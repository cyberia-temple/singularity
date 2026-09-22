<script setup lang="ts">
import { computed, onMounted } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import TokenList from '@/components/wallet/TokenList.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { walletChain } from '@/lib/wallet';
import type { WalletChainId, WalletTokenBalance } from '@/lib/wallet';
import { formatUsd, usdValue } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Every token this vault holds, on every network that can hold one.
 *
 * The portfolio rolls tokens into the network they live on, because that is
 * where their address and their gas come from. This screen is the other cut of
 * the same fact: one total, then one section per network, so "what do I hold"
 * can be answered without walking five network screens.
 *
 * The total counts what could be priced and says how much it left out. Prices
 * exist for contracts the Cyberia pool graph quotes; a token nobody trades has
 * a balance and no price, which is not the same as being worth nothing.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** Chain id → (lowercased contract → USD price). */
    tokenPrices: Record<string, Record<string, number>>;
}>();

const emit = defineEmits<{
    back: [];
    open: [chain: WalletChainId, token: WalletTokenBalance];
    send: [chain: WalletChainId, token: WalletTokenBalance];
}>();

const { locale, t } = useLocale(walletMessages);

/** The accounts that can hold a token at all — everything else has no list. */
const sections = computed(() =>
    props.wallet.accounts.value.filter(
        (account) => walletChain(account.chain).readToken !== undefined,
    ),
);

const held = computed(() =>
    sections.value.flatMap((account) =>
        (props.wallet.tokens.value[account.chain]?.items ?? []).map(
            (token) => ({
                chain: account.chain,
                token,
                usd: usdValue(
                    token.balance,
                    token.decimals,
                    props.tokenPrices[account.chain]?.[
                        token.address.toLowerCase()
                    ] ?? null,
                ),
            }),
        ),
    ),
);

const total = computed(() =>
    held.value.reduce((sum, row) => sum + (row.usd ?? 0), 0),
);

/** Balances the total cannot include, because nothing quotes them. */
const unpriced = computed(
    () => held.value.filter((row) => row.usd === null).length,
);

onMounted(() => {
    // The portfolio only refreshes the chains that can enumerate tokens by
    // themselves; a chain where every token was added by hand is loaded here,
    // because this is the screen that claims to list all of them.
    sections.value.forEach((account) => {
        void props.wallet.refreshTokens(account.chain);
    });
});
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">{{ t('tokens') }}</h2>

        <div class="cw-card" style="margin-top: 18px; padding: 14px 16px">
            <div class="cw-label">{{ t('tokenValue') }}</div>
            <div
                class="cw-total"
                style="margin-top: 8px; font-size: 26px"
                :style="unpriced > 0 ? { color: 'var(--cw-muted)' } : undefined"
            >
                {{ formatUsd(total, locale) }}
            </div>
            <div
                class="cw-label"
                style="margin-top: 10px; color: var(--cw-faint)"
            >
                {{
                    t('tokensTracked', {
                        count: held.length,
                        networks: sections.length,
                    })
                }}
            </div>
            <div
                v-if="unpriced > 0"
                style="
                    margin-top: 6px;
                    font: 500 13px/1.5 var(--cw-mono);
                    color: var(--cw-pending);
                "
            >
                {{ t('tokensUnpricedCount', { count: unpriced }) }}
            </div>
        </div>

        <template v-for="account in sections" :key="account.chain">
            <div class="cw-group" style="margin-top: 22px">
                <NetworkMark :chain="account.chain" dot :size="7" />
                <span class="cw-label" style="color: var(--cw-muted)">{{
                    account.label
                }}</span>
            </div>
            <TokenList
                :wallet="wallet"
                :chain="account.chain"
                :prices="tokenPrices[account.chain] ?? {}"
                :heading="null"
                style="margin-top: 8px"
                @open="emit('open', account.chain, $event)"
                @send="emit('send', account.chain, $event)"
            />
        </template>

        <!--
          No network in this vault can hold a token — Monero and the Bitcoin
          family cannot, and the EVM chains are the ones that were removed.
        -->
        <p
            v-if="sections.length === 0"
            class="cw-prose"
            style="margin-top: 24px"
        >
            {{ t('tokensNoNetworks') }}
        </p>
    </div>
</template>
