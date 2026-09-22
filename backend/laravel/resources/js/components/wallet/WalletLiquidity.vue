<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { analytics, errorCode } from '@/lib/analytics';
import { KNOWN_TOKENS } from '@/lib/cyberiaTokens';
import { CYBERIA_CHAIN_ID } from '@/lib/evmChains';
import {
    canAddLiquidity,
    formatUnits,
    forgetPairs,
    hasSwap,
    pairedAmount,
    parseUnits,
    poolTxUrl,
    quoteAddLiquidity,
    quoteRemoveLiquidity,
    readLpPositions,
    readPair,
    swapChainFor,
    walletChain,
    withdrawalLp,
    wrappedSide,
} from '@/lib/wallet';
import type {
    AddLiquidityQuote,
    LpPosition,
    PairState,
    RemoveLiquidityQuote,
    SwapAsset,
    WalletChainId,
    WalletTokenBalance,
} from '@/lib/wallet';
import { formatUsd, shortAddress, usdValue } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Making a pool position, and taking one apart.
 *
 * This screen is the step the wallet did not have. It could trade a pool, it
 * could stake the LP token a pool hands out and it could claim what that stake
 * earned — but the one act that *produces* an LP token was a link to the site,
 * so the farm screen was offering to put to work something the wallet gave
 * nobody any way of getting.
 *
 * It is the hardest thing this wallet signs, and the screen is ordered by what
 * makes it hard rather than by what makes it look like the swap:
 *
 *  - **Only one amount is typed.** An existing pool has a price, and that
 *    price fixes the other side exactly. The second box is filled in from the
 *    reserves and says so; typing a different number into it would not buy a
 *    different ratio, it would make the router keep the side that fits and
 *    hand the rest back.
 *  - **A pool that does not exist yet is a different act**, and it is named as
 *    one rather than smoothed over: the deposit invents the price, and it also
 *    deploys the pool contract, which is why its fee is an order of magnitude
 *    larger than an ordinary deposit's.
 *  - **Both sides get a floor**, because the ratio moves between the quote and
 *    the block, and both floors travel into the transaction rather than being
 *    re-derived after the hold.
 *  - **Impermanent loss is stated where the deposit happens**, not in a
 *    footnote under an APR. It is the whole risk of the position and the one
 *    thing no number on this screen nets out.
 *
 * What is in the farm is deliberately not listed here. Staked LP cannot be
 * withdrawn from a pool without coming out of the farm first, and offering it
 * on this screen would be offering to burn something the router cannot reach.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** Which network the wallet is pointed at, when it has an exchange. */
    chain: WalletChainId;
    prices: Record<string, number | null>;
    /** Chain id → (lowercased contract → USD price). */
    tokenPrices: Record<string, Record<string, number>>;
}>();

const emit = defineEmits<{ back: []; earn: [] }>();

const { locale, t } = useLocale(walletMessages);

/**
 * The exchange this screen is about: the wallet's own network when it has one,
 * and Cyberia otherwise. Every pool here settles on a chain the seed already
 * derives, so there is never a network to switch to, only one to point at.
 */
const active = computed<WalletChainId>(() => {
    const meta = walletChain(props.chain);

    return meta.chainId && hasSwap(meta.chainId) ? props.chain : 'cyberia';
});

const chainMeta = computed(() => walletChain(active.value));

const dex = computed(() =>
    chainMeta.value.chainId && hasSwap(chainMeta.value.chainId)
        ? swapChainFor(chainMeta.value.chainId)
        : null,
);

const account = computed(
    () =>
        props.wallet.accounts.value.find(
            (entry) => entry.chain === active.value,
        ) ?? null,
);

type Tab = 'add' | 'mine';

const tab = ref<Tab>('add');
const error = ref<string | null>(null);
const busy = ref(false);
const sent = ref<{ hash: string; url: string } | null>(null);
const gasPrice = ref<bigint | null>(null);
const slippageBps = ref(50);

/* ------------------------------------------------------------- assets --- */

const coin = computed<SwapAsset>(() => ({
    address: null,
    symbol: chainMeta.value.symbol,
    decimals: chainMeta.value.decimals,
}));

const asAsset = (token: WalletTokenBalance): SwapAsset => ({
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
});

const held = computed(
    () => props.wallet.tokens.value[active.value]?.items ?? [],
);

const nativeBalance = computed(
    () => props.wallet.balances.value[active.value]?.value ?? null,
);

/** Tokens read straight from a contract — the ones no index listed here. */
const readTokens = ref<Record<string, WalletTokenBalance>>({});

const first = ref<SwapAsset>(coin.value);
const second = ref<SwapAsset | null>(null);
const picking = ref<'first' | 'second' | null>(null);
const pasted = ref('');
const loadingAsset = ref(false);

/**
 * Tokens worth offering beyond what this account already holds — on Cyberia
 * the registry the DEX pages use, elsewhere the chain's own listed assets plus
 * its wrapped coin. Balances are not read for these; choosing one reads it.
 */
const catalogue = computed<{ address: string; symbol: string }[]>(() => {
    const config = dex.value;

    if (!config) {
        return [];
    }

    if (config.chainId === CYBERIA_CHAIN_ID) {
        return KNOWN_TOKENS;
    }

    return [
        ...config.tokens,
        { address: config.wrappedNative, symbol: `W${config.nativeSymbol}` },
    ];
});

const options = computed(() => {
    const rows: { asset: SwapAsset; balance: bigint | null }[] = [
        { asset: coin.value, balance: nativeBalance.value },
    ];
    const seen = new Set<string>();

    for (const token of held.value) {
        seen.add(token.address.toLowerCase());
        rows.push({ asset: asAsset(token), balance: token.balance });
    }

    for (const entry of catalogue.value) {
        const key = entry.address.toLowerCase();

        if (seen.has(key)) {
            continue;
        }

        seen.add(key);

        // A token this wallet has already read is offered with its own
        // decimals; one nobody has read is a name and an address, and
        // choosing it is what reads it. Never a guessed decimals under a
        // rendered number.
        const known = readTokens.value[key];

        rows.push({
            asset: known
                ? asAsset(known)
                : { address: entry.address, symbol: entry.symbol, decimals: 0 },
            balance: known?.balance ?? null,
        });
    }

    return rows;
});

const balanceOf = (asset: SwapAsset | null): bigint | null => {
    if (asset === null) {
        return null;
    }

    if (asset.address === null) {
        return nativeBalance.value;
    }

    const key = asset.address.toLowerCase();

    return (
        held.value.find((token) => token.address.toLowerCase() === key)
            ?.balance ??
        readTokens.value[key]?.balance ??
        null
    );
};

const priceOf = (asset: SwapAsset | null): number | null => {
    if (asset === null) {
        return null;
    }

    return asset.address === null
        ? (props.prices[active.value] ?? null)
        : (props.tokenPrices[active.value]?.[asset.address.toLowerCase()] ??
              null);
};

/**
 * Choosing an asset, and reading it for real when nobody had.
 *
 * A catalogue row carries a symbol and an address and deliberately no
 * decimals; a deposit priced against a guessed scale is wrong by orders of
 * magnitude, so the read happens here, before anything is typed against it.
 */
const chooseAsset = async (
    side: 'first' | 'second',
    asset: SwapAsset,
): Promise<void> => {
    picking.value = null;

    let chosen = asset;

    if (asset.address !== null && asset.decimals === 0) {
        loadingAsset.value = true;

        try {
            const read = await props.wallet.readToken(
                active.value,
                asset.address,
            );

            if (read) {
                readTokens.value[asset.address.toLowerCase()] = read;
                chosen = asAsset(read);
            }
        } finally {
            loadingAsset.value = false;
        }
    }

    if (side === 'first') {
        first.value = chosen;
    } else {
        second.value = chosen;
    }
};

const addPasted = async (): Promise<void> => {
    const address = pasted.value.trim();
    const side = picking.value;

    if (side === null || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
        return;
    }

    loadingAsset.value = true;

    try {
        const read = await props.wallet.readToken(active.value, address);

        if (read) {
            readTokens.value[address.toLowerCase()] = read;
            pasted.value = '';
            await chooseAsset(side, asAsset(read));
        }
    } catch (failure) {
        error.value =
            failure instanceof Error ? failure.message : String(failure);
    } finally {
        loadingAsset.value = false;
    }
};

/* -------------------------------------------------------------- amounts -- */

const amountFirst = ref('');
const amountSecond = ref('');

/** Which box was typed in last — the other one is the pool's answer. */
const typed = ref<'first' | 'second'>('first');

const pair = ref<PairState | null>(null);
const reading = ref(false);

const unitsOf = (value: string, asset: SwapAsset | null): bigint => {
    if (!asset || value.trim() === '') {
        return 0n;
    }

    try {
        return parseUnits(value.trim(), asset.decimals);
    } catch {
        return -1n;
    }
};

const unitsFirst = computed(() => unitsOf(amountFirst.value, first.value));
const unitsSecond = computed(() => unitsOf(amountSecond.value, second.value));

/** A pool with reserves prices the second side; an empty one does not. */
const priced = computed(
    () =>
        pair.value !== null &&
        pair.value.address !== null &&
        pair.value.reserves[0] > 0n &&
        pair.value.reserves[1] > 0n,
);

const opensPool = computed(() => pair.value !== null && !priced.value);

/**
 * Fill the side the user is *not* typing in, from the pool's own ratio.
 *
 * Called from the input handler rather than from a watcher on the two
 * amounts, and that is not a style choice. A watcher would see the side this
 * function just wrote, decide that side was the one being typed in, and
 * recompute the other from it — two boxes each insisting the other one moved,
 * with the rounding drifting on every pass.
 */
const repair = (): void => {
    const state = pair.value;

    if (!priced.value || !state || second.value === null) {
        return;
    }

    if (typed.value === 'first') {
        const other = pairedAmount(
            unitsFirst.value,
            state.reserves[0],
            state.reserves[1],
        );

        amountSecond.value =
            other === null ? '' : formatUnits(other, second.value.decimals, 18);

        return;
    }

    const other = pairedAmount(
        unitsSecond.value,
        state.reserves[1],
        state.reserves[0],
    );

    amountFirst.value =
        other === null ? '' : formatUnits(other, first.value.decimals, 18);
};

const loadPair = async (): Promise<void> => {
    pair.value = null;
    quote.value = null;

    const chainId = chainMeta.value.chainId;

    if (!chainId || second.value === null) {
        return;
    }

    reading.value = true;
    error.value = null;

    try {
        pair.value = await readPair(chainId, first.value, second.value);
        repair();
    } catch (failure) {
        error.value =
            failure instanceof Error ? failure.message : String(failure);
    } finally {
        reading.value = false;
    }
};

watch([first, second], () => {
    sent.value = null;
    void loadPair();
});

watch(slippageBps, () => scheduleQuote());

/** One amount typed: it stands, and the pool answers with the other one. */
const onAmount = (side: 'first' | 'second', value: string): void => {
    typed.value = side;

    if (side === 'first') {
        amountFirst.value = value;
    } else {
        amountSecond.value = value;
    }

    repair();
    scheduleQuote();
};

const setMax = (side: 'first' | 'second'): void => {
    const asset = side === 'first' ? first.value : second.value;
    const balance = balanceOf(asset);

    if (!asset || balance === null) {
        return;
    }

    onAmount(side, formatUnits(balance, asset.decimals, 18));
};

/* --------------------------------------------------------------- quote --- */

const quote = ref<AddLiquidityQuote | null>(null);
const quoting = ref(false);

let sequence = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const refusal = computed(() =>
    canAddLiquidity({
        first: first.value,
        second: second.value,
        amountFirst: unitsFirst.value,
        amountSecond: unitsSecond.value,
        balanceFirst: balanceOf(first.value),
        balanceSecond: balanceOf(second.value),
    }),
);

const refreshQuote = async (): Promise<void> => {
    quote.value = null;

    const chainId = chainMeta.value.chainId;
    const owner = account.value?.address;
    const price = gasPrice.value;

    if (
        !chainId ||
        !owner ||
        price === null ||
        second.value === null ||
        refusal.value !== 'ok'
    ) {
        return;
    }

    const mine = ++sequence;

    quoting.value = true;

    try {
        const answer = await quoteAddLiquidity({
            chainId,
            first: first.value,
            second: second.value,
            amountFirst: unitsFirst.value,
            amountSecond: unitsSecond.value,
            slippageBps: slippageBps.value,
            account: owner,
            gasPrice: price,
        });

        if (mine === sequence) {
            quote.value = answer;
            pair.value = answer.pair;
        }
    } catch (failure) {
        if (mine === sequence) {
            error.value =
                failure instanceof Error ? failure.message : String(failure);
        }
    } finally {
        if (mine === sequence) {
            quoting.value = false;
        }
    }
};

/** Typing is not a request for a quote; a pause in the typing is. */
const scheduleQuote = (): void => {
    if (timer !== null) {
        clearTimeout(timer);
    }

    timer = setTimeout(() => void refreshQuote(), 400);
};

const fee = computed(() =>
    quote.value === null ? null : quote.value.fee + quote.value.approvalFee,
);

const feeUsd = computed(() =>
    fee.value === null
        ? null
        : usdValue(
              fee.value,
              chainMeta.value.decimals,
              props.prices[active.value] ?? null,
          ),
);

/**
 * Whether the coin left over would still pay the fee.
 *
 * Only the native side can run into this: a deposit that spends the coin and
 * the fee out of the same balance is the one way to sign something that cannot
 * be mined, and the swap screen separates the two for the same reason.
 */
const gasShort = computed(() => {
    const cost = fee.value;
    const balance = nativeBalance.value;

    if (cost === null || balance === null) {
        return false;
    }

    const spent =
        quote.value?.kind === 'native-first'
            ? unitsFirst.value
            : quote.value?.kind === 'native-second'
              ? unitsSecond.value
              : 0n;

    return balance < spent + cost;
});

const pairLabel = computed(() =>
    second.value === null
        ? ''
        : `${first.value.symbol} / ${second.value.symbol}`,
);

const amountLabel = (asset: SwapAsset | null, value: string): string =>
    asset === null ? '' : `${value.trim()} ${asset.symbol}`;

/** One plain sentence for what is about to be signed. */
const sentence = computed(() => {
    if (quote.value === null) {
        return '';
    }

    return t(quote.value.opensPool ? 'poolSignCreate' : 'poolSignAdd', {
        first: amountLabel(first.value, amountFirst.value),
        second: amountLabel(second.value, amountSecond.value),
        pair: pairLabel.value,
        fee: `${formatUnits(fee.value ?? 0n, chainMeta.value.decimals, 6)} ${chainMeta.value.symbol}`,
    });
});

const ready = computed(
    () =>
        quote.value !== null &&
        refusal.value === 'ok' &&
        !gasShort.value &&
        !busy.value &&
        !quoting.value,
);

/* ------------------------------------------------------------- settling --- */

/**
 * True while a signed transaction is on its way into a block.
 *
 * This exists because of a real bug and not for decoration. `pool.add` returns
 * as soon as the transaction is *broadcast* — that is the point at which a
 * hash exists — and the screen then went straight on to re-read the chain, so
 * it read the state from before its own deposit and drew a fresh position as
 * "0 LP". It stayed wrong until somebody pressed F5, which is exactly how long
 * it took the block to arrive and the reader to be run again by hand.
 *
 * Broadcast is not settlement. The wait is the chain adapter's own
 * `awaitOutcome`, and its timeout says something about the watching rather
 * than about the transaction — so a wait that gives up still re-reads, because
 * the deposit is very probably in by then and a stale zero is the worse
 * answer.
 */
const settling = ref(false);

const settle = async (hash: string): Promise<void> => {
    const chain = chainMeta.value;

    if (!chain.awaitOutcome) {
        return;
    }

    settling.value = true;

    try {
        await chain.awaitOutcome(hash);
    } catch {
        // Timed out watching. Nothing is known about the transaction from
        // that, so the re-read below is still the right next move.
    } finally {
        settling.value = false;
    }
};

/* ------------------------------------------------------------- signing --- */

const traits = () => ({
    chain: active.value,
    transaction_type: 'liquidity' as const,
    token_in: first.value.symbol,
    token_out: second.value?.symbol,
    fee_usd: feeUsd.value ?? undefined,
    amount_usd:
        usdValue(
            unitsFirst.value,
            first.value.decimals,
            priceOf(first.value),
        ) ?? undefined,
});

const add = async (): Promise<void> => {
    const answer = quote.value;
    const chainId = chainMeta.value.chainId;

    if (!answer || !chainId || !ready.value) {
        return;
    }

    busy.value = true;
    error.value = null;
    sent.value = null;

    const startedAt = Date.now();

    try {
        const receipt = await props.wallet.pool.add(active.value, answer);

        sent.value = {
            hash: receipt.hash,
            url: poolTxUrl(swapChainFor(chainId), receipt.hash),
        };
        amountFirst.value = '';
        amountSecond.value = '';
        quote.value = null;

        analytics.track('liquidity_added', {
            ...traits(),
            duration_ms: Date.now() - startedAt,
        });

        // The block first: reading the chain here without waiting is reading
        // it before this deposit is in it, which is what drew a brand new
        // position as zero until the page was reloaded by hand.
        await settle(receipt.hash);

        // A pool that did not exist a moment ago is one the cached factory
        // listing has never heard of, and it is exactly the pool whose
        // position somebody is about to go looking for.
        forgetPairs();
        await Promise.all([loadPair(), loadPositions()]);
        await props.wallet.refreshBalances();
    } catch (failure) {
        error.value =
            failure instanceof Error ? failure.message : String(failure);

        analytics.track('transaction_failed', {
            ...traits(),
            error_code: errorCode(failure),
            duration_ms: Date.now() - startedAt,
        });
    } finally {
        busy.value = false;
    }
};

/* ----------------------------------------------------------- positions --- */

const positions = ref<LpPosition[]>([]);
const loadingPositions = ref(false);
const selected = ref<string | null>(null);
const percent = ref(50);
const toCoin = ref(true);
const removal = ref<RemoveLiquidityQuote | null>(null);

const position = computed<LpPosition | null>(
    () =>
        positions.value.find((entry) => entry.pair === selected.value) ?? null,
);

const loadPositions = async (): Promise<void> => {
    const chainId = chainMeta.value.chainId;
    const owner = account.value?.address;

    if (!chainId || !owner) {
        return;
    }

    loadingPositions.value = true;

    try {
        positions.value = await readLpPositions(chainId, owner);
    } catch (failure) {
        error.value =
            failure instanceof Error ? failure.message : String(failure);
    } finally {
        loadingPositions.value = false;
    }
};

/** What a whole LP balance is a claim on, for the list. */
const underlying = (entry: LpPosition): [bigint, bigint] =>
    entry.totalSupply > 0n
        ? [
              (entry.reserves[0] * entry.balance) / entry.totalSupply,
              (entry.reserves[1] * entry.balance) / entry.totalSupply,
          ]
        : [0n, 0n];

const wrappedIn = (entry: LpPosition): 0 | 1 | null =>
    dex.value === null ? null : wrappedSide(entry, dex.value);

const openPosition = (entry: LpPosition): void => {
    selected.value = entry.pair;
    percent.value = 50;
    removal.value = null;
    sent.value = null;
    void quoteWithdrawal();
};

const quoteWithdrawal = async (): Promise<void> => {
    removal.value = null;

    const entry = position.value;
    const chainId = chainMeta.value.chainId;
    const owner = account.value?.address;
    const price = gasPrice.value;

    if (!entry || !chainId || !owner || price === null) {
        return;
    }

    const liquidity = withdrawalLp(entry.balance, percent.value);

    if (liquidity <= 0n) {
        return;
    }

    try {
        removal.value = await quoteRemoveLiquidity({
            chainId,
            position: entry,
            liquidity,
            slippageBps: slippageBps.value,
            toCoin: toCoin.value,
            account: owner,
            gasPrice: price,
        });
    } catch (failure) {
        error.value =
            failure instanceof Error ? failure.message : String(failure);
    }
};

watch([percent, toCoin], () => void quoteWithdrawal());

const removeFee = computed(() =>
    removal.value === null
        ? null
        : removal.value.fee + removal.value.approvalFee,
);

const removeSentence = computed(() => {
    const answer = removal.value;

    if (answer === null) {
        return '';
    }

    const { position: entry } = answer;

    return t('poolSignRemove', {
        amount: formatUnits(answer.liquidity, 18, 6),
        pair: `${entry.symbols[0]} / ${entry.symbols[1]}`,
        first: `${formatUnits(answer.amounts[0], entry.decimals[0], 6)} ${entry.symbols[0]}`,
        second: `${formatUnits(answer.amounts[1], entry.decimals[1], 6)} ${entry.symbols[1]}`,
        fee: `${formatUnits(removeFee.value ?? 0n, chainMeta.value.decimals, 6)} ${chainMeta.value.symbol}`,
    });
});

const remove = async (): Promise<void> => {
    const answer = removal.value;
    const chainId = chainMeta.value.chainId;

    if (!answer || !chainId || busy.value) {
        return;
    }

    busy.value = true;
    error.value = null;
    sent.value = null;

    const startedAt = Date.now();

    try {
        const receipt = await props.wallet.pool.remove(active.value, answer);

        sent.value = {
            hash: receipt.hash,
            url: poolTxUrl(swapChainFor(chainId), receipt.hash),
        };

        analytics.track('liquidity_removed', {
            chain: active.value,
            transaction_type: 'liquidity',
            token_in: answer.position.symbols[0],
            token_out: answer.position.symbols[1],
            duration_ms: Date.now() - startedAt,
        });

        removal.value = null;
        selected.value = null;
        await settle(receipt.hash);
        await loadPositions();
        await props.wallet.refreshBalances();
    } catch (failure) {
        error.value =
            failure instanceof Error ? failure.message : String(failure);

        analytics.track('transaction_failed', {
            chain: active.value,
            transaction_type: 'liquidity',
            error_code: errorCode(failure),
            duration_ms: Date.now() - startedAt,
        });
    } finally {
        busy.value = false;
    }
};

/* ---------------------------------------------------------------- load --- */

const loadGasPrice = async (): Promise<void> => {
    try {
        gasPrice.value = await props.wallet.gasPrice(active.value);
    } catch {
        gasPrice.value = null;
    }
};

onMounted(() => {
    void loadGasPrice();
    void loadPositions();
});

// A different account is a different set of positions; a different network is
// a different exchange entirely.
watch([() => props.wallet.activeAccountId.value, active], () => {
    first.value = coin.value;
    second.value = null;
    amountFirst.value = '';
    amountSecond.value = '';
    pair.value = null;
    quote.value = null;
    removal.value = null;
    selected.value = null;
    positions.value = [];
    sent.value = null;
    void loadGasPrice();
    void loadPositions();
});

const back = (): void => {
    if (selected.value !== null) {
        selected.value = null;
        removal.value = null;

        return;
    }

    emit('back');
};
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="back()">
            ← {{ selected === null ? t('navPortfolio') : t('poolPositions') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ t('poolTitle') }}
        </h2>
        <p class="cw-prose">{{ t('poolBody') }}</p>

        <p
            v-if="dex === null"
            class="cw-note cw-note-warn"
            style="margin-top: 18px"
        >
            <span>{{ t('poolNoDex') }}</span>
        </p>

        <template v-else>
            <div class="cw-row" style="margin: 20px 0 12px">
                <span style="display: flex; align-items: center; gap: 8px">
                    <NetworkMark :chain="active" dot :size="6" />
                    <span class="cw-label" style="color: var(--cw-faint)">{{
                        chainMeta.label
                    }}</span>
                </span>
                <button type="button" class="cw-back" @click="emit('earn')">
                    {{ t('poolOpenEarn') }} →
                </button>
            </div>

            <div class="cw-seg">
                <button
                    v-for="option in ['add', 'mine'] as const"
                    :key="option"
                    type="button"
                    class="cw-seg-item"
                    :class="{ 'cw-seg-bar': tab === option }"
                    :aria-pressed="tab === option"
                    @click="
                        tab = option;
                        sent = null;
                    "
                >
                    {{ option === 'add' ? t('poolTabAdd') : t('poolTabMine') }}
                </button>
            </div>

            <!-- ------------------------------------------------------ add -- -->
            <template v-if="tab === 'add'">
                <div
                    v-for="side in ['first', 'second'] as const"
                    :key="side"
                    style="margin-top: 16px"
                >
                    <div class="cw-row" style="margin-bottom: 8px">
                        <span class="cw-label">{{
                            side === 'first' ? t('poolFirst') : t('poolSecond')
                        }}</span>
                        <button
                            v-if="
                                balanceOf(side === 'first' ? first : second) !==
                                null
                            "
                            type="button"
                            class="cw-back"
                            @click="setMax(side)"
                        >
                            {{ t('max') }}
                        </button>
                    </div>
                    <div style="display: flex; gap: 8px">
                        <button
                            type="button"
                            class="cw-btn cw-btn-secondary"
                            style="width: 132px; flex: none"
                            @click="picking = side"
                        >
                            {{
                                side === 'first'
                                    ? first.symbol
                                    : (second?.symbol ?? t('poolPick'))
                            }}
                        </button>
                        <input
                            :value="
                                side === 'first' ? amountFirst : amountSecond
                            "
                            class="cw-input"
                            inputmode="decimal"
                            spellcheck="false"
                            placeholder="0.0"
                            :aria-label="
                                side === 'first'
                                    ? t('poolFirst')
                                    : t('poolSecond')
                            "
                            @input="
                                onAmount(
                                    side,
                                    ($event.target as HTMLInputElement).value,
                                )
                            "
                        />
                    </div>
                    <p
                        v-if="priced && typed !== side"
                        class="cw-label"
                        style="margin-top: 6px; color: var(--cw-faint)"
                    >
                        {{ t('poolPaired') }}
                    </p>
                </div>

                <p v-if="reading" class="cw-prose" style="margin-top: 14px">
                    {{ t('poolReading') }}
                </p>

                <!--
                  A pair nobody has opened yet. The deposit sets the price and
                  deploys the contract, and both of those are said here rather
                  than discovered in the fee.
                -->
                <p
                    v-else-if="opensPool && second !== null"
                    class="cw-note cw-note-warn"
                    style="margin-top: 14px"
                >
                    <span
                        ><strong>{{ t('poolNew') }}</strong>
                        {{ t('poolNewNote') }}</span
                    >
                </p>

                <p
                    v-else-if="priced"
                    class="cw-label"
                    style="margin-top: 14px; color: var(--cw-faint)"
                >
                    {{ t('poolPairedNote') }}
                </p>

                <div
                    v-if="quote"
                    style="margin-top: 18px; border: 1px solid var(--cw-line)"
                >
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('poolYouGet') }}</span>
                        <span class="cw-kv-val"
                            >{{ formatUnits(quote.minted, 18, 6) }} LP</span
                        >
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('poolShareAfter') }}</span>
                        <span class="cw-kv-val"
                            >{{ (quote.shareAfter * 100).toFixed(4) }}%</span
                        >
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{
                            t('poolMinReceived')
                        }}</span>
                        <span class="cw-kv-val"
                            >{{
                                formatUnits(quote.minFirst, first.decimals, 6)
                            }}
                            {{ first.symbol }} ·
                            {{
                                formatUnits(
                                    quote.minSecond,
                                    second?.decimals ?? 18,
                                    6,
                                )
                            }}
                            {{ second?.symbol }}</span
                        >
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('networkFee') }}</span>
                        <span class="cw-kv-val"
                            >{{ formatUnits(fee ?? 0n, chainMeta.decimals, 6) }}
                            {{ chainMeta.symbol
                            }}<template v-if="feeUsd !== null">
                                · {{ formatUsd(feeUsd, locale) }}</template
                            ></span
                        >
                    </div>
                </div>

                <!--
                  The label above the chips rather than beside them: four
                  percentages and a Russian word for "slippage" do not share a
                  393px row, and the version that tried pushed the last chip
                  off the screen and gave the whole page a sideways scroll.
                -->
                <div style="margin-top: 16px">
                    <span class="cw-label">{{ t('poolSlippage') }}</span>
                    <span style="display: flex; gap: 6px; margin-top: 8px">
                        <button
                            v-for="option in [10, 50, 100, 300]"
                            :key="option"
                            type="button"
                            class="cw-chip"
                            :class="{ 'cw-chip-on': slippageBps === option }"
                            @click="slippageBps = option"
                        >
                            {{ option / 100 }}%
                        </button>
                    </span>
                </div>

                <p
                    v-if="quote && quote.approvals.length > 0"
                    class="cw-note"
                    style="margin-top: 14px"
                >
                    <span>{{
                        t('poolApprovalNote', {
                            symbols: quote.approvals
                                .map((entry) => entry.symbol)
                                .join(' + '),
                        })
                    }}</span>
                </p>

                <p
                    v-if="refusal !== 'ok' && second !== null"
                    class="cw-label"
                    style="margin-top: 14px; color: var(--cw-pending)"
                >
                    {{
                        refusal === 'shortFirst'
                            ? t('poolRefusalShort', { symbol: first.symbol })
                            : refusal === 'shortSecond'
                              ? t('poolRefusalShort', {
                                    symbol: second?.symbol ?? '',
                                })
                              : refusal === 'sameAsset'
                                ? t('poolRefusalSame')
                                : t('poolRefusalEmpty')
                    }}
                </p>

                <p
                    v-if="gasShort"
                    class="cw-label"
                    style="margin-top: 14px; color: var(--cw-pending)"
                >
                    {{ t('poolRefusalGas', { symbol: chainMeta.symbol }) }}
                </p>

                <p v-if="quoting" class="cw-prose" style="margin-top: 14px">
                    {{ t('poolQuoting') }}
                </p>

                <p v-if="sentence" class="cw-prose" style="margin-top: 14px">
                    {{ sentence }}
                </p>

                <div style="margin-top: 18px">
                    <HoldButton
                        :label="t('holdToSign')"
                        :disabled="!ready"
                        @complete="add()"
                    />
                </div>

                <p class="cw-note cw-note-warn" style="margin-top: 20px">
                    <span>{{ t('poolImpermanent') }}</span>
                </p>
            </template>

            <!-- ------------------------------------------------ positions -- -->
            <template v-else>
                <p
                    v-if="loadingPositions"
                    class="cw-prose"
                    style="margin-top: 18px"
                >
                    {{ t('poolLoading') }}
                </p>

                <template v-else-if="selected === null">
                    <p
                        v-if="positions.length === 0"
                        class="cw-prose"
                        style="margin-top: 18px"
                    >
                        {{ t('poolNoPositions') }}
                    </p>

                    <div
                        v-else
                        class="cw-stack"
                        style="gap: 8px; margin-top: 18px"
                    >
                        <button
                            v-for="entry in positions"
                            :key="entry.pair"
                            type="button"
                            class="cw-card cw-card-button"
                            @click="openPosition(entry)"
                        >
                            <div class="cw-row">
                                <span
                                    style="
                                        font: 500 16px/1.2 var(--cw-sans);
                                        color: var(--cw-text);
                                    "
                                    >{{ entry.symbols[0] }} /
                                    {{ entry.symbols[1] }}</span
                                >
                                <span class="cw-num"
                                    >{{
                                        formatUnits(entry.balance, 18, 4)
                                    }}
                                    LP</span
                                >
                            </div>
                            <div class="cw-row" style="margin-top: 8px">
                                <span
                                    class="cw-rowdata"
                                    style="color: var(--cw-dim)"
                                    >{{
                                        formatUnits(
                                            underlying(entry)[0],
                                            entry.decimals[0],
                                            4,
                                        )
                                    }}
                                    {{ entry.symbols[0] }} +
                                    {{
                                        formatUnits(
                                            underlying(entry)[1],
                                            entry.decimals[1],
                                            4,
                                        )
                                    }}
                                    {{ entry.symbols[1] }}</span
                                >
                                <span
                                    class="cw-label"
                                    style="color: var(--cw-faint)"
                                    >{{ shortAddress(entry.pair) }}</span
                                >
                            </div>
                        </button>
                    </div>

                    <p class="cw-prose" style="margin-top: 16px">
                        {{ t('poolStakedElsewhere') }}
                    </p>
                </template>

                <!-- One position, and how much of it to take back out. -->
                <template v-else-if="position">
                    <h3
                        class="cw-title"
                        style="margin: 20px 0 4px; font-size: 18px"
                    >
                        {{ position.symbols[0] }} / {{ position.symbols[1] }}
                    </h3>
                    <p class="cw-label" style="color: var(--cw-faint)">
                        {{ formatUnits(position.balance, 18, 8) }} LP
                    </p>

                    <div class="cw-row" style="margin-top: 18px">
                        <span class="cw-label">{{ t('poolTakeOut') }}</span>
                        <span class="cw-num">{{ percent }}%</span>
                    </div>
                    <div style="display: flex; gap: 6px; margin-top: 8px">
                        <button
                            v-for="option in [25, 50, 75, 100]"
                            :key="option"
                            type="button"
                            class="cw-chip"
                            :class="{ 'cw-chip-on': percent === option }"
                            @click="percent = option"
                        >
                            {{ option }}%
                        </button>
                    </div>

                    <label
                        v-if="wrappedIn(position) !== null"
                        class="cw-row"
                        style="margin-top: 16px; cursor: pointer"
                    >
                        <span class="cw-label">{{
                            t('poolAsCoin', { symbol: chainMeta.symbol })
                        }}</span>
                        <input v-model="toCoin" type="checkbox" />
                    </label>

                    <div
                        v-if="removal"
                        style="
                            margin-top: 18px;
                            border: 1px solid var(--cw-line);
                        "
                    >
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{
                                t('poolYouTake')
                            }}</span>
                            <span class="cw-kv-val"
                                >{{
                                    formatUnits(
                                        removal.amounts[0],
                                        position.decimals[0],
                                        6,
                                    )
                                }}
                                {{ position.symbols[0] }} ·
                                {{
                                    formatUnits(
                                        removal.amounts[1],
                                        position.decimals[1],
                                        6,
                                    )
                                }}
                                {{ position.symbols[1] }}</span
                            >
                        </div>
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{ t('networkFee') }}</span>
                            <span class="cw-kv-val"
                                >{{
                                    formatUnits(
                                        removeFee ?? 0n,
                                        chainMeta.decimals,
                                        6,
                                    )
                                }}
                                {{ chainMeta.symbol }}</span
                            >
                        </div>
                    </div>

                    <p
                        v-if="removal && removal.approval !== null"
                        class="cw-note"
                        style="margin-top: 14px"
                    >
                        <span>{{ t('poolLpApprovalNote') }}</span>
                    </p>

                    <p
                        v-if="removeSentence"
                        class="cw-prose"
                        style="margin-top: 14px"
                    >
                        {{ removeSentence }}
                    </p>

                    <div style="margin-top: 18px">
                        <HoldButton
                            :label="t('holdToSign')"
                            :disabled="removal === null || busy"
                            @complete="remove()"
                        />
                    </div>
                </template>
            </template>

            <p
                v-if="error"
                class="cw-note cw-note-bad"
                style="margin-top: 16px"
            >
                <span>{{ error }}</span>
            </p>

            <div v-if="sent" class="cw-note" style="margin-top: 16px">
                <span>
                    {{ settling ? t('poolSettling') : t('poolSent') }}
                    <a :href="sent.url" target="_blank" rel="noopener">{{
                        t('viewInExplorer')
                    }}</a>
                </span>
            </div>
        </template>

        <!-- ------------------------------------------------- asset picker --- -->
        <div v-if="picking !== null" class="cw-sheet">
            <div class="cw-sheet-panel">
                <div class="cw-row" style="margin-bottom: 14px">
                    <h3 class="cw-title" style="font-size: 18px">
                        {{ t('poolPick') }}
                    </h3>
                    <button
                        type="button"
                        class="cw-icon-btn"
                        style="border: none"
                        :aria-label="t('cancel')"
                        @click="picking = null"
                    >
                        ✕
                    </button>
                </div>

                <div
                    class="cw-stack"
                    style="gap: 0; max-height: 46vh; overflow-y: auto"
                >
                    <button
                        v-for="row in options"
                        :key="row.asset.address ?? 'native'"
                        type="button"
                        class="cw-row"
                        style="
                            width: 100%;
                            padding: 11px 4px;
                            border: none;
                            border-bottom: 1px solid var(--cw-line);
                            background: none;
                            cursor: pointer;
                        "
                        @click="chooseAsset(picking!, row.asset)"
                    >
                        <span style="text-align: left">
                            <span
                                style="
                                    display: block;
                                    font: 500 15px/1.2 var(--cw-mono);
                                    color: var(--cw-text);
                                "
                                >{{ row.asset.symbol }}</span
                            >
                            <span
                                v-if="row.asset.address"
                                style="
                                    display: block;
                                    margin-top: 3px;
                                    font: 500 12px/1 var(--cw-mono);
                                    color: var(--cw-faint);
                                "
                                >{{ shortAddress(row.asset.address) }}</span
                            >
                        </span>
                        <span
                            style="
                                font: 500 13px/1 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                            >{{
                                row.balance === null
                                    ? ''
                                    : formatUnits(
                                          row.balance,
                                          row.asset.decimals,
                                          6,
                                      )
                            }}</span
                        >
                    </button>
                </div>

                <div class="cw-label" style="margin: 16px 0 6px">
                    {{ t('swapByAddress') }}
                </div>
                <div style="display: flex; gap: 8px">
                    <input
                        v-model="pasted"
                        class="cw-input"
                        type="text"
                        spellcheck="false"
                        placeholder="0x…"
                    />
                    <button
                        type="button"
                        class="cw-btn cw-btn-secondary"
                        style="width: 100px"
                        :disabled="loadingAsset || pasted.trim() === ''"
                        @click="addPasted"
                    >
                        {{ loadingAsset ? '…' : t('swapAdd') }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
