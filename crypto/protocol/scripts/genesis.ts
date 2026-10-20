/**
 * Add Cyberia's predeploys to an Avalanche L1 genesis.
 *
 *   node scripts/genesis.ts <genesis-in.json> <genesis-out.json> [wcyberAddress]
 *
 * Start from the genesis avalanche-cli (or the Builder Console) produces -- it owns the parts that
 * are about the chain: the validator manager, the precompile admins, the fee config, the initial
 * balances. This script only adds contracts that every wallet and tool expects to find at a fixed
 * address from block 0, and checks the one fee setting the protocol depends on:
 *
 *   - WCYBER at `wcyberAddress` (default 0x...C0FE): the wrapped native coin;
 *   - Multicall3 at 0xcA11bde05977b3631167028862bE2a173976CA11, where every library looks for it;
 *   - the deterministic CREATE2 deployer at 0x4e59b44847b379578588920cA78FbF26c0B4956C, so contracts
 *     can be deployed at the same address on Cyberia as on other chains;
 *   - the block gas limit: a launch with its whole kit takes about 12M gas, so less than 15M
 *     is refused.
 *
 * Pass the WCYBER address chosen here as `wcyber` in the deploy config.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const [input, output, wcyberArg] = process.argv.slice(2);
if (!input || !output) throw new Error("usage: node scripts/genesis.ts <in.json> <out.json> [wcyberAddress]");

const WCYBER = (wcyberArg ?? "0x000000000000000000000000000000000000C0FE").toLowerCase();
const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
const CREATE2_DEPLOYER = "0x4e59b44847b379578588920ca78fbf26c0b4956c";
// The runtime code of Arachnid's deterministic deployment proxy, as deployed on every chain.
const CREATE2_DEPLOYER_CODE =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

const MIN_GAS_LIMIT = 15_000_000;

function runtime(name: string, file: string): string {
  const artifactPath = path.join(ROOT, "artifacts", file, `${name}.json`);
  if (!fs.existsSync(artifactPath)) throw new Error(`missing ${artifactPath}; run npx hardhat build`);
  return JSON.parse(fs.readFileSync(artifactPath, "utf8")).deployedBytecode;
}

const genesis = JSON.parse(fs.readFileSync(input, "utf8"));
genesis.alloc ??= {};

const predeploys: Record<string, string> = {
  [WCYBER]: runtime("WCYBER", "contracts/tokens/WCYBER.sol"),
  [MULTICALL3]: runtime("Multicall3", "contracts/vendor/multicall/Multicall3.sol"),
  [CREATE2_DEPLOYER]: CREATE2_DEPLOYER_CODE,
};

for (const [address, code] of Object.entries(predeploys)) {
  const key = Object.keys(genesis.alloc).find((k) => k.toLowerCase().replace(/^0x/, "") === address.replace(/^0x/, ""));
  const existing = key ? genesis.alloc[key] : undefined;
  if (existing?.code && existing.code !== code) {
    throw new Error(`${address} already holds different code in the input genesis`);
  }
  genesis.alloc[address.replace(/^0x/, "")] = { ...(existing ?? {}), balance: existing?.balance ?? "0x0", code };
  if (key && key !== address.replace(/^0x/, "")) delete genesis.alloc[key];
  console.log(`predeploy ${address}`);
}

const gasLimit = Number(genesis.config?.feeConfig?.gasLimit ?? BigInt(genesis.gasLimit ?? "0"));
if (gasLimit < MIN_GAS_LIMIT) {
  throw new Error(`feeConfig.gasLimit ${gasLimit} is below ${MIN_GAS_LIMIT}: a full-kit launch would not fit in a block`);
}
console.log(`block gas limit ${gasLimit}`);

fs.writeFileSync(output, JSON.stringify(genesis, null, 2) + "\n");
console.log(`wrote ${output}`);
