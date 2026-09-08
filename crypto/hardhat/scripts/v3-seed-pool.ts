/**
 * Open a Cyberia V3 market and put the treasury's liquidity in it.
 *
 * A v3 pool is three separate things that a v2 pair does in one step — an
 * address, a price, and a range — and this script keeps them separate on
 * purpose:
 *
 *   1. **create.** The pool is created from *this* EOA rather than through the
 *      position manager, because whoever calls `createPool` is the address the
 *      factory records as the pool's creator. Going through the position
 *      manager would spend that record on a contract that can never use it,
 *      and the pool's fee would be stuck at its tier forever.
 *   2. **initialise.** The first price is a decision, not a market: nobody has
 *      traded yet, so whatever is written here is what the first trader pays.
 *      It is given as a plain ratio (how many of token1 one token0 is worth)
 *      and converted to Q64.96 here.
 *   3. **mint.** Liquidity is placed in a tick range. Full range behaves like
 *      v2; a narrow range is why v3 exists — the same money is deeper where
 *      the price actually is, and stops working once it leaves.
 *
 * The position minted here is **not** locked: it is the treasury's, and it must
 * be movable. Launch liquidity is the locked kind and goes through
 * `LaunchpadV3` instead.
 *
 * Usage:
 *   npx hardhat compile
 *   SEED_TOKEN0=0x… SEED_TOKEN1=0x… SEED_AMOUNT0=100 SEED_AMOUNT1=0.5 \
 *   SEED_PRICE=200 SEED_TIER=10000 SEED_RANGE_PCT=60 npx tsx scripts/v3-seed-pool.ts
 *
 * Env:
 *   SEED_TOKEN0 / SEED_TOKEN1  the pair, in any order (sorted here)
 *   SEED_AMOUNT0 / SEED_AMOUNT1  what to put in, in whole tokens
 *   SEED_PRICE      token1 per token0, whole units. Ignored once the pool exists.
 *   SEED_TIER       fee tier to create in (default 10000 = 1%)
 *   SEED_FEE        what the pool should actually charge, if not the tier
 *   SEED_RANGE_PCT  half-width of the range in percent (default 60; 0 = full range)
 *   SEED_DRY_RUN=1  print the plan and stop
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { createPublicClient, createWalletClient, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const DEPLOYER_PK = process.env.DEPLOYER_PK;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_PK not set in .env");

const account = privateKeyToAccount(
  (DEPLOYER_PK.startsWith("0x") ? DEPLOYER_PK : `0x${DEPLOYER_PK}`) as Hex,
);

const RPC_URL = process.env.CYBERIA_RPC_URL ?? "https://rpc.cyberia.church";
const CHAIN_ID = Number(process.env.CYBERIA_CHAIN_ID ?? 49406);
const DRY_RUN = process.env.SEED_DRY_RUN === "1";

const TIER = Number(process.env.SEED_TIER ?? 10_000);
const FEE = process.env.SEED_FEE ? Number(process.env.SEED_FEE) : null;
const RANGE_PCT = Number(process.env.SEED_RANGE_PCT ?? 60);

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

const CALL_GAS = 900_000n;
// Creating a pool deploys a 23 KB contract by CREATE2 — it is not a cheap call
// and the node's estimate cannot be trusted here.
const CREATE_POOL_GAS = 6_000_000n;
const MINT_GAS = 1_400_000n;
const MIN_GAS_PRICE = 1_500_000_000n;

const ERC20_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const satisfies Abi;

const POOL_ABI = [
  { type: "function", name: "initialize", stateMutability: "nonpayable", inputs: [{ type: "uint160" }], outputs: [] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "tickSpacing", stateMutability: "view", inputs: [], outputs: [{ type: "int24" }] },
  {
    type: "function", name: "slot0", stateMutability: "view", inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" }, { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" }, { name: "feeProtocol", type: "uint32" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const satisfies Abi;

function artifact(name: string): Abi {
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
  return JSON.parse(fs.readFileSync(matches[0], "utf8")).abi as Abi;
}

async function gasPrice(): Promise<bigint> {
  const live = await publicClient.getGasPrice();
  const bumped = (live * 3n) / 2n;
  return bumped > MIN_GAS_PRICE ? bumped : MIN_GAS_PRICE;
}

/**
 * The first price, as the pool stores it: sqrt(token1/token0) in Q64.96.
 *
 * Computed in integers the whole way — a float here is a price that is wrong
 * in its last digits forever, because nobody re-initialises a pool.
 */
function sqrtPriceX96(amount1: bigint, amount0: bigint): bigint {
  if (amount0 <= 0n || amount1 <= 0n) throw new Error("a price needs both sides");
  // sqrt(a1/a0) * 2^96 == sqrt(a1 * 2^192 / a0)
  return sqrtBigInt((amount1 << 192n) / amount0);
}

function sqrtBigInt(value: bigint): bigint {
  if (value < 0n) throw new Error("no square root of a negative");
  if (value < 2n) return value;

  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

/** The tick a price sits at: log base 1.0001 of it. Ticks are integers, so this floors. */
function tickAtPrice(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

const MIN_TICK = -887272;
const MAX_TICK = 887272;

/** Ticks may only land on multiples of the tier's spacing. */
const roundToSpacing = (tick: number, spacing: number, dir: "down" | "up"): number => {
  const rounded = dir === "down"
    ? Math.floor(tick / spacing) * spacing
    : Math.ceil(tick / spacing) * spacing;
  return Math.min(MAX_TICK - (MAX_TICK % spacing), Math.max(-(MAX_TICK - (MAX_TICK % spacing)), rounded));
};

async function send(label: string, to: Hex, abi: Abi, functionName: string, args: unknown[], gas = CALL_GAS) {
  const hash = await walletClient.writeContract({
    address: to, abi, functionName, args: args as never, gas, gasPrice: await gasPrice(),
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  console.log(`  ${label.padEnd(38)} ok  ${receipt.gasUsed.toString().padStart(9)} gas  ${hash}`);
  return receipt;
}

async function main() {
  const state = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const factory = state.PancakeV3Factory as Hex;
  const positions = state.NonfungiblePositionManager as Hex;
  const factoryAbi = artifact("PancakeV3Factory");
  const positionsAbi = artifact("NonfungiblePositionManager");

  const rawA = (process.env.SEED_TOKEN0 ?? "").trim() as Hex;
  const rawB = (process.env.SEED_TOKEN1 ?? "").trim() as Hex;
  if (!rawA || !rawB) throw new Error("SEED_TOKEN0 and SEED_TOKEN1 are required");

  // The pool key is ordered by address, and so is everything downstream of it.
  const flip = rawA.toLowerCase() > rawB.toLowerCase();
  const [token0, token1] = flip ? [rawB, rawA] : [rawA, rawB];

  const read = (address: Hex, functionName: string, args: unknown[] = []) =>
    publicClient.readContract({
      address,
      abi: ERC20_ABI as unknown as Abi,
      functionName,
      args: args as never,
    });

  const [dec0, dec1, sym0, sym1] = await Promise.all([
    read(token0, "decimals") as Promise<number>,
    read(token1, "decimals") as Promise<number>,
    read(token0, "symbol") as Promise<string>,
    read(token1, "symbol") as Promise<string>,
  ]);

  const whole = (value: string, decimals: number): bigint => {
    const [int, frac = ""] = value.trim().split(".");
    return BigInt(int || "0") * 10n ** BigInt(decimals) +
      BigInt((frac + "0".repeat(decimals)).slice(0, decimals) || "0");
  };

  const inA = process.env.SEED_AMOUNT0 ?? "0";
  const inB = process.env.SEED_AMOUNT1 ?? "0";
  const amount0 = whole(flip ? inB : inA, dec0);
  const amount1 = whole(flip ? inA : inB, dec1);
  if (amount0 <= 0n || amount1 <= 0n) throw new Error("both sides need an amount");

  console.log(`Cyberia V3 pool seeding`);
  console.log(`  caller     ${account.address}`);
  console.log(`  pair       ${sym0}/${sym1}  (${token0} / ${token1})`);
  console.log(`  tier       ${TIER} (${TIER / 10_000}%)${FEE ? ` -> charging ${FEE / 10_000}%` : ""}`);
  console.log(`  amounts    ${inA} + ${inB}`);

  const tickSpacing = Number(
    await publicClient.readContract({
      address: factory, abi: factoryAbi, functionName: "feeAmountTickSpacing", args: [TIER],
    }),
  );
  if (tickSpacing === 0) throw new Error(`the ${TIER} tier is not enabled on this factory`);

  let pool = (await publicClient.readContract({
    address: factory, abi: factoryAbi, functionName: "getPool", args: [token0, token1, TIER],
  })) as Hex;

  const priceEnv = process.env.SEED_PRICE;
  // The seeded amounts already state a price; SEED_PRICE only overrides it.
  const initialSqrt = priceEnv
    ? sqrtPriceX96(whole(priceEnv, dec1), 10n ** BigInt(dec0))
    : sqrtPriceX96(amount1, amount0);

  const priceOf = (sqrt: bigint): number => {
    const ratio = Number(sqrt) / 2 ** 96;
    return ratio * ratio * 10 ** (dec0 - dec1);
  };
  console.log(`  price      1 ${sym0} = ${priceOf(initialSqrt).toPrecision(8)} ${sym1}`);

  if (DRY_RUN) {
    console.log(`\n  dry run: pool ${pool}, tick spacing ${tickSpacing}. Nothing sent.`);
    return;
  }

  if (pool === "0x0000000000000000000000000000000000000000") {
    // Created from this EOA so the factory records *us* as the creator, which
    // is what keeps the pool's fee adjustable afterwards.
    await send(
      "factory.createPool",
      factory,
      factoryAbi,
      "createPool",
      [token0, token1, TIER],
      CREATE_POOL_GAS,
    );
    pool = (await publicClient.readContract({
      address: factory, abi: factoryAbi, functionName: "getPool", args: [token0, token1, TIER],
    })) as Hex;
  }
  console.log(`  pool       ${pool}`);

  const slot0 = (await publicClient.readContract({
    address: pool, abi: POOL_ABI, functionName: "slot0",
  })) as unknown as [bigint, number, ...unknown[]];

  if (slot0[0] === 0n) {
    await send("pool.initialize", pool, POOL_ABI as unknown as Abi, "initialize", [initialSqrt]);
  } else {
    console.log(`  already initialised at 1 ${sym0} = ${priceOf(slot0[0]).toPrecision(8)} ${sym1}`);
  }

  if (FEE !== null) {
    const current = Number(await publicClient.readContract({ address: pool, abi: POOL_ABI, functionName: "fee" }));
    if (current !== FEE) {
      // Owner's setter, not the creator's one-shot: it can move either way and
      // as often as the market needs, which is the whole point of the fork.
      await send("factory.setPoolFee", factory, factoryAbi, "setPoolFee", [pool, FEE]);
    }
  }

  const live = (await publicClient.readContract({
    address: pool, abi: POOL_ABI, functionName: "slot0",
  })) as unknown as [bigint, number, ...unknown[]];
  const currentTick = Number(live[1]);

  // A range in percent around the price, because that is how a market maker
  // thinks about one; zero means full range, which is v2 behaviour and the
  // right choice for a pair whose price nobody can bracket yet.
  const [tickLower, tickUpper] = RANGE_PCT <= 0
    ? [roundToSpacing(MIN_TICK, tickSpacing, "up"), roundToSpacing(MAX_TICK, tickSpacing, "down")]
    : [
        roundToSpacing(currentTick + tickAtPrice(1 - RANGE_PCT / 100), tickSpacing, "down"),
        roundToSpacing(currentTick + tickAtPrice(1 / (1 - RANGE_PCT / 100)), tickSpacing, "up"),
      ];
  console.log(`  range      ticks ${tickLower} … ${tickUpper} (spacing ${tickSpacing})`);

  for (const [token, amount, symbol] of [
    [token0, amount0, sym0] as const,
    [token1, amount1, sym1] as const,
  ]) {
    const balance = (await read(token, "balanceOf", [account.address])) as bigint;
    if (balance < amount) {
      throw new Error(`not enough ${symbol}: have ${balance}, need ${amount}`);
    }
    const allowance = (await read(token, "allowance", [account.address, positions])) as bigint;
    if (allowance < amount) {
      await send(`approve ${symbol}`, token, ERC20_ABI as unknown as Abi, "approve", [positions, amount]);
    }
  }

  const receipt = await send(
    "positions.mint",
    positions,
    positionsAbi,
    "mint",
    [{
      token0, token1, fee: TIER, tickLower, tickUpper,
      amount0Desired: amount0, amount1Desired: amount1,
      // The pool decides the ratio it actually takes; a floor here would only
      // fight the price that was just written into it.
      amount0Min: 0n, amount1Min: 0n,
      recipient: account.address,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    }],
    MINT_GAS,
  );

  const minted = receipt.logs
    .map((log) => (log.topics[0] && log.address.toLowerCase() === positions.toLowerCase() ? log : null))
    .filter((log) => log !== null);

  state.seededPools = [
    ...(state.seededPools ?? []).filter(
      (entry: { pool?: string }) => entry.pool?.toLowerCase() !== pool.toLowerCase(),
    ),
    {
      pool, token0, token1, symbols: `${sym0}/${sym1}`, tier: TIER,
      fee: FEE ?? TIER, tickLower, tickUpper,
      amount0: amount0.toString(), amount1: amount1.toString(),
      mintTx: receipt.transactionHash, logs: minted.length,
      timestamp: new Date().toISOString(),
    },
  ];
  fs.writeFileSync(OUT, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`\n  written ${path.relative(ROOT, OUT)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
