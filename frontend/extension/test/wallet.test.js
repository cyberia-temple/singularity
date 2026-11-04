/**
 * The rules that would be expensive to get wrong: which chain is which, what a
 * page may call without a human, what the relay does to the browser, and what
 * the manifest is allowed to ask for.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { CHAINS, DEFAULT_CHAIN_ID, chainById, chainIdHex, parseChainId } from '../src/shared/chains.js';
import { APPROVAL_METHODS, PASSTHROUGH_METHODS, keepsWalletAwake, rpcError } from '../src/shared/protocol.js';
import {
    endpointFor,
    permissionsFor,
    proxyConfigFor,
    proxyInfoFor,
    routesThrough,
    walletEndpoints,
} from '../src/background/relay.js';
import { DATA_COLLECTION, GECKO_ID, GECKO_MIN, TARGETS, manifestFor } from '../manifest.mjs';
import { addressFor, isValidPhrase, normalisePhrase, pathFor } from '../src/background/keyring.js';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

/** The BIP-39 test vector every wallet ships in its own test suite. */
const VECTOR_PHRASE =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('49406 is 0xC0FE, and the hex is always derived', () => {
    assert.equal(chainIdHex(49_406), '0xc0fe');
    assert.equal(DEFAULT_CHAIN_ID, 49_406);
    assert.equal(chainById('49406').name, 'Cyberia');
    assert.equal(chainById(1), null, 'a chain the wallet does not carry is not a chain');
});

test('a chain id from a page is read in either notation, or refused', () => {
    assert.equal(parseChainId('0xc0fe'), 49_406);
    assert.equal(parseChainId('49406'), 49_406);
    assert.equal(parseChainId(8453), 8453);
    assert.equal(parseChainId('mainnet'), null);
    assert.equal(parseChainId(''), null);
    assert.equal(parseChainId(-1), null);
});

test('every chain RPC is a host the manifest was allowed to reach', () => {
    for (const chain of CHAINS) {
        const host = new URL(chain.rpc).host;
        const allowed = manifest.host_permissions.some((pattern) => pattern.includes(host));

        assert.ok(allowed, `${chain.name} RPC ${host} is missing from host_permissions`);
    }
});

test('the provider is never injected everywhere', () => {
    assert.ok(!('content_scripts' in manifest), 'injection is registered per granted origin');
    assert.ok(
        !manifest.host_permissions.some((pattern) => pattern.includes('<all_urls>') || pattern === 'https://*/*'),
        'a wallet that can read every page can fingerprint every page',
    );
    assert.deepEqual(manifest.optional_permissions, ['proxy', 'privacy']);
});

test('no method both bypasses the human and reaches the signer', () => {
    for (const method of APPROVAL_METHODS) {
        assert.ok(!PASSTHROUGH_METHODS.has(method), `${method} must stop at a person`);
    }

    assert.ok(!PASSTHROUGH_METHODS.has('eth_sendTransaction'));
    assert.ok(!PASSTHROUGH_METHODS.has('eth_requestAccounts'));
    assert.equal(rpcError('userRejected').code, 4001);
    assert.equal(rpcError('unauthorized').code, 4100);
});

test('a page polling the chain does not keep the vault open', () => {
    for (const method of PASSTHROUGH_METHODS) {
        assert.ok(!keepsWalletAwake(method), `${method} must not re-arm the auto-lock`);
    }

    for (const method of [...APPROVAL_METHODS, 'eth_requestAccounts', 'wallet_requestPermissions']) {
        assert.ok(keepsWalletAwake(method), `${method} is somebody using the wallet`);
    }

    assert.ok(!keepsWalletAwake('eth_accounts'));
    assert.ok(!keepsWalletAwake(undefined));
});

test('no screen is re-rendered from a keystroke', async () => {
    /*
     * The popup and the onboarding page render by replacing markup. Doing that
     * from an `input` event puts the text into a fresh element with the caret
     * at position 0, so each character lands in front of the last one — the
     * password was typed backwards, and it shipped that way in app-v1.2.0.
     *
     * The fix is architectural, which makes it easy to undo by accident: any
     * future handler that "just re-renders" brings the bug straight back. So
     * the rule is pinned here rather than left to a browser nobody runs.
     */
    for (const file of ['../src/popup/popup.js', '../src/onboarding/onboarding.js']) {
        const source = await readFile(new URL(file, import.meta.url), 'utf8');
        const at = source.indexOf("addEventListener('input'");

        assert.ok(at > 0, `${file} has no input handler`);

        // The handler body, up to the listener that follows it.
        const body = source.slice(at, source.indexOf('addEventListener', at + 30));

        assert.ok(
            !/\brender\(\)/.test(body),
            `${file} re-renders on input — the caret jumps and text arrives reversed`,
        );
    }
});

test('a relay is applied only when it points somewhere', () => {
    assert.equal(proxyConfigFor({ mode: 'direct' }), null);
    assert.equal(proxyConfigFor({ mode: 'socks5', host: '', port: '1080' }), null);
    assert.equal(proxyConfigFor({ mode: 'socks5', host: '127.0.0.1', port: '70000' }), null);

    assert.deepEqual(proxyConfigFor({ mode: 'socks5', host: '127.0.0.1', port: '10808' }).rules.singleProxy, {
        scheme: 'socks5',
        host: '127.0.0.1',
        port: 10_808,
    });

    // Tor and I2P ignore whatever is typed in the SOCKS fields: they are the
    // ports those daemons listen on, not a preference.
    assert.deepEqual(proxyConfigFor({ mode: 'tor', host: '10.0.0.1', port: '1' }).rules.singleProxy, {
        scheme: 'socks5',
        host: '127.0.0.1',
        port: 9050,
    });
    assert.equal(proxyConfigFor({ mode: 'i2p' }).rules.singleProxy.port, 4444);
});

test('localhost stays direct, so a relay never hides a node on this machine', () => {
    assert.deepEqual(proxyConfigFor({ mode: 'tor' }).rules.bypassList, ['<local>']);
});

test('gecko gets a per-request route, and it covers the wallet only', () => {
    const tor = { mode: 'tor' };

    assert.deepEqual(proxyInfoFor({ mode: 'direct' }), { type: 'direct' });
    assert.deepEqual(proxyInfoFor(tor), {
        type: 'socks',
        host: '127.0.0.1',
        port: 9050,
        // A name resolved outside the relay announces every host the wallet
        // talks to, which is the leak the relay exists to close.
        proxyDNS: true,
    });
    assert.equal(proxyInfoFor({ mode: 'i2p' }).type, 'http');

    // The wallet's own endpoints go through it; a page the user happens to have
    // open does not, unless they asked for that explicitly.
    assert.equal(routesThrough(tor, 'https://rpc.cyberia.church/'), true);
    assert.equal(routesThrough(tor, 'https://explorer.cyberia.church/api?x=1'), true);
    assert.equal(routesThrough(tor, 'https://cyberia.church/api/wallet/prices'), true);
    assert.equal(routesThrough(tor, 'https://example.com/'), false);
    assert.equal(routesThrough({ ...tor, routeBrowser: true }, 'https://example.com/'), true);

    // Localhost never routes: a relay must not hide a node on this machine.
    assert.equal(routesThrough({ ...tor, routeBrowser: true }, 'http://127.0.0.1:8545/'), false);
    assert.equal(routesThrough({ ...tor, routeBrowser: true }, 'http://localhost:5173/'), false);

    // And nothing routes at all without somewhere to route to.
    assert.equal(routesThrough({ mode: 'direct' }, 'https://rpc.cyberia.church/'), false);
    assert.equal(endpointFor({ mode: 'socks5', host: '127.0.0.1', port: '0' }), null);
    assert.ok(walletEndpoints().includes('https://rpc.cyberia.church'));
});

test('the firefox manifest is the same wallet in gecko dialect', () => {
    const gecko = manifestFor(manifest, 'firefox', '9.9.9');

    assert.equal(gecko.version, '9.9.9');
    assert.deepEqual(gecko.background, { scripts: ['background.js'], type: 'module' });
    assert.ok(!('service_worker' in gecko.background), 'gecko has no service worker to point at');
    assert.ok(!('minimum_chrome_version' in gecko));
    assert.equal(gecko.browser_specific_settings.gecko.id, GECKO_ID);
    assert.equal(gecko.browser_specific_settings.gecko.strict_min_version, GECKO_MIN);
    // AMO refuses a new add-on without the declaration, and Firefox only
    // shows it from 140 — an older floor would install without the prompt.
    assert.deepEqual(gecko.browser_specific_settings.gecko.data_collection_permissions, DATA_COLLECTION);
    assert.ok(Number.parseFloat(GECKO_MIN) >= 140);
    assert.ok(!DATA_COLLECTION.required.includes('none'), 'the wallet does talk to nodes');
    // Approvals open with windows.create and Android has no windows API; AMO
    // lists an add-on for Android off this key.
    assert.ok(!('gecko_android' in gecko.browser_specific_settings), 'not an Android add-on');

    // Everything that decides what the wallet may reach stays identical.
    assert.deepEqual(gecko.permissions, manifest.permissions.filter((permission) => permission !== 'sidePanel'));
    assert.ok(!('side_panel' in gecko));
    assert.equal(gecko.action.default_popup, 'popup.html');
    assert.deepEqual(gecko.optional_permissions, manifest.optional_permissions);
    assert.deepEqual(gecko.host_permissions, manifest.host_permissions);
    assert.ok(!('content_scripts' in gecko));

    const chromium = manifestFor(manifest, 'chrome', '9.9.9');
    assert.equal(chromium.background.service_worker, 'background.js');
    assert.equal(chromium.side_panel.default_path, 'popup.html?view=sidepanel');
    assert.ok(chromium.permissions.includes('sidePanel'));
    assert.ok(!('default_popup' in chromium.action));
    assert.ok(!('browser_specific_settings' in chromium));
});

test('the two builds land in their own directories under their own names', () => {
    assert.equal(TARGETS.chrome.zip, 'Cyberia-extension.zip');
    assert.equal(TARGETS.firefox.zip, 'Cyberia-extension-firefox.zip');
    assert.notEqual(TARGETS.chrome.dir, TARGETS.firefox.dir);
});

test('a relay profile declares the permissions it needs', () => {
    assert.deepEqual(permissionsFor({ mode: 'tor' }), ['proxy']);
    assert.deepEqual(permissionsFor({ mode: 'direct', blockWebrtc: true }), ['privacy']);
    assert.deepEqual(permissionsFor({ mode: 'direct' }), []);
});

test('accounts derive exactly where the wallet on the site derives them', () => {
    // The same published BIP-39 vector, and the same expected address, as
    // `backend/laravel/tests/Frontend/WalletDerivationTest.mjs`. This is the
    // promise that importing your site phrase here finds the same funds; if it
    // ever fails, the extension is deriving someone else's accounts.
    assert.equal(pathFor(0), "m/44'/60'/0'/0/0");
    assert.equal(pathFor(3), "m/44'/60'/0'/0/3");
    assert.equal(addressFor(VECTOR_PHRASE, 0), '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    assert.notEqual(addressFor(VECTOR_PHRASE, 1), addressFor(VECTOR_PHRASE, 0));
});

test('a phrase is checked, not merely counted', () => {
    assert.equal(isValidPhrase(VECTOR_PHRASE), true);
    assert.equal(isValidPhrase(VECTOR_PHRASE.replace('about', 'abandon')), false, 'checksum word');
    assert.equal(isValidPhrase(`  ${VECTOR_PHRASE.toUpperCase()} `), true);
    assert.equal(normalisePhrase('  ABANDON   about '), 'abandon about');
});
