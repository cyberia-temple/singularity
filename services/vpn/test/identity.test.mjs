import assert from "node:assert/strict";
import test from "node:test";
import { realityPublicKey, uuidFor, vlessLink } from "../src/identity.mjs";

const b64url = (hex) => Buffer.from(hex, "hex").toString("base64url");

test("the Reality public key is X25519 of the private key (RFC 7748 vector)", () => {
  const priv = b64url("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
  const pub = b64url("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
  assert.equal(realityPublicKey(priv), pub);
});

test("a client id is stable per address, case-blind, and secret-bound", () => {
  const secret = "s".repeat(32);
  const a = uuidFor(secret, "0xAbC0000000000000000000000000000000000001");
  assert.equal(a, uuidFor(secret, "0xabc0000000000000000000000000000000000001"));
  assert.notEqual(a, uuidFor("t".repeat(32), "0xabc0000000000000000000000000000000000001"));
  assert.notEqual(a, uuidFor(secret, "0xabc0000000000000000000000000000000000002"));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("the link carries everything a client app needs", () => {
  const link = vlessLink({
    uuid: "11111111-1111-4111-8111-111111111111",
    host: "vpn.cyberia.church",
    port: 443,
    serverName: "www.microsoft.com",
    publicKey: "PUB",
    shortId: "abcd",
    label: "Cyberia de-1",
  });
  const url = new URL(link);
  assert.equal(url.protocol, "vless:");
  assert.equal(url.username, "11111111-1111-4111-8111-111111111111");
  assert.equal(url.host, "vpn.cyberia.church:443");
  assert.equal(url.searchParams.get("security"), "reality");
  assert.equal(url.searchParams.get("flow"), "xtls-rprx-vision");
  assert.equal(url.searchParams.get("pbk"), "PUB");
  assert.equal(url.searchParams.get("sid"), "abcd");
  assert.equal(decodeURIComponent(url.hash.slice(1)), "Cyberia de-1");
});
