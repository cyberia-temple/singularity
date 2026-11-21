/*
 * The cross-chain swap window on /3d — public/js/cyberia-3d.js draws it into
 * the scene, this file owns its form and its numbers.
 *
 * A route is priced the way the wallet prices it: through this host's
 * /api/wallet/crosschain/quote, which asks Relay with Cyberia's fee composed on
 * the server. A quote needs somebody to quote for, so the window asks for an
 * address nobody holds — a fresh random one per visit (a random bech32 for
 * bitcoin, a key generated once and thrown away for Solana). Nothing is signed
 * here and nothing is sent: "Swap" hands the route to the wallet
 * (/wallet?section=crosschain&from=…&to=…&amount=…), which prices it again for
 * the user's own address and leaves the hold to them.
 *
 * The scene listens through `on()`: which two coins to show, when a quote is
 * on its way and when one has landed.
 */

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * What the window offers. The wallet signs the paying side, so a source is an
 * EVM network the wallet can switch on; Bitcoin and Solana are places to
 * receive. `currency` is the router's id for a token; none means the chain's
 * own coin, named the way the router's chain list names it.
 */
export const ASSETS = [
  { id: 'eth-robinhood', chain: 4663, symbol: 'ETH', net: 'Robinhood', emblem: 'robinhood' },
  { id: 'eth-base', chain: 8453, symbol: 'ETH', net: 'Base', emblem: 'base' },
  { id: 'eth-ethereum', chain: 1, symbol: 'ETH', net: 'Ethereum', emblem: 'ethereum' },
  { id: 'eth-arbitrum', chain: 42161, symbol: 'ETH', net: 'Arbitrum', emblem: 'arbitrum' },
  { id: 'eth-optimism', chain: 10, symbol: 'ETH', net: 'Optimism', emblem: 'optimism' },
  { id: 'bnb', chain: 56, symbol: 'BNB', net: 'BNB Chain', emblem: 'bnb' },
  { id: 'avax', chain: 43114, symbol: 'AVAX', net: 'Avalanche', emblem: 'avalanche' },
  { id: 'pol', chain: 137, symbol: 'POL', net: 'Polygon', emblem: 'polygon' },
  { id: 'usdc-base', chain: 8453, symbol: 'USDC', net: 'Base', emblem: 'usdc', currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { id: 'usdc-ethereum', chain: 1, symbol: 'USDC', net: 'Ethereum', emblem: 'usdc', currency: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
  { id: 'usdc-arbitrum', chain: 42161, symbol: 'USDC', net: 'Arbitrum', emblem: 'usdc', currency: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
  { id: 'btc', chain: 8253038, symbol: 'BTC', net: 'Bitcoin', emblem: 'bitcoin', receiveOnly: true },
  { id: 'sol', chain: 792703809, symbol: 'SOL', net: 'Solana', emblem: 'solana', receiveOnly: true },
  { id: 'usdc-solana', chain: 792703809, symbol: 'USDC', net: 'Solana', emblem: 'usdc', currency: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, receiveOnly: true },
];
const DEFAULT = { from: 'eth-robinhood', to: 'btc', amount: '0.05' };

/* -------------------------------------------------------------- emblems -- */

/*
 * Each network's mark, drawn rather than downloaded: the scene needs them as
 * textures (a picture from another origin cannot be one without CORS) and the
 * flat window needs them before any request answers. Simplified on purpose —
 * a mark to tell the coins apart at 40 pixels, not a reproduction.
 */
const poly = (g, pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill(); };
const EMBLEMS = {
  bitcoin: { bg: '#f7931a', fg: '#ffffff', draw(g) {
    g.save(); g.translate(256, 256); g.rotate(-0.24); g.translate(-256, -256);
    g.font = '800 250px Manrope, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('B', 262, 268);
    g.fillRect(212, 112, 22, 52); g.fillRect(268, 112, 22, 52); g.fillRect(212, 368, 22, 52); g.fillRect(268, 368, 22, 52);
    g.restore();
  } },
  ethereum: { bg: '#3c4a8f', fg: '#ffffff', draw(g) {
    g.globalAlpha = 0.95; poly(g, [[256, 84], [372, 262], [256, 330], [140, 262]]);
    g.globalAlpha = 0.7; poly(g, [[256, 84], [256, 330], [140, 262]]);
    g.globalAlpha = 0.95; poly(g, [[256, 356], [372, 288], [256, 436], [140, 288]]);
    g.globalAlpha = 0.7; poly(g, [[256, 356], [256, 436], [140, 288]]);
    g.globalAlpha = 1;
  } },
  solana: { bg: '#0d0b16', fg: '#14f195', draw(g) {
    const grad = g.createLinearGradient(120, 380, 400, 130);
    grad.addColorStop(0, '#9945ff'); grad.addColorStop(1, '#14f195');
    g.fillStyle = grad;
    const s = 36;
    const bar = (y, lean) => poly(g, lean
      ? [[128 + s, y], [404, y], [404 - s, y + 56], [128, y + 56]]
      : [[128, y], [404 - s, y], [404, y + 56], [128 + s, y + 56]]);
    bar(150, true);
    bar(236, false);
    bar(322, true);
  } },
  base: { bg: '#0052ff', fg: '#ffffff', draw(g) {
    g.beginPath(); g.arc(256, 256, 150, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#0052ff'; g.fillRect(96, 240, 190, 32);
  } },
  arbitrum: { bg: '#1b2a3f', fg: '#ffffff', draw(g) {
    g.lineWidth = 30; g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = '#28a0f0';
    g.beginPath(); g.moveTo(256, 96); g.lineTo(398, 178); g.lineTo(398, 334); g.lineTo(256, 416); g.lineTo(114, 334); g.lineTo(114, 178); g.closePath(); g.stroke();
    g.strokeStyle = '#ffffff';
    g.beginPath(); g.moveTo(186, 350); g.lineTo(252, 176); g.lineTo(272, 176); g.lineTo(338, 350); g.stroke();
    g.strokeStyle = '#28a0f0';
    g.beginPath(); g.moveTo(222, 304); g.lineTo(304, 304); g.stroke();
  } },
  optimism: { bg: '#ff0420', fg: '#ffffff', draw(g) {
    g.font = 'italic 800 170px Manrope, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('OP', 256, 270);
  } },
  bnb: { bg: '#f3ba2f', fg: '#181a20', draw(g) {
    const d = (x, y, r) => poly(g, [[x, y - r], [x + r, y], [x, y + r], [x - r, y]]);
    d(256, 256, 52); d(256, 136, 46); d(256, 376, 46); d(136, 256, 46); d(376, 256, 46);
  } },
  avalanche: { bg: '#e84142', fg: '#ffffff', draw(g) {
    poly(g, [[236, 104], [292, 200], [196, 384], [92, 384]]);
    poly(g, [[322, 254], [420, 384], [252, 384]]);
  } },
  polygon: { bg: '#7b3fe4', fg: '#ffffff', draw(g) {
    g.lineWidth = 34; g.lineJoin = 'round'; g.strokeStyle = '#ffffff';
    const hex = (x, y, r) => { g.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; g[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r); } g.closePath(); g.stroke(); };
    hex(196, 292, 78); hex(316, 220, 78);
  } },
  robinhood: { bg: '#0b0f08', fg: '#ccff00', draw(g) {
    g.beginPath(); g.moveTo(150, 400); g.bezierCurveTo(170, 250, 260, 130, 396, 98); g.bezierCurveTo(352, 230, 282, 330, 150, 400); g.fill();
    g.strokeStyle = '#0b0f08'; g.lineWidth = 12; g.lineCap = 'round';
    g.beginPath(); g.moveTo(170, 380); g.quadraticCurveTo(270, 260, 372, 122); g.stroke();
  } },
  usdc: { bg: '#2775ca', fg: '#ffffff', draw(g) {
    g.lineWidth = 26; g.strokeStyle = '#ffffff';
    g.beginPath(); g.arc(256, 256, 150, Math.PI * 0.62, Math.PI * 1.38); g.stroke();
    g.beginPath(); g.arc(256, 256, 150, -Math.PI * 0.38, Math.PI * 0.38); g.stroke();
    g.font = '800 200px Manrope, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('$', 256, 266);
  } },
};

/** A network's mark on a coin face: its colour, its sign, a lit rim. */
export function drawEmblem(name, size = 256) {
  const e = EMBLEMS[name] || EMBLEMS.ethereum;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.scale(size / 512, size / 512);
  const grad = g.createRadialGradient(200, 170, 40, 256, 256, 280);
  grad.addColorStop(0, shade(e.bg, 0.22));
  grad.addColorStop(1, shade(e.bg, -0.25));
  g.fillStyle = grad;
  g.beginPath(); g.arc(256, 256, 256, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(255,255,255,.28)';
  g.lineWidth = 10;
  g.beginPath(); g.arc(256, 256, 236, 0, Math.PI * 2); g.stroke();
  g.fillStyle = g.strokeStyle = e.fg;
  e.draw(g);
  return c;
}
export const emblemColor = (name) => (EMBLEMS[name] || EMBLEMS.ethereum).bg;

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.round(k >= 0 ? v + (255 - v) * k : v * (1 + k));
  return `rgb(${ch(n >> 16)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/* ------------------------------------------------- addresses for a quote -- */

const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) { if ((b >> i) & 1) { chk ^= G[i]; } }
  }
  return chk;
}
function convertBits(data, from, to) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  const maxAcc = (1 << (from + to - 1)) - 1;
  for (const v of data) {
    acc = ((acc << from) | v) & maxAcc;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & maxv); }
  }
  if (bits > 0) { out.push((acc << (to - bits)) & maxv); }
  return out;
}
/** A segwit v0 address for a random key hash: valid, and nobody's. */
export function randomBitcoinAddress(program = randomBytes(20)) {
  const hrp = [...'bc'].map((c) => c.charCodeAt(0));
  const data = [0, ...convertBits(program, 8, 5)];
  const mod = polymod([...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const check = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return 'bc1' + [...data, ...check].map((d) => CHARSET[d]).join('');
}
/** An ed25519 public key whose secret was generated and discarded, so it is on the curve and nobody can spend. */
const SOLANA_NOBODY = 'EagjU7FGmg2a52DxPwXuzMqYPiXHTSz7AnyQFVNFJdHV';

/* ---------------------------------------------------------------- money -- */

function toUnits(text, decimals) {
  const m = /^(\d{0,18})(?:\.(\d*))?$/.exec(String(text).trim());
  if (!m || (!m[1] && !m[2])) { return null; }
  const frac = (m[2] || '').slice(0, decimals).padEnd(decimals, '0');
  const units = BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt(frac || '0');
  return units > 0n ? units : null;
}
function showAmount(raw, decimals) {
  const n = Number(raw) / 10 ** decimals;
  if (!isFinite(n)) { return '–'; }
  if (n === 0) { return '0'; }
  return n >= 1
    ? n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 2 : 4 })
    : n.toLocaleString('en-US', { maximumSignificantDigits: 5 });
}
const showTime = (s) => (!s ? '' : s < 50 ? `~${Math.max(1, Math.round(s))} s` : `~${Math.round(s / 60)} min`);
/** The typed amount as the wallet should read it: a leading zero, and no more decimals than the coin has. */
function linkAmount(text, decimals) {
  const m = /^(\d*)(?:\.(\d*))?$/.exec(String(text).trim());
  if (!m) { return null; }
  const frac = (m[2] || '').slice(0, decimals).replace(/0+$/, '');
  return (m[1] || '0').replace(/^0+(?=\d)/, '') + (frac ? '.' + frac : '');
}
/** How often a price on screen is asked again while the window is in view. */
const REFRESH_MS = 30000;

/* --------------------------------------------------------------- window -- */

export function createSwap(root, cfg) {
  const $ = (s) => root.querySelector(s);
  const out = (k) => root.querySelector(`[data-out="${k}"]`);
  const byId = Object.fromEntries(ASSETS.map((a) => [a.id, a]));
  const listeners = [];
  const emit = (kind) => listeners.forEach((f) => f(kind, state));
  const evm = '0x' + [...randomBytes(20)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const recipients = { evm, svm: SOLANA_NOBODY, bvm: randomBitcoinAddress() };
  const state = {
    from: byId[DEFAULT.from],
    to: byId[DEFAULT.to],
    chains: new Map(),
    feeBps: null,
    enabled: true,
    quote: null,
    error: null,
    busy: false,
    picking: null,
  };
  const input = $('#swap-amount');
  input.value = DEFAULT.amount;
  const pick = $('.swap-pick');
  const list = pick.querySelector('ul');
  const emblemUrl = {};
  const emblem = (name) => (emblemUrl[name] ||= drawEmblem(name, 96).toDataURL());

  const chainOf = (a) => state.chains.get(a.chain);
  const currencyOf = (a) => a.currency || (chainOf(a) && chainOf(a).native) || '0x0000000000000000000000000000000000000000';
  const decimalsOf = (a) => a.decimals ?? (chainOf(a) ? chainOf(a).decimals : 18);
  const routed = (a, side) => {
    const c = chainOf(a);
    if (!state.chains.size) { return true; }
    if (!c) { return false; }
    return side === 'from' ? !a.receiveOnly && c.vm === 'evm' && c.deposits : true;
  };

  /* -- drawing the form */
  const paintSide = (side) => {
    const a = state[side];
    const btn = root.querySelector(`[data-pick="${side}"]`);
    btn.innerHTML = `<img src="${emblem(a.emblem)}" alt=""><span class="swap-asset-name"><b>${esc(a.symbol)}</b><span>${esc(a.net)}</span></span><i aria-hidden="true">▾</i>`;
    btn.setAttribute('aria-label', `${side === 'from' ? 'Pay with' : 'Receive'} ${a.symbol} on ${a.net} — change`);
    const slot = root.querySelector(`[data-coin="${side}"]`);
    slot.style.backgroundImage = `url(${emblem(a.emblem)})`;
  };
  const render = () => {
    const q = state.quote;
    root.classList.toggle('busy', state.busy);
    out('amount').textContent = q && q.out ? showAmount(q.out.amount, q.out.decimals) : state.busy ? '…' : '–';
    out('out-usd').textContent = q && q.out && q.out.usd ? '≈ ' + usd.format(+q.out.usd) : '';
    out('in-usd').textContent = q && q.in && q.in.usd ? '≈ ' + usd.format(+q.in.usd) : '';
    out('time').textContent = q ? showTime(q.timeEstimate) || '–' : '–';
    const fee = q && q.fees && q.fees.app;
    const pct = state.feeBps === null ? '' : `${+(state.feeBps / 100).toFixed(2)}%`;
    out('fee').textContent = state.feeBps === 0 ? 'none' : [pct, fee && fee.usd ? usd.format(+fee.usd) : ''].filter(Boolean).join(' · ') || '–';
    out('impact').textContent = q && q.impactPercent !== '' && q.impactPercent !== undefined ? `${Math.abs(+q.impactPercent).toFixed(2)}%` : '–';
    out('note').textContent = !state.enabled ? 'Cross-chain swaps are switched off on this host right now.' : state.error || '';
    out('note').classList.toggle('bad', !!state.error || !state.enabled);
    const go = out('go');
    const units = toUnits(input.value, decimalsOf(state.from));
    const link = new URLSearchParams({ section: 'crosschain', from: String(state.from.chain), to: String(state.to.chain) });
    if (state.from.currency) { link.set('fromToken', state.from.currency); }
    if (state.to.currency) { link.set('toToken', state.to.currency); }
    if (units) { link.set('amount', linkAmount(input.value, decimalsOf(state.from))); }
    go.href = `${cfg.wallet}?${link}`;
    const flip = $('.swap-flip');
    flip.disabled = !routed(state.to, 'from');
    flip.title = flip.disabled ? `${state.to.net} is a place to receive here; spending it starts in the wallet.` : 'Turn the route around';
  };

  /* -- pricing */
  let seq = 0;
  let typing = null;
  const quote = async () => {
    const from = state.from;
    const to = state.to;
    const units = toUnits(input.value, decimalsOf(from));
    const id = ++seq;
    if (!units || !state.enabled) {
      state.quote = null;
      state.busy = false;
      state.error = input.value.trim() && !units ? 'Type an amount above zero.' : null;
      render();
      emit('busy');
      return;
    }
    state.busy = true;
    render();
    emit('busy');
    try {
      const vm = chainOf(to) ? chainOf(to).vm : 'evm';
      const r = await fetch(cfg.quote, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          originChainId: from.chain,
          destinationChainId: to.chain,
          originCurrency: currencyOf(from),
          destinationCurrency: currencyOf(to),
          user: recipients.evm,
          recipient: recipients[vm] || recipients.evm,
          amount: units.toString(),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (id !== seq) { return; }
      if (r.status === 429) { throw new Error('Too many prices asked from here this minute. Try again in a moment.'); }
      if (!r.ok || !body.quote) { throw new Error(body.error || body.message || `The router answered ${r.status}.`); }
      state.quote = body.quote;
      state.error = null;
      emit('quote');
    } catch (e) {
      if (id !== seq) { return; }
      state.quote = null;
      state.error = e instanceof TypeError ? 'The router can’t be reached right now.' : e.message;
    } finally {
      if (id === seq) {
        state.busy = false;
        render();
        emit('busy');
      }
    }
  };
  const requote = (delay = 450) => {
    clearTimeout(typing);
    state.quote = null;
    typing = setTimeout(quote, delay);
    render();
  };

  /* -- picking a coin */
  const openPick = (side) => {
    state.picking = side;
    pick.querySelector('b').textContent = side === 'from' ? 'Pay with' : 'Receive';
    list.innerHTML = ASSETS.filter((a) => routed(a, side)).map((a) => `
      <li><button type="button" role="option" data-asset="${a.id}" aria-selected="${state[side].id === a.id}">
        <img src="${emblem(a.emblem)}" alt=""><b>${esc(a.symbol)}</b><span>${esc(a.net)}</span>
      </button></li>`).join('');
    pick.hidden = false;
    root.classList.add('picking');
    (list.querySelector('[aria-selected="true"]') || list.querySelector('button'))?.focus({ preventScroll: true });
  };
  const closePick = () => {
    if (!state.picking) { return; }
    const side = state.picking;
    state.picking = null;
    pick.hidden = true;
    root.classList.remove('picking');
    root.querySelector(`[data-pick="${side}"]`).focus({ preventScroll: true });
  };
  const choose = (side, asset) => {
    const other = side === 'from' ? 'to' : 'from';
    if (state[other].id === asset.id) { state[other] = state[side]; paintSide(other); }
    state[side] = asset;
    paintSide(side);
    emit('change');
    requote(0);
  };

  root.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => openPick(b.dataset.pick)));
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-asset]');
    if (!b || !state.picking) { return; }
    const side = state.picking;
    closePick();
    choose(side, byId[b.dataset.asset]);
  });
  pick.querySelector('.swap-x').addEventListener('click', closePick);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePick(); } });
  $('.swap-flip').addEventListener('click', () => {
    if (!routed(state.to, 'from')) { return; }
    [state.from, state.to] = [state.to, state.from];
    paintSide('from');
    paintSide('to');
    emit('change');
    requote(0);
  });
  input.addEventListener('input', () => {
    const clean = input.value.replace(',', '.').replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
    if (clean !== input.value) { input.value = clean; }
    requote();
  });

  /* -- what the router reaches, and what this host charges */
  (async () => {
    try {
      const r = await fetch(cfg.config, { headers: { Accept: 'application/json' } });
      if (!r.ok) { throw new Error(String(r.status)); }
      const c = await r.json();
      state.enabled = c.enabled !== false;
      state.feeBps = c.fee ? +c.fee.bps || 0 : null;
      (c.chains || []).forEach((row) => state.chains.set(+row.id, row));
      // A network the router stopped serving leaves the window on one it does.
      for (const side of ['from', 'to']) {
        if (!routed(state[side], side)) {
          const other = state[side === 'from' ? 'to' : 'from'];
          const next = ASSETS.find((a) => routed(a, side) && a.id !== other.id);
          if (next) { state[side] = next; paintSide(side); emit('change'); }
        }
      }
    } catch (e) {
      state.error = 'The router’s list can’t be read right now.';
    }
    render();
    quote();
  })();

  // A price is a moment's answer: while the first screen is on view, it is
  // asked again every half minute, never while one is already on its way.
  const hero = document.getElementById('top');
  setInterval(() => {
    const r = hero ? hero.getBoundingClientRect() : null;
    if (document.hidden || state.busy || state.picking || !state.quote || (r && (r.bottom < 0 || r.top > innerHeight))) { return; }
    quote();
  }, REFRESH_MS);

  paintSide('from');
  paintSide('to');
  render();

  return {
    root,
    state,
    slot: (side) => root.querySelector(`[data-coin="${side}"]`),
    on: (f) => listeners.push(f),
  };
}
