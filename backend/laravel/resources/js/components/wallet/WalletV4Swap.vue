<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { formatUnits, parseUnits } from '@/lib/wallet';
import type { WalletTokenBalance } from '@/lib/wallet';
import {
    V4_FUJI,
    awaitV4Outcome,
    quoteV4,
    v4Balances,
    v4Provider,
} from '@/lib/wallet/v4';
import type { V4Quote } from '@/lib/wallet/v4';
import { walletMessages } from '@/lib/walletMessages';

const props = defineProps<{
    wallet: MultiWallet;
    token?: WalletTokenBalance | null;
    contract?: string | null;
}>();
const emit = defineEmits<{ swapped: [] }>();
const { t } = useLocale(walletMessages);
const config = V4_FUJI;
const provider = v4Provider();
const account = computed(() =>
    props.wallet.accounts.value.find((a) => a.chain === 'cyberia_fuji'),
);
const unsupported = computed(() => {
    const requested = props.contract || props.token?.address;
    return (
        !!requested &&
        (!config || requested.toLowerCase() !== config.token.toLowerCase())
    );
});
const nativeIn = ref(!props.token);
const amount = ref('');
const quote = ref<V4Quote | null>(null);
const balances = ref<{ native: bigint; token: bigint } | null>(null);
const loading = ref(false);
const quoteError = ref(false);
const phase = ref<
    | 'compose'
    | 'review'
    | 'signing'
    | 'pending'
    | 'confirmed'
    | 'reverted'
    | 'failed'
>('compose');
const hash = ref<string | null>(null);
const pendingHash = ref<string | null>(null);
const approvalHashes = ref<string[]>([]);
const error = ref('');
let serial = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

const inputAmount = computed(() => {
    try {
        const value = parseUnits(amount.value, 18);
        return value > 0n ? value : null;
    } catch {
        return null;
    }
});
const sufficient = computed(() => {
    if (!quote.value || !balances.value) return false;
    return nativeIn.value
        ? balances.value.native >= quote.value.amountIn + quote.value.maxFee
        : balances.value.native >= quote.value.maxFee &&
              balances.value.token >= quote.value.amountIn;
});
const canReview = computed(
    () =>
        !!quote.value &&
        !!account.value?.capabilities.send &&
        sufficient.value &&
        !loading.value &&
        !unsupported.value,
);
const paySymbol = computed(() => (nativeIn.value ? 'CYBER' : 'AVAX.FUJI'));
const receiveSymbol = computed(() => (nativeIn.value ? 'AVAX.FUJI' : 'CYBER'));

watch(
    [amount, nativeIn, () => account.value?.address],
    () => {
        const run = ++serial;
        if (timer) clearTimeout(timer);
        quote.value = null;
        balances.value = null;
        quoteError.value = false;
        loading.value = false;
        if (
            !config ||
            !account.value ||
            !inputAmount.value ||
            unsupported.value
        )
            return;
        const address = account.value.address;
        const input = inputAmount.value;
        const direction = nativeIn.value;
        loading.value = true;
        timer = setTimeout(async () => {
            try {
                const [next, available] = await Promise.all([
                    quoteV4(provider, config, address, direction, input),
                    v4Balances(provider, config, address),
                ]);
                if (run === serial) {
                    quote.value = next;
                    balances.value = available;
                }
            } catch {
                if (run === serial) quoteError.value = true;
            } finally {
                if (run === serial) loading.value = false;
            }
        }, 350);
    },
    { immediate: true },
);

onBeforeUnmount(() => {
    serial++;
    if (timer) clearTimeout(timer);
});

const pendingKey = (owner: string) =>
    `cyberia.v4.pending.${owner.toLowerCase()}`;
onMounted(async () => {
    if (!account.value) return;
    const owner = account.value.address;
    try {
        const raw = localStorage.getItem(pendingKey(owner));
        if (!raw) return;
        const record = JSON.parse(raw) as { hash?: string; step?: string };
        if (
            !record.hash ||
            !/^0x[0-9a-f]{64}$/i.test(record.hash) ||
            !['approval', 'swap'].includes(record.step ?? '')
        )
            return;
        hash.value = record.hash;
        pendingHash.value = record.hash;
        phase.value = 'pending';
        const result = await awaitV4Outcome(provider, record.hash);
        localStorage.removeItem(pendingKey(owner));
        pendingHash.value = null;
        if (record.step === 'approval') {
            approvalHashes.value.push(record.hash);
            error.value = t('v4ApprovalDone');
            phase.value = 'failed';
        } else {
            phase.value = result === 'confirmed' ? 'confirmed' : 'reverted';
            emit('swapped');
        }
    } catch {
        // An unreadable receipt remains pending and keeps its original hash.
    }
});

const sign = async (): Promise<void> => {
    const current = quote.value;
    if (!current || !canReview.value) return;
    phase.value = 'signing';
    error.value = '';
    approvalHashes.value = [];
    const key = pendingKey(current.owner);
    try {
        hash.value = await props.wallet.swapV4(
            current,
            (step, submitted) => {
                localStorage.setItem(
                    key,
                    JSON.stringify({ step, hash: submitted }),
                );
                hash.value = submitted;
                pendingHash.value = submitted;
            },
            (_step, confirmed) => {
                localStorage.removeItem(key);
                pendingHash.value = null;
                approvalHashes.value.push(confirmed);
            },
        );
        phase.value = 'pending';
        const result = await awaitV4Outcome(provider, hash.value);
        if (result === 'confirmed' || result === 'failed') {
            localStorage.removeItem(key);
            pendingHash.value = null;
            phase.value = result === 'confirmed' ? 'confirmed' : 'reverted';
            emit('swapped');
            void props.wallet.refreshBalances();
            void props.wallet.refreshTokens('cyberia_fuji');
        }
    } catch (cause) {
        // A broadcast hash remains pending if the receipt could not be read.
        if (pendingHash.value) {
            phase.value = 'pending';
            return;
        }
        error.value = (cause as Error).message;
        phase.value = 'failed';
    }
};
</script>

<template>
    <div class="cw-stack" style="gap: 12px; margin-top: 16px">
        <p class="cw-note">
            <span>{{ t('v4FeeInfo') }}</span>
        </p>
        <p v-if="unsupported" class="cw-note cw-note-warn">
            <span>{{ t('v4OnlyPair') }}</span>
        </p>
        <template v-else-if="phase === 'compose' || phase === 'review'">
            <div class="cw-card" style="padding: 14px">
                <div class="cw-row">
                    <span class="cw-label">{{ t('swapPay') }}</span
                    ><span class="cw-mono">{{ paySymbol }}</span>
                </div>
                <input
                    v-model="amount"
                    class="cw-amount"
                    type="text"
                    inputmode="decimal"
                    placeholder="0.00"
                    :aria-label="t('amount')"
                    :disabled="phase !== 'compose'"
                />
                <div
                    v-if="nativeIn"
                    class="cw-row"
                    style="
                        justify-content: flex-start;
                        gap: 8px;
                        flex-wrap: wrap;
                        margin-top: 10px;
                    "
                >
                    <button
                        v-for="preset in ['100', '200', '500']"
                        :key="preset"
                        type="button"
                        class="cw-chip"
                        :class="{ 'cw-chip-on': amount === preset }"
                        :aria-pressed="amount === preset"
                        :disabled="phase !== 'compose'"
                        @click="amount = preset"
                    >
                        {{ preset }} CYBER
                    </button>
                </div>
            </div>
            <button
                type="button"
                class="cw-btn cw-btn-secondary"
                :disabled="phase !== 'compose'"
                @click="nativeIn = !nativeIn"
            >
                {{ t('swapFlip') }} ⇅
            </button>
            <div class="cw-card" style="padding: 14px">
                <div class="cw-row">
                    <span class="cw-label">{{ t('swapReceive') }}</span
                    ><span class="cw-mono">{{ receiveSymbol }}</span>
                </div>
                <div class="cw-mono" style="margin-top: 10px">
                    {{ quote ? formatUnits(quote.amountOut, 18, 18) : '—' }}
                </div>
            </div>
            <p v-if="loading" class="cw-note">
                <span>{{ t('swapQuoting') }}</span>
            </p>
            <p v-else-if="quoteError" class="cw-note cw-note-warn">
                <span>{{ t('v4NoQuote') }}</span>
            </p>
            <template v-if="quote">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('swapMinOut') }}</span
                    ><span class="cw-kv-val"
                        >{{ formatUnits(quote.minOut, 18, 18) }}
                        {{ receiveSymbol }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('v4GasLimit') }}</span
                    ><span class="cw-kv-val"
                        >{{ formatUnits(quote.maxFee, 18, 18) }} CYBER</span
                    >
                </div>
                <div v-if="quote.impactPct !== null" class="cw-kv">
                    <span class="cw-kv-key">{{ t('swapImpact') }}</span>
                    <span class="cw-kv-val"
                        >{{ quote.impactPct.toFixed(2) }}%</span
                    >
                </div>
                <p
                    v-if="quote.impactPct !== null && quote.impactPct >= 5"
                    class="cw-note cw-note-warn"
                >
                    <span>{{
                        t('swapImpactWarn', {
                            impact: quote.impactPct.toFixed(2),
                        })
                    }}</span>
                </p>
                <p v-if="!balances" class="cw-note cw-note-warn">
                    <span>{{ t('v4BalanceUnknown') }}</span>
                </p>
                <p v-else-if="!sufficient" class="cw-note cw-note-warn">
                    <span>{{ t('routeOverBalance') }}</span>
                </p>
                <p
                    v-if="quote.tokenApproval || quote.permitApproval"
                    class="cw-note"
                >
                    <span>{{ t('v4ApprovalInfo') }}</span>
                </p>
            </template>
            <p
                v-if="account && !account.capabilities.send"
                class="cw-note cw-note-warn"
            >
                <span>{{ t('swapWatchOnly') }}</span>
            </p>
            <button
                v-if="phase === 'compose'"
                type="button"
                class="cw-btn cw-btn-primary"
                :disabled="!canReview"
                @click="phase = 'review'"
            >
                {{ t('swapReview') }}
            </button>
            <template v-else-if="quote">
                <p class="cw-note">
                    <span>{{
                        t('v4ReviewText', {
                            amount,
                            from: paySymbol,
                            min: formatUnits(quote.minOut, 18, 18),
                            to: receiveSymbol,
                            gas: formatUnits(quote.maxFee, 18, 18),
                        })
                    }}</span>
                </p>
                <HoldButton
                    :label="t('holdToSign')"
                    :disabled="!canReview || wallet.busy.value"
                    @complete="sign"
                />
                <button
                    type="button"
                    class="cw-ghost"
                    @click="phase = 'compose'"
                >
                    {{ t('cancel') }}
                </button>
            </template>
        </template>
        <template v-else>
            <p class="cw-note">
                <span>{{
                    phase === 'pending'
                        ? t('v4Pending')
                        : t(`swapOutcome_${phase}`)
                }}</span>
            </p>
            <p v-if="hash" class="cw-mono" style="overflow-wrap: anywhere">
                {{ hash }}
            </p>
            <p
                v-for="approval in approvalHashes"
                :key="approval"
                class="cw-mono"
                style="overflow-wrap: anywhere"
            >
                {{ t('swapApprovalTx') }}: {{ approval }}
            </p>
            <p v-if="error" class="cw-note cw-note-warn">
                <span>{{ error }}</span>
            </p>
            <button
                v-if="
                    phase === 'failed' ||
                    phase === 'reverted' ||
                    phase === 'confirmed'
                "
                type="button"
                class="cw-btn cw-btn-secondary"
                @click="
                    phase = 'compose';
                    amount = '';
                    hash = null;
                "
            >
                {{ t('adjustRetry') }}
            </button>
        </template>
    </div>
</template>
