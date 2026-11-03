// The node's one door for the wallet: prove you hold the key behind an address
// with a running pass, and get that address's link.
//
// The wallet never signs text it was handed. The challenge is built from three
// values on both sides — the address, this node's id and a one-shot nonce —
// with `challengeMessage`, which `resources/js/lib/wallet/vpn.ts` mirrors byte
// for byte, so a node cannot get a wallet to sign anything but this sentence.
// No cookie, no session, no account: CORS is open because nothing here is
// ambient authority.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { verifyMessage } from "ethers";
import { normalizeAddress } from "./identity.mjs";

export const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_NONCES = 10_000;
const MAX_BODY = 4096;

/** The exact text a wallet signs to be given its link on `node`. */
export function challengeMessage(address, node, nonce) {
  return [
    "Cyberia VPN: issue my connection link.",
    "This signature spends nothing.",
    `Address: ${address.toLowerCase()}`,
    `Node: ${node}`,
    `Nonce: ${nonce}`,
  ].join("\n");
}

export class NonceBook {
  constructor(now = () => Date.now()) {
    this.now = now;
    this.entries = new Map();
  }

  issue(address) {
    if (this.entries.size >= MAX_NONCES) {
      this.prune();
    }
    const nonce = randomBytes(16).toString("hex");
    this.entries.set(nonce, { address, at: this.now() });
    return nonce;
  }

  /** True once per nonce, and only for the address it was issued to. */
  consume(nonce, address) {
    const entry = this.entries.get(nonce);
    this.entries.delete(nonce);
    return Boolean(entry) && entry.address === address && this.now() - entry.at <= NONCE_TTL_MS;
  }

  prune() {
    const cutoff = this.now() - NONCE_TTL_MS;
    for (const [nonce, { at }] of this.entries) {
      if (at < cutoff) {
        this.entries.delete(nonce);
      }
    }
  }
}

/**
 * The request handler. `node` is this node's public description;
 * `passUntil(address)` answers with the unix second the pass ends (0 = none);
 * `linkFor(address)` builds the link.
 */
export function createGate({ node, nonces, passUntil, linkFor, now = () => Date.now() }) {
  const send = (res, status, body) => {
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  };

  return async (req, res) => {
    const url = new URL(req.url, "http://gate");
    const path = url.pathname.replace(/\/+$/, "");

    try {
      if (req.method === "OPTIONS") {
        return send(res, 204, {});
      }

      if (req.method === "GET" && path.endsWith("/status")) {
        return send(res, 200, node);
      }

      if (req.method === "GET" && path.endsWith("/challenge")) {
        const address = normalizeAddress(url.searchParams.get("address"));
        if (!address) {
          return send(res, 400, { error: "badAddress" });
        }
        const nonce = nonces.issue(address);
        return send(res, 200, { node: node.id, nonce, message: challengeMessage(address, node.id, nonce) });
      }

      if (req.method === "POST" && path.endsWith("/link")) {
        const body = await readJson(req);
        const address = normalizeAddress(body?.address);
        if (!address || typeof body.nonce !== "string" || typeof body.signature !== "string") {
          return send(res, 400, { error: "badRequest" });
        }
        if (!nonces.consume(body.nonce, address)) {
          return send(res, 401, { error: "staleChallenge" });
        }
        let signer;
        try {
          signer = verifyMessage(challengeMessage(address, node.id, body.nonce), body.signature).toLowerCase();
        } catch {
          signer = null;
        }
        if (signer !== address) {
          return send(res, 401, { error: "badSignature" });
        }
        const until = await passUntil(address);
        if (until * 1000 <= now()) {
          return send(res, 402, { error: "noPass", expiresAt: until || null });
        }
        return send(res, 200, { link: linkFor(address), expiresAt: until, node: node.id });
      }

      return send(res, 404, { error: "notFound" });
    } catch (error) {
      console.error("gate:", error?.message ?? error);
      return send(res, 503, { error: "unavailable" });
    }
  };
}

export function listen(handler, port, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(port, host, () => resolve(server));
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}
