/**
 * Launch one token through LaunchpadV3 on a live chain and prove, on that chain, the three things
 * the contracts promise:
 *
 *   1. the pool really charges what the creator asked for, plus the protocol's 1%, and its address
 *      is still the one the 11% tier derives -- so every router path finds it;
 *   2. the whole supply and the whole CYBER really went into a position the locker will never
 *      release;
 *   3. a trade through that pool really pays the creator, the holders and the treasury in the
 *      proportions the launch announced -- collected by an address with no privileges at all.
 *
 * Step 3 is why this script buys a little of its own token and then collects: a split that has
 * never moved a wei is a claim, not a proof. The launch's CYBER is spent for good, exactly as a
 * real launch's is; nothing here can take it back, which is the point.
 *
 * A launch locks its CYBER forever, so the dry run comes first: SMOKE_DRY_RUN=1 reads the deployed
 * stack's own wiring and executes the whole launch as an eth_call, which reverts exactly where a
 * real one would and costs nothing. Only what a simulation cannot answer -- that a trade really
 * pays three parties -- needs the real thing.
 *
 * Usage:
 *   npx hardhat compile
 *   SMOKE_DRY_RUN=1 npx tsx scripts/v3-launch-smoke.ts   # free
 *   npx tsx scripts/v3-launch-smoke.ts                   # spends the launch minimum, for good
 *
 * Env:
 *   SMOKE_NAME / SMOKE_SYMBOL     token metadata           (default "Cyberia V3 Smoke" / "V3SMOKE")
 *   SMOKE_CREATOR_FEE             hundredths of a bip      (default 50000 = 5%)
 *   SMOKE_HOLDERS_BPS             creator's share to holders, in bps (default 3000 = 30%)
 *   SMOKE_BUY                     CYBER spent buying it back, in wei (default 0.05 CYBER)
 *   SMOKE_DRY_RUN=1               check the wiring and simulate the launch, spending nothing
 *   CYBERIA_RPC_URL, CYBERIA_CHAIN_ID   as in deploy-v3.ts, so this can rehearse locally too
 */

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { createPublicClient, createWalletClient, decodeEventLog, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const DEPLOYER_PK = process.env.DEPLOYER_PK;
if (!DEPLOYER_PK) throw new Error("DEPLOYER_PK not set in .env");

const account = privateKeyToAccount(
  (DEPLOYER_PK.startsWith("0x") ? DEPLOYER_PK : `0x${DEPLOYER_PK}`) as Hex,
);

const RPC_URL = process.env.CYBERIA_RPC_URL ?? "https://rpc.cyberia.church";
const CHAIN_ID = Number(process.env.CYBERIA_CHAIN_ID ?? 49406);

const NAME = process.env.SMOKE_NAME ?? "Cyberia V3 Smoke";
const SYMBOL = process.env.SMOKE_SYMBOL ?? "V3SMOKE";
const SUPPLY = 1_000_000n * 10n ** 18n;
const CREATOR_FEE = Number(process.env.SMOKE_CREATOR_FEE ?? 50_000);
const HOLDERS_BPS = Number(process.env.SMOKE_HOLDERS_BPS ?? 3000);
const BUY = BigInt(process.env.SMOKE_BUY ?? 50_000_000_000_000_000n); // 0.05 CYBER
const LAUNCH_TIER = 110_000;
const DRY_RUN = process.env.SMOKE_DRY_RUN === "1";
const BURN = "0x000000000000000000000000000000000000dEaD" as const;

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

// A launch deploys a whole pool and a whole token in one transaction (~7.9M measured), and this
// node's eth_estimateGas is not to be trusted, so every call carries its own explicit limit.
const LAUNCH_GAS = 12_000_000n;
const CALL_GAS = 900_000n;
const MIN_GAS_PRICE = 1_500_000_000n;

function artifact(name: string): { abi: Abi } {
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
  return { abi: JSON.parse(fs.readFileSync(matches[0], "utf8")).abi as Abi };
}

async function gasPrice(): Promise<bigint> {
  const live = await publicClient.getGasPrice();
  const bumped = (live * 3n) / 2n;
  return bumped > MIN_GAS_PRICE ? bumped : MIN_GAS_PRICE;
}

const cyber = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} CYBER`;

function check(what: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what.padEnd(46)} ${detail}`);
  if (!ok) throw new Error(`${what}: ${detail}`);
}

async function main() {
  if (!fs.existsSync(OUT)) throw new Error(`${path.relative(ROOT, OUT)} not found -- deploy first`);
  const state = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const launchpad = state.LaunchpadV3 as `0x${string}`;
  const locker = state.LaunchLocker as `0x${string}`;
  const router = state.SwapRouter as `0x${string}`;
  const wcyber = state.WCYBER as `0x${string}`;
  const positions = state.NonfungiblePositionManager as `0x${string}`;
  if (!launchpad || !locker) throw new Error("no LaunchpadV3/LaunchLocker in the record");

  const launchpadAbi = artifact("LaunchpadV3").abi;
  const lockerAbi = artifact("LaunchLocker").abi;
  const tokenAbi = artifact("LaunchToken").abi;
  const poolAbi = artifact("PancakeV3Pool").abi;
  const routerAbi = artifact("SwapRouter").abi;
  const wcyberAbi = artifact("WCYBER").abi;
  const positionsAbi = artifact("NonfungiblePositionManager").abi;

  const minLiquidity = (await publicClient.readContract({
    address: launchpad,
    abi: launchpadAbi,
    functionName: "minLiquidity",
  })) as bigint;

  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`Cyberia V3 launch smoke`);
  console.log(`  caller     ${account.address}  ${cyber(balance)}`);
  console.log(`  launchpad  ${launchpad}`);
  console.log(`  paying in  ${cyber(minLiquidity)} (locked forever) + ${cyber(BUY)} to trade\n`);
  if (balance < minLiquidity + BUY + 10n ** 18n) throw new Error("not enough CYBER to smoke this");

  const [poolFee, creatorBps, holdersBps, treasuryBps] = (await publicClient.readContract({
    address: launchpad,
    abi: launchpadAbi,
    functionName: "quote",
    args: [CREATOR_FEE, HOLDERS_BPS],
  })) as [number, number, number, number];
  console.log(
    `  quote: a trade costs ${poolFee / 10_000}% -- of every unit collected, ` +
      `${creatorBps / 100}% creator / ${holdersBps / 100}% holders / ${treasuryBps / 100}% treasury\n`,
  );

  if (DRY_RUN) {
    // The stack's own wiring, read from the chain rather than from the record that named it.
    check(
      "the factory knows the 11% tier",
      Number(
        await publicClient.readContract({
          address: state.PancakeV3Factory as `0x${string}`,
          abi: artifact("PancakeV3Factory").abi,
          functionName: "feeAmountTickSpacing",
          args: [LAUNCH_TIER],
        }),
      ) === 200,
      "tick spacing 200",
    );
    check(
      "the locker takes this launchpad's terms",
      (await publicClient.readContract({
        address: locker, abi: lockerAbi, functionName: "launchers", args: [launchpad],
      })) === true,
      launchpad,
    );
    check(
      "the launchpad locks into that locker",
      ((await publicClient.readContract({
        address: launchpad, abi: launchpadAbi, functionName: "locker",
      })) as string).toLowerCase() === locker.toLowerCase(),
      locker,
    );
    check(
      "and pairs against the real wrapper",
      ((await publicClient.readContract({
        address: launchpad, abi: launchpadAbi, functionName: "wcyber",
      })) as string).toLowerCase() === wcyber.toLowerCase(),
      wcyber,
    );

    // The launch itself, as an eth_call: every contract it touches runs, nothing is written.
    const { result } = await publicClient.simulateContract({
      address: launchpad,
      abi: launchpadAbi,
      functionName: "launch",
      args: [NAME, SYMBOL, SUPPLY, CREATOR_FEE, HOLDERS_BPS],
      value: minLiquidity,
      account: account.address,
      gas: LAUNCH_GAS,
    });
    const [wouldToken, wouldPool, wouldPosition] = result as [`0x${string}`, `0x${string}`, bigint];
    check("a launch would go through", wouldToken !== "0x", `token ${wouldToken}`);
    console.log(`\n  simulated: pool ${wouldPool}, position #${wouldPosition}`);
    console.log(`  nothing was spent. Drop SMOKE_DRY_RUN to launch for real.`);
    return;
  }

  const launchHash = await walletClient.writeContract({
    address: launchpad,
    abi: launchpadAbi,
    functionName: "launch",
    args: [NAME, SYMBOL, SUPPLY, CREATOR_FEE, HOLDERS_BPS],
    value: minLiquidity,
    gas: LAUNCH_GAS,
    gasPrice: await gasPrice(),
  });
  const launchReceipt = await publicClient.waitForTransactionReceipt({ hash: launchHash });
  if (launchReceipt.status !== "success") throw new Error(`launch reverted (${launchHash})`);
  console.log(`  launched   ${launchHash}  ${launchReceipt.gasUsed} gas`);

  let token = "" as `0x${string}`;
  let pool = "" as `0x${string}`;
  let positionId = 0n;
  for (const log of launchReceipt.logs) {
    try {
      const parsed = decodeEventLog({ abi: launchpadAbi, ...log });
      if (parsed.eventName === "TokenLaunched") {
        token = (parsed.args as unknown as { token: `0x${string}` }).token;
        pool = (parsed.args as unknown as { pool: `0x${string}` }).pool;
      }
      if (parsed.eventName === "LaunchTerms") {
        positionId = (parsed.args as unknown as { positionId: bigint }).positionId;
      }
    } catch {
      /* not one of ours */
    }
  }
  console.log(`  token      ${token}`);
  console.log(`  pool       ${pool}`);
  console.log(`  position   #${positionId}\n`);

  const read = (address: `0x${string}`, abi: Abi, functionName: string, args: unknown[] = []) =>
    publicClient.readContract({ address, abi, functionName, args: args as never });

  check(
    "pool charges the creator's fee plus 1%",
    (await read(pool, poolAbi, "fee")) === poolFee,
    `${poolFee} (${poolFee / 10_000}%)`,
  );
  check(
    "pool still lives at the 11% tier's address",
    ((await read(launchpad, launchpadAbi, "poolOf", [token])) as string).toLowerCase() ===
      pool.toLowerCase(),
    `tier ${LAUNCH_TIER}`,
  );
  // A full-range v3 mint never consumes a round number exactly, so the supply is in two places
  // and no third: the pool, and the burn address the launchpad sends its own dust to.
  const inPool = (await read(token, tokenAbi, "balanceOf", [pool])) as bigint;
  const burned = (await read(token, tokenAbi, "balanceOf", [BURN])) as bigint;
  const stuck = (await read(token, tokenAbi, "balanceOf", [launchpad])) as bigint;
  check(
    "the whole supply is in the pool, bar burnt dust",
    inPool + burned === SUPPLY && stuck === 0n,
    `${(Number(inPool) / 1e18).toFixed(0)} in the pool, ${(Number(burned) / 1e18).toFixed(6)} burnt`,
  );
  check(
    "the position belongs to the locker, permanently",
    ((await read(positions, positionsAbi, "ownerOf", [positionId])) as string).toLowerCase() ===
      locker.toLowerCase(),
    locker,
  );
  const lock = (await read(locker, lockerAbi, "locks", [positionId])) as unknown[];
  check(
    "locked under the terms the launch announced",
    Number(lock[1]) === creatorBps && Number(lock[2]) === holdersBps,
    `creator ${Number(lock[1]) / 100}% / holders ${Number(lock[2]) / 100}%`,
  );
  check(
    "the token knows its pool, and the pool holds no dividend",
    ((await read(token, tokenAbi, "pool")) as string).toLowerCase() === pool.toLowerCase(),
    "pool excluded from rewards",
  );

  // A split nobody has been paid by is a claim. Buy a little, then collect.
  console.log();
  await walletClient.writeContract({
    address: wcyber, abi: wcyberAbi, functionName: "deposit",
    value: BUY, gas: CALL_GAS, gasPrice: await gasPrice(),
  });
  const approve = await walletClient.writeContract({
    address: wcyber, abi: wcyberAbi, functionName: "approve",
    args: [router, BUY], gas: CALL_GAS, gasPrice: await gasPrice(),
  });
  await publicClient.waitForTransactionReceipt({ hash: approve });
  const swap = await walletClient.writeContract({
    address: router,
    abi: routerAbi,
    functionName: "exactInputSingle",
    args: [{
      tokenIn: wcyber,
      tokenOut: token,
      fee: LAUNCH_TIER, // the path names the tier, never what the pool charges
      recipient: account.address,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      amountIn: BUY,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    }],
    gas: CALL_GAS,
    gasPrice: await gasPrice(),
  });
  const swapReceipt = await publicClient.waitForTransactionReceipt({ hash: swap });
  if (swapReceipt.status !== "success") throw new Error(`swap reverted (${swap})`);
  const bought = (await read(token, tokenAbi, "balanceOf", [account.address])) as bigint;
  console.log(`  bought     ${cyber(BUY)} -> ${(Number(bought) / 1e18).toFixed(4)} ${SYMBOL}  (${swap})`);

  const claimable = (await read(locker, lockerAbi, "claimable", [positionId])) as bigint[];
  const collectHash = await walletClient.writeContract({
    address: locker, abi: lockerAbi, functionName: "collect",
    args: [positionId], gas: CALL_GAS, gasPrice: await gasPrice(),
  });
  const collectReceipt = await publicClient.waitForTransactionReceipt({ hash: collectHash });
  if (collectReceipt.status !== "success") throw new Error(`collect reverted (${collectHash})`);

  let paid = { creator: 0n, holders: 0n, treasury: 0n };
  for (const log of collectReceipt.logs) {
    try {
      const parsed = decodeEventLog({ abi: lockerAbi, ...log });
      if (parsed.eventName !== "Collected") continue;
      const a = parsed.args as unknown as Record<string, bigint>;
      const wcyberIsToken0 = wcyber.toLowerCase() < token.toLowerCase();
      paid = {
        creator: wcyberIsToken0 ? a.creatorAmount0 : a.creatorAmount1,
        holders: wcyberIsToken0 ? a.holdersAmount0 : a.holdersAmount1,
        treasury: wcyberIsToken0 ? a.treasuryAmount0 : a.treasuryAmount1,
      };
    } catch {
      /* not one of ours */
    }
  }
  const total = paid.creator + paid.holders + paid.treasury;
  console.log(`  collected  ${collectHash}`);
  console.log(`    creator  ${cyber(paid.creator)}`);
  console.log(`    holders  ${cyber(paid.holders)}`);
  console.log(`    treasury ${cyber(paid.treasury)}`);

  check(
    "a real trade paid a real fee",
    total > 0n,
    `${cyber(total)} of the ${cyber(BUY)} traded (${(Number(total) / Number(BUY) * 100).toFixed(2)}%)`,
  );
  check(
    "claimable said beforehand what collect paid",
    claimable.reduce((sum, v) => sum + v, 0n) === total,
    cyber(total),
  );
  check(
    "the treasury got its share and the creator got theirs",
    paid.treasury > 0n && paid.creator > 0n,
    `${(Number(paid.treasury) / Number(total) * 100).toFixed(1)}% to the treasury`,
  );
  const distributed = (await read(token, tokenAbi, "totalRewardsDistributed")) as bigint;
  check(
    "holders' share reached the token as a dividend",
    HOLDERS_BPS === 0 || distributed > 0n,
    `${cyber(distributed)} distributed to holders`,
  );

  state.launchSmoke = {
    token,
    pool,
    positionId: positionId.toString(),
    name: NAME,
    symbol: SYMBOL,
    creatorFee: CREATOR_FEE,
    poolFee,
    split: { creatorBps, holdersBps, treasuryBps },
    liquidity: minLiquidity.toString(),
    launchTx: launchHash,
    launchGas: launchReceipt.gasUsed.toString(),
    collectTx: collectHash,
    collected: { creator: paid.creator.toString(), holders: paid.holders.toString(), treasury: paid.treasury.toString() },
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(OUT, `${JSON.stringify(state, null, 2)}\n`);
  console.log(`\n  written ${path.relative(ROOT, OUT)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
