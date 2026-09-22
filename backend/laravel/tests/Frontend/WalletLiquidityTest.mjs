import assert from 'node:assert/strict';
import test from 'node:test';
import { CYBERIA_CHAIN_ID } from '@/lib/evmChains';
import {
    canAddLiquidity,
    mintedLp,
    pairedAmount,
    poolShareAfter,
    sqrtBigInt,
    withdrawalLp,
    wrappedSide,
} from '@/lib/wallet/liquidity';
import { swapChainFor } from '@/lib/wallet/swap';

/**
 * The arithmetic behind making a pool position.
 *
 * All of it is the pair contract's own, reimplemented in a browser so that a
 * person can read what they are about to sign — which is exactly why it is
 * pinned. A swap that quotes badly is a bad price somebody can see; a deposit
 * that pairs badly is the router quietly keeping the side that fits and
 * handing back the rest, and the screen reporting a position nobody has.
 */

const ONE = 1_000_000_000_000_000_000n;

const asset = (address, symbol, decimals = 18) => ({
    address,
    symbol,
    decimals,
});

const COIN = asset(null, 'CYBER');
const USDC = asset('0x1111111111111111111111111111111111111111', 'USDC', 6);

test('the second side of a deposit is the pool price, not a guess', () => {
    // 1000 : 2000 — every unit of the first side is worth two of the second.
    assert.equal(pairedAmount(ONE, ONE * 1000n, ONE * 2000n), ONE * 2n);
    assert.equal(
        pairedAmount(ONE * 3n, ONE * 2000n, ONE * 1000n),
        ONE + ONE / 2n,
    );
});

test('an empty pool has no ratio to pair against', () => {
    assert.equal(pairedAmount(ONE, 0n, ONE * 10n), null);
    assert.equal(pairedAmount(ONE, ONE * 10n, 0n), null);
    assert.equal(pairedAmount(0n, ONE, ONE), null);
});

test('the square root is a floor and never a float', () => {
    assert.equal(sqrtBigInt(0n), 0n);
    assert.equal(sqrtBigInt(1n), 1n);
    assert.equal(sqrtBigInt(3n), 1n);
    assert.equal(sqrtBigInt(4n), 2n);
    assert.equal(sqrtBigInt(4n * ONE * ONE), 2n * ONE);
    // A number no float could hold to the unit, which is the whole point.
    assert.equal(sqrtBigInt(ONE * ONE + 1n), ONE);
});

test('the first deposit is paid the geometric mean, less what the pair burns', () => {
    // sqrt(1e18 * 4e18) = 2e18, and a thousand units stay in the pair forever.
    assert.equal(mintedLp(ONE, ONE * 4n, 0n, 0n, 0n), ONE * 2n - 1000n);
});

test('a first deposit too small to cover the burned minimum mints nothing', () => {
    assert.equal(mintedLp(10n, 10n, 0n, 0n, 0n), 0n);
});

test('every later deposit is paid for its smaller side', () => {
    const reserveA = ONE * 1000n;
    const reserveB = ONE * 2000n;
    const supply = ONE * 1000n;

    // Paired at the pool's own ratio: both sides agree, and both are paid.
    assert.equal(mintedLp(ONE, ONE * 2n, reserveA, reserveB, supply), ONE);

    // Five times too much of the second side buys nothing extra — which is
    // the pair refusing a lopsided deposit, and the reason this wallet
    // derives the second amount instead of letting somebody type it.
    assert.equal(mintedLp(ONE, ONE * 10n, reserveA, reserveB, supply), ONE);
});

test('the share is measured against the pool this deposit joins', () => {
    // One into a thousand is a thousandth of the pool *after* the mint.
    assert.equal(poolShareAfter(ONE, ONE * 999n), 0.001);
    assert.equal(poolShareAfter(0n, ONE * 999n), 0);
    assert.equal(poolShareAfter(ONE, 0n), 1);
});

test('a refusal names which side is the problem', () => {
    const base = {
        first: COIN,
        second: USDC,
        amountFirst: ONE,
        amountSecond: 1_000_000n,
        balanceFirst: ONE * 10n,
        balanceSecond: 10_000_000n,
    };

    assert.equal(canAddLiquidity(base), 'ok');
    assert.equal(canAddLiquidity({ ...base, second: null }), 'empty');
    assert.equal(canAddLiquidity({ ...base, second: COIN }), 'sameAsset');
    assert.equal(canAddLiquidity({ ...base, amountSecond: 0n }), 'empty');
    assert.equal(
        canAddLiquidity({ ...base, balanceFirst: ONE / 2n }),
        'shortFirst',
    );
    assert.equal(
        canAddLiquidity({ ...base, balanceSecond: 1n }),
        'shortSecond',
    );
});

test('the same token as itself is refused however it is spelled', () => {
    const upper = asset(USDC.address.toUpperCase(), 'USDC', 6);

    assert.equal(
        canAddLiquidity({
            first: USDC,
            second: upper,
            amountFirst: 1n,
            amountSecond: 1n,
            balanceFirst: null,
            balanceSecond: null,
        }),
        'sameAsset',
    );
});

test('a balance nobody could read never refuses a deposit on its own', () => {
    assert.equal(
        canAddLiquidity({
            first: COIN,
            second: USDC,
            amountFirst: ONE,
            amountSecond: 1_000_000n,
            balanceFirst: null,
            balanceSecond: null,
        }),
        'ok',
    );
});

test('a withdrawal takes a percentage of the LP and never more than all', () => {
    assert.equal(withdrawalLp(ONE, 100), ONE);
    assert.equal(withdrawalLp(ONE, 25), ONE / 4n);
    assert.equal(withdrawalLp(ONE, 0), 0n);
    assert.equal(withdrawalLp(ONE, 250), ONE);
    assert.equal(withdrawalLp(ONE, -5), 0n);
});

test('the wrapped coin is found on either side of a pool, or not at all', () => {
    const config = swapChainFor(CYBERIA_CHAIN_ID);
    const wrapped = config.wrappedNative;
    const other = '0x2222222222222222222222222222222222222222';

    const position = (tokens) => ({
        pair: '0x3333333333333333333333333333333333333333',
        tokens,
        symbols: ['A', 'B'],
        decimals: [18, 18],
        balance: ONE,
        totalSupply: ONE,
        reserves: [ONE, ONE],
    });

    assert.equal(wrappedSide(position([wrapped, other]), config), 0);
    assert.equal(wrappedSide(position([other, wrapped]), config), 1);
    // Lowercased, because an address off an explorer arrives however it likes.
    assert.equal(
        wrappedSide(position([other, wrapped.toLowerCase()]), config),
        1,
    );
    assert.equal(wrappedSide(position([other, other]), config), null);
});
