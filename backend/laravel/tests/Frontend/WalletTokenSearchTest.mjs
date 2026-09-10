import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeOffers } from '@/lib/wallet/crosschain';
import {
    dexScreenerChartUrl,
    dexScreenerSlug,
    marketFor,
    readDexPairs,
    summariseMarkets,
} from '@/lib/wallet/dexscreener';

/**
 * Finding the token somebody actually means.
 *
 * The wallet can trade on chains where Cyberia runs nothing, which makes
 * "which token is this" a question with three answers and no authority: the
 * router's catalogue, the pool index, and the chain itself. What is pinned
 * here is how those three are combined, because every mistake in that
 * combination is somebody buying the wrong token — nine of them share a name,
 * and the one they mean is the one with money in it.
 */

const pair = (overrides = {}) => ({
    chainId: 'solana',
    dexId: 'pumpswap',
    url: 'https://dexscreener.com/solana/x',
    pairAddress: 'Dk19ZrUAJLW2e6Ra1qkaZk1pwb48y5cwQu6xfcFXYtEg',
    priceChange: { h24: 50.9 },
    baseToken: { address: 'MINT1', symbol: 'CYBER.sol', name: 'cyber.sol' },
    quoteToken: { address: 'SOL', symbol: 'SOL', name: 'Wrapped SOL' },
    priceUsd: '0.000034',
    liquidity: { usd: 17284.69 },
    volume: { h24: 9709.6 },
    pairCreatedAt: 1776000000000,
    ...overrides,
});

/* --------------------------------------------------------- reading the index -- */

test('both shapes the index answers in are read, and junk is dropped', () => {
    // `/latest/dex/search` wraps its rows; `/tokens/v1` returns them bare.
    assert.equal(readDexPairs({ pairs: [pair()] }).length, 1);
    assert.equal(readDexPairs([pair()]).length, 1);

    // A row with no chain, or with a side missing, cannot be placed on a
    // network or named, so it is not a row.
    assert.deepEqual(readDexPairs([{ baseToken: {}, quoteToken: {} }]), []);
    assert.deepEqual(readDexPairs([pair({ chainId: 7 })]), []);
    assert.deepEqual(readDexPairs([pair({ baseToken: { symbol: 'X' } })]), []);
    assert.deepEqual(readDexPairs(null), []);
});

test('a price that is not a number is absent, never zero', () => {
    const [row] = readDexPairs([
        pair({ priceUsd: undefined, liquidity: {}, volume: {} }),
    ]);

    // Zero is a price. "The index did not say" is not, and a token drawn as
    // free is the one mistake a price column must never make.
    assert.equal(row.priceUsd, null);
    assert.equal(row.liquidityUsd, null);
    assert.equal(row.volume24hUsd, null);
});

/* -------------------------------------------------------------- summarising -- */

test('depth is summed across pools and the deepest one sets the price', () => {
    const [market] = summariseMarkets(
        readDexPairs([
            pair({ priceUsd: '9', liquidity: { usd: 100 } }),
            pair({
                priceUsd: '10',
                liquidity: { usd: 900 },
                dexId: 'raydium',
                url: 'https://dexscreener.com/solana/deep',
            }),
        ]),
    );

    assert.equal(market.pools, 2);
    assert.equal(market.liquidityUsd, 1000);
    // Not the first row the index happened to return: for a token that
    // graduated off a launchpad, that is regularly the dead bonding curve.
    assert.equal(market.priceUsd, 10);
    assert.equal(market.dex, 'raydium');
});

test('a token is summarised only where it is the base side', () => {
    // The index prices the base token of a pair. Reading a pair's price for
    // its quote token would report SOL's price as the token's.
    const markets = summariseMarkets(readDexPairs([pair()]));

    assert.equal(markets.length, 1);
    assert.equal(markets[0].address, 'MINT1');
    assert.equal(marketFor(markets, 'SOL'), null);
});

test('markets come back deepest first', () => {
    const markets = summariseMarkets(
        readDexPairs([
            pair({ baseToken: { address: 'SHALLOW', symbol: 'CYBER', name: 'c' }, liquidity: { usd: 340 } }),
            pair({ baseToken: { address: 'DEEP', symbol: 'CYBER', name: 'c' }, liquidity: { usd: 17000 } }),
        ]),
    );

    assert.deepEqual(
        markets.map((market) => market.address),
        ['DEEP', 'SHALLOW'],
    );
});

test('a mint is matched exactly and an EVM contract case-insensitively', () => {
    const solana = summariseMarkets(readDexPairs([pair()]));

    assert.ok(marketFor(solana, 'MINT1'));
    // base58 uses upper and lower case as different characters: lowercasing a
    // Solana mint to compare it compares two strings that are not addresses.
    assert.equal(marketFor(solana, 'mint1'), null);

    const evm = summariseMarkets(
        readDexPairs([
            pair({
                chainId: 'base',
                baseToken: {
                    address: '0xAbC0000000000000000000000000000000000001',
                    symbol: 'X',
                    name: 'X',
                },
            }),
        ]),
    );

    assert.ok(marketFor(evm, '0xabc0000000000000000000000000000000000001'));
});

/* ------------------------------------------------------------------- chains -- */

test('a network with no slug is not annotated rather than guessed at', () => {
    assert.equal(dexScreenerSlug('solana'), 'solana');
    assert.equal(dexScreenerSlug('bnb'), 'bsc');

    // Cyberia's own pools are read from the factory graph this project runs;
    // an unknown slug would answer `[]`, which is indistinguishable from a
    // real chain with no pools and would read as "no market" forever.
    assert.equal(dexScreenerSlug('cyberia'), null);
});

/* ------------------------------------------------------------------ merging -- */

const listed = (overrides = {}) => ({
    chainId: 792703809,
    address: 'MINT1',
    symbol: 'CYBER.sol',
    name: 'cyber.sol',
    decimals: 6,
    verified: false,
    logo: '',
    ...overrides,
});

test('the router leads, the pools follow, and nothing appears twice', () => {
    const markets = summariseMarkets(
        readDexPairs([
            pair(),
            pair({
                baseToken: { address: 'MINT2', symbol: 'OTHER', name: 'o' },
                liquidity: { usd: 5 },
            }),
        ]),
    );

    const offers = mergeOffers([listed()], markets);

    assert.deepEqual(
        offers.map((offer) => offer.address),
        ['MINT1', 'MINT2'],
    );

    // A row the router carries keeps the router's decimals and is not
    // "unlisted" merely because the pools know it too.
    assert.equal(offers[0].unlisted, false);
    assert.equal(offers[0].decimals, 6);
    assert.equal(offers[0].market.liquidityUsd, 17284.69);
});

test('a pool-only row carries no scale until the chain is asked', () => {
    const markets = summariseMarkets(readDexPairs([pair()]));
    const [offer] = mergeOffers([], markets);

    assert.equal(offer.unlisted, true);
    assert.equal(offer.market.priceUsd, 0.000034);
    // Not 18, not 9, not 6. The index does not report decimals, and a guessed
    // scale is the difference between buying a token and buying a millionth of
    // one — so the screen reads it off the chain when the row is picked.
    assert.equal(offer.decimals, 0);
});

test('what the chain itself answered outranks both other sources', () => {
    const markets = summariseMarkets(readDexPairs([pair()]));
    const pasted = {
        ...listed({ decimals: 6 }),
        market: null,
        unlisted: true,
    };

    const offers = mergeOffers([listed({ decimals: 18 })], markets, [pasted]);

    assert.equal(offers.length, 1);
    // The address was pasted and read on chain: that row is first, keeps its
    // own decimals, and still picks up the market the index knows about.
    assert.equal(offers[0].decimals, 6);
    assert.equal(offers[0].market.liquidityUsd, 17284.69);
    // …and is not badged as unknown to the router, because it is not: the
    // badge says how much is known, not how the user happened to find it.
    assert.equal(offers[0].unlisted, false);
});

test('a pasted address the router never heard of stays badged as such', () => {
    const offers = mergeOffers([], [], [
        { ...listed(), market: null, unlisted: true },
    ]);

    assert.equal(offers[0].unlisted, true);
});

test('one contract written two ways is one row on an EVM chain', () => {
    const offers = mergeOffers(
        [
            listed({ address: '0xAbC0000000000000000000000000000000000001' }),
            listed({ address: '0xabc0000000000000000000000000000000000001' }),
        ],
        [],
    );

    assert.equal(offers.length, 1);
});

test('the day\'s move comes from the deepest pool and is never averaged', () => {
    const [market] = summariseMarkets(
        readDexPairs([
            pair({ liquidity: { usd: 100 }, priceChange: { h24: -3 } }),
            pair({ liquidity: { usd: 900 }, priceChange: { h24: 19 } }),
        ]),
    );

    // A change is a ratio and ratios do not add: an average of −3% and +19%
    // is a number that happened in neither pool.
    assert.equal(market.priceChange24h, 19);
});

test('a pool that reported no change says so rather than reading as flat', () => {
    const [market] = summariseMarkets(readDexPairs([pair({ priceChange: {} })]));

    assert.equal(market.priceChange24h, null);
});

/* -------------------------------------------------------------------- chart -- */

test('a chart is addressed by slug and pool, and only through the embed path', () => {
    const [market] = summariseMarkets(readDexPairs([pair()]));
    const url = dexScreenerChartUrl(market, { theme: 'dark' });

    assert.ok(url.startsWith('https://dexscreener.com/solana/Dk19Zr'));
    // Without `embed=1` the index answers a frame with 403 and
    // X-Frame-Options: SAMEORIGIN — the plain page is not embeddable.
    assert.match(url, /[?&]embed=1(&|$)/);
    assert.match(url, /[?&]theme=dark(&|$)/);
    // The chart inside the embed is a separate widget with its own theme, and
    // sending only the outer one leaves a black chart in a white wallet.
    assert.match(url, /[?&]chartTheme=dark(&|$)/);
});

test('nothing but a slug and a pool address is ever put in a frame src', () => {
    // This string becomes an iframe `src`, and it is built from values that
    // arrived over the network. A pool address that is not one is no chart.
    assert.equal(
        dexScreenerChartUrl(
            { chain: 'solana', pairAddress: null },
            { theme: 'dark' },
        ),
        null,
    );
    assert.equal(
        dexScreenerChartUrl(
            { chain: 'solana', pairAddress: '../../evil?x=' },
            { theme: 'dark' },
        ),
        null,
    );
    assert.equal(
        dexScreenerChartUrl(
            { chain: 'sol ana', pairAddress: 'Dk19ZrUAJLW2e6Ra1qkaZk1pwb48y5cwQu6xfcFXYtEg' },
            { theme: 'dark' },
        ),
        null,
    );
});

/* ------------------------------------------------------------------ ordering -- */

test('the list is ordered by how much money is in the pools', () => {
    const markets = summariseMarkets(
        readDexPairs([
            pair({
                baseToken: { address: 'DEEP', symbol: 'CYBER', name: 'c' },
                liquidity: { usd: 17000 },
            }),
            pair({
                baseToken: { address: 'SHALLOW', symbol: 'CYBER', name: 'c' },
                liquidity: { usd: 340 },
            }),
        ]),
    );

    // The router listed the shallow one first; depth is what the reader can
    // check, so depth decides and the number is printed on the row.
    const offers = mergeOffers(
        [listed({ address: 'SHALLOW' }), listed({ address: 'DEEP' })],
        markets,
    );

    assert.deepEqual(
        offers.map((offer) => offer.address),
        ['DEEP', 'SHALLOW'],
    );
});

test('a row with no market keeps its place instead of ranking as zero', () => {
    const markets = summariseMarkets(
        readDexPairs([
            pair({
                baseToken: { address: 'DEEP', symbol: 'X', name: 'x' },
                liquidity: { usd: 900 },
            }),
        ]),
    );

    const offers = mergeOffers(
        [
            listed({ address: 'NOMARKET1' }),
            listed({ address: 'NOMARKET2' }),
            listed({ address: 'DEEP' }),
        ],
        markets,
    );

    // Unknown is not empty: the ones nobody priced go last, in the order they
    // came, rather than being sorted against a depth of zero they never had.
    assert.deepEqual(
        offers.map((offer) => offer.address),
        ['DEEP', 'NOMARKET1', 'NOMARKET2'],
    );
});

test('what the chain answered stays pinned above the ranking', () => {
    const markets = summariseMarkets(
        readDexPairs([
            pair({
                baseToken: { address: 'DEEP', symbol: 'X', name: 'x' },
                liquidity: { usd: 900000 },
            }),
        ]),
    );

    const offers = mergeOffers(
        [listed({ address: 'DEEP' })],
        markets,
        [{ ...listed({ address: 'PASTED' }), market: null, unlisted: true }],
    );

    // A pasted address is not a suggestion to be ranked — it is the thing
    // that was asked for, even against a market a thousand times deeper.
    assert.equal(offers[0].address, 'PASTED');
});
