<script setup lang="ts">
import { formatUnits } from 'ethers';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { tokenAdminMessages } from '@/lib/tokenAdminMessages';
import {
    TOKEN_GATEWAY,
    checkedAddress,
    checkedHash,
    prepareOperation,
    readOutbound,
    readTokens,
    receiptStatus,
    units,
} from '@/lib/wallet/tokenAdmin';
import type { AdminRequest, AdminToken } from '@/lib/wallet/tokenAdmin';

const props = defineProps<{ wallet: MultiWallet }>();
const emit = defineEmits<{ back: [] }>();
const { t } = useLocale(tokenAdminMessages);
const account = computed(
    () =>
        props.wallet.accounts.value.find(
            (entry) => entry.chain === 'cyberia_fuji',
        )?.address ?? null,
);
const tokens = ref<AdminToken[]>([]);
const selected = ref('');
const token = computed(
    () => tokens.value.find((item) => item.address === selected.value) ?? null,
);
const mode = ref<'create' | 'configure' | 'mint' | 'finalize'>('create');
const form = reactive({
    name: '',
    symbol: '',
    decimals: '18',
    originChain: '',
    originId: '',
    capacity: '0',
    refill: '0',
    minOut: '0',
    enabled: false,
    recipient: '',
    amount: '',
    source: '',
    nonce: '',
    payout: '',
});
const review = ref<{
    request: AdminRequest;
    lines: [string, string][];
    fee: bigint | null;
} | null>(null);
const busy = ref(false);
const loading = ref(true);
const readFailed = ref(false);
const paused = ref(false);
const error = ref('');
const txKey = 'cyberia.fuji.token-admin.pending';
const txHash = ref(localStorage.getItem(txKey) ?? '');
const txStatus = ref<'pending' | 'confirmed' | 'failed'>('pending');
const money = (amount: bigint, decimals: number) =>
    formatUnits(amount, decimals);
const fail = (e: unknown) => {
    error.value = e instanceof Error ? e.message : String(e);
};
const refresh = async () => {
    loading.value = true;
    readFailed.value = false;

    try {
        const data = await readTokens();
        tokens.value = data.tokens;
        paused.value = data.paused;

        if (!selected.value && data.tokens.length) {
            selected.value = data.tokens[0].address;
        }
    } catch (e) {
        readFailed.value = true;
        fail(e);
    } finally {
        loading.value = false;
    }
};
const checkTx = async () => {
    if (!txHash.value) {
        return;
    }

    busy.value = true;

    try {
        txStatus.value = await receiptStatus(txHash.value);

        if (txStatus.value !== 'pending') {
            localStorage.removeItem(txKey);
            await refresh();
        }
    } catch (e) {
        fail(e);
    } finally {
        busy.value = false;
    }
};
onMounted(() => {
    void refresh();

    if (txHash.value) {
        void checkTx();
    }
});
watch(account, () => {
    review.value = null;
});
watch(token, (value) => {
    if (!value) {
        return;
    }

    form.capacity = money(value.capacity, value.decimals);
    form.refill = money(value.refill, value.decimals);
    form.minOut = money(value.minOut, value.decimals);
    form.enabled = value.outboundEnabled;
});
const positiveInteger = (value: string, max: bigint): bigint => {
    if (!/^\d+$/.test(value)) {
        throw new Error(t('invalid'));
    }

    const result = BigInt(value);

    if (result > max) {
        throw new Error(t('invalid'));
    }

    return result;
};
const makeReview = async () => {
    error.value = '';

    if (!account.value || busy.value) {
        return;
    }

    busy.value = true;

    try {
        let request: AdminRequest;
        let lines: [string, string][];

        if (mode.value === 'create') {
            const name = form.name.trim();
            const symbol = form.symbol.trim();
            const decimals = positiveInteger(form.decimals, 18n);
            const origin = positiveInteger(form.originChain, (1n << 64n) - 1n);

            if (!name || !symbol || origin === 0n) {
                throw new Error(t('invalid'));
            }

            const id = checkedHash(form.originId);
            request = {
                operation: 'createWrapped',
                args: [name, symbol, Number(decimals), origin, id],
                account: account.value,
            };
            lines = [
                [t('name'), name],
                [t('symbol'), symbol],
                [t('decimals'), String(decimals)],
                [t('originChain'), String(origin)],
                [t('originId'), id],
            ];
        } else {
            const item = token.value;

            if (!item) {
                throw new Error(t('invalid'));
            }

            lines = [
                [t('selected'), `${item.name} (${item.symbol})`],
                ['Contract', item.address],
            ];

            if (mode.value === 'configure') {
                const capacity = units(form.capacity, item.decimals, true);
                const refill = units(form.refill, item.decimals, true);
                const min = units(form.minOut, item.decimals, true);

                if ([capacity, refill, min].some((x) => x >= 1n << 128n)) {
                    throw new Error(t('invalid'));
                }

                request = {
                    operation: 'setAsset',
                    args: [
                        item.address,
                        1,
                        capacity,
                        refill,
                        form.enabled,
                        min,
                    ],
                    account: account.value,
                };
                lines.push(
                    [t('capacity'), form.capacity],
                    [t('refill'), form.refill],
                    [t('minOut'), form.minOut],
                    [t('enabled'), String(form.enabled)],
                );
            } else if (mode.value === 'mint') {
                const recipient = checkedAddress(form.recipient);
                const amount = units(form.amount, item.decimals);
                const source = checkedHash(form.source);
                request = {
                    operation: 'release',
                    args: [item.address, recipient, amount, source],
                    account: account.value,
                };
                lines.push(
                    [t('recipient'), recipient],
                    [t('amount'), `${form.amount} ${item.symbol}`],
                    [t('source'), source],
                );
            } else {
                const nonce = positiveInteger(form.nonce, (1n << 256n) - 1n);

                if (nonce === 0n) {
                    throw new Error(t('invalid'));
                }

                const out = await readOutbound(nonce);

                if (
                    out.status !== 1 ||
                    out.token.toLowerCase() !== item.address.toLowerCase()
                ) {
                    throw new Error(t('requestOther'));
                }

                const payout = checkedHash(form.payout);
                request = {
                    operation: 'finalize',
                    args: [nonce, payout],
                    account: account.value,
                };
                lines.push(
                    [t('nonce'), String(nonce)],
                    [t('holder'), out.sender],
                    [
                        t('amount'),
                        `${money(out.amount, item.decimals)} ${item.symbol}`,
                    ],
                    [t('destination'), String(out.destChain)],
                    [t('destinationRecipient'), out.recipient],
                    [t('payout'), payout],
                );
            }
        }

        const estimate = await prepareOperation(request);

        if (account.value?.toLowerCase() !== request.account.toLowerCase()) {
            throw new Error(
                'The active account changed; review the operation again',
            );
        }

        review.value = { request, lines, fee: estimate.maxFee };
    } catch (e) {
        fail(e);
    } finally {
        busy.value = false;
    }
};
const sign = async () => {
    if (
        !review.value ||
        busy.value ||
        (txHash.value && txStatus.value === 'pending')
    ) {
        return;
    }

    busy.value = true;
    error.value = '';

    try {
        const hash = await props.wallet.chainAdmin.tokenOperation(
            review.value.request,
        );
        txHash.value = hash;
        txStatus.value = 'pending';
        localStorage.setItem(txKey, hash);
        review.value = null;
    } catch (e) {
        fail(e);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('back') }}
        </button>
        <p class="cw-label" style="margin-top: 24px">{{ t('subtitle') }}</p>
        <h2 class="cw-title" style="margin: 8px 0">{{ t('title') }}</h2>
        <p class="cw-prose">{{ t('intro') }}</p>
        <p class="cw-note cw-note-warn" style="margin-top: 16px">
            {{ t('backing') }}
        </p>
        <p v-if="paused" class="cw-note cw-note-warn" style="margin-top: 10px">
            {{ t('paused') }}
        </p>
        <p v-if="!account" class="cw-note cw-note-bad">{{ t('noAccount') }}</p>
        <p
            v-if="error"
            class="cw-note cw-note-bad"
            role="alert"
            style="margin-top: 12px; overflow-wrap: anywhere"
        >
            {{ error }}
        </p>
        <div
            v-if="txHash"
            class="cw-card"
            style="padding: 16px; margin-top: 16px"
        >
            <p>
                {{
                    t(
                        txStatus === 'pending'
                            ? 'waiting'
                            : txStatus === 'confirmed'
                              ? 'confirmed'
                              : 'failed',
                    )
                }}
            </p>
            <p style="overflow-wrap: anywhere; margin-top: 8px">
                {{ t('hash') }}: {{ txHash }}
            </p>
            <button
                type="button"
                class="cw-btn cw-btn-secondary"
                style="margin-top: 10px"
                :disabled="busy"
                @click="checkTx"
            >
                {{ t('status') }}
            </button>
        </div>
        <template v-if="!review">
            <div class="admin-heading">
                <span class="cw-label"
                    >{{ t('selected') }} · {{ tokens.length }}</span
                ><button type="button" class="cw-back" @click="refresh">
                    {{ t('refresh') }}
                </button>
            </div>
            <p v-if="loading" class="cw-prose">{{ t('loading') }}</p>
            <p v-else-if="!readFailed && !tokens.length" class="cw-prose">
                {{ t('empty') }}
            </p>
            <div class="admin-list">
                <button
                    v-for="item in tokens"
                    :key="item.address"
                    type="button"
                    class="admin-token"
                    :class="{ active: selected === item.address }"
                    @click="
                        selected = item.address;
                        mode = 'mint';
                    "
                >
                    <strong>{{ item.symbol }}</strong
                    ><span>{{ item.name }}</span
                    ><span
                        >{{ t('supply') }}:
                        {{ money(item.supply, item.decimals) }}</span
                    ><span
                        >{{ t('limit') }}:
                        {{ money(item.available, item.decimals) }}</span
                    >
                </button>
            </div>
            <p class="cw-note" style="margin-top: 12px">{{ t('burnNote') }}</p>
            <div class="admin-actions">
                <button
                    v-for="item in [
                        'create',
                        'configure',
                        'mint',
                        'finalize',
                    ] as const"
                    :key="item"
                    type="button"
                    class="cw-btn"
                    :class="
                        mode === item ? 'cw-btn-primary' : 'cw-btn-secondary'
                    "
                    :disabled="item !== 'create' && !token"
                    @click="
                        mode = item;
                        error = '';
                    "
                >
                    {{ t(item) }}
                </button>
            </div>
            <div class="cw-card admin-form">
                <template v-if="mode === 'create'">
                    <label
                        >{{ t('name')
                        }}<input
                            v-model="form.name"
                            class="cw-input"
                            maxlength="80"
                    /></label>
                    <label
                        >{{ t('symbol')
                        }}<input
                            v-model="form.symbol"
                            class="cw-input"
                            maxlength="24"
                    /></label>
                    <label
                        >{{ t('decimals')
                        }}<input
                            v-model="form.decimals"
                            class="cw-input"
                            inputmode="numeric"
                    /></label>
                    <label
                        >{{ t('originChain')
                        }}<input
                            v-model="form.originChain"
                            class="cw-input"
                            inputmode="numeric"
                    /></label>
                    <label
                        >{{ t('originId')
                        }}<input v-model="form.originId" class="cw-input"
                    /></label>
                    <p class="cw-prose">{{ t('originHelp') }}</p>
                </template>
                <template v-else-if="mode === 'configure'">
                    <p class="cw-prose">{{ t('saved') }}</p>
                    <label
                        >{{ t('capacity')
                        }}<input
                            v-model="form.capacity"
                            class="cw-input"
                            inputmode="decimal"
                    /></label>
                    <label
                        >{{ t('refill')
                        }}<input
                            v-model="form.refill"
                            class="cw-input"
                            inputmode="decimal"
                    /></label>
                    <label
                        >{{ t('minOut')
                        }}<input
                            v-model="form.minOut"
                            class="cw-input"
                            inputmode="decimal"
                    /></label>
                    <label
                        ><input v-model="form.enabled" type="checkbox" />
                        {{ t('enabled') }}</label
                    >
                </template>
                <template v-else-if="mode === 'mint'">
                    <label
                        >{{ t('recipient')
                        }}<input v-model="form.recipient" class="cw-input"
                    /></label>
                    <label
                        >{{ t('amount')
                        }}<input
                            v-model="form.amount"
                            class="cw-input"
                            inputmode="decimal"
                    /></label>
                    <label
                        >{{ t('source')
                        }}<input v-model="form.source" class="cw-input"
                    /></label>
                    <p class="cw-prose">{{ t('sourceHelp') }}</p>
                </template>
                <template v-else>
                    <label
                        >{{ t('nonce')
                        }}<input
                            v-model="form.nonce"
                            class="cw-input"
                            inputmode="numeric"
                    /></label>
                    <label
                        >{{ t('payout')
                        }}<input v-model="form.payout" class="cw-input"
                    /></label>
                    <p class="cw-prose">{{ t('payoutHelp') }}</p>
                </template>
                <button
                    type="button"
                    class="cw-btn cw-btn-primary"
                    :disabled="
                        busy || !account || (!!txHash && txStatus === 'pending')
                    "
                    @click="makeReview"
                >
                    {{ busy ? t('checking') : t('review') }}
                </button>
            </div>
        </template>
        <div v-else class="cw-card admin-form" style="margin-top: 20px">
            <h3>
                {{ t('reviewTitle') }} ·
                {{
                    t(
                        (
                            {
                                createWrapped: 'create',
                                setAsset: 'configure',
                                release: 'mint',
                                finalize: 'finalize',
                            } as const
                        )[review.request.operation],
                    )
                }}
            </h3>
            <div
                v-for="line in review.lines"
                :key="line[0]"
                class="admin-review"
            >
                <span>{{ line[0] }}</span
                ><strong>{{ line[1] }}</strong>
            </div>
            <div class="admin-review">
                <span>{{ t('signer') }}</span
                ><strong>{{ review.request.account }}</strong>
            </div>
            <div class="admin-review">
                <span>{{ t('gateway') }}</span
                ><strong>{{ TOKEN_GATEWAY }}</strong>
            </div>
            <div class="admin-review">
                <span>{{ t('fee') }}</span
                ><strong>{{
                    review.fee === null
                        ? t('unknown')
                        : `${formatUnits(review.fee, 18)} CYBER`
                }}</strong>
            </div>
            <p class="cw-prose">{{ t('backing') }}</p>
            <HoldButton
                :label="t('confirm')"
                :disabled="busy || !props.wallet.unlocked.value"
                @complete="sign"
            />
            <button
                type="button"
                class="cw-btn cw-btn-secondary"
                :disabled="busy"
                @click="review = null"
            >
                {{ t('cancel') }}
            </button>
        </div>
    </div>
</template>

<style scoped>
.admin-heading {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin: 24px 0 10px;
}
.admin-list {
    display: grid;
    gap: 8px;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 210px), 1fr));
}
.admin-token {
    border: 1px solid var(--cw-border);
    border-radius: 4px;
    padding: 12px;
    text-align: left;
    display: grid;
    gap: 5px;
    overflow-wrap: anywhere;
}
.admin-token.active {
    border-color: var(--cw-accent);
}
.admin-token span {
    color: var(--cw-muted);
    font-size: 12px;
}
.admin-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 20px;
}
.admin-form {
    display: grid;
    gap: 14px;
    padding: 18px;
    margin-top: 12px;
}
.admin-form label {
    display: grid;
    gap: 6px;
    overflow-wrap: anywhere;
}
.admin-review {
    display: grid;
    gap: 4px;
    overflow-wrap: anywhere;
}
.admin-review span {
    color: var(--cw-muted);
    font-size: 12px;
}
</style>
