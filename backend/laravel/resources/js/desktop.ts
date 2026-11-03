import './polyfills';
import '../css/app.css';
import '../desktop/desktop.css';
import { createInertiaApp, router } from '@inertiajs/vue3';
import { createApp, defineComponent, h } from 'vue';
import type { Component, DefineComponent } from 'vue';
import DesktopWalletGate from '@/components/wallet/DesktopWalletGate.vue';
import WalletFrameLayout from '@/layouts/WalletFrameLayout.vue';
import { configureAnalytics } from '@/lib/analytics';
import { initializeNativeShell } from '@/lib/native';
import Wallet from '@/pages/Wallet.vue';
import bootstrap from '../desktop/bootstrap.json';

initializeNativeShell();
configureAnalytics({ enabled: false });

// Navigation to another website belongs to the browser, never the key-holding renderer.
router.on('before', (event) => {
    const visit = new URL(event.detail.visit.url, window.location.href);

    if (visit.pathname !== '/wallet') {
        window.cyberiaNative?.openExternal?.(
            new URL(
                visit.pathname + visit.search + visit.hash,
                'https://cyberia.church',
            ).href,
        );

        return false;
    }
});

const LocalWallet: DefineComponent = defineComponent({
    inheritAttrs: false,
    render() {
        return h(DesktopWalletGate, null, {
            default: () => h(Wallet as Component, this.$attrs),
        });
    },
});

void createInertiaApp({
    page: {
        component: 'Wallet',
        url: window.location.pathname + window.location.search,
        version: 'desktop-local-v1',
        props: {
            ...bootstrap,
            solanaRpcUrl: `${window.location.origin}/api/solana/rpc`,
            auth: { user: null, canAccessCrm: false },
            errors: {},
            flash: {},
        },
        clearHistory: false,
        encryptHistory: false,
        flash: {},
        rememberedState: {},
    },
    resolve: (name) => {
        if (name !== 'Wallet') {
throw new Error('This build contains only the local wallet.');
}

        return LocalWallet;
    },
    layout: () => WalletFrameLayout,
    setup: ({ el, App, props, plugin }) => {
        createApp({ render: () => h(App, props) })
            .use(plugin)
            .mount(el);
    },
});
