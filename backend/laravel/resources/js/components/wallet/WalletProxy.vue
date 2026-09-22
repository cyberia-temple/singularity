<script setup lang="ts">
import { computed } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import {
    canOpenProxySettings,
    nativeProxy,
    nativeShell,
    openProxySettings,
} from '@/lib/native';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Where this wallet's requests go, and what carries them.
 *
 * Keys never leave the device. Requests do, and every one of them tells a node
 * somewhere that this address is being watched from this line — which is the
 * half of privacy a non-custodial wallet does not get for free. This screen is
 * the inventory of that: one row per network, naming the host that answers it.
 *
 * What it will not do is offer a switch this shell does not have. A page in a
 * browser tab cannot choose a transport — there is no API for it, and drawing
 * a SOCKS host and port that quietly did nothing would be worse than saying
 * so. The desktop app owns its own session and can, so there the setting is
 * one button away and the proxy in force is named; the extension routes its
 * own traffic and is pointed at rather than imitated.
 */

const props = defineProps<{ wallet: MultiWallet }>();

const emit = defineEmits<{ back: [] }>();

const { t } = useLocale(walletMessages);

const shell = nativeShell();

/** What the desktop shell says is carrying this window. Null anywhere else. */
const proxy = computed(() => nativeProxy());

const settable = computed(() => canOpenProxySettings());

/**
 * Which sentence this shell gets. Four, because four things are true in four
 * different places and a single "configure your proxy" would be false in three
 * of them.
 */
const transport = computed<'desktop' | 'browser' | 'mobile' | 'telegram'>(
    () => {
        if (settable.value) {
            return 'desktop';
        }

        if (shell === 'telegram') {
            return 'telegram';
        }

        return shell === 'mobile' ? 'mobile' : 'browser';
    },
);

/**
 * The proxy in force, as a label. `system` and `direct` are the shell's own
 * words and are translated; anything else is a rule string, which is shown
 * verbatim because it is an address and translating an address is nonsense.
 */
const proxyLabel = computed(() => {
    const described = proxy.value;

    if (described === null) {
        return null;
    }

    if (described === 'system') {
        return t('proxyModeSystem');
    }

    return described === 'direct' ? t('proxyModeDirect') : described;
});

/** Routed through something the user chose, rather than straight out. */
const routed = computed(
    () =>
        proxy.value !== null &&
        proxy.value !== 'direct' &&
        proxy.value !== 'system',
);

const host = (endpoint: string): string => {
    try {
        return new URL(endpoint).host;
    } catch {
        return endpoint;
    }
};

/**
 * Every network, and who answers for it.
 *
 * Three kinds of row, and the difference is who is on the other end. A chain
 * read straight from an RPC tells that RPC's operator the address and the line
 * it was asked from. Solana is read through this site's own relay, because the
 * public cluster refuses a browser outright — so the address reaches Cyberia's
 * server instead of Solana's, which is a different disclosure and is named as
 * one. Monero is read by nobody: there is no scanner here, so nothing about
 * that account is ever asked for.
 */
const rows = computed(() =>
    props.wallet.accounts.value.map((account) => {
        const endpoint = account.endpoint ?? null;
        const relayed =
            endpoint !== null &&
            typeof window !== 'undefined' &&
            endpoint.startsWith(window.location.origin);

        return {
            chain: account.chain,
            label: account.label,
            symbol: account.symbol,
            custom: account.custom,
            silent: !account.capabilities.balance,
            relayed,
            endpoint,
            host: endpoint === null ? null : host(endpoint),
        };
    }),
);
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navSecurity') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ t('proxyTitle') }}
        </h2>
        <p class="cw-prose">{{ t('proxyBody') }}</p>

        <!-- What carries the requests, which is a different answer per shell. -->
        <div class="cw-label" style="margin-top: 26px">
            {{ t('proxyTransport') }}
        </div>

        <div class="cw-card" style="margin-top: 10px">
            <div v-if="transport === 'desktop'">
                <div style="display: flex; align-items: center; gap: 10px">
                    <span
                        style="
                            width: 6px;
                            height: 6px;
                            flex: none;
                            border-radius: 50%;
                        "
                        :style="{
                            background: routed
                                ? 'var(--cw-accent)'
                                : 'var(--cw-muted)',
                        }"
                    />
                    <span class="cw-data" style="color: var(--cw-text)">{{
                        proxyLabel ?? t('proxyModeSystem')
                    }}</span>
                </div>
                <p class="cw-prose" style="margin-top: 12px">
                    {{
                        routed
                            ? t('proxyDesktopRouted')
                            : t('proxyDesktopDirect')
                    }}
                </p>
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="margin-top: 14px"
                    @click="openProxySettings()"
                >
                    {{ t('proxySettings') }}
                </button>
            </div>

            <template v-else>
                <p class="cw-prose">
                    {{
                        transport === 'telegram'
                            ? t('proxyTelegram')
                            : transport === 'mobile'
                              ? t('proxyMobile')
                              : t('proxyBrowser')
                    }}
                </p>
                <!--
                  The two builds that can actually do it. Offered as links
                  rather than as a switch, because this page is not either of
                  them and a control here would be theatre.
                -->
                <div
                    v-if="transport === 'browser'"
                    style="
                        display: flex;
                        gap: 8px;
                        margin-top: 14px;
                        flex-wrap: wrap;
                    "
                >
                    <a class="cw-ghost" href="/download/extension">{{
                        t('proxyGetExtension')
                    }}</a>
                    <a class="cw-ghost" href="/download">{{
                        t('proxyGetDesktop')
                    }}</a>
                </div>
            </template>
        </div>

        <!-- One row per network: who is told that this address is being read. -->
        <div class="cw-label" style="margin: 26px 0 10px">
            {{ t('proxyPerNetwork') }}
        </div>

        <div class="cw-card" style="padding: 0">
            <div
                v-for="row in rows"
                :key="row.chain"
                class="cw-row"
                style="
                    align-items: flex-start;
                    gap: 12px;
                    padding: 14px 16px;
                    border-bottom: 1px solid var(--cw-line);
                "
            >
                <NetworkMark :chain="row.chain" :size="22" />
                <span style="flex: 1; min-width: 0">
                    <span
                        style="
                            display: block;
                            font: 500 15px/1.2 var(--cw-sans);
                            color: var(--cw-text);
                        "
                        >{{ row.label }}</span
                    >
                    <span
                        style="
                            display: block;
                            margin-top: 4px;
                            font: 500 12px/1.5 var(--cw-mono);
                            color: var(--cw-dim);
                            word-break: break-all;
                        "
                    >
                        <template v-if="row.silent">{{
                            t('proxyNotRead')
                        }}</template>
                        <template v-else-if="row.relayed"
                            >{{ t('proxyViaRelay') }} · {{ row.host }}</template
                        >
                        <template v-else>{{ row.host }}</template>
                    </span>
                    <span
                        v-if="row.custom"
                        style="
                            display: block;
                            margin-top: 4px;
                            font: 500 12px/1.5 var(--cw-mono);
                            color: var(--cw-net-custom);
                        "
                        >{{ t('endpointUnverified') }}</span
                    >
                </span>
            </div>
        </div>

        <p class="cw-prose" style="margin-top: 12px">
            {{ t('proxyRelayNote') }}
        </p>

        <p class="cw-note cw-note-warn" style="margin-top: 22px">
            <span>{{ t('proxyLinkability') }}</span>
        </p>
    </div>
</template>
