<script setup lang="ts">
import { computed } from 'vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { walletChain } from '@/lib/wallet';
import type { WalletChainId } from '@/lib/wallet';
import { formatUsd, usdValue } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * What this vault is actually made of.
 *
 * Every number here is computed in this browser from balances it already read
 * and prices the page already has; nothing about the composition of a wallet
 * is sent anywhere to be analysed. That is also the limit of the screen: there
 * is no server keeping a history of this vault, so there is no value-over-time
 * curve — only what is held right now, and the transfers the chains' own
 * indexes will still tell us about.
 *
 * Anything that could not be priced is counted separately rather than folded
 * in at zero, because a share of a total that silently omits a holding is a
 * wrong answer stated confidently.
 */

const props = defineProps<{
    wallet: MultiWallet;
    prices: Record<string, number | null>;
    /** Chain id → (lowercased contract → USD price). */
    tokenPrices: Record<string, Record<string, number>>;
}>();

const emit = defineEmits<{ back: [] }>();

const { locale, t } = useLocale(walletMessages);

const hue = (chain: WalletChainId): string => {
    try {
        return walletChain(chain).mark.hue;
    } catch {
        return 'var(--cw-net-custom)';
    }
};

type Slice = {
    key: string;
    label: string;
    sub: string;
    usd: number | null;
    hue: string;
    /** Tokens ride on their network's hue at lower weight. */
    token: boolean;
};

/**
 * The coin of each network, at whatever the page last quoted it.
 *
 * Networks the browser cannot read — Monero, without a view-key scanner — are
 * kept in the list with a null value rather than dropped. They hold whatever
 * they hold; leaving them out silently would make a partial total look whole.
 */
const coins = computed<Slice[]>(() =>
    props.wallet.accounts.value.map((account) => ({
        key: account.chain,
        label: account.symbol,
        sub: account.label,
        usd: usdValue(
            props.wallet.balances.value[account.chain]?.value ?? null,
            account.decimals,
            props.prices[account.chain] ?? null,
        ),
        hue: hue(account.chain),
        token: false,
    })),
);

const tokens = computed<Slice[]>(() =>
    props.wallet.accounts.value.flatMap((account) =>
        (props.wallet.tokens.value[account.chain]?.items ?? []).map(
            (token) => ({
                key: `${account.chain}:${token.address.toLowerCase()}`,
                label: token.symbol,
                sub: account.label,
                usd: usdValue(
                    token.balance,
                    token.decimals,
                    props.tokenPrices[account.chain]?.[
                        token.address.toLowerCase()
                    ] ?? null,
                ),
                hue: hue(account.chain),
                token: true,
            }),
        ),
    ),
);

const sum = (slices: Slice[]): number =>
    slices.reduce((carry, slice) => carry + (slice.usd ?? 0), 0);

const coinsTotal = computed(() => sum(coins.value));
const tokensTotal = computed(() => sum(tokens.value));
const total = computed(() => coinsTotal.value + tokensTotal.value);

/** Holdings the total leaves out: nothing quotes them, or nothing read them. */
const unpriced = computed(
    () =>
        [...coins.value, ...tokens.value].filter((slice) => slice.usd === null)
            .length,
);

/**
 * Allocation, largest first. A holding worth nothing takes no width and would
 * only push the ones that matter off the screen, so the list is what is
 * actually in the book.
 */
const allocation = computed(() => {
    const rows = [...coins.value, ...tokens.value]
        .filter((slice) => (slice.usd ?? 0) > 0)
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));

    return rows.map((slice) => ({
        ...slice,
        share: total.value > 0 ? (100 * (slice.usd ?? 0)) / total.value : 0,
    }));
});

const largest = computed(() => allocation.value[0] ?? null);

/** The chains that can answer "what moved here" without an API key. */
const indexed = computed(() =>
    props.wallet.accounts.value.filter(
        (account) => walletChain(account.chain).fetchHistory !== undefined,
    ),
);

const transfers = computed(() =>
    Object.values(props.wallet.history.value).flatMap((entry) => entry.items),
);

const networks = computed(() => props.wallet.accounts.value.length);

const DAY = 86_400;

/**
 * One bucket per day for the last week, oldest first. Only transfers the
 * source timestamped are counted — an undated one would land on whichever day
 * we guessed, which is worse than being absent from a bar chart.
 */
const week = computed(() => {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const today = Math.floor(midnight.getTime() / 1000);
    const weekday = new Intl.DateTimeFormat(locale.value, { weekday: 'short' });

    const days = Array.from({ length: 7 }, (_, index) => {
        const start = today - (6 - index) * DAY;

        return {
            start,
            label: weekday.format(new Date(start * 1000)),
            count: transfers.value.filter(
                (tx) =>
                    tx.timestamp !== null &&
                    tx.timestamp >= start &&
                    tx.timestamp < start + DAY,
            ).length,
        };
    });

    const peak = Math.max(...days.map((day) => day.count), 1);

    return days.map((day) => ({
        ...day,
        // A day with movement is never a hairline: the bar is a count, and one
        // transfer has to be visible next to a day with ten.
        height: day.count === 0 ? 0 : Math.max(8, (100 * day.count) / peak),
    }));
});

const weekTotal = computed(() =>
    week.value.reduce((carry, day) => carry + day.count, 0),
);

const stats = computed(() => [
    {
        key: 'networks',
        label: t('statNetworks'),
        value: String(networks.value),
        tone: 'var(--cw-text)',
    },
    {
        key: 'tokens',
        label: t('statTokens'),
        value: String(tokens.value.length),
        tone: 'var(--cw-text)',
    },
    {
        key: 'largest',
        label: t('statLargest'),
        value:
            largest.value === null
                ? '—'
                : `${largest.value.label} ${largest.value.share.toFixed(1)}%`,
        tone: 'var(--cw-text)',
    },
    {
        key: 'unpriced',
        label: t('statUnpriced'),
        value: String(unpriced.value),
        tone: unpriced.value > 0 ? 'var(--cw-pending)' : 'var(--cw-text)',
    },
    {
        key: 'transfers',
        label: t('statTransfers'),
        value: String(weekTotal.value),
        tone: 'var(--cw-text)',
    },
    {
        key: 'sources',
        label: t('statSources'),
        value: `${indexed.value.length} / ${networks.value}`,
        tone: 'var(--cw-text)',
    },
]);
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ t('navAnalytics') }}
        </h2>
        <p class="cw-prose">{{ t('analyticsBody') }}</p>

        <div class="cw-label" style="margin-top: 22px">{{ t('netWorth') }}</div>
        <div style="margin-top: 10px">
            <span
                class="cw-total"
                :style="unpriced > 0 ? { color: 'var(--cw-muted)' } : undefined"
                >{{ formatUsd(total, locale) }}</span
            >
        </div>
        <div
            v-if="unpriced > 0"
            style="
                margin-top: 8px;
                font: 500 13px/1.5 var(--cw-mono);
                color: var(--cw-pending);
            "
        >
            {{ t('analyticsPartial', { count: unpriced }) }}
        </div>

        <div style="display: flex; gap: 8px; margin-top: 18px">
            <div class="cw-card" style="flex: 1; padding: 13px 14px">
                <div class="cw-label" style="font-size: 12px">
                    {{ t('shareNetworks') }}
                </div>
                <div class="cw-num" style="margin-top: 8px; font-size: 16px">
                    {{ formatUsd(coinsTotal, locale) }}
                </div>
            </div>
            <div class="cw-card" style="flex: 1; padding: 13px 14px">
                <div class="cw-label" style="font-size: 12px">
                    {{ t('shareTokens') }}
                </div>
                <div class="cw-num" style="margin-top: 8px; font-size: 16px">
                    {{ formatUsd(tokensTotal, locale) }}
                </div>
            </div>
        </div>

        <div class="cw-label" style="margin: 26px 0 12px">
            {{ t('allocation') }}
        </div>
        <div class="cw-stack" style="gap: 14px">
            <div v-for="slice in allocation" :key="slice.key">
                <div
                    class="cw-row"
                    style="align-items: baseline; margin-bottom: 6px"
                >
                    <span
                        style="
                            display: flex;
                            min-width: 0;
                            align-items: baseline;
                            gap: 8px;
                        "
                    >
                        <span
                            style="
                                font: 500 14px/1 var(--cw-mono);
                                color: var(--cw-text);
                            "
                            >{{ slice.label }}</span
                        >
                        <span
                            class="cw-label"
                            style="
                                overflow: hidden;
                                font-size: 12px;
                                color: var(--cw-faint);
                                text-overflow: ellipsis;
                                white-space: nowrap;
                            "
                            >{{ slice.sub }}</span
                        >
                    </span>
                    <span style="display: flex; flex: none; gap: 10px">
                        <span
                            style="
                                font: 500 13px/1 var(--cw-mono);
                                color: var(--cw-muted);
                            "
                            >{{ formatUsd(slice.usd, locale) }}</span
                        >
                        <span
                            style="
                                width: 44px;
                                font: 500 13px/1 var(--cw-mono);
                                color: var(--cw-body);
                                text-align: right;
                            "
                            >{{ slice.share.toFixed(1) }}%</span
                        >
                    </span>
                </div>
                <div class="cw-bar">
                    <div
                        class="cw-bar-fill"
                        :class="{ 'cw-bar-token': slice.token }"
                        :style="{
                            width: `${Math.max(slice.share, 0.6)}%`,
                            background: slice.hue,
                        }"
                    ></div>
                </div>
            </div>

            <p v-if="allocation.length === 0" class="cw-prose">
                {{ t('analyticsEmpty') }}
            </p>
        </div>

        <div class="cw-label" style="margin: 28px 0 12px">
            {{ t('flowWeek') }}
        </div>
        <div
            style="
                display: flex;
                height: 92px;
                align-items: flex-end;
                gap: 8px;
                padding-bottom: 2px;
                border-bottom: 1px solid var(--cw-line);
            "
        >
            <div
                v-for="day in week"
                :key="day.start"
                style="
                    display: flex;
                    flex: 1;
                    height: 100%;
                    align-items: flex-end;
                "
            >
                <div
                    :style="{
                        width: '100%',
                        height: `${day.height}%`,
                        background:
                            day.count > 0
                                ? 'var(--cw-accent)'
                                : 'var(--cw-border)',
                    }"
                ></div>
            </div>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 8px">
            <span
                v-for="day in week"
                :key="day.start"
                class="cw-label"
                style="flex: 1; font-size: 12px; text-align: center"
                >{{ day.label }}</span
            >
        </div>
        <!--
          Half of these networks have no index a browser can read, so the bars
          are a count of what can be seen from here — not of what happened.
        -->
        <p class="cw-prose" style="margin-top: 10px; font-size: 14px">
            {{ t('flowNote', { indexed: indexed.length, total: networks }) }}
        </p>

        <div class="cw-grid" style="margin-top: 24px">
            <div v-for="stat in stats" :key="stat.key">
                <div class="cw-label" style="font-size: 12px">
                    {{ stat.label }}
                </div>
                <div
                    class="cw-num"
                    style="margin-top: 8px; font-size: 15px"
                    :style="{ color: stat.tone }"
                >
                    {{ stat.value }}
                </div>
            </div>
        </div>
    </div>
</template>
