// From a question to an answer, for the zones this server is authoritative
// for. A name is `<label>.<zone>` — one domain NFT in one zone of
// CyberiaDomains (`zones.mjs` says which zones are served) — and everything
// below it — `www.lain.cyber` — is the same domain's records under a `<sub>/`
// prefix, with `*/` as the wildcard. The contract stores strings; every one is validated here and an
// invalid record is skipped rather than served or allowed to fail the answer.

import { isIPv4, isIPv6 } from 'node:net';
import { TYPE, RCODE } from './wire.mjs';
import { ZERO_ADDRESS } from './chain.mjs';

const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX'];
const MAX_PER_TYPE = 16;
const HOST = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9_]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The keys one name's answer can need, fetched together and cached together. */
export function keysFor(sub) {
  const keys = sub ? RECORD_TYPES.map((t) => `${sub}/${t}`) : [...RECORD_TYPES];
  if (sub) keys.push(...RECORD_TYPES.map((t) => `*/${t}`));
  keys.push('ipfs', 'addr', 'url');
  return keys;
}

const host = (v) => {
  const h = v.trim().toLowerCase().replace(/\.$/, '');
  return HOST.test(h) ? h : null;
};
const list = (v) => v.split(/[\s,]+/).filter(Boolean);

/** Parse one record's string into the values a type can carry. */
export function parseRecord(type, raw) {
  if (!raw) return [];
  switch (type) {
    case 'A':
      return list(raw).filter((ip) => isIPv4(ip)).slice(0, MAX_PER_TYPE);
    case 'AAAA':
      return list(raw).filter((ip) => isIPv6(ip)).slice(0, MAX_PER_TYPE);
    case 'CNAME': {
      const h = host(raw);
      return h ? [h] : [];
    }
    case 'TXT':
      return raw.split('\n').filter((t) => t.length > 0).slice(0, MAX_PER_TYPE);
    case 'MX':
      return raw
        .split(/[\n,]+/)
        .map((line) => line.trim().split(/\s+/))
        .filter(([p, h]) => /^\d{1,5}$/.test(p ?? '') && Number(p) <= 65535 && host(h ?? ''))
        .map(([p, h]) => ({ preference: Number(p), exchange: host(h) }))
        .slice(0, MAX_PER_TYPE);
    default:
      return [];
  }
}

export function createResolver({ book, read, ttl = 60, negativeTtl = 60, ns = [], hostmaster, cacheMs = 30_000, now = Date.now }) {
  const cache = new Map();

  const soa = (zone) => ({
    name: zone,
    type: TYPE.SOA,
    ttl: negativeTtl,
    value: {
      mname: ns[0] ?? `ns.${zone}`,
      rname: hostmaster ?? `hostmaster.${zone}`,
      // The zone changes whenever a block does; a serial that only moves
      // forward is all secondaries would ever need, and there are none.
      serial: Math.floor(now() / 1000),
      refresh: 3600,
      retry: 600,
      expire: 604800,
      minimum: negativeTtl,
    },
  });

  async function lookup(label, zone, sub) {
    const key = `${label}\0${zone}\0${sub}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.value;

    const keys = keysFor(sub);
    const { owner, values } = await read(label, zone, keys);
    const value = { owner, records: Object.fromEntries(keys.map((k, i) => [k, values[i] ?? ''])) };

    cache.delete(key);
    cache.set(key, { at: now(), value });
    if (cache.size > 10_000) cache.delete(cache.keys().next().value);
    return value;
  }

  /** The served suffix a name falls under, or null when it is not ours. */
  function zoneOf(qname) {
    return book.match(qname)?.suffix ?? null;
  }

  /** `www.lain.moon` → { suffix, zone, label: 'lain', sub: 'www' }. */
  function split(name) {
    const m = book.match(name);
    if (!m || name === m.suffix) return m && { ...m, label: null, sub: '' };
    const labels = name.slice(0, -(m.suffix.length + 1)).split('.');
    const label = labels.pop();
    return { ...m, label, sub: labels.join('.') };
  }

  /**
   * Answer a question in one of our zones, or return null when the name is
   * not ours (the server then forwards or refuses). Throws only when the
   * chain cannot be read.
   */
  async function answer({ name, type }) {
    const where = split(name);
    if (!where) return null;
    const zone = where.suffix;

    const rr = (rtype, value) => ({ name, type: TYPE[rtype], ttl, value });
    const nodata = () => ({ rcode: RCODE.NOERROR, answers: [], authority: [soa(zone)] });
    const nxdomain = () => ({ rcode: RCODE.NXDOMAIN, answers: [], authority: [soa(zone)] });

    if (name === zone) {
      if (type === TYPE.SOA || type === TYPE.ANY) return { rcode: RCODE.NOERROR, answers: [{ ...soa(zone), ttl }], authority: [] };
      if (type === TYPE.NS && ns.length) return { rcode: RCODE.NOERROR, answers: ns.map((n) => rr('NS', n)), authority: [] };
      return nodata();
    }

    const { label, sub } = where;
    if (!LABEL.test(label)) return nxdomain();

    const { owner, records } = await lookup(label, where.zone, sub);
    if (owner === ZERO_ADDRESS) return nxdomain();

    // Two names the gateway synthesises from the name's own records.
    if (sub === '_dnslink' || sub === '_addr') {
      const text =
        sub === '_dnslink'
          ? records.ipfs && `dnslink=${records.ipfs.startsWith('/') ? records.ipfs : `/ipfs/${records.ipfs.trim()}`}`
          : `${records.addr?.trim() || owner}`;
      if (!text) return nxdomain();
      return type === TYPE.TXT || type === TYPE.ANY ? { rcode: RCODE.NOERROR, answers: [rr('TXT', text)], authority: [] } : nodata();
    }

    // Exact records under the sub-name win; the wildcard covers the rest.
    const pick = (t) => {
      if (!sub) return parseRecord(t, records[t]);
      const exact = parseRecord(t, records[`${sub}/${t}`]);
      return exact.length ? exact : parseRecord(t, records[`*/${t}`]);
    };
    const have = Object.fromEntries(RECORD_TYPES.map((t) => [t, pick(t)]));
    const exists = !sub || RECORD_TYPES.some((t) => have[t].length);
    if (!exists) return nxdomain();

    // A CNAME owns its name: it is the answer to every other type.
    if (have.CNAME.length && type !== TYPE.CNAME) {
      return { rcode: RCODE.NOERROR, answers: [rr('CNAME', have.CNAME[0])], authority: [] };
    }

    const wanted = type === TYPE.ANY ? RECORD_TYPES : [RECORD_TYPES.find((t) => TYPE[t] === type)].filter(Boolean);
    const answers = wanted.flatMap((t) => have[t].map((v) => rr(t, v)));
    return answers.length ? { rcode: RCODE.NOERROR, answers, authority: [] } : nodata();
  }

  /**
   * Everything a browser needs about one name: whose it is, its records
   * (validated, as DNS would serve them) and where a visit should go. This is
   * what the HTTP gateway acts on and what the wallet's browser reads, so the
   * two cannot disagree. Null when the name is not in a served zone.
   */
  async function describe(hostname) {
    const name = hostname.toLowerCase().replace(/\.$/, '');
    const where = split(name);
    if (!where) return null;
    const base = { name, zone: where.zone, label: where.label, sub: where.sub };
    if (!where.label || !LABEL.test(where.label)) return { ...base, registered: false, target: { kind: 'none' } };

    const { owner, records } = await lookup(where.label, where.zone, where.sub);
    if (owner === ZERO_ADDRESS) return { ...base, registered: false, target: { kind: 'none' } };

    const raw = (t) => {
      if (!where.sub) return records[t];
      return parseRecord(t, records[`${where.sub}/${t}`]).length ? records[`${where.sub}/${t}`] : records[`*/${t}`];
    };
    const parsed = Object.fromEntries(RECORD_TYPES.map((t) => [t, parseRecord(t, raw(t) ?? '')]));
    const apex = !where.sub;
    const info = {
      ...base,
      registered: true,
      owner,
      addr: records.addr?.trim() || owner,
      records: parsed,
      url: apex ? (records.url ?? '').trim() : '',
      ipfs: apex ? (records.ipfs ?? '').trim() : '',
    };
    return { ...info, target: targetOf(info, zoneOf) };
  }

  return { answer, describe, zoneOf, split, cache };
}

const SAFE_URL = /^https?:\/\/[^\s"'<>]+$/i;
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;

/**
 * Where a visit to a name goes, in the order an owner would expect their
 * records to win: an explicit `url`, then a `CNAME`, then an `ipfs` site,
 * then an address (`A`/`AAAA`), which only plain HTTP can reach.
 */
export function targetOf(info, zoneOf, ipfsGateway = 'https://ipfs.io') {
  if (!info.registered) return { kind: 'none' };
  if (SAFE_URL.test(info.url)) return { kind: 'url', url: info.url };
  const cname = info.records.CNAME[0];
  if (cname) return zoneOf(cname) ? { kind: 'name', name: cname } : { kind: 'cname', url: `https://${cname}/` };
  if (info.ipfs) {
    const path = info.ipfs.startsWith('/ipfs/') || info.ipfs.startsWith('/ipns/') ? info.ipfs : CID.test(info.ipfs) ? `/ipfs/${info.ipfs}` : null;
    if (path) return { kind: 'ipfs', path, url: `${ipfsGateway}${path}/` };
  }
  if (info.records.A.length || info.records.AAAA.length) return { kind: 'host', url: `http://${info.name}/` };
  return { kind: 'none' };
}
