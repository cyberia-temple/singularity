<script setup lang="ts">
import {
    CandlestickChart,
    Coins,
    CreditCard,
    LineChart,
    MoreHorizontal,
    Percent,
    Rocket,
    Route,
} from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import TxList from '@/components/wallet/TxList.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { arenaMessages } from '@/lib/arenaMessages';
import { canOpenProxySettings, openProxySettings } from '@/lib/native';
import { WALLET_FAMILY_GROUPS, formatUnits } from '@/lib/wallet';
import type { WalletChainId, WalletTxStatus } from '@/lib/wallet';
import { formatUsd, usdValue } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The home screen: one total, every network, recent movement.
 *
 * Networks are grouped by what the account behind them actually is. All the EVM
 * chains share one address, so they belong together; Solana and Monero each
 * have their own key; the Bitcoin family has one key per coin type. The
 * grouping is the answer to "why do these two show the same string".
 *
 * Every failure a portfolio can have is a designed state here rather than a
 * toast — an unreachable node, a coin with no price, an empty vault. A number
 * that could not be read is never rendered as zero, because zero is a claim
 * about the balance and "—" is a claim about the connection.
 */

const props = defineProps<{
    wallet: MultiWallet;
    prices: Record<string, number | null>;
    /** Chain id → (lowercased contract → USD price). */
    tokenPrices: Record<string, Record<string, number>>;
    online: boolean;
}>();

const emit = defineEmits<{
    open: [chain: WalletChainId];
    send: [];
    receive: [];
    swap: [];
    crosschain: [];
    addNetwork: [];
    buy: [];
    tokens: [];
    markets: [];
    stocks: [];
    bridge: [];
    earn: [];
    browse: [];
    arena: [];
    daily: [];
    preferences: [];
    launchpad: [];
    /** Everything that is not one of the eight, one level down. */
    more: [];
    accounts: [];
    security: [];
}>();

const { locale, t } = useLocale(walletMessages);
const { t: arenaT } = useLocale(arenaMessages);

const activeRecord = computed(() => props.wallet.activeAccount.value);

/**
 * What this account is not covered by, said on the screen that spends from it
 * rather than only on the list it was created in.
 */
const activeAccountWarning = computed(() => {
    const kind = activeRecord.value?.kind;

    return kind === 'watch'
        ? t('accountWatchOnly')
        : kind === 'key'
          ? t('accountNotInBackup')
          : kind === 'phrase'
            ? t('accountOwnPhrase')
            : null;
});

const statusLabels = computed<Record<WalletTxStatus, string>>(() => ({
    confirmed: t('statusConfirmed'),
    pending: t('statusPending'),
    failed: t('statusFailed'),
}));

const cards = computed(() =>
    props.wallet.accounts.value.map((account) => {
        const balance = props.wallet.balances.value[account.chain];
        const price = props.prices[account.chain] ?? null;
        const held = (
            props.wallet.tokens.value[account.chain]?.items ?? []
        ).filter((token) => token.balance > 0n);
        const quotes = props.tokenPrices[account.chain] ?? {};

        // Tokens are summed into the network they live on rather than listed
        // beside it: they share this account and this address, and a portfolio
        // that split them into rows of their own would claim more networks than
        // the seed actually derives.
        const priced = held.filter(
            (token) => quotes[token.address.toLowerCase()] !== undefined,
        );

        return {
            account,
            loading: balance?.loading ?? false,
            error: balance?.error ?? null,
            readable: account.capabilities.balance,
            amount:
                balance?.value === undefined || balance?.value === null
                    ? null
                    : formatUnits(balance.value, account.decimals, 4),
            usd: usdValue(balance?.value ?? null, account.decimals, price),
            tokenCount: held.length,
            unpricedTokens: held.length - priced.length,
            tokenUsd: priced.reduce(
                (sum, token) =>
                    sum +
                    (usdValue(
                        token.balance,
                        token.decimals,
                        quotes[token.address.toLowerCase()],
                    ) ?? 0),
                0,
            ),
        };
    }),
);

/**
 * Cards in family order: the EVM chains that share one address, then the ones
 * with a key of their own.
 *
 * The order is the grouping now. Each group used to open with its name —
 * "EVM-СЕТИ", "СЕМЕЙСТВО BITCOIN" — which answered "why do these two show the
 * same string" on every visit, forever, and above a single card answered
 * nothing at all. Where that question is actually asked, on the receive screen
 * and on a network's own, it is still answered.
 */
const groupedCards = computed(() =>
    WALLET_FAMILY_GROUPS.flatMap((group) =>
        cards.value.filter((card) =>
            group.families.includes(card.account.family),
        ),
    ),
);

/**
 * Failures the user has put away. Dismissal is per network and lasts only
 * until that network reads again: a node that recovers and then fails later
 * has something new to say, and a notice silenced for the whole session would
 * leave a stale balance looking live.
 */
const dismissed = ref(new Set<WalletChainId>());

watch(cards, (list) => {
    for (const card of list) {
        if (card.error === null) {
            dismissed.value.delete(card.account.chain);
        }
    }
});

/** Networks whose balance could not be read at all, minus the ones put away. */
const unreachable = computed(() =>
    cards.value.filter(
        (card) =>
            card.readable &&
            card.error !== null &&
            !dismissed.value.has(card.account.chain),
    ),
);

/**
 * The way out of a network that blocks Cyberia, offered where the block is
 * felt: nothing read, or a node that will not answer.
 *
 * Only the desktop app can act on it — it owns its own connection — so the
 * offer appears only where it is true, and only once something has actually
 * failed. It is worded as a question because an unreachable node is as often
 * an RPC having a bad minute as it is censorship.
 */
const proxyOffer = computed(
    () =>
        canOpenProxySettings() &&
        (!props.online || unreachable.value.length > 0),
);

/**
 * The thing about this wallet that cannot be undone by anybody, including us —
 * one of them, and never a list.
 *
 * Both facts used to be printed together under a heading: a title, a
 * two-sentence paragraph and a button, five lines above the balance saying
 * that a phrase was never written down *and* that there is no password. Two
 * problems stated at once is a paragraph to read; one problem with one action
 * is something to do. The phrase comes first because it is the one that loses
 * the money rather than merely exposing it, and the password's turn comes when
 * the phrase is safe. The full wording stays in Security, which this row is a
 * door to.
 */
const safety = computed(() => {
    if (!props.wallet.backedUp.value) {
        return t('safetyBackup');
    }

    return props.wallet.protection.value === 'none'
        ? t('safetyPassword')
        : null;
});

/**
 * Nothing priced at all, on a wallet that did read some balances.
 *
 * That is one fact about a connection and not eight facts about eight
 * networks — and "{count} of {total} networks unpriced" says the second when
 * the first is what happened, on the screen that is also stamping "no price"
 * down the whole list.
 */
const pricesOffline = computed(
    () =>
        cards.value.length > 0 &&
        cards.value.every((card) => card.usd === null),
);

/** Networks holding value the total cannot include — no price, or no read. */
const unaccounted = computed(
    () =>
        cards.value.filter(
            (card) => card.usd === null || card.unpricedTokens > 0,
        ).length,
);

const total = computed(() =>
    cards.value.reduce((sum, card) => sum + (card.usd ?? 0) + card.tokenUsd, 0),
);

const isEmpty = computed(() =>
    cards.value.every(
        (card) =>
            !card.readable ||
            (card.error === null && !card.loading && card.amount === '0'),
    ),
);

/**
 * An account with nowhere to be: an imported key or watched address whose
 * network has since been removed from this wallet. It is a different thing from
 * an empty vault, and saying "no activity yet" about it would be wrong.
 */
const orphaned = computed(
    () =>
        cards.value.length === 0 &&
        activeRecord.value !== null &&
        activeRecord.value.kind !== 'seed' &&
        activeRecord.value.kind !== 'phrase',
);

/** Recent movement across every chain that can report it, newest first. */
const recent = computed(() =>
    Object.entries(props.wallet.history.value)
        .flatMap(([chain, entry]) =>
            entry.items.map((tx) => ({ chain: chain as WalletChainId, tx })),
        )
        .sort((a, b) => (b.tx.timestamp ?? 0) - (a.tx.timestamp ?? 0))
        .slice(0, 4),
);
</script>

<template>
    <div class="cw-stack">
        <!--
          What this account is *not* covered by. The bar above already names
          the account and switches it, so what is left here is the one thing
          that bar cannot say in a chip: an imported key or a watched address
          is outside the backup the user wrote down.
        -->
        <p
            v-if="activeAccountWarning"
            class="cw-label"
            style="margin-bottom: 18px; color: var(--cw-pending)"
        >
            {{ activeAccountWarning }}
        </p>

        <!--
          The one thing on this screen that cannot be undone by anybody,
          including us. It sits above the balance because the balance is what
          it is about, and the whole row is the way to fix it: a sentence with
          a separate link under it is two things to read where there is one
          thing to do.
        -->
        <button
            v-if="safety"
            type="button"
            class="cw-note cw-note-warn"
            style="
                width: 100%;
                margin-bottom: 18px;
                align-items: center;
                cursor: pointer;
                text-align: left;
            "
            @click="emit('security')"
        >
            <span style="flex: 1; min-width: 0">{{ safety }}</span>
            <span style="flex: none">→</span>
        </button>

        <p v-if="!online" class="cw-note" style="margin-bottom: 18px">
            <span>
                <strong style="display: block; color: var(--cw-text)">{{
                    t('offlineTitle')
                }}</strong>
                {{ t('offlineBody') }}
            </span>
        </p>

        <p
            v-for="card in unreachable"
            :key="card.account.chain"
            class="cw-note cw-note-bad"
            style="margin-bottom: 18px"
        >
            <span style="flex: 1">
                <strong style="display: block">{{
                    t('rpcErrorTitle', { chain: card.account.label })
                }}</strong>
                <span
                    style="
                        font: 400 11px/1.5 var(--cw-mono);
                        color: var(--cw-muted);
                    "
                    >{{ t('rpcErrorBody') }}</span
                >
            </span>
            <button
                type="button"
                class="cw-back"
                style="color: var(--cw-bad-soft)"
                @click="wallet.refreshBalances()"
            >
                {{ t('retry') }}
            </button>
            <button
                type="button"
                class="cw-note-close"
                :title="t('rpcErrorDismiss')"
                :aria-label="t('rpcErrorDismiss')"
                @click="dismissed.add(card.account.chain)"
            >
                ×
            </button>
        </p>

        <p v-if="proxyOffer" class="cw-note" style="margin-bottom: 18px">
            <span style="flex: 1">
                <strong style="display: block; color: var(--cw-text)">{{
                    t('proxyOfferTitle')
                }}</strong>
                {{ t('proxyOfferBody') }}
            </span>
            <button type="button" class="cw-back" @click="openProxySettings()">
                {{ t('proxySettings') }}
            </button>
        </p>

        <!--
          The number, with nothing over it. "ПОРТФЕЛЬ ЦЕЛИКОМ" named what the
          biggest figure on the wallet's first screen obviously is, and the
          line under it printed where prices come from — on every visit, to
          everyone, whether or not anything was wrong. What is left below is
          only the exception: a total that is missing a price it needed.
        -->
        <div style="display: flex; align-items: baseline; gap: 10px">
            <span
                class="cw-total"
                :style="
                    unaccounted > 0 ? { color: 'var(--cw-muted)' } : undefined
                "
                >{{ formatUsd(total, locale) }}</span
            >
        </div>
        <div
            style="
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                align-items: center;
                margin-top: 10px;
            "
        >
            <span
                v-if="unaccounted > 0"
                style="
                    font: 400 11px/1 var(--cw-mono);
                    color: var(--cw-pending);
                "
                >{{ t('pricePartial') }}</span
            >
            <span
                v-if="pricesOffline || unaccounted > 0"
                class="cw-label"
                style="color: var(--cw-faint)"
                >{{
                    pricesOffline
                        ? t('priceOffline')
                        : t('priceMissing', {
                              count: unaccounted,
                              total: cards.length,
                          })
                }}</span
            >
        </div>

        <!--
          A new wallet has nothing in it, said next to the zero it explains
          rather than in a bordered box of its own with a heading, two
          sentences and a button repeating Получить from the row below.
        -->
        <p
            v-if="isEmpty && !orphaned"
            class="cw-prose"
            style="margin: 12px 0 0"
        >
            {{ t('emptyShort') }}
        </p>

        <!--
          Three things you do with a balance rather than three ways of reading
          one: move it out, take it in, or trade it for something else on the
          network's own exchange.
        -->
        <div style="display: flex; gap: 8px; margin: 22px 0 24px">
            <button
                type="button"
                class="cw-btn cw-btn-primary"
                style="height: 48px"
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
            <button
                type="button"
                class="cw-btn cw-btn-secondary"
                style="height: 48px"
                @click="emit('swap')"
            >
                {{ t('swapTitle') }}
            </button>
        </div>

        <div
            v-if="orphaned"
            style="
                margin-top: 28px;
                padding: 28px 20px;
                border: 1px dashed var(--cw-border-soft);
                text-align: center;
            "
        >
            <div class="cw-label" style="margin-bottom: 10px">
                {{ t('orphanTitle') }}
            </div>
            <p class="cw-prose" style="max-width: 40ch; margin: 0 auto 18px">
                {{ t('orphanBody') }}
            </p>
            <button type="button" class="cw-ghost" @click="emit('accounts')">
                {{ t('accounts') }}
            </button>
        </div>

        <!--
          The holdings, with no heading over them: a list of networks carrying
          amounts, directly under a total, is not something a label called
          "СЕТИ" makes clearer, and "ВЫВЕДЕНО: 1" counted a thing nobody asked
          about.
        -->
        <div
            v-else-if="isEmpty"
            style="
                margin: 4px 0 26px;
                padding: 28px 20px;
                border: 1px dashed var(--cw-border-soft);
                text-align: center;
            "
        >
            <div class="cw-label" style="margin-bottom: 10px">
                {{ t('emptyTitle') }}
            </div>
            <p class="cw-prose" style="max-width: 34ch; margin: 0 auto 18px">
                {{ t('emptyBody') }}
            </p>
            <button type="button" class="cw-ghost" @click="emit('receive')">
                {{ t('showAddress') }}
            </button>
        </div>

        <button
            type="button"
            class="cw-card cw-card-button"
            style="margin: 10px 0; padding: 14px 16px"
            @click="emit('arena')"
        >
            <span class="cw-row"
                ><span>{{ arenaT('tile') }}</span
                ><span class="cw-label">{{ arenaT('tileHint') }}</span></span
            >
        </button>

        <div class="cw-row" style="margin-bottom: 10px">
            <span class="cw-label">{{ t('networks') }}</span>
            <span class="cw-label" style="color: var(--cw-faint)">{{
                t('derivedCount', { count: cards.length })
            }}</span>
        </div>
        <div class="cw-stack" style="gap: 8px">
            <template v-for="card in groupedCards" :key="card.account.chain">
                <button
                    type="button"
                    class="cw-card cw-card-button"
                    :class="{ 'cw-card-custom': card.account.custom }"
                    @click="emit('open', card.account.chain)"
                >
                    <div style="display: flex; align-items: center; gap: 12px">
                        <NetworkMark :chain="card.account.chain" />
                        <span style="flex: 1; min-width: 0; text-align: left">
                            <span
                                style="
                                    display: block;
                                    font: 500 14px/1.2 var(--cw-sans);
                                    color: var(--cw-text);
                                "
                                >{{ card.account.label }}</span
                            >
                            <span
                                style="
                                    display: block;
                                    margin-top: 3px;
                                    font: 400 11px/1.4 var(--cw-mono);
                                    color: var(--cw-dim);
                                "
                                >{{ card.account.symbol
                                }}<template v-if="card.tokenCount > 0">
                                    ·
                                    {{
                                        t('tokenCount', {
                                            count: card.tokenCount,
                                        })
                                    }}</template
                                ></span
                            >
                        </span>
                        <span style="text-align: right">
                            <span
                                class="cw-num"
                                style="display: block"
                                :style="{
                                    color:
                                        card.amount === null
                                            ? 'var(--cw-dim)'
                                            : 'var(--cw-text)',
                                }"
                            >
                                {{ card.loading ? '…' : (card.amount ?? '—') }}
                            </span>
                            <span
                                style="
                                    display: block;
                                    margin-top: 2px;
                                    font: 400 11px/1.4 var(--cw-mono);
                                    color: var(--cw-dim);
                                "
                            >
                                {{
                                    card.readable
                                        ? card.usd === null
                                            ? t('unpriced')
                                            : formatUsd(card.usd, locale)
                                        : t('noBalanceHere')
                                }}
                            </span>
                        </span>
                    </div>
                    <!--
                      A network the user added carries its own provenance line:
                      the account is as real as any other, the endpoint it is
                      read through is the part nobody checked.
                    -->
                    <div
                        v-if="card.account.custom"
                        style="
                            margin-top: 11px;
                            padding-top: 10px;
                            border-top: 1px solid var(--cw-line);
                            font: 400 11px/1.2 var(--cw-mono);
                            letter-spacing: 0.08em;
                            color: var(--cw-meta);
                            text-transform: uppercase;
                        "
                    >
                        {{ t('addedByYou') }} · {{ t('endpointUnverified') }}
                    </div>
                </button>
            </template>

            <button
                type="button"
                class="cw-dashed"
                style="margin-top: 4px"
                @click="emit('addNetwork')"
            >
                <span
                    style="
                        font: 400 15px/1 var(--cw-mono);
                        color: var(--cw-muted);
                    "
                    >+</span
                >
                <span style="flex: 1; font: 400 13px/1.2 var(--cw-sans)">{{
                    t('addNetwork')
                }}</span>
            </button>
        </div>

        <div
            v-if="!orphaned && !isEmpty && recent.length > 0"
            style="margin-top: 26px"
        >
            <div class="cw-label" style="margin-bottom: 10px">
                {{ t('recent') }}
            </div>
            <TxList
                :entries="recent"
                :locale="locale"
                :status-labels="statusLabels"
                :sent-to="t('sentTo')"
                :received-from="t('receivedFrom')"
            />
        </div>

        <!--
          Everything here is a way *out* of the portfolio, and none of it is a
          holding — so it goes under the holdings. Eight names in a grid, and
          nothing else: what stood here was eleven destinations, every one of
          them a card or a tile with a caption explaining what it was for
          ("Графики · биржевые стаканы и наши пулы", "Серия · задания · чем
          оплачивается день", "0.98 CYBER · хватит примерно на 98 адресов"),
          which is four hundred pixels of prose on the screen somebody opens to
          look at their money. A destination needs a name; what it is for is
          answered by opening it.

          Seven of these are the ones people actually go to; the eighth is the
          door to the rest, which are one level down rather than gone.
        -->
        <div class="cw-quick">
            <!--
              First, because it is the only one of these that answers "I have
              no coins at all" — every other tile assumes a balance exists.
            -->
            <button type="button" class="cw-quick-item" @click="emit('buy')">
                <CreditCard :size="21" :stroke-width="1.5" aria-hidden="true" />
                <span>{{ t('tileBuy') }}</span>
            </button>
            <button type="button" class="cw-quick-item" @click="emit('tokens')">
                <Coins :size="21" :stroke-width="1.5" aria-hidden="true" />
                <span>{{ t('tokens') }}</span>
            </button>
            <button
                type="button"
                class="cw-quick-item"
                @click="emit('markets')"
            >
                <LineChart :size="21" :stroke-width="1.5" aria-hidden="true" />
                <span>{{ t('markets') }}</span>
            </button>
            <button type="button" class="cw-quick-item" @click="emit('stocks')">
                <CandlestickChart
                    :size="21"
                    :stroke-width="1.5"
                    aria-hidden="true"
                />
                <span>{{ t('stocks') }}</span>
            </button>
            <button type="button" class="cw-quick-item" @click="emit('bridge')">
                <Route :size="21" :stroke-width="1.5" aria-hidden="true" />
                <span>{{ t('bridgeTitle') }}</span>
            </button>
            <button type="button" class="cw-quick-item" @click="emit('earn')">
                <Percent :size="21" :stroke-width="1.5" aria-hidden="true" />
                <span>{{ t('earnTitle') }}</span>
            </button>
            <button
                type="button"
                class="cw-quick-item"
                @click="emit('launchpad')"
            >
                <Rocket :size="21" :stroke-width="1.5" aria-hidden="true" />
                <span>{{ t('tabLaunch') }}</span>
            </button>
            <button type="button" class="cw-quick-item" @click="emit('more')">
                <MoreHorizontal
                    :size="21"
                    :stroke-width="1.5"
                    aria-hidden="true"
                />
                <span>{{ t('navMore') }}</span>
            </button>
        </div>
    </div>
</template>
