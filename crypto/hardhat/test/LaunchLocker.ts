import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

/**
 * A launch's liquidity is locked forever and still pays its creator.
 *
 * The v2 launchpad sends its LP token to 0x…dEaD, and with it the fees that LP would have earned:
 * in v2 fees compound into the reserves, and a burned LP can never redeem them. In v3 fees accrue
 * outside the position, so the position can be locked and the fees still collected. These tests
 * check that both halves of that hold -- the money comes out, the liquidity does not.
 */
describe("LaunchLocker", async function () {
  const { viem } = await network.connect();
  const [deployer, creator, trader, treasury, newOwner] = await viem.getWalletClients();

  const FEE_TIER = 2500;
  const TICK_SPACING = 50;
  const FULL_LOWER = Math.ceil(-887272 / TICK_SPACING) * TICK_SPACING;
  const FULL_UPPER = Math.floor(887272 / TICK_SPACING) * TICK_SPACING;
  const SQRT_PRICE_1_1 = 79228162514264337593543950336n;
  const MAX_UINT128 = (1n << 128n) - 1n;
  const ONE = 10n ** 18n;
  const CREATOR_BPS = 7000;

  async function deployStack() {
    const weth = await viem.deployContract("WCYBER");
    const a = await viem.deployContract("ETH", [deployer.account.address]);
    const b = await viem.deployContract("GOLD", [deployer.account.address]);

    const poolDeployer = await viem.deployContract("PancakeV3PoolDeployer");
    const factory = await viem.deployContract("PancakeV3Factory", [poolDeployer.address]);
    await poolDeployer.write.setFactoryAddress([factory.address]);
    const router = await viem.deployContract("SwapRouter", [
      poolDeployer.address, factory.address, weth.address,
    ]);
    const descriptor = await viem.deployContract("NonfungibleTokenPositionDescriptorOffChain");
    await descriptor.write.initialize(["https://cyberia.church/api/v3/positions/"]);
    const positions = await viem.deployContract("NonfungiblePositionManager", [
      poolDeployer.address, factory.address, weth.address, descriptor.address,
    ]);

    const locker = await viem.deployContract("LaunchLocker", [
      positions.address,
      treasury.account.address,
      CREATOR_BPS,
    ]);

    const [token0, token1] =
      a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];

    for (const token of [a, b]) {
      await token.write.mint([deployer.account.address, 1_000_000n * ONE]);
      await token.write.mint([trader.account.address, 1_000_000n * ONE]);
      await token.write.approve([positions.address, MAX_UINT128], { account: deployer.account });
      await token.write.approve([router.address, MAX_UINT128], { account: trader.account });
    }

    await positions.write.createAndInitializePoolIfNecessary([
      token0.address, token1.address, FEE_TIER, SQRT_PRICE_1_1,
    ]);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    await positions.write.mint([{
      token0: token0.address,
      token1: token1.address,
      fee: FEE_TIER,
      tickLower: FULL_LOWER,
      tickUpper: FULL_UPPER,
      amount0Desired: 100_000n * ONE,
      amount1Desired: 100_000n * ONE,
      amount0Min: 0n,
      amount1Min: 0n,
      recipient: deployer.account.address,
      deadline,
    }]);

    // the position minted first is tokenId 1
    const tokenId = 1n;
    return { factory, positions, router, locker, token0, token1, tokenId };
  }

  /** abi-encoded creator address, which is the only thing the locker accepts as transfer data */
  function creatorData(address: string) {
    return `0x${address.slice(2).toLowerCase().padStart(64, "0")}` as `0x${string}`;
  }

  async function lock(stack: Awaited<ReturnType<typeof deployStack>>, to = creator.account.address) {
    await stack.positions.write.safeTransferFrom(
      [deployer.account.address, stack.locker.address, stack.tokenId, creatorData(to)],
      { account: deployer.account },
    );
  }

  async function swap(stack: Awaited<ReturnType<typeof deployStack>>, amountIn: bigint) {
    await stack.router.write.exactInputSingle([{
      tokenIn: stack.token0.address,
      tokenOut: stack.token1.address,
      fee: FEE_TIER,
      recipient: trader.account.address,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      amountIn,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    }], { account: trader.account });
  }

  it("takes a position and records the creator and the split it was accepted under", async function () {
    const stack = await deployStack();
    await lock(stack);

    assert.equal(
      (await stack.positions.read.ownerOf([stack.tokenId])).toLowerCase(),
      stack.locker.address.toLowerCase(),
    );
    const [lockedCreator, bps, holdersBps, rewardsTo, locked] =
      await stack.locker.read.locks([stack.tokenId]);
    assert.equal(lockedCreator.toLowerCase(), creator.account.address.toLowerCase());
    assert.equal(bps, CREATOR_BPS);
    // a plain sender names no holder share and no reward token; both stay empty
    assert.equal(holdersBps, 0);
    assert.equal(rewardsTo, "0x0000000000000000000000000000000000000000");
    assert.equal(locked, true);
    assert.equal(await stack.locker.read.lockedCount(), 1n);
  });

  it("refuses a position that names no creator", async function () {
    const stack = await deployStack();

    await assert.rejects(
      stack.positions.write.safeTransferFrom(
        [deployer.account.address, stack.locker.address, stack.tokenId, "0x"],
        { account: deployer.account },
      ),
    );
    await assert.rejects(
      stack.positions.write.safeTransferFrom(
        [
          deployer.account.address,
          stack.locker.address,
          stack.tokenId,
          creatorData("0x0000000000000000000000000000000000000000"),
        ],
        { account: deployer.account },
      ),
    );
    // still with its owner, not stuck anywhere
    assert.equal(
      (await stack.positions.read.ownerOf([stack.tokenId])).toLowerCase(),
      deployer.account.address.toLowerCase(),
    );
  });

  it("pays the creator their share of the fees, and the treasury the rest", async function () {
    const stack = await deployStack();
    await lock(stack);
    await swap(stack, 10_000n * ONE);

    const [c0, c1, h0, , t0] = await stack.locker.read.claimable([stack.tokenId]);
    assert.equal(h0, 0n, "nobody promised holders anything on this lock");
    assert.ok(c0 > 0n, "creator should have token0 fees to claim");
    assert.equal(c1, 0n, "a one-way swap earns fees in the input token only");

    const creatorBefore = await stack.token0.read.balanceOf([creator.account.address]);
    const treasuryBefore = await stack.token0.read.balanceOf([treasury.account.address]);

    // anyone may call it: the creator should not need our key to be paid
    await stack.locker.write.collect([stack.tokenId], { account: trader.account });

    const creatorGot = (await stack.token0.read.balanceOf([creator.account.address])) - creatorBefore;
    const treasuryGot = (await stack.token0.read.balanceOf([treasury.account.address])) - treasuryBefore;

    assert.equal(creatorGot, c0);
    assert.equal(treasuryGot, t0);

    // the split is exact to the wei, and the rounding remainder goes to the treasury rather
    // than being left behind: creator = floor(total * bps / 10000), treasury = the rest
    const total = creatorGot + treasuryGot;
    assert.equal(creatorGot, (total * BigInt(CREATOR_BPS)) / 10_000n);
    assert.equal(treasuryGot, total - creatorGot);

    // 0.25% of the swap, less the protocol's default cut, reached the two of them
    assert.ok(creatorGot + treasuryGot > 0n);
    // and nothing was left behind in the locker
    assert.equal(await stack.token0.read.balanceOf([stack.locker.address]), 0n);
    assert.equal(await stack.token1.read.balanceOf([stack.locker.address]), 0n);
  });

  it("cannot be made to give the position back", async function () {
    const stack = await deployStack();
    await lock(stack);

    // there is no decreaseLiquidity, no burn and no transfer on this contract at all
    const abi = stack.locker.abi as Array<{ type: string; name?: string }>;
    const names = abi.filter((f) => f.type === "function").map((f) => f.name);
    for (const forbidden of [
      "decreaseLiquidity",
      "burn",
      "transferFrom",
      "safeTransferFrom",
      "approve",
      "setApprovalForAll",
      "execute",
      "call",
    ]) {
      assert.ok(!names.includes(forbidden), `LaunchLocker must not expose ${forbidden}`);
    }

    // and the position manager still says the locker owns it after fees have been taken out
    await swap(stack, 1_000n * ONE);
    await stack.locker.write.collect([stack.tokenId]);
    assert.equal(
      (await stack.positions.read.ownerOf([stack.tokenId])).toLowerCase(),
      stack.locker.address.toLowerCase(),
    );
    const position = await stack.positions.read.positions([stack.tokenId]);
    assert.ok((position[7] as bigint) > 0n, "liquidity must still be in the position");
  });

  it("lets the creator hand the fee stream on, and nobody else", async function () {
    const stack = await deployStack();
    await lock(stack);

    await assert.rejects(
      stack.locker.write.setCreator([stack.tokenId, trader.account.address], {
        account: deployer.account,
      }),
      /NOT_CREATOR/,
    );

    await stack.locker.write.setCreator([stack.tokenId, newOwner.account.address], {
      account: creator.account,
    });

    await swap(stack, 5_000n * ONE);
    const before = await stack.token0.read.balanceOf([newOwner.account.address]);
    await stack.locker.write.collect([stack.tokenId]);
    assert.ok((await stack.token0.read.balanceOf([newOwner.account.address])) > before);
  });

  it("keeps an existing launch on the terms it was accepted under", async function () {
    const stack = await deployStack();
    await lock(stack);

    // the owner is free to retune the default for everything that comes later
    await stack.locker.write.setDefaultCreatorBps([2000]);
    assert.equal(await stack.locker.read.defaultCreatorBps(), 2000);

    // but this launch keeps 70%, which is what it was promised
    const [, bps] = await stack.locker.read.locks([stack.tokenId]);
    assert.equal(bps, CREATOR_BPS);

    await swap(stack, 10_000n * ONE);
    const [c0, , , , t0] = await stack.locker.read.claimable([stack.tokenId]);
    assert.equal(c0, ((c0 + t0) * BigInt(CREATOR_BPS)) / 10_000n);
  });

  it("guards its own settings", async function () {
    const stack = await deployStack();

    await assert.rejects(
      stack.locker.write.setDefaultCreatorBps([5000], { account: creator.account }),
      /NOT_OWNER/,
    );
    await assert.rejects(stack.locker.write.setDefaultCreatorBps([10001]), /BPS/);
    await assert.rejects(
      stack.locker.write.setTreasury(["0x0000000000000000000000000000000000000000"]),
      /ZERO/,
    );
    await assert.rejects(stack.locker.read.claimable([999n]), /NOT_LOCKED/);
    await assert.rejects(stack.locker.write.collect([999n]), /NOT_LOCKED/);
  });

  it("takes positions only from the position manager it was built for", async function () {
    const stack = await deployStack();
    await assert.rejects(
      stack.locker.write.onERC721Received([
        deployer.account.address,
        deployer.account.address,
        stack.tokenId,
        creatorData(creator.account.address),
      ]),
      /NOT_POSITION/,
    );
  });
});
