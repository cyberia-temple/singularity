/**
 * Deploy the whole Cyberia protocol to an Avalanche L1 (or any EVM chain), resumably.
 *
 *   node scripts/deploy.ts <config.json>
 *
 * Environment:
 *   RPC_URL       the chain's RPC endpoint
 *   DEPLOYER_PK   the deploying key (never commit it, never print it)
 *
 * Every address and every completed configuration step is written to
 * deployments/<chainId>.json as soon as it lands, so a run that fails halfway is simply run again:
 * what exists is reused and what was done is skipped.
 *
 * At the end the deployer still holds ADMIN unless the config says `renounceDeployer: true`; do
 * that once the multisig has checked it can schedule and execute admin calls itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getAbiItem,
  http,
  parseEther,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// -------------------------------------------------------------------------------------- roles

/** Mirrors contracts/access/Roles.sol. */
const ROLE = { ADMIN: 0n, GUARDIAN: 1n, OPERATOR: 2n, RELAYER: 3n, LAUNCHPAD: 4n, ARBITER: 5n } as const;

// ------------------------------------------------------------------------------------- config

type Config = {
  admin: Address;
  adminExecutionDelay: number;
  guardian: Address;
  operator: Address;
  relayer: Address;
  arbiter: Address;
  treasury: Address;
  wiredSigner: Address;
  /** A genesis-predeployed WCYBER, or null to deploy one */
  wcyber: Address | null;
  ash: { cap: string; initialSupply: string; initialHolder: Address; weekly: string; decayBps: number; treasuryBps: number };
  launch: { minLiquidity: string; creditLltv: string; twapWindow: number; twapMinWindow: number; cardinality: number };
  lltvs: string[];
  router: { treasuryWeight: number; gasStationWeight: number; votersBps: number };
  domains: { rootPrice: string; reserved: string[] };
  predictions: { createFee: string };
  nft: { feeBps: number };
  bridge: { refundDelay: number };
  land: { mintPrice: string; baseURI: string };
  badgesURI: string;
  positionsBaseURI: string;
  renounceDeployer: boolean;
};

const configPath = process.argv[2];
if (!configPath) throw new Error("usage: node scripts/deploy.ts <config.json>");
const config: Config = JSON.parse(fs.readFileSync(configPath, "utf8"));

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

// ------------------------------------------------------------------------------------- record

const RECORD_PATH = path.join(ROOT, "deployments", `${chainId}.json`);
type DeployRecord = { chainId: number; deployer: Address; contracts: Record<string, Address>; steps: string[] };
const record: DeployRecord = fs.existsSync(RECORD_PATH)
  ? JSON.parse(fs.readFileSync(RECORD_PATH, "utf8"))
  : { chainId, deployer: account.address, contracts: {}, steps: [] };

function save() {
  fs.mkdirSync(path.dirname(RECORD_PATH), { recursive: true });
  fs.writeFileSync(RECORD_PATH, JSON.stringify(record, null, 2) + "\n");
}

// ---------------------------------------------------------------------------------- artifacts

const artifactIndex = new Map<string, string>();
(function index(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) index(full);
    else if (entry.name.endsWith(".json") && !entry.name.endsWith(".dbg.json") && !full.includes("build-info")) {
      artifactIndex.set(entry.name.slice(0, -5), full);
    }
  }
})(path.join(ROOT, "artifacts"));

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const file = artifactIndex.get(name);
  if (!file) throw new Error(`no artifact for ${name}; run npx hardhat build`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// ------------------------------------------------------------------------------------ actions

async function deploy(key: string, contract: string, args: unknown[] = []): Promise<Address> {
  if (record.contracts[key]) {
    console.log(`  = ${key} ${record.contracts[key]}`);
    return record.contracts[key];
  }
  const { abi, bytecode } = artifact(contract);
  const hash = await wallet.deployContract({ abi, bytecode, args });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy ${key} failed: ${hash}`);
  record.contracts[key] = receipt.contractAddress;
  save();
  console.log(`  + ${key} ${receipt.contractAddress}`);
  return receipt.contractAddress;
}

async function read<T>(key: string, contract: string, functionName: string, args: unknown[] = []): Promise<T> {
  return (await publicClient.readContract({
    address: record.contracts[key],
    abi: artifact(contract).abi,
    functionName,
    args,
  })) as T;
}

/** A configuration call, done once: its label is recorded when it succeeds. */
async function step(label: string, key: string, contract: string, functionName: string, args: unknown[] = [], value = 0n) {
  if (record.steps.includes(label)) return;
  const hash = await wallet.writeContract({
    address: record.contracts[key],
    abi: artifact(contract).abi,
    functionName,
    args,
    value,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} failed: ${hash}`);
  record.steps.push(label);
  save();
  console.log(`  ✓ ${label}`);
}

function selectors(contract: string, names: string[]): Hex[] {
  const { abi } = artifact(contract);
  return names.map((name) => toFunctionSelector(getAbiItem({ abi, name }) as never));
}

const wad = (x: string) => parseEther(x);

// --------------------------------------------------------------------------------------- run

console.log(`deploying to chain ${chainId} from ${account.address}`);

// The authority every contract answers to. The deployer is its first admin, for setup only.
const manager = await deploy("AccessManager", "CyberiaAuthority", [account.address]);

// Wrapped CYBER: the genesis predeploy when there is one.
if (config.wcyber) record.contracts.WCYBER = config.wcyber;
const wcyber = await deploy("WCYBER", "WCYBER");

// --- DEX: the vendored V3, owned by the authority once configured
const poolDeployer = await deploy("PancakeV3PoolDeployer", "PancakeV3PoolDeployer");
const dexFactory = await deploy("PancakeV3Factory", "PancakeV3Factory", [poolDeployer]);
// Anyone could call this first on a fresh deployer; the check below catches it.
await step("poolDeployer.setFactoryAddress", "PancakeV3PoolDeployer", "PancakeV3PoolDeployer", "setFactoryAddress", [dexFactory]);
const boundFactory = await read<Address>("PancakeV3PoolDeployer", "PancakeV3PoolDeployer", "factoryAddress");
if (boundFactory.toLowerCase() !== dexFactory.toLowerCase()) {
  throw new Error(`pool deployer is bound to ${boundFactory}, not our factory: redeploy both`);
}
await step("factory.enableFeeAmount(11%)", "PancakeV3Factory", "PancakeV3Factory", "enableFeeAmount", [110_000, 200]);
const descriptor = await deploy("PositionDescriptor", "NonfungibleTokenPositionDescriptorOffChain", [config.positionsBaseURI]);
const positions = await deploy("NonfungiblePositionManager", "NonfungiblePositionManager", [
  poolDeployer,
  dexFactory,
  wcyber,
  descriptor,
]);
await deploy("SwapRouter", "SwapRouter", [poolDeployer, dexFactory, wcyber]);
await deploy("QuoterV2", "QuoterV2", [poolDeployer, dexFactory, wcyber]);
await deploy("TickLens", "TickLens");

// --- lending
const gasStation = await deploy("GasStation", "GasStation", [manager]);
const lending = await deploy("Lending", "Lending", [manager, config.treasury]);
const irm = await deploy("AdaptiveCurveIrm", "AdaptiveCurveIrm", [lending]);
await step("lending.enableIrm(adaptive)", "Lending", "Lending", "enableIrm", [irm]);
for (const lltv of config.lltvs) {
  await step(`lending.enableLltv(${lltv})`, "Lending", "Lending", "enableLltv", [wad(lltv)]);
}
const oracles = await deploy("OracleFactory", "OracleFactory");
const vaults = await deploy("LiquidityVaultFactory", "LiquidityVaultFactory", [dexFactory]);
await deploy("CreditVaultFactory", "CreditVaultFactory", [lending]);

// --- revenue
const router = await deploy("RevenueRouter", "RevenueRouter", [
  manager,
  dexFactory,
  positions,
  wcyber,
  lending,
  vaults,
  [
    { recipient: config.treasury, weight: config.router.treasuryWeight },
    { recipient: gasStation, weight: config.router.gasStationWeight },
  ],
]);
await step("lending.setFeeRecipient(router)", "Lending", "Lending", "setFeeRecipient", [router]);
await step("factory.setFeeCollector(router)", "PancakeV3Factory", "PancakeV3Factory", "setFeeCollector", [router]);

// --- launches
const locker = await deploy("LaunchLocker", "LaunchLocker", [manager, positions, router]);
const launchpad = await deploy("Launchpad", "Launchpad", [
  manager,
  dexFactory,
  positions,
  wcyber,
  locker,
  lending,
  oracles,
  vaults,
  wad(config.launch.minLiquidity),
]);
await step("locker.setLauncher(launchpad)", "LaunchLocker", "LaunchLocker", "setLauncher", [launchpad, true]);
await step("launchpad.setCredit", "Launchpad", "Launchpad", "setCredit", [
  irm,
  wad(config.launch.creditLltv),
  config.launch.twapWindow,
  config.launch.twapMinWindow,
]);
await step("launchpad.setObservationCardinality", "Launchpad", "Launchpad", "setObservationCardinality", [
  config.launch.cardinality,
]);

// --- ASH and its emission
const ash = await deploy("Ash", "Ash", [manager, wad(config.ash.cap), config.ash.initialHolder, wad(config.ash.initialSupply)]);
const ve = await deploy("VotingEscrow", "VotingEscrow", [ash]);
const voter = await deploy("Voter", "Voter", [manager, ve, router]);
const minter = await deploy("Minter", "Minter", [manager, ash, voter, config.ash.decayBps, config.treasury, config.ash.treasuryBps]);
await step("ash.setMinter", "Ash", "Ash", "setMinter", [minter]);
await step("voter.setMinter", "Voter", "Voter", "setMinter", [minter]);
await step("router.setModules", "RevenueRouter", "RevenueRouter", "setModules", [locker, voter]);
await step("router.setVotersBps", "RevenueRouter", "RevenueRouter", "setVotersBps", [config.router.votersBps]);

// --- identity and governance
const domains = await deploy("Domains", "Domains", [manager, launchpad, router, wad(config.domains.rootPrice)]);
if (config.domains.reserved.length > 0) {
  await step("domains.reserve", "Domains", "Domains", "reserve", [config.domains.reserved, true]);
}
await deploy("Badges", "Badges", [manager, config.badgesURI]);
const daos = await deploy("DAOFactory", "DAOFactory");
await step("launchpad.setModules", "Launchpad", "Launchpad", "setModules", [voter, domains, daos]);

// --- bridge
await deploy("BridgeGateway", "BridgeGateway", [manager]);
await step("bridge.setRefundDelay", "BridgeGateway", "BridgeGateway", "setRefundDelay", [config.bridge.refundDelay]);

// --- apps
await deploy("PredictionMarket", "PredictionMarket", [manager, router, wad(config.predictions.createFee)]);
await deploy("CyberiaNFT", "CyberiaNFT");
await deploy("NFTMarket", "NFTMarket", [manager, router, config.nft.feeBps]);
await deploy("CommunityTokenFactory", "CommunityTokenFactory");
await deploy("PixelBattle", "PixelBattle");
await deploy("WiredForge", "WiredForge", [manager, config.wiredSigner]);
await deploy("MinecraftLand", "MinecraftLand", [manager, wad(config.land.mintPrice), config.land.baseURI]);

// ------------------------------------------------------------------------------- permissions

const functionRoles: [string, string, string[], bigint][] = [
  ["BridgeGateway", "BridgeGateway", ["setPaused"], ROLE.GUARDIAN],
  ["Domains", "Domains", ["blockZone"], ROLE.GUARDIAN],
  ["Voter", "Voter", ["killGauge"], ROLE.GUARDIAN],
  ["GasStation", "GasStation", ["claim"], ROLE.OPERATOR],
  ["Domains", "Domains", ["registerFor"], ROLE.OPERATOR],
  ["Badges", "Badges", ["award", "awardBatch"], ROLE.OPERATOR],
  ["PredictionMarket", "PredictionMarket", ["createOperatorMarket", "resolveByOperator"], ROLE.OPERATOR],
  ["BridgeGateway", "BridgeGateway", ["release", "finalize", "refund"], ROLE.RELAYER],
  ["Voter", "Voter", ["createGauge"], ROLE.LAUNCHPAD],
  ["PredictionMarket", "PredictionMarket", ["arbitrate"], ROLE.ARBITER],
];
for (const [key, contract, names, role] of functionRoles) {
  await step(`roles: ${key}.${names.join(",")} → ${role}`, "AccessManager", "CyberiaAuthority", "setTargetFunctionRole", [
    record.contracts[key],
    selectors(contract, names),
    role,
  ]);
}

const labels: [bigint, string][] = [
  [ROLE.GUARDIAN, "GUARDIAN"],
  [ROLE.OPERATOR, "OPERATOR"],
  [ROLE.RELAYER, "RELAYER"],
  [ROLE.LAUNCHPAD, "LAUNCHPAD"],
  [ROLE.ARBITER, "ARBITER"],
];
for (const [role, label] of labels) {
  await step(`label ${label}`, "AccessManager", "CyberiaAuthority", "labelRole", [role, label]);
}

const grants: [bigint, Address, number][] = [
  [ROLE.GUARDIAN, config.guardian, 0],
  [ROLE.OPERATOR, config.operator, 0],
  [ROLE.RELAYER, config.relayer, 0],
  [ROLE.LAUNCHPAD, launchpad, 0],
  [ROLE.LAUNCHPAD, config.admin, config.adminExecutionDelay],
  [ROLE.ARBITER, config.arbiter, 0],
  [ROLE.ADMIN, config.admin, config.adminExecutionDelay],
];
for (const [role, who, delay] of grants) {
  await step(`grant ${role} → ${who}`, "AccessManager", "CyberiaAuthority", "grantRole", [role, who, delay]);
}

// The DEX factory predates AccessManager and has an owner; the authority becomes it, so its admin
// calls go through the same delayed path as everything else.
await step("factory.setOwner(authority)", "PancakeV3Factory", "PancakeV3Factory", "setOwner", [manager]);

if (config.renounceDeployer) {
  await step("deployer renounces ADMIN", "AccessManager", "CyberiaAuthority", "renounceRole", [ROLE.ADMIN, account.address]);
}

console.log(`\ndone: ${RECORD_PATH}`);
console.log("Not done here, on purpose:");
console.log("  - minter.start(weekly): starts the ASH schedule; an admin call, scheduled through the delay");
console.log("  - bridge assets (createWrapped / setAsset / setDestination): per corridor, by admin");
console.log("  - RewardManager precompile: point transaction fees at the RevenueRouter");
