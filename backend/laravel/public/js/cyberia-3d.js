/*
 * Cyberia in 3D (/3d) — resources/views/landing/temple.blade.php, public/css/cyberia-3d.css,
 * public/js/cyberia-3d-swap.js (the swap window's form and numbers) and
 * public/assets/3d/ (textures, generated offline: etched circuits, basalt,
 * marble, the road's die).
 *
 * One scene, one camera that flies between seven shots as the page scrolls:
 *   hero      the cube on its altar — the logo made solid: black etched glass,
 *             the eye on top, the hexagram and ‹Ø/› on its sides, the live block
 *             number on its back — and beside it the cross-chain swap window,
 *             a real form standing in the scene: the cube projects it, two
 *             coins stand for the networks picked in it and an arc of light
 *             runs from one to the other while a route is priced;
 *   chain     the road behind it: the newest blocks, in the order they landed,
 *             read from the public RPC once a second; blocks with transactions
 *             burn bright and carry one chip per transaction;
 *   doctrine  close on the cube;
 *   doors     the ecosystem as two rings of cubes (on the chain / beyond it),
 *             read from the page's own list of doors;
 *   launched  a step pyramid whose lit stones are the launchpad's tokens,
 *             newest at the top;
 *   next      Cyberia 2.0 — the Avalanche L1, a wired cube on the horizon with
 *             its Fuji block and treasury from /api/fuji/chain, and the bridge
 *             to it drawn with its middle missing until mainnet opens it;
 *   join      back at the cube.
 *
 * The look: a black marble floor that mirrors the scene (a reflection pass at
 * half resolution, blurred by mip level, stretched the way wet stone stretches
 * light), glass lit by a studio of neon strips instead of a grey room, MSAA
 * under the bloom, and a last pass for the vignette.
 *
 * Nothing is invented: when a source cannot be read the page says so and the
 * scene shows less. Without WebGL the copy, the numbers, the swap window and
 * the cube picture stay; with reduced motion the camera cuts instead of flying.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { createSwap, drawEmblem, emblemColor } from 'cyberia-swap';

const CFG = window.CYBERIA_3D || {};
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const narrow = matchMedia('(max-width: 940px)');
const fmt = new Intl.NumberFormat('en-US');
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const day = (iso) => { if (!iso) { return ''; } const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
const ago = (ts) => {
  const s = Math.max(0, Math.round(Date.now() / 1000 - ts));
  if (s < 2) { return 'just now'; }
  if (s < 90) { return s + ' s ago'; }
  if (s < 5400) { return Math.round(s / 60) + ' min ago'; }
  return Math.round(s / 3600) + ' h ago';
};

/* ------------------------------------------------------------------ data -- */

const chain = { head: null, blocks: [], batch: true, fails: 0, listeners: [] };
const pulse = (k, v) => { const el = $(`[data-pulse="${k}"]`); if (el) { el.textContent = v; } };

async function rpc(body) {
  const r = await fetch(CFG.rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  if (!r.ok) { throw new Error('rpc ' + r.status); }
  return r.json();
}
const call = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const hex = (n) => '0x' + n.toString(16);
const toBlock = (b) => ({ n: parseInt(b.number, 16), tx: (b.transactions || []).length, ts: parseInt(b.timestamp, 16) });

/** Blocks by number, in one batch request when the node takes batches; unread ones come back without tx/ts. */
async function readBlocks(nums) {
  if (!nums.length) { return []; }
  if (chain.batch) {
    try {
      const out = [];
      for (let i = 0; i < nums.length; i += 16) {
        const part = nums.slice(i, i + 16);
        const res = await rpc(part.map((n, j) => call('eth_getBlockByNumber', [hex(n), false], j + 1)));
        if (!Array.isArray(res)) { throw new Error('no batch'); }
        res.sort((a, b) => a.id - b.id).forEach((x) => { if (x && x.result) { out.push(toBlock(x.result)); } });
      }
      return out;
    } catch (e) {
      chain.batch = false;
    }
  }
  return nums.map((n) => ({ n, tx: null, ts: null }));
}

async function pollChain() {
  try {
    const res = await rpc(call('eth_getBlockByNumber', ['latest', false]));
    if (!res || !res.result) { throw new Error('no block'); }
    const head = toBlock(res.result);
    chain.fails = 0;
    const last = chain.head;
    if (!last || head.n - last.n > 8) {
      const nums = [];
      for (let n = Math.max(0, head.n - 47); n < head.n; n++) { nums.push(n); }
      const past = await readBlocks(nums);
      chain.blocks = [...past, head];
      chain.head = head;
      chain.listeners.forEach((f) => f('reset', chain.blocks));
    } else if (head.n > last.n) {
      const nums = [];
      for (let n = last.n + 1; n < head.n; n++) { nums.push(n); }
      const fresh = [...(await readBlocks(nums)), head];
      chain.head = head;
      fresh.forEach((b) => { chain.blocks.push(b); chain.listeners.forEach((f) => f('block', b)); });
      if (chain.blocks.length > 64) { chain.blocks.splice(0, chain.blocks.length - 64); }
    }
    showChain(true);
  } catch (e) {
    if (++chain.fails >= 3) { showChain(false); }
  }
  setTimeout(pollChain, document.hidden ? 6000 : 1000);
}

function showChain(ok) {
  const live = $('#live');
  const head = chain.head;
  if (!ok || !head) {
    live.className = 'live off';
    live.lastElementChild.textContent = 'Can’t reach the chain right now — retrying';
    return;
  }
  live.className = 'live on';
  live.lastElementChild.textContent = `Live · block #${fmt.format(head.n)} · ${head.tx} tx`;
  pulse('blocks', fmt.format(head.n));
  $('#foot-block').textContent = `Block #${fmt.format(head.n)}`;
  const read = chain.blocks.filter((b) => b.ts !== null);
  const note = $('#chain-note');
  if (read.length > 2) {
    const first = read[0];
    const span = (head.ts - first.ts) / Math.max(1, head.n - first.n);
    const busy = read.filter((b) => b.tx > 0).length;
    note.textContent = `Block #${fmt.format(head.n)} landed ${ago(head.ts)}. One block every ${span.toFixed(1)} s over the last ${read.length}; `
      + (busy ? `${busy} of them carried transactions.` : 'none of them carried a transaction — the chain keeps time between them.');
  } else {
    note.textContent = `Block #${fmt.format(head.n)} landed ${ago(head.ts)}.`;
  }
}

async function json(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) { throw new Error(url + ' ' + r.status); }
  return r.json();
}

async function readStats() {
  try {
    const s = await json(CFG.stats);
    if (s.total_transactions) { pulse('transactions', fmt.format(+s.total_transactions)); }
    if (s.transactions_today) { pulse('today', fmt.format(+s.transactions_today)); }
  } catch (e) { /* the explorer is optional: the dashes stay */ }
  setTimeout(readStats, 60000);
}

const launchpad = { tokens: [], listeners: [] };
async function readTokens() {
  const note = $('#launched-note');
  try {
    const j = await json(CFG.tokens);
    const tokens = (j.tokens || []).filter((t) => t && t.address && Number(t.chain_id || 49406) === 49406)
      .sort((a, b) => String(b.launched_at || '').localeCompare(String(a.launched_at || '')));
    launchpad.tokens = tokens;
    pulse('launched', fmt.format(tokens.length));
    if (tokens.length) {
      note.textContent = `${tokens.length} tokens so far. The newest is $${tokens[0].symbol}` + (tokens[0].launched_at ? `, launched ${day(tokens[0].launched_at)}.` : '.');
    } else {
      note.textContent = 'No token has launched yet — the first stone is yours.';
    }
    launchpad.listeners.forEach((f) => f(tokens));
  } catch (e) {
    note.textContent = 'The launchpad can’t be read right now.';
  }
}

const fuji = { data: null, listeners: [] };
async function readFuji() {
  const set = (k, v) => { $$(`[data-fuji="${k}"]`).forEach((el) => { el.textContent = v; }); };
  try {
    const f = await json(CFG.fuji);
    fuji.data = f;
    if (f.block) { set('block', '#' + fmt.format(f.block.number)); }
    if (f.chainId) { set('chain', String(f.chainId)); }
    if (f.treasury && f.treasury.balance) {
      set('treasury', fmt.format(Number(BigInt(f.treasury.balance) / 10n ** 18n)) + ' test CYBER');
    }
    if (f.validator) {
      set('validator', '1 node · proof of authority');
    }
    fuji.listeners.forEach((fn) => fn(f));
  } catch (e) {
    set('block', 'can’t be read now');
  }
}

function countDoors() {
  const doors = $$('.door');
  const open = doors.filter((d) => d.dataset.status !== 'dev').length;
  pulse('doors', `${open} of ${doors.length}`);
}

function wireAddNetwork() {
  const btn = $('#add-network');
  const note = $('#add-network-note');
  if (!btn) { return; }
  btn.addEventListener('click', async () => {
    const eth = window.ethereum;
    if (!eth || !eth.request) {
      note.innerHTML = 'No browser wallet found here. <a href="/wallet">The Cyberia Wallet</a> has the network built in.';
      return;
    }
    try {
      await eth.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: '0xC0FE',
          chainName: 'Cyberia',
          nativeCurrency: { name: 'CYBER', symbol: 'CYBER', decimals: 18 },
          rpcUrls: [CFG.rpc],
          blockExplorerUrls: [CFG.explorer],
        }],
      });
      note.textContent = 'Cyberia is in your wallet.';
    } catch (e) {
      note.textContent = e && e.message ? e.message : 'The wallet turned the request down.';
    }
  });
}

/* ------------------------------------------------------------- textures -- */

const TEX = (name) => (CFG.textures || '/assets/3d/') + name + (CFG.texturesVersion ? '?v=' + CFG.texturesVersion : '');
const loader = new THREE.TextureLoader();
/** A map that carries data, not colour (roughness, normals, masks), unless `color` says otherwise. */
const dataMap = (name, { repeat = 1, color = false } = {}) => {
  const t = loader.load(TEX(name));
  t.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 8;
  return t;
};

// The circuit etching is also drawn, faintly, under each glowing glyph, so the
// traces catch a little of the glyph's light. Glyph textures repaint once it loads.
const etchImage = new Image();
const etched = [];
etchImage.onload = () => etched.forEach((t) => t.repaint());
etchImage.src = TEX('etch.webp');

const S = 512;
function canvasTexture(draw, { size = 512, bg = '#000', glow = 12, etch = false } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const paint = () => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = bg;
    g.fillRect(0, 0, size, size);
    if (etch && etchImage.complete && etchImage.naturalWidth) {
      g.globalAlpha = 0.2;
      g.drawImage(etchImage, 0, 0, size, size);
      g.globalAlpha = 1;
    }
    g.save();
    g.scale(size / S, size / S);
    g.strokeStyle = g.fillStyle = '#fff';
    g.lineCap = 'round';
    g.lineJoin = 'round';
    g.shadowColor = 'rgba(255,255,255,.85)';
    g.shadowBlur = glow;
    draw(g);
    g.restore();
  };
  paint();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.repaint = (fn) => { if (fn) { draw = fn; } paint(); t.needsUpdate = true; };
  if (etch) { etched.push(t); }
  return t;
}
const path = (g, pts, close = false) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (close) { g.closePath(); } g.stroke(); };
const dot = (g, x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); };
const ring = (g, x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.stroke(); };
const rr = (g, x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.stroke(); };

const GLYPH = {
  eye(g) {
    g.lineWidth = 20;
    g.beginPath(); g.moveTo(112, 176); g.bezierCurveTo(190, 126, 320, 120, 414, 162); g.stroke();
    g.beginPath(); g.moveTo(122, 262); g.bezierCurveTo(176, 196, 300, 186, 360, 232); g.lineTo(426, 236); g.stroke();
    g.beginPath(); g.moveTo(122, 262); g.bezierCurveTo(196, 302, 300, 300, 360, 232); g.stroke();
    dot(g, 246, 244, 34);
    path(g, [[216, 294], [206, 382]]);
    g.beginPath(); g.moveTo(300, 292); g.bezierCurveTo(312, 344, 338, 386, 384, 380); g.bezierCurveTo(414, 376, 414, 336, 386, 334); g.bezierCurveTo(366, 334, 362, 356, 376, 362); g.stroke();
    dot(g, 454, 322, 22);
  },
  hexagram(g) {
    g.lineWidth = 18;
    for (const rot of [-Math.PI / 2, Math.PI / 2]) {
      path(g, [0, 1, 2].map((i) => [256 + Math.cos(rot + i * 2.0944) * 196, 262 + Math.sin(rot + i * 2.0944) * 196]), true);
    }
    g.lineWidth = 16;
    ring(g, 256, 262, 50);
    path(g, [[280, 288], [314, 326]]);
  },
  code(g) {
    g.lineWidth = 22;
    path(g, [[150, 168], [72, 256], [150, 344]]);
    path(g, [[362, 168], [440, 256], [362, 344]]);
    g.lineWidth = 20;
    g.beginPath(); g.ellipse(256, 256, 58, 80, 0, 0, Math.PI * 2); g.stroke();
    path(g, [[204, 358], [308, 154]]);
  },
  // The altar's seal: the hexagram inside two rings, with the hours around it.
  seal(g) {
    g.lineWidth = 7;
    ring(g, 256, 256, 236);
    g.lineWidth = 4;
    ring(g, 256, 256, 214);
    for (let i = 0; i < 48; i++) {
      const a = i * Math.PI / 24;
      const r0 = i % 4 === 0 ? 192 : 202;
      path(g, [[256 + Math.cos(a) * r0, 256 + Math.sin(a) * r0], [256 + Math.cos(a) * 212, 256 + Math.sin(a) * 212]]);
    }
    g.lineWidth = 6;
    for (const rot of [-Math.PI / 2, Math.PI / 2]) {
      path(g, [0, 1, 2].map((i) => [256 + Math.cos(rot + i * 2.0944) * 168, 256 + Math.sin(rot + i * 2.0944) * 168]), true);
    }
    ring(g, 256, 256, 84);
  },
};

const ICON = {
  wallet(g) { rr(g, 110, 160, 292, 210, 30); rr(g, 296, 230, 106, 70, 16); dot(g, 336, 265, 12); },
  swap(g) { path(g, [[130, 200], [372, 200]]); path(g, [[330, 158], [372, 200], [330, 242]]); path(g, [[382, 316], [140, 316]]); path(g, [[182, 274], [140, 316], [182, 358]]); },
  bridge(g) {
    g.beginPath(); g.moveTo(96, 330); g.quadraticCurveTo(256, 110, 416, 330); g.stroke();
    path(g, [[80, 330], [432, 330]]);
    for (const x of [176, 256, 336]) { const t = (x - 96) / 320; const y = (1 - t) ** 2 * 330 + 2 * (1 - t) * t * 110 + t * t * 330; path(g, [[x, 330], [x, y]]); }
  },
  dao(g) { path(g, [[116, 206], [256, 116], [396, 206]], true); for (const x of [156, 220, 292, 356]) { path(g, [[x, 236], [x, 356]]); } path(g, [[106, 390], [406, 390]]); },
  lending(g) { ring(g, 214, 290, 96); path(g, [[214, 240], [214, 340]]); path(g, [[300, 206], [404, 102]]); path(g, [[334, 100], [404, 102], [402, 172]]); },
  launchpad(g) {
    g.beginPath(); g.moveTo(256, 92); g.bezierCurveTo(336, 180, 336, 300, 302, 352); g.lineTo(210, 352); g.bezierCurveTo(176, 300, 176, 180, 256, 92); g.closePath(); g.stroke();
    ring(g, 256, 222, 28);
    path(g, [[206, 296], [154, 384], [216, 356]]);
    path(g, [[306, 296], [358, 384], [296, 356]]);
  },
  markets(g) { path(g, [[110, 118], [110, 400], [404, 400]]); path(g, [[144, 340], [214, 256], [274, 300], [384, 158]]); dot(g, 384, 158, 16); },
  profile(g) { ring(g, 256, 196, 70); g.beginPath(); g.moveTo(122, 404); g.bezierCurveTo(140, 296, 372, 296, 390, 404); g.stroke(); },
  arcade(g) { rr(g, 136, 136, 240, 240, 36); dot(g, 196, 196, 20); dot(g, 256, 256, 20); dot(g, 316, 316, 20); },
  explorer(g) { ring(g, 224, 224, 102); g.lineWidth = 36; path(g, [[300, 300], [402, 402]]); },
  lain(g) { g.beginPath(); g.ellipse(256, 168, 154, 42, -0.08, 0, Math.PI * 2); g.stroke(); ring(g, 256, 304, 92); path(g, [[340, 126], [384, 182]]); path(g, [[384, 126], [340, 182]]); },
  wired(g) { ring(g, 256, 256, 150); g.beginPath(); g.ellipse(256, 256, 62, 150, 0, 0, Math.PI * 2); g.stroke(); g.beginPath(); g.ellipse(256, 256, 150, 58, 0, 0, Math.PI * 2); g.stroke(); },
  nocarrier(g) { dot(g, 256, 340, 20); for (const r of [72, 134, 196]) { g.beginPath(); g.arc(256, 340, r, -Math.PI * 0.78, -Math.PI * 0.22); g.stroke(); } },
  telegram(g) { path(g, [[92, 250], [414, 118], [352, 400], [248, 306]], true); path(g, [[248, 306], [414, 118]]); path(g, [[248, 306], [262, 392], [302, 344]]); },
  os(g) { g.beginPath(); g.arc(256, 276, 124, -Math.PI / 2 + 0.62, -Math.PI / 2 - 0.62 + Math.PI * 2); g.stroke(); path(g, [[256, 104], [256, 262]]); },
  blog(g) { rr(g, 146, 100, 220, 312, 22); for (const y of [176, 230, 284, 338]) { path(g, [[188, y], [y === 338 ? 280 : 324, y]]); } },
};
const iconTexture = (name) => canvasTexture((g) => { g.lineWidth = 26; (ICON[name] || ICON.blog)(g); }, { size: 256, glow: 8, etch: true });

/**
 * The studio the glass is lit by: a dark room with a soft box overhead and
 * neon strips along its walls — cyan on the left, magenta on the right, a cold
 * line behind. What the black glass shows is these strips, sharp on polished
 * faces and smeared where the circuits are etched.
 */
function neonEnvironment(renderer) {
  const env = new THREE.Scene();
  const room = new THREE.Mesh(new THREE.BoxGeometry(34, 18, 34), new THREE.MeshBasicMaterial({ color: 0x010304, side: THREE.BackSide }));
  room.position.y = 6;
  env.add(room);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const light = (hexColor, power, [x, y, z], [w, h, d]) => {
    const m = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ color: new THREE.Color(hexColor).multiplyScalar(power) }));
    m.position.set(x, y, z);
    m.scale.set(w, h, d);
    env.add(m);
  };
  light(0xdffcff, 5, [0, 14.5, -1], [12, 0.3, 5]);
  light(0x00e5d1, 9, [-16.5, 5, -2], [0.3, 1.0, 20]);
  light(0x00e5d1, 4, [-16.5, 9, -2], [0.3, 0.25, 20]);
  light(0xff2bd6, 7, [16.5, 3.5, 3], [0.3, 0.7, 16]);
  light(0x8fd8ff, 4, [3, 7, -16.5], [16, 0.5, 0.3]);
  light(0x00e5d1, 1.4, [0, -2.8, 0], [20, 0.2, 20]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(env, 0.015).texture;
  pmrem.dispose();
  return texture;
}

/** Light running along a tube: dashes that move from the start to the end, with an optional gap in the middle. */
function flowMaterial({ colorA, colorB, dashes = 24, speed = 0.4, alpha = 1, gap = 0, gapAt = 0.5 }) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: {
      uA: { value: new THREE.Color(colorA) }, uB: { value: new THREE.Color(colorB) },
      uTime: { value: 0 }, uDash: { value: dashes }, uSpeed: { value: speed }, uAlpha: { value: alpha }, uGap: { value: gap }, uGapAt: { value: gapAt }, uGlow: { value: 1 },
    },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 uA; uniform vec3 uB; uniform float uTime; uniform float uDash; uniform float uSpeed; uniform float uAlpha; uniform float uGap; uniform float uGapAt; uniform float uGlow;
      varying vec2 vUv;
      void main(){
        float k = fract(vUv.x * uDash - uTime * uSpeed);
        float dash = smoothstep(0.0, 0.18, k) * (1.0 - smoothstep(0.36, 0.6, k));
        float ends = smoothstep(0.0, 0.06, vUv.x) * (1.0 - smoothstep(0.94, 1.0, vUv.x));
        float hole = uGap > 0.0 ? smoothstep(uGap, uGap + 0.02, abs(vUv.x - uGapAt)) : 1.0;
        float core = 0.18 + 0.82 * dash;
        vec3 col = mix(uA, uB, vUv.x) * core * uGlow;
        gl_FragColor = vec4(col * ends * hole * uAlpha, 1.0);
      }`,
  });
}

/* --------------------------------------------------------------- scene -- */

function boot(swap) {
  const canvas = $('#scene');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch (e) {
    document.body.classList.add('no-gl');
    return;
  }
  if (!renderer.getContext()) { document.body.classList.add('no-gl'); return; }

  renderer.setClearColor(0x000000, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const FOG = new THREE.Color(0x081113);
  const DENSITY = 0.028;
  scene.fog = new THREE.FogExp2(FOG, DENSITY);
  scene.environment = neonEnvironment(renderer);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: narrow.matches ? 2 : 4 }));
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.45, 0.62);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  // Display-referred finish: a vignette, a hair of chromatic fringe toward the
  // corners, and a dither so the dark gradients do not band. No grain.
  const finish = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uTime; varying vec2 vUv;
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      void main(){
        vec2 c = vUv - 0.5;
        vec2 off = c * dot(c, c) * 0.005;
        vec3 col = vec3(texture2D(tDiffuse, vUv - off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv + off).b);
        float v = smoothstep(0.98, 0.3, length(c * vec2(1.0, 0.92)));
        col *= mix(0.58, 1.0, v);
        col += (hash(vUv * uRes + fract(uTime)) - 0.5) / 255.0;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  composer.addPass(finish);

  scene.add(new THREE.AmbientLight(0x6fa8a4, 0.06));
  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  key.position.set(-6, 10, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xff2bd6, 0.55);
  rim.position.set(8, 4, -9);
  scene.add(rim);
  const under = new THREE.PointLight(0x00e5d1, 3.2, 6, 2);
  under.position.set(0, 0.6, 0);
  scene.add(under);

  const pickables = [];
  const t0 = performance.now();
  let now = 0;

  const etchRough = dataMap('etch.webp');
  const etchNormal = dataMap('etch-normal.webp');
  const stoneRough = dataMap('stone.webp', { repeat: 1.5 });
  const stoneNormal = dataMap('stone-normal.webp', { repeat: 1.5 });
  const stoneColor = dataMap('stone.webp', { repeat: 1.5, color: true });
  const chipMap = dataMap('chip.webp', { color: true });
  const marble = dataMap('marble.webp');

  /* -- the floor: black marble that mirrors what stands on it */
  const reflection = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
  const mirror = new THREE.PerspectiveCamera();
  const textureMatrix = new THREE.Matrix4();
  const floorMat = new THREE.ShaderMaterial({
    uniforms: {
      tReflect: { value: reflection.texture }, tMarble: { value: marble }, textureMatrix: { value: textureMatrix },
      uTexel: { value: new THREE.Vector2(1, 1) }, uFog: { value: FOG }, uDensity: { value: DENSITY },
      uRings: { value: new THREE.Vector2(5.4, 8.6) }, uPool: { value: new THREE.Vector4(0, 0, 0, 0) }, uReflect: { value: 1 },
    },
    vertexShader: `
      uniform mat4 textureMatrix; varying vec4 vRefl; varying vec3 vW;
      void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; vRefl = textureMatrix * w; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `
      uniform sampler2D tReflect; uniform sampler2D tMarble; uniform vec2 uTexel; uniform vec3 uFog; uniform float uDensity;
      uniform vec2 uRings; uniform vec4 uPool; uniform float uReflect;
      varying vec4 vRefl; varying vec3 vW;
      float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
      float ringLine(float d, float r, float w){ float aa = fwidth(d) * 1.2; return 1.0 - smoothstep(w, w + aa, abs(d - r)); }
      vec3 blurred(vec2 uv, float lod){
        vec2 o = uTexel * exp2(lod) * vec2(1.0, 2.8);
        vec3 c = textureLod(tReflect, uv, lod).rgb * 0.32;
        c += textureLod(tReflect, uv + vec2(o.x, 0.0), lod).rgb * 0.12;
        c += textureLod(tReflect, uv - vec2(o.x, 0.0), lod).rgb * 0.12;
        c += textureLod(tReflect, uv + vec2(0.0, o.y), lod).rgb * 0.22;
        c += textureLod(tReflect, uv - vec2(0.0, o.y), lod).rgb * 0.22;
        return c;
      }
      void main(){
        vec2 p = vW.xz; float d = length(p);
        vec3 cyan = vec3(0.0, 0.9, 0.82);
        float T = 2.0;
        vec2 q = p / T; vec2 cell = floor(q); vec2 f = fract(q);
        float h = hash(cell);
        vec2 mp = p * 0.085 + vec2(h * 3.7, fract(h * 7.3) * 2.9);
        if (h > 0.5) { mp = mp.yx; }
        float m = texture2D(tMarble, mp).r;
        float vein = smoothstep(0.5, 0.95, m);
        vec2 e = min(f, 1.0 - f) * T;
        float ed = min(e.x, e.y);
        float grout = 1.0 - smoothstep(0.01, 0.01 + fwidth(ed) * 1.5, ed);
        vec3 col = mix(vec3(0.005, 0.008, 0.009), vec3(0.014, 0.018, 0.020), h) * (0.75 + 0.5 * m) + vec3(0.045, 0.06, 0.062) * vein;
        col *= 1.0 - grout * 0.75;
        vec2 wob = vec2(texture2D(tMarble, p * 0.031).r - 0.5, texture2D(tMarble, p * 0.027 + 0.37).r - 0.5) * 0.005;
        float lod = mix(1.1, 3.4, vein) + (1.0 - smoothstep(0.0, 0.07, ed)) * 0.9;
        vec3 refl = blurred(vRefl.xy / vRefl.w + wob, lod);
        vec3 V = normalize(cameraPosition - vW);
        float F = 0.04 + 0.96 * pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
        col += refl * uReflect * mix(0.2, 0.95, F) * (1.0 - grout) * (1.0 - 0.5 * vein);
        col += cyan * (ringLine(d, uRings.x, 0.012) + ringLine(d, uRings.y, 0.012)) * 0.5;
        col += cyan * (ringLine(d, 2.0, 0.008) * 0.3 + ringLine(d, 2.2, 0.004) * 0.22);
        col += cyan * exp(-d * 0.95) * 0.07;
        float pd = length(p - uPool.xy);
        col += vec3(0.0, 0.5, 0.56) * exp(-pd * pd * 0.16) * uPool.z;
        float depth = gl_FragCoord.z / gl_FragCoord.w;
        float fogF = 1.0 - exp(-uDensity * uDensity * depth * depth);
        gl_FragColor = vec4(mix(col, uFog, fogF), 1.0);
      }`,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const sky = new THREE.Mesh(new THREE.SphereGeometry(150, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uFog: { value: FOG }, uTop: { value: new THREE.Color(0x010203) } },
    vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 uFog; uniform vec3 uTop; varying vec3 vD; void main(){ float h = clamp(vD.y, 0.0, 1.0); gl_FragColor = vec4(mix(uFog, uTop, pow(h, 0.45)), 1.0); }',
  }));
  sky.renderOrder = -1;
  scene.add(sky);

  // The mirror pass, after three's Reflector: the camera reflected in the
  // floor, its near plane bent onto the floor so nothing under it is drawn.
  const UP = new THREE.Vector3(0, 1, 0);
  const plane = new THREE.Plane();
  const clip = new THREE.Vector4();
  const qv = new THREE.Vector4();
  const camAt = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const rot = new THREE.Matrix4();
  const renderReflection = () => {
    camAt.setFromMatrixPosition(camera.matrixWorld);
    if (camAt.y < 0.05) { return; }
    rot.extractRotation(camera.matrixWorld);
    lookAt.set(0, 0, -1).applyMatrix4(rot).add(camAt);
    mirror.position.set(camAt.x, -camAt.y, camAt.z);
    mirror.up.set(0, 1, 0).applyMatrix4(rot).reflect(UP);
    mirror.lookAt(lookAt.x, -lookAt.y, lookAt.z);
    mirror.far = camera.far;
    mirror.updateMatrixWorld();
    mirror.projectionMatrix.copy(camera.projectionMatrix);
    textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    textureMatrix.multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);
    plane.setFromNormalAndCoplanarPoint(UP, floor.position).applyMatrix4(mirror.matrixWorldInverse);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const pm = mirror.projectionMatrix.elements;
    qv.set((Math.sign(clip.x) + pm[8]) / pm[0], (Math.sign(clip.y) + pm[9]) / pm[5], -1, (1 + pm[10]) / pm[14]);
    clip.multiplyScalar(2 / clip.dot(qv));
    pm[2] = clip.x;
    pm[6] = clip.y;
    pm[10] = clip.z + 1;
    pm[14] = clip.w;
    floor.visible = false;
    dust.visible = false;
    const beamOn = beam.visible;
    beam.visible = false;
    renderer.setRenderTarget(reflection);
    renderer.clear();
    renderer.render(scene, mirror);
    renderer.setRenderTarget(null);
    floor.visible = true;
    dust.visible = true;
    beam.visible = beamOn;
  };

  /* -- the altar */
  const altarMat = new THREE.MeshPhysicalMaterial({
    color: 0x0c0f11, roughness: 0.55, roughnessMap: stoneRough, normalMap: stoneNormal, normalScale: new THREE.Vector2(0.3, 0.3),
    metalness: 0.1, clearcoat: 0.8, clearcoatRoughness: 0.1, envMapIntensity: 1,
  });
  const inlay = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.0, 1.45, 1.32) });
  [[1.52, 0, 0.14], [1.16, 0.14, 0.14]].forEach(([r, y, h]) => {
    const step = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 0.02, h, 128, 1), altarMat);
    step.position.y = y + h / 2;
    scene.add(step);
    const line = new THREE.Mesh(new THREE.TorusGeometry(r - 0.04, 0.008, 6, 192), inlay);
    line.rotation.x = Math.PI / 2;
    line.position.y = y + h + 0.002;
    scene.add(line);
  });
  const seal = new THREE.Mesh(new THREE.CircleGeometry(1.02, 128), new THREE.MeshStandardMaterial({
    color: 0x07090a, roughness: 0.22, metalness: 0.3, envMapIntensity: 0.8,
    emissive: 0x00e5d1, emissiveMap: canvasTexture(GLYPH.seal, { glow: 6 }), emissiveIntensity: 0.55,
  }));
  seal.rotation.x = -Math.PI / 2;
  seal.position.y = 0.282;
  scene.add(seal);

  /* -- the cube */
  const glyphMat = (tex, intensity = 1.9) => new THREE.MeshPhysicalMaterial({
    color: 0x000000, roughness: 0.62, roughnessMap: etchRough, normalMap: etchNormal, normalScale: new THREE.Vector2(0.45, 0.45),
    metalness: 0, specularIntensity: 1, ior: 1.6, clearcoat: 0.35, clearcoatRoughness: 0.08, envMapIntensity: 1.6,
    emissive: 0x00e5d1, emissiveMap: tex, emissiveIntensity: intensity,
  });
  const monoFont = (w, px) => `${w} ${px}px "JetBrains Mono", ui-monospace, monospace`;
  const blockFace = canvasTexture(() => {}, { etch: true });
  const paintBlockFace = (n) => blockFace.repaint((g) => {
    g.shadowBlur = 8;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = monoFont(500, 34);
    g.fillText('BLOCK', 256, 170);
    g.font = monoFont(500, n ? 62 : 50);
    g.fillText(n ? fmt.format(n) : 'reading…', 256, 256);
    g.font = monoFont(400, 28);
    g.fillText('CYBERIA · 49406', 256, 344);
  });
  paintBlockFace(null);
  const idFace = canvasTexture((g) => {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = monoFont(500, 112);
    g.fillText('49406', 256, 236);
    g.font = monoFont(400, 30);
    g.fillText('CHAIN ID · 0xC0FE', 256, 330);
  }, { etch: true });
  const faces = [
    glyphMat(canvasTexture(GLYPH.code, { etch: true })),
    glyphMat(idFace, 1.6),
    glyphMat(canvasTexture(GLYPH.eye, { etch: true })),
    glyphMat(canvasTexture(GLYPH.hexagram, { etch: true }), 0.6),
    glyphMat(canvasTexture(GLYPH.hexagram, { etch: true })),
    glyphMat(blockFace, 1.8),
  ];
  const cube = new THREE.Mesh(new RoundedBoxGeometry(2.4, 2.4, 2.4, 8, 0.18), faces);
  cube.position.set(0, 2.1, 0);
  cube.userData.pick = 'cube';
  scene.add(cube);
  pickables.push(cube);

  document.fonts && document.fonts.load(monoFont(500, 64)).then(() => {
    idFace.repaint();
    paintBlockFace(chain.head && chain.head.n);
  }).catch(() => {});

  /* -- the road of blocks */
  const curve = new THREE.CatmullRomCurve3([
    [0, 0, 0], [1.6, 0, -2.4], [3.6, 0, -6.5], [5.0, 0, -12], [3.8, 0, -19], [0.5, 0, -27], [-3.5, 0, -36], [-7, 0, -45],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z)), false, 'centripetal');
  const roadLength = curve.getLength();
  const SLOT0 = 1.9;
  const STEP = 0.64;
  const CAP = 64;
  const stoneMat = new THREE.MeshStandardMaterial({
    color: 0x0d1214, roughness: 0.5, roughnessMap: stoneRough, normalMap: stoneNormal, normalScale: new THREE.Vector2(0.4, 0.4),
    metalness: 0.6, emissive: 0xffffff, emissiveMap: chipMap, emissiveIntensity: 1, envMapIntensity: 1.1,
  });
  stoneMat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n#ifdef USE_COLOR\ntotalEmissiveRadiance *= vColor;\n#endif');
  };
  const stones = new THREE.InstancedMesh(new RoundedBoxGeometry(0.42, 0.42, 0.42, 3, 0.05), stoneMat, CAP);
  stones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  stones.setColorAt(0, new THREE.Color());
  stones.count = 0;
  stones.frustumCulled = false;
  stones.userData.pick = 'block';
  scene.add(stones);
  pickables.push(stones);
  const chipMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.0, 1.9, 1.7) });
  const CHIPS = 12;
  const chips = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.05, 0.3), chipMat, CAP * CHIPS);
  chips.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  chips.count = 0;
  chips.frustumCulled = false;
  scene.add(chips);

  const road = [];
  const spawnFrom = new THREE.Vector3(0, 0.9, 0);
  const tmp = new THREE.Object3D();
  const col = new THREE.Color();
  const v1 = new THREE.Vector3();
  const v2 = new THREE.Vector3();
  let hoverBlock = -1;

  const placeRoad = (all) => {
    road.length = 0;
    const list = all.slice(-CAP);
    list.forEach((b, i) => road.push({ ...b, slot: list.length - 1 - i, target: list.length - 1 - i, spawn: 1, flash: 0 }));
    paintBlockFace(chain.head && chain.head.n);
  };
  const addToRoad = (b) => {
    road.forEach((r) => { r.target += 1; });
    road.push({ ...b, slot: 0, target: 0, spawn: reduced ? 1 : 0, flash: 1 });
    while (road.length && road[0].target >= CAP) { road.shift(); }
    paintBlockFace(b.n);
  };
  chain.listeners.push((kind, payload) => (kind === 'reset' ? placeRoad(payload) : addToRoad(payload)));

  const blockPoint = (slot, out) => {
    const u = Math.min(1, (SLOT0 + slot * STEP) / roadLength);
    curve.getPointAt(u, out);
    out.y = 0.21;
    return u;
  };
  const updateRoad = (dt) => {
    let c = 0;
    const k = reduced ? 1 : 1 - Math.exp(-dt * 7);
    road.forEach((b, i) => {
      b.slot += (b.target - b.slot) * k;
      if (b.spawn < 1) { b.spawn = Math.min(1, b.spawn + dt * 1.6); }
      b.flash = Math.max(0, b.flash - dt * 1.5);
      const u = blockPoint(b.slot, v1);
      curve.getTangentAt(u, v2);
      tmp.rotation.set(0, Math.atan2(v2.x, v2.z), 0);
      if (b.spawn < 1) {
        const e = 1 - (1 - b.spawn) ** 3;
        tmp.position.lerpVectors(spawnFrom, v1, e);
        tmp.position.y += Math.sin(Math.PI * e) * 0.5;
        tmp.scale.setScalar(0.35 + 0.65 * e);
      } else {
        tmp.position.copy(v1);
        tmp.scale.setScalar(1);
      }
      tmp.updateMatrix();
      stones.setMatrixAt(i, tmp.matrix);
      if (b.tx === null) { col.setRGB(0.05, 0.06, 0.065); } else if (b.tx > 0) { const s = Math.min(1, 0.65 + b.tx * 0.08); col.setRGB(0.0, 1.9 * s, 1.75 * s); } else { col.setRGB(0.02, 0.2, 0.19); }
      if (b.flash > 0) { col.r += b.flash * 0.9; col.g += b.flash * 0.9; col.b += b.flash * 0.9; }
      if (i === hoverBlock) { col.setRGB(1.6, 1.6, 1.6); }
      stones.setColorAt(i, col);
      const n = b.tx ? Math.min(b.tx, CHIPS) : 0;
      for (let j = 0; j < n && c < chips.instanceMatrix.count; j++) {
        tmp.position.y += j === 0 ? 0.26 * tmp.scale.y : 0.075;
        tmp.updateMatrix();
        chips.setMatrixAt(c++, tmp.matrix);
      }
    });
    stones.count = road.length;
    chips.count = c;
    stones.instanceMatrix.needsUpdate = true;
    if (stones.instanceColor) { stones.instanceColor.needsUpdate = true; }
    chips.instanceMatrix.needsUpdate = true;
  };

  /* -- the doors */
  const roadAngleAt = (r) => {
    for (let s = 0; s < roadLength; s += 0.1) {
      curve.getPointAt(s / roadLength, v1);
      if (Math.hypot(v1.x, v1.z) >= r) { return Math.atan2(v1.z, v1.x); }
    }
    return -Math.PI / 2;
  };
  const doorGeo = new RoundedBoxGeometry(0.95, 0.95, 0.95, 5, 0.1);
  const doors = [];
  const doorEls = $$('.door');
  [0, 1].forEach((ringNo) => {
    const els = doorEls.filter((el) => el.dataset.ring === String(ringNo));
    const radius = ringNo ? 8.6 : 5.4;
    const gap = ringNo ? 0.26 : 0.38;
    const start = roadAngleAt(radius) + gap;
    const span = Math.PI * 2 - gap * 2;
    els.forEach((el, i) => {
      const a = start + (i + 0.5) * span / els.length;
      const dev = el.dataset.status === 'dev';
      const mat = new THREE.MeshPhysicalMaterial({
        color: 0x000000, roughness: 0.62, roughnessMap: etchRough, normalMap: etchNormal, normalScale: new THREE.Vector2(0.4, 0.4),
        metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.1, envMapIntensity: 1.5,
        emissive: dev ? 0xff2bd6 : 0x00e5d1, emissiveMap: iconTexture(el.dataset.icon), emissiveIntensity: dev ? 0.55 : 1.7,
      });
      const m = new THREE.Mesh(doorGeo, mat);
      m.position.set(Math.cos(a) * radius, -0.6, Math.sin(a) * radius);
      m.lookAt(0, -0.6, 0);
      m.userData = { pick: 'door', el, base: mat.emissiveIntensity, phase: i * 0.7 + ringNo * 2 };
      scene.add(m);
      pickables.push(m);
      doors.push(m);
      el.addEventListener('pointerenter', () => { m.userData.hot = true; });
      el.addEventListener('pointerleave', () => { m.userData.hot = false; });
      el.addEventListener('focus', () => { m.userData.hot = true; });
      el.addEventListener('blur', () => { m.userData.hot = false; });
    });
  });

  /* -- the step pyramid of launched tokens */
  const ZIG = new THREE.Vector3(-12.5, 0, 5.5);
  const zig = new THREE.Group();
  zig.position.copy(ZIG);
  zig.rotation.y = -0.5;
  scene.add(zig);
  const zigStones = [];
  const plainStone = new THREE.MeshStandardMaterial({
    color: 0x2a3033, map: stoneColor, roughness: 0.85, roughnessMap: stoneRough, normalMap: stoneNormal, normalScale: new THREE.Vector2(0.9, 0.9),
    metalness: 0.05, envMapIntensity: 0.5,
  });
  const stoneGeo = new RoundedBoxGeometry(0.82, 0.82, 0.82, 3, 0.06);
  const tokenTexture = (t, img) => canvasTexture((g) => {
    if (img) {
      g.shadowBlur = 0;
      g.save();
      g.beginPath(); g.arc(256, 256, 196, 0, Math.PI * 2); g.clip();
      g.drawImage(img, 60, 60, 392, 392);
      g.restore();
      g.lineWidth = 14;
      ring(g, 256, 256, 200);
      return;
    }
    const sym = String(t.symbol || '?').slice(0, 7);
    g.lineWidth = 10;
    rr(g, 40, 40, 432, 432, 40);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = monoFont(500, sym.length > 5 ? 74 : 104);
    g.fillText(sym, 256, 262);
  }, { size: 256, glow: 6 });

  const buildZiggurat = (tokens) => {
    zigStones.forEach((m) => { zig.remove(m); const i = pickables.indexOf(m); if (i >= 0) { pickables.splice(i, 1); } });
    zigStones.length = 0;
    let levels = 3;
    while ((2 * levels - 1) ** 2 < tokens.length) { levels++; }
    const step = 0.86;
    let k = 0;
    for (let L = levels - 1; L >= 0; L--) {
      const side = 2 * (levels - 1 - L) + 1;
      const y = L * step + 0.41;
      const ringCells = [];
      if (side === 1) { ringCells.push([0, 0]); } else {
        const h = (side - 1) / 2;
        for (let i = -h; i <= h; i++) { ringCells.push([i, h]); }
        for (let j = h - 1; j >= -h; j--) { ringCells.push([h, j]); }
        for (let i = h - 1; i >= -h; i--) { ringCells.push([i, -h]); }
        for (let j = -h + 1; j <= h - 1; j++) { ringCells.push([-h, j]); }
      }
      ringCells.forEach(([i, j]) => {
        const t = tokens[k++];
        let mat = plainStone;
        if (t) {
          mat = new THREE.MeshStandardMaterial({
            color: 0x1a1f22, map: stoneColor, roughness: 0.7, roughnessMap: stoneRough, normalMap: stoneNormal, normalScale: new THREE.Vector2(0.6, 0.6),
            metalness: 0.1, envMapIntensity: 0.6, emissive: 0x00e5d1, emissiveMap: tokenTexture(t, null), emissiveIntensity: 1.25,
          });
          if (t.image_url) {
            try {
              const u = new URL(t.image_url, location.href);
              if (u.origin === location.origin) {
                const img = new Image();
                img.onload = () => { mat.emissiveMap = tokenTexture(t, img); mat.emissive.set(0xffffff); mat.emissiveIntensity = 0.9; mat.needsUpdate = true; };
                img.src = u.href;
              }
            } catch (e) { /* the ticker stays */ }
          }
        }
        const m = new THREE.Mesh(stoneGeo, mat);
        m.position.set(i * step, y, j * step);
        if (t) { m.userData = { pick: 'token', token: t, rank: k }; pickables.push(m); }
        zig.add(m);
        zigStones.push(m);
      });
    }
    zigLabels(tokens);
  };

  /* -- Cyberia 2.0 on the horizon, and the bridge to it */
  const fatLines = [];
  const fat = (geo, color, width, opacity = 1) => {
    const m = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    fatLines.push(m);
    return new LineSegments2(new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(geo)), m);
  };
  const NEXT = new THREE.Vector3(15, 3.4, -13);
  const two = new THREE.Group();
  two.position.copy(NEXT);
  scene.add(two);
  two.add(fat(new THREE.BoxGeometry(3.2, 3.2, 3.2), new THREE.Color(0.55, 1.35, 1.9), 2.2));
  const inner = fat(new THREE.BoxGeometry(2.2, 2.2, 2.2), new THREE.Color(1.6, 0.35, 1.35), 1.4);
  two.add(inner);
  const wired = dataMap('etch.webp');
  const glass = new THREE.Mesh(new THREE.BoxGeometry(3.18, 3.18, 3.18), new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.25, 0.75, 1.1), alphaMap: wired, transparent: true, opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  two.add(glass);
  const seed = new THREE.Mesh(new RoundedBoxGeometry(0.9, 0.9, 0.9, 4, 0.08), faces);
  two.add(seed);
  two.userData.pick = 'next';
  glass.userData.pick = 'next';
  pickables.push(glass);
  const pillarPts = [];
  for (const [x, z] of [[-1.6, -1.6], [1.6, -1.6], [1.6, 1.6], [-1.6, 1.6]]) { pillarPts.push(new THREE.Vector3(NEXT.x + x, 0, NEXT.z + z), new THREE.Vector3(NEXT.x + x, NEXT.y - 1.6, NEXT.z + z)); }
  const pillarMat = new LineMaterial({ color: new THREE.Color(0.3, 0.75, 1.1), linewidth: 1.2, transparent: true, opacity: 0.6 });
  fatLines.push(pillarMat);
  scene.add(new LineSegments2(new LineSegmentsGeometry().setPositions(pillarPts.flatMap((p) => [p.x, p.y, p.z])), pillarMat));
  const twoGlow = new THREE.PointLight(0x7fd8ff, 10, 8, 2);
  twoGlow.position.set(NEXT.x, 0.8, NEXT.z);
  scene.add(twoGlow);
  // The bridge from today's chain to 2.0: drawn, flowing, and missing its
  // last span — bridges open with mainnet, and the picture says no more than that.
  const bridgeCurve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(0.7, 3.2, -0.7), new THREE.Vector3(8.2, 9.4, -7.6), new THREE.Vector3(NEXT.x - 1.4, NEXT.y + 0.9, NEXT.z + 1.2));
  const bridgeMat = flowMaterial({ colorA: new THREE.Color(0.0, 1.3, 1.2), colorB: new THREE.Color(0.55, 1.0, 1.9), dashes: 38, speed: 0.5, alpha: 0.75, gap: 0.045, gapAt: 0.86 });
  scene.add(new THREE.Mesh(new THREE.TubeGeometry(bridgeCurve, 200, 0.03, 8, false), bridgeMat));

  /* -- the swap window, standing in the scene beside the cube */
  const panel = new THREE.Group();
  scene.add(panel);
  const css = new CSS3DRenderer();
  css.domElement.className = 'css3d';
  css.domElement.setAttribute('aria-hidden', 'false');
  document.body.appendChild(css.domElement);
  const swapEl = swap ? swap.root : null;
  const swapHome = swapEl ? swapEl.parentElement : null;
  const swapObj = swapEl ? new CSS3DObject(swapEl) : null;
  if (swapObj) {
    swapEl.style.userSelect = '';
    swapEl.removeAttribute('draggable');
    panel.add(swapObj);
  }
  const slabMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, fog: false,
    uniforms: { uSize: { value: new THREE.Vector2(380, 480) }, uTime: { value: 0 }, uAlpha: { value: 1 }, uBusy: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec2 uSize; uniform float uTime; uniform float uAlpha; uniform float uBusy; varying vec2 vUv;
      float box(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
      void main(){
        vec2 px = (vUv - 0.5) * uSize;
        float d = box(px, uSize * 0.5 - 2.0, 16.0);
        float aa = fwidth(d);
        float inside = 1.0 - smoothstep(-aa, aa, d);
        float edge = 1.0 - smoothstep(0.6, 0.6 + aa * 1.5, abs(d + 0.8));
        float halo = exp(-max(d, 0.0) / 9.0) * (1.0 - inside);
        vec2 cq = abs(px) - (uSize * 0.5 - 34.0);
        float corner = step(0.0, cq.x) * step(0.0, cq.y);
        vec3 cyan = vec3(0.0, 0.9, 0.82);
        vec3 pink = vec3(1.0, 0.17, 0.84);
        vec3 tint = mix(cyan, pink, smoothstep(0.25, 1.15, vUv.x * 0.45 + (1.0 - vUv.y) * 0.55));
        vec3 fill = mix(vec3(0.004, 0.012, 0.015), vec3(0.012, 0.03, 0.034), vUv.y);
        float sweep = exp(-pow((vUv.y - (1.0 - fract(uTime * (0.06 + uBusy * 0.25)))) * 40.0, 2.0)) * (0.05 + uBusy * 0.08);
        vec3 c = fill + cyan * sweep + tint * edge * (0.42 + corner * 1.2) + tint * halo * 0.26;
        float a = inside * 0.88 + edge * 0.6 + halo * 0.5;
        gl_FragColor = vec4(c, a * uAlpha);
      }`,
  });
  const slab = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), slabMat);
  slab.position.z = -0.006;
  slab.renderOrder = 2;
  panel.add(slab);
  panel.visible = false;

  // The cube projects the window: a faint cone of light from the cube to the
  // window's edges, with scan lines running out along it.
  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12 * 3), 3));
  beamGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(12 * 2), 2));
  const beamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false,
    uniforms: { uTime: { value: 0 }, uAlpha: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform float uTime; uniform float uAlpha; varying vec2 vUv;
      void main(){
        float along = vUv.y;
        float across = along > 0.001 ? clamp((vUv.x - 0.5) / along + 0.5, 0.0, 1.0) : 0.5;
        float edge = smoothstep(0.82, 1.0, abs(across - 0.5) * 2.0);
        float fade = smoothstep(0.05, 0.4, along) * (1.0 - smoothstep(0.86, 1.0, along));
        float scan = 0.55 + 0.45 * sin(along * 26.0 - uTime * 3.2);
        vec3 c = vec3(0.0, 0.9, 0.82) * (0.006 + edge * 0.07) * fade * scan * uAlpha;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.frustumCulled = false;
  beam.visible = false;
  scene.add(beam);

  // Two coins for the two networks picked in the window, and the arc between them.
  const coinFace = new THREE.CircleGeometry(1, 64);
  const coinRim = new THREE.CylinderGeometry(1, 1, 0.16, 64, 1, true).rotateX(Math.PI / 2);
  const emblemTex = {};
  const textureOf = (name) => {
    if (!emblemTex[name]) {
      const t = new THREE.CanvasTexture(drawEmblem(name, 256));
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      emblemTex[name] = t;
    }
    return emblemTex[name];
  };
  const makeCoin = () => {
    const g = new THREE.Group();
    const faceMat = new THREE.MeshPhysicalMaterial({ roughness: 0.28, metalness: 0.15, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.2, emissive: 0xffffff, emissiveIntensity: 0.42 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x9aa3a8, roughness: 0.22, metalness: 1, envMapIntensity: 1.6 });
    const front = new THREE.Mesh(coinFace, faceMat);
    front.position.z = 0.08;
    const back = new THREE.Mesh(coinFace, faceMat);
    back.position.z = -0.08;
    back.rotation.y = Math.PI;
    g.add(front, back, new THREE.Mesh(coinRim, rimMat));
    g.userData = { faceMat, rimMat, name: null, flip: 1, next: null, spin: Math.random() * 6 };
    return g;
  };
  const setCoin = (coin, name, animate) => {
    const u = coin.userData;
    if (u.name === name) { return; }
    if (!animate || !u.name || reduced) {
      u.name = name;
      u.faceMat.map = u.faceMat.emissiveMap = textureOf(name);
      u.faceMat.needsUpdate = true;
      u.rimMat.color.set(emblemColor(name)).lerp(new THREE.Color(0xc8d0d4), 0.45);
      return;
    }
    u.next = name;
    u.flip = 0;
  };
  const coins = { from: makeCoin(), to: makeCoin() };
  panel.add(coins.from, coins.to);
  const arcMat = flowMaterial({ colorA: 0x00e5d1, colorB: 0x00e5d1, dashes: 9, speed: 0.55, alpha: 0.95 });
  const arc = new THREE.Mesh(new THREE.BufferGeometry(), arcMat);
  panel.add(arc);
  let arcGlow = 0;
  const tint = (name) => new THREE.Color(emblemColor(name)).lerp(new THREE.Color(0x00e5d1), 0.35).multiplyScalar(1.6);
  const paintSwap = (animate) => {
    if (!swap) { return; }
    setCoin(coins.from, swap.state.from.emblem, animate);
    setCoin(coins.to, swap.state.to.emblem, animate);
    arcMat.uniforms.uA.value.copy(tint(swap.state.from.emblem));
    arcMat.uniforms.uB.value.copy(tint(swap.state.to.emblem));
  };
  paintSwap(false);
  if (swap) {
    swap.on((kind) => {
      if (kind === 'change') { paintSwap(true); }
      if (kind === 'quote') { arcGlow = 1; }
    });
  }

  /** Where a slot of the window sits in its own plane, in pixels from its centre (y up). */
  const slotOffset = (el) => {
    let x = el.offsetWidth / 2;
    let y = el.offsetHeight / 2;
    for (let n = el; n && n !== swapEl; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; }
    return [x - swapEl.offsetWidth / 2, swapEl.offsetHeight / 2 - y];
  };
  const PANEL = { distance: 8.2, turn: -0.26, right: 0.045, y: 0.5 };
  const heroCam = new THREE.PerspectiveCamera();
  let threeD = false;
  let panelScale = 0;
  const half = new THREE.Vector2();
  const placePanel = () => {
    if (!swapEl || !threeD) { return; }
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const w = swapEl.offsetWidth;
    const h = swapEl.offsetHeight;
    if (!w || !h || !W || !H) { return; }
    const shot = SHOTS.hero;
    heroCam.fov = camera.fov;
    heroCam.aspect = W / H;
    heroCam.near = camera.near;
    heroCam.far = camera.far;
    shotVec('hero', 'pos', heroCam.position, false);
    heroCam.lookAt(...shot.look);
    heroCam.setViewOffset(W, H, -W * shiftOf('hero'), 0, W, H);
    heroCam.updateProjectionMatrix();
    heroCam.updateMatrixWorld();
    const ppu = H / (2 * PANEL.distance * Math.tan(THREE.MathUtils.degToRad(heroCam.fov / 2)));
    const fit = Math.min(1, (H * 0.7) / h, (W * 0.3) / w);
    panelScale = fit / ppu;
    const cx = W - Math.max(24, W * PANEL.right) - (w * fit) / 2;
    const cy = H * PANEL.y;
    v1.set((cx / W) * 2 - 1, 1 - (cy / H) * 2, 0.5).unproject(heroCam).sub(heroCam.position).normalize();
    heroCam.getWorldDirection(v2);
    panel.position.copy(heroCam.position).addScaledVector(v1, PANEL.distance / v1.dot(v2));
    panel.quaternion.copy(heroCam.quaternion);
    panel.rotateY(PANEL.turn);
    swapObj.scale.setScalar(panelScale);
    half.set((w * panelScale) / 2, (h * panelScale) / 2);
    slab.scale.set(w * panelScale, h * panelScale, 1);
    slabMat.uniforms.uSize.value.set(w, h);
    // the coins sit in their slots, a hair in front of the glass
    const [fx, fy] = slotOffset(swap.slot('from'));
    const [tx, ty] = slotOffset(swap.slot('to'));
    const r = (swap.slot('from').offsetWidth / 2) * panelScale * 0.94;
    coins.from.position.set(fx * panelScale, fy * panelScale, r * 0.35);
    coins.to.position.set(tx * panelScale, ty * panelScale, r * 0.35);
    coins.from.scale.setScalar(r);
    coins.to.scale.setScalar(r);
    const a = coins.from.position;
    const b = coins.to.position;
    const mid = new THREE.Vector3((a.x + b.x) / 2 - r * 1.25, (a.y + b.y) / 2, r * 2.2);
    arc.geometry.dispose();
    arc.geometry = new THREE.TubeGeometry(new THREE.QuadraticBezierCurve3(a.clone().add(new THREE.Vector3(0, -r * 1.05, 0)), mid, b.clone().add(new THREE.Vector3(0, r * 1.05, 0))), 64, r * 0.07, 6, false);
    // the light pool on the floor under the window
    floorMat.uniforms.uPool.value.set(panel.position.x, panel.position.z, 0.16, 0);
  };
  const setMode = () => {
    if (!swapEl) { return; }
    const want = !narrow.matches;
    if (want === threeD) { return; }
    threeD = want;
    swapEl.classList.toggle('in-scene', threeD);
    css.domElement.hidden = !threeD;
    if (!threeD) {
      swapEl.style.opacity = '';
      swapEl.style.display = '';
      swapEl.style.visibility = '';
      swapHome.appendChild(swapEl);
      floorMat.uniforms.uPool.value.set(0, 0, 0, 0);
    }
    panel.visible = threeD;
    beam.visible = threeD;
    placePanel();
  };
  if (swapEl) { new ResizeObserver(() => placePanel()).observe(swapEl); }
  const corner = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const beamPos = beamGeo.attributes.position;
  const beamUv = beamGeo.attributes.uv;
  const apex = new THREE.Vector3();
  const cornerAt = (i, out) => out.set(corner[i][0] * half.x * 0.985, corner[i][1] * half.y * 0.985, -0.01).applyMatrix4(panel.matrixWorld);
  const updateBeam = () => {
    panel.updateMatrixWorld();
    v2.copy(panel.position).sub(cube.position).normalize();
    apex.copy(cube.position).addScaledVector(v2, 1.15);
    for (let i = 0; i < 4; i++) {
      const o = i * 3;
      beamPos.setXYZ(o, apex.x, apex.y, apex.z);
      cornerAt(i, v1);
      beamPos.setXYZ(o + 1, v1.x, v1.y, v1.z);
      cornerAt((i + 1) % 4, v1);
      beamPos.setXYZ(o + 2, v1.x, v1.y, v1.z);
      beamUv.setXY(o, 0.5, 0);
      beamUv.setXY(o + 1, 0, 1);
      beamUv.setXY(o + 2, 1, 1);
    }
    beamPos.needsUpdate = true;
    beamUv.needsUpdate = true;
  };
  const panelRect = { on: false, l: 0, r: 0, t: 0, b: 0 };
  const measurePanel = (W, H) => {
    panelRect.on = threeD && panel.visible;
    if (!panelRect.on) { return; }
    panelRect.l = Infinity; panelRect.r = -Infinity; panelRect.t = Infinity; panelRect.b = -Infinity;
    for (let i = 0; i < 4; i++) {
      cornerAt(i, v1).project(camera);
      const x = (v1.x + 1) / 2 * W;
      const y = (1 - v1.y) / 2 * H;
      panelRect.l = Math.min(panelRect.l, x); panelRect.r = Math.max(panelRect.r, x);
      panelRect.t = Math.min(panelRect.t, y); panelRect.b = Math.max(panelRect.b, y);
    }
  };

  /* -- dust */
  const DUST = narrow.matches ? 260 : 600;
  const dustPos = new Float32Array(DUST * 3);
  for (let i = 0; i < DUST; i++) {
    const r = 2 + Math.random() * 26;
    const a = Math.random() * Math.PI * 2;
    dustPos.set([Math.cos(a) * r, Math.random() * 9, Math.sin(a) * r], i * 3);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  // A mote that drifts up to the lens would grow to a square across the screen,
  // so its size on screen is capped and it fades out close to the camera.
  const dustMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uScale: { value: 400 } },
    vertexShader: 'uniform float uScale; varying float vA; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; float d = -mv.z; gl_PointSize = clamp(0.045 * uScale / d, 0.0, 2.5); vA = smoothstep(1.5, 4.0, d) * exp(-d * 0.04); }',
    fragmentShader: 'varying float vA; void main(){ if (length(gl_PointCoord - 0.5) > 0.5) { discard; } gl_FragColor = vec4(vec3(0.15, 0.9, 0.82) * vA, 1.0); }',
  });
  const dust = new THREE.Points(dustGeo, dustMat);
  scene.add(dust);

  /* ------------------------------------------------------------ labels -- */
  const layer = $('#labels');
  const labels = [];
  const addLabel = (opts) => {
    const el = document.createElement('div');
    el.className = 'lbl ' + (opts.cls || '');
    el.style.opacity = '0';
    layer.appendChild(el);
    const { html, ...rest } = opts;
    const l = { el, w: 0, h: 0, rank: 0, scenes: [], ...rest, html: '' };
    if (html) { setLabel(l, html); }
    labels.push(l);
    return l;
  };
  const setLabel = (l, html) => { if (l.html !== html) { l.el.innerHTML = html; l.html = html; l.w = 0; } };
  const dropLabels = (tag) => {
    for (let i = labels.length - 1; i >= 0; i--) { if (labels[i].tag === tag) { labels[i].el.remove(); labels.splice(i, 1); } }
  };

  const newest = addLabel({ scenes: ['hero', 'chain'], rank: 10, at: () => {
    const b = road[road.length - 1];
    if (!b) { return null; }
    blockPoint(b.slot, v1);
    return v1.setY(0.75);
  } });
  const busiest = addLabel({ scenes: ['chain'], rank: 6, cls: 'hot', at: () => {
    for (let i = road.length - 2; i >= 0; i--) { if (road[i].tx > 0) { blockPoint(road[i].slot, v1); return v1.setY(0.95); } }
    return null;
  } });
  doors.forEach((m) => {
    const el = m.userData.el;
    const dev = el.dataset.status === 'dev';
    addLabel({ scenes: ['doors'], rank: dev ? 2 : 4, cls: dev ? 'dev' : '', html: `${esc(el.querySelector('b').textContent)}<small>${dev ? 'in development' : esc(el.dataset.kind)}</small>`, at: () => v1.copy(m.position).setY(m.position.y + 0.85) });
  });
  const zigLabels = (tokens) => {
    dropLabels('zig');
    zigStones.slice(0, 6).forEach((m, i) => {
      const t = tokens[i];
      if (!t) { return; }
      addLabel({ tag: 'zig', scenes: ['launched'], rank: 8 - i, html: `$${esc(t.symbol)}<small>${esc(t.name)} · ${esc(day(t.launched_at))}</small>`, at: () => m.getWorldPosition(v1).setY(v1.y + 0.6) });
    });
  };
  launchpad.listeners.push(buildZiggurat);
  if (launchpad.tokens.length) { buildZiggurat(launchpad.tokens); }
  const twoLabel = addLabel({ scenes: ['next', 'hero'], rank: 7, cls: 'big', html: 'Cyberia 2.0<small>Avalanche L1 · Fuji testnet</small>', at: () => v1.copy(NEXT).setY(NEXT.y + 2.3) });
  const showFuji = (f) => setLabel(twoLabel, `Cyberia 2.0<small>Avalanche L1 · Fuji · block #${fmt.format(f.block ? f.block.number : 0)}</small>`);
  fuji.listeners.push(showFuji);
  if (fuji.data) { showFuji(fuji.data); }
  addLabel({ scenes: ['next'], rank: 6, cls: 'soon', html: 'Bridge to 2.0<small>opens with mainnet</small>', at: () => bridgeCurve.getPointAt(0.86, v1).setY(v1.y - 0.15) });

  const P = new THREE.Vector3();
  const placeLabels = (active, copyRight) => {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const placed = [];
    labels.slice().sort((a, b) => b.rank - a.rank).forEach((l) => {
      let show = l.scenes.includes(active);
      let x = 0;
      let y = 0;
      if (show) {
        const at = l.at();
        if (!at) { show = false; } else {
          P.copy(at).project(camera);
          if (P.z > 1 || Math.abs(P.x) > 1.02 || Math.abs(P.y) > 1.02) { show = false; }
          x = (P.x + 1) / 2 * W;
          y = (1 - P.y) / 2 * H;
        }
      }
      if (show) {
        if (!l.w) { l.w = l.el.offsetWidth || 120; l.h = l.el.offsetHeight || 30; }
        const box = { l: x - l.w / 2, r: x + l.w / 2, t: y - l.h - 6, b: y - 6 };
        if (box.l < copyRight + 8 || box.l < 4 || box.r > W - 4 || box.t < 56) { show = false; }
        if (show && panelRect.on && box.l < panelRect.r + 8 && box.r > panelRect.l - 8 && box.t < panelRect.b + 8 && box.b > panelRect.t - 8) { show = false; }
        if (show && placed.some((p) => box.l < p.r + 6 && box.r > p.l - 6 && box.t < p.b + 4 && box.b > p.t - 4)) { show = false; }
        if (show) {
          placed.push(box);
          l.el.style.transform = `translate(${box.l.toFixed(1)}px, ${box.t.toFixed(1)}px)`;
        }
      }
      if (show !== l.shown) { l.el.style.opacity = show ? '1' : '0'; l.shown = show; }
    });
  };

  /* ------------------------------------------------------------ camera -- */
  const SHOTS = {
    hero: { pos: [7.4, 4.6, 11.4], look: [1.1, 1.85, -0.5], shift: 0.1, phone: 0.95, phoneLook: [0.4, 1.6, -0.6], doors: 0, swap: 1, bridge: 0 },
    chain: { pos: [7.6, 2.3, -6.8], look: [0.4, 0.8, -1.8], shift: 0.16, phone: 1.15, doors: 0, bridge: 0.3 },
    doctrine: { pos: [4.4, 3.7, 4.9], look: [0, 2.1, 0], shift: 0.2, phone: 1.35, doors: 0, bridge: 0.3 },
    doors: { pos: [0, 13.5, 16.5], look: [0, 0, 0.6], shift: 0.15, phone: 1.25, orbit: true, doors: 1, bridge: 0.35 },
    launched: { pos: [-4.6, 5.6, 13.8], look: [-12.5, 1.5, 5.5], shift: 0.18, phone: 1.3, doors: 1, bridge: 0.35 },
    next: { pos: [9.6, 5.2, -2.6], look: [14.2, 3.9, -12.2], shift: 0.18, phone: 1.25, doors: 1, bridge: 1 },
    join: { pos: [-3.6, 8.2, 11.8], look: [0.3, 1.3, 0], shift: 0.2, phone: 1.2, doors: 1, bridge: 0.6 },
  };
  const sections = $$('[data-scene]');
  const navLinks = $$('.nav nav a');
  const want = { pos: new THREE.Vector3(), look: new THREE.Vector3(), shift: 0, orbit: 0, doors: 0, swap: 0, bridge: 0 };
  let doorsUp = 0;
  let swapUp = 1;
  const cur = { pos: new THREE.Vector3(...SHOTS.hero.pos), look: new THREE.Vector3(...SHOTS.hero.look), shift: SHOTS.hero.shift };
  const drag = { yaw: 0, pitch: 0, vy: 0, vp: 0, down: false, moved: false, x: 0, y: 0, idle: 0 };
  let active = 'hero';
  let activeIndex = 0;
  let orbitAngle = 0;
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();

  // On a narrow desktop the copy, the cube and the swap window share less
  // width: the first shot steps back and slides the scene right.
  const tight = (name, isPhone) => (isPhone || name !== 'hero' ? 0 : THREE.MathUtils.clamp((1240 - canvas.clientWidth) / 300, 0, 1));
  const shiftOf = (name) => SHOTS[name].shift + 0.07 * tight(name, false);
  const shotVec = (name, key, out, isPhone) => {
    const s = SHOTS[name];
    out.set(...(key === 'look' && isPhone && s.phoneLook ? s.phoneLook : s[key]));
    if (key === 'pos' && isPhone) {
      // the same direction and distance, scaled, around the phone's own focus
      out.sub(new THREE.Vector3(...s.look)).multiplyScalar(s.phone).add(new THREE.Vector3(...(s.phoneLook || s.look)));
    } else if (key === 'pos') {
      out.sub(new THREE.Vector3(...s.look)).multiplyScalar(1 + 0.3 * tight(name, isPhone)).add(new THREE.Vector3(...s.look));
    }
    return out;
  };
  const aimCamera = () => {
    const isPhone = narrow.matches;
    const H = innerHeight;
    const band = isPhone ? canvas.clientHeight : 0;
    const focus = isPhone ? band + (H - band) * 0.32 : H * 0.5;
    const centers = sections.map((s) => { const r = s.getBoundingClientRect(); return r.top + Math.min(r.height, H) / 2; });
    let i = 0;
    while (i < centers.length - 1 && centers[i + 1] <= focus) { i++; }
    let t = 0;
    if (i < centers.length - 1 && centers[i] < focus) {
      t = (focus - centers[i]) / Math.max(1, centers[i + 1] - centers[i]);
      t = THREE.MathUtils.smoothstep(t, 0.2, 0.8);
    }
    const a = sections[i].dataset.scene;
    const b = sections[Math.min(i + 1, sections.length - 1)].dataset.scene;
    shotVec(a, 'pos', A, isPhone);
    shotVec(b, 'pos', B, isPhone);
    want.pos.lerpVectors(A, B, t);
    want.pos.y += Math.sin(Math.PI * t) * 1.2;
    shotVec(a, 'look', A, isPhone);
    shotVec(b, 'look', B, isPhone);
    want.look.lerpVectors(A, B, t);
    want.shift = isPhone ? 0 : THREE.MathUtils.lerp(shiftOf(a), shiftOf(b), t);
    want.orbit = (SHOTS[a].orbit ? 1 - t : 0) + (SHOTS[b].orbit ? t : 0);
    want.doors = THREE.MathUtils.lerp(SHOTS[a].doors, SHOTS[b].doors, t);
    want.swap = THREE.MathUtils.clamp(THREE.MathUtils.lerp(SHOTS[a].swap || 0, SHOTS[b].swap || 0, Math.min(1, t * 1.6)), 0, 1);
    want.bridge = THREE.MathUtils.lerp(SHOTS[a].bridge || 0, SHOTS[b].bridge || 0, t);
    const nextActive = t < 0.5 ? a : b;
    const idx = t < 0.5 ? i : Math.min(i + 1, sections.length - 1);
    if (nextActive !== active) {
      active = nextActive;
      activeIndex = idx;
      navLinks.forEach((n) => n.classList.toggle('on', n.getAttribute('href') === '#' + sections[idx].id));
    }
  };

  /* ------------------------------------------------------------- input -- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const tip = $('#tip');
  let hovered = null;
  let tipped = null;

  const describe = (hit) => {
    const o = hit.object;
    const kind = o.userData.pick;
    if (kind === 'block') {
      const b = road[hit.instanceId];
      if (!b) { return null; }
      const tx = b.tx === null ? 'not read' : `${b.tx} transaction${b.tx === 1 ? '' : 's'}`;
      return { key: 'b' + b.n, html: `<span class="k">Block</span><b>#${fmt.format(b.n)}</b>${tx}${b.ts ? ' · ' + ago(b.ts) : ''}<span class="go">Open in the explorer ↗</span>`, go: () => window.open(CFG.explorer + 'block/' + b.n, '_blank', 'noopener'), block: hit.instanceId };
    }
    if (kind === 'door') {
      const el = o.userData.el;
      const href = el.getAttribute('href');
      return { key: el, html: `<span class="k">${esc(el.dataset.kind)}</span><b>${esc(el.querySelector('b').textContent)}</b>${esc(el.dataset.desc)}<span class="go">${href ? 'Go through →' : 'In development'}</span>`, go: href ? () => { location.href = href; } : null, door: o };
    }
    if (kind === 'token') {
      const t = o.userData.token;
      return { key: t.address, html: `<span class="k">$${esc(t.symbol)} · launched ${esc(day(t.launched_at))}</span><b>${esc(t.name)}</b>${t.description ? esc(String(t.description).slice(0, 140)) : ''}<span class="go">Open the token →</span>`, go: () => { location.href = CFG.tokenPage + '/' + t.address; }, stone: o };
    }
    if (kind === 'cube') {
      const n = chain.head ? '#' + fmt.format(chain.head.n) : 'reading…';
      return { key: 'cube', html: `<span class="k">Cyberia L1 · chain 49406</span><b>Block ${n}</b>A block every second since genesis, every one of them public.<span class="go">Open the explorer ↗</span>`, go: () => window.open(CFG.explorer, '_blank', 'noopener') };
    }
    if (kind === 'next') {
      const f = fuji.data;
      return { key: 'next', html: `<span class="k">Avalanche L1 · Fuji testnet</span><b>Cyberia 2.0</b>${f && f.block ? 'Block #' + fmt.format(f.block.number) + '. ' : ''}Fees go to the DAO treasury. Mainnet is next.<span class="go">Get test CYBER →</span>`, go: () => { location.href = '/fuji'; } };
    }
    return null;
  };
  const pick = (x, y) => {
    const r = canvas.getBoundingClientRect();
    if (y > r.bottom || y < r.top) { return null; }
    ndc.set((x - r.left) / r.width * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(pickables, false);
    for (const h of hits) { const d = describe(h); if (d) { return d; } }
    return null;
  };
  const showTip = (d, x, y) => {
    if (!d) { tip.hidden = true; return; }
    tip.innerHTML = d.html;
    tip.hidden = false;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    tip.style.left = Math.min(innerWidth - w - 8, x + 16) + 'px';
    tip.style.top = Math.min(innerHeight - h - 8, Math.max(8, y + 16)) + 'px';
  };
  const setHover = (d) => {
    hovered = d;
    hoverBlock = d && d.block !== undefined ? d.block : -1;
    doors.forEach((m) => { m.userData.pointed = d && d.door === m; m.userData.el.classList.toggle('hover', !!(d && d.door === m)); });
    zigStones.forEach((m) => { m.userData.pointed = d && d.stone === m; });
    canvas.classList.toggle('pointing', !!(d && d.go));
  };

  canvas.addEventListener('pointerdown', (e) => {
    drag.down = true;
    drag.moved = false;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.sx = e.clientX;
    drag.sy = e.clientY;
    drag.type = e.pointerType;
  });
  addEventListener('pointermove', (e) => {
    if (drag.down) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 5) {
        drag.moved = true;
        canvas.classList.add('dragging');
        tip.hidden = true;
      }
      if (drag.moved) {
        drag.vy = -dx * 0.006;
        drag.vp = e.pointerType === 'touch' ? 0 : dy * 0.004;
        drag.yaw += drag.vy;
        drag.pitch = THREE.MathUtils.clamp(drag.pitch + drag.vp, -0.35, 0.5);
        drag.idle = 0;
      }
      drag.x = e.clientX;
      drag.y = e.clientY;
      return;
    }
    if (e.pointerType === 'touch' || e.target !== canvas) {
      if (hovered && e.target !== canvas && e.pointerType !== 'touch') { setHover(null); tip.hidden = true; }
      return;
    }
    const d = pick(e.clientX, e.clientY);
    setHover(d);
    showTip(d, e.clientX, e.clientY);
  });
  const release = (e) => {
    if (!drag.down) { return; }
    drag.down = false;
    canvas.classList.remove('dragging');
    if (drag.moved || e.type === 'pointercancel') { return; }
    const d = pick(e.clientX, e.clientY);
    if (!d) { tip.hidden = true; setHover(null); tipped = null; return; }
    if (drag.type === 'touch' && tipped !== d.key) {
      tipped = d.key;
      setHover(d);
      showTip(d, e.clientX, e.clientY);
      return;
    }
    tipped = null;
    if (d.go) { d.go(); }
  };
  addEventListener('pointerup', release);
  addEventListener('pointercancel', release);
  addEventListener('scroll', () => { if (drag.type === 'touch') { tip.hidden = true; tipped = null; } }, { passive: true });

  /* ------------------------------------------------------------ resize -- */
  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = Math.min(devicePixelRatio || 1, narrow.matches ? 1.5 : 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(dpr);
    composer.setSize(w, h);
    bloom.resolution.set(w / 2, h / 2);
    finish.uniforms.uRes.value.set(w * dpr, h * dpr);
    const mirrorScale = narrow.matches ? 0.35 : 0.5;
    const rw = Math.max(2, Math.round(w * dpr * mirrorScale));
    const rh = Math.max(2, Math.round(h * dpr * mirrorScale));
    reflection.setSize(rw, rh);
    floorMat.uniforms.uTexel.value.set(1 / rw, 1 / rh);
    fatLines.forEach((m) => m.resolution.set(w, h));
    dustMat.uniforms.uScale.value = h * Math.min(devicePixelRatio || 1, 2) / 2;
    camera.aspect = w / h;
    camera.fov = w / h < 1.1 ? 46 : 38;
    camera.updateProjectionMatrix();
    css.setSize(w, h);
    setMode();
    placePanel();
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  /* -------------------------------------------------------------- loop -- */
  let last = performance.now();
  let glitchAt = 6;
  const baseCyan = new THREE.Color(0x00e5d1);
  const magenta = new THREE.Color(0xff2bd6);
  const frame = (t) => {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    now = (t - t0) / 1000;

    aimCamera();
    if (!drag.down) {
      drag.yaw += drag.vy;
      drag.pitch = THREE.MathUtils.clamp(drag.pitch + drag.vp, -0.35, 0.5);
      drag.vy *= 0.92;
      drag.vp *= 0.92;
      drag.idle += dt;
      if (drag.idle > 2.5) {
        const k = 1 - Math.exp(-dt * 1.2);
        drag.yaw -= drag.yaw * k;
        drag.pitch -= drag.pitch * k;
      }
    }
    if (!reduced) { orbitAngle += dt * 0.06 * want.orbit; }
    orbitAngle *= want.orbit > 0.01 ? 1 : 0.97;

    const k = reduced ? 1 : 1 - Math.exp(-dt * 3.2);
    cur.pos.lerp(want.pos, k);
    cur.look.lerp(want.look, k);
    cur.shift += (want.shift - cur.shift) * k;
    A.copy(cur.pos).sub(cur.look);
    A.applyAxisAngle(THREE.Object3D.DEFAULT_UP, drag.yaw + orbitAngle);
    const right = B.set(A.z, 0, -A.x).normalize();
    A.applyAxisAngle(right, -drag.pitch);
    if (A.y < 0.6) { A.y = 0.6; }
    camera.position.copy(cur.look).add(A);
    camera.lookAt(cur.look);
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    if (cur.shift > 0.001) { camera.setViewOffset(W, H, -W * cur.shift, 0, W, H); } else { camera.clearViewOffset(); }
    camera.updateMatrixWorld();

    if (!reduced) {
      cube.position.y = 2.1 + Math.sin(now * 0.9) * 0.08;
      cube.rotation.y += dt * 0.07;
      seed.rotation.x += dt * 0.3;
      seed.rotation.y += dt * 0.4;
      two.rotation.y -= dt * 0.08;
      inner.rotation.x += dt * 0.12;
      inner.rotation.z += dt * 0.09;
      const p = dust.geometry.attributes.position;
      for (let i = 0; i < DUST; i++) { let y = p.getY(i) + dt * 0.12; if (y > 9) { y = 0; } p.setY(i, y); }
      p.needsUpdate = true;
      if (now > glitchAt) {
        const on = now < glitchAt + 0.12;
        faces.forEach((m) => m.emissive.copy(on ? magenta : baseCyan));
        cube.position.x = on ? (Math.random() - 0.5) * 0.08 : 0;
        if (!on) { glitchAt = now + 6 + Math.random() * 7; }
      }
    }
    doors.forEach((m) => {
      const u = m.userData;
      const hot = u.hot || u.pointed;
      const bob = reduced ? 0 : Math.sin(now * 1.2 + u.phase) * 0.05 * doorsUp;
      m.position.y = THREE.MathUtils.lerp(-0.6, 0.78, doorsUp) + bob;
      const s = THREE.MathUtils.lerp(m.scale.x, hot ? 1.16 : 1, 1 - Math.exp(-dt * 10));
      m.scale.setScalar(s);
      m.material.emissiveIntensity = THREE.MathUtils.lerp(m.material.emissiveIntensity, u.base * (hot ? 1.8 : 1), 1 - Math.exp(-dt * 8));
    });
    zigStones.forEach((m) => {
      if (!m.userData.token) { return; }
      const target = m.userData.pointed ? 0.18 : 0;
      m.position.y += ((Math.round((m.position.y - 0.41) / 0.86) * 0.86 + 0.41 + target) - m.position.y) * (1 - Math.exp(-dt * 10));
    });
    updateRoad(dt);
    doorsUp += (want.doors - doorsUp) * (reduced ? 1 : 1 - Math.exp(-dt * 2.5));

    // the swap window: there in the hero, gone everywhere else
    swapUp += (want.swap - swapUp) * (reduced ? 1 : 1 - Math.exp(-dt * 6));
    const showing = threeD && swapUp > 0.02;
    if (threeD) {
      panel.visible = showing;
      beam.visible = showing;
      if (swapEl) {
        swapEl.style.opacity = swapUp.toFixed(3);
        swapEl.style.visibility = showing ? '' : 'hidden';
      }
      slabMat.uniforms.uAlpha.value = swapUp;
      beamMat.uniforms.uAlpha.value = swapUp;
      floorMat.uniforms.uPool.value.z = 0.16 * swapUp;
    }
    if (showing) {
      slabMat.uniforms.uTime.value = now;
      slabMat.uniforms.uBusy.value += (((swap && swap.state.busy) ? 1 : 0) - slabMat.uniforms.uBusy.value) * Math.min(1, dt * 6);
      beamMat.uniforms.uTime.value = reduced ? 0 : now;
      arcMat.uniforms.uTime.value = reduced ? 0 : now * (swap && swap.state.busy ? 2.6 : 1);
      arcGlow = Math.max(0, arcGlow - dt * 0.9);
      arcMat.uniforms.uGlow.value = (swap && swap.state.quote ? 1 : 0.45) + arcGlow * 1.6;
      [coins.from, coins.to].forEach((c, i) => {
        const u = c.userData;
        if (u.flip < 1) {
          u.flip = Math.min(1, u.flip + dt * 2.4);
          if (u.flip >= 0.5 && u.next) { const n = u.next; u.next = null; u.name = null; setCoin(c, n, false); }
        }
        const turn = u.flip < 1 ? Math.PI * u.flip : 0;
        c.rotation.y = (reduced ? 0 : Math.sin(now * 0.7 + i * 2.1) * 0.42) + turn;
      });
      updateBeam();
    }
    bridgeMat.uniforms.uTime.value = reduced ? 0 : now;
    bridgeMat.uniforms.uAlpha.value += (want.bridge * 0.8 - bridgeMat.uniforms.uAlpha.value) * Math.min(1, dt * 3);

    const b = road[road.length - 1];
    if (b) { setLabel(newest, `#${fmt.format(b.n)}<small>${b.tx === null ? 'newest block' : b.tx + ' tx'} · ${b.ts ? ago(b.ts) : ''}</small>`); }
    let busy = null;
    for (let i = road.length - 2; i >= 0; i--) { if (road[i].tx > 0) { busy = road[i]; break; } }
    if (busy) { setLabel(busiest, `#${fmt.format(busy.n)}<small>${busy.tx} tx · ${ago(busy.ts)}</small>`); }

    finish.uniforms.uTime.value = now;
    renderReflection();
    composer.render();
    if (showing) { css.render(scene, camera); }
    measurePanel(W, H);
    const copy = narrow.matches ? null : sections[activeIndex].querySelector('.copy');
    const cr = copy ? copy.getBoundingClientRect() : null;
    placeLabels(active, cr && cr.bottom > 0 && cr.top < innerHeight ? cr.right : 0);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* --------------------------------------------------------------- start -- */
const swapRoot = $('#swap');
const swap = swapRoot ? createSwap(swapRoot, CFG.swap || {}) : null;
countDoors();
wireAddNetwork();
boot(swap);
pollChain();
readStats();
readTokens();
readFuji();
