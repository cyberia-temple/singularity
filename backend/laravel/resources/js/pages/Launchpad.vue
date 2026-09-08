<script setup lang="ts">
import { Head } from '@inertiajs/vue3';
import {
    Contract,
    Interface,
    JsonRpcProvider,
    ZeroAddress,
    formatUnits,
    id,
    parseUnits,
} from 'ethers';
import type { UTCTimestamp } from 'lightweight-charts';
import { Loader2 } from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import TokenCandlesChart from '@/components/launchpad/TokenCandlesChart.vue';
import { Input } from '@/components/ui/input';
import { useWallet } from '@/composables/useWallet';
import { formatNum, formatPrice } from '@/lib/dexFormat';
import { ensureEvmNetwork } from '@/lib/evmChains';
import {
    DEFAULT_LAUNCHPAD_CHAIN_ID,
    LAUNCHPAD_CHAINS,
    deployedLaunchpadChains,
    launchpadChain,
    launchpadExplorerAddressUrl,
    launchpadExplorerTxUrl,
    launchpadReadRpcUrl,
    launchpadSwapUrl,
} from '@/lib/launchpadChains';
import type { LaunchpadChain } from '@/lib/launchpadChains';
import type { TokenCandle } from '@/lib/launchpadChart';

// LaunchpadNative — fair launches paid in the chain's native coin, burned into
// permanently locked liquidity. A launch may target several chains at once;
// contract addresses per chain live in lib/launchpadChains.ts.
//
// The listing below ("Live launches", charts, prices) still reads Cyberia
// only: it is the chain with the launch history, and every satellite launch
// links out to its own explorer from the deployment panel.
const LISTING_CHAIN: LaunchpadChain =
    launchpadChain(DEFAULT_LAUNCHPAD_CHAIN_ID) ?? LAUNCHPAD_CHAINS[0];
const LAUNCHPAD_ADDRESS = LISTING_CHAIN.launchpad ?? '';
const WCYBER_ADDRESS = LISTING_CHAIN.wrappedNative;

const LAUNCHPAD_ABI = [
    'function minLiquidity() view returns (uint256)',
    'function allTokensLength() view returns (uint256)',
    'function allTokens(uint256) view returns (address)',
    'function pairOf(address) view returns (address)',
    'function launch(string,string,uint256) payable returns (address,address,uint256)',
    'event TokenLaunched(address indexed token, address indexed creator, address pair, string name, string symbol, uint256 tokenSupply, uint256 cyberLiquidity, uint256 lpBurned)',
];

/**
 * The v3 launchpad: a launch whose creator names the trading fee.
 *
 * `launch` takes two arguments the v2 one has no vocabulary for — the fee, in
 * hundredths of a bip, and how much of that fee goes to holders — and answers
 * with a *pool* rather than a pair. `quote` is the same arithmetic the contract
 * itself uses, exposed so this screen can print the promise instead of
 * restating it in JavaScript that could drift from it.
 */
const LAUNCHPAD_V3_ABI = [
    'function minLiquidity() view returns (uint256)',
    'function MAX_CREATOR_FEE() view returns (uint24)',
    'function PROTOCOL_FEE() view returns (uint24)',
    'function quote(uint24 creatorFee, uint16 holdersShareBps) view returns (uint24 poolFee, uint16 creatorBps, uint16 holdersBps, uint16 treasuryBps)',
    'function launch(string,string,uint256,uint24,uint16) payable returns (address,address,uint256)',
    'event TokenLaunched(address indexed token, address indexed creator, address pool, string name, string symbol, uint256 tokenSupply, uint256 cyberLiquidity)',
    'event LaunchTerms(address indexed token, uint256 positionId, uint24 poolFee, uint16 creatorBps, uint16 holdersBps, uint16 treasuryBps)',
];

const PAIR_ABI = [
    'event Sync(uint112 reserve0, uint112 reserve1)',
    'event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)',
    'function token0() view returns (address)',
    'function token1() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const FACTORY_ABI = [
    'function getPair(address tokenA, address tokenB) view returns (address)',
];
const FACTORY_ADDRESS = LISTING_CHAIN.factory;

const ERC20_READ_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
];

const SWAP_BASE_URL = LISTING_CHAIN.swapUrl;
const EXPLORER_BASE_URL = LISTING_CHAIN.explorerUrl;
const SWAP_TOPIC = id('Swap(address,uint256,uint256,uint256,uint256,address)');
const SYNC_TOPIC = id('Sync(uint112,uint112)');
const TOKEN_LAUNCHED_TOPIC = id(
    'TokenLaunched(address,address,address,string,string,uint256,uint256,uint256)',
);

type LaunchedToken = {
    chainId: number;
    token: string;
    pair: string;
    creator: string;
    name: string;
    symbol: string;
    tokenSupply: bigint;
    cyberLiquidity: bigint;
    quoteSymbol: string;
    txHash?: string;
    // Enriched off-chain.
    description?: string | null;
    xHandle?: string | null;
    xUrl?: string | null;
    telegramHandle?: string | null;
    telegramUrl?: string | null;
    websiteUrl?: string | null;
    imageUrl?: string | null;
    siteSubdomain?: string | null;
    siteUrl?: string | null;
    ipfsUri?: string | null;
    ipfsUrl?: string | null;
    // Enriched from pair reserves (price quoted in the pair's quote asset).
    priceCyber?: number | null;
    marketCapCyber?: number | null;
    launchBlock?: number | null;
};

type LaunchpadMetadata = {
    chain_id: number;
    address: string;
    creator: string | null;
    name: string | null;
    symbol: string | null;
    description: string | null;
    x_handle: string | null;
    x_url: string | null;
    telegram_handle: string | null;
    telegram_url: string | null;
    website_url: string | null;
    image_url: string | null;
    site_subdomain: string | null;
    site_url: string | null;
    ipfs_cid: string | null;
    ipfs_uri: string | null;
    ipfs_url: string | null;
};

type LaunchEventMeta = {
    creator: string;
    pair: string;
    blockNumber: number;
    txHash: string;
};

type RawCandle = Omit<TokenCandle, 'time'>;

type ExplorerLog = {
    transaction_hash: string;
    block_number: number;
    index: number;
    topics: (string | null)[];
    data: string;
};

type ExplorerLogsResponse = {
    items: ExplorerLog[];
    next_page_params: Record<string, string | number> | null;
};

const wallet = useWallet();

const priceHistories = ref<Record<string, TokenCandle[]>>({});
const historyLoaded = ref<Record<string, boolean>>({});

const name = ref('');
const symbol = ref('');
const description = ref('');
// Where the project talks. Taken as typed — `@name`, a bare name or a pasted
// profile URL — and collapsed to a bare handle by the server.
const xHandle = ref('');
const telegramHandle = ref('');
const websiteUrl = ref('');
const siteSubdomain = ref('');
/**
 * What a trade through this launch will cost, in percent, and how much of it
 * the creator hands to holders.
 *
 * Only meaningful where a v3 launchpad exists. The defaults are deliberate: a
 * 1% creator fee is a real fee that does not scare a market, and none of it is
 * shared until somebody decides to share it — a default that quietly gives
 * away a creator's income is a default that gets discovered afterwards.
 */
const creatorFeePct = ref('1');
const holdersSharePct = ref('0');
const imageFile = ref<File | null>(null);
const imagePreview = ref<string | null>(null);
const htmlFile = ref<File | null>(null);
const htmlFileName = ref<string | null>(null);

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const SUBDOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const normalizedSubdomain = (value: string): string =>
    value.trim().toLowerCase();

const siteSubdomainInvalid = computed(() => {
    const value = normalizedSubdomain(siteSubdomain.value);

    return value.length > 0 && !SUBDOMAIN_PATTERN.test(value);
});

const onHtmlChange = (event: Event): void => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0] ?? null;
    error.value = null;

    if (file && file.size > MAX_HTML_BYTES) {
        error.value = `HTML page must be ≤ 2 MB (got ${(file.size / 1024 / 1024).toFixed(2)} MB)`;
        target.value = '';
        htmlFile.value = null;
        htmlFileName.value = null;

        return;
    }

    htmlFile.value = file;
    htmlFileName.value = file?.name ?? null;
};

const onImageChange = (event: Event): void => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0] ?? null;
    error.value = null;

    if (file && file.size > MAX_IMAGE_BYTES) {
        error.value = `Image must be ≤ 2 MB (got ${(file.size / 1024 / 1024).toFixed(2)} MB)`;
        target.value = '';
        imageFile.value = null;

        return;
    }

    imageFile.value = file;

    if (imagePreview.value) {
        URL.revokeObjectURL(imagePreview.value);
        imagePreview.value = null;
    }

    if (file) {
        imagePreview.value = URL.createObjectURL(file);
    }
};

const recent = ref<LaunchedToken[]>([]);
const totalLaunches = ref(0);

const busy = ref(false);
const status = ref<string | null>(null);
const error = ref<string | null>(null);

const readProviders = new Map<number, JsonRpcProvider>();

const readProviderFor = (target: LaunchpadChain): JsonRpcProvider => {
    const cached = readProviders.get(target.chain.chainId);

    if (cached) {
        return cached;
    }

    const provider = new JsonRpcProvider(launchpadReadRpcUrl(target), {
        chainId: target.chain.chainId,
        name: target.chain.name.toLowerCase(),
    });
    readProviders.set(target.chain.chainId, provider);

    return provider;
};

const readProvider = readProviderFor(LISTING_CHAIN);

/**
 * One row per chain the token is launched on. `launched` flips as soon as a
 * launch transaction is mined and is persisted, so retrying a partially
 * failed multichain launch never deploys a second contract on a chain that
 * already has one.
 */
type LaunchStage =
    | 'idle'
    | 'sending'
    | 'mining'
    | 'metadata'
    | 'done'
    | 'failed';

type LaunchTarget = {
    chainId: number;
    label: string;
    currency: string;
    selected: boolean;
    supply: string;
    liquidity: string;
    minLiquidity: bigint;
    balance: bigint;
    stage: LaunchStage;
    launched: boolean;
    metadataDone: boolean;
    txHash: string | null;
    token: string | null;
    pair: string | null;
    error: string | null;
};

const blankTarget = (target: LaunchpadChain): LaunchTarget => ({
    chainId: target.chain.chainId,
    label: target.chain.name,
    currency: target.chain.nativeCurrency.symbol,
    selected: target.chain.chainId === DEFAULT_LAUNCHPAD_CHAIN_ID,
    supply: '1000000',
    // All of it ends up burned inside the LP.
    liquidity: target.defaultLiquidity,
    minLiquidity: 0n,
    balance: 0n,
    stage: 'idle',
    launched: false,
    metadataDone: false,
    txHash: null,
    token: null,
    pair: null,
    error: null,
});

const launchTargets = ref<LaunchTarget[]>(
    deployedLaunchpadChains().map(blankTarget),
);

/** Chains in the registry that have no LaunchpadNative deployed yet. */
const unavailableChains = LAUNCHPAD_CHAINS.filter(
    (target) => target.launchpad === null,
);

const parseAmount = (value: string): bigint => {
    try {
        return parseUnits(value || '0', 18);
    } catch {
        return 0n;
    }
};

// Leave a little native headroom for gas on top of the liquidity itself.
const GAS_HEADROOM = parseUnits('0.01', 18);

/**
 * A transaction that was sent but whose receipt never came back has to be
 * checked by hand — retrying it blind could deploy the token twice.
 */
const needsManualCheck = (target: LaunchTarget): boolean =>
    target.txHash !== null && !target.launched;

const targetIssue = (target: LaunchTarget): string | null => {
    if (target.launched) {
        return null;
    }

    const liquidity = parseAmount(target.liquidity);

    if (parseAmount(target.supply) <= 0n) {
        return 'Set a total supply.';
    }

    if (liquidity <= 0n) {
        return 'Set the liquidity amount.';
    }

    if (target.minLiquidity > 0n && liquidity < target.minLiquidity) {
        return `Minimum is ${fmt(target.minLiquidity)} ${target.currency}.`;
    }

    // A zero balance means the read failed (satellite RPCs are not always
    // reachable from the browser), so the check is skipped rather than lying.
    if (target.balance > 0n && target.balance < liquidity + GAS_HEADROOM) {
        return `Not enough ${target.currency} for the liquidity plus gas.`;
    }

    return null;
};

/**
 * What is still to be done on a chain: the launch itself, or the metadata
 * upload for a token that is already deployed. A launched token whose address
 * could not be read back is left alone — its metadata is attached by hand from
 * the token list instead.
 */
const targetPending = (target: LaunchTarget): boolean =>
    target.selected &&
    !needsManualCheck(target) &&
    (!target.launched || (target.token !== null && !target.metadataDone));

const selectedTargets = computed(() =>
    launchTargets.value.filter((target) => target.selected),
);

/** Whichever launchpad the chosen chains run. v3 anywhere means v3 terms. */
const v3Targets = computed(() =>
    selectedTargets.value.filter((t) => launchpadChain(t.chainId)?.launchpadV3),
);
const usesV3 = computed(() => v3Targets.value.length > 0);

/** The creator's fee in hundredths of a bip, which is what the contract takes. */
const creatorFeeUnits = computed(() => {
    const pct = Number(creatorFeePct.value);

    return Number.isFinite(pct) && pct >= 0
        ? Math.round(Math.min(pct, 10) * 10_000)
        : 0;
});

/** The holders' share of that fee, in basis points. */
const holdersShareBps = computed(() => {
    const pct = Number(holdersSharePct.value);

    return Number.isFinite(pct) && pct >= 0
        ? Math.round(Math.min(pct, 100) * 100)
        : 0;
});

const feeInputInvalid = computed(() => {
    const fee = Number(creatorFeePct.value);
    const share = Number(holdersSharePct.value);

    return (
        !Number.isFinite(fee) ||
        fee < 0 ||
        fee > 10 ||
        !Number.isFinite(share) ||
        share < 0 ||
        share > 100
    );
});

/**
 * The split, as the contract itself computes it.
 *
 * Read from `quote()` rather than reproduced here: the same arithmetic written
 * twice is the same arithmetic until one of them changes. Null while it is
 * being read, or when the chain did not answer — the screen says so instead of
 * showing numbers it made up.
 */
const launchTerms = ref<{
    poolFee: number;
    creatorBps: number;
    holdersBps: number;
    treasuryBps: number;
} | null>(null);

const refreshLaunchTerms = async (): Promise<void> => {
    const registry = v3Targets.value
        .map((t) => launchpadChain(t.chainId))
        .find((c) => c?.launchpadV3);

    if (!registry?.launchpadV3 || feeInputInvalid.value) {
        launchTerms.value = null;

        return;
    }

    try {
        const provider = new JsonRpcProvider(launchpadReadRpcUrl(registry));
        const pad = new Contract(
            registry.launchpadV3,
            LAUNCHPAD_V3_ABI,
            provider,
        );
        const [poolFee, creatorBps, holdersBps, treasuryBps] = await pad.quote(
            creatorFeeUnits.value,
            holdersShareBps.value,
        );

        launchTerms.value = {
            poolFee: Number(poolFee),
            creatorBps: Number(creatorBps),
            holdersBps: Number(holdersBps),
            treasuryBps: Number(treasuryBps),
        };
    } catch {
        launchTerms.value = null;
    }
};

const pendingTargets = computed(() =>
    launchTargets.value.filter(targetPending),
);

const startedTargets = computed(() =>
    launchTargets.value.filter(
        (target) => target.launched || target.txHash !== null,
    ),
);

const canLaunch = computed(
    () =>
        !busy.value &&
        wallet.isConnected.value &&
        name.value.trim().length > 0 &&
        symbol.value.trim().length > 0 &&
        pendingTargets.value.length > 0 &&
        selectedTargets.value.every((target) => targetIssue(target) === null) &&
        !siteSubdomainInvalid.value &&
        (!siteSubdomain.value.trim() || htmlFile.value !== null),
);

/**
 * Deployed contracts survive a reload: the results of every mined launch are
 * kept in local storage until the whole multichain launch is finished, so a
 * refresh in the middle of one cannot lose an address and cause a redeploy.
 */
const DRAFT_KEY = 'cyberia.launchpad.multichain.v1';

type LaunchDraftRow = Pick<
    LaunchTarget,
    | 'chainId'
    | 'supply'
    | 'liquidity'
    | 'launched'
    | 'metadataDone'
    | 'txHash'
    | 'token'
    | 'pair'
>;

type LaunchDraft = {
    name: string;
    symbol: string;
    rows: LaunchDraftRow[];
};

const persistDraft = (): void => {
    try {
        const rows = startedTargets.value.map(
            (target): LaunchDraftRow => ({
                chainId: target.chainId,
                supply: target.supply,
                liquidity: target.liquidity,
                launched: target.launched,
                metadataDone: target.metadataDone,
                txHash: target.txHash,
                token: target.token,
                pair: target.pair,
            }),
        );

        if (rows.length === 0) {
            localStorage.removeItem(DRAFT_KEY);

            return;
        }

        localStorage.setItem(
            DRAFT_KEY,
            JSON.stringify({
                name: name.value,
                symbol: symbol.value,
                rows,
            } satisfies LaunchDraft),
        );
    } catch {
        // Storage disabled (private mode) — the in-memory state still guards
        // the current page session.
    }
};

const restoreDraft = (): void => {
    let draft: LaunchDraft | null = null;

    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        draft = raw ? (JSON.parse(raw) as LaunchDraft) : null;
    } catch {
        draft = null;
    }

    if (!draft || !Array.isArray(draft.rows) || draft.rows.length === 0) {
        return;
    }

    name.value = draft.name ?? '';
    symbol.value = draft.symbol ?? '';

    for (const row of draft.rows) {
        const target = launchTargets.value.find(
            (candidate) => candidate.chainId === row.chainId,
        );

        if (!target) {
            continue;
        }

        target.selected = true;
        target.supply = row.supply ?? target.supply;
        target.liquidity = row.liquidity ?? target.liquidity;
        target.launched = Boolean(row.launched);
        target.metadataDone = Boolean(row.metadataDone);
        target.txHash = row.txHash ?? null;
        target.token = row.token ?? null;
        target.pair = row.pair ?? null;
        target.stage =
            target.launched && target.metadataDone ? 'done' : 'failed';
        target.error = target.launched
            ? target.metadataDone
                ? null
                : 'Launched, but the metadata upload did not finish.'
            : 'Transaction was sent — check it before retrying.';
    }
};

/** Forget a finished (or checked) launch so the form can be reused. */
const startOver = (): void => {
    launchTargets.value = deployedLaunchpadChains().map(blankTarget);
    name.value = '';
    symbol.value = '';
    status.value = null;
    error.value = null;
    persistDraft();
    void loadOnchain();
};

/** Drop one row's transaction record after the operator checked it manually. */
const clearTarget = (target: LaunchTarget): void => {
    target.stage = 'idle';
    target.launched = false;
    target.metadataDone = false;
    target.txHash = null;
    target.token = null;
    target.pair = null;
    target.error = null;
    persistDraft();
};

const totalCyberLocked = computed(() =>
    recent.value.reduce((acc, t) => acc + t.cyberLiquidity, 0n),
);

type SortKey = 'new' | 'mcap' | 'liq';
const sortBy = ref<SortKey>('new');
const sortTabs: { key: SortKey; label: string }[] = [
    { key: 'new', label: 'Newest' },
    { key: 'mcap', label: 'Market cap' },
    { key: 'liq', label: 'Liquidity' },
];

const sortedRecent = computed<LaunchedToken[]>(() => {
    // 'new' keeps the on-chain newest-first order.
    if (sortBy.value === 'new') {
        return recent.value;
    }

    const list = [...recent.value];

    if (sortBy.value === 'mcap') {
        list.sort((a, b) => (b.marketCapCyber ?? 0) - (a.marketCapCyber ?? 0));
    } else {
        list.sort((a, b) =>
            b.cyberLiquidity > a.cyberLiquidity
                ? 1
                : b.cyberLiquidity < a.cyberLiquidity
                  ? -1
                  : 0,
        );
    }

    return list;
});

/** Per-chain minimum liquidity and wallet balance, best effort. */
const loadChainState = async (target: LaunchTarget): Promise<void> => {
    const registry = launchpadChain(target.chainId);

    if (!registry?.launchpad) {
        return;
    }

    const provider = readProviderFor(registry);

    try {
        const launchpad = new Contract(
            registry.launchpad,
            LAUNCHPAD_ABI,
            provider,
        );
        target.minLiquidity = (await launchpad.minLiquidity()) as bigint;
    } catch {
        target.minLiquidity = 0n;
    }

    if (!wallet.address.value) {
        target.balance = 0n;

        return;
    }

    try {
        target.balance = await provider.getBalance(wallet.address.value);
    } catch {
        target.balance = 0n;
    }
};

const loadOnchain = async (): Promise<void> => {
    await Promise.all(
        launchTargets.value.map((target) => loadChainState(target)),
    );
};

const metadataKey = (chainId: number, address: string): string =>
    `${chainId}:${address.toLowerCase()}`;

const fetchMetadata = async (): Promise<Map<string, LaunchpadMetadata>> => {
    try {
        const res = await fetch('/api/launchpad/tokens', {
            headers: { Accept: 'application/json' },
        });

        if (!res.ok) {
            return new Map();
        }

        const data = (await res.json()) as { tokens: LaunchpadMetadata[] };
        const map = new Map<string, LaunchpadMetadata>();

        // Metadata is keyed per chain: the same address on another chain is
        // another token. The listing only asks for the listing chain.
        for (const t of data.tokens) {
            map.set(metadataKey(t.chain_id, t.address), t);
        }

        return map;
    } catch {
        return new Map();
    }
};

const fetchAddressLogs = async (
    address: string,
    topic: string,
): Promise<ExplorerLog[]> => {
    const logs: ExplorerLog[] = [];
    let nextPage: Record<string, string | number> | null = null;

    do {
        const query = new URLSearchParams({ topic });

        if (nextPage) {
            Object.entries(nextPage).forEach(([key, value]) => {
                query.set(key, String(value));
            });
        }

        const response = await fetch(
            `${EXPLORER_BASE_URL}/api/v2/addresses/${address}/logs?${query.toString()}`,
            { headers: { Accept: 'application/json' } },
        );

        if (!response.ok) {
            throw new Error(
                `Explorer logs request failed (${response.status})`,
            );
        }

        const page = (await response.json()) as ExplorerLogsResponse;
        logs.push(...(Array.isArray(page.items) ? page.items : []));
        nextPage = page.next_page_params;
    } while (nextPage);

    return logs;
};

const fetchLaunchEvents = async (): Promise<Map<string, LaunchEventMeta>> => {
    const map = new Map<string, LaunchEventMeta>();

    try {
        const iface = new Interface(LAUNCHPAD_ABI);
        const logs = await fetchAddressLogs(
            LAUNCHPAD_ADDRESS,
            TOKEN_LAUNCHED_TOPIC,
        );

        for (const log of logs) {
            if (log.topics[0]?.toLowerCase() !== TOKEN_LAUNCHED_TOPIC) {
                continue;
            }

            try {
                const parsed = iface.parseLog({
                    topics: log.topics.filter(
                        (topic): topic is string => topic !== null,
                    ),
                    data: log.data,
                });

                if (parsed?.name !== 'TokenLaunched') {
                    continue;
                }

                const token = String(parsed.args.token).toLowerCase();
                map.set(token, {
                    creator: String(parsed.args.creator).toLowerCase(),
                    pair: String(parsed.args.pair),
                    blockNumber: log.block_number,
                    txHash: log.transaction_hash,
                });
            } catch {
                // Ignore logs that don't match the current ABI shape.
            }
        }
    } catch (e) {
        console.warn('[Launchpad] launch event history failed', e);
    }

    return map;
};

const priceFromReserves = (
    reserve0: bigint,
    reserve1: bigint,
    tokenIsToken0: boolean,
): {
    priceCyber: number;
    reserveCyber: bigint;
    reserveToken: bigint;
} | null => {
    const reserveToken = tokenIsToken0 ? reserve0 : reserve1;
    const reserveCyber = tokenIsToken0 ? reserve1 : reserve0;

    if (reserveToken === 0n || reserveCyber === 0n) {
        return null;
    }

    const tokenWhole = Number(formatUnits(reserveToken, 18));
    const cyberWhole = Number(formatUnits(reserveCyber, 18));

    if (!isFinite(tokenWhole) || tokenWhole <= 0 || !isFinite(cyberWhole)) {
        return null;
    }

    return {
        priceCyber: cyberWhole / tokenWhole,
        reserveCyber,
        reserveToken,
    };
};

const readPairPrice = async (
    pairAddr: string,
    tokenAddr: string,
): Promise<{
    priceCyber: number;
    reserveCyber: bigint;
    reserveToken: bigint;
    tokenIsToken0: boolean;
} | null> => {
    try {
        const pair = new Contract(pairAddr, PAIR_ABI, readProvider);
        const [token0, reserves] = await Promise.all([
            pair.token0(),
            pair.getReserves(),
        ]);
        const tokenIsToken0 =
            String(token0).toLowerCase() === tokenAddr.toLowerCase();
        const price = priceFromReserves(
            reserves[0] as bigint,
            reserves[1] as bigint,
            tokenIsToken0,
        );

        return price ? { ...price, tokenIsToken0 } : null;
    } catch {
        return null;
    }
};

const swapBreakdown = (
    amount0In: bigint,
    amount1In: bigint,
    amount0Out: bigint,
    amount1Out: bigint,
    tokenIsToken0: boolean,
): { executionPrice: number; cyberVolume: number } | null => {
    const tokenAmount = tokenIsToken0
        ? amount0In + amount0Out
        : amount1In + amount1Out;
    const cyberAmount = tokenIsToken0
        ? amount1In + amount1Out
        : amount0In + amount0Out;

    if (tokenAmount <= 0n || cyberAmount <= 0n) {
        return null;
    }

    const tokenWhole = Number(formatUnits(tokenAmount, 18));
    const cyberWhole = Number(formatUnits(cyberAmount, 18));

    if (
        !isFinite(tokenWhole) ||
        tokenWhole <= 0 ||
        !isFinite(cyberWhole) ||
        cyberWhole <= 0
    ) {
        return null;
    }

    return {
        executionPrice: cyberWhole / tokenWhole,
        cyberVolume: cyberWhole,
    };
};

// One candle per block: trades landing in the same block are merged, which
// also guarantees strictly increasing chart times.
const readPairTradeHistory = async (
    pairAddr: string,
    tokenIsToken0: boolean,
): Promise<RawCandle[]> => {
    if (!pairAddr || pairAddr === ZeroAddress) {
        return [];
    }

    try {
        const iface = new Interface(PAIR_ABI);
        const [swapLogs, syncLogs] = await Promise.all([
            fetchAddressLogs(pairAddr, SWAP_TOPIC),
            fetchAddressLogs(pairAddr, SYNC_TOPIC),
        ]);
        const logs = swapLogs
            .filter((log) => log.topics[0]?.toLowerCase() === SWAP_TOPIC)
            .sort(
                (left, right) =>
                    left.block_number - right.block_number ||
                    left.index - right.index,
            );
        const syncsByTransaction = new Map<string, ExplorerLog[]>();

        syncLogs.forEach((log) => {
            const key = log.transaction_hash.toLowerCase();
            const transactionSyncs = syncsByTransaction.get(key) ?? [];
            transactionSyncs.push(log);
            syncsByTransaction.set(key, transactionSyncs);
        });

        const candles: RawCandle[] = [];
        let previousClose: number | null = null;

        logs.forEach((log) => {
            try {
                const parsed = iface.parseLog({
                    topics: log.topics.filter(
                        (topic): topic is string => topic !== null,
                    ),
                    data: log.data,
                });

                if (parsed?.name !== 'Swap') {
                    return;
                }

                const amount0In = parsed.args.amount0In as bigint;
                const amount1In = parsed.args.amount1In as bigint;
                const amount0Out = parsed.args.amount0Out as bigint;
                const amount1Out = parsed.args.amount1Out as bigint;
                const breakdown = swapBreakdown(
                    amount0In,
                    amount1In,
                    amount0Out,
                    amount1Out,
                    tokenIsToken0,
                );
                const matchingSync = syncsByTransaction
                    .get(log.transaction_hash.toLowerCase())
                    ?.filter((sync) => sync.index < log.index)
                    .sort((left, right) => right.index - left.index)[0];
                let open = previousClose ?? breakdown?.executionPrice ?? null;
                let close = breakdown?.executionPrice ?? null;

                if (matchingSync) {
                    const parsedSync = iface.parseLog({
                        topics: matchingSync.topics.filter(
                            (topic): topic is string => topic !== null,
                        ),
                        data: matchingSync.data,
                    });

                    if (parsedSync?.name === 'Sync') {
                        const reserve0After = parsedSync.args
                            .reserve0 as bigint;
                        const reserve1After = parsedSync.args
                            .reserve1 as bigint;
                        const reserve0Before =
                            reserve0After - amount0In + amount0Out;
                        const reserve1Before =
                            reserve1After - amount1In + amount1Out;
                        const before = priceFromReserves(
                            reserve0Before,
                            reserve1Before,
                            tokenIsToken0,
                        );
                        const after = priceFromReserves(
                            reserve0After,
                            reserve1After,
                            tokenIsToken0,
                        );

                        open = before?.priceCyber ?? open;
                        close = after?.priceCyber ?? close;
                    }
                }

                if (open === null || close === null) {
                    return;
                }

                const volume = breakdown?.cyberVolume ?? 0;
                const last = candles[candles.length - 1];

                if (last && last.block === log.block_number) {
                    last.high = Math.max(last.high, open, close);
                    last.low = Math.min(last.low, open, close);
                    last.close = close;
                    last.volumeCyber += volume;
                    last.trades += 1;
                } else {
                    candles.push({
                        block: log.block_number,
                        open,
                        high: Math.max(open, close),
                        low: Math.min(open, close),
                        close,
                        volumeCyber: volume,
                        trades: 1,
                    });
                }

                previousClose = close;
            } catch {
                // Skip malformed logs.
            }
        });

        return candles;
    } catch (e) {
        console.warn('[Launchpad] pair trade history failed', e);

        return [];
    }
};

// Explorer logs carry block numbers but no timestamps. Fetch the real
// timestamps of the first and last candle blocks and interpolate between
// them — Cyberia blocks are near-uniform, so this is accurate enough for
// the chart's time axis.
const attachCandleTimes = async (
    candles: RawCandle[],
): Promise<TokenCandle[]> => {
    if (candles.length === 0) {
        return [];
    }

    const firstBlock = candles[0].block;
    const lastBlock = candles[candles.length - 1].block;
    let firstTs: number | null = null;
    let lastTs: number | null = null;

    try {
        const [first, last] = await Promise.all([
            readProvider.getBlock(firstBlock),
            firstBlock === lastBlock ? null : readProvider.getBlock(lastBlock),
        ]);
        firstTs = first?.timestamp ?? null;
        lastTs = firstBlock === lastBlock ? firstTs : (last?.timestamp ?? null);
    } catch {
        // Fall back to the ~1s-per-block estimate below.
    }

    if (firstTs === null || lastTs === null) {
        lastTs = Math.floor(Date.now() / 1000);
        firstTs = lastTs - (lastBlock - firstBlock);
    }

    const startTs = firstTs;
    const blockSpan = Math.max(1, lastBlock - firstBlock);
    const timeSpan = Math.max(0, lastTs - firstTs);
    let previousTime = 0;

    return candles.map((candle) => {
        const interpolated =
            startTs +
            Math.round(((candle.block - firstBlock) / blockSpan) * timeSpan);
        const time = Math.max(interpolated, previousTime + 1);
        previousTime = time;

        return { ...candle, time: time as UTCTimestamp };
    });
};

const loadRecent = async (): Promise<void> => {
    try {
        const launchpad = new Contract(
            LAUNCHPAD_ADDRESS,
            LAUNCHPAD_ABI,
            readProvider,
        );
        const factory = new Contract(
            FACTORY_ADDRESS,
            FACTORY_ABI,
            readProvider,
        );

        const lengthBn = (await launchpad.allTokensLength()) as bigint;
        const length = Number(lengthBn);
        totalLaunches.value = length;

        if (length === 0) {
            recent.value = [];
            priceHistories.value = {};
            historyLoaded.value = {};

            return;
        }

        // Newest first, cap at 25.
        const start = Math.max(0, length - 25);
        const indices: number[] = [];

        for (let i = length - 1; i >= start; i--) {
            indices.push(i);
        }

        const addresses = (await Promise.all(
            indices.map((i) => launchpad.allTokens(i)),
        )) as string[];

        const launchEvents = await fetchLaunchEvents();

        const perTokenData = await Promise.all(
            addresses.map(async (tokenAddr) => {
                const erc20 = new Contract(
                    tokenAddr,
                    ERC20_READ_ABI,
                    readProvider,
                );
                const launchEvent = launchEvents.get(tokenAddr.toLowerCase());
                const [name_, symbol_, totalSupply_, pairAddrFromFactory] =
                    await Promise.all([
                        erc20.name().catch(() => '') as Promise<string>,
                        erc20.symbol().catch(() => '') as Promise<string>,
                        erc20.totalSupply().catch(() => 0n) as Promise<bigint>,
                        factory
                            .getPair(tokenAddr, WCYBER_ADDRESS)
                            .catch(() => ZeroAddress) as Promise<string>,
                    ]);
                const pairAddr =
                    launchEvent?.pair && launchEvent.pair !== ZeroAddress
                        ? launchEvent.pair
                        : pairAddrFromFactory;
                const quoteSymbol = 'CYBER';
                let reserveCyber = 0n;
                let priceCyber: number | null = null;
                let tokenIsToken0: boolean | null = null;

                if (pairAddr && pairAddr !== ZeroAddress) {
                    const p = await readPairPrice(pairAddr, tokenAddr);

                    if (p) {
                        priceCyber = p.priceCyber;
                        reserveCyber = p.reserveCyber;
                        tokenIsToken0 = p.tokenIsToken0;
                    }
                }

                return {
                    name_,
                    symbol_,
                    totalSupply_,
                    pairAddr,
                    quoteSymbol,
                    reserveCyber,
                    priceCyber,
                    tokenIsToken0,
                    launchBlock: launchEvent?.blockNumber ?? null,
                    eventCreator: launchEvent?.creator ?? '',
                };
            }),
        );

        const metadata = await fetchMetadata();

        recent.value = addresses.map((tokenAddr, i) => {
            const d = perTokenData[i];
            const md = metadata.get(
                metadataKey(LISTING_CHAIN.chain.chainId, tokenAddr),
            );
            const supplyWhole = Number(formatUnits(d.totalSupply_, 18));

            return {
                chainId: LISTING_CHAIN.chain.chainId,
                token: tokenAddr,
                pair: d.pairAddr,
                creator: md?.creator ?? d.eventCreator,
                name: d.name_ || md?.name || '',
                symbol: d.symbol_ || md?.symbol || '',
                tokenSupply: d.totalSupply_,
                cyberLiquidity: d.reserveCyber,
                quoteSymbol: d.quoteSymbol,
                description: md?.description ?? null,
                xHandle: md?.x_handle ?? null,
                xUrl: md?.x_url ?? null,
                telegramHandle: md?.telegram_handle ?? null,
                telegramUrl: md?.telegram_url ?? null,
                websiteUrl: md?.website_url ?? null,
                imageUrl: md?.image_url ?? null,
                siteSubdomain: md?.site_subdomain ?? null,
                siteUrl: md?.site_url ?? null,
                ipfsUri: md?.ipfs_uri ?? null,
                ipfsUrl: md?.ipfs_url ?? null,
                priceCyber: d.priceCyber,
                marketCapCyber:
                    d.priceCyber != null ? d.priceCyber * supplyWhole : null,
                launchBlock: d.launchBlock,
            };
        });

        const nextHistories: Record<string, TokenCandle[]> = {};
        const nextLoaded: Record<string, boolean> = {};
        recent.value.forEach((t) => {
            nextHistories[chartKey(t.token)] = [];
            nextLoaded[chartKey(t.token)] = false;
        });
        priceHistories.value = nextHistories;
        historyLoaded.value = nextLoaded;

        void loadPriceHistories(
            recent.value.map((t, i) => ({
                token: t,
                tokenIsToken0: perTokenData[i].tokenIsToken0,
            })),
        );
    } catch (e) {
        console.warn('[Launchpad] loadRecent failed', e);
    }
};

const loadPriceHistories = async (
    tokens: { token: LaunchedToken; tokenIsToken0: boolean | null }[],
): Promise<void> => {
    for (const { token, tokenIsToken0 } of tokens) {
        const key = chartKey(token.token);

        if (tokenIsToken0 === null) {
            historyLoaded.value = { ...historyLoaded.value, [key]: true };
            continue;
        }

        const raw = await readPairTradeHistory(token.pair, tokenIsToken0);
        const points = await attachCandleTimes(raw);
        priceHistories.value = { ...priceHistories.value, [key]: points };
        historyLoaded.value = { ...historyLoaded.value, [key]: true };
    }
};

// The chain id is part of the signed message so a signature for one chain's
// metadata row cannot be replayed onto another chain's row.
const buildMetadataMessage = (tokenAddress: string, chainId: number): string =>
    `Edit Cyberia Launchpad metadata for ${tokenAddress.toLowerCase()} on chain ${chainId} at ${new Date().toISOString()}`;

const signMetadataMessage = async (
    tokenAddress: string,
    chainId: number,
): Promise<{ message: string; signature: string }> => {
    const registry = launchpadChain(chainId) ?? LISTING_CHAIN;
    const provider = await ensureEvmNetwork(registry.chain);
    const signer = await provider.getSigner();
    const message = buildMetadataMessage(tokenAddress, chainId);
    const signature = await signer.signMessage(message);

    return { message, signature };
};

/**
 * Upload the form's metadata for one deployment. The static site (HTML page
 * and subdomain) belongs to a single chain — `withSite` marks the first
 * launched chain, the rest get name/symbol/description/image only.
 */
const submitMetadata = async (
    tokenAddress: string,
    chainId: number,
    withSite: boolean,
): Promise<void> => {
    const wantsSite =
        withSite && (htmlFile.value !== null || siteSubdomain.value.trim());

    const hasSocials =
        xHandle.value.trim() !== '' ||
        telegramHandle.value.trim() !== '' ||
        websiteUrl.value.trim() !== '';

    if (
        !description.value.trim() &&
        !imageFile.value &&
        !hasSocials &&
        !wantsSite
    ) {
        return;
    }

    const { message, signature } = await signMetadataMessage(
        tokenAddress,
        chainId,
    );
    const form = new FormData();
    form.append('address', tokenAddress);
    form.append('chain_id', String(chainId));
    form.append('message', message);
    form.append('signature', signature);

    if (name.value.trim()) {
        form.append('name', name.value.trim());
    }

    if (symbol.value.trim()) {
        form.append('symbol', symbol.value.trim());
    }

    if (description.value.trim()) {
        form.append('description', description.value.trim());
    }

    if (xHandle.value.trim()) {
        form.append('x', xHandle.value.trim());
    }

    if (telegramHandle.value.trim()) {
        form.append('telegram', telegramHandle.value.trim());
    }

    if (websiteUrl.value.trim()) {
        form.append('website', websiteUrl.value.trim());
    }

    if (imageFile.value) {
        form.append('image', imageFile.value);
    }

    if (wantsSite && htmlFile.value) {
        form.append('html', htmlFile.value);
    }

    if (wantsSite && siteSubdomain.value.trim()) {
        form.append('site_subdomain', normalizedSubdomain(siteSubdomain.value));
    }

    const res = await fetch('/api/launchpad/tokens', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: form,
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');

        throw new Error(
            `Metadata upload failed: HTTP ${res.status} ${text.slice(0, 300)}`,
        );
    }
};

const swapUrlFor = (tokenAddress: string): string =>
    `${SWAP_BASE_URL}?inputCurrency=ETH&outputCurrency=${tokenAddress}`;

const explorerAddressUrl = (address: string): string =>
    `${EXPLORER_BASE_URL}/address/${address}`;

// Per-network deployment status shown next to each selected chain.
const STAGE_LABELS: Record<LaunchStage, string> = {
    idle: '',
    sending: 'waiting for signature',
    mining: 'mining',
    metadata: 'uploading metadata',
    done: 'launched',
    failed: 'failed',
};

const stageLabel = (target: LaunchTarget): string => {
    if (needsManualCheck(target)) {
        return 'sent, unconfirmed';
    }

    if (target.launched && target.stage === 'failed') {
        return 'launched, metadata pending';
    }

    return STAGE_LABELS[target.stage];
};

const targetRegistry = (target: LaunchTarget): LaunchpadChain =>
    launchpadChain(target.chainId) ?? LISTING_CHAIN;

const targetTokenUrl = (target: LaunchTarget): string =>
    launchpadExplorerAddressUrl(targetRegistry(target), target.token ?? '');

const targetTxUrl = (target: LaunchTarget): string =>
    launchpadExplorerTxUrl(targetRegistry(target), target.txHash ?? '');

const targetSwapUrl = (target: LaunchTarget): string =>
    launchpadSwapUrl(targetRegistry(target), target.token ?? '');

// Only the creator can edit. If no creator is set yet (unclaimed metadata),
// any connected wallet is allowed to take the first turn — the backend records
// the first signer as the canonical creator.
const canEdit = (t: LaunchedToken): boolean => {
    if (!wallet.isConnected.value || !wallet.address.value) {
        return false;
    }

    if (!t.creator) {
        return true;
    }

    return t.creator.toLowerCase() === wallet.address.value.toLowerCase();
};

// Per-row inline editor state for attaching metadata to already-launched tokens.
const editingToken = ref<string | null>(null);
const editDescription = ref('');
const editXHandle = ref('');
const editTelegramHandle = ref('');
const editWebsiteUrl = ref('');
const editSiteSubdomain = ref('');
const editImageFile = ref<File | null>(null);
const editImagePreview = ref<string | null>(null);
const editHtmlFile = ref<File | null>(null);
const editHtmlFileName = ref<string | null>(null);
const editBusy = ref(false);
const editError = ref<string | null>(null);

const editSiteSubdomainInvalid = computed(() => {
    const value = normalizedSubdomain(editSiteSubdomain.value);

    return value.length > 0 && !SUBDOMAIN_PATTERN.test(value);
});

const openEditor = (t: LaunchedToken): void => {
    editingToken.value = t.token;
    editDescription.value = t.description ?? '';
    editXHandle.value = t.xHandle ?? '';
    editTelegramHandle.value = t.telegramHandle ?? '';
    editWebsiteUrl.value = t.websiteUrl ?? '';
    editSiteSubdomain.value = t.siteSubdomain ?? '';
    editImageFile.value = null;
    editHtmlFile.value = null;
    editHtmlFileName.value = null;

    if (editImagePreview.value) {
        URL.revokeObjectURL(editImagePreview.value);
        editImagePreview.value = null;
    }

    editError.value = null;
};

const closeEditor = (): void => {
    editingToken.value = null;
    editDescription.value = '';
    editXHandle.value = '';
    editTelegramHandle.value = '';
    editWebsiteUrl.value = '';
    editSiteSubdomain.value = '';
    editImageFile.value = null;
    editHtmlFile.value = null;
    editHtmlFileName.value = null;

    if (editImagePreview.value) {
        URL.revokeObjectURL(editImagePreview.value);
        editImagePreview.value = null;
    }

    editError.value = null;
};

const onEditHtmlChange = (event: Event): void => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0] ?? null;
    editError.value = null;

    if (file && file.size > MAX_HTML_BYTES) {
        editError.value = `HTML page must be ≤ 2 MB (got ${(file.size / 1024 / 1024).toFixed(2)} MB)`;
        target.value = '';
        editHtmlFile.value = null;
        editHtmlFileName.value = null;

        return;
    }

    editHtmlFile.value = file;
    editHtmlFileName.value = file?.name ?? null;
};

const onEditImageChange = (event: Event): void => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0] ?? null;
    editError.value = null;

    if (file && file.size > MAX_IMAGE_BYTES) {
        editError.value = `Image must be ≤ 2 MB (got ${(file.size / 1024 / 1024).toFixed(2)} MB)`;
        target.value = '';
        editImageFile.value = null;

        return;
    }

    editImageFile.value = file;

    if (editImagePreview.value) {
        URL.revokeObjectURL(editImagePreview.value);
        editImagePreview.value = null;
    }

    if (file) {
        editImagePreview.value = URL.createObjectURL(file);
    }
};

const saveEditor = async (t: LaunchedToken): Promise<void> => {
    editBusy.value = true;
    editError.value = null;

    try {
        if (!wallet.isConnected.value) {
            throw new Error(
                'Connect your wallet first — editing requires a signature from the token creator.',
            );
        }

        if (editSiteSubdomainInvalid.value) {
            throw new Error(
                'Subdomain may contain only lowercase letters, digits, and internal hyphens.',
            );
        }

        const { message, signature } = await signMetadataMessage(
            t.token,
            t.chainId,
        );
        const form = new FormData();
        form.append('address', t.token);
        form.append('chain_id', String(t.chainId));
        form.append('message', message);
        form.append('signature', signature);

        if (t.name) {
            form.append('name', t.name);
        }

        if (t.symbol) {
            form.append('symbol', t.symbol);
        }

        form.append('description', editDescription.value.trim());
        // Always sent, blank included: an emptied field is how a link is taken
        // down, and an absent field means "leave what is stored alone".
        form.append('x', editXHandle.value.trim());
        form.append('telegram', editTelegramHandle.value.trim());
        form.append('website', editWebsiteUrl.value.trim());

        if (editImageFile.value) {
            form.append('image', editImageFile.value);
        }

        if (editHtmlFile.value) {
            form.append('html', editHtmlFile.value);
        }

        if (editSiteSubdomain.value.trim()) {
            form.append(
                'site_subdomain',
                normalizedSubdomain(editSiteSubdomain.value),
            );
        }

        const res = await fetch('/api/launchpad/tokens', {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: form,
        });

        if (!res.ok) {
            const text = await res.text();

            throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }

        closeEditor();
        await loadRecent();
    } catch (e) {
        editError.value = (e as Error).message ?? String(e);
    } finally {
        editBusy.value = false;
    }
};

/** Deploy the token on one chain and record everything the retry path needs. */
const launchOnChain = async (target: LaunchTarget): Promise<void> => {
    const registry = launchpadChain(target.chainId);

    if (!registry?.launchpad) {
        throw new Error(`No launchpad is deployed on ${target.label}.`);
    }

    const provider = await ensureEvmNetwork(registry.chain);
    const signer = await provider.getSigner();

    // A chain that has the v3 launchpad launches there: it is the only one
    // that can honour a creator's own fee and a holders' share, and its
    // liquidity keeps earning instead of being burned into a pair.
    const v3 = registry.launchpadV3 ?? null;
    const launchpad = new Contract(
        v3 ?? registry.launchpad,
        v3 ? LAUNCHPAD_V3_ABI : LAUNCHPAD_ABI,
        signer,
    );
    const iface = new Interface(v3 ? LAUNCHPAD_V3_ABI : LAUNCHPAD_ABI);

    target.stage = 'sending';
    status.value = `${target.label}: confirm launch() in your wallet…`;
    const tx = v3
        ? await launchpad.launch(
              name.value.trim(),
              symbol.value.trim(),
              parseAmount(target.supply),
              creatorFeeUnits.value,
              holdersShareBps.value,
              { value: parseAmount(target.liquidity) },
          )
        : await launchpad.launch(
              name.value.trim(),
              symbol.value.trim(),
              parseAmount(target.supply),
              { value: parseAmount(target.liquidity) },
          );

    // From here on a contract may exist on this chain, so the transaction is
    // recorded before we wait for it.
    target.txHash = tx.hash;
    target.stage = 'mining';
    persistDraft();
    status.value = `${target.label}: transaction sent, waiting for block…`;

    let receipt;

    try {
        receipt = await tx.wait();
    } catch (e) {
        // A reverted transaction deployed nothing, so the hash is dropped and
        // the row stays plainly retryable. Anything else (timeout, RPC drop)
        // keeps the hash for a manual check before any retry.
        if ((e as { receipt?: { status?: number } })?.receipt?.status === 0) {
            target.txHash = null;
            persistDraft();
        }

        throw e;
    }

    target.launched = true;
    persistDraft();

    // Pull the deployed token address out of TokenLaunched (first indexed arg).
    for (const log of receipt?.logs ?? []) {
        try {
            const parsed = iface.parseLog(log);

            if (parsed?.name === 'TokenLaunched') {
                target.token = parsed.args.token as string;
                // v2 burns its LP into a pair, v3 locks a position in a pool.
                // The row records whichever market the launch actually made.
                target.pair = (
                    v3 ? parsed.args.pool : parsed.args.pair
                ) as string;
                break;
            }
        } catch {
            // not our event
        }
    }

    persistDraft();

    if (!target.token) {
        throw new Error(
            `Launch on ${target.label} was mined but the TokenLaunched event was missing from the receipt — attach the metadata from the token list.`,
        );
    }
};

/**
 * Walk the selected chains one at a time (a wallet can only sit on one chain
 * at a time). A failure on one chain never rolls back or re-runs the chains
 * that already succeeded: their results stay on the row and the button turns
 * into a retry for what is left.
 */
const handleLaunch = async (): Promise<void> => {
    error.value = null;
    status.value = null;
    busy.value = true;

    const queue = launchTargets.value.filter(targetPending);
    // The static site is one page on one domain, so it is attached to the
    // first selected chain and stays there across retries.
    const siteChainId = selectedTargets.value[0]?.chainId ?? null;

    try {
        for (const target of queue) {
            const withSite = target.chainId === siteChainId;

            try {
                if (!target.launched) {
                    await launchOnChain(target);
                }

                if (target.token && !target.metadataDone) {
                    target.stage = 'metadata';
                    status.value = `${target.label}: uploading metadata…`;
                    await submitMetadata(
                        target.token,
                        target.chainId,
                        withSite,
                    );
                    target.metadataDone = true;
                }

                target.stage = 'done';
                target.error = null;
            } catch (e) {
                target.stage = 'failed';
                target.error = (e as Error).message ?? String(e);
            }

            persistDraft();
        }

        const failed = queue.filter((target) => target.stage === 'failed');
        const launched = queue.filter((target) => target.stage === 'done');

        if (failed.length > 0) {
            status.value =
                launched.length > 0
                    ? `Launched on ${launched.length} of ${queue.length} networks — the rest can be retried without redeploying.`
                    : null;
            error.value = failed
                .map((target) => `${target.label}: ${target.error}`)
                .join(' · ');
        } else {
            status.value = `Done! Launched on ${launched.length} network${launched.length === 1 ? '' : 's'}, LP burned.`;
            description.value = '';
            xHandle.value = '';
            telegramHandle.value = '';
            websiteUrl.value = '';
            siteSubdomain.value = '';
            imageFile.value = null;
            htmlFile.value = null;
            htmlFileName.value = null;

            if (imagePreview.value) {
                URL.revokeObjectURL(imagePreview.value);
                imagePreview.value = null;
            }
        }

        await loadOnchain();
        await loadRecent();
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
    } finally {
        busy.value = false;
    }
};

const fmt = (v: bigint, decimals = 18): string => {
    const s = formatUnits(v, decimals);
    const n = Number(s);

    if (!isFinite(n)) {
        return s;
    }

    if (n >= 1_000_000) {
        return `${(n / 1_000_000).toFixed(2)}M`;
    }

    if (n >= 1_000) {
        return `${(n / 1_000).toFixed(2)}K`;
    }

    return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
};

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

const chartKey = (tokenAddress: string): string => tokenAddress.toLowerCase();

const chartPointsFor = (t: LaunchedToken): TokenCandle[] =>
    priceHistories.value[chartKey(t.token)] ?? [];

// Change since launch, derived from the trade history.
const changeBadgeFor = (
    t: LaunchedToken,
): { up: boolean; text: string } | null => {
    const points = chartPointsFor(t);

    if (points.length === 0) {
        return null;
    }

    const first = points[0].open;
    const last = points[points.length - 1].close;

    if (!isFinite(first) || first <= 0) {
        return null;
    }

    const pct = ((last - first) / first) * 100;

    return {
        up: pct >= 0,
        text: `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(2)}%`,
    };
};

// Reload the native balances whenever the connected address changes.
watch(
    () => wallet.address.value,
    () => {
        launchTargets.value.forEach((target) => {
            target.balance = 0n;
        });
        void loadOnchain();
    },
);

// The terms are the contract's answer, so they are re-read whenever one of the
// two numbers behind them changes — or whenever the chain choice does, since a
// chain without a v3 launchpad has no terms to state.
watch(
    [creatorFeePct, holdersSharePct, usesV3],
    () => {
        void refreshLaunchTerms();
    },
    { immediate: true },
);

const handleConnect = async (): Promise<void> => {
    error.value = null;

    try {
        const addr = await wallet.connect();

        if (!addr) {
            error.value = wallet.error.value || 'Failed to connect wallet';

            return;
        }

        // wallet.address watcher will refresh balance/allowance.
        await loadOnchain();
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
    }
};

onMounted(async () => {
    restoreDraft();
    await loadOnchain();
    await loadRecent();
});
</script>

<template>
    <Head title="Launchpad" />

    <div class="launchpad-page">
        <div class="launchpad">
            <header class="hero">
                <div class="heroBadge">
                    Fair launch · 100% LP burned · no presale
                </div>
                <h1>Cyberia <span class="heroGrad">Launchpad</span></h1>
                <p>
                    Launch your own ERC-20 on Cyberia in one transaction. The
                    full supply is paired with your CYBER on Ritual DEX and the
                    LP tokens are burned on the spot — liquidity can never be
                    pulled.
                </p>
                <div class="heroStats">
                    <div class="stat">
                        <span class="statNum">{{ totalLaunches }}</span>
                        <span class="statCap">tokens launched</span>
                    </div>
                    <div class="stat">
                        <span class="statNum">{{ fmt(totalCyberLocked) }}</span>
                        <span class="statCap">CYBER locked in LPs</span>
                    </div>
                    <div class="stat">
                        <span class="statNum">100%</span>
                        <span class="statCap">of every LP burned</span>
                    </div>
                </div>
            </header>

            <section class="card card--form">
                <h2>Create token</h2>

                <div class="grid">
                    <label>
                        <span>Name</span>
                        <Input v-model="name" placeholder="e.g. MyToken" />
                    </label>
                    <label>
                        <span>Symbol</span>
                        <Input
                            v-model="symbol"
                            placeholder="e.g. MYT"
                            maxlength="11"
                        />
                    </label>
                    <div class="full networks">
                        <span class="netTitle">Networks</span>
                        <p class="small muted">
                            Pick one or several — each network gets its own
                            supply, liquidity and contract.
                        </p>
                        <div
                            v-for="target in launchTargets"
                            :key="target.chainId"
                            class="netRow"
                            :class="{ 'netRow--on': target.selected }"
                        >
                            <label class="netPick">
                                <input
                                    v-model="target.selected"
                                    type="checkbox"
                                    :disabled="busy || target.launched"
                                />
                                <span class="netName">{{ target.label }}</span>
                                <span class="small muted"
                                    >chain {{ target.chainId }}</span
                                >
                            </label>

                            <template v-if="target.selected">
                                <div class="netFields">
                                    <label>
                                        <span>Total supply</span>
                                        <Input
                                            v-model="target.supply"
                                            type="text"
                                            inputmode="decimal"
                                            :disabled="busy || target.launched"
                                        />
                                    </label>
                                    <label>
                                        <span
                                            >{{ target.currency }} liquidity
                                            (burned)</span
                                        >
                                        <Input
                                            v-model="target.liquidity"
                                            type="text"
                                            inputmode="decimal"
                                            :disabled="busy || target.launched"
                                        />
                                    </label>
                                </div>
                                <div class="netMeta small muted">
                                    <span>
                                        Balance:
                                        <strong>{{
                                            fmt(target.balance)
                                        }}</strong>
                                        {{ target.currency }}
                                    </span>
                                    <span v-if="target.minLiquidity > 0n">
                                        Minimum:
                                        <strong>{{
                                            fmt(target.minLiquidity)
                                        }}</strong>
                                        {{ target.currency }}
                                    </span>
                                </div>
                                <div
                                    v-if="targetIssue(target)"
                                    class="small hint--err"
                                >
                                    {{ targetIssue(target) }}
                                </div>
                            </template>

                            <div
                                v-if="target.stage !== 'idle'"
                                class="netStatus small"
                            >
                                <span
                                    class="netPill"
                                    :class="`netPill--${target.stage}`"
                                >
                                    {{ stageLabel(target) }}
                                </span>
                                <a
                                    v-if="target.token"
                                    class="addrLink"
                                    :href="targetTokenUrl(target)"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    <code>{{ short(target.token) }}</code>
                                </a>
                                <a
                                    v-if="target.txHash"
                                    class="addrLink"
                                    :href="targetTxUrl(target)"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    tx
                                </a>
                                <a
                                    v-if="target.token"
                                    class="addrLink"
                                    :href="targetSwapUrl(target)"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                >
                                    swap
                                </a>
                                <button
                                    v-if="needsManualCheck(target)"
                                    type="button"
                                    class="editBtn"
                                    :disabled="busy"
                                    @click="clearTarget(target)"
                                >
                                    Clear &amp; retry
                                </button>
                            </div>
                            <div v-if="target.error" class="small hint--err">
                                {{ target.error }}
                            </div>
                        </div>

                        <p v-if="unavailableChains.length" class="small muted">
                            Coming soon:
                            {{
                                unavailableChains
                                    .map((c) => c.chain.name)
                                    .join(', ')
                            }}
                            — no launchpad contract deployed there yet.
                        </p>
                    </div>
                    <label class="full">
                        <span>Description (optional)</span>
                        <textarea
                            v-model="description"
                            rows="3"
                            maxlength="2000"
                            placeholder="Tell people what your token is about"
                            class="textarea"
                        ></textarea>
                    </label>
                    <label class="full">
                        <span>X (optional)</span>
                        <Input
                            v-model="xHandle"
                            maxlength="200"
                            placeholder="@cyberia_network — or paste the profile link"
                            autocomplete="off"
                        />
                    </label>
                    <label class="full">
                        <span>Telegram (optional)</span>
                        <Input
                            v-model="telegramHandle"
                            maxlength="200"
                            placeholder="@cyberia_network — or paste the t.me link"
                            autocomplete="off"
                        />
                    </label>
                    <label class="full">
                        <span>Website (optional)</span>
                        <Input
                            v-model="websiteUrl"
                            maxlength="255"
                            placeholder="https://…"
                            autocomplete="off"
                        />
                    </label>
                    <template v-if="usesV3">
                        <label>
                            <span>Trading fee (%)</span>
                            <Input
                                v-model="creatorFeePct"
                                inputmode="decimal"
                                placeholder="1"
                                autocomplete="off"
                            />
                        </label>
                        <label>
                            <span>Of that, to holders (%)</span>
                            <Input
                                v-model="holdersSharePct"
                                inputmode="decimal"
                                placeholder="0"
                                autocomplete="off"
                            />
                        </label>
                        <p
                            v-if="feeInputInvalid"
                            class="full feeNote feeNote--bad"
                        >
                            A trading fee is 0–10%, and the holders' share is
                            0–100% of it.
                        </p>
                        <p v-else-if="launchTerms" class="full feeNote">
                            A trade will cost
                            <strong>{{ launchTerms.poolFee / 10000 }}%</strong>
                            — your {{ Number(creatorFeePct) || 0 }}% plus the
                            protocol's 1%. Of every unit of fees collected:
                            <strong>{{ launchTerms.creatorBps / 100 }}%</strong>
                            to you,
                            <strong>{{ launchTerms.holdersBps / 100 }}%</strong>
                            to everyone holding the token, and
                            {{ launchTerms.treasuryBps / 100 }}% to the
                            protocol. The fee is fixed at launch and the
                            liquidity is locked forever.
                        </p>
                        <p v-else class="full feeNote">
                            Reading the terms from the contract…
                        </p>
                    </template>
                    <label class="full">
                        <span>Image (optional, ≤ 2 MB)</span>
                        <input
                            type="file"
                            accept="image/*"
                            class="file"
                            @change="onImageChange"
                        />
                        <img
                            v-if="imagePreview"
                            :src="imagePreview"
                            class="preview"
                        />
                    </label>
                    <label class="full">
                        <span
                            >HTML page (optional, ≤ 2 MB) — sandboxed static
                            site</span
                        >
                        <input
                            type="file"
                            accept=".html,.htm,text/html"
                            class="file"
                            @change="onHtmlChange"
                        />
                        <span v-if="htmlFileName" class="small muted">{{
                            htmlFileName
                        }}</span>
                        <span class="small muted">
                            Published to IPFS on save — the page keeps its
                            address after any host stops serving it.
                        </span>
                    </label>
                    <label class="full">
                        <span>Token subdomain (requires an HTML page)</span>
                        <div class="siteAddress">
                            <Input
                                v-model="siteSubdomain"
                                maxlength="63"
                                placeholder="lain"
                                autocomplete="off"
                            />
                            <span>.cyberia.church</span>
                        </div>
                        <span
                            v-if="siteSubdomainInvalid"
                            class="small hint--err"
                        >
                            Use letters, digits, and internal hyphens only.
                        </span>
                        <span
                            v-else-if="siteSubdomain.trim() && !htmlFile"
                            class="small hint--err"
                        >
                            Select the HTML page that this subdomain will host.
                        </span>
                    </label>
                </div>

                <div class="meta">
                    <div>
                        Each selected network is deployed in its own
                        transaction, one after the other.
                    </div>
                    <div>
                        The native coin is paired with the full supply and the
                        LP is burned — it cannot be withdrawn.
                    </div>
                </div>

                <div class="actions">
                    <button
                        v-if="!wallet.isConnected.value"
                        class="ctaBtn"
                        type="button"
                        :disabled="wallet.isConnecting.value"
                        @click="handleConnect"
                    >
                        <Loader2
                            v-if="wallet.isConnecting.value"
                            class="spin"
                        />
                        Connect wallet
                    </button>
                    <button
                        v-else
                        class="ctaBtn"
                        type="button"
                        :disabled="!canLaunch"
                        @click="handleLaunch"
                    >
                        <Loader2 v-if="busy" class="spin" />
                        {{
                            startedTargets.length > 0
                                ? `Retry ${pendingTargets.length} network${pendingTargets.length === 1 ? '' : 's'}`
                                : `Launch on ${selectedTargets.length} network${selectedTargets.length === 1 ? '' : 's'}`
                        }}
                    </button>
                    <button
                        v-if="startedTargets.length > 0 && !busy"
                        class="editBtn"
                        type="button"
                        @click="startOver"
                    >
                        Start a new launch
                    </button>
                </div>

                <div v-if="status" class="hint">{{ status }}</div>
                <div v-if="error" class="hint hint--err">{{ error }}</div>
            </section>

            <section v-if="recent.length" class="launches">
                <div class="launchesHead">
                    <h2>Live launches</h2>
                    <div class="sortTabs" role="tablist" aria-label="Sort by">
                        <button
                            v-for="tab in sortTabs"
                            :key="tab.key"
                            type="button"
                            :class="{ active: sortBy === tab.key }"
                            @click="sortBy = tab.key"
                        >
                            {{ tab.label }}
                        </button>
                    </div>
                </div>
                <ul class="tokenList">
                    <li
                        v-for="t in sortedRecent"
                        :key="t.token"
                        class="tokenItem"
                    >
                        <div class="tokenImage">
                            <img
                                v-if="t.imageUrl"
                                :src="t.imageUrl"
                                :alt="t.symbol"
                            />
                            <span v-else class="tokenImageFallback">
                                {{
                                    (t.symbol || '?').slice(0, 2).toUpperCase()
                                }}
                            </span>
                        </div>
                        <div class="tokenBody">
                            <div class="tokenHead">
                                <div>
                                    <div class="tokenTitle">
                                        <strong>{{ t.symbol }}</strong>
                                        <span class="muted">
                                            · {{ t.name }}</span
                                        >
                                        <span
                                            v-if="changeBadgeFor(t)"
                                            class="pricePill"
                                            :class="
                                                changeBadgeFor(t)?.up
                                                    ? 'pricePill--up'
                                                    : 'pricePill--down'
                                            "
                                        >
                                            {{ changeBadgeFor(t)?.text }}
                                        </span>
                                    </div>
                                    <div class="muted small">
                                        <a
                                            class="addrLink"
                                            :href="explorerAddressUrl(t.token)"
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            <code>{{ short(t.token) }}</code>
                                        </a>
                                    </div>
                                </div>
                                <div class="rowActions">
                                    <button
                                        v-if="canEdit(t)"
                                        class="editBtn"
                                        type="button"
                                        @click="openEditor(t)"
                                    >
                                        Edit
                                    </button>
                                    <a
                                        v-if="t.siteUrl"
                                        class="siteBtn"
                                        :href="t.siteUrl"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        Site →
                                    </a>
                                    <a
                                        v-if="
                                            t.ipfsUrl && t.ipfsUrl !== t.siteUrl
                                        "
                                        class="ipfsBtn"
                                        :href="t.ipfsUrl"
                                        :title="t.ipfsUri ?? undefined"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        IPFS →
                                    </a>
                                    <a
                                        class="swapBtn"
                                        :href="swapUrlFor(t.token)"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                    >
                                        Swap →
                                    </a>
                                </div>
                            </div>
                            <p v-if="t.description" class="tokenDesc">
                                {{ t.description }}
                            </p>
                            <div
                                v-if="t.xUrl || t.telegramUrl || t.websiteUrl"
                                class="tokenLinks"
                            >
                                <a
                                    v-if="t.xUrl"
                                    :href="t.xUrl"
                                    target="_blank"
                                    rel="noopener noreferrer nofollow"
                                    >𝕏 {{ t.xHandle }}</a
                                >
                                <a
                                    v-if="t.telegramUrl"
                                    :href="t.telegramUrl"
                                    target="_blank"
                                    rel="noopener noreferrer nofollow"
                                    >TG {{ t.telegramHandle }}</a
                                >
                                <a
                                    v-if="t.websiteUrl"
                                    :href="t.websiteUrl"
                                    target="_blank"
                                    rel="noopener noreferrer nofollow"
                                    >WWW</a
                                >
                            </div>
                            <div class="tokenStats">
                                <div>
                                    <span class="statLabel">Price</span>
                                    <span class="statValue">
                                        {{
                                            t.priceCyber != null
                                                ? formatPrice(t.priceCyber) +
                                                  ` ${t.quoteSymbol}`
                                                : '—'
                                        }}
                                    </span>
                                </div>
                                <div>
                                    <span class="statLabel">Market cap</span>
                                    <span class="statValue">
                                        {{
                                            t.marketCapCyber != null
                                                ? formatNum(t.marketCapCyber) +
                                                  ` ${t.quoteSymbol}`
                                                : '—'
                                        }}
                                    </span>
                                </div>
                                <div>
                                    <span class="statLabel">Supply</span>
                                    <span class="statValue">{{
                                        fmt(t.tokenSupply)
                                    }}</span>
                                </div>
                                <div>
                                    <span class="statLabel"
                                        >Liquidity locked</span
                                    >
                                    <span class="statValue"
                                        >{{ fmt(t.cyberLiquidity) }}
                                        {{ t.quoteSymbol }}</span
                                    >
                                </div>
                                <div>
                                    <span class="statLabel">Creator</span>
                                    <span class="statValue">
                                        <a
                                            v-if="t.creator"
                                            class="addrLink"
                                            :href="
                                                explorerAddressUrl(t.creator)
                                            "
                                            target="_blank"
                                            rel="noopener noreferrer"
                                        >
                                            <code>{{ short(t.creator) }}</code>
                                        </a>
                                        <code v-else>—</code>
                                    </span>
                                </div>
                            </div>

                            <TokenCandlesChart
                                v-if="chartPointsFor(t).length > 0"
                                class="tokenChartWrap"
                                :candles="chartPointsFor(t)"
                                :quote-symbol="t.quoteSymbol"
                            />
                            <div v-else class="chartEmpty">
                                {{
                                    historyLoaded[chartKey(t.token)]
                                        ? 'No trades yet — the chart lights up with the first swap.'
                                        : 'Loading trade history…'
                                }}
                            </div>

                            <div v-if="editingToken === t.token" class="editor">
                                <label>
                                    <span>Description</span>
                                    <textarea
                                        v-model="editDescription"
                                        rows="3"
                                        maxlength="2000"
                                        class="textarea"
                                    ></textarea>
                                </label>
                                <label>
                                    <span>X</span>
                                    <Input
                                        v-model="editXHandle"
                                        maxlength="200"
                                        placeholder="@handle or profile link"
                                        autocomplete="off"
                                    />
                                </label>
                                <label>
                                    <span>Telegram</span>
                                    <Input
                                        v-model="editTelegramHandle"
                                        maxlength="200"
                                        placeholder="@handle or t.me link"
                                        autocomplete="off"
                                    />
                                </label>
                                <label>
                                    <span>Website</span>
                                    <Input
                                        v-model="editWebsiteUrl"
                                        maxlength="255"
                                        placeholder="https://…"
                                        autocomplete="off"
                                    />
                                </label>
                                <label>
                                    <span>Image (≤ 2 MB)</span>
                                    <input
                                        type="file"
                                        accept="image/*"
                                        class="file"
                                        @change="onEditImageChange"
                                    />
                                    <img
                                        v-if="editImagePreview"
                                        :src="editImagePreview"
                                        class="preview"
                                    />
                                </label>
                                <label>
                                    <span
                                        >HTML page (≤ 2 MB) — sandboxed static
                                        site</span
                                    >
                                    <input
                                        type="file"
                                        accept=".html,.htm,text/html"
                                        class="file"
                                        @change="onEditHtmlChange"
                                    />
                                    <span
                                        v-if="editHtmlFileName"
                                        class="small muted"
                                        >{{ editHtmlFileName }}</span
                                    >
                                    <a
                                        v-if="t.ipfsUrl"
                                        class="small muted ipfsAddr"
                                        :href="t.ipfsUrl"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        >Pinned at {{ t.ipfsUri }}</a
                                    >
                                    <span v-else class="small muted">
                                        Uploading a page also pins it to IPFS.
                                    </span>
                                </label>
                                <label>
                                    <span>Token subdomain</span>
                                    <div class="siteAddress">
                                        <Input
                                            v-model="editSiteSubdomain"
                                            maxlength="63"
                                            placeholder="lain"
                                            autocomplete="off"
                                        />
                                        <span>.cyberia.church</span>
                                    </div>
                                    <span
                                        v-if="editSiteSubdomainInvalid"
                                        class="small hint--err"
                                    >
                                        Use letters, digits, and internal
                                        hyphens only.
                                    </span>
                                </label>
                                <div v-if="editError" class="hint hint--err">
                                    {{ editError }}
                                </div>
                                <div class="editorActions">
                                    <button
                                        class="ctaBtn ctaBtn--sm"
                                        type="button"
                                        :disabled="
                                            editBusy || editSiteSubdomainInvalid
                                        "
                                        @click="saveEditor(t)"
                                    >
                                        <Loader2 v-if="editBusy" class="spin" />
                                        Save
                                    </button>
                                    <button
                                        type="button"
                                        class="editBtn"
                                        :disabled="editBusy"
                                        @click="closeEditor"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        </div>
                    </li>
                </ul>
            </section>
        </div>
    </div>
</template>

<style scoped>
.launchpad-page {
    position: relative;
    isolation: isolate;
    overflow-x: clip;
    min-height: 100vh;
    background: var(--background, #0d0d0d);
    color: var(--foreground, #e5e7eb);
}
/* Ambient glows behind the hero — decorative only. */
.launchpad-page::before,
.launchpad-page::after {
    content: '';
    position: absolute;
    z-index: -1;
    border-radius: 50%;
    pointer-events: none;
}
.launchpad-page::before {
    top: -220px;
    left: 50%;
    width: 680px;
    height: 680px;
    transform: translateX(-72%);
    background: radial-gradient(
        circle,
        rgba(16, 185, 129, 0.16),
        transparent 60%
    );
}
.launchpad-page::after {
    top: 80px;
    left: 50%;
    width: 560px;
    height: 560px;
    transform: translateX(12%);
    background: radial-gradient(
        circle,
        rgba(139, 92, 246, 0.12),
        transparent 60%
    );
}
.launchpad {
    max-width: 1040px;
    margin: 0 auto;
    padding: 48px 16px 72px;
    color: var(--foreground, #e5e7eb);
}
.hero {
    text-align: center;
    margin-bottom: 36px;
}
.heroBadge {
    display: inline-block;
    padding: 6px 14px;
    margin-bottom: 16px;
    border: 1px solid rgba(16, 185, 129, 0.35);
    border-radius: 999px;
    background: rgba(16, 185, 129, 0.08);
    color: #6ee7b7;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.6px;
    text-transform: uppercase;
}
.hero h1 {
    margin: 0 0 12px;
    font-size: clamp(32px, 6vw, 48px);
    font-weight: 800;
    letter-spacing: -0.02em;
}
.heroGrad {
    background: linear-gradient(90deg, #34d399, #22d3ee 55%, #a78bfa);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
}
.hero p {
    max-width: 560px;
    margin: 0 auto 24px;
    color: var(--muted-foreground, #94a3b8);
    line-height: 1.55;
}
.heroStats {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 12px;
}
.stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 150px;
    padding: 14px 20px;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--card);
}
.statNum {
    font-size: 22px;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
}
.statCap {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted-foreground, #94a3b8);
}
.card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 22px;
    margin-bottom: 28px;
}
.card--form {
    border-color: rgba(16, 185, 129, 0.25);
    box-shadow: 0 0 48px rgba(16, 185, 129, 0.06);
}
.card h2,
.launchesHead h2 {
    margin: 0 0 16px;
    font-size: 18px;
    font-weight: 700;
}
.launchesHead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 14px;
}
.launchesHead h2 {
    margin: 0;
}
.sortTabs {
    display: inline-flex;
    gap: 2px;
    padding: 3px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--card);
}
.sortTabs button {
    border: none;
    background: transparent;
    color: var(--muted-foreground, #94a3b8);
    padding: 6px 14px;
    border-radius: 8px;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
}
.sortTabs button.active {
    background: rgba(16, 185, 129, 0.14);
    color: #6ee7b7;
    font-weight: 600;
}
.grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
}
.grid label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--muted-foreground, #94a3b8);
}
.grid label.full {
    grid-column: 1 / -1;
}
/* The launch terms, spelled out under the two numbers that set them. */
.feeNote {
    grid-column: 1 / -1;
    margin: 0;
    padding: 10px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--muted, #1e293b) 40%, transparent);
    font-size: 12px;
    line-height: 1.5;
    color: var(--muted-foreground, #94a3b8);
}
.feeNote strong {
    color: var(--foreground, #e5e7eb);
    font-weight: 600;
}
.feeNote--bad {
    border-color: color-mix(in srgb, #ef4444 50%, var(--border));
    color: #fca5a5;
}
.networks {
    display: flex;
    flex-direction: column;
    gap: 10px;
    font-size: 13px;
    color: var(--muted-foreground, #94a3b8);
}
.netTitle {
    font-weight: 600;
    color: var(--foreground, #e5e7eb);
}
.netRow {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
}
.netRow--on {
    border-color: rgba(16, 185, 129, 0.35);
    background: rgba(16, 185, 129, 0.04);
}
.netPick {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
}
.netName {
    color: var(--foreground, #e5e7eb);
    font-weight: 600;
}
.netFields {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
}
.netFields label {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.netMeta {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
}
.netMeta strong {
    color: var(--foreground, #e5e7eb);
}
.netStatus {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
}
.netPill {
    padding: 3px 8px;
    border-radius: 999px;
    background: rgba(148, 163, 184, 0.15);
    text-transform: uppercase;
    letter-spacing: 0.4px;
}
.netPill--done {
    background: rgba(16, 185, 129, 0.16);
    color: #6ee7b7;
}
.netPill--failed {
    background: rgba(248, 113, 113, 0.16);
    color: #f87171;
}
.textarea {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    color: var(--foreground, #e5e7eb);
    font: inherit;
    resize: vertical;
}
.file {
    color: var(--muted-foreground, #94a3b8);
    font-size: 13px;
}
.siteAddress {
    display: flex;
    align-items: center;
    gap: 8px;
}
.siteAddress > :first-child {
    min-width: 0;
    flex: 1;
}
.siteAddress > span {
    flex-shrink: 0;
    color: var(--foreground, #e5e7eb);
}
.preview {
    margin-top: 8px;
    max-width: 120px;
    max-height: 120px;
    border-radius: 12px;
    object-fit: cover;
    border: 1px solid var(--border);
}
.meta {
    display: flex;
    flex-wrap: wrap;
    gap: 18px;
    margin-top: 14px;
    font-size: 13px;
    color: var(--muted-foreground, #94a3b8);
}
.meta strong {
    color: var(--foreground, #e5e7eb);
}
.actions {
    display: flex;
    gap: 10px;
    margin-top: 18px;
}
.ctaBtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 12px 28px;
    border: none;
    border-radius: 12px;
    background: linear-gradient(135deg, #10b981, #06b6d4);
    color: #04110d;
    font: inherit;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 0 24px rgba(16, 185, 129, 0.35);
    transition:
        transform 0.15s ease,
        box-shadow 0.15s ease;
}
.ctaBtn:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 0 36px rgba(16, 185, 129, 0.5);
}
.ctaBtn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    box-shadow: none;
}
.ctaBtn--sm {
    padding: 8px 18px;
    font-size: 13px;
    border-radius: 10px;
}
.hint {
    margin-top: 10px;
    font-size: 13px;
    color: var(--muted-foreground, #94a3b8);
    word-break: break-all;
}
.hint--err {
    color: #f87171;
}
.spin {
    width: 16px;
    height: 16px;
    animation: spin 0.8s linear infinite;
}
.muted {
    color: var(--muted-foreground, #94a3b8);
}
.small {
    font-size: 11px;
}
.tokenList {
    display: flex;
    flex-direction: column;
    gap: 16px;
    list-style: none;
    margin: 0;
    padding: 0;
}
.tokenItem {
    display: flex;
    gap: 16px;
    padding: 18px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    transition:
        border-color 0.2s ease,
        box-shadow 0.2s ease,
        transform 0.2s ease;
}
.tokenItem:hover {
    border-color: rgba(16, 185, 129, 0.45);
    box-shadow: 0 8px 32px rgba(16, 185, 129, 0.08);
    transform: translateY(-2px);
}
.tokenImage {
    flex-shrink: 0;
    width: 84px;
    height: 84px;
    border-radius: 14px;
    overflow: hidden;
    background: var(--muted);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: inset 0 0 0 1px rgba(148, 163, 184, 0.15);
}
.tokenImage img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}
.tokenImageFallback {
    background: linear-gradient(135deg, #34d399, #22d3ee);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    font-weight: 800;
    font-size: 22px;
}
.tokenBody {
    flex: 1;
    min-width: 0;
}
.tokenHead {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 10px;
}
.tokenTitle {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: 16px;
}
.pricePill {
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
}
.pricePill--up {
    color: #26a69a;
    background: rgba(38, 166, 154, 0.12);
}
.pricePill--down {
    color: #ef5350;
    background: rgba(239, 83, 80, 0.12);
}
.rowActions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
}
.swapBtn,
.editBtn,
.ipfsBtn,
.siteBtn {
    border: 1px solid var(--input);
    background: var(--card);
    color: var(--foreground, #e5e7eb);
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 13px;
    text-decoration: none;
    white-space: nowrap;
    cursor: pointer;
    font: inherit;
}
.siteBtn {
    background: rgba(34, 197, 94, 0.15);
    border-color: rgba(34, 197, 94, 0.4);
    color: #86efac;
}
.siteBtn:hover {
    background: rgba(34, 197, 94, 0.25);
}
.ipfsAddr {
    word-break: break-all;
    color: #d8b4fe;
    text-decoration: none;
}
.ipfsBtn {
    background: rgba(168, 85, 247, 0.15);
    border-color: rgba(168, 85, 247, 0.4);
    color: #d8b4fe;
}
.ipfsBtn:hover {
    background: rgba(168, 85, 247, 0.25);
}
.swapBtn {
    background: rgba(59, 130, 246, 0.15);
    border-color: rgba(59, 130, 246, 0.4);
    color: #93c5fd;
}
.swapBtn:hover,
.editBtn:hover {
    background: var(--muted);
}
.swapBtn:hover {
    background: rgba(59, 130, 246, 0.25);
}
.editor {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.editor label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--muted-foreground, #94a3b8);
}
.editorActions {
    display: flex;
    gap: 8px;
}
/* Where the project talks. Links a creator typed are external and untrusted,
   so they carry nofollow alongside noopener. */
.tokenLinks {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0 0 0.6rem;
}

.tokenLinks a {
    font-size: 0.72rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    padding: 0.2rem 0.5rem;
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 0.35rem;
    color: inherit;
    opacity: 0.85;
    text-decoration: none;
}

.tokenLinks a:hover {
    opacity: 1;
}

.tokenDesc {
    margin: 8px 0 0;
    font-size: 13px;
    color: var(--foreground, #e5e7eb);
    line-height: 1.45;
    white-space: pre-wrap;
}
.tokenStats {
    margin-top: 12px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
}
.statLabel {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    color: var(--muted-foreground, #94a3b8);
    letter-spacing: 0.4px;
}
.statValue {
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    color: var(--foreground, #e5e7eb);
}
.addrLink {
    color: #93c5fd;
    text-decoration: none;
}
.addrLink:hover {
    text-decoration: underline;
}
.tokenChartWrap {
    margin-top: 14px;
}
.chartEmpty {
    margin-top: 12px;
    padding: 12px;
    border: 1px dashed rgba(148, 163, 184, 0.28);
    border-radius: 10px;
    color: var(--muted-foreground, #94a3b8);
    font-size: 12px;
}
@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}
@media (max-width: 640px) {
    .grid {
        grid-template-columns: 1fr;
    }
    .tokenItem {
        flex-direction: column;
    }
}
</style>
