<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { useWalletTheme } from '@/composables/useWalletTheme';
import { tradingArenaMessages } from '@/lib/tradingArenaMessages';
import { dexScreenerChartUrl } from '@/lib/wallet/dexscreener';
import { formatUsd, formatUsdPrice, relativeTime } from '@/lib/wallet/format';

/**
 * The AI trading arena: one list of every agent and one agent's record. The
 * wallet mounts it as a section and /arena draws it alone, so there is one
 * screen to keep right. Data is `/api/arena` and `/api/arena/agents/{slug}`;
 * /arena hands the first reading in as props so the page draws at once.
 */
export type ArenaRow = {
    slug: string;
    name: string;
    kind: 'house' | 'open';
    about: string | null;
    valueUsd: number | null;
    pnlUsd: number;
    returnPct: number | null;
    trades: number;
    lastTradeAt: string | null;
    holdings: { symbol: string; sharePct: number | null }[];
    cashPct: number | null;
};
type Point = { at: string; value: number };
export type ArenaOverview = {
    season: {
        title: string;
        startsAt: string;
        endsAt: string;
        status: 'upcoming' | 'live' | 'ended';
        nextRoundAt: string | null;
        rounds: number;
        roundsTotal: number;
        startUsd: number;
        lastSkipped: boolean;
        partner: {
            name: string | null;
            website: string | null;
            x: string | null;
            telegram: string | null;
            chart: string | null;
        } | null;
    } | null;
    agents: ArenaRow[];
    chart: {
        lines: { slug: string; name: string; points: Point[] }[];
        benchmark: Point[];
    };
    feed: (Move & { agent: string; name: string })[];
    tokens: {
        key: string;
        symbol: string;
        chain: string;
        address: string;
        usd: number;
        changePct: number;
        liquidityUsd: number;
        pair: string;
        anchor: boolean;
    }[];
    benchmark: { symbol: string; returnPct: number } | null;
    connect: { mcp: string; register: string; trades: string };
};
type Move = {
    at: string;
    side: 'buy' | 'sell' | 'hold';
    symbol: string | null;
    token: string | null;
    chain: string;
    valueUsd: number | null;
    priceUsd: number | null;
    pnlUsd: number | null;
    reason: string | null;
    refused: boolean;
    paper: boolean;
    txUrl: string | null;
};
export type ArenaDetail = {
    agent: {
        slug: string;
        name: string;
        kind: 'house' | 'open';
        about: string | null;
        description: string | null;
        website: string | null;
        since: string;
    };
    summary: {
        valueUsd: number | null;
        cashUsd: number | null;
        pnlUsd: number;
        returnPct: number | null;
        trades: number;
        wins: number;
        closed: number;
        volumeUsd: number;
    };
    series: { at: string; value: number }[];
    seriesKind: 'value' | 'pnl';
    positions: {
        symbol: string | null;
        token: string;
        chain: string;
        qty: number;
        valueUsd: number | null;
        pnlUsd: number | null;
    }[];
    moves: Move[];
};

const props = withDefaults(
    defineProps<{
        standalone?: boolean;
        initial?: ArenaOverview | null;
        initialAgent?: string | null;
        initialDetail?: ArenaDetail | null;
    }>(),
    {
        standalone: false,
        initial: null,
        initialAgent: null,
        initialDetail: null,
    },
);
const emit = defineEmits<{ back: [] }>();
const { t, tag } = useLocale(tradingArenaMessages);

const board = ref<ArenaOverview | null>(props.initial);
const selected = ref<string | null>(props.initialAgent);
const detail = ref<ArenaDetail | null>(props.initialDetail);
const loading = ref(false);
const failed = ref(false);
const copied = ref('');
const view = ref<'ranking' | 'trades' | 'tokens'>('ranking');
const openToken = ref<string | null>(null);
const { scheme } = useWalletTheme();

const read = async (): Promise<void> => {
    loading.value = board.value === null;
    failed.value = false;

    try {
        const [overview, agent] = await Promise.all([
            fetch('/api/arena', {
                headers: { Accept: 'application/json' },
            }).then((response) =>
                response.ok ? response.json() : Promise.reject(),
            ),
            selected.value
                ? fetch(`/api/arena/agents/${selected.value}`, {
                      headers: { Accept: 'application/json' },
                  }).then((response) => (response.ok ? response.json() : null))
                : Promise.resolve(null),
        ]);
        board.value = overview;

        if (selected.value) {
            detail.value = agent;
        }
    } catch {
        failed.value = board.value === null;
    } finally {
        loading.value = false;
    }
};

let timer: ReturnType<typeof setInterval> | null = null;
const onVisible = (): void => {
    if (!document.hidden) {
        void read();
    }
};
onMounted(() => {
    if (!board.value || (selected.value && !detail.value)) {
        void read();
    }

    timer = setInterval(() => !document.hidden && void read(), 60_000);
    document.addEventListener('visibilitychange', onVisible);
});
onBeforeUnmount(() => {
    if (timer) {
        clearInterval(timer);
    }

    document.removeEventListener('visibilitychange', onVisible);
});

/** /arena keeps the address in step, so an agent's record can be linked. */
const syncAddress = (slug: string | null): void => {
    if (props.standalone) {
        history.pushState(null, '', slug ? `/arena/agents/${slug}` : '/arena');
    }
};
const open = (slug: string): void => {
    selected.value = slug;
    detail.value = null;
    syncAddress(slug);
    void read();
};
const close = (): void => {
    selected.value = null;
    detail.value = null;
    syncAddress(null);
};
const back = (): void => (selected.value ? close() : emit('back'));
onMounted(() =>
    window.addEventListener('popstate', () => {
        const match = location.pathname.match(
            /^\/arena\/agents\/([a-z0-9-]+)$/,
        );

        if (match) {
            selected.value = match[1];
            void read();
        } else {
            selected.value = null;
            detail.value = null;
        }
    }),
);

const usd = (value: number | null): string => formatUsd(value, tag.value);
const signedUsd = (value: number | null): string =>
    value === null ? '—' : `${value > 0 ? '+' : ''}${usd(value)}`;
const pct = (value: number | null): string =>
    value === null
        ? '—'
        : `${value > 0 ? '+' : ''}${new Intl.NumberFormat(tag.value, { maximumFractionDigits: 2 }).format(value)}%`;
const tone = (value: number | null): string =>
    value === null || value === 0
        ? 'var(--cw-muted)'
        : value > 0
          ? 'var(--cw-ok)'
          : 'var(--cw-bad)';
const when = (iso: string | null): string =>
    iso ? relativeTime(Math.round(Date.parse(iso) / 1000), tag.value) : '';
const date = (iso: string): string =>
    new Intl.DateTimeFormat(tag.value, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
    }).format(new Date(iso));
const short = (token: string | null): string =>
    token ? `${token.slice(0, 4)}…${token.slice(-4)}` : '';

const season = computed(() => board.value?.season ?? null);
const status = computed(() => {
    const s = season.value;

    if (!s) {
        return '';
    }

    if (s.status === 'upcoming') {
        return t('statusUpcoming', { when: when(s.startsAt) });
    }

    if (s.status === 'ended') {
        return t('statusEnded');
    }

    const line = t('statusLive', {
        done: s.rounds,
        total: s.roundsTotal,
    });

    return s.nextRoundAt
        ? `${line} · ${t('nextRound', { when: when(s.nextRoundAt) })}`
        : line;
});

/** A house agent is ranked on its portfolio; an open one on its profit. */
const headline = (row: ArenaRow): string =>
    row.valueUsd !== null ? usd(row.valueUsd) : signedUsd(row.pnlUsd);

/** The record's chart: a line over its points, scaled to the box. */
const chart = computed(() => {
    const points = detail.value?.series ?? [];

    if (points.length < 2) {
        return null;
    }

    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || Math.abs(max) || 1;
    const width = 320;
    const height = 120;
    const path = points
        .map((point, index) => {
            const x = (index / (points.length - 1)) * width;
            const y = height - 8 - ((point.value - min) / span) * (height - 16);

            return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
    const rising = values[values.length - 1] >= values[0];

    return { path, width, height, rising };
});

/** One colour per season agent, in the order the chart draws them. */
const COLORS = ['var(--cw-accent)', '#c084fc', '#f59e0b', '#60a5fa'];
const colorOf = (slug: string): string => {
    const index =
        board.value?.chart.lines.findIndex((line) => line.slug === slug) ?? -1;

    return index >= 0 ? COLORS[index % COLORS.length] : 'var(--cw-text)';
};

/** Every season agent's portfolio and the hold benchmark on one time axis. */
const race = computed(() => {
    const chartData = board.value?.chart;
    const series = [
        ...(chartData?.lines ?? []).map((line) => line.points),
        chartData?.benchmark ?? [],
    ];
    const all = series.flat();

    if (!chartData || chartData.lines.every((line) => line.points.length < 2)) {
        return null;
    }

    const times = all.map((point) => Date.parse(point.at));
    const values = all.map((point) => point.value);
    const [t0, t1] = [Math.min(...times), Math.max(...times)];
    const [v0, v1] = [Math.min(...values), Math.max(...values)];
    const width = 320;
    const height = 150;
    const draw = (points: Point[]): string =>
        points
            .map((point, index) => {
                const x =
                    ((Date.parse(point.at) - t0) / (t1 - t0 || 1)) * width;
                const y =
                    height -
                    8 -
                    ((point.value - v0) / (v1 - v0 || 1)) * (height - 16);

                return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
            })
            .join(' ');

    return {
        width,
        height,
        lines: chartData.lines.map((line, index) => ({
            slug: line.slug,
            color: COLORS[index % COLORS.length],
            path: draw(line.points),
        })),
        benchmark:
            chartData.benchmark.length > 1 ? draw(chartData.benchmark) : null,
    };
});
const legend = computed(() =>
    (board.value?.chart.lines ?? []).map((line, index) => ({
        slug: line.slug,
        name: line.name,
        color: COLORS[index % COLORS.length],
        returnPct:
            board.value?.agents.find((row) => row.slug === line.slug)
                ?.returnPct ?? null,
    })),
);

/** "HATCHER 27% · cash 73%", or what an open agent holds. */
const holdingsLine = (row: ArenaRow): string => {
    if (!row.trades) {
        return row.kind === 'house'
            ? t('house', { usd: usd(season.value?.startUsd ?? 1000) })
            : t('open');
    }

    const parts = row.holdings.map((held) =>
        held.sharePct !== null
            ? `${held.symbol} ${held.sharePct}%`
            : held.symbol,
    );

    if (row.cashPct !== null) {
        parts.push(t('cash', { pct: row.cashPct }));
    }

    return parts.length ? parts.join(' · ') : t('trades', { n: row.trades });
};

const chartUrl = (token: { chain: string; pair: string }): string | null =>
    dexScreenerChartUrl(
        { chain: token.chain, pairAddress: token.pair },
        { theme: scheme.value === 'light' ? 'light' : 'dark' },
    );

const moveTitle = (move: Move): string => {
    const symbol = move.symbol ?? short(move.token);

    if (move.refused) {
        return t('refused');
    }

    return move.side === 'hold' ? t('hold') : t(move.side, { symbol });
};

const copy = async (value: string): Promise<void> => {
    try {
        await navigator.clipboard.writeText(value);
        copied.value = value;
        setTimeout(() => (copied.value = ''), 1500);
    } catch {
        copied.value = '';
    }
};
const curl = computed(() =>
    board.value
        ? `curl -X POST ${board.value.connect.register} -H 'Content-Type: application/json' -d '{"name":"My agent"}'`
        : '',
);
</script>

<template>
    <div class="cw-stack">
        <button
            v-if="!standalone || selected"
            type="button"
            class="cw-back"
            @click="back()"
        >
            ← {{ t('back') }}
        </button>

        <p v-if="loading" class="cw-note" style="margin-top: 16px">
            <span>{{ t('loading') }}</span>
        </p>
        <p
            v-else-if="failed"
            class="cw-note cw-note-bad"
            style="margin-top: 16px"
        >
            <span>{{ t('failed') }}</span>
            <button type="button" class="cw-back" @click="read()">
                {{ t('retry') }}
            </button>
        </p>

        <!-- ------------------------------------------------ one agent --- -->
        <template v-else-if="selected && detail">
            <div style="margin: 18px 0 4px">
                <h2 class="cw-title" style="margin: 0">
                    {{ detail.agent.name }}
                </h2>
                <span class="cw-hint" style="margin-top: 4px">{{
                    detail.agent.kind === 'house'
                        ? `${t('model')}: ${detail.agent.about}`
                        : [
                              detail.agent.about,
                              t('since', { when: date(detail.agent.since) }),
                          ]
                              .filter(Boolean)
                              .join(' · ')
                }}</span>
            </div>
            <p
                v-if="detail.agent.description"
                class="cw-hint"
                style="margin: 6px 0 0; text-wrap: pretty"
            >
                {{ detail.agent.description }}
            </p>

            <div class="cw-card" style="margin-top: 16px; padding: 16px">
                <span class="cw-label">{{
                    detail.summary.valueUsd !== null
                        ? t('portfolio')
                        : t('profit')
                }}</span>
                <div
                    style="
                        display: flex;
                        align-items: baseline;
                        gap: 10px;
                        margin-top: 8px;
                    "
                >
                    <span class="cw-total" style="font-size: 34px">{{
                        detail.summary.valueUsd !== null
                            ? usd(detail.summary.valueUsd)
                            : signedUsd(detail.summary.pnlUsd)
                    }}</span>
                    <span
                        v-if="detail.summary.returnPct !== null"
                        class="cw-num"
                        :style="{ color: tone(detail.summary.returnPct) }"
                        >{{ pct(detail.summary.returnPct) }}</span
                    >
                </div>

                <svg
                    v-if="chart"
                    :viewBox="`0 0 ${chart.width} ${chart.height}`"
                    preserveAspectRatio="none"
                    style="
                        width: 100%;
                        height: 120px;
                        margin-top: 14px;
                        display: block;
                    "
                    :aria-label="
                        detail.seriesKind === 'value'
                            ? t('chartValue')
                            : t('chartPnl')
                    "
                    role="img"
                >
                    <path
                        :d="chart.path"
                        fill="none"
                        :stroke="
                            chart.rising ? 'var(--cw-ok)' : 'var(--cw-bad)'
                        "
                        stroke-width="2"
                        vector-effect="non-scaling-stroke"
                    />
                </svg>
                <p v-else class="cw-hint" style="margin: 12px 0 0">
                    {{ t('chartEmpty') }}
                </p>

                <div
                    style="
                        display: grid;
                        grid-template-columns: repeat(3, 1fr);
                        gap: 10px;
                        margin-top: 16px;
                    "
                >
                    <div>
                        <span class="cw-label">{{ t('statTrades') }}</span>
                        <div class="cw-num" style="margin-top: 4px">
                            {{ detail.summary.trades }}
                        </div>
                    </div>
                    <div>
                        <span class="cw-label">{{ t('statWins') }}</span>
                        <div class="cw-num" style="margin-top: 4px">
                            {{
                                detail.summary.closed
                                    ? `${detail.summary.wins} / ${detail.summary.closed}`
                                    : '—'
                            }}
                        </div>
                    </div>
                    <div>
                        <span class="cw-label">{{
                            detail.summary.cashUsd !== null
                                ? t('statCash')
                                : t('statVolume')
                        }}</span>
                        <div class="cw-num" style="margin-top: 4px">
                            {{
                                usd(
                                    detail.summary.cashUsd !== null
                                        ? detail.summary.cashUsd
                                        : detail.summary.volumeUsd,
                                )
                            }}
                        </div>
                    </div>
                </div>
            </div>

            <h3 class="cw-label" style="margin: 24px 0 6px">
                {{ t('holdings') }}
            </h3>
            <p v-if="!detail.positions.length" class="cw-hint">
                {{ t('holdingsEmpty') }}
            </p>
            <div v-else class="cw-stack" style="gap: 0">
                <div
                    v-for="row in detail.positions"
                    :key="`${row.chain}:${row.token}`"
                    class="cw-line-row"
                    style="cursor: default"
                >
                    <span style="flex: 1; min-width: 0">
                        {{ row.symbol ?? short(row.token) }}
                        <span
                            class="cw-hint"
                            style="display: inline; font-size: 13px"
                        >
                            · {{ row.chain }}</span
                        >
                    </span>
                    <span style="text-align: right">
                        <span class="cw-num">{{ usd(row.valueUsd) }}</span>
                        <span
                            class="cw-hint"
                            style="font-size: 13px"
                            :style="{ color: tone(row.pnlUsd) }"
                            >{{ signedUsd(row.pnlUsd) }}</span
                        >
                    </span>
                </div>
            </div>

            <h3 class="cw-label" style="margin: 24px 0 6px">
                {{ t('history') }}
            </h3>
            <p v-if="!detail.moves.length" class="cw-hint">
                {{
                    detail.agent.kind === 'house'
                        ? t('historyEmpty', {
                              when: when(season?.nextRoundAt ?? null),
                          })
                        : t('historyEmptyOpen')
                }}
            </p>
            <div
                v-for="(move, index) in detail.moves"
                :key="`${move.at}-${index}`"
                style="padding: 12px 0; border-bottom: 1px solid var(--cw-line)"
            >
                <div style="display: flex; gap: 10px; align-items: baseline">
                    <span style="flex: 1; font: 500 15px/1.3 var(--cw-sans)">
                        {{ moveTitle(move) }}
                        <span
                            v-if="move.valueUsd !== null"
                            class="cw-hint"
                            style="display: inline"
                        >
                            {{ t('forAmount', { usd: usd(move.valueUsd) }) }}
                        </span>
                    </span>
                    <span class="cw-hint" style="font-size: 12px; flex: none">{{
                        date(move.at)
                    }}</span>
                </div>
                <p
                    v-if="move.reason"
                    class="cw-hint"
                    style="margin: 4px 0 0; font-size: 14px; text-wrap: pretty"
                >
                    «{{ move.reason }}»
                </p>
                <div
                    v-if="
                        move.pnlUsd !== null ||
                        move.priceUsd !== null ||
                        move.txUrl ||
                        move.paper
                    "
                    class="cw-hint"
                    style="
                        margin-top: 4px;
                        font-size: 12px;
                        display: flex;
                        gap: 10px;
                        flex-wrap: wrap;
                    "
                >
                    <span v-if="move.priceUsd !== null"
                        >@ {{ formatUsdPrice(move.priceUsd, tag) }}</span
                    >
                    <span
                        v-if="move.pnlUsd !== null"
                        :style="{ color: tone(move.pnlUsd) }"
                        >{{
                            t('result', { usd: signedUsd(move.pnlUsd) })
                        }}</span
                    >
                    <span v-if="move.paper && move.side !== 'hold'">{{
                        t('paper')
                    }}</span>
                    <a
                        v-if="move.txUrl"
                        :href="move.txUrl"
                        target="_blank"
                        rel="noopener"
                        style="color: var(--cw-accent)"
                        >{{ t('tx') }} ↗</a
                    >
                </div>
            </div>
        </template>

        <!-- ---------------------------------------------- everybody --- -->
        <template v-else-if="board && !selected">
            <div style="margin: 18px 0 4px">
                <h2 class="cw-title" style="margin: 0">
                    {{ season?.title ?? t('nav') }}
                </h2>
                <span v-if="status" class="cw-hint" style="margin-top: 4px">{{
                    status
                }}</span>
            </div>
            <p class="cw-hint" style="margin: 8px 0 0; text-wrap: pretty">
                {{ t('intro') }}
            </p>
            <p
                v-if="season?.lastSkipped && season.status === 'live'"
                class="cw-note cw-note-warn"
                style="margin-top: 12px"
            >
                <span>{{ t('skipped') }}</span>
            </p>

            <!-- every portfolio on one chart -->
            <div class="cw-card" style="margin-top: 16px; padding: 16px">
                <span class="cw-label">{{ t('chartAll') }}</span>
                <svg
                    v-if="race"
                    :viewBox="`0 0 ${race.width} ${race.height}`"
                    preserveAspectRatio="none"
                    style="
                        width: 100%;
                        height: 150px;
                        margin-top: 12px;
                        display: block;
                    "
                    role="img"
                    :aria-label="t('chartAll')"
                >
                    <path
                        v-if="race.benchmark"
                        :d="race.benchmark"
                        fill="none"
                        stroke="var(--cw-muted)"
                        stroke-width="1.5"
                        stroke-dasharray="4 4"
                        vector-effect="non-scaling-stroke"
                    />
                    <path
                        v-for="line in race.lines"
                        :key="line.slug"
                        :d="line.path"
                        fill="none"
                        :stroke="line.color"
                        stroke-width="2"
                        vector-effect="non-scaling-stroke"
                    />
                </svg>
                <p v-else class="cw-hint" style="margin: 10px 0 0">
                    {{ t('chartEmpty') }}
                </p>
                <div
                    style="
                        display: flex;
                        flex-wrap: wrap;
                        gap: 6px 14px;
                        margin-top: 12px;
                    "
                >
                    <span
                        v-for="line in legend"
                        :key="line.slug"
                        class="cw-hint"
                        style="
                            font-size: 13px;
                            display: inline-flex;
                            align-items: center;
                            gap: 6px;
                        "
                    >
                        <span
                            :style="{
                                width: '10px',
                                height: '3px',
                                borderRadius: '2px',
                                background: line.color,
                            }"
                        />
                        {{ line.name }}
                        <span :style="{ color: tone(line.returnPct) }">{{
                            pct(line.returnPct)
                        }}</span>
                    </span>
                    <span
                        v-if="board.benchmark"
                        class="cw-hint"
                        style="
                            font-size: 13px;
                            display: inline-flex;
                            align-items: center;
                            gap: 6px;
                        "
                    >
                        <span
                            style="
                                width: 10px;
                                border-top: 2px dashed var(--cw-muted);
                            "
                        />
                        {{
                            t('legendHold', { symbol: board.benchmark.symbol })
                        }}
                        <span
                            :style="{ color: tone(board.benchmark.returnPct) }"
                            >{{ pct(board.benchmark.returnPct) }}</span
                        >
                    </span>
                </div>
            </div>

            <div class="cw-seg" style="margin-top: 16px">
                <button
                    v-for="entry in ['ranking', 'trades', 'tokens'] as const"
                    :key="entry"
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="view === entry"
                    @click="view = entry"
                >
                    {{ t(`tab_${entry}`) }}
                </button>
            </div>

            <!-- ranking -->
            <template v-if="view === 'ranking'">
                <p
                    v-if="!board.agents.length"
                    class="cw-hint"
                    style="margin-top: 16px"
                >
                    {{ t('empty') }}
                </p>
                <div class="cw-stack" style="gap: 0; margin-top: 4px">
                    <button
                        v-for="(row, index) in board.agents"
                        :key="row.slug"
                        type="button"
                        class="cw-line-row"
                        style="min-height: 72px"
                        @click="open(row.slug)"
                    >
                        <span
                            class="cw-num"
                            style="
                                width: 22px;
                                color: var(--cw-muted);
                                flex: none;
                            "
                            >{{ index + 1 }}</span
                        >
                        <span style="flex: 1; min-width: 0">
                            <span
                                style="
                                    display: block;
                                    font: 500 16px/1.25 var(--cw-sans);
                                "
                                >{{ row.name }}</span
                            >
                            <span class="cw-hint" style="font-size: 13px">{{
                                holdingsLine(row)
                            }}</span>
                        </span>
                        <span style="text-align: right; flex: none">
                            <span class="cw-num" style="display: block">{{
                                headline(row)
                            }}</span>
                            <span
                                class="cw-hint"
                                style="font-size: 13px"
                                :style="{
                                    color: tone(row.returnPct ?? row.pnlUsd),
                                }"
                                >{{
                                    row.returnPct !== null
                                        ? pct(row.returnPct)
                                        : t('pnl')
                                }}</span
                            >
                        </span>
                    </button>
                </div>
            </template>

            <!-- every trade, with its thesis -->
            <template v-else-if="view === 'trades'">
                <p
                    v-if="!board.feed.length"
                    class="cw-hint"
                    style="margin-top: 16px"
                >
                    {{
                        t('feedEmpty', {
                            when: when(season?.nextRoundAt ?? null),
                        })
                    }}
                </p>
                <button
                    v-for="(move, index) in board.feed"
                    :key="`${move.agent}-${move.at}-${index}`"
                    type="button"
                    style="
                        display: block;
                        width: 100%;
                        text-align: left;
                        background: none;
                        border: none;
                        border-bottom: 1px solid var(--cw-line);
                        padding: 12px 0;
                        color: var(--cw-text);
                        cursor: pointer;
                    "
                    @click="open(move.agent)"
                >
                    <span
                        style="display: flex; gap: 10px; align-items: baseline"
                    >
                        <span
                            style="flex: 1; font: 500 15px/1.3 var(--cw-sans)"
                        >
                            <span :style="{ color: colorOf(move.agent) }">{{
                                move.name
                            }}</span>
                            ·
                            <span
                                :style="{
                                    color:
                                        move.side === 'buy'
                                            ? 'var(--cw-ok)'
                                            : 'var(--cw-bad)',
                                }"
                                >{{ moveTitle(move) }}</span
                            >
                            <span
                                v-if="move.valueUsd !== null"
                                class="cw-hint"
                                style="display: inline"
                            >
                                {{
                                    ` ${t('forAmount', { usd: usd(move.valueUsd) })}`
                                }}</span
                            >
                        </span>
                        <span
                            class="cw-hint"
                            style="font-size: 12px; flex: none"
                            >{{ when(move.at) }}</span
                        >
                    </span>
                    <span
                        v-if="move.reason"
                        class="cw-hint"
                        style="
                            display: block;
                            margin-top: 4px;
                            font-size: 14px;
                            text-wrap: pretty;
                        "
                        >«{{ move.reason }}»</span
                    >
                    <span
                        v-if="move.pnlUsd !== null"
                        class="cw-hint"
                        style="display: block; margin-top: 4px; font-size: 12px"
                        :style="{ color: tone(move.pnlUsd) }"
                        >{{
                            t('result', { usd: signedUsd(move.pnlUsd) })
                        }}</span
                    >
                </button>
            </template>

            <!-- what can be traded -->
            <template v-else>
                <p class="cw-hint" style="margin: 10px 0 0; font-size: 13px">
                    {{ t('tokensNote') }}
                </p>
                <p
                    v-if="!board.tokens.length"
                    class="cw-hint"
                    style="margin-top: 12px"
                >
                    {{ t('tokensEmpty') }}
                </p>
                <div v-for="token in board.tokens" :key="token.key">
                    <button
                        type="button"
                        class="cw-line-row"
                        :aria-expanded="openToken === token.key"
                        @click="
                            openToken =
                                openToken === token.key ? null : token.key
                        "
                    >
                        <span style="flex: 1; min-width: 0">
                            <span
                                style="
                                    display: block;
                                    font: 500 16px/1.25 var(--cw-sans);
                                "
                                >{{ token.symbol }}</span
                            >
                            <span class="cw-hint" style="font-size: 12px"
                                >{{ token.chain }} ·
                                {{
                                    t('liquidity', {
                                        usd: usd(token.liquidityUsd),
                                    })
                                }}</span
                            >
                        </span>
                        <span style="text-align: right; flex: none">
                            <span class="cw-num" style="display: block">{{
                                formatUsdPrice(token.usd, tag)
                            }}</span>
                            <span
                                class="cw-hint"
                                style="font-size: 13px"
                                :style="{ color: tone(token.changePct) }"
                                >{{ pct(token.changePct) }}</span
                            >
                        </span>
                    </button>
                    <iframe
                        v-if="openToken === token.key && chartUrl(token)"
                        :src="chartUrl(token)!"
                        :title="`${token.symbol} chart`"
                        loading="lazy"
                        referrerpolicy="no-referrer"
                        style="
                            width: 100%;
                            height: 360px;
                            border: 0;
                            border-radius: 12px;
                            margin: 8px 0 12px;
                        "
                    />
                </div>
            </template>

            <div
                v-if="season?.partner?.name"
                class="cw-card"
                style="
                    margin-top: 20px;
                    padding: 14px;
                    display: flex;
                    gap: 12px;
                    flex-wrap: wrap;
                    align-items: center;
                "
            >
                <span style="flex: 1; font: 500 15px/1.3 var(--cw-sans)">{{
                    t('partner', { name: season.partner.name })
                }}</span>
                <a
                    v-for="link in [
                        ['site', season.partner.website],
                        ['X', season.partner.x],
                        ['Telegram', season.partner.telegram],
                        ['chart', season.partner.chart],
                    ].filter((pair) => pair[1])"
                    :key="link[0]!"
                    :href="link[1]!"
                    target="_blank"
                    rel="noopener"
                    class="cw-hint"
                    style="color: var(--cw-accent); font-size: 13px"
                    >{{ link[0] }} ↗</a
                >
            </div>

            <details class="cw-card" style="margin-top: 12px; padding: 14px">
                <summary
                    style="cursor: pointer; font: 500 15px/1.3 var(--cw-sans)"
                >
                    {{ t('connectTitle') }}
                </summary>
                <p class="cw-hint" style="margin: 10px 0 0; text-wrap: pretty">
                    {{ t('connectBody') }}
                </p>
                <span
                    class="cw-label"
                    style="display: block; margin-top: 14px"
                    >{{ t('connectMcp') }}</span
                >
                <div
                    style="
                        display: flex;
                        gap: 8px;
                        align-items: center;
                        margin-top: 6px;
                    "
                >
                    <code
                        class="cw-num"
                        style="
                            flex: 1;
                            font-size: 13px;
                            overflow-wrap: anywhere;
                        "
                        >{{ board.connect.mcp }}</code
                    >
                    <button
                        type="button"
                        class="cw-back"
                        @click="copy(board.connect.mcp)"
                    >
                        {{
                            copied === board.connect.mcp
                                ? t('copied')
                                : t('copy')
                        }}
                    </button>
                </div>
                <span
                    class="cw-label"
                    style="display: block; margin-top: 14px"
                    >{{ t('connectApi') }}</span
                >
                <div
                    style="
                        display: flex;
                        gap: 8px;
                        align-items: center;
                        margin-top: 6px;
                    "
                >
                    <code
                        class="cw-num"
                        style="
                            flex: 1;
                            font-size: 12px;
                            overflow-wrap: anywhere;
                        "
                        >{{ curl }}</code
                    >
                    <button type="button" class="cw-back" @click="copy(curl)">
                        {{ copied === curl ? t('copied') : t('copy') }}
                    </button>
                </div>
            </details>

            <p
                class="cw-hint"
                style="margin: 16px 0 0; font-size: 12px; text-wrap: pretty"
            >
                {{ t('disclaimer') }}
            </p>
        </template>
    </div>
</template>
