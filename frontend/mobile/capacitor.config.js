'use strict';

const { allowNavigation, resolveAppUrl, resolveStartUrl, resolveUserAgent } = require('./src/app-url');
const { version } = require('./package.json');

const appUrl = resolveAppUrl();
const startUrl = resolveStartUrl();
const { hostname, protocol } = new URL(appUrl);

/**
 * The shell renders the live site, so `server.url` is the whole app — pointed
 * at the wallet, which is what this app is for; the rest of Cyberia is a link
 * away inside it. `www/` is only the local fallback the WebView shows when that
 * URL cannot be reached (`server.errorPath`); regenerate it with `npm run www`.
 *
 * @type {import('@capacitor/cli').CapacitorConfig}
 */
const config = {
    appId: 'church.cyberia.app',
    appName: 'Cyberia',
    webDir: 'www',
    backgroundColor: '#0b0f10',
    // Lets the backend recognise the native shell (see resources/js/lib/native.ts)
    // and, for a Google Play or App Store build (CYBERIA_STORE=play|appstore),
    // which store edition of the wallet to serve (resources/js/lib/storeEdition.ts).
    appendUserAgent: resolveUserAgent(process.env, version),
    zoomEnabled: false,
    server: {
        url: startUrl,
        hostname,
        androidScheme: 'https',
        cleartext: protocol === 'http:',
        errorPath: 'error.html',
        allowNavigation: allowNavigation(appUrl),
    },
    android: {
        allowMixedContent: false,
        webContentsDebuggingEnabled: false,
    },
    ios: {
        // The site paints its own safe-area padding, so the WebView must not
        // add another inset on top of it.
        contentInset: 'never',
        limitsNavigationsToAppBoundDomains: false,
    },
    plugins: {
        SplashScreen: {
            launchAutoHide: true,
            launchShowDuration: 500,
            backgroundColor: '#0b0f10',
            androidSplashResourceName: 'splash',
            showSpinner: false,
        },
        PushNotifications: {
            presentationOptions: ['badge', 'sound', 'alert'],
        },
        StatusBar: {
            style: 'DARK',
            backgroundColor: '#0b0f10',
            overlaysWebView: false,
        },
    },
};

module.exports = config;
