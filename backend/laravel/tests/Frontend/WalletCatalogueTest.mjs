import assert from 'node:assert/strict';
import test from 'node:test';
import {
    NETWORK_CATALOGUE,
    catalogueMark,
    catalogueNetwork,
    catalogueWalletChain,
    catalogueWalletChains,
    deriveAccounts,
    readNetworkChoices,
    searchCatalogue,
    seedFromMnemonic,
    seedSource,
    setCatalogueWalletChains,
    walletChains,
    writeNetworkChoices,
} from '@/lib/wallet';
import { shippedChains } from '@/lib/wallet/chains';

/**
 * The catalogue makes one promise per row and no more: this chain id is real,
 * this endpoint answers a browser, and the account behind it is the account the
 * seed already derives. These tests pin the parts of that promise that are
 * checkable without a network — the shape of the data, and the claim that a
 * catalogue network is the *same account* as a built-in one.
 *
 * The endpoints themselves were verified against the live networks when the
 * file was generated (an RPC has to return its own chain id to a request
 * carrying a browser `Origin`); nothing here re-runs that, because a unit test
 * that fails when a third party has an outage is a test nobody keeps green.
 */

const PHRASE =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('the catalogue is a hundred networks and more', () => {
    assert.ok(
        NETWORK_CATALOGUE.length >= 100,
        `expected 100+ networks, got ${NETWORK_CATALOGUE.length}`,
    );
});

test('nothing in the catalogue collides with anything else', () => {
    const ids = new Set();
    const chainIds = new Set();
    const tags = new Set(shippedChains().map((chain) => chain.mark.tag));
    const shippedIds = new Set(shippedChains().map((chain) => chain.id));
    const builtinChainIds = new Set(
        shippedChains().map((chain) => chain.chainId).filter(
            (id) => id !== undefined,
        ),
    );

    for (const network of NETWORK_CATALOGUE) {
        assert.ok(!ids.has(network.id), `duplicate id ${network.id}`);
        assert.ok(
            !shippedIds.has(network.id),
            `${network.id} shadows a built-in network`,
        );
        assert.ok(
            !chainIds.has(network.chainId),
            `duplicate chain id ${network.chainId}`,
        );
        assert.ok(
            !builtinChainIds.has(network.chainId),
            `chain ${network.chainId} is already built in`,
        );
        // Two letters are what a colour-blind reader actually reads off the
        // tile, so they carry the whole identity and have to be unique.
        assert.ok(!tags.has(network.tag), `duplicate tag ${network.tag}`);

        ids.add(network.id);
        chainIds.add(network.chainId);
        tags.add(network.tag);
    }
});

test('every endpoint is one a browser can actually reach', () => {
    for (const network of NETWORK_CATALOGUE) {
        // The wallet is served over TLS: a plain-HTTP endpoint is blocked as
        // mixed content and would show up as a network that never loads.
        assert.match(
            network.rpc,
            /^https:\/\//,
            `${network.id} has a non-HTTPS RPC`,
        );

        if (network.explorer !== null) {
            assert.match(
                network.explorer,
                /^https:\/\/[^/]+/,
                `${network.id} has a malformed explorer`,
            );
            assert.ok(
                !network.explorer.endsWith('/'),
                `${network.id} explorer has a trailing slash, which would double the one in the link`,
            );
        }

        if (network.blockscout !== undefined) {
            assert.ok(
                network.blockscout.endsWith('/api'),
                `${network.id} blockscout root must be the API root`,
            );
        }

        assert.ok(
            /^[A-Za-z0-9]{2}$/.test(network.tag),
            `${network.id} tag must be two alphanumerics`,
        );
        assert.ok(network.chainId > 0, `${network.id} has no chain id`);
        assert.ok(network.symbol.length > 0, `${network.id} has no symbol`);
    }
});

test('a catalogue network is the same account as a built-in one', () => {
    const source = seedSource(seedFromMnemonic(PHRASE), 0);
    const home = shippedChains().find((chain) => chain.id === 'cyberia');
    const arbitrum = catalogueWalletChain(catalogueNetwork('arbitrum-one'));

    // The whole reason switching a network on cannot lose money: coin type 60
    // is one key, and every EVM chain in this wallet shows the same string.
    assert.equal(arbitrum.derive(source), home.derive(source));
    assert.equal(arbitrum.family, 'evm');
    assert.equal(arbitrum.path(0), home.path(0));
    assert.equal(arbitrum.chainId, 42161);
    assert.equal(arbitrum.decimals, 18);
});

test('a network states what it can do rather than implying it', () => {
    const indexed = NETWORK_CATALOGUE.find(
        (network) => network.blockscout !== undefined,
    );
    const bare = NETWORK_CATALOGUE.find(
        (network) => network.blockscout === undefined,
    );

    const withIndex = catalogueWalletChain(indexed);
    const withoutIndex = catalogueWalletChain(bare);

    assert.ok(withIndex.fetchTokens, 'an indexed chain can list tokens');
    assert.equal(withIndex.tokensNote, undefined);
    assert.ok(withIndex.fetchHistory, 'an indexed chain can show history');

    // Not "this address holds nothing" — "nobody here can enumerate them".
    assert.equal(withoutIndex.fetchTokens, undefined);
    assert.equal(withoutIndex.tokensNote, 'tokensNoIndexer');
    assert.equal(withoutIndex.fetchHistory, undefined);
    assert.equal(withoutIndex.historyNote, 'historyNoIndexer');

    // Both can still be read and spent from: that is what a verified RPC buys.
    for (const chain of [withIndex, withoutIndex]) {
        assert.deepEqual(chain.capabilities, {
            balance: true,
            history: chain.explorerAddressUrl('0x0') !== null,
            send: true,
        });
    }
});

test('a shipped network is never drawn as one the user typed in', () => {
    for (const network of NETWORK_CATALOGUE.slice(0, 20)) {
        const chain = catalogueWalletChain(network);

        // `custom` is the flag every screen reads to decide whether to warn
        // about an unvetted endpoint. These endpoints were vetted.
        assert.notEqual(chain.custom, true);
        assert.notEqual(chain.mark.unverified, true);
        assert.equal(catalogueMark(network).shape, 'square');
        assert.match(catalogueMark(network).hue, /^var\(--cw-net-cat-[1-8]\)$/);
    }
});

test('one derivation per key, and never one address across two keys', () => {
    // The catalogue turns one unlock into 120 walks of the same BIP-32 path
    // unless something notices they are the same path. What must not happen is
    // the shortcut reaching across a boundary it should not.
    setCatalogueWalletChains(
        catalogueWalletChains(NETWORK_CATALOGUE.map((network) => network.id)),
    );

    try {
        const accounts = deriveAccounts(PHRASE);
        const evm = accounts.filter((account) => account.family === 'evm');

        assert.ok(evm.length > 100, 'every catalogue network derives');
        assert.equal(
            new Set(evm.map((account) => account.address)).size,
            1,
            'every EVM network is one address',
        );

        const bitcoin = accounts.find((account) => account.chain === 'bitcoin');
        const litecoin = accounts.find(
            (account) => account.chain === 'litecoin',
        );
        const solana = accounts.find((account) => account.chain === 'solana');

        // Same family, different coin type — different path, different address.
        assert.notEqual(bitcoin.address, litecoin.address);
        assert.notEqual(solana.address, evm[0].address);
        assert.notEqual(bitcoin.path, litecoin.path);
    } finally {
        setCatalogueWalletChains([]);
    }
});

test('the catalogue is searched by the three things people have', () => {
    const byName = searchCatalogue('arbitrum');
    assert.ok(byName.some((network) => network.chainId === 42161));
    assert.ok(byName.some((network) => network.chainId === 42170));

    // A ticker, which is what a user copying from an exchange has.
    assert.ok(
        searchCatalogue('AVAX').some((network) => network.chainId === 43114),
    );

    // And a chain id, which is what a dapp saying "switch to 137" gives them.
    assert.ok(
        searchCatalogue('137').some((network) => network.chainId === 137),
    );

    assert.deepEqual(searchCatalogue('not-a-network-anywhere'), []);
    assert.equal(searchCatalogue('  ').length, NETWORK_CATALOGUE.length);
});

test('only the choices that differ from the default are stored', () => {
    const store = new Map();

    globalThis.window = {
        localStorage: {
            getItem: (key) => store.get(key) ?? null,
            setItem: (key, value) => store.set(key, value),
            removeItem: (key) => store.delete(key),
        },
    };

    try {
        // Deviations, in both directions: one network switched on that arrives
        // off, one switched off that arrives on. A stored list of "what is on"
        // could not have said the second thing.
        writeNetworkChoices({ 'arbitrum-one': true, bnb: false });
        assert.deepEqual(readNetworkChoices(), {
            'arbitrum-one': true,
            bnb: false,
        });

        // The key this replaced held the catalogue ids that were on, which is
        // exactly a set of deviations from a default of off — so an existing
        // wallet opens on the networks it closed on, with nobody asked.
        store.delete('cyberia.wallet.networks.v2');
        store.set(
            'cyberia.wallet.catalogue.v1',
            JSON.stringify(['arbitrum-one', 'a-chain-that-was-removed']),
        );
        assert.deepEqual(readNetworkChoices(), { 'arbitrum-one': true });

        // A corrupt list is a settings problem, never a funds problem.
        store.set('cyberia.wallet.networks.v2', '{not json');
        assert.deepEqual(readNetworkChoices(), {});
    } finally {
        delete globalThis.window;
    }
});

test('switching a network on adds an account and never touches the others', () => {
    const before = deriveAccounts(PHRASE).length;
    const chains = catalogueWalletChains(['polygon', 'arbitrum-one']);

    assert.equal(chains.length, 2);
    // Catalogue order, not the order the ids were typed in: the portfolio
    // lists networks the same way twice.
    assert.deepEqual(
        chains.map((chain) => chain.id),
        NETWORK_CATALOGUE.filter((network) =>
            ['polygon', 'arbitrum-one'].includes(network.id),
        ).map((network) => network.id),
    );

    // Nothing was published to the registry, so the derived set is untouched.
    assert.equal(deriveAccounts(PHRASE).length, before);
    assert.equal(
        walletChains().length,
        shippedChains().length,
        'building an adapter must not register it',
    );
});
