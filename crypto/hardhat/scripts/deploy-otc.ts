/**
 * Deploys CyberiaOTC — fixed-price OTC offers with no platform fee — to any
 * EVM chain. The chain is whatever the RPC answers; the record lands in
 * deployments/cyberia-otc-<chainId>.json and the wallet reads its address
 * from OTC_DEPLOYMENTS in backend/laravel/resources/js/lib/wallet/otc.ts.
 *
 * The contract has no fee and no treasury. Its owner can only pause new
 * offers and fills: the protocol Safe (2/3) on Cyberia Fuji, where one
 * exists, and the deployer elsewhere unless OTC_OWNER names somebody else.
 *
 * Usage:
 *   EVM_RPC_URL=https://... npx tsx scripts/deploy-otc.ts            # dry run, sends nothing
 *   EVM_RPC_URL=https://... DEPLOY=1 npx tsx scripts/deploy-otc.ts   # deploy
 *
 * env:
 *   EVM_RPC_URL  — RPC of the target chain (default: Cyberia Fuji)
 *   OTC_OWNER    — pause authority
 *   DEPLOYER_PK  — pays for the deploy
 */

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeDeployData,
  formatEther,
  formatGwei,
  getAddress,
  http,
  isAddress,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as fs from "node:fs";
import * as path from "node:path";

/** Safe 2/3 of the new protocol (lain-labs/backend resources/chaos-protocol.json). */
const PROTOCOL_SAFE = "0x96cd117786EBC0fDbef56a6559FEB2bd2BaE3393";
const SAFE_CHAIN_ID = 49407;

/** Chains whose pool refuses anything under a fixed gas price. */
const GAS_FLOOR: Record<number, bigint> = { 49406: 1_500_000_000n };

const RPC_URL = process.env.EVM_RPC_URL || "https://cyberia.church/api/fuji/rpc";

const DEPLOYER_PK = process.env.DEPLOYER_PK;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_PK not set in .env");
const pk = (DEPLOYER_PK.startsWith("0x") ? DEPLOYER_PK : `0x${DEPLOYER_PK}`) as `0x${string}`;
const account = privateKeyToAccount(pk);

const probe = createPublicClient({ transport: http(RPC_URL) });

function loadArtifact(p: string): { abi: Abi; bytecode: Hex } {
  return JSON.parse(fs.readFileSync(path.resolve(p), "utf8")) as { abi: Abi; bytecode: Hex };
}

async function main() {
  const CHAIN_ID = await probe.getChainId();
  const chain = defineChain({
    id: CHAIN_ID,
    name: `chain ${CHAIN_ID}`,
    nativeCurrency: { name: "coin", symbol: "coin", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  });
  const walletClient = createWalletClient({ chain, transport: http(RPC_URL), account });
  const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

  const outPath = path.resolve(`./deployments/cyberia-otc-${CHAIN_ID}.json`);
  if (fs.existsSync(outPath) && process.env.OTC_REDEPLOY !== "1") {
    const existing = JSON.parse(fs.readFileSync(outPath, "utf8")) as { CyberiaOTC: string };
    console.log(`Chain ${CHAIN_ID} already has CyberiaOTC at ${existing.CyberiaOTC}. Set OTC_REDEPLOY=1 to deploy another.`);
    return;
  }

  const rawOwner =
    process.env.OTC_OWNER || (CHAIN_ID === SAFE_CHAIN_ID ? PROTOCOL_SAFE : account.address);
  if (!isAddress(rawOwner)) throw new Error(`OTC_OWNER is not an address: ${rawOwner}`);
  const owner = getAddress(rawOwner);

  const quoted = await publicClient.getGasPrice();
  const floor = GAS_FLOOR[CHAIN_ID] ?? 0n;
  const gasPrice = quoted > floor ? quoted : floor;

  console.log("=== Deploy CyberiaOTC (no fee) ===");
  console.log("RPC:      ", RPC_URL, `(chain ${CHAIN_ID})`);
  console.log("Deployer: ", account.address);
  console.log("Owner:    ", owner, owner === PROTOCOL_SAFE ? "(protocol Safe; pause only)" : "(pause only)");

  const balance = await publicClient.getBalance({ address: account.address });
  const art = loadArtifact("./artifacts/contracts/CyberiaOTC.sol/CyberiaOTC.json");
  const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [owner] } as never);
  const gas = await publicClient
    .estimateGas({ account, data })
    .catch(() => 2_200_000n);
  const cost = gas * gasPrice;
  console.log("Balance:  ", formatEther(balance), "(native coin)");
  console.log("Needs:    ", formatEther(cost), `(${gas} gas at ${formatGwei(gasPrice)} gwei)`);
  if (balance < cost) {
    throw new Error(`Deployer holds ${formatEther(balance)}, the deploy needs about ${formatEther(cost)}.`);
  }

  if (process.env.DEPLOY !== "1") {
    console.log("\nDry run. Set DEPLOY=1 to broadcast.");
    return;
  }

  const hash = await walletClient.deployContract({
    abi: art.abi,
    bytecode: art.bytecode,
    args: [owner],
    gasPrice,
    chain,
  } as never);
  console.log("\nCyberiaOTC deploy tx:", hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error("CyberiaOTC deploy reverted");
  }
  console.log("CyberiaOTC:", receipt.contractAddress);
  console.log("gas used:  ", receipt.gasUsed.toString());

  const out = {
    chainId: CHAIN_ID,
    rpc: RPC_URL,
    CyberiaOTC: receipt.contractAddress,
    owner,
    deployer: account.address,
    deployTx: hash,
    block: Number(receipt.blockNumber),
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log("\nWrote:", outPath);
  console.log("Next: add this address to OTC_DEPLOYMENTS in backend/laravel/resources/js/lib/wallet/otc.ts and rebuild the site.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
