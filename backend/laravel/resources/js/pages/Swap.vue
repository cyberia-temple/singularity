<script setup lang="ts">
import { Head, usePage } from '@inertiajs/vue3';
import type { BrowserProvider } from 'ethers';
import {
    Contract,
    JsonRpcProvider,
    MaxUint256,
    formatUnits,
    parseUnits,
} from 'ethers';
import { BrowserProvider as EthersBrowserProvider } from 'ethers';
import { ArrowDownUp, Loader2 } from 'lucide-vue-next';
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    watch,
} from 'vue';
import MarketCandlesChart from '@/components/dex/MarketCandlesChart.vue';
import TokenIcon from '@/components/TokenIcon.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { useAppearance } from '@/composables/useAppearance';
import { useWallet } from '@/composables/useWallet';
import {
    KNOWN_TOKENS,
    USDC_ADDRESS,
    filterJunkPools,
} from '@/lib/cyberiaTokens';
import type { AprSnapshot } from '@/lib/dexApr';
import { aprByPair, formatApr } from '@/lib/dexApr';
import { formatNum, formatPrice } from '@/lib/dexFormat';
import type { V3Route } from '@/lib/dexV3';
import {
    v3BestRoute,
    v3BestRouteExactOut,
    v3AfterFee,
    v3IntegratorFee,
    v3RouteFeePct,
    v3Swap,
} from '@/lib/dexV3';
import { ensureEvmChain } from '@/lib/evmChains';
import { getSelectedEvmProvider } from '@/lib/evmProvider';
import {
    DEFAULT_LIQUIDITY_CHAIN_ID as DEFAULT_DEX_CHAIN_ID,
    LIQUIDITY_CHAINS as DEX_CHAINS,
    liquidityChainById as dexChainById,
} from '@/lib/liquidityChains';
import type { LiquidityChainConfig as DexChainConfig } from '@/lib/liquidityChains';
import {
    MARKET_RANGES,
    autoRangeKey,
    buildCandles,
    loadMarketHistory,
    marketRange,
    routePrice,
} from '@/lib/marketCandles';
import type {
    MarketCandle,
    MarketHistory,
    Reserves,
    RouteHop,
} from '@/lib/marketCandles';
import { logoForToken } from '@/lib/tokenLogos';
import { track } from '@/lib/track';
import { walletChains } from '@/lib/wallet/chains';
import type { WalletChainId } from '@/lib/wallet/chains';
import type { DexPair } from '@/lib/wallet/dexscreener';
import {
    dexScreenerChartUrl,
    fetchDexPairs,
    pairPoolFor,
} from '@/lib/wallet/dexscreener';

// Router/factory/wrapped-native/pools are per-chain (DEX_CHAINS); the page
// reads, quotes and swaps entirely within the wallet's chain, so Robinhood
// swaps never touch Cyberia liquidity.
// Sentinel for the native coin in the token pickers (maps to the chain's
// wrapped-native token on-chain).
const NATIVE = 'NATIVE';
const DAY_SEC = 24 * 60 * 60;

const ROUTER_ABI = [
    'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
    'function getAmountsIn(uint amountOut, address[] path) view returns (uint[] amounts)',
    'function swapExactTokensForTokens(uint amountIn,uint amountOutMin,address[] path,address to,uint deadline) returns (uint[])',
    'function swapTokensForExactTokens(uint amountOut,uint amountInMax,address[] path,address to,uint deadline) returns (uint[])',
    'function swapExactETHForTokens(uint amountOutMin,address[] path,address to,uint deadline) payable returns (uint[])',
    'function swapETHForExactTokens(uint amountOut,address[] path,address to,uint deadline) payable returns (uint[])',
    'function swapExactTokensForETH(uint amountIn,uint amountOutMin,address[] path,address to,uint deadline) returns (uint[])',
    'function swapTokensForExactETH(uint amountOut,uint amountInMax,address[] path,address to,uint deadline) returns (uint[])',
];

// The live factory pair list backs routing when the indexer table lags.
const FACTORY_ABI = [
    'function allPairsLength() view returns (uint256)',
    'function allPairs(uint256) view returns (address)',
];
const PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
];

type Token = { address: string; symbol: string; native?: boolean };
type PoolRow = {
    pair_address: string;
    token0: string;
    token1: string;
    symbol0: string;
    symbol1: string;
    reserve0: number;
    reserve1: number;
    tvl_usd: number | null;
    updated_at?: string | null;
};

type DailyRow = {
    day: string;
    swap_usd: number;
    swaps: number;
};

const props = defineProps<{
    pools: PoolRow[];
    daily: DailyRow[];
    indexerReady: boolean;
    apr?: AprSnapshot | null;
}>();

const aprMap = computed(() => aprByPair(props.apr));
const poolApr = (pairAddress?: string | null): number | null =>
    pairAddress
        ? (aprMap.value.get(pairAddress.toLowerCase())?.apr ?? null)
        : null;

const wallet = useWallet();
const { resolvedAppearance } = useAppearance();
const page = usePage();
const authUser = computed(
    () =>
        page.props.auth?.user as { wallet_address?: string | null } | undefined,
);

/**
 * Whether the person reading this runs the place.
 *
 * The same flag the console gate shares on every page, reused rather than
 * re-derived: there is one definition of who the operators are and it lives in
 * `config/crm.php`.
 *
 * It hides the *itemised* fee line and nothing else. Every number that decides
 * the trade stays exactly as true for everyone: the output shown is already net
 * of the fee, and so is the minimum received — this only stops the breakdown
 * being printed beside them.
 */
const operator = computed(() => page.props.auth?.canAccessCrm === true);

const status = ref<string | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const slippage = ref('0.5');

// The active DEX chain follows the wallet's network when it is a known DEX
// chain, else the default (Cyberia). A chain tab lets users browse another
// chain's markets read-only; swapping prompts a network switch.
const activeChainId = ref<number>(DEFAULT_DEX_CHAIN_ID);
const activeChain = computed<DexChainConfig>(() =>
    dexChainById(activeChainId.value),
);

const makeReadProvider = (cfg: DexChainConfig): JsonRpcProvider =>
    new JsonRpcProvider(
        cfg.readRpcUrl,
        { chainId: cfg.chainId, name: cfg.evmChain.name },
        // Cyberia's RPC caps JSON-RPC batches at 20; path quoting and pair
        // enumeration fan out well past that, so let ethers split reads.
        { batchMaxCount: 20 },
    );

let readProvider = makeReadProvider(dexChainById(DEFAULT_DEX_CHAIN_ID));
let readRouter = new Contract(
    dexChainById(DEFAULT_DEX_CHAIN_ID).router,
    ROUTER_ABI,
    readProvider,
);

// Switch the wallet to the active DEX chain (adding it when unknown) and hand
// back a signer-capable provider. Swapping on another chain first prompts a
// network switch.
async function ensureActiveNetwork(): Promise<EthersBrowserProvider> {
    const eth = getSelectedEvmProvider();

    if (!eth) {
        throw new Error('EVM wallet not found');
    }

    await ensureEvmChain(eth, activeChain.value.evmChain);

    return new EthersBrowserProvider(eth);
}

const shortAddr = (a: string): string =>
    a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const slippageBps = computed(() => {
    const v = Math.round(Number(slippage.value || '0') * 100);

    return Number.isFinite(v) && v >= 0 && v < 5000 ? v : 50;
});
const deadline = (): bigint => BigInt(Math.floor(Date.now() / 1000) + 1200);
const resolveAddr = (a: string): string =>
    a === NATIVE ? activeChain.value.wrappedNative : a;

const cleanPools = computed(() => filterJunkPools(props.pools ?? []));
// Direct-pair address resolved on-chain when dex_pools lags (display only).
const livePairAddress = ref<string | null>(null);
const maxDailyUsd = computed(() =>
    Math.max(1, ...props.daily.map((d) => Number(d.swap_usd) || 0)),
);
const topPools = computed(() =>
    cleanPools.value
        .filter((p) => Number(p.reserve0) > 0 && Number(p.reserve1) > 0)
        .slice()
        .sort((a, b) => Number(b.tvl_usd ?? 0) - Number(a.tvl_usd ?? 0))
        .slice(0, 8),
);

const selectedPool = computed(() => {
    if (!tokenIn.value || !tokenOut.value || tokenIn.value === tokenOut.value) {
        return null;
    }

    const a = resolveAddr(tokenIn.value).toLowerCase();
    const b = resolveAddr(tokenOut.value).toLowerCase();

    return (
        cleanPools.value.find((p) => {
            const t0 = p.token0.toLowerCase();
            const t1 = p.token1.toLowerCase();

            return (t0 === a && t1 === b) || (t0 === b && t1 === a);
        }) ?? null
    );
});

// The chart always plots how much of the quote token one base token buys,
// no matter which direction the swap form points. Stables make the best quote
// side, then the chain's own coin (CYBER on Cyberia, ETH on satellites — so
// bridged CYBER charts in ETH on Robinhood, not the other way round); ties
// keep the user's in→out arrangement.
const STABLE_QUOTES = [
    'USDC',
    'USDT',
    'JUPUSD',
    'RUB',
    'TRUR',
    'GOLD',
    'SILVER',
];
const quotePriority = computed(() => [
    ...STABLE_QUOTES,
    `W${activeChain.value.nativeSymbol.toUpperCase()}`,
    activeChain.value.nativeSymbol.toUpperCase(),
]);
const quoteRank = (addr: string): number => {
    const i = quotePriority.value.indexOf(symbolOf(addr).toUpperCase());

    return i === -1 ? quotePriority.value.length : i;
};

const chartOrientation = computed(() => {
    const a = tokenIn.value;
    const b = tokenOut.value;

    if (!a || !b || a === b) {
        return null;
    }

    return quoteRank(a) < quoteRank(b)
        ? { base: b, quote: a }
        : { base: a, quote: b };
});
const chartBase = computed(() => chartOrientation.value?.base ?? '');
const chartQuote = computed(() => chartOrientation.value?.quote ?? '');
// Identity of the charted market; flipping the swap direction keeps it, and
// a chain switch always rebuilds it (pools/addresses differ per chain).
const chartPairKey = computed(() =>
    chartOrientation.value
        ? `${activeChainId.value}:${resolveAddr(chartBase.value).toLowerCase()}>${resolveAddr(chartQuote.value).toLowerCase()}`
        : '',
);

// --- market chart ---------------------------------------------------------
// The chart shows the price the router actually quotes, reconstructed from the
// route pools' Sync events (see lib/marketCandles.ts). Charting the direct
// pool instead would be a lie on this DEX: WCYBER/USDC holds ~$27 and trades
// ~12% under the routed rate, so every swap goes around it.
const marketRoute = ref<RouteHop[] | null>(null);
const marketReserves = ref<Reserves[]>([]);
const marketHistory = ref<MarketHistory | null>(null);
const marketLoading = ref(false);
const marketError = ref<string | null>(null);
const rangeKey = ref<string>('7D');
// The range is settled once per market — auto on the first load, or by the
// user — and then left alone, so nothing reframes the chart under them.
const rangePinned = ref(false);
// Right edge of the chart. Advanced only when the pools actually moved, so a
// quiet market re-renders nothing at all (no creeping axis, no reset zoom).
const nowSec = ref(Math.floor(Date.now() / 1000));

// Route selection only needs the ranking of the candidate paths, so a probe
// that quotes a non-dust amount is enough; the price itself comes from
// reserves and carries no quantization error.
const bestPath = async (from: string, to: string): Promise<string[] | null> => {
    const paths = candidatePaths(from, to);
    const { decimals } = await tokenMeta(from);
    const start = 10n ** BigInt(Math.max(decimals - 2, 0));
    let best: string[] | null = null;

    for (let attempt = 0; attempt < 5; attempt++) {
        const probeIn = start * 10n ** BigInt(attempt);
        // One tick so ethers batches the calls (≤20 per RPC batch).
        const outs = await Promise.all(
            paths.map(async (path) => {
                try {
                    const amounts = (await readRouter.getAmountsOut(
                        probeIn,
                        path,
                    )) as bigint[];

                    return amounts[amounts.length - 1];
                } catch {
                    return 0n;
                }
            }),
        );
        let bestOut = 0n;

        outs.forEach((out, i) => {
            if (out > bestOut) {
                bestOut = out;
                best = paths[i];
            }
        });

        // Cheap base tokens quote into a 6-decimals leg with heavy truncation;
        // escalate until the winner is clear of the rounding noise.
        if (bestOut >= 2000n) {
            break;
        }
    }

    return best;
};

const readHopReserves = async (hops: RouteHop[]): Promise<Reserves[]> =>
    Promise.all(
        hops.map(async (hop) => {
            const reserves = (await new Contract(
                hop.pair,
                PAIR_ABI,
                readProvider,
            ).getReserves()) as [bigint, bigint, bigint];

            return [reserves[0], reserves[1]] as Reserves;
        }),
    );

const buildHops = async (path: string[]): Promise<RouteHop[]> => {
    const factory = new Contract(
        activeChain.value.factory,
        ['function getPair(address,address) view returns (address)'],
        readProvider,
    );

    return Promise.all(
        path.slice(0, -1).map(async (tokenIn, i) => {
            const tokenOut = path[i + 1];
            const [pair, metaIn, metaOut] = await Promise.all([
                factory.getPair(tokenIn, tokenOut) as Promise<string>,
                tokenMeta(tokenIn),
                tokenMeta(tokenOut),
            ]);

            if (/^0x0{40}$/i.test(pair)) {
                throw new Error('Pool missing for route hop');
            }

            const token0 = (await new Contract(
                pair,
                PAIR_ABI,
                readProvider,
            ).token0()) as string;

            return {
                pair,
                token0: token0.toLowerCase(),
                tokenIn: tokenIn.toLowerCase(),
                tokenOut: tokenOut.toLowerCase(),
                decIn: metaIn.decimals,
                decOut: metaOut.decimals,
            };
        }),
    );
};

const routeKeyOf = (hops: RouteHop[] | null): string =>
    (hops ?? []).map((hop) => hop.pair.toLowerCase()).join('>');

// Bumped by every (re)resolution so a slow explorer answering for a market the
// user already left can never overwrite the current one.
let routeSeq = 0;

const loadRouteHistory = async (
    hops: RouteHop[],
    seq: number,
): Promise<void> => {
    const history = await loadMarketHistory(activeChain.value.explorer, hops);

    if (seq !== routeSeq) {
        return;
    }

    marketHistory.value = history;

    if (!rangePinned.value) {
        rangeKey.value = autoRangeKey(history, nowSec.value);
        rangePinned.value = true;
    }
};

const resolveMarketRoute = async (): Promise<void> => {
    const orientation = chartOrientation.value;
    const seq = ++routeSeq;

    if (!orientation) {
        marketRoute.value = null;
        marketHistory.value = null;

        return;
    }

    const from = resolveAddr(orientation.base);
    const to = resolveAddr(orientation.quote);

    if (from.toLowerCase() === to.toLowerCase()) {
        marketRoute.value = null;
        marketHistory.value = null;

        return;
    }

    marketLoading.value = true;
    marketError.value = null;

    try {
        const path = await bestPath(from, to);

        if (seq !== routeSeq) {
            return;
        }

        if (!path) {
            marketRoute.value = null;
            marketHistory.value = null;

            return;
        }

        const hops = await buildHops(path);

        if (seq !== routeSeq) {
            return;
        }

        const sameRoute =
            routeKeyOf(hops) === routeKeyOf(marketRoute.value) &&
            marketHistory.value !== null;
        marketRoute.value = hops;
        marketReserves.value = await readHopReserves(hops);

        if (seq !== routeSeq) {
            return;
        }

        nowSec.value = Math.floor(Date.now() / 1000);

        // A re-resolution that lands on the same pools (new factory edges, a
        // chain re-select) keeps the history it already has.
        if (!sameRoute) {
            marketHistory.value = null;
            await loadRouteHistory(hops, seq);
        }
    } catch (e) {
        if (seq === routeSeq) {
            marketError.value = (e as Error).message ?? String(e);
            marketHistory.value = null;
        }
    } finally {
        if (seq === routeSeq) {
            marketLoading.value = false;
        }
    }
};

// Reserves are the only thing that can move this market, so the poll reads
// them (cheap, RPC-only) and re-reads the logs solely when they changed. That
// keeps the chart still while nobody trades instead of drawing a new tick
// every few seconds like the old router-probe series did.
const syncMarketReserves = async (): Promise<void> => {
    const hops = marketRoute.value;

    if (!hops) {
        return;
    }

    const seq = routeSeq;

    try {
        const next = await readHopReserves(hops);

        if (seq !== routeSeq) {
            return;
        }

        const changed = next.some((reserves, i) => {
            const previous = marketReserves.value[i];

            return (
                !previous ||
                previous[0] !== reserves[0] ||
                previous[1] !== reserves[1]
            );
        });

        if (!changed) {
            return;
        }

        marketReserves.value = next;
        nowSec.value = Math.floor(Date.now() / 1000);
        await loadRouteHistory(hops, seq);
    } catch {
        // Keep the last known state; the next poll retries.
    }
};

const spotPrice = computed(() =>
    marketRoute.value
        ? routePrice(marketRoute.value, marketReserves.value)
        : null,
);

const activeRange = computed(() => marketRange(rangeKey.value));

const selectRange = (key: string): void => {
    rangePinned.value = true;
    rangeKey.value = key;
    nowSec.value = Math.floor(Date.now() / 1000);
};

const candles = computed<MarketCandle[]>(() => {
    const history = marketHistory.value;

    if (!history || history.observations.length === 0) {
        return [];
    }

    const range = activeRange.value;
    const toSec = nowSec.value;

    return buildCandles(history, {
        fromSec:
            range.windowSec === null
                ? history.observations[0].ts
                : toSec - range.windowSec,
        toSec,
        bucketSec: range.bucketSec,
        spot: spotPrice.value,
    });
});

const rangeChangePct = computed(() => {
    const points = candles.value;

    if (points.length < 2) {
        return null;
    }

    const first = points[0].open;
    const last = points[points.length - 1].close;

    return first > 0 ? ((last - first) / first) * 100 : null;
});

const volume24h = computed(() => {
    const history = marketHistory.value;

    if (!history) {
        return null;
    }

    const from = nowSec.value - DAY_SEC;

    return history.trades
        .filter((trade) => trade.ts >= from)
        .reduce((total, trade) => total + trade.volume, 0);
});

// "CYBER → USDT → USDC": makes it obvious the charted price is a routed one.
const marketRouteSymbols = computed(() =>
    marketRoute.value
        ? [
              symbolOf(marketRoute.value[0].tokenIn),
              ...marketRoute.value.map((hop) => symbolOf(hop.tokenOut)),
          ]
        : [],
);

const formatUsd = (value: number | null | undefined): string => {
    if (value === null || value === undefined) {
        return '—';
    }

    return (
        '$' +
        Number(value).toLocaleString('en-US', {
            maximumFractionDigits: Number(value) >= 1000 ? 0 : 2,
        })
    );
};

const selectedPoolPairAddress = computed(
    () => livePairAddress.value ?? selectedPool.value?.pair_address,
);

const customTokens = ref<Token[]>([]);
const tokens = computed<Token[]>(() => {
    const map = new Map<string, Token>();
    const cfg = activeChain.value;
    map.set(NATIVE, {
        address: NATIVE,
        symbol: cfg.nativeSymbol,
        native: true,
    });

    if (cfg.serverPools) {
        for (const t of KNOWN_TOKENS) {
            map.set(t.address.toLowerCase(), {
                address: t.address,
                symbol: t.symbol,
            });
        }

        for (const p of cleanPools.value) {
            map.set(p.token0.toLowerCase(), {
                address: p.token0,
                symbol: p.symbol0,
            });
            map.set(p.token1.toLowerCase(), {
                address: p.token1,
                symbol: p.symbol1,
            });
        }
    } else {
        // Satellite chains: curated bridged assets only (no server indexer).
        for (const t of cfg.tokens) {
            map.set(t.address.toLowerCase(), {
                address: t.address,
                symbol: t.symbol,
            });
        }
    }

    for (const t of customTokens.value) {
        map.set(t.address.toLowerCase(), t);
    }

    return Array.from(map.values());
});
const symbolOf = (addr: string): string => {
    const known = tokens.value.find(
        (t) => t.address.toLowerCase() === addr.toLowerCase(),
    );

    if (known) {
        return known.symbol;
    }

    // Routes are built from resolved addresses, so the wrapped native shows up
    // even where it is not a pickable token (aeWETH on Robinhood).
    return addr.toLowerCase() === activeChain.value.wrappedNative.toLowerCase()
        ? activeChain.value.nativeSymbol
        : shortAddr(addr);
};

/**
 * The mark beside a ticker, when this chain has one for that contract.
 *
 * Address-keyed rather than ticker-keyed, because on Robinhood Chain the
 * tickers are companies' and companies' tickers are short: `F` is Ford there
 * and could be anything anywhere else. `logoForToken` answers undefined for
 * everything it does not recognise, and `TokenIcon` falls back to its lettered
 * avatar exactly as before.
 */
const logoOf = (addr: string | null): string | undefined =>
    addr === null || addr === NATIVE
        ? undefined
        : logoForToken(activeChainId.value, addr, symbolOf(addr));

// --- token metadata cache -----------------------------------------------
const metaCache = new Map<string, { symbol: string; decimals: number }>();
const tokenMeta = async (
    addr: string,
): Promise<{ symbol: string; decimals: number }> => {
    if (addr === NATIVE) {
        return { symbol: activeChain.value.nativeSymbol, decimals: 18 };
    }

    const key = addr.toLowerCase();
    const cached = metaCache.get(key);

    if (cached) {
        return cached;
    }

    const c = new Contract(addr, ERC20_ABI, readProvider);
    const [symbol, decimals] = await Promise.all([
        c.symbol().catch(() => '?'),
        c.decimals().catch(() => 18),
    ]);
    const meta = { symbol: String(symbol), decimals: Number(decimals) };
    metaCache.set(key, meta);

    return meta;
};

const resolveLivePairAddress = async (): Promise<void> => {
    livePairAddress.value = null;

    if (!tokenIn.value || !tokenOut.value || tokenIn.value === tokenOut.value) {
        return;
    }

    const from = resolveAddr(tokenIn.value);
    const to = resolveAddr(tokenOut.value);

    if (from.toLowerCase() === to.toLowerCase()) {
        return;
    }

    if (selectedPool.value?.pair_address) {
        livePairAddress.value = selectedPool.value.pair_address;

        return;
    }

    try {
        const factory = new Contract(
            activeChain.value.factory,
            [
                'function getPair(address tokenA, address tokenB) view returns (address)',
            ],
            readProvider,
        );
        const pairAddress = (await factory.getPair(from, to)) as string;

        // The selection may have moved on while the RPC round-tripped.
        if (
            resolveAddr(tokenIn.value).toLowerCase() !== from.toLowerCase() ||
            resolveAddr(tokenOut.value).toLowerCase() !== to.toLowerCase()
        ) {
            return;
        }

        livePairAddress.value = /^0x0{40}$/i.test(pairAddress)
            ? null
            : pairAddress;
    } catch {
        livePairAddress.value = null;
    }
};

// --- swap form state ------------------------------------------------------
const tokenIn = ref<string>(NATIVE);
// CYBER → USDC by default so the page opens on the main market with a chart.
const tokenOut = ref<string>(USDC_ADDRESS);
const amountIn = ref('');
const amountOut = ref('');
// Which side the user last edited: 'in' quotes exact-input (getAmountsOut),
// 'out' quotes exact-output (getAmountsIn) so a target buy amount can be
// entered directly.
const mode = ref<'in' | 'out'>('in');
const decIn = ref(18);
const decOut = ref(18);
// A balance is `null` while it is unknown — no wallet yet, or a node that did
// not answer — and never 0n for it. The two read the same on screen and mean
// opposite things to a swap: "you have nothing" refuses the trade, "we could
// not look" must not.
const balIn = ref<bigint | null>(null);
const balOut = ref<bigint | null>(null);

type Quote = {
    path: string[];
    amountIn: bigint;
    amountOut: bigint;
    // Pool price move this trade causes, in % (LP fee excluded); null when
    // the spot-rate probe failed.
    impactPct: number | null;
    // Which set of pools this quote came from. Both are real liquidity on the
    // same chain, so the page asks both and takes the better answer rather
    // than sending every trade to the older venue out of habit.
    venue: 'v2' | 'v3';
    // Present only on a v3 quote: the exact pools and tiers the swap is signed
    // against, so nothing is re-derived between the quote and the signature.
    v3Route?: V3Route;
};
const quote = ref<Quote | null>(null);
const quoting = ref(false);

const fmt = (v: bigint, dec: number, digits = 6): string => {
    const s = formatUnits(v, dec);
    const [int, frac = ''] = s.split('.');
    const trimmed = frac.slice(0, digits).replace(/0+$/, '');

    return trimmed ? `${int}.${trimmed}` : int;
};

const parseSide = (raw: string, decimals: number): bigint => {
    try {
        const v = parseUnits(raw.trim() || '0', decimals);

        return v > 0n ? v : 0n;
    } catch {
        return 0n;
    }
};

const amountInBn = computed(() => parseSide(amountIn.value, decIn.value));
const amountOutBn = computed(() => parseSide(amountOut.value, decOut.value));

const minReceived = computed(() =>
    quote.value
        ? (quote.value.amountOut * BigInt(10000 - slippageBps.value)) / 10000n
        : 0n,
);
// Exact-output ceiling on the input side (the router refunds/never pulls more).
const maxSpent = computed(() =>
    quote.value
        ? (quote.value.amountIn * BigInt(10000 + slippageBps.value)) / 10000n
        : 0n,
);

/**
 * The amount the router is allowed to pull from the wallet: what was typed on
 * an exact-input trade, and the slippage ceiling on an exact-output one, since
 * that is the number the transaction actually authorises.
 */
const spendIn = computed<bigint>(() =>
    mode.value === 'in'
        ? (quote.value?.amountIn ?? amountInBn.value)
        : maxSpent.value,
);

/**
 * Refusing a trade the wallet cannot pay for is this page's job, not the
 * router's: the router says `TransferHelper::transferFrom: transferFrom
 * failed`, which names neither the token nor the balance and reads as a broken
 * DEX. Only a balance that was actually read can refuse anything — `null` is
 * "not looked up", and blocking on it would strand every swap behind one
 * unanswered RPC call.
 */
const insufficientIn = computed(
    () =>
        balIn.value !== null &&
        spendIn.value > 0n &&
        spendIn.value > balIn.value,
);

/** The refusal in the two numbers that caused it, for screen and for error. */
const insufficientMessage = computed(
    () =>
        `Not enough ${symbolOf(tokenIn.value)}: this trade spends ` +
        `${fmt(spendIn.value, decIn.value, 8)} and this address holds ` +
        `${fmt(balIn.value ?? 0n, decIn.value, 8)}.`,
);

// Uniswap V2 keeps 0.3% of the in-side amount per hop for LP holders.
const lpFee = computed(() => {
    if (!quote.value) {
        return 0n;
    }

    // v3 pools each charge their own rate — and this fork's rate is a setting,
    // so it is read off the pool rather than off the tier that addresses it.
    if (quote.value.venue === 'v3' && quote.value.v3Route) {
        const kept = quote.value.v3Route.pools.reduce(
            (rate, pool) => (rate * BigInt(1_000_000 - pool.fee)) / 1_000_000n,
            quote.value.amountIn,
        );

        return quote.value.amountIn - kept;
    }

    const hops = BigInt(quote.value.path.length - 1);

    return (
        (quote.value.amountIn * (1000n ** hops - 997n ** hops)) / 1000n ** hops
    );
});

/** What that fee is, said as a rate rather than as an amount. */
const feeNote = computed(() => {
    if (quote.value?.venue === 'v3' && quote.value.v3Route) {
        const pct = v3RouteFeePct(quote.value.v3Route.pools);

        return `${Number(pct.toFixed(4))}% on this route`;
    }

    return '0.3% per hop';
});

/**
 * Which pools this quote came from.
 *
 * Both venues hold real liquidity on the same chain and the page trades
 * whichever pays better, so it says which one won — a trade that went through
 * a different market than the chart below it is otherwise unaccountable.
 */
const venueLabel = computed(() => {
    if (quote.value?.venue !== 'v3') {
        return 'Ritual DEX (v2)';
    }

    /*
     * Whose v3 this is, which is not always ours.
     *
     * Cyberia's concentrated pools are a fork this project deployed; Robinhood
     * Chain's are Uniswap's own, deployed by somebody else, and the stock
     * tokens live entirely in them. Naming both "Cyberia V3" would credit this
     * project with a venue it does not run, on the one line whose whole job is
     * to say where the money actually went.
     */
    return activeChain.value.v3?.routerKind === 'swapRouter02'
        ? 'Uniswap V3 (concentrated)'
        : 'Cyberia V3 (concentrated)';
});

/**
 * What this chain actually offers, said before anything is picked.
 *
 * The page used to promise "Ritual (Uniswap V2)" everywhere, which was true of
 * every chain it served until one of them turned out to have a second venue
 * with more liquidity in it than ours.
 */
const venuesLine = computed(() =>
    activeChain.value.v3
        ? 'Trade tokens across both venues — the v2 pools and the concentrated ones, whichever pays better'
        : 'Trade tokens on Ritual (Uniswap V2)',
);

/**
 * This project's own cut, when the winning route pays one.
 *
 * Printed as its own line rather than folded into the pool's fee: they are
 * different money going to different people — the pool's goes to whoever put
 * the liquidity there, and this goes to Cyberia. `amountOut` above is already
 * net of it, and a quote that quietly differs from the pool's own is the thing
 * every fee-taking front end gets wrong.
 */
const appFee = computed<{ bps: number; amount: bigint } | null>(() => {
    const q = quote.value;
    const cfg = activeChain.value.v3;

    if (!q || q.venue !== 'v3' || !q.v3Route || !cfg || mode.value !== 'in') {
        return null;
    }

    const fee = v3IntegratorFee(cfg);

    return fee === null
        ? null
        : { bps: fee.bps, amount: q.v3Route.amountOut - q.amountOut };
});

const routeSymbols = computed(() =>
    quote.value ? quote.value.path.map((a) => symbolOf(a)) : [],
);

const rate = computed(() => {
    if (!quote.value || quote.value.amountIn === 0n) {
        return null;
    }

    const inWhole = Number(formatUnits(quote.value.amountIn, decIn.value));
    const outWhole = Number(formatUnits(quote.value.amountOut, decOut.value));

    return inWhole > 0 ? outWhole / inWhole : null;
});

const impactClass = computed(() => {
    const v = quote.value?.impactPct;

    if (v === null || v === undefined) {
        return 'text-muted-foreground';
    }

    if (v >= 5) {
        return 'font-semibold text-red-500';
    }

    return v >= 1 ? 'text-amber-500' : 'text-emerald-500';
});

// --- routing: candidate paths over the known pool graph --------------------
// Fallback routing hubs when the pool graph has no direct route. They are per
// chain and live in the DEX registry, so the wallet's own swap screen routes
// through exactly the same assets this page does.
const HUBS = computed<string[]>(() => activeChain.value.hubs);

// The dex_pools table is fed by an off-chain indexer and can lag the chain by
// weeks (freshly launched pools missing → routes silently ignored). Merge in
// the live factory pair list so new pools are routable immediately.
const chainEdges = ref<[string, string][]>([]);

const loadChainEdges = async (): Promise<void> => {
    try {
        const factory = new Contract(
            activeChain.value.factory,
            FACTORY_ABI,
            readProvider,
        );
        const len = Number(await factory.allPairsLength());
        const addrs = (await Promise.all(
            Array.from({ length: len }, (_, i) => factory.allPairs(i)),
        )) as string[];
        chainEdges.value = await Promise.all(
            addrs.map(async (addr) => {
                const pair = new Contract(addr, PAIR_ABI, readProvider);
                const [t0, t1] = await Promise.all([
                    pair.token0() as Promise<string>,
                    pair.token1() as Promise<string>,
                ]);

                return [t0, t1] as [string, string];
            }),
        );
    } catch {
        // Server-provided pools plus hub fallbacks still route.
    }
};

const adjacency = computed(() => {
    const adj = new Map<string, Set<string>>();
    const link = (a: string, b: string): void => {
        const ka = a.toLowerCase();
        const kb = b.toLowerCase();

        if (!adj.has(ka)) {
            adj.set(ka, new Set());
        }

        adj.get(ka)!.add(kb);
    };

    // Cyberia's server pool snapshot seeds the graph; satellites rely on the
    // live factory edges below (their pools aren't in the Cyberia indexer).
    if (activeChain.value.serverPools) {
        for (const p of cleanPools.value) {
            link(p.token0, p.token1);
            link(p.token1, p.token0);
        }
    }

    for (const [t0, t1] of chainEdges.value) {
        link(t0, t1);
        link(t1, t0);
    }

    return adj;
});

const candidatePaths = (from: string, to: string): string[][] => {
    const a = from.toLowerCase();
    const b = to.toLowerCase();
    const adj = adjacency.value;
    const paths: string[][] = [[a, b]];

    // One intermediate: every X with pools on both sides.
    const nA = adj.get(a) ?? new Set<string>();
    const nB = adj.get(b) ?? new Set<string>();

    for (const x of nA) {
        if (x !== b && nB.has(x)) {
            paths.push([a, x, b]);
        }
    }

    // Two intermediates: X in N(a), Y in N(b) with an X–Y pool.
    for (const x of nA) {
        if (x === b) {
            continue;
        }

        const nX = adj.get(x) ?? new Set<string>();

        for (const y of nB) {
            if (y === a || y === x || !nX.has(y)) {
                continue;
            }

            paths.push([a, x, y, b]);

            if (paths.length >= 40) {
                return paths;
            }
        }
    }

    // Hub fallbacks (dedup below) cover an empty/stale pool table.
    for (const hub of HUBS.value) {
        const h = hub.toLowerCase();

        if (h !== a && h !== b) {
            paths.push([a, h, b]);
        }
    }

    const seen = new Set<string>();

    return paths.filter((p) => {
        const key = p.join('>');

        if (seen.has(key)) {
            return false;
        }

        seen.add(key);

        return true;
    });
};

// Execution rate vs the marginal (spot) rate on the same path, probed with a
// 1/10000 slice of the input. The 0.3%/hop LP fee cancels out of the ratio,
// so this isolates the price move the trade itself causes.
const priceImpactPct = async (q: {
    path: string[];
    amountIn: bigint;
    amountOut: bigint;
}): Promise<number | null> => {
    const probeIn = q.amountIn / 10000n;

    if (probeIn === 0n) {
        return 0;
    }

    try {
        const amounts = (await readRouter.getAmountsOut(
            probeIn,
            q.path,
        )) as bigint[];
        const probeOut = amounts[amounts.length - 1];

        if (probeOut === 0n) {
            return null;
        }

        const execRate = Number(q.amountOut) / Number(q.amountIn);
        const spotRate = Number(probeOut) / Number(probeIn);
        const impact = (1 - execRate / spotRate) * 100;

        return impact > 0 ? impact : 0;
    } catch {
        return null;
    }
};

/**
 * The same probe as `priceImpactPct`, asked of the v3 quoter.
 *
 * A tenth of a basis point of the input pays the marginal rate, and the ratio
 * of the two rates is the move this trade causes. Concentrated liquidity makes
 * that number matter more than it does on a constant-product pool: inside a
 * tick range the price barely moves, and one tick further it moves a lot.
 */
const v3ImpactPct = async (q: {
    amountIn: bigint;
    amountOut: bigint;
    v3Route?: V3Route;
}): Promise<number | null> => {
    const cfg = activeChain.value.v3;
    const probeIn = q.amountIn / 10000n;

    if (!cfg || !q.v3Route || probeIn === 0n) {
        return probeIn === 0n ? 0 : null;
    }

    try {
        const probe = await v3BestRoute(
            readProvider,
            cfg,
            q.v3Route.tokens[0],
            q.v3Route.tokens[q.v3Route.tokens.length - 1],
            probeIn,
            activeChain.value.hubs,
        );

        if (!probe || probe.amountOut === 0n) {
            return null;
        }

        /*
         * Both sides gross. Pricing the net answer against a gross probe would
         * read this project's own fee as the market moving against the trade.
         */
        const execRate = Number(q.v3Route.amountOut) / Number(q.amountIn);
        const spotRate = Number(probe.amountOut) / Number(probeIn);
        const impact = (1 - execRate / spotRate) * 100;

        return impact > 0 ? impact : 0;
    } catch {
        return null;
    }
};

let quoteSeq = 0;

const refreshQuote = async (): Promise<void> => {
    quote.value = null;
    error.value = null;

    const exactIn = mode.value === 'in';
    const driving = exactIn ? amountInBn.value : amountOutBn.value;

    if (
        !tokenIn.value ||
        !tokenOut.value ||
        tokenIn.value === tokenOut.value ||
        driving === 0n
    ) {
        // Keep the counterpart field from showing a stale quote.
        if (exactIn) {
            amountOut.value = '';
        } else {
            amountIn.value = '';
        }

        return;
    }

    const seq = ++quoteSeq;
    quoting.value = true;

    try {
        const from = resolveAddr(tokenIn.value);
        const to = resolveAddr(tokenOut.value);

        if (from.toLowerCase() === to.toLowerCase()) {
            return;
        }

        const paths = candidatePaths(from, to);
        // Fired in one tick so ethers batches them (≤20 per RPC batch).
        const results = await Promise.all(
            paths.map(async (path) => {
                try {
                    if (exactIn) {
                        const amounts = (await readRouter.getAmountsOut(
                            driving,
                            path,
                        )) as bigint[];

                        return {
                            path,
                            amountIn: driving,
                            amountOut: amounts[amounts.length - 1],
                        };
                    }

                    const amounts = (await readRouter.getAmountsIn(
                        driving,
                        path,
                    )) as bigint[];

                    return { path, amountIn: amounts[0], amountOut: driving };
                } catch {
                    return null;
                }
            }),
        );

        // The concentrated-liquidity pools, asked the same question at the same
        // time. A chain with no v3 stack answers null and nothing changes.
        const v3 = activeChain.value.v3;
        const v3Route = v3
            ? await (
                  exactIn
                      ? v3BestRoute(
                            readProvider,
                            v3,
                            from,
                            to,
                            driving,
                            activeChain.value.hubs,
                        )
                      : v3BestRouteExactOut(
                            readProvider,
                            v3,
                            from,
                            to,
                            driving,
                            activeChain.value.hubs,
                        )
              ).catch(() => null)
            : null;

        if (seq !== quoteSeq) {
            return;
        }

        // Best route: most output for exact-in, least input for exact-out.
        let best: Omit<Quote, 'impactPct'> | null = null;

        for (const r of results) {
            if (!r || r.amountOut === 0n || r.amountIn === 0n) {
                continue;
            }

            if (
                !best ||
                (exactIn
                    ? r.amountOut > best.amountOut
                    : r.amountIn < best.amountIn)
            ) {
                best = { ...r, venue: 'v2' as const };
            }
        }

        // v3 wins only by paying better — a tie stays with v2, whose route the
        // chart and the pool page already understand.
        const v3Net =
            v3Route && exactIn && v3
                ? v3AfterFee(v3, v3Route.amountOut)
                : (v3Route?.amountOut ?? 0n);

        if (
            v3Route &&
            v3Route.amountIn > 0n &&
            v3Route.amountOut > 0n &&
            (!best ||
                (exactIn
                    ? v3Net > best.amountOut
                    : v3Route.amountIn < best.amountIn))
        ) {
            best = {
                path: v3Route.tokens,
                amountIn: v3Route.amountIn,
                /*
                 * Net of this project's fee on an exact-input trade: it is what
                 * the user receives, so it is the only figure the other venue
                 * can honestly be compared against. Exact-output takes no fee
                 * — the output there is the number that was asked for — and
                 * `v3AfterFee` is not applied to it.
                 */
                amountOut:
                    exactIn && v3
                        ? v3AfterFee(v3, v3Route.amountOut)
                        : v3Route.amountOut,
                venue: 'v3' as const,
                v3Route,
            };
        }

        if (!best) {
            error.value = 'No route with liquidity found for this pair.';

            if (exactIn) {
                amountOut.value = '';
            } else {
                amountIn.value = '';
            }

            return;
        }

        // The probe goes through whichever venue won: pricing a v3 route with
        // the v2 router would compare two different markets and call the gap
        // price impact.
        const impactPct =
            best.venue === 'v3'
                ? await v3ImpactPct(best)
                : await priceImpactPct(best);

        if (seq !== quoteSeq) {
            return;
        }

        quote.value = { ...best, impactPct };

        // Fill the side the user did not type. Programmatic writes do not
        // emit update:modelValue, so this cannot re-trigger quoting.
        if (exactIn) {
            amountOut.value = fmt(best.amountOut, decOut.value);
        } else {
            amountIn.value = fmt(best.amountIn, decIn.value, 8);
        }
    } finally {
        if (seq === quoteSeq) {
            quoting.value = false;
        }
    }
};

let quoteTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleQuote = (): void => {
    if (quoteTimer) {
        clearTimeout(quoteTimer);
    }

    quoteTimer = setTimeout(() => void refreshQuote(), 300);
};

// Typing makes that field the exact side; the opposite one shows the quote.
const onAmountEdited = (side: 'in' | 'out'): void => {
    mode.value = side;
    scheduleQuote();
};

/* ------------------------------------------------------- indexed chart -- */

/**
 * A price history for the pairs this page cannot draw one for.
 *
 * The chart above is rebuilt from the v2 pools' own `Sync` events, which works
 * because this project runs that exchange. A concentrated pool emits no such
 * event, and the pools holding the tokenised stocks belong to somebody else
 * entirely — so for those pairs the panel had nothing to show but a sentence
 * about having nothing to show, directly beside a live quote.
 *
 * The venue that does index them draws it, in a frame on its own origin. That
 * shape is the security argument and not a convenience: a third party's script
 * tag would run inside this page, and a frame is another origin. `?embed=1` is
 * load-bearing too — the ordinary page answers a frame with `403` and
 * `X-Frame-Options: SAMEORIGIN`.
 */
const activeWalletChain = computed<WalletChainId | null>(
    () =>
        walletChains().find((chain) => chain.chainId === activeChainId.value)
            ?.id ?? null,
);

/**
 * The two sides, as the index addresses them: the coin becomes its wrapper.
 *
 * Output first, because that is the token somebody who came here by link is
 * looking at, and it is the side whose name goes on the panel.
 */
const dexSides = computed<{ base: string; quote: string } | null>(() => {
    const wrapped = activeChain.value.wrappedNative.toLowerCase();
    const resolve = (token: string | null): string | null =>
        token === null || token === ''
            ? null
            : token === NATIVE
              ? wrapped
              : token.toLowerCase();

    const base = resolve(tokenOut.value);
    const quote = resolve(tokenIn.value);

    return base === null || quote === null || base === quote
        ? null
        : { base, quote };
});

const dexPool = ref<{ pair: DexPair; exact: boolean } | null>(null);
let dexSeq = 0;

watch(
    [dexSides, activeChainId],
    async () => {
        const seq = ++dexSeq;
        dexPool.value = null;

        const chain = activeWalletChain.value;
        const sides = dexSides.value;

        if (!chain || !sides) {
            return;
        }

        const pairs = await fetchDexPairs(chain, sides.base);

        // A slower answer for a pair nobody is looking at any more must not
        // land on top of the one on screen.
        if (seq === dexSeq) {
            dexPool.value = pairPoolFor(pairs, sides.base, sides.quote);
        }
    },
    { immediate: true },
);

const dexChartUrl = computed<string | null>(() =>
    dexPool.value
        ? dexScreenerChartUrl(
              {
                  chain: dexPool.value.pair.chain,
                  pairAddress: dexPool.value.pair.pairAddress,
              },
              { theme: resolvedAppearance.value },
          )
        : null,
);

/** Whether the panel is showing somebody else's chart rather than ours. */
const showsIndexedChart = computed(
    () => candles.value.length === 0 && dexChartUrl.value !== null,
);

/** The pair the frame is actually drawing, in the index's own words. */
const dexPairLabel = computed(() =>
    dexPool.value
        ? `${dexPool.value.pair.base.symbol}/${dexPool.value.pair.quote.symbol}`
        : '',
);

watch([tokenIn, tokenOut], scheduleQuote);
watch([tokenIn, tokenOut], () => void resolveLivePairAddress(), {
    immediate: true,
});
// Keyed on the oriented market so flipping the swap direction keeps the chart;
// picking a different market re-resolves the route and reloads its history.
watch(
    chartPairKey,
    () => {
        rangePinned.value = false;
        void resolveMarketRoute();
    },
    { immediate: true },
);
// A late-loading pair list can unlock better routes for an existing quote —
// and a better route for the chart (re-resolving keeps the history when the
// winning pools do not change).
watch(chainEdges, () => {
    scheduleQuote();
    void resolveMarketRoute();
});

// --- balances ---------------------------------------------------------------
const loadBalance = async (token: string): Promise<bigint | null> => {
    const me = wallet.address.value;

    if (!me || !token) {
        return null;
    }

    try {
        return token === NATIVE
            ? await readProvider.getBalance(me)
            : ((await new Contract(token, ERC20_ABI, readProvider).balanceOf(
                  me,
              )) as bigint);
    } catch {
        // A node that did not answer has told us nothing about the balance.
        return null;
    }
};

/**
 * One counter per side, so a slow answer cannot land on top of a fast one.
 *
 * Two reads of the same side are in flight all the time — a token is picked
 * while the balance poll is out, a link fills both fields a tick after the
 * watchers already fired for the defaults — and they resolve in whatever order
 * the node answers. Without this, the *older* read wins whenever it is slower,
 * and it carries the previous token's `decimals` with it: a six-decimal
 * stablecoin's scale applied to an eighteen-decimal token renders the amount a
 * trillion times too large, on a screen somebody is about to trade from.
 */
const sideSeq = { in: 0, out: 0 };

const loadSide = async (side: 'in' | 'out'): Promise<void> => {
    const token = side === 'in' ? tokenIn.value : tokenOut.value;
    const seq = ++sideSeq[side];

    if (!token) {
        if (side === 'in') {
            balIn.value = null;
        } else {
            balOut.value = null;
        }

        return;
    }

    const [meta, bal] = await Promise.all([
        tokenMeta(token),
        loadBalance(token),
    ]);

    // Something newer has already answered for this side; this one is history.
    if (seq !== sideSeq[side]) {
        return;
    }

    if (side === 'in') {
        decIn.value = meta.decimals;
        balIn.value = bal;
    } else {
        decOut.value = meta.decimals;
        balOut.value = bal;
    }
};
watch([tokenIn, () => wallet.address.value], () => void loadSide('in'), {
    immediate: true,
});
watch([tokenOut, () => wallet.address.value], () => void loadSide('out'), {
    immediate: true,
});

// Balances change outside this page (lending, bridge, transfers, other tabs),
// so refresh them on a slow poll while visible and immediately on return to
// the tab — no page reload needed.
const BALANCE_POLL_MS = 10000;
const MARKET_POLL_MS = 10000;
let balanceTimer: ReturnType<typeof setInterval> | undefined;
let marketTimer: ReturnType<typeof setInterval> | undefined;

const refreshBalances = (): void => {
    void loadSide('in');
    void loadSide('out');
};

const onTabVisible = (): void => {
    if (!document.hidden) {
        refreshBalances();
        void syncMarketReserves();
    }
};

const flip = (): void => {
    const a = tokenIn.value;
    tokenIn.value = tokenOut.value;
    tokenOut.value = a;
    amountIn.value = '';
    amountOut.value = '';
    mode.value = 'in';
    quote.value = null;
};

/** Gas one swap can burn; the ceiling `max` holds back on the coin side. */
const SWAP_GAS_UNITS = 300_000n;

/**
 * What selling the coin has to leave behind to be mined at all. Unreadable
 * fee data reserves nothing rather than guessing a number — the balance check
 * below still refuses the trade if the coin runs out.
 */
const nativeGasReserve = async (): Promise<bigint> => {
    try {
        const fee = await readProvider.getFeeData();
        const price = fee.maxFeePerGas ?? fee.gasPrice;

        return price ? price * SWAP_GAS_UNITS : 0n;
    } catch {
        return 0n;
    }
};

const setMaxIn = async (): Promise<void> => {
    const bal = balIn.value;

    if (bal === null || bal <= 0n) {
        amountIn.value = '';
        mode.value = 'in';
        scheduleQuote();

        return;
    }

    // A token is spendable whole — its fee comes out of the coin. The coin
    // pays for its own transaction, so the whole of it is one gas short.
    const spendable =
        tokenIn.value === NATIVE ? bal - (await nativeGasReserve()) : bal;

    amountIn.value = spendable > 0n ? formatUnits(spendable, decIn.value) : '';
    mode.value = 'in';
    scheduleQuote();
};

/** The network picker's value is a string, as every `Select` here is. */
const pickChain = (val: unknown): void => {
    const chainId = Number(val);

    if (Number.isFinite(chainId) && chainId !== activeChainId.value) {
        switchChain(chainId);
    }
};

const pickToken = (side: 'in' | 'out', val: unknown): void => {
    const v = String(val ?? '');

    if (side === 'in') {
        tokenIn.value = v;
    } else {
        tokenOut.value = v;
    }
};

// --- network / execution ------------------------------------------------

const approveIfNeeded = async (
    signer: Awaited<ReturnType<BrowserProvider['getSigner']>>,
    token: string,
    amount: bigint,
    // Each venue pulls the tokens with its own router, so an allowance granted
    // to one is worth nothing to the other.
    spender: string = activeChain.value.router,
): Promise<void> => {
    const me = await signer.getAddress();
    const c = new Contract(token, ERC20_ABI, signer);
    const allowance = (await c.allowance(me, spender)) as bigint;

    if (allowance >= amount) {
        return;
    }

    status.value = `Approving ${symbolOf(token)}…`;
    const tx = await c.approve(spender, MaxUint256);
    await tx.wait();
};

/**
 * A router revert says what the contract checked, never what the user did.
 * The three that have an everyday cause are answered in the user's terms; the
 * rest are passed through unchanged rather than guessed at.
 */
const swapError = (e: unknown): string => {
    const msg = (e as Error)?.message ?? String(e);

    if (msg.includes('transferFrom failed')) {
        return (
            `The router could not take your ${symbolOf(tokenIn.value)} — the ` +
            'balance or the approval is smaller than the trade. The balances ' +
            'above have been re-read.'
        );
    }

    if (msg.includes('INSUFFICIENT_OUTPUT_AMOUNT')) {
        return (
            'The price moved past your slippage tolerance before the swap ' +
            'was mined. Quote it again, or raise the tolerance.'
        );
    }

    if (msg.includes('EXPIRED')) {
        return 'The quote expired before the swap was mined. Try again.';
    }

    return msg;
};

const doSwap = async (): Promise<void> => {
    if (!wallet.isConnected.value) {
        await wallet.connect();

        if (!wallet.isConnected.value) {
            return;
        }
    }

    const q = quote.value;

    if (!q || q.amountIn === 0n) {
        error.value = 'Enter an amount and wait for a quote';

        return;
    }

    if (insufficientIn.value) {
        error.value = insufficientMessage.value;

        return;
    }

    error.value = null;
    busy.value = true;
    const tokenPair = `${symbolOf(tokenIn.value)}/${symbolOf(tokenOut.value)}`;

    track('swap_started', {
        metadata: {
            action_type: 'swap',
            network: activeChain.value.evmChain.name,
            token: tokenPair,
        },
    });

    try {
        const provider = await ensureActiveNetwork();
        const signer = await provider.getSigner();
        const to = await signer.getAddress();
        const router = new Contract(
            activeChain.value.router,
            ROUTER_ABI,
            signer,
        );
        const exactIn = mode.value === 'in';
        const minOut = minReceived.value;
        const maxIn = maxSpent.value;

        let tx;

        if (q.venue === 'v3' && q.v3Route) {
            const cfg = activeChain.value.v3;

            if (!cfg) {
                throw new Error('No v3 stack on this chain');
            }

            if (tokenIn.value !== NATIVE) {
                await approveIfNeeded(
                    signer,
                    tokenIn.value,
                    exactIn ? q.amountIn : maxIn,
                    cfg.router,
                );
            }

            status.value = 'Confirm the swap in your wallet…';
            /*
             * The floor handed to the router is the **gross** one — its fee
             * hooks test the balance they are holding before taking a share —
             * so it is derived from the route's own pre-fee output and the
             * slippage on screen. `minOut` is that same floor after the fee,
             * which is the number the user was shown.
             */
            tx = await v3Swap(signer, cfg, {
                route: q.v3Route,
                recipient: to,
                amountOutMinimum: exactIn
                    ? (q.v3Route.amountOut *
                          BigInt(10000 - slippageBps.value)) /
                      10000n
                    : q.amountOut,
                amountInMaximum: exactIn ? undefined : maxIn,
                exactIn,
                nativeIn: tokenIn.value === NATIVE,
                nativeOut: tokenOut.value === NATIVE,
                deadline: deadline(),
            });
        } else if (tokenIn.value === NATIVE) {
            status.value = 'Confirm the swap in your wallet…';
            tx = exactIn
                ? await router.swapExactETHForTokens(
                      minOut,
                      q.path,
                      to,
                      deadline(),
                      { value: q.amountIn },
                  )
                : // The router refunds whatever part of the max-in value it
                  // does not need at execution time.
                  await router.swapETHForExactTokens(
                      q.amountOut,
                      q.path,
                      to,
                      deadline(),
                      { value: maxIn },
                  );
        } else if (tokenOut.value === NATIVE) {
            await approveIfNeeded(
                signer,
                tokenIn.value,
                exactIn ? q.amountIn : maxIn,
            );
            status.value = 'Confirm the swap in your wallet…';
            tx = exactIn
                ? await router.swapExactTokensForETH(
                      q.amountIn,
                      minOut,
                      q.path,
                      to,
                      deadline(),
                  )
                : await router.swapTokensForExactETH(
                      q.amountOut,
                      maxIn,
                      q.path,
                      to,
                      deadline(),
                  );
        } else {
            await approveIfNeeded(
                signer,
                tokenIn.value,
                exactIn ? q.amountIn : maxIn,
            );
            status.value = 'Confirm the swap in your wallet…';
            tx = exactIn
                ? await router.swapExactTokensForTokens(
                      q.amountIn,
                      minOut,
                      q.path,
                      to,
                      deadline(),
                  )
                : await router.swapTokensForExactTokens(
                      q.amountOut,
                      maxIn,
                      q.path,
                      to,
                      deadline(),
                  );
        }

        status.value = 'Waiting for block…';
        await tx.wait();
        status.value = `Swapped ${fmt(q.amountIn, decIn.value)} ${symbolOf(tokenIn.value)} → ${fmt(q.amountOut, decOut.value)} ${symbolOf(tokenOut.value)}.`;
        track('swap_completed', {
            metadata: {
                action_type: 'swap',
                network: activeChain.value.evmChain.name,
                token: tokenPair,
            },
        });
        amountIn.value = '';
        amountOut.value = '';
        quote.value = null;
        await Promise.all([
            loadSide('in'),
            loadSide('out'),
            syncMarketReserves(),
        ]);
    } catch (e) {
        error.value = swapError(e);
        status.value = null;
        // Whatever the node refused, the numbers on screen are older than its
        // answer — read the two balances again so the page stops arguing.
        void loadSide('in');
        void loadSide('out');
    } finally {
        busy.value = false;
    }
};

// --- custom token by address ------------------------------------------------
const customAddr = ref('');
const addCustomToken = async (): Promise<void> => {
    const a = customAddr.value.trim();

    if (!/^0x[a-fA-F0-9]{40}$/.test(a)) {
        error.value = 'Invalid token address';

        return;
    }

    try {
        const m = await tokenMeta(a);
        customTokens.value = [
            ...customTokens.value,
            { address: a, symbol: m.symbol },
        ];
        customAddr.value = '';
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
    }
};

// Default output token for a chain: Cyberia opens on USDC; satellites open on
// their first curated bridged asset (their chart is off, so any pair is fine).
const defaultTokenOut = (cfg: DexChainConfig): string =>
    cfg.serverPools ? USDC_ADDRESS : (cfg.tokens[0]?.address ?? '');

// Switch which chain's DEX the page shows. Read-only — no wallet prompt;
// swapping later triggers the network switch. Rebuilds providers and resets
// all chain-specific state (addresses, markets and the chart differ per chain).
const switchChain = (chainId: number): void => {
    if (chainId === activeChainId.value) {
        return;
    }

    activeChainId.value = chainId;
    readProvider = makeReadProvider(activeChain.value);
    readRouter = new Contract(
        activeChain.value.router,
        ROUTER_ABI,
        readProvider,
    );
    metaCache.clear();
    customTokens.value = [];
    chainEdges.value = [];
    livePairAddress.value = null;
    marketRoute.value = null;
    marketHistory.value = null;
    marketReserves.value = [];
    tokenIn.value = NATIVE;
    tokenOut.value = defaultTokenOut(activeChain.value);
    amountIn.value = '';
    quote.value = null;

    // The chartPairKey watcher re-resolves the route on the new chain.
    void loadChainEdges();
    refreshBalances();
    void refreshQuote();
};

/**
 * Whether the wallet's network still gets to steer this page.
 *
 * It does by default, and stops the moment a link says otherwise — see
 * `takeLinkedPair`. A link is a more specific request than whichever network an
 * extension happens to be pointing at, and the extension always answers second:
 * `restore()` reports its chain a beat after the page has loaded, so following
 * it unconditionally quietly undid every link — the chain and both tokens
 * snapped back to the defaults with nothing on screen to say why.
 */
let followsWallet = true;

// Follow the wallet's network: switching it re-points the page to that chain's
// DEX (when it is a known DEX chain).
watch(
    () => wallet.chainId.value,
    (chainId, previous) => {
        /*
         * The first chain a restoring wallet reports is not somebody switching
         * networks, it is the page finding out where the wallet already was.
         * After a link has chosen, that one report is ignored and every real
         * switch afterwards is followed as before.
         */
        if (!followsWallet && previous === null) {
            followsWallet = true;

            return;
        }

        if (
            chainId !== null &&
            chainId !== activeChainId.value &&
            DEX_CHAINS.some((c) => c.chainId === chainId)
        ) {
            switchChain(chainId);
        }
    },
);

/**
 * A trade somebody was sent here to make: `/swap?chain=4663&out=0x…`.
 *
 * The pair is the whole of what a link like this can say, and it is deliberately
 * not a wallet action — nothing is signed by arriving, the fields are simply
 * filled in. A network this page does not serve, or an address that is not one,
 * is ignored rather than half-applied: landing on the wrong chain with the
 * right contract would quote a token that is not there.
 *
 * The parameters are left in the address on purpose, unlike the wallet's — this
 * one is a page somebody links to and reloading it should still be the link
 * they followed.
 */
const takeLinkedPair = (): void => {
    if (typeof window === 'undefined') {
        return;
    }

    const params = new URLSearchParams(window.location.search);
    const requested = Number(params.get('chain'));

    if (
        Number.isFinite(requested) &&
        DEX_CHAINS.some((c) => c.chainId === requested)
    ) {
        activeChainId.value = requested;
        readProvider = makeReadProvider(activeChain.value);
        readRouter = new Contract(
            activeChain.value.router,
            ROUTER_ABI,
            readProvider,
        );
        // The cache is keyed by address alone, and the provider it was read
        // through has just changed underneath it.
        metaCache.clear();
        tokenOut.value = defaultTokenOut(activeChain.value);
        tokenIn.value = NATIVE;
        // The link has chosen the network; the wallet's own does not override
        // it when it reports in a moment from now.
        followsWallet = false;
    }

    for (const [key, side] of [
        ['in', tokenIn],
        ['out', tokenOut],
    ] as const) {
        const address = (params.get(key) ?? '').trim();

        if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
            side.value = address;
        }
    }
};

onMounted(async () => {
    // Start on the wallet's chain when it is a DEX chain, else the default.
    if (DEX_CHAINS.some((c) => c.chainId === wallet.chainId.value)) {
        activeChainId.value = wallet.chainId.value as number;
        readProvider = makeReadProvider(activeChain.value);
        readRouter = new Contract(
            activeChain.value.router,
            ROUTER_ABI,
            readProvider,
        );
        tokenOut.value = defaultTokenOut(activeChain.value);
    }

    // After the wallet's chain, because a link is a more specific request than
    // whichever network a browser extension happens to be pointing at.
    takeLinkedPair();

    await nextTick();

    void loadChainEdges();

    balanceTimer = setInterval(() => {
        if (!document.hidden) {
            refreshBalances();
        }
    }, BALANCE_POLL_MS);
    marketTimer = setInterval(() => {
        if (!document.hidden) {
            void syncMarketReserves();
        }
    }, MARKET_POLL_MS);
    window.addEventListener('focus', onTabVisible);
    document.addEventListener('visibilitychange', onTabVisible);

    // Silently restore the wallet (saved address + eth_accounts, no popup) so
    // balances populate without re-clicking connect, same as Liquidity/Farm.
    await wallet.restore(authUser.value?.wallet_address ?? null);
});

onBeforeUnmount(() => {
    clearInterval(balanceTimer);
    clearInterval(marketTimer);
    window.removeEventListener('focus', onTabVisible);
    document.removeEventListener('visibilitychange', onTabVisible);
});
</script>

<template>
    <Head :title="`Swap · ${activeChain.evmChain.name}`" />

    <!--
      Wider than the rest of the site on a big screen, because this page is not
      a document: the left column is a chart, and a chart is the one thing here
      that gets better with every pixel it is given. The cap stays, so a very
      wide monitor does not stretch the form into a line nobody can read.
    -->
    <div
        class="mx-auto max-w-5xl px-4 py-6 xl:max-w-[92rem] 2xl:max-w-[108rem]"
    >
        <header class="mb-4">
            <h1 class="text-2xl font-bold">Swap</h1>
            <p class="text-sm text-muted-foreground">
                {{ venuesLine }} on {{ activeChain.evmChain.name }}. Native
                {{ activeChain.nativeSymbol }} is supported directly.
            </p>
        </header>

        <div
            class="grid gap-4 lg:grid-cols-[1fr_28rem] lg:items-start xl:gap-6"
        >
            <section class="space-y-4 rounded-lg border p-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <!--
                          Two charts and two captions, because they are drawn
                          by different people. Ours is rebuilt from the pools'
                          own reserves; the other is somebody else's index of
                          somebody else's pool, and saying "Ritual market" over
                          it would take credit for a market this project has
                          nothing in.
                        -->
                        <h2 class="font-semibold">
                            {{ showsIndexedChart ? 'Market' : 'Ritual market' }}
                            <!--
                              The pair the chart is *of*, not the pair being
                              traded. They are usually the same and sometimes
                              are not: a token's deepest pool is often against
                              the chain's dollar while the trade goes through
                              ether, and a heading naming one over a chart of
                              the other is the mismatch this exists to avoid.
                            -->
                            <span
                                v-if="showsIndexedChart"
                                class="font-mono text-sm text-muted-foreground"
                            >
                                {{ dexPairLabel }}
                            </span>
                            <span
                                v-else-if="chartPairKey"
                                class="font-mono text-sm text-muted-foreground"
                            >
                                {{ symbolOf(chartBase) }}/{{
                                    symbolOf(chartQuote)
                                }}
                            </span>
                        </h2>
                        <p class="text-xs text-muted-foreground">
                            <template
                                v-if="showsIndexedChart && dexPool?.exact"
                            >
                                This pair trades in concentrated pools, whose
                                history this page cannot rebuild — the chart
                                below is the index's own, of the deepest pool
                                holding both sides.
                            </template>
                            <template v-else-if="showsIndexedChart">
                                No indexed pool holds both sides of this trade,
                                so the chart below is
                                {{ symbolOf(chartBase) }}'s deepest pool instead
                                — a different pair from the one being traded.
                            </template>
                            <template v-else-if="marketRouteSymbols.length > 2">
                                Routed
                                {{ marketRouteSymbols.join(' → ') }} — candles
                                come from the pools' on-chain reserves, so the
                                chart moves only when the chain does.
                            </template>
                            <template v-else>
                                Candles come from the pool's on-chain reserves,
                                so the chart moves only when the chain does.
                            </template>
                        </p>
                    </div>
                    <span
                        v-if="selectedPoolPairAddress && !showsIndexedChart"
                        class="rounded bg-muted px-2 py-1 font-mono text-xs"
                        title="Direct pool for this pair"
                    >
                        {{ shortAddr(selectedPoolPairAddress) }}
                    </span>
                </div>

                <div class="min-h-[190px] rounded-md bg-muted/30 p-3">
                    <template v-if="candles.length > 0">
                        <div
                            class="mb-3 flex flex-wrap items-start justify-between gap-x-6 gap-y-2 text-xs"
                        >
                            <div>
                                <p class="text-muted-foreground">
                                    Price
                                    <span class="font-mono">
                                        {{ symbolOf(chartQuote) }}
                                    </span>
                                </p>
                                <p class="font-mono text-sm">
                                    {{
                                        spotPrice === null
                                            ? '—'
                                            : formatPrice(spotPrice)
                                    }}
                                </p>
                                <p
                                    v-if="rangeChangePct !== null"
                                    class="font-mono text-[0.68rem]"
                                    :class="
                                        rangeChangePct >= 0
                                            ? 'text-emerald-500'
                                            : 'text-red-500'
                                    "
                                >
                                    {{ rangeChangePct >= 0 ? '+' : ''
                                    }}{{ rangeChangePct.toFixed(2) }}% ·
                                    {{ activeRange.label }}
                                </p>
                            </div>
                            <div>
                                <p class="text-muted-foreground">Volume 24h</p>
                                <p class="font-mono">
                                    {{
                                        volume24h === null
                                            ? '—'
                                            : `${formatNum(volume24h)} ${symbolOf(chartBase)}`
                                    }}
                                </p>
                            </div>
                            <div v-if="activeChain.serverPools">
                                <p class="text-muted-foreground">Pool TVL</p>
                                <p class="font-mono">
                                    {{ formatUsd(selectedPool?.tvl_usd) }}
                                </p>
                            </div>
                            <div v-if="activeChain.serverPools">
                                <p class="text-muted-foreground">LP APR</p>
                                <p
                                    class="font-mono"
                                    :class="
                                        (poolApr(selectedPoolPairAddress) ??
                                            0) > 0
                                            ? 'text-emerald-500'
                                            : ''
                                    "
                                >
                                    {{
                                        formatApr(
                                            poolApr(selectedPoolPairAddress),
                                        )
                                    }}
                                </p>
                            </div>
                            <div class="flex gap-1">
                                <button
                                    v-for="range in MARKET_RANGES"
                                    :key="range.key"
                                    type="button"
                                    class="rounded border px-2 py-0.5 text-[0.7rem] font-medium transition"
                                    :class="
                                        range.key === rangeKey
                                            ? 'border-primary bg-primary text-primary-foreground'
                                            : 'border-border text-muted-foreground hover:border-foreground/30'
                                    "
                                    @click="selectRange(range.key)"
                                >
                                    {{ range.label }}
                                </button>
                            </div>
                        </div>
                        <MarketCandlesChart
                            :candles="candles"
                            :base-symbol="symbolOf(chartBase)"
                            :quote-symbol="symbolOf(chartQuote)"
                        />
                    </template>
                    <!--
                      Somebody else's index, for the pools this page cannot
                      rebuild a history from. Keyed on the pool so a change of
                      token drops the frame instead of leaving the previous
                      pair's chart up while a new one loads — the one thing a
                      price chart must never do.
                    -->
                    <div v-else-if="dexChartUrl" class="space-y-2">
                        <div class="flex items-baseline justify-between px-1">
                            <h3 class="text-sm font-medium">
                                {{ dexPairLabel }} · {{ dexPool?.pair.dex }}
                            </h3>
                            <a
                                :href="dexPool?.pair.url ?? undefined"
                                target="_blank"
                                rel="noopener noreferrer"
                                class="text-[0.7rem] text-muted-foreground hover:underline"
                            >
                                Chart by DEX Screener ↗
                            </a>
                        </div>
                        <iframe
                            :key="dexChartUrl"
                            :src="dexChartUrl"
                            class="h-[420px] w-full rounded border border-border xl:h-[600px] 2xl:h-[680px]"
                            loading="lazy"
                            referrerpolicy="no-referrer"
                            sandbox="allow-scripts allow-same-origin allow-popups"
                            title="Price history"
                        />
                    </div>
                    <div
                        v-else
                        class="flex h-40 items-center justify-center px-4 text-center text-sm text-muted-foreground"
                    >
                        <span v-if="marketLoading">
                            Reading the market's on-chain history…
                        </span>
                        <span v-else-if="marketError">
                            Market history unavailable: {{ marketError }}
                        </span>
                        <span v-else-if="!chartPairKey">
                            Select two tokens to view their market chart.
                        </span>
                        <!--
                          Only the v2 pools have a history this page can
                          rebuild: candles come from `Sync` events, and a
                          concentrated pool does not emit them. So a pair the
                          swap above just quoted can still have no chart, and
                          saying "no route" about it would contradict the price
                          sitting beside it.
                        -->
                        <span v-else-if="!marketRoute && activeChain.v3">
                            No chart for this pair: it trades in the
                            concentrated pools, whose history this page cannot
                            rebuild, and no index carries it either.
                        </span>
                        <span v-else-if="!marketRoute">
                            No route between these tokens yet — add liquidity to
                            open this market.
                        </span>
                        <span v-else>
                            No on-chain history for this market yet.
                        </span>
                    </div>
                </div>

                <!-- Server-indexed Cyberia figures; satellites have no indexer. -->
                <div
                    v-if="activeChain.serverPools && daily.length > 0"
                    class="space-y-2"
                >
                    <h3 class="text-sm font-medium">Daily volume 7d</h3>
                    <div
                        v-for="d in daily"
                        :key="d.day"
                        class="grid grid-cols-[5rem_1fr_5rem] items-center gap-2 text-xs"
                    >
                        <span class="font-mono text-muted-foreground">
                            {{ d.day.slice(5) }}
                        </span>
                        <div class="h-3 rounded bg-muted">
                            <div
                                class="h-3 rounded bg-blue-500/70"
                                :style="{
                                    width:
                                        (Number(d.swap_usd) / maxDailyUsd) *
                                            100 +
                                        '%',
                                }"
                            />
                        </div>
                        <span class="text-right font-mono">
                            {{ formatUsd(Number(d.swap_usd)) }}
                        </span>
                    </div>
                </div>

                <div
                    v-else-if="activeChain.serverPools && topPools.length > 0"
                    class="space-y-2"
                >
                    <h3 class="text-sm font-medium">Top pools</h3>
                    <div
                        v-for="pool in topPools"
                        :key="pool.pair_address"
                        class="grid grid-cols-[1fr_5.5rem_4.5rem] gap-2 text-xs"
                    >
                        <span class="truncate font-mono">
                            {{ pool.symbol0 }}/{{ pool.symbol1 }}
                        </span>
                        <span
                            class="text-right font-mono text-muted-foreground"
                        >
                            {{ formatUsd(pool.tvl_usd) }}
                        </span>
                        <span
                            class="text-right font-mono"
                            :class="
                                (poolApr(pool.pair_address) ?? 0) > 0
                                    ? 'text-emerald-500'
                                    : 'text-muted-foreground'
                            "
                        >
                            {{ formatApr(poolApr(pool.pair_address)) }}
                        </span>
                    </div>
                </div>
            </section>

            <div class="space-y-3 rounded-lg border p-4">
                <!--
                  The network and the slippage belong to the trade, so they sit
                  in the card that makes one. They used to own a whole row of
                  their own above the fold — two large pills for two networks —
                  which spent about fifty pixels of every screen to say
                  something the page title already said, and pushed the chart
                  down by exactly that much.
                -->
                <div class="flex items-center justify-between gap-2">
                    <Select
                        :model-value="String(activeChainId)"
                        @update:model-value="pickChain($event)"
                    >
                        <SelectTrigger
                            class="h-8 w-auto gap-2 border-0 bg-muted/60 px-2.5 text-xs font-medium shadow-none focus:ring-0"
                        >
                            <span class="flex items-center gap-2">
                                <span
                                    class="size-1.5 rounded-full bg-primary"
                                />
                                {{ activeChain.evmChain.name }}
                            </span>
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem
                                v-for="chain in DEX_CHAINS"
                                :key="chain.chainId"
                                :value="String(chain.chainId)"
                            >
                                {{ chain.evmChain.name }}
                            </SelectItem>
                        </SelectContent>
                    </Select>

                    <div
                        class="flex items-center gap-1.5 text-xs text-muted-foreground"
                    >
                        <span>Slippage %</span>
                        <Input v-model="slippage" class="h-8 w-14 text-xs" />
                    </div>
                </div>

                <!-- FROM -->
                <div class="rounded-md border p-3">
                    <div class="mb-2 flex items-center justify-between text-sm">
                        <Select
                            :model-value="tokenIn"
                            @update:model-value="pickToken('in', $event)"
                        >
                            <SelectTrigger
                                class="h-9 w-[170px] border-0 bg-transparent px-2 shadow-none focus:ring-0"
                            >
                                <span
                                    v-if="tokenIn"
                                    class="flex items-center gap-2 font-medium"
                                >
                                    <TokenIcon
                                        :symbol="symbolOf(tokenIn)"
                                        :logo="logoOf(tokenIn)"
                                        :size="20"
                                    />
                                    {{ symbolOf(tokenIn) }}
                                </span>
                                <SelectValue
                                    v-else
                                    placeholder="Select token"
                                />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    v-for="t in tokens"
                                    :key="t.address"
                                    :value="t.address"
                                >
                                    <span class="flex items-center gap-2">
                                        <TokenIcon
                                            :symbol="t.symbol"
                                            :logo="logoOf(t.address)"
                                            :size="20"
                                        />
                                        {{ t.symbol }}
                                    </span>
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <button
                            class="text-xs text-muted-foreground hover:underline"
                            @click="void setMaxIn()"
                        >
                            Balance:
                            {{ balIn === null ? '—' : fmt(balIn, decIn) }} (max)
                        </button>
                    </div>
                    <Input
                        v-model="amountIn"
                        placeholder="0.0"
                        inputmode="decimal"
                        @update:model-value="onAmountEdited('in')"
                    />
                </div>

                <!-- flip -->
                <div class="flex justify-center">
                    <button
                        type="button"
                        class="rounded-full border border-border p-2 text-muted-foreground transition hover:text-foreground"
                        title="Flip direction"
                        @click="flip"
                    >
                        <ArrowDownUp class="h-4 w-4" />
                    </button>
                </div>

                <!-- TO -->
                <div class="rounded-md border p-3">
                    <div class="mb-2 flex items-center justify-between text-sm">
                        <Select
                            :model-value="tokenOut"
                            @update:model-value="pickToken('out', $event)"
                        >
                            <SelectTrigger
                                class="h-9 w-[170px] border-0 bg-transparent px-2 shadow-none focus:ring-0"
                            >
                                <span
                                    v-if="tokenOut"
                                    class="flex items-center gap-2 font-medium"
                                >
                                    <TokenIcon
                                        :symbol="symbolOf(tokenOut)"
                                        :logo="logoOf(tokenOut)"
                                        :size="20"
                                    />
                                    {{ symbolOf(tokenOut) }}
                                </span>
                                <SelectValue
                                    v-else
                                    placeholder="Select token"
                                />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem
                                    v-for="t in tokens.filter(
                                        (t) => t.address !== tokenIn,
                                    )"
                                    :key="t.address"
                                    :value="t.address"
                                >
                                    <span class="flex items-center gap-2">
                                        <TokenIcon
                                            :symbol="t.symbol"
                                            :logo="logoOf(t.address)"
                                            :size="20"
                                        />
                                        {{ t.symbol }}
                                    </span>
                                </SelectItem>
                            </SelectContent>
                        </Select>
                        <span class="text-xs text-muted-foreground">
                            Balance:
                            {{ balOut === null ? '—' : fmt(balOut, decOut) }}
                        </span>
                    </div>
                    <div class="relative">
                        <Input
                            v-model="amountOut"
                            placeholder="0.0"
                            inputmode="decimal"
                            class="pr-8"
                            @update:model-value="onAmountEdited('out')"
                        />
                        <Loader2
                            v-if="quoting"
                            class="absolute top-1/2 right-2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground"
                        />
                    </div>
                </div>

                <!-- quote details -->
                <div
                    v-if="quote"
                    class="space-y-1 rounded-md bg-muted/40 p-3 text-xs text-muted-foreground"
                >
                    <p v-if="rate">
                        1 {{ symbolOf(tokenIn) }} ≈
                        <span class="font-mono">{{
                            rate.toLocaleString(undefined, {
                                maximumSignificantDigits: 6,
                            })
                        }}</span>
                        {{ symbolOf(tokenOut) }}
                    </p>
                    <p>
                        Price impact:
                        <span class="font-mono" :class="impactClass">
                            {{
                                quote.impactPct === null
                                    ? '—'
                                    : quote.impactPct < 0.01
                                      ? '<0.01%'
                                      : `${quote.impactPct.toFixed(2)}%`
                            }}
                        </span>
                    </p>
                    <p>
                        Liquidity Provider Fee:
                        <span class="font-mono">{{
                            fmt(lpFee, decIn, 8)
                        }}</span>
                        {{ symbolOf(tokenIn) }} ({{ feeNote }})
                    </p>
                    <p v-if="appFee && operator">
                        Cyberia fee:
                        <span class="font-mono">{{
                            fmt(appFee.amount, decOut, 8)
                        }}</span>
                        {{ symbolOf(tokenOut) }} ({{
                            (appFee.bps / 100).toFixed(2)
                        }}% of the output)
                    </p>
                    <p>Venue: {{ venueLabel }}</p>
                    <p v-if="mode === 'in'">
                        Min received:
                        <span class="font-mono">{{
                            fmt(minReceived, decOut)
                        }}</span>
                        {{ symbolOf(tokenOut) }} ({{ slippage }}% slippage)
                    </p>
                    <p v-else>
                        Max sold:
                        <span class="font-mono">{{
                            fmt(maxSpent, decIn, 8)
                        }}</span>
                        {{ symbolOf(tokenIn) }} ({{ slippage }}% slippage)
                    </p>
                    <p>Route: {{ routeSymbols.join(' → ') }}</p>
                </div>

                <p
                    v-if="
                        quote &&
                        quote.impactPct !== null &&
                        quote.impactPct >= 5
                    "
                    class="rounded-md bg-red-500/10 p-2 text-xs text-red-500"
                >
                    High price impact: this trade moves the pool price by
                    {{ quote.impactPct.toFixed(1) }}%. Consider a smaller
                    amount.
                </p>

                <p
                    v-if="insufficientIn"
                    class="rounded-md bg-red-500/10 p-2 text-xs text-red-500"
                >
                    {{ insufficientMessage }}
                </p>

                <Button
                    class="w-full"
                    :disabled="busy || quoting || !quote || insufficientIn"
                    @click="doSwap"
                >
                    <Loader2 v-if="busy" class="mr-2 h-4 w-4 animate-spin" />
                    {{ wallet.isConnected.value ? 'Swap' : 'Connect wallet' }}
                </Button>

                <div class="flex gap-2 pt-1">
                    <Input
                        v-model="customAddr"
                        placeholder="Add token by 0x address"
                        class="text-xs"
                    />
                    <Button variant="outline" @click="addCustomToken"
                        >Add</Button
                    >
                </div>
            </div>
        </div>

        <p v-if="status" class="mt-3 text-sm">{{ status }}</p>
        <p v-if="error" class="mt-3 text-sm text-red-500">{{ error }}</p>

        <p class="mt-4 text-xs text-muted-foreground">
            Router
            <a
                :href="`${activeChain.explorer}/address/${activeChain.router}`"
                target="_blank"
                class="underline"
                >{{ shortAddr(activeChain.router) }}</a
            >
            on {{ activeChain.evmChain.name }}
        </p>
    </div>
</template>
