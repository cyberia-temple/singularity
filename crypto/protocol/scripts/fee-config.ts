/**
 * Read or change the L1's fees through the FeeManager precompile, never below the replay floor.
 *
 *   node scripts/fee-config.ts                              # print the current config and base fee
 *   node scripts/fee-config.ts --minBaseFee <wei> [--<field> <value> …]   # change fields, keep the rest
 *
 * Environment: RPC_URL (the L1) and, to change anything, DEPLOYER_PK of an address on FeeManager's
 * allow list. When the key is not on it (on mainnet the admin is a Safe), the calldata is printed for
 * the Safe instead of sent.
 *
 * Fees are small on purpose: the chain has users to win before it has block space to ration. The
 * floor is genesis.ts's REPLAY_FLOOR_WEI: below it, transactions signed for the old chain 49406 would
 * be valid here again.
 *
 * A lower minimum does not lower the base fee at once: it falls by at most 1/baseFeeChangeDenominator
 * per block, however long the chain was idle (36 by default: a few hundred blocks for a big cut). To get
 * there in a dozen blocks, set --baseFeeChangeDenominator 2 for that time and put it back after.
 */

import * as path from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { REPLAY_FLOOR_WEI } from "./genesis.ts";

const FEE_MANAGER = "0x0200000000000000000000000000000000000003";
const FEE_MANAGER_ABI = parseAbi([
  "function getFeeConfig() view returns (uint256 gasLimit, uint256 targetBlockRate, uint256 minBaseFee, uint256 targetGas, uint256 baseFeeChangeDenominator, uint256 minBlockGasCost, uint256 maxBlockGasCost, uint256 blockGasCostStep)",
  "function getFeeConfigLastChangedAt() view returns (uint256)",
  "function setFeeConfig(uint256 gasLimit, uint256 targetBlockRate, uint256 minBaseFee, uint256 targetGas, uint256 baseFeeChangeDenominator, uint256 minBlockGasCost, uint256 maxBlockGasCost, uint256 blockGasCostStep)",
  "function readAllowList(address addr) view returns (uint256)",
]);
const FIELDS = [
  "gasLimit",
  "targetBlockRate",
  "minBaseFee",
  "targetGas",
  "baseFeeChangeDenominator",
  "minBlockGasCost",
  "maxBlockGasCost",
  "blockGasCostStep",
] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const RPC_URL = process.env.RPC_URL;
  if (!RPC_URL) throw new Error("RPC_URL must be set");
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ transport });
  const chainId = await publicClient.getChainId();

  const show = async () => {
    const config = await publicClient.readContract({ address: FEE_MANAGER, abi: FEE_MANAGER_ABI, functionName: "getFeeConfig" });
    const changedAt = await publicClient.readContract({ address: FEE_MANAGER, abi: FEE_MANAGER_ABI, functionName: "getFeeConfigLastChangedAt" });
    const block = await publicClient.getBlock();
    FIELDS.forEach((field, i) => console.log(`  ${field.padEnd(25)} ${config[i]}`));
    console.log(`  last changed at block      ${changedAt}`);
    console.log(`  base fee now               ${block.baseFeePerGas} wei: a transfer costs ${formatEther(21_000n * block.baseFeePerGas!)} CYBER`);
    return config;
  };

  console.log(`chain ${chainId}`);
  const current = await show();
  const args = [...current] as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
  const changes = FIELDS.filter((field) => arg(field) !== undefined);
  if (!changes.length) return;
  for (const field of changes) args[FIELDS.indexOf(field)] = BigInt(arg(field)!);
  const minBaseFee = args[FIELDS.indexOf("minBaseFee")];
  if (minBaseFee < REPLAY_FLOOR_WEI) throw new Error(`minBaseFee ${minBaseFee} is below the replay floor ${REPLAY_FLOOR_WEI}`);
  const data = encodeFunctionData({ abi: FEE_MANAGER_ABI, functionName: "setFeeConfig", args });

  const PK = process.env.DEPLOYER_PK;
  const account = PK ? privateKeyToAccount((PK.startsWith("0x") ? PK : `0x${PK}`) as Hex) : undefined;
  const role = account
    ? await publicClient.readContract({ address: FEE_MANAGER, abi: FEE_MANAGER_ABI, functionName: "readAllowList", args: [account.address] })
    : 0n;
  if (role === 0n) {
    console.log(`\nnot on FeeManager's allow list; have the admin (the Safe) call ${FEE_MANAGER} with\n${data}`);
    return;
  }

  const chain = {
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "CYBER", symbol: "CYBER", decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] } },
  } as const;
  const wallet = createWalletClient({ account: account!, chain, transport });
  const hash = await wallet.sendTransaction({ to: FEE_MANAGER, data });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`setFeeConfig failed: ${hash}`);
  console.log(`\nset ${changes.map((field) => `${field} ${args[FIELDS.indexOf(field)]}`).join(", ")} in block ${receipt.blockNumber} (${hash})`);
  await show();
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main();
}
