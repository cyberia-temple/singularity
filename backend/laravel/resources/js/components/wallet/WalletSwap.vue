<script setup lang="ts">
import {
    ArrowDownUp,
    CircleCheck,
    CircleX,
    Loader,
    RefreshCw,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import GasSponsor from '@/components/wallet/GasSponsor.vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import WalletRouteSwap from '@/components/wallet/WalletRouteSwap.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { analytics, errorCode } from '@/lib/analytics';
import { KNOWN_TOKENS } from '@/lib/cyberiaTokens';
import { CYBERIA_CHAIN_ID } from '@/lib/evmChains';
import {
    MARKET_RANGES,
    autoRangeKey,
    buildCandles,
    marketRange,
} from '@/lib/marketCandles';
import type { MarketCandle, MarketHistory } from '@/lib/marketCandles';
import {
    SWAP_GAS_CAP,
    WRAP_GAS_CAP,
    forgetPoolEdges,
    formatUnits,
    hasSwap,
    parseUnits,
    quoteSwap,
    quoteWrap,
    sameToken,
    swapChainFor,
    swapTxUrl,
    walletChain,
    wrapDirection,
} from '@/lib/wallet';
import type {
    SwapAsset,
    SwapQuote,
    WalletChainId,
    WalletTokenBalance,
    WrapDirection,
    WrapQuote,
} from '@/lib/wallet';
import {
    forgetRoutedChains,
    routedChainIds,
    routerChainId,
} from '@/lib/wallet/crosschain';
import { dailyBoardCached } from '@/lib/wallet/daily';
import type { DailyBoard } from '@/lib/wallet/daily';
import { formatUsd, shortAddress, usdValue } from '@/lib/wallet/format';
import {
    loadRouteHistory,
    resolveMarketRoute,
} from '@/lib/wallet/marketHistory';
import {
    announceWalletEvent,
    playWalletSound,
} from '@/lib/wallet/notifications';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Trading inside the wallet: swap two assets, or wrap the network's coin.
 *
 * Both acts end in a signature, so both obey the rules the send screen set.
 * One plain-language sentence above the numbers. A hold, not a tap. And every
 * number on screen read from the chain — the route, the output, the gas — with
 * the quote the user agreed to travelling into the transaction as a *floor*
 * rather than being re-derived after the hold.
 *
 * Swapping and wrapping share a screen because they answer the same question —
 * "I have this, I want that" — but they are not the same act and the screen
 * never blurs them. A swap has a route, a price that moves and a slippage
 * setting; a wrap is one for one, forever, and says exactly that instead of
 * showing three numbers that would all read 100%.
 *
 * There is a chart now, and it is the pair's own: the strip above the form is
 * this trade's route replayed out of the pools' `Sync` events, base priced in
 * quote, which is the only history that exists for a market with no book. It is
 * loaded after the quote and never before it — the route the chart draws has to
 * be the route the trade would take — and a pair whose pools this browser
 * cannot read draws nothing rather than a flat line.
 */

const props = defineProps<{
    wallet: MultiWallet;
    chain: WalletChainId;
    prices: Record<string, number | null>;
    /** Chain id → (lowercased contract → USD price). */
    tokenPrices: Record<string, Record<string, number>>;
    /** Asset the screen opens on, when it was reached from a token row. */
    token?: WalletTokenBalance | null;
    /**
     * Contract to buy, when the screen was reached from something that knows
     * an address and nothing else — a launch, for instance. It is read from
     * the chain before it is used, so its decimals are never assumed.
     */
    contract?: string | null;
}>();

const emit = defineEmits<{
    back: [];
    pick: [chain: WalletChainId];
    swapped: [];
    /** The markets list, for the chart this pair's own strip is not. */
    markets: [];
    /** The daily board, from the one line of it this screen shows. */
    daily: [];
}>();

const { locale, t } = useLocale(walletMessages);

type Mode = 'swap' | 'wrap';
type Phase = 'compose' | 'review' | 'status';
type Outcome = 'signing' | 'approving' | 'pending' | 'confirmed' | 'failed';

const mode = ref<Mode>('swap');
const phase = ref<Phase>('compose');
const outcome = ref<Outcome>('signing');
const direction = ref<WrapDirection>('wrap');

const amount = ref('');
const slippageBps = ref(50);
const quote = ref<SwapQuote | null>(null);
const wrapQuote = ref<WrapQuote | null>(null);
const quoting = ref(false);
const failure = ref<string | null>(null);
const hash = ref<string | null>(null);
const approvalHash = ref<string | null>(null);
const gasPrice = ref<bigint | null>(null);

/** The wrapped native token, read from its own contract rather than assumed. */
const wrapped = ref<WalletTokenBalance | null>(null);

/**
 * Tokens read straight from their contracts — the ones no index listed for
 * this address. Keyed by lowercased contract, and the decimals are the whole
 * reason they are kept: a symbol is a label, a decimals is arithmetic.
 */
const readTokens = ref<Record<string, WalletTokenBalance>>({});

/** Which side the asset picker is choosing for, or null when it is closed. */
const picking = ref<'pay' | 'receive' | null>(null);
const pasted = ref('');
const loadingAsset = ref(false);

const chain = computed(() => walletChain(props.chain));

/*
 * A network with no Cyberia exchange is not a network with no trade.
 *
 * The screen used to stop at "we have not deployed here" — a fact about this
 * project, offered as though it were a fact about the chain. BNB Chain has
 * more liquidity than Cyberia ever will; what is missing is only *our* router.
 * So the wallet asks the one it already asks for cross-chain swaps, and this
 * flag is the whole difference: does that router serve this chain, or is there
 * genuinely nothing to offer.
 *
 * Asked lazily and only when our own DEX is absent, because it is a network
 * call and every chain that has our router has already answered the question.
 */
const routerChains = ref<number[] | null>(null);
const routerAsked = ref(false);

/**
 * The router could not be reached, which is a different sentence from "the
 * router does not serve this chain".
 *
 * One is a fact about the network and the old dead end says it correctly. The
 * other is a fact about this minute, and answering it with "there is no
 * exchange here" tells the user something false about their chain and offers
 * them no way to find out otherwise.
 */
const routerUnreachable = ref(false);

const routable = computed(() => {
    const id = routerChainId(props.chain);

    return id !== null && (routerChains.value ?? []).includes(id);
});

const account = computed(() =>
    props.wallet.accounts.value.find(
        (candidate) => candidate.chain === props.chain,
    ),
);

/** The exchange deployed on this network, or null when there is none. */
const dex = computed(() =>
    hasSwap(chain.value.chainId) ? swapChainFor(chain.value.chainId!) : null,
);

/** Networks this account can trade on — the only ones the picker offers. */
/**
 * Networks this account can trade on — the only ones the picker offers.
 *
 * "Can trade on" and not "has a Cyberia exchange on": with a router behind the
 * screen the current network belongs in the strip too, or the picker offers
 * two elsewheres while quoting a trade right here and nothing is marked.
 */
const tradable = computed(() => {
    const routed = routerChains.value ?? [];

    return props.wallet.accounts.value.filter((candidate) => {
        if (hasSwap(walletChain(candidate.chain).chainId)) {
            return true;
        }

        const id = routerChainId(candidate.chain);

        return id !== null && routed.includes(id);
    });
});

const coin = computed<SwapAsset>(() => ({
    address: null,
    symbol: chain.value.symbol,
    decimals: chain.value.decimals,
}));

const asAsset = (token: WalletTokenBalance): SwapAsset => ({
    address: token.address,
    symbol: token.symbol,
    decimals: token.decimals,
});

const wrappedAsset = computed<SwapAsset | null>(() =>
    wrapped.value ? asAsset(wrapped.value) : null,
);

const from = ref<SwapAsset>(props.token ? asAsset(props.token) : coin.value);
const to = ref<SwapAsset | null>(null);

/** What is being paid — in wrap mode the direction decides, not the pickers. */
const payAsset = computed<SwapAsset>(() => {
    if (mode.value === 'wrap') {
        return direction.value === 'wrap'
            ? coin.value
            : (wrappedAsset.value ?? coin.value);
    }

    return from.value;
});

const receiveAsset = computed<SwapAsset | null>(() => {
    if (mode.value === 'wrap') {
        return direction.value === 'wrap' ? wrappedAsset.value : coin.value;
    }

    return to.value;
});

const held = computed(
    () => props.wallet.tokens.value[props.chain]?.items ?? [],
);

const nativeBalance = computed(
    () => props.wallet.balances.value[props.chain]?.value ?? null,
);

const balanceOf = (asset: SwapAsset | null): bigint | null => {
    if (asset === null) {
        return null;
    }

    if (asset.address === null) {
        return nativeBalance.value;
    }

    const owned = held.value.find((token) =>
        sameToken(token.address, asset.address!),
    );

    return (
        owned?.balance ??
        readTokens.value[asset.address.toLowerCase()]?.balance ??
        null
    );
};

const payBalance = computed(() => balanceOf(payAsset.value));

const priceOf = (asset: SwapAsset | null): number | null => {
    if (asset === null) {
        return null;
    }

    return asset.address === null
        ? (props.prices[chain.value.id] ?? null)
        : ((props.tokenPrices[chain.value.id] ?? {})[
              asset.address.toLowerCase()
          ] ?? null);
};

const amountUnits = computed(() => {
    if (amount.value.trim() === '') {
        return null;
    }

    try {
        return parseUnits(amount.value, payAsset.value.decimals);
    } catch {
        return null;
    }
});

/** What comes back: the router's quote, or the same amount for a wrap. */
const receiveUnits = computed(() => {
    if (mode.value === 'wrap') {
        return wrapQuote.value?.amount ?? null;
    }

    return quote.value?.amountOut ?? null;
});

/** Gas for this act, including the allowance transactions when there are any. */
const fee = computed(() =>
    mode.value === 'wrap'
        ? (wrapQuote.value?.fee ?? null)
        : quote.value === null
          ? null
          : quote.value.fee + quote.value.approvalFee,
);

/**
 * How much of the paid asset is missing.
 *
 * When the coin itself is being paid, gas comes out of the same balance and is
 * part of the sum; a token is a different balance entirely, which is what the
 * gas shortfall below is for.
 */
const shortfall = computed(() => {
    if (amountUnits.value === null || payBalance.value === null) {
        return null;
    }

    const gas = payAsset.value.address === null ? (fee.value ?? 0n) : 0n;
    const needed = amountUnits.value + gas;

    return needed > payBalance.value ? needed - payBalance.value : null;
});

/** Holding the token but not the coin that moves it — a different sentence. */
const gasShortfall = computed(() => {
    if (
        payAsset.value.address === null ||
        fee.value === null ||
        nativeBalance.value === null
    ) {
        return null;
    }

    return fee.value > nativeBalance.value
        ? fee.value - nativeBalance.value
        : null;
});

const impact = computed(() => quote.value?.impactPct ?? null);

/** Above this the pool is thin enough that the warning belongs on screen. */
const impactHigh = computed(() => impact.value !== null && impact.value >= 5);

const canSign = computed(() => account.value?.capabilities.send ?? false);

const ready = computed(
    () =>
        canSign.value &&
        shortfall.value === null &&
        gasShortfall.value === null &&
        (mode.value === 'wrap'
            ? // Without the wrapper's own symbol and decimals the screen cannot
              // name what it is about to sign, so it refuses to sign it.
              wrapQuote.value !== null && wrapped.value !== null
            : quote.value !== null),
);

/* ------------------------------------------------------ asset catalogue --- */

/**
 * Tokens worth offering on this network beyond what the wallet already holds.
 *
 * On Cyberia that is the curated registry the DEX pages use; a satellite lists
 * its bridged assets plus the wrapped coin. Balances are not read for these —
 * that would be a call per row — so the picker shows a balance only where it
 * already knows one, and reads the token for real once it is chosen.
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

/** Everything the picker offers, held tokens first, without duplicates. */
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

        // A token the wallet has already read is offered with its own
        // decimals and balance; one nobody has read is offered as a name and
        // an address, and choosing it is what reads it. Never a guessed
        // decimals under a rendered number.
        const read = readTokens.value[key];

        rows.push({
            asset: read
                ? asAsset(read)
                : { address: entry.address, symbol: entry.symbol, decimals: 0 },
            balance: read?.balance ?? null,
        });
    }

    return rows;
});

/** Symbols along the route, so a three-hop trade is visible as one. */
/**
 * Contract → ticker, for reading a route as assets.
 *
 * The wrapped native keeps its own name rather than borrowing the coin's: the
 * route really does walk through the wrapper, and a path that said CYBER where
 * WCYBER is would be describing a pool that does not exist.
 */
const knownSymbols = computed(() => {
    const known = new Map<string, string>();

    known.set(
        (dex.value?.wrappedNative ?? '').toLowerCase(),
        `W${chain.value.symbol}`,
    );

    for (const token of held.value) {
        known.set(token.address.toLowerCase(), token.symbol);
    }

    for (const token of catalogue.value) {
        known.set(token.address.toLowerCase(), token.symbol);
    }

    return known;
});

/** One path as tickers. Every route on the screen is read through this. */
const symbolsOf = (path: readonly string[]): string[] =>
    path.map(
        (address) =>
            knownSymbols.value.get(address.toLowerCase()) ??
            shortAddress(address),
    );

const routeSymbols = computed(() =>
    quote.value === null ? [] : symbolsOf(quote.value.path),
);

/** Price of one paid unit in the received asset, from the quote itself. */
const rate = computed(() => {
    if (
        quote.value === null ||
        receiveAsset.value === null ||
        quote.value.amountIn === 0n
    ) {
        return null;
    }

    const paid = Number(
        formatUnits(quote.value.amountIn, payAsset.value.decimals, 18),
    );
    const got = Number(
        formatUnits(quote.value.amountOut, receiveAsset.value.decimals, 18),
    );

    return paid === 0 ? null : got / paid;
});

/* ----------------------------------------------------------- selection --- */

const setAsset = (side: 'pay' | 'receive', asset: SwapAsset): void => {
    if (side === 'pay') {
        from.value = asset;
    } else {
        to.value = asset;
    }
};

/**
 * Take a token the wallet does not hold: read it before it is used.
 *
 * The decimals decide what the typed amount means, so they come from the
 * contract rather than from the row that was tapped — a six-decimal token
 * parsed as eighteen would swap a millionth of what the user meant.
 */
const chooseToken = async (
    side: 'pay' | 'receive',
    asset: SwapAsset,
): Promise<void> => {
    picking.value = null;
    failure.value = null;

    if (asset.address === null) {
        setAsset(side, coin.value);

        return;
    }

    const owned = held.value.find((token) =>
        sameToken(token.address, asset.address!),
    );

    if (owned) {
        setAsset(side, asAsset(owned));

        return;
    }

    loadingAsset.value = true;

    try {
        const read = await props.wallet.readToken(props.chain, asset.address);

        if (read) {
            readTokens.value = {
                ...readTokens.value,
                [read.address.toLowerCase()]: read,
            };
            setAsset(side, asAsset(read));
        }
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        loadingAsset.value = false;
    }
};

const addPasted = async (): Promise<void> => {
    const contract = pasted.value.trim();

    if (contract === '' || picking.value === null) {
        return;
    }

    await chooseToken(picking.value, {
        address: contract,
        symbol: '???',
        decimals: 18,
    });
    pasted.value = '';
};

const flip = (): void => {
    if (mode.value === 'wrap') {
        direction.value = direction.value === 'wrap' ? 'unwrap' : 'wrap';
        amount.value = '';

        return;
    }

    if (to.value === null) {
        return;
    }

    const previous = from.value;

    from.value = to.value;
    to.value = previous;
    amount.value = '';
};

const setMax = (): void => {
    const balance = payBalance.value;

    if (balance === null) {
        return;
    }

    // A token's whole balance is spendable — its gas is paid in the coin. The
    // coin has to keep back what the transaction itself will cost, and the
    // worst case is used rather than the estimate so MAX cannot leave the
    // account a few thousand wei short of its own fee.
    if (payAsset.value.address !== null) {
        amount.value = formatUnits(balance, payAsset.value.decimals, 12);

        return;
    }

    if (gasPrice.value === null) {
        return;
    }

    const reserve =
        gasPrice.value * (mode.value === 'wrap' ? WRAP_GAS_CAP : SWAP_GAS_CAP);
    const spendable = balance - reserve;

    amount.value =
        spendable > 0n
            ? formatUnits(spendable, payAsset.value.decimals, 12)
            : '0';
};

/* ------------------------------------------------------------- quoting --- */

let sequence = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

const loadGasPrice = async (): Promise<bigint | null> => {
    try {
        gasPrice.value = await props.wallet.gasPrice(props.chain);
    } catch {
        gasPrice.value = null;
    }

    return gasPrice.value;
};

/**
 * What a trade looks like to analytics: the network, the pair by symbol, what
 * it was worth and how it was priced.
 *
 * Symbols and USD, never contracts and never units — a contract address plus
 * an exact amount identifies one trade on a public chain, and a symbol plus a
 * rounded dollar figure is a row in a total. The slippage is the setting the
 * user chose, which is the number worth knowing when failures cluster.
 */
const traits = () => ({
    chain: props.chain,
    token_in: payAsset.value.symbol,
    token_out: receiveAsset.value?.symbol,
    transaction_type: (mode.value === 'wrap' ? 'wrap' : 'swap') as
        | 'wrap'
        | 'swap',
    slippage: mode.value === 'wrap' ? undefined : slippageBps.value / 100,
    amount_usd:
        usdValue(
            amountUnits.value,
            payAsset.value.decimals,
            payAsset.value.address === null
                ? (props.prices[props.chain] ?? null)
                : (props.tokenPrices[props.chain]?.[
                      payAsset.value.address.toLowerCase()
                  ] ?? null),
        ) ?? undefined,
});

const refreshQuote = async (): Promise<void> => {
    quote.value = null;
    wrapQuote.value = null;
    failure.value = null;

    const config = dex.value;
    const owner = account.value;
    const units = amountUnits.value;

    if (!config || !owner || units === null || units <= 0n) {
        return;
    }

    if (mode.value === 'swap' && to.value === null) {
        return;
    }

    const mine = ++sequence;

    quoting.value = true;

    const askedAt = Date.now();

    // A quote is where a swap either becomes possible or quietly does not:
    // "requested but never received" is a missing route or an unreachable
    // node, and it is invisible in any funnel that starts at the signature.
    analytics.track('swap_quote_requested', traits());

    try {
        const price = gasPrice.value ?? (await loadGasPrice());

        if (price === null) {
            throw new Error(t('feeUnavailable'));
        }

        if (mode.value === 'wrap') {
            const next = await quoteWrap({
                chainId: config.chainId,
                direction: direction.value,
                amount: units,
                account: owner.address,
                gasPrice: price,
            });

            if (mine === sequence) {
                wrapQuote.value = next;

                analytics.track('swap_quote_received', {
                    ...traits(),
                    duration_ms: Date.now() - askedAt,
                });
            }
        } else {
            const next = await quoteSwap({
                chainId: config.chainId,
                from: from.value,
                to: to.value!,
                amountIn: units,
                slippageBps: slippageBps.value,
                account: owner.address,
                gasPrice: price,
            });

            if (mine === sequence) {
                quote.value = next;

                analytics.track('swap_quote_received', {
                    ...traits(),
                    // The route as symbols would need a token lookup per hop;
                    // the hop count is the part a dashboard can act on — a
                    // three-hop route is a pair with no direct pool.
                    hops: Math.max(0, next.path.length - 1),
                    price_impact: next.impactPct ?? undefined,
                    duration_ms: Date.now() - askedAt,
                });
            }
        }
    } catch (error) {
        if (mine === sequence) {
            failure.value =
                error instanceof Error ? error.message : String(error);

            analytics.track('swap_quote_failed', {
                ...traits(),
                error_code: errorCode(error),
                duration_ms: Date.now() - askedAt,
            });
        }
    } finally {
        if (mine === sequence) {
            quoting.value = false;
        }
    }
};

/**
 * Retry after a route could not be found.
 *
 * The pool graph is cached for a few minutes, so the honest retry is to forget
 * it first: the pair the user is asking about may have been opened after this
 * browser last read the factory.
 */
const retryQuote = (): void => {
    forgetPoolEdges();
    void refreshQuote();
};

/** Typing is not a request for a quote; a pause in the typing is. */
const scheduleQuote = (): void => {
    if (timer !== null) {
        clearTimeout(timer);
    }

    timer = setTimeout(() => void refreshQuote(), 400);
};

/* ------------------------------------------------------------- signing --- */

/** The one sentence shown before every signature. */
const sentence = computed(() => {
    const decimals = payAsset.value.decimals;
    const paid =
        amountUnits.value === null
            ? '0'
            : formatUnits(amountUnits.value, decimals, 8);
    const gas =
        fee.value === null
            ? '—'
            : formatUnits(fee.value, chain.value.decimals, 8);

    if (mode.value === 'wrap') {
        return t(
            direction.value === 'wrap' ? 'wrapSentence' : 'unwrapSentence',
            {
                amount: paid,
                from: payAsset.value.symbol,
                to: receiveAsset.value?.symbol ?? '—',
                network: chain.value.label,
                fee: gas,
                gas: chain.value.symbol,
            },
        );
    }

    return t('swapSentence', {
        amount: paid,
        from: payAsset.value.symbol,
        min:
            quote.value === null || receiveAsset.value === null
                ? '—'
                : formatUnits(
                      quote.value.minOut,
                      receiveAsset.value.decimals,
                      8,
                  ),
        to: receiveAsset.value?.symbol ?? '—',
        network: chain.value.label,
        fee: gas,
        gas: chain.value.symbol,
    });
});

const OUTCOMES: Record<Outcome, { icon: typeof Loader }> = {
    signing: { icon: Loader },
    approving: { icon: Loader },
    pending: { icon: Loader },
    confirmed: { icon: CircleCheck },
    failed: { icon: CircleX },
};

/** The quote was accepted and the review screen opened. */
const review = (): void => {
    analytics.track('swap_started', {
        ...traits(),
        price_impact: quote.value?.impactPct ?? undefined,
        fee_usd:
            usdValue(
                quote.value?.fee ?? wrapQuote.value?.fee ?? null,
                chain.value.decimals,
                props.prices[props.chain] ?? null,
            ) ?? undefined,
    });
    phase.value = 'review';
};

const sign = async (): Promise<void> => {
    playWalletSound('message');
    phase.value = 'status';
    outcome.value = 'signing';
    failure.value = null;
    hash.value = null;
    approvalHash.value = null;

    const startedAt = Date.now();

    analytics.track('swap_signed', {
        ...traits(),
        price_impact: quote.value?.impactPct ?? undefined,
    });

    try {
        if (mode.value === 'wrap') {
            if (wrapQuote.value === null) {
                return;
            }

            hash.value = await props.wallet.wrap(props.chain, wrapQuote.value);
        } else {
            if (quote.value === null) {
                return;
            }

            if (quote.value.approval !== null) {
                outcome.value = 'approving';
            }

            const receipt = await props.wallet.swap(
                props.chain,
                quote.value,
                (approved) => {
                    approvalHash.value = approved;
                    outcome.value = 'signing';
                },
            );

            approvalHash.value = receipt.approvalHash;
            hash.value = receipt.hash;
        }

        outcome.value = 'pending';
    } catch (error) {
        outcome.value = 'failed';
        failure.value = error instanceof Error ? error.message : String(error);
        announceWalletEvent({
            title: `${t('swapTitle')} · ${t('swapOutcome_failed')}`,
            body: t('swapOutcomeBody_failed'),
            sound: 'error',
        });

        analytics.track('swap_failed', {
            ...traits(),
            error_code: errorCode(error),
            duration_ms: Date.now() - startedAt,
        });

        return;
    }

    emit('swapped');
    void props.wallet.refreshBalances();

    // Broadcast is not settlement, and watching can time out without the trade
    // failing — a timeout leaves this pending rather than calling it dead.
    if (!chain.value.awaitOutcome || hash.value === null) {
        announceWalletEvent({
            title: `${t('swapTitle')} · ${t('swapOutcome_pending')}`,
            body: t('swapOutcomeBody_pending'),
            sound: 'success',
            tag: hash.value ? `swap:${hash.value}` : undefined,
        });

        return;
    }

    try {
        outcome.value = await chain.value.awaitOutcome(hash.value);

        analytics.track(
            outcome.value === 'confirmed' ? 'swap_completed' : 'swap_failed',
            {
                ...traits(),
                price_impact: quote.value?.impactPct ?? undefined,
                duration_ms: Date.now() - startedAt,
                ...(outcome.value === 'confirmed'
                    ? {}
                    : { error_code: 'reverted' as const }),
            },
        );

        announceWalletEvent({
            title: `${t('swapTitle')} · ${t(`swapOutcome_${outcome.value}`)}`,
            body:
                outcome.value === 'confirmed'
                    ? t('swapOutcomeBody_confirmed', {
                          from: payAsset.value?.symbol ?? '—',
                          to: receiveAsset.value?.symbol ?? '—',
                      })
                    : t('swapOutcomeBody_failed'),
            sound: outcome.value === 'confirmed' ? 'success' : 'error',
            tag: `swap:${hash.value}`,
        });
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);

        // A watch that timed out has not failed the trade, and the screen says
        // so — nothing is recorded either way.
    }

    void props.wallet.refreshBalances();
    void props.wallet.refreshTokens(props.chain);
    void props.wallet.refreshHistory(props.chain);
};

/** Gas arrived from the station: only the coin balance changed. */
const onFunded = (): void => {
    void props.wallet.refreshBalances();
};

const reset = (): void => {
    phase.value = 'compose';
    hash.value = null;
    approvalHash.value = null;
    failure.value = null;
    void refreshQuote();
};

/* ------------------------------------------------------------- loading --- */

const loadWrapped = async (): Promise<void> => {
    const config = dex.value;

    wrapped.value = null;

    if (!config) {
        return;
    }

    try {
        wrapped.value = await props.wallet.readToken(
            props.chain,
            config.wrappedNative,
        );
    } catch {
        // Without the wrapper's own numbers the wrap tab has nothing true to
        // say, so it says so rather than assuming eighteen decimals.
    }
};

onMounted(() => {
    void loadGasPrice();
    void loadWrapped();
    void props.wallet.refreshTokens(props.chain);

    if (props.contract) {
        void chooseToken('receive', {
            address: props.contract,
            symbol: '',
            decimals: 0,
        });
    }
});

onBeforeUnmount(() => {
    if (timer !== null) {
        clearTimeout(timer);
    }
});

watch(
    () => props.chain,
    () => {
        // Assets belong to the network they live on: keeping one across a
        // switch would quote a contract that is not there.
        mode.value = 'swap';
        from.value = coin.value;
        to.value = null;
        amount.value = '';
        quote.value = null;
        wrapQuote.value = null;
        readTokens.value = {};
        void loadGasPrice();
        void loadWrapped();
        void props.wallet.refreshTokens(props.chain);
    },
);

/**
 * A coin and its own wrapper are not a trade — the router has no pool for them
 * and would answer with a revert. Picking that pair moves the screen to the
 * tab that can actually do it.
 */
watch([from, to], () => {
    const config = dex.value;

    if (!config || to.value === null) {
        return;
    }

    const wrapping = wrapDirection(
        config,
        from.value.address,
        to.value.address,
    );

    if (wrapping !== null) {
        mode.value = 'wrap';
        direction.value = wrapping;
    }
});

/**
 * Changing tab changes what the typed number means — six-decimal USDC on one
 * side, the eighteen-decimal coin on the other — so the amount does not
 * survive the move. Nor does a coin-and-wrapper pair: back on the swap tab it
 * would ask the router to price a pool that cannot exist.
 */
watch(mode, (next) => {
    amount.value = '';

    if (next !== 'swap' || to.value === null || dex.value === null) {
        return;
    }

    if (
        wrapDirection(dex.value, from.value.address, to.value.address) !== null
    ) {
        to.value = null;
    }
});

/*
 * One call for the page, and it is asked wherever this screen opens.
 *
 * It used to be asked only on a chain we do not serve — cheap, and it made the
 * network strip a different list depending on which network you happened to
 * arrive on: standing on Cyberia it offered Cyberia and Robinhood, so the way
 * to Solana was to leave this screen, switch the network chip, and come back.
 * The answer is now shared for the whole page and cached on the server behind
 * the route, so asking it always costs nothing and the strip is the same list
 * everywhere.
 *
 * A failure is not an error state: it means the fallback is unavailable, which
 * is what the third message on this screen says.
 */
watch(
    [() => props.chain, dex],
    async () => {
        if (routerAsked.value) {
            return;
        }

        routerAsked.value = true;
        routerUnreachable.value = false;

        try {
            routerChains.value = await routedChainIds();
        } catch {
            routerChains.value = [];
            routerUnreachable.value = true;
        }
    },
    { immediate: true },
);

/** Ask again, for the case that was only ever about this minute. */
const retryRouter = async (): Promise<void> => {
    routerUnreachable.value = false;
    // The shared answer is kept for the life of the page, so a retry has to
    // drop it first or it retries nothing and reports the same failure.
    forgetRoutedChains();

    try {
        routerChains.value = await routedChainIds();
    } catch {
        routerChains.value = [];
        routerUnreachable.value = true;
    }
};

/* ------------------------------------------------------- the day's board -- */

/**
 * What today pays, for the one line of it this screen shows.
 *
 * Read from a short-lived cache rather than requested per visit: opening the
 * composer from a launch row must not wait on a board, and the answer is the
 * same for the whole page. A failure is `null` and the banner simply does not
 * draw — a swap screen is never held up by a streak.
 */
const daily = ref<DailyBoard | null>(null);

const swapXp = computed<number | null>(() => {
    const paid = daily.value?.xpPerAction?.swap;

    return typeof paid === 'number' && paid > 0 ? paid : null;
});

const streakChip = computed<string | null>(() => {
    const standing = daily.value?.standing ?? null;

    if (daily.value === null) {
        return null;
    }

    return standing === null
        ? t('dailyStreakNone')
        : t('dailyStreakDays', { days: standing.currentStreak });
});

/**
 * The sentence beside it, and it is three different sentences.
 *
 * A wallet with no account is told what a swap *would* pay rather than that it
 * is losing something; an account that has not been counted today is told the
 * trade counts; one already counted is told the truth, which is that the day
 * pays once and the XP for the trade is separate.
 */
const dailyNote = computed<string | null>(() => {
    const board = daily.value;
    const paid = swapXp.value;

    if (board === null || paid === null) {
        return null;
    }

    if (!board.signedIn || board.standing === null) {
        return t('swapDailyAnon', { xp: paid });
    }

    return board.standing.activeToday
        ? t('swapDailyKept', { xp: paid })
        : t('swapDailyOpen', { xp: paid });
});

/* -------------------------------------------------------------- history -- */

/**
 * The pair's own price history, replayed from the route's pools.
 *
 * Keyed on the *quote's* path rather than on the two picked assets: the path is
 * what the trade actually walks, native already mapped to its wrapper, so the
 * strip and the trade can never be drawn from two different routes. A pair the
 * pool graph does not connect has no history and the card does not appear.
 */
const history = ref<MarketHistory | null>(null);
const historyLoading = ref(false);
const rangeKey = ref<string>('7D');
/** Set the moment the reader picks a range, so the loader stops overruling it. */
const rangePinned = ref(false);
const adv = ref(false);

const nowSec = (): number => Math.floor(Date.now() / 1_000);

let historyRun = 0;
let historyAbort: AbortController | null = null;

const pairKey = computed<string | null>(() => {
    const current = quote.value;

    if (mode.value !== 'swap' || current === null || current.path.length < 2) {
        return null;
    }

    return [
        current.chainId,
        current.path[0].toLowerCase(),
        current.path[current.path.length - 1].toLowerCase(),
    ].join(':');
});

const loadHistory = async (): Promise<void> => {
    const config = dex.value;
    const current = quote.value;

    if (!config || current === null || current.path.length < 2) {
        return;
    }

    const run = ++historyRun;
    historyAbort?.abort();
    const controller = new AbortController();
    historyAbort = controller;
    historyLoading.value = true;

    try {
        const route = await resolveMarketRoute(
            config,
            current.path[0],
            current.path[current.path.length - 1],
        );

        if (run !== historyRun || route === null) {
            if (run === historyRun) {
                history.value = null;
            }

            return;
        }

        const loaded = await loadRouteHistory(
            config,
            route.hops,
            controller.signal,
        );

        if (run !== historyRun) {
            return;
        }

        history.value = loaded;

        // Open on a window that actually has movement in it. A pair that
        // traded twice last month has nothing to show on a 24h strip, and a
        // flat line is a claim about the price rather than about the data.
        if (!rangePinned.value && loaded.observations.length > 0) {
            rangeKey.value = autoRangeKey(loaded, nowSec());
        }
    } catch {
        if (run === historyRun) {
            history.value = null;
        }
    } finally {
        if (run === historyRun) {
            historyLoading.value = false;
        }
    }
};

watch(pairKey, (next, previous) => {
    if (next === previous) {
        return;
    }

    historyRun++;
    historyAbort?.abort();
    history.value = null;
    historyLoading.value = false;

    if (next !== null) {
        void loadHistory();
    }
});

const candles = computed<MarketCandle[]>(() => {
    const loaded = history.value;

    if (loaded === null || loaded.observations.length === 0) {
        return [];
    }

    const range = marketRange(rangeKey.value);
    const toSec = nowSec();

    return buildCandles(loaded, {
        fromSec:
            range.windowSec === null
                ? loaded.observations[0].ts
                : toSec - range.windowSec,
        toSec,
        bucketSec: range.bucketSec,
    });
});

/** One drawn candle, in percentages of the strip's own box. */
type MiniBar = {
    x: number;
    width: number;
    mid: number;
    bodyTop: number;
    bodyHeight: number;
    wickTop: number;
    wickHeight: number;
    up: boolean;
};

/**
 * The strip, as percentages rather than pixels.
 *
 * Hand-drawn and not the charting library: at 92px tall an axis, a crosshair
 * and a legend are illegible, and the library would be loaded to draw forty
 * rectangles. The full chart, where those controls have room, is the markets
 * screen's job.
 */
const miniBars = computed<MiniBar[]>(() => {
    const rows = candles.value;

    if (rows.length === 0) {
        return [];
    }

    let low = Infinity;
    let high = -Infinity;

    for (const candle of rows) {
        low = Math.min(low, candle.low);
        high = Math.max(high, candle.high);
    }

    // A pair that never moved has no span to scale by; it is drawn as a line
    // through the middle rather than divided by zero.
    const span = high - low > 0 ? high - low : 0;
    const slot = 100 / rows.length;
    const width = Math.max(slot * 0.62, 0.3);
    const y = (value: number): number =>
        span === 0 ? 50 : ((high - value) / span) * 100;

    return rows.map((candle, index) => {
        const x = index * slot + (slot - width) / 2;
        const top = y(Math.max(candle.open, candle.close));
        const bottom = y(Math.min(candle.open, candle.close));
        const wickTop = y(candle.high);

        return {
            x,
            width,
            mid: x + width / 2,
            bodyTop: top,
            // Two percent of 92px is about two device pixels: a doji has to
            // stay visible as a mark rather than thin out into the grid.
            bodyHeight: Math.max(bottom - top, 2),
            wickTop,
            wickHeight: Math.max(y(candle.low) - wickTop, 1),
            up: candle.close >= candle.open,
        };
    });
});

/** Move over the drawn window, in percent, or null when there is none. */
const historyChangePct = computed<number | null>(() => {
    const rows = candles.value;

    if (rows.length < 2 || rows[0].open <= 0) {
        return null;
    }

    return ((rows[rows.length - 1].close - rows[0].open) / rows[0].open) * 100;
});

/** What the strip is a strip of: the network and how far the route walks. */
const venueLine = computed(() => {
    const hops = Math.max((quote.value?.path.length ?? 2) - 1, 1);

    return t('swapVenue', { chain: chain.value.label, hops });
});

/* --------------------------------------------------------- alternatives -- */

/**
 * The routes this trade was chosen over, priced in the output asset.
 *
 * They cost nothing — the quote priced every candidate and kept the losers —
 * and they are the only way the screen can say "this is the best of several"
 * instead of asserting one path as though it were the only one there is.
 */
const alternatives = computed(() => {
    const current = quote.value;
    const asset = receiveAsset.value;

    if (current === null || asset === null) {
        return [];
    }

    return current.alternatives.map((route) => ({
        key: route.path.join('>'),
        symbols: symbolsOf(route.path),
        out: formatUnits(route.amountOut, asset.decimals, 6),
        /** How much worse than the winner, in percent. */
        worsePct:
            current.amountOut > 0n
                ? Number(
                      ((current.amountOut - route.amountOut) * 10_000n) /
                          current.amountOut,
                  ) / 100
                : null,
    }));
});

/* --------------------------------------------------------------- lines --- */

/** "1 CYBER ≈ 0.42 USDC", the one number a trader reads first. */
const rateLine = computed(() => {
    if (mode.value === 'wrap') {
        return `1 ${payAsset.value.symbol} = 1 ${receiveAsset.value?.symbol ?? ''}`;
    }

    if (rate.value === null || receiveAsset.value === null) {
        return '—';
    }

    return `1 ${payAsset.value.symbol} ≈ ${rate.value.toLocaleString(
        locale.value,
        { maximumSignificantDigits: 6 },
    )} ${receiveAsset.value.symbol}`;
});

/** The inverse, which is the same fact read from the other side of the trade. */
const inverseLine = computed(() => {
    if (
        rate.value === null ||
        rate.value === 0 ||
        receiveAsset.value === null
    ) {
        return '—';
    }

    return `1 ${receiveAsset.value.symbol} ≈ ${(1 / rate.value).toLocaleString(
        locale.value,
        { maximumSignificantDigits: 6 },
    )} ${payAsset.value.symbol}`;
});

/** Fee and impact in one line under the form, where a summary belongs. */
const summaryLine = computed(() => {
    const cost =
        fee.value === null
            ? '—'
            : `${formatUnits(fee.value, chain.value.decimals, 6)} ${chain.value.symbol}`;

    return mode.value === 'wrap' || impact.value === null
        ? t('swapSummaryFee', { fee: cost })
        : t('swapSummary', { fee: cost, impact: impact.value.toFixed(2) });
});

const assetKind = (asset: SwapAsset | null): string =>
    asset === null
        ? ''
        : asset.address === null
          ? t('swapKindCoin', { chain: chain.value.label })
          : t('swapKindToken', { chain: chain.value.label });

onMounted(() => {
    void dailyBoardCached().then((board) => {
        daily.value = board;
    });
});

watch([amount, from, to, slippageBps, mode, direction], scheduleQuote);
</script>

<template>
    <div v-if="account" class="cw-stack cw-screen">
        <!-- ------------------------------------------------------ compose --- -->
        <template v-if="phase !== 'status'">
            <button type="button" class="cw-back" @click="emit('back')">
                ← {{ t('back') }}
            </button>

            <!--
              The screen names itself and says what it is for, the way the rest
              of the wallet's places do. The link out is Markets and not a
              chart: the strip below is this *pair*, and the full charts are
              per asset against the dollar — two different questions, and a
              button that pretended otherwise would open the wrong one.
            -->
            <div
                style="
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                    gap: 12px;
                    margin: 22px 0 6px;
                "
            >
                <h2 class="cw-title" style="margin: 0">{{ t('swapTitle') }}</h2>
                <button
                    type="button"
                    class="cw-back"
                    style="flex: none; color: var(--cw-accent)"
                    @click="emit('markets')"
                >
                    {{ t('markets') }} →
                </button>
            </div>
            <div class="cw-label" style="color: var(--cw-dim)">
                {{ t('swapEyebrow') }}
            </div>

            <div
                v-if="tradable.length > 1"
                class="cw-seg"
                style="margin: 16px 0"
            >
                <button
                    v-for="candidate in tradable"
                    :key="candidate.chain"
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="candidate.chain === chain.id"
                    @click="emit('pick', candidate.chain)"
                >
                    {{ candidate.label }}
                    <span
                        class="cw-seg-bar"
                        :style="{
                            background:
                                candidate.chain === chain.id
                                    ? candidate.mark.hue
                                    : 'transparent',
                        }"
                    />
                </button>
            </div>

            <!--
              No Cyberia exchange here. That used to end the screen; now it only
              decides who routes the trade. The old dead end survives for the
              case it was actually right about — a chain nobody routes at all.
            -->
            <WalletRouteSwap
                v-if="!dex && routable"
                :wallet="wallet"
                :chain="props.chain"
            />

            <!--
              Asked, and nobody routes this chain. The only one of the three
              states that is a fact about the network rather than about us.
            -->
            <template v-else-if="!dex && routerUnreachable">
                <p class="cw-note cw-note-warn" style="margin-top: 16px">
                    <span style="flex: 1">{{ t('swapRouterDown') }}</span>
                    <button
                        type="button"
                        class="cw-back"
                        @click="retryRouter()"
                    >
                        {{ t('retry') }}
                    </button>
                </p>
            </template>

            <template v-else-if="!dex">
                <p class="cw-note cw-note-warn" style="margin-top: 16px">
                    <span>{{ t('swapNoDex', { chain: chain.label }) }}</span>
                </p>
                <button
                    v-for="candidate in tradable"
                    :key="candidate.chain"
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="margin-top: 10px"
                    @click="emit('pick', candidate.chain)"
                >
                    {{ t('swapOnNetwork', { chain: candidate.label }) }}
                </button>
            </template>

            <template v-else>
                <!--
                  What this trade is worth beyond the trade. It is one line and
                  it links rather than explains: the board it comes from is a
                  screen of its own, and a swap composer is not the place to
                  argue about experience points.
                -->
                <button
                    v-if="dailyNote"
                    type="button"
                    class="cw-streak"
                    @click="emit('daily')"
                >
                    <span class="cw-streak-chip">{{ streakChip }}</span>
                    <span class="cw-streak-text">{{ dailyNote }}</span>
                    <span class="cw-streak-go">→</span>
                </button>

                <div class="cw-seg" style="margin-bottom: 16px">
                    <button
                        type="button"
                        class="cw-seg-item"
                        :aria-pressed="mode === 'swap'"
                        @click="mode = 'swap'"
                    >
                        {{ t('swapTab') }}
                        <span
                            class="cw-seg-bar"
                            :style="{
                                background:
                                    mode === 'swap'
                                        ? chain.mark.hue
                                        : 'transparent',
                            }"
                        />
                    </button>
                    <button
                        type="button"
                        class="cw-seg-item"
                        :aria-pressed="mode === 'wrap'"
                        @click="mode = 'wrap'"
                    >
                        {{ t('wrapTab') }}
                        <span
                            class="cw-seg-bar"
                            :style="{
                                background:
                                    mode === 'wrap'
                                        ? chain.mark.hue
                                        : 'transparent',
                            }"
                        />
                    </button>
                </div>

                <p v-if="!canSign" class="cw-note cw-note-warn">
                    <span>{{ t('swapWatchOnly') }}</span>
                </p>

                <p
                    v-if="mode === 'wrap' && !wrapped"
                    class="cw-note cw-note-warn"
                    style="margin-bottom: 16px"
                >
                    <span>{{ t('wrapUnavailable') }}</span>
                </p>

                <p
                    v-else-if="mode === 'wrap'"
                    class="cw-note"
                    style="margin-bottom: 16px"
                >
                    <span>{{
                        t('wrapBody', {
                            coin: chain.symbol,
                            wrapped: wrapped?.symbol ?? `W${chain.symbol}`,
                        })
                    }}</span>
                </p>

                <!--
                  The pair's own history, replayed out of the pools this trade
                  would walk. It appears only once there is one: a pair whose
                  pools have never traded draws nothing, because a flat line is
                  a claim about the price rather than about the data.
                -->
                <div
                    v-if="
                        mode === 'swap' &&
                        (historyLoading || miniBars.length > 0)
                    "
                    class="cw-card"
                    style="padding: 13px 14px 10px; margin-bottom: 12px"
                >
                    <div class="cw-row" style="align-items: baseline">
                        <span style="min-width: 0">
                            <span
                                style="
                                    display: block;
                                    font: 600 14px/1 var(--cw-sans);
                                "
                                >{{ payAsset.symbol }} /
                                {{ receiveAsset?.symbol ?? '—' }}</span
                            >
                            <span
                                class="cw-label"
                                style="
                                    display: block;
                                    margin-top: 6px;
                                    font-size: 9px;
                                    letter-spacing: 0.1em;
                                "
                                >{{ venueLine }}</span
                            >
                        </span>
                        <span style="flex: none; text-align: right">
                            <span
                                style="
                                    display: block;
                                    font: 500 17px/1 var(--cw-mono);
                                    color: var(--cw-bright);
                                "
                                >{{
                                    rate === null
                                        ? '—'
                                        : rate.toLocaleString(locale, {
                                              maximumSignificantDigits: 6,
                                          })
                                }}</span
                            >
                            <span
                                v-if="historyChangePct !== null"
                                style="
                                    display: block;
                                    margin-top: 6px;
                                    font: 400 10px/1 var(--cw-mono);
                                "
                                :style="{
                                    color:
                                        historyChangePct >= 0
                                            ? 'var(--cw-ok)'
                                            : 'var(--cw-bad-soft)',
                                }"
                                >{{ historyChangePct >= 0 ? '+' : ''
                                }}{{ historyChangePct.toFixed(2) }}%</span
                            >
                        </span>
                    </div>

                    <div class="cw-mini">
                        <p
                            v-if="historyLoading && miniBars.length === 0"
                            class="cw-mini-note"
                        >
                            {{ t('marketLoading') }}
                        </p>
                        <template v-else>
                            <template
                                v-for="(bar, index) in miniBars"
                                :key="index"
                            >
                                <span
                                    class="cw-mini-wick"
                                    :style="{
                                        left: `${bar.mid}%`,
                                        top: `${bar.wickTop}%`,
                                        height: `${bar.wickHeight}%`,
                                        background: bar.up
                                            ? 'var(--cw-ok)'
                                            : 'var(--cw-bad)',
                                    }"
                                />
                                <span
                                    class="cw-mini-body"
                                    :style="{
                                        left: `${bar.x}%`,
                                        width: `${bar.width}%`,
                                        top: `${bar.bodyTop}%`,
                                        height: `${bar.bodyHeight}%`,
                                        background: bar.up
                                            ? 'var(--cw-ok)'
                                            : 'var(--cw-bad)',
                                    }"
                                />
                            </template>
                        </template>
                    </div>

                    <div class="cw-row">
                        <div style="display: flex; gap: 2px">
                            <button
                                v-for="range in MARKET_RANGES"
                                :key="range.key"
                                type="button"
                                class="cw-tf"
                                :aria-pressed="rangeKey === range.key"
                                @click="
                                    rangeKey = range.key;
                                    rangePinned = true;
                                "
                            >
                                {{ range.label }}
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Pay -->
                <div
                    class="cw-card"
                    style="padding: 14px 15px"
                    :style="
                        shortfall !== null
                            ? { borderColor: 'var(--cw-bad)' }
                            : undefined
                    "
                >
                    <div class="cw-row" style="margin-bottom: 10px">
                        <span class="cw-label">{{ t('swapPay') }}</span>
                        <span
                            style="
                                display: flex;
                                align-items: center;
                                gap: 8px;
                                flex: none;
                            "
                        >
                            <span
                                style="
                                    font: 400 10px/1 var(--cw-mono);
                                    color: var(--cw-dim);
                                "
                                >{{
                                    payBalance === null
                                        ? '—'
                                        : formatUnits(
                                              payBalance,
                                              payAsset.decimals,
                                              6,
                                          )
                                }}
                                {{ payAsset.symbol }}</span
                            >
                            <button
                                type="button"
                                class="cw-ghost"
                                style="
                                    min-height: 28px;
                                    padding: 0 8px;
                                    border-color: transparent;
                                    color: var(--cw-accent);
                                "
                                :disabled="
                                    payBalance === null ||
                                    (payAsset.address === null &&
                                        gasPrice === null)
                                "
                                @click="setMax"
                            >
                                {{ t('max') }}
                            </button>
                        </span>
                    </div>

                    <div style="display: flex; align-items: center; gap: 12px">
                        <button
                            type="button"
                            class="cw-chip cw-chip-tight"
                            :disabled="mode === 'wrap'"
                            @click="picking = 'pay'"
                        >
                            <NetworkMark :chain="chain.id" dot :size="8" />
                            <span style="min-width: 0">
                                <span class="cw-chip-net">{{
                                    payAsset.symbol
                                }}</span>
                                <span class="cw-chip-sub">{{
                                    chain.label
                                }}</span>
                            </span>
                            <span v-if="mode !== 'wrap'" class="cw-chip-chev"
                                >⌄</span
                            >
                        </button>
                        <input
                            v-model="amount"
                            type="text"
                            inputmode="decimal"
                            placeholder="0.00"
                            :aria-label="t('amount')"
                            class="cw-amount"
                        />
                    </div>

                    <div class="cw-row" style="margin-top: 9px">
                        <span
                            style="
                                font: 400 9px/1 var(--cw-mono);
                                color: var(--cw-faint);
                            "
                            >{{ assetKind(payAsset) }}</span
                        >
                        <span
                            style="
                                font: 400 10px/1 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                            >{{
                                formatUsd(
                                    usdValue(
                                        amountUnits,
                                        payAsset.decimals,
                                        priceOf(payAsset),
                                    ),
                                    locale,
                                )
                            }}</span
                        >
                    </div>
                </div>

                <!--
                  The flip sits *between* the two cards rather than under them:
                  it is the one control that acts on both, and a gap with a
                  button in it is how that reads without a label.
                -->
                <div class="cw-flip-row">
                    <button
                        type="button"
                        class="cw-flip"
                        :aria-label="t('swapFlip')"
                        @click="flip"
                    >
                        <ArrowDownUp :size="14" aria-hidden="true" />
                    </button>
                </div>

                <!-- Receive -->
                <div class="cw-card" style="padding: 14px 15px">
                    <div class="cw-row" style="margin-bottom: 10px">
                        <span class="cw-label">{{ t('swapReceive') }}</span>
                        <span
                            style="
                                font: 400 10px/1 var(--cw-mono);
                                color: var(--cw-dim);
                                flex: none;
                            "
                            >{{
                                balanceOf(receiveAsset) === null
                                    ? '—'
                                    : formatUnits(
                                          balanceOf(receiveAsset)!,
                                          receiveAsset?.decimals ?? 18,
                                          6,
                                      )
                            }}
                            {{ receiveAsset?.symbol ?? '' }}</span
                        >
                    </div>

                    <div style="display: flex; align-items: center; gap: 12px">
                        <button
                            type="button"
                            class="cw-chip cw-chip-tight"
                            :disabled="mode === 'wrap'"
                            @click="picking = 'receive'"
                        >
                            <NetworkMark :chain="chain.id" dot :size="8" />
                            <span style="min-width: 0">
                                <span class="cw-chip-net">{{
                                    receiveAsset?.symbol ?? t('swapPick')
                                }}</span>
                                <span class="cw-chip-sub">{{
                                    chain.label
                                }}</span>
                            </span>
                            <span v-if="mode !== 'wrap'" class="cw-chip-chev"
                                >⌄</span
                            >
                        </button>
                        <span class="cw-amount cw-amount-out">{{
                            receiveUnits === null || receiveAsset === null
                                ? quoting
                                    ? '…'
                                    : '0.00'
                                : formatUnits(
                                      receiveUnits,
                                      receiveAsset.decimals,
                                      8,
                                  )
                        }}</span>
                    </div>

                    <div class="cw-row" style="margin-top: 9px">
                        <span
                            style="
                                font: 400 9px/1 var(--cw-mono);
                                color: var(--cw-faint);
                            "
                            >{{ assetKind(receiveAsset) }}</span
                        >
                        <span
                            style="
                                font: 400 10px/1 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                            >{{
                                formatUsd(
                                    usdValue(
                                        receiveUnits,
                                        receiveAsset?.decimals ?? 18,
                                        priceOf(receiveAsset),
                                    ),
                                    locale,
                                )
                            }}</span
                        >
                    </div>
                </div>

                <!-- The rate on the left, what it costs on the right. -->
                <div
                    class="cw-row"
                    style="
                        gap: 12px;
                        padding: 12px 2px;
                        align-items: flex-start;
                    "
                >
                    <span
                        style="
                            font: 400 11px/1.4 var(--cw-mono);
                            color: var(--cw-muted);
                        "
                        >{{ rateLine }}</span
                    >
                    <span
                        style="
                            font: 400 10px/1.4 var(--cw-mono);
                            color: var(--cw-faint);
                            text-align: right;
                            flex: none;
                        "
                        >{{ summaryLine }}</span
                    >
                </div>

                <!--
                  An allowance is a second transaction and the user's coin pays
                  for it. It is said before the hold, not discovered after it.
                -->
                <p v-if="quote?.approval" class="cw-note">
                    <span>{{
                        t(
                            quote.approval.reset
                                ? 'swapApprovalReset'
                                : 'swapApproval',
                            { symbol: payAsset.symbol },
                        )
                    }}</span>
                </p>

                <p
                    v-if="impactHigh"
                    class="cw-note cw-note-warn"
                    style="margin-top: 12px"
                >
                    <span>{{
                        t('swapImpactWarn', {
                            impact: (impact ?? 0).toFixed(2),
                        })
                    }}</span>
                </p>

                <p
                    v-if="shortfall !== null"
                    class="cw-note cw-note-bad"
                    style="margin-top: 12px"
                >
                    <span>
                        <strong style="display: block">{{
                            t('insufficientTitle')
                        }}</strong>
                        {{
                            t('insufficientBody', {
                                amount: formatUnits(
                                    shortfall,
                                    payAsset.decimals,
                                    8,
                                ),
                                symbol: payAsset.symbol,
                            })
                        }}
                    </span>
                </p>

                <p
                    v-if="gasShortfall !== null"
                    class="cw-note cw-note-bad"
                    style="margin-top: 12px"
                >
                    <span>
                        <strong style="display: block">{{
                            t('insufficientGasTitle', { gas: chain.symbol })
                        }}</strong>
                        {{
                            t('insufficientGasBody', {
                                amount: formatUnits(
                                    gasShortfall,
                                    chain.decimals,
                                    8,
                                ),
                                gas: chain.symbol,
                                symbol: payAsset.symbol,
                            })
                        }}
                    </span>
                </p>

                <!-- The station pays fees on Cyberia; silent everywhere else. -->
                <GasSponsor
                    :chain="props.chain"
                    :address="account?.address"
                    :fee="fee"
                    :gas-balance="nativeBalance"
                    :symbol="chain.symbol"
                    :decimals="chain.decimals"
                    @funded="onFunded"
                />

                <p
                    v-if="failure"
                    class="cw-note cw-note-bad"
                    style="margin-top: 12px"
                >
                    <span>{{ failure }}</span>
                    <button
                        type="button"
                        class="cw-back"
                        style="color: inherit"
                        :aria-label="t('retry')"
                        @click="retryQuote"
                    >
                        <RefreshCw :size="14" aria-hidden="true" />
                    </button>
                </p>

                <div
                    style="
                        margin-top: 14px;
                        padding: 14px 16px;
                        border: 1px solid var(--cw-line-strong);
                        background: var(--cw-surface);
                    "
                >
                    <div
                        class="cw-label"
                        style="margin-bottom: 9px; color: var(--cw-meta)"
                    >
                        {{ t('youWillSign') }}
                    </div>
                    <p
                        style="
                            margin: 0;
                            font: 400 13px/1.65 var(--cw-sans);
                            color: var(--cw-body);
                            text-wrap: pretty;
                        "
                    >
                        {{ sentence }}
                    </p>
                </div>

                <button
                    type="button"
                    class="cw-btn cw-btn-primary cw-btn-tall"
                    style="margin-top: 16px"
                    :disabled="!ready || quoting"
                    @click="review()"
                >
                    {{ quoting ? t('swapQuoting') : t('swapReview') }}
                </button>

                <div
                    v-if="mode === 'swap' && swapXp !== null"
                    style="
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 8px;
                        padding: 11px 0 4px;
                    "
                >
                    <span
                        style="
                            font: 500 10px/1 var(--cw-mono);
                            letter-spacing: 0.14em;
                            color: var(--cw-accent);
                        "
                        >+{{ swapXp }} XP</span
                    >
                    <span
                        style="
                            font: 400 10px/1 var(--cw-mono);
                            color: var(--cw-dim);
                        "
                        >·</span
                    >
                    <span
                        style="
                            font: 400 11px/1.4 var(--cw-sans);
                            color: var(--cw-muted);
                        "
                        >{{ t('swapXpNote') }}</span
                    >
                </div>

                <!--
                  Everything a trade has that a trade does not need to be made.
                  Folded away by default and not removed: the route, the routes
                  it beat, the slippage and the floor are the four things
                  somebody argues with afterwards, so they are all here and all
                  reading the same quote.
                -->
                <button
                    type="button"
                    class="cw-adv"
                    :aria-expanded="adv"
                    @click="adv = !adv"
                >
                    <span>{{ t('swapAdvanced') }}</span>
                    <span>{{ adv ? '−' : '+' }}</span>
                </button>

                <template v-if="adv">
                    <div
                        v-if="mode === 'swap'"
                        class="cw-card"
                        style="margin-top: 8px; padding: 0"
                    >
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{ t('swapRoute') }}</span>
                            <span
                                class="cw-kv-val"
                                style="
                                    font-weight: 400;
                                    max-width: 220px;
                                    overflow-wrap: anywhere;
                                    text-align: right;
                                "
                                >{{ routeSymbols.join(' → ') }}</span
                            >
                        </div>
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{ t('swapMinOut') }}</span>
                            <span class="cw-kv-val" style="font-weight: 400"
                                >{{
                                    quote && receiveAsset
                                        ? formatUnits(
                                              quote.minOut,
                                              receiveAsset.decimals,
                                              8,
                                          )
                                        : '—'
                                }}
                                {{ receiveAsset?.symbol }}</span
                            >
                        </div>
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{ t('swapImpact') }}</span>
                            <span
                                class="cw-kv-val"
                                style="font-weight: 400"
                                :style="{
                                    color: impactHigh
                                        ? 'var(--cw-bad-soft)'
                                        : undefined,
                                }"
                                >{{
                                    impact === null
                                        ? '—'
                                        : `${impact.toFixed(2)}%`
                                }}</span
                            >
                        </div>
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{
                                t('swapInverse')
                            }}</span>
                            <span
                                class="cw-kv-val"
                                style="font-weight: 400; color: var(--cw-muted)"
                                >{{ inverseLine }}</span
                            >
                        </div>
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{ t('kFee') }}</span>
                            <span class="cw-kv-val" style="font-weight: 400"
                                >{{
                                    fee === null
                                        ? '—'
                                        : formatUnits(fee, chain.decimals, 8)
                                }}
                                {{ chain.symbol }}</span
                            >
                        </div>
                    </div>

                    <!--
                      What the route beat. These were priced by the same search
                      and thrown away; showing them is the only way this screen
                      can say "the best of several" rather than assert one path.
                    -->
                    <template v-if="mode === 'swap' && alternatives.length > 0">
                        <div
                            class="cw-label"
                            style="margin: 18px 0 9px; color: var(--cw-dim)"
                        >
                            {{ t('swapAlternatives') }}
                        </div>
                        <div
                            style="
                                display: flex;
                                flex-direction: column;
                                gap: 7px;
                            "
                        >
                            <div
                                v-for="route in alternatives"
                                :key="route.key"
                                class="cw-card"
                                style="
                                    display: flex;
                                    align-items: center;
                                    gap: 11px;
                                    padding: 12px 14px;
                                "
                            >
                                <span style="flex: 1; min-width: 0">
                                    <span
                                        style="
                                            display: block;
                                            font: 500 11px/1.4 var(--cw-mono);
                                            overflow-wrap: anywhere;
                                        "
                                        >{{ route.symbols.join(' → ') }}</span
                                    >
                                    <span
                                        v-if="route.worsePct !== null"
                                        style="
                                            display: block;
                                            margin-top: 5px;
                                            font: 400 10px/1 var(--cw-mono);
                                            color: var(--cw-dim);
                                        "
                                        >{{
                                            t('swapWorseBy', {
                                                pct: route.worsePct.toFixed(2),
                                            })
                                        }}</span
                                    >
                                </span>
                                <span
                                    style="
                                        flex: none;
                                        font: 400 11px/1 var(--cw-mono);
                                        color: var(--cw-body);
                                    "
                                    >{{ route.out }}</span
                                >
                            </div>
                        </div>
                    </template>

                    <!-- Slippage: a swap has one, a wrap cannot have one. -->
                    <template v-if="mode === 'swap'">
                        <div class="cw-row" style="margin: 18px 0 8px">
                            <span class="cw-label">{{
                                t('swapSlippage')
                            }}</span>
                            <span
                                style="
                                    font: 400 11px/1 var(--cw-mono);
                                    color: var(--cw-dim);
                                "
                                >{{ (slippageBps / 100).toFixed(2) }}%</span
                            >
                        </div>
                        <div class="cw-seg">
                            <button
                                v-for="option in [10, 50, 100, 300]"
                                :key="option"
                                type="button"
                                class="cw-seg-item"
                                :aria-pressed="slippageBps === option"
                                @click="slippageBps = option"
                            >
                                {{
                                    (option / 100).toFixed(
                                        option < 100 ? 1 : 0,
                                    )
                                }}%
                                <span
                                    class="cw-seg-bar"
                                    :style="{
                                        background:
                                            slippageBps === option
                                                ? chain.mark.hue
                                                : 'transparent',
                                    }"
                                />
                            </button>
                        </div>
                    </template>

                    <div
                        v-else
                        class="cw-card"
                        style="margin-top: 8px; padding: 0"
                    >
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{ t('swapRate') }}</span>
                            <span class="cw-kv-val">1 : 1</span>
                        </div>
                        <div class="cw-kv">
                            <span class="cw-kv-key">{{ t('kFee') }}</span>
                            <span class="cw-kv-val" style="font-weight: 400"
                                >{{
                                    fee === null
                                        ? '—'
                                        : formatUnits(fee, chain.decimals, 8)
                                }}
                                {{ chain.symbol }}</span
                            >
                        </div>
                    </div>
                </template>

                <div class="cw-fill" style="min-height: 12px"></div>
            </template>
        </template>

        <!-- ------------------------------------------------------ outcome --- -->
        <template v-else>
            <div style="display: flex; justify-content: flex-end">
                <button
                    type="button"
                    class="cw-icon-btn"
                    style="border: none"
                    :aria-label="t('backToPortfolio')"
                    @click="emit('back')"
                >
                    ✕
                </button>
            </div>
            <div
                class="cw-stack"
                style="
                    flex: 1;
                    align-items: center;
                    justify-content: center;
                    text-align: center;
                    padding-bottom: 40px;
                "
            >
                <component
                    :is="OUTCOMES[outcome].icon"
                    :size="44"
                    aria-hidden="true"
                    :style="{
                        color:
                            outcome === 'confirmed'
                                ? 'var(--cw-ok)'
                                : outcome === 'failed'
                                  ? 'var(--cw-bad)'
                                  : 'var(--cw-accent)',
                    }"
                />
                <h2 class="cw-title" style="margin: 18px 0 8px">
                    {{ t(`swapOutcome_${outcome}`) }}
                </h2>
                <p class="cw-prose" style="max-width: 42ch">
                    {{
                        failure ??
                        t(`swapOutcomeBody_${outcome}`, {
                            from: payAsset.symbol,
                            to: receiveAsset?.symbol ?? '—',
                        })
                    }}
                </p>
            </div>

            <div class="cw-stack" style="gap: 8px">
                <button
                    v-if="outcome === 'failed'"
                    type="button"
                    class="cw-btn cw-btn-primary"
                    @click="reset"
                >
                    {{ t('adjustRetry') }}
                </button>
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    @click="emit('back')"
                >
                    {{ t('backToPortfolio') }}
                </button>
                <a
                    v-if="hash && dex"
                    :href="swapTxUrl(dex, hash)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="cw-ghost"
                    style="width: 100%; text-decoration: none"
                >
                    {{ t('viewInExplorer') }} ↗
                </a>
                <a
                    v-if="approvalHash && dex"
                    :href="swapTxUrl(dex, approvalHash)"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="cw-ghost"
                    style="width: 100%; text-decoration: none"
                >
                    {{ t('swapApprovalTx') }} ↗
                </a>
            </div>
        </template>

        <!-- ------------------------------------------------- asset picker --- -->
        <div v-if="picking !== null" class="cw-sheet">
            <div class="cw-sheet-panel">
                <div class="cw-row" style="margin-bottom: 14px">
                    <h3 class="cw-title" style="font-size: 17px">
                        {{ t('swapPickAsset') }}
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
                        @click="chooseToken(picking!, row.asset)"
                    >
                        <span style="text-align: left">
                            <span
                                style="
                                    display: block;
                                    font: 500 13px/1.2 var(--cw-mono);
                                    color: var(--cw-text);
                                "
                                >{{ row.asset.symbol }}</span
                            >
                            <span
                                v-if="row.asset.address"
                                style="
                                    display: block;
                                    margin-top: 3px;
                                    font: 400 10px/1 var(--cw-mono);
                                    color: var(--cw-faint);
                                "
                                >{{ shortAddress(row.asset.address) }}</span
                            >
                        </span>
                        <span
                            style="
                                font: 400 11px/1 var(--cw-mono);
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
                <p class="cw-note" style="margin-top: 12px">
                    <span>{{ t('swapByAddressNote') }}</span>
                </p>
            </div>
        </div>

        <!-- ------------------------------------------------- review sheet --- -->
        <div v-if="phase === 'review'" class="cw-sheet">
            <div class="cw-sheet-panel">
                <div
                    style="
                        width: 36px;
                        height: 3px;
                        margin: 0 auto 20px;
                        border-radius: 2px;
                        background: var(--cw-border);
                    "
                ></div>
                <div class="cw-row" style="margin-bottom: 6px">
                    <h3
                        class="cw-title"
                        style="font-size: 19px; line-height: 1.2"
                    >
                        {{ t('confirmTransaction') }}
                    </h3>
                    <button
                        type="button"
                        class="cw-icon-btn"
                        style="border: none"
                        :aria-label="t('cancel')"
                        @click="phase = 'compose'"
                    >
                        ✕
                    </button>
                </div>

                <div style="border: 1px solid var(--cw-hairline)">
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('kNetwork') }}</span>
                        <span
                            class="cw-kv-val"
                            style="display: flex; align-items: center; gap: 8px"
                        >
                            <NetworkMark :chain="chain.id" dot :size="6" />
                            {{ chain.label }}
                        </span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('swapPay') }}</span>
                        <span class="cw-kv-val"
                            >{{ amount }} {{ payAsset.symbol }}</span
                        >
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{
                            mode === 'wrap' ? t('swapReceive') : t('swapMinOut')
                        }}</span>
                        <span class="cw-kv-val"
                            >{{
                                mode === 'wrap'
                                    ? amount
                                    : quote && receiveAsset
                                      ? formatUnits(
                                            quote.minOut,
                                            receiveAsset.decimals,
                                            8,
                                        )
                                      : '—'
                            }}
                            {{ receiveAsset?.symbol }}</span
                        >
                    </div>
                    <div v-if="mode === 'swap'" class="cw-kv">
                        <span class="cw-kv-key">{{ t('swapRoute') }}</span>
                        <span
                            class="cw-kv-val"
                            style="
                                font-weight: 400;
                                max-width: 220px;
                                overflow-wrap: anywhere;
                                text-align: right;
                            "
                            >{{ routeSymbols.join(' → ') }}</span
                        >
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('kFee') }}</span>
                        <span class="cw-kv-val" style="font-weight: 400"
                            >{{
                                fee === null
                                    ? '—'
                                    : formatUnits(fee, chain.decimals, 8)
                            }}
                            {{ chain.symbol }}</span
                        >
                    </div>
                </div>

                <div
                    style="
                        margin-top: 14px;
                        padding: 13px 14px;
                        border: 1px solid #1b2126;
                        background: #080a0c;
                    "
                >
                    <div
                        class="cw-label"
                        style="margin-bottom: 8px; color: var(--cw-meta)"
                    >
                        {{ t('plainLanguage') }}
                    </div>
                    <p
                        style="
                            margin: 0;
                            font: 400 12px/1.6 var(--cw-sans);
                            color: #b6bec6;
                        "
                    >
                        {{ sentence }}
                    </p>
                </div>

                <div style="margin-top: 18px">
                    <HoldButton
                        :label="t('holdToSign')"
                        :disabled="wallet.busy.value || !ready"
                        @complete="sign"
                    />
                </div>
                <button
                    type="button"
                    class="cw-ghost"
                    style="width: 100%; margin-top: 8px; border: none"
                    @click="phase = 'compose'"
                >
                    {{ t('cancel') }}
                </button>
            </div>
        </div>
    </div>
</template>
