import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCandles } from '@/lib/marketCandles';

/**
 * What a chart of a quiet pool is allowed to draw.
 *
 * The rule these pin is one line of code and the whole readability of the
 * panel: a bucket where nothing happened is not a candle. Drawing it as a flat
 * bar at the carried price turned a pool that traded twice in a month into
 * seven hundred one-pixel bars, two spikes and a dotted line — a picture that
 * says "the price sat still for thirty days" about a market nobody looked at.
 */

const HOUR = 3600;

const history = (observations, trades = []) => ({
    observations,
    trades,
    // The rest of `MarketHistory` is not read by `buildCandles`.
    hops: [],
    fromBlock: 0,
    toBlock: 0,
});

test('a bucket nothing happened in is not drawn', () => {
    const candles = buildCandles(
        history([
            { ts: 0, price: 1 },
            { ts: 10 * HOUR, price: 2 },
        ]),
        { fromSec: 0, toSec: 20 * HOUR, bucketSec: HOUR },
    );

    // Two moves, two candles — not twenty-one.
    assert.equal(candles.length, 2);
    assert.deepEqual(
        candles.map((candle) => candle.time),
        [0, 10 * HOUR],
    );
});

test('the line stays continuous across a gap', () => {
    const candles = buildCandles(
        history([
            { ts: 0, price: 1 },
            { ts: 50 * HOUR, price: 3 },
        ]),
        { fromSec: 0, toSec: 60 * HOUR, bucketSec: HOUR },
    );

    // The second candle opens where the first closed, however long the silence
    // between them was: a gap in the record is not a gap in the price.
    assert.equal(candles[0].close, 1);
    assert.equal(candles[1].open, 1);
    assert.equal(candles[1].close, 3);
});

test('a bucket with volume but no price move is still a candle', () => {
    const candles = buildCandles(
        history([{ ts: 0, price: 1 }], [{ ts: 5 * HOUR, volume: 42 }]),
        { fromSec: 0, toSec: 10 * HOUR, bucketSec: HOUR },
    );

    // Somebody traded. That it did not move the price is a fact about the
    // trade, not a reason to hide it.
    assert.equal(candles.length, 2);
    assert.equal(candles[1].volume, 42);
    assert.equal(candles[1].trades, 1);
});

test('the live price is written into the current period and no other', () => {
    const now = 100 * HOUR;

    // The last trade is a day old: today's price must not be painted onto it.
    const stale = buildCandles(
        history([
            { ts: 0, price: 1 },
            { ts: 76 * HOUR, price: 2 },
        ]),
        { fromSec: 0, toSec: now, bucketSec: HOUR, spot: 5 },
    );

    assert.equal(stale[stale.length - 1].close, 2);

    // A trade inside the newest bucket is the current period, and there the
    // spot is the freshest thing there is.
    const live = buildCandles(
        history([
            { ts: 0, price: 1 },
            { ts: now, price: 2 },
        ]),
        { fromSec: 0, toSec: now, bucketSec: HOUR, spot: 5 },
    );

    assert.equal(live[live.length - 1].close, 5);
});

test('a window nothing reaches into draws nothing at all', () => {
    // Better than one flat bar: "no trades in this window" and "the price was
    // flat for a month" are different claims, and only one of them is true.
    assert.deepEqual(
        buildCandles(history([{ ts: 0, price: 1 }]), {
            fromSec: 50 * HOUR,
            toSec: 60 * HOUR,
            bucketSec: HOUR,
        }),
        [],
    );
});
