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

test('a bare CID is asked of this site first', () => {
    const cid = 'bafkreibpcjavlnrcnk4xpqb25y6aujlwwgpclbluw5llpxm3gnth26wneq';
    assert.deepEqual(
        nftMetadataUrls(`ipfs://${cid}`, 'https://ipfs.io/ipfs/'),
        [
            `/ipfs/${cid}`,
            `https://ipfs.io/ipfs/${cid}`,
            `https://gateway.pinata.cloud/ipfs/${cid}`,
        ],
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
