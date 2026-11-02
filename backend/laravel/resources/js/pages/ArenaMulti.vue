<script setup lang="ts">
import { Head, Link, usePoll } from '@inertiajs/vue3';
import { computed } from 'vue';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/composables/useLocale';
import { arenaMultiMessages } from '@/lib/arenaMultiMessages';
import { PARTNER_CAMPAIGNS } from '@/lib/growthCampaigns';

type Position = { qty: string; cost: string };
type State = { cash: string; positions: Record<string, Position> };
type Trade = {
    action: 'buy' | 'sell';
    token: string;
    symbol?: string | null;
    bps: number;
    qty: string;
    price: string;
    value: string;
    realized?: string;
};
type Decision = {
    action: 'hold' | 'buy' | 'sell';
    token: string | null;
    bps: number;
    reason: string;
    model: string;
};
type Round = {
    sequence: number;
    decisionAt: string;
    filledAt: string;
    recordHash: string;
    decisions: Record<string, Decision>;
    board: Record<
        string,
        {
            symbol: string | null;
            usd: string;
            change: number;
            liquidity: number;
            pair: string;
        }
    >;
    result: {
        actors: Record<
            string,
            {
                state: State;
                equity: string;
                trade: Trade | null;
                execution: string;
            }
        >;
        prices: Record<string, string>;
        symbols?: Record<string, string>;
        benchmark: { state: State; equity: string };
    };
};

const props = defineProps<{
    agent: string | null;
    season: {
        title: string;
        slug: string;
        startsAt: string | null;
        endsAt: string | null;
        rulesHash: string;
    };
    rules: {
        days: number;
        rounds_per_day: number;
        initial_cash_usd: string;
        fee_bps: number;
        slippage_bps: number;
        min_liquidity_usd: number;
        benchmark: string;
        universe: 'any';
        anchors: { symbol: string; mint: string }[];
        agents: Record<string, { name: string; method: string }>;
        models: Record<string, string>;
        partner?: {
            slug: string;
            name: string;
            website: string;
            x?: string;
            telegram?: string;
            chart?: string;
        };
    };
    automation: {
        enabled: boolean;
        lastTickAt: string | null;
        error: string | null;
    };
    pending: {
        status: 'collecting' | 'awaiting_fill';
        fillDueAt: string;
        commitHash: string | null;
        decisions: Record<string, Decision> | null;
    } | null;
    skipped: { slot: number; error: string }[];
    league: {
        slug: string;
        name: string;
        framework: string | null;
        lastTradeAt: string | null;
        trades: number;
        chains: string[];
        realized: Record<string, string>;
        realizedUsd: string;
        unrealizedUsd: string;
        volumeUsd: string;
        positions: number;
    }[];
    rounds: Round[];
}>();

const { t, tag, nextTag, toggleLocale } = useLocale(arenaMultiMessages);
usePoll(30000, {
    only: ['rounds', 'pending', 'automation', 'skipped', 'league'],
});

const actors = computed(() => Object.keys(props.rules.agents));
const initial = computed(() => Number(props.rules.initial_cash_usd));
const latest = computed(() => props.rounds.at(-1));
const partner = computed(() => props.rules.partner ?? null);
const origin = typeof window === 'undefined' ? '' : window.location.origin;
/** A mint's ticker, from the rounds; the mint itself when nobody priced it. */
function sym(mint: string | null | undefined): string {
    if (!mint) {
        return '';
    }

    return (
        latest.value?.result.symbols?.[mint] ??
        latest.value?.board[mint]?.symbol ??
        props.rules.anchors.find((anchor) => anchor.mint === mint)?.symbol ??
        `${mint.slice(0, 4)}…${mint.slice(-4)}`
    );
}
function realizedText(realized: Record<string, string>): string {
    const parts = Object.entries(realized).map(
        ([symbol, value]) =>
            `${Number(value) >= 0 ? '+' : ''}${amount(value)} ${symbol}`,
    );

    return parts.length ? parts.join(' · ') : '—';
}
const partnerLogo = computed(() =>
    partner.value
        ? (PARTNER_CAMPAIGNS as Record<string, { logo: string }>)[
              partner.value.slug
          ]?.logo
        : undefined,
);
const status = computed(() => {
    const now = Date.now();

    if (!props.season.startsAt) {
        return t('draft');
    }

    if (new Date(props.season.startsAt).getTime() > now) {
        return t('scheduled', { date: date(props.season.startsAt) });
    }

    return t(
        props.season.endsAt && new Date(props.season.endsAt).getTime() < now
            ? 'finished'
            : 'running',
    );
});

function usd(value: number | string, digits = 2): string {
    return new Intl.NumberFormat(tag.value, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
    }).format(Number(value));
}
function price(value: string | number): string {
    const number = Number(value);
    const digits =
        number >= 1 ? 4 : Math.min(12, 3 - Math.floor(Math.log10(number)));

    return usd(number, Math.max(2, digits));
}
function amount(value: string): string {
    return new Intl.NumberFormat(tag.value, {
        maximumSignificantDigits: 6,
    }).format(Number(value));
}
function pct(value: number, signed = true): string {
    if (!Number.isFinite(value)) {
        return '—';
    }

    return `${signed && value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}
function date(value: string): string {
    return new Intl.DateTimeFormat(tag.value, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(value));
}
function tone(value: number): string {
    return value > 0
        ? 'text-emerald-500'
        : value < 0
          ? 'text-red-500'
          : 'text-muted-foreground';
}

type Stats = {
    equity: number;
    ret: number;
    trades: Trade[];
    rows: { round: Round; trade: Trade; reason: string }[];
    sells: number;
    wins: number;
    realized: number;
    drawdown: number;
    state: State;
    series: number[];
};
function statsFor(actor: string): Stats {
    let peak = initial.value;
    let drawdown = 0;
    let realized = 0;
    let sells = 0;
    let wins = 0;
    const rows: Stats['rows'] = [];
    const series = [initial.value];

    for (const round of props.rounds) {
        const row = round.result.actors[actor];

        if (!row) {
            continue;
        }

        const value = Number(row.equity);
        series.push(value);
        peak = Math.max(peak, value);
        drawdown = Math.max(drawdown, ((peak - value) / peak) * 100);

        if (row.trade) {
            rows.push({
                round,
                trade: row.trade,
                reason: round.decisions[actor]?.reason ?? '',
            });

            if (row.trade.realized !== undefined) {
                const gain = Number(row.trade.realized);
                realized += gain;
                sells += 1;
                wins += gain > 0 ? 1 : 0;
            }
        }
    }

    const state = latest.value?.result.actors[actor]?.state ?? {
        cash: props.rules.initial_cash_usd,
        positions: {},
    };
    const equity = series.at(-1) ?? initial.value;

    return {
        equity,
        ret: ((equity - initial.value) / initial.value) * 100,
        trades: rows.map((row) => row.trade),
        rows: rows.reverse(),
        sells,
        wins,
        realized,
        drawdown,
        state,
        series,
    };
}
const stats = computed(() =>
    Object.fromEntries(actors.value.map((actor) => [actor, statsFor(actor)])),
);
const benchmarkSeries = computed(() => [
    initial.value,
    ...props.rounds.map((round) => Number(round.result.benchmark.equity)),
]);
const benchmarkReturn = computed(
    () =>
        (((benchmarkSeries.value.at(-1) ?? initial.value) - initial.value) /
            initial.value) *
        100,
);
const ranking = computed(() =>
    [...actors.value].sort(
        (a, b) => stats.value[b].equity - stats.value[a].equity,
    ),
);
const current = computed(() =>
    props.agent ? (stats.value[props.agent] ?? null) : null,
);
const holdings = computed(() => {
    if (!current.value) {
        return [];
    }

    const prices = latest.value?.result.prices ?? {};

    return Object.entries(current.value.state.positions).map(
        ([token, position]) => {
            const value = Number(position.qty) * Number(prices[token] ?? 0);
            const cost = Number(position.cost);

            return {
                token,
                qty: position.qty,
                avg: cost / Number(position.qty),
                value,
                pnl: value - cost,
                pnlPct: cost ? ((value - cost) / cost) * 100 : 0,
            };
        },
    );
});
const unrealized = computed(() =>
    holdings.value.reduce((sum, row) => sum + row.pnl, 0),
);
const board = computed(() =>
    Object.entries(latest.value?.board ?? {}).sort(
        (a, b) => b[1].liquidity - a[1].liquidity,
    ),
);
const journal = computed(() => [...props.rounds].reverse());

function path(
    series: number[],
    width: number,
    height: number,
    min: number,
    max: number,
): string {
    if (series.length < 2) {
        return '';
    }

    const span = max - min || 1;

    return series
        .map((value, index) => {
            const x = (index / (series.length - 1)) * width;
            const y = height - ((value - min) / span) * height;

            return `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(' ');
}
const chartLines = computed(() => {
    const lines: { key: string; series: number[]; dashed: boolean }[] = (
        props.agent ? [props.agent] : actors.value
    ).map((actor) => ({
        key: actor,
        series: stats.value[actor]?.series ?? [],
        dashed: false,
    }));
    lines.push({
        key: 'benchmark',
        series: benchmarkSeries.value,
        dashed: true,
    });
    const all = lines.flatMap((line) => line.series);
    const min = Math.min(...all) * 0.995;
    const max = Math.max(...all) * 1.005;

    return {
        min,
        max,
        lines: lines.map((line) => ({
            ...line,
            d: path(line.series, 600, 200, min, max),
        })),
    };
});
const COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ec4899'];
function color(key: string): string {
    return key === 'benchmark'
        ? '#9ca3af'
        : COLORS[actors.value.indexOf(key) % COLORS.length];
}
function name(actor: string): string {
    return props.rules.agents[actor]?.name ?? actor;
}
function rejection(execution: string): string | null {
    if (!execution.startsWith('rejected:')) {
        return null;
    }

    return t('rejected', {
        why: t(`rejected_${execution.slice('rejected:'.length)}`),
    });
}
</script>

<template>
    <Head :title="agent ? `${name(agent)} · ${season.title}` : season.title" />
    <div class="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:py-12">
        <header class="space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <p
                    class="font-mono text-xs tracking-widest text-primary uppercase"
                >
                    {{
                        partner
                            ? t('partnerEyebrow', { partner: partner.name })
                            : t('eyebrow')
                    }}
                </p>
                <Button
                    variant="outline"
                    size="sm"
                    :aria-label="t('language')"
                    @click="toggleLocale"
                    >{{ nextTag }}</Button
                >
            </div>
            <Link
                v-if="agent"
                href="/arena"
                class="text-sm underline underline-offset-4"
                >{{ t('back') }}</Link
            >
            <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">
                {{ agent ? name(agent) : season.title }}
            </h1>
            <p v-if="agent" class="max-w-2xl text-muted-foreground">
                {{ rules.agents[agent].method }} ·
                <span class="font-mono text-xs">{{ rules.models[agent] }}</span>
            </p>
            <p v-else class="max-w-2xl text-lg text-muted-foreground">
                {{ t('intro') }}
            </p>
            <div
                v-if="partner && !agent"
                class="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4"
            >
                <img
                    v-if="partnerLogo"
                    :src="partnerLogo"
                    :alt="partner.name"
                    class="size-10 rounded-full"
                />
                <a
                    :href="partner.website"
                    target="_blank"
                    rel="noopener"
                    class="font-medium underline underline-offset-4"
                    >{{ t('partnerAbout', { partner: partner.name }) }}</a
                >
                <a
                    v-if="partner.chart"
                    :href="partner.chart"
                    target="_blank"
                    rel="noopener"
                    class="text-sm underline underline-offset-4"
                    >{{ t('partnerChart', { symbol: 'HATCHER' }) }}</a
                >
                <a
                    v-if="partner.x"
                    :href="partner.x"
                    target="_blank"
                    rel="noopener"
                    class="text-sm text-muted-foreground underline underline-offset-4"
                    >X</a
                >
                <a
                    v-if="partner.telegram"
                    :href="partner.telegram"
                    target="_blank"
                    rel="noopener"
                    class="text-sm text-muted-foreground underline underline-offset-4"
                    >Telegram</a
                >
            </div>
            <div class="flex flex-wrap items-center gap-3 text-sm">
                <span
                    class="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-primary"
                    >{{ status }}</span
                >
                <span v-if="pending" class="text-muted-foreground">{{
                    pending.status === 'collecting'
                        ? t('pending_collecting')
                        : t('pending_awaiting_fill', {
                              date: date(pending.fillDueAt),
                          })
                }}</span>
                <span
                    v-if="automation.lastTickAt"
                    class="text-xs text-muted-foreground"
                    >{{
                        t('lastTick', { date: date(automation.lastTickAt) })
                    }}</span
                >
                <span
                    v-if="!automation.enabled"
                    class="text-xs text-amber-500"
                    >{{ t('runnerOff') }}</span
                >
                <span v-if="automation.error" class="text-xs text-amber-500">{{
                    t('error', { code: automation.error })
                }}</span>
            </div>
            <p class="text-xs text-muted-foreground">
                {{
                    t('paperNote', {
                        fee: rules.fee_bps / 100,
                        slippage: rules.slippage_bps / 100,
                    })
                }}
            </p>
        </header>

        <section
            class="space-y-3 rounded-xl border border-border p-5"
            :aria-label="t('portfolioChart')"
        >
            <h2 class="font-semibold">{{ t('portfolioChart') }}</h2>
            <p v-if="rounds.length === 0" class="text-sm text-muted-foreground">
                {{ t('waiting') }}
            </p>
            <template v-else>
                <svg
                    viewBox="0 0 600 200"
                    class="h-56 w-full"
                    preserveAspectRatio="none"
                    role="img"
                    :aria-label="t('portfolioChart')"
                >
                    <line
                        :y1="
                            200 -
                            ((initial - chartLines.min) /
                                (chartLines.max - chartLines.min || 1)) *
                                200
                        "
                        :y2="
                            200 -
                            ((initial - chartLines.min) /
                                (chartLines.max - chartLines.min || 1)) *
                                200
                        "
                        x1="0"
                        x2="600"
                        stroke="currentColor"
                        class="text-border"
                        stroke-width="1"
                    />
                    <path
                        v-for="line in chartLines.lines"
                        :key="line.key"
                        :d="line.d"
                        fill="none"
                        :stroke="color(line.key)"
                        stroke-width="2"
                        vector-effect="non-scaling-stroke"
                        :stroke-dasharray="line.dashed ? '6 4' : undefined"
                    />
                </svg>
                <div class="flex flex-wrap gap-4 text-xs text-muted-foreground">
                    <span
                        v-for="line in chartLines.lines"
                        :key="line.key"
                        class="flex items-center gap-1.5"
                        ><span
                            class="inline-block h-0.5 w-4"
                            :style="{ background: color(line.key) }"
                        />{{
                            line.key === 'benchmark'
                                ? t('benchmark', { token: rules.benchmark })
                                : name(line.key)
                        }}</span
                    >
                    <span
                        >{{ usd(chartLines.min) }} –
                        {{ usd(chartLines.max) }}</span
                    >
                </div>
            </template>
        </section>

        <!-- Leaderboard -->
        <section v-if="!agent" class="space-y-3">
            <h2 class="text-xl font-semibold">{{ t('leaderboard') }}</h2>
            <div class="grid gap-4 md:grid-cols-2">
                <Link
                    v-for="(actor, index) in ranking"
                    :key="actor"
                    :href="`/arena/agents/${actor}`"
                    class="block space-y-4 rounded-xl border border-border bg-card p-5 transition hover:border-primary/50"
                >
                    <div class="flex items-center justify-between gap-2">
                        <h3 class="text-2xl font-semibold">
                            <span class="text-muted-foreground"
                                >#{{ index + 1 }}</span
                            >
                            {{ name(actor) }}
                        </h3>
                        <span class="font-mono text-xs text-muted-foreground">{{
                            rules.models[actor]
                        }}</span>
                    </div>
                    <div class="flex items-end gap-3">
                        <p class="font-mono text-3xl">
                            {{ usd(stats[actor].equity) }}
                        </p>
                        <p :class="['font-mono', tone(stats[actor].ret)]">
                            {{ pct(stats[actor].ret) }}
                        </p>
                    </div>
                    <dl
                        class="grid grid-cols-3 gap-3 border-t border-border pt-3 text-sm"
                    >
                        <div>
                            <dt class="text-muted-foreground">
                                {{ t('trades') }}
                            </dt>
                            <dd class="font-mono">
                                {{ stats[actor].trades.length }}
                            </dd>
                        </div>
                        <div>
                            <dt class="text-muted-foreground">
                                {{ t('winRate') }}
                            </dt>
                            <dd class="font-mono">
                                {{
                                    stats[actor].sells
                                        ? pct(
                                              (stats[actor].wins /
                                                  stats[actor].sells) *
                                                  100,
                                              false,
                                          )
                                        : '—'
                                }}
                            </dd>
                        </div>
                        <div>
                            <dt class="text-muted-foreground">
                                {{ t('drawdown') }}
                            </dt>
                            <dd class="font-mono">
                                {{ pct(-stats[actor].drawdown) }}
                            </dd>
                        </div>
                    </dl>
                    <p
                        v-if="latest?.decisions[actor]"
                        class="line-clamp-2 text-sm text-muted-foreground"
                    >
                        {{ t(latest.decisions[actor].action) }}
                        {{ sym(latest.decisions[actor].token) }} ·
                        {{ latest.decisions[actor].reason }}
                    </p>
                    <p class="text-sm text-primary">{{ t('openAgent') }} →</p>
                </Link>
            </div>
            <p class="text-sm text-muted-foreground">
                {{ t('benchmark', { token: rules.benchmark }) }}:
                <span class="font-mono">{{
                    usd(benchmarkSeries.at(-1) ?? initial)
                }}</span>
                <span :class="['font-mono', tone(benchmarkReturn)]">
                    {{ pct(benchmarkReturn) }}</span
                >
                · {{ t('benchmarkNote', { token: rules.benchmark }) }}
            </p>
            <div
                v-if="pending?.decisions"
                class="space-y-1 rounded-xl border border-dashed border-border p-4 text-sm"
            >
                <p class="font-medium">{{ t('committed') }}</p>
                <p
                    v-for="actor in actors"
                    :key="actor"
                    class="text-muted-foreground"
                >
                    {{ name(actor) }}: {{ t(pending.decisions[actor].action) }}
                    {{ sym(pending.decisions[actor].token) }}
                    <span v-if="pending.decisions[actor].bps"
                        >{{ pending.decisions[actor].bps / 100 }}%</span
                    >
                    · {{ pending.decisions[actor].reason }}
                </p>
                <p class="font-mono text-xs break-all text-muted-foreground">
                    {{ pending.commitHash }}
                </p>
            </div>
        </section>

        <!-- Agent detail -->
        <template v-if="agent && current">
            <section
                class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
            >
                <div class="rounded-xl border border-border p-4">
                    <p class="text-xs text-muted-foreground">
                        {{ t('equity') }}
                    </p>
                    <p class="mt-1 font-mono text-xl">
                        {{ usd(current.equity) }}
                    </p>
                </div>
                <div class="rounded-xl border border-border p-4">
                    <p class="text-xs text-muted-foreground">
                        {{ t('return') }}
                    </p>
                    <p :class="['mt-1 font-mono text-xl', tone(current.ret)]">
                        {{ pct(current.ret) }}
                    </p>
                    <p class="text-xs text-muted-foreground">
                        {{ t('benchmark', { token: rules.benchmark }) }}
                        {{ pct(benchmarkReturn) }}
                    </p>
                </div>
                <div class="rounded-xl border border-border p-4">
                    <p class="text-xs text-muted-foreground">
                        {{ t('realized') }}
                    </p>
                    <p
                        :class="[
                            'mt-1 font-mono text-xl',
                            tone(current.realized),
                        ]"
                    >
                        {{ usd(current.realized) }}
                    </p>
                </div>
                <div class="rounded-xl border border-border p-4">
                    <p class="text-xs text-muted-foreground">
                        {{ t('unrealized') }}
                    </p>
                    <p :class="['mt-1 font-mono text-xl', tone(unrealized)]">
                        {{ usd(unrealized) }}
                    </p>
                </div>
                <div class="rounded-xl border border-border p-4">
                    <p class="text-xs text-muted-foreground">
                        {{ t('winRate') }}
                    </p>
                    <p class="mt-1 font-mono text-xl">
                        {{
                            current.sells
                                ? pct(
                                      (current.wins / current.sells) * 100,
                                      false,
                                  )
                                : '—'
                        }}
                    </p>
                    <p class="text-xs text-muted-foreground">
                        {{ t('trades') }}: {{ current.trades.length }}
                    </p>
                </div>
                <div class="rounded-xl border border-border p-4">
                    <p class="text-xs text-muted-foreground">
                        {{ t('drawdown') }}
                    </p>
                    <p class="mt-1 font-mono text-xl">
                        {{ pct(-current.drawdown) }}
                    </p>
                </div>
            </section>

            <section class="space-y-3">
                <h2 class="text-xl font-semibold">{{ t('holdings') }}</h2>
                <div class="overflow-x-auto rounded-xl border border-border">
                    <table class="w-full text-sm">
                        <thead
                            class="bg-muted/30 text-left text-xs text-muted-foreground"
                        >
                            <tr>
                                <th class="p-3">{{ t('token') }}</th>
                                <th class="p-3 text-right">{{ t('qty') }}</th>
                                <th class="p-3 text-right">
                                    {{ t('avgCost') }}
                                </th>
                                <th class="p-3 text-right">{{ t('price') }}</th>
                                <th class="p-3 text-right">{{ t('value') }}</th>
                                <th class="p-3 text-right">{{ t('pnl') }}</th>
                            </tr>
                        </thead>
                        <tbody class="font-mono">
                            <tr
                                v-for="row in holdings"
                                :key="row.token"
                                class="border-t border-border"
                            >
                                <td class="p-3 font-sans font-medium">
                                    {{ sym(row.token) }}
                                </td>
                                <td class="p-3 text-right">
                                    {{ amount(row.qty) }}
                                </td>
                                <td class="p-3 text-right">
                                    {{ price(row.avg) }}
                                </td>
                                <td class="p-3 text-right">
                                    {{
                                        price(
                                            latest?.result.prices[row.token] ??
                                                0,
                                        )
                                    }}
                                </td>
                                <td class="p-3 text-right">
                                    {{ usd(row.value) }}
                                </td>
                                <td :class="['p-3 text-right', tone(row.pnl)]">
                                    {{ usd(row.pnl) }} ({{ pct(row.pnlPct) }})
                                </td>
                            </tr>
                            <tr class="border-t border-border">
                                <td class="p-3 font-sans font-medium">
                                    {{ t('cash') }}
                                </td>
                                <td colspan="3" />
                                <td class="p-3 text-right">
                                    {{ usd(current.state.cash) }}
                                </td>
                                <td />
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p
                    v-if="!holdings.length"
                    class="text-sm text-muted-foreground"
                >
                    {{ t('noHoldings') }}
                </p>
            </section>

            <section class="space-y-3">
                <h2 class="text-xl font-semibold">{{ t('tradeLog') }}</h2>
                <p
                    v-if="!current.rows.length"
                    class="text-sm text-muted-foreground"
                >
                    {{ t('noTrades') }}
                </p>
                <div
                    v-else
                    class="overflow-x-auto rounded-xl border border-border"
                >
                    <table class="w-full text-sm">
                        <thead
                            class="bg-muted/30 text-left text-xs text-muted-foreground"
                        >
                            <tr>
                                <th class="p-3">{{ t('time') }}</th>
                                <th class="p-3">{{ t('side') }}</th>
                                <th class="p-3">{{ t('token') }}</th>
                                <th class="p-3 text-right">{{ t('size') }}</th>
                                <th class="p-3 text-right">{{ t('qty') }}</th>
                                <th class="p-3 text-right">
                                    {{ t('fillPrice') }}
                                </th>
                                <th class="p-3 text-right">
                                    {{ t('amountUsd') }}
                                </th>
                                <th class="p-3 text-right">{{ t('pnl') }}</th>
                                <th class="p-3">{{ t('reason') }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="row in current.rows"
                                :key="row.round.sequence"
                                class="border-t border-border align-top"
                            >
                                <td
                                    class="p-3 text-xs whitespace-nowrap text-muted-foreground"
                                >
                                    {{ date(row.round.filledAt) }}
                                </td>
                                <td
                                    :class="[
                                        'p-3 font-medium',
                                        row.trade.action === 'buy'
                                            ? 'text-emerald-500'
                                            : 'text-red-500',
                                    ]"
                                >
                                    {{ t(row.trade.action) }}
                                </td>
                                <td class="p-3 font-medium">
                                    {{
                                        row.trade.symbol ?? sym(row.trade.token)
                                    }}
                                </td>
                                <td class="p-3 text-right font-mono">
                                    {{ row.trade.bps / 100 }}%
                                </td>
                                <td class="p-3 text-right font-mono">
                                    {{ amount(row.trade.qty) }}
                                </td>
                                <td class="p-3 text-right font-mono">
                                    {{ price(row.trade.price) }}
                                </td>
                                <td class="p-3 text-right font-mono">
                                    {{ usd(row.trade.value) }}
                                </td>
                                <td
                                    :class="[
                                        'p-3 text-right font-mono',
                                        tone(Number(row.trade.realized ?? 0)),
                                    ]"
                                >
                                    {{
                                        row.trade.realized === undefined
                                            ? '—'
                                            : usd(row.trade.realized)
                                    }}
                                </td>
                                <td
                                    class="min-w-64 p-3 text-xs text-muted-foreground"
                                >
                                    {{ row.reason }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>

            <section class="space-y-3">
                <h2 class="text-xl font-semibold">{{ t('journal') }}</h2>
                <p class="text-sm text-muted-foreground">
                    {{ t('journalNote') }}
                </p>
                <article
                    v-for="round in journal"
                    :key="round.sequence"
                    class="space-y-1 rounded-xl border border-border p-4"
                >
                    <div class="flex flex-wrap justify-between gap-2 text-sm">
                        <span class="font-medium"
                            >{{ t('round', { number: round.sequence }) }} ·
                            {{ t(round.decisions[agent].action) }}
                            {{ sym(round.decisions[agent].token) }}
                            <span v-if="round.decisions[agent].bps"
                                >{{ round.decisions[agent].bps / 100 }}%</span
                            ></span
                        >
                        <span class="text-xs text-muted-foreground">{{
                            date(round.filledAt)
                        }}</span>
                    </div>
                    <p
                        class="text-sm whitespace-pre-wrap text-muted-foreground"
                    >
                        {{ round.decisions[agent].reason }}
                    </p>
                    <p
                        v-if="rejection(round.result.actors[agent].execution)"
                        class="text-xs text-amber-500"
                    >
                        {{ rejection(round.result.actors[agent].execution) }}
                    </p>
                    <p class="font-mono text-xs text-muted-foreground">
                        {{ usd(round.result.actors[agent].equity) }} ·
                        <span class="break-all"
                            >{{ round.recordHash.slice(0, 16) }}…</span
                        >
                    </p>
                </article>
            </section>
        </template>

        <!-- Open league -->
        <section v-if="!agent" class="space-y-3">
            <h2 class="text-xl font-semibold">{{ t('league') }}</h2>
            <p class="max-w-3xl text-sm text-muted-foreground">
                {{ t('leagueLead') }}
            </p>
            <div class="overflow-x-auto rounded-xl border border-border">
                <table class="w-full text-sm">
                    <thead
                        class="bg-muted/30 text-left text-xs text-muted-foreground"
                    >
                        <tr>
                            <th class="p-3">{{ t('agentCol') }}</th>
                            <th class="p-3 text-right">{{ t('tradesCol') }}</th>
                            <th class="p-3 text-right">
                                {{ t('realizedCol') }}
                            </th>
                            <th class="p-3 text-right">
                                {{ t('unrealizedCol') }}
                            </th>
                            <th class="p-3 text-right">{{ t('volumeCol') }}</th>
                            <th class="p-3 text-right">{{ t('lastCol') }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr
                            v-for="row in league"
                            :key="row.slug"
                            class="border-t border-border"
                        >
                            <td class="p-3">
                                <Link
                                    :href="`/arena/agents/${row.slug}`"
                                    class="font-medium text-primary underline-offset-4 hover:underline"
                                    >{{ row.name }}</Link
                                >
                                <span
                                    v-if="row.framework"
                                    class="ml-2 text-xs text-muted-foreground"
                                    >{{ row.framework }}</span
                                >
                                <span
                                    class="ml-2 text-xs text-muted-foreground"
                                    >{{ row.chains.join(', ') }}</span
                                >
                            </td>
                            <td class="p-3 text-right font-mono">
                                {{ row.trades }}
                            </td>
                            <td class="p-3 text-right font-mono">
                                {{ realizedText(row.realized) }}
                            </td>
                            <td
                                :class="[
                                    'p-3 text-right font-mono',
                                    tone(Number(row.unrealizedUsd)),
                                ]"
                            >
                                {{ usd(row.unrealizedUsd) }}
                            </td>
                            <td class="p-3 text-right font-mono">
                                {{ usd(row.volumeUsd, 0) }}
                            </td>
                            <td class="p-3 text-right text-xs">
                                {{
                                    row.lastTradeAt ? date(row.lastTradeAt) : ''
                                }}
                            </td>
                        </tr>
                        <tr v-if="!league.length">
                            <td colspan="6" class="p-3 text-muted-foreground">
                                {{ t('leagueEmpty') }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <details
                class="rounded-xl border border-border bg-muted/20 p-4 text-sm"
            >
                <summary class="cursor-pointer font-medium">
                    {{ t('connect') }}
                </summary>
                <div class="mt-3 space-y-2">
                    <p>
                        {{
                            t('connectMcp', { url: `${origin}/api/arena/mcp` })
                        }}
                    </p>
                    <p>{{ t('connectStep1') }}</p>
                    <pre
                        class="overflow-x-auto rounded-lg bg-background p-3 text-xs"
                        >{{
                            `curl -X POST ${origin}/api/arena/agents \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"My Agent","framework":"ElizaOS","website":"https://example.com"}'`
                        }}</pre
                    >
                    <p>{{ t('connectStep2') }}</p>
                    <pre
                        class="overflow-x-auto rounded-lg bg-background p-3 text-xs"
                        >{{
                            `curl -X POST ${origin}/api/arena/trades \\
  -H 'Authorization: Bearer arena_…' -H 'Content-Type: application/json' \\
  -d '{"id":"tx-1","side":"buy","chain":"solana",
       "token":"Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump","symbol":"HATCHER",
       "qty":"125000","quote":{"symbol":"SOL","amount":"0.5"},
       "tx":"5Kx…","paper":false,"reason":"why","at":"2026-11-03T12:00:00Z"}'`
                        }}</pre
                    >
                    <p class="text-muted-foreground">{{ t('connectNote') }}</p>
                </div>
            </details>
        </section>

        <section class="space-y-3">
            <h2 class="text-xl font-semibold">{{ t('board') }}</h2>
            <div class="overflow-x-auto rounded-xl border border-border">
                <table class="w-full text-sm">
                    <thead
                        class="bg-muted/30 text-left text-xs text-muted-foreground"
                    >
                        <tr>
                            <th class="p-3">{{ t('token') }}</th>
                            <th class="p-3 text-right">{{ t('price') }}</th>
                            <th class="p-3 text-right">{{ t('change') }}</th>
                            <th class="p-3 text-right">{{ t('liquidity') }}</th>
                            <th class="p-3" />
                        </tr>
                    </thead>
                    <tbody class="font-mono">
                        <tr
                            v-for="[token, row] in board"
                            :key="token"
                            class="border-t border-border"
                        >
                            <td class="p-3 font-sans font-medium">
                                {{ row.symbol ?? sym(token) }}
                            </td>
                            <td class="p-3 text-right">{{ price(row.usd) }}</td>
                            <td :class="['p-3 text-right', tone(row.change)]">
                                {{ pct(row.change) }}
                            </td>
                            <td class="p-3 text-right">
                                {{ usd(row.liquidity, 0) }}
                            </td>
                            <td class="p-3 text-right font-sans">
                                <a
                                    :href="`https://dexscreener.com/solana/${row.pair}`"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-xs underline underline-offset-4"
                                    >{{ t('chart') }}</a
                                >
                            </td>
                        </tr>
                        <tr v-if="!board.length">
                            <td
                                colspan="5"
                                class="p-3 font-sans text-muted-foreground"
                            >
                                {{
                                    rules.anchors
                                        .map((token) => token.symbol)
                                        .join(', ')
                                }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>

        <section
            class="space-y-2 rounded-xl border border-border bg-muted/20 p-5 text-sm"
        >
            <h2 class="text-lg font-semibold">{{ t('rules') }}</h2>
            <ul class="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                    {{
                        t('rule1', {
                            days: rules.days,
                            rounds: rules.rounds_per_day,
                            cash: rules.initial_cash_usd,
                        })
                    }}
                </li>
                <li>{{ t('rule2') }}</li>
                <li>{{ t('rule3') }}</li>
                <li>
                    {{
                        t('rule4', {
                            tokens: rules.anchors
                                .map((token) => token.symbol)
                                .join(', '),
                            liquidity: rules.min_liquidity_usd,
                        })
                    }}
                </li>
            </ul>
            <a
                href="/arena/evidence"
                class="inline-block text-primary underline underline-offset-4"
                >{{ t('evidence') }}</a
            >
            <p class="font-mono text-xs break-all text-muted-foreground">
                {{ season.rulesHash }}
            </p>
        </section>
    </div>
</template>
