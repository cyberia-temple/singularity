<script setup lang="ts">
import { Head } from '@inertiajs/vue3';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { changeColor, squarify } from '@/lib/treemap';
import type { Placed, Rect } from '@/lib/treemap';

type Tile = {
    symbol: string;
    name: string | null;
    address: string;
    marketCap: number;
    change: number | null;
    url: string;
};

type Sector = { key: string; label: string; tiles: Tile[] };

type MarketMap = {
    generatedAt: string | null;
    sectors: Sector[];
    unpriced?: number;
    cyberUsd?: number | null;
};

const props = defineProps<{ crypto: MarketMap; cyberia: MarketMap }>();

const market = ref<'crypto' | 'cyberia'>('crypto');
const sizing = ref<'cap' | 'equal'>('cap');
const box = ref<HTMLElement | null>(null);
const width = ref(0);
const height = ref(0);

const current = computed(() =>
    market.value === 'crypto' ? props.crypto : props.cyberia,
);

const HEADER = 18;

const size = (tile: Tile): number =>
    sizing.value === 'cap' ? tile.marketCap : 1;

const layout = computed(() => {
    const rect: Rect = { x: 0, y: 0, w: width.value, h: height.value };
    const sectors = squarify(
        current.value.sectors,
        (sector) => sector.tiles.reduce((sum, tile) => sum + size(tile), 0),
        rect,
    );

    return sectors.map((placed) => {
        const header = placed.h > 60 && placed.w > 60 ? HEADER : 0;
        const inner: Rect = {
            x: placed.x,
            y: placed.y + header,
            w: placed.w,
            h: placed.h - header,
        };

        return {
            sector: placed,
            header,
            tiles: squarify(placed.item.tiles, size, inner),
        };
    });
});

const compactUsd = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
});

const pct = (change: number | null): string =>
    change === null ? '—' : `${change > 0 ? '+' : ''}${change.toFixed(2)}%`;

const fontSize = (tile: Placed<Tile>): number =>
    Math.max(9, Math.min(28, Math.sqrt(tile.w * tile.h) / 6));

const tooltip = (tile: Tile): string =>
    `${tile.name ?? tile.symbol} (${tile.symbol})\n${sizing.value === 'cap' || market.value === 'crypto' ? `Market cap: ${compactUsd.format(tile.marketCap)}\n` : ''}24h: ${pct(tile.change)}`;

const updated = computed(() =>
    current.value.generatedAt
        ? new Date(current.value.generatedAt).toLocaleString()
        : null,
);

let observer: ResizeObserver | null = null;

const measure = (): void => {
    const w = box.value?.clientWidth ?? 0;

    width.value = w;
    height.value =
        w < 640
            ? Math.round(w * 1.6)
            : Math.max(480, Math.round(window.innerHeight * 0.75));
};

onMounted(() => {
    measure();
    observer = new ResizeObserver(measure);

    if (box.value) {
        observer.observe(box.value);
    }
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
    <Head title="Heatmap" />

    <div class="mx-auto max-w-[1600px] space-y-3 p-3 sm:p-6">
        <div class="flex flex-wrap items-center gap-2">
            <h1 class="mr-2 text-xl font-semibold">Heatmap</h1>
            <div
                class="flex overflow-hidden rounded border border-border text-sm"
            >
                <button
                    v-for="option in [
                        { key: 'crypto', label: 'Crypto market' },
                        { key: 'cyberia', label: 'Cyberia' },
                    ] as const"
                    :key="option.key"
                    type="button"
                    class="px-3 py-1.5"
                    :class="
                        market === option.key
                            ? 'bg-primary text-primary-foreground'
                            : 'hover:bg-muted'
                    "
                    @click="market = option.key"
                >
                    {{ option.label }}
                </button>
            </div>
            <select
                v-model="sizing"
                class="rounded border border-border bg-background px-2 py-1.5 text-sm"
            >
                <option value="cap">Size: market cap</option>
                <option value="equal">Size: equal</option>
            </select>
            <div
                class="ml-auto flex items-center gap-1 text-xs text-muted-foreground"
            >
                <span>−3%</span>
                <span
                    v-for="step in [-3, -2, -1, 0, 1, 2, 3]"
                    :key="step"
                    class="h-3 w-5 rounded-sm"
                    :style="{ background: changeColor(step) }"
                />
                <span>+3%</span>
                <span
                    class="ml-2 h-3 w-5 rounded-sm"
                    :style="{ background: changeColor(null) }"
                />
                <span>no 24h data</span>
            </div>
        </div>

        <p class="text-xs text-muted-foreground">
            <template v-if="market === 'crypto'">
                Top coins by market cap from CoinGecko, grouped by its
                categories; stablecoins and wrapped or staked coins are left
                out. Colour is the 24h change in USD.
            </template>
            <template v-else>
                Every token on Cyberia's two launchpads, priced from its own
                pool; CYBER.sol and LAIN from DexScreener. Launch tokens move
                against CYBER; the change appears once a day of snapshots
                exists.
                <template v-if="cyberia.unpriced">
                    {{ cyberia.unpriced }} tokens without a readable pool are
                    not drawn.
                </template>
            </template>
            <template v-if="updated"> Updated {{ updated }}.</template>
        </p>

        <div
            ref="box"
            class="relative w-full overflow-hidden rounded bg-[rgb(24,27,33)]"
            :style="{ height: `${height}px` }"
        >
            <div
                v-if="!current.sectors.length"
                class="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-neutral-400"
            >
                The map has not been collected yet — it refreshes every ten
                minutes.
            </div>

            <template v-for="block in layout" :key="block.sector.item.key">
                <div
                    v-if="block.header"
                    class="absolute truncate px-1 text-center text-[11px] leading-[18px] text-neutral-300"
                    :style="{
                        left: `${block.sector.x}px`,
                        top: `${block.sector.y}px`,
                        width: `${block.sector.w}px`,
                    }"
                >
                    {{ block.sector.item.label }}
                </div>
                <a
                    v-for="tile in block.tiles"
                    :key="tile.item.address"
                    :href="tile.item.url"
                    :target="
                        tile.item.url.startsWith('/') ? undefined : '_blank'
                    "
                    rel="noopener"
                    :title="tooltip(tile.item)"
                    class="absolute flex flex-col items-center justify-center overflow-hidden border border-[rgb(24,27,33)] text-center leading-tight text-white transition hover:brightness-125"
                    :style="{
                        left: `${tile.x}px`,
                        top: `${tile.y}px`,
                        width: `${tile.w}px`,
                        height: `${tile.h}px`,
                        background: changeColor(tile.item.change),
                        fontSize: `${fontSize(tile)}px`,
                    }"
                >
                    <span
                        v-if="tile.w > 26 && tile.h > 14"
                        class="max-w-full truncate px-0.5 font-medium"
                    >
                        {{ tile.item.symbol }}
                    </span>
                    <span
                        v-if="tile.w > 40 && tile.h > 34"
                        class="text-[0.75em] opacity-85"
                    >
                        {{ pct(tile.item.change) }}
                    </span>
                </a>
            </template>
        </div>
    </div>
</template>
