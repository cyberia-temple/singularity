import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

/**
 * Cyberia's PancakeSwap V3 fork: the swap fee of a live pool is settable by the factory owner.
 *
 * What these tests are actually guarding:
 *   - the whole v3 stack deploys and swaps on an EVM no newer than london (solc 0.7.6 / istanbul);
 *   - POOL_INIT_CODE_HASH in the periphery matches the pool this repo compiles, so every address
 *     the router and the position manager derive is the pool that really exists;
 *   - changing a pool's fee changes what a swap costs, and changes nothing else -- not the pool's
 *     address, not its tier in `getPool`, not its tick spacing, not the fees already accrued;
 *   - the fee is bounded by MAX_FEE and reachable only through the factory owner.
 */
describe("PancakeV3 mutable swap fee", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, trader] = await viem.getWalletClients();

  const FEE_TIER = 2500; // 0.25%, tick spacing 50
  const TICK_SPACING = 50;
  const MIN_TICK = -887272;
  const MAX_TICK = 887272;
  const FULL_LOWER = Math.ceil(MIN_TICK / TICK_SPACING) * TICK_SPACING;
  const FULL_UPPER = Math.floor(MAX_TICK / TICK_SPACING) * TICK_SPACING;
  const SQRT_PRICE_1_1 = 79228162514264337593543950336n; // 2**96, price 1:1
  const MAX_UINT128 = (1n << 128n) - 1n;
  const ONE = 10n ** 18n;

  async function deployStack() {
    const weth = await viem.deployContract("WCYBER");

    // Two plain 18-decimal owner-mintable ERC20s already in this repo.
    const a = await viem.deployContract("ETH", [deployer.account.address]);
    const b = await viem.deployContract("GOLD", [deployer.account.address]);

    const poolDeployer = await viem.deployContract("PancakeV3PoolDeployer");
    const factory = await viem.deployContract("PancakeV3Factory", [poolDeployer.address]);
    await poolDeployer.write.setFactoryAddress([factory.address]);

    const router = await viem.deployContract("SwapRouter", [
      poolDeployer.address,
      factory.address,
      weth.address,
    ]);
    const descriptor = await viem.deployContract("NonfungibleTokenPositionDescriptorOffChain");
    await descriptor.write.initialize(["https://cyberia.church/nft/v3/"]);
    const positionManager = await viem.deployContract("NonfungiblePositionManager", [
      poolDeployer.address,
      factory.address,
      weth.address,
      descriptor.address,
    ]);
    const quoter = await viem.deployContract("QuoterV2", [
      poolDeployer.address,
      factory.address,
      weth.address,
    ]);

    // sorted, the way every pool key in v3 is
    const [token0, token1] =
      a.address.toLowerCase() < b.address.toLowerCase() ? [a, b] : [b, a];

    for (const token of [a, b]) {
      await token.write.mint([deployer.account.address, 1_000_000n * ONE]);
      await token.write.mint([trader.account.address, 1_000_000n * ONE]);
      await token.write.approve([positionManager.address, MAX_UINT128], {
        account: deployer.account,
      });
      await token.write.approve([router.address, MAX_UINT128], { account: trader.account });
    }

    await positionManager.write.createAndInitializePoolIfNecessary([
      token0.address,
      token1.address,
      FEE_TIER,
      SQRT_PRICE_1_1,
    ]);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    await positionManager.write.mint([
      {
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
      },
    ]);

    const poolAddress = await factory.read.getPool([token0.address, token1.address, FEE_TIER]);
    const pool = await viem.getContractAt("PancakeV3Pool", poolAddress);

    return { factory, poolDeployer, router, positionManager, quoter, pool, token0, token1 };
  }

  async function quote(quoter: any, tokenIn: string, tokenOut: string, amountIn: bigint) {
    const { result } = await quoter.simulate.quoteExactInputSingle([
      { tokenIn, tokenOut, amountIn, fee: FEE_TIER, sqrtPriceLimitX96: 0n },
    ]);
    return result[0] as bigint;
  }

  it("the stack deploys and a swap goes through on an istanbul-target EVM", async function () {
    const { pool, quoter, router, token0, token1 } = await deployStack();

    assert.equal(await pool.read.fee(), FEE_TIER);
    assert.equal(await pool.read.tickSpacing(), TICK_SPACING);
    assert.ok((await pool.read.liquidity()) > 0n);

    const amountIn = 1_000n * ONE;
    const expected = await quote(quoter, token0.address, token1.address, amountIn);
    assert.ok(expected > 0n);

    const before = await token1.read.balanceOf([trader.account.address]);
    await router.write.exactInputSingle(
      [
        {
          tokenIn: token0.address,
          tokenOut: token1.address,
          fee: FEE_TIER,
          recipient: trader.account.address,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
          amountIn,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
      { account: trader.account },
    );
    const after = await token1.read.balanceOf([trader.account.address]);

    // The quoter simulates the real pool, so it must agree with the swap exactly.
    assert.equal(after - before, expected);
  });

  it("lowering a live pool's fee makes the same swap pay out more", async function () {
    const { factory, pool, quoter, token0, token1 } = await deployStack();
    const amountIn = 1_000n * ONE;

    const at2500 = await quote(quoter, token0.address, token1.address, amountIn);

    await factory.write.setPoolFee([pool.address, 500]);
    assert.equal(await pool.read.fee(), 500);

    const at500 = await quote(quoter, token0.address, token1.address, amountIn);
    assert.ok(at500 > at2500, `expected more out at 0.05% than at 0.25%, got ${at500} vs ${at2500}`);

    // 0.25% -> 0.05% hands 0.2% of the input back to the trader, minus the extra price impact
    // that the no-longer-taken fee causes by staying in the swap. Within a few percent of 0.2%.
    const gain = at500 - at2500;
    const expectedGain = (amountIn * 2n) / 1000n;
    assert.ok(
      gain > (expectedGain * 95n) / 100n && gain <= expectedGain,
      `fee delta off: gained ${gain}, expected a little under ${expectedGain}`,
    );
  });

  it("the pool keeps its address, its tier and its tick spacing when the fee moves", async function () {
    const { factory, pool, token0, token1 } = await deployStack();

    await factory.write.setPoolFee([pool.address, 10000]);

    // Still filed under the tier in its CREATE2 salt -- the tier is the pool's identity, the fee is a setting.
    assert.equal(
      (await factory.read.getPool([token0.address, token1.address, FEE_TIER])).toLowerCase(),
      pool.address.toLowerCase(),
    );
    assert.equal(await factory.read.getPool([token0.address, token1.address, 10000]), "0x0000000000000000000000000000000000000000");
    assert.equal(await pool.read.tickSpacing(), TICK_SPACING);
    assert.equal(await pool.read.fee(), 10000);
  });

  it("fees already earned are not touched by a fee change", async function () {
    const { factory, pool, router, token0, token1 } = await deployStack();

    await router.write.exactInputSingle(
      [
        {
          tokenIn: token0.address,
          tokenOut: token1.address,
          fee: FEE_TIER,
          recipient: trader.account.address,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
          amountIn: 1_000n * ONE,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        },
      ],
      { account: trader.account },
    );

    const earned = await pool.read.feeGrowthGlobal0X128();
    assert.ok(earned > 0n);

    await factory.write.setPoolFee([pool.address, 100]);
    assert.equal(await pool.read.feeGrowthGlobal0X128(), earned);
  });

  it("only the factory owner may set the fee, and never above MAX_FEE", async function () {
    const { factory, pool } = await deployStack();

    // 11% is the launchpad's ceiling: 10% to the creator plus 1% to the protocol.
    assert.equal(await factory.read.MAX_POOL_FEE(), 110000);

    await assert.rejects(
      factory.write.setPoolFee([pool.address, 500], { account: trader.account }),
      /Not owner/,
    );
    // the pool answers to the factory and to nobody else, owner included
    await assert.rejects(pool.write.setFee([500], { account: trader.account }));
    await assert.rejects(pool.write.setFee([500], { account: deployer.account }));
    await assert.rejects(factory.write.setPoolFee([pool.address, 110001]), /fee too high/);

    // the ceiling itself is allowed
    await factory.write.setPoolFee([pool.address, 110000]);
    assert.equal(await pool.read.fee(), 110000);
  });

  it("PancakeV3PoolDeployer still fits under EIP-170", async function () {
    // The deployer carries the pool's entire creation code as a literal, so the pool's size is
    // spent against the deployer's 24576-byte runtime limit -- not against the pool's own.
    // Upstream ships with about 19 bytes to spare; the mutable fee spends most of what is left.
    // If this fails, the pool cannot be deployed at all, and no test after it would run either:
    // buy room by giving the deployer an external code holder, not by trimming the fee logic.
    const artifact = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        "artifacts/contracts/pancake-v3-core/PancakeV3PoolDeployer.sol/PancakeV3PoolDeployer.json",
        "utf8",
      ),
    );
    const runtime = JSON.parse(artifact).deployedBytecode as string;
    const size = (runtime.startsWith("0x") ? runtime.slice(2) : runtime).length / 2;
    console.log(`    PancakeV3PoolDeployer runtime ${size} bytes, ${24576 - size} to spare`);
    assert.ok(size <= 24576, `PancakeV3PoolDeployer is ${size - 24576} bytes over EIP-170`);
  });

  it("reports deployment gas for the stack", async function () {
    const weth = await viem.deployContract("WCYBER");
    const measured: Array<[string, bigint]> = [];

    async function measure(name: string, deploy: () => Promise<{ address: `0x${string}` }>) {
      const before = await publicClient.getBlockNumber();
      const contract = await deploy();
      const block = await publicClient.getBlock({ blockNumber: before + 1n });
      const receipt = await publicClient.getTransactionReceipt({ hash: block.transactions[0] });
      measured.push([name, receipt.gasUsed]);
      return contract;
    }

    const poolDeployer = await measure("PancakeV3PoolDeployer", () =>
      viem.deployContract("PancakeV3PoolDeployer"),
    );
    const factory = await measure("PancakeV3Factory", () =>
      viem.deployContract("PancakeV3Factory", [poolDeployer.address]),
    );
    await (poolDeployer as any).write.setFactoryAddress([factory.address]);
    await measure("SwapRouter", () =>
      viem.deployContract("SwapRouter", [poolDeployer.address, factory.address, weth.address]),
    );
    const descriptor = await measure("PositionDescriptorOffChain", () =>
      viem.deployContract("NonfungibleTokenPositionDescriptorOffChain"),
    );
    await measure("NonfungiblePositionManager", () =>
      viem.deployContract("NonfungiblePositionManager", [
        poolDeployer.address,
        factory.address,
        weth.address,
        descriptor.address,
      ]),
    );
    await measure("QuoterV2", () =>
      viem.deployContract("QuoterV2", [poolDeployer.address, factory.address, weth.address]),
    );

    const total = measured.reduce((sum, [, gas]) => sum + gas, 0n);
    for (const [name, gas] of measured) {
      console.log(`    ${name.padEnd(30)} ${gas.toString().padStart(10)} gas`);
    }
    console.log(`    ${"TOTAL".padEnd(30)} ${total.toString().padStart(10)} gas`);

    // Cyberia's block gas limit is 30,000,000: no single deploy may exceed it.
    for (const [name, gas] of measured) {
      assert.ok(gas < 30_000_000n, `${name} does not fit in a Cyberia block`);
    }
  });
});
