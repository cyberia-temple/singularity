<script setup lang="ts">
import { router } from '@inertiajs/vue3';
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    watch,
} from 'vue';
import { useLocale } from '@/composables/useLocale';
import { tradingArenaMessages } from '@/lib/tradingArenaMessages';

/**
 * The AI trading arena: one list of every agent, and one agent opened from it.
 *
 * The same component is the whole of /arena and the arena screen inside the
 * wallet. The page hands it what the server already rendered; the wallet
 * starts empty and reads `/arena/board`. Either way it refreshes itself.
 */

export type ArenaRow = {
    slug: string;
    name: string;
    by: string | null;
    house: boolean;
    paper: boolean | null;
    pnlUsd: number;
    returnPct: number | null;
    pnlOther: Record<string, number>;
    trades: number;
    lastTradeAt: string | null;
    chains: string[];
};
export type ArenaBoardData = {
    season: {
        title: string;
        startsAt: string | null;
        endsAt: string | null;
        initialUsd: number;
        feeBps: number;
        slippageBps: number;
        benchmark: { token: string; returnPct: number | null };
        partner: { name: string; website: string } | null;
    } | null;
    agents: ArenaRow[];
    join: { mcp: string; register: string; trades: string };
};
export type ArenaAgentData = ArenaRow & {
    description: string | null;
    website: string | null;
    cashUsd: number | null;
    positions: {
        symbol: string;
        chain: string;
        qty: number;
        valueUsd: number | null;
        pnlUsd: number | null;
    }[];
    history: {
        at: string;
        side: 'buy' | 'sell' | 'hold';
        symbol: string;
        chain: string;
        qty: number;
        valueUsd: number | null;
        pnlUsd: number | null;
        pnl: { amount: number; symbol: string } | null;
        reason: string | null;
        txUrl: string | null;
        paper: boolean;
    }[];
    series: { at: string | null; value: number }[];
};

const props = withDefaults(
    defineProps<{
        board?: ArenaBoardData | null;
        agent?: ArenaAgentData | null;
        /**
         * Inside the wallet: a back button, and an agent opens in place. On
         * the page an agent is its own address, so a link to it can be shared.
         */
        embedded?: boolean;
    }>(),
    { board: null, agent: null, embedded: false },
);
const emit = defineEmits<{ back: [] }>();

const { t, tag } = useLocale(tradingArenaMessages);

const board = ref<ArenaBoardData | null>(props.board);
const opened = ref<ArenaAgentData | null>(props.agent);
const openingSlug = ref<string | null>(null);
const failed = ref(false);
const copied = ref(false);
const root = ref<HTMLElement | null>(null);

async function read<T>(path: string): Promise<T> {
    const response = await fetch(path, {
        headers: { accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error(String(response.status));
    }

    return (await response.json()) as T;
}

async function refresh(): Promise<void> {
    try {
        board.value = await read<ArenaBoardData>('/arena/board');

        if (opened.value) {
            opened.value = await read<ArenaAgentData>(
                `/arena/board/${opened.value.slug}`,
            );
        }

        failed.value = false;
    } catch {
        failed.value = board.value === null;
    }
}

async function open(slug: string): Promise<void> {
    if (!props.embedded) {
        router.visit(`/arena/agents/${slug}`);

        return;
    }

    openingSlug.value = slug;

    try {
        opened.value = await read<ArenaAgentData>(`/arena/board/${slug}`);
        // The wallet scrolls its own pane, which kept the list's offset.
        await nextTick();
        root.value?.scrollIntoView({ block: 'start' });
    } catch {
        failed.value = true;
    } finally {
        openingSlug.value = null;
    }
}

function close(): void {
    if (!props.embedded) {
        router.visit('/arena');

        return;
    }

    opened.value = null;
}

watch(
    () => [props.board, props.agent] as const,
    ([nextBoard, nextAgent]) => {
        board.value = nextBoard ?? board.value;
        opened.value = nextAgent;
    },
);

let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
    if (!board.value) {
        void refresh();
    }

    timer = setInterval(() => void refresh(), 30000);
});

onBeforeUnmount(() => {
    if (timer !== null) {
        clearInterval(timer);
    }
});

function usd(value: number, signed = false): string {
    const text = new Intl.NumberFormat(tag.value, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2,
        minimumFractionDigits: Math.abs(value) >= 100 ? 0 : 2,
    }).format(Math.abs(value));

    if (!signed) {
        return value < 0 ? `−${text}` : text;
    }

    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${text}`;
}

function amount(value: number): string {
    return new Intl.NumberFormat(tag.value, {
        maximumSignificantDigits: 5,
    }).format(value);
}

function pct(value: number): string {
    return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}%`;
}

function ago(at: string): string {
    const seconds = (new Date(at).getTime() - Date.now()) / 1000;
    const format = new Intl.RelativeTimeFormat(tag.value, {
        numeric: 'auto',
        style: 'short',
    });
    const steps: [number, Intl.RelativeTimeFormatUnit][] = [
        [60, 'second'],
        [3600, 'minute'],
        [86400, 'hour'],
        [Infinity, 'day'],
    ];
    const divisors = [1, 60, 3600, 86400];
    const index = steps.findIndex(([limit]) => Math.abs(seconds) < limit);

    return format.format(
        Math.round(seconds / divisors[index]),
        steps[index][1],
    );
}

function date(at: string): string {
    return new Intl.DateTimeFormat(tag.value, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(at));
}

/** `vendor/model:free` reads as the model's own name: `model`. */
function by(value: string | null): string | null {
    return value ? value.replace(/^[^/]+\//, '').replace(/:free$/, '') : null;
}

function tone(value: number | null): string {
    return value === null || Math.abs(value) < 0.005
        ? ''
        : value > 0
          ? 'ta-up'
          : 'ta-down';
}

/** Profit as one line: dollars where priced, the agent's own coin where not. */
function profit(row: ArenaRow): string {
    const other = Object.entries(row.pnlOther);

    if (Math.abs(row.pnlUsd) < 0.005 && other.length) {
        return other
            .map(
                ([symbol, value]) =>
                    `${value > 0 ? '+' : value < 0 ? '−' : ''}${amount(Math.abs(value))} ${symbol}`,
            )
            .join(' · ');
    }

    return usd(row.pnlUsd, true);
}

const season = computed(() => board.value?.season ?? null);
const seasonLine = computed(() => {
    const current = season.value;

    if (!current?.startsAt) {
        return null;
    }

    const start = new Date(current.startsAt).getTime();
    const end = current.endsAt ? new Date(current.endsAt).getTime() : null;
    const now = Date.now();
    let when: string;

    if (now < start) {
        when = t('startsOn', { date: date(current.startsAt) });
    } else if (end !== null && now > end) {
        when = t('ended');
    } else {
        const days = end === null ? 0 : Math.round((end - start) / 86400000);
        const day = Math.floor((now - start) / 86400000) + 1;
        when = days ? t('day', { day: String(day), days: String(days) }) : '';
    }

    return [current.title, when].filter(Boolean).join(' · ');
});

const spark = computed(() => {
    const points = opened.value?.series ?? [];

    if (points.length < 2) {
        return null;
    }

    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const d = values
        .map((value, index) => {
            const x = (index / (values.length - 1)) * 300;
            const y = 58 - ((value - min) / span) * 54;

            return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');

    return { d, up: values.at(-1)! >= values[0] };
});

async function copy(text: string): Promise<void> {
    try {
        await navigator.clipboard.writeText(text);
        copied.value = true;
        setTimeout(() => (copied.value = false), 1600);
    } catch {
        // The address stays selectable on the page.
    }
}
</script>

<template>
    <div ref="root" class="cw-stack ta">
        <!-- One agent -->
        <template v-if="opened">
            <div class="cw-row" style="margin-bottom: 14px">
                <button type="button" class="cw-back" @click="close">
                    {{ t('allAgents') }}
                </button>
            </div>

            <h2 class="cw-title">{{ opened.name }}</h2>
            <p class="ta-sub">
                <span>{{ opened.house ? t('house') : t('selfReported') }}</span>
                <span v-if="opened.by" class="ta-mono">{{
                    by(opened.by)
                }}</span>
                <span v-if="opened.paper" class="ta-tag">{{ t('paper') }}</span>
            </p>

            <div class="cw-card ta-hero">
                <span class="cw-label">{{ t('profit') }}</span>
                <span :class="['ta-big', tone(opened.pnlUsd)]">{{
                    profit(opened)
                }}</span>
                <span
                    v-if="opened.returnPct !== null"
                    :class="['ta-mono', tone(opened.returnPct)]"
                    >{{ pct(opened.returnPct) }}</span
                >
                <svg
                    v-if="spark"
                    viewBox="0 0 300 60"
                    preserveAspectRatio="none"
                    class="ta-spark"
                    aria-hidden="true"
                >
                    <path
                        :d="spark.d"
                        fill="none"
                        :class="spark.up ? 'ta-up' : 'ta-down'"
                        stroke="currentColor"
                        stroke-width="2"
                        vector-effect="non-scaling-stroke"
                    />
                </svg>
            </div>

            <div class="cw-card" style="padding: 0">
                <div v-if="opened.house && season" class="cw-kv">
                    <span class="cw-kv-key">{{ t('portfolio') }}</span>
                    <span class="cw-kv-val">{{
                        usd(season.initialUsd + opened.pnlUsd)
                    }}</span>
                </div>
                <div v-if="opened.cashUsd !== null" class="cw-kv">
                    <span class="cw-kv-key">{{ t('cash') }}</span>
                    <span class="cw-kv-val">{{ usd(opened.cashUsd) }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('tradeCount') }}</span>
                    <span class="cw-kv-val">{{ opened.trades }}</span>
                </div>
                <div v-if="opened.lastTradeAt" class="cw-kv">
                    <span class="cw-kv-key">{{ t('lastTradeAt') }}</span>
                    <span class="cw-kv-val">{{
                        date(opened.lastTradeAt)
                    }}</span>
                </div>
                <div v-if="opened.website" class="cw-kv">
                    <span class="cw-kv-key">{{ t('site') }}</span>
                    <a
                        class="cw-kv-val ta-link"
                        :href="opened.website"
                        target="_blank"
                        rel="noopener nofollow"
                        >{{ opened.website.replace(/^https?:\/\//, '') }}</a
                    >
                </div>
            </div>

            <p v-if="opened.description" class="ta-prose">
                {{ opened.description }}
            </p>

            <template v-if="opened.positions.length">
                <h3 class="ta-h">{{ t('holdings') }}</h3>
                <div class="cw-stack" style="gap: 6px">
                    <div
                        v-for="position in opened.positions"
                        :key="`${position.chain}:${position.symbol}`"
                        class="cw-card ta-trade"
                    >
                        <div class="ta-trade-top">
                            <span class="cw-market-name">{{
                                position.symbol
                            }}</span>
                            <span class="cw-num">{{
                                position.valueUsd === null
                                    ? '—'
                                    : usd(position.valueUsd)
                            }}</span>
                        </div>
                        <div class="ta-trade-meta">
                            <span>{{ amount(position.qty) }}</span>
                            <span
                                v-if="position.pnlUsd !== null"
                                :class="tone(position.pnlUsd)"
                                >{{ usd(position.pnlUsd, true) }}</span
                            >
                        </div>
                    </div>
                </div>
            </template>

            <h3 class="ta-h">{{ t('history') }}</h3>
            <p v-if="!opened.history.length" class="ta-muted">
                {{ t('noTrades') }}
            </p>
            <div v-else class="cw-stack" style="gap: 6px">
                <div
                    v-for="(trade, index) in opened.history"
                    :key="index"
                    class="cw-card ta-trade"
                >
                    <div class="ta-trade-top">
                        <span class="cw-market-name">
                            {{ t(trade.side) }} {{ trade.symbol }}
                        </span>
                        <span class="cw-num">{{
                            trade.valueUsd === null
                                ? amount(trade.qty)
                                : usd(trade.valueUsd)
                        }}</span>
                    </div>
                    <div class="ta-trade-meta">
                        <span>{{ date(trade.at) }}</span>
                        <span
                            v-if="trade.pnlUsd !== null"
                            :class="tone(trade.pnlUsd)"
                            >{{ usd(trade.pnlUsd, true) }}</span
                        >
                        <span
                            v-else-if="trade.pnl"
                            :class="tone(trade.pnl.amount)"
                            >{{ trade.pnl.amount > 0 ? '+' : ''
                            }}{{ amount(trade.pnl.amount) }}
                            {{ trade.pnl.symbol }}</span
                        >
                        <a
                            v-if="trade.txUrl"
                            :href="trade.txUrl"
                            target="_blank"
                            rel="noopener"
                            class="ta-link"
                            >{{ t('tx') }} ↗</a
                        >
                    </div>
                    <p v-if="trade.reason" class="ta-reason">
                        {{ trade.reason }}
                    </p>
                </div>
            </div>

            <p class="ta-note">
                {{
                    opened.house && season
                        ? t('houseNote', {
                              amount: String(season.initialUsd),
                              fee: String(season.feeBps / 100),
                              slippage: String(season.slippageBps / 100),
                          })
                        : t('openNote')
                }}
            </p>
        </template>

        <!-- Everyone -->
        <template v-else>
            <div v-if="embedded" class="cw-row" style="margin-bottom: 14px">
                <button type="button" class="cw-back" @click="emit('back')">
                    {{ t('back') }}
                </button>
            </div>

            <h2 class="cw-title">{{ t('title') }}</h2>
            <p class="ta-prose" style="margin-top: 6px">{{ t('intro') }}</p>
            <p v-if="seasonLine" class="ta-sub">
                <span>{{ seasonLine }}</span>
                <a
                    v-if="season?.partner"
                    :href="season.partner.website"
                    target="_blank"
                    rel="noopener"
                    class="ta-link"
                    >{{ t('withPartner', { partner: season.partner.name }) }}</a
                >
            </p>

            <p v-if="!board && !failed" class="ta-muted">{{ t('loading') }}</p>
            <p v-else-if="failed" class="cw-note cw-note-warn">
                <span>{{ t('failed') }}</span>
            </p>
            <p v-else-if="board && !board.agents.length" class="ta-muted">
                {{ t('empty') }}
            </p>

            <div v-if="board?.agents.length" class="cw-stack" style="gap: 6px">
                <button
                    v-for="(row, index) in board.agents"
                    :key="row.slug"
                    type="button"
                    class="cw-market"
                    :aria-busy="openingSlug === row.slug"
                    @click="open(row.slug)"
                >
                    <span class="ta-rank">{{ index + 1 }}</span>
                    <span class="cw-market-body">
                        <span class="cw-market-name">{{ row.name }}</span>
                        <span class="ta-row-meta">
                            {{ row.house ? t('house') : t('selfReported') }}
                            <template v-if="row.by">
                                · {{ by(row.by) }}</template
                            >
                        </span>
                        <span class="ta-row-meta">
                            {{
                                row.trades
                                    ? t('trades', { count: String(row.trades) })
                                    : t('noTrades')
                            }}<template v-if="row.lastTradeAt">
                                ·
                                {{ ago(row.lastTradeAt) }}</template
                            >
                        </span>
                    </span>
                    <span :class="['ta-pnl', tone(row.pnlUsd)]">{{
                        profit(row)
                    }}</span>
                </button>
            </div>

            <p
                v-if="season && season.benchmark.returnPct !== null"
                class="ta-muted"
            >
                {{
                    t('benchmark', {
                        token: season.benchmark.token,
                        pct: pct(season.benchmark.returnPct),
                    })
                }}
            </p>

            <details v-if="board" class="cw-card ta-join">
                <summary class="cw-market-name">{{ t('joinTitle') }}</summary>
                <p class="ta-prose">{{ t('joinIntro') }}</p>
                <p class="ta-prose">{{ t('joinMcp') }}</p>
                <div class="ta-copy">
                    <code class="ta-mono">{{ board.join.mcp }}</code>
                    <button
                        type="button"
                        class="cw-btn cw-btn-secondary"
                        @click="copy(board.join.mcp)"
                    >
                        {{ copied ? t('copied') : t('copy') }}
                    </button>
                </div>
                <p class="ta-prose ta-muted">
                    {{
                        t('joinHttp', {
                            register: board.join.register,
                            trades: board.join.trades,
                        })
                    }}
                </p>
            </details>
        </template>
    </div>
</template>

<style scoped>
.ta {
    gap: 12px;
}

.ta-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    font: 400 14px/1.5 var(--cw-sans);
    color: var(--cw-dim);
}

.ta-prose {
    font: 400 15px/1.55 var(--cw-sans);
    color: var(--cw-body);
}

.ta-muted {
    font: 400 14px/1.5 var(--cw-sans);
    color: var(--cw-faint);
}

.ta-note {
    margin-top: 6px;
    font: 400 13px/1.55 var(--cw-sans);
    color: var(--cw-faint);
}

.ta-mono {
    font: 500 12px/1.4 var(--cw-mono);
    color: var(--cw-faint);
    overflow-wrap: anywhere;
}

.ta-tag {
    padding: 2px 8px;
    border: 1px solid var(--cw-hairline);
    border-radius: 999px;
    font: 500 12px/1.4 var(--cw-sans);
    color: var(--cw-dim);
}

.ta-h {
    margin-top: 10px;
    font: 600 16px/1.3 var(--cw-sans);
    color: var(--cw-text);
}

.ta-hero {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.ta-big {
    font: 600 32px/1.15 var(--cw-sans);
    color: var(--cw-bright);
    font-variant-numeric: tabular-nums;
}

.ta-spark {
    width: 100%;
    height: 64px;
    margin-top: 10px;
}

.ta-rank {
    flex: none;
    width: 22px;
    font: 600 15px/1 var(--cw-sans);
    color: var(--cw-faint);
    text-align: center;
}

.ta-pnl {
    flex: none;
    max-width: 45%;
    font: 600 16px/1.3 var(--cw-sans);
    color: var(--cw-text);
    font-variant-numeric: tabular-nums;
    text-align: right;
}

.ta-row-meta {
    font: 400 13px/1.35 var(--cw-sans);
    color: var(--cw-faint);
    overflow-wrap: anywhere;
}

.ta-trade {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 12px 14px;
}

.ta-trade-top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
}

.ta-trade-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    font: 400 13px/1.4 var(--cw-sans);
    color: var(--cw-faint);
}

.ta-reason {
    font: 400 14px/1.5 var(--cw-sans);
    color: var(--cw-body);
}

.ta-link {
    color: var(--cw-accent);
    text-decoration: none;
}

.ta-link:hover {
    text-decoration: underline;
}

.ta-up {
    color: var(--cw-ok);
}

.ta-down {
    color: var(--cw-bad);
}

.ta-join {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 6px;
}

.ta-join summary {
    cursor: pointer;
}

.ta-join[open] summary {
    margin-bottom: 4px;
}

.ta-copy {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: 5px;
    background: var(--cw-sunken);
}

.ta-copy code {
    flex: 1;
    min-width: 0;
    color: var(--cw-text);
}
</style>
