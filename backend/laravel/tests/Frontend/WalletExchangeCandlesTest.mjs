import assert from 'node:assert/strict';
import test from 'node:test';
import {
    exchangeListing,
    loadExchangeCandles,
    parseExchangeCandles,
} from '@/lib/wallet/exchangeCandles';

const time = 1792900000;
const binanceRow = (ts = time, close = '102') => [
    ts * 1000,
    '100',
    '105',
    '98',
    close,
    '12.5',
    (ts + 3600) * 1000 - 1,
    '1250',
    42,
    '6',
    '600',
    '0',
];

test('Binance millisecond timestamps and base volume become sorted, unique candle bars', () => {
    const bars = parseExchangeCandles(
        [binanceRow(time + 3600), binanceRow(), binanceRow(time, '103')],
        'Binance',
        time,
        time + 7200,
    );

    assert.equal(bars.length, 2);
    assert.deepEqual(bars[0], {
        time,
        open: 100,
        high: 105,
        low: 98,
        close: 103,
        volume: 12.5,
        trades: 42,
    });
    assert.equal(bars[1].time, time + 3600);
});

test('Kraken uses its canonical response pair and volume, not its VWAP or last cursor', () => {
    const bars = parseExchangeCandles(
        {
            error: [],
            result: {
                last: time + 60,
                XXMRZUSD: [
                    [time, '100', '105', '98', '102', '101.5', '12.5', 42],
                ],
            },
        },
        'Kraken',
        time,
        time + 7200,
    );

    assert.equal(bars[0].time, time);
    assert.equal(bars[0].volume, 12.5);
    assert.equal(bars[0].trades, 42);
});

test('malformed bars, impossible OHLC, and bars outside the selected window are excluded', () => {
    const bad = (index, value) => {
        const row = binanceRow();
        row[index] = value;

        return row;
    };
    const bars = parseExchangeCandles(
        [
            null,
            {},
            [],
            binanceRow(time - 1),
            binanceRow(time + 7201),
            bad(0, 'not a timestamp'),
            bad(1, null),
            bad(1, true),
            bad(1, ''),
            bad(2, '99'),
            bad(3, '103'),
            bad(4, 'Infinity'),
            bad(5, '-1'),
            bad(8, 'NaN'),
            binanceRow(),
        ],
        'Binance',
        time,
        time + 7200,
    );

    assert.equal(bars.length, 1);
    assert.equal(bars[0].close, 102);
});

test('provider errors never become zero-priced or empty successful charts', () => {
    assert.throws(() =>
        parseExchangeCandles({ code: -1121 }, 'Binance', 0, time),
    );
    assert.throws(() =>
        parseExchangeCandles(
            {
                error: ['EQuery:Unknown asset pair'],
                result: {},
            },
            'Kraken',
            0,
            time,
        ),
    );
    assert.throws(() => parseExchangeCandles(null, 'Kraken', 0, time));
    assert.equal(exchangeListing('BINANCE:MADEUPUSDT'), null);
    assert.equal(exchangeListing('__proto__'), null);
});

test('the public Binance feed sends only an allowlisted pair and period with no credentials', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        assert.equal(url.origin, 'https://data-api.binance.vision');
        assert.equal(url.pathname, '/api/v3/klines');
        assert.equal(url.searchParams.get('symbol'), 'BTCUSDT');
        assert.equal(url.searchParams.get('interval'), '15m');
        assert.equal(url.searchParams.get('limit'), '720');
        assert.equal(options.credentials, 'omit');
        assert.equal(options.referrerPolicy, 'no-referrer');
        assert.ok(options.signal instanceof AbortSignal);

        // A minute back: the loader reads its clock before fetch, and a row
        // stamped in the next second would fall outside the window it asked for.
        return new Response(
            JSON.stringify([binanceRow(Math.floor(Date.now() / 1000) - 60)]),
        );
    });

    const candles = await loadExchangeCandles(
        'BINANCE:BTCUSDT',
        '1D',
        new AbortController().signal,
    );
    assert.equal(candles.length, 1);
});

test('Monero uses Kraken and the year window requests daily candles', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url) => {
        assert.equal(url.origin, 'https://api.kraken.com');
        assert.equal(url.searchParams.get('pair'), 'XMRUSD');
        assert.equal(url.searchParams.get('interval'), '1440');
        assert.ok(
            Number(url.searchParams.get('since')) <
                Date.now() / 1000 - 364 * 86400,
        );

        return new Response(
            JSON.stringify({
                error: [],
                result: {
                    XXMRZUSD: [
                        [
                            Math.floor(Date.now() / 1000),
                            '100',
                            '105',
                            '98',
                            '102',
                            '101',
                            '4',
                            2,
                        ],
                    ],
                    last: 0,
                },
            }),
        );
    });

    assert.equal(
        (
            await loadExchangeCandles(
                'KRAKEN:XMRUSD',
                '1Y',
                new AbortController().signal,
            )
        ).length,
        1,
    );
});

test('HTTP errors, empty feeds, and cancelled requests reject instead of displaying invented data', async (t) => {
    const mock = t.mock.method(
        globalThis,
        'fetch',
        async () => new Response('unavailable', { status: 503 }),
    );
    const signal = new AbortController().signal;

    await assert.rejects(loadExchangeCandles('BINANCE:BTCUSDT', '7D', signal));
    mock.mock.mockImplementation(async () => new Response('[]'));
    await assert.rejects(loadExchangeCandles('BINANCE:BTCUSDT', '7D', signal));
    await assert.rejects(
        loadExchangeCandles('BINANCE:MADEUPUSDT', '7D', signal),
    );
    mock.mock.mockImplementation(async (_url, options) => {
        options.signal.throwIfAborted();

        throw new Error('Unexpected non-aborted request');
    });
    await assert.rejects(
        loadExchangeCandles('BINANCE:BTCUSDT', '7D', AbortSignal.abort()),
        { name: 'AbortError' },
    );
});
