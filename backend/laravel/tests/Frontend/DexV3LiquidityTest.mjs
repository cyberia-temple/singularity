import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, ZeroAddress } from 'ethers';
import {
    MAX_TICK,
    MAX_UINT128,
    MIN_TICK,
    Q96,
    V3_POSITION_MANAGER_ABI,
    amountsForLiquidity,
    fullRangeTicks,
    initialSqrtPriceX96,
    liquidityForAmounts,
    pairedAmount,
    priceAtTick,
    rangeStatus,
    rangeTicksAround,
    snapTick,
    sqrtRatioAtTick,
    tickAtPrice,
    v3DepositCalls,
    v3WithdrawCalls,
    withSlippage,
} from '@/lib/dexV3Positions';

/**
 * The parts of a v3 position that are arithmetic rather than a call.
 *
 * A wrong number here is not an error anywhere — it is a range that is not
 * where the screen said it was, a deposit ratio the pool quietly refunds half
 * of, or a withdrawal that credits tokens and pays nothing out. So the tick
 * table is pinned to the contracts' own constants, the ratio math to the
 * round trip it must satisfy, and the two plans to the call order that makes
 * them true.
 */

const iface = new Interface(V3_POSITION_MANAGER_ABI);
const names = (calls) =>
    calls.map((c) => iface.parseTransaction({ data: c }).name);
const arg = (call, index) => iface.parseTransaction({ data: call }).args[index];

const WCYBER = '0x78272aAd03E4b9d7A9134e874BA6d419B534F6c9';
const USDC = '0xdc25597B19799010047F17e9591EFE08EFd40077';
const ME = '0xfA41267C5E2390E941A12b0b8e566448539A5179';
const SPACING = 50;

test('the tick table answers what the contracts answer', () => {
    // TickMath.sol's own constants: tick zero is 1.0 in Q64.96, and the two
    // extremes are the MIN_SQRT_RATIO/MAX_SQRT_RATIO the pool refuses to cross.
    assert.equal(sqrtRatioAtTick(0), Q96);
    assert.equal(sqrtRatioAtTick(MIN_TICK), 4295128739n);
    assert.equal(
        sqrtRatioAtTick(MAX_TICK),
        1461446703485210103287273052203988822378723970342n,
    );
    assert.throws(() => sqrtRatioAtTick(MAX_TICK + 1), /representable/);
});

test('the tick table agrees with the exponential it stands for', () => {
    // An independent derivation of the same number: sqrt(1.0001^tick) * 2^96.
    // A mistyped constant in the ported table is off by orders of magnitude,
    // so a relative tolerance of a billionth is a decisive check and not a
    // loose one.
    for (const tick of [-887272, -500000, -60000, -1000, -1, 0, 1, 1000, 60000, 500000, 887271]) {
        const mine = Number(sqrtRatioAtTick(tick)) / 2 ** 96;
        const expected = 1.0001 ** (tick / 2);

        assert.ok(
            Math.abs(mine / expected - 1) < 1e-9,
            `tick ${tick}: ${mine} vs ${expected}`,
        );
    }
});

test('one tick is one basis point of price, in both directions', () => {
    assert.ok(Math.abs(priceAtTick(1, 18, 18) - 1.0001) < 1e-9);
    assert.ok(Math.abs(priceAtTick(-1, 18, 18) - 1 / 1.0001) < 1e-9);
    assert.ok(sqrtRatioAtTick(-100) < sqrtRatioAtTick(0));
    assert.ok(sqrtRatioAtTick(100) > sqrtRatioAtTick(0));
});

test('a price and its tick survive the round trip, decimals included', () => {
    // The pair that makes this matter: USDC is 6 decimals and the coin is 18,
    // so the raw ratio a tick encodes is 10^12 away from the price on screen.
    const tick = tickAtPrice(0.0042, 18, 6);

    assert.ok(Math.abs(priceAtTick(tick, 18, 6) / 0.0042 - 1) < 1e-4);
    assert.throws(() => tickAtPrice(0, 18, 6), /positive price/);
});

test('a tick is snapped to the spacing, and the full range is what fits', () => {
    assert.equal(snapTick(1234, SPACING), 1250);
    assert.equal(snapTick(1234, SPACING, 'down'), 1200);
    assert.equal(snapTick(1234, SPACING, 'up'), 1250);

    const [lower, upper] = fullRangeTicks(SPACING);

    assert.ok(lower % SPACING === 0);
    assert.ok(upper % SPACING === 0);
    assert.ok(lower >= MIN_TICK && upper <= MAX_TICK);
    assert.equal(lower, -upper);
});

test('a ±% range is symmetric in the space ticks live in', () => {
    const [lower, upper] = rangeTicksAround(0, 1, 25);

    // 0.75x down and 1/0.75x up: the same distance either way, which is what
    // "±25%" has to mean for a range that is not lopsided towards the upside.
    assert.ok(Math.abs(priceAtTick(lower, 18, 18) - 0.75) < 0.001);
    assert.ok(Math.abs(priceAtTick(upper, 18, 18) - 1 / 0.75) < 0.002);
    assert.deepEqual(rangeTicksAround(0, SPACING, 0), fullRangeTicks(SPACING));
    assert.deepEqual(
        rangeTicksAround(0, SPACING, 100),
        fullRangeTicks(SPACING),
    );
});

test('the first price of a pool is computed in integers', () => {
    // 1 WCYBER = 0.0042 USDC, as the two raw amounts that state it.
    const sqrt = initialSqrtPriceX96(4200n, 10n ** 18n);

    assert.ok(sqrt > 0n);
    assert.throws(() => initialSqrtPriceX96(0n, 10n ** 18n), /both sides/);
});

test('a range decides the deposit ratio, and outside it there is only one side', () => {
    const lower = sqrtRatioAtTick(-1000);
    const upper = sqrtRatioAtTick(1000);
    const inside = sqrtRatioAtTick(0);

    assert.equal(rangeStatus(inside, lower, upper), 'in');
    assert.equal(rangeStatus(sqrtRatioAtTick(-2000), lower, upper), 'below');
    assert.equal(rangeStatus(sqrtRatioAtTick(2000), lower, upper), 'above');

    // Below the range the position is all token0, above it all token1 — so the
    // side that cannot be deposited answers null rather than zero, which is a
    // different sentence on screen.
    assert.equal(
        pairedAmount(sqrtRatioAtTick(-2000), lower, upper, 1, 10n ** 18n),
        null,
    );
    assert.equal(
        pairedAmount(sqrtRatioAtTick(-2000), lower, upper, 0, 10n ** 18n),
        0n,
    );
    assert.equal(
        pairedAmount(sqrtRatioAtTick(2000), lower, upper, 0, 10n ** 18n),
        null,
    );
    assert.equal(
        pairedAmount(sqrtRatioAtTick(2000), lower, upper, 1, 10n ** 18n),
        0n,
    );

    // Symmetric range around the price: the two sides pair up one for one.
    const paired = pairedAmount(inside, lower, upper, 0, 10n ** 18n);

    assert.ok(paired !== null);
    assert.ok(Math.abs(Number(paired) / 1e18 - 1) < 0.001);
});

test('what a deposit buys is what the position then holds', () => {
    const lower = sqrtRatioAtTick(-1000);
    const upper = sqrtRatioAtTick(1000);
    const price = sqrtRatioAtTick(0);
    const amount0 = 5n * 10n ** 18n;
    const amount1 = pairedAmount(price, lower, upper, 0, amount0);
    const liquidity = liquidityForAmounts(
        price,
        lower,
        upper,
        amount0,
        amount1,
    );
    const held = amountsForLiquidity(price, lower, upper, liquidity);

    assert.ok(liquidity > 0n);
    // Rounding is downward at every step, so the position holds a hair less
    // than went in and never more.
    assert.ok(held.amount0 <= amount0 && held.amount1 <= amount1);
    assert.ok(Number(amount0 - held.amount0) / Number(amount0) < 1e-9);

    // An out-of-range position is one token and nothing of the other.
    const above = amountsForLiquidity(
        sqrtRatioAtTick(2000),
        lower,
        upper,
        liquidity,
    );

    assert.equal(above.amount0, 0n);
    assert.ok(above.amount1 > 0n);
});

test('a floor is below what was quoted, and a nonsense tolerance falls back', () => {
    assert.equal(withSlippage(10_000n, 50), 9950n);
    assert.equal(withSlippage(10_000n, 0), 10_000n);
    assert.equal(withSlippage(10_000n, Number.NaN), 9950n);
});

test('a deposit is one call, and a coin deposit refunds what the ratio did not take', () => {
    const base = {
        token0: WCYBER,
        token1: USDC,
        tier: 2500,
        tickLower: -1000,
        tickUpper: 1000,
        amount0Desired: 10n ** 18n,
        amount1Desired: 4200n,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: ME,
        deadline: 1n,
        nativeSide: null,
    };

    assert.deepEqual(names(v3DepositCalls(base).calls), ['mint']);
    assert.equal(v3DepositCalls(base).value, 0n);

    const coin = v3DepositCalls({ ...base, nativeSide: 0 });

    assert.deepEqual(names(coin.calls), ['mint', 'refundETH']);
    assert.equal(coin.value, base.amount0Desired);

    // Adding to a position that exists is the same plan with one call swapped.
    assert.deepEqual(names(v3DepositCalls({ ...base, tokenId: 7n }).calls), [
        'increaseLiquidity',
    ]);
});

test('a deposit refuses a pair out of pool order, or a range that is not one', () => {
    const plan = {
        token0: USDC,
        token1: WCYBER,
        tier: 2500,
        tickLower: -1000,
        tickUpper: 1000,
        amount0Desired: 1n,
        amount1Desired: 1n,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: ME,
        deadline: 1n,
        nativeSide: null,
    };

    // USDC sorts above WCYBER, so this pair is named backwards — which would
    // otherwise mint a position with the two amounts on the wrong sides.
    assert.throws(() => v3DepositCalls(plan), /pool order/);
    assert.throws(
        () =>
            v3DepositCalls({
                ...plan,
                token0: WCYBER,
                token1: USDC,
                tickLower: 1000,
                tickUpper: 1000,
            }),
        /lower tick/,
    );
});

test('a withdrawal always collects, and only collects when nothing is pulled', () => {
    const base = {
        tokenId: 7n,
        token0: WCYBER,
        token1: USDC,
        liquidity: 1000n,
        amount0Min: 10n,
        amount1Min: 20n,
        recipient: ME,
        deadline: 1n,
        nativeSide: null,
        burn: false,
    };

    // decreaseLiquidity only credits the tokens to the position; collect is
    // what pays them out, so it is never absent.
    assert.deepEqual(names(v3WithdrawCalls(base).calls), [
        'decreaseLiquidity',
        'collect',
    ]);
    assert.deepEqual(names(v3WithdrawCalls({ ...base, liquidity: 0n }).calls), [
        'collect',
    ]);
});

test('taking the coin back routes the collect through the manager', () => {
    const plan = v3WithdrawCalls({
        tokenId: 7n,
        token0: WCYBER,
        token1: USDC,
        liquidity: 1000n,
        amount0Min: 10n,
        amount1Min: 20n,
        recipient: ME,
        deadline: 1n,
        nativeSide: 0,
        burn: true,
    });

    assert.deepEqual(names(plan.calls), [
        'decreaseLiquidity',
        'collect',
        'unwrapWETH9',
        'sweepToken',
        'burn',
    ]);

    // The collect goes to address zero — the manager's own way of saying "keep
    // it here" — or the unwrap that follows would have nothing to unwrap.
    const collect = iface.parseTransaction({ data: plan.calls[1] }).args[0];

    assert.equal(collect.recipient, ZeroAddress);
    assert.equal(collect.amount0Max, MAX_UINT128);
    assert.equal(arg(plan.calls[2], 0), 10n);
});

test('a position with liquidity left is never burned', () => {
    assert.throws(
        () =>
            v3WithdrawCalls({
                tokenId: 7n,
                token0: WCYBER,
                token1: USDC,
                liquidity: 0n,
                amount0Min: 0n,
                amount1Min: 0n,
                recipient: ME,
                deadline: 1n,
                nativeSide: null,
                burn: true,
            }),
        /cannot be burned/,
    );
});
