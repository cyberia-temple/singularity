<script setup lang="ts">
import { Head, Link, usePoll } from '@inertiajs/vue3';
import { computed } from 'vue';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/composables/useLocale';
import { arenaMultiMessages } from '@/lib/arenaMultiMessages';

type Position = {
    chain: string;
    token: string;
    symbol: string;
    quote: string;
    qty: string;
    cost: string;
    cost_usd: string;
    usd_known: boolean;
    paper: boolean;
    mark_usd: string | null;
    value_usd: string | null;
    unrealized_usd: string | null;
};
type TradeRow = {
    id: string;
    side: 'buy' | 'sell';
    chain: string;
    token: string;
    symbol: string;
    qty: string;
    quote: string;
    amount: string;
    price_usd: string | null;
    value_usd: string | null;
    pnl: string | null;
    pnl_usd: string | null;
    tx: string | null;
    tx_url: string | null;
    paper: boolean;
    reason: string | null;
    at: string;
};

const props = defineProps<{
    agent: {
        slug: string;
        name: string;
        framework: string | null;
        description: string | null;
        website: string | null;
        owner: string | null;
        registeredAt: string;
        lastTradeAt: string | null;
    };
    book: {
        positions: Position[];
        realized: Record<string, string>;
        realized_usd: string;
        unrealized_usd: string;
        open_value_usd: string;
        volume_usd: string;
        counts: {
            trades: number;
            buys: number;
            sells: number;
            wins: number;
            closed: number;
            paper: number;
            tokens: number;
            chains: string[];
        };
        series: {
            at: string;
            realized: Record<string, string>;
            realized_usd: string;
            volume_usd: string;
        }[];
        trades: TradeRow[];
        first_at: string | null;
        priced_at: string;
    };
    season: { title: string } | null;
}>();

const { t, tag, nextTag, toggleLocale } = useLocale(arenaMultiMessages);
usePoll(30000, { only: ['book', 'agent'] });

const DEX: Record<string, string> = {
    solana: 'solana',
    robinhood: 'robinhood',
    base: 'base',
    bnb: 'bsc',
    ethereum: 'ethereum',
};

function usd(value: number | string | null, digits = 2): string {
    if (value === null) {
        return '—';
    }

    return new Intl.NumberFormat(tag.value, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
    }).format(Number(value));
}
function price(value: string | number | null): string {
    if (value === null || !Number(value)) {
        return '—';
    }

    const number = Number(value);
    const digits =
        number >= 1 ? 4 : Math.min(12, 3 - Math.floor(Math.log10(number)));

    return usd(number, Math.max(2, digits));
}
function amount(value: string | number): string {
    return new Intl.NumberFormat(tag.value, {
        maximumSignificantDigits: 6,
    }).format(Number(value));
}
function signed(value: string | null, symbol: string): string {
    if (value === null) {
        return '—';
    }

    return `${Number(value) >= 0 ? '+' : ''}${amount(value)} ${symbol}`;
}
function date(value: string): string {
    return new Intl.DateTimeFormat(tag.value, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(value));
}
function tone(value: number | string | null): string {
    const number = Number(value ?? 0);

    return number > 0
        ? 'text-emerald-500'
        : number < 0
          ? 'text-red-500'
          : 'text-muted-foreground';
}
function short(value: string): string {
    return value.length > 14
        ? `${value.slice(0, 6)}…${value.slice(-4)}`
        : value;
}
function chartUrl(chain: string, token: string): string | null {
    return DEX[chain] ? `https://dexscreener.com/${DEX[chain]}/${token}` : null;
}

/** The currency most of the trades were paid in: what the chart is drawn in. */
const primary = computed(() => {
    const counts: Record<string, number> = {};

    for (const row of props.book.trades) {
        counts[row.quote] = (counts[row.quote] ?? 0) + 1;
    }

    return (
        Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ??
        Object.keys(props.book.realized)[0] ??
        'USD'
    );
});
const realizedEntries = computed(() => Object.entries(props.book.realized));
const series = computed(() =>
    props.book.series.map((point) => ({
        at: new Date(point.at).getTime(),
        value: Number(point.realized[primary.value] ?? 0),
    })),
);
const chart = computed(() => {
    const points = series.value;

    if (
        points.length < 2 ||
        !props.book.counts.sells ||
        points.every((point) => point.value === 0)
    ) {
        return null;
    }

    const width = 800;
    const height = 240;
    const values = points.map((point) => point.value);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const span = max - min || 1;
    const start = points[0].at;
    const range = points.at(-1)!.at - start || 1;
    const x = (at: number) => ((at - start) / range) * width;
    const y = (value: number) => height - ((value - min) / span) * height;
    const line = points
        .map(
            (point, index) =>
                `${index ? 'L' : 'M'}${x(point.at).toFixed(1)},${y(point.value).toFixed(1)}`,
        )
        .join(' ');

    return {
        width,
        height,
        line,
        area: `${line} L${width},${y(0).toFixed(1)} L0,${y(0).toFixed(1)} Z`,
        zero: y(0),
        last: values.at(-1) ?? 0,
        min,
        max,
    };
});
const winRate = computed(() =>
    props.book.counts.closed
        ? `${Math.round((props.book.counts.wins / props.book.counts.closed) * 100)}% · ${props.book.counts.wins}/${props.book.counts.closed}`
        : '—',
);
</script>

<template>
    <Head :title="`${agent.name} · ${season?.title ?? 'Arena'}`" />
    <div class="mx-auto max-w-6xl space-y-8 px-4 py-8 sm:py-12">
        <header class="space-y-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <p
                    class="font-mono text-xs tracking-widest text-primary uppercase"
                >
                    {{ t('league') }}
                </p>
                <Button
                    variant="outline"
                    size="sm"
                    :aria-label="t('language')"
                    @click="toggleLocale"
                    >{{ nextTag }}</Button
                >
            </div>
            <Link href="/arena" class="text-sm underline underline-offset-4">{{
                t('back')
            }}</Link>
            <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">
                {{ agent.name }}
                <span
                    v-if="agent.framework"
                    class="align-middle text-base font-normal text-muted-foreground"
                    >{{ agent.framework }}</span
                >
            </h1>
            <p
                v-if="agent.description"
                class="max-w-3xl text-lg text-muted-foreground"
            >
                {{ agent.description }}
            </p>
            <p
                class="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground"
            >
                <span>{{
                    t('agentRegistered', { date: date(agent.registeredAt) })
                }}</span>
                <a
                    v-if="agent.website"
                    :href="agent.website"
                    target="_blank"
                    rel="noopener nofollow"
                    class="underline underline-offset-4"
                    >{{ agent.website.replace(/^https:\/\//, '') }}</a
                >
                <span v-if="agent.owner" class="font-mono">{{
                    short(agent.owner)
                }}</span>
            </p>
            <p class="max-w-3xl text-xs text-muted-foreground">
                {{ t('agentHonesty') }}
            </p>
        </header>

        <section class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div class="rounded-xl border border-border bg-card p-4">
                <p class="text-xs text-muted-foreground">
                    {{ t('statRealized') }}
                </p>
                <p
                    v-for="[symbol, value] in realizedEntries"
                    :key="symbol"
                    :class="['font-mono text-2xl', tone(value)]"
                >
                    {{ signed(value, symbol) }}
                </p>
                <p v-if="!realizedEntries.length" class="font-mono text-2xl">
                    —
                </p>
                <p
                    v-if="Number(book.realized_usd)"
                    :class="['font-mono text-sm', tone(book.realized_usd)]"
                >
                    ≈ {{ usd(book.realized_usd) }}
                </p>
            </div>
            <div class="rounded-xl border border-border bg-card p-4">
                <p class="text-xs text-muted-foreground">{{ t('statOpen') }}</p>
                <p class="font-mono text-2xl">
                    {{ usd(book.open_value_usd) }}
                </p>
                <p class="text-sm text-muted-foreground">
                    {{
                        t('statOpenSub', {
                            count: book.positions.length,
                            pnl: usd(book.unrealized_usd),
                        })
                    }}
                </p>
            </div>
            <div class="rounded-xl border border-border bg-card p-4">
                <p class="text-xs text-muted-foreground">
                    {{ t('statTrades') }}
                </p>
                <p class="font-mono text-2xl">{{ book.counts.trades }}</p>
                <p class="text-sm text-muted-foreground">
                    {{
                        t('statTradesSub', {
                            buys: book.counts.buys,
                            sells: book.counts.sells,
                        })
                    }}
                    <template v-if="book.counts.paper">
                        · {{ t('statPaper', { count: book.counts.paper }) }}
                    </template>
                </p>
            </div>
            <div class="rounded-xl border border-border bg-card p-4">
                <p class="text-xs text-muted-foreground">{{ t('statWin') }}</p>
                <p class="font-mono text-2xl">{{ winRate }}</p>
            </div>
            <div class="rounded-xl border border-border bg-card p-4">
                <p class="text-xs text-muted-foreground">
                    {{ t('statVolume') }}
                </p>
                <p class="font-mono text-2xl">
                    {{ usd(book.volume_usd, 0) }}
                </p>
            </div>
            <div class="rounded-xl border border-border bg-card p-4">
                <p class="text-xs text-muted-foreground">
                    {{ t('statChains') }}
                </p>
                <p class="text-2xl">
                    {{ book.counts.chains.join(', ') || '—' }} ·
                    {{ book.counts.tokens }}
                </p>
            </div>
        </section>

        <section class="space-y-3">
            <h2 class="text-xl font-semibold">
                {{ t('chartRealized', { symbol: primary }) }}
            </h2>
            <div class="rounded-xl border border-border bg-card p-4">
                <svg
                    v-if="chart"
                    :viewBox="`0 0 ${chart.width} ${chart.height}`"
                    class="h-60 w-full"
                    preserveAspectRatio="none"
                    role="img"
                >
                    <line
                        x1="0"
                        :x2="chart.width"
                        :y1="chart.zero"
                        :y2="chart.zero"
                        class="stroke-border"
                        stroke-dasharray="4 4"
                    />
                    <path
                        :d="chart.area"
                        :class="
                            chart.last >= 0
                                ? 'fill-emerald-500/10'
                                : 'fill-red-500/10'
                        "
                    />
                    <path
                        :d="chart.line"
                        fill="none"
                        stroke-width="2"
                        vector-effect="non-scaling-stroke"
                        :class="
                            chart.last >= 0
                                ? 'stroke-emerald-500'
                                : 'stroke-red-500'
                        "
                    />
                </svg>
                <p v-else class="p-6 text-center text-sm text-muted-foreground">
                    {{ t('chartEmpty') }}
                </p>
                <p
                    v-if="chart"
                    class="flex justify-between font-mono text-xs text-muted-foreground"
                >
                    <span>{{ book.first_at ? date(book.first_at) : '' }}</span>
                    <span
                        >{{ signed(String(chart.min), primary) }} …
                        {{ signed(String(chart.max), primary) }}</span
                    >
                    <span>{{
                        agent.lastTradeAt ? date(agent.lastTradeAt) : ''
                    }}</span>
                </p>
            </div>
        </section>

        <section class="space-y-3">
            <h2 class="text-xl font-semibold">{{ t('positions') }}</h2>
            <div class="overflow-x-auto rounded-xl border border-border">
                <table class="w-full text-sm">
                    <thead
                        class="bg-muted/30 text-left text-xs text-muted-foreground"
                    >
                        <tr>
                            <th class="p-3">{{ t('token') }}</th>
                            <th class="p-3">{{ t('chainCol') }}</th>
                            <th class="p-3 text-right">{{ t('qtyCol') }}</th>
                            <th class="p-3 text-right">{{ t('costCol') }}</th>
                            <th class="p-3 text-right">{{ t('markCol') }}</th>
                            <th class="p-3 text-right">{{ t('valueCol') }}</th>
                            <th class="p-3 text-right">{{ t('pnlCol') }}</th>
                        </tr>
                    </thead>
                    <tbody class="font-mono">
                        <tr
                            v-for="row in book.positions"
                            :key="`${row.chain}:${row.token}`"
                            class="border-t border-border"
                        >
                            <td class="p-3 font-sans">
                                <a
                                    v-if="chartUrl(row.chain, row.token)"
                                    :href="chartUrl(row.chain, row.token)!"
                                    target="_blank"
                                    rel="noopener"
                                    class="font-medium underline-offset-4 hover:underline"
                                    >{{ row.symbol }}</a
                                >
                                <span v-else class="font-medium">{{
                                    row.symbol
                                }}</span>
                                <span
                                    class="ml-2 text-xs text-muted-foreground"
                                    >{{ short(row.token) }}</span
                                >
                                <span
                                    v-if="row.paper"
                                    class="ml-2 text-xs text-amber-500"
                                    >{{ t('paper') }}</span
                                >
                            </td>
                            <td class="p-3 font-sans">{{ row.chain }}</td>
                            <td class="p-3 text-right">
                                {{ amount(row.qty) }}
                            </td>
                            <td class="p-3 text-right">
                                {{ amount(row.cost) }} {{ row.quote }}
                                <span
                                    v-if="row.usd_known && Number(row.cost_usd)"
                                    class="block text-xs text-muted-foreground"
                                    >{{ usd(row.cost_usd) }}</span
                                >
                            </td>
                            <td class="p-3 text-right">
                                {{
                                    row.mark_usd
                                        ? price(row.mark_usd)
                                        : t('unpriced')
                                }}
                            </td>
                            <td class="p-3 text-right">
                                {{ usd(row.value_usd) }}
                            </td>
                            <td
                                :class="[
                                    'p-3 text-right',
                                    tone(row.unrealized_usd),
                                ]"
                            >
                                {{ usd(row.unrealized_usd) }}
                            </td>
                        </tr>
                        <tr v-if="!book.positions.length">
                            <td
                                colspan="7"
                                class="p-3 font-sans text-muted-foreground"
                            >
                                {{ t('positionsEmpty') }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>

        <section class="space-y-3">
            <h2 class="text-xl font-semibold">{{ t('tradeLog') }}</h2>
            <div class="overflow-x-auto rounded-xl border border-border">
                <table class="w-full text-sm">
                    <thead
                        class="bg-muted/30 text-left text-xs text-muted-foreground"
                    >
                        <tr>
                            <th class="p-3">{{ t('timeCol') }}</th>
                            <th class="p-3">{{ t('sideCol') }}</th>
                            <th class="p-3">{{ t('token') }}</th>
                            <th class="p-3 text-right">{{ t('qtyCol') }}</th>
                            <th class="p-3 text-right">{{ t('paidCol') }}</th>
                            <th class="p-3 text-right">{{ t('pnlCol') }}</th>
                            <th class="p-3">{{ t('proofCol') }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <template v-for="row in book.trades" :key="row.id">
                            <tr class="border-t border-border">
                                <td class="p-3 text-xs whitespace-nowrap">
                                    {{ date(row.at) }}
                                </td>
                                <td
                                    :class="[
                                        'p-3 font-medium',
                                        row.side === 'buy'
                                            ? 'text-emerald-500'
                                            : 'text-red-500',
                                    ]"
                                >
                                    {{ t(row.side) }}
                                </td>
                                <td class="p-3">
                                    <span class="font-medium">{{
                                        row.symbol
                                    }}</span>
                                    <span
                                        class="ml-1 text-xs text-muted-foreground"
                                        >{{ row.chain }}</span
                                    >
                                </td>
                                <td class="p-3 text-right font-mono">
                                    {{ amount(row.qty) }}
                                </td>
                                <td class="p-3 text-right font-mono">
                                    {{ amount(row.amount) }} {{ row.quote }}
                                    <span
                                        v-if="row.value_usd"
                                        class="block text-xs text-muted-foreground"
                                        >{{ usd(row.value_usd) }}</span
                                    >
                                </td>
                                <td
                                    :class="[
                                        'p-3 text-right font-mono',
                                        tone(row.pnl),
                                    ]"
                                >
                                    {{
                                        row.side === 'sell'
                                            ? signed(row.pnl, row.quote)
                                            : ''
                                    }}
                                </td>
                                <td class="p-3 text-xs">
                                    <a
                                        v-if="row.tx_url"
                                        :href="row.tx_url"
                                        target="_blank"
                                        rel="noopener"
                                        class="font-mono underline underline-offset-4"
                                        >{{ short(row.tx ?? '') }}</a
                                    >
                                    <span
                                        v-else-if="row.paper"
                                        class="text-amber-500"
                                        >{{ t('paper') }}</span
                                    >
                                    <span
                                        v-else-if="row.tx"
                                        class="font-mono text-muted-foreground"
                                        >{{ short(row.tx) }}</span
                                    >
                                </td>
                            </tr>
                            <tr v-if="row.reason">
                                <td
                                    colspan="7"
                                    class="px-3 pb-3 text-xs text-muted-foreground"
                                >
                                    {{ row.reason }}
                                </td>
                            </tr>
                        </template>
                        <tr v-if="!book.trades.length">
                            <td colspan="7" class="p-3 text-muted-foreground">
                                {{ t('tradesEmpty') }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </section>
    </div>
</template>
