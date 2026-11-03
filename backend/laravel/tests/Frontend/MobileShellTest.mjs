import assert from 'node:assert/strict';
import test from 'node:test';

import { deepLinkPath } from '@/lib/mobileShell';
import { parsePaymentUri } from '@/lib/wallet/paymentUri';

/**
 * The phone app's two new doors: a link that opens the app (a home-screen
 * shortcut, cyberia://…) and a QR code read off the camera. Both decide where
 * somebody lands or what fills a send form, so both are pinned.
 */

test('a link that opens the app names a path on this site, and nothing else', () => {
    assert.equal(
        deepLinkPath('cyberia://wallet?scan=1', 'cyberia.church'),
        '/wallet?scan=1',
    );
    assert.equal(
        deepLinkPath('cyberia://wallet?section=chat', 'cyberia.church'),
        '/wallet?section=chat',
    );
    assert.equal(deepLinkPath('cyberia://feed', 'cyberia.church'), '/feed');
    assert.equal(deepLinkPath('cyberia://', 'cyberia.church'), '/wallet');
    assert.equal(
        deepLinkPath('https://cyberia.church/dao/3', 'cyberia.church'),
        '/dao/3',
    );
    assert.equal(
        deepLinkPath('https://www.cyberia.church/feed?x=1', 'cyberia.church'),
        '/feed?x=1',
    );
    // Another site is not ours to open inside the app.
    assert.equal(
        deepLinkPath('https://evil.example/wallet', 'cyberia.church'),
        null,
    );
    assert.equal(deepLinkPath('javascript:alert(1)', 'cyberia.church'), null);
    assert.equal(deepLinkPath('not a url', 'cyberia.church'), null);
});

test('a QR code gives an address and never an amount or a call', () => {
    const plain = '0x52908400098527886E0F7030069857D2E4169EE7';

    assert.deepEqual(parsePaymentUri(plain), {
        address: plain.toLowerCase(),
        family: 'evm',
        chainId: null,
    });
    assert.deepEqual(parsePaymentUri(`ethereum:${plain}@8453?value=1e18`), {
        address: plain.toLowerCase(),
        family: 'evm',
        chainId: 8453,
    });
    assert.equal(
        parsePaymentUri(`ethereum:pay-${plain}/transfer?address=0x0`)?.address,
        plain.toLowerCase(),
    );
    assert.equal(
        parsePaymentUri(
            'bitcoin:bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq?amount=1',
        )?.family,
        'bitcoin',
    );
    assert.equal(
        parsePaymentUri('solana:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')
            ?.family,
        'solana',
    );
    assert.equal(parsePaymentUri('https://cyberia.church'), null);
    assert.equal(parsePaymentUri('0x1234'), null);
    assert.equal(parsePaymentUri('ethereum:0xnothex'), null);
});
