/**
 * Write Cyberia's L1 genesis (Subnet-EVM), or check one.
 *
 *   node scripts/genesis.ts --network fuji|mainnet --remote-deployer 0x… --operator 0x… --fee-admin 0x… \
 *       [--remote-gas 100] [--operator-gas 10000] [--alloc allocations.json] [--min-base-fee <wei>] \
 *       --out genesis.json
 *   node scripts/genesis.ts --check genesis.json --remote-deployer 0x…
 *
 *   node scripts/genesis.ts --network mainnet --fixed-supply 1000000 --subnet-id <cb58> \
 *       --safe-owners 0x…,0x…,0x… --threshold 2 --operator 0x… --operator-gas 1000 --fee-admin 0x… \
 *       --transfer-fee 10 --out genesis.json
 *   node scripts/genesis.ts --check genesis.json --fixed-supply 1000000
 *
 * **Fixed supply (mainnet, the operator's call of 2026-11-23).** CYBER.sol reached Ethereum through
 * Wormhole (0x16EcD5995bC2d934F3Cb98fe79c0BE36a4EC05e9), which does not reach this chain, so there is
 * no NativeTokenRemote to mint: genesis creates the whole supply -- the operator's gas and the rest to
 * the DAO Safe, at the address validator-manager.ts will give it (lib/safe.ts) -- and the NativeMinter
 * stays off, so no key can create more. The DAO holds as many CYBER.sol on Ethereum as backing.
 * Everything below about the remote applies to the bridged layout only.
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
 *     and nobody can point them at a fixed address in genesis. They are the validators' income for
 *     now; RewardManager's admin, the fee admin (a Safe on mainnet), can send them elsewhere later.
 *   - **Minimal fees.** The minimum base fee is 1 wei: a transfer costs 21,000 wei of CYBER.
 *     FeeManager's admin can raise it (scripts/fee-config.ts) if the chain ever needs rationing.
 *   - **Old 49406 transactions are not blocked** (the operator's call, 2026-10-21: minimal fees
 *     matter more). Mainnet reuses the old chain id and nonces start again at 0, so a transaction
 *     signed for the old chain is valid here once its sender holds coins and reaches its nonce.
 *     Every project role gets a new key; a key that used the old chain should hold nothing here.
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
import { predictSafe, safeSalt } from "./lib/safe.ts";
import type { Predeploy } from "./predeploys.ts";
import { id32 } from "./validator-manager.ts";

export const CHAIN_IDS = { mainnet: 49406, fuji: 49407 } as const;

/** The lowest base fee there is: the transaction pool takes nothing below 1 wei of gas price. */
export const DEFAULT_MIN_BASE_FEE_WEI = 1n;
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

/** Which supply a genesis is checked against: minted by the bridge's remote, or fixed at genesis. */
export type Supply = { remoteDeployer: Address } | { fixedSupply: bigint };

/**
 * Every rule above, as checks. Returns the genesis' total balance: for the bridged layout the remote's
 * initialReserveImbalance; for a fixed supply, the supply itself.
 */
export function check(genesis: Genesis, supply: Supply): bigint {
  const config = genesis.config ?? {};
  const fail = (message: string): never => {
    throw new Error(`genesis: ${message}`);
  };

  const chainId = Number(config.chainId);
  if (!Object.values(CHAIN_IDS).includes(chainId as never)) fail(`chainId ${chainId} is neither mainnet nor fuji`);

  const minter = config[NATIVE_MINTER];
  if ("fixedSupply" in supply) {
    if (minter) fail("the NativeMinter is on: a fixed supply must have no way to mint");
  } else {
    const remote = predictRemote(supply.remoteDeployer);
    if (!minter) fail("the NativeMinter is off: NativeTokenRemote could not mint");
    const enabled: string[] = minter.enabledAddresses ?? [];
    if (enabled.length !== 1 || getAddress(enabled[0]) !== remote) {
      fail(`the NativeMinter must enable exactly the remote ${remote}, not [${enabled.join(", ")}]`);
    }
    if ((minter.adminAddresses ?? []).length || (minter.managerAddresses ?? []).length) {
      fail("the NativeMinter has an admin or manager who could enable another minter");
    }
    if (minter.initialMint && Object.keys(minter.initialMint).length) fail("the NativeMinter mints at genesis");
  }

  const rewards = config.rewardManagerConfig;
  if (!rewards || rewards.initialRewardConfig?.allowFeeRecipients !== true || rewards.initialRewardConfig?.rewardAddress) {
    fail("fees must go to the validators who produce the blocks (RewardManager with allowFeeRecipients)");
  }
  if (config.allowFeeRecipients !== true) fail("allowFeeRecipients must agree with the RewardManager");

  const fees = config.feeConfig ?? {};
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
  if ("fixedSupply" in supply && total !== supply.fixedSupply) {
    fail(`genesis holds ${total} wei, not the fixed supply ${supply.fixedSupply}`);
  }
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
  operator: Address;
  feeAdmin: Address;
  operatorGas: bigint;
  /** Bridged layout: NativeTokenRemote's deployer and its gas. */
  remoteDeployer?: Address;
  remoteGas?: bigint;
  /** Fixed supply: the operator's gas, and the rest of `supply` to the DAO Safe. No minter. */
  fixed?: { supply: bigint; safe: Address };
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

  if (options.fixed) {
    if (options.remoteDeployer) throw new Error("a fixed supply has no remote");
    if (options.operatorGas > options.fixed.supply) throw new Error("the operator's gas exceeds the supply");
    credit(options.operator, options.operatorGas);
    credit(options.fixed.safe, options.fixed.supply - options.operatorGas);
  } else {
    if (!options.remoteDeployer) throw new Error("the bridged layout needs the remote's deployer");
    credit(options.remoteDeployer, options.remoteGas ?? 0n);
    credit(options.operator, options.operatorGas);
  }
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
      ...(options.fixed ? {} : { [NATIVE_MINTER]: { blockTimestamp: 0, enabledAddresses: [predictRemote(options.remoteDeployer!)] } }),
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

/** The base fee at which a plain transfer (21,000 gas) costs at least `cyber` CYBER. */
export function baseFeeForTransfer(cyber: string): bigint {
  const wei = parseEther(cyber);
  return (wei + 20_999n) / 21_000n;
}

function main(): void {
  const checkPath = arg("check", "");
  const fixedSupply = arg("fixed-supply", "");
  const supply: Supply = fixedSupply
    ? { fixedSupply: parseEther(fixedSupply) }
    : { remoteDeployer: getAddress(arg("remote-deployer")) };

  if (checkPath) {
    const total = check(JSON.parse(fs.readFileSync(checkPath, "utf8")), supply);
    console.log(`${checkPath} passes; ${cyber(total)} CYBER at genesis (${total} wei)`);
    return;
  }

  const network = arg("network") as GenesisOptions["network"];
  if (!(network in CHAIN_IDS)) throw new Error(`--network must be one of ${Object.keys(CHAIN_IDS).join(", ")}`);
  const allocPath = arg("alloc", "");
  const transferFee = arg("transfer-fee", "");
  const minBaseFee = transferFee ? baseFeeForTransfer(transferFee) : arg("min-base-fee", "") ? BigInt(arg("min-base-fee")) : undefined;

  let fixed: GenesisOptions["fixed"];
  if ("fixedSupply" in supply) {
    if (allocPath) throw new Error("a fixed supply goes to the operator and the Safe only; --alloc is for the bridged layout");
    const owners = arg("safe-owners").split(",").map((a) => getAddress(a.trim()));
    const threshold = BigInt(arg("threshold"));
    if (threshold < 1n || threshold > BigInt(owners.length)) throw new Error("--threshold must be between 1 and the owner count");
    const subnetID = id32(arg("subnet-id"));
    fixed = { supply: supply.fixedSupply, safe: predictSafe(owners, threshold, safeSalt(subnetID)) };
  }

  const genesis = build({
    network,
    remoteDeployer: "remoteDeployer" in supply ? supply.remoteDeployer : undefined,
    operator: getAddress(arg("operator")),
    feeAdmin: getAddress(arg("fee-admin")),
    // Gas only, and owed collateral: at a minimal base fee this lasts practically forever, and even at
    // 10¹² wei the remote's two deployments take a few CYBER and the whole protocol a few hundred.
    remoteGas: parseEther(arg("remote-gas", "100")),
    operatorGas: parseEther(arg("operator-gas", "10000")),
    allocations: allocPath ? JSON.parse(fs.readFileSync(allocPath, "utf8")) : undefined,
    minBaseFee,
    fixed,
  });
  const total = check(genesis, supply);

  const output = arg("out");
  fs.writeFileSync(output, JSON.stringify(genesis, null, 2) + "\n");
  const fee = BigInt(genesis.config.feeConfig.minBaseFee);
  console.log(`chain id          ${genesis.config.chainId} (${network})`);
  if (fixed) {
    console.log(`NativeMinter      off: ${cyber(total)} CYBER, fixed`);
    console.log(`DAO Safe          ${fixed.safe}: ${cyber(fixed.supply - parseEther(arg("operator-gas", "10000")))} CYBER`);
    console.log(`operator          ${getAddress(arg("operator"))}: ${arg("operator-gas", "10000")} CYBER`);
  } else {
    const remoteDeployer = (supply as { remoteDeployer: Address }).remoteDeployer;
    console.log(`NativeMinter      only ${predictRemote(remoteDeployer)}: ${remoteDeployer}'s nonce-1 contract`);
    console.log(`genesis CYBER     ${cyber(total)} = NativeTokenRemote initialReserveImbalance ${total} wei`);
  }
  console.log(`min base fee      ${fee} wei (a transfer: ${cyber(fee * 21_000n)} CYBER)`);
  console.log(`fee admin         ${genesis.config.feeManagerConfig.adminAddresses[0]}`);
  console.log(`fees              to each block producer's feeRecipient`);
  console.log(`block gas limit   ${genesis.config.feeConfig.gasLimit}`);
  console.log(`wrote ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
