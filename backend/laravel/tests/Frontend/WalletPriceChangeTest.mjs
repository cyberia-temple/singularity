import assert from 'node:assert/strict';
import test from 'node:test';
import { holdings } from '@/lib/wallet/holdings';
import {
    changeOf,
    changeTone,
    combinedChange,
    formatChangePct,
    usdDelta,
} from '@/lib/wallet/priceChange';

/**
 * The 24h move the portfolio draws. Pinned: a missing change stays missing
 * (never 0%), a holding's dollar move is what the same amount was worth a day
 * ago subtracted from now, and the total's percentage counts only holdings
 * whose change was measured.
 */

const changes = {
    prices: { cyberia: 25 },
    tokens: { cyberia: { '0xaaaa': -50 } },
};

test('a change is looked up by chain and by lowercased contract', () => {
    assert.equal(changeOf(changes, 'cyberia'), 25);
    assert.equal(changeOf(changes, 'cyberia', '0xAAAA'), -50);
    assert.equal(changeOf(changes, 'base'), null);
    assert.equal(changeOf(null, 'cyberia'), null);
});

test("the dollar move is now minus the same amount at yesterday's price", () => {
    // $125 after +25% was $100 a day ago.
    assert.equal(usdDelta(125, 25), 25);
    assert.equal(usdDelta(50, -50), -50);
    assert.equal(usdDelta(null, 10), null);
    assert.equal(usdDelta(10, null), null);
});

test('the combined move ignores holdings nobody measured', () => {
    const moved = combinedChange([
        { usd: 125, change: 25 },
        { usd: 50, change: -50 },
        { usd: 1000, change: null },
    ]);

    // Was 100 + 100 = 200, now 175: −$25, −12.5%.
    assert.equal(moved.usd, -25);
    assert.equal(moved.pct, -12.5);
    assert.equal(combinedChange([{ usd: 10, change: null }]), null);
});

test('a move is always signed and coloured by direction', () => {
    assert.equal(formatChangePct(3.2, 'en'), '+3.20%');
    assert.equal(formatChangePct(-0.4, 'en'), '-0.40%');
    assert.equal(changeTone(1), 'up');
    assert.equal(changeTone(-1), 'down');
    assert.equal(changeTone(0.001), 'flat');
    assert.equal(changeTone(null), 'flat');
});

test('holdings carry the change of the coin and of each priced token', () => {
    const { rows } = holdings({
        accounts: [
            {
                chain: 'cyberia',
                label: 'Cyberia',
                symbol: 'CYBER',
                decimals: 18,
            },
        ],
        balances: { cyberia: 10n ** 18n },
        tokens: {
            cyberia: [
                {
                    address: '0xAAAA',
                    symbol: 'AAA',
                    name: 'AAA',
                    decimals: 18,
                    balance: 10n ** 18n,
                },
            ],
        },
        prices: { cyberia: 1 },
        tokenPrices: { cyberia: { '0xaaaa': 2 } },
        changes,
    });

    assert.deepEqual(
        rows.map((row) => [row.symbol, row.change]),
        [
            ['AAA', -50],
            ['CYBER', 25],
        ],
    );
});
