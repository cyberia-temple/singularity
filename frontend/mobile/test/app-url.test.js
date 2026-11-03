'use strict';

/**
 * The URL resolver decides what the app renders and which hosts stay inside the
 * WebView, so it is worth a test that runs without Android or Xcode.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
    DEFAULT_APP_PATH,
    DEFAULT_APP_URL,
    allowNavigation,
    resolveAppPath,
    resolveAppUrl,
    resolveStartUrl,
    resolveStoreEdition,
    resolveUserAgent,
} = require('../src/app-url');

test('falls back to the production URL', () => {
    assert.equal(resolveAppUrl({}), DEFAULT_APP_URL);
});

test('accepts an http override for LAN builds', () => {
    assert.equal(resolveAppUrl({ CYBERIA_APP_URL: 'http://192.168.1.10:8000/' }), 'http://192.168.1.10:8000');
});

test('rejects a malformed or non-http override', () => {
    assert.equal(resolveAppUrl({ CYBERIA_APP_URL: 'nope' }), DEFAULT_APP_URL);
    assert.equal(resolveAppUrl({ CYBERIA_APP_URL: 'file:///etc/passwd' }), DEFAULT_APP_URL);
});

test('allows the app host, its subdomains, and the OAuth providers', () => {
    const hosts = allowNavigation('https://cyberia.church');

    assert.ok(hosts.includes('cyberia.church'));
    assert.ok(hosts.includes('*.cyberia.church'));
    assert.ok(hosts.includes('x.com'));
    assert.equal(hosts.includes('*'), false);
});

test('tracks the override host instead of the production one', () => {
    assert.deepEqual(allowNavigation('http://192.168.1.10:8000').slice(0, 2), [
        '192.168.1.10',
        '*.192.168.1.10',
    ]);
});

test('launches on the wallet, not on the site home', () => {
    assert.equal(resolveAppPath({}), DEFAULT_APP_PATH);
    assert.equal(resolveStartUrl({}), `${DEFAULT_APP_URL}/wallet`);
    assert.equal(
        resolveStartUrl({ CYBERIA_APP_URL: 'http://192.168.1.10:8000/' }),
        'http://192.168.1.10:8000/wallet',
    );
});

test('a landing route may never move the app to another origin', () => {
    assert.equal(resolveAppPath({ CYBERIA_APP_PATH: '//evil.example/wallet' }), DEFAULT_APP_PATH);
    assert.equal(resolveAppPath({ CYBERIA_APP_PATH: 'https://evil.example' }), DEFAULT_APP_PATH);
    assert.equal(resolveAppPath({ CYBERIA_APP_PATH: 'wallet' }), DEFAULT_APP_PATH);
    assert.equal(resolveAppPath({ CYBERIA_APP_PATH: '/bridge?to=sol' }), '/bridge?to=sol');
});

test('a root landing route keeps its slash, query and all', () => {
    assert.equal(resolveAppPath({ CYBERIA_APP_PATH: '/' }), '/');
    assert.equal(resolveAppPath({ CYBERIA_APP_PATH: '/?ref=app' }), '/?ref=app');
});

test('the WebView is pointed at the landing route, and the host stays the host', () => {
    const config = require('../capacitor.config');

    assert.equal(config.server.url, `${DEFAULT_APP_URL}/wallet`);
    assert.equal(config.server.hostname, new URL(DEFAULT_APP_URL).hostname);
    assert.ok(config.server.allowNavigation.includes(new URL(DEFAULT_APP_URL).hostname));
});

test('keeps the encrypted wallet vault out of Android backups', () => {
    const manifest = fs.readFileSync(
        path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
        'utf8',
    );

    assert.match(manifest, /android:allowBackup="false"/);
});

test('only a known store names a store edition', () => {
    assert.equal(resolveStoreEdition({}), null);
    assert.equal(resolveStoreEdition({ CYBERIA_STORE: 'play' }), 'play');
    assert.equal(resolveStoreEdition({ CYBERIA_STORE: ' AppStore ' }), 'appstore');
    assert.equal(resolveStoreEdition({ CYBERIA_STORE: 'huawei' }), null);
});

test('the user agent carries the store token only in a store build', () => {
    assert.equal(resolveUserAgent({}, '1.2.3'), 'CyberiaMobile/1.2.3');
    assert.equal(resolveUserAgent({ CYBERIA_VERSION_NAME: '2.0.0' }, '1.2.3'), 'CyberiaMobile/2.0.0');
    assert.equal(
        resolveUserAgent({ CYBERIA_STORE: 'play' }, '1.2.3'),
        'CyberiaMobile/1.2.3 CyberiaStore/play',
    );
    // The site matches exactly this token (resources/js/lib/storeEdition.ts).
    assert.match(resolveUserAgent({ CYBERIA_STORE: 'appstore' }), /\bCyberiaStore\/(play|appstore)\b/);
});

test('a build with Firebase configured says so, and only then', () => {
    assert.match(resolveUserAgent({ CYBERIA_PUSH: '1' }, '1.5.0'), /CyberiaMobile\/1\.5\.0 CyberiaPush\/1$/);
    assert.doesNotMatch(resolveUserAgent({}, '1.5.0'), /CyberiaPush/);
});
