// Cyberia DNS: answers the names in CyberiaDomains — `.cyber` and every zone a
// launchpad token opened — over UDP and TCP on 53 and DNS-over-HTTPS behind
// the site's nginx, plus a JSON view of the same answers for the wallet.
//
// Anything outside our zones is forwarded to an upstream resolver, but over
// plain UDP only when DNS_FORWARD_UDP=1: UDP's source address is forgeable, so
// a server that recurses for anyone on UDP is an amplifier pointed at whoever
// an attacker names. TCP and DoH cannot be spoofed and forward by default, and
// DoH is the door people actually configure in a browser or a phone.

import dgram from 'node:dgram';
import net from 'node:net';
import http from 'node:http';
import { parseQuery, buildResponse, buildQuery, parseAnswers, errorFor, RCODE, TYPE, TYPE_NAME, CLASS_IN, FormatError } from './wire.mjs';
import { createResolver, targetOf } from './resolver.mjs';
import { chainReader } from './chain.mjs';
import { createZoneBook } from './zones.mjs';

const env = process.env;
const flag = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const csv = (v, d) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

export function configFromEnv() {
  return {
    rpcUrl: env.CYBERIA_RPC_URL || 'https://rpc.cyberia.church',
    contract: env.CYBERIA_DOMAINS_ADDRESS || env.CYBERIA_NAMES_ADDRESS,
    // suffix=zone pairs: the chain's names again under a delegated real domain.
    aliases: Object.fromEntries(csv(env.DNS_ALIASES, ['cyber.cyberia.church=cyber']).map((p) => p.split('='))),
    zoneRefreshMs: Number(env.DNS_ZONE_REFRESH_MS || 60_000),
    ipfsGateway: env.IPFS_GATEWAY || 'https://ipfs.io',
    siteUrl: env.CYBERIA_SITE_URL || 'https://cyberia.church',
    ns: csv(env.DNS_NS, ['ns1.cyberia.church']),
    hostmaster: env.DNS_HOSTMASTER || 'hostmaster.cyberia.church',
    ttl: Number(env.DNS_TTL || 60),
    bind: env.DNS_BIND || '0.0.0.0',
    port: Number(env.DNS_PORT || 53),
    dohBind: env.DOH_BIND || '0.0.0.0',
    dohPort: Number(env.DOH_PORT || 8053),
    upstreams: csv(env.DNS_UPSTREAM, ['1.1.1.1', '9.9.9.9']),
    forwardUdp: flag(env.DNS_FORWARD_UDP, false),
    forwardTcp: flag(env.DNS_FORWARD_TCP, true),
    forwardDoh: flag(env.DNS_FORWARD_DOH, true),
    udpQps: Number(env.DNS_UDP_QPS || 20),
  };
}

// ── forwarding ──────────────────────────────────────────────────────────

function hostPort(upstream) {
  const m = upstream.match(/^\[?([^\]]+?)\]?(?::(\d+))?$/);
  return { host: m[1], port: Number(m[2] || 53) };
}

function forwardUdpOnce(msg, upstream, timeoutMs) {
  const { host, port } = hostPort(upstream);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4');
    const done = (err, val) => {
      clearTimeout(timer);
      sock.close();
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => done(new Error('upstream timeout')), timeoutMs);
    sock.on('error', (e) => done(e));
    sock.on('message', (reply) => {
      if (reply.length >= 2 && reply.readUInt16BE(0) === msg.readUInt16BE(0)) done(null, reply);
    });
    sock.send(msg, port, host);
  });
}

function forwardTcpOnce(msg, upstream, timeoutMs) {
  const { host, port } = hostPort(upstream);
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => sock.destroy(new Error('upstream timeout')), timeoutMs);
    sock.on('connect', () => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(msg.length);
      sock.write(Buffer.concat([len, msg]));
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        clearTimeout(timer);
        sock.end();
        resolve(buf.subarray(2, 2 + buf.readUInt16BE(0)));
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** Ask each upstream in turn; a truncated UDP answer is re-asked over TCP. */
async function forward(msg, upstreams, { tcp = false } = {}) {
  let last;
  for (const up of upstreams) {
    try {
      if (tcp) return await forwardTcpOnce(msg, up, 4000);
      const reply = await forwardUdpOnce(msg, up, 2000);
      return reply[2] & 0x02 ? await forwardTcpOnce(msg, up, 4000) : reply;
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error('no upstream');
}

// ── the handler every transport shares ─────────────────────────────────

/**
 * Whether the real root delegates a TLD: anything but NXDOMAIN for
 * `NS <zone>.` means somebody else answers for it. Throws when no upstream
 * gave a usable answer, which the zone book treats as "do not serve".
 */
export function rootChecker(upstreams) {
  return async (zone) => {
    const reply = await forward(buildQuery(`${zone}.`, TYPE.NS), upstreams);
    const rcode = reply[3] & 0xf;
    if (rcode === RCODE.NXDOMAIN) return false;
    if (rcode === RCODE.NOERROR) return true;
    throw new Error(`upstream rcode ${rcode}`);
  };
}

export function createHandler(config, { read, book } = {}) {
  const chain = read ? null : chainReader({ rpcUrl: config.rpcUrl, contract: config.contract });
  const zoneBook =
    book ??
    createZoneBook({
      readZones: chain.zones,
      isDelegated: rootChecker(config.upstreams),
      aliases: config.aliases,
      log: (m) => console.log(m),
    });
  const resolver = createResolver({
    book: zoneBook,
    ns: config.ns,
    hostmaster: config.hostmaster,
    ttl: config.ttl,
    read: read ?? chain.resolve,
  });

  /** One raw query in, one raw response out (or null to stay silent). */
  async function handle(msg, { transport }) {
    let query;
    try {
      query = parseQuery(msg);
    } catch (e) {
      if (e instanceof FormatError) return errorFor(msg, RCODE.FORMERR);
      throw e;
    }
    if (query.qr) return null; // a response sent to us: never answer one
    if (query.opcode !== 0) return buildResponse(query, { rcode: RCODE.NOTIMP, aa: false });
    if (!query.question) return buildResponse(query, { rcode: RCODE.FORMERR, aa: false });

    const limit = transport === 'udp' ? Math.min(query.edns?.udpSize ?? 512, 1232) : 65535;
    const q = query.question;

    if (resolver.zoneOf(q.name)) {
      if (q.class !== CLASS_IN) return buildResponse(query, { rcode: RCODE.REFUSED, aa: false, maxSize: limit });
      try {
        const res = await resolver.answer(q);
        const may = { udp: config.forwardUdp, tcp: config.forwardTcp, doh: config.forwardDoh }[transport];
        if (query.rd) await chase(res, q.type, may);
        log(transport, q, res.rcode);
        return buildResponse(query, { ...res, ra: !!res.chased, maxSize: limit });
      } catch (e) {
        log(transport, q, RCODE.SERVFAIL, e.message);
        return buildResponse(query, { rcode: RCODE.SERVFAIL, aa: false, maxSize: limit });
      }
    }

    const may = { udp: config.forwardUdp, tcp: config.forwardTcp, doh: config.forwardDoh }[transport];
    if (!may || !query.rd) return buildResponse(query, { rcode: RCODE.REFUSED, aa: false, maxSize: limit });

    try {
      const reply = await forward(msg, config.upstreams);
      // Over UDP an upstream answer bigger than the client allows is cut to TC.
      if (transport === 'udp' && reply.length > limit) {
        return buildResponse(query, { rcode: RCODE.NOERROR, aa: false, ra: true, maxSize: 0 });
      }
      return reply;
    } catch {
      return buildResponse(query, { rcode: RCODE.SERVFAIL, aa: false, ra: true, maxSize: limit });
    }
  }

  /**
   * A client that asked for recursion and got `CNAME cyberia.church` wants
   * the address behind it too — a stub (curl, Firefox's DoH) will not ask
   * again by itself. Inside our zones the target is answered here; outside
   * them it is asked upstream, but only on transports allowed to forward.
   */
  async function chase(res, qtype, mayForward) {
    if (qtype === TYPE.CNAME || qtype === TYPE.ANY) return;
    const seen = new Set();
    for (let depth = 0; depth < 8; depth++) {
      const last = res.answers[res.answers.length - 1];
      if (!last || last.type !== TYPE.CNAME || seen.has(last.value)) return;
      seen.add(last.value);
      const target = last.value;

      if (resolver.zoneOf(target)) {
        const next = await resolver.answer({ name: target, type: qtype });
        res.answers.push(...next.answers);
        continue;
      }
      if (!mayForward) return;
      try {
        const reply = await forward(buildQuery(target, qtype), config.upstreams);
        const got = parseAnswers(reply);
        if (got.length) res.chased = true;
        res.answers.push(...got.map((r) => ({ ...r, ttl: Math.min(r.ttl, config.ttl) })));
      } catch {
        // The CNAME alone is still a true answer; the client can chase it.
      }
      return;
    }
  }

  handle.resolver = resolver;
  handle.book = zoneBook;
  return handle;
}

// ── the web gateway ────────────────────────────────────────────────────
//
// A browser that resolved `cyberia.cyber` through us then connects to
// whatever the name points at — and a name pointing at this host lands on the
// site's nginx, which hands every Host it does not know here. No CA issues
// certificates for a TLD that is not in the root, so this half is plain HTTP
// and never more than a redirect or a card: it serves nobody's content as if
// it were its own.

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function webGateway(resolver, req, { ipfsGateway = 'https://ipfs.io', siteUrl = 'https://cyberia.church' } = {}) {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
  const info = await resolver.describe(host);
  const redirect = (to) => ({ status: 302, headers: { location: to, 'cache-control': 'max-age=60' } });
  // Not a name of ours: an unknown Host or the bare IP. Send it home.
  if (!info) return redirect(`${siteUrl}/`);

  const path = req.url.startsWith('/') ? req.url : '/';
  const target = info.registered ? targetOf(info, resolver.zoneOf, ipfsGateway) : { kind: 'none' };
  if (target.kind === 'url') return redirect(target.url);
  if (target.kind === 'cname') return redirect(`https://${info.records.CNAME[0]}${path}`);
  if (target.kind === 'name') return redirect(`http://${target.name}${path}`);
  if (target.kind === 'ipfs') return redirect(`${ipfsGateway}${target.path}${path === '/' ? '/' : path}`);

  const register = `${siteUrl}/wallet?section=domains&name=${encodeURIComponent(info.name)}`;
  const body = info.registered
    ? `<p><b>${esc(info.name)}</b> is a Cyberia domain held by <code>${esc(info.addr)}</code> and has no site yet.</p>
<p>Its holder can point it somewhere from the wallet: a link, an IPFS page or an address.</p>`
    : `<p><b>${esc(info.name)}</b> is not registered.</p><p>It is free to take: <a href="${esc(register)}">register it in the Cyberia wallet</a>.</p>`;
  return {
    status: info.registered ? 200 : 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'max-age=60' },
    body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(info.name)}</title>
<style>body{font:16px/1.5 ui-monospace,monospace;max-width:40rem;margin:4rem auto;padding:0 1rem;background:#0b0b10;color:#d8d8e8}a{color:#c08cff}code{word-break:break-all}</style>
${body}`,
  };
}

/**
 * The JSON half, for the wallet's browser: `/api/resolve?name=` is the same
 * answer the gateway acts on, and `/api/zones` is the list of zones served.
 */
export async function jsonApi(handle, url, { ipfsGateway } = {}) {
  if (url.pathname === '/api/zones') {
    return { status: 200, body: { zones: handle.book.list() } };
  }
  if (url.pathname === '/api/resolve') {
    const name = (url.searchParams.get('name') ?? '').trim().toLowerCase().replace(/\.$/, '');
    if (!name || name.length > 253) return { status: 400, body: { error: 'name' } };
    const info = await handle.resolver.describe(name);
    if (!info) return { status: 200, body: { name, zone: null } };
    if (info.registered) info.target = targetOf(info, handle.resolver.zoneOf, ipfsGateway);
    return { status: 200, body: info };
  }
  return null;
}

function log(transport, q, rcode, note = '') {
  if (!flag(env.DNS_LOG, true)) return;
  const rc = Object.keys(RCODE).find((k) => RCODE[k] === rcode);
  console.log(`${transport} ${q.name} ${TYPE_NAME[q.type] ?? q.type} ${rc}${note ? ` (${note})` : ''}`);
}

// ── transports ──────────────────────────────────────────────────────────

/** Per-source token bucket for UDP, the only transport whose source can lie. */
function rateLimiter(qps) {
  const buckets = new Map();
  setInterval(() => buckets.clear(), 60_000).unref();
  return (ip) => {
    const t = Date.now();
    const b = buckets.get(ip) ?? { tokens: qps * 2, at: t };
    b.tokens = Math.min(qps * 2, b.tokens + ((t - b.at) / 1000) * qps);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    buckets.set(ip, b);
    return true;
  };
}

export function serveUdp(handle, { bind, port, qps }) {
  const allow = rateLimiter(qps);
  const sock = dgram.createSocket({ type: net.isIPv6(bind) ? 'udp6' : 'udp4', reuseAddr: false });
  sock.on('message', async (msg, rinfo) => {
    if (!allow(rinfo.address)) return;
    try {
      const out = await handle(msg, { transport: 'udp' });
      if (out) sock.send(out, rinfo.port, rinfo.address);
    } catch (e) {
      console.error('udp:', e);
    }
  });
  sock.bind(port, bind);
  return sock;
}

export function serveTcp(handle, { bind, port }) {
  const server = net.createServer((conn) => {
    conn.setTimeout(10_000, () => conn.destroy());
    let buf = Buffer.alloc(0);
    let busy = Promise.resolve();
    conn.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 70_000) return conn.destroy();
      while (buf.length >= 2 && buf.length >= 2 + buf.readUInt16BE(0)) {
        const msg = buf.subarray(2, 2 + buf.readUInt16BE(0));
        buf = buf.subarray(2 + msg.length);
        busy = busy.then(async () => {
          const out = await handle(msg, { transport: 'tcp' }).catch(() => null);
          if (!out || conn.destroyed) return;
          const len = Buffer.alloc(2);
          len.writeUInt16BE(out.length);
          conn.write(Buffer.concat([len, out]));
        });
      }
    });
    conn.on('error', () => {});
  });
  server.listen(port, bind);
  return server;
}

/** RFC 8484: GET ?dns=<base64url> or POST application/dns-message. */
export function serveDoh(handle, { bind, port, dohHost = 'dns.cyberia.church', gatewayOptions = {} }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const cors = { 'access-control-allow-origin': '*' };

    // nginx sends every Host it has no server for (:80 default_server) here
    // too. A name in a served zone is the gateway's; the DoH, API and health
    // routes answer on any other Host (nginx's own, the container's name);
    // anything else — an unknown Host, the bare IP — goes to the site.
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    const named = host !== dohHost && handle.resolver.zoneOf(host);
    const route = url.pathname === '/dns-query' || url.pathname === '/health' || url.pathname.startsWith('/api/');
    if (named || !route) {
      try {
        const page = await webGateway(handle.resolver, req, gatewayOptions);
        res.writeHead(page.status, page.headers).end(page.body);
      } catch (e) {
        res.writeHead(502, { 'content-type': 'text/plain' }).end(`Cyberia could not be read: ${e.message}\n`);
      }
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        const out = await jsonApi(handle, url, gatewayOptions);
        if (!out) return res.writeHead(404, cors).end();
        res
          .writeHead(out.status, { 'content-type': 'application/json', 'cache-control': 'max-age=15', ...cors })
          .end(JSON.stringify(out.body));
      } catch (e) {
        // The chain did not answer: say so, never "not registered".
        res.writeHead(503, { 'content-type': 'application/json', ...cors }).end(JSON.stringify({ error: 'chain', message: e.message }));
      }
      return;
    }

    if (url.pathname === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain', ...cors }).end('ok\n');
      return;
    }

    let msg;
    if (req.method === 'GET' && url.searchParams.get('dns')) {
      msg = Buffer.from(url.searchParams.get('dns'), 'base64url');
    } else if (req.method === 'POST' && (req.headers['content-type'] ?? '').startsWith('application/dns-message')) {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 65535) return res.writeHead(413, cors).end();
        chunks.push(c);
      }
      msg = Buffer.concat(chunks);
    } else if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' }).end();
      return;
    } else {
      res.writeHead(400, cors).end();
      return;
    }

    try {
      const out = await handle(msg, { transport: 'doh' });
      if (!out) return res.writeHead(400, cors).end();
      // Cache for the shortest TTL we would have handed out ourselves.
      res.writeHead(200, { 'content-type': 'application/dns-message', 'cache-control': 'max-age=30', ...cors }).end(out);
    } catch (e) {
      console.error('doh:', e);
      res.writeHead(500, cors).end();
    }
  });
  server.listen(port, bind);
  return server;
}

// ── main ────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = configFromEnv();
  if (!/^0x[0-9a-fA-F]{40}$/.test(config.contract ?? '')) {
    console.error('CYBERIA_DOMAINS_ADDRESS is not set to a contract address');
    process.exit(1);
  }
  const handle = createHandler(config);
  const refresh = () =>
    handle.book
      .refresh()
      .then((zones) => console.log(`zones: ${zones.join(', ')}`))
      .catch((e) => console.error(`zones: ${e.message}`));
  await refresh();
  // Only print when the set changes; a new zone appears within a minute.
  let last = '';
  setInterval(async () => {
    try {
      const zones = (await handle.book.refresh()).join(', ');
      if (zones !== last) console.log(`zones: ${zones}`);
      last = zones;
    } catch (e) {
      console.error(`zones: ${e.message}`);
    }
  }, config.zoneRefreshMs).unref();
  serveUdp(handle, { bind: config.bind, port: config.port, qps: config.udpQps });
  serveTcp(handle, { bind: config.bind, port: config.port });
  serveDoh(handle, {
    bind: config.dohBind,
    port: config.dohPort,
    dohHost: env.DOH_HOST || 'dns.cyberia.church',
    gatewayOptions: { ipfsGateway: config.ipfsGateway, siteUrl: config.siteUrl },
  });
  console.log(
    `cyberia-dns: domains ${config.contract} via ${config.rpcUrl}; ` +
      `dns ${config.bind}:${config.port} udp+tcp, doh :${config.dohPort}; ` +
      `forwarding udp=${config.forwardUdp} tcp=${config.forwardTcp} doh=${config.forwardDoh}`,
  );
}

export { TYPE };
