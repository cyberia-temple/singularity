// Who has paid, read from CyberiaVpnPass's own log.
//
// Every purchase emits `PassBought(user, payer, days, expiresAt, paid, fee)`
// with the new end of that address's access, so the latest event per address
// *is* its pass — no per-address call, and every node arrives at the same set.
// The scan is incremental and its cursor is kept on disk, so a restart does
// not reread the chain from the deployment block.

import { Interface } from "ethers";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const PASS_ABI = [
  "event PassBought(address indexed user, address indexed payer, uint32 days_, uint64 expiresAt, uint256 paid, uint256 fee)",
  "function expiresAt(address user) view returns (uint64)",
  "function pricePerDay() view returns (uint256)",
];

const passInterface = new Interface(PASS_ABI);
const PASS_TOPIC = passInterface.getEvent("PassBought").topicHash;

/** Fold decoded purchases into `expiries` (address → unix seconds). Pure. */
export function foldPurchases(expiries, purchases) {
  for (const { user, expiresAt } of purchases) {
    const key = user.toLowerCase();
    const until = Number(expiresAt);
    if (!(expiries[key] >= until)) {
      expiries[key] = until;
    }
  }
  return expiries;
}

/** Addresses whose pass is still running at `now` (unix seconds), sorted. Pure. */
export function activeAddresses(expiries, now) {
  return Object.keys(expiries)
    .filter((address) => expiries[address] > now)
    .sort();
}

export class PassIndex {
  constructor({ provider, address, fromBlock, statePath, chunk = 5000, log = console }) {
    this.provider = provider;
    this.address = address;
    this.statePath = statePath;
    this.chunk = chunk;
    this.log = log;
    const saved = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
    const sameContract = saved?.address?.toLowerCase() === address.toLowerCase();
    this.next = sameContract ? saved.next : fromBlock;
    this.expiries = sameContract ? saved.expiries : {};
  }

  /** Read every block not yet read; returns the expiry map. */
  async sync() {
    const head = await this.provider.getBlockNumber();
    while (this.next <= head) {
      const to = Math.min(this.next + this.chunk - 1, head);
      const logs = await this.provider.getLogs({
        address: this.address,
        topics: [PASS_TOPIC],
        fromBlock: this.next,
        toBlock: to,
      });
      foldPurchases(
        this.expiries,
        logs.map((entry) => passInterface.parseLog(entry).args),
      );
      this.next = to + 1;
      this.save();
    }
    return this.expiries;
  }

  save() {
    if (!this.statePath) {
      return;
    }
    writeFileSync(
      this.statePath,
      JSON.stringify({ address: this.address, next: this.next, expiries: this.expiries }),
    );
  }
}
