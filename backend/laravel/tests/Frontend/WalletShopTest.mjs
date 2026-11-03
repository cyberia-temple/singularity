import assert from 'node:assert/strict';
import test from 'node:test';
import {
    chatPrivateKey,
    chatPublicKey,
    conversationKey,
    openMessage,
    sealMessage,
} from '@/lib/wallet/chatCrypto';
import {
    SHOP_CATEGORIES,
    decodeEnvelope,
    deliveryMeta,
    encodeEnvelope,
    orderActions,
    sellerGets,
} from '@/lib/wallet/shop';

/**
 * The shop's browser half: the category order the contract stores by index,
 * the fee arithmetic restated from `CyberiaShop`, who may do what to an order
 * at a given moment, and the sealed delivery — opened by the buyer, refused
 * by anybody else and refused as the delivery of another order.
 */

const SELLER = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const TERMS = { deliveryWindow: 172_800, disputeWindow: 259_200, feeBps: 200 };

test('categories keep the contract order', () => {
    assert.deepEqual(SHOP_CATEGORIES, [
        'key',
        'subscription',
        'account',
        'giftCard',
        'domain',
        'hosting',
        'aiCredits',
        'other',
    ]);
});

test('the seller is paid the price less 2%, rounded like the contract', () => {
    assert.equal(sellerGets(10n ** 19n, 200), 98n * 10n ** 17n);
    assert.equal(sellerGets(49n, 200), 49n);
    assert.equal(sellerGets(50n, 200), 49n);
});

test('who may act on an order, and when', () => {
    const paid = { state: 'paid', paidAt: 1_000, deliveredAt: 0, buyer: BUYER };

    assert.deepEqual(orderActions(paid, SELLER, SELLER, TERMS, 1_001), [
        'deliver',
        'sellerRefund',
    ]);
    assert.deepEqual(orderActions(paid, SELLER, BUYER, TERMS, 1_001), []);
    assert.deepEqual(
        orderActions(paid, SELLER, BUYER, TERMS, 1_000 + TERMS.deliveryWindow),
        ['refund'],
    );

    const delivered = { ...paid, state: 'delivered', deliveredAt: 2_000 };

    assert.deepEqual(orderActions(delivered, SELLER, BUYER, TERMS, 2_001), [
        'confirm',
        'dispute',
    ]);
    assert.deepEqual(
        orderActions(
            delivered,
            SELLER,
            BUYER,
            TERMS,
            2_000 + TERMS.disputeWindow,
        ),
        ['confirm', 'release'],
    );
    assert.deepEqual(
        orderActions(
            { ...delivered, state: 'released' },
            SELLER,
            BUYER,
            TERMS,
            9e9,
        ),
        [],
    );
});

test('a delivery opens for the buyer only, and only as its own order', async () => {
    const sellerKey = chatPrivateKey(`0x${'a1'.repeat(32)}`);
    const buyerKey = chatPrivateKey(`0x${'b2'.repeat(32)}`);
    const strangerKey = chatPrivateKey(`0x${'c3'.repeat(32)}`);
    const meta = deliveryMeta(7n, SELLER, BUYER);

    const sealing = await conversationKey(
        sellerKey,
        chatPublicKey(buyerKey),
        SELLER,
        BUYER,
    );
    const bytes = encodeEnvelope(
        await sealMessage(sealing, meta, 'XXXXX-YYYYY-ZZZZZ'),
    );
    const envelope = decodeEnvelope(bytes);

    const opening = await conversationKey(
        buyerKey,
        chatPublicKey(sellerKey),
        BUYER,
        SELLER,
    );
    assert.equal(
        await openMessage(opening, meta, envelope),
        'XXXXX-YYYYY-ZZZZZ',
    );

    await assert.rejects(
        openMessage(opening, deliveryMeta(8n, SELLER, BUYER), envelope),
    );

    const stranger = await conversationKey(
        strangerKey,
        chatPublicKey(sellerKey),
        BUYER,
        SELLER,
    );
    await assert.rejects(openMessage(stranger, meta, envelope));
});
