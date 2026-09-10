import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAddress } from 'ethers';
import { UNISWAP_V3_FEE_TIERS, v3PoolAddress, v3RouterAbi } from '@/lib/dexV3';
import { liquidityChainById } from '@/lib/liquidityChains';
import {
    ROBINHOOD_STOCK_CHAIN_ID,
    ROBINHOOD_STOCKS,
    isStockToken,
    searchStocks,
    stockByAddress,
    stockBySymbol,
} from '@/lib/robinhoodStocks';
import { logoForToken } from '@/lib/tokenLogos';
import { dayPosition, formatStockUsd } from '@/lib/wallet/stocks';

/**
 * The tokenised stocks, and the two claims this project makes about them.
 *
 * The first is identity: a ticker is not an identifier on a chain anyone can
 * deploy to — a router's own search answers "NVDA" on Robinhood Chain with nine
 * different contracts — so the registry's address column is the whole feature
 * and everything that draws a company's name or logo must be keyed by it.
 *
 * The second is that the pools are reachable. Our v3 module derives a pool's
 * address rather than looking it up, and a wrong `initCodeHash` or a fee tier
 * this chain never deployed produces a plausible address with nothing at it —
 * a market that silently does not exist. Both are pinned against a pool that
 * was live when this was written.
 */

/** The Laravel root: this file sits in `tests/Frontend/`. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/* The deepest stock pool on the chain, read from it: NVDA/USDG at 0.05%. */
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const NVDA_USDG_POOL = '0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3';

const robinhood = () => liquidityChainById(ROBINHOOD_STOCK_CHAIN_ID);

test('every listed stock is one row, checksummed and unique', () => {
    assert.ok(ROBINHOOD_STOCKS.length >= 50);

    const symbols = new Set();
    const addresses = new Set();

    for (const stock of ROBINHOOD_STOCKS) {
        assert.equal(
            stock.address,
            getAddress(stock.address),
            `${stock.symbol} is not checksummed`,
        );
        assert.equal(stock.decimals, 18, `${stock.symbol} decimals`);
        assert.ok(
            /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(stock.isin),
            `${stock.symbol} ISIN`,
        );
        assert.ok(['equity', 'fund'].includes(stock.kind));

        assert.ok(!symbols.has(stock.symbol), `${stock.symbol} listed twice`);
        assert.ok(
            !addresses.has(stock.address.toLowerCase()),
            `${stock.address} listed twice`,
        );

        symbols.add(stock.symbol);
        addresses.add(stock.address.toLowerCase());
    }
});

test('every listed stock has an icon on disk, under its real format', () => {
    for (const stock of ROBINHOOD_STOCKS) {
        const path = resolve(ROOT, 'public', stock.icon.slice(1));

        assert.ok(existsSync(path), `no icon for ${stock.symbol} at ${path}`);

        /*
         * The extension has to match the bytes. Eight of these arrive as PNGs
         * from a source that serves everything else as SVG, and a PNG named
         * `.svg` is labelled `image/svg+xml` by the web server and drawn by no
         * browser — a broken icon indistinguishable from a missing one.
         */
        const png =
            readFileSync(path).subarray(0, 8).toString('hex') ===
            '89504e470d0a1a0a';

        assert.equal(
            png,
            path.endsWith('.png'),
            `${stock.symbol}: the file's format and its name disagree`,
        );
    }
});

test('a stock is found by its address, in any casing, and by nothing else', () => {
    const nvda = stockBySymbol('nvda');

    assert.ok(nvda);
    assert.equal(nvda.name, 'NVIDIA');
    assert.equal(stockByAddress(nvda.address.toLowerCase())?.symbol, 'NVDA');
    assert.equal(
        stockByAddress(nvda.address.toUpperCase().replace('0X', '0x'))?.symbol,
        'NVDA',
    );

    // The impostors: same ticker, different contract. Not this token.
    assert.equal(
        stockByAddress('0xddc0b0e504f000a607c9a680c4f9dc3ada001a29'),
        undefined,
    );
});

test('a stock is only a stock on Robinhood Chain', () => {
    const nvda = stockBySymbol('NVDA');

    assert.ok(isStockToken(ROBINHOOD_STOCK_CHAIN_ID, nvda.address));
    assert.ok(!isStockToken(49406, nvda.address));
});

test('a company logo is never drawn from a ticker alone', () => {
    const ford = stockBySymbol('F');

    assert.equal(
        logoForToken(ROBINHOOD_STOCK_CHAIN_ID, ford.address, 'F'),
        ford.icon,
    );
    // The same ticker on any other chain is somebody else's token.
    assert.equal(logoForToken(49406, ford.address, 'F'), undefined);
    assert.equal(logoForToken(ROBINHOOD_STOCK_CHAIN_ID, null, 'F'), undefined);
});

test('search reads tickers, names and the exact ISIN', () => {
    assert.equal(searchStocks('nvid')[0]?.symbol, 'NVDA');
    assert.equal(searchStocks('US67066G1040')[0]?.symbol, 'NVDA');
    assert.equal(searchStocks('').length, ROBINHOOD_STOCKS.length);
    assert.deepEqual(searchStocks('zzzz'), []);
});

test("Robinhood Chain's v3 stack derives the live NVDA pool", () => {
    const cfg = robinhood().v3;

    assert.ok(cfg, 'Robinhood Chain must carry a v3 stack');
    assert.equal(
        v3PoolAddress(cfg, USDG, stockBySymbol('NVDA').address, 500),
        NVDA_USDG_POOL,
    );
    // Uniswap's factory is its own pool deployer; only Pancake splits them.
    assert.equal(cfg.poolDeployer, cfg.factory);
});

test("Uniswap tiers are asked for, not the fork's", () => {
    const cfg = robinhood().v3;

    assert.deepEqual([...cfg.tiers], [...UNISWAP_V3_FEE_TIERS]);
    // 2500 is Pancake's replacement for 0.3% and exists on no Uniswap factory.
    assert.ok(!cfg.tiers.includes(2500));
    assert.ok(cfg.tiers.includes(3000));
});

test('SwapRouter02 is addressed with its own ABI', () => {
    const cfg = robinhood().v3;

    assert.equal(cfg.routerKind, 'swapRouter02');

    const abi = v3RouterAbi(cfg).join('\n');

    // The whole difference between the two routers, in one assertion: the
    // deadline left the parameter struct and became a multicall argument.
    assert.ok(!/exactInputSingle\(\([^)]*deadline/.test(abi));
    assert.ok(abi.includes('multicall(uint256 deadline,bytes[] data)'));

    // …and the fork's router still speaks the older shape.
    const cyberia = liquidityChainById(49406).v3;

    assert.ok(
        /exactInputSingle\(\([^)]*deadline/.test(
            v3RouterAbi(cyberia).join('\n'),
        ),
    );
});

test('every stock is pickable on the exchange page', () => {
    const listed = new Set(
        robinhood().tokens.map((token) => token.address.toLowerCase()),
    );

    for (const stock of ROBINHOOD_STOCKS) {
        assert.ok(
            listed.has(stock.address.toLowerCase()),
            `${stock.symbol} is not in the chain's token list`,
        );
    }

    // The dollar these are quoted in has to be pickable too, and has to be
    // the chain's declared one — routing a stock through ether alone prices
    // it through a pool it did not need.
    assert.equal(robinhood().dollar?.toLowerCase(), USDG.toLowerCase());
    assert.ok(listed.has(USDG.toLowerCase()));
    assert.equal(robinhood().hubs[0].toLowerCase(), USDG.toLowerCase());
});

test('the day marker is a position inside a range, or nothing', () => {
    assert.equal(dayPosition({ share: 5, low: 0, high: 10 }), 0.5);
    assert.equal(dayPosition({ share: 0, low: 0, high: 10 }), 0);
    // A day that has not moved has no inside.
    assert.equal(dayPosition({ share: 5, low: 5, high: 5 }), null);
    assert.equal(dayPosition({ share: null, low: 1, high: 2 }), null);
    // A quote outside the day's own range is clamped rather than drawn off the
    // end of the bar: the two figures come from different reads.
    assert.equal(dayPosition({ share: 99, low: 0, high: 10 }), 1);
});

test('a share price is printed to the cent and no further', () => {
    // The multiplier makes the number long; the market does not quote it that
    // way, and four decimals would claim a precision nobody published.
    assert.equal(formatStockUsd(223.09279848097944, 'en'), '$223.09');
    assert.equal(formatStockUsd(null, 'en'), '\u2014');
});
