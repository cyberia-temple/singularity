import {
    AbiCoder,
    Contract,
    Interface,
    ZeroAddress,
    getAddress,
    getCreate2Address,
    keccak256,
    solidityPacked,
} from 'ethers';
import type {
    ContractRunner,
    ContractTransactionResponse,
    Signer,
} from 'ethers';

/**
 * Trading through the Cyberia V3 pools (the PancakeSwap V3 fork).
 *
 * v2 and v3 answer the same question — what does this trade pay — in ways that
 * share no code, so this module is the v3 half and nothing here knows about
 * pairs or reserves. Three facts shape all of it:
 *
 *   - **a pool's address is derived, not looked up.** It is CREATE2 over the
 *     *pool deployer* (not the factory — Pancake splits them so the pool's
 *     creation code lives in its own contract) and the pool's key. So finding
 *     out whether a market exists costs no call at all until the address is
 *     probed, and probing is one `liquidity()` read;
 *   - **the fee in a pool key is the tier, never what the pool charges.** This
 *     fork's pools have a mutable fee, so an address is derived from the tier
 *     it was born in while `fee()` says what a trade actually costs. Reading
 *     the fee out of a path is the one mistake that silently misprices a whole
 *     screen;
 *   - **a quote is a call, not arithmetic.** v3 liquidity is spread over ticks
 *     and there is no closed form for what a trade crossing them pays, which is
 *     why the quoter is a contract and why every quote here is `staticCall`.
 *
 * Amounts are in smallest units throughout, in and out. Nothing in this file
 * knows a token's decimals.
 */

/** The four tiers the factory ships with, plus the launchpad's 11% tier. */
export const V3_FEE_TIERS = [100, 500, 2500, 10_000, 110_000] as const;

/**
 * Uniswap's own four, for the chains that run the unforked contracts.
 *
 * It is one number apart from the list above and that number matters: Pancake
 * (and so Cyberia) replaced the 0.3% tier with 0.25%, so probing a Uniswap
 * chain with 2500 derives the address of a pool that was never created, and
 * skipping 3000 misses the tier most pairs actually live in.
 */
export const UNISWAP_V3_FEE_TIERS = [100, 500, 3_000, 10_000] as const;

export type V3Config = {
    /** CREATE2 deployer for every pool — NOT the factory. */
    poolDeployer: string;
    factory: string;
    quoter: string;
    router: string;
    positionManager: string;
    /** keccak256 of the pool's creation code; a stale one addresses nothing. */
    initCodeHash: string;
    /** Tiers worth probing on this chain, cheapest first. */
    tiers: readonly number[];
    /**
     * Which periphery router this chain deploys.
     *
     * Not a detail: Uniswap's `SwapRouter02` **took the deadline out of the
     * swap parameters** and moved it to a `multicall(deadline, calls)`
     * overload. So the two routers disagree about the shape of every call this
     * module makes, and a struct encoded for one is not merely rejected by the
     * other — it is a different function selector. A chain saying nothing here
     * gets the original `SwapRouter` layout, which is what the Cyberia fork
     * (and Pancake's, which it comes from) deploys.
     *
     * The deadline never becomes optional. On `SwapRouter02` every swap goes
     * out through the multicall overload even when there is only one call in
     * it, because a swap with no deadline is one that can be mined tomorrow at
     * tomorrow's price.
     */
    routerKind?: 'swapRouter' | 'swapRouter02';
    /**
     * What this project takes for putting the trade together, and where.
     *
     * Only on `swapRouter02`, because it is that router's own hook: the swap
     * pays out to the router instead of to the user, and `sweepTokenWithFee`
     * (or `unwrapWETH9WithFee` for the coin) forwards the output minus
     * `feeBips`. One transaction, no contract of ours in the path, and the
     * whole of it is visible in the calldata the user signs.
     *
     * Deliberately absent on Cyberia's own pools: those already pay this
     * project a protocol share at the pool, and charging again on top would be
     * taking the same cut twice from the same trade.
     *
     * Two honest limits. Uniswap caps `feeBips` at 100 — one per cent — and
     * refuses zero, so an entry here is between 1 and 100. And the fee is taken
     * in **what was bought**: buying NVDA pays it in NVDA, on Robinhood Chain.
     * It is not swept anywhere; it sits at the address below until somebody
     * moves it.
     *
     * A client-side fee is also a voluntary one — anything a browser assembles,
     * a browser can assemble without this — which is true of every exchange
     * front end and is not worth pretending otherwise.
     */
    fee?: { bps: number; recipient: string };
};

/** Uniswap's own ceiling on an integrator fee: one per cent, and never zero. */
export const V3_MAX_FEE_BPS = 100;

/**
 * The fee this chain's v3 stack takes, or null.
 *
 * Null for anything but `SwapRouter02` — no other router here has the hook —
 * and null for a configured fee outside what the router will accept, because a
 * fee it rejects is not a smaller fee, it is a swap that reverts.
 */
export const v3IntegratorFee = (
    cfg: Pick<V3Config, 'routerKind' | 'fee'>,
): { bps: number; recipient: string } | null => {
    const fee = cfg.fee;

    if (
        cfg.routerKind !== 'swapRouter02' ||
        !fee ||
        fee.bps < 1 ||
        fee.bps > V3_MAX_FEE_BPS
    ) {
        return null;
    }

    return fee;
};

/**
 * What actually reaches the user, once the fee is taken.
 *
 * The quoter answers with the gross — it prices the pools and knows nothing
 * about us — so every number a screen shows, and every comparison against the
 * other venue, goes through here. The floor the *router* checks stays gross:
 * `sweepTokenWithFee` tests the balance it holds before it splits it.
 */
export const v3AfterFee = (
    cfg: Pick<V3Config, 'routerKind' | 'fee'>,
    amount: bigint,
): bigint => {
    const fee = v3IntegratorFee(cfg);

    return fee === null
        ? amount
        : (amount * BigInt(10_000 - fee.bps)) / 10_000n;
};

const QUOTER_ABI = [
    'function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
    'function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
    'function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)',
    'function quoteExactOutput(bytes path,uint256 amountOut) returns (uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
];

const POOL_ABI = [
    'function liquidity() view returns (uint128)',
    'function fee() view returns (uint24)',
    'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint32 feeProtocol,bool unlocked)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
];

export const V3_ROUTER_ABI = [
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
    'function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
    'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
    'function exactOutput((bytes path,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum)) payable returns (uint256 amountIn)',
    'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
    'function refundETH() payable',
    'function multicall(bytes[] data) payable returns (bytes[] results)',
];

/**
 * Uniswap's `SwapRouter02`, which is the same trade said differently.
 *
 * Every difference from the list above is here: no `deadline` inside the
 * parameter structs, and a `multicall` that takes one for the whole batch.
 * `unwrapWETH9` and `refundETH` are unchanged, which is why the coin legs need
 * no second version.
 */
export const V3_ROUTER_02_ABI = [
    'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
    'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
    'function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountIn)',
    'function exactOutput((bytes path,address recipient,uint256 amountOut,uint256 amountInMaximum)) payable returns (uint256 amountIn)',
    'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
    'function unwrapWETH9WithFee(uint256 amountMinimum,address recipient,uint256 feeBips,address feeRecipient) payable',
    'function sweepTokenWithFee(address token,uint256 amountMinimum,address recipient,uint256 feeBips,address feeRecipient) payable',
    'function refundETH() payable',
    'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)',
];

/**
 * How a router is told to keep the output instead of paying it out.
 *
 * The two disagree, and the disagreement is silent. The original `SwapRouter`
 * reads a recipient of `address(0)` as "this contract"; `SwapRouter02` replaced
 * that with the sentinel `address(2)` and treats a zero recipient as a literal
 * address — so a swap that means "hold it, I am about to unwrap or take a fee"
 * instead transfers the output to the zero address and reverts with `TF`.
 *
 * Every path that keeps the output in the router goes through here: unwrapping
 * to the coin, and taking this project's fee.
 */
const routerSelf = (cfg: Pick<V3Config, 'routerKind'>): string =>
    cfg.routerKind === 'swapRouter02'
        ? '0x0000000000000000000000000000000000000002'
        : ZeroAddress;

/** The ABI this chain's router actually speaks. */
export const v3RouterAbi = (cfg: Pick<V3Config, 'routerKind'>): string[] =>
    cfg.routerKind === 'swapRouter02' ? V3_ROUTER_02_ABI : V3_ROUTER_ABI;

/**
 * Where a pool lives, before asking anything.
 *
 * `abi.encode(token0, token1, fee)` hashed into the CREATE2 salt, exactly as
 * `PoolAddress.sol` does it — the two must agree or the router and this screen
 * would be trading different addresses.
 */
export const v3PoolAddress = (
    cfg: Pick<V3Config, 'poolDeployer' | 'initCodeHash'>,
    tokenA: string,
    tokenB: string,
    fee: number,
): string => {
    const [token0, token1] = sortTokens(tokenA, tokenB);
    const salt = keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ['address', 'address', 'uint24'],
            [token0, token1, fee],
        ),
    );

    return getCreate2Address(
        getAddress(cfg.poolDeployer),
        salt,
        cfg.initCodeHash,
    );
};

/** Pool keys are ordered by address; taking them the other way round changes the address. */
export const sortTokens = (
    tokenA: string,
    tokenB: string,
): [string, string] => {
    const a = getAddress(tokenA);
    const b = getAddress(tokenB);

    if (a.toLowerCase() === b.toLowerCase()) {
        throw new Error('A pool needs two different tokens');
    }

    return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
};

/**
 * The bytes a multi-hop swap travels as: token, tier, token, tier, token…
 *
 * Note "tier": these three bytes address the pool, they are not what it
 * charges. `tokens.length` must be exactly one more than `fees.length`, and a
 * path with one fee is still legal — it is simply the single-hop case spelled
 * the long way.
 */
export const encodeV3Path = (
    tokens: readonly string[],
    fees: readonly number[],
): string => {
    if (tokens.length < 2 || tokens.length !== fees.length + 1) {
        throw new Error('A v3 path needs one fee between every two tokens');
    }

    const types: string[] = [];
    const values: unknown[] = [];

    tokens.forEach((token, i) => {
        types.push('address');
        values.push(getAddress(token));

        if (i < fees.length) {
            types.push('uint24');
            values.push(fees[i]);
        }
    });

    return solidityPacked(types, values);
};

export type V3Route = {
    /** Every token the trade passes through, input first. */
    tokens: string[];
    /** The tier of each hop — this is pool addressing, and never the price. */
    fees: number[];
    /** The pools the trade actually goes through, in order. */
    pools: V3Pool[];
    /** What goes in. Equal to the amount asked for on an exact-input quote. */
    amountIn: bigint;
    /** What the quoter says this route pays right now. */
    amountOut: bigint;
    /** The quoter's own gas figure, for comparing routes rather than for signing. */
    gasEstimate: bigint;
};

/** A pool that exists and has something in it. */
export type V3Pool = {
    address: string;
    tokenA: string;
    tokenB: string;
    /** The tier the pool was created in — this is what addresses it. */
    tier: number;
    /** What it actually charges, read from the pool. */
    fee: number;
    liquidity: bigint;
    sqrtPriceX96: bigint;
};

/**
 * Which pools exist for one pair, across every tier.
 *
 * The addresses are computed rather than asked for, so this is one read per
 * tier and no factory call at all. A tier with no pool answers with a revert
 * or an empty result and is simply absent from the answer — never an error,
 * because "there is no 1% pool for this pair" is the normal case.
 */
export const v3PoolsFor = async (
    runner: ContractRunner,
    cfg: V3Config,
    tokenA: string,
    tokenB: string,
): Promise<V3Pool[]> => {
    const found = await Promise.all(
        cfg.tiers.map(async (tier): Promise<V3Pool | null> => {
            const address = v3PoolAddress(cfg, tokenA, tokenB, tier);

            try {
                const pool = new Contract(address, POOL_ABI, runner);
                const [liquidity, fee, slot0] = await Promise.all([
                    pool.liquidity() as Promise<bigint>,
                    pool.fee() as Promise<bigint>,
                    pool.slot0() as Promise<{ sqrtPriceX96: bigint }>,
                ]);

                // A pool that was created but never initialised has no price and
                // cannot be traded through; it is not a market yet.
                if (slot0.sqrtPriceX96 === 0n) {
                    return null;
                }

                return {
                    address,
                    tokenA: getAddress(tokenA),
                    tokenB: getAddress(tokenB),
                    tier,
                    fee: Number(fee),
                    liquidity,
                    sqrtPriceX96: slot0.sqrtPriceX96,
                };
            } catch {
                return null;
            }
        }),
    );

    return found
        .filter((pool): pool is V3Pool => pool !== null)
        .sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1));
};

/**
 * What this trade pays, over the best route the v3 pools offer.
 *
 * Direct pools are tried first and the hubs are only reached for when none of
 * them answers — a pair with its own pool never needs a second hop, and every
 * hub tried is another round trip on a chain whose node batches at twenty.
 * Every candidate is priced by the quoter and the best answer wins; a route
 * that reverts (no liquidity, not initialised, price limit) loses silently.
 */
export const v3BestRoute = async (
    runner: ContractRunner,
    cfg: V3Config,
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    hubs: readonly string[] = [],
): Promise<V3Route | null> => {
    if (amountIn <= 0n) {
        return null;
    }

    const quoter = new Contract(cfg.quoter, QUOTER_ABI, runner);
    const direct = await v3PoolsFor(runner, cfg, tokenIn, tokenOut);

    const quoteSingle = async (pool: V3Pool): Promise<V3Route | null> => {
        try {
            const [amountOut, , , gasEstimate] =
                await quoter.quoteExactInputSingle.staticCall({
                    tokenIn: getAddress(tokenIn),
                    tokenOut: getAddress(tokenOut),
                    amountIn,
                    fee: pool.tier,
                    sqrtPriceLimitX96: 0n,
                });

            return amountOut > 0n
                ? {
                      tokens: [getAddress(tokenIn), getAddress(tokenOut)],
                      fees: [pool.tier],
                      pools: [pool],
                      amountIn,
                      amountOut,
                      gasEstimate,
                  }
                : null;
        } catch {
            return null;
        }
    };

    const best = pickBest(await Promise.all(direct.map(quoteSingle)));

    if (best) {
        return best;
    }

    const twoHop = await Promise.all(
        hubs
            .filter(
                (hub) =>
                    hub.toLowerCase() !== tokenIn.toLowerCase() &&
                    hub.toLowerCase() !== tokenOut.toLowerCase(),
            )
            .map(async (hub): Promise<V3Route | null> => {
                const [first, second] = await Promise.all([
                    v3PoolsFor(runner, cfg, tokenIn, hub),
                    v3PoolsFor(runner, cfg, hub, tokenOut),
                ]);

                if (first.length === 0 || second.length === 0) {
                    return null;
                }

                // The deepest pool on each leg: quoting every combination would
                // be tiers-squared calls for a hop that usually does not exist.
                const fees = [first[0].tier, second[0].tier];
                const tokens = [
                    getAddress(tokenIn),
                    getAddress(hub),
                    getAddress(tokenOut),
                ];

                try {
                    const [amountOut, , , gasEstimate] =
                        await quoter.quoteExactInput.staticCall(
                            encodeV3Path(tokens, fees),
                            amountIn,
                        );

                    return amountOut > 0n
                        ? {
                              tokens,
                              fees,
                              pools: [first[0], second[0]],
                              amountIn,
                              amountOut,
                              gasEstimate,
                          }
                        : null;
                } catch {
                    return null;
                }
            }),
    );

    return pickBest(twoHop);
};

const pickBest = (routes: (V3Route | null)[]): V3Route | null =>
    routes.reduce<V3Route | null>(
        (best, route) =>
            route && (!best || route.amountOut > best.amountOut) ? route : best,
        null,
    );

/** Least input for a fixed output — the mirror of `pickBest`. */
const pickCheapest = (routes: (V3Route | null)[]): V3Route | null =>
    routes.reduce<V3Route | null>(
        (best, route) =>
            route && (!best || route.amountIn < best.amountIn) ? route : best,
        null,
    );

/**
 * What buying an exact amount would cost, over the best route v3 offers.
 *
 * The mirror of `v3BestRoute`, and kept beside it rather than folded into it,
 * because the two disagree about what "best" means: most output there, least
 * input here. An exact-output **path is written backwards** — output token
 * first — which is the quoter's convention and not a mistake to tidy up.
 */
export const v3BestRouteExactOut = async (
    runner: ContractRunner,
    cfg: V3Config,
    tokenIn: string,
    tokenOut: string,
    amountOut: bigint,
    hubs: readonly string[] = [],
): Promise<V3Route | null> => {
    if (amountOut <= 0n) {
        return null;
    }

    const quoter = new Contract(cfg.quoter, QUOTER_ABI, runner);
    const direct = await v3PoolsFor(runner, cfg, tokenIn, tokenOut);

    const quoteSingle = async (pool: V3Pool): Promise<V3Route | null> => {
        try {
            const [amountIn, , , gasEstimate] =
                await quoter.quoteExactOutputSingle.staticCall({
                    tokenIn: getAddress(tokenIn),
                    tokenOut: getAddress(tokenOut),
                    amount: amountOut,
                    fee: pool.tier,
                    sqrtPriceLimitX96: 0n,
                });

            return amountIn > 0n
                ? {
                      tokens: [getAddress(tokenIn), getAddress(tokenOut)],
                      fees: [pool.tier],
                      pools: [pool],
                      amountIn,
                      amountOut,
                      gasEstimate,
                  }
                : null;
        } catch {
            return null;
        }
    };

    const best = pickCheapest(await Promise.all(direct.map(quoteSingle)));

    if (best) {
        return best;
    }

    const twoHop = await Promise.all(
        hubs
            .filter(
                (hub) =>
                    hub.toLowerCase() !== tokenIn.toLowerCase() &&
                    hub.toLowerCase() !== tokenOut.toLowerCase(),
            )
            .map(async (hub): Promise<V3Route | null> => {
                const [first, second] = await Promise.all([
                    v3PoolsFor(runner, cfg, tokenIn, hub),
                    v3PoolsFor(runner, cfg, hub, tokenOut),
                ]);

                if (first.length === 0 || second.length === 0) {
                    return null;
                }

                const fees = [first[0].tier, second[0].tier];
                const tokens = [
                    getAddress(tokenIn),
                    getAddress(hub),
                    getAddress(tokenOut),
                ];

                try {
                    const [amountIn, , , gasEstimate] =
                        await quoter.quoteExactOutput.staticCall(
                            // Backwards, as the quoter wants it.
                            encodeV3Path(
                                [...tokens].reverse(),
                                [...fees].reverse(),
                            ),
                            amountOut,
                        );

                    return amountIn > 0n
                        ? {
                              tokens,
                              fees,
                              pools: [first[0], second[0]],
                              amountIn,
                              amountOut,
                              gasEstimate,
                          }
                        : null;
                } catch {
                    return null;
                }
            }),
    );

    return pickCheapest(twoHop);
};

/**
 * The price a pool is sitting at, as token1 per token0.
 *
 * `sqrtPriceX96` is a Q64.96 square root, so this squares it and shifts back —
 * in floating point, because the answer is for a screen. Never round-trip a
 * traded amount through this number; that is what the quoter is for.
 */
export const v3PriceFromSqrt = (
    sqrtPriceX96: bigint,
    decimals0: number,
    decimals1: number,
): number => {
    if (sqrtPriceX96 <= 0n) {
        return 0;
    }

    const ratio = Number(sqrtPriceX96) / 2 ** 96;
    const price = ratio * ratio;

    return price * 10 ** (decimals0 - decimals1);
};

/**
 * What a swap through this route costs a trader, as a percentage of the input.
 *
 * Read off each pool's own `fee()` and deliberately **not** off the route's
 * tiers: in this fork the two are different numbers, and a launch pool born in
 * the 11% tier while charging 3% would otherwise be advertised at 11%.
 */
export const v3RouteFeePct = (pools: readonly V3Pool[]): number =>
    pools.reduce((total, pool) => total + pool.fee / 10_000, 0);

/**
 * What a v3 swap is asked to do, once the route is chosen.
 *
 * `nativeIn`/`nativeOut` are about the *coin*, not about a token: the router
 * only ever swaps WCYBER, so the coin is wrapped on the way in by sending
 * value, and unwrapped on the way out by keeping the output in the router and
 * calling `unwrapWETH9`. Both legs must be one transaction — a user who signed
 * one swap must not end up holding an intermediate wrapper because the second
 * call failed.
 */
export type V3SwapPlan = {
    route: V3Route;
    recipient: string;
    /**
     * Exact-in: the floor. Exact-out: the amount to buy.
     *
     * **Gross**, always — the amount the router must be holding, before this
     * project's fee comes out of it. That is what `sweepTokenWithFee` and
     * `unwrapWETH9WithFee` check, and quoting the net here would set a floor a
     * fee-taking swap can never clear. What the user is shown is the net of
     * this number, through `v3AfterFee`.
     */
    amountOutMinimum: bigint;
    /** Exact-out only: the ceiling on what may be spent. */
    amountInMaximum?: bigint;
    exactIn: boolean;
    nativeIn: boolean;
    nativeOut: boolean;
    deadline: bigint;
};

/**
 * The transaction one v3 swap is, without a signer anywhere near it.
 *
 * Split out from `v3Swap` because two callers want the same bytes for
 * different reasons: one signs them, and one asks the node what they would
 * cost. A fee quoted from a differently-shaped call is a fee that promises
 * something the signature does not deliver.
 */
export const v3SwapCall = (
    cfg: V3Config,
    plan: V3SwapPlan,
): { to: string; data: string; value: bigint } => {
    const iface = new Interface(v3RouterAbi(cfg));
    const { route } = plan;
    const single = route.tokens.length === 2;

    // `SwapRouter02` has no `deadline` field in any of its parameter structs;
    // it carries one for the whole batch instead. Spreading nothing into the
    // struct on that router is what keeps one encoder for both.
    const deadline =
        cfg.routerKind === 'swapRouter02' ? {} : { deadline: plan.deadline };

    /*
     * The fee, when this chain has one and the trade is exact-in.
     *
     * Exact-out is excluded on purpose: there the output is the number the user
     * asked for, and a cut off the top would deliver less than the exact amount
     * that was agreed. On that side the surplus already comes back as a refund
     * of the input, and taking anything out of it would need a different hook
     * than the two this router has.
     */
    const fee = plan.exactIn ? v3IntegratorFee(cfg) : null;

    /*
     * Output that must come back as the coin stays in the router until
     * `unwrapWETH9` sends it on; anything else goes straight to the user — and
     * a fee makes every output stay, because the router can only take its share
     * out of a balance it is holding.
     */
    const recipient =
        plan.nativeOut || fee !== null
            ? routerSelf(cfg)
            : getAddress(plan.recipient);
    const value = plan.nativeIn
        ? plan.exactIn
            ? route.amountIn
            : (plan.amountInMaximum ?? route.amountIn)
        : 0n;

    const swapCall = plan.exactIn
        ? single
            ? iface.encodeFunctionData('exactInputSingle', [
                  {
                      tokenIn: route.tokens[0],
                      tokenOut: route.tokens[1],
                      fee: route.fees[0],
                      recipient,
                      ...deadline,
                      amountIn: route.amountIn,
                      amountOutMinimum: plan.amountOutMinimum,
                      sqrtPriceLimitX96: 0n,
                  },
              ])
            : iface.encodeFunctionData('exactInput', [
                  {
                      path: encodeV3Path(route.tokens, route.fees),
                      recipient,
                      ...deadline,
                      amountIn: route.amountIn,
                      amountOutMinimum: plan.amountOutMinimum,
                  },
              ])
        : single
          ? iface.encodeFunctionData('exactOutputSingle', [
                {
                    tokenIn: route.tokens[0],
                    tokenOut: route.tokens[1],
                    fee: route.fees[0],
                    recipient,
                    ...deadline,
                    amountOut: route.amountOut,
                    amountInMaximum: plan.amountInMaximum ?? route.amountIn,
                    sqrtPriceLimitX96: 0n,
                },
            ])
          : iface.encodeFunctionData('exactOutput', [
                {
                    // An exact-output path is written output-first.
                    path: encodeV3Path(
                        [...route.tokens].reverse(),
                        [...route.fees].reverse(),
                    ),
                    recipient,
                    ...deadline,
                    amountOut: route.amountOut,
                    amountInMaximum: plan.amountInMaximum ?? route.amountIn,
                },
            ]);

    const calls = [swapCall];

    if (plan.nativeOut) {
        /*
         * The floor is enforced here as well as in the swap, so a router that
         * somehow holds less than promised cannot pay out less than promised.
         * `amountOutMinimum` is the **gross** — what the router is holding
         * before it splits it — which is what both of these calls test.
         */
        calls.push(
            fee === null
                ? iface.encodeFunctionData('unwrapWETH9', [
                      plan.amountOutMinimum,
                      getAddress(plan.recipient),
                  ])
                : iface.encodeFunctionData('unwrapWETH9WithFee', [
                      plan.amountOutMinimum,
                      getAddress(plan.recipient),
                      fee.bps,
                      getAddress(fee.recipient),
                  ]),
        );
    } else if (fee !== null) {
        calls.push(
            iface.encodeFunctionData('sweepTokenWithFee', [
                route.tokens[route.tokens.length - 1],
                plan.amountOutMinimum,
                getAddress(plan.recipient),
                fee.bps,
                getAddress(fee.recipient),
            ]),
        );
    }

    // Exact-output paid in the coin is sent the ceiling; whatever the swap did
    // not need is refunded in the same transaction, never left in the router.
    if (plan.nativeIn && !plan.exactIn) {
        calls.push(iface.encodeFunctionData('refundETH', []));
    }

    const data =
        cfg.routerKind === 'swapRouter02'
            ? // Always the multicall, single call or not: it is the only place
              // this router will take a deadline, and going without one lets
              // the transaction settle at a price nobody agreed to.
              iface.encodeFunctionData('multicall', [plan.deadline, calls])
            : calls.length === 1
              ? calls[0]
              : iface.encodeFunctionData('multicall', [calls]);

    return { to: getAddress(cfg.router), data, value };
};

/**
 * Sign and send one v3 swap.
 *
 * Single-hop and multi-hop are different router calls, and the coin legs turn
 * the whole thing into a `multicall` — so this is assembled in one place
 * rather than in each screen that trades. Nothing here re-quotes: the floor
 * (or ceiling) it was given is what travels into the signature.
 */
export const v3Swap = async (
    signer: Signer,
    cfg: V3Config,
    plan: V3SwapPlan,
): Promise<ContractTransactionResponse> =>
    (await signer.sendTransaction(
        v3SwapCall(cfg, plan),
    )) as unknown as ContractTransactionResponse;
