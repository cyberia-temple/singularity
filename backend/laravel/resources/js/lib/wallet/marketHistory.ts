import { Contract, JsonRpcProvider } from 'ethers';
import type { LiquidityChainConfig } from '@/lib/liquidityChains';
import { loadMarketHistory, routePrice } from '@/lib/marketCandles';
import type { MarketHistory, Reserves, RouteHop } from '@/lib/marketCandles';
import { poolEdges, swapPaths } from '@/lib/wallet/swap';

/**
 * Price history for a token that trades only in this chain's own pools.
 *
 * Nothing lists CYBER, LAIN or MINE, so there is no book to read and no feed to
 * subscribe to: their entire price history exists as `Sync` events on a handful
 * of pairs. `lib/marketCandles.ts` already knows how to replay those into
 * candles for the site's `/swap` — this module is only the half that is
 * different in a wallet: finding *which* pools, from the wallet's own pool
 * graph, without the page's DEX state around it.
 *
 * The route matters as much as the pools. A pair's price on this fork is not
 * its direct pool's reserve ratio — thin direct pools get routed around, and
 * charting one would draw a price nobody can trade at — so the history is
 * rebuilt along the path the router would actually quote.
 */

const PAIR_ABI = [
    'function token0() view returns (address)',
    'function getReserves() view returns (uint112,uint112,uint32)',
];

const FACTORY_ABI = [
    'function getPair(address,address) view returns (address)',
];

const ROUTER_ABI = [
    'function getAmountsOut(uint256,address[]) view returns (uint256[])',
];

const ERC20_ABI = ['function decimals() view returns (uint8)'];

const ZERO_PAIR = /^0x0{40}$/i;

export type MarketRoute = {
    hops: RouteHop[];
    reserves: Reserves[];
    /** Token addresses the route walks, for naming it on screen. */
    path: string[];
};

const decimalsCache = new Map<string, number>();

const decimalsOf = async (
    rpc: JsonRpcProvider,
    token: string,
): Promise<number> => {
    const key = `${token.toLowerCase()}`;
    const known = decimalsCache.get(key);

    if (known !== undefined) {
        return known;
    }

    // 18 is the ERC-20 default and the only sane answer for a token that will
    // not say. It is cached like any other so a mute contract is asked once.
    let value = 18;

    try {
        value = Number(
            (await new Contract(token, ERC20_ABI, rpc).decimals()) as bigint,
        );
    } catch {
        value = 18;
    }

    decimalsCache.set(key, value);

    return value;
};

/** Every hop of one path, with the pool and the decimals each side needs. */
const hopsOf = async (
    rpc: JsonRpcProvider,
    config: LiquidityChainConfig,
    path: readonly string[],
): Promise<RouteHop[]> => {
    const factory = new Contract(config.factory, FACTORY_ABI, rpc);

    return Promise.all(
        path.slice(0, -1).map(async (tokenIn, index) => {
            const tokenOut = path[index + 1];
            const [pair, decIn, decOut] = await Promise.all([
                factory.getPair(tokenIn, tokenOut) as Promise<string>,
                decimalsOf(rpc, tokenIn),
                decimalsOf(rpc, tokenOut),
            ]);

            if (ZERO_PAIR.test(pair)) {
                throw new Error('no pool for this hop');
            }

            const token0 = (await new Contract(
                pair,
                PAIR_ABI,
                rpc,
            ).token0()) as string;

            return {
                pair,
                token0: token0.toLowerCase(),
                tokenIn: tokenIn.toLowerCase(),
                tokenOut: tokenOut.toLowerCase(),
                decIn,
                decOut,
            };
        }),
    );
};

/** Live reserves for every hop, which is what turns a route into a price. */
export const routeReserves = async (
    config: LiquidityChainConfig,
    hops: readonly RouteHop[],
    rpcUrl?: string,
): Promise<Reserves[]> => {
    const rpc = new JsonRpcProvider(rpcUrl ?? config.readRpcUrl, undefined, {
        staticNetwork: true,
    });

    return Promise.all(
        hops.map(async (hop) => {
            const reserves = (await new Contract(
                hop.pair,
                PAIR_ABI,
                rpc,
            ).getReserves()) as [bigint, bigint, bigint];

            return [reserves[0], reserves[1]] as Reserves;
        }),
    );
};

/**
 * The path the router would quote from `base` to `quote`, resolved to pools.
 *
 * Candidates come from the same graph search the swap screen trades on, and the
 * winner is picked by asking the router what each one pays — not by hop count.
 * A one-hop path through a $27 pool loses to a two-hop path through real
 * liquidity, and the chart has to follow the money rather than the topology.
 *
 * The probe is one unit of the base token: enough for `getAmountsOut` to rank
 * the paths, small enough that its own impact does not decide the ranking.
 */
export const resolveMarketRoute = async (
    config: LiquidityChainConfig,
    base: string,
    quote: string,
    rpcUrl?: string,
): Promise<MarketRoute | null> => {
    const rpc = new JsonRpcProvider(rpcUrl ?? config.readRpcUrl, undefined, {
        staticNetwork: true,
    });
    const edges = await poolEdges(config, rpcUrl);
    const candidates = swapPaths(edges, base, quote, config.hubs);

    if (candidates.length === 0) {
        return null;
    }

    const router = new Contract(config.router, ROUTER_ABI, rpc);
    const probe = 10n ** BigInt(await decimalsOf(rpc, base));

    const priced = await Promise.all(
        candidates.map(async (path) => {
            try {
                const amounts = (await router.getAmountsOut(
                    probe,
                    path,
                )) as bigint[];

                return { path, out: amounts[amounts.length - 1] };
            } catch {
                // A path through a drained or missing pool. The router refuses
                // it too, so it is not a route.
                return null;
            }
        }),
    );

    const best = priced
        .filter((entry): entry is { path: string[]; out: bigint } => !!entry)
        .reduce<{
            path: string[];
            out: bigint;
        } | null>(
            (winner, entry) =>
                !winner || entry.out > winner.out ? entry : winner,
            null,
        );

    if (!best) {
        return null;
    }

    const hops = await hopsOf(rpc, config, best.path);

    return {
        hops,
        reserves: await routeReserves(config, hops, rpcUrl),
        path: best.path,
    };
};

/**
 * Replay the route's pools into a price series.
 *
 * The explorer and not the RPC, because this needs a block *timestamp* with
 * every log and only the Etherscan-compatible log API returns one. It is a read
 * of public logs with no key, so it costs nothing but the wait.
 */
export const loadRouteHistory = (
    config: LiquidityChainConfig,
    hops: readonly RouteHop[],
    signal?: AbortSignal,
): Promise<MarketHistory> => loadMarketHistory(config.explorer, hops, signal);

/** The route's marginal price right now, or null when a hop is empty. */
export const routeSpot = (
    hops: readonly RouteHop[],
    reserves: readonly Reserves[],
): number | null => routePrice(hops, reserves);
