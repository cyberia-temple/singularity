<script setup lang="ts">
import { Wallet, Clock, Flame } from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';

import type { RecentDestination } from '@/composables/useBridgeFlow';
import { bridgeRoute, isManualBridgeRoute } from '@/lib/addressValidation';
import { validateDestination } from '@/lib/addressValidation';
import type { BridgeDirection } from '@/lib/addressValidation';
import type { DestinationCapacity } from '@/lib/bridgeCapacity';
import { capacityVerdict } from '@/lib/bridgeCapacity';
import { tokensForRoute } from '@/lib/bridgeConfig';
import type { BridgeTokenSymbol } from '@/lib/bridgeTokens';

const props = defineProps<{
    direction: BridgeDirection;
    token: BridgeTokenSymbol;
    amount: string;
    sourceTxHash: string;
    sourceAddress: string;
    destinationAddress: string;
    convertToNative: boolean;
    convertEnabled: boolean;
    convertRate: number;
    sourceWalletConnected: boolean;
    sourceWalletAddress: string | null;
    sourceWalletConnecting: boolean;
    sourceBalance: string | null;
    sourceMaxAmount: string | null;
    /**
     * What the destination can deliver right now — a state, not a number. A
     * failed read is `unavailable` and blocks; it is never an absent limit.
     */
    destinationCapacity: DestinationCapacity;
    /** Destination chain label (e.g. "Base") for the capacity hint. */
    destinationLabel: string | null;
    sourceDepositAddress: string | null;
    /** One-time deposit address returned by /bridge/prepare. */
    preparedDepositAddress: string | null;
    /** When the deposit address stops being monitored (ISO timestamp). */
    depositExpiresAt: string | null;
    /** Confirmations the source chain needs before the deposit is credited. */
    depositConfirmations: number | null;
    preparing: boolean;
    recent: RecentDestination[];
    /** The signed-in user's saved native Monero payout address, if any. */
    savedMoneroAddress: string | null;
}>();

const emit = defineEmits<{
    (e: 'update:amount', v: string): void;
    (e: 'update:sourceTxHash', v: string): void;
    (e: 'update:sourceAddress', v: string): void;
    (e: 'update:destinationAddress', v: string): void;
    (e: 'update:token', v: BridgeTokenSymbol): void;
    (e: 'update:convertToNative', v: boolean): void;
    (e: 'connect-source'): void;
    (e: 'prepare'): void;
    (e: 'claim'): void;
    (e: 'next'): void;
    (e: 'back'): void;
}>();

const tokenSymbols = computed(
    () => tokensForRoute(props.direction) as BridgeTokenSymbol[],
);

const localToken = computed({
    get: () => props.token,
    set: (v) => emit('update:token', v),
});

const localAmount = computed({
    get: () => props.amount,
    set: (v) => emit('update:amount', v),
});

const localSourceTxHash = computed({
    get: () => props.sourceTxHash,
    set: (v) => emit('update:sourceTxHash', v),
});

const localSourceAddress = computed({
    get: () => props.sourceAddress,
    set: (v) => emit('update:sourceAddress', v),
});

const localDestination = computed({
    get: () => props.destinationAddress,
    set: (v) => emit('update:destinationAddress', v),
});

const localConvert = computed({
    get: () => props.convertToNative,
    set: (v) => emit('update:convertToNative', v),
});

// Auto-conversion is only offered for CYBER.sol arriving on Cyberia.
const convertAvailable = computed(
    () =>
        props.convertEnabled &&
        props.direction === 'sol_to_evm' &&
        props.token === 'CYBER.sol',
);

const route = computed(() => bridgeRoute(props.direction));

const manualRoute = computed(() => isManualBridgeRoute(props.direction));

const manualReviewRoute = computed(
    () => manualRoute.value && !route.value.autoProcess,
);

// Two chains hand out an address instead of taking a transaction hash
// (prepare → claim): the address belongs to one request and the recipient is
// committed before a coin moves. Yenten because a light wallet's hash is not
// something a person can reliably copy; Monero because nobody outside the
// receiving wallet can look a transaction up at all, so the address is the
// only thing that can attribute a deposit. Other manual routes (TON) keep the
// shared-address flow.
const oneTimeDepositRoute = computed(() =>
    ['yenten', 'monero'].includes(route.value.source),
);

const prepared = computed(() => props.preparedDepositAddress !== null);

// Inputs are locked once the deposit address is committed.
const inputsLocked = computed(
    () => oneTimeDepositRoute.value && prepared.value,
);

const copied = ref(false);

const depositDeadline = computed(() => {
    if (!props.depositExpiresAt) {
        return null;
    }

    const parsed = new Date(props.depositExpiresAt);

    if (Number.isNaN(parsed.getTime())) {
        return null;
    }

    // A Monero window is a day wide, so a bare clock time would read as an
    // hour from now and send somebody's deposit to a closed address.
    const sameDay = parsed.toDateString() === new Date().toDateString();

    return sameDay
        ? parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : parsed.toLocaleString([], {
              day: '2-digit',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
          });
});

/**
 * How deep the deposit has to go before it is credited. Said out loud because
 * it is the difference between a minute of waiting and twenty, and a person
 * who does not know which one they are in writes to support.
 */
const depositWait = computed(() => {
    const blocks = props.depositConfirmations;

    if (!blocks) {
        return 'network confirmations';
    }

    return `${blocks} ${route.value.sourceLabel} confirmation${blocks === 1 ? '' : 's'}`;
});

const copyDepositAddress = async () => {
    if (!props.preparedDepositAddress) {
        return;
    }

    await navigator.clipboard.writeText(props.preparedDepositAddress);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
};

const convertedEstimate = computed(() => {
    const amt = parseFloat(localAmount.value);

    if (!(amt > 0) || props.convertRate <= 0) {
        return null;
    }

    return (amt / props.convertRate).toFixed(6);
});

const validation = ref(validateDestination(props.direction, ''));

watch(
    () => [props.direction, props.destinationAddress] as const,
    ([dir, addr]) => {
        validation.value = validateDestination(dir, addr);
    },
    { immediate: true },
);

const sourceLabel = computed(() => route.value.sourceLabel);

const destChainLabel = computed(() => route.value.destinationLabel);

const destPlaceholder = computed(() => {
    if (route.value.destinationAddressType === 'evm') {
        return '0x... address that will receive the funds';
    }

    if (route.value.destinationAddressType === 'ton') {
        return 'TON address that will receive the funds';
    }

    if (route.value.destinationAddressType === 'yenten') {
        return 'Y... address that will receive native YTN';
    }

    if (route.value.destinationAddressType === 'bitcoin') {
        return 'Bitcoin address that will receive native BTC';
    }

    if (route.value.destinationAddressType === 'litecoin') {
        return 'Litecoin address that will receive native LTC';
    }

    if (route.value.destinationAddressType === 'monero') {
        return 'Monero address that will receive native XMR';
    }

    return 'Solana address that will receive the funds';
});

const sourceWalletUrl = computed(() => {
    if (route.value.source === 'yenten') {
        return 'https://wallet.yentencoin.info/';
    }

    if (route.value.source === 'monero') {
        return 'https://www.getmonero.org/downloads/';
    }

    return null;
});

const sourceWalletLabel = computed(() =>
    route.value.source === 'monero'
        ? 'Get a Monero wallet'
        : `Open ${route.value.sourceLabel} web wallet`,
);

const amountNum = computed(() => parseFloat(localAmount.value));

const amountValid = computed(() => amountNum.value > 0);

const manualFieldsValid = computed(
    () =>
        !manualRoute.value ||
        (localSourceAddress.value.trim().length > 0 &&
            localSourceTxHash.value.trim().length > 0),
);

const amountExceedsBalance = computed(() => {
    const available = parseFloat(
        props.sourceMaxAmount ?? props.sourceBalance ?? '0',
    );

    return (
        props.sourceBalance !== null &&
        amountNum.value > 0 &&
        amountNum.value > available
    );
});

const maxReservesGas = computed(
    () =>
        props.sourceBalance !== null &&
        props.sourceMaxAmount !== null &&
        props.sourceBalance !== props.sourceMaxAmount,
);

/**
 * The relayer can only pay out what it holds on the destination chain, and it
 * must not be asked to try on a number nobody has.
 *
 * The comparison is in raw integer units, not floats: 0.492836888 SOL is
 * 492836888 lamports and the boundary is where this decision matters. See
 * `@/lib/bridgeCapacity`.
 */
const capacity = computed(() =>
    capacityVerdict(props.destinationCapacity, localAmount.value),
);

const overCapacity = computed(() => capacity.value === 'exceeded');

// Still asking, or the read failed. Both block the way to a signature, and
// they say different things to the person waiting.
const capacityPending = computed(() => capacity.value === 'loading');
const capacityUnknown = computed(() => capacity.value === 'unavailable');

const capacityCeiling = computed(() =>
    props.destinationCapacity.state === 'available'
        ? props.destinationCapacity.available
        : null,
);

const setMax = () => {
    const limits = [props.sourceMaxAmount, capacityCeiling.value]
        .filter((v): v is string => v !== null)
        .sort((a, b) => parseFloat(a) - parseFloat(b));

    if (limits.length > 0) {
        localAmount.value = limits[0];
    }
};

const canProceed = computed(
    () =>
        props.sourceWalletConnected &&
        amountValid.value &&
        !amountExceedsBalance.value &&
        // Fail-closed, exactly like the server: only an affirmative 'ok'
        // opens the way forward. Loading and unavailable both stop here.
        capacity.value === 'ok' &&
        manualFieldsValid.value &&
        validation.value.valid,
);

// Phase A: only the destination is needed to reserve a deposit address —
// the amount is whatever the user later deposits.
const canPrepare = computed(() => validation.value.valid && !props.preparing);

const useRecent = (entry: RecentDestination) => {
    localDestination.value = entry.address;
};

// XMR payouts go to a native Monero address, which nobody retypes correctly —
// offer the one saved on the profile instead.
const savedMoneroOffer = computed(() =>
    route.value.destinationAddressType === 'monero' &&
    props.savedMoneroAddress &&
    props.savedMoneroAddress !== localDestination.value
        ? props.savedMoneroAddress
        : null,
);

const formatRelative = (ts: number): string => {
    const diff = Date.now() - ts;
    const day = 86_400_000;

    if (diff < day) {
        return 'today';
    }

    if (diff < 2 * day) {
        return 'yesterday';
    }

    return `${Math.floor(diff / day)}d ago`;
};
</script>

<template>
    <div class="flex w-full flex-col gap-4">
        <header class="flex items-center justify-between">
            <h2
                class="text-lg font-semibold text-[#1b1b18] dark:text-[#EDEDEC]"
            >
                Configure transfer
            </h2>
            <button
                type="button"
                class="text-xs text-[#706f6c] underline hover:text-[#1b1b18] dark:text-[#A1A09A] dark:hover:text-[#EDEDEC]"
                @click="$emit('back')"
            >
                Back
            </button>
        </header>

        <!-- Source wallet / manual deposit -->
        <div
            v-if="!oneTimeDepositRoute"
            class="flex items-center justify-between rounded-lg border border-[#19140035] p-4 dark:border-[#3E3E3A]"
        >
            <div class="flex items-center gap-2">
                <Wallet class="h-4 w-4 text-[#1b1b18] dark:text-[#EDEDEC]" />
                <div>
                    <p class="text-xs text-[#706f6c] dark:text-[#A1A09A]">
                        From {{ sourceLabel }}
                    </p>
                    <p
                        v-if="
                            !manualRoute &&
                            sourceWalletConnected &&
                            sourceWalletAddress
                        "
                        class="font-mono text-xs text-[#1b1b18] dark:text-[#EDEDEC]"
                    >
                        {{ sourceWalletAddress.slice(0, 6) }}…{{
                            sourceWalletAddress.slice(-4)
                        }}
                    </p>
                </div>
            </div>
            <button
                v-if="!manualRoute && !sourceWalletConnected"
                type="button"
                class="rounded border border-[#19140035] px-3 py-1.5 text-xs text-[#1b1b18] hover:border-[#1915014a] disabled:opacity-50 dark:border-[#3E3E3A] dark:text-[#EDEDEC] dark:hover:border-[#62605b]"
                :disabled="sourceWalletConnecting"
                @click="$emit('connect-source')"
            >
                {{ sourceWalletConnecting ? 'Connecting…' : 'Connect' }}
            </button>
            <span v-else class="text-xs text-green-600 dark:text-green-400">
                {{ manualRoute ? 'Manual' : 'Connected' }}
            </span>
        </div>

        <!-- One-time deposit address (phase B: after prepare) -->
        <div
            v-if="oneTimeDepositRoute && prepared"
            class="rounded-lg border border-[#19140035] p-4 dark:border-[#3E3E3A]"
        >
            <p class="mb-3 text-xs text-[#706f6c] dark:text-[#A1A09A]">
                Send any amount of {{ token }} to the address below — whatever
                arrives is what gets bridged. The address belongs to this
                transfer alone, so send to it once. It is credited after
                {{ depositWait }}, on its own: this page checks while it is
                open, and the bridge keeps checking after you close it.
            </p>
            <p
                class="mb-3 rounded border border-yellow-500/30 bg-yellow-500/10 p-2 text-xs text-yellow-700 dark:text-yellow-300"
            >
                <template v-if="depositDeadline">
                    The address is watched until {{ depositDeadline }}. After
                    that it is no longer monitored — don't send to it later.
                </template>
                <template v-else>
                    The address is watched for a limited time — don't send to it
                    later.
                </template>
            </p>
            <div
                class="rounded border border-[#19140020] bg-[#19140008] p-3 dark:border-[#3E3E3A] dark:bg-[#ffffff08]"
            >
                <p class="mb-1 text-xs text-[#706f6c] dark:text-[#A1A09A]">
                    Your {{ sourceLabel }} deposit address
                </p>
                <div class="flex items-start justify-between gap-2">
                    <code
                        class="text-xs break-all text-[#1b1b18] dark:text-[#EDEDEC]"
                    >
                        {{ preparedDepositAddress }}
                    </code>
                    <button
                        type="button"
                        class="shrink-0 rounded border border-[#19140035] px-2 py-1 text-[10px] text-[#1b1b18] hover:border-[#1915014a] dark:border-[#3E3E3A] dark:text-[#EDEDEC]"
                        @click="copyDepositAddress"
                    >
                        {{ copied ? 'Copied' : 'Copy' }}
                    </button>
                </div>
                <a
                    v-if="sourceWalletUrl"
                    :href="sourceWalletUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="mt-2 block text-xs underline"
                >
                    {{ sourceWalletLabel }}
                </a>
            </div>
        </div>

        <!-- Shared-address manual deposit (TON) -->
        <div
            v-if="manualRoute && !oneTimeDepositRoute"
            class="rounded-lg border border-[#19140035] p-4 dark:border-[#3E3E3A]"
        >
            <p class="mb-3 text-xs text-[#706f6c] dark:text-[#A1A09A]">
                <template v-if="manualReviewRoute">
                    Send the amount to the bridge deposit address first, then
                    paste the sender address and transaction hash. The request
                    will stay pending until an operator verifies and settles it.
                </template>
                <template v-else>
                    Send the amount to the bridge deposit address first, then
                    paste the sender address and transaction hash. The relayer
                    verifies the confirmed transaction automatically.
                </template>
            </p>
            <div
                v-if="sourceDepositAddress"
                class="mb-3 rounded border border-[#19140020] bg-[#19140008] p-3 dark:border-[#3E3E3A] dark:bg-[#ffffff08]"
            >
                <p class="mb-1 text-xs text-[#706f6c] dark:text-[#A1A09A]">
                    Bridge deposit address
                </p>
                <code
                    class="text-xs break-all text-[#1b1b18] dark:text-[#EDEDEC]"
                >
                    {{ sourceDepositAddress }}
                </code>
                <a
                    v-if="sourceWalletUrl"
                    :href="sourceWalletUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="mt-2 block text-xs underline"
                >
                    Open Yenten web wallet
                </a>
            </div>
            <label
                for="bridge-source-address"
                class="mb-1 block text-xs text-[#706f6c] dark:text-[#A1A09A]"
            >
                Sender address on {{ sourceLabel }}
            </label>
            <input
                id="bridge-source-address"
                v-model="localSourceAddress"
                type="text"
                autocomplete="off"
                spellcheck="false"
                class="mb-3 w-full rounded border border-[#19140020] bg-[#FDFDFC] px-3 py-2 font-mono text-xs text-[#1b1b18] outline-none placeholder:text-[#c4c4c0] focus:border-[#1915014a] dark:border-[#3E3E3A] dark:bg-[#0a0a0a] dark:text-[#EDEDEC] dark:placeholder:text-[#555]"
                :placeholder="`${sourceLabel} sender address`"
            />
            <label
                for="bridge-source-tx"
                class="mb-1 block text-xs text-[#706f6c] dark:text-[#A1A09A]"
            >
                Source transaction hash
            </label>
            <input
                id="bridge-source-tx"
                v-model="localSourceTxHash"
                type="text"
                autocomplete="off"
                spellcheck="false"
                class="w-full rounded border border-[#19140020] bg-[#FDFDFC] px-3 py-2 font-mono text-xs text-[#1b1b18] outline-none placeholder:text-[#c4c4c0] focus:border-[#1915014a] dark:border-[#3E3E3A] dark:bg-[#0a0a0a] dark:text-[#EDEDEC] dark:placeholder:text-[#555]"
                placeholder="Transaction hash on the source chain"
            />
        </div>

        <!-- Token + Amount (Yenten deposits any amount, so no amount input) -->
        <div
            v-if="!oneTimeDepositRoute"
            class="rounded-lg border border-[#19140035] p-4 dark:border-[#3E3E3A]"
        >
            <div class="mb-3 flex flex-wrap items-center gap-2">
                <span class="text-xs text-[#706f6c] dark:text-[#A1A09A]">
                    Token:
                </span>
                <button
                    v-for="symbol in tokenSymbols"
                    :key="symbol"
                    type="button"
                    :disabled="inputsLocked"
                    class="rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-60"
                    :class="
                        localToken === symbol
                            ? 'border-[#1b1b18] bg-[#1b1b18] text-white dark:border-[#EDEDEC] dark:bg-[#EDEDEC] dark:text-[#0a0a0a]'
                            : 'border-[#19140035] text-[#1b1b18] hover:border-[#1915014a] dark:border-[#3E3E3A] dark:text-[#EDEDEC] dark:hover:border-[#62605b]'
                    "
                    @click="localToken = symbol"
                >
                    {{ symbol }}
                </button>
            </div>

            <div class="mb-2 flex items-center justify-between">
                <label
                    for="bridge-amount"
                    class="text-xs text-[#706f6c] dark:text-[#A1A09A]"
                >
                    Amount
                </label>
                <span
                    v-if="sourceBalance !== null"
                    class="text-xs text-[#706f6c] dark:text-[#A1A09A]"
                >
                    Balance:
                    <span class="font-mono">{{
                        parseFloat(sourceBalance).toFixed(4)
                    }}</span>
                    {{ token }}
                    <button
                        type="button"
                        class="ml-2 rounded bg-[#19140010] px-1.5 py-0.5 text-[10px] font-medium text-[#1b1b18] hover:bg-[#19140020] dark:bg-[#3E3E3A] dark:text-[#EDEDEC]"
                        @click="setMax"
                    >
                        MAX
                    </button>
                </span>
            </div>
            <p
                v-if="capacityCeiling !== null"
                class="mb-1 text-xs text-[#706f6c] dark:text-[#A1A09A]"
            >
                Deliverable to {{ destinationLabel ?? 'destination' }} now:
                <span class="font-mono">{{
                    parseFloat(capacityCeiling).toFixed(4)
                }}</span>
                {{ token }}
            </p>
            <p
                v-else-if="capacityPending"
                class="mb-1 text-xs text-[#706f6c] dark:text-[#A1A09A]"
            >
                Checking what {{ destinationLabel ?? 'the destination' }} can
                deliver…
            </p>
            <p
                v-else-if="capacityUnknown"
                class="mb-1 text-xs text-amber-600 dark:text-amber-400"
            >
                The bridge cannot read its balance on
                {{ destinationLabel ?? 'the destination chain' }} right now, so
                it will not take this transfer. Nothing has been sent.
            </p>
            <input
                id="bridge-amount"
                v-model="localAmount"
                type="text"
                inputmode="decimal"
                placeholder="0.0"
                :disabled="inputsLocked"
                class="w-full bg-transparent text-2xl font-light text-[#1b1b18] outline-none placeholder:text-[#c4c4c0] disabled:opacity-70 dark:text-[#EDEDEC] dark:placeholder:text-[#555]"
                :class="{
                    'text-red-500 dark:text-red-400':
                        amountExceedsBalance || overCapacity,
                }"
            />
            <p
                v-if="amountExceedsBalance"
                class="mt-1 text-xs text-red-500 dark:text-red-400"
            >
                {{
                    maxReservesGas
                        ? 'Amount plus network fee exceeds your balance'
                        : 'Amount exceeds your balance'
                }}
            </p>
            <p
                v-else-if="overCapacity"
                class="mt-1 text-xs text-red-500 dark:text-red-400"
            >
                Exceeds what can be delivered to
                {{ destinationLabel ?? 'the destination' }} right now
            </p>
        </div>

        <!-- Optional CYBER.sol -> native CYBER auto-conversion -->
        <div
            v-if="convertAvailable"
            class="rounded-lg border border-[#19140035] p-4 dark:border-[#3E3E3A]"
        >
            <label class="flex cursor-pointer items-start gap-3">
                <input
                    v-model="localConvert"
                    type="checkbox"
                    class="mt-0.5 h-4 w-4 shrink-0 rounded border-[#19140035] dark:border-[#3E3E3A]"
                />
                <span class="flex flex-col gap-1">
                    <span
                        class="flex items-center gap-1.5 text-sm font-medium text-[#1b1b18] dark:text-[#EDEDEC]"
                    >
                        <Flame class="h-3.5 w-3.5 text-orange-500" />
                        Convert to native CYBER
                    </span>
                    <span class="text-xs text-[#706f6c] dark:text-[#A1A09A]">
                        Automatically burn the bridged CYBER.sol and receive
                        native CYBER (gas token) at {{ convertRate }} : 1
                        instead. Leave off to receive CYBER.sol as usual.
                    </span>
                    <span
                        v-if="localConvert && convertedEstimate"
                        class="font-mono text-xs text-green-700 dark:text-green-400"
                    >
                        ≈ {{ convertedEstimate }} CYBER
                    </span>
                </span>
            </label>
        </div>

        <!-- Destination address -->
        <div
            class="rounded-lg border border-[#19140035] p-4 dark:border-[#3E3E3A]"
        >
            <label
                for="bridge-dest"
                class="mb-1 block text-xs text-[#706f6c] dark:text-[#A1A09A]"
            >
                Send to {{ destChainLabel }} address
            </label>
            <input
                id="bridge-dest"
                v-model="localDestination"
                type="text"
                autocomplete="off"
                spellcheck="false"
                :placeholder="destPlaceholder"
                :disabled="inputsLocked"
                class="w-full rounded border border-[#19140020] bg-[#FDFDFC] px-3 py-2 font-mono text-xs text-[#1b1b18] outline-none placeholder:text-[#c4c4c0] focus:border-[#1915014a] disabled:opacity-70 dark:border-[#3E3E3A] dark:bg-[#0a0a0a] dark:text-[#EDEDEC] dark:placeholder:text-[#555]"
                :class="{
                    'border-red-500 dark:border-red-500':
                        !validation.valid && localDestination.length > 0,
                }"
            />
            <p
                v-if="!validation.valid && localDestination.length > 0"
                class="mt-1 text-xs text-red-500 dark:text-red-400"
            >
                {{ validation.error }}
            </p>
            <p
                v-else-if="validation.warning"
                class="mt-1 text-xs text-yellow-600 dark:text-yellow-400"
            >
                {{ validation.warning }}
            </p>

            <!-- Saved Monero wallet (profile) -->
            <button
                v-if="savedMoneroOffer"
                type="button"
                class="mt-2 flex w-full items-center justify-between rounded border border-[#19140020] px-2 py-1.5 text-xs hover:border-[#1915014a] dark:border-[#3E3E3A] dark:hover:border-[#62605b]"
                :disabled="inputsLocked"
                @click="localDestination = savedMoneroOffer"
            >
                <span
                    class="truncate font-mono text-[#1b1b18] dark:text-[#EDEDEC]"
                >
                    {{ savedMoneroOffer.slice(0, 8) }}…{{
                        savedMoneroOffer.slice(-8)
                    }}
                </span>
                <span class="shrink-0 text-[#706f6c] dark:text-[#A1A09A]">
                    my Monero wallet
                </span>
            </button>

            <!-- Recent addresses -->
            <div v-if="recent.length > 0" class="mt-3">
                <p
                    class="mb-1 text-[10px] tracking-wider text-[#706f6c] uppercase dark:text-[#A1A09A]"
                >
                    Recent destinations
                </p>
                <div class="flex flex-col gap-1">
                    <button
                        v-for="entry in recent"
                        :key="entry.address + entry.timestamp"
                        type="button"
                        class="flex items-center justify-between rounded border border-[#19140020] px-2 py-1.5 text-xs hover:border-[#1915014a] dark:border-[#3E3E3A] dark:hover:border-[#62605b]"
                        @click="useRecent(entry)"
                    >
                        <span
                            class="truncate font-mono text-[#1b1b18] dark:text-[#EDEDEC]"
                        >
                            {{ entry.address.slice(0, 8) }}…{{
                                entry.address.slice(-8)
                            }}
                        </span>
                        <span
                            class="flex shrink-0 items-center gap-1 text-[#706f6c] dark:text-[#A1A09A]"
                        >
                            <Clock class="h-3 w-3" />
                            {{ entry.amount }} ·
                            {{ formatRelative(entry.timestamp) }}
                        </span>
                    </button>
                </div>
            </div>
        </div>

        <!-- One-time-address flow: prepare (phase A) then claim (phase B). -->
        <button
            v-if="oneTimeDepositRoute && !prepared"
            type="button"
            class="w-full rounded-lg bg-[#1b1b18] py-3 text-sm font-medium text-white transition-colors hover:bg-[#2d2d2a] disabled:opacity-50 dark:bg-[#EDEDEC] dark:text-[#0a0a0a] dark:hover:bg-[#d4d4d0]"
            :disabled="!canPrepare"
            @click="$emit('prepare')"
        >
            <span v-if="preparing">Reserving address…</span>
            <span v-else-if="!validation.valid">Enter destination address</span>
            <span v-else>Get deposit address</span>
        </button>
        <button
            v-else-if="oneTimeDepositRoute && prepared"
            type="button"
            class="w-full rounded-lg bg-[#1b1b18] py-3 text-sm font-medium text-white transition-colors hover:bg-[#2d2d2a] disabled:opacity-50 dark:bg-[#EDEDEC] dark:text-[#0a0a0a] dark:hover:bg-[#d4d4d0]"
            @click="$emit('claim')"
        >
            I've deposited — check now
        </button>
        <button
            v-else
            type="button"
            class="w-full rounded-lg bg-[#1b1b18] py-3 text-sm font-medium text-white transition-colors hover:bg-[#2d2d2a] disabled:opacity-50 dark:bg-[#EDEDEC] dark:text-[#0a0a0a] dark:hover:bg-[#d4d4d0]"
            :disabled="!canProceed"
            @click="$emit('next')"
        >
            <span v-if="!sourceWalletConnected">Connect source wallet</span>
            <span v-else-if="!amountValid">Enter amount</span>
            <span v-else-if="amountExceedsBalance">Insufficient balance</span>
            <span v-else-if="overCapacity">Insufficient liquidity</span>
            <span v-else-if="capacityPending">Checking liquidity…</span>
            <span v-else-if="capacityUnknown">Liquidity unavailable</span>
            <span v-else-if="!manualFieldsValid">Enter source transaction</span>
            <span v-else-if="!validation.valid">Enter destination address</span>
            <span v-else>Review</span>
        </button>
    </div>
</template>
