/**
 * Launch one token with the whole kit against a deployment, and report what it cost.
 *
 *   RPC_URL=... DEPLOYER_PK=... node scripts/smoke-launch.ts [cyberAmount]
 *
 * The gas a full-kit launch takes is the floor for the chain's block gas limit: genesis must
 * allow at least this much in one transaction, with room to spare.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, parseEther, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = process.env.RPC_URL!;
const account = privateKeyToAccount(process.env.DEPLOYER_PK as Hex);
const transport = http(RPC_URL);
const publicClient = createPublicClient({ transport });
const chainId = await publicClient.getChainId();
const chain = {
  id: chainId,
  name: "local",
  nativeCurrency: { name: "CYBER", symbol: "CYBER", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;
const wallet = createWalletClient({ account, chain, transport });

const record = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments", `${chainId}.json`), "utf8"));
const launchpadAbi: Abi = JSON.parse(
  fs.readFileSync(path.join(ROOT, "artifacts/contracts/launch/Launchpad.sol/Launchpad.json"), "utf8"),
).abi;

const params = {
  name: ".smoke",
  symbol: "DOTSMOKE",
  totalSupply: parseEther("1000000000"),
  creatorFee: 30_000,
  holdersShareBps: 5_000,
  salt: `0x${Date.now().toString(16).padStart(64, "0")}` as Hex,
  kit: 1 | 2 | 4 | 8,
  metadataURI: "",
};

const hash = await wallet.writeContract({
  address: record.contracts.Launchpad as Address,
  abi: launchpadAbi,
  functionName: "launch",
  args: [params],
  value: parseEther(process.argv[2] ?? "10"),
  gas: 16_700_000n,
});
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`status ${receipt.status}, gas used ${receipt.gasUsed}`);
