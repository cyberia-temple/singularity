import assert from 'node:assert/strict';
import test from 'node:test';
import {
    STAKE_GAS_CAP,
    accrue,
    canStake,
    canUnstake,
    earnChainFor,
    hasEarn,
    poolShare,
} from '@/lib/wallet/earn';

/**
 * The parts of farming that decide what gets signed.
 *
 * A stake is a plain ERC-20 deposit, so the arithmetic is small — and that is
 * exactly why it is pinned here: the two numbers on this screen are somebody's
 * whole position, and an off-by-a-share renders a stake as a fraction of
 * itself without anything failing.
 */

const ONE = 1_000_000_000_000_000_000n;

test('a share of a pool is a claim on both reserves', () => {
    const { share, amounts } = poolShare(ONE, ONE * 4n, [
        ONE * 1000n,
        2_000_000_000n,
    ]);

    assert.equal(share, 0.25);
    assert.equal(amounts[0], ONE * 250n);
    // The second side has six decimals, and nothing here knows that or needs
    // to: a quarter of the reserve is a quarter of the reserve.
    assert.equal(amounts[1], 500_000_000n);
});

test('an unfunded pool has no share rather than a division by zero', () => {
    assert.deepEqual(poolShare(ONE, 0n, [0n, 0n]), {
        share: 0,
        amounts: [0n, 0n],
    });
    assert.deepEqual(poolShare(0n, ONE, [ONE, ONE]), {
        share: 0,
        amounts: [0n, 0n],
    });
});

test('a dust position keeps a real share instead of rounding to nothing', () => {
    // A millionth of a large pool: computed as a float division of two bigints
    // this is either zero or Infinity, which is why it goes through integers.
    const { share, amounts } = poolShare(ONE, ONE * 1_000_000n, [
        ONE * 1_000_000n,
        ONE * 2_000_000n,
    ]);

    assert.ok(share > 0);
    assert.equal(amounts[0], ONE);
    assert.equal(amounts[1], ONE * 2n);
});

test('staking refuses in the vocabulary the user can act on', () => {
    assert.equal(canStake(ONE, ONE * 2n), 'ok');
    assert.equal(canStake(0n, ONE), 'empty');
    assert.equal(canStake(ONE * 3n, ONE), 'tooMuch');

    // The whole balance is stakeable — the fee is paid in the coin, not in LP.
    assert.equal(canStake(ONE, ONE), 'ok');
});

test('unstaking tells "nothing staked" apart from "too much"', () => {
    assert.equal(canUnstake(ONE, ONE * 2n), 'ok');
    assert.equal(canUnstake(ONE, 0n), 'nothingStaked');
    assert.equal(canUnstake(ONE * 3n, ONE), 'tooMuch');
    assert.equal(canUnstake(0n, ONE), 'empty');
});

test('the farm registry answers for Cyberia and refuses to guess', () => {
    assert.equal(hasEarn(49406), true);
    assert.equal(hasEarn(1), false);
    assert.equal(hasEarn(undefined), false);

    assert.equal(earnChainFor(49406).chainId, 49406);
    // Never a silent fallback to another chain's chef: staking into the wrong
    // farm is a transfer of LP to a contract that does not know it.
    assert.throws(() => earnChainFor(1));
});

test('the gas ceiling is a promise, not a guess', () => {
    // A MasterChef deposit updates one pool and one user record and pays out
    // the accrued reward on the way — well inside this, and the unused part
    // comes back.
    assert.ok(STAKE_GAS_CAP >= 200_000n);
});

/**
 * Carrying a reward forward between reads.
 *
 * The screen polls the chain's head and projects the reward from the block it
 * last read a real figure at, so a farm shows that it is working instead of a
 * frozen number that only moves when somebody reloads. Everything below is
 * about that projection agreeing with the chef rather than approximating it.
 */

test('a span of blocks is priced the way the chef prices it', () => {
    // rewardPerBlock 1 CYBER, this pool holds a third of the emission, and the
    // account holds the whole pool: three blocks pay one whole reward.
    assert.equal(
        accrue({
            blocks: 3,
            rewardPerBlock: ONE,
            allocPoint: 1n,
            totalAllocPoint: 3n,
            staked: ONE,
            totalStaked: ONE,
        }),
        ONE,
    );
});

test('the whole span is divided once, never a block at a time', () => {
    const span = {
        rewardPerBlock: 10n,
        allocPoint: 1n,
        totalAllocPoint: 3n,
        staked: 1n,
        totalStaked: 1n,
    };

    // Three blocks in one go: 30/3 = 10, exactly.
    assert.equal(accrue({ ...span, blocks: 3 }), 10n);

    // The same three blocks counted one at a time lose the remainder every
    // time — 10/3 = 3, three times, is 9. This is why the projection takes the
    // block *difference* and never loops, and why a ticker built the obvious
    // way would quietly under-report a farm forever.
    const looped = accrue({ ...span, blocks: 1 }) * 3n;

    assert.equal(looped, 9n);
    assert.notEqual(looped, accrue({ ...span, blocks: 3 }));
});

test('a share of the pool is a share of the reward', () => {
    const base = {
        blocks: 10,
        rewardPerBlock: ONE,
        allocPoint: 1n,
        totalAllocPoint: 1n,
        totalStaked: ONE * 4n,
    };

    assert.equal(accrue({ ...base, staked: ONE }), (ONE * 10n) / 4n);
    assert.equal(accrue({ ...base, staked: ONE * 4n }), ONE * 10n);
});

test('nothing is projected out of a denominator that does not exist', () => {
    const base = {
        blocks: 5,
        rewardPerBlock: ONE,
        allocPoint: 1n,
        totalAllocPoint: 1n,
        staked: ONE,
        totalStaked: ONE,
    };

    // A pool nobody has staked in pays nothing, and an account with no stake
    // earns nothing — neither is a division this is allowed to attempt.
    assert.equal(accrue({ ...base, totalStaked: 0n }), 0n);
    assert.equal(accrue({ ...base, staked: 0n }), 0n);
    assert.equal(accrue({ ...base, totalAllocPoint: 0n }), 0n);
    // A pool carrying no weight is switched off, not merely quiet.
    assert.equal(accrue({ ...base, allocPoint: 0n }), 0n);
    // A farm that pays nothing per block projects nothing.
    assert.equal(accrue({ ...base, rewardPerBlock: 0n }), 0n);
});

test('a chain that has not moved, or moved backwards, adds nothing', () => {
    const base = {
        rewardPerBlock: ONE,
        allocPoint: 1n,
        totalAllocPoint: 1n,
        staked: ONE,
        totalStaked: ONE,
    };

    assert.equal(accrue({ ...base, blocks: 0 }), 0n);
    // A reorg, or a node behind the one the anchor came from. Either way the
    // reward does not run backwards on screen.
    assert.equal(accrue({ ...base, blocks: -4 }), 0n);
});
