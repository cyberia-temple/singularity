<script setup lang="ts">
import {
    BrowserProvider,
    Contract,
    JsonRpcProvider,
    ZeroAddress,
    formatUnits,
    getAddress,
    parseUnits,
} from 'ethers';
import { Loader2 } from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
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
import { sortTokens, v3PoolAddress, v3PriceFromSqrt } from '@/lib/dexV3';
import {
    MAX_UINT128,
    V3_FACTORY_ABI,
    V3_POOL_ABI,
    V3_POSITION_MANAGER_ABI,
    amountsForLiquidity,
    fullRangeTicks,
    initialSqrtPriceX96,
    pairedAmount,
    priceAtTick,
    rangeStatus,
    rangeTicksAround,
    snapTick,
    sqrtRatioAtTick,
    tickAtPrice,
    v3DepositCalls,
    v3WithdrawCalls,
    withSlippage,
} from '@/lib/dexV3Positions';
import { ensureEvmChain } from '@/lib/evmChains';
import { getSelectedEvmProvider } from '@/lib/evmProvider';
import type { LiquidityChainConfig } from '@/lib/liquidityChains';
import { track } from '@/lib/track';
import { walletChains } from '@/lib/wallet';

/**
 * Adding to and taking out of the concentrated-liquidity pools.
 *
 * The v2 half of this page is one decision — how much of each token — because
 * a v2 pair holds every price there is. Here the position *is* a price range,
 * so the screen is built around one: the tier is picked before the range (it
 * decides the tick spacing), the range is picked before the amounts (it
 * decides their ratio), and the second amount is never typed. Every price the
 * screen shows is read back out of the tick it was snapped to, so what is on
 * screen is the position that will exist rather than the number that was
 * typed into it.
 *
 * A position is an NFT, not a balance, so "remove" is a list of positions and
 * not a list of pairs — one address can hold five ranges in the same pool.
 */

type Token = { address: string; symbol: string; native?: boolean };

const props = defineProps<{
    chain: LiquidityChainConfig;
    tokens: Token[];
    slippageBps: number;
    tab: 'add' | 'remove';
}>();

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
];

// Creating a pool deploys a 23 KB contract by CREATE2. The node's estimate is
// not to be trusted for that (scripts/v3-seed-pool.ts says the same), so this
// one call carries its gas explicitly; everything else is estimated normally,
// where a failed estimate is a revert worth surfacing rather than hiding.
const CREATE_POOL_GAS = 6_000_000n;

const wallet = useWallet();

const v3 = computed(() => props.chain.v3!);
const nativeSentinel = computed(
    () => props.tokens.find((t) => t.native)?.address ?? 'NATIVE',
);

let readProvider = new JsonRpcProvider(props.chain.readRpcUrl, {
    chainId: props.chain.chainId,
    name: props.chain.evmChain.name,
});

const status = ref<string | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);

const shortAddr = (a: string): string =>
    a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '';
const deadline = (): bigint => BigInt(Math.floor(Date.now() / 1000) + 1200);
const resolveAddr = (a: string): string =>
    a === nativeSentinel.value ? props.chain.wrappedNative : a;
const isNative = (a: string): boolean => a === nativeSentinel.value;

/** A tier as a percentage, for a label. Never what the pool charges. */
const pct = (fee: number): string => {
    const value = fee / 10_000;

    return `${value % 1 === 0 ? value : Number(value.toFixed(4))}%`;
};

const fmt = (v: bigint, dec: number, digits = 6): string => {
    const s = formatUnits(v, dec);
    const [int, frac = ''] = s.split('.');
    const cut = frac.slice(0, digits).replace(/0+$/, '');

    return cut ? `${int}.${cut}` : int;
};

/** Prices span many orders of magnitude here, so significant digits, not places. */
const price = (value: number): string => {
    if (!Number.isFinite(value) || value <= 0) {
        return '—';
    }

    if (value >= 1e9) {
        return '∞';
    }

    return value >= 1
        ? value.toPrecision(6).replace(/\.?0+$/, '')
        : value.toPrecision(4);
};

const walletAnalyticsChain = (): string | undefined =>
    walletChains().find((chain) => chain.chainId === props.chain.chainId)?.id;

const ensureActiveNetwork = async (): Promise<BrowserProvider> => {
    const eth = getSelectedEvmProvider();

    if (!eth) {
        throw new Error('EVM wallet not found');
    }

    await ensureEvmChain(eth, props.chain.evmChain);

    return new BrowserProvider(eth);
};

// --- token metadata ---------------------------------------------------------
const metaCache = new Map<string, { symbol: string; decimals: number }>();
const tokenMeta = async (
    addr: string,
): Promise<{ symbol: string; decimals: number }> => {
    if (isNative(addr)) {
        return { symbol: props.chain.nativeSymbol, decimals: 18 };
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

const symbolOf = (addr: string): string =>
    props.tokens.find((t) => t.address.toLowerCase() === addr.toLowerCase())
        ?.symbol ??
    metaCache.get(addr.toLowerCase())?.symbol ??
    shortAddr(addr);

const loadBalance = async (token: string): Promise<bigint> => {
    const me = wallet.address.value;

    if (!me) {
        return 0n;
    }

    if (isNative(token)) {
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

// --- the pair ---------------------------------------------------------------
const tokenA = ref<string>('');
const tokenB = ref<string>('');
const decA = ref(18);
const decB = ref(18);
const balA = ref<bigint>(0n);
const balB = ref<bigint>(0n);

const pairReady = computed(
    () =>
        !!tokenA.value &&
        !!tokenB.value &&
        resolveAddr(tokenA.value).toLowerCase() !==
            resolveAddr(tokenB.value).toLowerCase(),
);

/**
 * The pair in pool order, which is by address and has nothing to do with the
 * order the two were picked in. Everything below this line is token0/token1;
 * everything above it is A/B, as the user sees them.
 */
const ordered = computed(() => {
    if (!pairReady.value) {
        return null;
    }

    const [token0, token1] = sortTokens(
        resolveAddr(tokenA.value),
        resolveAddr(tokenB.value),
    );
    const aIsToken0 =
        token0.toLowerCase() === resolveAddr(tokenA.value).toLowerCase();

    return {
        token0,
        token1,
        aIsToken0,
        dec0: aIsToken0 ? decA.value : decB.value,
        dec1: aIsToken0 ? decB.value : decA.value,
        sym0: aIsToken0 ? symbolOf(tokenA.value) : symbolOf(tokenB.value),
        sym1: aIsToken0 ? symbolOf(tokenB.value) : symbolOf(tokenA.value),
        /** Which side, if either, is being paid in the coin rather than its wrapper. */
        nativeSide: isNative(tokenA.value)
            ? aIsToken0
                ? (0 as const)
                : (1 as const)
            : isNative(tokenB.value)
              ? aIsToken0
                  ? (1 as const)
                  : (0 as const)
              : null,
    };
});

// --- the tiers --------------------------------------------------------------
type TierInfo = {
    tier: number;
    address: string;
    spacing: number;
    created: boolean;
    initialized: boolean;
    /** What the pool charges, which in this fork is not its tier. */
    fee: number;
    liquidity: bigint;
    sqrtPriceX96: bigint;
    tick: number;
};

const tiers = ref<TierInfo[]>([]);
const tiersLoading = ref(false);
const tier = ref<number>(2500);
const selectedTier = computed(
    () => tiers.value.find((t) => t.tier === tier.value) ?? null,
);

const probeTiers = async (): Promise<void> => {
    tiers.value = [];

    const pair = ordered.value;

    if (!pair) {
        return;
    }

    tiersLoading.value = true;

    try {
        const factory = new Contract(
            v3.value.factory,
            V3_FACTORY_ABI,
            readProvider,
        );
        const found = await Promise.all(
            v3.value.tiers.map(async (t): Promise<TierInfo> => {
                const [spacingRaw, registered] = await Promise.all([
                    factory.feeAmountTickSpacing(t).catch(() => 0n),
                    factory
                        .getPool(pair.token0, pair.token1, t)
                        .catch(() => ZeroAddress) as Promise<string>,
                ]);
                const spacing = Number(spacingRaw);
                // The derivation is what a quote uses, because it costs no
                // call; here the factory is already being asked for the
                // spacing, so its own answer is taken where it has one and the
                // derived address is only needed to talk about a pool that
                // does not exist yet.
                const address =
                    registered && registered !== ZeroAddress
                        ? getAddress(registered)
                        : v3PoolAddress(v3.value, pair.token0, pair.token1, t);
                const base = {
                    tier: t,
                    address,
                    spacing,
                    created: false,
                    initialized: false,
                    fee: t,
                    liquidity: 0n,
                    sqrtPriceX96: 0n,
                    tick: 0,
                };

                try {
                    const pool = new Contract(
                        address,
                        V3_POOL_ABI,
                        readProvider,
                    );
                    const [slot0, fee, liquidity] = await Promise.all([
                        pool.slot0(),
                        pool.fee() as Promise<bigint>,
                        pool.liquidity() as Promise<bigint>,
                    ]);

                    return {
                        ...base,
                        created: true,
                        initialized: slot0.sqrtPriceX96 > 0n,
                        fee: Number(fee),
                        liquidity,
                        sqrtPriceX96: slot0.sqrtPriceX96 as bigint,
                        tick: Number(slot0.tick),
                    };
                } catch {
                    // No contract at the derived address: this tier has no pool
                    // yet, which is the normal case and not an error.
                    return base;
                }
            }),
        );

        tiers.value = found.filter((t) => t.spacing > 0);

        // Land on the deepest market that exists, and on the middle tier when
        // none does — picking an empty 0.01% pool by default would quote a
        // range nobody trades through.
        const deepest = [...tiers.value]
            .filter((t) => t.initialized)
            .sort((a, b) => (b.liquidity > a.liquidity ? 1 : -1))[0];

        tier.value =
            deepest?.tier ??
            tiers.value.find((t) => t.tier === 2500)?.tier ??
            tiers.value[0]?.tier ??
            2500;
    } finally {
        tiersLoading.value = false;
    }
};

// --- the range --------------------------------------------------------------
const RANGE_PRESETS = [10, 25, 60] as const;
const rangePreset = ref<'full' | 'custom' | number>(25);
const tickLower = ref<number>(0);
const tickUpper = ref<number>(0);
const inverted = ref(false);
const minInput = ref('');
const maxInput = ref('');
const initialPriceInput = ref('');

/** The price this pool sits at, or the one being written into a new one. */
const currentSqrt = computed<bigint>(() => {
    const info = selectedTier.value;

    if (info?.initialized) {
        return info.sqrtPriceX96;
    }

    return newPoolSqrt.value ?? 0n;
});

/**
 * The first price of a pool that does not exist yet, out of what was typed.
 *
 * Built from two raw amounts rather than from a float, and never by inverting
 * one: when the box is read the other way round the reciprocal is expressed by
 * swapping which side the typed number lands on, so nothing is ever divided.
 */
const newPoolSqrt = computed<bigint | null>(() => {
    const pair = ordered.value;

    if (!pair || !initialPriceInput.value) {
        return null;
    }

    try {
        return inverted.value
            ? initialSqrtPriceX96(
                  10n ** BigInt(pair.dec1),
                  parseUnits(initialPriceInput.value, pair.dec0),
              )
            : initialSqrtPriceX96(
                  parseUnits(initialPriceInput.value, pair.dec1),
                  10n ** BigInt(pair.dec0),
              );
    } catch {
        return null;
    }
});

const currentTick = computed<number | null>(() => {
    const info = selectedTier.value;

    if (info?.initialized) {
        return info.tick;
    }

    const pair = ordered.value;
    const sqrt = newPoolSqrt.value;

    if (!pair || sqrt === null) {
        return null;
    }

    try {
        // The price of a pool that does not exist yet has no tick on chain, so
        // it is read back out of the price itself.
        return tickAtPrice(
            v3PriceFromSqrt(sqrt, pair.dec0, pair.dec1),
            pair.dec0,
            pair.dec1,
        );
    } catch {
        return null;
    }
});

/** The price of a tick, in the orientation the screen is currently reading. */
const shownPriceAtTick = (tick: number): number => {
    const pair = ordered.value;

    if (!pair) {
        return 0;
    }

    const p = priceAtTick(tick, pair.dec0, pair.dec1);

    return inverted.value ? (p > 0 ? 1 / p : 0) : p;
};

const tickAtShownPrice = (value: number): number => {
    const pair = ordered.value!;

    return tickAtPrice(
        inverted.value ? 1 / value : value,
        pair.dec0,
        pair.dec1,
    );
};

const baseSymbol = computed(() =>
    ordered.value
        ? inverted.value
            ? ordered.value.sym1
            : ordered.value.sym0
        : '',
);
const quoteSymbol = computed(() =>
    ordered.value
        ? inverted.value
            ? ordered.value.sym0
            : ordered.value.sym1
        : '',
);

const currentPriceShown = computed<number | null>(() => {
    const tick = currentTick.value;

    return tick === null ? null : shownPriceAtTick(tick);
});

const isFullRange = computed(() => {
    const spacing = selectedTier.value?.spacing;

    if (!spacing) {
        return false;
    }

    const [lower, upper] = fullRangeTicks(spacing);

    return tickLower.value === lower && tickUpper.value === upper;
});

/** Read the two boxes back out of the ticks they were snapped to. */
const syncRangeInputs = (): void => {
    if (isFullRange.value) {
        minInput.value = '0';
        maxInput.value = '∞';

        return;
    }

    // Inverting the orientation turns the lower tick into the higher price, so
    // the two boxes swap ends with it.
    const [low, high] = inverted.value
        ? [tickUpper.value, tickLower.value]
        : [tickLower.value, tickUpper.value];
    minInput.value = price(shownPriceAtTick(low));
    maxInput.value = price(shownPriceAtTick(high));
};

const applyPreset = (preset: 'full' | 'custom' | number): void => {
    const info = selectedTier.value;
    const tick = currentTick.value;

    if (!info) {
        return;
    }

    rangePreset.value = preset;

    const typed = preset === 'custom' && tickUpper.value > tickLower.value;

    if (typed) {
        // A range typed by hand survives a change of tier, but every tier has
        // its own spacing, so it lands on the nearest ticks this one allows.
        const lower = snapTick(tickLower.value, info.spacing, 'down');
        tickLower.value = lower;
        tickUpper.value = Math.max(
            snapTick(tickUpper.value, info.spacing, 'up'),
            lower + info.spacing,
        );
    } else if (preset === 'full' || preset === 'custom' || tick === null) {
        [tickLower.value, tickUpper.value] = fullRangeTicks(info.spacing);
    } else {
        [tickLower.value, tickUpper.value] = rangeTicksAround(
            tick,
            info.spacing,
            preset,
        );
    }

    syncRangeInputs();
};

const commitBound = (which: 'min' | 'max'): void => {
    const info = selectedTier.value;
    const raw = which === 'min' ? minInput.value : maxInput.value;
    const value = Number(raw);

    if (!info || !ordered.value || !(value > 0) || !Number.isFinite(value)) {
        syncRangeInputs();

        return;
    }

    rangePreset.value = 'custom';

    const [floor, ceiling] = fullRangeTicks(info.spacing);
    const tick = Math.min(
        ceiling,
        Math.max(floor, snapTick(tickAtShownPrice(value), info.spacing)),
    );
    // In the inverted orientation the box marked "min" is the *upper* tick.
    const editsLower = which === (inverted.value ? 'max' : 'min');

    if (editsLower) {
        tickLower.value = Math.min(tick, tickUpper.value - info.spacing);
    } else {
        tickUpper.value = Math.max(tick, tickLower.value + info.spacing);
    }

    syncRangeInputs();
    repairAmounts();
};

/**
 * Which preset the buttons show as chosen — what the ticks *are*, not what was
 * asked for. A pair with no price yet can only be the full range, so that is
 * what is lit; the moment a price exists the asked-for width is applied and
 * the highlight follows it.
 */
const activePreset = computed<'full' | 'custom' | number>(() =>
    isFullRange.value ? 'full' : rangePreset.value,
);

const flipOrientation = (): void => {
    inverted.value = !inverted.value;
    syncRangeInputs();
};

const rangeState = computed(() =>
    currentSqrt.value > 0n && tickUpper.value > tickLower.value
        ? rangeStatus(
              currentSqrt.value,
              sqrtRatioAtTick(tickLower.value),
              sqrtRatioAtTick(tickUpper.value),
          )
        : null,
);

/** Which of the two boxes this range can actually take a deposit in. */
const depositable = computed<{ a: boolean; b: boolean }>(() => {
    const pair = ordered.value;

    if (!pair || !rangeState.value) {
        return { a: true, b: true };
    }

    if (rangeState.value === 'in') {
        return { a: true, b: true };
    }

    // Below the range a deposit is all token0; above it, all token1.
    const only0 = rangeState.value === 'below';
    const aIs0 = pair.aIsToken0;

    return { a: only0 === aIs0, b: only0 !== aIs0 };
});

// --- the amounts ------------------------------------------------------------
const amountA = ref('');
const amountB = ref('');

const rawAmount = (value: string, decimals: number): bigint => {
    try {
        return parseUnits(value || '0', decimals);
    } catch {
        return 0n;
    }
};

/** Type one side; the range and the price decide the other. */
const pairFrom = (side: 'A' | 'B'): void => {
    const pair = ordered.value;
    const sqrt = currentSqrt.value;

    if (!pair || sqrt === 0n || tickUpper.value <= tickLower.value) {
        return;
    }

    const typedIsToken0 = side === 'A' ? pair.aIsToken0 : !pair.aIsToken0;
    const amount = rawAmount(
        side === 'A' ? amountA.value : amountB.value,
        side === 'A' ? decA.value : decB.value,
    );
    const other = pairedAmount(
        sqrt,
        sqrtRatioAtTick(tickLower.value),
        sqrtRatioAtTick(tickUpper.value),
        typedIsToken0 ? 0 : 1,
        amount,
    );

    if (other === null) {
        // The typed side cannot be deposited into this range at all.
        return;
    }

    const target = side === 'A' ? amountB : amountA;
    const decimals = side === 'A' ? decB.value : decA.value;
    target.value = other === 0n ? '' : fmt(other, decimals, decimals);
};

/** Both boxes, re-derived after the range or the tier moved under them. */
const repairAmounts = (): void => {
    if (!depositable.value.a) {
        amountA.value = '';
        pairFrom('B');

        return;
    }

    if (!depositable.value.b) {
        amountB.value = '';
        pairFrom('A');

        return;
    }

    if (amountA.value) {
        pairFrom('A');
    } else if (amountB.value) {
        pairFrom('B');
    }
};

const desired = computed(() => {
    const pair = ordered.value;

    if (!pair) {
        return null;
    }

    const rawA = depositable.value.a
        ? rawAmount(amountA.value, decA.value)
        : 0n;
    const rawB = depositable.value.b
        ? rawAmount(amountB.value, decB.value)
        : 0n;

    return {
        amount0: pair.aIsToken0 ? rawA : rawB,
        amount1: pair.aIsToken0 ? rawB : rawA,
    };
});

const shortOfBalance = computed(() => {
    // A visitor with no wallet has no balance to be short of; saying so before
    // there is an address to say it about is noise, not a warning.
    if (!wallet.address.value) {
        return null;
    }

    if (
        depositable.value.a &&
        rawAmount(amountA.value, decA.value) > balA.value
    ) {
        return symbolOf(tokenA.value);
    }

    if (
        depositable.value.b &&
        rawAmount(amountB.value, decB.value) > balB.value
    ) {
        return symbolOf(tokenB.value);
    }

    return null;
});

const canDeposit = computed(() => {
    const amounts = desired.value;

    if (!amounts || !selectedTier.value || tickUpper.value <= tickLower.value) {
        return false;
    }

    if (currentSqrt.value === 0n || shortOfBalance.value) {
        return false;
    }

    return amounts.amount0 > 0n || amounts.amount1 > 0n;
});

const approveIfNeeded = async (
    signer: Awaited<ReturnType<BrowserProvider['getSigner']>>,
    token: string,
    spender: string,
    amount: bigint,
): Promise<void> => {
    const me = await signer.getAddress();
    const erc20 = new Contract(token, ERC20_ABI, signer);
    const allowance = (await erc20.allowance(me, spender)) as bigint;

    if (allowance >= amount) {
        return;
    }

    // Approved for exactly this deposit and never for everything: the extra
    // zeroing transaction is what USDT-style tokens demand of a raised
    // allowance, and it is cheaper than the alternative it replaces.
    if (allowance > 0n) {
        status.value = `Clearing the old ${symbolOf(token)} allowance…`;
        await (await erc20.approve(spender, 0n)).wait();
    }

    status.value = `Approving ${symbolOf(token)}…`;
    await (await erc20.approve(spender, amount)).wait();
};

const deposit = async (): Promise<void> => {
    if (!wallet.isConnected.value) {
        await wallet.connect();

        if (!wallet.isConnected.value) {
            return;
        }
    }

    const pair = ordered.value;
    const info = selectedTier.value;
    const amounts = desired.value;

    if (!pair || !info || !amounts) {
        return;
    }

    error.value = null;
    busy.value = true;

    try {
        const provider = await ensureActiveNetwork();
        const signer = await provider.getSigner();
        const me = await signer.getAddress();
        const fresh = !info.initialized;
        let poolAddress = info.address;

        if (!info.created) {
            // From the user's own address rather than through the position
            // manager: whoever calls `createPool` is the address the factory
            // records as its creator, and that record is the one chance to set
            // what the pool charges. Spending it on a contract that can never
            // use it would freeze the fee at the tier forever.
            status.value = 'Creating the pool…';
            const factory = new Contract(
                v3.value.factory,
                V3_FACTORY_ABI,
                signer,
            );
            await (
                await factory.createPool(pair.token0, pair.token1, info.tier, {
                    gasLimit: CREATE_POOL_GAS,
                })
            ).wait();

            // Written into by the factory a block ago: the price goes into the
            // address it recorded, never into the one this screen derived.
            const registered = (await factory.getPool(
                pair.token0,
                pair.token1,
                info.tier,
            )) as string;

            if (registered && registered !== ZeroAddress) {
                poolAddress = getAddress(registered);
            }
        }

        if (!info.initialized) {
            const sqrt = newPoolSqrt.value;

            if (sqrt === null) {
                throw new Error('Set the first price for this pool');
            }

            status.value = 'Writing the first price…';
            await (
                await new Contract(poolAddress, V3_POOL_ABI, signer).initialize(
                    sqrt,
                )
            ).wait();
        }

        for (const [token, amount, side] of [
            [pair.token0, amounts.amount0, 0] as const,
            [pair.token1, amounts.amount1, 1] as const,
        ]) {
            if (amount > 0n && pair.nativeSide !== side) {
                await approveIfNeeded(
                    signer,
                    token,
                    v3.value.positionManager,
                    amount,
                );
            }
        }

        const plan = v3DepositCalls({
            token0: pair.token0,
            token1: pair.token1,
            tier: info.tier,
            tickLower: tickLower.value,
            tickUpper: tickUpper.value,
            amount0Desired: amounts.amount0,
            amount1Desired: amounts.amount1,
            // A pool whose price this transaction just wrote has no market to
            // slip against, and a floor there would only fight the ratio that
            // was written into it a block ago.
            amount0Min: fresh
                ? 0n
                : withSlippage(amounts.amount0, props.slippageBps),
            amount1Min: fresh
                ? 0n
                : withSlippage(amounts.amount1, props.slippageBps),
            recipient: me,
            deadline: deadline(),
            nativeSide: pair.nativeSide,
        });

        status.value = 'Confirm the deposit…';
        const manager = new Contract(
            v3.value.positionManager,
            V3_POSITION_MANAGER_ABI,
            signer,
        );
        const tx =
            plan.calls.length === 1
                ? await signer.sendTransaction({
                      to: v3.value.positionManager,
                      data: plan.calls[0],
                      value: plan.value,
                  })
                : await manager.multicall(plan.calls, { value: plan.value });
        status.value = 'Waiting for block…';
        await tx.wait();
        status.value = 'Position opened.';

        analytics.track('liquidity_added', {
            chain: walletAnalyticsChain(),
            transaction_type: 'liquidity',
            token_in: pair.sym0,
            token_out: pair.sym1,
        });
        track('liquidity_added', {
            metadata: {
                action_type: 'add_liquidity_v3',
                network: props.chain.evmChain.name,
                token: `${pair.sym0}/${pair.sym1}`,
            },
        });

        amountA.value = '';
        amountB.value = '';
        await Promise.all([probeTiers(), refreshBalances(), loadPositions()]);
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
        status.value = null;
    } finally {
        busy.value = false;
    }
};

// --- the positions ----------------------------------------------------------
type V3Position = {
    tokenId: bigint;
    token0: string;
    token1: string;
    tier: number;
    fee: number;
    tickLower: number;
    tickUpper: number;
    liquidity: bigint;
    dec0: number;
    dec1: number;
    sym0: string;
    sym1: string;
    pool: string;
    sqrtPriceX96: bigint;
    tick: number;
    amount0: bigint;
    amount1: bigint;
    owed0: bigint;
    owed1: bigint;
};

const positions = ref<V3Position[]>([]);
const positionsLoading = ref(false);
const positionsError = ref<string | null>(null);
const closedCount = ref(0);
const selectedId = ref<string | null>(null);
const removePct = ref(50);
const receiveNative = ref(true);

const loadPositions = async (): Promise<void> => {
    const me = wallet.address.value;
    positions.value = [];
    positionsError.value = null;
    closedCount.value = 0;

    if (!me) {
        return;
    }

    positionsLoading.value = true;

    try {
        const manager = new Contract(
            v3.value.positionManager,
            V3_POSITION_MANAGER_ABI,
            readProvider,
        );
        const count = Number((await manager.balanceOf(me)) as bigint);
        const ids = (await Promise.all(
            Array.from({ length: count }, (_, index) =>
                manager.tokenOfOwnerByIndex(me, index),
            ),
        )) as bigint[];

        const found = await Promise.allSettled(
            ids.map(async (tokenId): Promise<V3Position> => {
                const p = await manager.positions(tokenId);
                const tier = Number(p.fee);
                const pool = v3PoolAddress(v3.value, p.token0, p.token1, tier);
                const poolContract = new Contract(
                    pool,
                    V3_POOL_ABI,
                    readProvider,
                );
                const [slot0, fee, meta0, meta1, owed] = await Promise.all([
                    poolContract.slot0(),
                    poolContract.fee() as Promise<bigint>,
                    tokenMeta(p.token0),
                    tokenMeta(p.token1),
                    // What `collect` would pay right now. `tokensOwed` on the
                    // position is only as fresh as the last time it was
                    // touched, so a position that has been earning quietly for
                    // a month reads zero there; this asks the pool.
                    (
                        manager.collect.staticCall(
                            {
                                tokenId,
                                recipient: me,
                                amount0Max: MAX_UINT128,
                                amount1Max: MAX_UINT128,
                            },
                            { from: me },
                        ) as Promise<[bigint, bigint]>
                    ).catch(() => [0n, 0n] as [bigint, bigint]),
                ]);
                const liquidity = p.liquidity as bigint;
                const tickLowerValue = Number(p.tickLower);
                const tickUpperValue = Number(p.tickUpper);
                const held = amountsForLiquidity(
                    slot0.sqrtPriceX96 as bigint,
                    sqrtRatioAtTick(tickLowerValue),
                    sqrtRatioAtTick(tickUpperValue),
                    liquidity,
                );

                return {
                    tokenId,
                    token0: getAddress(p.token0),
                    token1: getAddress(p.token1),
                    tier,
                    fee: Number(fee),
                    tickLower: tickLowerValue,
                    tickUpper: tickUpperValue,
                    liquidity,
                    dec0: meta0.decimals,
                    dec1: meta1.decimals,
                    sym0: meta0.symbol,
                    sym1: meta1.symbol,
                    pool,
                    sqrtPriceX96: slot0.sqrtPriceX96 as bigint,
                    tick: Number(slot0.tick),
                    amount0: held.amount0,
                    amount1: held.amount1,
                    owed0: owed[0],
                    owed1: owed[1],
                };
            }),
        );

        const readable = found.flatMap((r) =>
            r.status === 'fulfilled' ? [r.value] : [],
        );
        // A position emptied down to nothing is a spent NFT, not a holding.
        closedCount.value = readable.filter(
            (p) => p.liquidity === 0n && p.owed0 === 0n && p.owed1 === 0n,
        ).length;
        positions.value = readable.filter(
            (p) => p.liquidity > 0n || p.owed0 > 0n || p.owed1 > 0n,
        );

        const failed = found.filter((r) => r.status === 'rejected').length;

        if (failed > 0) {
            positionsError.value = `Could not read ${failed} of ${count} positions. Results may be incomplete.`;
        }
    } catch {
        positionsError.value =
            'Could not read your positions from the position manager. Please retry.';
    } finally {
        positionsLoading.value = false;
    }
};

const selectedPosition = computed(
    () =>
        positions.value.find(
            (p) => p.tokenId.toString() === selectedId.value,
        ) ?? null,
);

const positionInRange = (p: V3Position): boolean =>
    p.tick >= p.tickLower && p.tick < p.tickUpper;

/** The side that is the chain's wrapped coin, if the user wants it unwrapped. */
const nativeSideOf = (p: V3Position): 0 | 1 | null => {
    if (!receiveNative.value) {
        return null;
    }

    const w = props.chain.wrappedNative.toLowerCase();

    return p.token0.toLowerCase() === w
        ? 0
        : p.token1.toLowerCase() === w
          ? 1
          : null;
};

const positionHasWrappedNative = (p: V3Position): boolean => {
    const w = props.chain.wrappedNative.toLowerCase();

    return p.token0.toLowerCase() === w || p.token1.toLowerCase() === w;
};

const removal = computed(() => {
    const p = selectedPosition.value;

    if (!p || p.liquidity === 0n) {
        return null;
    }

    const liquidity = (p.liquidity * BigInt(removePct.value)) / 100n;
    const amounts = amountsForLiquidity(
        p.sqrtPriceX96,
        sqrtRatioAtTick(p.tickLower),
        sqrtRatioAtTick(p.tickUpper),
        liquidity,
    );

    return { liquidity, ...amounts };
});

const sendPositionCalls = async (
    calls: string[],
    label: string,
): Promise<void> => {
    const provider = await ensureActiveNetwork();
    const signer = await provider.getSigner();
    const manager = new Contract(
        v3.value.positionManager,
        V3_POSITION_MANAGER_ABI,
        signer,
    );

    status.value = label;
    const tx =
        calls.length === 1
            ? await signer.sendTransaction({
                  to: v3.value.positionManager,
                  data: calls[0],
              })
            : await manager.multicall(calls);
    status.value = 'Waiting for block…';
    await tx.wait();
};

const removeLiquidity = async (): Promise<void> => {
    const p = selectedPosition.value;
    const out = removal.value;

    if (!p || !out || out.liquidity <= 0n) {
        return;
    }

    error.value = null;
    busy.value = true;

    try {
        const provider = await ensureActiveNetwork();
        const me = await (await provider.getSigner()).getAddress();
        const plan = v3WithdrawCalls({
            tokenId: p.tokenId,
            token0: p.token0,
            token1: p.token1,
            liquidity: out.liquidity,
            amount0Min: withSlippage(out.amount0, props.slippageBps),
            amount1Min: withSlippage(out.amount1, props.slippageBps),
            recipient: me,
            deadline: deadline(),
            nativeSide: nativeSideOf(p),
            // Taking all of it out leaves an NFT that holds nothing; burning it
            // in the same transaction is what keeps the list a list of holdings.
            burn: removePct.value === 100,
        });

        await sendPositionCalls(plan.calls, 'Confirm the withdrawal…');
        status.value = 'Liquidity removed.';
        analytics.track('liquidity_removed', {
            chain: walletAnalyticsChain(),
            transaction_type: 'liquidity',
        });
        selectedId.value = null;
        await Promise.all([loadPositions(), refreshBalances()]);
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
        status.value = null;
    } finally {
        busy.value = false;
    }
};

const collectFees = async (): Promise<void> => {
    const p = selectedPosition.value;

    if (!p) {
        return;
    }

    error.value = null;
    busy.value = true;

    try {
        const provider = await ensureActiveNetwork();
        const me = await (await provider.getSigner()).getAddress();
        const plan = v3WithdrawCalls({
            tokenId: p.tokenId,
            token0: p.token0,
            token1: p.token1,
            liquidity: 0n,
            amount0Min: 0n,
            amount1Min: 0n,
            recipient: me,
            deadline: deadline(),
            nativeSide: nativeSideOf(p),
            burn: false,
        });

        await sendPositionCalls(plan.calls, 'Confirm the collection…');
        status.value = 'Fees collected.';
        await Promise.all([loadPositions(), refreshBalances()]);
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
        status.value = null;
    } finally {
        busy.value = false;
    }
};

// --- adding to a position that already exists -------------------------------
const topUp0 = ref('');
const topUp1 = ref('');

/** The same "type one side, the range decides the other" as a new position. */
const pairTopUp = (side: 0 | 1): void => {
    const p = selectedPosition.value;

    if (!p) {
        return;
    }

    const typed = rawAmount(
        side === 0 ? topUp0.value : topUp1.value,
        side === 0 ? p.dec0 : p.dec1,
    );
    const other = pairedAmount(
        p.sqrtPriceX96,
        sqrtRatioAtTick(p.tickLower),
        sqrtRatioAtTick(p.tickUpper),
        side,
        typed,
    );

    if (other === null) {
        return;
    }

    const target = side === 0 ? topUp1 : topUp0;
    const decimals = side === 0 ? p.dec1 : p.dec0;
    target.value = other === 0n ? '' : fmt(other, decimals, decimals);
};

const topUpAmounts = computed(() => {
    const p = selectedPosition.value;

    if (!p) {
        return null;
    }

    const where = rangeStatus(
        p.sqrtPriceX96,
        sqrtRatioAtTick(p.tickLower),
        sqrtRatioAtTick(p.tickUpper),
    );

    return {
        amount0: where === 'above' ? 0n : rawAmount(topUp0.value, p.dec0),
        amount1: where === 'below' ? 0n : rawAmount(topUp1.value, p.dec1),
        takes0: where !== 'above',
        takes1: where !== 'below',
    };
});

const increaseLiquidity = async (): Promise<void> => {
    const p = selectedPosition.value;
    const amounts = topUpAmounts.value;

    if (!p || !amounts || (amounts.amount0 === 0n && amounts.amount1 === 0n)) {
        return;
    }

    error.value = null;
    busy.value = true;

    try {
        const provider = await ensureActiveNetwork();
        const signer = await provider.getSigner();
        const me = await signer.getAddress();
        const nativeSide = nativeSideOf(p);

        for (const [token, amount, side] of [
            [p.token0, amounts.amount0, 0] as const,
            [p.token1, amounts.amount1, 1] as const,
        ]) {
            if (amount > 0n && nativeSide !== side) {
                await approveIfNeeded(
                    signer,
                    token,
                    v3.value.positionManager,
                    amount,
                );
            }
        }

        const plan = v3DepositCalls({
            token0: p.token0,
            token1: p.token1,
            tier: p.tier,
            tickLower: p.tickLower,
            tickUpper: p.tickUpper,
            amount0Desired: amounts.amount0,
            amount1Desired: amounts.amount1,
            amount0Min: withSlippage(amounts.amount0, props.slippageBps),
            amount1Min: withSlippage(amounts.amount1, props.slippageBps),
            recipient: me,
            deadline: deadline(),
            nativeSide,
            tokenId: p.tokenId,
        });

        const manager = new Contract(
            v3.value.positionManager,
            V3_POSITION_MANAGER_ABI,
            signer,
        );
        status.value = 'Confirm the deposit…';
        const tx =
            plan.calls.length === 1
                ? await signer.sendTransaction({
                      to: v3.value.positionManager,
                      data: plan.calls[0],
                      value: plan.value,
                  })
                : await manager.multicall(plan.calls, { value: plan.value });
        status.value = 'Waiting for block…';
        await tx.wait();
        status.value = 'Position increased.';

        analytics.track('liquidity_added', {
            chain: walletAnalyticsChain(),
            transaction_type: 'liquidity',
            token_in: p.sym0,
            token_out: p.sym1,
        });

        topUp0.value = '';
        topUp1.value = '';
        await Promise.all([loadPositions(), refreshBalances()]);
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
        status.value = null;
    } finally {
        busy.value = false;
    }
};

// --- keeping the screen in step ---------------------------------------------
const refreshBalances = async (): Promise<void> => {
    const [a, b] = await Promise.all([
        tokenA.value ? loadBalance(tokenA.value) : Promise.resolve(0n),
        tokenB.value ? loadBalance(tokenB.value) : Promise.resolve(0n),
    ]);
    balA.value = a;
    balB.value = b;
};

const refreshPair = async (): Promise<void> => {
    if (!pairReady.value) {
        tiers.value = [];

        return;
    }

    const [ma, mb] = await Promise.all([
        tokenMeta(tokenA.value),
        tokenMeta(tokenB.value),
    ]);
    decA.value = ma.decimals;
    decB.value = mb.decimals;

    // The first-picked token reads as the base, so "1 CYBER = 0.004 USDC" is
    // the sentence a person who picked CYBER first is expecting.
    inverted.value = !ordered.value?.aIsToken0;

    await probeTiers();
    applyPreset(rangePreset.value);
    await refreshBalances();
};

watch([tokenA, tokenB], () => {
    amountA.value = '';
    amountB.value = '';
    void refreshPair();
});

watch(tier, () => {
    applyPreset(rangePreset.value);
    repairAmounts();
});

watch(newPoolSqrt, () => {
    if (!selectedTier.value?.initialized) {
        applyPreset(rangePreset.value);
        repairAmounts();
    }
});

watch(
    () => wallet.address.value,
    () => {
        void refreshBalances();
        void loadPositions();
    },
);

watch(
    () => props.tab,
    (tab) => {
        if (tab === 'remove') {
            void loadPositions();
        }
    },
    { immediate: true },
);

watch(
    () => props.chain.chainId,
    () => {
        readProvider = new JsonRpcProvider(props.chain.readRpcUrl, {
            chainId: props.chain.chainId,
            name: props.chain.evmChain.name,
        });
        metaCache.clear();
        tokenA.value = '';
        tokenB.value = '';
        tiers.value = [];
        positions.value = [];
        selectedId.value = null;
    },
);

watch(selectedPosition, () => {
    topUp0.value = '';
    topUp1.value = '';
    removePct.value = 50;
});
const setMax = (side: 'A' | 'B'): void => {
    if (side === 'A') {
        amountA.value = formatUnits(balA.value, decA.value);
        pairFrom('A');
    } else {
        amountB.value = formatUnits(balB.value, decB.value);
        pairFrom('B');
    }
};

const onAmount = (side: 'A' | 'B', value: unknown): void => {
    if (side === 'A') {
        amountA.value = String(value ?? '');
    } else {
        amountB.value = String(value ?? '');
    }

    pairFrom(side);
};

const pickToken = (side: 'A' | 'B', value: unknown): void => {
    if (side === 'A') {
        tokenA.value = String(value ?? '');
    } else {
        tokenB.value = String(value ?? '');
    }
};

const positionRange = (p: V3Position): string =>
    `${price(priceAtTick(p.tickLower, p.dec0, p.dec1))} – ${price(priceAtTick(p.tickUpper, p.dec0, p.dec1))}`;

onMounted(() => {
    if (!tokenA.value) {
        tokenA.value = nativeSentinel.value;
    }
});
</script>

<template>
    <div class="space-y-3 rounded-lg border p-4">
        <!-- ADD: pair, then tier, then range, then amounts. In that order,
             because each one decides what the next one may be. -->
        <template v-if="tab === 'add'">
            <div class="grid grid-cols-2 gap-2">
                <Select
                    v-for="side in ['A', 'B'] as const"
                    :key="side"
                    :model-value="side === 'A' ? tokenA : tokenB"
                    @update:model-value="pickToken(side, $event)"
                >
                    <SelectTrigger class="h-11">
                        <span
                            v-if="side === 'A' ? tokenA : tokenB"
                            class="flex items-center gap-2 font-medium"
                        >
                            <TokenIcon
                                :symbol="
                                    symbolOf(side === 'A' ? tokenA : tokenB)
                                "
                                :size="20"
                            />
                            {{ symbolOf(side === 'A' ? tokenA : tokenB) }}
                        </span>
                        <SelectValue v-else placeholder="Select token" />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem
                            v-for="t in tokens"
                            :key="t.address"
                            :value="t.address"
                        >
                            <span class="flex items-center gap-2">
                                <TokenIcon :symbol="t.symbol" :size="20" />
                                {{ t.symbol }}
                            </span>
                        </SelectItem>
                    </SelectContent>
                </Select>
            </div>

            <p v-if="!pairReady" class="text-sm text-muted-foreground">
                Pick two different tokens to see the fee tiers they have pools
                in.
            </p>

            <template v-else>
                <!-- FEE TIER: it decides the tick spacing, so it is picked
                     before the range and not after it. -->
                <div>
                    <div
                        class="mb-1 flex items-center justify-between text-xs text-muted-foreground"
                    >
                        <span>Fee tier</span>
                        <span v-if="tiersLoading">
                            <Loader2 class="inline h-3 w-3 animate-spin" />
                            reading the pools…
                        </span>
                    </div>
                    <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
                        <button
                            v-for="t in tiers"
                            :key="t.tier"
                            type="button"
                            class="rounded-md border p-2 text-left text-sm transition"
                            :class="
                                t.tier === tier
                                    ? 'border-primary bg-primary/10'
                                    : 'border-border hover:border-foreground/30'
                            "
                            @click="tier = t.tier"
                        >
                            <span class="block font-medium">
                                {{ pct(t.tier) }}
                            </span>
                            <span class="block text-xs text-muted-foreground">
                                <template v-if="!t.created">no pool</template>
                                <template v-else-if="!t.initialized">
                                    no price yet
                                </template>
                                <template v-else-if="t.liquidity === 0n">
                                    empty
                                </template>
                                <template v-else>liquidity</template>
                            </span>
                            <!-- The tier addresses the pool; the fee is what it
                                 charges, and in this fork they differ. -->
                            <span
                                v-if="t.initialized && t.fee !== t.tier"
                                class="block text-xs text-amber-500"
                            >
                                charges {{ pct(t.fee) }}
                            </span>
                        </button>
                    </div>
                </div>

                <!-- THE POOL, or the price of one that does not exist yet -->
                <div class="rounded-md border p-3 text-sm">
                    <template v-if="selectedTier?.initialized">
                        <div class="flex items-center justify-between">
                            <span class="text-muted-foreground">
                                Pool price
                            </span>
                            <button
                                type="button"
                                class="text-xs text-muted-foreground underline"
                                @click="flipOrientation"
                            >
                                {{ quoteSymbol }} per {{ baseSymbol }}
                            </button>
                        </div>
                        <p class="font-mono">
                            1 {{ baseSymbol }} =
                            {{ price(currentPriceShown ?? 0) }}
                            {{ quoteSymbol }}
                        </p>
                    </template>
                    <template v-else>
                        <p class="mb-2 text-amber-500">
                            No pool at this tier yet. You would create it, and
                            the price you write here is the price the first
                            trade pays.
                        </p>
                        <div class="flex items-center gap-2">
                            <Input
                                v-model="initialPriceInput"
                                placeholder="0.0"
                                inputmode="decimal"
                            />
                            <button
                                type="button"
                                class="shrink-0 text-xs text-muted-foreground underline"
                                @click="flipOrientation"
                            >
                                {{ quoteSymbol }} per {{ baseSymbol }}
                            </button>
                        </div>
                        <p class="mt-2 text-xs text-muted-foreground">
                            Creating it from your own address keeps the one
                            right the factory records for a pool's creator:
                            setting what it charges, once, downward from
                            {{ pct(tier) }}.
                        </p>
                    </template>
                </div>

                <!-- THE RANGE. Every price here is read back out of the tick it
                     was snapped to, never out of what was typed. -->
                <div class="space-y-2">
                    <div
                        class="flex flex-wrap items-center justify-between gap-2"
                    >
                        <span class="text-xs text-muted-foreground">
                            Price range
                        </span>
                        <div class="flex flex-wrap gap-1">
                            <Button
                                size="sm"
                                :variant="
                                    activePreset === 'full'
                                        ? 'default'
                                        : 'outline'
                                "
                                @click="applyPreset('full')"
                            >
                                Full
                            </Button>
                            <Button
                                v-for="preset in RANGE_PRESETS"
                                :key="preset"
                                size="sm"
                                :variant="
                                    activePreset === preset
                                        ? 'default'
                                        : 'outline'
                                "
                                @click="applyPreset(preset)"
                            >
                                ±{{ preset }}%
                            </Button>
                        </div>
                    </div>

                    <div class="grid grid-cols-2 gap-2">
                        <label class="rounded-md border p-2">
                            <span class="block text-xs text-muted-foreground">
                                Min price
                            </span>
                            <Input
                                v-model="minInput"
                                class="border-0 px-0 shadow-none focus-visible:ring-0"
                                inputmode="decimal"
                                @blur="commitBound('min')"
                                @keyup.enter="commitBound('min')"
                            />
                            <span class="block text-xs text-muted-foreground">
                                {{ quoteSymbol }} per {{ baseSymbol }}
                            </span>
                        </label>
                        <label class="rounded-md border p-2">
                            <span class="block text-xs text-muted-foreground">
                                Max price
                            </span>
                            <Input
                                v-model="maxInput"
                                class="border-0 px-0 shadow-none focus-visible:ring-0"
                                inputmode="decimal"
                                @blur="commitBound('max')"
                                @keyup.enter="commitBound('max')"
                            />
                            <span class="block text-xs text-muted-foreground">
                                {{ quoteSymbol }} per {{ baseSymbol }}
                            </span>
                        </label>
                    </div>

                    <p v-if="isFullRange" class="text-xs text-muted-foreground">
                        The full range behaves like a v2 pair: it never stops
                        earning and it is never deep.
                    </p>
                    <p
                        v-else-if="rangeState && rangeState !== 'in'"
                        class="text-xs text-amber-500"
                    >
                        The price is
                        {{ rangeState === 'below' ? 'below' : 'above' }} this
                        range, so the deposit is one-sided and earns nothing
                        until the price comes back into it.
                    </p>
                </div>

                <!-- THE AMOUNTS. One is typed; the range decides the other. -->
                <div class="space-y-2">
                    <div
                        v-for="side in ['A', 'B'] as const"
                        :key="side"
                        class="rounded-md border p-3"
                        :class="{
                            'opacity-50':
                                side === 'A' ? !depositable.a : !depositable.b,
                        }"
                    >
                        <div
                            class="mb-1 flex items-center justify-between text-sm"
                        >
                            <span class="flex items-center gap-2 font-medium">
                                <TokenIcon
                                    :symbol="
                                        symbolOf(side === 'A' ? tokenA : tokenB)
                                    "
                                    :size="20"
                                />
                                {{ symbolOf(side === 'A' ? tokenA : tokenB) }}
                            </span>
                            <button
                                class="text-xs text-muted-foreground hover:underline"
                                @click="setMax(side)"
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
                            :disabled="
                                side === 'A' ? !depositable.a : !depositable.b
                            "
                            placeholder="0.0"
                            inputmode="decimal"
                            @update:model-value="onAmount(side, $event)"
                        />
                    </div>
                </div>

                <p v-if="shortOfBalance" class="text-xs text-red-500">
                    Not enough {{ shortOfBalance }}.
                </p>

                <Button
                    class="w-full"
                    :disabled="
                        busy || (wallet.isConnected.value && !canDeposit)
                    "
                    @click="deposit"
                >
                    <Loader2 v-if="busy" class="mr-2 h-4 w-4 animate-spin" />
                    <template v-if="!wallet.isConnected.value">
                        Connect wallet
                    </template>
                    <template v-else-if="!selectedTier?.created">
                        Create pool & add liquidity
                    </template>
                    <template v-else-if="!selectedTier?.initialized">
                        Set the price & add liquidity
                    </template>
                    <template v-else>Add liquidity</template>
                </Button>
            </template>
        </template>

        <!-- POSITIONS: an NFT each, so one pair can appear five times. -->
        <template v-else>
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
                    Reading your positions…
                </p>
                <p
                    v-else-if="positions.length === 0 && !positionsError"
                    class="text-sm text-muted-foreground"
                >
                    No V3 positions in this wallet on
                    {{ chain.evmChain.name }}.
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

                <div
                    v-for="p in positions"
                    :key="p.tokenId.toString()"
                    class="rounded-md border"
                    :class="{
                        'ring-2 ring-primary':
                            selectedId === p.tokenId.toString(),
                    }"
                >
                    <button
                        class="flex w-full items-center justify-between p-3 text-left"
                        @click="
                            selectedId =
                                selectedId === p.tokenId.toString()
                                    ? null
                                    : p.tokenId.toString()
                        "
                    >
                        <span class="flex items-center gap-2">
                            <TokenIcon :symbol="p.sym0" :size="20" />
                            <TokenIcon :symbol="p.sym1" :size="20" />
                            <span>
                                <span class="block font-medium">
                                    {{ p.sym0 }}/{{ p.sym1 }}
                                </span>
                                <span
                                    class="block text-xs text-muted-foreground"
                                >
                                    {{ pct(p.fee) }} · #{{ p.tokenId }}
                                </span>
                            </span>
                        </span>
                        <span class="text-right">
                            <span
                                class="block text-xs"
                                :class="
                                    positionInRange(p)
                                        ? 'text-emerald-500'
                                        : 'text-amber-500'
                                "
                            >
                                {{
                                    positionInRange(p)
                                        ? 'in range'
                                        : 'out of range'
                                }}
                            </span>
                            <span
                                class="block font-mono text-xs text-muted-foreground"
                            >
                                {{ fmt(p.amount0, p.dec0, 4) }} {{ p.sym0 }} +
                                {{ fmt(p.amount1, p.dec1, 4) }} {{ p.sym1 }}
                            </span>
                        </span>
                    </button>

                    <div
                        v-if="selectedId === p.tokenId.toString()"
                        class="space-y-3 border-t p-3"
                    >
                        <p class="text-xs text-muted-foreground">
                            Range {{ positionRange(p) }} {{ p.sym1 }} per
                            {{ p.sym0 }} · pool price
                            {{ price(priceAtTick(p.tick, p.dec0, p.dec1)) }}
                        </p>
                        <p class="text-sm">
                            Uncollected:
                            <span class="font-mono">
                                {{ fmt(p.owed0, p.dec0) }} {{ p.sym0 }} +
                                {{ fmt(p.owed1, p.dec1) }} {{ p.sym1 }}
                            </span>
                        </p>

                        <label
                            v-if="positionHasWrappedNative(p)"
                            class="flex items-center gap-2 text-sm"
                        >
                            <input v-model="receiveNative" type="checkbox" />
                            Take {{ chain.nativeSymbol }} back as the coin
                            rather than as its wrapper
                        </label>

                        <!-- WITHDRAW -->
                        <template v-if="p.liquidity > 0n">
                            <div class="flex items-center gap-2">
                                <Button
                                    v-for="value in [25, 50, 75, 100]"
                                    :key="value"
                                    size="sm"
                                    :variant="
                                        removePct === value
                                            ? 'default'
                                            : 'outline'
                                    "
                                    @click="removePct = value"
                                >
                                    {{ value }}%
                                </Button>
                            </div>
                            <p
                                v-if="removal"
                                class="text-sm text-muted-foreground"
                            >
                                You receive ≈
                                {{ fmt(removal.amount0, p.dec0) }}
                                {{ p.sym0 }} +
                                {{ fmt(removal.amount1, p.dec1) }} {{ p.sym1 }},
                                plus everything uncollected.
                            </p>
                            <p
                                v-if="removePct === 100"
                                class="text-xs text-muted-foreground"
                            >
                                Taking all of it out burns the position NFT.
                            </p>
                            <div class="flex gap-2">
                                <Button
                                    class="flex-1"
                                    :disabled="busy"
                                    @click="removeLiquidity"
                                >
                                    <Loader2
                                        v-if="busy"
                                        class="mr-2 h-4 w-4 animate-spin"
                                    />
                                    Remove
                                </Button>
                                <Button
                                    variant="outline"
                                    :disabled="
                                        busy ||
                                        (p.owed0 === 0n && p.owed1 === 0n)
                                    "
                                    @click="collectFees"
                                >
                                    Collect fees
                                </Button>
                            </div>
                        </template>
                        <Button
                            v-else
                            class="w-full"
                            :disabled="busy"
                            @click="collectFees"
                        >
                            Collect what is owed
                        </Button>

                        <!-- TOP UP: the range is fixed, so only the amounts
                             are a decision here. -->
                        <details class="rounded-md border p-2">
                            <summary
                                class="cursor-pointer text-sm text-muted-foreground"
                            >
                                Add to this position
                            </summary>
                            <div class="mt-2 space-y-2">
                                <div
                                    class="flex items-center gap-2"
                                    :class="{
                                        'opacity-50': !topUpAmounts?.takes0,
                                    }"
                                >
                                    <span class="w-24 shrink-0 text-sm">
                                        {{ p.sym0 }}
                                    </span>
                                    <Input
                                        :model-value="topUp0"
                                        :disabled="!topUpAmounts?.takes0"
                                        placeholder="0.0"
                                        inputmode="decimal"
                                        @update:model-value="
                                            ((topUp0 = String($event)),
                                            pairTopUp(0))
                                        "
                                    />
                                </div>
                                <div
                                    class="flex items-center gap-2"
                                    :class="{
                                        'opacity-50': !topUpAmounts?.takes1,
                                    }"
                                >
                                    <span class="w-24 shrink-0 text-sm">
                                        {{ p.sym1 }}
                                    </span>
                                    <Input
                                        :model-value="topUp1"
                                        :disabled="!topUpAmounts?.takes1"
                                        placeholder="0.0"
                                        inputmode="decimal"
                                        @update:model-value="
                                            ((topUp1 = String($event)),
                                            pairTopUp(1))
                                        "
                                    />
                                </div>
                                <Button
                                    class="w-full"
                                    variant="outline"
                                    :disabled="busy"
                                    @click="increaseLiquidity"
                                >
                                    Add
                                </Button>
                            </div>
                        </details>
                    </div>
                </div>

                <p v-if="closedCount > 0" class="text-xs text-muted-foreground">
                    {{ closedCount }} closed
                    {{ closedCount === 1 ? 'position' : 'positions' }} hidden.
                </p>
            </template>
        </template>

        <p v-if="status" class="text-sm">{{ status }}</p>
        <p v-if="error" class="text-sm text-red-500">{{ error }}</p>

        <p class="text-xs text-muted-foreground">
            Positions
            <a
                :href="`${chain.explorer}/address/${v3.positionManager}`"
                target="_blank"
                class="underline"
                >{{ shortAddr(v3.positionManager) }}</a
            >
        </p>
    </div>
</template>
