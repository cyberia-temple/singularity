<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { dateTime, num } from '@/lib/console';
import { consoleMessages } from '@/lib/consoleMessages';
import { length } from '@/lib/replay';
import type { ReplayEvent } from '@/lib/replay';
import 'rrweb-player/dist/style.css';

type Session = {
    id: string;
    site: string;
    device: string;
    browser: string | null;
    os: string | null;
    viewport: string;
    entry_path: string;
    pages: number;
    clicks: number;
    rage_clicks: number;
    dead_clicks: number;
    errors: number;
    duration_ms: number;
    installation: string | null;
    installation_known: boolean;
    user_id: number | null;
    started_at: string | null;
};

const props = defineProps<{
    session: Session;
    pages: { path: string; at_ms: number }[];
    marks: {
        path: string;
        target: string;
        rage: boolean;
        dead: boolean;
        at_ms: number;
    }[];
    faults: { path: string; message: string; at_ms: number }[];
}>();

const { t, tag } = useLocale(consoleMessages);

const stage = ref<HTMLDivElement | null>(null);
const state = ref<'loading' | 'ready' | 'empty' | 'failed'>('loading');
const start = ref(0);

type Player = {
    goto(offset: number, play?: boolean): void;
    $destroy(): void;
};

let player: Player | null = null;

/**
 * Everything worth jumping to, in recording order: each page as it was
 * reached, each rage or dead click, each error.
 */
const timeline = computed(() =>
    [
        ...props.pages.map((page) => ({
            at: page.at_ms,
            kind: 'page' as const,
            text: page.path,
        })),
        ...props.marks.map((mark) => ({
            at: mark.at_ms,
            kind: mark.rage ? ('rage' as const) : ('dead' as const),
            text: `${mark.target} · ${mark.path}`,
        })),
        ...props.faults.map((fault) => ({
            at: fault.at_ms,
            kind: 'error' as const,
            text: fault.message,
        })),
    ].sort((a, b) => a.at - b.at),
);

const KIND_COLOR: Record<string, string> = {
    page: 'var(--mk-dim)',
    rage: 'var(--mk-warning)',
    dead: 'var(--mk-faint)',
    error: 'var(--mk-critical)',
};

function jump(at: number): void {
    player?.goto(Math.max(0, at - start.value), true);
}

onMounted(async () => {
    try {
        const response = await fetch(
            `/crm/replays/${props.session.id}/events`,
            {
                headers: { Accept: 'application/json' },
                credentials: 'same-origin',
            },
        );
        const events = (await response.json()) as ReplayEvent[];

        if (!events.some((event) => event.type === 2) || !stage.value) {
            state.value = 'empty';

            return;
        }

        events.sort((a, b) => a.timestamp - b.timestamp);
        start.value = events[0].timestamp;

        const meta = events.find((event) => event.type === 4);
        const width = stage.value.clientWidth;
        const ratio =
            Number(meta?.data.height ?? 9) / Number(meta?.data.width ?? 16);
        const height = Math.min(
            Math.round(window.innerHeight * 0.68),
            Math.round(width * ratio),
        );

        const { default: RrwebPlayer } = await import('rrweb-player');
        state.value = 'ready';
        player = new RrwebPlayer({
            target: stage.value,
            props: {
                // rrweb's own event type; these came from rrweb and back.
                events: events as never,
                width,
                height,
                autoPlay: false,
                skipInactive: true,
                showController: true,
                mouseTail: {
                    strokeStyle: 'rgba(80, 220, 210, 0.6)',
                    lineWidth: 2,
                },
                tags: {
                    error: '#ff4d4d',
                    rage: '#e0a516',
                    dead: '#8a8aa0',
                    event: '#4dd0e1',
                },
            },
        }) as unknown as Player;
    } catch {
        state.value = 'failed';
    }
});

onBeforeUnmount(() => player?.$destroy());
</script>

<template>
    <Head title="Пульт · Запись" />

    <div
        style="display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap"
    >
        <Link class="mk-link mk-m" href="/crm/replays" style="font-size: 12px">
            ← {{ t('replays.back') }}
        </Link>
        <h1 class="mk-h1">
            <span class="mk-t3">{{ props.session.site }}</span
            >{{ props.session.entry_path }}
        </h1>
    </div>
    <div class="mk-m mk-t3" style="margin-top: 6px; font-size: 12px">
        {{ dateTime(props.session.started_at, tag) }} ·
        {{ length(props.session.duration_ms) }} · {{ props.session.device }}
        {{ props.session.viewport }} · {{ props.session.browser ?? '?' }} /
        {{ props.session.os ?? '?' }} · {{ num(props.session.pages) }}
        {{ t('replays.pages').toLowerCase() }} · {{ num(props.session.clicks) }}
        {{ t('replays.col.clicks').toLowerCase() }}
        <template v-if="props.session.installation_known">
            ·
            <Link
                class="mk-link"
                :href="`/crm/installs/${props.session.installation}`"
            >
                {{ t('replays.install') }}
            </Link>
        </template>
        <template v-if="props.session.user_id">
            · {{ t('replays.account') }} #{{ props.session.user_id }}
        </template>
    </div>

    <div
        style="
            margin-top: 16px;
            display: grid;
            grid-template-columns: minmax(0, 1fr) 300px;
            gap: 14px;
            align-items: start;
        "
    >
        <div class="mk-panel" style="padding: 10px; min-height: 240px">
            <div
                v-if="state === 'loading'"
                class="mk-m mk-t3"
                style="padding: 20px"
            >
                {{ t('replays.loading') }}
            </div>
            <div
                v-else-if="state === 'empty'"
                class="mk-m mk-t3"
                style="padding: 20px"
            >
                {{ t('replays.noSnapshot') }}
            </div>
            <div
                v-else-if="state === 'failed'"
                class="mk-m"
                style="padding: 20px; color: var(--mk-critical)"
            >
                {{ t('replays.failed') }}
            </div>
            <div ref="stage" class="mk-replay-stage"></div>
        </div>

        <div
            class="mk-panel"
            style="padding: 12px 14px; max-height: 76vh; overflow-y: auto"
        >
            <div class="mk-k">{{ t('replays.timeline') }}</div>
            <button
                v-for="(item, index) in timeline"
                :key="index"
                type="button"
                class="mk-replay-mark"
                :disabled="state !== 'ready'"
                @click="jump(item.at)"
            >
                <span
                    class="mk-num"
                    style="width: 52px; flex: none; color: var(--mk-faint)"
                >
                    {{ length(item.at - start) }}
                </span>
                <span class="mk-clip" :style="{ color: KIND_COLOR[item.kind] }">
                    {{ item.text }}
                </span>
            </button>
        </div>
    </div>
</template>

<style scoped>
.mk-replay-stage :deep(.rr-player) {
    background: var(--mk-panel);
    box-shadow: none;
}

.mk-replay-mark {
    display: flex;
    gap: 8px;
    width: 100%;
    padding: 6px 0;
    border: 0;
    border-top: 1px solid var(--mk-hair);
    background: none;
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
}

.mk-replay-mark:disabled {
    cursor: default;
}
</style>
