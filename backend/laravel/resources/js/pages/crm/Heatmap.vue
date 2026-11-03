<script setup lang="ts">
import { Head, Link, router } from '@inertiajs/vue3';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { num } from '@/lib/console';
import { consoleMessages } from '@/lib/consoleMessages';
import { pageSnapshot } from '@/lib/replay';
import type { ReplayEvent } from '@/lib/replay';
import 'rrweb/dist/style.css';

type Point = {
    x: number;
    y: number;
    fixed: boolean | number;
    rage: boolean | number;
    dead: boolean | number;
};

type Filters = {
    site: string | null;
    path: string | null;
    device: string;
    days: number;
};

const props = defineProps<{
    filters: Filters;
    sites: string[];
    paths: { path: string; clicks: number }[];
    devices: Record<string, number>;
    points: Point[];
    targets: { target: string; clicks: number; rage: number; dead: number }[];
    snapshot: {
        session: string;
        seq: number;
        at_ms: number;
        width: number;
    } | null;
}>();

const { t } = useLocale(consoleMessages);

const frame = ref<HTMLDivElement | null>(null);
const page = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);
const drawn = ref(false);
const height = ref(600);

type Replayer = {
    pause(offset?: number): void;
    destroy(): void;
    iframe: HTMLIFrameElement;
    wrapper: HTMLElement;
};

let replayer: Replayer | null = null;

const DEVICE_WIDTH: Record<string, number> = {
    phone: 390,
    tablet: 820,
    desktop: 1440,
};

function filter(change: Partial<Filters>): void {
    const next = { ...props.filters, ...change };
    const query = Object.fromEntries(
        Object.entries(next).filter(
            ([, value]) => value !== null && value !== '',
        ),
    );

    router.get('/crm/replays/heatmap', query as Record<string, string>, {
        preserveScroll: true,
    });
}

/**
 * The points, over whatever the page underneath turned out to be. Positions
 * are the visitor's own: across as a share of the page's width, down in
 * pixels of a page drawn at the snapshot's width — which is why the heat map
 * is per device, since a phone and a desktop put the same button in two
 * different places.
 */
function paint(width: number, scale: number, pageHeight: number): void {
    const board = canvas.value;

    if (!board || !frame.value) {
        return;
    }

    const shown = frame.value.clientWidth;
    board.width = shown;
    board.height = Math.max(1, Math.round(pageHeight * scale));
    height.value = board.height;
    const context = board.getContext('2d');

    if (!context) {
        return;
    }

    context.clearRect(0, 0, board.width, board.height);

    for (const point of props.points) {
        const x = point.x * width * scale;
        const y = point.y * scale;
        const glow = context.createRadialGradient(x, y, 0, x, y, 18);
        glow.addColorStop(0, 'rgba(255, 60, 60, 0.32)');
        glow.addColorStop(1, 'rgba(255, 60, 60, 0)');
        context.fillStyle = glow;
        context.beginPath();
        context.arc(x, y, 18, 0, Math.PI * 2);
        context.fill();
    }

    for (const point of props.points) {
        if (!point.rage && !point.dead) {
            continue;
        }

        context.strokeStyle = point.rage ? '#e0a516' : '#9a9ab0';
        context.lineWidth = 2;
        context.beginPath();
        context.arc(
            point.x * width * scale,
            point.y * scale,
            7,
            0,
            Math.PI * 2,
        );
        context.stroke();
    }
}

async function draw(): Promise<void> {
    replayer?.destroy();
    replayer = null;
    drawn.value = false;
    await nextTick();

    const shown = frame.value?.clientWidth ?? 1000;
    const fallbackWidth = DEVICE_WIDTH[props.filters.device] ?? 1440;
    const deepest = props.points.reduce(
        (most, point) => Math.max(most, point.y),
        0,
    );

    if (!props.snapshot || !page.value) {
        paint(fallbackWidth, shown / fallbackWidth, deepest + 120);

        return;
    }

    try {
        const response = await fetch(
            `/crm/replays/${props.snapshot.session}/events?seq=${props.snapshot.seq}`,
            {
                headers: { Accept: 'application/json' },
                credentials: 'same-origin',
            },
        );
        const pair = pageSnapshot(
            (await response.json()) as ReplayEvent[],
            props.snapshot.at_ms,
        );

        if (!pair) {
            paint(fallbackWidth, shown / fallbackWidth, deepest + 120);

            return;
        }

        const { Replayer } = await import('rrweb');
        replayer = new Replayer(pair as never, {
            root: page.value,
            mouseTail: false,
            showWarning: false,
            triggerFocus: false,
            skipInactive: false,
        }) as unknown as Replayer;
        replayer.pause(0);

        const width = Number(pair[0].data.width) || fallbackWidth;
        const scale = shown / width;

        // Styles and fonts arrive after the DOM: measure once they have.
        window.setTimeout(() => {
            if (!replayer) {
                return;
            }

            const document_ = replayer.iframe.contentDocument;
            const pageHeight = Math.max(
                document_?.documentElement.scrollHeight ?? 0,
                deepest + 120,
            );
            replayer.iframe.setAttribute('height', String(pageHeight));
            replayer.iframe.style.height = `${pageHeight}px`;
            replayer.wrapper.style.transform = `scale(${scale})`;
            replayer.wrapper.style.transformOrigin = 'top left';
            drawn.value = true;
            paint(width, scale, pageHeight);
        }, 900);
    } catch {
        paint(fallbackWidth, shown / fallbackWidth, deepest + 120);
    }
}

onMounted(draw);
watch(
    () => [
        props.snapshot?.session,
        props.filters.path,
        props.filters.device,
        props.points.length,
    ],
    draw,
);
onBeforeUnmount(() => replayer?.destroy());
</script>

<template>
    <Head title="Пульт · Тепловая карта" />

    <div
        style="display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap"
    >
        <Link class="mk-link mk-m" href="/crm/replays" style="font-size: 12px">
            ← {{ t('replays.back') }}
        </Link>
        <h1 class="mk-h1">{{ t('replays.heat.title') }}</h1>
        <span class="mk-m mk-t3" style="font-size: 12px">
            {{ t('replays.heat.subtitle') }}
        </span>
    </div>

    <div
        style="
            margin-top: 16px;
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            align-items: center;
        "
    >
        <button
            v-for="site in props.sites"
            :key="site"
            type="button"
            class="mk-pick"
            :class="{ 'mk-on': props.filters.site === site }"
            @click="filter({ site, path: null })"
        >
            {{ site }}
        </button>
        <span style="width: 12px"></span>
        <button
            v-for="device in ['phone', 'tablet', 'desktop']"
            :key="device"
            type="button"
            class="mk-pick"
            :class="{ 'mk-on': props.filters.device === device }"
            @click="filter({ device })"
        >
            {{ device }} · {{ num(props.devices[device] ?? 0) }}
        </button>
        <span style="width: 12px"></span>
        <span class="mk-k">{{ t('replays.heat.days') }}</span>
        <button
            v-for="days in [1, 7, 30]"
            :key="days"
            type="button"
            class="mk-pick"
            :class="{ 'mk-on': props.filters.days === days }"
            @click="filter({ days })"
        >
            {{ days }}
        </button>
        <select
            class="mk-input"
            style="margin-left: auto; min-width: 260px"
            :value="props.filters.path ?? ''"
            @change="
                filter({ path: ($event.target as HTMLSelectElement).value })
            "
        >
            <option
                v-for="row in props.paths"
                :key="row.path"
                :value="row.path"
            >
                {{ row.path }} · {{ row.clicks }}
            </option>
        </select>
    </div>

    <div
        style="
            margin-top: 14px;
            display: grid;
            grid-template-columns: minmax(0, 1fr) 320px;
            gap: 14px;
            align-items: start;
        "
    >
        <div class="mk-panel" style="padding: 10px">
            <div class="mk-m mk-t3" style="font-size: 11px; margin-bottom: 8px">
                {{ t('replays.heat.legend') }}
                <template v-if="!props.snapshot"
                    >· {{ t('replays.heat.noSnapshot') }}</template
                >
            </div>
            <div
                v-if="props.points.length === 0"
                class="mk-m mk-t3"
                style="padding: 20px"
            >
                {{ t('replays.heat.none') }}
            </div>
            <div
                ref="frame"
                class="mk-heat-frame"
                :style="{ height: `${height}px` }"
            >
                <div
                    ref="page"
                    class="mk-heat-page"
                    :style="{ opacity: drawn ? 0.55 : 0 }"
                ></div>
                <canvas ref="canvas" class="mk-heat-canvas"></canvas>
            </div>
        </div>

        <div class="mk-panel" style="padding: 12px 14px">
            <div class="mk-k">{{ t('replays.heat.targets') }}</div>
            <table class="mk-table" style="margin-top: 8px">
                <tbody>
                    <tr v-for="row in props.targets" :key="row.target">
                        <td
                            class="mk-m"
                            style="padding-left: 0; max-width: 190px"
                        >
                            <div class="mk-clip">{{ row.target }}</div>
                        </td>
                        <td class="mk-num" style="text-align: right">
                            {{ num(row.clicks) }}
                        </td>
                        <td
                            class="mk-num"
                            style="text-align: right; color: var(--mk-warning)"
                        >
                            {{ row.rage ? num(row.rage) : '' }}
                        </td>
                        <td
                            class="mk-num"
                            style="text-align: right; color: var(--mk-faint)"
                        >
                            {{ row.dead ? num(row.dead) : '' }}
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<style scoped>
.mk-heat-frame {
    position: relative;
    overflow: hidden;
    min-height: 200px;
    background: #fff;
}

.mk-heat-page {
    position: absolute;
    inset: 0;
    pointer-events: none;
    transition: opacity 0.2s;
}

.mk-heat-page :deep(.replayer-mouse) {
    display: none;
}

.mk-heat-canvas {
    position: absolute;
    inset: 0;
    pointer-events: none;
}
</style>
