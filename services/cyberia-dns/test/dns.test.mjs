import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { encodeName, parseQuery, TYPE, RCODE } from '../src/wire.mjs';
import { encodeResolve, decodeResolve, decodeZones, encodeCall, RESOLVE_SELECTOR, ZONES_SELECTOR, ZERO_ADDRESS } from '../src/chain.mjs';
import { staticZoneBook, createZoneBook } from '../src/zones.mjs';
import { parseRecord } from '../src/resolver.mjs';
import { createHandler, webGateway, jsonApi } from '../src/server.mjs';

const OWNER = '0x' + 'ab'.repeat(20);

function query(name, type, { id = 0x1234, rd = 1, edns = false } = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(rd ? 0x0100 : 0, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(edns ? 1 : 0, 10);
  const q = Buffer.concat([encodeName(name), Buffer.from([type >> 8, type & 0xff, 0, 1])]);
  const opt = edns ? Buffer.from([0, 0, 41, 0x10, 0x00, 0, 0, 0, 0, 0, 0]) : Buffer.alloc(0);
  return Buffer.concat([header, q, opt]);
}

/** Decode the parts of a response the tests look at. */
function decode(buf) {
  const flags = buf.readUInt16BE(2);
  const counts = [4, 6, 8, 10].map((o) => buf.readUInt16BE(o));
  let pos = 12;
  const skipName = () => {
    for (;;) {
      const l = buf[pos];
      if ((l & 0xc0) === 0xc0) return (pos += 2);
      pos += 1 + l;
      if (l === 0) return;
    }
  };
  skipName();
  pos += 4;
  const rrs = [];
  for (let i = 0; i < counts[1] + counts[2]; i++) {
    skipName();
    const type = buf.readUInt16BE(pos);
    const len = buf.readUInt16BE(pos + 8);
    const data = buf.subarray(pos + 10, pos + 10 + len);
    pos += 10 + len;
    let value = data;
    if (type === TYPE.A) value = [...data].join('.');
    if (type === TYPE.TXT) value = data.toString('utf8', 1, 1 + data[0]);
    rrs.push({ section: i < counts[1] ? 'an' : 'ns', type, value });
  }
  return { id: buf.readUInt16BE(0), rcode: flags & 0xf, aa: !!(flags & 0x400), tc: !!(flags & 0x200), rrs };
}

function fakeChain(names) {
  let calls = 0;
  // Names are keyed `label` (in .cyber) or `label.zone`.
  const read = async (label, zone, keys) => {
    calls++;
    const n = names[zone === 'cyber' ? label : `${label}.${zone}`];
    if (n === 'boom') throw new Error('rpc down');
    return { owner: n ? OWNER : ZERO_ADDRESS, values: keys.map((k) => n?.[k] ?? '') };
  };
  return { read, calls: () => calls };
}

const config = { ns: ['ns1.cyberia.church'], ttl: 60, upstreams: [], forwardUdp: false, forwardTcp: false, forwardDoh: false };

/** A handler over fake names, serving `.cyber`, `.moon` and the delegated alias. */
async function makeHandler(read) {
  const book = staticZoneBook(['cyber', 'moon'], { 'cyber.cyberia.church': 'cyber' });
  await book.refresh();
  return createHandler(config, { read, book });
}

const chain = fakeChain({
  lain: {
    A: '1.2.3.4, 5.6.7.8 not-an-ip',
    AAAA: '2001:db8::1',
    TXT: 'hello\nworld',
    MX: '10 mail.lain.cyber',
    'www/CNAME': 'lain.cyber.',
    '*/A': '9.9.9.9',
    ipfs: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi',
  },
  empty: {},
  broken: 'boom',
  'shop.moon': { A: '4.4.4.4' },
});
const handle = await makeHandler(chain.read);
const ask = async (name, type, opts) => decode(await handle(query(name, type, opts), { transport: 'udp' }));

test('the gateway calls the selectors the hardhat suite pins', () => {
  const artifact = new URL('../../../crypto/hardhat/artifacts/contracts/CyberiaDomains.sol/CyberiaDomains.json', import.meta.url);
  assert.equal(RESOLVE_SELECTOR, 'd1ab368c');
  assert.equal(ZONES_SELECTOR, '03d25049');
  if (!existsSync(artifact)) return; // compile crypto/hardhat to run this half
  const abi = JSON.parse(readFileSync(artifact)).abi;
  assert.ok(abi.some((f) => f.name === 'resolve' && f.inputs.map((i) => i.type).join() === 'string,string,string[]'));
  assert.ok(abi.some((f) => f.name === 'zones' && f.inputs.length === 0));
});

const w = (n) => BigInt(n).toString(16).padStart(64, '0');
const s32 = (t) => w(Buffer.byteLength(t)) + Buffer.from(t).toString('hex').padEnd(Math.ceil(Buffer.byteLength(t) / 32) * 64, '0');

test('ABI round trip for resolve()', () => {
  const data = encodeResolve('lain', 'cyber', ['A', 'www/TXT']);
  assert.ok(data.startsWith('0xd1ab368c'));
  // Three heads, then 'lain', 'cyber' and the two-key array.
  assert.equal(data.slice(10, 10 + 64), w(96));
  // A return value by hand: (address, string[] ["1.2.3.4", ""]).
  const ret = '0x' + w(BigInt(OWNER)) + w(64) + w(2) + w(64) + w(64 + 64) + s32('1.2.3.4') + s32('');
  assert.deepEqual(decodeResolve(ret), { owner: OWNER, values: ['1.2.3.4', ''] });
  assert.equal(encodeCall('03d25049', []), '0x03d25049');
});

test('zones() decodes three parallel arrays', () => {
  const TOKEN = '0x' + 'cd'.repeat(20);
  // heads: three offsets; then string[] [cyber, moon], address[], bool[]
  const strings = w(2) + w(64) + w(64 + 64) + s32('cyber') + s32('moon');
  const addrs = w(2) + w(0) + w(BigInt(TOKEN));
  const bools = w(2) + w(0) + w(1);
  const ret = '0x' + w(96) + w(96 + strings.length / 2) + w(96 + strings.length / 2 + addrs.length / 2) + strings + addrs + bools;
  assert.deepEqual(decodeZones(ret), [
    { zone: 'cyber', token: ZERO_ADDRESS, blocked: false },
    { zone: 'moon', token: TOKEN, blocked: true },
  ]);
});

test('a chain zone is served only when the real root does not have it', async () => {
  const root = { com: true, moon: false };
  const book = createZoneBook({
    readZones: async () => ['cyber', 'moon', 'com', 'local', 'down', 'gone'].map((zone) => ({ zone, token: null, blocked: zone === 'gone' })),
    isDelegated: async (zone) => {
      if (zone === 'down') throw new Error('timeout');
      return root[zone] ?? false;
    },
    aliases: { 'cyber.cyberia.church': 'cyber', 'com.cyberia.church': 'com' },
  });
  assert.deepEqual((await book.refresh()).sort(), ['cyber', 'moon']);
  assert.equal(book.match('google.com'), null);
  assert.equal(book.match('x.com.cyberia.church'), null);
  assert.deepEqual(book.match('lain.cyber.cyberia.church'), { suffix: 'cyber.cyberia.church', zone: 'cyber' });
  assert.deepEqual(book.match('a.b.moon'), { suffix: 'moon', zone: 'moon' });
});

test('records are validated, never trusted', () => {
  assert.deepEqual(parseRecord('A', '1.2.3.4 300.1.1.1,5.6.7.8'), ['1.2.3.4', '5.6.7.8']);
  assert.deepEqual(parseRecord('AAAA', '::1 nope'), ['::1']);
  assert.deepEqual(parseRecord('CNAME', 'Bad Host'), []);
  assert.deepEqual(parseRecord('MX', '10 mx.example.com, x y'), [{ preference: 10, exchange: 'mx.example.com' }]);
});

test('answers A, AAAA, TXT and MX for a registered name, authoritatively', async () => {
  const a = await ask('lain.cyber', TYPE.A);
  assert.equal(a.rcode, RCODE.NOERROR);
  assert.equal(a.aa, true);
  assert.deepEqual(a.rrs.map((r) => r.value), ['1.2.3.4', '5.6.7.8']);

  assert.equal((await ask('LAIN.cyber', TYPE.AAAA)).rrs.length, 1);
  assert.deepEqual((await ask('lain.cyber', TYPE.TXT)).rrs.map((r) => r.value), ['hello', 'world']);
  assert.equal((await ask('lain.cyber', TYPE.MX)).rrs[0].type, TYPE.MX);
});

test('the same names answer under the delegated cyber.cyberia.church', async () => {
  const a = await ask('lain.cyber.cyberia.church', TYPE.A);
  assert.deepEqual(a.rrs.map((r) => r.value), ['1.2.3.4', '5.6.7.8']);
});

test('unregistered is NXDOMAIN, registered without that type is NODATA, both with SOA', async () => {
  const nx = await ask('ghost.cyber', TYPE.A);
  assert.equal(nx.rcode, RCODE.NXDOMAIN);
  assert.equal(nx.rrs[0].type, TYPE.SOA);

  const nodata = await ask('empty.cyber', TYPE.A);
  assert.equal(nodata.rcode, RCODE.NOERROR);
  assert.deepEqual(nodata.rrs.map((r) => r.section), ['ns']);
});

test('sub-names: exact CNAME, wildcard A, dnslink and the owner address', async () => {
  const www = await ask('www.lain.cyber', TYPE.A);
  assert.equal(www.rrs[0].type, TYPE.CNAME);

  assert.deepEqual((await ask('anything.lain.cyber', TYPE.A)).rrs.map((r) => r.value), ['9.9.9.9']);
  assert.equal((await ask('anything.empty.cyber', TYPE.A)).rcode, RCODE.NXDOMAIN);

  assert.match((await ask('_dnslink.lain.cyber', TYPE.TXT)).rrs[0].value, /^dnslink=\/ipfs\/bafy/);
  assert.equal((await ask('_addr.lain.cyber', TYPE.TXT)).rrs[0].value, OWNER);
});

test('an unreadable chain is SERVFAIL, never NXDOMAIN', async () => {
  assert.equal((await ask('broken.cyber', TYPE.A)).rcode, RCODE.SERVFAIL);
});

test('zone apex serves SOA and NS', async () => {
  assert.equal((await ask('cyber', TYPE.SOA)).rrs[0].type, TYPE.SOA);
  assert.equal((await ask('cyber', TYPE.NS)).rrs[0].type, TYPE.NS);
});

test('foreign names are refused when forwarding is off', async () => {
  assert.equal((await ask('example.com', TYPE.A)).rcode, RCODE.REFUSED);
});

test('answers are cached per name', async () => {
  const c = fakeChain({ cached: { A: '1.1.1.1' } });
  const h = await makeHandler(c.read);
  await h(query('cached.cyber', TYPE.A), { transport: 'udp' });
  await h(query('cached.cyber', TYPE.AAAA), { transport: 'udp' });
  assert.equal(c.calls(), 1);
});

test('EDNS is echoed, the id is kept, a response is never answered', async () => {
  const r = await handle(query('lain.cyber', TYPE.A, { id: 0xbeef, edns: true }), { transport: 'udp' });
  assert.equal(r.readUInt16BE(0), 0xbeef);
  assert.equal(r.readUInt16BE(10), 1);
  assert.equal(parseQuery(r).edns.udpSize, 1232);

  const resp = query('lain.cyber', TYPE.A);
  resp[2] |= 0x80;
  assert.equal(await handle(resp, { transport: 'udp' }), null);
});

test('garbage is FORMERR, not a crash', async () => {
  const r = await handle(Buffer.from([1, 2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0]), { transport: 'udp' });
  assert.equal(r[3] & 0xf, RCODE.FORMERR);
});

test('web gateway: url, CNAME and ipfs redirect; a bare name gets a card; a free one a 404', async () => {
  const CIDV1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
  const c = fakeChain({
    site: { url: 'https://example.org/x', CNAME: 'ignored.example' },
    alias: { CNAME: 'cyberia.church' },
    inner: { CNAME: 'site.cyber' },
    pinned: { ipfs: CIDV1 },
    bare: { A: '2.26.24.177' },
    evil: { url: 'javascript:alert(1)' },
    'page.moon': { ipfs: `/ipfs/${CIDV1}` },
  });
  const h = await makeHandler(c.read);
  const visit = (host, url = '/') => webGateway(h.resolver, { headers: { host }, url });

  assert.equal((await visit('site.cyber')).headers.location, 'https://example.org/x');
  assert.equal((await visit('alias.cyber', '/swap?a=1')).headers.location, 'https://cyberia.church/swap?a=1');
  assert.equal((await visit('inner.cyber')).headers.location, 'http://site.cyber/');
  assert.equal((await visit('pinned.cyber')).headers.location, `https://ipfs.io/ipfs/${CIDV1}/`);
  assert.equal((await visit('page.moon', '/a.css')).headers.location, `https://ipfs.io/ipfs/${CIDV1}/a.css`);
  assert.equal((await visit('bare.cyber:80')).status, 200);
  assert.equal((await visit('evil.cyber')).status, 200);
  assert.equal((await visit('free.cyber')).status, 404);
  // Not ours (an unknown Host, the bare IP): home.
  assert.equal((await visit('example.com')).headers.location, 'https://cyberia.church/');
});

test('token zones resolve like .cyber', async () => {
  assert.deepEqual((await ask('shop.moon', TYPE.A)).rrs.map((r) => r.value), ['4.4.4.4']);
  assert.equal((await ask('lain.moon', TYPE.A)).rcode, RCODE.NXDOMAIN);
  assert.equal((await ask('shop.mars', TYPE.A)).rcode, RCODE.REFUSED);
});

test('the JSON view says what a name is and where a visit goes', async () => {
  const api = (path) => jsonApi(handle, new URL(path, 'http://x'));
  const lain = (await api('/api/resolve?name=LAIN.cyber')).body;
  assert.equal(lain.registered, true);
  assert.equal(lain.owner, OWNER);
  assert.deepEqual(lain.records.A, ['1.2.3.4', '5.6.7.8']);
  assert.equal(lain.target.kind, 'ipfs');

  assert.equal((await api('/api/resolve?name=www.lain.cyber')).body.target.name, 'lain.cyber');
  assert.equal((await api('/api/resolve?name=shop.moon')).body.target.kind, 'host');
  assert.deepEqual((await api('/api/resolve?name=ghost.moon')).body.target, { kind: 'none' });
  assert.equal((await api('/api/resolve?name=example.com')).body.zone, null);
  assert.deepEqual((await api('/api/zones')).body.zones.map((z) => z.zone).sort(), ['cyber', 'moon']);
  await assert.rejects(api('/api/resolve?name=broken.cyber'));
});

test('a CNAME inside our zones is chased to its address', async () => {
  const c = fakeChain({ alias: { CNAME: 'target.cyber' }, target: { A: '7.7.7.7' } });
  const h = await makeHandler(c.read);
  const r = decode(await h(query('alias.cyber', TYPE.A), { transport: 'doh' }));
  assert.deepEqual(r.rrs.map((x) => [x.type, x.value]).slice(1), [[TYPE.A, '7.7.7.7']]);
});

test('parseAnswers reads compressed upstream answers', async () => {
  const { parseAnswers, buildResponse } = await import('../src/wire.mjs');
  const q = parseQuery(query('x.example', TYPE.A));
  const buf = buildResponse(q, { answers: [{ name: 'x.example', type: TYPE.CNAME, ttl: 5, value: 'y.example' }, { name: 'y.example', type: TYPE.A, ttl: 5, value: '1.2.3.4' }] });
  assert.deepEqual(parseAnswers(buf).map((r) => r.value), ['y.example', '1.2.3.4']);
});

test('the HTTP side routes by name first, then by path', async () => {
  const http = await import('node:http');
  const { serveDoh } = await import('../src/server.mjs');
  const server = serveDoh(handle, { bind: '127.0.0.1', port: 0, gatewayOptions: {} });
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const get = (path, host) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
        res.resume();
        resolve([res.statusCode, res.headers.location ?? null]);
      }).on('error', reject);
    });
  try {
    assert.deepEqual(await get('/health', 'cyberia-dns:8053'), [200, null]);
    assert.deepEqual(await get('/api/zones', 'dns.cyberia.church'), [200, null]);
    assert.deepEqual(await get('/', '2.26.24.177'), [302, 'https://cyberia.church/']);
    assert.deepEqual(await get('/health', 'lain.cyber'), [302, `https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/health`]);
  } finally {
    server.close();
  }
});
