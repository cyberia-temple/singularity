'use strict';

/**
 * Single source of truth for the site the mobile shell renders.
 *
 * The shell has no bundle of its own: it points a native WebView at the live
 * Cyberia site. Override with CYBERIA_APP_URL to build a staging or LAN app
 * (`CYBERIA_APP_URL=http://192.168.1.10:8000 npm run sync:android`).
 *
 * The app is the Cyberia wallet first: it launches on the wallet rather than
 * the site home, and the wallet renders without site chrome inside a native
 * shell. Override the landing route with CYBERIA_APP_PATH.
 */

const DEFAULT_APP_URL = 'https://cyberia.church';

const DEFAULT_APP_PATH = '/wallet';

/** Hosts that may take over the WebView; anything else opens in the browser. */
const EXTRA_NAVIGABLE_HOSTS = [
    'accounts.google.com',
    'api.twitter.com',
    'api.x.com',
    'twitter.com',
    'x.com',
];

function resolveAppUrl(env = process.env) {
    const candidate = env.CYBERIA_APP_URL || DEFAULT_APP_URL;

    try {
        const url = new URL(candidate);

        if (url.protocol !== 'https:' && url.protocol !== 'http:') {
            return DEFAULT_APP_URL;
        }

        return url.toString().replace(/\/$/, '');
    } catch {
        return DEFAULT_APP_URL;
    }
}

/**
 * The route the WebView launches on, as a same-origin absolute path.
 *
 * A full URL or a protocol-relative `//host` would quietly point the whole app
 * at another origin, so anything that is not a plain path falls back to the
 * wallet instead of being followed.
 */
function resolveAppPath(env = process.env) {
    const candidate = env.CYBERIA_APP_PATH ?? DEFAULT_APP_PATH;

    if (typeof candidate !== 'string') {
        return DEFAULT_APP_PATH;
    }

    const raw = candidate.trim();

    if (!raw.startsWith('/') || raw.startsWith('//')) {
        return DEFAULT_APP_PATH;
    }

    try {
        const { pathname, search, hash } = new URL(raw, 'https://placeholder.invalid');
        // Trim a trailing slash, but never the one that *is* the path: "/"
        // with a query has to stay "/?x", not "?x".
        const route = pathname === '/' ? '/' : pathname.replace(/\/$/, '');

        return `${route}${search}${hash}`;
    } catch {
        return DEFAULT_APP_PATH;
    }
}

/** The exact URL the WebView opens: the app origin plus its landing route. */
function resolveStartUrl(env = process.env) {
    return `${resolveAppUrl(env)}${resolveAppPath(env)}`;
}

/**
 * `allowNavigation` entries for the resolved app URL: the host itself, its
 * subdomains, and the OAuth providers the site redirects through.
 */
function allowNavigation(appUrl) {
    const { hostname } = new URL(appUrl);

    return [hostname, `*.${hostname}`, ...EXTRA_NAVIGABLE_HOSTS];
}

/** The stores a build may be made for; see `resolveStoreEdition`. */
const STORE_EDITIONS = ['play', 'appstore'];

/**
 * Which store this build is for, from CYBERIA_STORE, or null for the APK the
 * site serves at /download.
 *
 * A store build says so in its user agent and the site answers it with the
 * store edition of the wallet (`resources/js/lib/storeEdition.ts` and the
 * `ConfineStoreEdition` middleware): the screens those stores do not take from
 * an unlicensed developer are left out, and the app stays on the wallet. An
 * edition this file does not know is not a store build, so a typo ships the
 * whole wallet to nobody rather than a half-confined one to a store.
 */
function resolveStoreEdition(env = process.env) {
    const candidate = String(env.CYBERIA_STORE ?? '').trim().toLowerCase();

    return STORE_EDITIONS.includes(candidate) ? candidate : null;
}

/** What the shell appends to the WebView's user agent. */
function resolveUserAgent(env = process.env, version = '1.0.0') {
    const edition = resolveStoreEdition(env);
    const own = `CyberiaMobile/${env.CYBERIA_VERSION_NAME || version}`;
    // Firebase is configured in this build (google-services.json was there at
    // sync time): the site may register for push. Without it, asking the
    // plugin to register would fail inside Firebase itself.
    const push = env.CYBERIA_PUSH === '1' ? ' CyberiaPush/1' : '';

    return (edition ? `${own} CyberiaStore/${edition}` : own) + push;
}

module.exports = {
    DEFAULT_APP_PATH,
    DEFAULT_APP_URL,
    EXTRA_NAVIGABLE_HOSTS,
    allowNavigation,
    resolveAppPath,
    resolveAppUrl,
    resolveStartUrl,
    resolveStoreEdition,
    resolveUserAgent,
    STORE_EDITIONS,
};
