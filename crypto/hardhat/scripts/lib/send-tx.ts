/**
 * Broadcast a bridge relay tx so a lost broadcast ACK can never double-pay.
 *
 * Two failure modes plagued the naive `wallet.sendTransaction(...)`:
 *
 *  1. Nonce race — the relayer EOA is shared (bridge relayer + Telegram minter
 *     + DCA bot), so a relay tx races another tx from the same account for a
 *     nonce and is rejected with "replacement transaction underpriced" /
 *     "nonce too low". We wait it out (no gas bump — that would cancel the
 *     other account's legitimate tx) until the competing tx clears the nonce.
 *
 *  2. Lost broadcast ACK — a flaky RPC accepts eth_sendRawTransaction into the
 *     mempool but drops the HTTP response, so the client throws even though the
 *     tx is live. `wallet.sendTransaction` populates+signs+broadcasts in one
 *     opaque step and only yields the hash on a clean ACK, so on this error the
 *     hash is lost. A blind resend then rebuilds a *fresh nonce* once the first
 *     tx mines → a second, duplicate payout.
 *
 * The fix: populate and sign ONCE up front so the tx hash is known before the
 * first broadcast, then (re)broadcast that exact signed tx. Resending the same
 * signed bytes is idempotent — the node dedupes by hash ("already known") — so
 * a lost ACK is recovered by returning the known hash instead of resending a
 * different tx. A fresh nonce is only rebuilt when we prove OUR tx can never
 * mine (its nonce was consumed by a different tx and no receipt exists for our
 * hash), which is safe because our original never landed.
 */
import { ethers } from "ethers";

// Node already holds this exact signed tx (a prior broadcast landed / the ACK
// was lost). It is in the mempool — treat the broadcast as done.
const ALREADY_KNOWN = [
  "already known",
  "already in the mempool",
  "txn already in mempool",
];

// The nonce is already spent. Either OUR tx mined (success, confirmed by a
// receipt lookup) or a competing tx from the shared EOA took it.
const NONCE_CONSUMED = ["nonce too low", "nonce has already been used"];

// A competing pending tx holds our nonce. Wait and resend the same signed tx
// (idempotent) until that tx mines or is dropped.
const UNDERPRICED = [
  "replacement transaction underpriced",
  "replacement tx underpriced",
  "transaction underpriced",
];

// Terminal errors — retrying the same signed tx cannot help, so fail fast
// instead of burning the whole retry budget before surfacing the real cause.
const PERMANENT = [
  "insufficient funds",
  "intrinsic gas too low",
  "exceeds block gas limit",
  "execution reverted",
  "invalid sender",
];

function errText(err: unknown): string {
  return String(
    (err as { shortMessage?: string })?.shortMessage ??
      (err as { message?: string })?.message ??
      err,
  ).toLowerCase();
}

const matches = (err: unknown, patterns: string[]): boolean => {
  const msg = errText(err);
  return patterns.some((p) => msg.includes(p));
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Transient RPC/network faults where the tx may already be on the wire: resend
// the same signed bytes rather than fail the payout.
function isTransient(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (
    code === "NETWORK_ERROR" ||
    code === "TIMEOUT" ||
    code === "SERVER_ERROR"
  ) {
    return true;
  }
  return matches(err, [
    "could not coalesce error",
    "timeout",
    "timed out",
    "etimedout",
    "econnreset",
    "socket hang up",
    "connection",
    "failed to fetch",
    "bad response",
    "service unavailable",
  ]);
}

/**
 * Broadcast `request` from `wallet`, returning the mined-or-mempooled tx hash.
 * The caller then polls the receipt (see wait-receipt.ts). Never resends a tx
 * with a different nonce than the one it already put on the wire, so a retry
 * cannot double-pay.
 */
export async function broadcastWithRecovery(
  wallet: ethers.Wallet,
  provider: ethers.JsonRpcProvider,
  request: ethers.TransactionRequest,
  {
    tries = 6,
    baseDelayMs = 1500,
    onSigned,
  }: {
    tries?: number;
    baseDelayMs?: number;
    onSigned?: (hash: string) => void | Promise<void>;
  } = {},
): Promise<{ hash: string }> {
  // Sign once so the hash is fixed before the first broadcast.
  let signed = await wallet.signTransaction(
    await wallet.populateTransaction(request),
  );
  let hash = ethers.Transaction.from(signed).hash!;
  // The caller records this identity before the RPC can accept the transfer.
  // Once recorded, this operation must never acquire another nonce.
  await onSigned?.(hash);

  let lastErr: unknown;

  for (let i = 0; i < tries; i++) {
    try {
      await provider.broadcastTransaction(signed);
      return { hash };
    } catch (err) {
      lastErr = err;

      // The node already accepted this exact tx — recover its hash.
      if (matches(err, ALREADY_KNOWN)) return { hash };

      // Nonce spent: if by our tx, it already mined → success; otherwise a
      // competing tx took it and ours can never land → rebuild a fresh nonce.
      if (matches(err, NONCE_CONSUMED)) {
        const receipt = await provider.getTransactionReceipt(hash);
        if (receipt) return { hash };
        if (onSigned) throw err;
        if (i === tries - 1) throw err;
        await sleep(baseDelayMs * (i + 1));
        signed = await wallet.signTransaction(
          await wallet.populateTransaction(request),
        );
        hash = ethers.Transaction.from(signed).hash!;
        continue;
      }

      // Terminal error, or budget exhausted — surface it.
      if (matches(err, PERMANENT) || i === tries - 1) throw err;

      // Underpriced (competing pending tx) or a transient RPC/network error:
      // back off and resend the SAME signed tx (idempotent). Backoff grows so
      // a busy shared account has time to clear the pending nonce.
      if (!matches(err, UNDERPRICED) && !isTransient(err)) throw err;
      await sleep(baseDelayMs * (i + 1));
    }
  }

  throw lastErr;
}
