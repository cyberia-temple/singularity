<script setup lang="ts">
import { computed, ref } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { walletChain } from '@/lib/wallet';
import { formatUsdPrice } from '@/lib/wallet/format';
import { coinMarkets, searchMarkets, tokenMarket } from '@/lib/wallet/markets';
import type { Market } from '@/lib/wallet/markets';
import { walletMessages } from '@/lib/walletMessages';

/**
 * What this wallet can chart.
 *
 * The list is the holder's own networks and tokens, not a venue's catalogue. A
 * markets screen that opens on eight thousand pairs is a screen about somebody
 * else's portfolio; this one opens on the eight things they actually have, and
 * the search is there for the ninth.
 *
 * Every row states where its chart would come from, because that is the honest
 * difference between them: an exchange book somebody else keeps, or a price
 * rebuilt here out of this chain's pools. A row with neither says so instead of
 * opening onto an empty frame.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** USD per unit of each network's own coin, or null where unreadable. */
    prices: Record<string, number | null>;
    /** USD per token contract, by chain then lowercased address. */
    tokenPrices: Record<string, Record<string, number>>;
}>();

const emit = defineEmits<{ back: []; open: [market: Market] }>();

const { locale, t } = useLocale(walletMessages);

const query = ref('');

/**
 * The tokens this wallet has actually discovered, in the order the token list
 * already puts them. Nothing is invented: a contract the wallet has never read
 * is a market it cannot price either.
 */
const heldTokens = computed(() =>
    props.wallet.accounts.value.flatMap((account) =>
        (props.wallet.tokens.value[account.chain]?.items ?? []).map(
            (token) => ({
                chain: account.chain,
                address: token.address,
                symbol: token.symbol,
                name: token.name,
            }),
        ),
    ),
);

const rows = computed<Market[]>(() => [
    ...coinMarkets(),
    ...heldTokens.value.map((token) => tokenMarket(token)),
]);

const shown = computed(() => searchMarkets(rows.value, query.value));

/**
 * A charted market with no price to print says nothing rather than zero — the
 * same rule the portfolio total follows, and for the same reason.
 */
const priceOf = (market: Market): number | null => {
    if (market.address) {
        return (
            props.tokenPrices[market.chain]?.[market.address.toLowerCase()] ??
            null
        );
    }

    return props.prices[market.chain] ?? null;
};

const sourceLabel = (market: Market): string => {
    if (market.source === 'exchange') {
        return t('marketExchange');
    }

    if (market.source === 'onchain') {
        return t('marketOnchain');
    }

    return market.note === 'noPool' ? t('marketNoPool') : t('marketNoListing');
};

const networkOf = (market: Market): string => {
    try {
        return walletChain(market.chain).label;
    } catch {
        return '';
    }
};

const charted = (market: Market): boolean => market.source !== 'none';
</script>

<template>
    <div class="cw-stack">
        <div class="cw-row" style="margin-bottom: 14px">
            <button type="button" class="cw-back" @click="emit('back')">
                {{ t('back') }}
            </button>
        </div>

        <h2 class="cw-title">{{ t('markets') }}</h2>
        <p class="cw-label" style="margin: 8px 0 14px">
            {{ t('marketsCount', { count: String(rows.length) }) }}
        </p>

        <input
            v-model="query"
            class="cw-input"
            type="search"
            :placeholder="t('marketsSearch')"
            style="margin-bottom: 14px"
        />

        <div class="cw-stack" style="gap: 6px">
            <button
                v-for="market in shown"
                :key="market.id"
                type="button"
                class="cw-market"
                :disabled="!charted(market)"
                :style="charted(market) ? undefined : { cursor: 'default' }"
                @click="charted(market) && emit('open', market)"
            >
                <NetworkMark :chain="market.chain" :size="24" />

                <span class="cw-market-body">
                    <span class="cw-market-name">
                        {{ market.symbol }} / {{ market.quote }}
                        <!--
                          The network, because two of these rows are the same
                          asset: ether is what both Base and Robinhood settle
                          in, and without the name they read as a duplicate
                          rather than as two places you hold it.
                        -->
                        <span class="cw-market-on">{{
                            networkOf(market)
                        }}</span>
                    </span>
                    <span class="cw-label" style="letter-spacing: 0.1em">{{
                        sourceLabel(market)
                    }}</span>
                </span>

                <span class="cw-market-side">
                    <span class="cw-num">{{
                        priceOf(market) === null
                            ? '—'
                            : formatUsdPrice(priceOf(market)!, locale)
                    }}</span>
                    <span
                        v-if="charted(market)"
                        class="cw-label"
                        style="color: var(--cw-fainter)"
                        >›</span
                    >
                </span>
            </button>
        </div>

        <p v-if="shown.length === 0" class="cw-note" style="margin-top: 14px">
            <span>{{ t('marketsNone') }}</span>
        </p>
    </div>
</template>
