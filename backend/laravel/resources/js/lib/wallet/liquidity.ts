import { Contract, JsonRpcProvider, getAddress } from 'ethers';
import type { LiquidityChainConfig } from '@/lib/liquidityChains';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';
import { applySlippage, swapChainFor } from '@/lib/wallet/swap';
import type { SwapAsset } from '@/lib/wallet/swap';

/**
 * Making a pool position from inside the wallet, and taking it apart again.
 *
 * This is the step the wallet was missing. It could trade a pool, it could
 * stake the LP token a pool hands out and it could claim what that stake
 * earned — but the one act that *produces* an LP token happened somewhere
 * else, so "earn on your position" was advice to a person who had no way of
 * getting one. The farm screen linked out to the site and the journey ended
 * at a browser tab.
 *
 * Adding liquidity is genuinely harder than a swap, and the reasons are worth
 * writing down because every one of them is a rule in this file:
 *
 *  - **It is two assets, and only one of them is typed.** A pool that already
 *    exists has a price, and that price fixes the second amount exactly —
 *    `pairedAmount` derives it, and the screen never lets somebody type both
 *    into an existing pool, because the router would silently keep the smaller
 *    side and hand the rest back.
 *  - **A pool that does *not* exist has no price yet**, so the first deposit
 *    invents one. That is a different act with a different risk and it is
 *    named as one (`opensPool`) rather than being smoothed over.
 *  - **The ratio moves between the quote and the signature.** So both sides
 *    get a floor, exactly as a swap's output does, and the floors travel into
 *    the transaction instead of being re-derived after the hold.
 *  - **Two assets means up to two allowances**, and both are priced before
 *    anything is signed. They are for exactly the amount being deposited —
 *    never `MaxUint256`, the same rule the swap and the farm follow.
 *
 * Amounts arrive and leave in smallest units. Nothing here knows a token's
 * decimals, because a six-decimal USDC rendered as eighteen is off by twelve
 * orders of magnitude.
 *
 * v2 only, deliberately. A v3 position is an NFT holding a price range, not a
 * fungible LP token — it is a different object with a different screen, it is
 * not what the farm stakes, and `/liquidity` → «V3 ranges» already does it.
 */

const ROUTER_ABI = [
    'function addLiquidity(address tokenA,address tokenB,uint amountADesired,uint amountBDesired,uint amountAMin,uint amountBMin,address to,uint deadline) returns (uint,uint,uint)',
    'function addLiquidityETH(address token,uint amountTokenDesired,uint amountTokenMin,uint amountETHMin,address to,uint deadline) payable returns (uint,uint,uint)',
    'function removeLiquidity(address tokenA,address tokenB,uint liquidity,uint amountAMin,uint amountBMin,address to,uint deadline) returns (uint,uint)',
    'function removeLiquidityETH(address token,uint liquidity,uint amountTokenMin,uint amountETHMin,address to,uint deadline) returns (uint,uint)',
];

const FACTORY_ABI = [
    'function getPair(address,address) view returns (address)',
    'function allPairsLength() view returns (uint256)',
    'function allPairs(uint256) view returns (address)',
];

const PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
];

const ERC20_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
];

/**
 * What one deposit into an existing pool may cost.
 *
 * Two transfers in, one LP mint, one reserve update. The cap is the promise
 * the quoted fee makes: a deposit that would cost more is refused rather than
 * signed for the difference.
 */
export const ADD_LIQUIDITY_GAS_CAP = 400_000n;

/**
 * And what it costs when the pool is not there yet.
 *
 * The router asks the factory for the pair, the factory does not have one, and
 * it deploys one by CREATE2 — a whole contract, which is an order of magnitude
 * more gas than the deposit that follows it. Quoting the ordinary figure for
 * this would refuse every first deposit out of gas, which is the one deposit
 * that cannot be retried cheaply.
 */
export const CREATE_PAIR_GAS_CAP = 4_000_000n;

/** Taking a position apart: two transfers out and an LP burn. */
export const REMOVE_LIQUIDITY_GAS_CAP = 400_000n;

/** Gas for one `approve`, generous on purpose — unused gas is refunded. */
export const LP_APPROVE_GAS = 70_000n;

/** Headroom over a live estimate, for the drift between quote and mine. */
const GAS_MARGIN = [125n, 100n] as const;

/** Minutes a signed deposit stays valid before the router refuses it. */
const DEADLINE_SECONDS = 20 * 60;

/** Cyberia's node caps a JSON-RPC batch at 20 calls. */
const BATCH_MAX = 20;

/**
 * The LP a pair burns to itself on its first mint, so the pool can never be
 * emptied to a supply of zero. It comes out of the first depositor's share and
 * is therefore part of what this file promises them.
 */
const MINIMUM_LIQUIDITY = 1_000n;

/** How long the list of the chain's pairs is reused before it is read again. */
const PAIRS_TTL_MS = 5 * 60_000;

const provider = (
    config: LiquidityChainConfig,
    rpcUrl?: string,
): JsonRpcProvider =>
    new JsonRpcProvider(rpcUrl || config.readRpcUrl, config.chainId, {
        staticNetwork: true,
        batchMaxCount: BATCH_MAX,
    });

/** Where a liquidity transaction ends up being read, once it is broadcast. */
export const poolTxUrl = (config: LiquidityChainConfig, hash: string): string =>
    `${config.explorer}/tx/${hash}`;

/** Native coin → the wrapper the pool actually holds. */
const poolAddressOf = (
    asset: SwapAsset,
    config: LiquidityChainConfig,
): string => getAddress(asset.address ?? config.wrappedNative);

/* ---------------------------------------------------------------- pure -- */

/**
 * The second side of a deposit, at the pool's current price.
 *
 * This is Uniswap's own `quote()`: a deposit into an existing pool has to
 * arrive at the ratio the reserves are already at, or the router keeps what
 * fits and refunds the rest — which reads to the depositor as "it took less
 * than I told it to". Null is an empty pool, where there is no ratio yet and
 * the second amount is a decision rather than a derivation.
 */
export const pairedAmount = (
    amount: bigint,
    reserveOfTyped: bigint,
    reserveOfOther: bigint,
): bigint | null => {
    if (amount <= 0n || reserveOfTyped <= 0n || reserveOfOther <= 0n) {
        return null;
    }

    return (amount * reserveOfOther) / reserveOfTyped;
};

/** Integer square root, for the first mint. Babylonian, on bigints. */
export const sqrtBigInt = (value: bigint): bigint => {
    if (value <= 0n) {
        return 0n;
    }

    if (value < 4n) {
        return 1n;
    }

    let guess = value;
    let next = value / 2n + 1n;

    while (next < guess) {
        guess = next;
        next = (value / next + next) / 2n;
    }

    return guess;
};

/**
 * The LP this deposit will mint, as the pair itself computes it.
 *
 * Two branches because a pair has two behaviours. The first deposit sets the
 * price and is paid the geometric mean of what it put in, less the thousand
 * units the pair burns to itself forever. Every deposit after it is paid the
 * *smaller* of what each side is worth in existing supply — which is the pair
 * refusing to pay for a lopsided deposit, and the reason the second amount is
 * derived rather than typed.
 *
 * The protocol fee a pair may mint to its `feeTo` before this is deliberately
 * not modelled: it is a sixth of the growth in the invariant since the last
 * touch, it makes the answer here a shade *pessimistic*, and reading it would
 * cost two more calls for a number below the rounding of everything on screen.
 */
export const mintedLp = (
    amountA: bigint,
    amountB: bigint,
    reserveA: bigint,
    reserveB: bigint,
    totalSupply: bigint,
): bigint => {
    if (amountA <= 0n || amountB <= 0n) {
        return 0n;
    }

    if (totalSupply === 0n || reserveA === 0n || reserveB === 0n) {
        const minted = sqrtBigInt(amountA * amountB) - MINIMUM_LIQUIDITY;

        return minted > 0n ? minted : 0n;
    }

    const fromA = (amountA * totalSupply) / reserveA;
    const fromB = (amountB * totalSupply) / reserveB;

    return fromA < fromB ? fromA : fromB;
};

/**
 * What share of the pool this deposit ends up owning.
 *
 * Against the supply *after* the mint, because that is the pool the depositor
 * will be a member of. Measured in millionths before the float — two bigints
 * divided as numbers lose the answer entirely at eighteen decimals.
 */
export const poolShareAfter = (minted: bigint, totalSupply: bigint): number => {
    const after = totalSupply + minted;

    if (after <= 0n || minted <= 0n) {
        return 0;
    }

    return Number((minted * 1_000_000n) / after) / 1_000_000;
};

/**
 * Why a deposit cannot be signed, in the vocabulary the user can act on.
 *
 * Each of these is a different sentence and a different fix: an amount larger
 * than the balance is typing less, the same asset twice is picking again, and
 * an empty side is a pool whose price this deposit would be inventing.
 */
export type PoolRefusal =
    | 'ok'
    | 'sameAsset'
    | 'empty'
    | 'shortFirst'
    | 'shortSecond';

export const canAddLiquidity = (request: {
    first: SwapAsset;
    second: SwapAsset | null;
    amountFirst: bigint;
    amountSecond: bigint;
    balanceFirst: bigint | null;
    balanceSecond: bigint | null;
}): PoolRefusal => {
    const { first, second } = request;

    if (second === null) {
        return 'empty';
    }

    if (
        (first.address ?? '').toLowerCase() ===
        (second.address ?? '').toLowerCase()
    ) {
        return 'sameAsset';
    }

    if (request.amountFirst <= 0n || request.amountSecond <= 0n) {
        return 'empty';
    }

    if (
        request.balanceFirst !== null &&
        request.amountFirst > request.balanceFirst
    ) {
        return 'shortFirst';
    }

    if (
        request.balanceSecond !== null &&
        request.amountSecond > request.balanceSecond
    ) {
        return 'shortSecond';
    }

    return 'ok';
};

/** How much of a position a withdrawal takes, as LP, from a percentage. */
export const withdrawalLp = (balance: bigint, percent: number): bigint => {
    const clamped = Math.min(100, Math.max(0, Math.round(percent)));

    return (balance * BigInt(clamped)) / 100n;
};

/* --------------------------------------------------------------- reads -- */

export type PairState = {
    /** The pair contract, or null when this deposit would be creating it. */
    address: string | null;
    /** Reserves in the order the two assets were asked about, not token0/1. */
    reserves: [bigint, bigint];
    totalSupply: bigint;
};

/** One pair, read in the caller's own asset order. */
export const readPair = async (
    chainId: number,
    first: SwapAsset,
    second: SwapAsset,
    rpcUrl?: string,
): Promise<PairState> => {
    const config = swapChainFor(chainId);
    const rpc = provider(config, rpcUrl);
    const addressFirst = poolAddressOf(first, config);
    const addressSecond = poolAddressOf(second, config);

    const factory = new Contract(config.factory, FACTORY_ABI, rpc);
    const pairAddress = (await factory.getPair(
        addressFirst,
        addressSecond,
    )) as string;

    if (!pairAddress || /^0x0+$/.test(pairAddress)) {
        return { address: null, reserves: [0n, 0n], totalSupply: 0n };
    }

    const pair = new Contract(pairAddress, PAIR_ABI, rpc);
    const [token0, reserves, totalSupply] = await Promise.all([
        pair.token0() as Promise<string>,
        pair.getReserves() as Promise<[bigint, bigint, bigint]>,
        pair.totalSupply() as Promise<bigint>,
    ]);

    // The pair sorts its tokens by address; the screen sorted them by which
    // box somebody typed in first. Reading them back in the caller's order is
    // the whole reason this function exists rather than a bare `getReserves`.
    const firstIsToken0 = token0.toLowerCase() === addressFirst.toLowerCase();

    return {
        address: pairAddress,
        reserves: firstIsToken0
            ? [reserves[0], reserves[1]]
            : [reserves[1], reserves[0]],
        totalSupply,
    };
};

export type AddLiquidityQuote = {
    chainId: number;
    first: SwapAsset;
    second: SwapAsset;
    amountFirst: bigint;
    amountSecond: bigint;
    /** The floors that get signed, one per side. */
    minFirst: bigint;
    minSecond: bigint;
    slippageBps: number;
    pair: PairState;
    /** LP the pair will mint for this deposit. */
    minted: bigint;
    /** Share of the pool that leaves the depositor with, 0–1. */
    shareAfter: number;
    /** True when there is no pool yet and this deposit sets its price. */
    opensPool: boolean;
    gasLimit: bigint;
    gasPrice: bigint;
    /** Worst case cost of the deposit itself, in wei. */
    fee: bigint;
    /** Cost of the allowance transactions, in wei; zero when none is needed. */
    approvalFee: bigint;
    /** Whether the fee above came from the node or from the static ceiling. */
    estimated: boolean;
    /**
     * What the router still has to be allowed to pull, one entry per side.
     *
     * `reset` marks a token that refuses to move a non-zero allowance in one
     * call — a leftover from an abandoned deposit has to be zeroed first,
     * which is a second transaction and is priced as one.
     */
    approvals: {
        token: string;
        symbol: string;
        spender: string;
        amount: bigint;
        reset: boolean;
    }[];
    /** Which side, if either, is the network's own coin. */
    kind: 'tokens' | 'native-first' | 'native-second';
};

/**
 * Everything a deposit needs before anybody holds a button.
 *
 * The amounts arrive already paired by the screen — `pairedAmount` derives the
 * second from the first against the reserves this same function read a moment
 * earlier — so nothing is re-derived here. What is added is the part that
 * costs a call: the allowances, the gas, and the LP the pair will actually
 * mint.
 */
export const quoteAddLiquidity = async (request: {
    chainId: number;
    first: SwapAsset;
    second: SwapAsset;
    amountFirst: bigint;
    amountSecond: bigint;
    slippageBps: number;
    /** The address that will sign, for the allowances and the estimate. */
    account: string;
    gasPrice: bigint;
    rpcUrl?: string;
}): Promise<AddLiquidityQuote> => {
    const config = swapChainFor(request.chainId);

    if (request.amountFirst <= 0n || request.amountSecond <= 0n) {
        throw new Error('Enter an amount for both sides');
    }

    const addressFirst = poolAddressOf(request.first, config);
    const addressSecond = poolAddressOf(request.second, config);

    if (addressFirst.toLowerCase() === addressSecond.toLowerCase()) {
        throw new Error('A pool is two different assets.');
    }

    const rpc = provider(config, request.rpcUrl);
    const pair = await readPair(
        request.chainId,
        request.first,
        request.second,
        request.rpcUrl,
    );

    const spender = getAddress(config.router);

    /*
     * One allowance per ERC-20 side, for exactly this deposit's amount.
     *
     * The coin needs none — it travels as the transaction's value — which is
     * why the native side is skipped rather than approved against its wrapper:
     * `addLiquidityETH` wraps it inside the router and the wrapper never
     * passes through the depositor's hands at all.
     */
    const approvals = await Promise.all(
        [
            { asset: request.first, amount: request.amountFirst },
            { asset: request.second, amount: request.amountSecond },
        ]
            .filter((side) => side.asset.address !== null)
            .map(async (side) => {
                const token = new Contract(side.asset.address!, ERC20_ABI, rpc);
                const allowance = (await token.allowance(
                    request.account,
                    spender,
                )) as bigint;

                return allowance >= side.amount
                    ? null
                    : {
                          token: getAddress(side.asset.address!),
                          symbol: side.asset.symbol,
                          spender,
                          amount: side.amount,
                          reset: allowance > 0n,
                      };
            }),
    );

    const needed = approvals.filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null,
    );

    const kind: AddLiquidityQuote['kind'] =
        request.first.address === null
            ? 'native-first'
            : request.second.address === null
              ? 'native-second'
              : 'tokens';

    const minFirst = applySlippage(request.amountFirst, request.slippageBps);
    const minSecond = applySlippage(request.amountSecond, request.slippageBps);

    const ceiling =
        pair.address === null ? CREATE_PAIR_GAS_CAP : ADD_LIQUIDITY_GAS_CAP;

    /*
     * A live estimate, but only once the router may actually move the tokens.
     * Without the allowance in place the deposit reverts on the transfer, so
     * there is nothing to estimate and the static ceiling is what the fee
     * promises — and what the transaction is then signed for.
     */
    const estimate = await (async (): Promise<bigint | null> => {
        if (needed.length > 0) {
            return null;
        }

        try {
            const router = new Contract(config.router, ROUTER_ABI, rpc);
            const deadline = BigInt(
                Math.floor(Date.now() / 1_000) + DEADLINE_SECONDS,
            );

            const gas =
                kind === 'tokens'
                    ? ((await router.addLiquidity.estimateGas(
                          addressFirst,
                          addressSecond,
                          request.amountFirst,
                          request.amountSecond,
                          minFirst,
                          minSecond,
                          request.account,
                          deadline,
                          { from: request.account },
                      )) as bigint)
                    : ((await router.addLiquidityETH.estimateGas(
                          kind === 'native-first'
                              ? addressSecond
                              : addressFirst,
                          kind === 'native-first'
                              ? request.amountSecond
                              : request.amountFirst,
                          kind === 'native-first' ? minSecond : minFirst,
                          kind === 'native-first' ? minFirst : minSecond,
                          request.account,
                          deadline,
                          {
                              from: request.account,
                              value:
                                  kind === 'native-first'
                                      ? request.amountFirst
                                      : request.amountSecond,
                          },
                      )) as bigint);

            return (gas * GAS_MARGIN[0]) / GAS_MARGIN[1];
        } catch {
            return null;
        }
    })();

    const gasLimit = estimate ?? ceiling;

    if (gasLimit > ceiling) {
        throw new Error(
            'This deposit would cost more gas than this wallet will spend on one.',
        );
    }

    const approvalFee = needed.reduce(
        (total, entry) =>
            total + LP_APPROVE_GAS * (entry.reset ? 2n : 1n) * request.gasPrice,
        0n,
    );

    const minted = mintedLp(
        request.amountFirst,
        request.amountSecond,
        pair.reserves[0],
        pair.reserves[1],
        pair.totalSupply,
    );

    return {
        chainId: config.chainId,
        first: request.first,
        second: request.second,
        amountFirst: request.amountFirst,
        amountSecond: request.amountSecond,
        minFirst,
        minSecond,
        slippageBps: request.slippageBps,
        pair,
        minted,
        shareAfter: poolShareAfter(minted, pair.totalSupply),
        opensPool: pair.address === null || pair.totalSupply === 0n,
        gasLimit,
        gasPrice: request.gasPrice,
        fee: gasLimit * request.gasPrice,
        approvalFee,
        estimated: estimate !== null,
        approvals: needed,
        kind,
    };
};

export type LpPosition = {
    pair: string;
    tokens: [string, string];
    symbols: [string, string];
    decimals: [number, number];
    /** LP held by this account, in the wallet and not staked anywhere. */
    balance: bigint;
    totalSupply: bigint;
    reserves: [bigint, bigint];
};

const pairCache = new Map<number, { at: number; pairs: string[] }>();

/** Every pair the factory has created. Pools appear; they do not move. */
const allPairs = async (
    config: LiquidityChainConfig,
    rpcUrl?: string,
): Promise<string[]> => {
    const cached = pairCache.get(config.chainId);

    if (cached && Date.now() - cached.at < PAIRS_TTL_MS) {
        return cached.pairs;
    }

    const rpc = provider(config, rpcUrl);
    const factory = new Contract(config.factory, FACTORY_ABI, rpc);
    const length = Number((await factory.allPairsLength()) as bigint);

    const pairs = (await Promise.all(
        Array.from(
            { length },
            (_unused, index) => factory.allPairs(index) as Promise<string>,
        ),
    )) as string[];

    pairCache.set(config.chainId, { at: Date.now(), pairs });

    return pairs;
};

/** Forget the cached pair list — for a screen that just created a pool. */
export const forgetPairs = (): void => pairCache.clear();

/**
 * The LP this account is holding, pool by pool.
 *
 * Read from the chain rather than from the indexer, for the same reason the
 * route graph is: a pool opened an hour ago is exactly the one somebody is
 * checking on. A pair that will not answer is dropped rather than rendered as
 * a zero — a zero is a claim about this account, an unread pair is a claim
 * about the node.
 *
 * Only what is *in the wallet*. LP that is staked in the farm is the farm
 * screen's answer and appears there; showing it here as withdrawable would be
 * offering to remove liquidity the router cannot reach.
 */
export const readLpPositions = async (
    chainId: number,
    owner: string,
    rpcUrl?: string,
): Promise<LpPosition[]> => {
    const config = swapChainFor(chainId);
    const rpc = provider(config, rpcUrl);
    const pairs = await allPairs(config, rpcUrl);

    const results = await Promise.allSettled(
        pairs.map(async (address): Promise<LpPosition | null> => {
            const pair = new Contract(address, PAIR_ABI, rpc);
            const balance = (await pair.balanceOf(owner)) as bigint;

            if (balance <= 0n) {
                return null;
            }

            const [token0, token1, reserves, totalSupply] = await Promise.all([
                pair.token0() as Promise<string>,
                pair.token1() as Promise<string>,
                pair.getReserves() as Promise<[bigint, bigint, bigint]>,
                pair.totalSupply() as Promise<bigint>,
            ]);

            const first = new Contract(token0, ERC20_ABI, rpc);
            const second = new Contract(token1, ERC20_ABI, rpc);
            const [symbol0, symbol1, decimals0, decimals1] = await Promise.all([
                first.symbol() as Promise<string>,
                second.symbol() as Promise<string>,
                first.decimals() as Promise<bigint>,
                second.decimals() as Promise<bigint>,
            ]);

            return {
                pair: getAddress(address),
                tokens: [getAddress(token0), getAddress(token1)],
                symbols: [symbol0, symbol1],
                decimals: [Number(decimals0), Number(decimals1)],
                balance,
                totalSupply,
                reserves: [reserves[0], reserves[1]],
            };
        }),
    );

    return results.flatMap((result) =>
        result.status === 'fulfilled' && result.value !== null
            ? [result.value]
            : [],
    );
};

export type RemoveLiquidityQuote = {
    chainId: number;
    position: LpPosition;
    /** LP being burned. */
    liquidity: bigint;
    /** What comes back, in the position's own token order. */
    amounts: [bigint, bigint];
    minAmounts: [bigint, bigint];
    slippageBps: number;
    /** Whether the wrapped-native side is unwrapped to the coin on the way. */
    toCoin: boolean;
    gasLimit: bigint;
    gasPrice: bigint;
    fee: bigint;
    approvalFee: bigint;
    approval: {
        token: string;
        spender: string;
        amount: bigint;
        reset: boolean;
    } | null;
};

/** Whether this pool holds the chain's wrapped coin, and on which side. */
export const wrappedSide = (
    position: LpPosition,
    config: LiquidityChainConfig,
): 0 | 1 | null => {
    const wrapped = config.wrappedNative.toLowerCase();

    if (position.tokens[0].toLowerCase() === wrapped) {
        return 0;
    }

    return position.tokens[1].toLowerCase() === wrapped ? 1 : null;
};

export const quoteRemoveLiquidity = async (request: {
    chainId: number;
    position: LpPosition;
    liquidity: bigint;
    slippageBps: number;
    /** Take the wrapped side back as the coin, where the pool holds it. */
    toCoin: boolean;
    account: string;
    gasPrice: bigint;
    rpcUrl?: string;
}): Promise<RemoveLiquidityQuote> => {
    const config = swapChainFor(request.chainId);

    if (request.liquidity <= 0n) {
        throw new Error('Choose how much to take out');
    }

    if (request.liquidity > request.position.balance) {
        throw new Error('That is more than this account holds of that pool');
    }

    const rpc = provider(config, request.rpcUrl);
    const spender = getAddress(config.router);
    const pair = new Contract(request.position.pair, ERC20_ABI, rpc);
    const allowance = (await pair.allowance(
        request.account,
        spender,
    )) as bigint;

    const { totalSupply, reserves } = request.position;
    const amounts: [bigint, bigint] =
        totalSupply > 0n
            ? [
                  (reserves[0] * request.liquidity) / totalSupply,
                  (reserves[1] * request.liquidity) / totalSupply,
              ]
            : [0n, 0n];

    const approval =
        allowance >= request.liquidity
            ? null
            : {
                  token: request.position.pair,
                  spender,
                  amount: request.liquidity,
                  // An LP token is this DEX's own contract and never a
                  // USDT-style one, so a leftover allowance can be raised in
                  // a single call.
                  reset: false,
              };

    const toCoin =
        request.toCoin && wrappedSide(request.position, config) !== null;

    return {
        chainId: config.chainId,
        position: request.position,
        liquidity: request.liquidity,
        amounts,
        minAmounts: [
            applySlippage(amounts[0], request.slippageBps),
            applySlippage(amounts[1], request.slippageBps),
        ],
        slippageBps: request.slippageBps,
        toCoin,
        gasLimit: REMOVE_LIQUIDITY_GAS_CAP,
        gasPrice: request.gasPrice,
        fee: REMOVE_LIQUIDITY_GAS_CAP * request.gasPrice,
        approvalFee: approval === null ? 0n : LP_APPROVE_GAS * request.gasPrice,
        approval,
    };
};

/* ------------------------------------------------------------- writing -- */

export type PoolReceipt = {
    /** Hashes of the allowance transactions this act needed, in order. */
    approvalHashes: string[];
    hash: string;
};

const signerFor = (
    source: WalletKeySource,
    config: LiquidityChainConfig,
    rpcUrl?: string,
) => evmSigner(source).connect(provider(config, rpcUrl));

/**
 * Sign the deposit the user agreed to.
 *
 * Nothing is re-quoted between the hold and the signature: the amounts, the
 * two floors, the gas limit and the gas price are the ones that were on
 * screen. The deadline is the single exception, and it is refreshed rather
 * than reused because the one in the quote was cut for the moment it was read.
 */
export const executeAddLiquidity = async (
    source: WalletKeySource,
    request: {
        quote: AddLiquidityQuote;
        /** Where the LP goes — this wallet's own address on this chain. */
        recipient: string;
        rpcUrl?: string;
        /** Called as each allowance is mined, before the deposit is signed. */
        onApproved?: (hash: string) => void;
    },
): Promise<PoolReceipt> => {
    const { quote } = request;
    const config = swapChainFor(quote.chainId);
    const signer = signerFor(source, config, request.rpcUrl);
    const router = new Contract(config.router, ROUTER_ABI, signer);
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + DEADLINE_SECONDS);
    const approvalHashes: string[] = [];

    for (const entry of quote.approvals) {
        const token = new Contract(entry.token, ERC20_ABI, signer);
        const overrides = {
            gasLimit: LP_APPROVE_GAS,
            gasPrice: quote.gasPrice,
        };

        if (entry.reset) {
            await (await token.approve(entry.spender, 0n, overrides)).wait();
        }

        const approval = await token.approve(
            entry.spender,
            entry.amount,
            overrides,
        );

        await approval.wait();
        approvalHashes.push(approval.hash as string);
        request.onApproved?.(approval.hash as string);
    }

    const overrides: Record<string, bigint> = {
        gasLimit: quote.gasLimit,
        gasPrice: quote.gasPrice,
    };

    if (quote.kind === 'tokens') {
        const tx = await router.addLiquidity(
            poolAddressOf(quote.first, config),
            poolAddressOf(quote.second, config),
            quote.amountFirst,
            quote.amountSecond,
            quote.minFirst,
            quote.minSecond,
            request.recipient,
            deadline,
            overrides,
        );

        return { approvalHashes, hash: tx.hash as string };
    }

    const nativeIsFirst = quote.kind === 'native-first';

    const tx = await router.addLiquidityETH(
        poolAddressOf(nativeIsFirst ? quote.second : quote.first, config),
        nativeIsFirst ? quote.amountSecond : quote.amountFirst,
        nativeIsFirst ? quote.minSecond : quote.minFirst,
        nativeIsFirst ? quote.minFirst : quote.minSecond,
        request.recipient,
        deadline,
        {
            ...overrides,
            value: nativeIsFirst ? quote.amountFirst : quote.amountSecond,
        },
    );

    return { approvalHashes, hash: tx.hash as string };
};

/** Burn LP and take the two assets back out. */
export const executeRemoveLiquidity = async (
    source: WalletKeySource,
    request: {
        quote: RemoveLiquidityQuote;
        recipient: string;
        rpcUrl?: string;
        onApproved?: (hash: string) => void;
    },
): Promise<PoolReceipt> => {
    const { quote } = request;
    const config = swapChainFor(quote.chainId);
    const signer = signerFor(source, config, request.rpcUrl);
    const router = new Contract(config.router, ROUTER_ABI, signer);
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + DEADLINE_SECONDS);
    const approvalHashes: string[] = [];

    if (quote.approval !== null) {
        const pair = new Contract(quote.approval.token, ERC20_ABI, signer);
        const approval = await pair.approve(
            quote.approval.spender,
            quote.approval.amount,
            { gasLimit: LP_APPROVE_GAS, gasPrice: quote.gasPrice },
        );

        await approval.wait();
        approvalHashes.push(approval.hash as string);
        request.onApproved?.(approval.hash as string);
    }

    const overrides = {
        gasLimit: quote.gasLimit,
        gasPrice: quote.gasPrice,
    };

    const wrapped = wrappedSide(quote.position, config);

    if (quote.toCoin && wrapped !== null) {
        const tokenIndex = wrapped === 0 ? 1 : 0;

        const tx = await router.removeLiquidityETH(
            quote.position.tokens[tokenIndex],
            quote.liquidity,
            quote.minAmounts[tokenIndex],
            quote.minAmounts[wrapped],
            request.recipient,
            deadline,
            overrides,
        );

        return { approvalHashes, hash: tx.hash as string };
    }

    const tx = await router.removeLiquidity(
        quote.position.tokens[0],
        quote.position.tokens[1],
        quote.liquidity,
        quote.minAmounts[0],
        quote.minAmounts[1],
        request.recipient,
        deadline,
        overrides,
    );

    return { approvalHashes, hash: tx.hash as string };
};
