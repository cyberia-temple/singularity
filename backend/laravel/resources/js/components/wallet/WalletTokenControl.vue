<script setup lang="ts">
import { ZeroAddress, isAddress, parseUnits } from 'ethers';
import { computed, onMounted, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { formatUnits, walletChains } from '@/lib/wallet';
import { shortAddress } from '@/lib/wallet/format';
import {
    TokenActionRefused,
    awaitTokenAction,
    mintRoom,
    quoteTokenAction,
    readTokenControl,
    tokenRights,
} from '@/lib/wallet/tokenControl';
import type {
    KitPart,
    TokenAction,
    TokenActionQuote,
    TokenControl,
} from '@/lib/wallet/tokenControl';
import { walletMessages } from '@/lib/walletMessages';

/**
 * A Cyberia 2.0 token's controls, on its page: who mints and how much more
 * can be, and what this account may do about it — mint to an address, hand
 * minting on (to an address, the token's DAO, or nobody), burn its own,
 * collect the pool's fees, open a part of the kit nobody has opened yet.
 *
 * The wallet's `token-admin.ts`. Each action is run as a call first and shows
 * its network fee before the hold; the contracts decide who may do what, and
 * only what they would accept from this account is offered.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** EVM chain id the token lives on. */
    evmChainId: number;
    token: string;
    tokenSymbol: string;
}>();

const emit = defineEmits<{ changed: [] }>();

const { t } = useLocale(walletMessages);

type Pick = 'mint' | 'handOver' | 'burn' | 'collect' | KitPart;
type Stage = 'form' | 'confirm' | 'sent' | 'done' | 'failed';

const walletChainId = computed(
    () =>
        walletChains().find((chain) => chain.chainId === props.evmChainId)
            ?.id ?? null,
);

const account = computed(() =>
    walletChainId.value === null
        ? null
        : (props.wallet.accounts.value.find(
              (entry) => entry.chain === walletChainId.value,
          ) ?? null),
);
const address = computed(() => account.value?.address ?? null);
const canSign = computed(() => account.value?.capabilities.send ?? false);

const coin = computed(
    () =>
        walletChains().find((chain) => chain.chainId === props.evmChainId)
            ?.symbol ?? 'CYBER',
);

const control = ref<TokenControl | null>(null);
const loading = ref(true);

const load = async (): Promise<void> => {
    try {
        control.value = await readTokenControl(
            props.evmChainId,
            props.token,
            address.value,
        );
    } catch {
        control.value = null;
    } finally {
        loading.value = false;
    }
};

onMounted(load);
watch(address, load);

const same = (a: string | null | undefined, b: string | null | undefined) =>
    Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();

const rights = computed(() =>
    control.value ? tokenRights(control.value, address.value) : null,
);
const room = computed(() => (control.value ? mintRoom(control.value) : null));

const minterText = computed(() => {
    const minter = control.value?.minter ?? null;

    if (minter === null) {
        return t('tokenMinterNobody');
    }

    if (same(minter, address.value)) {
        return t('tokenMinterYou');
    }

    if (same(minter, control.value?.timelock)) {
        return t('tokenMinterDao');
    }

    return t('tokenMinterOther', { address: shortAddress(minter) });
});

/** What this account may do here, in the order a creator reaches for them. */
const offered = computed<Pick[]>(() => {
    const can = rights.value;

    if (!can || !canSign.value) {
        return [];
    }

    return [
        ...(can.mint ? (['mint'] as const) : []),
        ...(can.handOver ? (['handOver'] as const) : []),
        ...(can.burn ? (['burn'] as const) : []),
        ...(can.collect ? (['collect'] as const) : []),
        ...can.open,
    ];
});

const partName = (part: KitPart): string =>
    t(
        part === 'credit'
            ? 'launchKitCredit'
            : part === 'farm'
              ? 'launchKitFarm'
              : 'launchKitDao',
    );

const label = (choice: Pick): string => {
    switch (choice) {
        case 'mint':
            return t('tokenActMint');
        case 'handOver':
            return t('tokenActHandOver');
        case 'burn':
            return t('tokenActBurn');
        case 'collect':
            return t('tokenActCollect');
        default:
            return t('tokenActOpen', { part: partName(choice) });
    }
};

const picked = ref<Pick | null>(null);
const stage = ref<Stage>('form');
const busy = ref(false);
const failure = ref<string | null>(null);
const quote = ref<TokenActionQuote | null>(null);

const mintTo = ref('');
const mintAmount = ref('');
const handTo = ref<'address' | 'dao' | 'nobody'>('address');
const handAddress = ref('');
const burnAmount = ref('');

const pick = (choice: Pick): void => {
    picked.value = picked.value === choice ? null : choice;
    stage.value = 'form';
    quote.value = null;
    failure.value = null;

    if (choice === 'mint' && !mintTo.value) {
        mintTo.value = address.value ?? '';
    }

    if (choice === 'handOver') {
        handTo.value = control.value?.timelock ? 'dao' : 'address';
    }
};

/** 18-decimal units of a typed amount, or null when it is not one above zero. */
const units = (value: string): bigint | null => {
    const trimmed = value.trim();

    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
        return null;
    }

    try {
        const parsed = parseUnits(trimmed, 18);

        return parsed > 0n ? parsed : null;
    } catch {
        return null;
    }
};

const amount = (value: bigint, precision = 4): string =>
    formatUnits(value, 18, precision);

/** The action the form describes, or the reason it describes none yet. */
const draft = computed<{ action: TokenAction } | { problem: string | null }>(
    () => {
        switch (picked.value) {
            case 'mint': {
                const value = units(mintAmount.value);

                if (!isAddress(mintTo.value.trim())) {
                    return { problem: t('tokenErrAddress') };
                }

                if (value === null) {
                    return { problem: null };
                }

                if (room.value !== null && value > room.value) {
                    return {
                        problem: t('tokenErrRoom', {
                            amount: amount(room.value, 0),
                        }),
                    };
                }

                return {
                    action: {
                        kind: 'mint',
                        to: mintTo.value.trim(),
                        amount: value,
                    },
                };
            }
            case 'handOver': {
                if (handTo.value === 'nobody') {
                    return {
                        action: { kind: 'setMinter', minter: ZeroAddress },
                    };
                }

                if (handTo.value === 'dao' && control.value?.timelock) {
                    return {
                        action: {
                            kind: 'setMinter',
                            minter: control.value.timelock,
                        },
                    };
                }

                return isAddress(handAddress.value.trim())
                    ? {
                          action: {
                              kind: 'setMinter',
                              minter: handAddress.value.trim(),
                          },
                      }
                    : { problem: null };
            }
            case 'burn': {
                const value = units(burnAmount.value);

                if (value === null) {
                    return { problem: null };
                }

                if (control.value && value > control.value.balance) {
                    return {
                        problem: t('tokenErrBalance', {
                            amount: amount(control.value.balance),
                        }),
                    };
                }

                return { action: { kind: 'burn', amount: value } };
            }
            case 'collect':
                return { action: { kind: 'collect' } };
            case 'credit':
            case 'farm':
            case 'dao':
                return { action: { kind: 'open', part: picked.value } };
            default:
                return { problem: null };
        }
    },
);

const action = computed(() =>
    'action' in draft.value ? draft.value.action : null,
);
const problem = computed(() =>
    'problem' in draft.value ? draft.value.problem : null,
);

/** Who a hand-over names, in words where it has some. */
const minterLabel = (minter: string): string =>
    minter === ZeroAddress
        ? t('tokenHandNobody')
        : same(minter, control.value?.timelock)
          ? t('tokenHandDao')
          : shortAddress(minter);

const refusal = (error: unknown): string => {
    if (error instanceof TokenActionRefused) {
        return error.code === 'funds'
            ? t('tokenErrFunds', { symbol: coin.value })
            : t('tokenErrReverted', { reason: error.message });
    }

    return error instanceof Error ? error.message : String(error);
};

const prepare = async (): Promise<void> => {
    if (
        !control.value ||
        !action.value ||
        !address.value ||
        walletChainId.value === null
    ) {
        return;
    }

    busy.value = true;
    failure.value = null;

    try {
        quote.value = await quoteTokenAction({
            control: control.value,
            action: action.value,
            account: address.value,
            gasPrice: await props.wallet.gasPrice(walletChainId.value),
        });
        stage.value = 'confirm';
    } catch (error) {
        failure.value = refusal(error);
    } finally {
        busy.value = false;
    }
};

const send = async (): Promise<void> => {
    if (!quote.value || walletChainId.value === null) {
        return;
    }

    busy.value = true;
    failure.value = null;

    try {
        const hash = await props.wallet.tokenAction(
            walletChainId.value,
            quote.value,
        );

        stage.value = 'sent';
        stage.value = (await awaitTokenAction(props.evmChainId, hash))
            ? 'done'
            : 'failed';
    } catch (error) {
        failure.value = refusal(error);
        stage.value = 'confirm';

        return;
    } finally {
        busy.value = false;
    }

    mintAmount.value = '';
    burnAmount.value = '';
    await load();
    emit('changed');
};
</script>

<template>
    <div class="cw-card" style="padding: 14px 16px; margin-top: 12px">
        <div class="cw-label" style="margin-bottom: 6px">
            {{ t('tokenControlTitle') }}
        </div>

        <p v-if="loading" class="cw-data">…</p>

        <template v-else-if="control">
            <div class="cw-kv">
                <span class="cw-kv-key">{{ t('tokenSupplyRule') }}</span>
                <span class="cw-kv-val">{{ minterText }}</span>
            </div>
            <div v-if="control.maxSupply !== null" class="cw-kv">
                <span class="cw-kv-key">{{ t('tokenCeiling') }}</span>
                <span class="cw-kv-val">{{
                    amount(control.maxSupply, 0)
                }}</span>
            </div>
            <div v-if="room !== null" class="cw-kv">
                <span class="cw-kv-key">{{ t('tokenRoom') }}</span>
                <span class="cw-kv-val">{{ amount(room, 0) }}</span>
            </div>
            <div v-if="control.balance > 0n" class="cw-kv">
                <span class="cw-kv-key">{{ t('tokenYourBalance') }}</span>
                <span class="cw-kv-val"
                    >{{ amount(control.balance) }} {{ tokenSymbol }}</span
                >
            </div>

            <div
                v-if="offered.length > 0"
                class="cw-row"
                style="
                    flex-wrap: wrap;
                    gap: 8px;
                    justify-content: flex-start;
                    margin-top: 12px;
                "
            >
                <button
                    v-for="choice in offered"
                    :key="choice"
                    type="button"
                    class="cw-chip"
                    :class="{ 'cw-chip-on': picked === choice }"
                    :aria-pressed="picked === choice"
                    :disabled="busy"
                    @click="pick(choice)"
                >
                    {{ label(choice) }}
                </button>
            </div>

            <div v-if="picked" style="margin-top: 14px">
                <template v-if="stage === 'form'">
                    <template v-if="picked === 'mint'">
                        <label
                            class="cw-label"
                            style="display: block; margin: 0 0 6px"
                        >
                            {{ t('tokenMintTo') }}
                        </label>
                        <input
                            v-model="mintTo"
                            class="cw-input"
                            type="text"
                            spellcheck="false"
                            autocomplete="off"
                            placeholder="0x…"
                        />
                        <label
                            class="cw-label"
                            style="display: block; margin: 12px 0 6px"
                        >
                            {{ t('tokenAmount') }} · {{ tokenSymbol }}
                        </label>
                        <input
                            v-model="mintAmount"
                            class="cw-input"
                            type="text"
                            inputmode="decimal"
                        />
                    </template>

                    <template v-else-if="picked === 'handOver'">
                        <div class="cw-seg" role="group">
                            <button
                                v-if="control.timelock"
                                type="button"
                                class="cw-seg-item"
                                :aria-pressed="handTo === 'dao'"
                                @click="handTo = 'dao'"
                            >
                                {{ t('tokenHandDao') }}
                            </button>
                            <button
                                type="button"
                                class="cw-seg-item"
                                :aria-pressed="handTo === 'address'"
                                @click="handTo = 'address'"
                            >
                                {{ t('tokenHandTo') }}
                            </button>
                            <button
                                type="button"
                                class="cw-seg-item"
                                :aria-pressed="handTo === 'nobody'"
                                @click="handTo = 'nobody'"
                            >
                                {{ t('tokenHandNobody') }}
                            </button>
                        </div>
                        <input
                            v-if="handTo === 'address'"
                            v-model="handAddress"
                            class="cw-input"
                            type="text"
                            spellcheck="false"
                            autocomplete="off"
                            placeholder="0x…"
                            style="margin-top: 10px"
                        />
                        <p
                            :class="
                                handTo === 'nobody'
                                    ? 'cw-note cw-note-warn'
                                    : 'cw-data'
                            "
                            style="margin-top: 10px"
                        >
                            <span>{{
                                t(
                                    handTo === 'nobody'
                                        ? 'tokenHandNobodyWarn'
                                        : handTo === 'dao'
                                          ? 'tokenHandDaoNote'
                                          : 'tokenHandAddressNote',
                                )
                            }}</span>
                        </p>
                    </template>

                    <template v-else-if="picked === 'burn'">
                        <label
                            class="cw-label"
                            style="display: block; margin: 0 0 6px"
                        >
                            {{ t('tokenAmount') }} · {{ tokenSymbol }}
                        </label>
                        <input
                            v-model="burnAmount"
                            class="cw-input"
                            type="text"
                            inputmode="decimal"
                        />
                        <p class="cw-data" style="margin-top: 6px">
                            {{ t('tokenBurnNote') }}
                        </p>
                    </template>

                    <p v-else-if="picked === 'collect'" class="cw-data">
                        {{ t('tokenCollectNote') }}
                    </p>

                    <p v-else class="cw-data">{{ t('tokenOpenNote') }}</p>

                    <p v-if="problem" class="cw-data" style="margin-top: 8px">
                        {{ problem }}
                    </p>

                    <button
                        type="button"
                        class="cw-btn cw-btn-primary"
                        style="height: 44px; margin-top: 12px"
                        :disabled="busy || action === null"
                        @click="prepare"
                    >
                        {{
                            busy
                                ? t('launchNewChecking')
                                : t('tokenContinue')
                        }}
                    </button>
                </template>

                <template v-else-if="stage === 'confirm' && quote">
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ label(picked) }}</span>
                        <span class="cw-kv-val">{{
                            quote.action.kind === 'mint'
                                ? `${amount(quote.action.amount)} → ${shortAddress(quote.action.to)}`
                                : quote.action.kind === 'burn'
                                  ? amount(quote.action.amount)
                                  : quote.action.kind === 'setMinter'
                                    ? minterLabel(quote.action.minter)
                                    : ''
                        }}</span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('mintFee') }}</span>
                        <span class="cw-kv-val"
                            >{{ formatUnits(quote.fee, 18, 4) }}
                            {{ coin }}</span
                        >
                    </div>
                    <div style="margin-top: 12px">
                        <HoldButton
                            :label="t('tokenHold')"
                            :disabled="busy"
                            @complete="send"
                        />
                    </div>
                    <button
                        type="button"
                        class="cw-ghost"
                        style="margin-top: 8px"
                        :disabled="busy"
                        @click="stage = 'form'"
                    >
                        {{ t('cancel') }}
                    </button>
                </template>

                <p v-else-if="stage === 'sent'" class="cw-data">
                    {{ t('tokenSent') }}
                </p>
                <p v-else-if="stage === 'done'" class="cw-note">
                    <span>{{ t('tokenDone') }}</span>
                </p>
                <p v-else-if="stage === 'failed'" class="cw-note cw-note-bad">
                    <span>{{ t('tokenFailed') }}</span>
                </p>

                <p
                    v-if="failure"
                    class="cw-note cw-note-bad"
                    style="margin-top: 10px"
                >
                    <span>{{ failure }}</span>
                </p>
            </div>
        </template>
    </div>
</template>
