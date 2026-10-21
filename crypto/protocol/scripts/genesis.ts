/**
 * Write Cyberia's L1 genesis (Subnet-EVM), or check one.
 *
 *   node scripts/genesis.ts --network fuji|mainnet --remote-deployer 0x… --operator 0x… --fee-admin 0x… \
 *       [--remote-gas 100000] [--operator-gas 1000000] [--alloc allocations.json] [--min-base-fee <wei>] \
 *       --out genesis.json
 *   node scripts/genesis.ts --check genesis.json --remote-deployer 0x…
 *
 * CYBER is CYBER.sol brought over from Solana, one for one: Wormhole NTT locks it on Solana and mints
 * it on the C-Chain, and ICTT locks that in an ERC20TokenHome and mints the same amount here as the
 * native coin, through Ava Labs' NativeTokenRemote. Genesis is where the rules that keep this honest
 * become properties of the chain:
 *
 *   - **Only NativeTokenRemote mints.** The NativeMinter precompile is on with exactly one enabled
 *     address -- the remote's proxy, which `--remote-deployer` creates as its second transaction
 *     (nonce 0: the implementation, nonce 1: the proxy) -- and no admin or manager who could add
 *     another. That key must send nothing else before.
 *   - **Every genesis coin is owed collateral.** The balances here (gas for the remote's deployer
 *     and for the operator, plus any `--alloc`) exist before anything is locked on the C-Chain.
 *     Their sum is NativeTokenRemote's `initialReserveImbalance`; the home refuses to bridge to
 *     this chain until that much is deposited as collateral.
 *   - **Fees pay the validators.** RewardManager starts with fee recipients allowed: each block's
 *     fees go to the validator that produced it (its node's `feeRecipient`; burned if it sets none),
 *     and nobody can point them at a fixed address in genesis. They stay small (see
 *     REPLAY_FLOOR_WEI) and are the validators' income for now; RewardManager's admin, the fee admin
 *     (a Safe on mainnet), can send them elsewhere later.
 *   - **No replay of the old chain.** Mainnet reuses chain id 49406, so every transaction ever
 *     signed for the old chain carries a valid chain id here, and every account starts again at
 *     nonce 0. The minimum base fee is kept far above any gas price the old chain accepted, which
 *     makes all of them invalid.
 *   - **Warp** is on and needs Primary Network signatures for C-Chain messages: this chain's own
 *     validators cannot vouch for what happened on the C-Chain. It activates at the genesis
 *     timestamp: Subnet-EVM refuses to start a chain whose Warp predates Durango, and a timestamp
 *     of 0 does.
 *   - **Predeploys** at their usual addresses: Safe 1.4.1, TeleporterMessenger v1.0.0 (see
 *     predeploys.ts), Multicall3, the deterministic CREATE2 deployer and WCYBER. Presigned deployments
 *     cannot run here because of the base fee, so they have to be in genesis.
 *   - **Gas:** a launch with its whole kit takes about 12M gas, so a block limit under 15M is refused.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAddress, getContractAddress, keccak256, parseEther, toHex, type Address, type Hex } from "viem";

import { CREATE2_DEPLOYER, CREATE2_DEPLOYER_CODE, ROOT } from "./lib/create2.ts";
import type { Predeploy } from "./predeploys.ts";

export const CHAIN_IDS = { mainnet: 49406, fuji: 49407 } as const;

/**
 * The highest gas price seen on the old 49406 chain was 1.875 gwei (sampled from its explorer).
 * The floor leaves about 500 times that on top, and it is also the default minimum base fee: fees
 * are meant to be small (a transfer costs 0.021 CYBER). FeeManager's admin can raise them later
 * (scripts/fee-config.ts), never below the floor.
 */
export const REPLAY_FLOOR_WEI = 1_000_000_000_000n;
export const DEFAULT_MIN_BASE_FEE_WEI = REPLAY_FLOOR_WEI;
export const MIN_GAS_LIMIT = 15_000_000;
/** Durango activation (avalanchego upgrade/upgrade.go): Warp may not activate before it. */
export const DURANGO = { mainnet: 1_709_740_800, fuji: 1_707_840_000 } as const;
export const WCYBER: Address = "0x000000000000000000000000000000000000C0FE";
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const NATIVE_MINTER = "contractNativeMinterConfig";

/** The NativeTokenRemote proxy: `remoteDeployer`'s second contract (its first is the implementation). */
export function predictRemote(remoteDeployer: Address): Address {
  return getContractAddress({ opcode: "CREATE", from: remoteDeployer, nonce: 1n });
}

type Genesis = { config: Record<string, any>; alloc: Record<string, any>; [key: string]: unknown };

const key = (address: Address) => address.toLowerCase().replace(/^0x/, "");

/** Every rule above, as checks. Returns the genesis' total balance: the remote's initialReserveImbalance. */
export function check(genesis: Genesis, remoteDeployer: Address): bigint {
  const config = genesis.config ?? {};
  const fail = (message: string): never => {
    throw new Error(`genesis: ${message}`);
  };

  const chainId = Number(config.chainId);
  if (!Object.values(CHAIN_IDS).includes(chainId as never)) fail(`chainId ${chainId} is neither mainnet nor fuji`);

  const minter = config[NATIVE_MINTER];
  const remote = predictRemote(remoteDeployer);
  if (!minter) fail("the NativeMinter is off: NativeTokenRemote could not mint");
  const enabled: string[] = minter.enabledAddresses ?? [];
  if (enabled.length !== 1 || getAddress(enabled[0]) !== remote) {
    fail(`the NativeMinter must enable exactly the remote ${remote}, not [${enabled.join(", ")}]`);
  }
  if ((minter.adminAddresses ?? []).length || (minter.managerAddresses ?? []).length) {
    fail("the NativeMinter has an admin or manager who could enable another minter");
  }
  if (minter.initialMint && Object.keys(minter.initialMint).length) fail("the NativeMinter mints at genesis");

  const rewards = config.rewardManagerConfig;
  if (!rewards || rewards.initialRewardConfig?.allowFeeRecipients !== true || rewards.initialRewardConfig?.rewardAddress) {
    fail("fees must go to the validators who produce the blocks (RewardManager with allowFeeRecipients)");
  }
  if (config.allowFeeRecipients !== true) fail("allowFeeRecipients must agree with the RewardManager");

  const fees = config.feeConfig ?? {};
  if (BigInt(fees.minBaseFee ?? 0) < REPLAY_FLOOR_WEI) {
    fail(`minBaseFee ${fees.minBaseFee} is below the replay floor ${REPLAY_FLOOR_WEI}: old 49406 transactions would be valid`);
  }
  const gasLimit = Number(fees.gasLimit ?? 0);
  if (gasLimit < MIN_GAS_LIMIT) fail(`feeConfig.gasLimit ${gasLimit} is below ${MIN_GAS_LIMIT}: a full-kit launch would not fit`);
  if (BigInt(String(genesis.gasLimit ?? "0")) !== BigInt(gasLimit)) fail("the header gasLimit differs from feeConfig.gasLimit");

  if (!config.warpConfig) fail("Warp is off: no ICM, so no ICTT");
  if (config.warpConfig.requirePrimaryNetworkSigners !== true) {
    fail("Warp must require Primary Network signers for C-Chain messages");
  }
  const network = chainId === CHAIN_IDS.mainnet ? "mainnet" : "fuji";
  const warpAt = Number(config.warpConfig.blockTimestamp ?? 0);
  if (warpAt < DURANGO[network] || warpAt > Number(genesis.timestamp)) {
    fail(`Warp activates at ${warpAt}: it must be between Durango (${DURANGO[network]}) and the genesis timestamp`);
  }

  for (const predeploy of loadPredeploys()) {
    const entry = genesis.alloc[key(predeploy.address)];
    if (!entry || (entry.code ?? "0x") !== predeploy.code) fail(`${predeploy.name} is missing at ${predeploy.address}`);
  }

  let total = 0n;
  for (const entry of Object.values(genesis.alloc)) total += BigInt(entry.balance ?? "0x0");
  return total;
}

export function loadPredeploys(): Predeploy[] {
  const predeploys: Predeploy[] = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/lib/predeploys.json"), "utf8"));
  for (const p of predeploys) {
    if (keccak256(p.code) !== p.codeHash) throw new Error(`predeploys.json: ${p.name}'s code does not match its hash`);
  }
  return predeploys;
}

function runtime(name: string, file: string): Hex {
  const artifact = path.join(ROOT, "artifacts", file, `${name}.json`);
  if (!fs.existsSync(artifact)) throw new Error(`missing ${artifact}; run npx hardhat build`);
  return JSON.parse(fs.readFileSync(artifact, "utf8")).deployedBytecode;
}

export type GenesisOptions = {
  network: keyof typeof CHAIN_IDS;
  remoteDeployer: Address;
  operator: Address;
  feeAdmin: Address;
  remoteGas: bigint;
  operatorGas: bigint;
  allocations?: Record<string, string>;
  minBaseFee?: bigint;
  gasLimit?: number;
  timestamp?: number;
};

export function build(options: GenesisOptions): Genesis {
  const gasLimit = options.gasLimit ?? 20_000_000;
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const minBaseFee = options.minBaseFee ?? DEFAULT_MIN_BASE_FEE_WEI;
  if (minBaseFee > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("minBaseFee does not fit a JSON number exactly");
  const alloc: Genesis["alloc"] = {};
  const credit = (address: Address, wei: bigint) => {
    const current = BigInt(alloc[key(address)]?.balance ?? "0x0");
    alloc[key(address)] = { ...(alloc[key(address)] ?? {}), balance: toHex(current + wei) };
  };

  credit(options.remoteDeployer, options.remoteGas);
  credit(options.operator, options.operatorGas);
  for (const [address, cyber] of Object.entries(options.allocations ?? {})) credit(getAddress(address), parseEther(cyber));

  const place = (address: Address, entry: { code: Hex; storage?: Record<string, Hex>; nonce?: number }) => {
    alloc[key(address)] = { balance: "0x0", ...(alloc[key(address)] ?? {}), ...entry };
  };
  for (const p of loadPredeploys()) {
    place(p.address, { code: p.code, ...(p.storage ? { storage: p.storage } : {}), ...(p.nonce ? { nonce: p.nonce } : {}) });
  }
  place(MULTICALL3, { code: runtime("Multicall3", "contracts/vendor/multicall/Multicall3.sol") });
  place(CREATE2_DEPLOYER, { code: CREATE2_DEPLOYER_CODE });
  place(WCYBER, { code: runtime("WCYBER", "contracts/tokens/WCYBER.sol") });

  return {
    config: {
      chainId: CHAIN_IDS[options.network],
      feeConfig: {
        gasLimit,
        minBaseFee: Number(minBaseFee),
        targetGas: 60_000_000,
        baseFeeChangeDenominator: 36,
        minBlockGasCost: 0,
        maxBlockGasCost: 1_000_000,
        targetBlockRate: 2,
        blockGasCostStep: 200_000,
      },
      allowFeeRecipients: true,
      warpConfig: { blockTimestamp: timestamp, quorumNumerator: 67, requirePrimaryNetworkSigners: true },
      [NATIVE_MINTER]: { blockTimestamp: 0, enabledAddresses: [predictRemote(options.remoteDeployer)] },
      feeManagerConfig: { blockTimestamp: 0, adminAddresses: [options.feeAdmin] },
      rewardManagerConfig: {
        blockTimestamp: 0,
        adminAddresses: [options.feeAdmin],
        initialRewardConfig: { allowFeeRecipients: true },
      },
    },
    alloc,
    nonce: "0x0",
    timestamp: toHex(timestamp),
    extraData: "0x",
    gasLimit: toHex(gasLimit),
    difficulty: "0x0",
    mixHash: `0x${"0".repeat(64)}`,
    coinbase: `0x${"0".repeat(40)}`,
    number: "0x0",
    gasUsed: "0x0",
    parentHash: `0x${"0".repeat(64)}`,
  };
}

const cyber = (wei: bigint) => (Number(wei / 10n ** 14n) / 1e4).toLocaleString("en-US");

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing --${name}`);
}

function main(): void {
  const remoteDeployer = getAddress(arg("remote-deployer"));
  const checkPath = arg("check", "");

  if (checkPath) {
    const total = check(JSON.parse(fs.readFileSync(checkPath, "utf8")), remoteDeployer);
    console.log(`${checkPath} passes; initialReserveImbalance ${total} wei (${cyber(total)} CYBER)`);
    return;
  }

  const network = arg("network") as GenesisOptions["network"];
  if (!(network in CHAIN_IDS)) throw new Error(`--network must be one of ${Object.keys(CHAIN_IDS).join(", ")}`);
  const allocPath = arg("alloc", "");
  const minBaseFee = arg("min-base-fee", "");
  const genesis = build({
    network,
    remoteDeployer,
    operator: getAddress(arg("operator")),
    feeAdmin: getAddress(arg("fee-admin")),
    remoteGas: parseEther(arg("remote-gas", "100000")),
    operatorGas: parseEther(arg("operator-gas", "1000000")),
    allocations: allocPath ? JSON.parse(fs.readFileSync(allocPath, "utf8")) : undefined,
    minBaseFee: minBaseFee ? BigInt(minBaseFee) : undefined,
  });
  const total = check(genesis, remoteDeployer);

  const output = arg("out");
  fs.writeFileSync(output, JSON.stringify(genesis, null, 2) + "\n");
  console.log(`chain id          ${genesis.config.chainId} (${network})`);
  console.log(`NativeMinter      only ${predictRemote(remoteDeployer)}: ${remoteDeployer}'s nonce-1 contract`);
  console.log(`genesis CYBER     ${cyber(total)} = NativeTokenRemote initialReserveImbalance ${total} wei`);
  console.log(`min base fee      ${genesis.config.feeConfig.minBaseFee} wei (replay floor ${REPLAY_FLOOR_WEI})`);
  console.log(`fee admin         ${genesis.config.feeManagerConfig.adminAddresses[0]}`);
  console.log(`block gas limit   ${genesis.config.feeConfig.gasLimit}`);
  console.log(`wrote ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
