import assert from 'node:assert/strict';
import test from 'node:test';
import { ipfsHttpUrl } from '@/lib/wallet/ipfs';
import { buildMetadata } from '@/lib/wallet/nft';
import {
    formatEta,
    formatSpeed,
    normalizeTorrentSource,
} from '@/lib/wallet/torrent';

/**
 * The pure parts of minting, pinning and torrenting.
 *
 * Two of these decide what goes on chain forever — the metadata document a CID
 * is made of, and how an `ipfs://` is turned into something fetchable — so
 * they are pinned here rather than checked by looking at a screen. The third
 * decides what reaches a torrent engine at all, which is the last point at
 * which a mistyped line is still only text.
 */

test('metadata carries what was typed and nothing else', () => {
    const metadata = buildMetadata({
        name: '  lain  ',
        description: ' hello, wired ',
        image: 'ipfs://bafkreiey23hc4qrq7geaemvfzrhnahnywt3ro5cf76vty6ebuubcnxvz7a',
        externalUrl: 'https://cyberia.church',
        attributes: [
            { trait: 'Layer', value: '07' },
            // Half-filled rows are not attributes; they are a form in progress.
            { trait: '', value: 'x' },
            { trait: 'y', value: '  ' },
        ],
    });

    assert.deepEqual(metadata, {
        name: 'lain',
        description: 'hello, wired',
        image: 'ipfs://bafkreiey23hc4qrq7geaemvfzrhnahnywt3ro5cf76vty6ebuubcnxvz7a',
        external_url: 'https://cyberia.church',
        attributes: [{ trait_type: 'Layer', value: '07' }],
    });
});

test('a token with no image has no image field at all', () => {
    const metadata = buildMetadata({ name: 'a line of text' });

    assert.deepEqual(metadata, { name: 'a line of text', description: '' });
    assert.equal('image' in metadata, false);
    assert.equal('attributes' in metadata, false);
});

test('ipfs:// resolves through a gateway, https is left alone', () => {
    assert.equal(
        ipfsHttpUrl('ipfs://bafybeigdyrzt/index.html'),
        'https://ipfs.io/ipfs/bafybeigdyrzt/index.html',
    );
    assert.equal(
        ipfsHttpUrl('ipfs://bafybeigdyrzt', 'https://gw.example/'),
        'https://gw.example/ipfs/bafybeigdyrzt',
    );
    assert.equal(
        ipfsHttpUrl('https://example.org/a.png'),
        'https://example.org/a.png',
    );
});

test('what is not fetchable is null rather than a broken link', () => {
    assert.equal(ipfsHttpUrl(''), null);
    assert.equal(ipfsHttpUrl(null), null);
    assert.equal(ipfsHttpUrl(undefined), null);
    // A token URI can be a line of text. A wallet must not render it as a src.
    assert.equal(ipfsHttpUrl('hello, wired'), null);
    assert.equal(ipfsHttpUrl('javascript:alert(1)'), null);
    assert.equal(ipfsHttpUrl('data:text/html,<script>'), null);
});

test('a bare info hash is a magnet with the ceremony removed', () => {
    const hex = 'DD8255ECDC7CA55FB0BBF81323D87062DB1F6D1C';

    assert.equal(
        normalizeTorrentSource(`  ${hex}  `),
        `magnet:?xt=urn:btih:${hex.toLowerCase()}`,
    );
    assert.equal(
        normalizeTorrentSource('ANFHU5S6MDVJXP7UGBZO4XZQFJEDPXAJ'),
        'magnet:?xt=urn:btih:anfhu5s6mdvjxp7ugbzo4xzqfjedpxaj',
    );
});

test('magnets and https .torrent links pass through unchanged', () => {
    const magnet =
        'magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c&dn=debian.iso';

    assert.equal(normalizeTorrentSource(magnet), magnet);
    assert.equal(
        normalizeTorrentSource('https://example.org/a.torrent'),
        'https://example.org/a.torrent',
    );
});

test('anything else never reaches the engine', () => {
    assert.equal(normalizeTorrentSource(''), null);
    assert.equal(normalizeTorrentSource('   '), null);
    // A magnet with no info hash names no torrent.
    assert.equal(normalizeTorrentSource('magnet:?dn=debian'), null);
    assert.equal(normalizeTorrentSource('deadbeef'), null);
    // Plain http and file:// are refused: one is not a link this offers, the
    // other would ask the shell to read the local disk.
    assert.equal(normalizeTorrentSource('http://example.org/a.torrent'), null);
    assert.equal(normalizeTorrentSource('file:///etc/passwd'), null);
});

test('speeds and times read as measurements, and absence reads as absence', () => {
    assert.equal(formatSpeed(0), '0 B/s');
    assert.equal(formatSpeed(2048), '2.0 KB/s');
    assert.equal(formatSpeed(5 * 1024 * 1024), '5.0 MB/s');

    assert.equal(formatEta(45), '45s');
    assert.equal(formatEta(600), '10m');
    assert.equal(formatEta(7200), '2h 0m');
    // A stalled torrent has no ETA; "∞" would read like a number.
    assert.equal(formatEta(null), null);
    assert.equal(formatEta(Infinity), null);
    assert.equal(formatEta(0), null);
});

test('the public gallery returns other owners and a pagination cursor', async () => {
    const { fetchNftGallery } = await import('@/lib/wallet/nft');
    const original = globalThis.fetch;
    let requested;
    globalThis.fetch = async (url) => {
        requested = String(url);
        return {
            ok: true,
            json: async () => ({
                items: [
                    {
                        id: '42',
                        owner: { hash: '0x1234' },
                        metadata: {
                            name: 'Example',
                            external_url: 'https://t.me/c/42',
                        },
                    },
                ],
                next_page_params: { unique_token: 41 },
            }),
        };
    };
    try {
        const result = await fetchNftGallery(
            {
                collection: '0x546462FAbf30734E63b64f32B30EC8ADD9B6EBa7',
                explorerUrl: 'https://example.org',
            },
            '92',
        );
        assert.match(requested, /unique_token=92/);
        assert.equal(result.next, '41');
        assert.equal(result.items[0].owner, '0x1234');
        assert.equal(result.items[0].externalUrl, 'https://t.me/c/42');
    } finally {
        globalThis.fetch = original;
    }
});
