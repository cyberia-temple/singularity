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
import { Loader2 } from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import V3Liquidity from '@/components/dex/V3Liquidity.vue';
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
import { useWallet } from '@/composables/useWallet';
import { analytics } from '@/lib/analytics';
import { KNOWN_TOKENS, filterJunkPools } from '@/lib/cyberiaTokens';
import type { AprSnapshot } from '@/lib/dexApr';
import { aprByPair, formatApr } from '@/lib/dexApr';
import { ensureEvmChain } from '@/lib/evmChains';
import { getSelectedEvmProvider } from '@/lib/evmProvider';
import {
    DEFAULT_LIQUIDITY_CHAIN_ID,
    LIQUIDITY_CHAINS,
    liquidityChainById,
} from '@/lib/liquidityChains';
import type { LiquidityChainConfig } from '@/lib/liquidityChains';
import { scanLiquidityBalances } from '@/lib/liquidityPositions';
import { logoForToken } from '@/lib/tokenLogos';
import { track } from '@/lib/track';
import { walletChains } from '@/lib/wallet';

// Router/factory/wrapped-native/pools are per-chain (LIQUIDITY_CHAINS); the
// page reads and trades entirely within the wallet's chain, so Robinhood
// liquidity never mixes with Cyberia's.
// Sentinel for the native coin in the token pickers (maps to the chain's
// wrapped-native token on-chain).
const NATIVE = 'NATIVE';

const ROUTER_ABI = [
    'function addLiquidity(address tokenA,address tokenB,uint amountADesired,uint amountBDesired,uint amountAMin,uint amountBMin,address to,uint deadline) returns (uint,uint,uint)',
    'function addLiquidityETH(address token,uint amountTokenDesired,uint amountTokenMin,uint amountETHMin,address to,uint deadline) payable returns (uint,uint,uint)',
    'function removeLiquidity(address tokenA,address tokenB,uint liquidity,uint amountAMin,uint amountBMin,address to,uint deadline) returns (uint,uint)',
    'function removeLiquidityETH(address token,uint liquidity,uint amountTokenMin,uint amountETHMin,address to,uint deadline) returns (uint,uint)',
    'function quote(uint amountA,uint reserveA,uint reserveB) pure returns (uint)',
];
const FACTORY_ABI = [
    'function getPair(address,address) view returns (address)',
    'function allPairsLength() view returns (uint256)',
    'function allPairs(uint256) view returns (address)',
];
const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
];
const PAIR_ABI = [
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0,uint112 reserve1,uint32)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
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
};

const props = defineProps<{
    pools: PoolRow[];
    indexerReady: boolean;
    apr?: AprSnapshot | null;
}>();

const aprMap = computed(() => aprByPair(props.apr));
const poolApr = (pairAddress?: string | null): number | null =>
    pairAddress
        ? (aprMap.value.get(pairAddress.toLowerCase())?.apr ?? null)
        : null;

const wallet = useWallet();
const page = usePage();
const authUser = computed(
    () =>
        page.props.auth?.user as { wallet_address?: string | null } | undefined,
);

const tab = ref<'add' | 'remove'>('add');
/**
 * Which venue this screen is talking to. The two are not versions of each
 * other — v2 pairs and v3 positions both hold real liquidity on this chain and
 * neither is being retired — so this is a switch and not a migration notice.
 * A chain with no v3 stack never draws it.
 */
const venue = ref<'v2' | 'v3'>('v2');
const slippage = ref('0.5');
const status = ref<string | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);

// The active DEX chain follows the wallet's network when it is a known
// liquidity chain, else the default (Cyberia). A chain tab lets users browse
// another chain's pools read-only; adding/removing prompts a network switch.
const activeChainId = ref<number>(DEFAULT_LIQUIDITY_CHAIN_ID);
const activeChain = computed<LiquidityChainConfig>(() =>
    liquidityChainById(activeChainId.value),
);

/**
 * The chain slug product analytics uses, which is the wallet's own id for the
 * network rather than the DEX config's numeric one — so a swap signed in the
 * wallet and liquidity added here group under the same name.
 */
const walletAnalyticsChain = (): string | undefined =>
    walletChains().find((chain) => chain.chainId === activeChain.value.chainId)
        ?.id;

const makeReadProvider = (cfg: LiquidityChainConfig): JsonRpcProvider =>
    new JsonRpcProvider(cfg.readRpcUrl, {
        chainId: cfg.chainId,
        name: cfg.evmChain.name,
    });

let readProvider = makeReadProvider(
    liquidityChainById(DEFAULT_LIQUIDITY_CHAIN_ID),
);

const shortAddr = (a: string): string =>
    a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const slippageBps = computed(() => {
    const v = Math.round(Number(slippage.value || '0') * 100);

    return Number.isFinite(v) && v >= 0 && v < 5000 ? v : 50;
});
const minOut = (desired: bigint): bigint =>
    (desired * BigInt(10000 - slippageBps.value)) / 10000n;
const deadline = (): bigint => BigInt(Math.floor(Date.now() / 1000) + 1200);
const resolveAddr = (a: string): string =>
    a === NATIVE ? activeChain.value.wrappedNative : a;

// Switch the wallet to the active DEX chain (adding it when unknown) and hand
// back a signer-capable provider. Trading on another chain first prompts a
// network switch.
async function ensureActiveNetwork(): Promise<EthersBrowserProvider> {
    const eth = getSelectedEvmProvider();

    if (!eth) {
        throw new Error('EVM wallet not found');
    }

    await ensureEvmChain(eth, activeChain.value.evmChain);

    return new EthersBrowserProvider(eth);
}

const customTokens = ref<Token[]>([]);
// TEST* deploys, dust pools and unknown-token chat pairs stay out of the UI.
const cleanPools = computed(() => filterJunkPools(props.pools ?? []));
const tokens = computed<Token[]>(() => {
    const cfg = activeChain.value;
    const map = new Map<string, Token>();
    map.set(NATIVE, {
        address: NATIVE,
        symbol: cfg.nativeSymbol,
        native: true,
    });

    if (cfg.serverPools) {
        // Cyberia: curated registry (real assets are pickable before their
        // first pool exists) + everything in the server pool snapshot.
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
const symbolOf = (addr: string): string =>
    tokens.value.find((t) => t.address.toLowerCase() === addr.toLowerCase())
        ?.symbol ?? shortAddr(addr);

/**
 * The mark beside a ticker, when this chain has one for that contract.
 *
 * Address-keyed rather than ticker-keyed: on Robinhood Chain the tickers belong
 * to companies, and a company's ticker is short enough to collide with anything
 * — `F` is Ford there. `logoForToken` answers undefined for everything it does
 * not recognise, and the icon falls back to its lettered avatar as before.
 */
const logoOf = (addr: string | null | undefined): string | undefined =>
    !addr || addr === NATIVE
        ? undefined
        : logoForToken(activeChainId.value, addr, symbolOf(addr));

// --- token metadata cache (live) --------------------------------------------
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

// --- Add liquidity ----------------------------------------------------------
const tokenA = ref<string>(NATIVE);
const tokenB = ref<string>('');
const amountA = ref('');
const amountB = ref('');
const balA = ref<bigint>(0n);
const balB = ref<bigint>(0n);
const decA = ref(18);
const decB = ref(18);
const pair = ref<{
    exists: boolean;
    address: string | null;
    reserveA: bigint;
    reserveB: bigint;
} | null>(null);

const nativeSelected = computed(
    () => tokenA.value === NATIVE || tokenB.value === NATIVE,
);

const loadBalance = async (token: string): Promise<bigint> => {
    const me = wallet.address.value;

    if (!me) {
        return 0n;
    }

    if (token === NATIVE) {
        return readProvider.getBalance(me);
    }

    try {
        return (await new Contract(token, ERC20_ABI, readProvider).balanceOf(
            me,
        )) as bigint;
    } catch {
        return 0n;
    }
};

const refreshPair = async (): Promise<void> => {
    pair.value = null;
    amountB.value = '';

    if (!tokenA.value || !tokenB.value || tokenA.value === tokenB.value) {
        return;
    }

    const [ma, mb] = await Promise.all([
        tokenMeta(tokenA.value),
        tokenMeta(tokenB.value),
    ]);
    decA.value = ma.decimals;
    decB.value = mb.decimals;

    const addrA = resolveAddr(tokenA.value);
    const addrB = resolveAddr(tokenB.value);

    try {
        const factory = new Contract(
            activeChain.value.factory,
            FACTORY_ABI,
            readProvider,
        );
        const pairAddr: string = await factory.getPair(addrA, addrB);

        if (!pairAddr || /^0x0+$/.test(pairAddr)) {
            pair.value = {
                exists: false,
                address: null,
                reserveA: 0n,
                reserveB: 0n,
            };

            return;
        }

        const p = new Contract(pairAddr, PAIR_ABI, readProvider);
        const [t0, reserves] = await Promise.all([p.token0(), p.getReserves()]);
        const aIsToken0 = String(t0).toLowerCase() === addrA.toLowerCase();
        pair.value = {
            exists: true,
            address: pairAddr,
            reserveA: aIsToken0 ? reserves[0] : reserves[1],
            reserveB: aIsToken0 ? reserves[1] : reserves[0],
        };

        if (amountA.value) {
            recomputeFromA();
        }
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
    }
};

const recomputeFromA = (): void => {
    if (!pair.value?.exists || pair.value.reserveA === 0n || !amountA.value) {
        return;
    }

    try {
        const inA = parseUnits(amountA.value, decA.value);
        const outB = (inA * pair.value.reserveB) / pair.value.reserveA;
        amountB.value = formatUnits(outB, decB.value);
    } catch {
        /* partial input */
    }
};
const recomputeFromB = (): void => {
    if (!pair.value?.exists || pair.value.reserveB === 0n || !amountB.value) {
        return;
    }

    try {
        const inB = parseUnits(amountB.value, decB.value);
        const outA = (inB * pair.value.reserveA) / pair.value.reserveB;
        amountA.value = formatUnits(outA, decA.value);
    } catch {
        /* partial input */
    }
};

watch([tokenA, tokenB, () => wallet.address.value], () => void refreshPair());

// Each token's balance loads on its own — independent of whether the *other*
// side is chosen yet — and refreshes when the connected wallet changes.
const loadSide = async (side: 'A' | 'B'): Promise<void> => {
    const token = side === 'A' ? tokenA.value : tokenB.value;

    if (!token) {
        if (side === 'A') {
            balA.value = 0n;
        } else {
            balB.value = 0n;
        }

        return;
    }

    const [meta, bal] = await Promise.all([
        tokenMeta(token),
        loadBalance(token),
    ]);

    if (side === 'A') {
        decA.value = meta.decimals;
        balA.value = bal;
    } else {
        decB.value = meta.decimals;
        balB.value = bal;
    }
};
watch([tokenA, () => wallet.address.value], () => void loadSide('A'), {
    immediate: true,
});
watch([tokenB, () => wallet.address.value], () => void loadSide('B'), {
    immediate: true,
});

const approveIfNeeded = async (
    signer: Awaited<ReturnType<BrowserProvider['getSigner']>>,
    token: string,
    spender: string,
    amount: bigint,
    abi: string[] = ERC20_ABI,
): Promise<void> => {
    const me = await signer.getAddress();
    const c = new Contract(token, abi, signer);
    const allowance = (await c.allowance(me, spender)) as bigint;

    if (allowance >= amount) {
        return;
    }

    status.value = `Approving ${symbolOf(token)}…`;
    const tx = await c.approve(spender, MaxUint256);
    await tx.wait();
};

const addLiquidity = async (): Promise<void> => {
    if (!wallet.isConnected.value) {
        await wallet.connect();

        if (!wallet.isConnected.value) {
            return;
        }
    }

    if (!tokenA.value || !tokenB.value || tokenA.value === tokenB.value) {
        error.value = 'Pick two different tokens';

        return;
    }

    error.value = null;
    busy.value = true;

    try {
        const desiredA = parseUnits(amountA.value || '0', decA.value);
        const desiredB = parseUnits(amountB.value || '0', decB.value);

        if (desiredA <= 0n || desiredB <= 0n) {
            throw new Error('Enter amounts for both tokens');
        }

        const provider = await ensureActiveNetwork();
        const signer = await provider.getSigner();
        const to = await signer.getAddress();
        const router = new Contract(
            activeChain.value.router,
            ROUTER_ABI,
            signer,
        );

        if (nativeSelected.value) {
            const nativeIsA = tokenA.value === NATIVE;
            const token = nativeIsA
                ? resolveAddr(tokenB.value)
                : resolveAddr(tokenA.value);
            const tokenDesired = nativeIsA ? desiredB : desiredA;
            const cyberDesired = nativeIsA ? desiredA : desiredB;
            await approveIfNeeded(
                signer,
                token,
                activeChain.value.router,
                tokenDesired,
            );
            status.value = 'Confirm addLiquidityETH…';
            const tx = await router.addLiquidityETH(
                token,
                tokenDesired,
                minOut(tokenDesired),
                minOut(cyberDesired),
                to,
                deadline(),
                { value: cyberDesired },
            );
            status.value = 'Waiting for block…';
            await tx.wait();
        } else {
            await approveIfNeeded(
                signer,
                tokenA.value,
                activeChain.value.router,
                desiredA,
            );
            await approveIfNeeded(
                signer,
                tokenB.value,
                activeChain.value.router,
                desiredB,
            );
            status.value = 'Confirm addLiquidity…';
            const tx = await router.addLiquidity(
                tokenA.value,
                tokenB.value,
                desiredA,
                desiredB,
                minOut(desiredA),
                minOut(desiredB),
                to,
                deadline(),
            );
            status.value = 'Waiting for block…';
            await tx.wait();
        }

        status.value = 'Liquidity added.';
        /*
         * Also a meaningful action for product analytics: adding liquidity is
         * one of the few things a person can do here that settles on a chain
         * and costs them something, so it activates a user exactly as a swap
         * does. Two systems, deliberately — `track` answers the site funnel
         * (which browser sessions convert), `analytics` answers the product
         * one (which installations became users).
         */
        analytics.track('liquidity_added', {
            chain: walletAnalyticsChain(),
            transaction_type: 'liquidity',
            token_in: symbolOf(tokenA.value),
            token_out: symbolOf(tokenB.value),
        });
        track('liquidity_added', {
            metadata: {
                action_type: 'add_liquidity',
                network: activeChain.value.evmChain.name,
                token: `${symbolOf(tokenA.value)}/${symbolOf(tokenB.value)}`,
            },
        });
        amountA.value = '';
        amountB.value = '';
        await Promise.all([refreshPair(), loadSide('A'), loadSide('B')]);
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
        status.value = null;
    } finally {
        busy.value = false;
    }
};

const pickToken = (side: 'A' | 'B', val: unknown): void => {
    const v = String(val ?? '');

    if (side === 'A') {
        tokenA.value = v;
    } else {
        tokenB.value = v;
    }
};

const setMaxA = (): void => {
    amountA.value = formatUnits(balA.value, decA.value);
    recomputeFromA();
};
const setMaxB = (): void => {
    amountB.value = formatUnits(balB.value, decB.value);
    recomputeFromB();
};

// --- Remove liquidity -------------------------------------------------------
type Position = {
    pairAddress: string;
    token0: string;
    token1: string;
    symbol0: string;
    symbol1: string;
    lp: bigint;
    totalSupply: bigint;
    reserve0: bigint;
    reserve1: bigint;
    dec0: number;
    dec1: number;
};
const positions = ref<Position[]>([]);
const positionsLoading = ref(false);
const positionsError = ref<string | null>(null);
const selected = ref<string | null>(null);
const removePct = ref(50);
const receiveNative = ref(true);

const loadPositions = async (): Promise<void> => {
    const me = wallet.address.value;
    positions.value = [];
    positionsError.value = null;

    if (!me) {
        return;
    }

    positionsLoading.value = true;

    try {
        const factory = new Contract(
            activeChain.value.factory,
            FACTORY_ABI,
            readProvider,
        );
        const pairCount = Number(await factory.allPairsLength());
        const pairAddresses = (await Promise.all(
            Array.from({ length: pairCount }, (_, index) =>
                factory.allPairs(index),
            ),
        )) as string[];
        const balanceScan = await scanLiquidityBalances(
            pairAddresses,
            async (pairAddress) =>
                (await new Contract(
                    pairAddress,
                    PAIR_ABI,
                    readProvider,
                ).balanceOf(me)) as bigint,
        );
        const found = await Promise.allSettled(
            balanceScan.ownedPairs.map(async ({ pairAddress, lpBalance }) => {
                const pairContract = new Contract(
                    pairAddress,
                    PAIR_ABI,
                    readProvider,
                );
                const [totalSupply, reserves, token0, token1] =
                    await Promise.all([
                        pairContract.totalSupply() as Promise<bigint>,
                        pairContract.getReserves(),
                        pairContract.token0() as Promise<string>,
                        pairContract.token1() as Promise<string>,
                    ]);
                const [meta0, meta1] = await Promise.all([
                    tokenMeta(token0),
                    tokenMeta(token1),
                ]);

                return {
                    pairAddress,
                    token0,
                    token1,
                    symbol0: meta0.symbol,
                    symbol1: meta1.symbol,
                    lp: lpBalance,
                    totalSupply,
                    reserve0: reserves[0],
                    reserve1: reserves[1],
                    dec0: meta0.decimals,
                    dec1: meta1.decimals,
                } as Position;
            }),
        );
        positions.value = found.flatMap((result) =>
            result.status === 'fulfilled' ? [result.value] : [],
        );

        const failedPositionReads = found.filter(
            (result) => result.status === 'rejected',
        ).length;
        const failedReads = balanceScan.failedReads + failedPositionReads;

        if (failedReads > 0) {
            positionsError.value = `Could not read ${failedReads} of ${pairCount} pools. Results may be incomplete.`;
        }
    } catch {
        positionsError.value =
            'Could not scan LP positions from the Ritual factory. Please retry.';
    } finally {
        positionsLoading.value = false;
    }
};

const selectedPosition = computed(
    () => positions.value.find((p) => p.pairAddress === selected.value) ?? null,
);
const pooledOut = computed(() => {
    const p = selectedPosition.value;

    if (!p || p.totalSupply === 0n) {
        return null;
    }

    const liq = (p.lp * BigInt(removePct.value)) / 100n;

    return {
        liq,
        amount0: (p.reserve0 * liq) / p.totalSupply,
        amount1: (p.reserve1 * liq) / p.totalSupply,
    };
});
// A position pairs the chain's wrapped-native token (WCYBER / WETH), so it can
// be withdrawn to the native coin via removeLiquidityETH.
const positionHasWrappedNative = (p: Position): boolean => {
    const w = activeChain.value.wrappedNative.toLowerCase();

    return p.token0.toLowerCase() === w || p.token1.toLowerCase() === w;
};

const removeLiquidity = async (): Promise<void> => {
    const p = selectedPosition.value;
    const out = pooledOut.value;

    if (!p || !out || out.liq <= 0n) {
        return;
    }

    error.value = null;
    busy.value = true;

    try {
        const provider = await ensureActiveNetwork();
        const signer = await provider.getSigner();
        const to = await signer.getAddress();
        const router = new Contract(
            activeChain.value.router,
            ROUTER_ABI,
            signer,
        );

        await approveIfNeeded(
            signer,
            p.pairAddress,
            activeChain.value.router,
            out.liq,
            PAIR_ABI,
        );

        const asNative = receiveNative.value && positionHasWrappedNative(p);

        if (asNative) {
            const wIs0 =
                p.token0.toLowerCase() ===
                activeChain.value.wrappedNative.toLowerCase();
            const token = wIs0 ? p.token1 : p.token0;
            const tokenMin = minOut(wIs0 ? out.amount1 : out.amount0);
            const cyberMin = minOut(wIs0 ? out.amount0 : out.amount1);
            status.value = 'Confirm removeLiquidityETH…';
            const tx = await router.removeLiquidityETH(
                token,
                out.liq,
                tokenMin,
                cyberMin,
                to,
                deadline(),
            );
            status.value = 'Waiting for block…';
            await tx.wait();
        } else {
            status.value = 'Confirm removeLiquidity…';
            const tx = await router.removeLiquidity(
                p.token0,
                p.token1,
                out.liq,
                minOut(out.amount0),
                minOut(out.amount1),
                to,
                deadline(),
            );
            status.value = 'Waiting for block…';
            await tx.wait();
        }

        status.value = 'Liquidity removed.';
        analytics.track('liquidity_removed', {
            chain: walletAnalyticsChain(),
            transaction_type: 'liquidity',
        });
        await loadPositions();
        selected.value = null;
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
        status.value = null;
    } finally {
        busy.value = false;
    }
};

watch([() => wallet.address.value, tab], () => {
    if (tab.value === 'remove') {
        void loadPositions();
    }
});

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

const fmt = (v: bigint, dec: number): string => {
    const s = formatUnits(v, dec);

    return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

// Switch which chain's liquidity the page shows. Read-only — no wallet prompt;
// adding/removing later triggers the network switch. Rebuilds the read
// provider and resets all chain-specific state (addresses differ per chain).
const switchChain = (chainId: number): void => {
    if (chainId === activeChainId.value) {
        return;
    }

    activeChainId.value = chainId;
    readProvider = makeReadProvider(activeChain.value);

    if (!activeChain.value.v3) {
        venue.value = 'v2';
    }

    metaCache.clear();
    customTokens.value = [];
    selected.value = null;
    positions.value = [];
    tokenA.value = NATIVE;
    tokenB.value = '';
    amountA.value = '';
    amountB.value = '';
    pair.value = null;
    void loadSide('A');
    void loadSide('B');

    if (tab.value === 'remove') {
        void loadPositions();
    }
};

onMounted(async () => {
    // Silently restore the wallet (saved address + eth_accounts, no popup) so
    // balances/positions populate without the user re-clicking connect, same as
    // Farm/Lending/Bridge. The token-balance watchers refresh once address lands.
    await wallet.restore(authUser.value?.wallet_address ?? null);

    // Start on the wallet's chain when it is a liquidity chain, else the default.
    if (LIQUIDITY_CHAINS.some((c) => c.chainId === wallet.chainId.value)) {
        activeChainId.value = wallet.chainId.value as number;
        readProvider = makeReadProvider(activeChain.value);
    }

    void refreshPair();
});

// Follow the wallet's network: switching it re-points the page to that chain's
// liquidity (when it is a known liquidity chain).
watch(
    () => wallet.chainId.value,
    (chainId) => {
        if (
            chainId !== null &&
            chainId !== activeChainId.value &&
            LIQUIDITY_CHAINS.some((c) => c.chainId === chainId)
        ) {
            switchChain(chainId);
        }
    },
);
</script>

<template>
    <Head :title="`Liquidity · ${activeChain.evmChain.name}`" />

    <div class="liq-page">
        <div class="mx-auto max-w-xl px-4 py-6">
            <header class="mb-4">
                <h1 class="text-2xl font-bold">Liquidity</h1>
                <p class="text-sm text-muted-foreground">
                    <template v-if="venue === 'v2'">
                        Provide or withdraw liquidity on Ritual (Uniswap V2) on
                        {{ activeChain.evmChain.name }}. Native
                        {{ activeChain.nativeSymbol }} is supported directly.
                    </template>
                    <template v-else>
                        Provide or withdraw concentrated liquidity on Cyberia V3
                        on {{ activeChain.evmChain.name }}: a position is a
                        price range, and it earns only while the price is inside
                        it.
                    </template>
                </p>
            </header>

            <!-- CHAIN SWITCHER: pools/balances are per-chain and never mix -->
            <div class="mb-4 flex flex-wrap items-center gap-2">
                <button
                    v-for="chain in LIQUIDITY_CHAINS"
                    :key="chain.chainId"
                    type="button"
                    class="rounded-full border px-4 py-1.5 text-sm font-medium transition"
                    :class="
                        chain.chainId === activeChainId
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-card hover:border-foreground/30'
                    "
                    @click="switchChain(chain.chainId)"
                >
                    {{ chain.evmChain.name }}
                </button>
            </div>

            <!-- VENUE: both hold real liquidity, so this is a choice and not
                 an upgrade path. Hidden where there is only one. -->
            <div
                v-if="activeChain.v3"
                class="mb-4 inline-flex rounded-lg border p-1 text-sm"
            >
                <button
                    v-for="option in ['v2', 'v3'] as const"
                    :key="option"
                    type="button"
                    class="rounded-md px-4 py-1.5 font-medium transition"
                    :class="
                        venue === option
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                    "
                    @click="venue = option"
                >
                    {{ option === 'v2' ? 'V2 pairs' : 'V3 ranges' }}
                </button>
            </div>

            <div class="mb-4 flex gap-2">
                <Button
                    :variant="tab === 'add' ? 'default' : 'outline'"
                    @click="tab = 'add'"
                >
                    Add
                </Button>
                <Button
                    :variant="tab === 'remove' ? 'default' : 'outline'"
                    @click="tab = 'remove'"
                >
                    {{ venue === 'v3' ? 'Positions' : 'Remove' }}
                </Button>
                <div class="ml-auto flex items-center gap-2 text-sm">
                    <span class="text-muted-foreground">Slippage %</span>
                    <Input v-model="slippage" class="w-16" />
                </div>
            </div>

            <!-- ADD (v2) -->
            <div
                v-if="venue === 'v2' && tab === 'add'"
                class="space-y-3 rounded-lg border p-4"
            >
                <div
                    v-for="side in ['A', 'B'] as const"
                    :key="side"
                    class="rounded-md border p-3"
                >
                    <div class="mb-2 flex items-center justify-between text-sm">
                        <Select
                            :model-value="side === 'A' ? tokenA : tokenB"
                            @update:model-value="pickToken(side, $event)"
                        >
                            <SelectTrigger
                                class="h-9 w-[170px] border-0 bg-transparent px-2 shadow-none focus:ring-0"
                            >
                                <span
                                    v-if="side === 'A' ? tokenA : tokenB"
                                    class="flex items-center gap-2 font-medium"
                                >
                                    <TokenIcon
                                        :symbol="
                                            symbolOf(
                                                side === 'A' ? tokenA : tokenB,
                                            )
                                        "
                                        :logo="
                                            logoOf(
                                                side === 'A' ? tokenA : tokenB,
                                            )
                                        "
                                        :size="20"
                                    />
                                    {{
                                        symbolOf(side === 'A' ? tokenA : tokenB)
                                    }}
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
                            @click="side === 'A' ? setMaxA() : setMaxB()"
                        >
                            Balance:
                            {{
                                fmt(
                                    side === 'A' ? balA : balB,
                                    side === 'A' ? decA : decB,
                                )
                            }}
                            (max)
                        </button>
                    </div>
                    <Input
                        :model-value="side === 'A' ? amountA : amountB"
                        placeholder="0.0"
                        inputmode="decimal"
                        @update:model-value="
                            side === 'A'
                                ? ((amountA = String($event)), recomputeFromA())
                                : ((amountB = String($event)), recomputeFromB())
                        "
                    />
                </div>

                <p v-if="pair && !pair.exists" class="text-xs text-amber-500">
                    New pool — you set the initial price by choosing both
                    amounts.
                </p>
                <p
                    v-else-if="poolApr(pair?.address) !== null"
                    class="text-xs text-muted-foreground"
                >
                    LP APR (24h fees, annualized):
                    <span class="font-mono text-emerald-500">
                        {{ formatApr(poolApr(pair?.address)) }}
                    </span>
                </p>

                <Button class="w-full" :disabled="busy" @click="addLiquidity">
                    <Loader2 v-if="busy" class="mr-2 h-4 w-4 animate-spin" />
                    {{
                        wallet.isConnected.value
                            ? 'Add liquidity'
                            : 'Connect wallet'
                    }}
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

            <!-- REMOVE (v2) -->
            <div
                v-else-if="venue === 'v2'"
                class="space-y-3 rounded-lg border p-4"
            >
                <Button
                    v-if="!wallet.isConnected.value"
                    class="w-full"
                    @click="wallet.connect()"
                >
                    Connect wallet
                </Button>

                <template v-else>
                    <p
                        v-if="positionsLoading"
                        class="text-sm text-muted-foreground"
                    >
                        <Loader2 class="mr-1 inline h-4 w-4 animate-spin" />
                        Scanning your positions…
                    </p>
                    <p
                        v-else-if="positions.length === 0 && !positionsError"
                        class="text-sm text-muted-foreground"
                    >
                        No LP positions found for this wallet.
                    </p>
                    <div
                        v-if="positionsError"
                        class="flex items-center justify-between gap-3 rounded-md border border-amber-500/40 p-3 text-sm text-amber-500"
                    >
                        <span>{{ positionsError }}</span>
                        <Button
                            size="sm"
                            variant="outline"
                            :disabled="positionsLoading"
                            @click="loadPositions"
                        >
                            Retry
                        </Button>
                    </div>

                    <button
                        v-for="p in positions"
                        :key="p.pairAddress"
                        class="flex w-full items-center justify-between rounded-md border p-3 text-left"
                        :class="{
                            'ring-2 ring-primary': selected === p.pairAddress,
                        }"
                        @click="selected = p.pairAddress"
                    >
                        <span class="flex items-center gap-2">
                            <TokenIcon
                                :symbol="p.symbol0"
                                :logo="logoOf(p.token0)"
                                :size="20"
                            />
                            <TokenIcon
                                :symbol="p.symbol1"
                                :logo="logoOf(p.token1)"
                                :size="20"
                            />
                            <span class="font-medium"
                                >{{ p.symbol0 }}/{{ p.symbol1 }}</span
                            >
                        </span>
                        <span class="text-right font-mono text-xs">
                            <span class="text-muted-foreground">
                                {{ fmt(p.lp, 18) }} LP
                            </span>
                            <span
                                v-if="poolApr(p.pairAddress) !== null"
                                class="ml-2 text-emerald-500"
                            >
                                {{ formatApr(poolApr(p.pairAddress)) }}
                            </span>
                        </span>
                    </button>

                    <template v-if="selectedPosition && pooledOut">
                        <div class="flex items-center gap-2">
                            <Button
                                v-for="pct in [25, 50, 75, 100]"
                                :key="pct"
                                size="sm"
                                :variant="
                                    removePct === pct ? 'default' : 'outline'
                                "
                                @click="removePct = pct"
                            >
                                {{ pct }}%
                            </Button>
                        </div>
                        <p class="text-sm text-muted-foreground">
                            You receive ≈
                            {{ fmt(pooledOut.amount0, selectedPosition.dec0) }}
                            {{ selectedPosition.symbol0 }} +
                            {{ fmt(pooledOut.amount1, selectedPosition.dec1) }}
                            {{ selectedPosition.symbol1 }}
                        </p>
                        <label
                            v-if="positionHasWrappedNative(selectedPosition)"
                            class="flex items-center gap-2 text-sm"
                        >
                            <input v-model="receiveNative" type="checkbox" />
                            Receive wrapped {{ activeChain.nativeSymbol }} as
                            native {{ activeChain.nativeSymbol }}
                        </label>
                        <Button
                            class="w-full"
                            :disabled="busy"
                            @click="removeLiquidity"
                        >
                            <Loader2
                                v-if="busy"
                                class="mr-2 h-4 w-4 animate-spin"
                            />
                            Remove liquidity
                        </Button>
                    </template>
                </template>
            </div>

            <!-- V3 -->
            <V3Liquidity
                v-else-if="activeChain.v3"
                :chain="activeChain"
                :tokens="tokens"
                :slippage-bps="slippageBps"
                :tab="tab"
            />

            <p v-if="status" class="mt-3 text-sm">{{ status }}</p>
            <p v-if="error" class="mt-3 text-sm text-red-500">{{ error }}</p>

            <p v-if="venue === 'v2'" class="mt-4 text-xs text-muted-foreground">
                Router
                <a
                    :href="`${activeChain.explorer}/address/${activeChain.router}`"
                    target="_blank"
                    class="underline"
                    >{{ shortAddr(activeChain.router) }}</a
                >
            </p>
        </div>
    </div>
</template>
