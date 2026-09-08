<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import WalletCandles from '@/components/wallet/WalletCandles.vue';
import { useLocale } from '@/composables/useLocale';
import { liquidityChainById } from '@/lib/liquidityChains';
import type { LiquidityChainConfig } from '@/lib/liquidityChains';
import {
    MARKET_RANGES,
    autoRangeKey,
    buildCandles,
    marketRange,
} from '@/lib/marketCandles';
import type { MarketCandle, MarketHistory } from '@/lib/marketCandles';
import { formatUsdPrice } from '@/lib/wallet/format';
import {
    loadRouteHistory,
    resolveMarketRoute,
    routeSpot,
} from '@/lib/wallet/marketHistory';
import type { MarketRoute } from '@/lib/wallet/marketHistory';
import {
    exchangeChartLocale,
    exchangeChartUrl,
    marketChainId,
} from '@/lib/wallet/markets';
import type { Market } from '@/lib/wallet/markets';
import { walletMessages } from '@/lib/walletMessages';

/**
 * One market's price history.
 *
 * Which chart you get is decided by what actually exists, never by preference.
 * An asset with an exchange listing gets TradingView's own widget — a real book
 * with real depth, drawn by people whose whole product that is. An asset that
 * trades only in this chain's pools gets candles rebuilt from those pools,
 * because there is no book to draw and a wallet that showed an empty
 * TradingView frame for CYBER would be claiming the market does not exist.
 *
 * TradingView arrives as an `iframe` on TradingView's origin and never as their
 * script tag. Their loader executes in the embedding page, and this page holds
 * a decrypted seed in memory and a vault in this origin's localStorage; no
 * chart is worth handing a third party that reach. In a frame the same widget
 * is another origin and can touch none of it.
 */

const props = defineProps<{
    market: Market;
    /** The wallet's palette, so both kinds of chart match the surface. */
    scheme: 'light' | 'dark';
    /** USD spot for the header, from the prices the wallet already holds. */
    price: number | null;
    rpcUrl?: string;
}>();

const emit = defineEmits<{ back: []; swap: [market: Market] }>();

const { locale, t } = useLocale(walletMessages);

/* --------------------------------------------------------- exchange --- */

const frameUrl = computed(() =>
    props.market.tvSymbol
        ? exchangeChartUrl(props.market.tvSymbol, {
              theme: props.scheme,
              locale: exchangeChartLocale(locale.value),
          })
        : null,
);

/* ---------------------------------------------------------- on chain --- */

const route = ref<MarketRoute | null>(null);
const history = ref<MarketHistory | null>(null);
const loading = ref(false);
const failed = ref(false);
const rangeKey = ref('7D');

/*
 * Settled once per market — automatically on the first load, or by the reader —
 * and then left alone, so nothing reframes the chart under them.
 */
const rangePinned = ref(false);

const pickRange = (key: string): void => {
    rangePinned.value = true;
    rangeKey.value = key;
};

/*
 * The right edge of the chart. Moved when the data moves and not on a timer, so
 * a quiet market re-renders nothing and never creeps sideways under a reader.
 */
const nowSec = ref(Math.floor(Date.now() / 1000));

let inFlight: AbortController | null = null;

const config = computed<LiquidityChainConfig | null>(() => {
    const chainId = marketChainId(props.market);

    return chainId === null ? null : (liquidityChainById(chainId) ?? null);
});

/**
 * What the market is priced against — the chain's own dollar, named in the
 * registry rather than taken from the hub list. The first hub on Cyberia is
 * WCYBER, so reading the quote from there priced the coin against itself and
 * reported that no pool connected it to the dollar.
 */
const quoteToken = computed<string | null>(() => config.value?.dollar ?? null);

const baseToken = computed<string | null>(() => {
    const chain = config.value;

    if (!chain) {
        return null;
    }

    // The network's own coin trades as its wrapper; there is no pool for a coin.
    return props.market.address ?? chain.wrappedNative;
});

const load = async (): Promise<void> => {
    const chain = config.value;
    const base = baseToken.value;
    const quote = quoteToken.value;

    if (!chain || !base || !quote) {
        return;
    }

    inFlight?.abort();

    const controller = new AbortController();

    inFlight = controller;
    loading.value = true;
    failed.value = false;

    try {
        const resolved = await resolveMarketRoute(
            chain,
            base,
            quote,
            props.rpcUrl,
        );

        if (controller.signal.aborted) {
            return;
        }

        route.value = resolved;

        if (!resolved) {
            failed.value = true;

            return;
        }

        const loaded = await loadRouteHistory(
            chain,
            resolved.hops,
            controller.signal,
        );

        if (controller.signal.aborted) {
            return;
        }

        history.value = loaded;
        nowSec.value = Math.floor(Date.now() / 1000);
        failed.value = loaded.observations.length === 0;

        /*
         * Open on a window that has something in it. These pools can go a week
         * without a trade, and a fixed 7D default drew a flat line at one
         * price with a 0.00% change — a picture of a dead market rather than of
         * a quiet one. Only until the reader picks a range themselves.
         */
        if (!rangePinned.value && loaded.observations.length > 0) {
            rangeKey.value = autoRangeKey(loaded, nowSec.value);
        }
    } catch {
        if (!controller.signal.aborted) {
            failed.value = true;
        }
    } finally {
        if (!controller.signal.aborted) {
            loading.value = false;
        }
    }
};

watch(
    () => props.market.id,
    () => {
        route.value = null;
        history.value = null;
        rangePinned.value = false;

        if (props.market.source === 'onchain') {
            void load();
        }
    },
    { immediate: true },
);

onBeforeUnmount(() => inFlight?.abort());

const spot = computed(() =>
    route.value ? routeSpot(route.value.hops, route.value.reserves) : null,
);

const candles = computed<MarketCandle[]>(() => {
    const loaded = history.value;

    if (!loaded || loaded.observations.length === 0) {
        return [];
    }

    const range = marketRange(rangeKey.value);
    const toSec = nowSec.value;

    return buildCandles(loaded, {
        fromSec:
            range.windowSec === null
                ? loaded.observations[0].ts
                : toSec - range.windowSec,
        toSec,
        bucketSec: range.bucketSec,
        spot: spot.value,
    });
});

/**
 * Change over the drawn window, and only over the drawn window. It is computed
 * from the candles on screen rather than from a fixed 24h, so the number and
 * the picture can never disagree about the period they describe.
 */
const changePct = computed(() => {
    const points = candles.value;

    if (points.length < 2) {
        return null;
    }

    const first = points[0].open;

    return first > 0
        ? ((points[points.length - 1].close - first) / first) * 100
        : null;
});

/**
 * The price above the chart is the price *in* the chart, never a second
 * opinion beside it.
 *
 * On an on-chain market the two are different numbers and always will be: the
 * wallet's USD quote for CYBER comes from the CYBER.sol feed on Solana, while
 * this chart is the routed WCYBER/USDC rate on Cyberia, and they have been
 * three orders of magnitude apart. Printing the feed over the pool's own
 * candles put two prices for one asset on one screen with nothing saying which
 * was which — so the routed spot wins here, and the feed keeps the portfolio.
 *
 * On an exchange market there is no such conflict: TradingView draws its own
 * book and the wallet's quote is the same asset from the same kind of venue.
 */
const headline = computed(() => {
    const shown =
        props.market.source === 'onchain'
            ? (spot.value ?? props.price)
            : (props.price ?? spot.value);

    return shown === null ? '—' : formatUsdPrice(shown, locale.value);
});

const routeSymbols = computed(() =>
    route.value === null || route.value.hops.length <= 1
        ? null
        : `${route.value.hops.length} ${t('marketHops')}`,
);
</script>

<template>
    <div class="cw-stack">
        <div class="cw-row" style="margin-bottom: 14px">
            <button type="button" class="cw-back" @click="emit('back')">
                {{ t('back') }}
            </button>
        </div>

        <div style="display: flex; align-items: center; gap: 12px">
            <NetworkMark :chain="market.chain" :size="28" />
            <div style="flex: 1; min-width: 0">
                <h2 class="cw-title" style="margin: 0">
                    {{ market.symbol }} / {{ market.quote }}
                </h2>
                <p class="cw-label" style="margin-top: 6px">
                    {{
                        market.source === 'exchange'
                            ? t('marketExchange')
                            : t('marketOnchain')
                    }}
                    <template v-if="routeSymbols">
                        · {{ routeSymbols }}</template
                    >
                </p>
            </div>
        </div>

        <div
            style="
                display: flex;
                align-items: baseline;
                gap: 12px;
                margin: 16px 0 12px;
            "
        >
            <span class="cw-total" style="font-size: 28px">{{ headline }}</span>
            <span
                v-if="changePct !== null"
                class="cw-num"
                :style="{
                    color:
                        changePct >= 0 ? 'var(--cw-ok)' : 'var(--cw-bad-soft)',
                }"
                >{{ changePct >= 0 ? '+' : ''
                }}{{ changePct.toFixed(2) }}%</span
            >
        </div>

        <!--
          Exchange book, in a frame on TradingView's own origin.

          The link under it is not a nicety. A cross-origin frame cannot be
          inspected from here, so a widget that loads its scripts and then
          paints nothing — which is what their free embed does for a referrer it
          does not like — is indistinguishable from one still loading, and there
          is no event to hang a fallback on. The way out is stated instead of
          detected.
        -->
        <iframe
            v-if="market.source === 'exchange' && frameUrl"
            :key="frameUrl"
            class="cw-chart-frame"
            :src="frameUrl"
            :title="`${market.symbol} / ${market.quote}`"
            loading="lazy"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        ></iframe>

        <a
            v-if="market.source === 'exchange' && market.tvSymbol"
            class="cw-back"
            style="margin-top: 8px; text-decoration: none"
            :href="`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(market.tvSymbol)}`"
            target="_blank"
            rel="noopener noreferrer"
        >
            {{ t('marketOpenOnTv') }}
        </a>

        <!-- Rebuilt from this chain's own pools. -->
        <template v-else-if="market.source === 'onchain'">
            <div
                style="display: flex; gap: 3px; margin-bottom: 8px"
                role="group"
            >
                <button
                    v-for="range in MARKET_RANGES"
                    :key="range.key"
                    type="button"
                    class="cw-tf"
                    :aria-pressed="rangeKey === range.key"
                    @click="pickRange(range.key)"
                >
                    {{ range.label }}
                </button>
            </div>

            <p v-if="loading && candles.length === 0" class="cw-note">
                <span>{{ t('marketLoading') }}</span>
            </p>

            <!--
              A market whose pools this browser could not read says which of the
              two it was — no route at all, or a route with no trades yet — and
              offers the retry. A flat line would be a claim about the price.
            -->
            <p v-else-if="failed" class="cw-note cw-note-warn">
                <span style="flex: 1">{{
                    route === null ? t('marketNoRoute') : t('marketNoTrades')
                }}</span>
                <button type="button" class="cw-back" @click="load()">
                    {{ t('retry') }}
                </button>
            </p>

            <WalletCandles
                v-else-if="candles.length > 0"
                :candles="candles"
                :base-symbol="market.symbol"
                :quote-symbol="market.quote"
                :scheme="scheme"
            />
        </template>

        <p v-else class="cw-note">
            <span>{{ t('marketNoListing') }}</span>
        </p>

        <button
            type="button"
            class="cw-btn cw-btn-primary"
            style="margin-top: 16px"
            @click="emit('swap', market)"
        >
            {{ t('marketTrade', { symbol: market.symbol }) }}
        </button>
    </div>
</template>
