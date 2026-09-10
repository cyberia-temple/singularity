import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAddress, Interface } from 'ethers';
import {
    UNISWAP_V3_FEE_TIERS,
    V3_MAX_FEE_BPS,
    v3AfterFee,
    v3IntegratorFee,
    v3PoolAddress,
    v3RouterAbi,
    v3SwapCall,
} from '@/lib/dexV3';
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
import { pairPoolFor } from '@/lib/wallet/dexscreener';
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

test("this project's fee is the router's own hook, inside the router's bounds", () => {
    const cfg = robinhood().v3;
    const fee = v3IntegratorFee(cfg);

    assert.ok(fee, 'the stock chain must carry a fee — nothing else here pays');
    assert.ok(fee.bps >= 1 && fee.bps <= V3_MAX_FEE_BPS);
    assert.match(fee.recipient, /^0x[0-9a-fA-F]{40}$/);

    // Both hooks have to be in the ABI or the calldata cannot be built.
    const abi = v3RouterAbi(cfg).join('\n');

    assert.ok(abi.includes('sweepTokenWithFee('));
    assert.ok(abi.includes('unwrapWETH9WithFee('));
});

test('our own pools are not charged twice', () => {
    // Cyberia's v3 already pays this project a protocol share at the pool, so
    // an integrator fee on top would be the same trade taken from twice.
    assert.equal(v3IntegratorFee(liquidityChainById(49406).v3), null);
    assert.equal(
        v3AfterFee(liquidityChainById(49406).v3, 1_000_000n),
        1_000_000n,
    );
});

test('the net is what the fee leaves, and it rounds down', () => {
    const cfg = robinhood().v3;
    const bps = v3IntegratorFee(cfg).bps;

    assert.equal(v3AfterFee(cfg, 10_000n), BigInt(10_000 - bps));
    // Never rounds *up*: the user is shown no more than the router will pay.
    assert.ok(v3AfterFee(cfg, 1n) <= 1n);
    assert.equal(v3AfterFee(cfg, 0n), 0n);
});

/**
 * The recipient sentinel, which is the difference between a working swap and
 * one that burns the output.
 *
 * `SwapRouter` reads a recipient of `address(0)` as "keep it here";
 * `SwapRouter02` replaced that with `address(2)` and takes a zero recipient
 * literally — so every path that holds the output back (unwrapping to the coin,
 * or taking this project's fee) sends it to the zero address and reverts with
 * `TF`. It cost one live simulation to find and is invisible in every unit that
 * does not look at the encoded recipient.
 */
const decodeCalls = (cfg, data) => {
    const iface = new Interface(v3RouterAbi(cfg));
    const outer = iface.parseTransaction({ data });
    const inner = cfg.routerKind === 'swapRouter02' ? outer.args[1] : [data];

    return inner.map((call) => iface.parseTransaction({ data: call }));
};

const plan = (route, extra = {}) => ({
    route,
    recipient: '0x00000000000000000000000000000000000CaFE1',
    amountOutMinimum: 1n,
    exactIn: true,
    nativeIn: false,
    nativeOut: false,
    deadline: 1n,
    ...extra,
});

const fakeRoute = (a, b) => ({
    tokens: [a, b],
    fees: [500],
    pools: [],
    amountIn: 10n ** 18n,
    amountOut: 10n ** 18n,
    gasEstimate: 0n,
});

test('a fee-taking swap keeps the output in the router, by the right sentinel', () => {
    const cfg = robinhood().v3;
    const route = fakeRoute(cfg.router, stockBySymbol('NVDA').address);
    const calls = decodeCalls(cfg, v3SwapCall(cfg, plan(route)).data);

    assert.deepEqual(
        calls.map((c) => c.name),
        ['exactInputSingle', 'sweepTokenWithFee'],
    );

    // address(2) — Constants.ADDRESS_THIS on SwapRouter02. Zero would be a
    // transfer to the zero address, which the token refuses.
    assert.equal(
        calls[0].args[0].recipient,
        '0x0000000000000000000000000000000000000002',
    );

    const sweep = calls[1].args;

    assert.equal(sweep[0], stockBySymbol('NVDA').address);
    assert.equal(Number(sweep[3]), v3IntegratorFee(cfg).bps);
    assert.equal(sweep[4], v3IntegratorFee(cfg).recipient);
});

test('taking the coin out uses the fee-aware unwrap', () => {
    const cfg = robinhood().v3;
    const route = fakeRoute(stockBySymbol('NVDA').address, cfg.router);
    const calls = decodeCalls(
        cfg,
        v3SwapCall(cfg, plan(route, { nativeOut: true })).data,
    );

    assert.deepEqual(
        calls.map((c) => c.name),
        ['exactInputSingle', 'unwrapWETH9WithFee'],
    );
});

test('exact-output pays no fee, because the output is what was asked for', () => {
    const cfg = robinhood().v3;
    const route = fakeRoute(cfg.router, stockBySymbol('NVDA').address);
    const calls = decodeCalls(
        cfg,
        v3SwapCall(cfg, plan(route, { exactIn: false })).data,
    );

    assert.deepEqual(
        calls.map((c) => c.name),
        ['exactOutputSingle'],
    );
    // …and it pays the user directly, so no sentinel is involved at all.
    assert.equal(
        calls[0].args[0].recipient,
        '0x00000000000000000000000000000000000CaFE1',
    );
});

/**
 * Which pool a chart is drawn of.
 *
 * The token's deepest pool and the pool the trade goes through are routinely
 * different — NVDA's deepest is against the chain's dollar, while buying it
 * with ether touches another one — and drawing the first under a heading
 * naming the second is exactly the mismatch this picks apart.
 */
const pool = (base, quote, liquidityUsd, extra = {}) => ({
    chain: 'robinhood',
    dex: 'uniswap',
    url: '',
    pairAddress: `0x${liquidityUsd}`,
    base: { address: base, symbol: 'B', name: '' },
    quote: { address: quote, symbol: 'Q', name: '' },
    priceUsd: null,
    priceChange24h: null,
    liquidityUsd,
    volume24hUsd: null,
    createdAt: null,
    ...extra,
});

test('the pair being traded wins over the deeper pool beside it', () => {
    const nvda = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
    const usdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
    const weth = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
    const pairs = [pool(nvda, usdg, 7000), pool(nvda, weth, 1500)];

    const chosen = pairPoolFor(pairs, nvda, weth);

    assert.equal(chosen.pair.liquidityUsd, 1500);
    assert.equal(chosen.exact, true);

    // Reversed sides are the same pool; the index does not promise an order.
    assert.equal(pairPoolFor(pairs, weth, nvda).pair.liquidityUsd, 1500);
});

test('with no pool holding both sides, the deepest one is offered and said to be', () => {
    const nvda = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';
    const usdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
    const cyber = '0x753979e6585CCa139fbB1918966D563a25eEB3B2';
    const pairs = [pool(nvda, usdg, 7000), pool(nvda, usdg, 900)];

    const chosen = pairPoolFor(pairs, nvda, cyber);

    assert.equal(chosen.pair.liquidityUsd, 7000);
    // The caller has to be able to say "a different pair from the one traded".
    assert.equal(chosen.exact, false);

    assert.equal(pairPoolFor([], nvda, cyber), null);
});
