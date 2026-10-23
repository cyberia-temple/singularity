<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import StockIcon from '@/components/wallet/StockIcon.vue';
import TxList from '@/components/wallet/TxList.vue';
import WalletPlaces from '@/components/wallet/WalletPlaces.vue';
import type { WalletPlace } from '@/components/wallet/WalletPlaces.vue';
import WalletSync from '@/components/wallet/WalletSync.vue';
import WalletTelegramLink from '@/components/wallet/WalletTelegramLink.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useWalletMode } from '@/composables/useWalletMode';
import { canOpenProxySettings, openProxySettings } from '@/lib/native';
import { WALLET_FAMILY_GROUPS, formatUnits } from '@/lib/wallet';
import type {
    WalletChainId,
    WalletTokenBalance,
    WalletTxStatus,
} from '@/lib/wallet';
import { formatUsd, usdValue } from '@/lib/wallet/format';
import { holdings } from '@/lib/wallet/holdings';
import type { Holding } from '@/lib/wallet/holdings';
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
    /** A profile is signed in — sync can read and store its copy. */
    authenticated?: boolean;
    /** The wallet that profile signed in with, if any. */
    profileAddress?: string | null;
}>();

const emit = defineEmits<{
    open: [chain: WalletChainId];
    /** A token row on the simple home. */
    token: [chain: WalletChainId, token: WalletTokenBalance];
    send: [];
    receive: [];
    swap: [];
    /** A place from the grid under the balance (full mode only). */
    place: [place: WalletPlace];
    accounts: [];
    security: [];
    /** Sync put the profile's wallet on this device. */
    restored: [];
}>();

const { locale, t } = useLocale(walletMessages);

const { simple } = useWalletMode();

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
    failed: t('statusFailedFee'),
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

        const raw = balance?.value ?? null;
        const shown =
            raw === null ? null : formatUnits(raw, account.decimals, 4);

        return {
            account,
            loading: balance?.loading ?? false,
            error: balance?.error ?? null,
            readable: account.capabilities.balance,
            raw,
            priced: price !== null,
            // A balance too small for four decimals is still not zero: one wei
            // read "0" beside "Nothing here yet", which is two wrong answers.
            amount:
                raw !== null && raw > 0n && shown === '0' ? '<0.0001' : shown,
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
    // Simple mode asks once there is something to lose, and asks kindly: a
    // newcomer first gets a wallet that works, then the reason to keep it safe.
    if (simple.value && isEmpty.value) {
        return null;
    }

    if (!props.wallet.backedUp.value) {
        return t(simple.value ? 'safetyBackupSoft' : 'safetyBackup');
    }

    if (props.wallet.protection.value !== 'none') {
        return null;
    }

    return t(simple.value ? 'safetyPasswordSoft' : 'safetyPassword');
});

/**
 * Nothing priced at all, on a wallet that did read some balances.
 *
 * That is one fact about a connection and not eight facts about eight
 * networks — and "{count} of {total} networks unpriced" says the second when
 * the first is what happened, on the screen that is also stamping "no price"
 * down the whole list.
 */
const pricesOffline = computed(() => {
    // Only cards whose balance was read can say anything about prices: a node
    // that didn't answer used to be reported as "no prices could be read".
    const known = cards.value.filter((card) => card.raw !== null);

    return known.length > 0 && known.every((card) => !card.priced);
});

/** Readable networks whose balance couldn't be read — not zero, unknown. */
const unread = computed(
    () =>
        cards.value.filter(
            (card) => card.readable && card.raw === null && !card.loading,
        ).length,
);

/** Networks whose coin has a balance but no price. */
const unpricedNetworks = computed(
    () =>
        cards.value.filter((card) => card.raw !== null && !card.priced).length,
);

/** Tokens held without a price, across every network. */
const unpricedTokens = computed(() =>
    cards.value.reduce((sum, card) => sum + card.unpricedTokens, 0),
);

/** Anything the total cannot include. */
const unaccounted = computed(
    () => unread.value + unpricedNetworks.value + unpricedTokens.value,
);

/** Nothing could be read at all: there is no total to show, not a zero one. */
const totalUnknown = computed(
    () =>
        cards.value.some((card) => card.readable) &&
        cards.value.every(
            (card) => !card.readable || (card.raw === null && !card.loading),
        ),
);

/** The one sentence under the total that names what is missing from it. */
const caveat = computed(() => {
    if (unread.value > 0) {
        return t('balanceMissing', {
            count: unread.value,
            total: cards.value.length,
        });
    }

    if (pricesOffline.value) {
        return t('priceOffline');
    }

    if (unpricedNetworks.value > 0) {
        return t('priceMissing', {
            count: unpricedNetworks.value,
            total: cards.value.length,
        });
    }

    return unpricedTokens.value > 0
        ? t('tokensUnpriced', { count: unpricedTokens.value })
        : null;
});

/**
 * Simple mode doesn't flag a total for tokens nobody prices — those are almost
 * always airdropped dust. A network that couldn't be read or priced is still
 * said, because then the number really is missing something.
 */
const partial = computed(() =>
    simple.value
        ? unread.value + unpricedNetworks.value > 0 || pricesOffline.value
        : unaccounted.value > 0,
);

const shownCaveat = computed(() => (partial.value ? caveat.value : null));

/**
 * The simple home lists what you hold, one asset a row (`holdings`); unpriced
 * strangers stay on the Tokens screen, counted in a link below the list.
 */
const held = computed(() =>
    holdings({
        accounts: props.wallet.accounts.value,
        balances: Object.fromEntries(
            props.wallet.accounts.value.map((account) => [
                account.chain,
                props.wallet.balances.value[account.chain]?.value ?? null,
            ]),
        ),
        tokens: Object.fromEntries(
            Object.entries(props.wallet.tokens.value).map(([chain, state]) => [
                chain,
                state?.items ?? [],
            ]),
        ),
        prices: props.prices,
        tokenPrices: props.tokenPrices,
    }),
);

const assets = computed(() => held.value.rows);

const hiddenTokens = computed(() => held.value.hidden);

const TAG_LABEL = {
    bridged: 'provBridged',
    wrapped: 'provWrapped',
    unverified: 'provUnverified',
} as const;

const openAsset = (row: Holding): void => {
    if (row.token) {
        emit('token', row.chain, row.token);
    } else {
        emit('open', row.chain);
    }
};

const total = computed(() =>
    cards.value.reduce((sum, card) => sum + (card.usd ?? 0) + card.tokenUsd, 0),
);

const isEmpty = computed(() =>
    cards.value.every(
        (card) =>
            !card.readable ||
            (card.error === null &&
                !card.loading &&
                card.raw === 0n &&
                card.tokenCount === 0),
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
            class="cw-note"
            :class="{ 'cw-note-warn': !simple }"
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
                        font: 500 13px/1.5 var(--cw-mono);
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
                :style="partial ? { color: 'var(--cw-muted)' } : undefined"
                >{{ totalUnknown ? '—' : formatUsd(total, locale) }}</span
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
                v-if="partial && !simple"
                style="
                    font: 500 13px/1 var(--cw-mono);
                    color: var(--cw-pending);
                "
                >{{ t('pricePartial') }}</span
            >
            <span v-if="shownCaveat" class="cw-hint">{{ shownCaveat }}</span>
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
                class="cw-btn cw-btn-secondary"
                style="height: 48px"
                @click="emit('send')"
            >
                {{ t('send') }}
            </button>
            <button
                type="button"
                class="cw-btn cw-btn-secondary"
                style="height: 48px"
                @click="emit('swap')"
            >
                {{ t('swapTitle') }}
            </button>
            <button
                type="button"
                class="cw-btn cw-btn-primary"
                style="height: 48px"
                @click="emit('receive')"
            >
                {{ t('receive') }}
            </button>
        </div>

        <WalletSync
            v-if="!orphaned"
            :wallet="wallet"
            :authenticated="authenticated ?? false"
            :funded="!isEmpty"
            :profile-address="profileAddress"
            variant="card"
            @security="emit('security')"
            @restored="emit('restored')"
        />

        <WalletTelegramLink v-if="!orphaned" :wallet="wallet" variant="card" />

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
            v-if="simple && assets.length > 0"
            class="cw-stack"
            style="gap: 4px"
        >
            <button
                v-for="row in assets"
                :key="row.key"
                type="button"
                class="cw-asset"
                @click="openAsset(row)"
            >
                <StockIcon
                    v-if="row.logo"
                    :symbol="row.symbol"
                    :src="row.logo"
                    :size="40"
                />
                <NetworkMark v-else :chain="row.chain" />
                <span style="flex: 1; min-width: 0; text-align: left">
                    <span class="cw-asset-name">{{ row.name }}</span>
                    <span class="cw-asset-sub"
                        >{{ row.amount }} {{ row.symbol }}
                        <span v-if="row.tag" class="cw-prov">{{
                            t(TAG_LABEL[row.tag])
                        }}</span></span
                    >
                </span>
                <span class="cw-asset-usd">{{
                    row.usd === null ? '—' : formatUsd(row.usd, locale)
                }}</span>
            </button>
            <button
                v-if="hiddenTokens > 0"
                type="button"
                class="cw-back"
                style="align-self: flex-start; margin-top: 4px"
                @click="emit('place', 'tokens')"
            >
                {{ t('assetsHidden', { count: hiddenTokens }) }} →
            </button>
        </div>

        <div v-else class="cw-stack" style="gap: 8px">
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
                                    font: 500 16px/1.2 var(--cw-sans);
                                    color: var(--cw-text);
                                "
                                >{{ card.account.label }}</span
                            >
                            <span
                                style="
                                    display: block;
                                    margin-top: 3px;
                                    font: 500 13px/1.4 var(--cw-mono);
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
                                    font: 500 13px/1.4 var(--cw-mono);
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
                            font: 500 13px/1.2 var(--cw-mono);
                            letter-spacing: 0.08em;
                            color: var(--cw-meta);
                            text-transform: uppercase;
                        "
                    >
                        {{ t('addedByYou') }} · {{ t('endpointUnverified') }}
                    </div>
                </button>
            </template>
        </div>

        <!--
          Everything here is a way *out* of the portfolio, and none of it is a
          holding — so it goes under the holdings. Names in a grid and nothing
          else: a destination needs a name; what it is for is answered by
          opening it.

          Five across and three down — fourteen places plus the door to the
          rest. What is behind "More" is what does not work yet or is reached
          less often (buying with a card, the gas station, torrents), one level
          down rather than gone.
        -->
        <WalletPlaces
            v-if="!simple"
            :places="[
                'tokens',
                'markets',
                'stocks',
                'bridge',
                'crosschain',
                'earn',
                'liquidity',
                'launchpad',
                'browse',
                'domains',
                'daily',
                'invite',
                'analytics',
                'tracker',
                'ipfs',
                'more',
            ]"
            @place="emit('place', $event)"
        />
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
    </div>
</template>
