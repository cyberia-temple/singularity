import assert from 'node:assert/strict';
import test from 'node:test';
import { withBridgeReservation } from '@/lib/bridgeReservation';
import { submitBridge } from '@/lib/wallet/bridge';

const intent = {
    direction: 'evm_to_sol',
    token: 'USDC',
    amount: '1.000001',
    senderAddress: '0xsender',
    recipientAddress: 'SolRecipient',
};
const expiry = () => new Date(Date.now() + 900000).toISOString();

for (const [label, reply] of [
    [
        'unknown liquidity',
        () =>
            new Response(
                JSON.stringify({
                    reason: 'unavailable',
                    message: 'No inventory reading',
                }),
                { status: 409 },
            ),
    ],
    ['empty claim', () => new Response('{}')],
    [
        'malformed claim',
        () =>
            new Response(
                JSON.stringify({
                    reservation: { reference: 'hold', expires_at: 'never' },
                }),
            ),
    ],
    [
        'expired claim',
        () =>
            new Response(
                JSON.stringify({
                    reservation: {
                        reference: 'hold',
                        expires_at: '2000-01-01T00:00:00Z',
                    },
                }),
            ),
    ],
    [
        'lost server connection',
        () => {
            throw new Error('offline');
        },
    ],
]) {
    test(`${label} cannot call the wallet signer`, async (t) => {
        t.mock.method(globalThis, 'fetch', reply);
        let signed = false;
        await assert.rejects(
            withBridgeReservation(intent, async () => {
                signed = true;
            }),
        );
        assert.equal(signed, false);
    });
}

test('claims the exact intent before signing and passes its reference to submit', async (t) => {
    const calls = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        calls.push({
            url,
            body: JSON.parse(options.body),
            credentials: options.credentials,
        });

        return new Response(
            JSON.stringify(
                url.endsWith('/reserve')
                    ? {
                          reservation: {
                              reference: 'hold-1',
                              expires_at: expiry(),
                          },
                      }
                    : {
                          bridge_request: {
                              id: 7,
                              status: 'pending',
                              destination_tx_hash: null,
                          },
                      },
            ),
        );
    });
    const locked = await withBridgeReservation(intent, async () => {
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, '/bridge/reserve');

        return { txHash: 'source-hash', nonce: 0 };
    });
    const result = await submitBridge({
        direction: intent.direction,
        token: intent.token,
        amount: intent.amount,
        sender: intent.senderAddress,
        recipient: intent.recipientAddress,
        sourceTxHash: locked.deposit.txHash,
        sourceNonce: 0,
        reservation: locked.reservation,
    });
    assert.deepEqual(calls[0].body, {
        direction: intent.direction,
        token: intent.token,
        amount: intent.amount,
        sender_address: intent.senderAddress,
        recipient_address: intent.recipientAddress,
    });
    assert.equal(calls[1].body.reservation, 'hold-1');
    assert.equal(calls[1].body.source_tx_hash, 'source-hash');
    assert.equal(calls[1].credentials, 'same-origin');
    assert.equal(result.id, 7);
    assert.equal(result.status, 'pending');
    assert.equal(result.destinationTxHash, null);
});
