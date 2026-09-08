/**
 * Deploy the Cyberia V3 concentrated-liquidity stack (PancakeSwap V3 fork, solc 0.7.6 / istanbul).
 *
 *   1. PancakeV3PoolDeployer   -- holds the pool creation code, CREATE2s every pool
 *   2. PancakeV3Factory        -- registry + the one admin surface (owner, fees, tiers)
 *   3. SwapRouter
 *   4. NonfungibleTokenPositionDescriptorOffChain  (+ initialize)
 *   5. NonfungiblePositionManager
 *   6. QuoterV2
 *   7. TickLens
 *   8. LaunchLocker + FeeSplitter
 *   9. LaunchpadV3          -- fair launches whose creator picks the fee (up to 10%, +1% protocol)
 *
 * Cyberia notes that this script exists to work around:
 *   - eth_estimateGas is unreliable here (it answers 21000 for a value transfer to a contract and
 *     fails outright on deploys), so every transaction carries an explicit gas limit;
 *   - the mempool has a ~1.5 gwei floor, so the node's own gasPrice is treated as a lower bound;
 *   - addresses are written to deployments/cyberia-v3.json after each step, so a failure halfway
 *     through leaves a record of what already exists instead of orphaning it;
 *   - a recompiled pool means a different CREATE2 init code hash, and therefore a different address
 *     for every pool the periphery can reach. The old core is then unreachable rather than wrong,
 *     so this script archives the previous record and redeploys the whole stack instead of mixing
 *     a new factory into old routers.
 *
 * Usage:
 *   npx hardhat compile
 *   npx tsx scripts/deploy-v3.ts
 *
 * To rehearse the whole run against a local node first, point CYBERIA_RPC_URL at it and set
 * CYBERIA_CHAIN_ID to that node's id (and V3_WCYBER at a wrapper deployed there). The record then
 * lands in deployments/cyberia-v3-<id>.json, so a rehearsal can never overwrite what is deployed
 * on Cyberia.
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getContractAddress,
  http,
  keccak256,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const DEPLOYER_PK = process.env.DEPLOYER_PK;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_PK not set in .env");

const account = privateKeyToAccount(
  (DEPLOYER_PK.startsWith("0x") ? DEPLOYER_PK : `0x${DEPLOYER_PK}`) as Hex,
);

const RPC_URL = process.env.CYBERIA_RPC_URL ?? "https://rpc.cyberia.church";
/// Cyberia's canonical wrapper. Overridable only so a rehearsal chain can deploy its own -- the
/// whole periphery is built around this address, and on Cyberia there is exactly one.
const WCYBER = (process.env.V3_WCYBER ?? "0x78272aAd03E4b9d7A9134e874BA6d419B534F6c9") as Hex;
const GAS_STATION = "0xA2134C165737Eff0775b163b73377E394004E7b2" as const;
const POSITION_BASE_URI = "https://cyberia.church/api/v3/positions/";

/// Where the non-creator share of a launch's fees goes, and who owns the two new contracts.
const TREASURY = (process.env.V3_TREASURY ?? "") as Hex;
/// A launch creator's share of their own pool's fees, in basis points. Retunable afterwards, and
/// applied only to launches locked after the change -- an existing one keeps what it was promised.
const CREATOR_BPS = Number(process.env.V3_CREATOR_BPS ?? 7000);
/// The tier every launch pool is born in: 10% for the creator plus the protocol's 1%. It is the
/// factory's ceiling too, so a launch can be tuned down afterwards and never up.
const LAUNCH_TIER = 110_000;
const LAUNCH_TIER_SPACING = 200;
/// The least CYBER a v3 launch may be paired with -- the same 10 the native v2 launchpad asks for.
const MIN_LIQUIDITY = BigInt(process.env.V3_MIN_LIQUIDITY ?? "10000000000000000000");

const CHAIN_ID = Number(process.env.CYBERIA_CHAIN_ID ?? 49406);

const chain = {
  ...mainnet,
  id: CHAIN_ID,
  name: CHAIN_ID === 49406 ? "Cyberia" : `Cyberia rehearsal (${CHAIN_ID})`,
  nativeCurrency: { name: "Cyber", symbol: "CYBER", decimals: 18 },
};

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const walletClient = createWalletClient({ chain, transport: http(RPC_URL), account });

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(
  ROOT,
  "deployments",
  CHAIN_ID === 49406 ? "cyberia-v3.json" : `cyberia-v3-${CHAIN_ID}.json`,
);

// Deploys measured locally: the largest is under 5.5M. A generous ceiling costs nothing --
// only gas actually burned is paid for -- and the block limit here is 30M.
const DEPLOY_GAS = 12_000_000n;
const CALL_GAS = 400_000n;
const MIN_GAS_PRICE = 1_500_000_000n; // the node's mempool floor

function artifact(name: string): { abi: Abi; bytecode: Hex } {
  const matches: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === `${name}.json`) matches.push(full);
    }
  };
  walk(path.join(ROOT, "artifacts", "contracts"));
  if (matches.length === 0) throw new Error(`artifact ${name} not found -- run: npx hardhat compile`);
  const json = JSON.parse(fs.readFileSync(matches[0], "utf8"));
  return { abi: json.abi as Abi, bytecode: json.bytecode as Hex };
}

type State = Record<string, unknown>;

function load(): State {
  return fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {};
}

function save(state: State) {
  fs.writeFileSync(OUT, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Put the previous stack beyond reuse before deploying a new one.
 *
 * Every address the periphery computes comes from the pool's init code hash, so a core that was
 * recompiled cannot be half-adopted: the old routers address pools the new factory will never
 * deploy. The record is moved aside (it still names the live-but-superseded contracts, which is
 * exactly what an operator needs when someone's liquidity is still in them) and the run starts
 * from an empty state, so `deploy()` finds nothing to skip.
 */
function archive(state: State): State {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(ROOT, "deployments", "archive");
  fs.mkdirSync(dir, { recursive: true });
  const to = path.join(dir, `${path.basename(OUT, ".json")}-${stamp}.json`);
  fs.writeFileSync(to, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`  superseded stack archived to ${path.relative(ROOT, to)}\n`);
  return {
    supersedes: {
      POOL_INIT_CODE_HASH: state.POOL_INIT_CODE_HASH,
      PancakeV3Factory: state.PancakeV3Factory,
      NonfungiblePositionManager: state.NonfungiblePositionManager,
      LaunchLocker: state.LaunchLocker,
      archivedAs: path.relative(ROOT, to),
    },
  };
}

async function gasPrice(): Promise<bigint> {
  const live = await publicClient.getGasPrice();
  const bumped = (live * 3n) / 2n;
  return bumped > MIN_GAS_PRICE ? bumped : MIN_GAS_PRICE;
}

async function alreadyThere(address: unknown): Promise<`0x${string}` | null> {
  if (typeof address !== "string" || !address.startsWith("0x")) return null;
  const code = await publicClient.getCode({ address: address as `0x${string}` });
  return code && code !== "0x" ? (address as `0x${string}`) : null;
}

let spent = 0n;

/** This node returns receipts with no effectiveGasPrice, so the price paid is inferred instead. */
function cost(receipt: { gasUsed: bigint; effectiveGasPrice?: bigint | null }): bigint {
  return receipt.gasUsed * (receipt.effectiveGasPrice ?? MIN_GAS_PRICE);
}

async function deploy(
  state: State,
  key: string,
  name: string,
  args: unknown[] = [],
): Promise<`0x${string}`> {
  const existing = await alreadyThere(state[key]);
  if (existing) {
    console.log(`  ${key.padEnd(34)} ${existing}  (already deployed)`);
    return existing;
  }

  const { abi, bytecode } = artifact(name);
  const hash = await walletClient.deployContract({
    abi,
    bytecode,
    args: args as never,
    gas: DEPLOY_GAS,
    gasPrice: await gasPrice(),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    throw new Error(`${name} deployment reverted (${hash})`);
  }
  state[key] = receipt.contractAddress;
  save(state);
  spent += cost(receipt);
  console.log(
    `  ${key.padEnd(34)} ${receipt.contractAddress}  ${receipt.gasUsed.toString().padStart(9)} gas`,
  );
  return receipt.contractAddress;
}

async function send(
  label: string,
  to: `0x${string}`,
  abi: Abi,
  functionName: string,
  args: unknown[],
) {
  const hash = await walletClient.writeContract({
    address: to,
    abi,
    functionName,
    args: args as never,
    gas: CALL_GAS,
    gasPrice: await gasPrice(),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  spent += cost(receipt);
  console.log(`  ${label.padEnd(34)} ok  ${receipt.gasUsed.toString().padStart(9)} gas`);
}

async function main() {
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Cyberia V3 deployment`);
  console.log(`  deployer   ${account.address}  ${(Number(balance) / 1e18).toFixed(4)} CYBER`);
  console.log(`  rpc        ${RPC_URL}`);
  console.log(`  gasPrice   ${(Number(await gasPrice()) / 1e9).toFixed(3)} gwei\n`);

  let state = load();
  state.chainId = CHAIN_ID;
  state.chainName = chain.name;
  state.rpc = RPC_URL;
  state.deployer = account.address;
  state.WCYBER = WCYBER;

  // The pool's creation code hash is what the periphery derives every pool address from. If the
  // vendored pool has been recompiled without updating PoolAddress.sol, every router call would
  // reach an address with nothing at it -- so it is checked here, before anything is deployed.
  const pool = artifact("PancakeV3Pool");
  const initCodeHash = keccak256(pool.bytecode);
  const poolAddressSource = fs.readFileSync(
    path.join(ROOT, "contracts", "pancake-v3-periphery", "libraries", "PoolAddress.sol"),
    "utf8",
  );
  if (!poolAddressSource.includes(initCodeHash)) {
    throw new Error(
      `POOL_INIT_CODE_HASH in PoolAddress.sol does not match the compiled pool (${initCodeHash}).\n` +
        `Update the constant and recompile, or the periphery will address pools that do not exist.`,
    );
  }
  console.log(`  init code hash ${initCodeHash}  (matches PoolAddress.sol)`);
  if (state.POOL_INIT_CODE_HASH && state.POOL_INIT_CODE_HASH !== initCodeHash) {
    console.log(`  previous hash  ${state.POOL_INIT_CODE_HASH}  -- the recorded core is superseded`);
    state = archive(state);
    state.chainId = CHAIN_ID;
    state.chainName = chain.name;
    state.rpc = RPC_URL;
    state.deployer = account.address;
    state.WCYBER = WCYBER;
  }
  state.POOL_INIT_CODE_HASH = initCodeHash;
  console.log();

  const poolDeployer = await deploy(state, "PancakeV3PoolDeployer", "PancakeV3PoolDeployer");
  const factory = await deploy(state, "PancakeV3Factory", "PancakeV3Factory", [poolDeployer]);

  const deployerAbi = artifact("PancakeV3PoolDeployer").abi;
  const wired = (await publicClient.readContract({
    address: poolDeployer,
    abi: deployerAbi,
    functionName: "factoryAddress",
  })) as `0x${string}`;
  if (wired === "0x0000000000000000000000000000000000000000") {
    await send("poolDeployer.setFactoryAddress", poolDeployer, deployerAbi, "setFactoryAddress", [
      factory,
    ]);
  } else if (wired.toLowerCase() !== factory.toLowerCase()) {
    // setFactoryAddress is one-shot; a mismatch means this deployer belongs to another factory.
    throw new Error(`poolDeployer is already bound to factory ${wired}, not ${factory}`);
  }

  // The launch tier. Upstream ships four (0.01/0.05/0.25/1%); a launch pool is born in a fifth so
  // that a creator asking for 10% has a tier to be born in at all -- `setPoolFeeByCreator` only
  // ever lowers, so the tier is the ceiling and every launch starts at it.
  const factoryAbiEarly = artifact("PancakeV3Factory").abi;
  const launchSpacing = Number(
    await publicClient.readContract({
      address: factory,
      abi: factoryAbiEarly,
      functionName: "feeAmountTickSpacing",
      args: [LAUNCH_TIER],
    }),
  );
  if (launchSpacing === 0) {
    await send("factory.enableFeeAmount(11%)", factory, factoryAbiEarly, "enableFeeAmount", [
      LAUNCH_TIER,
      LAUNCH_TIER_SPACING,
    ]);
  } else if (launchSpacing !== LAUNCH_TIER_SPACING) {
    // enableFeeAmount is one-shot per tier: a wrong spacing cannot be corrected, only worked around.
    throw new Error(`the ${LAUNCH_TIER} tier already exists with tick spacing ${launchSpacing}`);
  }

  await deploy(state, "SwapRouter", "SwapRouter", [poolDeployer, factory, WCYBER]);

  const descriptor = await deploy(
    state,
    "NonfungibleTokenPositionDescriptor",
    "NonfungibleTokenPositionDescriptorOffChain",
  );
  const descriptorAbi = artifact("NonfungibleTokenPositionDescriptorOffChain").abi;
  if (!state.positionBaseURI) {
    await send("descriptor.initialize", descriptor, descriptorAbi, "initialize", [
      POSITION_BASE_URI,
    ]);
    state.positionBaseURI = POSITION_BASE_URI;
    save(state);
  }

  await deploy(state, "NonfungiblePositionManager", "NonfungiblePositionManager", [
    poolDeployer,
    factory,
    WCYBER,
    descriptor,
  ]);
  await deploy(state, "QuoterV2", "QuoterV2", [poolDeployer, factory, WCYBER]);
  await deploy(state, "TickLens", "TickLens");

  // The treasury defaults to the deployer, which is what every other contract in this repo does.
  const treasury = (TREASURY || account.address) as Hex;
  const locker = await deploy(state, "LaunchLocker", "LaunchLocker", [
    state.NonfungiblePositionManager,
    treasury,
    CREATOR_BPS,
  ]);
  state.launchCreatorBps = CREATOR_BPS;
  state.treasury = treasury;

  const launchpad = await deploy(state, "LaunchpadV3", "LaunchpadV3", [
    factory,
    state.NonfungiblePositionManager,
    WCYBER,
    locker,
    MIN_LIQUIDITY,
  ]);
  state.minLiquidity = MIN_LIQUIDITY.toString();

  // The locker takes a launch's own split -- creator, holders, treasury -- only from an operator it
  // was told to trust, because that split names the treasury's own share. Anyone else locking a
  // position gets the default terms and cannot write its own.
  const lockerAbi = artifact("LaunchLocker").abi;
  const isLauncher = (await publicClient.readContract({
    address: locker,
    abi: lockerAbi,
    functionName: "launchers",
    args: [launchpad],
  })) as boolean;
  if (!isLauncher) {
    await send("locker.setLauncher(launchpad)", locker, lockerAbi, "setLauncher", [launchpad, true]);
  }

  // The protocol fee is zero on every pool for now, so the splitter receives nothing yet and its
  // weights cost nothing to change later. The tank is the first honest destination: a fee that
  // pays for other people's gas is the one that makes the chain usable for somebody holding a
  // token and no coin. A buy-back contract, once written, becomes a recipient beside it.
  await deploy(state, "FeeSplitter", "FeeSplitter", [
    WCYBER,
    [{ recipient: GAS_STATION, weight: 10000 }],
  ]);
  state.feeSplitterShares = [{ recipient: GAS_STATION, weight: 10000, what: "gas station tank" }];

  const factoryAbi = artifact("PancakeV3Factory").abi;
  const owner = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "owner",
  })) as string;
  const maxPoolFee = (await publicClient.readContract({
    address: factory,
    abi: factoryAbi,
    functionName: "MAX_POOL_FEE",
  })) as number;

  const tiers: Record<string, number> = {};
  for (const fee of [100, 500, 2500, 10000, LAUNCH_TIER]) {
    tiers[String(fee)] = Number(
      await publicClient.readContract({
        address: factory,
        abi: factoryAbi,
        functionName: "feeAmountTickSpacing",
        args: [fee],
      }),
    );
  }

  state.factoryOwner = owner;
  state.MAX_POOL_FEE = maxPoolFee;
  state.feeTiers = tiers;
  state.timestamp = new Date().toISOString();
  save(state);

  console.log(`\n  factory owner   ${owner}`);
  console.log(`  MAX_POOL_FEE    ${maxPoolFee} (${maxPoolFee / 10_000}%)`);
  console.log(`  fee tiers       ${Object.entries(tiers).map(([f, t]) => `${Number(f) / 10_000}%/ts${t}`).join("  ")}`);
  console.log(`  launchpad       ${launchpad}  (min ${Number(MIN_LIQUIDITY) / 1e18} CYBER)`);
  console.log(`\n  spent ${(Number(spent) / 1e18).toFixed(6)} CYBER`);
  console.log(`  written ${path.relative(ROOT, OUT)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
