/**
 * One manifest, said in two dialects.
 *
 * `manifest.json` is the Chromium one because that is the engine with the
 * stricter parser; this is the only place that knows how Gecko differs, and it
 * is a module rather than a branch inside `build.mjs` so the difference can be
 * asserted in tests instead of eyeballed in a build log.
 */

/** Gecko needs a stable id: it keys storage off it and AMO signs against it. */
export const GECKO_ID = 'cyberia-wallet@cyberia.church';

/**
 * 140 is where Firefox shows an add-on's data declaration in its own install
 * prompt (below). An older Firefox would install the wallet without ever
 * showing that, and addons.mozilla.org takes no new add-on without the
 * declaration — so 140 is the floor. It also clears the earlier one: `world:
 * "MAIN"` for a *registered* content script landed in 128, and without it the
 * provider cannot reach the page at all.
 */
export const GECKO_MIN = '140.0';

/**
 * Firefox for Android is deliberately not declared. Every approval opens in a
 * window of its own (`windows.create`) and Android has no windows API, so a
 * build installed there could connect to a site and then fail every signature
 * it was asked for. A `gecko_android` key is what addons.mozilla.org reads as
 * "works on Android" — 1.4.1 carried one and was listed for Android because of
 * it.
 *
 * `web-ext lint` answers its absence with one warning
 * (KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION: Android only reads the data
 * declaration from 142). It is about a platform this add-on no longer claims,
 * and the only ways to silence it are to claim Android again or to drop
 * desktop ESR 140 — so the warning stays, and it is the only one.
 */

/**
 * What leaves the browser, declared the way Firefox asks — shown to the user
 * in the install prompt and accepted there, with no opt-out because none of it
 * is optional: a wallet that does not ask a node about its address cannot show
 * a balance.
 *
 * - `financialAndPaymentInfo`: the account's address goes to each chain's RPC
 *   and token index (Cyberia's own, and Binance's, Base's and Robinhood's for
 *   their chains) to read balances and tokens, and a transaction the user
 *   signed is broadcast there.
 * - `websiteActivity`: what a connected site asks for is passed on — its
 *   read-only calls go straight to the chain's RPC, and a transaction it
 *   proposes goes there once the user approves it.
 *
 * `technicalAndInteraction` covers optional extension-open analytics. Firefox
 * sends it only when the user has granted this data collection permission.
 */
export const DATA_COLLECTION = {
    required: ['financialAndPaymentInfo', 'websiteActivity'],
    optional: ['technicalAndInteraction'],
};

export const TARGETS = {
    chrome: { dir: 'dist', zip: 'Cyberia-extension.zip', engine: 'chrome111' },
    firefox: { dir: 'dist-firefox', zip: 'Cyberia-extension-firefox.zip', engine: 'firefox128' },
};

/**
 * The manifest for one target, at one version.
 *
 * Both background keys cannot live in one file: Chromium rejects
 * `background.scripts` under MV3, and Gecko has no service worker to point at.
 */
export const manifestFor = (base, target, version) => {
    const manifest = structuredClone(base);
    manifest.version = version;

    if (target !== 'firefox') {
        return manifest;
    }

    delete manifest.minimum_chrome_version;
    manifest.background = { scripts: ['background.js'], type: 'module' };
    manifest.browser_specific_settings = {
        gecko: {
            id: GECKO_ID,
            strict_min_version: GECKO_MIN,
            data_collection_permissions: structuredClone(DATA_COLLECTION),
        },
    };

    return manifest;
};
