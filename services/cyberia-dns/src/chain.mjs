// The two contract calls the gateway makes against CyberiaDomains:
//   resolve(string label, string zone, string[] keys) → (address owner, string[] values)
//   zones() → (string[] labels, address[] tokens, bool[] blocked)
// ABI-encoded by hand so the image installs nothing; the selectors are pinned
// against viem in crypto/hardhat/test/CyberiaDomains.ts.

export const RESOLVE_SELECTOR = 'd1ab368c'; // resolve(string,string,string[])
export const ZONES_SELECTOR = '03d25049'; // zones()
export const ZERO_ADDRESS = '0x' + '0'.repeat(40);

const word = (n) => BigInt(n).toString(16).padStart(64, '0');

function encodeString(s) {
  const bytes = Buffer.from(s, 'utf8');
  const padded = Buffer.alloc(Math.ceil(bytes.length / 32) * 32);
  bytes.copy(padded);
  return word(bytes.length) + padded.toString('hex');
}

function encodeStringArray(items) {
  const parts = items.map(encodeString);
  let offsets = '';
  let at = items.length * 32;
  for (const p of parts) {
    offsets += word(at);
    at += p.length / 2;
  }
  return word(items.length) + offsets + parts.join('');
}

/** Encode a call whose arguments are all dynamic: strings and string arrays. */
export function encodeCall(selector, args) {
  const tails = args.map((a) => (Array.isArray(a) ? encodeStringArray(a) : encodeString(a)));
  let head = '';
  let at = args.length * 32;
  for (const t of tails) {
    head += word(at);
    at += t.length / 2;
  }
  return '0x' + selector + head + tails.join('');
}

export const encodeResolve = (label, zone, keys) => encodeCall(RESOLVE_SELECTOR, [label, zone, keys]);

function reader(hex) {
  const buf = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  const num = (pos) => {
    if (pos + 32 > buf.length) throw new Error('return data too short');
    if (buf.readBigUInt64BE(pos) || buf.readBigUInt64BE(pos + 8) || buf.readBigUInt64BE(pos + 16)) {
      throw new Error('offset out of range');
    }
    return Number(buf.readBigUInt64BE(pos + 24));
  };
  const address = (pos) => '0x' + buf.subarray(pos + 12, pos + 32).toString('hex');
  const string = (at) => {
    const len = num(at);
    if (at + 32 + len > buf.length) throw new Error('string runs past return data');
    return buf.toString('utf8', at + 32, at + 32 + len);
  };
  /** A dynamic array whose head word sits at `pos`; `item` reads element i. */
  const array = (pos, item) => {
    const start = num(pos);
    const n = num(start);
    if (n > 100_000) throw new Error('array too long');
    const base = start + 32;
    return Array.from({ length: n }, (_, i) => item(base, i));
  };
  return { num, address, string, array, buf };
}

export function decodeResolve(hex) {
  const r = reader(hex);
  const owner = r.address(0);
  const values = r.array(32, (base, i) => r.string(base + r.num(base + i * 32)));
  return { owner, values };
}

export function decodeZones(hex) {
  const r = reader(hex);
  const labels = r.array(0, (base, i) => r.string(base + r.num(base + i * 32)));
  const tokens = r.array(32, (base, i) => r.address(base + i * 32));
  const blocked = r.array(64, (base, i) => r.num(base + i * 32) !== 0);
  return labels.map((zone, i) => ({ zone, token: tokens[i], blocked: blocked[i] }));
}

/**
 * Readers over JSON-RPC. A failure throws — the caller answers SERVFAIL,
 * because "the chain did not answer" is not "this name does not exist".
 */
export function chainReader({ rpcUrl, contract, timeoutMs = 4000, fetchImpl = fetch }) {
  let seq = 0;
  const call = async (data) => {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'eth_call', params: [{ to: contract, data }, 'latest'] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`rpc http ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`rpc: ${body.error.message ?? JSON.stringify(body.error)}`);
    if (typeof body.result !== 'string' || body.result.length < 2 + 64 * 2) throw new Error('rpc: empty result');
    return body.result;
  };

  return {
    resolve: async (label, zone, keys) => decodeResolve(await call(encodeResolve(label, zone, keys))),
    zones: async () => decodeZones(await call('0x' + ZONES_SELECTOR)),
  };
}
