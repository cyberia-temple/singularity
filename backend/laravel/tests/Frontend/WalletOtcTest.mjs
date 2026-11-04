import assert from 'node:assert/strict';
import test from 'node:test';
import {
    NATIVE,
    OTC_DEPLOYMENTS,
    OTC_KNOWN_ASSETS,
    otcAssets,
    unitPriceOf,
    offerLink,
    affordable,
    fillAllowed,
    isOpen,
    payFor,
    quickCyberFill,
} from '@/lib/wallet/otc';

/**
 * The OTC offer arithmetic, restated in the browser so a buyer can read what
 * they will pay before the hold. It must agree with `CyberiaOTC.quote()` to
 * the wei: a payment one wei short reverts, and that number is also the
 * `maxPay` the transaction carries.
 */

const E18 = 10n ** 18n;

test('payFor is the stated price, rounded up in the seller’s favour', () => {
    const order = { priceSell: 100_000n * E18, priceBuy: 1_000n * E18 };
    assert.equal(payFor(order, 25_000n * E18), 250n * E18);
    assert.equal(payFor(order, order.priceSell), order.priceBuy);

    // 3 for 10: one unit costs 3.33…, so 4.
    assert.equal(payFor({ priceSell: 3n, priceBuy: 10n }, 1n), 4n);
    assert.equal(payFor({ priceSell: 3n, priceBuy: 10n }, 3n), 10n);
    assert.equal(payFor({ priceSell: 3n, priceBuy: 10n }, 0n), 0n);
});

test('affordable never exceeds the budget or what remains', () => {
    const order = { priceSell: 100n, priceBuy: 1n, remaining: 1_000n };
    assert.equal(affordable(order, 3n), 300n);
    assert.ok(payFor(order, affordable(order, 3n)) <= 3n);
    assert.equal(affordable(order, 50n), 1_000n);
    assert.equal(
        affordable({ priceSell: 3n, priceBuy: 10n, remaining: 9n }, 7n),
        2n,
    );
});

test('fillAllowed mirrors the contract: all-or-nothing, minFill, the remainder', () => {
    const whole = { remaining: 100n, minFill: 0n, partialFill: false };
    assert.equal(fillAllowed(whole, 100n), true);
    assert.equal(fillAllowed(whole, 50n), false);

    const parts = { remaining: 100n, minFill: 20n, partialFill: true };
    assert.equal(fillAllowed(parts, 20n), true);
    assert.equal(fillAllowed(parts, 19n), false);
    assert.equal(fillAllowed(parts, 101n), false);
    assert.equal(fillAllowed(parts, 0n), false);
    // What remains can always be taken, even below minFill.
    assert.equal(fillAllowed({ ...parts, remaining: 10n }, 10n), true);
});

test('quick CYBER budgets respect rounding, minimums, remaining stock and payment asset', () => {
    const order = {
        priceSell: 3n,
        priceBuy: 10n,
        remaining: 1_000n,
        minFill: 1n,
        partialFill: true,
        buy: { address: NATIVE },
    };
    for (const budget of [100n, 200n, 500n]) {
        const fill = quickCyberFill(order, budget);
        assert.equal(fill, (budget * 3n) / 10n);
        assert.ok(payFor(order, fill) <= budget);
    }
    assert.equal(quickCyberFill({ ...order, minFill: 31n }, 100n), null);
    assert.equal(
        quickCyberFill({ ...order, remaining: 5n, minFill: 10n }, 100n),
        5n,
    );
    assert.equal(quickCyberFill({ ...order, partialFill: false }, 100n), null);
    assert.equal(
        quickCyberFill(
            {
                ...order,
                buy: { address: '0x0000000000000000000000000000000000000001' },
            },
            100n,
        ),
        null,
    );
    assert.equal(quickCyberFill({ ...order, priceBuy: 0n }, 100n), null);
});

test('isOpen drops closed, sold-out and expired offers', () => {
    const now = 1_000;
    assert.equal(
        isOpen({ closed: false, remaining: 1n, expiry: 0n }, now),
        true,
    );
    assert.equal(
        isOpen({ closed: false, remaining: 1n, expiry: 1_001n }, now),
        true,
    );
    assert.equal(
        isOpen({ closed: false, remaining: 1n, expiry: 1_000n }, now),
        false,
    );
    assert.equal(
        isOpen({ closed: true, remaining: 1n, expiry: 0n }, now),
        false,
    );
    assert.equal(
        isOpen({ closed: false, remaining: 0n, expiry: 0n }, now),
        false,
    );
});

test('every desk and every shipped asset is a real address, once per network', () => {
    const isAddress = (value) => /^0x[0-9a-fA-F]{40}$/.test(value);
    assert.ok(Object.values(OTC_DEPLOYMENTS).every(isAddress));

    for (const list of Object.values(OTC_KNOWN_ASSETS)) {
        const addresses = list.map((asset) => asset.address.toLowerCase());
        assert.equal(new Set(addresses).size, addresses.length);
        assert.ok(list.every((asset) => isAddress(asset.address)));
    }
});

test('the picker leads with the coin and lists each contract once', () => {
    const desk = {
        chain: 'cyberia_fuji',
        native: { address: NATIVE, symbol: 'CYBER', decimals: 18 },
    };
    const ash = OTC_KNOWN_ASSETS.cyberia_fuji[1];
    const list = otcAssets(desk, [
        { address: ash.address.toUpperCase().replace('0X', '0x'), symbol: 'ASH' },
    ]);
    assert.equal(list[0].address, NATIVE);
    assert.equal(list[0].symbol, 'CYBER');
    const keys = list.map((asset) => asset.address.toLowerCase());
    assert.equal(new Set(keys).size, keys.length);
    assert.equal(list.length, 1 + OTC_KNOWN_ASSETS.cyberia_fuji.length);
});

test('unitPriceOf is the price of one whole unit of the sell side', () => {
    // 2 CYBER for 5 tokens (6 decimals): 2.5 tokens per CYBER.
    assert.equal(unitPriceOf(2n * E18, 5_000_000n, 18), 2_500_000n);
    assert.equal(unitPriceOf(0n, 5n, 18), null);
});

test('an offer link names its network', () => {
    assert.equal(
        offerLink('base', 7n),
        'https://cyberia.church/wallet?section=otc&chain=base&offer=7',
    );
});
