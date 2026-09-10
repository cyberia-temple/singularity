<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AddressField from '@/components/wallet/AddressField.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useSecureClipboard } from '@/composables/useSecureClipboard';
import { formatUnits, hasSwap, sameToken, walletChain } from '@/lib/wallet';
import type { WalletChainId, WalletTokenBalance } from '@/lib/wallet';
import { isRoutedChain } from '@/lib/wallet/crosschain';
import { formatUsd, formatUsdPrice, usdValue } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * One token in full.
 *
 * A symbol is not an identity: anyone can deploy a contract that calls itself
 * USDC. So the screen leads with what cannot be forged — the contract address,
 * how the token got onto this list, and whether anything actually quotes it —
 * and treats the ticker as a label rather than a claim.
 *
 * There is no price chart here. The wallet has no series to draw one from: the
 * quotes it receives are point-in-time pool prices, and inventing a curve
 * between them would be a picture of nothing.
 */

const props = defineProps<{
    wallet: MultiWallet;
    chain: WalletChainId;
    /** The contract this screen is about. */
    address: string;
    /** Contract address (lowercased) → USD price, for this chain. */
    prices: Record<string, number>;
}>();

const emit = defineEmits<{
    back: [];
    send: [token: WalletTokenBalance];
    swap: [token: WalletTokenBalance];
    /** The token was dropped from the list and this screen has nothing left. */
    hidden: [];
}>();

const { locale, t } = useLocale(walletMessages);
const clipboard = useSecureClipboard();

const chain = computed(() => walletChain(props.chain));

const account = computed(() =>
    props.wallet.accounts.value.find(
        (candidate) => candidate.chain === props.chain,
    ),
);

/**
 * Whether anybody will trade this network — our own exchange or the router.
 *
 * Same correction as the network screen: the button used to appear only where
 * Cyberia had deployed a DEX, so a token on Solana or BNB offered a send and
 * an explorer link and no way to sell it, on a screen whose whole subject is
 * that token.
 */
const routed = ref(false);

watch(
    () => props.chain,
    async (id) => {
        routed.value = hasSwap(walletChain(id).chainId)
            ? true
            : await isRoutedChain(id);
    },
    { immediate: true },
);

const token = computed<WalletTokenBalance | null>(
    () =>
        (props.wallet.tokens.value[props.chain]?.items ?? []).find((entry) =>
            sameToken(entry.address, props.address),
        ) ?? null,
);

const price = computed<number | null>(
    () => props.prices[props.address.toLowerCase()] ?? null,
);

const value = computed(() =>
    token.value === null
        ? null
        : usdValue(token.value.balance, token.value.decimals, price.value),
);

/** Two letters of the ticker, in the network's hue — a token is not a chain. */
const tag = computed(() =>
    (
        (token.value?.symbol ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2) ||
        '?'
    ).toUpperCase(),
);

const priceLabel = computed(() => formatUsdPrice(price.value, locale.value));

const explorerUrl = computed(() =>
    chain.value.explorerAddressUrl(props.address),
);

const hide = async (): Promise<void> => {
    await props.wallet.removeToken(props.chain, props.address);
    emit('hidden');
};
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('tokens') }}
        </button>

        <template v-if="token && account">
            <div
                style="
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    margin: 22px 0;
                "
            >
                <span
                    :style="{
                        display: 'flex',
                        width: '38px',
                        height: '38px',
                        flex: 'none',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: `1px ${token.manual ? 'dashed' : 'solid'} ${chain.mark.hue}`,
                        color: chain.mark.hue,
                        font: '500 12px/1 var(--cw-mono)',
                        letterSpacing: '0.05em',
                    }"
                    >{{ tag }}</span
                >
                <div style="min-width: 0">
                    <div
                        style="
                            display: flex;
                            align-items: center;
                            gap: 8px;
                            font: 500 18px/1.2 var(--cw-sans);
                        "
                    >
                        {{ token.symbol }}
                        <span v-if="token.manual" class="cw-badge">{{
                            t('tokenByHand')
                        }}</span>
                    </div>
                    <div
                        style="
                            margin-top: 3px;
                            font: 400 10px/1.4 var(--cw-mono);
                            color: var(--cw-dim);
                        "
                    >
                        {{ token.name || t('kToken') }} · {{ account.label }}
                    </div>
                </div>
            </div>

            <div class="cw-label">{{ t('tokenPrice') }}</div>
            <div
                class="cw-total"
                style="margin-top: 8px; font-size: 30px"
                :style="
                    price === null ? { color: 'var(--cw-muted)' } : undefined
                "
            >
                {{ priceLabel }}
            </div>
            <p class="cw-prose" style="margin-top: 8px; font-size: 12px">
                {{ price === null ? t('tokenNoQuote') : t('tokenQuoteSource') }}
            </p>

            <div class="cw-card" style="margin-top: 18px; padding: 0">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('tokenYourBalance') }}</span>
                    <span class="cw-kv-val"
                        >{{ formatUnits(token.balance, token.decimals, 6) }}
                        {{ token.symbol }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('tokenValueLabel') }}</span>
                    <span class="cw-kv-val">{{
                        value === null
                            ? t('unpriced')
                            : formatUsd(value, locale)
                    }}</span>
                </div>
                <!--
                  Decimals are read from the contract, never assumed: Cyberia's
                  USDC counts in six of them, and a wallet that guessed
                  eighteen would show a millionth of the balance.
                -->
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('tokenDecimals') }}</span>
                    <span class="cw-kv-val">{{ token.decimals }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('tokenListedBy') }}</span>
                    <span class="cw-kv-val">{{
                        token.manual
                            ? t('tokenListedByYou')
                            : t('tokenListedByIndex')
                    }}</span>
                </div>
                <div style="padding: 16px">
                    <AddressField
                        :address="token.address"
                        :label="t('tokenContractLabel')"
                        :copied="clipboard.copied.value === token.address"
                        :copy-label="t('copyAddress')"
                        :copied-label="t('copiedClears')"
                        :expand-label="t('expandAddress')"
                        @copy="clipboard.copy(token.address)"
                    />
                </div>
            </div>

            <p
                v-if="token.manual"
                class="cw-note cw-note-warn"
                style="margin-top: 14px"
            >
                <span>{{ t('tokenManualWarn') }}</span>
            </p>

            <div class="cw-fill" style="min-height: 20px"></div>

            <div style="display: flex; gap: 8px; margin-top: 20px">
                <button
                    type="button"
                    class="cw-btn cw-btn-primary"
                    style="height: 50px"
                    :disabled="!chain.send || token.balance === 0n"
                    @click="emit('send', token)"
                >
                    {{ t('send') }}
                </button>
                <!--
                  Trading it needs a pool, not a balance: a token at zero can
                  still be the thing you are about to buy.
                -->
                <button
                    v-if="routed"
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="height: 50px"
                    :disabled="!chain.send"
                    @click="emit('swap', token)"
                >
                    {{ t('swapTitle') }}
                </button>
                <a
                    v-if="explorerUrl"
                    :href="explorerUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="cw-btn cw-btn-secondary"
                    style="height: 50px; text-decoration: none"
                >
                    {{ t('viewInExplorer') }} ↗
                </a>
            </div>
            <button
                v-if="token.manual"
                type="button"
                class="cw-back"
                style="margin-top: 12px; align-self: center"
                @click="hide()"
            >
                {{ t('hideToken') }}
            </button>
        </template>

        <!--
          The row that opened this screen is gone — hidden here, or dropped by
          a refresh that found the balance at zero.
        -->
        <p v-else class="cw-prose" style="margin-top: 24px">
            {{ t('tokenGone') }}
        </p>
    </div>
</template>
