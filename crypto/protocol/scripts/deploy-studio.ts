/**
 * Add the TokenStudio to a chain that already runs the protocol, wired like its Launchpad.
 *
 *   RPC_URL=... DEPLOYER_PK=... node scripts/deploy-studio.ts
 *
 * Resumable, like deploy.ts: what is in `deployments/<chainId>.json` is not done again. The key
 * must hold the authority's admin role without delay (the deployer does until it is renounced).
 *
 * Every governed setting is copied from the Launchpad, so a studio token gets the same floor, the
 * same credit terms and the same farm and DAO modules as a launch. Zones are left unset: Domains
 * opens a zone only for a token its own launchpad launched.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, zeroAddress, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC_URL = process.env.RPC_URL;
const PK = process.env.DEPLOYER_PK;
if (!RPC_URL || !PK) throw new Error("RPC_URL and DEPLOYER_PK must be set");

const account = privateKeyToAccount((PK.startsWith("0x") ? PK : `0x${PK}`) as Hex);
const transport = http(RPC_URL);
const publicClient = createPublicClient({ transport });
const chainId = await publicClient.getChainId();
const chain = {
  id: chainId,
  name: `chain-${chainId}`,
  nativeCurrency: { name: "CYBER", symbol: "CYBER", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
} as const;
const wallet = createWalletClient({ account, chain, transport });

const RECORD_PATH = path.join(ROOT, "deployments", `${chainId}.json`);
type DeployRecord = { contracts: Record<string, Address>; steps: string[] } & Record<string, unknown>;
const record: DeployRecord = JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"));
const save = () => fs.writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2) + "\n");

const ARTIFACTS: Record<string, string> = {
  Launchpad: "artifacts/contracts/launch/Launchpad.sol/Launchpad.json",
  TokenStudio: "artifacts/contracts/launch/TokenStudio.sol/TokenStudio.json",
  StudioToken: "artifacts/contracts/tokens/StudioToken.sol/StudioToken.json",
  LaunchLocker: "artifacts/contracts/launch/LaunchLocker.sol/LaunchLocker.json",
};
const artifact = (name: string): { abi: Abi; bytecode: Hex } =>
  JSON.parse(fs.readFileSync(path.join(ROOT, ARTIFACTS[name]), "utf8"));

const AUTHORITY_ABI = [
  {
    type: "function",
    name: "grantRole",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roleId", type: "uint64" },
      { name: "account", type: "address" },
      { name: "executionDelay", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "hasRole",
    stateMutability: "view",
    inputs: [
      { name: "roleId", type: "uint64" },
      { name: "account", type: "address" },
    ],
    outputs: [
      { name: "isMember", type: "bool" },
      { name: "executionDelay", type: "uint32" },
    ],
  },
] as const satisfies Abi;

/** The role `Voter.createGauge` answers to: deploy.ts labels it LAUNCHPAD. */
const LAUNCHPAD_ROLE = 4n;

const c = record.contracts;
const launchpad = (functionName: string) =>
  publicClient.readContract({ address: c.Launchpad, abi: artifact("Launchpad").abi, functionName, args: [] });

async function deploy(key: string, contract: string, args: unknown[]): Promise<Address> {
  if (c[key]) {
    console.log(`  = ${key} ${c[key]}`);
    return c[key];
  }
  const { abi, bytecode } = artifact(contract);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy ${key} failed: ${hash}`);
  c[key] = receipt.contractAddress;
  save();
  console.log(`  + ${key} ${receipt.contractAddress} (gas ${receipt.gasUsed})`);
  return receipt.contractAddress;
}

async function step(label: string, address: Address, abi: Abi, functionName: string, args: unknown[]) {
  if (record.steps.includes(label)) return;
  const hash = await wallet.writeContract({ address, abi, functionName, args } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  record.steps.push(label);
  save();
  console.log(`  ✓ ${label}`);
}

console.log(`studio on chain ${chainId} from ${account.address}`);
const [isAdmin, delay] = await publicClient.readContract({
  address: c.AccessManager,
  abi: AUTHORITY_ABI,
  functionName: "hasRole",
  args: [0n, account.address],
});
if (!isAdmin || delay !== 0) throw new Error("this key is not the authority's admin without delay");

const minLiquidity = (await launchpad("minLiquidity")) as bigint;
const implementation = await deploy("StudioToken", "StudioToken", [c.WCYBER]);
const studio = await deploy("TokenStudio", "TokenStudio", [
  c.AccessManager,
  c.PancakeV3Factory,
  c.NonfungiblePositionManager,
  c.WCYBER,
  c.LaunchLocker,
  c.Lending,
  c.OracleFactory,
  c.LiquidityVaultFactory,
  minLiquidity,
  implementation,
]);

const studioAbi = artifact("TokenStudio").abi;
await step("locker.setLauncher(studio)", c.LaunchLocker, artifact("LaunchLocker").abi, "setLauncher", [studio, true]);
await step("studio.setCredit", studio, studioAbi, "setCredit", [
  await launchpad("creditIrm"),
  await launchpad("creditLltv"),
  await launchpad("twapWindow"),
  await launchpad("twapMinWindow"),
]);
await step("studio.setObservationCardinality", studio, studioAbi, "setObservationCardinality", [
  await launchpad("observationCardinality"),
]);
await step(`grant ${LAUNCHPAD_ROLE} → ${studio}`, c.AccessManager, AUTHORITY_ABI, "grantRole", [
  LAUNCHPAD_ROLE,
  studio,
  0,
]);
await step("studio.setModules", studio, studioAbi, "setModules", [
  await launchpad("gauges"),
  zeroAddress,
  await launchpad("daos"),
]);
await step("studio.setRewardExclusions", studio, studioAbi, "setRewardExclusions", [
  await launchpad("rewardExclusions"),
]);

console.log(`TokenStudio ${studio}, floor ${minLiquidity / 10n ** 18n} CYBER`);
