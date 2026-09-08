// Install the browser `Buffer` global before anything else evaluates. Must be
// the first import so the global exists before any static- or lazily-imported
// module (e.g. the Solana-using bridge chunk) references it. See polyfills.ts.
import './polyfills';

import { createInertiaApp, router } from '@inertiajs/vue3';
import { initializeTheme } from '@/composables/useAppearance';
import { initializePwa } from '@/composables/usePwaInstall';
import AppLayout from '@/layouts/AppLayout.vue';
import AuthLayout from '@/layouts/AuthLayout.vue';
import ConsoleLayout from '@/layouts/ConsoleLayout.vue';
import SettingsLayout from '@/layouts/settings/Layout.vue';
import WalletFrameLayout from '@/layouts/WalletFrameLayout.vue';
import Web3Layout from '@/layouts/Web3Layout.vue';
import {
    configureAnalytics,
    initializeAnalytics,
    rememberAttribution,
} from '@/lib/analytics';
import { initializeNativeShell, isNativeShell } from '@/lib/native';
import { initializeTelegram } from '@/lib/telegram';
import { track } from '@/lib/track';

const appName = import.meta.env.VITE_APP_NAME || 'Laravel';

initializeNativeShell();
initializePwa();
// Fetches Telegram's SDK, and only inside Telegram: the frame needs to be told
// we are ready and to take the full height. Everything renders without it.
void initializeTelegram();

createInertiaApp({
    title: (title) =>
        title.endsWith('| Cyberia')
            ? title
            : title
              ? `${title} - ${appName}`
              : appName,
    layout: (name) => {
        switch (true) {
            // The wallet is an application and gets a frame rather than a
            // page — in a browser tab exactly as in the desktop and mobile
            // shells and the Telegram Mini App. It owns the viewport, carries
            // its own top bar and its own tab bar, and a site header above all
            // of that was a second navigation for something else.
            case name === 'Wallet':
                return WalletFrameLayout;
            case name === 'Analytics':
            case name === 'Changelog':
            case name === 'Cyber':
            case name === 'Download':
            case name === 'Token':
            case name === 'Tracker':
            case name === 'Tokens':
            case name === 'Bridge':
            case name === 'Market':
            case name === 'Lending':
            case name === 'Liquidate':
            case name === 'Liquidity':
            case name === 'Farm':
            case name === 'Feed':
            case name === 'Launchpad':
            case name === 'LainChat':
            case name === 'CyberSolSwap':
            case name === 'Swap':
            case name === 'Slots':
            case name === 'Predictions':
            case name === 'PixelBattle':
            case name === 'Profile':
            case name.startsWith('Growth/'):
            case name.startsWith('dao/'):
            case name.startsWith('proposals/'):
            case name.startsWith('users/'):
                return Web3Layout;
            // The operator console owns the viewport: a fixed alarm strip, a
            // rail of lenses and one scrolling lens. The site's sidebar and
            // breadcrumbs would be a second navigation over the top of it.
            case name.startsWith('crm/'):
                return ConsoleLayout;
            case name.startsWith('auth/'):
                return AuthLayout;
            case name.startsWith('settings/'):
            case name.startsWith('teams/'):
                return [AppLayout, SettingsLayout];
            default:
                return AppLayout;
        }
    },
    progress: {
        color: '#00e5d1',
    },
});

// This will set light / dark mode on page load...
initializeTheme();

/**
 * Whether this page is the wallet, for the purposes of product analytics.
 *
 * `analytics_users` is documented as one *installation of the wallet*, and the
 * North Star counts funded installations. Starting the client on every Inertia
 * navigation made every reader of `/farm`, `/login` and `/download` an
 * installation: of the first eight rows the table ever held, seven were people
 * who never opened a wallet at all, and the funnel they diluted is the one the
 * product is steered by.
 *
 * Three ways to be the wallet, and a person only has to be one of them:
 *
 *   - the page is a wallet screen, which is the ordinary path;
 *   - the app is running inside a shell — desktop, phone, Mini App — where the
 *     wallet is the whole product and any screen is a screen of it;
 *   - a vault exists in this browser, so whatever page this is, the person
 *     reading it has a wallet here and their return visit is retention.
 *
 * The site funnel keeps counting everything, because *it* is about a browser
 * reading pages. Nothing is lost by this; two questions stop sharing one
 * denominator.
 */
const WALLET_COMPONENTS = ['Wallet'];

const VAULT_KEY = 'cyberia.wallet.vault.v1';

const hasVault = (): boolean => {
    try {
        return window.localStorage.getItem(VAULT_KEY) !== null;
    } catch {
        // A browser that refuses storage cannot be holding a vault we could
        // read anyway, and must not throw a navigation handler.
        return false;
    }
};

const isWalletSurface = (component: string): boolean =>
    WALLET_COMPONENTS.includes(component) || isNativeShell() || hasVault();

// Funnel: one page_view per Inertia navigation (initial load included).
router.on('navigate', (event) => {
    track('page_view', {
        page: new URL(event.detail.page.url, window.location.origin).pathname,
    });

    /*
     * Product analytics is a different subject from the site funnel above —
     * an installation of the wallet rather than a browser reading pages — so
     * it gets its own client and its own tables. Configured from the shared
     * props on every navigation (including the first, which is why it sits
     * here) and started exactly once.
     */
    const settings = event.detail.page.props.analytics as
        | Parameters<typeof configureAnalytics>[0]
        | undefined;

    if (settings) {
        configureAnalytics(settings);
    }

    /*
     * Where this browser came from is worth knowing wherever it lands, and
     * costs one localStorage write that talks to nobody. Whether this browser
     * is an *installation of the wallet* is a different question, and the
     * answer decides whether the product tables hear about it at all.
     */
    rememberAttribution();

    if (isWalletSurface(event.detail.page.component)) {
        initializeAnalytics();
    }
});
