import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { challengeMessage, createGate, listen, NonceBook, NONCE_TTL_MS } from "../src/gate.mjs";

const node = { id: "de-1", host: "vpn.example", port: 443 };

async function withGate(passUntil, run) {
  const nonces = new NonceBook();
  const server = await listen(
    createGate({ node, nonces, passUntil, linkFor: (address) => `vless://${address}` }),
    0,
    "127.0.0.1",
  );
  const base = `http://127.0.0.1:${server.address().port}/api/vpn`;
  try {
    await run(base);
  } finally {
    server.close();
  }
}

const claim = async (base, wallet, tamper = (m) => m) => {
  const { nonce, message } = await (await fetch(`${base}/challenge?address=${wallet.address}`)).json();
  assert.equal(message, challengeMessage(wallet.address, "de-1", nonce));
  const signature = await wallet.signMessage(tamper(message));
  return fetch(`${base}/link`, {
    method: "POST",
    body: JSON.stringify({ address: wallet.address, nonce, signature }),
  });
};

test("a signed claim with a running pass gets the link, once per nonce", async () => {
  const wallet = Wallet.createRandom();
  const future = Math.floor(Date.now() / 1000) + 3600;
  await withGate(async () => future, async (base) => {
    const res = await claim(base, wallet);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.link, `vless://${wallet.address.toLowerCase()}`);
    assert.equal(body.expiresAt, future);
  });
});

test("no pass is a 402, a wrong signature a 401", async () => {
  const wallet = Wallet.createRandom();
  await withGate(async () => 0, async (base) => {
    assert.equal((await claim(base, wallet)).status, 402);
    assert.equal((await claim(base, wallet, (m) => `${m}!`)).status, 401);
  });
});

test("a nonce is good once, for one address, for five minutes", () => {
  let clock = 0;
  const book = new NonceBook(() => clock);
  const a = book.issue("0xa");
  assert.equal(book.consume(a, "0xb"), false);
  assert.equal(book.consume(a, "0xa"), false);
  const b = book.issue("0xa");
  clock = NONCE_TTL_MS + 1;
  assert.equal(book.consume(b, "0xa"), false);
  const c = book.issue("0xa");
  assert.equal(book.consume(c, "0xa"), true);
});

test("the challenge matches the wallet's vector (tests/Frontend/WalletVpnTest.mjs)", () => {
  assert.equal(
    challengeMessage("0xAbC0000000000000000000000000000000000001", "de-1", "00112233445566778899aabbccddeeff"),
    [
      "Cyberia VPN: issue my connection link.",
      "This signature spends nothing.",
      "Address: 0xabc0000000000000000000000000000000000001",
      "Node: de-1",
      "Nonce: 00112233445566778899aabbccddeeff",
    ].join("\n"),
  );
});
