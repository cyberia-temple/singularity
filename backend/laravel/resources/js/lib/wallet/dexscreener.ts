import type { WalletChainId } from '@/lib/wallet/chains';

/**
 * What is actually traded on a network, from the index that watches the pools.
 *
 * The wallet already has two sources for "which token do you mean". On Cyberia
 * it walks the factory's own pair graph, because it runs that exchange. On
 * every other network it asks the router, because the router is what will fill
 * the trade — and that answer is deliberately narrow: a catalogue of tokens it
 * has decided to carry.
 *
 * Neither of them answers the question somebody actually arrives with, which
 * is "this address, the one in the message I was sent". A token minted on
 * pump.fun this morning has a market, a price and eight hundred holders, and
 * is in nobody's catalogue. Searching for it by name returns nine tokens with
 * the same name, one of which is the one they mean.
 *
 * So this module adds the third source, and it is the one the user pointed at:
 * DexScreener indexes the *pools*, on every chain, keylessly. What it gives is
 * not permission to trade — that stays with whoever fills the order — but the
 * two facts that make a choice possible: **is there a market at all**, and
 * **how deep is it**. Two tokens called CYBER stop being indistinguishable the
 * moment one has $17k of liquidity and the other has $340.
 *
 * Three properties, and each is a decision:
 *
 *  - **It never supplies decimals.** DexScreener does not return them, and
 *    inventing them is how a balance comes out a million times wrong. Decimals
 *    are read from the chain — the mint account on Solana, `decimals()` on an
 *    ERC-20 — or taken from the router's own catalogue entry.
 *  - **A chain with no slug here is not annotated at all.** The index keys
 *    chains by its own names, not by chain id, so a mapping that does not
 *    exist is left absent rather than guessed: labelling a token with another
 *    chain's market is worse than labelling it with nothing.
 *  - **Nothing here decides anything.** Every number is shown beside a row, and
 *    what can actually be traded is still the router's answer and the quote's.
 */

/* ------------------------------------------------------------------ shape -- */

export type DexTokenRef = {
    address: string;
    symbol: string;
    name: string;
};

/** One pool, reduced to what a row can show. */
export type DexPair = {
    /** DexScreener's own name for the chain — a slug, never a chain id. */
    chain: string;
    dex: string;
    url: string;
    /** The pool's own address, which is what a chart is addressed by. */
    pairAddress: string;
    base: DexTokenRef;
    quote: DexTokenRef;
    /** USD price of the **base** token. Null when the index has none. */
    priceUsd: number | null;
    /** Per cent over 24h, signed. Null is "not reported", never flat. */
    priceChange24h: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    /** Milliseconds, or null — a pool with no birthday is an old one. */
    createdAt: number | null;
};

/**
 * One token as its pools describe it.
 *
 * `liquidityUsd` is summed over every pool the token appears in, because depth
 * is what the number is for and a token split across three pools is not
 * shallower than one that is not. `priceUsd` is taken from the deepest pool
 * where this token is the *base*, since that is the only side DexScreener
 * prices — a token that is only ever the quote asset comes back priced null
 * rather than priced wrong.
 */
export type DexMarket = {
    chain: string;
    address: string;
    symbol: string;
    name: string;
    priceUsd: number | null;
    /**
     * Per cent over 24h, from the deepest pool rather than summed.
     *
     * A change is a ratio and ratios do not add up: averaging one pool's +19%
     * with another's −3% produces a number that happened nowhere. The pool
     * where the money is, is the one whose move is the token's.
     */
    priceChange24h: number | null;
    liquidityUsd: number | null;
    volume24hUsd: number | null;
    /** How many pools carry it — one is a launch, twelve is an asset. */
    pools: number;
    /** The deepest pool's venue, address and page — what a chart is drawn of. */
    dex: string | null;
    pairAddress: string | null;
    url: string | null;
};

/* ------------------------------------------------------------------ chains -- */

/**
 * How DexScreener names the networks this wallet knows.
 *
 * Harvested rather than typed: the slugs were collected out of live search
 * results (every `chainId` the index returned across a hundred token queries)
 * and only a chain whose slug appeared in that harvest is listed here. A guess
 * costs more than an omission — an unknown slug answers `[]`, which is exactly
 * what a real chain with no pools answers, so a wrong mapping would render as
 * "this token has no market" forever and never as an error.
 *
 * Absent on purpose: Cyberia and Robinhood's own pools are read from the
 * factory graph this project runs (`lib/dexV3.ts`, `CyberiaPrices`), which
 * knows about pools the minute they exist rather than the day an indexer
 * notices them. Robinhood is in the index and still not read from it, for the
 * same reason.
 */
const CHAIN_SLUGS: Partial<Record<WalletChainId, string>> = {
    solana: 'solana',
    bnb: 'bsc',
    base: 'base',
    // Robinhood Chain: the index carries it, which is the only reason the
    // tokenised stocks have a price history anywhere on this site — nothing
    // here can rebuild one, since their pools are concentrated and emit no
    // `Sync` for a page to walk.
    robinhood: 'robinhood',

    abstract: 'abstract',
    'arbitrum-one': 'arbitrum',
    avalanche: 'avalanche',
    beam: 'beam',
    berachain: 'berachain',
    blast: 'blast',
    celo: 'celo',
    'conflux-espace': 'conflux',
    cronos: 'cronos',
    ethereum: 'ethereum',
    fantom: 'fantom',
    flare: 'flare',
    'flow-evm': 'flowevm',
    fuse: 'fuse',
    hedera: 'hedera',
    hyperevm: 'hyperevm',
    ink: 'ink',
    katana: 'katana',
    kava: 'kava',
    linea: 'linea',
    'manta-pacific': 'manta',
    mantle: 'mantle',
    merlin: 'merlinchain',
    metis: 'metis',
    monad: 'monad',
    optimism: 'optimism',
    plasma: 'plasma',
    polygon: 'polygon',
    pulsechain: 'pulsechain',
    scroll: 'scroll',
    sei: 'seiv2',
    soneium: 'soneium',
    sonic: 'sonic',
    telos: 'telos',
    unichain: 'unichain',
    'world-chain': 'worldchain',
    'zksync-era': 'zksync',
};

/** The index's name for a wallet network, or null when it has none. */
export const dexScreenerSlug = (chain: WalletChainId): string | null =>
    CHAIN_SLUGS[chain] ?? null;

/* ------------------------------------------------------------------- pure -- */

const number = (value: unknown): number | null => {
    const parsed =
        typeof value === 'number' ? value : Number.parseFloat(String(value));

    return Number.isFinite(parsed) ? parsed : null;
};

const tokenRef = (value: unknown): DexTokenRef | null => {
    const row = (value ?? {}) as Record<string, unknown>;
    const address = typeof row.address === 'string' ? row.address : '';

    if (address === '') {
        return null;
    }

    return {
        address,
        symbol: typeof row.symbol === 'string' ? row.symbol : '',
        name: typeof row.name === 'string' ? row.name : '',
    };
};

/**
 * The index's JSON, reduced to `DexPair`.
 *
 * Exported because it is the whole of the trust boundary: everything below
 * works on the shape this function produces, and a field the index adds next
 * month reaches nothing that draws a screen.
 */
export const readDexPairs = (body: unknown): DexPair[] => {
    const rows = Array.isArray(body)
        ? body
        : Array.isArray((body as { pairs?: unknown })?.pairs)
          ? ((body as { pairs: unknown[] }).pairs ?? [])
          : [];

    const pairs: DexPair[] = [];

    for (const entry of rows) {
        const row = (entry ?? {}) as Record<string, unknown>;
        const base = tokenRef(row.baseToken);
        const quote = tokenRef(row.quoteToken);

        if (
            base === null ||
            quote === null ||
            typeof row.chainId !== 'string'
        ) {
            continue;
        }

        pairs.push({
            chain: row.chainId,
            dex: typeof row.dexId === 'string' ? row.dexId : '',
            pairAddress:
                typeof row.pairAddress === 'string' ? row.pairAddress : '',
            url: typeof row.url === 'string' ? row.url : '',
            base,
            quote,
            priceUsd: number(row.priceUsd),
            priceChange24h: number(
                (row.priceChange as { h24?: unknown } | undefined)?.h24,
            ),
            liquidityUsd: number(
                (row.liquidity as { usd?: unknown } | undefined)?.usd,
            ),
            volume24hUsd: number(
                (row.volume as { h24?: unknown } | undefined)?.h24,
            ),
            createdAt: number(row.pairCreatedAt),
        });
    }

    return pairs;
};

/** Same token written two ways. EVM is case-insensitive; base58 is not. */
const sameMint = (left: string, right: string): boolean =>
    left === right ||
    (left.startsWith('0x') &&
        right.startsWith('0x') &&
        left.toLowerCase() === right.toLowerCase());

/**
 * Every pool a set of tokens appears in, collapsed to one row per token.
 *
 * Deliberately not "the first pair the index returned". The index sorts by its
 * own relevance, and for a token that graduated from a launchpad the first row
 * is regularly the dead bonding-curve pool rather than the live one — so depth
 * decides, and depth is summed rather than picked.
 */
export const summariseMarkets = (pairs: readonly DexPair[]): DexMarket[] => {
    const markets = new Map<string, DexMarket>();
    /* Depth of the single deepest pool per token — which pool's price wins. */
    const deepest = new Map<string, number>();

    for (const pair of pairs) {
        // Only the base side is priced by this index, so only the base side
        // gets a market row. A token that appears solely as somebody else's
        // quote asset is still counted for depth below.
        const key = `${pair.chain}:${pair.base.address}`;
        const existing = markets.get(key);
        const depth = pair.liquidityUsd ?? 0;

        if (existing === undefined) {
            markets.set(key, {
                chain: pair.chain,
                address: pair.base.address,
                symbol: pair.base.symbol,
                name: pair.base.name || pair.base.symbol,
                priceUsd: pair.priceUsd,
                priceChange24h: pair.priceChange24h,
                liquidityUsd: pair.liquidityUsd,
                volume24hUsd: pair.volume24hUsd,
                pools: 1,
                dex: pair.dex || null,
                pairAddress: pair.pairAddress || null,
                url: pair.url || null,
            });
            deepest.set(key, depth);

            continue;
        }

        existing.pools += 1;
        existing.liquidityUsd =
            (existing.liquidityUsd ?? 0) + (pair.liquidityUsd ?? 0);
        existing.volume24hUsd =
            (existing.volume24hUsd ?? 0) + (pair.volume24hUsd ?? 0);

        if (depth > (deepest.get(key) ?? 0)) {
            deepest.set(key, depth);
            existing.priceUsd = pair.priceUsd;
            existing.priceChange24h = pair.priceChange24h;
            existing.dex = pair.dex || existing.dex;
            existing.pairAddress = pair.pairAddress || existing.pairAddress;
            existing.url = pair.url || existing.url;
        }
    }

    return [...markets.values()].sort(
        (a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0),
    );
};

/** The market for one address out of a summary, or null. */
export const marketFor = (
    markets: readonly DexMarket[],
    address: string,
): DexMarket | null =>
    markets.find((market) => sameMint(market.address, address)) ?? null;

/* ------------------------------------------------------------------ chart -- */

/**
 * The pool to chart for one *pair*, out of everything the index carries.
 *
 * Pure, and separate from `summariseMarkets`, because the two answer different
 * questions. A market row wants the token's deepest pool whatever it is priced
 * against — that is where its price comes from. A chart beside a trade wants
 * the pool the trade goes through, and those are routinely not the same pool:
 * NVDA's deepest is against the chain's dollar, while buying it with ether
 * touches a different one. Drawing the first under a heading naming the second
 * is the kind of quiet mismatch nobody catches twice.
 *
 * So: the deepest pool holding **both** sides, and only if there is none, the
 * deepest holding the base at all — with the caller told which it got, since
 * "this is your pair" and "this is the closest thing to it" are different
 * claims to put on a screen.
 */
export const pairPoolFor = (
    pairs: readonly DexPair[],
    base: string,
    quote: string,
): { pair: DexPair; exact: boolean } | null => {
    const holds = (pair: DexPair, token: string): boolean =>
        sameMint(pair.base.address, token) ||
        sameMint(pair.quote.address, token);

    const deepest = (candidates: readonly DexPair[]): DexPair | null =>
        candidates.reduce<DexPair | null>(
            (best, pair) =>
                best === null ||
                (pair.liquidityUsd ?? 0) > (best.liquidityUsd ?? 0)
                    ? pair
                    : best,
            null,
        );

    const both = deepest(
        pairs.filter((pair) => holds(pair, base) && holds(pair, quote)),
    );

    if (both !== null) {
        return { pair: both, exact: true };
    }

    const either = deepest(pairs.filter((pair) => holds(pair, base)));

    return either === null ? null : { pair: either, exact: false };
};

/**
 * The index's own chart for a pool, as a frame.
 *
 * There is already a chart in this wallet and it answers two cases: an asset
 * with an exchange listing gets TradingView, and an asset trading in Cyberia's
 * pools gets candles rebuilt from those pools' `Sync` logs. Neither can draw a
 * token on somebody else's chain — there is no listing, and this project does
 * not index those pools. So the venue that does index them draws it.
 *
 * `?embed=1` is not decoration: the ordinary page answers a frame with `403`
 * and `X-Frame-Options: SAMEORIGIN`, and the embed path answers 200 with
 * neither. Built from the slug and the pool address rather than from the `url`
 * the index handed back, because this string becomes the `src` of a frame and
 * a URL that arrived over the network is not something to put there unread.
 *
 * A frame is also the only acceptable shape. This page holds a decrypted seed
 * in memory and a vault in this origin's storage; a third party's script tag
 * would run inside all of that, and in a frame it is another origin and can
 * reach none of it — the same reasoning `WalletChart.vue` states for
 * TradingView.
 */
export const dexScreenerChartUrl = (
    market: Pick<DexMarket, 'chain' | 'pairAddress'>,
    options: { theme: 'light' | 'dark' },
): string | null => {
    if (market.pairAddress === null || market.pairAddress === '') {
        return null;
    }

    // The slug and a pool address, and nothing a caller typed.
    if (!/^[a-z0-9]+$/.test(market.chain)) {
        return null;
    }

    if (!/^[A-Za-z0-9]{20,64}$/.test(market.pairAddress)) {
        return null;
    }

    const params = new URLSearchParams({
        embed: '1',
        theme: options.theme,
        // Two themes and not one. `theme` paints the index's own chrome;
        // the chart inside it is a separate widget with its own setting, and
        // sending only the first leaves a black chart sitting in a white
        // wallet — which is what shipped for exactly one build.
        chartTheme: options.theme,
        // The trade tape and the token panel are the index's own chrome and
        // repeat what the row above the chart already says.
        trades: '0',
        info: '0',
    });

    return `https://dexscreener.com/${market.chain}/${market.pairAddress}?${params.toString()}`;
};

/* --------------------------------------------------------------- fetching -- */

const API = 'https://api.dexscreener.com';

/** Addresses per `/tokens/v1` call, as the index documents it. */
export const DEX_BATCH = 30;

const cache = new Map<string, { at: number; pairs: DexPair[] }>();
const CACHE_MS = 60_000;

const ask = async (path: string, signal?: AbortSignal): Promise<DexPair[]> => {
    const hit = cache.get(path);

    if (hit !== undefined && Date.now() - hit.at < CACHE_MS) {
        return hit.pairs;
    }

    const response = await fetch(`${API}${path}`, {
        headers: { accept: 'application/json' },
        signal,
    });

    if (!response.ok) {
        throw new Error(`DexScreener answered ${response.status}`);
    }

    const pairs = readDexPairs(await response.json());

    cache.set(path, { at: Date.now(), pairs });

    return pairs;
};

/**
 * Whatever the index has for a term, on one network.
 *
 * The filter is applied here rather than asked for, because the search
 * endpoint has no chain parameter: it answers across every chain it watches,
 * and a row from another one is a token the user cannot buy on the network
 * they are standing on.
 */
export const searchDexMarkets = async (
    chain: WalletChainId,
    term: string,
    signal?: AbortSignal,
): Promise<DexMarket[]> => {
    const slug = dexScreenerSlug(chain);
    const query = term.trim();

    if (slug === null || query === '') {
        return [];
    }

    const pairs = await ask(
        `/latest/dex/search?q=${encodeURIComponent(query)}`,
        signal,
    );

    return summariseMarkets(pairs.filter((pair) => pair.chain === slug));
};

/**
 * What the pools say about tokens this wallet already holds.
 *
 * One call for up to thirty addresses, which is what makes it usable on a
 * balance refresh: a portfolio asking per token would be a request per row.
 */
export const fetchDexMarkets = async (
    chain: WalletChainId,
    addresses: readonly string[],
    signal?: AbortSignal,
): Promise<DexMarket[]> => {
    const slug = dexScreenerSlug(chain);
    const wanted = [...new Set(addresses)].filter((address) => address !== '');

    if (slug === null || wanted.length === 0) {
        return [];
    }

    const batches: string[][] = [];

    for (let index = 0; index < wanted.length; index += DEX_BATCH) {
        batches.push(wanted.slice(index, index + DEX_BATCH));
    }

    const answers = await Promise.all(
        batches.map(async (batch) => {
            try {
                return await ask(
                    `/tokens/v1/${slug}/${batch.join(',')}`,
                    signal,
                );
            } catch {
                // An annotation that failed to load is a missing number beside
                // a row, never a missing row: the balance came from the chain.
                return [];
            }
        }),
    );

    return summariseMarkets(answers.flat());
};

/**
 * Every pool the index carries for one token, so a caller can pick.
 *
 * `fetchDexMarkets` collapses a token to one row and loses the pool list on the
 * way; a chart needs the list. Same cache, same failure rule — an index that
 * did not answer is a missing chart and never a broken screen.
 */
export const fetchDexPairs = async (
    chain: WalletChainId,
    token: string,
    signal?: AbortSignal,
): Promise<DexPair[]> => {
    const slug = dexScreenerSlug(chain);

    if (slug === null || token === '') {
        return [];
    }

    try {
        return await ask(`/token-pairs/v1/${slug}/${token}`, signal);
    } catch {
        return [];
    }
};
