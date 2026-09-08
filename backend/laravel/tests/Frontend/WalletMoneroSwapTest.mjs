import assert from 'node:assert/strict';
import test from 'node:test';
import {
    compareMoneroRoutes,
    moneroRouteReason,
    ourNetXmr,
} from '@/lib/wallet/moneroSwap';

/**
 * The arithmetic that decides which Monero route a person is shown as better.
 *
 * It is pinned because both halves fail quietly: a comparison on headline
 * rates hands the trade to the worse route while looking right, and a flat fee
 * that is dropped rather than converted makes a small deposit look profitable
 * when it is not.
 */

const XMR = 1_000_000_000_000n; // twelve decimals, one Monero

const route = (key, amountOut, extra = {}) => ({
    key,
    label: key,
    amountOut,
    decimalsOut: 18,
    feeBps: 75,
    feeApplied: true,
    minutes: 20,
    custodian: 'someone',
    notes: [],
    ...extra,
});

test('the better route is the one that pays out more, not the one that looks cheaper', () => {
    const { best, routes, advantagePct } = compareMoneroRoutes([
        route('partner', 1000n),
        route('cyberia', 1050n),
    ]);

    assert.equal(best.key, 'cyberia');
    assert.equal(routes.length, 2);
    assert.ok(Math.abs(advantagePct - 5) < 1e-9);
});

test('a route that could not be quoted is absent, never a zero', () => {
    const { routes, best, advantagePct } = compareMoneroRoutes([
        null,
        route('partner', 0n),
        route('cyberia', 7n),
    ]);

    assert.equal(routes.length, 1);
    assert.equal(best.key, 'cyberia');
    assert.equal(advantagePct, null, 'one answer is not an advantage over another');
});

test('nothing to compare is not an error', () => {
    const { routes, best, advantagePct } = compareMoneroRoutes([null, null]);

    assert.equal(routes.length, 0);
    assert.equal(best, null);
    assert.equal(advantagePct, null);
});

test('our fee and the bridge rate both come out of the deposit', () => {
    // 0.75% ours + 0.25% the bridge's, no flat fee.
    assert.equal(ourNetXmr(XMR, 75, 0, 25, 200), (XMR * 9900n) / 10_000n);
    assert.equal(ourNetXmr(XMR, 0, 0, 0, 200), XMR);
});

test('the flat fee is converted at the price of the day', () => {
    // $2 at $200/XMR is 0.01 XMR on top of the 0.75%.
    const net = ourNetXmr(XMR, 75, 2, 0, 200);

    assert.equal(net, (XMR * 9925n) / 10_000n - 10_000_000_000n);
});

test('a deposit too small to pay its own costs is zero, never negative', () => {
    const dust = 1_000_000n; // 0.000001 XMR against a $2 flat fee

    assert.equal(ourNetXmr(dust, 75, 2, 0, 200), 0n);
    assert.equal(ourNetXmr(0n, 75, 2, 0, 200), 0n);
});

test('an unknown price leaves the flat fee undeducted rather than free', () => {
    // The caller has to notice the null and say the quote is partial; what it
    // must never do is silently price the flat fee at nothing *and* at zero.
    assert.equal(ourNetXmr(XMR, 75, 2, 0, null), (XMR * 9925n) / 10_000n);
    assert.equal(ourNetXmr(XMR, 75, 2, 0, 0), (XMR * 9925n) / 10_000n);
});

test('a nonsense fee is refused rather than applied', () => {
    assert.throws(() => ourNetXmr(XMR, 10_000, 0, 0, 200), /between 0 and 100/);
    assert.throws(() => ourNetXmr(XMR, -1, 0, 0, 200), /between 0 and 100/);
});

test('every reason the server can give has a sentence', () => {
    for (const reason of [
        'monero_chain_disabled',
        'no_deposit_address',
        'corridor_coming_soon',
        'partner_not_configured',
        'disabled',
        'unreachable',
        'refused',
        'unreadable',
    ]) {
        assert.ok(
            (moneroRouteReason(reason) ?? '').length > 10,
            `${reason} must read as a sentence`,
        );
    }

    assert.equal(moneroRouteReason(null), null);
    assert.equal(moneroRouteReason('something new'), 'This route is unavailable.');
});
