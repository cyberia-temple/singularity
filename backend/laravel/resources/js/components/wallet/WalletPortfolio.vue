<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import StatusPill from '@/components/wallet/StatusPill.vue';
import TxList from '@/components/wallet/TxList.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { canOpenProxySettings, openProxySettings } from '@/lib/native';
import { WALLET_FAMILY_GROUPS, formatUnits, walletChain } from '@/lib/wallet';
import type { WalletChainId, WalletTxStatus } from '@/lib/wallet';
import { formatUsd, usdValue } from '@/lib/wallet/format';
import {
    SPONSORED_CHAIN,
    dripsLeft,
    gasSponsorStatus,
    stationState,
} from '@/lib/wallet/gas';
import type { SponsorStatus } from '@/lib/wallet/gas';
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
    tokens: [];
    markets: [];
    analytics: [];
    accounts: [];
    security: [];
    gas: [];
    bridge: [];
    earn: [];
    browse: [];
    daily: [];
    preferences: [];
}>();

const { locale, t } = useLocale(walletMessages);

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

const GROUP_LABELS: Record<string, string> = {
    evm: 'groupEvm',
    other: 'groupOther',
    utxo: 'groupUtxo',
};

/**
 * Cards in family order, each carrying the heading its group opens with. A
 * heading is on the first card of a group rather than in a wrapper element so
 * the whole list stays one flat, evenly spaced column.
 */
const groupedCards = computed(() =>
    WALLET_FAMILY_GROUPS.flatMap((group) =>
        cards.value
            .filter((card) => group.families.includes(card.account.family))
            .map((card, index) => ({
                ...card,
                heading: index === 0 ? t(GROUP_LABELS[group.id]) : null,
            })),
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
 * The gas station, as a state rather than as an offer.
 *
 * Asked without an address on purpose. Eligibility costs the server an
 * eth_call and an index lookup for whichever address is named, and this card
 * is not about one address — it says whether the station is serving at all,
 * which is the same answer for every reader and is cached as such. Whether
 * *this* account may be sponsored is asked on the station's own screen, and at
 * the moment of a transaction, which are the two places it is the question.
 */
const station = ref<SponsorStatus | null>(null);

onMounted(async () => {
    station.value = await gasSponsorStatus();
});

const stationTone = {
    live: 'confirmed',
    paused: 'pending',
    empty: 'failed',
    off: 'failed',
    unreadable: 'pending',
} as const;

const stationStatus = computed(() => stationState(station.value));

const stationDrips = computed(() => dripsLeft(station.value));

/** How much coin the station is still holding, in CYBER. */
const stationTank = computed(() => {
    const tank = station.value?.tank;

    return tank
        ? formatUnits(BigInt(tank), walletChain(SPONSORED_CHAIN).decimals, 2)
        : null;
});

/**
 * The two states this wallet cannot come back from, on the screen everybody
 * actually opens.
 *
 * Both used to live only inside Security — two taps away, behind one tile
 * among eleven — which is where a thing goes when nobody is meant to find it.
 * They are worth more of the first screen than anything else on it: every
 * other failure here is a bad minute on an RPC, and these two are the whole
 * wallet. The wording stays in Security; what is here is the fact and the door.
 */
const safety = computed(() => {
    const lines: string[] = [];

    if (!props.wallet.backedUp.value) {
        lines.push(t('safetyBackup'));
    }

    if (props.wallet.protection.value === 'none') {
        lines.push(t('safetyPassword'));
    }

    return lines;
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
          The only two things on this screen that cannot be undone by anybody,
          including us. They sit above the balance because the balance is what
          they are about.
        -->
        <div
            v-if="safety.length > 0"
            class="cw-note cw-note-warn"
            style="margin-bottom: 18px"
        >
            <span style="flex: 1; min-width: 0">
                <strong style="display: block">{{ t('safetyTitle') }}</strong>
                <span
                    style="
                        display: block;
                        margin-top: 2px;
                        font: 400 12px/1.5 var(--cw-sans);
                        color: var(--cw-body);
                    "
                    >{{ safety.join(' ') }}</span
                >
                <!--
                  Under the sentence rather than beside it: as a flex sibling
                  the button refused to shrink and squeezed the warning into a
                  ninety-pixel column six lines tall, which is the shape of a
                  notice nobody finishes reading.
                -->
                <button
                    type="button"
                    class="cw-back"
                    style="min-height: 36px; margin-top: 4px"
                    @click="emit('security')"
                >
                    {{ t('safetyAction') }} →
                </button>
            </span>
        </div>

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

        <div class="cw-label">{{ t('totalPortfolio') }}</div>
        <div
            style="
                display: flex;
                align-items: baseline;
                gap: 10px;
                margin-top: 10px;
            "
        >
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
            <span class="cw-label" style="color: var(--cw-faint)">{{
                pricesOffline
                    ? t('priceOffline')
                    : unaccounted > 0
                      ? t('priceMissing', {
                            count: unaccounted,
                            total: cards.length,
                        })
                      : t('priceSource')
            }}</span>
        </div>

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
          What a new wallet is actually supposed to do next, above the eight
          zeros rather than below them. It used to be the last block on a
          1720px screen — two screens of scrolling past every empty network to
          reach the one sentence that says how to stop them being empty.
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

        <div class="cw-row" style="margin-bottom: 10px">
            <span class="cw-label">{{ t('networks') }}</span>
            <span class="cw-label" style="color: var(--cw-faint)">{{
                t('derivedCount', { count: cards.length })
            }}</span>
        </div>

        <div class="cw-stack" style="gap: 8px">
            <template v-for="card in groupedCards" :key="card.account.chain">
                <div v-if="card.heading" class="cw-group">
                    <span class="cw-label" style="color: var(--cw-faint)">{{
                        card.heading
                    }}</span>
                </div>
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
                        display: flex;
                        width: 32px;
                        height: 32px;
                        flex: none;
                        align-items: center;
                        justify-content: center;
                        border: 1px dashed var(--cw-border);
                        font: 400 15px/1 var(--cw-mono);
                        color: var(--cw-muted);
                    "
                    >+</span
                >
                <span style="flex: 1">
                    <span
                        style="
                            display: block;
                            font: 500 13px/1.2 var(--cw-sans);
                        "
                        >{{ t('networksTile') }}</span
                    >
                    <span class="cw-hint" style="margin-top: 3px">{{
                        t('networksTileHint')
                    }}</span>
                </span>
                <span
                    style="
                        font: 400 12px/1 var(--cw-mono);
                        color: var(--cw-dim);
                    "
                    >→</span
                >
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
          holding — so it goes under the holdings. Ordered the other way round
          this screen opened with fourteen buttons and eleven tiles, and the
          first balance began at y=730 on a 703px phone: a wallet whose first
          screen contained no money.
        -->
        <div class="cw-label" style="margin: 30px 0 12px">
            {{ t('moreTitle') }}
        </div>

        <!--
          Prices over time, which this screen otherwise never shows: every
          number above is a reading taken now. A full row and not a fourth tile
          because it is the only place in the wallet that answers "what has this
          been doing", and because the two kinds of chart behind it — an
          exchange's book, and this chain's own pools — are worth naming.
        -->
        <button
            type="button"
            class="cw-card cw-card-button"
            style="margin-bottom: 10px; padding: 14px 16px"
            @click="emit('markets')"
        >
            <div class="cw-row">
                <span
                    style="
                        font: 500 12px/1 var(--cw-sans);
                        color: var(--cw-text);
                    "
                    >{{ t('markets') }}</span
                >
                <span class="cw-label" style="color: var(--cw-faint)">→</span>
            </div>
            <div class="cw-hint" style="margin-top: 8px">
                {{ t('tileMarketsHint') }}
            </div>
        </button>

        <!--
          The station, when there is one to speak of. It sits above the
          shortcuts because it is not a way of reading holdings: it is the
          answer to the one state in which holdings cannot be moved at all.
        -->
        <button
            v-if="station?.enabled"
            type="button"
            class="cw-card cw-card-button"
            style="margin-bottom: 10px; padding: 14px 16px"
            @click="emit('gas')"
        >
            <div class="cw-row">
                <span style="display: flex; align-items: center; gap: 10px">
                    <span
                        style="
                            font: 500 12px/1 var(--cw-sans);
                            color: var(--cw-text);
                        "
                        >{{ t('gasStation') }}</span
                    >
                    <StatusPill
                        :status="stationTone[stationStatus]"
                        :label="
                            t(
                                `gasState${stationStatus.charAt(0).toUpperCase()}${stationStatus.slice(1)}`,
                            )
                        "
                        bare
                    />
                </span>
                <span class="cw-label" style="color: var(--cw-faint)">→</span>
            </div>
            <div class="cw-hint" style="margin-top: 8px">
                <template v-if="stationTank !== null"
                    >{{ stationTank }} CYBER<template
                        v-if="stationDrips !== null"
                    >
                        ·
                        {{
                            t('gasDripsLeft', { count: stationDrips })
                        }}</template
                    ></template
                >
                <template v-else>{{ t('tileGasHint') }}</template>
            </div>
        </button>

        <!--
          Shortcuts, not a menu: the same holdings read as tokens, the same
          holdings read as shares, and the keys underneath both.
        -->
        <div class="cw-tiles">
            <button type="button" class="cw-tile" @click="emit('tokens')">
                <span style="font: 500 12px/1 var(--cw-sans)">{{
                    t('tokens')
                }}</span>
                <span class="cw-hint">{{ t('tileTokensHint') }}</span>
            </button>
            <button type="button" class="cw-tile" @click="emit('analytics')">
                <span style="font: 500 12px/1 var(--cw-sans)">{{
                    t('navAnalytics')
                }}</span>
                <span class="cw-hint">{{ t('tileAnalyticsHint') }}</span>
            </button>
            <button type="button" class="cw-tile" @click="emit('security')">
                <span style="font: 500 12px/1 var(--cw-sans)">{{
                    t('navSecurity')
                }}</span>
                <span class="cw-hint">{{ t('tileSecurityHint') }}</span>
            </button>
        </div>

        <!--
          A second row, and the difference from the first is what they are
          about: those three are ways of reading what you hold, these three are
          things done with it — moved to another chain, put to work, or spent
          on something running here.
        -->
        <div class="cw-tiles">
            <button type="button" class="cw-tile" @click="emit('bridge')">
                <span style="font: 500 12px/1 var(--cw-sans)">{{
                    t('bridgeTitle')
                }}</span>
                <span class="cw-hint">{{ t('tileBridgeHint') }}</span>
            </button>
            <button type="button" class="cw-tile" @click="emit('earn')">
                <span style="font: 500 12px/1 var(--cw-sans)">{{
                    t('earnTitle')
                }}</span>
                <span class="cw-hint">{{ t('tileEarnHint') }}</span>
            </button>
            <button type="button" class="cw-tile" @click="emit('browse')">
                <span style="font: 500 12px/1 var(--cw-sans)">{{
                    t('browseTitle')
                }}</span>
                <span class="cw-hint">{{ t('tileBrowseHint') }}</span>
            </button>
        </div>

        <!--
          What this project pays for using it. A row of its own because it is
          the only entry here that is not about a balance at all: it is about
          the person, and it says so on the screen it opens.
        -->
        <button
            type="button"
            class="cw-card cw-card-button"
            style="margin-bottom: 10px; padding: 14px 16px"
            @click="emit('daily')"
        >
            <span class="cw-row">
                <span style="text-align: left">
                    <span
                        style="display: block; font: 500 12px/1 var(--cw-sans)"
                        >{{ t('dailyTitle') }}</span
                    >
                    <span class="cw-hint" style="margin-top: 5px">{{
                        t('tileDailyHint')
                    }}</span>
                </span>
                <span class="cw-label" style="color: var(--cw-faint)">→</span>
            </span>
        </button>

        <!--
          The other kind of swap, and a full row rather than a fourth tile in
          a row of three: it is the only thing on this screen that hands money
          to somebody who is not Cyberia, and the sentence saying so does not
          fit in a tile.
        -->
        <button
            type="button"
            class="cw-card cw-card-button"
            style="margin-bottom: 10px; padding: 14px 16px"
            @click="emit('crosschain')"
        >
            <span class="cw-row">
                <span style="text-align: left">
                    <span
                        style="display: block; font: 500 12px/1 var(--cw-sans)"
                        >{{ t('crossTile') }}</span
                    >
                    <span class="cw-hint" style="margin-top: 5px">{{
                        t('crossTileHint')
                    }}</span>
                </span>
                <span class="cw-label" style="color: var(--cw-faint)">→</span>
            </span>
        </button>

        <button
            type="button"
            class="cw-card cw-card-button"
            style="margin-bottom: 24px; padding: 14px 16px"
            @click="emit('preferences')"
        >
            <span class="cw-row">
                <span style="text-align: left">
                    <span
                        style="display: block; font: 500 12px/1 var(--cw-sans)"
                        >{{ t('navPreferences') }}</span
                    >
                    <span class="cw-hint" style="margin-top: 5px">{{
                        t('tilePreferencesHint')
                    }}</span>
                </span>
                <span class="cw-label" style="color: var(--cw-faint)">→</span>
            </span>
        </button>
    </div>
</template>
