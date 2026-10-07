// DNS wire format (RFC 1035, EDNS0 from RFC 6891), only as much of it as an
// authoritative server for a handful of record types needs. Nothing is
// installed for this, the same way services/irc's bot is standard library
// only: the format is small, and a parser that sits on port 53 is better read
// in full than trusted from a package.

import { isIPv4, isIPv6 } from 'node:net';

export const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, AAAA: 28, OPT: 41, ANY: 255 };
export const TYPE_NAME = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));
export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };
export const CLASS_IN = 1;

export class FormatError extends Error {}

function readName(buf, offset) {
  const labels = [];
  let pos = offset;
  let end = -1;
  let jumps = 0;

  for (;;) {
    if (pos >= buf.length) throw new FormatError('name runs past the message');
    const len = buf[pos];

    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new FormatError('truncated pointer');
      if (++jumps > 16) throw new FormatError('pointer loop');
      if (end < 0) end = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      continue;
    }
    if (len & 0xc0) throw new FormatError('bad label type');
    if (len === 0) {
      pos += 1;
      break;
    }
    if (pos + 1 + len > buf.length) throw new FormatError('label runs past the message');
    labels.push(buf.toString('latin1', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }

  const name = labels.join('.');
  if (name.length > 253) throw new FormatError('name too long');
  return { name, next: end >= 0 ? end : pos };
}

/** Parse a query: header, the one question, and whether EDNS0 was offered. */
export function parseQuery(buf) {
  if (buf.length < 12) throw new FormatError('short header');

  const id = buf.readUInt16BE(0);
  const flags = buf.readUInt16BE(2);
  const qdcount = buf.readUInt16BE(4);
  const ancount = buf.readUInt16BE(6);
  const nscount = buf.readUInt16BE(8);
  const arcount = buf.readUInt16BE(10);

  const query = {
    id,
    opcode: (flags >> 11) & 0xf,
    qr: flags >> 15,
    rd: (flags >> 8) & 1,
    cd: (flags >> 4) & 1,
    qdcount,
    question: null,
    edns: null,
  };
  if (qdcount !== 1) return query;

  const { name, next } = readName(buf, 12);
  if (next + 4 > buf.length) throw new FormatError('short question');
  query.question = { name: name.toLowerCase(), type: buf.readUInt16BE(next), class: buf.readUInt16BE(next + 2) };

  // Walk past answer/authority to find an OPT record among the additionals.
  let pos = next + 4;
  const skip = ancount + nscount;
  for (let i = 0; i < skip + arcount; i++) {
    const rr = readName(buf, pos);
    pos = rr.next;
    if (pos + 10 > buf.length) throw new FormatError('short record');
    const type = buf.readUInt16BE(pos);
    const klass = buf.readUInt16BE(pos + 2);
    const rdlen = buf.readUInt16BE(pos + 8);
    if (i >= skip && type === TYPE.OPT) {
      query.edns = { udpSize: Math.max(512, klass), dnssecOk: !!(buf.readUInt32BE(pos + 4) & 0x8000) };
    }
    pos += 10 + rdlen;
    if (pos > buf.length) throw new FormatError('rdata runs past the message');
  }

  return query;
}

// ── encoding ────────────────────────────────────────────────────────────

export function encodeName(name) {
  const parts = [];
  for (const label of name.split('.').filter(Boolean)) {
    const bytes = Buffer.from(label, 'latin1');
    if (bytes.length > 63) throw new Error(`label too long: ${label}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function ipv6Bytes(text) {
  const [head, tail] = text.includes('::') ? text.split('::') : [text, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  // An embedded IPv4 tail (::ffff:1.2.3.4) is two groups.
  const expand = (groups) =>
    groups.flatMap((g) => {
      if (!g.includes('.')) return [g];
      const o = g.split('.').map(Number);
      return [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
    });
  const hh = expand(h);
  const tt = expand(t);
  const groups = tail === null ? hh : [...hh, ...Array(8 - hh.length - tt.length).fill('0'), ...tt];
  const out = Buffer.alloc(16);
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2));
  return out;
}

/** Character-strings of at most 255 bytes each, the way TXT carries text. */
function txtData(text) {
  const bytes = Buffer.from(text, 'utf8');
  const parts = [];
  for (let i = 0; i < bytes.length || i === 0; i += 255) {
    const chunk = bytes.subarray(i, i + 255);
    parts.push(Buffer.from([chunk.length]), chunk);
    if (bytes.length === 0) break;
  }
  return Buffer.concat(parts);
}

export function rdata(type, value) {
  switch (type) {
    case TYPE.A:
      if (!isIPv4(value)) throw new Error(`not IPv4: ${value}`);
      return Buffer.from(value.split('.').map(Number));
    case TYPE.AAAA:
      if (!isIPv6(value)) throw new Error(`not IPv6: ${value}`);
      return ipv6Bytes(value);
    case TYPE.CNAME:
    case TYPE.NS:
      return encodeName(value);
    case TYPE.MX: {
      const pref = Buffer.alloc(2);
      pref.writeUInt16BE(value.preference);
      return Buffer.concat([pref, encodeName(value.exchange)]);
    }
    case TYPE.TXT:
      return txtData(value);
    case TYPE.SOA: {
      const nums = Buffer.alloc(20);
      [value.serial, value.refresh, value.retry, value.expire, value.minimum].forEach((n, i) =>
        nums.writeUInt32BE(n >>> 0, i * 4),
      );
      return Buffer.concat([encodeName(value.mname), encodeName(value.rname), nums]);
    }
    default:
      throw new Error(`cannot encode type ${type}`);
  }
}

function encodeRecord({ name, type, ttl, value }) {
  const data = rdata(type, value);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(type, 0);
  fixed.writeUInt16BE(CLASS_IN, 2);
  fixed.writeUInt32BE(ttl >>> 0, 4);
  fixed.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), fixed, data]);
}

/**
 * Build a response. `maxSize` is the transport's limit (512, the client's
 * EDNS size, or 65535 over TCP); past it the sections are dropped and TC set,
 * which tells the client to come back over TCP.
 */
export function buildResponse(query, { rcode = RCODE.NOERROR, aa = true, ra = false, answers = [], authority = [], maxSize = 65535 } = {}) {
  const build = (truncated) => {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(query.id, 0);
    const flags =
      0x8000 |
      ((query.opcode & 0xf) << 11) |
      (aa ? 0x0400 : 0) |
      (truncated ? 0x0200 : 0) |
      (query.rd ? 0x0100 : 0) |
      (ra ? 0x0080 : 0) |
      (rcode & 0xf);
    header.writeUInt16BE(flags, 2);

    const question = query.question
      ? [encodeName(query.question.name), Buffer.from([query.question.type >> 8, query.question.type & 0xff, 0, CLASS_IN])]
      : [];
    const an = truncated ? [] : answers.map(encodeRecord);
    const ns = truncated ? [] : authority.map(encodeRecord);

    // OPT: our UDP size, no extended rcode, DO bit not echoed (no DNSSEC here).
    const opt = query.edns ? [Buffer.from([0, 0, TYPE.OPT, 0x04, 0xd0, 0, 0, 0, 0, 0, 0])] : [];

    header.writeUInt16BE(query.question ? 1 : 0, 4);
    header.writeUInt16BE(an.length, 6);
    header.writeUInt16BE(ns.length, 8);
    header.writeUInt16BE(opt.length, 10);
    return Buffer.concat([header, ...question, ...an, ...ns, ...opt]);
  };

  const full = build(false);
  return full.length <= maxSize ? full : build(true);
}

/** A bare error answer for a message that could not even be parsed fully. */
export function errorFor(buf, rcode) {
  if (buf.length < 2) return null;
  const out = Buffer.alloc(12);
  buf.copy(out, 0, 0, 2);
  const rd = buf.length >= 3 ? buf[2] & 0x01 : 0;
  out.writeUInt16BE(0x8000 | (rd << 8) | rcode, 2);
  return out;
}

/** A minimal query for one name, used to chase a CNAME upstream. */
export function buildQuery(name, type, id = Math.floor(Math.random() * 0xffff)) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([header, encodeName(name), Buffer.from([type >> 8, type & 0xff, 0, CLASS_IN])]);
}

/** The answer section of a response, decoded for A, AAAA and CNAME only. */
export function parseAnswers(buf) {
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  let pos = 12;
  for (let i = 0; i < qd; i++) pos = readName(buf, pos).next + 4;
  const out = [];
  for (let i = 0; i < an; i++) {
    const { name, next } = readName(buf, pos);
    if (next + 10 > buf.length) throw new FormatError('short record');
    const type = buf.readUInt16BE(next);
    const ttl = buf.readUInt32BE(next + 4);
    const len = buf.readUInt16BE(next + 8);
    const at = next + 10;
    if (at + len > buf.length) throw new FormatError('rdata runs past the message');
    if (type === TYPE.A && len === 4) out.push({ name, type, ttl, value: [...buf.subarray(at, at + 4)].join('.') });
    if (type === TYPE.AAAA && len === 16) {
      const g = [];
      for (let j = 0; j < 16; j += 2) g.push(buf.readUInt16BE(at + j).toString(16));
      out.push({ name, type, ttl, value: g.join(':') });
    }
    if (type === TYPE.CNAME) out.push({ name, type, ttl, value: readName(buf, at).name });
    pos = at + len;
  }
  return out;
}
