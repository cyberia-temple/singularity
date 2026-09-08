<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { formatUnits, parseUnits, walletChain } from '@/lib/wallet';
import type { WalletChainId } from '@/lib/wallet';
import {
    CROSS_NATIVE,
    crossFeeShareBps,
    crossSwapStatus,
    fetchCrossTokens,
    quoteCrossSwap,
} from '@/lib/wallet/crosschain';
import type {
    CrossQuote,
    CrossStatus,
    CrossToken,
} from '@/lib/wallet/crosschain';
import { formatUsd } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Trading on a network Cyberia has no exchange on.
 *
 * Until now this screen said so and stopped: no router here, nothing to quote,
 * try one of the two chains that do have one. True, and useless — the user is
 * holding BNB and wants a different token on BNB, and the fact that *we* have
 * not deployed a DEX there is a fact about us, not about whether the trade is
 * possible. There is deep liquidity on that chain; somebody else routes it.
 *
 * So the wallet asks the router it already asks for cross-chain swaps, with
 * both legs on the same network. Cyberia's cut is the same `appFees` field in
 * the same request, paid to the same address, for the same service — finding
 * the route. One rate and not two, because a second knob for what is
 * genuinely one arrangement is a knob nobody sets and everybody forgets.
 *
 * What this screen must never do is let the two venues read as one. On Cyberia
 * a swap goes through pools this project runs, priced by a probe of those
 * pools, and the whole route is on screen. Here a third party holds the
 * inventory, prices the trade and can decline; the wallet only signs what came
 * back. The header says which, every time — and the fee shown is the fee in the
 * answered quote, never the one this host asked for.
 */

const props = defineProps<{
    wallet: MultiWallet;
    chain: WalletChainId;
}>();

const { locale, t } = useLocale(walletMessages);

const chain = computed(() => walletChain(props.chain));

const account = computed(() =>
    props.wallet.accounts.value.find(
        (candidate) => candidate.chain === props.chain,
    ),
);

/* ------------------------------------------------------------- what to pay -- */

/**
 * What can be spent here: the network's own coin, plus every token the wallet
 * has actually read a balance for on it. Not the router's catalogue — that is
 * the list of things you can *buy*, and offering a token nobody holds as the
 * input is a form that can only ever fail.
 */
const payable = computed<CrossToken[]>(() => {
    const coin: CrossToken = {
        chainId: chain.value.chainId ?? 0,
        address: CROSS_NATIVE,
        symbol: chain.value.symbol,
        name: chain.value.label,
        decimals: chain.value.decimals,
        verified: true,
        logo: '',
    };

    const held = (props.wallet.tokens.value[props.chain]?.items ?? []).map(
        (token) => ({
            chainId: chain.value.chainId ?? 0,
            address: token.address,
            symbol: token.symbol,
            name: token.name ?? token.symbol,
            decimals: token.decimals,
            verified: true,
            logo: '',
        }),
    );

    return [coin, ...held];
});

const from = ref<CrossToken | null>(null);
const to = ref<CrossToken | null>(null);
const amount = ref('');

watch(
    payable,
    (list) => {
        if (!from.value && list.length > 0) {
            from.value = list[0];
        }
    },
    { immediate: true },
);

const balance = computed<bigint | null>(() => {
    const token = from.value;

    if (!token) {
        return null;
    }

    if (token.address === CROSS_NATIVE) {
        return props.wallet.balances.value[props.chain]?.value ?? null;
    }

    return (
        props.wallet.tokens.value[props.chain]?.items.find(
            (row) => row.address.toLowerCase() === token.address.toLowerCase(),
        )?.balance ?? null
    );
});

const amountRaw = computed<bigint | null>(() => {
    const token = from.value;

    if (!token || amount.value.trim() === '') {
        return null;
    }

    try {
        const value = parseUnits(amount.value, token.decimals);

        return value > 0n ? value : null;
    } catch {
        return null;
    }
});

const overBalance = computed(
    () =>
        balance.value !== null &&
        amountRaw.value !== null &&
        amountRaw.value > balance.value,
);

/* ------------------------------------------------------------ what to buy -- */

const query = ref('');
const offers = ref<CrossToken[]>([]);
const searching = ref(false);
const searchError = ref<string | null>(null);

let searchTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The tokens this network can be traded into, from the router's own list.
 *
 * Debounced, and re-asked on every term rather than filtered in the browser:
 * the catalogue for a chain like BNB is far larger than anything worth holding
 * in a page, and the router's search already knows which of them have routes.
 */
const search = (): void => {
    const chainId = chain.value.chainId;

    if (chainId === undefined) {
        return;
    }

    if (searchTimer !== null) {
        clearTimeout(searchTimer);
    }

    searchTimer = setTimeout(async () => {
        searching.value = true;
        searchError.value = null;

        try {
            offers.value = await fetchCrossTokens(chainId, query.value);
        } catch (error) {
            searchError.value =
                error instanceof Error ? error.message : t('routeNoOffers');
            offers.value = [];
        } finally {
            searching.value = false;
        }
    }, 350);
};

watch(query, search);
watch(
    () => props.chain,
    () => {
        to.value = null;
        quote.value = null;
        query.value = '';
        search();
    },
    { immediate: true },
);

/* ----------------------------------------------------------------- quoting -- */

const quote = ref<CrossQuote | null>(null);
const quoting = ref(false);
const quoteError = ref<string | null>(null);

const evmAddress = computed(() => account.value?.address ?? null);

/**
 * A quote costs nothing and answers the question people arrive with — what is
 * this worth here — so an empty balance does not block it. Holding too little
 * blocks the *signature* instead, which is the step that would actually fail.
 */
const canQuote = computed(
    () =>
        from.value !== null &&
        to.value !== null &&
        amountRaw.value !== null &&
        evmAddress.value !== null &&
        chain.value.chainId !== undefined,
);

const ask = async (): Promise<void> => {
    const chainId = chain.value.chainId;
    const address = evmAddress.value;

    if (!canQuote.value || chainId === undefined || address === null) {
        return;
    }

    quoting.value = true;
    quoteError.value = null;
    quote.value = null;

    try {
        quote.value = await quoteCrossSwap({
            // Both legs on this network: the router treats origin equal to
            // destination as an ordinary swap, and the fee field is the same.
            originChainId: chainId,
            destinationChainId: chainId,
            originCurrency: from.value!.address,
            destinationCurrency: to.value!.address,
            user: address,
            recipient: address,
            amount: amountRaw.value!,
        });
    } catch (error) {
        quoteError.value =
            error instanceof Error ? error.message : t('routeQuoteFailed');
    } finally {
        quoting.value = false;
    }
};

// A quote is about one amount and one pair; changing either invalidates it,
// and an out figure left on screen from the previous pair is the one number
// here that could cost somebody money.
watch([from, to, amount], () => {
    quote.value = null;
    quoteError.value = null;
});

/** Cyberia's cut as the route actually priced it, never as it was asked for. */
const feeShare = computed(() =>
    quote.value ? crossFeeShareBps(quote.value) : null,
);

/* ----------------------------------------------------------------- signing -- */

const signing = ref(false);
const signError = ref<string | null>(null);
const hashes = ref<{ label: string; hash: string }[]>([]);
const requestId = ref<string | null>(null);
const status = ref<CrossStatus | null>(null);

let poll: ReturnType<typeof setInterval> | null = null;

const stopPolling = (): void => {
    if (poll !== null) {
        clearInterval(poll);
        poll = null;
    }
};

const refreshStatus = async (): Promise<void> => {
    if (!requestId.value) {
        return;
    }

    try {
        status.value = await crossSwapStatus(requestId.value);

        if (['success', 'failure', 'refund'].includes(status.value.status)) {
            stopPolling();
            void props.wallet.refreshBalances();
        }
    } catch {
        // A status this host could not read says nothing about the trade. The
        // hashes stay on screen either way.
    }
};

const sign = async (): Promise<void> => {
    if (!quote.value) {
        return;
    }

    signing.value = true;
    signError.value = null;
    hashes.value = [];

    try {
        const receipt = await props.wallet.crossSwap(
            props.chain,
            quote.value,
            (step, hash) => {
                hashes.value = [
                    ...hashes.value,
                    {
                        label:
                            step.id === 'approve'
                                ? t('crossStepApprove')
                                : t('routeStepSwap'),
                        hash,
                    },
                ];
            },
        );

        requestId.value = receipt.requestId;
        void refreshStatus();
        poll = setInterval(() => void refreshStatus(), 6_000);
    } catch (error) {
        signError.value =
            error instanceof Error ? error.message : t('routeSignFailed');
    } finally {
        signing.value = false;
    }
};

onBeforeUnmount(() => {
    stopPolling();

    if (searchTimer !== null) {
        clearTimeout(searchTimer);
    }
});

const outAmount = computed(() =>
    quote.value && to.value
        ? formatUnits(quote.value.out.amount, to.value.decimals, 6)
        : null,
);

const explorerUrl = (hash: string): string | null =>
    chain.value.explorerTxUrl(hash);

const canSign = computed(
    () =>
        quote.value !== null &&
        !signing.value &&
        !overBalance.value &&
        (account.value?.capabilities.send ?? false),
);
</script>

<template>
    <div class="cw-stack">
        <!--
          No back control and no screen title: this renders inside the swap
          screen, which already has both. A second "← Back" over a second
          heading reads as two screens stacked on each other.
        -->
        <div style="display: flex; align-items: center; gap: 12px">
            <NetworkMark :chain="props.chain" :size="28" />
            <div style="flex: 1; min-width: 0">
                <h2 class="cw-title" style="margin: 0">
                    {{ t('routeTitle', { chain: chain.label }) }}
                </h2>
                <p class="cw-label" style="margin-top: 6px">
                    {{ t('routeVenue') }}
                </p>
            </div>
        </div>

        <!--
          Said once, at the top, and not as a warning: it is the difference
          between this screen and the swap screen on Cyberia, and somebody who
          does not know it cannot read the fee line below correctly.
        -->
        <p class="cw-note" style="margin-top: 14px">
            <span>{{ t('routeExplain', { chain: chain.label }) }}</span>
        </p>

        <!-- Pay -->
        <div class="cw-label" style="margin: 18px 0 8px">
            {{ t('routePay') }}
        </div>
        <div style="display: flex; gap: 6px">
            <select
                v-model="from"
                class="cw-input"
                style="flex: none; width: 40%"
            >
                <option
                    v-for="token in payable"
                    :key="token.address"
                    :value="token"
                >
                    {{ token.symbol }}
                </option>
            </select>
            <input
                v-model="amount"
                class="cw-input"
                inputmode="decimal"
                :placeholder="t('crossAmount')"
                style="flex: 1"
            />
        </div>
        <p
            v-if="balance !== null && from"
            class="cw-label"
            style="margin-top: 8px"
        >
            {{
                t('routeBalance', {
                    amount: formatUnits(balance, from.decimals, 6),
                    symbol: from.symbol,
                })
            }}
        </p>
        <p
            v-if="overBalance"
            class="cw-note cw-note-bad"
            style="margin-top: 8px"
        >
            <span>{{ t('routeOverBalance') }}</span>
        </p>

        <!-- Receive -->
        <div class="cw-label" style="margin: 18px 0 8px">
            {{ t('routeReceive') }}
        </div>
        <input
            v-model="query"
            class="cw-input"
            type="search"
            :placeholder="t('routeSearch', { chain: chain.label })"
        />

        <p v-if="searching" class="cw-label" style="margin-top: 8px">
            {{ t('routeSearching') }}
        </p>
        <p
            v-else-if="searchError"
            class="cw-note cw-note-warn"
            style="margin-top: 8px"
        >
            <span>{{ searchError }}</span>
        </p>

        <div
            v-else
            class="cw-stack"
            style="
                gap: 5px;
                margin-top: 8px;
                max-height: 240px;
                overflow-y: auto;
            "
        >
            <button
                v-for="offer in offers"
                :key="offer.address"
                type="button"
                class="cw-pick"
                :class="{
                    'cw-pick-on':
                        to?.address.toLowerCase() ===
                        offer.address.toLowerCase(),
                }"
                @click="to = offer"
            >
                <span style="flex: 1; min-width: 0; text-align: left">
                    <span
                        style="
                            display: block;
                            font: 500 12px/1.2 var(--cw-sans);
                        "
                    >
                        {{ offer.symbol }}
                    </span>
                    <span
                        class="cw-label"
                        style="display: block; margin-top: 3px; font-size: 9px"
                        >{{ offer.name }}</span
                    >
                </span>
                <!--
                  The router's own flag, passed through. An unverified token is
                  marked rather than hidden: anybody may list one, and the
                  wallet's job is to say so, not to decide for the holder.
                -->
                <span
                    v-if="!offer.verified"
                    class="cw-badge"
                    style="flex: none"
                    >{{ t('routeUnverified') }}</span
                >
            </button>
        </div>

        <!-- Quote -->
        <button
            type="button"
            class="cw-btn cw-btn-secondary"
            style="margin-top: 16px"
            :disabled="!canQuote || quoting"
            @click="ask()"
        >
            {{ quoting ? t('routeQuoting') : t('routeQuote') }}
        </button>

        <p
            v-if="quoteError"
            class="cw-note cw-note-bad"
            style="margin-top: 10px"
        >
            <span>{{ quoteError }}</span>
        </p>

        <template v-if="quote && to">
            <div class="cw-kv" style="margin-top: 16px">
                <span class="cw-label">{{ t('routeYouGet') }}</span>
                <span class="cw-num">{{ outAmount }} {{ to.symbol }}</span>
            </div>

            <div class="cw-kv">
                <span class="cw-label">{{ t('routeImpact') }}</span>
                <span class="cw-data">{{ quote.impactPercent }}%</span>
            </div>

            <!--
              The fee that came back, never the one this host asked for. A
              router may cap, round or decline it, and `feeApplied` false is
              printed rather than absorbed.
            -->
            <div class="cw-kv">
                <span class="cw-label">{{ t('routeFee') }}</span>
                <span class="cw-data">
                    <template v-if="quote.feeApplied && quote.fees.app">
                        {{ formatUsd(quote.fees.app.usd, locale) }}
                        <template v-if="feeShare !== null">
                            · {{ (feeShare / 100).toFixed(2) }}%
                        </template>
                    </template>
                    <template v-else-if="quote.feeRequested">{{
                        t('routeFeeDeclined')
                    }}</template>
                    <template v-else>{{ t('routeFeeNone') }}</template>
                </span>
            </div>

            <p class="cw-note" style="margin-top: 14px">
                <span>{{
                    t('routeSentence', {
                        amount,
                        from: from?.symbol ?? '',
                        min: formatUnits(quote.out.minimum, to.decimals, 6),
                        to: to.symbol,
                        network: chain.label,
                    })
                }}</span>
            </p>

            <p
                v-if="!(account?.capabilities.send ?? false)"
                class="cw-note cw-note-warn"
                style="margin-top: 10px"
            >
                <span>{{ t('swapWatchOnly') }}</span>
            </p>

            <HoldButton
                v-else
                :label="t('routeHold')"
                :disabled="!canSign"
                style="margin-top: 14px"
                @confirm="sign()"
            />
        </template>

        <p
            v-if="signError"
            class="cw-note cw-note-bad"
            style="margin-top: 10px"
        >
            <span>{{ signError }}</span>
        </p>

        <div v-if="hashes.length > 0" class="cw-stack" style="margin-top: 16px">
            <div v-for="row in hashes" :key="row.hash" class="cw-kv">
                <span class="cw-label">{{ row.label }}</span>
                <a
                    v-if="explorerUrl(row.hash)"
                    class="cw-data"
                    :href="explorerUrl(row.hash) ?? undefined"
                    target="_blank"
                    rel="noopener noreferrer"
                    >{{ row.hash.slice(0, 10) }}…</a
                >
                <span v-else class="cw-data">{{ row.hash.slice(0, 10) }}…</span>
            </div>
        </div>

        <p v-if="status" class="cw-note" style="margin-top: 10px">
            <span>{{ status.details || status.status }}</span>
        </p>
    </div>
</template>
