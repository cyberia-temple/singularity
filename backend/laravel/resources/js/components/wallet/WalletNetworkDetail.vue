<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import AddressField from '@/components/wallet/AddressField.vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import TokenList from '@/components/wallet/TokenList.vue';
import TxList from '@/components/wallet/TxList.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useSecureClipboard } from '@/composables/useSecureClipboard';
import {
    describeReadError,
    formatUnits,
    hasSwap,
    walletChain,
} from '@/lib/wallet';
import type {
    WalletChainId,
    WalletTokenBalance,
    WalletTxStatus,
} from '@/lib/wallet';
import { formatUsd, formatUsdPrice, usdValue } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * One network in full: balance, the address that receives it, and what has
 * moved through it. History comes from the chain's own indexer, so a chain the
 * browser cannot index says so instead of showing an empty list that would
 * read as "nothing ever happened".
 */

const props = defineProps<{
    wallet: MultiWallet;
    chain: WalletChainId;
    prices: Record<string, number | null>;
    /** Chain id → (lowercased contract → USD price). */
    tokenPrices: Record<string, Record<string, number>>;
}>();

const emit = defineEmits<{
    back: [];
    send: [token?: WalletTokenBalance];
    receive: [];
    swap: [];
    openToken: [token: WalletTokenBalance];
}>();

const { locale, t } = useLocale(walletMessages);
const clipboard = useSecureClipboard();

const chain = computed(() => walletChain(props.chain));

const account = computed(() =>
    props.wallet.accounts.value.find(
        (candidate) => candidate.chain === props.chain,
    ),
);

const balance = computed(() => props.wallet.balances.value[props.chain]);

const history = computed(() => props.wallet.history.value[props.chain]);

/** A failed history read, in words, with the status behind it kept separate. */
const historyFailure = computed(() =>
    history.value?.error ? describeReadError(history.value.error, t) : null,
);

const statusLabels = computed<Record<WalletTxStatus, string>>(() => ({
    confirmed: t('statusConfirmed'),
    pending: t('statusPending'),
    failed: t('statusFailed'),
}));

const load = (): void => {
    void props.wallet.refreshHistory(props.chain);
    void props.wallet.refreshTokens(props.chain);
};

onMounted(load);
watch(() => props.chain, load);
</script>

<template>
    <div v-if="account" class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <div
            style="
                display: flex;
                align-items: center;
                gap: 12px;
                margin: 22px 0;
            "
        >
            <NetworkMark :chain="props.chain" :size="38" />
            <div>
                <div style="font: 500 18px/1.2 var(--cw-sans)">
                    {{ account.label }}
                </div>
                <!--
                  What this network *is*, not how its key was derived.
                  `m/44'/60'/0'/0/0 · secp256k1` used to sit here — debugging
                  information in the most looked-at line of the screen, and an
                  answer to a question nobody standing on this page is asking.
                  It moved to Security, next to the phrase and the accounts,
                  where it answers "can I restore this elsewhere".
                -->
                <div
                    style="
                        margin-top: 3px;
                        font: 400 11px/1.4 var(--cw-mono);
                        color: var(--cw-dim);
                    "
                >
                    {{ account.symbol
                    }}<template v-if="chain.chainId">
                        · chain {{ chain.chainId }}</template
                    >
                </div>
            </div>
        </div>

        <div class="cw-card" style="padding: 18px">
            <div class="cw-label" style="margin-bottom: 10px">
                {{ t('balance') }}
            </div>
            <div style="display: flex; align-items: baseline; gap: 8px">
                <span
                    style="
                        font: 500 28px/1 var(--cw-mono);
                        letter-spacing: -0.02em;
                        font-variant-numeric: tabular-nums;
                    "
                >
                    {{
                        !account.capabilities.balance
                            ? '—'
                            : balance?.loading
                              ? '…'
                              : balance?.value === null ||
                                  balance?.value === undefined
                                ? '—'
                                : formatUnits(
                                      balance.value,
                                      account.decimals,
                                      6,
                                  )
                    }}
                </span>
                <span
                    style="
                        font: 400 13px/1 var(--cw-mono);
                        color: var(--cw-muted);
                    "
                    >{{ account.symbol }}</span
                >
            </div>
            <div
                style="
                    margin-top: 8px;
                    font: 400 12px/1 var(--cw-mono);
                    color: var(--cw-dim);
                "
            >
                {{
                    account.capabilities.balance
                        ? formatUsd(
                              usdValue(
                                  balance?.value ?? null,
                                  account.decimals,
                                  prices[props.chain] ?? null,
                              ),
                              locale,
                          )
                        : t('noBalanceHere')
                }}
            </div>

            <!--
              What one coin costs, said outright. A balance in dollars answers
              "how much do I have"; the rate answers "at what", and until it
              was here the wallet quoted a Cyberia balance without ever naming
              the price it had quoted it at.
            -->
            <div
                v-if="prices[props.chain] != null"
                style="
                    margin-top: 6px;
                    font: 400 11px/1 var(--cw-mono);
                    color: var(--cw-faint);
                "
            >
                1 {{ account.symbol }} =
                {{ formatUsdPrice(prices[props.chain] ?? null, locale) }}
            </div>

            <div
                style="
                    margin-top: 16px;
                    padding-top: 14px;
                    border-top: 1px solid var(--cw-line);
                "
            >
                <AddressField
                    :address="account.address"
                    :label="t('yourAddress')"
                    :copied="clipboard.copied.value === account.address"
                    :copy-label="t('copyAddress')"
                    :copied-label="t('copiedClears')"
                    :expand-label="t('expandAddress')"
                    @copy="clipboard.copy(account.address)"
                />
            </div>
        </div>

        <div style="display: flex; gap: 8px; margin: 16px 0 26px">
            <button
                type="button"
                class="cw-btn cw-btn-primary"
                style="height: 48px"
                :disabled="!account.capabilities.send"
                @click="emit('send')"
            >
                {{ t('send') }}
            </button>
            <button
                type="button"
                class="cw-btn cw-btn-secondary"
                style="height: 48px"
                @click="emit('receive')"
            >
                {{ t('receive') }}
            </button>
            <!--
              Only where an exchange is actually deployed: a network with no
              router has nothing to trade against, and a button that opens a
              screen to say so is a button that lied.
            -->
            <button
                v-if="hasSwap(chain.chainId)"
                type="button"
                class="cw-btn cw-btn-secondary"
                style="height: 48px"
                :disabled="!account.capabilities.send"
                @click="emit('swap')"
            >
                {{ t('swapTitle') }}
            </button>
        </div>

        <TokenList
            :wallet="wallet"
            :chain="props.chain"
            :prices="tokenPrices[props.chain] ?? {}"
            @send="emit('send', $event)"
            @open="emit('openToken', $event)"
        />

        <div class="cw-row" style="margin: 24px 0 6px">
            <span class="cw-label">{{ t('history') }}</span>
            <a
                v-if="account.explorerUrl"
                :href="account.explorerUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="cw-label"
                style="color: var(--cw-accent); text-decoration: none"
                >{{ t('viewInExplorer') }} ↗</a
            >
        </div>

        <p v-if="!chain.fetchHistory" class="cw-note">
            <span>{{ t(chain.historyNote ?? 'historyNoIndexer') }}</span>
        </p>
        <p
            v-else-if="history?.loading"
            class="cw-label"
            style="padding: 14px 0"
        >
            {{ t('loading') }}
        </p>
        <p v-else-if="historyFailure" class="cw-note cw-note-warn">
            <span>
                {{ t('historyUnavailable', { reason: historyFailure.text }) }}
                <span
                    v-if="historyFailure.detail"
                    style="color: var(--cw-faint)"
                    >{{ historyFailure.detail }}</span
                >
            </span>
        </p>
        <p
            v-else-if="(history?.items.length ?? 0) === 0"
            class="cw-prose"
            style="padding: 14px 0"
        >
            {{ t('historyEmpty') }}
        </p>
        <TxList
            v-else
            :entries="
                (history?.items ?? []).map((tx) => ({
                    chain: props.chain,
                    tx,
                }))
            "
            :locale="locale"
            :status-labels="statusLabels"
            :sent-to="t('sentTo')"
            :received-from="t('receivedFrom')"
        />
    </div>
</template>
