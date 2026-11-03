<script setup lang="ts">
import { computed, ref } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import StockIcon from '@/components/wallet/StockIcon.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import type { WalletChainId } from '@/lib/wallet';
import { formatUsd } from '@/lib/wallet/format';
import { holdings, matchesHolding } from '@/lib/wallet/holdings';
import type { Holding } from '@/lib/wallet/holdings';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Choose what to send: every coin and token this wallet can send, on every
 * network, most valuable first, with search.
 *
 * It replaces two rows of segmented buttons — networks, then every ticker on
 * the chosen network — which on a wallet holding a few hundred airdrops was a
 * wall of "T101 T102 T103". A network is chosen by choosing something on it;
 * each network's own coin is listed even at zero, so a network stays
 * reachable before anything has arrived there.
 */

const props = defineProps<{
    wallet: MultiWallet;
    prices: Record<string, number | null>;
    /** Chain id → (lowercased contract → USD price). */
    tokenPrices: Record<string, Record<string, number>>;
    /** The row that is chosen now. */
    selected: { chain: WalletChainId; address: string | null };
}>();

const emit = defineEmits<{
    pick: [row: Holding];
    close: [];
    addNetwork: [];
}>();

const { locale, t } = useLocale(walletMessages);

const query = ref('');

const sendable = computed(() =>
    props.wallet.accounts.value.filter((account) => account.capabilities.send),
);

const rows = computed(
    () =>
        holdings(
            {
                accounts: sendable.value,
                balances: Object.fromEntries(
                    sendable.value.map((account) => [
                        account.chain,
                        props.wallet.balances.value[account.chain]?.value ??
                            null,
                    ]),
                ),
                tokens: Object.fromEntries(
                    sendable.value.map((account) => [
                        account.chain,
                        props.wallet.tokens.value[account.chain]?.items ?? [],
                    ]),
                ),
                prices: props.prices,
                tokenPrices: props.tokenPrices,
            },
            { emptyCoins: true, unverified: true },
        ).rows,
);

const shown = computed(() =>
    rows.value.filter((row) => matchesHolding(row, query.value)),
);

const isSelected = (row: Holding): boolean =>
    row.chain === props.selected.chain &&
    (row.token?.address ?? null) === props.selected.address;

const networkOf = (chain: WalletChainId): string =>
    props.wallet.accounts.value.find((account) => account.chain === chain)
        ?.label ?? chain;

const TAG_LABEL = {
    bridged: 'provBridged',
    wrapped: 'provWrapped',
    partner: 'provPartner',
    unverified: 'provUnverified',
} as const;
</script>

<template>
    <div class="cw-stack">
        <div class="cw-row" style="margin-bottom: 16px">
            <button type="button" class="cw-back" @click="emit('close')">
                ← {{ t('back') }}
            </button>
            <span style="font: 600 15px/1 var(--cw-sans)">{{
                t('sendPickTitle')
            }}</span>
            <span style="width: 44px"></span>
        </div>

        <input
            v-model="query"
            type="search"
            class="cw-input"
            :placeholder="t('sendPickSearch')"
            :aria-label="t('sendPickSearch')"
            autocomplete="off"
            style="margin-bottom: 12px"
        />

        <div class="cw-stack" style="gap: 4px">
            <button
                v-for="row in shown"
                :key="row.key"
                type="button"
                class="cw-asset"
                :aria-pressed="isSelected(row)"
                @click="emit('pick', row)"
            >
                <StockIcon
                    v-if="row.logo"
                    :symbol="row.symbol"
                    :src="row.logo"
                    :size="40"
                />
                <NetworkMark v-else :chain="row.chain" />
                <span style="flex: 1; min-width: 0; text-align: left">
                    <span class="cw-asset-name">{{ row.symbol }}</span>
                    <span class="cw-asset-sub"
                        >{{ networkOf(row.chain) }}
                        <span v-if="row.tag" class="cw-prov">{{
                            t(TAG_LABEL[row.tag])
                        }}</span></span
                    >
                </span>
                <span style="flex: none; text-align: right">
                    <span class="cw-asset-usd" style="display: block">{{
                        row.amount
                    }}</span>
                    <span class="cw-asset-sub" style="justify-content: end">{{
                        row.usd === null ? '' : formatUsd(row.usd, locale)
                    }}</span>
                </span>
            </button>
        </div>

        <p v-if="shown.length === 0" class="cw-prose" style="margin-top: 12px">
            {{ t('sendPickNone') }}
        </p>

        <button
            type="button"
            class="cw-ghost"
            style="align-self: flex-start; margin-top: 16px"
            @click="emit('addNetwork')"
        >
            + {{ t('addNetwork') }}
        </button>
    </div>
</template>
