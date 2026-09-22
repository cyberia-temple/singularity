<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { formatUnits, parseUnits, walletChain } from '@/lib/wallet';
import type { WalletChainId } from '@/lib/wallet';
import {
    CROSS_NATIVE,
    crossDestinationProblem,
    crossDestinationValidator,
    crossFeeShareBps,
    crossSourceProblem,
    crossSwapStatus,
    fetchCrossTokens,
    fetchCrosschainConfig,
    quoteCrossSwap,
} from '@/lib/wallet/crosschain';
import type {
    CrossChainRow,
    CrosschainConfig,
    CrossQuote,
    CrossStatus,
    CrossToken,
} from '@/lib/wallet/crosschain';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Swapping into a chain Cyberia has no liquidity on.
 *
 * The screen next door trades against Cyberia's own pools, which is the only
 * thing one chain can honestly offer. This one answers the other question —
 * "I hold USDC on Base and want SOL" — by asking a router that holds inventory
 * on both sides, and it is built around that seam rather than hiding it: the
 * deposit goes to the router's contract, the delivery is the router's, and the
 * sentence saying so sits above the hold.
 *
 * Cyberia's fee is part of the route and is shown as the router priced it, not
 * as this app configured it. A router may cap or decline it, and a screen that
 * printed the configured number would be describing a different transaction
 * from the one being signed.
 *
 * What the wallet refuses is as deliberate as what it offers. The source is an
 * EVM network that is switched on here — that is where the endpoint and the
 * balance come from. The destination is a chain whose addresses this wallet can
 * check, because there is no cancel between the deposit and the delivery and a
 * typo into an unvalidated string is final. Everything refused is listed with
 * its reason.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** The network the user was last looking at, used as the source default. */
    chain: WalletChainId;
}>();

const emit = defineEmits<{ back: []; networks: [] }>();

const { t } = useLocale(walletMessages);

const config = ref<CrosschainConfig | null>(null);
const loading = ref(true);
const loadError = ref<string | null>(null);

const sourceChainId = ref<number | null>(null);
const destChainId = ref<number | null>(null);
const sourceToken = ref<CrossToken | null>(null);
const destToken = ref<CrossToken | null>(null);
const amount = ref('');
const recipient = ref('');
const recipientTouched = ref(false);

const picker = ref<'source' | 'dest' | null>(null);
const tokenQuery = ref('');
const tokenRows = ref<CrossToken[]>([]);
const tokenLoading = ref(false);

const quote = ref<CrossQuote | null>(null);
const quoting = ref(false);
const quoteError = ref<string | null>(null);

const signing = ref(false);
const signError = ref<string | null>(null);
const hashes = ref<{ label: string; hash: string }[]>([]);
const requestId = ref<string | null>(null);
const status = ref<CrossStatus | null>(null);

let poll: ReturnType<typeof setInterval> | null = null;

/* ---------------------------------------------------------------- chains -- */

const chains = computed(() => config.value?.chains ?? []);

const chainRow = (id: number | null): CrossChainRow | null =>
    chains.value.find((chain) => chain.id === id) ?? null;

/** This wallet's own EVM networks, by their chain id. */
const walletChainOf = (chainId: number): WalletChainId | null =>
    props.wallet.accounts.value.find(
        (account) => walletChain(account.chain).chainId === chainId,
    )?.chain ?? null;

const walletChainIds = computed(() =>
    props.wallet.accounts.value.map((account) => account.chain),
);

/** Networks a route can start from: routed, EVM, and switched on here. */
const sources = computed(() =>
    chains.value.filter(
        (chain) =>
            crossSourceProblem(chain, walletChainIds.value, walletChainOf) ===
            null,
    ),
);

/** Networks a route can end on: routed, and address-checkable by this wallet. */
const destinations = computed(() =>
    chains.value.filter((chain) => crossDestinationProblem(chain) === null),
);

const refusedSources = computed(() =>
    chains.value
        .filter((chain) => chain.vm === 'evm')
        .map((chain) => ({
            chain,
            problem: crossSourceProblem(
                chain,
                walletChainIds.value,
                walletChainOf,
            ),
        }))
        .filter((row) => row.problem !== null),
);

/**
 * Routed chains this wallet will not start from, with the reason.
 *
 * Only the ones nothing can be done about: the router is not taking deposits
 * there, or it is not a chain this wallet signs on. Listed rather than
 * dropped, because "the router does not go there" and "the router is paused
 * there" are different facts.
 */
const blockedSources = computed(() =>
    refusedSources.value
        .filter((row) => row.problem !== 'notInWallet')
        .slice(0, 8),
);

/**
 * And a count for the rest, which is the one the user can fix.
 *
 * A row each would be fifty rows saying the same sentence — the router serves
 * far more networks than any wallet switches on — so it is one line and one
 * way to act on it.
 */
const offSources = computed(
    () =>
        refusedSources.value.filter((row) => row.problem === 'notInWallet')
            .length,
);

const source = computed(() => chainRow(sourceChainId.value));
const destination = computed(() => chainRow(destChainId.value));

const sourceWalletChain = computed<WalletChainId | null>(() =>
    source.value ? walletChainOf(source.value.id) : null,
);

/* ----------------------------------------------------------------- money -- */

/** The chain's own coin as a token row, which is what "no token picked" means. */
const nativeToken = (chain: CrossChainRow): CrossToken => ({
    chainId: chain.id,
    address: CROSS_NATIVE,
    symbol: chain.symbol,
    name: chain.symbol,
    decimals: chain.decimals,
    verified: true,
    logo: '',
});

const fromToken = computed(() =>
    source.value ? (sourceToken.value ?? nativeToken(source.value)) : null,
);

const toToken = computed(() =>
    destination.value
        ? (destToken.value ?? nativeToken(destination.value))
        : null,
);

/**
 * What this wallet holds of the asset being spent, when it knows.
 *
 * The coin comes from the balance the portfolio already read; a token comes
 * from that network's token list. A balance nobody has read yet is null and
 * renders as nothing — never as zero, which would be a claim.
 */
const balance = computed<bigint | null>(() => {
    const id = sourceWalletChain.value;
    const token = fromToken.value;

    if (!id || !token) {
        return null;
    }

    if (token.address === CROSS_NATIVE) {
        return props.wallet.balances.value[id]?.value ?? null;
    }

    return (
        props.wallet.tokens.value[id]?.items.find(
            (row) => row.address.toLowerCase() === token.address.toLowerCase(),
        )?.balance ?? null
    );
});

const amountRaw = computed<bigint | null>(() => {
    const token = fromToken.value;

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

/* ------------------------------------------------------------- recipient -- */

/** This wallet's own address on the destination chain, when it has one. */
const ownAddress = computed<string | null>(() => {
    const chain = destination.value;

    if (!chain) {
        return null;
    }

    const evm = props.wallet.accounts.value.find(
        (account) => account.family === 'evm',
    );

    if (chain.vm === 'evm') {
        return evm?.address ?? null;
    }

    const family = chain.vm === 'svm' ? 'solana' : 'utxo';

    return (
        props.wallet.accounts.value.find(
            (account) =>
                account.family === family &&
                (family !== 'utxo' || account.chain === 'bitcoin'),
        )?.address ?? null
    );
});

const recipientValid = computed(() => {
    const chain = destination.value;
    const validate = chain ? crossDestinationValidator(chain) : null;

    return validate !== null && validate(recipient.value.trim());
});

/** Sending somewhere other than this wallet is legitimate — and worth saying. */
const recipientIsOwn = computed(
    () =>
        ownAddress.value !== null &&
        recipient.value.trim().toLowerCase() === ownAddress.value.toLowerCase(),
);

/* ---------------------------------------------------------------- quoting -- */

const ready = computed(
    () =>
        source.value !== null &&
        destination.value !== null &&
        fromToken.value !== null &&
        toToken.value !== null &&
        amountRaw.value !== null &&
        !overBalance.value &&
        recipientValid.value,
);

const askQuote = async (): Promise<void> => {
    quote.value = null;
    quoteError.value = null;

    if (
        !ready.value ||
        !source.value ||
        !destination.value ||
        !fromToken.value ||
        !toToken.value ||
        amountRaw.value === null
    ) {
        return;
    }

    const evm = props.wallet.accounts.value.find(
        (account) => account.family === 'evm',
    );

    if (!evm) {
        quoteError.value = t('crossNoAccount');

        return;
    }

    quoting.value = true;

    try {
        quote.value = await quoteCrossSwap({
            originChainId: source.value.id,
            destinationChainId: destination.value.id,
            originCurrency: fromToken.value.address,
            destinationCurrency: toToken.value.address,
            user: evm.address,
            recipient: recipient.value.trim(),
            amount: amountRaw.value,
        });
    } catch (error) {
        quoteError.value =
            error instanceof Error ? error.message : t('crossQuoteFailed');
    } finally {
        quoting.value = false;
    }
};

/** Cyberia's cut as the route actually priced it. */
const feeShare = computed(() =>
    quote.value ? crossFeeShareBps(quote.value) : null,
);

const stepLabel = (id: string): string =>
    id === 'approve' ? t('crossStepApprove') : t('crossStepDeposit');

/* --------------------------------------------------------------- signing -- */

const sign = async (): Promise<void> => {
    const id = sourceWalletChain.value;

    if (!quote.value || !id) {
        return;
    }

    signing.value = true;
    signError.value = null;
    hashes.value = [];

    try {
        const receipt = await props.wallet.crossSwap(
            id,
            quote.value,
            (step, hash) => {
                hashes.value = [
                    ...hashes.value,
                    { label: stepLabel(step.id), hash },
                ];
            },
        );

        requestId.value = receipt.requestId;
        void refreshStatus();
        poll = setInterval(() => void refreshStatus(), 6_000);
    } catch (error) {
        signError.value =
            error instanceof Error ? error.message : t('crossSignFailed');
    } finally {
        signing.value = false;
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
            // The destination balance is somebody else's transfer arriving,
            // which nothing in this wallet would otherwise notice.
            void props.wallet.refreshBalances();
        }
    } catch {
        // A status this host could not read says nothing about the swap: the
        // route is the router's either way, and the screen keeps the hashes.
    }
};

const stopPolling = (): void => {
    if (poll !== null) {
        clearInterval(poll);
        poll = null;
    }
};

const reset = (): void => {
    stopPolling();
    requestId.value = null;
    status.value = null;
    hashes.value = [];
    quote.value = null;
    amount.value = '';
};

/* ----------------------------------------------------------------- tokens -- */

const openPicker = async (side: 'source' | 'dest'): Promise<void> => {
    picker.value = side;
    tokenQuery.value = '';
    await loadTokens();
};

const loadTokens = async (): Promise<void> => {
    const chain = picker.value === 'dest' ? destination.value : source.value;

    if (!chain) {
        return;
    }

    tokenLoading.value = true;

    try {
        tokenRows.value = await fetchCrossTokens(chain.id, tokenQuery.value);
    } catch {
        tokenRows.value = [];
    } finally {
        tokenLoading.value = false;
    }
};

const pickToken = (token: CrossToken | null): void => {
    if (picker.value === 'dest') {
        destToken.value = token;
    } else {
        sourceToken.value = token;
    }

    picker.value = null;
    void askQuote();
};

/* ------------------------------------------------------------------ setup -- */

onMounted(async () => {
    try {
        config.value = await fetchCrosschainConfig();

        const here = walletChain(props.chain).chainId;
        sourceChainId.value =
            sources.value.find((chain) => chain.id === here)?.id ??
            sources.value[0]?.id ??
            null;
        // A destination this wallet already holds an account on, before any
        // other: it can then show its own address there, which is the reason a
        // cross-chain swap belongs in a wallet rather than on a website.
        const own = destinations.value.filter(
            (chain) =>
                chain.id !== sourceChainId.value &&
                (chain.vm !== 'evm' || walletChainOf(chain.id) !== null),
        );

        destChainId.value =
            own[0]?.id ??
            destinations.value.find((chain) => chain.id !== sourceChainId.value)
                ?.id ??
            null;
    } catch (error) {
        loadError.value =
            error instanceof Error ? error.message : t('crossUnavailable');
    } finally {
        loading.value = false;
    }
});

onBeforeUnmount(stopPolling);

// The recipient follows the destination until the user types their own, which
// is the whole reason a cross-chain swap belongs in a wallet: one seed derives
// both ends, so the usual way to lose money here is not something they have to
// do by hand.
watch(
    [destChainId, ownAddress],
    () => {
        if (!recipientTouched.value) {
            recipient.value = ownAddress.value ?? '';
        }

        destToken.value = null;
        quote.value = null;
    },
    { immediate: true },
);

watch(sourceChainId, () => {
    sourceToken.value = null;
    quote.value = null;
});
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ t('crossTitle') }}
        </h2>
        <p class="cw-prose">{{ t('crossBody') }}</p>

        <p v-if="loading" class="cw-prose" style="margin-top: 20px">
            {{ t('crossLoading') }}
        </p>

        <div
            v-else-if="loadError || config?.enabled === false"
            class="cw-note"
            style="margin-top: 20px"
        >
            <span>{{ loadError ?? t('crossOff') }}</span>
        </div>

        <template v-else-if="config">
            <!-- What this host takes, said before an amount is typed. -->
            <div class="cw-card" style="margin-top: 18px; padding: 13px 15px">
                <div class="cw-label">{{ t('crossFeeLabel') }}</div>
                <p
                    class="cw-prose"
                    style="margin-top: 7px; font-size: 14px; line-height: 1.6"
                >
                    {{
                        config.fee.address
                            ? t('crossFeeBody', {
                                  percent: (config.fee.bps / 100).toFixed(2),
                              })
                            : t('crossFeeNone')
                    }}
                </p>
            </div>

            <!-- Nothing to spend from: the fix is one screen away. -->
            <div
                v-if="sources.length === 0"
                class="cw-note"
                style="margin-top: 18px"
            >
                <span>{{ t('crossNoSources') }}</span>
            </div>

            <template v-else>
                <!-- From -->
                <div class="cw-label" style="margin: 24px 0 8px">
                    {{ t('crossFrom') }}
                </div>

                <select
                    v-model.number="sourceChainId"
                    class="cw-input"
                    :aria-label="t('crossFrom')"
                >
                    <option
                        v-for="chain in sources"
                        :key="chain.id"
                        :value="chain.id"
                    >
                        {{ chain.name }}
                    </option>
                </select>

                <button
                    type="button"
                    class="cw-ghost"
                    style="margin-top: 8px; width: 100%"
                    @click="openPicker('source')"
                >
                    {{ fromToken?.symbol ?? '—' }} · {{ t('crossPickToken') }}
                </button>

                <input
                    v-model="amount"
                    type="text"
                    inputmode="decimal"
                    class="cw-input"
                    style="margin-top: 8px"
                    :placeholder="t('crossAmount')"
                    :aria-label="t('crossAmount')"
                    :aria-invalid="overBalance"
                    @change="askQuote()"
                />

                <div
                    v-if="balance !== null && fromToken"
                    style="
                        margin-top: 6px;
                        font: 500 13px/1.5 var(--cw-mono);
                        color: var(--cw-dim);
                    "
                >
                    {{
                        t('crossBalance', {
                            amount: formatUnits(balance, fromToken.decimals, 6),
                            symbol: fromToken.symbol,
                        })
                    }}
                </div>

                <div
                    v-if="overBalance"
                    style="
                        margin-top: 6px;
                        font: 500 13px/1.5 var(--cw-mono);
                        color: var(--cw-bad-soft);
                    "
                >
                    {{ t('crossOverBalance') }}
                </div>

                <!-- To -->
                <div class="cw-label" style="margin: 24px 0 8px">
                    {{ t('crossTo') }}
                </div>

                <select
                    v-model.number="destChainId"
                    class="cw-input"
                    :aria-label="t('crossTo')"
                >
                    <option
                        v-for="chain in destinations"
                        :key="chain.id"
                        :value="chain.id"
                    >
                        {{ chain.name }}
                    </option>
                </select>

                <button
                    type="button"
                    class="cw-ghost"
                    style="margin-top: 8px; width: 100%"
                    @click="openPicker('dest')"
                >
                    {{ toToken?.symbol ?? '—' }} · {{ t('crossPickToken') }}
                </button>

                <input
                    v-model="recipient"
                    type="text"
                    class="cw-input"
                    style="margin-top: 8px; font-family: var(--cw-mono)"
                    :placeholder="t('crossRecipient')"
                    :aria-label="t('crossRecipient')"
                    :aria-invalid="recipient !== '' && !recipientValid"
                    @input="recipientTouched = true"
                    @change="askQuote()"
                />

                <div
                    style="
                        margin-top: 6px;
                        font: 500 13px/1.5 var(--cw-mono);
                        color: var(--cw-dim);
                    "
                >
                    {{
                        recipient === ''
                            ? t('crossRecipientEmpty')
                            : !recipientValid
                              ? t('crossRecipientInvalid')
                              : recipientIsOwn
                                ? t('crossRecipientOwn')
                                : t('crossRecipientOther')
                    }}
                </div>

                <!-- Token picker, inline: a list nobody has to leave for. -->
                <div
                    v-if="picker"
                    class="cw-card"
                    style="margin-top: 14px; padding: 12px 14px"
                >
                    <div class="cw-row">
                        <span class="cw-label">{{ t('crossPickToken') }}</span>
                        <button
                            type="button"
                            class="cw-ghost"
                            @click="picker = null"
                        >
                            {{ t('cancel') }}
                        </button>
                    </div>

                    <input
                        v-model="tokenQuery"
                        type="search"
                        class="cw-input"
                        style="margin-top: 10px"
                        :placeholder="t('crossTokenSearch')"
                        :aria-label="t('crossTokenSearch')"
                        @change="loadTokens()"
                    />

                    <button
                        type="button"
                        class="cw-ghost"
                        style="margin-top: 8px; width: 100%"
                        @click="pickToken(null)"
                    >
                        {{ (picker === 'dest' ? destination : source)?.symbol }}
                        · {{ t('crossNativeCoin') }}
                    </button>

                    <p
                        v-if="tokenLoading"
                        class="cw-prose"
                        style="margin-top: 10px; font-size: 14px"
                    >
                        {{ t('crossTokensLoading') }}
                    </p>

                    <button
                        v-for="token in tokenRows"
                        :key="`${token.chainId}-${token.address}`"
                        type="button"
                        class="cw-ghost"
                        style="margin-top: 6px; width: 100%; text-align: left"
                        @click="pickToken(token)"
                    >
                        {{ token.symbol }} · {{ token.name }}
                        <template v-if="!token.verified">
                            · {{ t('crossTokenUnverified') }}
                        </template>
                    </button>

                    <p
                        v-if="!tokenLoading && tokenRows.length === 0"
                        class="cw-prose"
                        style="margin-top: 10px; font-size: 14px"
                    >
                        {{ t('crossTokensEmpty') }}
                    </p>
                </div>

                <!-- The route, priced. -->
                <button
                    type="button"
                    class="cw-ghost"
                    style="margin-top: 16px"
                    :disabled="!ready || quoting"
                    @click="askQuote()"
                >
                    {{ quoting ? t('crossQuoting') : t('crossQuoteAction') }}
                </button>

                <div
                    v-if="quoteError"
                    class="cw-note cw-note-bad"
                    style="margin-top: 12px"
                >
                    <span>{{ quoteError }}</span>
                </div>

                <template v-if="quote && !requestId">
                    <div
                        class="cw-card"
                        style="margin-top: 14px; padding: 14px 16px"
                    >
                        <div class="cw-label">{{ t('crossYouGet') }}</div>
                        <div
                            class="cw-total"
                            style="margin-top: 8px; font-size: 24px"
                        >
                            {{
                                formatUnits(
                                    quote.out.amount,
                                    quote.out.decimals,
                                    6,
                                )
                            }}
                            {{ quote.out.symbol }}
                        </div>
                        <div
                            style="
                                margin-top: 8px;
                                font: 500 13px/1.6 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                        >
                            {{
                                t('crossMinimum', {
                                    amount: formatUnits(
                                        quote.out.minimum,
                                        quote.out.decimals,
                                        6,
                                    ),
                                    symbol: quote.out.symbol,
                                })
                            }}
                        </div>

                        <div
                            style="
                                margin: 12px 0;
                                height: 1px;
                                background: var(--cw-hairline);
                            "
                        />

                        <div
                            v-if="quote.fees.app"
                            class="cw-row"
                            style="margin-top: 6px"
                        >
                            <span class="cw-label">{{
                                t('crossFeeCyberia')
                            }}</span>
                            <span style="font: 500 13px/1 var(--cw-mono)"
                                >{{
                                    formatUnits(
                                        quote.fees.app.amount,
                                        quote.fees.app.decimals,
                                        6,
                                    )
                                }}
                                {{ quote.fees.app.symbol
                                }}<template v-if="feeShare !== null">
                                    · {{ (feeShare / 100).toFixed(2) }}%
                                </template></span
                            >
                        </div>

                        <div
                            v-if="quote.fees.relayer"
                            class="cw-row"
                            style="margin-top: 6px"
                        >
                            <span class="cw-label">{{
                                t('crossFeeRouter')
                            }}</span>
                            <span style="font: 500 13px/1 var(--cw-mono)"
                                >{{
                                    formatUnits(
                                        quote.fees.relayer.amount,
                                        quote.fees.relayer.decimals,
                                        6,
                                    )
                                }}
                                {{ quote.fees.relayer.symbol }}</span
                            >
                        </div>

                        <div class="cw-row" style="margin-top: 6px">
                            <span class="cw-label">{{ t('crossEta') }}</span>
                            <span style="font: 500 13px/1 var(--cw-mono)">{{
                                t('crossEtaValue', {
                                    seconds: quote.timeEstimate,
                                })
                            }}</span>
                        </div>

                        <div
                            v-if="quote.slippageBps > 0"
                            class="cw-row"
                            style="margin-top: 6px"
                        >
                            <span class="cw-label">{{
                                t('crossSlippage')
                            }}</span>
                            <span style="font: 500 13px/1 var(--cw-mono)"
                                >{{
                                    (quote.slippageBps / 100).toFixed(2)
                                }}%</span
                            >
                        </div>

                        <!--
                          Asked for and not charged is a fact about this route,
                          and it is said rather than quietly absorbed.
                        -->
                        <p
                            v-if="quote.feeRequested && !quote.feeApplied"
                            class="cw-prose"
                            style="
                                margin-top: 10px;
                                font-size: 13px;
                                color: var(--cw-pending);
                            "
                        >
                            {{ t('crossFeeDeclined') }}
                        </p>
                    </div>

                    <div class="cw-note" style="margin-top: 12px">
                        <span>{{ t('crossNoCancel') }}</span>
                    </div>

                    <div
                        v-if="signError"
                        class="cw-note cw-note-bad"
                        style="margin-top: 12px"
                    >
                        <span>{{ signError }}</span>
                    </div>

                    <div style="margin-top: 14px">
                        <HoldButton
                            :label="
                                signing ? t('crossSigning') : t('holdToSign')
                            "
                            :disabled="signing || !ready"
                            @complete="sign()"
                        />
                    </div>

                    <p
                        class="cw-prose"
                        style="margin-top: 10px; font-size: 13px"
                    >
                        {{
                            t('crossSteps', {
                                count: quote.steps.length,
                            })
                        }}
                    </p>
                </template>

                <!-- Signed: what was broadcast, and where the route stands. -->
                <template v-if="requestId">
                    <div
                        class="cw-card"
                        style="margin-top: 16px; padding: 14px 16px"
                    >
                        <div class="cw-label">{{ t('crossUnderway') }}</div>
                        <div
                            style="
                                margin-top: 8px;
                                font: 400 14px/1.6 var(--cw-mono);
                                color: var(--cw-body);
                            "
                        >
                            {{
                                status === null
                                    ? t('crossStatusPending')
                                    : status.status === 'success'
                                      ? t('crossStatusDone')
                                      : status.status === 'failure'
                                        ? t('crossStatusFailed')
                                        : status.status === 'refund'
                                          ? t('crossStatusRefunded')
                                          : t('crossStatusPending')
                            }}
                        </div>

                        <div
                            v-for="row in hashes"
                            :key="row.hash"
                            style="
                                margin-top: 8px;
                                font: 500 13px/1.5 var(--cw-mono);
                                color: var(--cw-dim);
                                word-break: break-all;
                            "
                        >
                            {{ row.label }} · {{ row.hash }}
                        </div>

                        <p
                            class="cw-prose"
                            style="margin-top: 10px; font-size: 13px"
                        >
                            {{ t('crossStatusNote') }}
                        </p>
                    </div>

                    <button
                        type="button"
                        class="cw-ghost"
                        style="margin-top: 12px"
                        @click="reset()"
                    >
                        {{ t('crossAnother') }}
                    </button>
                </template>

                <!-- Corridors that exist but not from here, with the reason. -->
                <template v-if="blockedSources.length > 0 || offSources > 0">
                    <div class="cw-label" style="margin: 28px 0 8px">
                        {{ t('crossElsewhere') }}
                    </div>

                    <div
                        v-for="row in blockedSources"
                        :key="row.chain.id"
                        class="cw-card"
                        style="margin-top: 6px; padding: 10px 13px"
                    >
                        <div style="display: flex; gap: 10px">
                            <span style="flex: 1">
                                <span
                                    style="
                                        display: block;
                                        font: 500 14px/1.2 var(--cw-sans);
                                    "
                                    >{{ row.chain.name }}</span
                                >
                                <span
                                    style="
                                        display: block;
                                        margin-top: 3px;
                                        font: 500 12px/1.4 var(--cw-mono);
                                        color: var(--cw-dim);
                                    "
                                    >{{
                                        row.problem === 'noDeposits'
                                            ? t('crossReasonNoDeposits')
                                            : t('crossReasonNotEvm')
                                    }}</span
                                >
                            </span>
                        </div>
                    </div>

                    <!--
                      One line and one action for the rest: a row each would be
                      fifty rows saying the same fixable thing.
                    -->
                    <div
                        v-if="offSources > 0"
                        class="cw-card"
                        style="margin-top: 6px; padding: 10px 13px"
                    >
                        <div style="display: flex; gap: 10px">
                            <span
                                style="
                                    flex: 1;
                                    font: 500 13px/1.5 var(--cw-mono);
                                    color: var(--cw-dim);
                                "
                                >{{
                                    t('crossOffCount', { count: offSources })
                                }}</span
                            >
                            <button
                                type="button"
                                class="cw-ghost"
                                @click="emit('networks')"
                            >
                                {{ t('networksTile') }}
                            </button>
                        </div>
                    </div>
                </template>
            </template>
        </template>
    </div>
</template>
