<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import StockIcon from '@/components/wallet/StockIcon.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { formatUnits } from '@/lib/wallet';
import {
    dayPosition,
    fetchStocks,
    formatStockUsd,
    searchStockRows,
    unpricedStocks,
} from '@/lib/wallet/stocks';
import type { StockRow } from '@/lib/wallet/stocks';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The tokenised stocks, as a place in the wallet.
 *
 * Two prices exist for every row here and this screen shows one of them: the
 * issuer's quote for the underlying share, times the multiplier that says how
 * many shares a token stands for. It is deliberately not the pool price. The
 * pool is where a trade actually happens and the swap screen quotes it live,
 * against the amount being traded — putting a second, differently-sourced
 * number beside it in a list would be two answers to "what is this worth" with
 * nothing on screen to say why they differ.
 *
 * The list is the registry, always, and the prices are laid over it. A market
 * that could not be read leaves the row in place with a dash, because a stock
 * disappearing from a list is what a delisting looks like, and this is not one.
 */

const props = defineProps<{ wallet: MultiWallet }>();

const emit = defineEmits<{
    back: [];
    /** Open the swap composer on this contract, on Robinhood Chain. */
    trade: [address: string];
}>();

const { locale, t } = useLocale(walletMessages);

/*
 * The registry renders immediately and the quotes arrive on top of it. Drawing
 * a spinner over a list this browser already has would hide fifty-three rows
 * to wait for a number beside each of them.
 */
const rows = ref<StockRow[]>(unpricedStocks());
const quotedAt = ref<string | null>(null);
const failed = ref(false);
const query = ref('');

let timer: ReturnType<typeof setInterval> | null = null;

const load = async (): Promise<void> => {
    try {
        const answer = await fetchStocks();
        rows.value = answer.rows;
        quotedAt.value = answer.quotedAt;
        failed.value = false;
    } catch {
        // The rows stay, unpriced. Prices are the part that failed.
        failed.value = true;
    }
};

onMounted(() => {
    void load();
    // A share moves through the day; the server's own cache is thirty seconds,
    // so asking more often than that would only re-read the same answer.
    timer = setInterval(() => void load(), 30_000);
});

onBeforeUnmount(() => {
    if (timer !== null) {
        clearInterval(timer);
    }
});

/**
 * Contract (lowercased) => what this wallet holds of it, when it knows.
 *
 * Read from the token list the Robinhood network already keeps rather than by
 * asking the chain per row: fifty-three balance calls to draw a catalogue is a
 * load test. A stock the wallet has never read is simply not in here, and the
 * row says nothing about a holding rather than saying zero.
 */
const held = computed<Record<string, { balance: bigint; decimals: number }>>(
    () => {
        const balances: Record<string, { balance: bigint; decimals: number }> =
            {};

        for (const token of props.wallet.tokens.value.robinhood?.items ?? []) {
            if (token.balance > 0n) {
                balances[token.address.toLowerCase()] = {
                    balance: token.balance,
                    decimals: token.decimals,
                };
            }
        }

        return balances;
    },
);

/**
 * Contracts this wallet is already tracking, held or not.
 *
 * Separate from `held` because the two answer different questions: that one is
 * "do you own any", this one is "is it on your list". A stock the index has not
 * reported yet is still tracked once it has been added by hand.
 */
const tracked = computed<Set<string>>(
    () =>
        new Set(
            (props.wallet.tokens.value.robinhood?.items ?? []).map((token) =>
                token.address.toLowerCase(),
            ),
        ),
);

/**
 * Adding a stock to the wallet by hand.
 *
 * It should not be necessary — Robinhood Chain has a keyless index and the
 * wallet reads it — but that index answers a browser with `429` often enough
 * that a holder can open this screen, own the thing, and see nothing. Adding
 * reads the contract over the RPC instead, which is the path that always works.
 */
const adding = ref<string | null>(null);
const addError = ref<string | null>(null);

const add = async (address: string): Promise<void> => {
    adding.value = address;
    addError.value = null;

    const failure = await props.wallet.addToken('robinhood', address);

    addError.value = failure;
    adding.value = null;
};

const shown = computed(() => searchStockRows(rows.value, query.value));

const equities = computed(() =>
    shown.value.filter((row) => row.kind === 'equity'),
);

const funds = computed(() => shown.value.filter((row) => row.kind === 'fund'));

const holdingOf = (row: StockRow): string | null => {
    const holding = held.value[row.address.toLowerCase()];

    return holding ? formatUnits(holding.balance, holding.decimals, 4) : null;
};

const price = (value: number | null): string =>
    formatStockUsd(value, locale.value);

/** The issuer's own timestamp, said in the reader's language. */
const quotedLabel = computed<string | null>(() => {
    if (quotedAt.value === null) {
        return null;
    }

    const at = new Date(quotedAt.value);

    return Number.isNaN(at.getTime())
        ? null
        : t('stocksQuotedAt', {
              at: at.toLocaleTimeString(locale.value, {
                  hour: '2-digit',
                  minute: '2-digit',
              }),
          });
});
</script>

<template>
    <div class="cw-stack">
        <div class="cw-row" style="margin-bottom: 14px">
            <button type="button" class="cw-back" @click="emit('back')">
                {{ t('back') }}
            </button>
        </div>

        <h2 class="cw-title">{{ t('stocks') }}</h2>

        <p class="cw-note" style="margin: 10px 0 12px">
            <span>{{ t('stocksIntro') }}</span>
        </p>

        <p class="cw-label" style="margin: 0 0 4px">
            {{ t('stocksCount', { count: String(rows.length) }) }}
        </p>
        <p class="cw-rowdata" style="margin: 0 0 14px">
            {{ t('stocksVenue') }}
        </p>

        <p
            v-if="failed"
            class="cw-note cw-note-warn"
            style="margin-bottom: 12px"
        >
            <span>{{ t('stocksFailed') }}</span>
        </p>

        <input
            v-model="query"
            class="cw-input"
            type="search"
            :placeholder="t('stocksSearch')"
            style="margin-bottom: 14px"
        />

        <template
            v-for="group in [
                { key: 'equities', label: t('stocksEquities'), rows: equities },
                { key: 'funds', label: t('stocksFunds'), rows: funds },
            ]"
            :key="group.key"
        >
            <p
                v-if="group.rows.length > 0"
                class="cw-label"
                style="margin: 6px 0 8px"
            >
                {{ group.label }}
            </p>

            <div
                v-if="group.rows.length > 0"
                class="cw-stack"
                style="gap: 6px; margin-bottom: 16px"
            >
                <div
                    v-for="row in group.rows"
                    :key="row.symbol"
                    class="cw-market"
                >
                    <StockIcon
                        :symbol="row.symbol"
                        :src="row.icon"
                        :size="28"
                    />

                    <button
                        type="button"
                        class="cw-market-body cw-open"
                        style="text-align: left"
                        @click="emit('trade', row.address)"
                    >
                        <span class="cw-market-name">
                            {{ row.symbol }}
                            <span class="cw-market-on">{{ row.name }}</span>
                        </span>
                        <span v-if="holdingOf(row)" class="cw-rowdata">
                            {{ t('stocksHeld', { amount: holdingOf(row)! }) }}
                        </span>
                        <span
                            v-else-if="row.low !== null && row.high !== null"
                            class="cw-rowdata"
                        >
                            {{
                                t('stocksDay', {
                                    low: price(row.low),
                                    high: price(row.high),
                                })
                            }}
                        </span>
                        <span v-else-if="row.price === null" class="cw-rowdata">
                            {{ t('stocksNoPrice') }}
                        </span>
                    </button>

                    <span class="cw-market-side">
                        <span class="cw-num">{{ price(row.price) }}</span>
                        <span v-if="row.halted" class="cw-stock-halted">{{
                            t('stocksHalted')
                        }}</span>
                        <span
                            v-else-if="dayPosition(row) !== null"
                            class="cw-stock-day"
                        >
                            <span
                                class="cw-stock-day-at"
                                :style="{
                                    left: `${(dayPosition(row) ?? 0) * 100}%`,
                                }"
                            />
                        </span>
                    </span>

                    <!--
                      The one action that is not a trade: put it on the token
                      list, which reads the contract over the RPC rather than
                      waiting for the chain's index to answer.
                    -->
                    <button
                        v-if="!tracked.has(row.address.toLowerCase())"
                        type="button"
                        class="cw-icon-btn-bare"
                        :disabled="adding === row.address"
                        :title="t('stocksAdd')"
                        :aria-label="t('stocksAdd')"
                        @click="void add(row.address)"
                    >
                        +
                    </button>
                    <span
                        v-else
                        class="cw-label"
                        style="color: var(--cw-faint)"
                        :title="t('stocksAdded')"
                        >✓</span
                    >
                </div>
            </div>
        </template>

        <p v-if="addError" class="cw-note cw-note-bad" style="margin-top: 14px">
            <span>{{ addError }}</span>
        </p>

        <p v-if="shown.length === 0" class="cw-note" style="margin-top: 14px">
            <span>{{ t('stocksNone') }}</span>
        </p>

        <p v-if="quotedLabel" class="cw-rowdata" style="margin-top: 14px">
            {{ quotedLabel }}
        </p>
    </div>
</template>
