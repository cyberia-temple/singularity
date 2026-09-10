<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { dexScreenerChartUrl } from '@/lib/wallet/dexscreener';
import type { DexMarket } from '@/lib/wallet/dexscreener';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The price history of a pool somebody else indexes.
 *
 * This wallet already draws two kinds of chart and neither of them can draw
 * this one. `WalletChart.vue` gives an exchange-listed asset TradingView's
 * widget, and gives an asset trading in Cyberia's own pools candles rebuilt
 * from those pools' `Sync` logs — which works because this project runs that
 * exchange and can read its events. A token on Solana or BNB has neither: no
 * listing to draw a book from, and no indexer here watching its pool. So the
 * screen offered a name, a ticker and a price, and nothing about where that
 * price had been, at the exact moment somebody is deciding whether to buy it.
 *
 * The venue that does index those pools draws it, in a frame on its own
 * origin. That shape is the whole security argument and it is not negotiable:
 * this page holds a decrypted seed in memory and a vault in this origin's
 * localStorage, so a third party's script tag would run inside all of it,
 * while a frame is another origin and can reach none of it. Same reasoning
 * `WalletChart.vue` states for TradingView, same sandbox.
 *
 * **It does not load until it is asked for.** A frame is a whole page of
 * somebody else's JavaScript, and mounting one under a list that re-renders on
 * every keystroke would load a dozen of them while a person is still typing a
 * ticker. So the chart is a button until it is opened, and closing it takes
 * the frame back out.
 */

const props = defineProps<{
    market: DexMarket;
    /** The wallet's palette, so the frame does not flash white in the dark. */
    scheme: 'light' | 'dark';
}>();

const { t } = useLocale(walletMessages);

const open = ref(false);

const url = computed(() =>
    dexScreenerChartUrl(props.market, { theme: props.scheme }),
);

/*
 * A chart belongs to one pool. Left open across a change of token it would go
 * on showing the previous one for as long as the frame took to reload, which
 * is the one thing a price chart must never do — so the frame is dropped and
 * re-opened by key, and a token with no pool closes it entirely.
 */
watch(
    () => props.market.pairAddress,
    () => {
        open.value = false;
    },
);
</script>

<template>
    <div v-if="url" style="margin-top: 10px">
        <button
            type="button"
            class="cw-back"
            style="text-decoration: none"
            @click="open = !open"
        >
            {{ open ? t('chartHide') : t('chartShow') }}
        </button>

        <template v-if="open">
            <iframe
                :key="url"
                class="cw-chart-frame"
                style="margin-top: 8px"
                :src="url"
                :title="`${market.symbol} · ${market.dex ?? ''}`"
                loading="lazy"
                sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            ></iframe>

            <!--
              Whose chart this is. The wallet is drawing somebody else's index
              of somebody else's pools, and a chart with no attribution reads
              as a number this project stands behind.
            -->
            <p class="cw-rowdata" style="margin-top: 6px">
                {{ t('chartSource', { dex: market.dex ?? '—' }) }}
            </p>
        </template>
    </div>
</template>
