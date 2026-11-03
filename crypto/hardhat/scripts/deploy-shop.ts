/**
 * Deploys CyberiaShop — digital goods (keys, subscriptions, accounts,
 * domains, hosting, AI credits) sold through escrow — to Cyberia Fuji L1
 * (chain 49407).
 *
 * The fee address and rate are immutable: 2% of what a seller receives goes
 * to the project fee address; refunds are whole. The owner (the protocol Safe
 * by default) names moderators, who hide lots, ban sellers and decide
 * disputes, and can pause new lots and purchases.
 *
 * Usage:
 *   EVM_RPC_URL=https://... npx tsx scripts/deploy-shop.ts            # dry run, sends nothing
 *   EVM_RPC_URL=https://... DEPLOY=1 npx tsx scripts/deploy-shop.ts   # deploy
 *
 * env:
 *   EVM_RPC_URL  — RPC of chain 49407 (checked against the chain id)
 *   SHOP_OWNER      — names moderators, pauses; defaults to the protocol Safe
 *   SHOP_MODERATOR  — optional first moderator (set by the owner afterwards
 *                     when the owner is the Safe)
 *   DEPLOYER_PK  — pays for the deploy, holds no rights afterwards
 */

import "dotenv/config";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatEther,
  getAddress,
  http,
  isAddress,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as fs from "node:fs";
import * as path from "node:path";

const CHAIN_ID = 49407;
/** Safe 2/3 of the new protocol (lain-labs/backend resources/chaos-protocol.json). */
const PROTOCOL_SAFE = "0x96cd117786EBC0fDbef56a6559FEB2bd2BaE3393";

/** Every fee of every service goes here (Lev, 2026-10-25). */
const FEE_RECIPIENT = "0x54BB8a86Fc001d5BB3e6C7ad2e2f153E5Fa6d7f6";
const FEE_BPS = 200;
const DELIVERY_WINDOW = 48 * 3600;
const DISPUTE_WINDOW = 72 * 3600;

const RPC_URL = process.env.EVM_RPC_URL || "https://cyberia.church/api/fuji/rpc";

const DEPLOYER_PK = process.env.DEPLOYER_PK;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_PK not set in .env");
const pk = (DEPLOYER_PK.startsWith("0x") ? DEPLOYER_PK : `0x${DEPLOYER_PK}`) as `0x${string}`;
const account = privateKeyToAccount(pk);

const chain = defineChain({
  id: CHAIN_ID,
  name: "Cyberia Fuji",
  nativeCurrency: { name: "CYBER", symbol: "CYBER", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

const walletClient = createWalletClient({ chain, transport: http(RPC_URL), account });
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

function loadArtifact(p: string): { abi: Abi; bytecode: Hex } {
  return JSON.parse(fs.readFileSync(path.resolve(p), "utf8")) as { abi: Abi; bytecode: Hex };
}

async function main() {
  const rawOwner = process.env.SHOP_OWNER || PROTOCOL_SAFE;
  if (!isAddress(rawOwner)) throw new Error(`SHOP_OWNER is not an address: ${rawOwner}`);
  const owner = getAddress(rawOwner);

  if ((await publicClient.getChainId()) !== CHAIN_ID) {
    throw new Error(`RPC ${RPC_URL} is not chain ${CHAIN_ID}`);
  }

  console.log("=== Deploy CyberiaShop ===");
  console.log("RPC:      ", RPC_URL);
  console.log("Deployer: ", account.address);
  console.log("Owner:    ", owner, owner === PROTOCOL_SAFE ? "(protocol Safe)" : "");
  console.log("Fee:      ", FEE_BPS / 100, "% to", FEE_RECIPIENT);
  console.log("Windows:  ", "delivery 48h, dispute 72h");

  const balance = await publicClient.getBalance({ address: account.address });
  console.log("Balance:  ", formatEther(balance), "CYBER");
  if (balance === 0n) throw new Error("Deployer has 0 CYBER — fund it before deploying.");

  if (process.env.DEPLOY !== "1") {
    console.log("\nDry run. Set DEPLOY=1 to broadcast.");
    return;
  }

  const art = loadArtifact("./artifacts/contracts/CyberiaShop.sol/CyberiaShop.json");
  const hash = await walletClient.deployContract({
    abi: art.abi,
    bytecode: art.bytecode,
    args: [owner, FEE_RECIPIENT, FEE_BPS, BigInt(DELIVERY_WINDOW), BigInt(DISPUTE_WINDOW)] as never,
  });
  console.log("\nCyberiaShop deploy tx:", hash);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error("CyberiaShop deploy reverted");
  }
  console.log("CyberiaShop:", receipt.contractAddress);
  console.log("gas used:  ", receipt.gasUsed.toString());

  const out = {
    chainId: CHAIN_ID,
    rpc: RPC_URL,
    CyberiaShop: receipt.contractAddress,
    feeRecipient: FEE_RECIPIENT,
    feeBps: FEE_BPS,
    owner,
    deployer: account.address,
    deployTx: hash,
    block: Number(receipt.blockNumber),
    timestamp: new Date().toISOString(),
  };
  const moderator = process.env.SHOP_MODERATOR;
  if (moderator && owner === account.address) {
    const abi = art.abi;
    const tx = await walletClient.writeContract({
      address: receipt.contractAddress,
      abi,
      functionName: "setModerator",
      args: [getAddress(moderator), true] as never,
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
    console.log("Moderator:", moderator);
  } else if (moderator) {
    console.log("Moderator: the owner must call setModerator(" + moderator + ", true)");
  }

  const outPath = path.resolve(`./deployments/cyberia-shop-${CHAIN_ID}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log("\nWrote:", outPath);
  console.log("Next: put this address into SHOP_ADDRESS in backend/laravel/resources/js/lib/wallet/shop.ts and rebuild the site.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
