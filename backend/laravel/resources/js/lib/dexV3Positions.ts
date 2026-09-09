import { Interface, ZeroAddress, getAddress } from 'ethers';
import { sortTokens, v3PriceFromSqrt } from '@/lib/dexV3';

/**
 * Liquidity in the Cyberia V3 pools — the half of v3 that is not a trade.
 *
 * A v2 position is one number: how many LP tokens an address holds, of a pair
 * that holds everything in one price range there is. A v3 position is four —
 * a pair, a fee tier, a lower tick and an upper tick — and it is an NFT rather
 * than a balance, so nothing about the v2 screen carries over. What follows is
 * the arithmetic that decides what a position is worth and what a change to it
 * must be signed as, and it is all here rather than in the screen because
 * every one of these fails *quietly*:
 *
 *   - **a tick is a price, exactly.** `sqrtRatioAtTick` is the contracts' own
 *     table (ported verbatim from `TickMath.sol`), not `1.0001 ** tick` in
 *     floating point: the pool decides what a range is worth with the integer
 *     answer, and a screen that computed a slightly different one would show
 *     amounts the mint then silently rounds away from;
 *   - **a range decides the ratio, not the market.** How much of each token a
 *     deposit takes is a function of where the price sits inside the range —
 *     entirely token0 below it, entirely token1 above it — so the second
 *     amount is derived, never typed;
 *   - **ticks are not free integers.** They must be multiples of the tier's
 *     spacing, which the factory keeps and which differs per tier, so what the
 *     user typed as a price is snapped and then read back out of the snapped
 *     tick — showing the typed number instead would misstate the position by
 *     up to a whole tick spacing;
 *   - **withdrawing is two operations.** `decreaseLiquidity` only *credits*
 *     the tokens to the position; `collect` is what moves them. One without
 *     the other looks like it worked and pays nothing out.
 *
 * Amounts are raw, in each token's own decimals, in and out. Prices are floats
 * because they are for a screen — never route an amount through one.
 */

export const Q96 = 2n ** 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
/** `collect` takes a uint128 ceiling; this is "everything owed". */
export const MAX_UINT128 = 2n ** 128n - 1n;

export const V3_POSITION_MANAGER_ABI = [
    'function positions(uint256 tokenId) view returns (uint96 nonce,address operator,address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,uint128 tokensOwed0,uint128 tokensOwed1)',
    'function balanceOf(address owner) view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner,uint256 index) view returns (uint256)',
    'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
    'function increaseLiquidity((uint256 tokenId,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint128 liquidity,uint256 amount0,uint256 amount1)',
    'function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline)) payable returns (uint256 amount0,uint256 amount1)',
    'function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max)) payable returns (uint256 amount0,uint256 amount1)',
    'function burn(uint256 tokenId) payable',
    'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
    'function sweepToken(address token,uint256 amountMinimum,address recipient) payable',
    'function refundETH() payable',
    'function multicall(bytes[] data) payable returns (bytes[] results)',
];

export const V3_FACTORY_ABI = [
    'function getPool(address,address,uint24) view returns (address)',
    'function feeAmountTickSpacing(uint24) view returns (int24)',
    'function createPool(address tokenA,address tokenB,uint24 fee) returns (address pool)',
    'function poolCreator(address) view returns (address)',
];

export const V3_POOL_ABI = [
    'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint32 feeProtocol,bool unlocked)',
    'function fee() view returns (uint24)',
    'function tickSpacing() view returns (int24)',
    'function liquidity() view returns (uint128)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function initialize(uint160 sqrtPriceX96)',
];

const nfpm = new Interface(V3_POSITION_MANAGER_ABI);

/**
 * sqrt(1.0001^tick) in Q64.96 — `TickMath.getSqrtRatioAtTick`, unchanged.
 *
 * Ported constant for constant from `contracts/pancake-v3-core/libraries/
 * TickMath.sol` rather than reimplemented: this is the number the pool itself
 * uses to decide what a range holds, so any other way of computing it is a
 * disagreement with the chain rather than a rounding preference.
 */
export const sqrtRatioAtTick = (tick: number): bigint => {
    const absTick = BigInt(Math.abs(tick));

    if (absTick > BigInt(MAX_TICK)) {
        throw new Error(`tick ${tick} is outside the representable range`);
    }

    let ratio =
        (absTick & 0x1n) !== 0n
            ? 0xfffcb933bd6fad37aa2d162d1a594001n
            : 0x100000000000000000000000000000000n;

    const step = (mask: bigint, factor: bigint): void => {
        if ((absTick & mask) !== 0n) {
            ratio = (ratio * factor) >> 128n;
        }
    };

    step(0x2n, 0xfff97272373d413259a46990580e213an);
    step(0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn);
    step(0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
    step(0x10n, 0xffcb9843d60f6159c9db58835c926644n);
    step(0x20n, 0xff973b41fa98c081472e6896dfb254c0n);
    step(0x40n, 0xff2ea16466c96a3843ec78b326b52861n);
    step(0x80n, 0xfe5dee046a99a2a811c461f1969c3053n);
    step(0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
    step(0x200n, 0xf987a7253ac413176f2b074cf7815e54n);
    step(0x400n, 0xf3392b0822b70005940c7a398e4b70f3n);
    step(0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n);
    step(0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n);
    step(0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n);
    step(0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n);
    step(0x8000n, 0x31be135f97d08fd981231505542fcfa6n);
    step(0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
    step(0x20000n, 0x5d6af8dedb81196699c329225ee604n);
    step(0x40000n, 0x2216e584f5fa1ea926041bedfe98n);
    step(0x80000n, 0x48a170391f7dc42444e8fa2n);

    if (tick > 0) {
        ratio = (2n ** 256n - 1n) / ratio;
    }

    // Q128.128 down to Q128.96, rounding up so the tick this price reads back
    // as is the tick it came from.
    return (ratio >> 32n) + (ratio % 2n ** 32n === 0n ? 0n : 1n);
};

/** What one whole token0 is worth in whole token1, at this tick. */
export const priceAtTick = (
    tick: number,
    decimals0: number,
    decimals1: number,
): number => v3PriceFromSqrt(sqrtRatioAtTick(tick), decimals0, decimals1);

/**
 * The tick a price sits at — the inverse of `priceAtTick`, in floating point.
 *
 * Deliberately not the contracts' `getTickAtSqrtRatio`: the answer is snapped
 * to the tier's spacing immediately afterwards, which is a far coarser step
 * than anything a logarithm gets wrong, and the price a screen then shows is
 * read back out of the snapped tick rather than out of this number.
 */
export const tickAtPrice = (
    price: number,
    decimals0: number,
    decimals1: number,
): number => {
    if (!(price > 0) || !Number.isFinite(price)) {
        throw new Error('a tick needs a positive price');
    }

    const raw = price * 10 ** (decimals1 - decimals0);

    return Math.round(Math.log(raw) / Math.log(1.0001));
};

/** Ticks may only land on multiples of the tier's spacing. */
export const snapTick = (
    tick: number,
    spacing: number,
    dir: 'nearest' | 'down' | 'up' = 'nearest',
): number => {
    if (spacing <= 0) {
        throw new Error('a tick spacing is a positive number');
    }

    const scaled = tick / spacing;
    const rounded =
        dir === 'down'
            ? Math.floor(scaled)
            : dir === 'up'
              ? Math.ceil(scaled)
              : Math.round(scaled);
    const limit = Math.floor(MAX_TICK / spacing) * spacing;

    return Math.min(limit, Math.max(-limit, rounded * spacing));
};

/** The widest range this tier can hold: v2 behaviour, spelled in ticks. */
export const fullRangeTicks = (spacing: number): [number, number] => [
    snapTick(MIN_TICK, spacing, 'up'),
    snapTick(MAX_TICK, spacing, 'down'),
];

/**
 * A range of ±`widthPct` around a tick, in the log space ticks live in.
 *
 * "±25%" therefore means down to 0.75× and up to 1/0.75× — the same distance
 * in both directions as the pool measures distance, which is what keeps a
 * range symmetric around the price instead of lopsided towards the upside.
 */
export const rangeTicksAround = (
    tick: number,
    spacing: number,
    widthPct: number,
): [number, number] => {
    if (!Number.isFinite(widthPct) || widthPct <= 0 || widthPct >= 100) {
        return fullRangeTicks(spacing);
    }

    const half = Math.log(1 - widthPct / 100) / Math.log(1.0001);

    return [
        snapTick(tick + half, spacing, 'down'),
        snapTick(tick - half, spacing, 'up'),
    ];
};

/**
 * The first price of a pool nobody has traded in yet, as Q64.96.
 *
 * Integer the whole way — a float here is a price that is wrong in its last
 * digits forever, because a pool is initialised once and never again. Given as
 * two raw amounts (how much token1 one whole token0 buys) rather than as a
 * float for the same reason.
 */
export const initialSqrtPriceX96 = (
    amount1: bigint,
    amount0: bigint,
): bigint => {
    if (amount0 <= 0n || amount1 <= 0n) {
        throw new Error('a price needs both sides');
    }

    return sqrtBigInt((amount1 << 192n) / amount0);
};

const sqrtBigInt = (value: bigint): bigint => {
    if (value < 2n) {
        return value;
    }

    let x = value;
    let y = (x + 1n) / 2n;

    while (y < x) {
        x = y;
        y = (x + value / x) / 2n;
    }

    return x;
};

/** Where the price sits relative to a range — which is what decides the ratio. */
export const rangeStatus = (
    sqrtPriceX96: bigint,
    sqrtLower: bigint,
    sqrtUpper: bigint,
): 'below' | 'in' | 'above' =>
    sqrtPriceX96 <= sqrtLower
        ? 'below'
        : sqrtPriceX96 < sqrtUpper
          ? 'in'
          : 'above';

const liquidityForAmount0 = (
    sqrtA: bigint,
    sqrtB: bigint,
    amount0: bigint,
): bigint => {
    const [lower, upper] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];

    if (upper === lower) {
        return 0n;
    }

    return (amount0 * ((lower * upper) / Q96)) / (upper - lower);
};

const liquidityForAmount1 = (
    sqrtA: bigint,
    sqrtB: bigint,
    amount1: bigint,
): bigint => {
    const [lower, upper] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];

    if (upper === lower) {
        return 0n;
    }

    return (amount1 * Q96) / (upper - lower);
};

/**
 * How much liquidity a deposit buys — `LiquidityAmounts.getLiquidityForAmounts`.
 *
 * Below the range the deposit is all token0, above it all token1, and inside
 * it the *smaller* of what each side can pay for, because a pool takes the two
 * in the ratio the current price dictates and the excess would simply be
 * refunded.
 */
export const liquidityForAmounts = (
    sqrtPriceX96: bigint,
    sqrtLower: bigint,
    sqrtUpper: bigint,
    amount0: bigint,
    amount1: bigint,
): bigint => {
    const [lower, upper] =
        sqrtLower <= sqrtUpper
            ? [sqrtLower, sqrtUpper]
            : [sqrtUpper, sqrtLower];

    if (sqrtPriceX96 <= lower) {
        return liquidityForAmount0(lower, upper, amount0);
    }

    if (sqrtPriceX96 < upper) {
        const from0 = liquidityForAmount0(sqrtPriceX96, upper, amount0);
        const from1 = liquidityForAmount1(lower, sqrtPriceX96, amount1);

        return from0 < from1 ? from0 : from1;
    }

    return liquidityForAmount1(lower, upper, amount1);
};

const amount0ForLiquidity = (
    sqrtA: bigint,
    sqrtB: bigint,
    liquidity: bigint,
): bigint => {
    const [lower, upper] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];

    if (lower <= 0n) {
        return 0n;
    }

    return ((liquidity << 96n) * (upper - lower)) / upper / lower;
};

const amount1ForLiquidity = (
    sqrtA: bigint,
    sqrtB: bigint,
    liquidity: bigint,
): bigint => {
    const [lower, upper] = sqrtA <= sqrtB ? [sqrtA, sqrtB] : [sqrtB, sqrtA];

    return (liquidity * (upper - lower)) / Q96;
};

/**
 * What a position holds right now — `LiquidityAmounts.getAmountsForLiquidity`.
 *
 * This is what a position *is*: liquidity is a constant of the position, and
 * the two token amounts move with the price, which is why an out-of-range
 * position reads as one token and nothing of the other.
 */
export const amountsForLiquidity = (
    sqrtPriceX96: bigint,
    sqrtLower: bigint,
    sqrtUpper: bigint,
    liquidity: bigint,
): { amount0: bigint; amount1: bigint } => {
    const [lower, upper] =
        sqrtLower <= sqrtUpper
            ? [sqrtLower, sqrtUpper]
            : [sqrtUpper, sqrtLower];

    if (sqrtPriceX96 <= lower) {
        return {
            amount0: amount0ForLiquidity(lower, upper, liquidity),
            amount1: 0n,
        };
    }

    if (sqrtPriceX96 < upper) {
        return {
            amount0: amount0ForLiquidity(sqrtPriceX96, upper, liquidity),
            amount1: amount1ForLiquidity(lower, sqrtPriceX96, liquidity),
        };
    }

    return {
        amount0: 0n,
        amount1: amount1ForLiquidity(lower, upper, liquidity),
    };
};

/**
 * The other side of a deposit: type one amount, this is what must go with it.
 *
 * `null` means the side that was typed cannot be deposited at all — the price
 * is on the far side of the range, so this deposit is single-sided and the
 * other field is not an input the user has to fill but a fact of the range.
 */
export const pairedAmount = (
    sqrtPriceX96: bigint,
    sqrtLower: bigint,
    sqrtUpper: bigint,
    side: 0 | 1,
    amount: bigint,
): bigint | null => {
    const status = rangeStatus(sqrtPriceX96, sqrtLower, sqrtUpper);

    if (status === 'below') {
        return side === 0 ? 0n : null;
    }

    if (status === 'above') {
        return side === 1 ? 0n : null;
    }

    if (amount <= 0n) {
        return 0n;
    }

    const liquidity =
        side === 0
            ? liquidityForAmount0(sqrtPriceX96, sqrtUpper, amount)
            : liquidityForAmount1(sqrtLower, sqrtPriceX96, amount);
    const amounts = amountsForLiquidity(
        sqrtPriceX96,
        sqrtLower,
        sqrtUpper,
        liquidity,
    );

    return side === 0 ? amounts.amount1 : amounts.amount0;
};

/** A floor (or a ceiling, on the way out) at `bps` below what was quoted. */
export const withSlippage = (amount: bigint, bps: number): bigint => {
    const safe = Number.isFinite(bps) && bps >= 0 && bps < 10_000 ? bps : 50;

    return (amount * BigInt(10_000 - Math.round(safe))) / 10_000n;
};

export type V3Calls = {
    /** Encoded position-manager calls, in the order they must run. */
    calls: string[];
    /** The coin sent with them, zero unless one side of the pair is native. */
    value: bigint;
};

export type V3DepositPlan = {
    token0: string;
    token1: string;
    tier: number;
    tickLower: number;
    tickUpper: number;
    amount0Desired: bigint;
    amount1Desired: bigint;
    amount0Min: bigint;
    amount1Min: bigint;
    recipient: string;
    deadline: bigint;
    /**
     * Which side of the pair is being paid in the coin rather than in its
     * wrapper, if either. The manager wraps what it needs out of `value`.
     */
    nativeSide: 0 | 1 | null;
    /** Set to add to a position that already exists instead of minting one. */
    tokenId?: bigint;
};

/**
 * What a deposit is signed as.
 *
 * A mint and an increase differ in one call and in nothing else, so they share
 * a plan. The coin turns it into a `multicall`: the amount is sent as value,
 * and `refundETH` returns the part the pool's ratio did not take — a deposit
 * that left the difference in the manager would be a silent donation to the
 * next caller.
 */
export const v3DepositCalls = (plan: V3DepositPlan): V3Calls => {
    const [token0, token1] = sortTokens(plan.token0, plan.token1);

    if (
        token0.toLowerCase() !== plan.token0.toLowerCase() ||
        token1.toLowerCase() !== plan.token1.toLowerCase()
    ) {
        throw new Error('a deposit must be given its pair in pool order');
    }

    if (plan.tickLower >= plan.tickUpper) {
        throw new Error('a range needs a lower tick below its upper one');
    }

    const call =
        plan.tokenId === undefined
            ? nfpm.encodeFunctionData('mint', [
                  {
                      token0,
                      token1,
                      fee: plan.tier,
                      tickLower: plan.tickLower,
                      tickUpper: plan.tickUpper,
                      amount0Desired: plan.amount0Desired,
                      amount1Desired: plan.amount1Desired,
                      amount0Min: plan.amount0Min,
                      amount1Min: plan.amount1Min,
                      recipient: getAddress(plan.recipient),
                      deadline: plan.deadline,
                  },
              ])
            : nfpm.encodeFunctionData('increaseLiquidity', [
                  {
                      tokenId: plan.tokenId,
                      amount0Desired: plan.amount0Desired,
                      amount1Desired: plan.amount1Desired,
                      amount0Min: plan.amount0Min,
                      amount1Min: plan.amount1Min,
                      deadline: plan.deadline,
                  },
              ]);

    if (plan.nativeSide === null) {
        return { calls: [call], value: 0n };
    }

    return {
        calls: [call, nfpm.encodeFunctionData('refundETH', [])],
        value:
            plan.nativeSide === 0 ? plan.amount0Desired : plan.amount1Desired,
    };
};

export type V3WithdrawPlan = {
    tokenId: bigint;
    token0: string;
    token1: string;
    /** How much liquidity to pull. Zero collects the fees and nothing else. */
    liquidity: bigint;
    amount0Min: bigint;
    amount1Min: bigint;
    recipient: string;
    deadline: bigint;
    /** Take this side back as the coin rather than as its wrapper. */
    nativeSide: 0 | 1 | null;
    /** Legal only once the position is emptied and collected. */
    burn: boolean;
};

/**
 * What a withdrawal is signed as.
 *
 * `decreaseLiquidity` credits the tokens to the position and moves nothing;
 * `collect` is what pays them out, and it pays the accrued fees in the same
 * breath — which is why the ceiling is uint128 max rather than the amount just
 * withdrawn. Taking the coin back means collecting into the manager (address
 * zero, its own convention) and having it unwrap: an https page cannot ask a
 * user to accept the wrapper when they deposited the coin.
 */
export const v3WithdrawCalls = (plan: V3WithdrawPlan): V3Calls => {
    if (plan.liquidity < 0n) {
        throw new Error('a withdrawal cannot be negative');
    }

    if (plan.burn && plan.liquidity === 0n) {
        throw new Error('a position with liquidity left cannot be burned');
    }

    const calls: string[] = [];

    if (plan.liquidity > 0n) {
        calls.push(
            nfpm.encodeFunctionData('decreaseLiquidity', [
                {
                    tokenId: plan.tokenId,
                    liquidity: plan.liquidity,
                    amount0Min: plan.amount0Min,
                    amount1Min: plan.amount1Min,
                    deadline: plan.deadline,
                },
            ]),
        );
    }

    const recipient = getAddress(plan.recipient);

    calls.push(
        nfpm.encodeFunctionData('collect', [
            {
                tokenId: plan.tokenId,
                recipient: plan.nativeSide === null ? recipient : ZeroAddress,
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128,
            },
        ]),
    );

    if (plan.nativeSide !== null) {
        const other = plan.nativeSide === 0 ? plan.token1 : plan.token0;
        const nativeMin =
            plan.nativeSide === 0 ? plan.amount0Min : plan.amount1Min;

        calls.push(
            nfpm.encodeFunctionData('unwrapWETH9', [nativeMin, recipient]),
            // The other side is swept without a floor: the floor it has was
            // already enforced by `decreaseLiquidity`, and the fees arriving
            // with it are whatever they are.
            nfpm.encodeFunctionData('sweepToken', [
                getAddress(other),
                0n,
                recipient,
            ]),
        );
    }

    if (plan.burn) {
        calls.push(nfpm.encodeFunctionData('burn', [plan.tokenId]));
    }

    return { calls, value: 0n };
};
