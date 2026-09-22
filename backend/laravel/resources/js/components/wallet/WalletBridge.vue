<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { analytics, errorCode } from '@/lib/analytics';
import {
    ERC20_TRANSFER_GAS_CAP,
    formatUnits,
    nativeSendGas,
    parseUnits,
    walletChain,
} from '@/lib/wallet';
import type { WalletChainId } from '@/lib/wallet';
import {
    bridgeBlockFor,
    bridgeOptions,
    bridgeRateFee,
    depositAddressFor,
    submitBridge,
} from '@/lib/wallet/bridge';
import type { BridgeConfig } from '@/lib/wallet/bridge';
import { formatUsd, usdValue } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Moving an asset to another chain.
 *
 * The screen is built around the seam rather than hiding it. What this wallet
 * does is sign one ordinary transfer to the bridge's deposit address on the
 * source chain; what Cyberia does is pay out on the other side against that
 * deposit. Between the two there is no cancel and no undo, so that sentence is
 * on screen above the hold rather than in a help page.
 *
 * The recipient defaults to this wallet's own address on the destination chain
 * and is the reason bridging belongs in a wallet at all: one seed derives both
 * ends, so the usual way to lose money here — pasting an address that belongs
 * to an exchange, a contract, or nobody — is not something the user has to do.
 * It stays editable, because sending to somebody else is a real thing to want.
 *
 * Corridors this wallet cannot construct the lock leg for are listed with the
 * reason instead of being dropped. "Cyberia does not bridge there" and "Cyberia
 * bridges there, but not from this screen" are different facts, and only one of
 * them is about this app.
 */

const props = defineProps<{
    wallet: MultiWallet;
    config: BridgeConfig;
    prices: Record<string, number | null>;
}>();

const emit = defineEmits<{ back: [] }>();

const { locale, t } = useLocale(walletMessages);

/** EVM chain ids this wallet holds an account on, which decides what it can sign. */
const walletChainIds = computed(() =>
    props.wallet.accounts.value
        .map((account) => walletChain(account.chain).chainId)
        .filter((id): id is number => id !== undefined),
);

const options = computed(() =>
    bridgeOptions(props.config, walletChainIds.value),
);

/** Corridors this wallet can sign, first — the rest are still shown, below. */
const open = computed(() =>
    options.value.filter((option) => option.block === 'ok'),
);

/**
 * The corridors that exist but cannot be started here, gathered by the reason.
 *
 * Every one of them stays listed — a corridor that quietly disappears is a
 * corridor somebody goes looking for on the site — but the *reason* was printed
 * under each row, which meant "Coming soon" nine times and one of two sentences
 * five more, thirty lines to say three things. The reason is a heading now and
 * the corridors are the list under it.
 */
const closed = computed(() => {
    const groups = new Map<string, { reason: string; routes: string[] }>();

    for (const option of options.value) {
        if (option.block === 'ok') {
            continue;
        }

        const reason =
            option.block === 'closed' && option.unavailableReason
                ? option.unavailableReason
                : t(
                      `bridgeBlock${option.block.charAt(0).toUpperCase()}${option.block.slice(1)}`,
                  );

        const group = groups.get(reason) ?? { reason, routes: [] };

        group.routes.push(`${option.sourceLabel} → ${option.destinationLabel}`);
        groups.set(reason, group);
    }

    return [...groups.values()];
});

const direction = ref<string | null>(null);
const symbol = ref<string | null>(null);
const amount = ref('');
const recipient = ref('');
const recipientTouched = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
const gasPrice = ref<bigint | null>(null);
const depositIsContract = ref(false);

type Done = {
    hash: string;
    url: string | null;
    submitted: boolean;
    message: string | null;
};

const done = ref<Done | null>(null);

const route = computed(
    () =>
        props.config.routes.find(
            (entry) => entry.direction === direction.value,
        ) ?? null,
);

const option = computed(
    () =>
        options.value.find((entry) => entry.direction === direction.value) ??
        null,
);

const sourceChain = computed(
    () =>
        props.config.chains.find(
            (chain) => chain.key === route.value?.source,
        ) ?? null,
);

const destinationChain = computed(
    () =>
        props.config.chains.find(
            (chain) => chain.key === route.value?.destination,
        ) ?? null,
);

/** The wallet chain the source leg is signed on, matched by EVM chain id. */
const sourceWalletChain = computed<WalletChainId | null>(() => {
    const id = sourceChain.value?.evmChainId ?? null;

    if (id === null) {
        return null;
    }

    return (
        props.wallet.accounts.value.find(
            (account) => walletChain(account.chain).chainId === id,
        )?.chain ?? null
    );
});

/**
 * The wallet's own account on the far side.
 *
 * Matched by EVM chain id where there is one, and by name otherwise — the
 * bridge's chain keys and this wallet's chain ids are the same words for
 * Solana and the Bitcoin family, and a mismatch simply means no default and a
 * field the user fills in.
 */
const destinationAccount = computed(() => {
    const chain = destinationChain.value;

    if (!chain) {
        return null;
    }

    return (
        props.wallet.accounts.value.find(
            (account) =>
                chain.evmChainId !== null &&
                walletChain(account.chain).chainId === chain.evmChainId,
        ) ??
        props.wallet.accounts.value.find(
            (account) => account.chain === chain.key,
        ) ??
        null
    );
});

const token = computed(
    () =>
        props.config.tokens.find((entry) => entry.symbol === symbol.value) ??
        null,
);

/** How this token exists on the source chain: a contract, or the coin itself. */
const sourceToken = computed(() => {
    const key = route.value?.source;

    return key ? (token.value?.chains[key] ?? null) : null;
});

const decimals = computed(() => sourceToken.value?.decimals ?? 18);

const deposit = computed(() =>
    route.value ? depositAddressFor(props.config, route.value.source) : null,
);

const block = computed(() =>
    route.value
        ? bridgeBlockFor(
              props.config,
              route.value,
              symbol.value,
              walletChainIds.value,
          )
        : 'ok',
);

/* --------------------------------------------------------------- amounts -- */

/** What this account holds of the chosen asset on the source chain. */
const balance = computed<bigint | null>(() => {
    const chain = sourceWalletChain.value;
    const entry = sourceToken.value;

    if (!chain || !entry) {
        return null;
    }

    if (entry.native) {
        return props.wallet.balances.value[chain]?.value ?? null;
    }

    const held = (props.wallet.tokens.value[chain]?.items ?? []).find(
        (candidate) =>
            candidate.address.toLowerCase() ===
            (entry.address ?? '').toLowerCase(),
    );

    return held?.balance ?? null;
});

const amountUnits = computed(() => {
    if (amount.value.trim() === '') {
        return 0n;
    }

    try {
        return parseUnits(amount.value.trim(), decimals.value);
    } catch {
        return -1n;
    }
});

const fee = computed(() =>
    amountUnits.value > 0n
        ? bridgeRateFee(amountUnits.value, props.config.feeBps)
        : 0n,
);

const received = computed(() =>
    amountUnits.value > 0n ? amountUnits.value - fee.value : 0n,
);

/** The gas the lock will be signed for, which depends on what it is. */
const gasLimit = computed(() =>
    sourceToken.value?.native
        ? nativeSendGas(depositIsContract.value)
        : ERC20_TRANSFER_GAS_CAP,
);

const networkFee = computed(() =>
    gasPrice.value === null ? null : gasPrice.value * gasLimit.value,
);

const networkFeeUsd = computed(() => {
    const chain = sourceWalletChain.value;

    return networkFee.value === null || chain === null
        ? null
        : usdValue(
              networkFee.value,
              walletChain(chain).decimals,
              props.prices[chain] ?? null,
          );
});

/** The coin balance that pays the fee, which is not always the asset sent. */
const gasBalance = computed(() =>
    sourceWalletChain.value
        ? (props.wallet.balances.value[sourceWalletChain.value]?.value ?? null)
        : null,
);

type Refusal =
    | 'ok'
    | 'noAmount'
    | 'noRecipient'
    | 'badRecipient'
    | 'tooMuch'
    | 'noGas'
    | 'noFee'
    | 'blocked';

const refusal = computed<Refusal>(() => {
    if (block.value !== 'ok') {
        return 'blocked';
    }

    if (amountUnits.value <= 0n) {
        return 'noAmount';
    }

    if (recipient.value.trim() === '') {
        return 'noRecipient';
    }

    if (!recipientValid.value) {
        return 'badRecipient';
    }

    if (balance.value !== null && amountUnits.value > balance.value) {
        return 'tooMuch';
    }

    if (networkFee.value === null) {
        return 'noFee';
    }

    // The coin pays the fee whether or not it is what is being sent, so a
    // token transfer with no coin behind it is refused for gas rather than
    // for the amount — two different problems with two different fixes.
    const needed =
        networkFee.value + (sourceToken.value?.native ? amountUnits.value : 0n);

    return gasBalance.value !== null && needed > gasBalance.value
        ? 'noGas'
        : 'ok';
});

/**
 * Whether the destination address is the shape that chain uses.
 *
 * Checked against this wallet's own adapter when the destination is a network
 * it knows; otherwise the server's validator is the authority and this side
 * only insists the field is not empty. A wrong-shaped address is the one
 * mistake here that cannot be undone by anybody.
 */
const recipientValid = computed(() => {
    const value = recipient.value.trim();

    if (value === '') {
        return false;
    }

    const chain = destinationAccount.value?.chain;

    if (!chain) {
        return true;
    }

    try {
        return walletChain(chain).isValidAddress(value);
    } catch {
        return true;
    }
});

const ready = computed(() => refusal.value === 'ok' && !busy.value);

/* ------------------------------------------------------------ selection -- */

const choose = (next: string): void => {
    direction.value = next;
    done.value = null;
    error.value = null;
    amount.value = '';

    const first = options.value.find((entry) => entry.direction === next);

    symbol.value = first?.tokens[0] ?? null;
};

// Picking a corridor answers three questions at once: which key signs, where
// the coin lands by default, and what a transfer costs there.
watch([direction, sourceWalletChain, deposit], async () => {
    const chain = sourceWalletChain.value;

    gasPrice.value = null;
    depositIsContract.value = false;

    if (!recipientTouched.value) {
        recipient.value = destinationAccount.value?.address ?? '';
    }

    if (!chain) {
        return;
    }

    try {
        gasPrice.value = await props.wallet.gasPrice(chain);
    } catch {
        gasPrice.value = null;
    }

    // Never estimated: this chain answers `eth_estimateGas` for a value
    // transfer with 21000 whether or not the recipient has code, and a deposit
    // that runs out of gas inside a contract's `receive()` keeps the fee.
    if (deposit.value) {
        try {
            depositIsContract.value = await props.wallet.recipientIsContract(
                chain,
                deposit.value,
            );
        } catch {
            depositIsContract.value = true;
        }
    }

    // A corridor whose cost this screen can actually state. The step between
    // opening the bridge and having a price is where "which chains do you
    // support" turns into "what will this cost me", and a corridor that never
    // reaches it is either closed or unreadable.
    if (gasPrice.value !== null && route.value) {
        analytics.track('bridge_quote_received', {
            chain,
            from_chain: route.value.source,
            to_chain: route.value.destination,
            asset: symbol.value ?? undefined,
        });
    }
});

const setMax = (): void => {
    if (balance.value === null) {
        return;
    }

    // The coin pays its own fee, so "max" for the coin is the balance less
    // what the transfer will cost — offering the whole balance would produce
    // a transaction that cannot be mined.
    const spendable = sourceToken.value?.native
        ? balance.value - (networkFee.value ?? 0n)
        : balance.value;

    amount.value =
        spendable > 0n ? formatUnits(spendable, decimals.value, 18) : '0';
};

const sentence = computed(() => {
    if (!route.value || !symbol.value || amountUnits.value <= 0n) {
        return '';
    }

    return t('bridgeSentence', {
        amount: amount.value.trim(),
        symbol: symbol.value,
        source: route.value.sourceLabel,
        destination: route.value.destinationLabel,
        to: `${recipient.value.trim().slice(0, 10)}…${recipient.value.trim().slice(-6)}`,
        fee:
            networkFee.value === null || sourceWalletChain.value === null
                ? '—'
                : `${formatUnits(networkFee.value, walletChain(sourceWalletChain.value).decimals, 6)} ${walletChain(sourceWalletChain.value).symbol}`,
    });
});

/* -------------------------------------------------------------- signing -- */

/**
 * A corridor, an asset and roughly what it is worth. Never the recipient —
 * that is an address on another chain, and the whole reason the wallet fills
 * it in for you is that it is yours.
 */
const traits = () => ({
    chain: sourceWalletChain.value ?? undefined,
    from_chain: route.value?.source ?? undefined,
    to_chain: route.value?.destination ?? undefined,
    asset: symbol.value ?? undefined,
    transaction_type: 'bridge' as const,
    amount_usd:
        usdValue(
            amountUnits.value,
            decimals.value,
            sourceWalletChain.value
                ? (props.prices[sourceWalletChain.value] ?? null)
                : null,
        ) ?? undefined,
    fee_usd: networkFeeUsd.value ?? undefined,
});

const sign = async (): Promise<void> => {
    const chain = sourceWalletChain.value;
    const chainId = sourceChain.value?.evmChainId ?? null;
    const rpcUrl = sourceChain.value?.rpcUrl ?? null;
    const to = deposit.value;

    if (
        !ready.value ||
        !chain ||
        chainId === null ||
        !rpcUrl ||
        !to ||
        !route.value ||
        !symbol.value ||
        gasPrice.value === null
    ) {
        return;
    }

    busy.value = true;
    error.value = null;
    done.value = null;

    const startedAt = Date.now();

    analytics.track('bridge_started', traits());

    const account = props.wallet.accounts.value.find(
        (entry) => entry.chain === chain,
    );

    try {
        const lock = await props.wallet.bridgeDeposit(chain, {
            chainId,
            rpcUrl,
            deposit: to,
            contract: sourceToken.value?.native
                ? null
                : (sourceToken.value?.address ?? null),
            amount: amountUnits.value,
            gasPrice: gasPrice.value,
            gasLimit: gasLimit.value,
        });

        // The transfer is broadcast. Whatever the relayer says next, this hash
        // exists and is the only thing that proves the deposit.
        const explorer = sourceChain.value?.explorerTx ?? null;

        done.value = {
            hash: lock.txHash,
            url: explorer ? explorer.replace('{hash}', lock.txHash) : null,
            submitted: false,
            message: null,
        };

        // The source leg is on chain. Everything after this is the relayer's,
        // and it is a separate step precisely because it can fail on its own.
        analytics.track('bridge_deposit_confirmed', {
            ...traits(),
            duration_ms: Date.now() - startedAt,
        });

        const outcome = await submitBridge({
            direction: route.value.direction,
            token: symbol.value,
            sourceTxHash: lock.txHash,
            sourceNonce: lock.nonce,
            sender: account?.address ?? '',
            recipient: recipient.value.trim(),
            amount: amount.value.trim(),
        });

        done.value = {
            ...done.value,
            submitted: outcome.ok,
            message: outcome.message,
        };

        /*
         * "Completed" here means the deposit registered with the relayer, not
         * that the payout landed — the wallet never learns that, and it says
         * so on screen. A deposit that broadcast but failed to register is the
         * failure worth counting, because it is the one that needs a human.
         */
        analytics.track(outcome.ok ? 'bridge_completed' : 'bridge_failed', {
            ...traits(),
            duration_ms: Date.now() - startedAt,
            ...(outcome.ok ? {} : { error_code: 'server_refused' as const }),
        });

        amount.value = '';
        await props.wallet.refreshBalances();
    } catch (failure) {
        error.value =
            failure instanceof Error ? failure.message : String(failure);

        analytics.track('bridge_failed', {
            ...traits(),
            error_code: errorCode(failure),
            duration_ms: Date.now() - startedAt,
        });
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ t('bridgeTitle') }}
        </h2>
        <p class="cw-prose">{{ t('bridgeBody') }}</p>

        <!-- Corridors this wallet can sign the source leg of. -->
        <div class="cw-label" style="margin-top: 24px">
            {{ t('bridgeRoutes') }}
        </div>

        <p v-if="open.length === 0" class="cw-note" style="margin-top: 10px">
            <span>{{ t('bridgeNoneOpen') }}</span>
        </p>

        <div v-else class="cw-stack" style="gap: 8px; margin-top: 10px">
            <button
                v-for="entry in open"
                :key="entry.direction"
                type="button"
                class="cw-card cw-card-button"
                :style="
                    entry.direction === direction
                        ? { borderColor: 'var(--cw-accent)' }
                        : undefined
                "
                @click="choose(entry.direction)"
            >
                <div class="cw-row">
                    <span
                        style="
                            font: 500 15px/1.2 var(--cw-sans);
                            color: var(--cw-text);
                        "
                        >{{ entry.sourceLabel }} →
                        {{ entry.destinationLabel }}</span
                    >
                    <span class="cw-label" style="color: var(--cw-faint)">{{
                        entry.tokens.join(' · ') || '—'
                    }}</span>
                </div>
            </button>
        </div>

        <!-- The composer, once a corridor is chosen. -->
        <template v-if="route">
            <div class="cw-label" style="margin: 26px 0 10px">
                {{ t('bridgeAsset') }}
            </div>
            <div class="cw-seg">
                <button
                    v-for="entry in option?.tokens ?? []"
                    :key="entry"
                    type="button"
                    class="cw-seg-item"
                    :class="{ 'cw-seg-bar': entry === symbol }"
                    :aria-pressed="entry === symbol"
                    @click="
                        symbol = entry;
                        done = null;
                    "
                >
                    {{ entry }}
                </button>
            </div>

            <!--
              A corridor that carries this token but cannot be started from
              here. The reason is the whole message: one of these is Cyberia's
              state and the other is this app's.
            -->
            <p
                v-if="block !== 'ok'"
                class="cw-note cw-note-warn"
                style="margin-top: 14px"
            >
                <span>{{
                    t(
                        `bridgeBlock${block.charAt(0).toUpperCase()}${block.slice(1)}`,
                    )
                }}</span>
            </p>

            <template v-else>
                <div class="cw-row" style="margin: 22px 0 8px">
                    <span class="cw-label">{{ t('amount') }}</span>
                    <button type="button" class="cw-back" @click="setMax()">
                        {{ t('max') }}
                    </button>
                </div>
                <input
                    v-model="amount"
                    class="cw-input"
                    inputmode="decimal"
                    spellcheck="false"
                    placeholder="0.0"
                    :aria-label="t('amount')"
                />
                <div class="cw-row" style="margin-top: 8px">
                    <span class="cw-label" style="color: var(--cw-faint)"
                        >{{ t('balanceShort') }}
                        {{
                            balance === null
                                ? '—'
                                : formatUnits(balance, decimals, 6)
                        }}
                        {{ symbol }}</span
                    >
                </div>

                <div class="cw-label" style="margin: 22px 0 8px">
                    {{ t('bridgeRecipient') }}
                </div>
                <input
                    v-model="recipient"
                    class="cw-input"
                    spellcheck="false"
                    autocomplete="off"
                    :aria-label="t('bridgeRecipient')"
                    :aria-invalid="recipient !== '' && !recipientValid"
                    @input="recipientTouched = true"
                />
                <p
                    v-if="
                        destinationAccount &&
                        recipient.trim().toLowerCase() ===
                            destinationAccount.address.toLowerCase()
                    "
                    class="cw-label"
                    style="margin-top: 8px; color: var(--cw-ok)"
                >
                    {{ t('bridgeOwnAddress') }}
                </p>

                <!-- What arrives, and what it cost to send it. -->
                <div style="margin-top: 22px; border: 1px solid var(--cw-line)">
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{
                            t('bridgeYouReceive', {
                                chain: route.destinationLabel,
                            })
                        }}</span>
                        <span class="cw-kv-val"
                            >{{ formatUnits(received, decimals, 6) }}
                            {{ symbol }}</span
                        >
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('bridgeFee') }}</span>
                        <span class="cw-kv-val">
                            {{ formatUnits(fee, decimals, 6) }} {{ symbol }}
                            <template v-if="config.feeFlatUsd > 0">
                                +
                                {{ formatUsd(config.feeFlatUsd, locale) }}
                            </template>
                        </span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{
                            t('bridgeGasSource')
                        }}</span>
                        <span class="cw-kv-val">
                            <template
                                v-if="networkFee !== null && sourceWalletChain"
                            >
                                {{
                                    formatUnits(
                                        networkFee,
                                        walletChain(sourceWalletChain).decimals,
                                        6,
                                    )
                                }}
                                {{ walletChain(sourceWalletChain).symbol }}
                                <template v-if="networkFeeUsd !== null"
                                    >·
                                    {{
                                        formatUsd(networkFeeUsd, locale)
                                    }}</template
                                >
                            </template>
                            <template v-else>—</template>
                        </span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('bridgeArrival') }}</span>
                        <span class="cw-kv-val">{{
                            route.autoProcess
                                ? t('bridgeArrivalAuto')
                                : t('bridgeArrivalManual')
                        }}</span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('bridgeDeposit') }}</span>
                        <span class="cw-kv-val">{{ deposit ?? '—' }}</span>
                    </div>
                </div>

                <!--
                  The one thing this screen exists to say. It sits above the
                  hold, not in a help page: after the source transaction is
                  final the funds are out of the user's hands until the payout
                  lands, and nothing here can call them back.
                -->
                <p class="cw-note cw-note-warn" style="margin-top: 18px">
                    <span>
                        <strong style="display: block">{{
                            t('bridgeLeavingTitle')
                        }}</strong>
                        {{ t('bridgeLeavingBody') }}
                    </span>
                </p>

                <p
                    v-if="refusal !== 'ok' && refusal !== 'blocked'"
                    class="cw-label"
                    style="margin-top: 14px; color: var(--cw-pending)"
                >
                    {{
                        t(
                            `bridgeRefusal${refusal.charAt(0).toUpperCase()}${refusal.slice(1)}`,
                        )
                    }}
                </p>

                <p v-if="sentence" class="cw-prose" style="margin-top: 14px">
                    {{ sentence }}
                </p>

                <p
                    v-if="error"
                    class="cw-note cw-note-bad"
                    style="margin-top: 14px"
                >
                    <span>{{ error }}</span>
                </p>

                <!--
                  Two outcomes, and they are not the same. The deposit is
                  broadcast either way; whether the relayer has been told about
                  it is a second, separate fact — and if it has not, the hash is
                  what the operator needs.
                -->
                <div
                    v-if="done"
                    class="cw-note"
                    :class="done.submitted ? '' : 'cw-note-warn'"
                    style="margin-top: 14px"
                >
                    <span>
                        <strong style="display: block">{{
                            done.submitted
                                ? t('bridgeSubmitted')
                                : t('bridgeNotSubmitted')
                        }}</strong>
                        {{ done.message ?? t('bridgeNotSubmittedBody') }}
                        <a
                            v-if="done.url"
                            :href="done.url"
                            target="_blank"
                            rel="noopener"
                            style="display: block; margin-top: 6px"
                            >{{ t('viewInExplorer') }}</a
                        >
                    </span>
                </div>

                <div style="margin-top: 18px">
                    <HoldButton
                        :label="t('holdToSign')"
                        :disabled="!ready"
                        @complete="sign()"
                    />
                </div>
            </template>
        </template>

        <!-- Corridors that exist but not from here, with the reason. -->
        <template v-if="closed.length > 0">
            <div class="cw-label" style="margin: 30px 0 10px">
                {{ t('bridgeElsewhere') }}
            </div>
            <div class="cw-card" style="padding: 0">
                <div
                    v-for="group in closed"
                    :key="group.reason"
                    style="
                        padding: 12px 16px;
                        border-bottom: 1px solid var(--cw-line);
                    "
                >
                    <span
                        style="
                            display: block;
                            font: 500 13px/1.4 var(--cw-mono);
                            color: var(--cw-faint);
                        "
                        >{{ group.reason }}</span
                    >
                    <span
                        style="
                            display: block;
                            margin-top: 5px;
                            font: 400 14px/1.5 var(--cw-sans);
                            color: var(--cw-muted);
                        "
                        >{{ group.routes.join(' · ') }}</span
                    >
                </div>
            </div>
            <p class="cw-prose" style="margin-top: 12px">
                {{ t('bridgeElsewhereNote') }}
                <a href="/bridge">{{ t('bridgeOpenPage') }}</a>
            </p>
        </template>

        <div
            v-if="sourceWalletChain"
            style="
                display: flex;
                align-items: center;
                gap: 8px;
                margin-top: 22px;
            "
        >
            <NetworkMark :chain="sourceWalletChain" dot :size="6" />
            <span class="cw-label" style="color: var(--cw-faint)">{{
                t('bridgeSameSeed')
            }}</span>
        </div>
    </div>
</template>
