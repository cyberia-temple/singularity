/**
 * Write CYBER's genesis: the supply, its backing, and the predeploys.
 *
 *   node scripts/genesis.ts --in genesis.json --out genesis.cyberia.json --deployer 0x… \
 *       [--supply 1000000] [--alloc allocations.json] [--wcyber 0x…]
 *
 * Start from the genesis avalanche-cli (or the Builder Console) produces -- it owns the parts that
 * are about the chain itself: the validator manager, precompile admins, the fee config. This adds
 * what is about CYBER:
 *
 *   - **The supply.** CYBER is 1,000,000 coins, forever: one for every 1,000 CYBER.sol on Solana.
 *     `--alloc` lists balances genesis gives out directly (e.g. restoring the old chain's users);
 *     everything else is credited to the bridge gateway's address, as the backing of the CYBER.sol
 *     that has not crossed yet. The gateway is deployed later at exactly that address (CREATE2,
 *     see scripts/lib/create2.ts), so the backing is visibly in place from block 0.
 *   - **No minting, ever.** A genesis that enables the NativeMinter precompile is refused: CYBER's
 *     fixed supply is a property of the chain, not a promise.
 *   - **Fees burn.** Burned fees are part of the fire ASH is made from; a genesis that redirects
 *     them (fee recipients, a RewardManager reward address) is refused.
 *   - **Predeploys:** WCYBER at `--wcyber` (default 0x…C0FE), Multicall3 at its canonical address,
 *     the deterministic CREATE2 deployer.
 *   - **Gas:** a launch with its whole kit takes about 12M gas, so a block limit under 15M is refused.
 */

import * as fs from "node:fs";
import { getAddress, parseEther, toHex, type Address } from "viem";

import { CREATE2_DEPLOYER, CREATE2_DEPLOYER_CODE, ROOT, predictCore } from "./lib/create2.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

const input = arg("in");
const output = arg("out");
const deployer = getAddress(arg("deployer"));
const supply = parseEther(arg("supply", "1000000"));
const allocPath = arg("alloc", "");
const WCYBER = getAddress(arg("wcyber", "0x000000000000000000000000000000000000C0FE"));
const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const MIN_GAS_LIMIT = 15_000_000;

const genesis = JSON.parse(fs.readFileSync(input, "utf8"));
const config = genesis.config ?? {};

// ------------------------------------------------------------------------------ chain rules

if (config.contractNativeMinterConfig) {
  throw new Error("genesis enables the NativeMinter: CYBER's supply must be fixed; remove contractNativeMinterConfig");
}
if (config.allowFeeRecipients) throw new Error("genesis lets validators keep fees; fees must burn (allowFeeRecipients: false)");
if (config.rewardManagerConfig?.initialRewardConfig?.rewardAddress) {
  throw new Error("genesis redirects fees through the RewardManager; fees must burn");
}
const gasLimit = Number(config.feeConfig?.gasLimit ?? BigInt(genesis.gasLimit ?? "0"));
if (gasLimit < MIN_GAS_LIMIT) {
  throw new Error(`feeConfig.gasLimit ${gasLimit} is below ${MIN_GAS_LIMIT}: a full-kit launch would not fit in a block`);
}

// ----------------------------------------------------------------------------------- supply

// Whatever the CLI already put in genesis stays (the validator manager and its proxy live there),
// and any balance it gave out counts against the supply.
genesis.alloc ??= {};
let preallocated = 0n;
for (const entry of Object.values(genesis.alloc) as { balance?: string }[]) {
  preallocated += BigInt(entry.balance ?? "0x0");
}

const credit = (address: Address, wei: bigint) => {
  const key = address.toLowerCase().replace(/^0x/, "");
  const current = BigInt(genesis.alloc[key]?.balance ?? "0x0");
  genesis.alloc[key] = { ...(genesis.alloc[key] ?? {}), balance: toHex(current + wei) };
};

let allocated = preallocated;
if (allocPath) {
  const allocations: Record<string, string> = JSON.parse(fs.readFileSync(allocPath, "utf8"));
  for (const [address, cyber] of Object.entries(allocations)) {
    const wei = parseEther(cyber);
    credit(getAddress(address), wei);
    allocated += wei;
  }
}
if (allocated > supply) throw new Error("allocations exceed the supply");

const { authority, gateway } = predictCore(deployer);
const backing = supply - allocated;
credit(gateway, backing);

// ------------------------------------------------------------------------------- predeploys

const runtime = (name: string, file: string) =>
  JSON.parse(fs.readFileSync(`${ROOT}/artifacts/${file}/${name}.json`, "utf8")).deployedBytecode;

const predeploys: [Address, string][] = [
  [WCYBER, runtime("WCYBER", "contracts/tokens/WCYBER.sol")],
  [MULTICALL3, runtime("Multicall3", "contracts/vendor/multicall/Multicall3.sol")],
  [CREATE2_DEPLOYER, CREATE2_DEPLOYER_CODE],
];
for (const [address, code] of predeploys) {
  const key = address.toLowerCase().replace(/^0x/, "");
  genesis.alloc[key] = { ...(genesis.alloc[key] ?? { balance: "0x0" }), code };
}

fs.writeFileSync(output, JSON.stringify(genesis, null, 2) + "\n");

const cyber = (wei: bigint) => (Number(wei / 10n ** 14n) / 1e4).toLocaleString("en-US");
console.log(`supply            ${cyber(supply)} CYBER`);
console.log(`direct allocations ${cyber(allocated)} CYBER (${cyber(preallocated)} already in the input genesis)`);
console.log(`bridge backing    ${cyber(backing)} CYBER at the gateway ${gateway}`);
console.log(`  (= ${cyber(backing * 1000n)} CYBER.sol that can still cross, at 1000:1)`);
console.log(`authority         ${authority} (deploy with ${deployer})`);
console.log(`WCYBER            ${WCYBER}`);
console.log(`block gas limit   ${gasLimit}`);
console.log(`wrote ${output}`);
