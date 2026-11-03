import assert from "node:assert/strict";
import test from "node:test";
import { activeAddresses, foldPurchases } from "../src/passes.mjs";
import { buildConfig } from "../src/xray.mjs";

test("the latest expiry per address wins, whatever order logs arrive in", () => {
  const expiries = foldPurchases({}, [
    { user: "0xAA00000000000000000000000000000000000000", expiresAt: 200n },
    { user: "0xaa00000000000000000000000000000000000000", expiresAt: 100n },
    { user: "0xbb00000000000000000000000000000000000000", expiresAt: 50n },
  ]);
  assert.deepEqual(expiries, {
    "0xaa00000000000000000000000000000000000000": 200,
    "0xbb00000000000000000000000000000000000000": 50,
  });
  assert.deepEqual(activeAddresses(expiries, 100), ["0xaa00000000000000000000000000000000000000"]);
  assert.deepEqual(activeAddresses(expiries, 200), []);
});

test("xray gets one Vision client per pass and never routes to private ranges", () => {
  const config = buildConfig({
    port: 443,
    dest: "www.microsoft.com:443",
    serverName: "www.microsoft.com",
    privateKey: "PRIV",
    shortId: "ab",
    clients: [{ id: "u1", email: "0xaa" }],
  });
  const inbound = config.inbounds[0];
  assert.deepEqual(inbound.settings.clients, [{ id: "u1", email: "0xaa", flow: "xtls-rprx-vision" }]);
  assert.equal(inbound.streamSettings.realitySettings.privateKey, "PRIV");
  assert.ok(config.routing.rules.some((rule) => rule.ip?.includes("geoip:private") && rule.outboundTag === "block"));
});

test("with nobody paying, the only client is a placeholder nobody holds", () => {
  const config = buildConfig({ port: 443, dest: "d:443", serverName: "d", privateKey: "P", shortId: "a", clients: [] });
  const [only] = config.inbounds[0].settings.clients;
  assert.equal(only.email, "nobody");
});
