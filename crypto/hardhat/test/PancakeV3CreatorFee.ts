import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

/**
 * Two changes to the vendored core that the launchpad rests on.
 *
 * **A pool's creator may set its fee once.** A v3 fee is a whitelisted tier, so a launch that lets
 * somebody name 3.7% cannot express it as a tier. Instead the pool is created in the tier that is
 * the product's maximum and its real fee is set once, downward, by whoever created it -- before it
 * holds anything, in the same transaction. Bounded three ways: only the creator, only once, never
 * upward.
 *
 * **A pool is born taking nothing for the protocol.** Upstream initialises every pool at 3200:3200
 * -- 32% of its fee -- until an owner remembers to zero it. Here a launch promises its creator a
 * named share of the fee, and a silent 32% cut would make that promise false on the first swap.
 */
describe("PancakeV3 creator fee", async function () {
  const { viem } = await network.connect();
  const [deployer, creator, other] = await viem.getWalletClients();

  const TIER = 110_000; // 11%
  const SPACING = 200;
  const SQRT_PRICE_1_1 = 79228162514264337593543950336n;

  async function deployStack() {
    const poolDeployer = await viem.deployContract("PancakeV3PoolDeployer");
    const factory = await viem.deployContract("PancakeV3Factory", [poolDeployer.address]);
    await poolDeployer.write.setFactoryAddress([factory.address]);
    await factory.write.enableFeeAmount([TIER, SPACING]);

    const a = await viem.deployContract("ETH", [deployer.account.address]);
    const b = await viem.deployContract("GOLD", [deployer.account.address]);
    const [token0, token1] =
      a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];

    return { factory, token0, token1 };
  }

  async function createPool(stack: Awaited<ReturnType<typeof deployStack>>) {
    await stack.factory.write.createPool(
      [stack.token0.address, stack.token1.address, TIER],
      { account: creator.account },
    );
    const address = await stack.factory.read.getPool([
      stack.token0.address, stack.token1.address, TIER,
    ]);
    const pool = await viem.getContractAt("PancakeV3Pool", address);
    await pool.write.initialize([SQRT_PRICE_1_1]);
    return pool;
  }

  it("lets a creator lower their own pool's fee, once", async function () {
    const stack = await deployStack();
    const pool = await createPool(stack);
    assert.equal(await pool.read.fee(), TIER);

    await stack.factory.write.setPoolFeeByCreator([pool.address, 47_000], {
      account: creator.account,
    });
    assert.equal(await pool.read.fee(), 47_000, "3.7% + 1%");

    // The right is spent, and it was the creator's alone.
    assert.equal(
      await stack.factory.read.poolCreator([pool.address]),
      "0x0000000000000000000000000000000000000000",
    );
    await assert.rejects(
      stack.factory.write.setPoolFeeByCreator([pool.address, 20_000], {
        account: creator.account,
      }),
      /not the pool creator/,
    );
  });

  it("refuses everyone who did not create the pool", async function () {
    const stack = await deployStack();
    const pool = await createPool(stack);

    for (const account of [other.account, deployer.account]) {
      await assert.rejects(
        stack.factory.write.setPoolFeeByCreator([pool.address, 20_000], { account }),
        /not the pool creator/,
      );
    }
    assert.equal(await pool.read.fee(), TIER, "and the fee did not move");
  });

  it("never lets a fee go up, or to nothing", async function () {
    const stack = await deployStack();
    const pool = await createPool(stack);

    await assert.rejects(
      stack.factory.write.setPoolFeeByCreator([pool.address, TIER + 1], {
        account: creator.account,
      }),
      /fee out of range/,
    );
    await assert.rejects(
      stack.factory.write.setPoolFeeByCreator([pool.address, 0], { account: creator.account }),
      /fee out of range/,
    );
    assert.equal(await pool.read.fee(), TIER);
  });

  it("keeps the tier as the pool's identity after the fee moves", async function () {
    const stack = await deployStack();
    const pool = await createPool(stack);
    await stack.factory.write.setPoolFeeByCreator([pool.address, 15_000], {
      account: creator.account,
    });

    // Where every swap path and every SDK looks for it is unchanged...
    assert.equal(
      (await stack.factory.read.getPool([stack.token0.address, stack.token1.address, TIER]))
        .toLowerCase(),
      pool.address.toLowerCase(),
    );
    // ...and the tier itself is still free for a second pool of the same pair? No: one pool per
    // pair per tier is the invariant, and lowering a fee must not quietly release it.
    await assert.rejects(
      stack.factory.write.createPool([stack.token0.address, stack.token1.address, TIER]),
    );
    assert.equal(await pool.read.tickSpacing(), SPACING);
  });

  it("is born taking nothing for the protocol", async function () {
    const stack = await deployStack();
    const pool = await createPool(stack);

    const slot0 = await pool.read.slot0();
    assert.equal(slot0[5], 0, "feeProtocol must be 0 on a fresh pool");

    // The owner can still turn it on, within the bounds the pool enforces.
    await stack.factory.write.setFeeProtocol([pool.address, 1000, 1000]);
    const after = await pool.read.slot0();
    assert.equal(after[5], 1000 + (1000 << 16));
  });

  it("caps every fee at the product's own maximum", async function () {
    const stack = await deployStack();
    const pool = await createPool(stack);

    assert.equal(await stack.factory.read.MAX_POOL_FEE(), 110_000, "10% creator + 1% protocol");
    await assert.rejects(
      stack.factory.write.setPoolFee([pool.address, 110_001]),
      /fee too high/,
    );
    await stack.factory.write.setPoolFee([pool.address, 110_000]);
    assert.equal(await pool.read.fee(), 110_000);
  });
});
