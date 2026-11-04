import assert from 'node:assert/strict';
import test from 'node:test';

import {
    formatUsd,
    inviteReasonOf,
    normaliseCode,
    sharePct,
} from '@/lib/wallet/referrals';

/**
 * The invite screen tells somebody what a friend earned them. These are the
 * places that number and that code are decided in the browser, so they are
 * the ones pinned.
 */

test('a code is read the way people type it, and nothing else passes', () => {
    assert.equal(normaliseCode(' abcd2345 '), 'ABCD2345');
    // No 0, 1, I, L or O: they are the letters people misread aloud.
    assert.equal(normaliseCode('ABCD0123'), null);
    assert.equal(normaliseCode('<script>'), null);
    assert.equal(normaliseCode(''), null);
    assert.equal(normaliseCode(null), null);
});

test('the share reads as a percentage, keeping a fraction when there is one', () => {
    assert.equal(sharePct(2500), '25%');
    assert.equal(sharePct(1250), '12.5%');
    assert.equal(sharePct(0), '0%');
});

test('a sub-cent reward is shown, not rounded down to nothing', () => {
    assert.equal(formatUsd(0.0042), '$0.0042');
    assert.equal(formatUsd(1.5), '$1.50');
    assert.equal(formatUsd(0), '$0.00');
});

test('a refusal is turned into a key the screen can translate', () => {
    assert.equal(inviteReasonOf({ status: 401 }), 'signed_out');
    assert.equal(inviteReasonOf({ status: 422, reason: 'too_old' }), 'too_old');
    assert.equal(inviteReasonOf({ status: 422, reason: 'made-up' }), null);
    assert.equal(inviteReasonOf(new Error('offline')), null);
});
