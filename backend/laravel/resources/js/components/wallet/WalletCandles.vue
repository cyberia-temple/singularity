<script setup lang="ts">
import {
    CandlestickSeries,
    ColorType,
    CrosshairMode,
    HistogramSeries,
    PriceScaleMode,
    createChart,
} from 'lightweight-charts';
import type {
    IChartApi,
    ISeriesApi,
    MouseEventParams,
} from 'lightweight-charts';
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { formatNum, formatPrice } from '@/lib/dexFormat';
import type { MarketCandle } from '@/lib/marketCandles';

/**
 * Candles for a market that exists only in this chain's pools.
 *
 * The renderer is the same library the site's `/swap` chart uses and the data
 * is the same replay of `Sync` events — what is different here is that the
 * wallet has two palettes, and a chart is the one element on the surface that
 * paints itself with a canvas rather than with CSS. So every colour it uses is
 * read off the wallet's own tokens at mount and re-read when the theme moves;
 * hardcoding a slate axis would have left the light theme with grey-on-white
 * gridlines nobody can see.
 *
 * Up and down keep their own pair rather than borrowing the wallet's ok/bad
 * colours. Green and red here are not states — they are the two halves of one
 * reading, and the wallet's red means "this failed".
 */

const props = defineProps<{
    candles: MarketCandle[];
    baseSymbol: string;
    quoteSymbol: string;
    /** Which palette to paint with; follows the wallet's theme. */
    scheme: 'light' | 'dark';
}>();

const UP = { dark: '#26a69a', light: '#0f8f7e' };
const DOWN = { dark: '#ef5350', light: '#d13c3c' };

const host = ref<HTMLDivElement | null>(null);

type Legend = {
    when: string;
    open: string;
    high: string;
    low: string;
    close: string;
    changePct: string;
    volume: string;
    up: boolean;
};

const legend = ref<Legend | null>(null);

let chart: IChartApi | null = null;
let candleSeries: ISeriesApi<'Candlestick'> | null = null;
let volumeSeries: ISeriesApi<'Histogram'> | null = null;

/**
 * The wallet's tokens, resolved to real colours. `getComputedStyle` and not the
 * literal values, so this component never holds a second copy of the palette
 * that can drift from `wallet.css`.
 */
const token = (name: string, fallback: string): string => {
    if (!host.value) {
        return fallback;
    }

    const value = getComputedStyle(host.value).getPropertyValue(name).trim();

    return value === '' ? fallback : value;
};

const chartOptions = () => ({
    layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: token('--cw-dim', '#5a636c'),
        fontSize: 10,
        fontFamily: token('--cw-mono', 'monospace'),
    },
    grid: {
        vertLines: { color: token('--cw-line', '#14181c') },
        horzLines: { color: token('--cw-line', '#14181c') },
    },
    rightPriceScale: { borderColor: token('--cw-hairline', '#16191d') },
    timeScale: { borderColor: token('--cw-hairline', '#16191d') },
});

const seriesColours = () => {
    const up = UP[props.scheme];
    const down = DOWN[props.scheme];

    return { up, down };
};

const legendFrom = (candle: MarketCandle): Legend => {
    const pct =
        candle.open > 0
            ? ((candle.close - candle.open) / candle.open) * 100
            : 0;

    return {
        when: new Date(candle.time * 1000).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        }),
        open: formatPrice(candle.open),
        high: formatPrice(candle.high),
        low: formatPrice(candle.low),
        close: formatPrice(candle.close),
        changePct: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`,
        volume: `${formatNum(candle.volume)} ${props.baseSymbol}`,
        up: candle.close >= candle.open,
    };
};

const applyData = (): void => {
    if (!chart || !candleSeries || !volumeSeries) {
        return;
    }

    const { up, down } = seriesColours();

    candleSeries.setData(
        props.candles.map(({ time, open, high, low, close }) => ({
            time,
            open,
            high,
            low,
            close,
        })),
    );
    volumeSeries.setData(
        props.candles.map((candle) => ({
            time: candle.time,
            value: candle.volume,
            color: candle.close >= candle.open ? `${up}66` : `${down}66`,
        })),
    );

    // `fitContent()` puts the first and last bars flush against the frame,
    // which slices them in half; widen by a bar on each side.
    const timeScale = chart.timeScale();

    timeScale.fitContent();

    const visible = timeScale.getVisibleLogicalRange();

    if (visible) {
        timeScale.setVisibleLogicalRange({
            from: visible.from - 1,
            to: visible.to + 1,
        });
    }

    const last = props.candles[props.candles.length - 1];

    legend.value = last ? legendFrom(last) : null;
};

const applyTheme = (): void => {
    if (!chart || !candleSeries) {
        return;
    }

    const { up, down } = seriesColours();

    chart.applyOptions(chartOptions());
    candleSeries.applyOptions({
        upColor: up,
        downColor: down,
        wickUpColor: up,
        wickDownColor: down,
    });
    applyData();
};

const onCrosshairMove = (param: MouseEventParams): void => {
    const hovered =
        param.time === undefined
            ? undefined
            : props.candles.find((candle) => candle.time === param.time);
    const target = hovered ?? props.candles[props.candles.length - 1];

    legend.value = target ? legendFrom(target) : null;
};

onMounted(() => {
    if (!host.value) {
        return;
    }

    const { up, down } = seriesColours();

    chart = createChart(host.value, {
        autoSize: true,
        ...chartOptions(),
        crosshair: { mode: CrosshairMode.Normal },
        rightPriceScale: {
            ...chartOptions().rightPriceScale,
            /*
             * Logarithmic, because these markets are thin enough to move by
             * multiples in a month and a linear scale flattens everything
             * before the last leg into a single line at the bottom.
             */
            mode: PriceScaleMode.Logarithmic,
            scaleMargins: { top: 0.1, bottom: 0.24 },
        },
        timeScale: {
            ...chartOptions().timeScale,
            timeVisible: true,
            secondsVisible: false,
        },
        localization: {
            priceFormatter: (price: number): string => formatPrice(price),
        },
    });

    candleSeries = chart.addSeries(CandlestickSeries, {
        upColor: up,
        downColor: down,
        wickUpColor: up,
        wickDownColor: down,
        borderVisible: false,
        priceFormat: {
            type: 'custom',
            formatter: (price: number): string => formatPrice(price),
            minMove: 1e-12,
        },
    });

    volumeSeries = chart.addSeries(HistogramSeries, {
        priceScaleId: 'volume',
        priceFormat: { type: 'volume' },
        priceLineVisible: false,
        lastValueVisible: false,
    });
    chart.priceScale('volume').applyOptions({
        visible: false,
        scaleMargins: { top: 0.82, bottom: 0 },
    });

    chart.subscribeCrosshairMove(onCrosshairMove);
    applyData();
});

watch(() => props.candles, applyData);
watch(() => props.scheme, applyTheme);

onBeforeUnmount(() => {
    chart?.remove();
    chart = null;
    candleSeries = null;
    volumeSeries = null;
});
</script>

<template>
    <div class="cw-chart">
        <!--
          The read-out sits above the canvas rather than floating over it: as an
          overlay it covered the top-left candles on exactly the markets that
          open high.
        -->
        <div
            v-if="legend"
            class="cw-chart-ohlc"
            :class="legend.up ? 'cw-chart-up' : 'cw-chart-down'"
        >
            <span class="cw-chart-when">{{ legend.when }}</span>
            <span
                >O <b>{{ legend.open }}</b></span
            >
            <span
                >H <b>{{ legend.high }}</b></span
            >
            <span
                >L <b>{{ legend.low }}</b></span
            >
            <span
                >C <b>{{ legend.close }}</b></span
            >
            <span class="cw-chart-pct">{{ legend.changePct }}</span>
            <span class="cw-chart-when">{{ legend.volume }}</span>
        </div>
        <div
            ref="host"
            class="cw-chart-host"
            role="img"
            :aria-label="`${baseSymbol}/${quoteSymbol}`"
        ></div>
    </div>
</template>
