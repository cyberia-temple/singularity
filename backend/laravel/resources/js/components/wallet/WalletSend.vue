<script setup lang="ts">
import { CircleCheck, CircleX, Loader, RefreshCw } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import GasSponsor from '@/components/wallet/GasSponsor.vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import QrScanner from '@/components/wallet/QrScanner.vue';
import StatusPill from '@/components/wallet/StatusPill.vue';
import StockIcon from '@/components/wallet/StockIcon.vue';
import WalletAssetPicker from '@/components/wallet/WalletAssetPicker.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { analytics, errorCode } from '@/lib/analytics';
import { qrScanSupported } from '@/lib/mobileShell';
import { logoForToken } from '@/lib/tokenLogos';
import { formatUnits, parseUnits, walletChain } from '@/lib/wallet';
import type {
    WalletChainId,
    WalletFeeTier,
    WalletTokenBalance,
} from '@/lib/wallet';
import { isFirstTime, lookalikeOf } from '@/lib/wallet/addressSafety';
import { failureReason } from '@/lib/wallet/failure';
import type { FailureReason } from '@/lib/wallet/failure';
import {
    addressGroups,
    formatUsd,
    shortAddress,
    usdValue,
} from '@/lib/wallet/format';
import type { Holding } from '@/lib/wallet/holdings';
import {
    announceWalletEvent,
    playWalletSound,
} from '@/lib/wallet/notifications';
import { parsePaymentUri } from '@/lib/wallet/paymentUri';
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
    /** An address the person already chose, e.g. from somebody's profile. */
    recipient?: string | null;
}>();

const emit = defineEmits<{
    back: [];
    pick: [chain: WalletChainId];
    sent: [];
    addNetwork: [];
}>();

const { locale, t } = useLocale(walletMessages);

type Phase = 'compose' | 'review' | 'status';
/**
 * `failed` is "never reached the network" — nothing moved and nothing was
 * paid. `reverted` reached a block and was refused there: the coins stayed,
 * the fee for the attempt did not. They were one state once, and the screen
 * told people whose fee had been spent that nothing had happened.
 */
type Outcome = 'signing' | 'pending' | 'confirmed' | 'failed' | 'reverted';

const phase = ref<Phase>('compose');
const outcome = ref<Outcome>('signing');
/** null is the network's own coin; anything else is an ERC20 on it. */
const asset = ref<WalletTokenBalance | null>(props.token ?? null);
const to = ref(props.recipient ?? '');

/*
 * The camera fills the recipient, and only the recipient: an amount or a call
 * inside a payment link is somebody else's choice of what to sign.
 */
const canScan = qrScanSupported();
const scanning = ref(false);
const scanRefused = ref(false);
const takeScanned = (text: string): void => {
    scanning.value = false;
    const scanned = parsePaymentUri(text);
    scanRefused.value = scanned === null;

    if (scanned !== null) {
        to.value = scanned.address;
    }
};
const amount = ref('');
const tier = ref<WalletFeeTier>(props.chain === 'cyberia' ? 'slow' : 'normal');
const txHash = ref<string | null>(null);
const failure = ref<FailureReason | null>(null);

const chain = computed(() => walletChain(props.chain));

const account = computed(() =>
    props.wallet.accounts.value.find(
        (candidate) => candidate.chain === props.chain,
    ),
);

/** Addresses this wallet has sent to on this network, newest first. */
const sentTo = computed(() =>
    (props.wallet.history.value[props.chain]?.items ?? [])
        .filter((tx) => tx.direction === 'out' && tx.counterparty)
        .map((tx) => tx.counterparty as string),
);

/** Every address the recipient could be confused with: ours and our recipients. */
const knownAddresses = computed(() => [
    ...props.wallet.accounts.value.map((entry) => entry.address),
    ...sentTo.value,
    ...(props.wallet.history.value[props.chain]?.items ?? [])
        .map((tx) => tx.counterparty)
        .filter((address): address is string => !!address),
]);

const lookalike = computed(() => lookalikeOf(to.value, knownAddresses.value));

/** The whole recipient in groups of four, counted after the `0x`. */
const groupedTo = computed(() => {
    const address = to.value.trim();
    const hex = /^0x/i.test(address);

    return `${hex ? '0x' : ''}${addressGroups(hex ? address.slice(2) : address).join(' ')}`;
});
const firstTime = computed(
    () => to.value.trim() !== '' && isFirstTime(to.value, sentTo.value),
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
    reverted: { icon: CircleX, status: 'failed' },
};

/** Pill, title and body per outcome — one table rather than three ternaries. */
const outcomeCopy = computed(() => {
    switch (outcome.value) {
        case 'signing':
            return {
                label: t('txSigningLabel'),
                title: t('txSigningTitle'),
                body: t('txSigningBody'),
            };
        case 'pending':
            return {
                label: t('txPendingLabel'),
                title: t('txPendingTitle'),
                body: t('txPendingBody'),
            };
        case 'confirmed':
            return {
                label: t('txSettledLabel'),
                title: t('txSettledTitle'),
                body: t('txSettledBody', { network: chain.value.label }),
            };
        case 'reverted':
            return {
                label: t('txRevertedLabel'),
                title: t('txRevertedTitle'),
                body: t('txRevertedBody', {
                    amount: amount.value,
                    symbol: symbol.value,
                }),
            };
        default:
            return {
                label: t('txFailedLabel'),
                title: t('txFailedTitle'),
                body: t('txFailedBody'),
            };
    }
});

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
        failure.value = failureReason(error);
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
        outcome.value =
            (await chain.value.awaitOutcome(txHash.value)) === 'confirmed'
                ? 'confirmed'
                : 'reverted';

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
                    ? t('txSettledTitle')
                    : t('txRevertedTitle'),
            body: `${chain.value.label} · ${
                outcome.value === 'confirmed'
                    ? t('txSettledBody', { network: chain.value.label })
                    : t('txRevertedBody', {
                          amount: amount.value,
                          symbol: symbol.value,
                      })
            }`,
            sound: outcome.value === 'confirmed' ? 'success' : 'error',
            tag: txHash.value ? `transaction:${txHash.value}` : undefined,
        });
    } catch (error) {
        failure.value = failureReason(error);

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
        tier.value = props.chain === 'cyberia' ? 'slow' : 'normal';
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

/** The list of everything sendable, open in place of the form. */
const picking = ref(false);

/**
 * A token chosen on another network. Switching the network clears the asset
 * (see the watch above), so the choice waits here and is applied once the
 * new network has arrived.
 */
let pendingAsset: WalletTokenBalance | null = null;

watch(
    () => props.chain,
    () => {
        if (pendingAsset) {
            asset.value = pendingAsset;
            pendingAsset = null;
        }
    },
);

const choose = (row: Holding): void => {
    picking.value = false;

    if (row.chain === props.chain) {
        pickAsset(row.token);

        return;
    }

    pendingAsset = row.token;
    emit('pick', row.chain);
};

/** What the chosen asset looks like on the button that changes it. */
const assetLogo = computed(() =>
    logoForToken(
        chain.value.chainId,
        asset.value?.address ?? null,
        symbol.value,
    ),
);

const balanceShown = computed(() =>
    balance.value === null
        ? '—'
        : formatUnits(balance.value, decimals.value, 4),
);
</script>

<template>
    <div v-if="account" class="cw-stack cw-screen">
        <WalletAssetPicker
            v-if="picking && phase === 'compose'"
            :wallet="wallet"
            :prices="prices"
            :token-prices="tokenPrices"
            :selected="{ chain: chain.id, address: asset?.address ?? null }"
            @pick="choose"
            @close="picking = false"
            @add-network="emit('addNetwork')"
        />

        <!-- Compose -->
        <template v-else-if="phase !== 'status'">
            <div class="cw-row" style="margin-bottom: 20px">
                <button type="button" class="cw-back" @click="emit('back')">
                    ← {{ t('back') }}
                </button>
                <span style="font: 500 14px/1 var(--cw-sans)">{{
                    t('send')
                }}</span>
                <span style="width: 44px"></span>
            </div>

            <!--
              What is being sent, and from which network, as one choice: the
              button opens every sendable coin and token across networks.
            -->
            <button
                type="button"
                class="cw-asset cw-asset-current"
                style="margin-bottom: 20px"
                @click="picking = true"
            >
                <StockIcon
                    v-if="assetLogo"
                    :symbol="symbol"
                    :src="assetLogo"
                    :size="40"
                />
                <NetworkMark v-else :chain="chain.id" />
                <span style="flex: 1; min-width: 0; text-align: left">
                    <span class="cw-asset-name">{{ symbol }}</span>
                    <span class="cw-asset-sub"
                        >{{ account.label }} ·
                        {{ t('sendAvailable', { amount: balanceShown }) }}</span
                    >
                </span>
                <span class="cw-asset-sub" style="flex: none">{{
                    t('sendChange')
                }}</span>
            </button>

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
                    <button
                        v-if="canScan"
                        type="button"
                        class="cw-icon-btn"
                        style="height: 48px; width: 48px"
                        :aria-label="t('qrScan')"
                        :title="t('qrScan')"
                        @click="scanning = true"
                    >
                        ⌗
                    </button>
                </div>
                <QrScanner
                    v-if="scanning"
                    @detected="takeScanned"
                    @close="scanning = false"
                />
                <p
                    v-if="scanRefused"
                    style="
                        margin: 8px 0 0;
                        font: 500 13px/1.4 var(--cw-mono);
                        color: var(--cw-bad-soft);
                    "
                >
                    {{ t('qrNotAddress') }}
                </p>
                <p
                    v-if="to.trim().length > 0"
                    style="margin: 8px 0 0; font: 500 13px/1.4 var(--cw-mono)"
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
                                font: 400 16px/1 var(--cw-mono);
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
                                font: 500 13px/1 var(--cw-mono);
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
                                font: 500 13px/1 var(--cw-mono);
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
                <div v-else-if="props.chain === 'cyberia'" class="cw-note">
                    {{
                        fee === null
                            ? t('feeUnavailable')
                            : `${formatUnits(fee, account.decimals, 8)} ${account.symbol}`
                    }}
                </div>
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
                                font: 500 13px/1 var(--cw-mono);
                                letter-spacing: 0.07em;
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
                                font: 500 13px/1.3 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                            >{{ formatUnits(quote.fee, account.decimals, 8) }}
                            {{ account.symbol }}</span
                        >
                        <span
                            style="
                                font: 500 12px/1.3 var(--cw-mono);
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
                            font: 400 15px/1.65 var(--cw-sans);
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
                                : outcome === 'failed' || outcome === 'reverted'
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
                    :label="outcomeCopy.label"
                />
                <h3
                    class="cw-title"
                    style="margin: 12px 0 10px; font-size: 22px"
                >
                    {{ outcomeCopy.title }}
                </h3>
                <p class="cw-prose" style="max-width: 34ch">
                    {{ outcomeCopy.body }}
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
                            >{{ t(failure.key) }}</span
                        >
                    </div>
                </div>
                <!--
                  The node's own words, for whoever helps with this later. Kept
                  out of sight: it is English, it can be hundreds of characters
                  of hex, and it once held the whole signed transaction.
                -->
                <details
                    v-if="failure && failure.detail"
                    class="cw-details"
                    style="width: 100%; margin-top: 12px; text-align: left"
                >
                    <summary class="cw-ghost" style="cursor: pointer">
                        {{ t('kDetails') }}
                    </summary>
                    <pre
                        class="cw-mono"
                        style="
                            white-space: pre-wrap;
                            word-break: break-all;
                            max-height: 160px;
                            overflow: auto;
                            font-size: 12px;
                            color: var(--cw-faint);
                            margin: 8px 0 0;
                        "
                        >{{ failure.detail }}</pre
                    >
                </details>
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
                <!-- After a refusal on chain, retrying pays another fee: offered, not urged. -->
                <button
                    v-if="outcome === 'reverted'"
                    type="button"
                    class="cw-ghost"
                    style="width: 100%"
                    @click="reset"
                >
                    {{ t('adjustRetry') }}
                </button>
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
                        style="font-size: 20px; line-height: 1.2"
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
                    style="margin-bottom: 18px; font-size: 14px"
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
                            >{{ groupedTo }}</span
                        >
                    </div>
                    <p
                        v-if="lookalike"
                        class="cw-note cw-note-warn"
                        style="margin: 0"
                        role="alert"
                    >
                        {{
                            t('addrLookalike', {
                                known: shortAddress(lookalike, 8, 6),
                            })
                        }}
                    </p>
                    <p v-else-if="firstTime" class="cw-note" style="margin: 0">
                        {{ t('addrFirstTime') }}
                    </p>
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
                        <span class="cw-kv-val" style="font-size: 16px"
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
                                    font: 600 17px/1 var(--cw-mono);
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
                                    font: 500 13px/1 var(--cw-mono);
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
                            font: 400 14px/1.6 var(--cw-sans);
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
