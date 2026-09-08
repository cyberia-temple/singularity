import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

/**
 * A launch where the creator names the fee, and holding the token pays.
 *
 * Three promises are made in one transaction and all three are contracts rather than intentions:
 * a trader pays what the creator chose plus the protocol's 1% and never more than 11%; the
 * liquidity can never come back out; and the fee stream is split by numbers written down when the
 * position was locked -- to the creator, to everyone holding the token, and to the treasury.
 *
 * What these tests guard:
 *   - an arbitrary fee is really reached (v3 fees are a whitelist, so the pool is born in the 11%
 *     tier and lowered exactly once, by the address that created it and nobody else);
 *   - the tier stays the pool's identity while `fee()` is what it charges;
 *   - the three shares add up to what was collected, with rounding falling on the treasury;
 *   - holders are paid out of the pool's own trading fees, and the pool itself is not a holder;
 *   - the supply really all went into the pool, and the position really cannot leave.
 */
describe("LaunchpadV3", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, creator, trader, treasury] = await viem.getWalletClients();

  const LAUNCH_TIER = 110_000; // 11% -- the tier every launch pool is created in
  const PROTOCOL_FEE = 10_000; // 1%
  const TICK_SPACING = 200;
  const ONE = 10n ** 18n;
  const SUPPLY = 1_000_000n * ONE;
  const LIQUIDITY = 10n * ONE; // 10 CYBER, the same floor the v2 launchpad uses
  const MAX_UINT128 = (1n << 128n) - 1n;

  async function deployStack() {
    const wcyber = await viem.deployContract("WCYBER");
    const poolDeployer = await viem.deployContract("PancakeV3PoolDeployer");
    const factory = await viem.deployContract("PancakeV3Factory", [poolDeployer.address]);
    await poolDeployer.write.setFactoryAddress([factory.address]);
    const router = await viem.deployContract("SwapRouter", [
      poolDeployer.address, factory.address, wcyber.address,
    ]);
    const descriptor = await viem.deployContract("NonfungibleTokenPositionDescriptorOffChain");
    await descriptor.write.initialize(["https://cyberia.church/api/v3/positions/"]);
    const positions = await viem.deployContract("NonfungiblePositionManager", [
      poolDeployer.address, factory.address, wcyber.address, descriptor.address,
    ]);

    // The 11% tier is not one of the four the factory ships with: launches need it enabled.
    await factory.write.enableFeeAmount([LAUNCH_TIER, TICK_SPACING]);

    const locker = await viem.deployContract("LaunchLocker", [
      positions.address, treasury.account.address, 7000,
    ]);
    const launchpad = await viem.deployContract("LaunchpadV3", [
      factory.address, positions.address, wcyber.address, locker.address, LIQUIDITY,
    ]);
    await locker.write.setLauncher([launchpad.address, true]);

    return { wcyber, factory, positions, router, locker, launchpad };
  }

  type Stack = Awaited<ReturnType<typeof deployStack>>;

  /** What the last launch actually cost, so the gas table in the README can be checked. */
  let lastLaunchGas = 0n;

  async function launch(
    stack: Stack,
    creatorFee: number,
    holdersShareBps = 0,
    value = LIQUIDITY,
  ) {
    // Explicit, because a launch deploys a pool and a token in one call: hardhat's estimate times
    // its safety multiplier lands over EDR's per-transaction cap, while the call itself does not.
    const hash = await stack.launchpad.write.launch(
      ["Lain", "LAIN", SUPPLY, creatorFee, holdersShareBps],
      { account: creator.account, value, gas: 16_000_000n },
    );
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    lastLaunchGas = receipt.gasUsed;

    const token = await stack.launchpad.read.allTokens([0n]);
    const pool = await stack.launchpad.read.poolOf([token]);
    return {
      token: await viem.getContractAt("LaunchToken", token),
      pool: await viem.getContractAt("PancakeV3Pool", pool),
    };
  }

  /** Buy the launched token with CYBER, through the router, at the pool's tier. */
  async function buy(stack: Stack, token: `0x${string}`, amountIn: bigint) {
    await stack.wcyber.write.deposit({ account: trader.account, value: amountIn });
    await stack.wcyber.write.approve([stack.router.address, MAX_UINT128], {
      account: trader.account,
    });
    await stack.router.write.exactInputSingle([{
      tokenIn: stack.wcyber.address,
      tokenOut: token,
      fee: LAUNCH_TIER, // the path names the tier, never what the pool charges
      recipient: trader.account.address,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    }], { account: trader.account });
  }

  it("charges what the creator asked for, plus the protocol's one percent", async function () {
    const stack = await deployStack();
    const { token, pool } = await launch(stack, 37_000); // 3.7%

    assert.equal(await pool.read.fee(), 47_000, "3.7% + 1% is what a trade costs");

    // The tier is still the pool's identity: its address was derived from 11%, and that is where
    // `getPool` and every swap path find it.
    assert.equal(
      (await stack.factory.read.getPool([token.address, stack.wcyber.address, LAUNCH_TIER]))
        .toLowerCase(),
      pool.address.toLowerCase(),
    );
    assert.equal(await pool.read.tickSpacing(), TICK_SPACING);
  });

  it("reaches both ends of what a creator may ask", async function () {
    // The most: the pool keeps the tier's own fee, and no adjustment is needed at all.
    assert.equal(await (await launch(await deployStack(), 100_000)).pool.read.fee(), LAUNCH_TIER);

    // The least: nothing for the creator is still a pool that pays the protocol.
    assert.equal(await (await launch(await deployStack(), 0)).pool.read.fee(), PROTOCOL_FEE);
  });

  it("fits in a Cyberia block, with room", async function () {
    const stack = await deployStack();
    await launch(stack, 50_000);
    // The chain's limit is 30M. A launch deploys a 23 KB pool and a whole token in one call, so
    // this is the number that decides whether the launchpad can exist at all.
    assert.ok(lastLaunchGas < 20_000_000n, `a launch cost ${lastLaunchGas} gas`);
    console.log(`      launch cost ${lastLaunchGas} gas`);
  });

  it("refuses a fee above ten percent", async function () {
    const stack = await deployStack();
    await assert.rejects(
      stack.launchpad.write.launch(["Lain", "LAIN", SUPPLY, 100_001, 0], {
        account: creator.account,
        value: LIQUIDITY,
      }),
      /FEE/,
    );
  });

  it("splits one unit of fees so that the protocol always gets its one percent", async function () {
    const stack = await deployStack();

    // 10% + 1%: the creator's side is 10/11 of everything collected, the treasury's 1/11.
    const [poolFee, creatorBps, holdersBps, treasuryBps] =
      await stack.launchpad.read.quote([100_000, 0]);
    assert.equal(poolFee, 110_000);
    assert.equal(creatorBps, 9090);
    assert.equal(holdersBps, 0);
    assert.equal(treasuryBps, 910);
    assert.equal(creatorBps + holdersBps + treasuryBps, 10_000);

    // Sharing with holders comes out of the creator's own share, never the protocol's.
    const [, sharedCreator, sharedHolders, sharedTreasury] =
      await stack.launchpad.read.quote([100_000, 2000]);
    assert.equal(sharedHolders, 1818);
    assert.equal(sharedCreator, 7272);
    assert.equal(sharedTreasury, 910, "a generous launch costs the protocol nothing");
    assert.equal(sharedCreator + sharedHolders + sharedTreasury, 10_000);
  });

  it("locks the position under exactly the terms it announced", async function () {
    const stack = await deployStack();
    const { token } = await launch(stack, 100_000, 2000);

    const positionId = 1n;
    assert.equal(
      (await stack.positions.read.ownerOf([positionId])).toLowerCase(),
      stack.locker.address.toLowerCase(),
    );
    const [lockCreator, creatorBps, holdersBps, rewardsTo, locked] =
      await stack.locker.read.locks([positionId]);
    assert.equal(lockCreator.toLowerCase(), creator.account.address.toLowerCase());
    assert.equal(creatorBps, 7272);
    assert.equal(holdersBps, 1818);
    assert.equal(rewardsTo.toLowerCase(), token.address.toLowerCase());
    assert.equal(locked, true);

    // The launchpad's own default (70%) is not what a launch gets: the launch names its split.
    assert.equal(await stack.locker.read.defaultCreatorBps(), 7000);
  });

  it("puts the whole supply into the pool and keeps nothing", async function () {
    const stack = await deployStack();
    const { token, pool } = await launch(stack, 50_000);

    const inPool = await token.read.balanceOf([pool.address]);
    const burned = await token.read.balanceOf(["0x000000000000000000000000000000000000dEaD"]);
    assert.equal(await token.read.balanceOf([stack.launchpad.address]), 0n);
    assert.equal(await token.read.balanceOf([creator.account.address]), 0n);
    assert.equal(inPool + burned, SUPPLY, "every token minted is either liquidity or burned dust");
    assert.ok(inPool > (SUPPLY * 999n) / 1000n, "the dust is dust");
  });

  it("pays the creator, the holders and the treasury out of real trades", async function () {
    const stack = await deployStack();
    const { token, pool } = await launch(stack, 100_000, 2000); // 10%, a fifth of it shared

    await buy(stack, token.address, 5n * ONE);
    const held = await token.read.balanceOf([trader.account.address]);
    assert.ok(held > 0n, "the trader is now a holder");

    const [c0, c1, h0, h1, t0, t1] = await stack.locker.read.claimable([1n]);

    const creatorBefore = await stack.wcyber.read.balanceOf([creator.account.address]);
    const treasuryBefore = await stack.wcyber.read.balanceOf([treasury.account.address]);
    await stack.locker.write.collect([1n], { account: deployer.account });
    const creatorGot =
      (await stack.wcyber.read.balanceOf([creator.account.address])) - creatorBefore;
    const treasuryGot =
      (await stack.wcyber.read.balanceOf([treasury.account.address])) - treasuryBefore;

    // The buy paid its fee in CYBER, so this collection is one-sided; which side that is depends
    // on the token's address, so read the pair rather than assuming it.
    const wcyberIsToken0 =
      stack.wcyber.address.toLowerCase() < token.address.toLowerCase();
    const [creatorFees, holdersFees, treasuryFees] = wcyberIsToken0
      ? [c0, h0, t0]
      : [c1, h1, t1];

    assert.ok(creatorFees > 0n && holdersFees > 0n && treasuryFees > 0n);
    assert.equal(creatorGot, creatorFees);
    assert.equal(treasuryGot, treasuryFees);

    // The protocol's share is 1/11 of an 11% fee -- one percent of what was traded. Each share is
    // floored and the treasury takes what is left, so the three add up to exactly what came out of
    // the pool and every wei lost to rounding lands on the protocol rather than on a person.
    const total = creatorFees + holdersFees + treasuryFees;
    assert.equal(creatorFees, (total * 7272n) / 10_000n);
    assert.equal(holdersFees, (total * 1818n) / 10_000n);
    assert.equal(treasuryFees, total - creatorFees - holdersFees);
    assert.ok(treasuryFees >= total - (total * 9090n) / 10_000n);

    // The holders' share reached the token, and the token counted it.
    assert.ok((await token.read.totalRewardsDistributed()) > 0n);
    const claimable = await token.read.withdrawableRewardsOf([trader.account.address]);
    assert.ok(claimable > 0n, "a holder can take their part of it");

    // …and the pool, which holds most of the supply, is not a holder.
    assert.equal(await token.read.excluded([pool.address]), true);
    assert.equal(await token.read.withdrawableRewardsOf([pool.address]), 0n);
  });

  it("hands a holder their share as the coin", async function () {
    const stack = await deployStack();
    const { token } = await launch(stack, 100_000, 10_000); // everything shared with holders

    await buy(stack, token.address, 5n * ONE);
    await buy(stack, token.address, 5n * ONE);
    await stack.locker.write.collect([1n]);

    // Count what has arrived before reading the claim: `claim` distributes first, and a residue
    // left by an earlier round would otherwise make the claim larger than the number just read.
    await token.write.distribute();
    const claimable = await token.read.withdrawableRewardsOf([trader.account.address]);
    assert.ok(claimable > 0n);

    const before = await publicClient.getBalance({ address: trader.account.address });
    const hash = await token.write.claim({ account: trader.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const spent = receipt.gasUsed * receipt.effectiveGasPrice;
    const after = await publicClient.getBalance({ address: trader.account.address });

    assert.equal(after - before + spent, claimable, "paid in CYBER, to the wei");
    assert.equal(await token.read.withdrawableRewardsOf([trader.account.address]), 0n);
    await assert.rejects(token.write.claim({ account: trader.account }), /NOTHING/);
  });

  it("gives the creator nothing when they chose to share everything", async function () {
    const stack = await deployStack();
    const { token } = await launch(stack, 100_000, 10_000);

    const [, creatorBps, holdersBps] = await stack.locker.read.locks([1n]);
    assert.equal(creatorBps, 0);
    assert.equal(holdersBps, 9090);

    await buy(stack, token.address, 5n * ONE);
    const creatorBefore = await stack.wcyber.read.balanceOf([creator.account.address]);
    await stack.locker.write.collect([1n]);
    assert.equal(
      await stack.wcyber.read.balanceOf([creator.account.address]),
      creatorBefore,
      "nothing to the creator is a promise like any other",
    );
  });
});
