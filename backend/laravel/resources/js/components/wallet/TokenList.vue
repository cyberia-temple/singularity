<script setup lang="ts">
import { computed, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { describeReadError, formatUnits, walletChain } from '@/lib/wallet';
import type { WalletChainId, WalletTokenBalance } from '@/lib/wallet';
import { formatUsd, usdValue } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The ERC20s held on one network.
 *
 * A token is not a network: it shares this account, this address and this
 * chain's gas coin, and only its balance and its transfer are its own. So it
 * sits inside the network screen rather than beside it in the portfolio, and it
 * borrows the network's mark instead of inventing one.
 *
 * Which tokens exist is answered by the chain's own index. A chain without one
 * says so — an empty list would read as "you hold nothing", which is a claim
 * this wallet cannot make — and in either case a contract can be added by hand.
 */

const props = withDefaults(
    defineProps<{
        wallet: MultiWallet;
        chain: WalletChainId;
        /** Contract address (lowercased) → USD price, for this chain. */
        prices: Record<string, number>;
        /**
         * The caption above the list. Null drops it, for a screen that already
         * says which network these belong to in its own heading.
         */
        heading?: string | null;
    }>(),
    { heading: undefined },
);

const emit = defineEmits<{
    send: [token: WalletTokenBalance];
    open: [token: WalletTokenBalance];
}>();

const { locale, t } = useLocale(walletMessages);

const contract = ref('');
const adding = ref(false);
const problem = ref<string | null>(null);

const chain = computed(() => walletChain(props.chain));

const state = computed(() => props.wallet.tokens.value[props.chain]);

/**
 * A failed read, said in words plus the status it came back with.
 *
 * The status used to be the whole sentence — "Explorer returned 429" dropped
 * into the middle of a Russian one. It is still printed, because it is what an
 * operator reads off a screenshot, but after the part a person can act on.
 */
const readFailure = computed(() =>
    state.value?.error ? describeReadError(state.value.error, t) : null,
);

const rows = computed(() =>
    (state.value?.items ?? []).map((token) => ({
        token,
        amount: formatUnits(token.balance, token.decimals, 4),
        usd: usdValue(
            token.balance,
            token.decimals,
            props.prices[token.address.toLowerCase()] ?? null,
        ),
    })),
);

/** Two letters of the ticker, in the network's own hue — a token is not a chain. */
const tag = (symbol: string): string =>
    (symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase();

const add = async (): Promise<void> => {
    adding.value = true;
    problem.value = await props.wallet.addToken(
        props.chain,
        contract.value.trim(),
    );
    adding.value = false;

    if (problem.value === null) {
        contract.value = '';
    }
};
</script>

<template>
    <div v-if="chain.readToken" class="cw-stack" style="margin-top: 24px">
        <div
            v-if="heading !== null || state?.loading"
            class="cw-row"
            style="margin-bottom: 10px"
        >
            <span v-if="heading !== null" class="cw-label">{{
                heading ?? t('tokens')
            }}</span>
            <span
                v-if="state?.loading"
                class="cw-label"
                style="color: var(--cw-faint)"
                >{{ t('loading') }}</span
            >
        </div>

        <!--
          No index means "nobody here can enumerate them", not "there are none".
          Saying the first is honest; rendering the second as an empty list is a
          claim about someone's balance that this wallet has no basis for.
        -->
        <p v-if="chain.tokensNote" class="cw-note" style="margin-bottom: 8px">
            <span>{{ t(chain.tokensNote) }}</span>
        </p>

        <p
            v-else-if="readFailure"
            class="cw-note cw-note-warn"
            style="margin-bottom: 8px"
        >
            <span>
                {{ t('tokensUnavailable', { reason: readFailure.text }) }}
                <span
                    v-if="readFailure.detail"
                    style="color: var(--cw-faint)"
                    >{{ readFailure.detail }}</span
                >
            </span>
        </p>

        <div class="cw-stack" style="gap: 8px">
            <div
                v-for="row in rows"
                :key="row.token.address"
                class="cw-card"
                style="padding: 13px 14px"
            >
                <button
                    type="button"
                    class="cw-open"
                    style="display: flex; align-items: center; gap: 12px"
                    @click="emit('open', row.token)"
                >
                    <span
                        :style="{
                            display: 'flex',
                            width: '28px',
                            height: '28px',
                            flex: 'none',
                            alignItems: 'center',
                            justifyContent: 'center',
                            border: `1px solid ${chain.mark.hue}`,
                            color: chain.mark.hue,
                            font: '500 9px/1 var(--cw-mono)',
                            letterSpacing: '0.05em',
                        }"
                        >{{ tag(row.token.symbol) }}</span
                    >
                    <span style="flex: 1; min-width: 0">
                        <span
                            style="
                                display: flex;
                                align-items: center;
                                gap: 8px;
                                font: 500 13px/1.2 var(--cw-sans);
                                color: var(--cw-text);
                            "
                            >{{ row.token.symbol }}
                            <!--
                              A symbol is attacker-controlled, so a contract
                              that arrived by hand rather than through the
                              chain's index says so wherever it appears.
                            -->
                            <span v-if="row.token.manual" class="cw-badge">{{
                                t('tokenByHand')
                            }}</span></span
                        >
                        <span
                            style="
                                display: block;
                                overflow: hidden;
                                margin-top: 2px;
                                font: 400 10px/1.4 var(--cw-mono);
                                color: var(--cw-dim);
                                text-overflow: ellipsis;
                                white-space: nowrap;
                            "
                            >{{ row.token.name || row.token.address }}</span
                        >
                    </span>
                    <span style="text-align: right">
                        <span class="cw-num" style="display: block">{{
                            row.amount
                        }}</span>
                        <span
                            style="
                                display: block;
                                margin-top: 2px;
                                font: 400 11px/1.4 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                            >{{
                                row.usd === null
                                    ? t('unpriced')
                                    : formatUsd(row.usd, locale)
                            }}</span
                        >
                    </span>
                </button>
                <div
                    style="
                        display: flex;
                        gap: 8px;
                        margin-top: 11px;
                        padding-top: 10px;
                        border-top: 1px solid var(--cw-line);
                    "
                >
                    <button
                        type="button"
                        class="cw-ghost"
                        style="min-height: 36px"
                        :disabled="!chain.send || row.token.balance === 0n"
                        @click="emit('send', row.token)"
                    >
                        {{ t('send') }}
                    </button>
                    <span class="cw-fill"></span>
                    <button
                        v-if="row.token.manual"
                        type="button"
                        class="cw-back"
                        style="color: var(--cw-dim)"
                        @click="wallet.removeToken(chain.id, row.token.address)"
                    >
                        {{ t('hideToken') }}
                    </button>
                </div>
            </div>

            <!--
              "No tokens here" is a claim about a balance, and it is only ours
              to make when the index answered. Printed under a read that failed
              — which is exactly where it appeared, directly below "Tokens
              could not be listed" — it is the one sentence on this screen that
              nobody has any basis for.
            -->
            <p
                v-if="
                    rows.length === 0 &&
                    !state?.loading &&
                    !state?.error &&
                    !chain.tokensNote
                "
                class="cw-prose"
                style="padding: 4px 0 8px"
            >
                {{ t('tokensEmpty') }}
            </p>

            <!-- Adding a token is reading a contract, not trusting a list. -->
            <form
                style="display: flex; gap: 8px; margin-top: 4px"
                @submit.prevent="add"
            >
                <input
                    v-model="contract"
                    type="text"
                    class="cw-input"
                    autocomplete="off"
                    spellcheck="false"
                    :aria-label="t('addToken')"
                    :aria-invalid="problem !== null"
                    :placeholder="t('tokenContract')"
                />
                <button
                    type="submit"
                    class="cw-ghost"
                    style="height: 48px; flex: none"
                    :disabled="adding || contract.trim().length === 0"
                >
                    {{ adding ? t('loading') : t('addToken') }}
                </button>
            </form>

            <p
                v-if="problem"
                class="cw-note cw-note-bad"
                style="margin-top: 8px"
            >
                <span>{{ problem }}</span>
            </p>
        </div>
    </div>
</template>
