<script setup lang="ts">
import {
    computed,
    onBeforeUnmount,
    onMounted,
    reactive,
    ref,
    watch,
} from 'vue';
import StatusPill from '@/components/wallet/StatusPill.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useSecureClipboard } from '@/composables/useSecureClipboard';
import { useWallet } from '@/composables/useWallet';
import { CYBERIA_FUJI_PUBLIC_RPC } from '@/lib/evmChains';
import { WALLETCONNECT_WALLET_ID } from '@/lib/evmProvider';
import { formatUnits } from '@/lib/wallet';
import {
    FEE_FIELDS,
    canManage,
    fetchChainStatus,
    minBaseFeeForTransfer,
    submitConnectedFeeConfig,
    transferCost,
    transfersLeft,
} from '@/lib/wallet/chainAdmin';
import type {
    ChainStatus,
    ChainWalletKey,
    FeeConfig,
} from '@/lib/wallet/chainAdmin';
import { formatUsd } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Cyberia 2.0, run from inside the wallet.
 *
 * Everyone sees how the chain is doing: what a transfer costs, where the fees
 * go, how long the validator's P-Chain balance lasts and which service wallets
 * are running dry — all read from the chain, never restated from config.
 *
 * The controls appear only for an account the chain itself lists as admin of
 * FeeManager or RewardManager, and they sign with that account's key here,
 * like every other transaction in this wallet. No key for any of this lives
 * on a server.
 */

const props = defineProps<{ wallet: MultiWallet }>();

const emit = defineEmits<{ back: [] }>();

const { locale, t } = useLocale(walletMessages);
const clipboard = useSecureClipboard();
const externalWallet = useWallet();
const connectedAdmin = ref(false);
const connectError = ref<string | null>(null);
const connectAdmin = async (): Promise<void> => {
    connectError.value = null;
    const address = await externalWallet.connect(WALLETCONNECT_WALLET_ID);

    if (!address) {
        connectError.value = externalWallet.error.value ?? 'WalletConnect unavailable';

        return;
    }

    connectedAdmin.value = true;
};

const CHAIN = 'cyberia_fuji' as const;

/** A service wallet with fewer transfers than this left is flagged. */
const LOW_TRANSFERS = 50n;

/** Under this many days the validator warning turns from amber to red. */
const VALIDATOR_URGENT_DAYS = 2;
const VALIDATOR_WARN_DAYS = 7;

const account = computed(
    () =>
        props.wallet.accounts.value.find((entry) => entry.chain === CHAIN) ??
        null,
);

const adminAddress = computed(() => connectedAdmin.value ? externalWallet.address.value : account.value?.address);
const status = ref<ChainStatus | null>(null);
const loading = ref(true);
const now = ref(Date.now());

const load = async (): Promise<void> => {
    status.value = await fetchChainStatus(adminAddress.value ?? undefined);
    loading.value = false;
    now.value = Date.now();
};

let ticker: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
    void load();
    void props.wallet.refreshFees(CHAIN);
    ticker = setInterval(() => void load(), 30_000);
});

onBeforeUnmount(() => {
    if (ticker !== null) {
        clearInterval(ticker);
    }
});

watch(
    () => adminAddress.value,
    () => void load(),
);

/* ------------------------------------------------------------- reading --- */

const cyber = (wei: bigint | string | null | undefined, digits = 2): string =>
    wei === null || wei === undefined
        ? '—'
        : formatUnits(BigInt(wei), 18, digits);

const short = (address: string): string =>
    `${address.slice(0, 6)}…${address.slice(-4)}`;

const baseFee = computed(() =>
    BigInt(status.value?.block?.baseFee ?? status.value?.gasPrice ?? '0'),
);

const minBaseFee = computed(() =>
    BigInt(status.value?.feeConfig?.minBaseFee ?? '0'),
);

const usdOf = (wei: bigint, usd: number | null | undefined): string | null =>
    usd ? formatUsd((Number(wei) / 1e18) * usd, locale.value) : null;

const transferUsd = computed(() =>
    usdOf(transferCost(baseFee.value), status.value?.pricing.cyberUsd),
);

const ethTransferUsd = computed(() => {
    const gas = status.value?.pricing.ethGasPrice;

    return gas
        ? usdOf(transferCost(BigInt(gas)), status.value?.pricing.ethUsd)
        : null;
});

const blockAge = computed(() => {
    const timestamp = status.value?.block?.timestamp;

    if (!timestamp) {
        return '';
    }

    const seconds = Math.max(0, Math.round(now.value / 1000 - timestamp));

    if (seconds < 90) {
        return t('chainAgeSeconds', { n: seconds });
    }

    if (seconds < 5400) {
        return t('chainAgeMinutes', { n: Math.round(seconds / 60) });
    }

    if (seconds < 172_800) {
        return t('chainAgeHours', { n: Math.round(seconds / 3600) });
    }

    return t('chainAgeDays', { n: Math.round(seconds / 86_400) });
});

const formatDate = (iso: string): string =>
    new Date(iso).toLocaleString(locale.value, {
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
    });

const validatorDays = computed(() =>
    status.value?.validator
        ? status.value.validator.secondsLeft / 86_400
        : null,
);

const validatorTone = computed<'confirmed' | 'pending' | 'failed'>(() => {
    const days = validatorDays.value;

    if (days === null || days < VALIDATOR_URGENT_DAYS) {
        return 'failed';
    }

    return days < VALIDATOR_WARN_DAYS ? 'pending' : 'confirmed';
});

const topUpCommand = computed(() =>
    status.value?.validator
        ? `platform-cli l1 increase-validator-balance --validation-id ${status.value.validator.validationId} --balance 1`
        : '',
);

const isTreasury = (address: string | null | undefined): boolean =>
    !!address &&
    !!status.value &&
    address.toLowerCase() === status.value.treasury.address.toLowerCase();

const walletTransfers = (balance: string | null): bigint | null =>
    balance === null ? null : transfersLeft(BigInt(balance), baseFee.value);

/* -------------------------------------------------------------- admin --- */

const canFees = computed(() => canManage(status.value?.roles?.feeManager));
const canRewards = computed(() =>
    !connectedAdmin.value && canManage(status.value?.roles?.rewardManager),
);
const isAdmin = computed(() => canFees.value || canRewards.value);

const operator = computed(
    () =>
        status.value?.wallets.find((wallet) => wallet.key === 'operator')
            ?.address ?? null,
);

type Phase = 'idle' | 'review' | 'signing';

const feePhase = ref<Phase>('idle');
const transferPrice = ref('');
const advanced = ref(false);
const draft = reactive<Partial<FeeConfig>>({});
const feeResult = ref<string | null>(null);
const feeError = ref<string | null>(null);

/** The current rules, as the form starts from them. */
const resetFeeForm = (): void => {
    const config = status.value?.feeConfig;

    if (!config) {
        return;
    }

    Object.assign(draft, config);
    transferPrice.value = cyber(transferCost(BigInt(config.minBaseFee)), 6);
};

watch(
    () => status.value?.feeConfig?.minBaseFee,
    () => {
        if (feePhase.value === 'idle') {
            resetFeeForm();
        }
    },
    { immediate: true },
);

watch(transferPrice, (price) => {
    if (/^\d+(\.\d+)?$/.test(price.trim())) {
        draft.minBaseFee = minBaseFeeForTransfer(price).toString();
    }
});

const parityPrice = computed(() => {
    const parity = status.value?.pricing.parityMinBaseFee;

    return parity ? cyber(transferCost(BigInt(parity)), 2) : null;
});

const useParity = (): void => {
    const parity = status.value?.pricing.parityMinBaseFee;

    if (parity) {
        transferPrice.value = cyber(transferCost(BigInt(parity)), 6);
        draft.minBaseFee = parity;
    }
};

const feeChanges = computed(() => {
    const config = status.value?.feeConfig;

    if (!config) {
        return [];
    }

    return FEE_FIELDS.filter(
        (field) =>
            draft[field] !== undefined &&
            /^\d+$/.test(String(draft[field])) &&
            draft[field] !== config[field],
    ).map((field) => ({ field, from: config[field], to: draft[field]! }));
});

const lowering = computed(
    () =>
        draft.minBaseFee !== undefined &&
        /^\d+$/.test(draft.minBaseFee) &&
        BigInt(draft.minBaseFee) < baseFee.value,
);

const failure = (error: unknown): string =>
    t('chainFailed', {
        message: (error instanceof Error ? error.message : String(error)).slice(
            0,
            200,
        ),
    });

const applyFees = async (): Promise<void> => {
    const config = status.value?.feeConfig;

    if (!config || feeChanges.value.length === 0) {
        return;
    }

    feePhase.value = 'signing';
    feeError.value = null;
    feeResult.value = null;

    try {
        const next = { ...config, ...draft } as FeeConfig;
        const address = adminAddress.value;
        const result = connectedAdmin.value && address
            ? await submitConnectedFeeConfig(address, {
                  config: next,
                  latestBaseFee: baseFee.value,
                  rpcUrl: CYBERIA_FUJI_PUBLIC_RPC,
              })
            : await props.wallet.chainAdmin.setFeeConfig(next, baseFee.value);

        feeResult.value =
            t('chainApplied', { hash: short(result.hash) }) +
            (result.nudge
                ? ' ' + t('chainNudged', { hash: short(result.nudge) })
                : '');
        feePhase.value = 'idle';
        await load();
        resetFeeForm();
    } catch (error) {
        feeError.value = failure(error);
        feePhase.value = 'review';
    }
};

type RecipientChoice = 'treasury' | 'producer' | 'other';

const recipientChoice = ref<RecipientChoice>('treasury');
const recipientOther = ref('');
const recipientBusy = ref(false);
const recipientResult = ref<string | null>(null);
const recipientError = ref<string | null>(null);

const applyRecipient = async (): Promise<void> => {
    const treasury = status.value?.treasury.address;
    const recipient =
        recipientChoice.value === 'producer'
            ? null
            : recipientChoice.value === 'treasury'
              ? (treasury ?? null)
              : recipientOther.value.trim();

    recipientBusy.value = true;
    recipientError.value = null;
    recipientResult.value = null;

    try {
        const hash = await props.wallet.chainAdmin.setFeeRecipient(
            recipient,
            baseFee.value,
            minBaseFee.value,
        );

        recipientResult.value = t('chainApplied', { hash: short(hash) });
        await load();
    } catch (error) {
        recipientError.value = failure(error);
    } finally {
        recipientBusy.value = false;
    }
};

const topUpOpen = ref<ChainWalletKey | null>(null);
const topUpAmount = ref('10000');
const topUpBusy = ref(false);
const topUpNote = ref<string | null>(null);

const topUp = async (address: string): Promise<void> => {
    topUpBusy.value = true;
    topUpNote.value = null;

    try {
        const hash = await props.wallet.send(
            CHAIN,
            address,
            topUpAmount.value.trim(),
        );

        topUpNote.value = t('chainSent', { hash: short(hash) });
        topUpOpen.value = null;
        await load();
    } catch (error) {
        topUpNote.value = failure(error);
    } finally {
        topUpBusy.value = false;
    }
};
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPreferences') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ t('chainTitle') }}
        </h2>
        <p class="cw-prose">{{ t('chainBody') }}</p>

        <p v-if="loading" class="cw-hint" style="margin-top: 22px">
            {{ t('chainLoading') }}
        </p>

        <p
            v-else-if="!status"
            class="cw-note cw-note-bad"
            style="margin-top: 22px"
        >
            {{ t('chainPanelUnreadable') }}
        </p>

        <template v-else>
            <!-- The one thing that stops the chain outright goes first. -->
            <div
                v-if="status.validator && validatorTone !== 'confirmed'"
                class="cw-note"
                :class="
                    validatorTone === 'failed' ? 'cw-note-bad' : 'cw-note-warn'
                "
                style="margin-top: 22px"
                data-test="validator-warning"
            >
                <div style="min-width: 0">
                    {{
                        t('chainValidatorWarn', {
                            date: formatDate(status.validator.haltsAt),
                        })
                    }}
                    <code
                        style="
                            display: block;
                            margin-top: 8px;
                            font: 500 12px/1.5 var(--cw-mono);
                            word-break: break-all;
                            cursor: pointer;
                        "
                        @click="clipboard.copy(topUpCommand)"
                        >{{ topUpCommand }}</code
                    >
                </div>
            </div>

            <!-- What a transfer costs, which is what anybody using it feels. -->
            <div class="cw-card" style="margin-top: 22px; padding: 18px">
                <div class="cw-row">
                    <span class="cw-label">{{ t('chainNetwork') }}</span>
                    <span
                        v-if="status.block"
                        style="
                            font: 500 13px/1 var(--cw-mono);
                            color: var(--cw-muted);
                        "
                        >{{
                            t('chainBlock', {
                                number: status.block.number,
                                age: blockAge,
                            })
                        }}</span
                    >
                </div>

                <div class="cw-label" style="margin-top: 16px">
                    {{ t('chainTransfer') }}
                </div>
                <div
                    style="
                        display: flex;
                        align-items: baseline;
                        gap: 10px;
                        margin-top: 6px;
                        flex-wrap: wrap;
                    "
                >
                    <span class="cw-total" data-test="transfer-cost">{{
                        cyber(transferCost(baseFee), 2)
                    }}</span>
                    <span class="cw-label" style="color: var(--cw-muted)"
                        >CYBER</span
                    >
                </div>
                <div
                    v-if="transferUsd && ethTransferUsd"
                    style="
                        margin-top: 8px;
                        font: 500 13px/1.5 var(--cw-mono);
                        color: var(--cw-dim);
                    "
                >
                    {{
                        t('chainTransferUsd', {
                            usd: transferUsd,
                            eth: ethTransferUsd,
                        })
                    }}
                </div>
            </div>

            <!-- Where fees go. -->
            <div class="cw-label" style="margin-top: 26px">
                {{ t('chainRewards') }}
            </div>
            <p class="cw-prose" style="margin-top: 8px" data-test="rewards">
                {{
                    status.rewards.address
                        ? isTreasury(status.rewards.address)
                            ? t('chainRewardsTreasury')
                            : t('chainRewardsAddress', {
                                  address: short(status.rewards.address),
                              })
                        : status.rewards.feeRecipientsAllowed
                          ? t('chainRewardsProducer')
                          : t('chainRewardsBurn')
                }}
            </p>
            <div style="margin-top: 10px; border: 1px solid var(--cw-line)">
                <div v-if="status.rewards.address" class="cw-kv">
                    <span class="cw-kv-key">{{
                        isTreasury(status.rewards.address)
                            ? t('chainRecipientTreasury')
                            : t('chainRecipientOther')
                    }}</span>
                    <span
                        class="cw-kv-val"
                        style="cursor: pointer"
                        @click="clipboard.copy(status.rewards.address)"
                        >{{ short(status.rewards.address) }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{
                        t('chainTreasuryBalance')
                    }}</span>
                    <span class="cw-kv-val"
                        >{{ cyber(status.treasury.balance) }} CYBER</span
                    >
                </div>
            </div>

            <!-- The validator's runway. -->
            <div class="cw-label" style="margin-top: 26px">
                {{ t('chainValidator') }}
            </div>
            <div
                v-if="status.validator"
                style="margin-top: 10px; border: 1px solid var(--cw-line)"
            >
                <div class="cw-kv">
                    <span class="cw-kv-key">{{
                        t('chainValidatorBalance')
                    }}</span>
                    <span class="cw-kv-val"
                        >{{
                            formatUnits(BigInt(status.validator.balance), 9, 4)
                        }}
                        AVAX</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('chainValidatorFee') }}</span>
                    <span class="cw-kv-val" style="white-space: nowrap">{{
                        t('chainValidatorPrice', {
                            price: status.validator.price,
                        })
                    }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{
                        t('chainValidatorRunway')
                    }}</span>
                    <StatusPill
                        :status="validatorTone"
                        :label="
                            t('chainValidatorLeft', {
                                days: (validatorDays ?? 0).toFixed(1),
                                date: formatDate(status.validator.haltsAt),
                            })
                        "
                        bare
                    />
                </div>
            </div>
            <p v-else class="cw-note cw-note-warn" style="margin-top: 10px">
                {{ t('chainValidatorUnknown') }}
            </p>

            <!-- The balances that keep services running. -->
            <div class="cw-label" style="margin-top: 26px">
                {{ t('chainWallets') }}
            </div>
            <div style="margin-top: 10px; border: 1px solid var(--cw-line)">
                <template v-for="entry in status.wallets" :key="entry.key">
                    <div class="cw-kv">
                        <span class="cw-kv-key">
                            {{ t(`chainWallet_${entry.key}`) }}
                            <span
                                style="
                                    display: block;
                                    font: 500 12px/1.4 var(--cw-mono);
                                    color: var(--cw-faint);
                                    cursor: pointer;
                                "
                                @click="clipboard.copy(entry.address)"
                                >{{ short(entry.address) }}</span
                            >
                        </span>
                        <span class="cw-kv-val" style="text-align: right">
                            {{ cyber(entry.balance, 0) }} CYBER
                            <span
                                v-if="walletTransfers(entry.balance) !== null"
                                style="
                                    display: block;
                                    font: 500 12px/1.4 var(--cw-mono);
                                "
                                :style="{
                                    color:
                                        walletTransfers(entry.balance)! <
                                        LOW_TRANSFERS
                                            ? 'var(--cw-bad)'
                                            : 'var(--cw-faint)',
                                }"
                                >{{
                                    walletTransfers(entry.balance)! <
                                    LOW_TRANSFERS
                                        ? t('chainWalletLow')
                                        : t('chainWalletTransfers', {
                                              count: String(
                                                  walletTransfers(
                                                      entry.balance,
                                                  ),
                                              ),
                                          })
                                }}</span
                            >
                            <button
                                v-if="isAdmin && entry.key !== 'operator'"
                                type="button"
                                class="chain-link"
                                style="margin-top: 4px; font-size: 12px"
                                @click="
                                    topUpOpen =
                                        topUpOpen === entry.key
                                            ? null
                                            : entry.key
                                "
                            >
                                {{ t('chainTopUp') }}
                            </button>
                        </span>
                    </div>
                    <div
                        v-if="topUpOpen === entry.key"
                        class="cw-kv"
                        style="gap: 8px"
                    >
                        <input
                            v-model="topUpAmount"
                            class="cw-input"
                            inputmode="decimal"
                            style="flex: 1"
                            aria-label="CYBER"
                        />
                        <button
                            type="button"
                            class="cw-btn cw-btn-primary"
                            :disabled="topUpBusy"
                            @click="topUp(entry.address)"
                        >
                            {{ t('chainTopUpSend', { amount: topUpAmount }) }}
                        </button>
                    </div>
                </template>
            </div>
            <p v-if="topUpNote" class="cw-hint" style="margin-top: 8px">
                {{ topUpNote }}
            </p>

            <!-- Who can create the coin. -->
            <div class="cw-label" style="margin-top: 26px">
                {{ t('chainMinters') }}
            </div>
            <div style="margin-top: 10px; border: 1px solid var(--cw-line)">
                <div
                    v-for="minter in status.minters"
                    :key="minter.address"
                    class="cw-kv"
                >
                    <span class="cw-kv-key">{{ t('chainMinterBridge') }}</span>
                    <span class="cw-kv-val" style="white-space: nowrap">{{
                        canManage(minter.role)
                            ? t('chainMinterAllowed')
                            : t('chainMinterNot')
                    }}</span>
                </div>
            </div>
            <p class="cw-prose" style="margin-top: 8px">
                {{ t('chainMintersNote') }}
            </p>

            <!-- The rules as they stand. -->
            <div class="cw-label" style="margin-top: 26px">
                {{ t('chainFeeRules') }}
            </div>
            <div
                v-if="status.feeConfig"
                style="margin-top: 10px; border: 1px solid var(--cw-line)"
            >
                <div v-for="field in FEE_FIELDS" :key="field" class="cw-kv">
                    <span class="cw-kv-key">{{ t(`chainFee_${field}`) }}</span>
                    <span class="cw-kv-val" style="white-space: nowrap">{{
                        status.feeConfig[field]
                    }}</span>
                </div>
            </div>
            <p
                v-if="status.feeConfigChangedAt"
                class="cw-hint"
                style="margin-top: 8px"
            >
                {{
                    t('chainFeeChangedAt', { block: status.feeConfigChangedAt })
                }}
            </p>

            <!-- Controls, for the account the chain lists and nobody else. -->
            <div class="cw-label" style="margin-top: 30px">
                {{ t('chainAdmin') }}
            </div>

            <button type="button" class="chain-link" style="margin-top: 8px" :disabled="externalWallet.isConnecting.value || feePhase !== 'idle'" @click="connectAdmin">
                {{ t('chainConnectPhone') }}
            </button>
            <p v-if="connectedAdmin && adminAddress" class="cw-hint">{{ t('chainConnectedPhone', { address: adminAddress }) }}</p>
            <p v-if="connectError" class="cw-hint">{{ connectError }}</p>
            <p
                v-if="!isAdmin"
                class="cw-prose"
                style="margin-top: 8px"
                data-test="admin-none"
            >
                {{ t('chainAdminNone', { address: operator ?? '—' }) }}
            </p>

            <template v-else>
                <p class="cw-prose" style="margin-top: 8px">
                    {{ t('chainAdminYou') }}
                </p>

                <div
                    v-if="canFees && status.feeConfig"
                    class="cw-card"
                    style="margin-top: 14px; padding: 18px"
                    data-test="fee-form"
                >
                    <div class="cw-label">{{ t('chainSetFee') }}</div>
                    <p class="cw-hint" style="margin-top: 6px">
                        {{ t('chainSetFeeHint') }}
                    </p>
                    <div
                        style="
                            display: flex;
                            gap: 8px;
                            margin-top: 10px;
                            align-items: center;
                        "
                    >
                        <input
                            v-model="transferPrice"
                            class="cw-input"
                            inputmode="decimal"
                            style="flex: 1"
                            data-test="transfer-price"
                            :disabled="feePhase !== 'idle'"
                        />
                        <span class="cw-label">CYBER</span>
                    </div>
                    <button
                        v-if="parityPrice"
                        type="button"
                        class="chain-link"
                        style="margin-top: 8px; font-size: 13px"
                        :disabled="feePhase !== 'idle'"
                        @click="useParity"
                    >
                        {{ t('chainSetFeeParity', { cyber: parityPrice }) }}
                    </button>

                    <button
                        type="button"
                        class="chain-link"
                        style="
                            display: block;
                            margin-top: 10px;
                            font-size: 13px;
                        "
                        @click="advanced = !advanced"
                    >
                        {{ t('chainSetFeeAdvanced') }}
                        {{ advanced ? '▴' : '▾' }}
                    </button>
                    <div v-if="advanced" style="margin-top: 8px">
                        <label
                            v-for="field in FEE_FIELDS"
                            :key="field"
                            style="display: block; margin-top: 8px"
                        >
                            <span class="cw-hint">{{
                                t(`chainFee_${field}`)
                            }}</span>
                            <input
                                v-model="draft[field]"
                                class="cw-input"
                                inputmode="numeric"
                                style="width: 100%; margin-top: 4px"
                                :disabled="feePhase !== 'idle'"
                            />
                        </label>
                    </div>

                    <template v-if="feePhase !== 'idle'">
                        <div
                            style="
                                margin-top: 14px;
                                border: 1px solid var(--cw-line);
                            "
                            data-test="fee-review"
                        >
                            <div
                                v-for="change in feeChanges"
                                :key="change.field"
                                class="cw-kv"
                            >
                                <span class="cw-kv-key">{{
                                    t(`chainFee_${change.field}`)
                                }}</span>
                                <span class="cw-kv-val"
                                    >{{ change.from }} → {{ change.to }}</span
                                >
                            </div>
                        </div>
                        <p
                            v-if="lowering"
                            class="cw-hint"
                            style="margin-top: 8px"
                        >
                            {{ t('chainLowering') }}
                        </p>
                    </template>

                    <p
                        v-if="feeError"
                        class="cw-note cw-note-bad"
                        style="margin-top: 10px"
                    >
                        {{ feeError }}
                    </p>
                    <p
                        v-if="feeResult"
                        class="cw-note"
                        style="margin-top: 10px"
                        data-test="fee-result"
                    >
                        {{ feeResult }}
                    </p>

                    <div style="display: flex; gap: 8px; margin-top: 14px">
                        <button
                            v-if="feePhase === 'idle'"
                            type="button"
                            class="cw-btn cw-btn-primary"
                            :disabled="feeChanges.length === 0"
                            data-test="fee-review-button"
                            @click="feePhase = 'review'"
                        >
                            {{
                                feeChanges.length === 0
                                    ? t('chainNoChange')
                                    : t('chainReview')
                            }}
                        </button>
                        <template v-else>
                            <button
                                type="button"
                                class="cw-btn cw-btn-primary"
                                :disabled="feePhase === 'signing'"
                                data-test="fee-sign"
                                @click="applyFees"
                            >
                                {{ t('chainSign') }}
                            </button>
                            <button
                                type="button"
                                class="cw-btn cw-btn-secondary"
                                :disabled="feePhase === 'signing'"
                                @click="
                                    feePhase = 'idle';
                                    resetFeeForm();
                                "
                            >
                                {{ t('chainCancel') }}
                            </button>
                        </template>
                    </div>
                </div>

                <div
                    v-if="canRewards"
                    class="cw-card"
                    style="margin-top: 14px; padding: 18px"
                    data-test="recipient-form"
                >
                    <div class="cw-label">{{ t('chainSetRecipient') }}</div>
                    <label
                        v-for="choice in [
                            'treasury',
                            'producer',
                            'other',
                        ] as const"
                        :key="choice"
                        style="
                            display: flex;
                            gap: 8px;
                            align-items: center;
                            margin-top: 10px;
                        "
                    >
                        <input
                            v-model="recipientChoice"
                            type="radio"
                            :value="choice"
                            name="fee-recipient"
                        />
                        <span>{{
                            choice === 'treasury'
                                ? `${t('chainRecipientTreasury')} · ${short(status.treasury.address)}`
                                : choice === 'producer'
                                  ? t('chainRecipientProducer')
                                  : t('chainRecipientOther')
                        }}</span>
                    </label>
                    <input
                        v-if="recipientChoice === 'other'"
                        v-model="recipientOther"
                        class="cw-input"
                        placeholder="0x…"
                        spellcheck="false"
                        style="width: 100%; margin-top: 8px"
                    />
                    <p
                        v-if="recipientError"
                        class="cw-note cw-note-bad"
                        style="margin-top: 10px"
                    >
                        {{ recipientError }}
                    </p>
                    <p
                        v-if="recipientResult"
                        class="cw-note"
                        style="margin-top: 10px"
                    >
                        {{ recipientResult }}
                    </p>
                    <button
                        type="button"
                        class="cw-btn cw-btn-primary"
                        style="margin-top: 14px"
                        :disabled="recipientBusy"
                        @click="applyRecipient"
                    >
                        {{ t('chainSign') }}
                    </button>
                </div>
            </template>
        </template>
    </div>
</template>

<style scoped>
/* A quiet action inside a row: the panel's secondary choices. */
.chain-link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--cw-accent);
    font: 500 13px/1.4 var(--cw-mono);
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
}

.chain-link:disabled {
    color: var(--cw-faint);
    cursor: default;
}
</style>
