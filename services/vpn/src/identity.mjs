// Who a client is to this node, and how the wallet is told.
//
// A VLESS client is a UUID. Here it is derived, never stored: HMAC(secret,
// address), so the same address gets the same link on every restart and the
// node keeps no list of credentials to leak. Without the secret, an address
// says nothing about its UUID.
//
// The Reality key pair is X25519 in Xray's spelling (raw 32 bytes, base64url
// without padding). Node's crypto reads it as a JWK, so the public half is
// derived here and never configured separately — one less pair to mismatch.

import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";

/** The address in one canonical spelling, or null if it is not one. */
export function normalizeAddress(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) ? value.toLowerCase() : null;
}

/** The VLESS id for one address on nodes sharing `secret`. */
export function uuidFor(secret, address) {
  const bytes = createHmac("sha256", secret).update(normalizeAddress(address) ?? "").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4 layout
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Reality public key from its private key, both in Xray's base64url. */
export function realityPublicKey(privateKey) {
  const key = createPrivateKey({ key: { kty: "OKP", crv: "X25519", d: privateKey, x: "" }, format: "jwk" });
  return createPublicKey(key).export({ format: "jwk" }).x;
}

/** A fresh Reality key pair and short id, for `npm run keygen`. */
export function generateReality() {
  const { privateKey } = generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { privateKey: jwk.d, publicKey: jwk.x, shortId: randomBytes(8).toString("hex") };
}

/** The link a client app imports: VLESS over TCP, Reality, XTLS Vision. */
export function vlessLink({ uuid, host, port, serverName, publicKey, shortId, label }) {
  const query = new URLSearchParams({
    encryption: "none",
    flow: "xtls-rprx-vision",
    security: "reality",
    sni: serverName,
    fp: "chrome",
    pbk: publicKey,
    sid: shortId,
    type: "tcp",
  });
  const where = host.includes(":") ? `[${host}]` : host;
  return `vless://${uuid}@${where}:${port}?${query}#${encodeURIComponent(label)}`;
}
