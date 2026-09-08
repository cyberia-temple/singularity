<script setup lang="ts">
import { computed, ref } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import {
    HOME_CHAIN,
    NETWORK_CATALOGUE,
    catalogueMark,
    shippedChains,
} from '@/lib/wallet';
import type { WalletChainId, WalletMark } from '@/lib/wallet';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The network list: everything this wallet knows how to reach, and which of it
 * is on.
 *
 * One list, because there is one kind of network. The screen used to open with
 * eight cards marked "always on" and then a hundred and twenty rows with
 * switches underneath, which drew a hierarchy that does not exist: a network we
 * happened to ship switched on is made by the same factory, read through the
 * same adapters and signed with the same key as one somebody switches on today.
 * What ships on is a default about how many balances a refresh should read —
 * 120 cards reading 120 balances is not a portfolio, it is a load test — and a
 * default belongs in the switch's starting position, not in a separate tier.
 *
 * Cyberia is the exception and the only one: it is the chain this wallet is
 * for, so it sits first and has no switch.
 *
 * The seed derives an account on every one of these already — that is what
 * BIP-44 coin type 60 means — so nothing here creates or destroys an account.
 * Every row states what that network can actually do rather than implying it:
 * balances and sending are true everywhere, tokens and history need a keyless
 * index that about a third of them have, and the rest say so in the row instead
 * of showing an empty list later.
 *
 * The one group still kept apart is the networks the user typed in themselves,
 * and that is not rank either — nobody vetted the endpoint, and every screen
 * that draws one says so.
 */

const props = defineProps<{
    wallet: MultiWallet;
}>();

const emit = defineEmits<{
    back: [];
    addNetwork: [];
    open: [chain: WalletChainId];
}>();

const { t } = useLocale(walletMessages);

const query = ref('');
type Filter = 'all' | 'on' | 'indexed';
const filter = ref<Filter>('all');

const FILTERS: { id: Filter; label: () => string }[] = [
    { id: 'all', label: () => t('networksFilterAll') },
    { id: 'on', label: () => t('networksFilterOn') },
    { id: 'indexed', label: () => t('networksFilterIndexed') },
];

const enabled = computed(() => props.wallet.enabledNetworks.value);

type Row = {
    id: WalletChainId;
    label: string;
    symbol: string;
    /** Only the catalogue needs one: its marks are derived, not registered. */
    mark?: WalletMark;
    chainId: number | null;
    indexed: boolean;
    explorer: boolean;
    on: boolean;
    /** The home chain, which has no switch. */
    home: boolean;
};

/**
 * Every network, from both places it can come from, as one kind of row.
 *
 * Cyberia first because it is the exception; everything after it alphabetical,
 * which is the one order that is visibly not a ranking. Registry order would
 * have put the shipped eight on top again by accident.
 */
const all = computed<Row[]>(() => {
    const on = enabled.value;

    const shipped = shippedChains().map<Row>((chain) => ({
        id: chain.id,
        label: chain.label,
        symbol: chain.symbol,
        chainId: chain.chainId ?? null,
        indexed: chain.readToken !== undefined,
        explorer: chain.explorerTxUrl('0x0') !== null,
        on: on.includes(chain.id),
        home: chain.id === HOME_CHAIN,
    }));

    const catalogue = NETWORK_CATALOGUE.map<Row>((network) => ({
        id: network.id,
        label: network.label,
        symbol: network.symbol,
        mark: catalogueMark(network),
        chainId: network.chainId,
        indexed: network.blockscout !== undefined,
        explorer: network.explorer !== null,
        on: on.includes(network.id),
        home: false,
    }));

    return [...shipped, ...catalogue].sort((a, b) => {
        if (a.home !== b.home) {
            return a.home ? -1 : 1;
        }

        return a.label.localeCompare(b.label);
    });
});

const rows = computed(() => {
    const term = query.value.trim().toLowerCase();

    return all.value.filter((row) => {
        if (filter.value === 'on' && !row.on) {
            return false;
        }

        if (filter.value === 'indexed' && !row.indexed) {
            return false;
        }

        return (
            term === '' ||
            row.label.toLowerCase().includes(term) ||
            row.symbol.toLowerCase().includes(term) ||
            String(row.chainId ?? '').includes(term)
        );
    });
});

const onCount = computed(() => all.value.filter((row) => row.on).length);

/** Networks the user described themselves, listed so they can be removed. */
const custom = computed(() => props.wallet.customNetworks.value);

const toggle = (row: Row): void => {
    if (row.home) {
        return;
    }

    props.wallet.setNetwork(row.id, !row.on);

    if (!row.on) {
        // A network switched on has never been read: ask for its balance now
        // rather than leaving a card that says nothing until the next refresh.
        void props.wallet.refreshBalances();
    }
};

/** What a row promises, in one line, and never more than is true. */
const capabilityOf = (row: Row): string =>
    row.indexed
        ? t('networksIndexed')
        : row.explorer
          ? t('networksNoIndex')
          : t('networksNoExplorer');
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ t('networksTitle') }}
        </h2>
        <p class="cw-prose">{{ t('networksBody') }}</p>

        <div class="cw-card" style="margin-top: 18px; padding: 14px 16px">
            <div class="cw-label">{{ t('networksOnLabel') }}</div>
            <div class="cw-total" style="margin-top: 8px; font-size: 26px">
                {{ t('networksOnCount', { on: onCount, total: all.length }) }}
            </div>
            <p
                class="cw-prose"
                style="margin-top: 10px; font-size: 11px; line-height: 1.6"
            >
                {{ t('networksCost') }}
            </p>
        </div>

        <input
            v-model="query"
            type="search"
            class="cw-input"
            style="margin-top: 18px"
            :placeholder="t('networksSearch')"
            :aria-label="t('networksSearch')"
        />

        <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px">
            <button
                v-for="option in FILTERS"
                :key="option.id"
                type="button"
                class="cw-ghost"
                :style="
                    filter === option.id
                        ? {
                              borderColor: 'var(--cw-accent)',
                              color: 'var(--cw-accent)',
                          }
                        : undefined
                "
                @click="filter = option.id"
            >
                {{ option.label() }}
            </button>
        </div>

        <!--
          One row per network, and the same row for every one of them. The
          switch is the only thing that differs, and only for Cyberia, which
          does not have one.
        -->
        <div class="cw-stack" style="gap: 8px; margin-top: 12px">
            <div
                v-for="row in rows"
                :key="row.id"
                class="cw-card"
                style="padding: 11px 14px"
            >
                <div style="display: flex; align-items: center; gap: 12px">
                    <NetworkMark :chain="row.id" :mark="row.mark" :size="28" />
                    <button
                        type="button"
                        style="
                            flex: 1;
                            min-width: 0;
                            border: 0;
                            background: none;
                            padding: 0;
                            text-align: left;
                            cursor: pointer;
                        "
                        :disabled="!row.on"
                        @click="row.on && emit('open', row.id)"
                    >
                        <span
                            style="
                                display: block;
                                font: 500 13px/1.2 var(--cw-sans);
                                color: var(--cw-text);
                            "
                            >{{ row.label }}</span
                        >
                        <span
                            style="
                                display: block;
                                margin-top: 2px;
                                font: 400 10px/1.4 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                            >{{ row.symbol
                            }}<template v-if="row.chainId !== null">
                                ·
                                {{
                                    t('networksChainId', { id: row.chainId })
                                }}</template
                            >
                            · {{ capabilityOf(row) }}</span
                        >
                    </button>

                    <span
                        v-if="row.home"
                        class="cw-label"
                        style="flex: none; color: var(--cw-accent)"
                        >{{ t('networksHome') }}</span
                    >
                    <button
                        v-else
                        type="button"
                        class="cw-ghost"
                        :aria-pressed="row.on"
                        :style="
                            row.on
                                ? {
                                      borderColor: 'var(--cw-accent)',
                                      color: 'var(--cw-accent)',
                                  }
                                : undefined
                        "
                        @click="toggle(row)"
                    >
                        {{
                            row.on
                                ? t('networksSwitchOff')
                                : t('networksSwitchOn')
                        }}
                    </button>
                </div>
            </div>
        </div>

        <p v-if="rows.length === 0" class="cw-prose" style="margin-top: 18px">
            {{ t('networksEmpty', { query: query.trim() }) }}
        </p>

        <!-- Added by hand: the same accounts, read through an unvetted host. -->
        <template v-if="custom.length > 0">
            <div class="cw-group" style="margin-top: 26px">
                <span
                    class="cw-label"
                    style="
                        font-size: 9px;
                        letter-spacing: 0.2em;
                        color: var(--cw-meta);
                    "
                    >{{ t('networksCustomHeading') }}</span
                >
            </div>

            <div class="cw-stack" style="gap: 8px; margin-top: 8px">
                <button
                    v-for="network in custom"
                    :key="network.id"
                    type="button"
                    class="cw-card cw-card-button cw-card-custom"
                    @click="emit('open', network.id)"
                >
                    <div style="display: flex; align-items: center; gap: 12px">
                        <NetworkMark :chain="network.id" :size="28" />
                        <span style="flex: 1; min-width: 0; text-align: left">
                            <span
                                style="
                                    display: block;
                                    font: 500 13px/1.2 var(--cw-sans);
                                "
                                >{{ network.name }}</span
                            >
                            <span
                                style="
                                    display: block;
                                    margin-top: 2px;
                                    font: 400 10px/1.4 var(--cw-mono);
                                    color: var(--cw-meta);
                                "
                                >{{ network.symbol }} ·
                                {{ t('endpointUnverified') }}</span
                            >
                        </span>
                        <span
                            style="
                                font: 400 12px/1 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                            >→</span
                        >
                    </div>
                </button>
            </div>
        </template>

        <button
            type="button"
            class="cw-dashed"
            style="margin-top: 18px"
            @click="emit('addNetwork')"
        >
            <span
                style="
                    display: flex;
                    width: 28px;
                    height: 28px;
                    flex: none;
                    align-items: center;
                    justify-content: center;
                    border: 1px dashed var(--cw-border);
                    font: 400 15px/1 var(--cw-mono);
                    color: var(--cw-muted);
                "
                >+</span
            >
            <span style="flex: 1">
                <span
                    style="display: block; font: 500 13px/1.2 var(--cw-sans)"
                    >{{ t('addNetwork') }}</span
                >
                <span
                    style="
                        display: block;
                        margin-top: 2px;
                        font: 400 10px/1.4 var(--cw-mono);
                        color: var(--cw-dim);
                    "
                    >{{ t('addNetworkHint') }}</span
                >
            </span>
            <span style="font: 400 12px/1 var(--cw-mono); color: var(--cw-dim)"
                >→</span
            >
        </button>
    </div>
</template>
