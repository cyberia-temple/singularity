import assert from 'node:assert/strict';
import test from 'node:test';
import { daysLeft, extendedUntil, vpnChallenge } from '@/lib/wallet/vpn';

/*
 * The sentence a VPN node asks this wallet to sign. services/vpn/test pins
 * `challengeMessage` to the same vector, so the two cannot drift apart.
 */
const VECTOR = [
    'Cyberia VPN: issue my connection link.',
    'This signature spends nothing.',
    'Address: 0xabc0000000000000000000000000000000000001',
    'Node: de-1',
    'Nonce: 00112233445566778899aabbccddeeff',
].join('\n');

test('the challenge is built here, byte for byte, never taken from the node', () => {
    assert.equal(
        vpnChallenge(
            '0xAbC0000000000000000000000000000000000001',
            'de-1',
            '00112233445566778899aabbccddeeff',
        ),
        VECTOR,
    );
});

test('days left round up, and an expired pass has none', () => {
    assert.equal(daysLeft(1_000 + 86_400, 1_000), 1);
    assert.equal(daysLeft(1_000 + 86_401, 1_000), 2);
    assert.equal(daysLeft(500, 1_000), 0);
});

test('buying adds to what is left, or starts now when nothing is', () => {
    assert.equal(extendedUntil(10_000, 1, 1_000), 10_000 + 86_400);
    assert.equal(extendedUntil(0, 7, 1_000), 1_000 + 7 * 86_400);
});
