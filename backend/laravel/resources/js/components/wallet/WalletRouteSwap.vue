<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import WalletPairChart from '@/components/wallet/WalletPairChart.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useWalletTheme } from '@/composables/useWalletTheme';
import { formatUnits, parseUnits, walletChain } from '@/lib/wallet';
import type { WalletChainId } from '@/lib/wallet';
import {
    crossFeeShareBps,
    crossSwapStatus,
    fetchCrossTokens,
    mergeOffers,
    quoteCrossSwap,
    routerChainId,
    routerNativeCurrency,
} from '@/lib/wallet/crosschain';
import type {
    CrossQuote,
    CrossStatus,
    CrossToken,
    TokenOffer,
} from '@/lib/wallet/crosschain';
import { fetchDexMarkets, searchDexMarkets } from '@/lib/wallet/dexscreener';
import { formatUsd, formatUsdPrice } from '@/lib/wallet/format';
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
const { scheme } = useWalletTheme();

const chain = computed(() => walletChain(props.chain));

/**
 * How the router names this network. An EVM chain answers with its own id;
 * Solana has none and the router invented one, which is why this is asked for
 * rather than read off the chain.
 */
const routedId = computed(() => routerChainId(props.chain));

/** How the router names this network's own coin — not the same string on both. */
const nativeCurrency = computed(() => routerNativeCurrency(props.chain));

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
        chainId: routedId.value ?? 0,
        address: nativeCurrency.value,
        symbol: chain.value.symbol,
        name: chain.value.label,
        decimals: chain.value.decimals,
        verified: true,
        logo: '',
    };

    const held = (props.wallet.tokens.value[props.chain]?.items ?? []).map(
        (token) => ({
            chainId: routedId.value ?? 0,
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

/**
 * Two spellings of one token.
 *
 * Case-insensitive on EVM, where a checksum is decoration over a hex string,
 * and exact everywhere else — base58 uses upper and lower case as *different
 * characters*, so lowercasing a Solana mint to compare it is a comparison
 * between two strings that are not addresses.
 */
const sameAddress = (left: string, right: string): boolean =>
    left === right ||
    (left.startsWith('0x') &&
        right.startsWith('0x') &&
        left.toLowerCase() === right.toLowerCase());

/**
 * A signed percentage, in the reader's own number format.
 *
 * Always with its sign, including the plus: these sit in a column where the
 * eye is looking for direction before magnitude, and an unsigned 19 next to a
 * −18 is the one pair that must never be ambiguous.
 */
const percentChange = (value: number): string => {
    // Zero takes no sign. It is a real answer — the index measured the day and
    // it did not move — and "+0%" reads as a rounded gain rather than as flat.
    const sign = value > 0 ? '+' : value < 0 ? '−' : '';

    return `${sign}${new Intl.NumberFormat(locale.value, {
        maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0,
    }).format(Math.abs(value))}%`;
};

const sameOffer = (selected: TokenOffer | null, offer: TokenOffer): boolean =>
    selected !== null && sameAddress(selected.address, offer.address);

const from = ref<CrossToken | null>(null);
const to = ref<TokenOffer | null>(null);
const amount = ref('');

/*
 * What is being spent, defaulted to the network's own coin.
 *
 * Kept only while it is still spendable *here*. A pay asset belongs to one
 * network — it is that chain's coin, or a token held on it — so carrying it
 * across a switch in the network strip leaves the form holding an address from
 * the chain you left. That is not a cosmetic wrong: on the way to Solana it
 * left the EVM zero address in `originCurrency`, and the router answered the
 * whole quote with `Invalid input currency`, which reads as "this trade is not
 * possible" and was really "the form is still on the previous chain".
 */
watch(
    payable,
    (list) => {
        const still =
            from.value !== null &&
            list.some((token) =>
                sameAddress(token.address, from.value!.address),
            );

        if (!still) {
            from.value = list[0] ?? null;
        }
    },
    { immediate: true },
);

const balance = computed<bigint | null>(() => {
    const token = from.value;

    if (!token) {
        return null;
    }

    if (token.address === nativeCurrency.value) {
        return props.wallet.balances.value[props.chain]?.value ?? null;
    }

    return (
        props.wallet.tokens.value[props.chain]?.items.find((row) =>
            sameAddress(row.address, token.address),
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
const offers = ref<TokenOffer[]>([]);
const searching = ref(false);
const searchError = ref<string | null>(null);

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchRun = 0;

/** Whether what was typed is an address on this network rather than a name. */
const typedAddress = computed(() => {
    const term = query.value.trim();

    try {
        return term !== '' && chain.value.isValidAddress(term) ? term : null;
    } catch {
        return null;
    }
});

/**
 * What can be bought here, from all three things that know.
 *
 * The router's catalogue was the only source for one release and it is the
 * narrowest of the three: it lists what the router has decided to carry, which
 * is neither everything it will route nor everything that trades. A token
 * minted on a launchpad this morning has a pool, a price and holders, and is
 * on nobody's list — and the whole reason somebody opens this screen is to buy
 * exactly that.
 *
 * So the catalogue is asked, the pool index is asked beside it, and when what
 * was typed is an address the chain itself is asked as well. All three are
 * allowed to fail independently: the row a user pasted an address for must
 * still appear when the pool index is down, and the catalogue must still
 * appear when the address is nonsense.
 *
 * Debounced, and every run stamped — three sources answer at three speeds, and
 * a slow answer to an old term arriving after a fast answer to the current one
 * is how a list ends up showing the results of a query nobody typed.
 */
const search = (): void => {
    const chainId = routedId.value;

    if (chainId === null) {
        return;
    }

    if (searchTimer !== null) {
        clearTimeout(searchTimer);
    }

    searchTimer = setTimeout(async () => {
        const run = ++searchRun;
        const term = query.value.trim();
        const address = typedAddress.value;

        searching.value = true;
        searchError.value = null;

        const [listed, searched, pasted] = await Promise.all([
            fetchCrossTokens(chainId, term).catch(() => null),
            searchDexMarkets(props.chain, term).catch(() => []),
            address === null
                ? Promise.resolve(null)
                : props.wallet
                      .readToken(props.chain, address)
                      .catch(() => null),
        ]);

        if (run !== searchRun) {
            return;
        }

        /*
         * With nothing typed there is nothing to search *for*, and the list on
         * screen is whatever the router carries — which is the list that
         * prompted the question "on what basis were these chosen". It cannot
         * be answered by re-ordering rows that carry no numbers, so the pools
         * are asked about those exact addresses instead: one batched call, and
         * every row arrives with a depth and a day's move to be ranked and
         * read by.
         */
        const markets =
            term === '' && listed !== null && listed.length > 0
                ? await fetchDexMarkets(
                      props.chain,
                      listed.map((token) => token.address),
                  ).catch(() => [])
                : searched;

        if (run !== searchRun) {
            return;
        }

        // The chain's own answer about a pasted address goes first and is the
        // only row here whose decimals nobody had to be trusted for.
        const extra: TokenOffer[] =
            pasted === null
                ? []
                : [
                      {
                          chainId,
                          address: pasted.address,
                          symbol: pasted.symbol,
                          name: pasted.name,
                          decimals: pasted.decimals,
                          verified: false,
                          logo: '',
                          market: null,
                          unlisted: true,
                      },
                  ];

        offers.value = mergeOffers(listed ?? [], markets, extra);
        searching.value = false;

        // Only a total blank is worth a sentence. The catalogue failing while
        // the pools answered is a list that works, and saying so would be
        // reporting our plumbing as the user's problem.
        searchError.value =
            listed === null && offers.value.length === 0
                ? t('routeNoOffers')
                : null;
    }, 350);
};

watch(query, search);

/* ------------------------------------------------------- picking one of them -- */

/** Reading a scale off the chain for a row that arrived without one. */
const resolving = ref(false);
const resolveError = ref<string | null>(null);

/**
 * Choose what to buy — and, for a row the router never listed, find out what
 * it is first.
 *
 * A row from the pool index carries no decimals, because that index does not
 * report them and a guessed scale is the difference between buying a token and
 * buying a millionth of one. So picking such a row reads it off the chain, on
 * a deliberate act rather than for all thirty rows on screen, and a token the
 * chain will not answer for cannot be picked at all — which is the correct
 * outcome for an address that is not a token on this network.
 */
const pick = async (offer: TokenOffer): Promise<void> => {
    resolveError.value = null;

    if (!offer.unlisted || offer.decimals > 0) {
        to.value = offer;

        return;
    }

    resolving.value = true;

    try {
        const read = await props.wallet.readToken(props.chain, offer.address);

        if (read === null) {
            resolveError.value = t('routeUnreadableToken');

            return;
        }

        to.value = { ...offer, decimals: read.decimals };
    } catch {
        resolveError.value = t('routeUnreadableToken');
    } finally {
        resolving.value = false;
    }
};

/* ----------------------------------------------------------------- quoting -- */

const quote = ref<CrossQuote | null>(null);
const quoting = ref(false);
const quoteError = ref<string | null>(null);

/*
 * A new network is a new catalogue, and the list has to be asked for once
 * before anybody types — the screen opens on "you receive" with nothing under
 * it otherwise, which reads as "there is nothing here" rather than as "say
 * what you want".
 *
 * It sits *below* the quote it clears rather than up with the other searching,
 * and that is not tidiness. `immediate` runs this body during setup, so every
 * name in it has to be initialised by the time setup reaches this line — and
 * for one release this ran above `const quote`, threw on the temporal dead
 * zone, and took the opening search down with it. The visible symptom was an
 * empty token list on every routed chain: the exception was swallowed into a
 * console warning, so the screen looked built and was simply blank.
 */
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

/** Who is spending, in whatever form this chain writes an address. */
const spender = computed(() => account.value?.address ?? null);

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
        spender.value !== null &&
        routedId.value !== null,
);

const ask = async (): Promise<void> => {
    const chainId = routedId.value;
    const address = spender.value;

    if (!canQuote.value || chainId === null || address === null) {
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

        <!--
          Where the list comes from and what decides its order. Without this
          the rows are somebody's ranking of somebody's catalogue, and the only
          honest reaction to that is the one this line answers.
        -->
        <p
            v-if="!searching && offers.length > 0"
            class="cw-rowdata"
            style="margin-top: 6px"
        >
            {{ query.trim() === '' ? t('routeListTop') : t('routeListFound') }}
        </p>

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
                :class="{ 'cw-pick-on': sameOffer(to, offer) }"
                :disabled="resolving"
                @click="pick(offer)"
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
                    <span class="cw-rowdata" style="margin-top: 3px">{{
                        offer.name
                    }}</span>
                    <!--
                      What separates nine tokens with one name. Depth first,
                      because it is the number that decides whether the one you
                      picked is the one everybody else is trading.
                    -->
                    <span
                        v-if="offer.market"
                        class="cw-rowdata"
                        style="margin-top: 3px"
                    >
                        {{
                            t('routeDepth', {
                                liquidity: formatUsd(
                                    offer.market.liquidityUsd,
                                    locale,
                                ),
                            })
                        }}
                        ·
                        {{ formatUsdPrice(offer.market.priceUsd, locale) }}
                        <!--
                          The day's move, and only when the index reported one.
                          A token with no figure is drawn without this rather
                          than at 0%, which would read as "flat" — the two are
                          different answers and a new pool gives the first.
                        -->
                        <span
                            v-if="offer.market.priceChange24h !== null"
                            :style="{
                                color:
                                    offer.market.priceChange24h === 0
                                        ? 'var(--cw-dim)'
                                        : offer.market.priceChange24h > 0
                                          ? 'var(--cw-ok)'
                                          : 'var(--cw-bad)',
                            }"
                            >· {{ percentChange(offer.market.priceChange24h) }}
                        </span>
                    </span>
                </span>
                <span
                    style="
                        flex: none;
                        display: flex;
                        flex-direction: column;
                        gap: 3px;
                        align-items: flex-end;
                    "
                >
                    <!--
                      The router's own flag, passed through. An unverified token
                      is marked rather than hidden: anybody may list one, and
                      the wallet's job is to say so, not to decide for the
                      holder.
                    -->
                    <span v-if="!offer.verified" class="cw-badge">{{
                        t('routeUnverified')
                    }}</span>
                    <!--
                      Found in the pools rather than in the router's catalogue.
                      Not a warning about the token — it is a warning about how
                      much is known about it here.
                    -->
                    <span v-if="offer.unlisted" class="cw-badge">{{
                        t('routeUnlisted')
                    }}</span>
                </span>
            </button>
        </div>

        <p
            v-if="resolveError"
            class="cw-note cw-note-warn"
            style="margin-top: 8px"
        >
            <span>{{ resolveError }}</span>
        </p>

        <!--
          The chosen token's own history, from the index that watches its pool.
          Under the picker rather than beside the quote: this is what a person
          reads *before* deciding an amount, and a chart that only appears once
          a route has been priced appears after the decision it informs.
        -->
        <WalletPairChart
            v-if="to?.market"
            :market="to.market"
            :scheme="scheme"
        />

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
