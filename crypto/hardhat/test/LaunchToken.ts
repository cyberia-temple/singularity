import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { network } from "hardhat";

/**
 * Holding the token is the claim: what a holder can take is what arrived while they were holding.
 *
 * The ledger is the standard magnified-per-share accumulator, and the things that break such a
 * ledger are all here: a holder arriving after money did, a balance moving between two
 * distributions, an account that must not earn at all (the pool holds most of the supply), money
 * arriving while nobody is eligible, and rounding -- which must always leave the contract able to
 * pay what it says it owes.
 */
describe("LaunchToken", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployer, alice, bob, carol] = await viem.getWalletClients();

  const ONE = 10n ** 18n;
  const SUPPLY = 1_000_000n * ONE;

  async function deployToken() {
    const wcyber = await viem.deployContract("WCYBER");
    const poolDeployer = await viem.deployContract("PancakeV3PoolDeployer");
    const factory = await viem.deployContract("PancakeV3Factory", [poolDeployer.address]);
    await poolDeployer.write.setFactoryAddress([factory.address]);

    // `launchpad` is whoever deployed it -- the test account here -- and the launchpad is never
    // a holder, so the supply starts with an ordinary address.
    const token = await viem.deployContract("LaunchToken", [
      "Lain", "LAIN", SUPPLY, alice.account.address, wcyber.address, factory.address,
    ]);
    return { token, wcyber, factory };
  }

  type Stack = Awaited<ReturnType<typeof deployToken>>;

  /**
   * The per-share ledger floors at every step, so a share can be a wei short of the arithmetic
   * ideal -- never over it, which is the direction that matters: the contract can always pay what
   * it says it owes. The dust stays here and joins the next round.
   */
  function assertAbout(actual: bigint, expected: bigint, what: string) {
    const diff = actual > expected ? actual - expected : expected - actual;
    assert.ok(actual <= expected, `${what}: ${actual} must never exceed ${expected}`);
    assert.ok(diff <= 2n, `${what}: ${actual} is not within a wei or two of ${expected}`);
  }

  /** Send WCYBER to the token the way the locker does, and let it count. */
  async function pay(stack: Stack, amount: bigint) {
    await stack.wcyber.write.deposit({ value: amount });
    await stack.wcyber.write.transfer([stack.token.address, amount]);
    await stack.token.write.distribute();
  }

  it("counts only the supply that can earn", async function () {
    const stack = await deployToken();
    assert.equal(await stack.token.read.eligibleSupply(), SUPPLY);
    assert.equal(await stack.token.read.totalSupply(), SUPPLY);

    // The launchpad that deployed it is not a holder, and neither is the burn address; the account
    // that received the supply is, which is why the eligible total is all of it.
    assert.equal(await stack.token.read.excluded([deployer.account.address]), true);
    assert.equal(
      await stack.token.read.excluded(["0x000000000000000000000000000000000000dEaD"]),
      true,
    );
    assert.equal(await stack.token.read.excluded([alice.account.address]), false);
  });

  it("splits what arrives in proportion to what is held", async function () {
    const stack = await deployToken();
    await stack.token.write.transfer([bob.account.address, 300_000n * ONE], {
      account: alice.account,
    });
    await stack.token.write.transfer([carol.account.address, 100_000n * ONE], {
      account: alice.account,
    });

    await pay(stack, 100n * ONE);

    assertAbout(await stack.token.read.withdrawableRewardsOf([bob.account.address]), 30n * ONE, "bob");
    assertAbout(await stack.token.read.withdrawableRewardsOf([carol.account.address]), 10n * ONE, "carol");
    assertAbout(await stack.token.read.withdrawableRewardsOf([alice.account.address]), 60n * ONE, "alice");
  });

  it("pays nobody for money that arrived before they held anything", async function () {
    const stack = await deployToken();
    await pay(stack, 100n * ONE);
    assertAbout(await stack.token.read.withdrawableRewardsOf([alice.account.address]), 100n * ONE, "alice");

    // Bob buys in after the fact, taking half the supply from Alice.
    await stack.token.write.transfer([bob.account.address, 500_000n * ONE], {
      account: alice.account,
    });

    assert.equal(await stack.token.read.withdrawableRewardsOf([bob.account.address]), 0n);
    assertAbout(await stack.token.read.withdrawableRewardsOf([alice.account.address]), 100n * ONE, "alice");

    // And the next round is split by the new balances.
    await pay(stack, 100n * ONE);
    assertAbout(await stack.token.read.withdrawableRewardsOf([bob.account.address]), 50n * ONE, "bob");
    assertAbout(await stack.token.read.withdrawableRewardsOf([alice.account.address]), 150n * ONE, "alice");
  });

  it("does not let a transfer move what has already been earned", async function () {
    const stack = await deployToken();
    await pay(stack, 100n * ONE);

    const earned = await stack.token.read.withdrawableRewardsOf([alice.account.address]);
    await stack.token.write.transfer([carol.account.address, SUPPLY], {
      account: alice.account,
    });

    assert.equal(await stack.token.read.balanceOf([alice.account.address]), 0n);
    assert.equal(
      await stack.token.read.withdrawableRewardsOf([alice.account.address]),
      earned,
      "an empty holder keeps what they earned while they were one",
    );
    assert.equal(await stack.token.read.withdrawableRewardsOf([carol.account.address]), 0n);
  });

  it("keeps an excluded pool out of the split entirely", async function () {
    const stack = await deployToken();
    // The launch flow names the pool while it is still empty; here a plain address stands in.
    await stack.token.write.setPool([carol.account.address]);
    assert.equal(await stack.token.read.excluded([carol.account.address]), true);

    await stack.token.write.transfer([carol.account.address, 900_000n * ONE], {
      account: alice.account,
    });
    assert.equal(await stack.token.read.eligibleSupply(), 100_000n * ONE);

    await pay(stack, 100n * ONE);
    assert.equal(await stack.token.read.withdrawableRewardsOf([carol.account.address]), 0n);
    assertAbout(
      await stack.token.read.withdrawableRewardsOf([alice.account.address]),
      100n * ONE,
      "the whole distribution went to the one account that can earn",
    );

    // Tokens leaving the pool re-enter the eligible supply.
    await stack.token.write.transfer([bob.account.address, 400_000n * ONE], {
      account: carol.account,
    });
    assert.equal(await stack.token.read.eligibleSupply(), 500_000n * ONE);
  });

  it("names its pool once, and only for the launchpad that made it", async function () {
    const stack = await deployToken();
    await assert.rejects(
      stack.token.write.setPool([bob.account.address], { account: alice.account }),
      /NOT_LAUNCHPAD/,
    );
    // An account holding tokens cannot be excluded, which is what keeps the ledger answerable.
    await assert.rejects(stack.token.write.setPool([alice.account.address]), /NOT_EMPTY/);

    await stack.token.write.setPool([bob.account.address]);
    await assert.rejects(stack.token.write.setPool([carol.account.address]), /POOL_SET/);
  });

  it("refuses to exclude an address that is not an empty pool of this token", async function () {
    const stack = await deployToken();
    await assert.rejects(stack.token.write.excludePool([alice.account.address]));

    // A real pool of this token, still empty, is the one thing it accepts.
    const other = await viem.deployContract("GOLD", [deployer.account.address]);
    await stack.factory.write.enableFeeAmount([110_000, 200]);
    await stack.factory.write.createPool([stack.token.address, other.address, 110_000]);
    const pool = await stack.factory.read.getPool([stack.token.address, other.address, 110_000]);

    await stack.token.write.excludePool([pool]);
    assert.equal(await stack.token.read.excluded([pool]), true);
    await assert.rejects(stack.token.write.excludePool([pool]), /ALREADY/);
  });

  it("holds money that arrived with nobody to pay, and pays the holders who come", async function () {
    const stack = await deployToken();
    await stack.token.write.setPool([carol.account.address]);
    await stack.token.write.transfer([carol.account.address, SUPPLY], {
      account: alice.account,
    }); // all of it in the "pool"
    assert.equal(await stack.token.read.eligibleSupply(), 0n);

    await stack.wcyber.write.deposit({ value: 100n * ONE });
    await stack.wcyber.write.transfer([stack.token.address, 100n * ONE]);
    await stack.token.write.distribute(); // nobody to pay: it credits nothing and keeps the money
    assert.equal(await stack.token.read.totalRewardsDistributed(), 0n);
    assert.equal(await stack.wcyber.read.balanceOf([stack.token.address]), 100n * ONE);

    // The first holder to appear is paid out of what was already sitting there.
    await stack.token.write.transfer([bob.account.address, 1000n * ONE], {
      account: carol.account,
    });
    await stack.token.write.distribute();
    assertAbout(await stack.token.read.withdrawableRewardsOf([bob.account.address]), 100n * ONE, "bob");
  });

  it("pays in the coin, or in the wrapper for a holder that cannot take the coin", async function () {
    const stack = await deployToken();
    await stack.token.write.transfer([bob.account.address, 500_000n * ONE], {
      account: alice.account,
    });
    await pay(stack, 100n * ONE);

    const wrappedBefore = await stack.wcyber.read.balanceOf([alice.account.address]);
    await stack.token.write.claimWrapped({ account: alice.account });
    assertAbout(
      (await stack.wcyber.read.balanceOf([alice.account.address])) - wrappedBefore,
      50n * ONE,
      "wrapped claim",
    );

    await pay(stack, 100n * ONE);
    const before = await publicClient.getBalance({ address: alice.account.address });
    const hash = await stack.token.write.claim({ account: alice.account });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const after = await publicClient.getBalance({ address: alice.account.address });
    assertAbout(after - before + receipt.gasUsed * receipt.effectiveGasPrice, 50n * ONE, "coin claim");
  });

  it("never books a claim it cannot pay", async function () {
    const stack = await deployToken();
    await stack.token.write.transfer([bob.account.address, 500_000n * ONE], {
      account: alice.account,
    });
    await pay(stack, 100n * ONE);

    await stack.token.write.claim({ account: alice.account });
    await stack.token.write.claim({ account: bob.account });

    // Everything credited has been paid, to the wei, and nothing is owed twice.
    const held = await stack.wcyber.read.balanceOf([stack.token.address]);
    assert.equal(await stack.token.read.totalRewardsClaimed(), 100n * ONE - held);
    await assert.rejects(stack.token.write.claim({ account: alice.account }), /NOTHING/);
  });

  it("takes the coin from nobody but the wrapper", async function () {
    const stack = await deployToken();
    await assert.rejects(
      deployer.sendTransaction({ to: stack.token.address, value: ONE }),
      /ONLY_WCYBER/,
    );
  });
});
