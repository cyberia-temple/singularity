<script setup lang="ts">
import { CircleCheck, CircleX, Loader, RefreshCw } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import GasSponsor from '@/components/wallet/GasSponsor.vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import StatusPill from '@/components/wallet/StatusPill.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { analytics, errorCode } from '@/lib/analytics';
import { formatUnits, parseUnits, walletChain } from '@/lib/wallet';
import type {
    WalletChainId,
    WalletFeeTier,
    WalletTokenBalance,
} from '@/lib/wallet';
import { formatUsd, shortAddress, usdValue } from '@/lib/wallet/format';
import {
    announceWalletEvent,
    playWalletSound,
} from '@/lib/wallet/notifications';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Compose → review → sign → outcome.
 *
 * Two rules run this screen. Nothing is signed without one plain-language
 * sentence stating what the signature does, above the numbers rather than
 * instead of them. And the confirm control is a hold, not a tap, because the
 * step after it cannot be undone by anything this wallet can do.
 *
 * Every number here comes from the chain: the fee is a live quote, MAX is the
 * balance minus that quote, and the total debit is their sum. When the fee
 * cannot be read the screen refuses to build a transaction instead of guessing.
 */

const props = defineProps<{
    wallet: MultiWallet;
    chain: WalletChainId;
    prices: Record<string, number | null>;
    /** Chain id → (lowercased contract → USD price). */
    tokenPrices: Record<string, Record<string, number>>;
    /** Asset to open on: a token held on this chain, or the native coin. */
    token?: WalletTokenBalance | null;
}>();

const emit = defineEmits<{
    back: [];
    pick: [chain: WalletChainId];
    sent: [];
    addNetwork: [];
}>();

const { locale, t } = useLocale(walletMessages);

type Phase = 'compose' | 'review' | 'status';
type Outcome = 'signing' | 'pending' | 'confirmed' | 'failed';

const phase = ref<Phase>('compose');
const outcome = ref<Outcome>('signing');
/** null is the network's own coin; anything else is an ERC20 on it. */
const asset = ref<WalletTokenBalance | null>(props.token ?? null);
const to = ref('');
const amount = ref('');
const tier = ref<WalletFeeTier>('normal');
const txHash = ref<string | null>(null);
const failure = ref<string | null>(null);

const chain = computed(() => walletChain(props.chain));

const account = computed(() =>
    props.wallet.accounts.value.find(
        (candidate) => candidate.chain === props.chain,
    ),
);

/** Tokens on this chain, offered next to the coin as things to send. */
const assets = computed(() =>
    (props.wallet.tokens.value[props.chain]?.items ?? []).filter(
        (token) => token.balance > 0n,
    ),
);

/** What the amount field counts in — the token's units, or the chain's. */
const decimals = computed(() => asset.value?.decimals ?? chain.value.decimals);

const symbol = computed(() => asset.value?.symbol ?? chain.value.symbol);

/**
 * The balance being spent from. For a token this is the token's own balance —
 * the gas that moves it is a *different* balance, checked separately below.
 */
const balance = computed(() =>
    asset.value
        ? asset.value.balance
        : (props.wallet.balances.value[props.chain]?.value ?? null),
);

/** The coin the fee is paid in, always the network's own. */
const gasBalance = computed(
    () => props.wallet.balances.value[props.chain]?.value ?? null,
);

/**
 * Whether the recipient has code behind it.
 *
 * It changes the fee, so it is part of the quote and not a detail: a coin sent
 * to a contract runs that contract's code on this transaction's gas, and the
 * 21000 that pays a plain address does not cover a single opcode of it.
 */
const toIsContract = ref(false);

const quotes = computed(() =>
    props.wallet.feesFor(
        props.chain,
        asset.value?.address ?? null,
        toIsContract.value,
    ),
);

const fee = computed(
    () => quotes.value.find((quote) => quote.tier === tier.value)?.fee ?? null,
);

/** Typed amount in smallest units, or null while it is not a number yet. */
const amountUnits = computed(() => {
    if (amount.value.trim() === '') {
        return null;
    }

    try {
        return parseUnits(amount.value, decimals.value);
    } catch {
        return null;
    }
});

const addressValid = computed(
    () =>
        to.value.trim().length > 0 &&
        chain.value.isValidAddress(to.value.trim()),
);

/**
 * How much of the asset itself is missing.
 *
 * For the native coin the fee comes out of the same balance, so it is part of
 * the sum. For a token it does not — the fee is gas, and gas is a different
 * asset entirely, which is what `gasShortfall` is for.
 */
const shortfall = computed(() => {
    if (amountUnits.value === null || balance.value === null) {
        return null;
    }

    if (asset.value === null && fee.value === null) {
        return null;
    }

    const needed =
        amountUnits.value + (asset.value === null ? (fee.value ?? 0n) : 0n);

    return needed > balance.value ? needed - balance.value : null;
});

/**
 * Missing gas: holding the token but not the coin that moves it.
 *
 * This is the failure people actually hit with tokens — a full USDC balance and
 * no CYBER — and it deserves its own sentence rather than being folded into
 * "insufficient balance", which would point at the wrong asset.
 */
const gasShortfall = computed(() => {
    if (
        asset.value === null ||
        fee.value === null ||
        gasBalance.value === null
    ) {
        return null;
    }

    return fee.value > gasBalance.value ? fee.value - gasBalance.value : null;
});

/** Total debited from the asset being sent — for a token, the amount alone. */
const total = computed(() =>
    amountUnits.value === null
        ? null
        : asset.value === null
          ? fee.value === null
              ? null
              : amountUnits.value + fee.value
          : amountUnits.value,
);

const canReview = computed(
    () =>
        addressValid.value &&
        amountUnits.value !== null &&
        amountUnits.value > 0n &&
        fee.value !== null &&
        shortfall.value === null &&
        gasShortfall.value === null,
);

/**
 * What "Max" would actually put in the field, or null while it cannot be
 * worked out yet.
 *
 * A token's whole balance is spendable: its fee is paid in the coin, not out
 * of it. Only the coin has to keep enough back to pay for its own move — and
 * on a balance of zero, or one smaller than its own fee, that leaves nothing.
 * This is also what decides whether the button is pressable at all: it read
 * `disabled: false` over a line saying "Balance 0 CYBER", which is a promise
 * the screen has no way to keep.
 */
const maxSpendable = computed(() => {
    if (balance.value === null) {
        return null;
    }

    if (asset.value !== null) {
        return balance.value;
    }

    if (fee.value === null) {
        return null;
    }

    const left = balance.value - fee.value;

    return left > 0n ? left : 0n;
});

const setMax = (): void => {
    if (maxSpendable.value === null || maxSpendable.value === 0n) {
        return;
    }

    amount.value = formatUnits(maxSpendable.value, decimals.value, 12);
};

const pasteTo = async (): Promise<void> => {
    to.value = (await navigator.clipboard.readText()).trim();
};

/** The one sentence shown before every signature. */
const sentence = computed(() =>
    t(asset.value === null ? 'signSentence' : 'signSentenceToken', {
        amount:
            amountUnits.value === null
                ? '0'
                : formatUnits(amountUnits.value, decimals.value, 8),
        symbol: symbol.value,
        chain: chain.value.label,
        to: to.value.trim() ? shortAddress(to.value.trim()) : '—',
        network: chain.value.label,
        // The fee is always in the chain's coin and its own decimals, even
        // when what is moving is a token that counts differently.
        fee:
            fee.value === null
                ? '—'
                : formatUnits(fee.value, chain.value.decimals, 8),
        gas: chain.value.symbol,
    }),
);

const OUTCOMES: Record<
    Outcome,
    {
        icon: typeof Loader;
        status: 'signing' | 'pending' | 'confirmed' | 'failed';
    }
> = {
    signing: { icon: Loader, status: 'signing' },
    pending: { icon: Loader, status: 'pending' },
    confirmed: { icon: CircleCheck, status: 'confirmed' },
    failed: { icon: CircleX, status: 'failed' },
};

/**
 * What a transfer looks like to analytics: which network, which kind of asset,
 * roughly how much it was worth, and what the fee tier was.
 *
 * Never the recipient, never the exact units, never the hash. The amount goes
 * in USD because that is the only figure a dashboard can add across assets,
 * and because it is coarser than a balance — an amount in units plus a symbol
 * is a fingerprint of one transfer, and a USD figure is a row in a total.
 */
const traits = () => ({
    chain: props.chain,
    asset: symbol.value,
    token_type: (asset.value === null ? 'coin' : 'token') as 'coin' | 'token',
    transaction_type: (asset.value === null ? 'send' : 'token_transfer') as
        | 'send'
        | 'token_transfer',
    tier: tier.value,
    amount_usd:
        usdValue(
            amountUnits.value,
            decimals.value,
            asset.value === null
                ? (props.prices[props.chain] ?? null)
                : (props.tokenPrices[props.chain]?.[
                      asset.value.address.toLowerCase()
                  ] ?? null),
        ) ?? undefined,
    fee_usd:
        usdValue(
            fee.value,
            chain.value.decimals,
            props.prices[props.chain] ?? null,
        ) ?? undefined,
});

/**
 * The user has a complete transfer and asked to see it. This is the top of the
 * transaction funnel — the point where they committed to an intention, rather
 * than the point where they opened the screen — so the drop-off between it and
 * a signature is a review step people abandon, which is a thing worth knowing.
 */
const review = (): void => {
    analytics.track('transaction_started', traits());
    phase.value = 'review';
};

const sign = async (): Promise<void> => {
    playWalletSound('message');
    phase.value = 'status';
    outcome.value = 'signing';
    failure.value = null;
    txHash.value = null;

    const startedAt = Date.now();

    analytics.track('transaction_signed', traits());

    try {
        txHash.value = await props.wallet.send(
            props.chain,
            to.value.trim(),
            amount.value,
            tier.value,
            asset.value,
        );
        outcome.value = 'pending';
    } catch (error) {
        outcome.value = 'failed';
        failure.value = error instanceof Error ? error.message : String(error);
        announceWalletEvent({
            title: t('txFailedTitle'),
            body: `${chain.value.label} · ${t('txFailedBody')}`,
            sound: 'error',
        });

        // The normalised code, never the message: the message names an
        // address and an amount, and no two RPC providers phrase the same
        // failure alike, so grouping by it would report six problems where
        // there is one.
        analytics.track('transaction_failed', {
            ...traits(),
            error_code: errorCode(error),
            duration_ms: Date.now() - startedAt,
        });

        return;
    }

    /*
     * Broadcast, and `watchable` says whether anything will ever confirm it.
     * A chain whose adapter cannot watch for a receipt — a user-added network,
     * a Bitcoin fork with no Esplora endpoint — never produces a
     * `transaction_confirmed`, and that is a fact about our instrumentation
     * rather than about the user, so the activation rule reads this flag.
     */
    analytics.track('transaction_submitted', {
        ...traits(),
        watchable: !!chain.value.awaitOutcome,
        duration_ms: Date.now() - startedAt,
    });

    void props.wallet.refreshBalances();
    emit('sent');

    // Broadcast is not settlement. Watching can time out without the transfer
    // failing, so a timeout leaves the row pending rather than calling it dead.
    if (!chain.value.awaitOutcome) {
        announceWalletEvent({
            title: t('txConfirmedTitle'),
            body: `${chain.value.label} · ${t('txConfirmedBody')}`,
            sound: 'success',
            tag: txHash.value ? `transaction:${txHash.value}` : undefined,
        });

        return;
    }

    try {
        outcome.value = await chain.value.awaitOutcome(txHash.value);

        analytics.track(
            outcome.value === 'confirmed'
                ? 'transaction_confirmed'
                : 'transaction_failed',
            {
                ...traits(),
                duration_ms: Date.now() - startedAt,
                ...(outcome.value === 'confirmed'
                    ? {}
                    : { error_code: 'reverted' as const }),
            },
        );

        announceWalletEvent({
            title:
                outcome.value === 'confirmed'
                    ? t('txConfirmedTitle')
                    : t('txFailedTitle'),
            body: `${chain.value.label} · ${
                outcome.value === 'confirmed'
                    ? t('txConfirmedBody')
                    : t('txFailedBody')
            }`,
            sound: outcome.value === 'confirmed' ? 'success' : 'error',
            tag: txHash.value ? `transaction:${txHash.value}` : undefined,
        });
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);

        // A watch that timed out is not a transfer that failed, and the row
        // stays pending on screen — so nothing is recorded as either.
    }

    void props.wallet.refreshBalances();
    void props.wallet.refreshHistory(props.chain);
    void props.wallet.refreshTokens(props.chain);
};

const reset = (): void => {
    phase.value = 'compose';
    txHash.value = null;
    failure.value = null;
};

const loadFees = (): void => {
    void props.wallet.refreshFees(
        props.chain,
        asset.value?.address ?? null,
        toIsContract.value,
    );
};

/** Pending recipient lookup, so typing an address does not spray reads. */
let codeCheck: ReturnType<typeof setTimeout> | null = null;

/**
 * Ask what the recipient is, once they have typed enough to be asking about.
 *
 * A wrong answer here is the difference between a transfer and a transfer that
 * reverts out of gas and keeps the fee, so an unreadable node is treated as
 * "contract" — the expensive-but-working side of the guess.
 */
const checkRecipient = (): void => {
    if (codeCheck !== null) {
        clearTimeout(codeCheck);
    }

    if (!addressValid.value) {
        if (toIsContract.value) {
            toIsContract.value = false;
            loadFees();
        }

        return;
    }

    const address = to.value.trim();

    codeCheck = setTimeout(async () => {
        const isContract = await props.wallet.recipientIsContract(
            props.chain,
            address,
        );

        // The field may have moved on while the node was answering.
        if (address !== to.value.trim()) {
            return;
        }

        toIsContract.value = isContract;
        loadFees();
    }, 400);
};

/**
 * Gas arrived from the station. The balance that was too small to pay a fee is
 * the one thing that changed, so it is the one thing re-read.
 */
const onFunded = (): void => {
    void props.wallet.refreshBalances();
};

onMounted(() => {
    loadFees();
    void props.wallet.refreshTokens(props.chain);
});

onBeforeUnmount(() => {
    if (codeCheck !== null) {
        clearTimeout(codeCheck);
    }
});

watch(
    () => props.chain,
    () => {
        to.value = '';
        amount.value = '';
        // The asset belongs to the network it lives on: keeping a token
        // selected across a network switch would price and sign it against a
        // contract that is not there.
        asset.value = null;
        // And so does the answer about the recipient: the same address is a
        // contract on one network and nothing at all on the next.
        toIsContract.value = false;
        loadFees();
        void props.wallet.refreshTokens(props.chain);
    },
);

watch(to, checkRecipient);

// Each asset is priced separately, because moving a token costs several times
// what moving the coin does.
watch(asset, () => {
    amount.value = '';
    loadFees();
});

const pickAsset = (next: WalletTokenBalance | null): void => {
    asset.value = next;
};
</script>

<template>
    <div v-if="account" class="cw-stack cw-screen">
        <!-- Compose -->
        <template v-if="phase !== 'status'">
            <div class="cw-row" style="margin-bottom: 20px">
                <button type="button" class="cw-back" @click="emit('back')">
                    ← {{ t('back') }}
                </button>
                <span style="font: 500 12px/1 var(--cw-sans)">{{
                    t('send')
                }}</span>
                <span style="width: 44px"></span>
            </div>

            <div class="cw-seg" style="margin-bottom: 20px">
                <button
                    v-for="candidate in wallet.accounts.value"
                    :key="candidate.chain"
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="candidate.chain === chain.id"
                    @click="emit('pick', candidate.chain)"
                >
                    {{ candidate.label }}
                    <span
                        class="cw-seg-bar"
                        :style="{
                            background:
                                candidate.chain === chain.id
                                    ? candidate.mark.hue
                                    : 'transparent',
                        }"
                    />
                </button>
                <button
                    type="button"
                    class="cw-seg-item"
                    style="flex: 0 0 56px; color: var(--cw-muted)"
                    :aria-label="t('addNetwork')"
                    @click="emit('addNetwork')"
                >
                    +
                    <span class="cw-seg-bar" />
                </button>
            </div>

            <!--
              What is being sent, when the network holds more than its own coin.
              A token shares this address and this chain's gas, so it belongs in
              a row inside the network rather than as a network of its own.
            -->
            <div
                v-if="assets.length > 0 && account.capabilities.send"
                class="cw-seg"
                style="margin-bottom: 20px"
            >
                <button
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="asset === null"
                    @click="pickAsset(null)"
                >
                    {{ chain.symbol }}
                    <span
                        class="cw-seg-bar"
                        :style="{
                            background:
                                asset === null ? chain.mark.hue : 'transparent',
                        }"
                    />
                </button>
                <button
                    v-for="candidate in assets"
                    :key="candidate.address"
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="asset?.address === candidate.address"
                    @click="pickAsset(candidate)"
                >
                    {{ candidate.symbol }}
                    <span
                        class="cw-seg-bar"
                        :style="{
                            background:
                                asset?.address === candidate.address
                                    ? chain.mark.hue
                                    : 'transparent',
                        }"
                    />
                </button>
            </div>

            <p v-if="!account.capabilities.send" class="cw-note cw-note-warn">
                <span>{{
                    t('sendUnsupported', { chain: account.label })
                }}</span>
            </p>

            <template v-else>
                <!--
                  On a network the user added, the fee and the balance below are
                  whatever its endpoint says they are. That belongs above the
                  form rather than under it: it changes how the numbers should
                  be read, and the signature it leads to cannot be undone.
                -->
                <p
                    v-if="account.custom"
                    class="cw-note"
                    style="margin-bottom: 16px"
                >
                    <span>{{ t('warnCustom') }}</span>
                </p>

                <div class="cw-label" style="margin-bottom: 8px">
                    {{ t('recipient') }}
                </div>
                <div style="display: flex; gap: 8px">
                    <!--
                      The placeholder is the address *format* of this network,
                      and it is load-bearing rather than decoration: the field
                      arrived completely blank — a frame and a paste icon — and
                      the chip above it named the ticker rather than the
                      network, so nothing on the screen said which of six
                      address shapes belonged in it.
                    -->
                    <input
                        v-model="to"
                        class="cw-input"
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        :placeholder="chain.addressHint"
                        :aria-label="t('recipient')"
                        :aria-invalid="to.length > 0 && !addressValid"
                    />
                    <button
                        type="button"
                        class="cw-icon-btn"
                        style="height: 48px; width: 48px"
                        :aria-label="t('paste')"
                        @click="pasteTo"
                    >
                        ⎘
                    </button>
                </div>
                <p
                    v-if="to.trim().length > 0"
                    style="margin: 8px 0 0; font: 400 11px/1.4 var(--cw-mono)"
                    :style="{
                        color: addressValid
                            ? 'var(--cw-ok)'
                            : 'var(--cw-bad-soft)',
                    }"
                >
                    {{
                        addressValid
                            ? `✓ ${t('addressValid', { kind: account.label })}`
                            : t('addressInvalid', { kind: account.label })
                    }}
                </p>

                <div class="cw-label" style="margin: 22px 0 8px">
                    {{ t('amount') }}
                </div>
                <div
                    class="cw-card"
                    style="padding: 14px; border-radius: 4px"
                    :style="
                        shortfall !== null
                            ? { borderColor: 'var(--cw-bad)' }
                            : { borderColor: 'var(--cw-border-soft)' }
                    "
                >
                    <div style="display: flex; align-items: center; gap: 12px">
                        <input
                            v-model="amount"
                            type="text"
                            inputmode="decimal"
                            placeholder="0.00"
                            :aria-label="t('amount')"
                            style="
                                flex: 1;
                                min-width: 0;
                                border: none;
                                background: transparent;
                                font: 500 26px/1 var(--cw-mono);
                                color: var(--cw-text);
                                outline: none;
                                padding: 0;
                            "
                        />
                        <span
                            style="
                                font: 400 14px/1 var(--cw-mono);
                                color: var(--cw-muted);
                            "
                            >{{ symbol }}</span
                        >
                        <!--
                          The accent is bound rather than inlined so that a
                          disabled Max actually looks disabled: an inline style
                          beats `.cw-ghost:disabled`, which is how this stayed
                          bright and inviting over a line reading "Balance 0".
                        -->
                        <button
                            type="button"
                            class="cw-ghost"
                            style="min-height: 32px"
                            :style="
                                maxSpendable
                                    ? {
                                          borderColor: 'var(--cw-accent)',
                                          color: 'var(--cw-accent)',
                                      }
                                    : undefined
                            "
                            :disabled="
                                maxSpendable === null || maxSpendable === 0n
                            "
                            @click="setMax"
                        >
                            {{ t('max') }}
                        </button>
                    </div>
                    <div
                        class="cw-row"
                        style="
                            margin-top: 12px;
                            padding-top: 12px;
                            border-top: 1px solid var(--cw-line);
                        "
                    >
                        <span
                            style="
                                font: 400 11px/1 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                            >{{
                                formatUsd(
                                    usdValue(
                                        amountUnits,
                                        decimals,
                                        asset === null
                                            ? (prices[chain.id] ?? null)
                                            : ((tokenPrices[chain.id] ?? {})[
                                                  asset.address.toLowerCase()
                                              ] ?? null),
                                    ),
                                    locale,
                                )
                            }}</span
                        >
                        <span
                            style="
                                font: 400 11px/1 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                            >{{ t('balanceShort') }}
                            {{
                                balance === null
                                    ? '—'
                                    : formatUnits(balance, decimals, 6)
                            }}
                            {{ symbol }}</span
                        >
                    </div>
                </div>

                <p
                    v-if="shortfall !== null"
                    class="cw-note cw-note-bad"
                    style="margin-top: 10px"
                >
                    <span>
                        <strong style="display: block">{{
                            t('insufficientTitle')
                        }}</strong>
                        {{
                            t('insufficientBody', {
                                amount: formatUnits(shortfall, decimals, 8),
                                symbol: symbol,
                            })
                        }}
                    </span>
                </p>

                <!--
                  Holding the token but not the coin that moves it. Folding this
                  into "insufficient balance" would point at the wrong asset and
                  send someone looking for USDC they already have.
                -->
                <p
                    v-if="gasShortfall !== null"
                    class="cw-note cw-note-bad"
                    style="margin-top: 10px"
                >
                    <span>
                        <strong style="display: block">{{
                            t('insufficientGasTitle', { gas: chain.symbol })
                        }}</strong>
                        {{
                            t('insufficientGasBody', {
                                amount: formatUnits(
                                    gasShortfall,
                                    chain.decimals,
                                    8,
                                ),
                                gas: chain.symbol,
                                symbol: symbol,
                            })
                        }}
                    </span>
                </p>

                <!--
                  On Cyberia there is something to be done about a fee that
                  cannot be paid: ask the station for it. Renders nothing on any
                  other chain, and nothing when this wallet can already pay.
                -->
                <GasSponsor
                    :chain="props.chain"
                    :address="account?.address"
                    :fee="fee"
                    :gas-balance="gasBalance"
                    :symbol="chain.symbol"
                    :decimals="chain.decimals"
                    @funded="onFunded"
                />

                <!--
                  Paying a contract is a contract call, and the fee above says
                  so. Worth a sentence rather than a silently larger number:
                  the same address pasted twice costs different amounts
                  depending on what is behind it.
                -->
                <p
                    v-if="toIsContract && asset === null"
                    class="cw-note"
                    style="margin-top: 10px"
                >
                    <span>{{ t('toContractNote') }}</span>
                </p>

                <div class="cw-label" style="margin: 22px 0 8px">
                    {{ t('networkFee') }}
                </div>
                <p v-if="quotes.length === 0" class="cw-note cw-note-warn">
                    <span>{{ t('feeUnavailable') }}</span>
                    <button
                        type="button"
                        class="cw-back"
                        style="color: inherit"
                        :aria-label="t('retry')"
                        @click="loadFees"
                    >
                        <RefreshCw :size="14" aria-hidden="true" />
                    </button>
                </p>
                <div v-else style="display: flex; gap: 8px">
                    <button
                        v-for="quote in quotes"
                        :key="quote.tier"
                        type="button"
                        class="cw-stack"
                        style="
                            flex: 1;
                            min-height: 60px;
                            gap: 5px;
                            padding: 10px;
                            border-radius: 4px;
                            text-align: left;
                            cursor: pointer;
                        "
                        :style="{
                            border: `1px solid ${
                                quote.tier === tier
                                    ? chain.mark.hue
                                    : 'var(--cw-border-soft)'
                            }`,
                            background:
                                quote.tier === tier
                                    ? 'rgba(47,233,224,.06)'
                                    : 'var(--cw-surface)',
                        }"
                        :aria-pressed="quote.tier === tier"
                        @click="tier = quote.tier"
                    >
                        <span
                            style="
                                font: 500 11px/1 var(--cw-mono);
                                letter-spacing: 0.1em;
                            "
                            :style="{
                                color:
                                    quote.tier === tier
                                        ? chain.mark.hue
                                        : 'var(--cw-muted)',
                            }"
                            >{{
                                quote.tier === 'slow'
                                    ? t('feeSlow')
                                    : quote.tier === 'normal'
                                      ? t('feeNormal')
                                      : t('feeFast')
                            }}</span
                        >
                        <!--
                          A fee is a quantity of something. This printed the
                          bare figure — `0.0000315` — under a tier name, with
                          the unit nowhere on the card and the line below it in
                          English whatever the interface language was.
                        -->
                        <span
                            style="
                                font: 400 11px/1.3 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                            >{{ formatUnits(quote.fee, account.decimals, 8) }}
                            {{ account.symbol }}</span
                        >
                        <span
                            style="
                                font: 400 10px/1.3 var(--cw-mono);
                                color: var(--cw-faint);
                            "
                            >{{ t(quote.basis.key, quote.basis.params) }}</span
                        >
                    </button>
                </div>

                <div
                    style="
                        margin-top: 22px;
                        padding: 14px 16px;
                        border: 1px solid #1b2126;
                        background: var(--cw-surface);
                    "
                >
                    <div
                        class="cw-label"
                        style="margin-bottom: 9px; color: var(--cw-meta)"
                    >
                        {{ t('youWillSign') }}
                    </div>
                    <p
                        style="
                            margin: 0;
                            font: 400 13px/1.65 var(--cw-sans);
                            color: var(--cw-body);
                            text-wrap: pretty;
                        "
                    >
                        {{ sentence }}
                    </p>
                </div>

                <div class="cw-fill" style="min-height: 20px"></div>
                <button
                    type="button"
                    class="cw-btn cw-btn-primary"
                    style="margin-top: 18px"
                    :disabled="!canReview"
                    @click="review()"
                >
                    {{ t('reviewTransaction') }}
                </button>
            </template>
        </template>

        <!-- Outcome -->
        <template v-else>
            <div style="display: flex; justify-content: flex-end">
                <button
                    type="button"
                    class="cw-icon-btn"
                    style="border: none"
                    :aria-label="t('backToPortfolio')"
                    @click="emit('back')"
                >
                    ✕
                </button>
            </div>
            <div
                class="cw-stack"
                style="
                    flex: 1;
                    align-items: center;
                    justify-content: center;
                    text-align: center;
                    padding-bottom: 40px;
                "
            >
                <component
                    :is="OUTCOMES[outcome].icon"
                    :size="44"
                    aria-hidden="true"
                    :style="{
                        color:
                            outcome === 'confirmed'
                                ? 'var(--cw-ok)'
                                : outcome === 'failed'
                                  ? 'var(--cw-bad)'
                                  : outcome === 'pending'
                                    ? 'var(--cw-pending)'
                                    : 'var(--cw-text)',
                        marginBottom: '26px',
                        animation:
                            outcome === 'signing' || outcome === 'pending'
                                ? 'cw-pulse 1.4s infinite'
                                : undefined,
                    }"
                />
                <StatusPill
                    :status="OUTCOMES[outcome].status"
                    :label="
                        outcome === 'signing'
                            ? t('txSigningLabel')
                            : outcome === 'pending'
                              ? t('txPendingLabel')
                              : outcome === 'confirmed'
                                ? t('txConfirmedLabel')
                                : t('txFailedLabel')
                    "
                />
                <h3
                    class="cw-title"
                    style="margin: 12px 0 10px; font-size: 22px"
                >
                    {{
                        outcome === 'signing'
                            ? t('txSigningTitle')
                            : outcome === 'pending'
                              ? t('txPendingTitle')
                              : outcome === 'confirmed'
                                ? t('txConfirmedTitle')
                                : t('txFailedTitle')
                    }}
                </h3>
                <p class="cw-prose" style="max-width: 34ch">
                    {{
                        outcome === 'signing'
                            ? t('txSigningBody')
                            : outcome === 'pending'
                              ? t('txPendingBody')
                              : outcome === 'confirmed'
                                ? t('txConfirmedBody')
                                : t('txFailedBody')
                    }}
                </p>

                <div
                    class="cw-card"
                    style="width: 100%; margin-top: 28px; padding: 0"
                >
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('kAmount') }}</span>
                        <span class="cw-kv-val">{{ amount }} {{ symbol }}</span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('kTo') }}</span>
                        <span class="cw-kv-val">{{
                            shortAddress(to.trim())
                        }}</span>
                    </div>
                    <!--
                      A broadcast transaction keeps its hash on screen even
                      when watching it fails: the hash is how the transfer is
                      found again, and losing sight of it is what turns a slow
                      confirmation into a second payment.
                    -->
                    <div v-if="txHash" class="cw-kv">
                        <span class="cw-kv-key">{{ t('kTxHash') }}</span>
                        <span class="cw-kv-val">{{
                            shortAddress(txHash, 8, 6)
                        }}</span>
                    </div>
                    <div v-if="failure" class="cw-kv">
                        <span class="cw-kv-key">{{ t('kReason') }}</span>
                        <span
                            class="cw-kv-val"
                            style="color: var(--cw-bad-soft)"
                            >{{ failure }}</span
                        >
                    </div>
                </div>
            </div>

            <div class="cw-stack" style="gap: 8px">
                <button
                    v-if="outcome === 'failed'"
                    type="button"
                    class="cw-btn cw-btn-primary"
                    @click="reset"
                >
                    {{ t('adjustRetry') }}
                </button>
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    @click="emit('back')"
                >
                    {{ t('backToPortfolio') }}
                </button>
                <a
                    v-if="txHash && chain.explorerTxUrl(txHash)"
                    :href="chain.explorerTxUrl(txHash) ?? undefined"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="cw-ghost"
                    style="width: 100%; text-decoration: none"
                >
                    {{ t('viewInExplorer') }} ↗
                </a>
            </div>
        </template>

        <!-- Review sheet -->
        <div v-if="phase === 'review'" class="cw-sheet">
            <div class="cw-sheet-panel">
                <div
                    style="
                        width: 36px;
                        height: 3px;
                        margin: 0 auto 20px;
                        border-radius: 2px;
                        background: var(--cw-border);
                    "
                ></div>
                <div class="cw-row" style="margin-bottom: 6px">
                    <h3
                        class="cw-title"
                        style="font-size: 19px; line-height: 1.2"
                    >
                        {{ t('confirmTransaction') }}
                    </h3>
                    <button
                        type="button"
                        class="cw-icon-btn"
                        style="border: none"
                        :aria-label="t('cancel')"
                        @click="phase = 'compose'"
                    >
                        ✕
                    </button>
                </div>
                <p
                    class="cw-prose"
                    style="margin-bottom: 18px; font-size: 12px"
                >
                    {{ t('reviewBody') }}
                </p>

                <div style="border: 1px solid var(--cw-hairline)">
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('kNetwork') }}</span>
                        <span
                            class="cw-kv-val"
                            style="display: flex; align-items: center; gap: 8px"
                        >
                            <NetworkMark :chain="chain.id" dot :size="6" />
                            {{ account.label }}
                        </span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('kTo') }}</span>
                        <span
                            class="cw-kv-val"
                            style="max-width: 240px; font-weight: 400"
                            >{{ to.trim() }}</span
                        >
                    </div>
                    <!--
                      Which asset, named by its contract. Two tokens can share a
                      ticker; only the address says which one is about to move.
                    -->
                    <div v-if="asset" class="cw-kv">
                        <span class="cw-kv-key">{{ t('kToken') }}</span>
                        <span class="cw-kv-val" style="font-weight: 400"
                            >{{ asset.symbol }} ·
                            {{ shortAddress(asset.address) }}</span
                        >
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('kAmount') }}</span>
                        <span class="cw-kv-val" style="font-size: 14px"
                            >{{ amount }} {{ symbol }}</span
                        >
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('kFee') }}</span>
                        <span class="cw-kv-val" style="font-weight: 400"
                            >{{
                                fee === null
                                    ? '—'
                                    : formatUnits(fee, chain.decimals, 8)
                            }}
                            {{ chain.symbol }}</span
                        >
                    </div>
                    <div
                        class="cw-kv"
                        style="align-items: center; background: #0c0f13"
                    >
                        <span class="cw-kv-key" style="color: var(--cw-text)">{{
                            t('kTotal')
                        }}</span>
                        <span style="text-align: right">
                            <span
                                style="
                                    display: block;
                                    font: 600 16px/1 var(--cw-mono);
                                    color: var(--cw-accent);
                                "
                                >{{
                                    total === null
                                        ? '—'
                                        : formatUnits(total, decimals, 8)
                                }}
                                {{ symbol }}</span
                            >
                            <span
                                style="
                                    display: block;
                                    margin-top: 4px;
                                    font: 400 11px/1 var(--cw-mono);
                                    color: var(--cw-dim);
                                "
                                >{{
                                    formatUsd(
                                        usdValue(
                                            total,
                                            decimals,
                                            asset === null
                                                ? (prices[chain.id] ?? null)
                                                : ((tokenPrices[chain.id] ??
                                                      {})[
                                                      asset.address.toLowerCase()
                                                  ] ?? null),
                                        ),
                                        locale,
                                    )
                                }}</span
                            >
                        </span>
                    </div>
                </div>

                <div
                    style="
                        margin-top: 14px;
                        padding: 13px 14px;
                        border: 1px solid #1b2126;
                        background: #080a0c;
                    "
                >
                    <div
                        class="cw-label"
                        style="margin-bottom: 8px; color: var(--cw-meta)"
                    >
                        {{ t('plainLanguage') }}
                    </div>
                    <p
                        style="
                            margin: 0;
                            font: 400 12px/1.6 var(--cw-sans);
                            color: #b6bec6;
                        "
                    >
                        {{ sentence }} {{ t('nothingElse') }}
                    </p>
                </div>

                <div style="margin-top: 18px">
                    <HoldButton
                        :label="t('holdToSign')"
                        :disabled="wallet.busy.value"
                        @complete="sign"
                    />
                </div>
                <button
                    type="button"
                    class="cw-ghost"
                    style="width: 100%; margin-top: 8px; border: none"
                    @click="phase = 'compose'"
                >
                    {{ t('cancel') }}
                </button>
            </div>
        </div>
    </div>
</template>
