import type { UTCTimestamp } from 'lightweight-charts';

/**
 * Routed market history for the Ritual DEX (Uniswap V2 fork).
 *
 * A pair's price here is *not* its direct pool's reserve ratio: the router
 * quotes through the best path it can find, and thin or off-market direct
 * pools get bypassed (WCYBER/USDC holds ~$27 and sits ~12% under the routed
 * rate). So the chart reconstructs the price the router would have quoted at
 * every point in time — hop by hop, from each pool's own `Sync` events.
 *
 * Every observation is therefore an on-chain fact with a block timestamp: the
 * series moves only when the chain moves, never because a page sat open. The
 * explorer's Etherscan-compatible log API is used because it returns the block
 * timestamp with each log (the v2 API does not), and both Cyberia's and the
 * satellites' Blockscout instances expose it with permissive CORS.
 */

/** One hop of a swap route, with everything needed to price it. */
export type RouteHop = {
    /** Pair (pool) address. */
    pair: string;
    /** Pool's token0, lowercased — decides reserve orientation. */
    token0: string;
    /** Token entering this hop, lowercased. */
    tokenIn: string;
    /** Token leaving this hop, lowercased. */
    tokenOut: string;
    decIn: number;
    decOut: number;
};

export type Reserves = readonly [bigint, bigint];

export type PriceObservation = { ts: number; price: number };
export type TradePoint = { ts: number; volume: number };

export type MarketHistory = {
    /** Ascending, deduplicated price observations. */
    observations: PriceObservation[];
    /** Swaps through the pool holding the base token (volume in base units). */
    trades: TradePoint[];
    /** First timestamp every hop on the route had known reserves. */
    coverageFrom: number | null;
};

export type MarketCandle = {
    time: UTCTimestamp;
    open: number;
    high: number;
    low: number;
    close: number;
    /** Base-token volume traded in this bucket. */
    volume: number;
    trades: number;
};

export type MarketRange = {
    key: string;
    label: string;
    /** null = every block the route's pools have existed for. */
    windowSec: number | null;
    bucketSec: number;
};

/** Uniswap V2 keeps 0.3% of the input per hop, so the marginal (router) rate
 *  is the reserve ratio net of that fee. Applying it keeps the chart's last
 *  close comparable with the quote the swap form shows. */
const HOP_FEE = 0.997;

const SYNC_TOPIC =
    '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const SWAP_TOPIC =
    '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';

// The v1 log API pages at 1000 entries. Ritual's busiest pool has a few
// hundred lifetime Syncs, so the cap only guards against a runaway pool.
const PAGE_SIZE = 1000;
const MAX_PAGES = 10;
const RATE_LIMIT_ATTEMPTS = 4;
const RATE_LIMIT_MAX_WAIT_MS = 5000;
// Never hand the chart more bars than it can show; coarsen the bucket instead.
const MAX_CANDLES = 720;

export const MARKET_RANGES: readonly MarketRange[] = [
    { key: '1D', label: '24H', windowSec: 86400, bucketSec: 900 },
    { key: '7D', label: '7D', windowSec: 604800, bucketSec: 3600 },
    { key: '30D', label: '30D', windowSec: 2592000, bucketSec: 14400 },
    { key: 'ALL', label: 'ALL', windowSec: null, bucketSec: 86400 },
];

export const marketRange = (key: string): MarketRange =>
    MARKET_RANGES.find((r) => r.key === key) ?? MARKET_RANGES[1];

/**
 * Marginal price of the route in quote-per-base, from each hop's reserves.
 * Returns null when any hop is empty (a drained pool has no price).
 */
export const routePrice = (
    route: readonly RouteHop[],
    reserves: readonly Reserves[],
): number | null => {
    if (route.length === 0 || reserves.length !== route.length) {
        return null;
    }

    let price = 1;

    for (let i = 0; i < route.length; i++) {
        const hop = route[i];
        const [r0, r1] = reserves[i];
        const inIsToken0 = hop.tokenIn === hop.token0;
        const rIn = Number(inIsToken0 ? r0 : r1) / 10 ** hop.decIn;
        const rOut = Number(inIsToken0 ? r1 : r0) / 10 ** hop.decOut;

        if (!(rIn > 0) || !(rOut > 0)) {
            return null;
        }

        price *= (rOut / rIn) * HOP_FEE;
    }

    return Number.isFinite(price) && price > 0 ? price : null;
};

type RawLog = {
    ts: number;
    block: number;
    index: number;
    tx: string;
    data: string;
};

const word = (data: string, i: number): bigint =>
    BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64) || '0'}`);

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

// Public Blockscout instances meter hard — Robinhood's allows one request per
// ~2s and answers 429 to anything concurrent — so every explorer is talked to
// through a single-file queue that paces itself off the rate-limit headers.
const explorerQueues = new Map<string, Promise<unknown>>();

const enqueue = <T>(explorer: string, task: () => Promise<T>): Promise<T> => {
    const previous = explorerQueues.get(explorer) ?? Promise.resolve();
    const next = previous.then(task, task);
    explorerQueues.set(
        explorer,
        next.catch(() => undefined),
    );

    return next;
};

const explorerGet = (
    explorer: string,
    query: URLSearchParams,
    signal?: AbortSignal,
): Promise<{ result?: unknown }> =>
    enqueue(explorer, async () => {
        for (let attempt = 1; ; attempt++) {
            const response = await fetch(
                `${explorer}/api?${query.toString()}`,
                { headers: { Accept: 'application/json' }, signal },
            );
            const resetMs = Number(
                response.headers.get('x-ratelimit-reset') ?? NaN,
            );
            const pause = Math.min(
                Number.isFinite(resetMs) && resetMs > 0 ? resetMs : 1000,
                RATE_LIMIT_MAX_WAIT_MS,
            );

            if (response.status === 429) {
                if (attempt >= RATE_LIMIT_ATTEMPTS) {
                    throw new Error('Explorer rate limit');
                }

                await sleep(pause);

                continue;
            }

            if (!response.ok) {
                throw new Error(`Explorer logs failed (${response.status})`);
            }

            const body = (await response.json()) as { result?: unknown };

            // Budget spent: hold the queue until the window rolls over instead
            // of walking into a 429 with the next page.
            if (response.headers.get('x-ratelimit-remaining') === '0') {
                await sleep(pause);
            }

            return body;
        }
    });

const fetchPairLogs = async (
    explorer: string,
    address: string,
    topic0: string,
    signal?: AbortSignal,
): Promise<RawLog[]> => {
    const logs: RawLog[] = [];

    for (let page = 1; page <= MAX_PAGES; page++) {
        const query = new URLSearchParams({
            module: 'logs',
            action: 'getLogs',
            fromBlock: '0',
            toBlock: 'latest',
            address,
            topic0,
            page: String(page),
            offset: String(PAGE_SIZE),
        });
        // Blockscout answers "no records found" with status 0 and a string
        // result, so anything but an array ends the walk.
        const body = await explorerGet(explorer, query, signal);
        const items = Array.isArray(body.result)
            ? (body.result as Record<string, string>[])
            : [];

        for (const item of items) {
            const ts = parseInt(item.timeStamp, 16);
            const block = parseInt(item.blockNumber, 16);

            if (Number.isFinite(ts) && Number.isFinite(block)) {
                logs.push({
                    ts,
                    block,
                    index: parseInt(item.logIndex, 16) || 0,
                    tx: (item.transactionHash ?? '').toLowerCase(),
                    data: item.data ?? '0x',
                });
            }
        }

        if (items.length < PAGE_SIZE) {
            break;
        }
    }

    return logs.sort((a, b) => a.block - b.block || a.index - b.index);
};

/**
 * Reserves right before the pool's first known Sync. A Uniswap V2 swap emits
 * Sync then Swap in the same transaction, so when the first Sync came from a
 * trade its pre-state is exactly recoverable; otherwise (the pool's funding
 * mint) the post-state is all there is.
 */
const preStateOf = (syncs: RawLog[], swaps: RawLog[]): Reserves => {
    const first = syncs[0];

    if (!first) {
        return [0n, 0n];
    }

    const r0 = word(first.data, 0);
    const r1 = word(first.data, 1);
    const paired = swaps.find(
        (swap) => swap.tx === first.tx && swap.index > first.index,
    );

    if (!paired) {
        return [r0, r1];
    }

    const amount0In = word(paired.data, 0);
    const amount1In = word(paired.data, 1);
    const amount0Out = word(paired.data, 2);
    const amount1Out = word(paired.data, 3);

    return [r0 - amount0In + amount0Out, r1 - amount1In + amount1Out];
};

/**
 * Replay every reserve change on the route into a price series, plus the
 * base-token volume of each swap through the base hop.
 */
export const loadMarketHistory = async (
    explorer: string,
    route: readonly RouteHop[],
    signal?: AbortSignal,
): Promise<MarketHistory> => {
    if (route.length === 0) {
        return { observations: [], trades: [], coverageFrom: null };
    }

    const perHop = await Promise.all(
        route.map(async (hop) => {
            const [syncs, swaps] = await Promise.all([
                fetchPairLogs(explorer, hop.pair, SYNC_TOPIC, signal),
                fetchPairLogs(explorer, hop.pair, SWAP_TOPIC, signal),
            ]);

            return { syncs, swaps };
        }),
    );

    const state: Reserves[] = perHop.map(({ syncs, swaps }) =>
        preStateOf(syncs, swaps),
    );
    // A hop only carries a price once its pool exists; the composite series
    // starts when the last of them came alive.
    const starts = perHop
        .map(({ syncs }) => syncs[0]?.ts)
        .filter((ts): ts is number => typeof ts === 'number');
    const coverageFrom = starts.length > 0 ? Math.max(...starts) : null;

    const events = perHop
        .flatMap(({ syncs }, hop) => syncs.map((log) => ({ hop, log })))
        .sort(
            (a, b) =>
                a.log.block - b.log.block ||
                a.log.index - b.log.index ||
                a.hop - b.hop,
        );

    const observations: PriceObservation[] = [];
    const push = (ts: number, price: number | null): void => {
        if (price === null) {
            return;
        }

        const last = observations[observations.length - 1];

        if (last && last.price === price) {
            return;
        }

        if (last && last.ts > ts) {
            return;
        }

        observations.push({ ts, price });
    };

    if (coverageFrom !== null) {
        push(coverageFrom, routePrice(route, state));
    }

    for (const { hop, log } of events) {
        state[hop] = [word(log.data, 0), word(log.data, 1)];

        if (coverageFrom !== null && log.ts >= coverageFrom) {
            push(log.ts, routePrice(route, state));
        }
    }

    // Volume is the base leg of every swap through the pool that holds the
    // base token — the first hop, since routes start at the base.
    const baseHop = route[0];
    const baseIsToken0 = baseHop.tokenIn === baseHop.token0;
    const trades = perHop[0].swaps
        .map((log) => {
            const amountIn = word(log.data, baseIsToken0 ? 0 : 1);
            const amountOut = word(log.data, baseIsToken0 ? 2 : 3);
            const volume = Number(amountIn + amountOut) / 10 ** baseHop.decIn;

            return { ts: log.ts, volume };
        })
        .filter((trade) => trade.volume > 0);

    return { observations, trades, coverageFrom };
};

/**
 * Bucket the observations into OHLC candles. Gaps are filled with flat
 * candles carrying the previous close forward: on an AMM a quiet market means
 * the reserves — and so the price — genuinely did not move.
 */
export const buildCandles = (
    history: MarketHistory,
    opts: {
        fromSec: number;
        toSec: number;
        bucketSec: number;
        /** Live price, folded into the newest candle when it is fresher. */
        spot?: number | null;
    },
): MarketCandle[] => {
    const { observations, trades } = history;

    if (observations.length === 0) {
        return [];
    }

    const earliest = observations[0].ts;
    const from = Math.max(opts.fromSec, earliest);
    const to = Math.max(opts.toSec, from);
    let bucketSec = opts.bucketSec;
    const span = to - from;

    if (span / bucketSec > MAX_CANDLES) {
        bucketSec *= Math.ceil(span / bucketSec / MAX_CANDLES);
    }

    const bucketOf = (ts: number): number =>
        Math.floor(ts / bucketSec) * bucketSec;

    // Price entering the window: the last observation before it started.
    let carry = observations[0].price;
    const inWindow: PriceObservation[] = [];

    for (const observation of observations) {
        if (observation.ts < from) {
            carry = observation.price;
        } else {
            inWindow.push(observation);
        }
    }

    const byBucket = new Map<number, PriceObservation[]>();

    for (const observation of inWindow) {
        const key = bucketOf(observation.ts);
        const list = byBucket.get(key);

        if (list) {
            list.push(observation);
        } else {
            byBucket.set(key, [observation]);
        }
    }

    const volumeByBucket = new Map<number, { volume: number; count: number }>();

    for (const trade of trades) {
        if (trade.ts < from || trade.ts > to) {
            continue;
        }

        const key = bucketOf(trade.ts);
        const entry = volumeByBucket.get(key) ?? { volume: 0, count: 0 };
        entry.volume += trade.volume;
        entry.count += 1;
        volumeByBucket.set(key, entry);
    }

    const candles: MarketCandle[] = [];

    for (let t = bucketOf(from); t <= bucketOf(to); t += bucketSec) {
        const points = byBucket.get(t) ?? [];
        const volume = volumeByBucket.get(t);

        /*
         * A bucket where nothing happened is not drawn.
         *
         * It used to be, as a flat candle at the carried price, and on a pool
         * that trades a few times a month that is what the chart became: seven
         * hundred one-pixel bars at one price, two real candles somewhere in
         * them, and a dotted line joining the lot. The price did not sit still
         * for thirty days — nobody looked at it, and those are different facts
         * that a flat candle prints identically.
         *
         * `carry` still moves forward, so the next real candle opens where the
         * last one closed and the line stays continuous. The time axis becomes
         * uneven, which is the honest shape: a market with gaps has gaps.
         */
        if (points.length === 0 && volume === undefined) {
            continue;
        }

        const open = carry;
        let high = open;
        let low = open;
        let close = open;

        for (const point of points) {
            high = Math.max(high, point.price);
            low = Math.min(low, point.price);
            close = point.price;
        }

        carry = close;
        candles.push({
            time: t as UTCTimestamp,
            open,
            high,
            low,
            close,
            volume: volume?.volume ?? 0,
            trades: volume?.count ?? 0,
        });
    }

    const last = candles[candles.length - 1];
    const spot = opts.spot;

    /*
     * The live price belongs to the *current* period and only there.
     *
     * While every bucket was drawn, the last candle was always the newest one,
     * so folding the spot into it was folding it into now. With empty buckets
     * gone the last candle can be a month old, and writing today's price into
     * a month-old candle would date the present wrongly — the one thing a
     * chart is read for.
     */
    if (
        last &&
        last.time === (bucketOf(to) as UTCTimestamp) &&
        spot !== null &&
        spot !== undefined &&
        spot > 0
    ) {
        last.close = spot;
        last.high = Math.max(last.high, spot);
        last.low = Math.min(last.low, spot);
    }

    return candles;
};

/**
 * Narrowest range that actually shows price action — a 7-day window on a
 * market that last traded two weeks ago is a flat line telling nobody
 * anything, while ALL shows the real history.
 */
export const autoRangeKey = (
    history: MarketHistory,
    nowSec: number,
): string => {
    const moves = (windowSec: number | null): number => {
        const from = windowSec === null ? -Infinity : nowSec - windowSec;

        return history.observations.filter(
            (observation) => observation.ts >= from,
        ).length;
    };

    return (
        MARKET_RANGES.find((range) => moves(range.windowSec) >= 4)?.key ?? 'ALL'
    );
};
