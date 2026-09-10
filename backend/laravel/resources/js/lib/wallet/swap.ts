import { Contract, JsonRpcProvider, getAddress } from 'ethers';
import type { V3Route } from '@/lib/dexV3';
import {
    v3AfterFee,
    v3BestRoute,
    v3IntegratorFee,
    v3SwapCall,
} from '@/lib/dexV3';
import { LIQUIDITY_CHAINS } from '@/lib/liquidityChains';
import type { LiquidityChainConfig } from '@/lib/liquidityChains';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';

/**
 * Trading one asset for another from inside the wallet.
 *
 * The DEX is a QuickSwap (Uniswap v2) fork, so a swap is a path through pools
 * and a quote is what the router says that path pays right now. Two facts
 * follow and this file is built around them: the *route* decides the price, so
 * it is searched rather than assumed; and the quote is only true for the block
 * it was read in, so what the user agreed to travels into the signature as a
 * floor — `minOut` — instead of being re-derived at execution time.
 *
 * Everything here is per chain, from the registry the DEX pages already use
 * (`lib/liquidityChains.ts`): Cyberia's router never sees Robinhood liquidity
 * and vice versa. Nothing in this file knows a token's decimals — amounts
 * arrive in smallest units and leave in smallest units, because a six-decimal
 * USDC rendered as eighteen is off by twelve orders of magnitude.
 *
 * Wrapping the native coin is *not* here. It is 1:1, has no route, no price
 * and no slippage, and pretending it is a trade would put three meaningless
 * numbers in front of a signature — `lib/wallet/wrap.ts` does that instead.
 */

/** Exact-input swaps and the read that prices them. Nothing else is signed. */
const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
    'function swapExactTokensForTokens(uint amountIn,uint amountOutMin,address[] path,address to,uint deadline) returns (uint[])',
    'function swapExactETHForTokens(uint amountOutMin,address[] path,address to,uint deadline) payable returns (uint[])',
    'function swapExactTokensForETH(uint amountIn,uint amountOutMin,address[] path,address to,uint deadline) returns (uint[])',
];

const FACTORY_ABI = [
    'function allPairsLength() view returns (uint256)',
    'function allPairs(uint256) view returns (address)',
];

const PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
];

const ERC20_ABI = [
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
];

/**
 * Gas this wallet will spend on one swap, and the ceiling every quote is
 * checked against.
 *
 * A single-hop swap costs 120–160k; each further hop adds another pool's
 * transfers on top. The cap is what makes the quoted fee a promise: a swap
 * that would cost more than the sentence the user read is refused instead of
 * signed for the difference.
 */
export const SWAP_GAS_CAP = 600_000n;

/** Gas for one `approve`, generous on purpose — unused gas is refunded. */
export const APPROVE_GAS = 70_000n;

/** Headroom over a live estimate, for the drift between quote and mine. */
const GAS_MARGIN = [125n, 100n] as const;

/** Minutes the signed swap stays valid before the router refuses it. */
const DEADLINE_SECONDS = 20 * 60;

/** How long a chain's pool graph is reused before it is read again. */
const EDGES_TTL_MS = 5 * 60_000;

/**
 * Runners-up kept on a quote. Three, because the list answers "was there
 * another way" and not "here is the whole graph".
 */
const ALTERNATIVES_SHOWN = 3;

/**
 * Cyberia's node caps a JSON-RPC batch at 20 calls, and reading the pool graph
 * is nothing but small calls — so the provider batches to that, rather than
 * having the node drop half a graph on a busy chain.
 */
const BATCH_MAX = 20;

/** The native coin is `null` everywhere in this wallet; a token is its address. */
export type SwapAsset = {
    /** Contract, or null for the network's own coin. */
    address: string | null;
    symbol: string;
    decimals: number;
};

export type SwapQuote = {
    /** EVM chain id, so a quote cannot be executed against another network. */
    chainId: number;
    /** Token contracts the trade walks, native already mapped to wrapped. */
    path: string[];
    amountIn: bigint;
    /** What the router pays right now, in the output asset's own units. */
    amountOut: bigint;
    /** The floor that gets signed: `amountOut` less the accepted slippage. */
    minOut: bigint;
    slippageBps: number;
    /** How far this trade moves the pool price, or null when unreadable. */
    impactPct: number | null;
    gasLimit: bigint;
    gasPrice: bigint;
    /** Worst case cost of the swap itself, in wei. */
    fee: bigint;
    /** Cost of the allowance transactions, in wei; zero when none is needed. */
    approvalFee: bigint;
    /**
     * The allowance the router still needs before this swap can move anything.
     *
     * `reset` marks the tokens that refuse to change a non-zero allowance in
     * one call — an approval left over from an abandoned swap has to be zeroed
     * first, which is a second transaction and is priced as one.
     */
    approval: {
        token: string;
        /**
         * Who is allowed to pull it. Not `config.router`: the two venues on a
         * chain have two routers, and an allowance granted to the one that is
         * not doing the trade is a transaction that pays for nothing and a
         * swap that reverts on the transfer anyway.
         */
        spender: string;
        amount: bigint;
        reset: boolean;
    } | null;
    /** Which side of the trade is the native coin — decided once, here. */
    kind: 'native-in' | 'native-out' | 'tokens';
    /** False when the node would not price the swap and the cap was used. */
    estimated: boolean;
    /**
     * The routes this trade was chosen *over*, best first, without the winner.
     *
     * The search already prices every candidate path, so these cost nothing
     * extra — they were computed and thrown away. Showing them is the only way
     * a screen can say "there is a route and this one is better" rather than
     * asserting a single path as if it were the only one. Capped, because a
     * chain with many hubs produces a list nobody reads.
     */
    alternatives: { path: string[]; amountOut: bigint }[];
    /**
     * What this project takes out of the output, in basis points, or 0.
     *
     * On screen rather than only in the calldata: `amountOut` above is already
     * net of it, and a number that quietly differs from the pool's own quote is
     * the thing every fee-taking front end gets wrong.
     */
    appFeeBps: number;
    /**
     * The concentrated-liquidity route, present only when v3 is what won.
     *
     * A v2 trade is fully described by `path`; a v3 trade is not — the same
     * two tokens have a pool per fee tier, and which one the router is sent to
     * is part of the route. So the winning route travels whole into the
     * signature rather than being rebuilt from the path afterwards.
     */
    v3Route?: V3Route;
};

/* ------------------------------------------------------------ registry -- */

/** Networks with a DEX this wallet can trade on. */
export const swapChains = (): readonly LiquidityChainConfig[] =>
    LIQUIDITY_CHAINS;

/** The DEX on one chain, or a throw — never a silent fallback to another. */
export const swapChainFor = (chainId: number): LiquidityChainConfig => {
    const config = LIQUIDITY_CHAINS.find(
        (candidate) => candidate.chainId === chainId,
    );

    if (!config) {
        throw new Error(`No exchange is deployed on chain ${chainId}`);
    }

    return config;
};

export const hasSwap = (chainId: number | undefined): boolean =>
    chainId !== undefined &&
    LIQUIDITY_CHAINS.some((candidate) => candidate.chainId === chainId);

const provider = (
    config: LiquidityChainConfig,
    rpcUrl?: string,
): JsonRpcProvider =>
    new JsonRpcProvider(rpcUrl || config.readRpcUrl, config.chainId, {
        staticNetwork: true,
        batchMaxCount: BATCH_MAX,
    });

/** Where a swap ends up being read, once it is broadcast. */
export const swapTxUrl = (config: LiquidityChainConfig, hash: string): string =>
    `${config.explorer}/tx/${hash}`;

/* ------------------------------------------------------------- routing -- */

const edgeCache = new Map<number, { at: number; edges: [string, string][] }>();

/**
 * Every pair the factory has ever created, as undirected edges.
 *
 * Read from the chain rather than from the indexer because a pool opened an
 * hour ago is exactly the one a wallet is asked to trade, and the indexer can
 * lag by weeks. It is three calls per pair, so the result is cached per chain
 * for a few minutes — pools appear, they do not move.
 */
export const poolEdges = async (
    config: LiquidityChainConfig,
    rpcUrl?: string,
): Promise<[string, string][]> => {
    const cached = edgeCache.get(config.chainId);

    if (cached && Date.now() - cached.at < EDGES_TTL_MS) {
        return cached.edges;
    }

    const rpc = provider(config, rpcUrl);
    const factory = new Contract(config.factory, FACTORY_ABI, rpc);
    const length = Number((await factory.allPairsLength()) as bigint);

    const pairs = (await Promise.all(
        Array.from(
            { length },
            (_, index) => factory.allPairs(index) as Promise<string>,
        ),
    )) as string[];

    const edges = (
        await Promise.all(
            pairs.map(async (address): Promise<[string, string] | null> => {
                const pair = new Contract(address, PAIR_ABI, rpc);

                try {
                    const [token0, token1] = await Promise.all([
                        pair.token0() as Promise<string>,
                        pair.token1() as Promise<string>,
                    ]);

                    return [token0.toLowerCase(), token1.toLowerCase()];
                } catch {
                    // A pair that will not answer is a pool nothing can route
                    // through; dropping it is what the router would do anyway.
                    return null;
                }
            }),
        )
    ).filter((edge): edge is [string, string] => edge !== null);

    edgeCache.set(config.chainId, { at: Date.now(), edges });

    return edges;
};

/** Forget the cached graph — for a screen that wants a route to a new pool. */
export const forgetPoolEdges = (): void => edgeCache.clear();

/**
 * Candidate paths from one token to another over the pool graph.
 *
 * Pure, and pinned by a test, because this is what decides the price: a pair
 * with no direct pool is not "no liquidity", it is a hop away, and a wallet
 * that only tries the direct path tells the user their trade is impossible
 * while the DEX quotes it happily.
 *
 * Up to three hops — direct, one intermediate, two intermediates — plus the
 * chain's hubs as a fallback for the pools the graph missed. Every candidate
 * is priced by the router afterwards, so a path through an empty pool costs a
 * failed call and nothing else.
 */
export const swapPaths = (
    edges: readonly (readonly [string, string])[],
    from: string,
    to: string,
    hubs: readonly string[] = [],
    limit = 24,
): string[][] => {
    const start = from.toLowerCase();
    const end = to.toLowerCase();

    if (start === end) {
        return [];
    }

    const adjacency = new Map<string, Set<string>>();
    const link = (a: string, b: string): void => {
        const key = a.toLowerCase();

        if (!adjacency.has(key)) {
            adjacency.set(key, new Set());
        }

        adjacency.get(key)!.add(b.toLowerCase());
    };

    for (const [token0, token1] of edges) {
        link(token0, token1);
        link(token1, token0);
    }

    const paths: string[][] = [[start, end]];
    const fromStart = adjacency.get(start) ?? new Set<string>();
    const intoEnd = adjacency.get(end) ?? new Set<string>();

    for (const middle of fromStart) {
        if (middle !== end && intoEnd.has(middle)) {
            paths.push([start, middle, end]);
        }
    }

    for (const first of fromStart) {
        if (first === end) {
            continue;
        }

        const fromFirst = adjacency.get(first) ?? new Set<string>();

        for (const second of intoEnd) {
            if (
                second === start ||
                second === first ||
                !fromFirst.has(second)
            ) {
                continue;
            }

            paths.push([start, first, second, end]);
        }
    }

    for (const hub of hubs) {
        const key = hub.toLowerCase();

        if (key !== start && key !== end) {
            paths.push([start, key, end]);
        }
    }

    const seen = new Set<string>();

    return paths
        .filter((path) => {
            const key = path.join('>');

            if (seen.has(key)) {
                return false;
            }

            seen.add(key);

            return true;
        })
        .slice(0, limit);
};

/**
 * The amount that actually gets signed.
 *
 * A quote is true for one block. Between reading it and mining the swap the
 * pool moves, so the router is given a floor rather than the quote: below it
 * the whole swap reverts and nothing is spent. This is the number that stands
 * between a user and a sandwich, which is why it is pure and pinned.
 */
export const applySlippage = (amountOut: bigint, bps: number): bigint => {
    if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) {
        throw new Error('Slippage must be between 0 and 100 percent');
    }

    return (amountOut * BigInt(10_000 - bps)) / 10_000n;
};

/**
 * How far this trade moves the price, against a probe of the same path.
 *
 * The probe is a ten-thousandth of the input, so it pays the marginal (spot)
 * rate; the ratio of the two rates is the move the trade itself causes. The
 * 0.3%-per-hop pool fee is in both rates and cancels out, which is why this
 * reads as impact and not as "fees plus impact".
 */
export const priceImpactPct = (
    amountIn: bigint,
    amountOut: bigint,
    probeIn: bigint,
    probeOut: bigint,
): number | null => {
    if (amountIn === 0n || probeIn === 0n || probeOut === 0n) {
        return null;
    }

    const execution = Number(amountOut) / Number(amountIn);
    const spot = Number(probeOut) / Number(probeIn);

    if (!Number.isFinite(execution) || !Number.isFinite(spot) || spot === 0) {
        return null;
    }

    const impact = (1 - execution / spot) * 100;

    // A trade smaller than rounding can price a hair *better* than spot; that
    // is noise in the last wei, not a gift, so it reads as zero.
    return impact > 0 ? impact : 0;
};

/* ------------------------------------------------------------- quoting -- */

/** Static fallback when the node will not price the swap. */
const staticSwapGas = (hops: number): bigint =>
    150_000n + 110_000n * BigInt(Math.max(0, hops - 1));

const routerAddressOf = (
    asset: SwapAsset,
    config: LiquidityChainConfig,
): string =>
    asset.address === null
        ? getAddress(config.wrappedNative)
        : getAddress(asset.address);

/**
 * What this swap pays and what it costs, before anything is signed.
 *
 * Reads, in order: the pool graph, every candidate path at the real amount,
 * a probe for the price impact, the router's allowance, and a gas estimate of
 * the exact call that will be signed. What comes back is the whole of what the
 * user is shown — and `executeSwap` will not exceed any of it.
 */
export const quoteSwap = async (request: {
    chainId: number;
    from: SwapAsset;
    to: SwapAsset;
    amountIn: bigint;
    slippageBps: number;
    /** The address that will sign, for the allowance and the gas estimate. */
    account: string;
    /** Price per unit of gas, floors already applied by the chain adapter. */
    gasPrice: bigint;
    rpcUrl?: string;
}): Promise<SwapQuote> => {
    const config = swapChainFor(request.chainId);

    if (request.amountIn <= 0n) {
        throw new Error('Enter an amount to swap');
    }

    const inputAddress = routerAddressOf(request.from, config);
    const outputAddress = routerAddressOf(request.to, config);

    if (inputAddress.toLowerCase() === outputAddress.toLowerCase()) {
        // Coin → its own wrapper is a deposit, not a trade. The router has no
        // pool for it and would simply revert, so the caller is told what this
        // actually is instead of being handed a failure.
        throw new Error(
            'These are the same asset — wrapping is on the Wrap tab, not here.',
        );
    }

    const rpc = provider(config, request.rpcUrl);
    const router = new Contract(config.router, ROUTER_ABI, rpc);
    const edges = await poolEdges(config, request.rpcUrl);
    const candidates = swapPaths(
        edges,
        inputAddress,
        outputAddress,
        config.hubs,
    );

    const priced = await Promise.all(
        candidates.map(async (path) => {
            try {
                const amounts = (await router.getAmountsOut(
                    request.amountIn,
                    path,
                )) as bigint[];

                return { path, amountOut: amounts[amounts.length - 1] };
            } catch {
                // A path with an empty or missing pool: not a route, not an
                // error the user did anything about.
                return null;
            }
        }),
    );

    const v2Best = priced.reduce<{ path: string[]; amountOut: bigint } | null>(
        (winner, candidate) =>
            candidate !== null &&
            candidate.amountOut > 0n &&
            (winner === null || candidate.amountOut > winner.amountOut)
                ? candidate
                : winner,
        null,
    );

    /*
     * The same trade, asked of the concentrated-liquidity pools.
     *
     * Both venues are asked and the better answer wins — the rule `/swap`
     * already follows, brought here because the wallet now trades chains where
     * the two hold *different assets* rather than competing over the same ones.
     * On Robinhood Chain our own fork holds the bridged CYBER and ASH while
     * every tokenised stock lives in Uniswap's v3 pools, so a wallet that asked
     * only one venue would tell somebody their trade is impossible while the
     * other one quotes it happily.
     *
     * A v3 stack that throws is treated as a venue with nothing in it, never as
     * a failed quote: v2 may still have the route.
     */
    const v3Config = config.v3;
    const v3 = v3Config
        ? await v3BestRoute(
              rpc,
              v3Config,
              inputAddress,
              outputAddress,
              request.amountIn,
              config.hubs,
          ).catch(() => null)
        : null;

    /*
     * Net of this project's fee, because that is what the user receives and
     * therefore the only number the other venue can honestly be compared
     * against. The route keeps the gross — the router checks its own balance
     * before it splits it, so the floor that gets signed is derived from there.
     */
    const v3Best =
        v3 !== null && v3.amountOut > 0n
            ? {
                  path: v3.tokens,
                  amountOut: v3Config
                      ? v3AfterFee(v3Config, v3.amountOut)
                      : v3.amountOut,
              }
            : null;

    const best =
        v3Best !== null &&
        (v2Best === null || v3Best.amountOut > v2Best.amountOut)
            ? v3Best
            : v2Best;

    if (best === null) {
        throw new Error(
            'No pool route connects those two assets on this network.',
        );
    }

    const onV3 = best === v3Best;

    /**
     * Everything the winner beat, best first.
     *
     * Compared by identity rather than by path: the losing venue's route can
     * name the same two tokens as the winner's — that is the ordinary case when
     * both hold the pair — and dropping it by path would hide the one
     * comparison this list exists to show.
     */
    const alternatives = [
        ...priced.filter(
            (candidate): candidate is { path: string[]; amountOut: bigint } =>
                candidate !== null && candidate.amountOut > 0n,
        ),
        ...(v3Best === null ? [] : [v3Best]),
    ]
        .filter((candidate) => candidate !== best)
        .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))
        .slice(0, ALTERNATIVES_SHOWN);

    /*
     * The move this trade causes, probed through the venue that won.
     *
     * A ten-thousandth of the input pays the marginal rate, and the ratio of
     * the two rates is the impact. It has to be asked of the *same* venue: a
     * v3 quote compared against a v2 spot price is two different markets
     * subtracted from each other, and on concentrated liquidity the difference
     * is not small — inside a tick range the price barely moves and one tick
     * further it moves a lot.
     */
    const impact = await (async (): Promise<number | null> => {
        const probeIn = request.amountIn / 10_000n;

        if (probeIn === 0n) {
            return 0;
        }

        try {
            if (onV3 && v3Config) {
                const probe = await v3BestRoute(
                    rpc,
                    v3Config,
                    inputAddress,
                    outputAddress,
                    probeIn,
                    config.hubs,
                );

                /*
                 * Both sides gross. Comparing the net answer against a gross
                 * probe would read this project's own fee as the market moving
                 * against the trade, and print it as price impact.
                 */
                return probe === null || probe.amountOut === 0n || v3 === null
                    ? null
                    : priceImpactPct(
                          request.amountIn,
                          v3.amountOut,
                          probeIn,
                          probe.amountOut,
                      );
            }

            const amounts = (await router.getAmountsOut(
                probeIn,
                best.path,
            )) as bigint[];

            return priceImpactPct(
                request.amountIn,
                best.amountOut,
                probeIn,
                amounts[amounts.length - 1],
            );
        } catch {
            return null;
        }
    })();

    const kind: SwapQuote['kind'] =
        request.from.address === null
            ? 'native-in'
            : request.to.address === null
              ? 'native-out'
              : 'tokens';

    const minOut = applySlippage(best.amountOut, request.slippageBps);
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + DEADLINE_SECONDS);

    /** The router doing this trade, which is not always the chain's `router`. */
    const spender =
        onV3 && v3Config
            ? getAddress(v3Config.router)
            : getAddress(config.router);

    /**
     * The floor the router itself checks, which is the **gross**: its fee hooks
     * test the balance they are holding before taking a share of it. `minOut`
     * above is the same floor seen from the user's side, after the fee.
     */
    const grossMinOut =
        v3 === null ? 0n : applySlippage(v3.amountOut, request.slippageBps);

    /** The transaction a v3 win will be signed as — quoted from, then signed. */
    const v3Call =
        onV3 && v3Config && v3 !== null
            ? v3SwapCall(v3Config, {
                  route: v3,
                  recipient: request.account,
                  amountOutMinimum: grossMinOut,
                  exactIn: true,
                  nativeIn: request.from.address === null,
                  nativeOut: request.to.address === null,
                  deadline,
              })
            : null;

    /**
     * The allowance the router needs to pull the input token.
     *
     * Exactly this swap's amount, not an unlimited one: an unlimited approval
     * outlives the trade it was granted for, and a wallet that quietly leaves
     * one behind on every swap has handed the router a standing claim on the
     * whole balance. The cost is one approval per swap, and it is quoted.
     */
    const approval = await (async (): Promise<SwapQuote['approval']> => {
        if (kind === 'native-in') {
            return null;
        }

        const token = new Contract(inputAddress, ERC20_ABI, rpc);
        const allowance = (await token.allowance(
            request.account,
            spender,
        )) as bigint;

        if (allowance >= request.amountIn) {
            return null;
        }

        return {
            token: inputAddress,
            spender,
            amount: request.amountIn,
            reset: allowance > 0n,
        };
    })();

    const hops = best.path.length - 1;
    const estimate = await (async (): Promise<bigint | null> => {
        // With no allowance in place the swap reverts on the transfer, so
        // there is nothing to estimate yet — the static figure below is what
        // the fee promises, and it is the one the transaction is signed for.
        if (approval !== null) {
            return null;
        }

        try {
            if (v3Call !== null) {
                // The exact bytes that will be signed, priced by the node: a
                // fee quoted from a differently-shaped call is a fee that
                // promises what the signature does not deliver.
                const gas = await rpc.estimateGas({
                    ...v3Call,
                    from: request.account,
                });

                return (gas * GAS_MARGIN[0]) / GAS_MARGIN[1];
            }

            const overrides =
                kind === 'native-in'
                    ? { from: request.account, value: request.amountIn }
                    : { from: request.account };

            const gas =
                kind === 'native-in'
                    ? ((await router.swapExactETHForTokens.estimateGas(
                          minOut,
                          best.path,
                          request.account,
                          deadline,
                          overrides,
                      )) as bigint)
                    : kind === 'native-out'
                      ? ((await router.swapExactTokensForETH.estimateGas(
                            request.amountIn,
                            minOut,
                            best.path,
                            request.account,
                            deadline,
                            overrides,
                        )) as bigint)
                      : ((await router.swapExactTokensForTokens.estimateGas(
                            request.amountIn,
                            minOut,
                            best.path,
                            request.account,
                            deadline,
                            overrides,
                        )) as bigint);

            return (gas * GAS_MARGIN[0]) / GAS_MARGIN[1];
        } catch {
            return null;
        }
    })();

    const gasLimit = estimate ?? staticSwapGas(hops);

    if (gasLimit > SWAP_GAS_CAP) {
        throw new Error(
            'This route would cost more gas than this wallet will spend on one swap.',
        );
    }

    const approvalFee =
        approval === null
            ? 0n
            : APPROVE_GAS * (approval.reset ? 2n : 1n) * request.gasPrice;

    return {
        chainId: config.chainId,
        path: best.path,
        amountIn: request.amountIn,
        amountOut: best.amountOut,
        minOut,
        slippageBps: request.slippageBps,
        impactPct: impact,
        gasLimit,
        gasPrice: request.gasPrice,
        fee: gasLimit * request.gasPrice,
        approvalFee,
        approval,
        kind,
        estimated: estimate !== null,
        alternatives,
        appFeeBps: onV3 && v3Config ? (v3IntegratorFee(v3Config)?.bps ?? 0) : 0,
        ...(onV3 && v3 !== null ? { v3Route: v3 } : {}),
    };
};

/* ----------------------------------------------------------- executing -- */

export type SwapReceipt = {
    /** Hash of the allowance transaction, when this swap needed one. */
    approvalHash: string | null;
    hash: string;
};

/**
 * Sign and broadcast the swap the user agreed to.
 *
 * `quote` is what they read and held a button for, so it is what gets signed:
 * the gas limit, the gas price and — the one that protects the money — the
 * minimum output. Nothing here re-quotes: a better price is a bonus the router
 * pays out on its own, and a worse one reverts instead of executing.
 *
 * An allowance, when one is needed, is a separate transaction that goes first.
 * It is reported back rather than hidden, because it is the user's coin that
 * paid for it and it lands in their history either way.
 */
export const executeSwap = async (
    source: WalletKeySource,
    request: {
        quote: SwapQuote;
        /** Where the output goes — this wallet's own address on this chain. */
        recipient: string;
        rpcUrl?: string;
        /** Called when the allowance is mined, before the swap is signed. */
        onApproved?: (hash: string) => void;
    },
): Promise<SwapReceipt> => {
    const { quote } = request;
    const config = swapChainFor(quote.chainId);
    const signer = evmSigner(source).connect(provider(config, request.rpcUrl));
    const router = new Contract(config.router, ROUTER_ABI, signer);
    const deadline = BigInt(Math.floor(Date.now() / 1_000) + DEADLINE_SECONDS);

    let approvalHash: string | null = null;

    if (quote.approval !== null) {
        const token = new Contract(quote.approval.token, ERC20_ABI, signer);
        const overrides = {
            gasLimit: APPROVE_GAS,
            gasPrice: quote.gasPrice,
        };

        // Tokens written against the original USDT refuse to move a non-zero
        // allowance to another non-zero one. Zeroing first is the only way
        // past a leftover approval, and it was priced in the quote.
        if (quote.approval.reset) {
            await (
                await token.approve(quote.approval.spender, 0n, overrides)
            ).wait();
        }

        const approval = await token.approve(
            quote.approval.spender,
            quote.approval.amount,
            overrides,
        );

        await approval.wait();
        approvalHash = approval.hash as string;
        request.onApproved?.(approvalHash);
    }

    const overrides: Record<string, bigint> = {
        gasLimit: quote.gasLimit,
        gasPrice: quote.gasPrice,
    };

    if (quote.kind === 'native-in') {
        overrides.value = quote.amountIn;
    }

    if (quote.v3Route !== undefined) {
        const v3Config = config.v3;

        if (!v3Config) {
            throw new Error(
                'This quote was made against a v3 stack this network no longer has.',
            );
        }

        /*
         * Rebuilt from the quote and not re-routed: the tiers, the floor and
         * the deadline are the ones the user held a button over. The deadline
         * is the single exception, and it is refreshed rather than reused
         * because the one in the quote was cut for the moment it was read.
         *
         * The floor handed to the router is the **gross** one, derived from the
         * route's own (pre-fee) output and the slippage the user agreed to —
         * `quote.minOut` is that same floor after the fee, which is what the
         * screen showed. Passing the net here would set a bar the router
         * cannot clear once it takes its share, and every swap would revert.
         */
        const call = v3SwapCall(v3Config, {
            route: quote.v3Route,
            recipient: request.recipient,
            amountOutMinimum: applySlippage(
                quote.v3Route.amountOut,
                quote.slippageBps,
            ),
            exactIn: true,
            nativeIn: quote.kind === 'native-in',
            nativeOut: quote.kind === 'native-out',
            deadline,
        });

        const sent = await signer.sendTransaction({
            ...call,
            gasLimit: quote.gasLimit,
            gasPrice: quote.gasPrice,
        });

        return { approvalHash, hash: sent.hash };
    }

    const tx =
        quote.kind === 'native-in'
            ? await router.swapExactETHForTokens(
                  quote.minOut,
                  quote.path,
                  request.recipient,
                  deadline,
                  overrides,
              )
            : quote.kind === 'native-out'
              ? await router.swapExactTokensForETH(
                    quote.amountIn,
                    quote.minOut,
                    quote.path,
                    request.recipient,
                    deadline,
                    overrides,
                )
              : await router.swapExactTokensForTokens(
                    quote.amountIn,
                    quote.minOut,
                    quote.path,
                    request.recipient,
                    deadline,
                    overrides,
                );

    return { approvalHash, hash: tx.hash as string };
};
