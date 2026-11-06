import assert from 'node:assert/strict';
import test from 'node:test';
import { nftExternalUrl, nftMetadataUrls } from '@/lib/nftMarketMetadata';

test('IPFS metadata and images have independent gateway fallbacks', () => {
    assert.deepEqual(
        nftMetadataUrls(
            'ipfs://ipfs/cid/image.png',
            'https://example.org/ipfs/',
        ),
        [
            'https://example.org/ipfs/cid/image.png',
            'https://gateway.pinata.cloud/ipfs/cid/image.png',
            'https://ipfs.io/ipfs/cid/image.png',
        ],
    );
    assert.deepEqual(
        nftMetadataUrls(
            'https://example.org/nft.json',
            'https://example.org/ipfs/',
        ),
        ['https://example.org/nft.json'],
    );
});

test('external posts only allow HTTP links', () => {
    assert.equal(
        nftExternalUrl('https://t.me/channel/42'),
        'https://t.me/channel/42',
    );
    assert.equal(nftExternalUrl('javascript:alert(1)'), null);
    assert.equal(nftExternalUrl(undefined), null);
});
