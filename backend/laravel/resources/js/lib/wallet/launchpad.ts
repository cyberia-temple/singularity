import {
    Contract,
    Interface,
    JsonRpcProvider,
    ZeroAddress,
    ZeroHash,
    formatUnits,
    hexlify,
    isAddress,
    parseUnits,
    randomBytes,
} from 'ethers';
import {
    CYBERIA2_LAUNCHPAD,
    DEFAULT_LAUNCHPAD_CHAIN_ID,
    LAUNCHPAD_CHAINS,
    launchpadChain,
    launchpadReadRpcUrl,
} from '@/lib/launchpadChains';
import type { LaunchpadChain } from '@/lib/launchpadChains';
import { zoneFromToken } from '@/lib/wallet/domains';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';

/**
 * What the wallet reads about the launchpad.
 *
 * The launchpad on Cyberia is a fair launch: a token is deployed, the native
 * coin that paid for it is burned into permanently locked liquidity, and from
 * that moment the token is simply a pool on the DEX. There are no rounds, no
 * allocation tiers, no vesting and no cap — so this file has no vocabulary for
 * any of that, and the screens above it do not draw controls for things that
 * cannot happen.
 *
 * Reading is most of this file. Nothing is *bought* here: buying a launched
 * token is a swap, and that lives in `lib/wallet/swap.ts` — the detail screen
 * hands it a contract address and the swap screen reads the token for itself.
 *
 * The one thing signed here is a launch itself (`quoteLaunch` →
 * `executeLaunch`), and it goes to the same contract `/launchpad` uses: the
 * v3 launchpad where a chain has one — the creator names a trading fee and the
 * liquidity is a locked position that keeps earning — and LaunchpadNative
 * where it has not. Two launchpads means two lists, so `fetchLaunches` reads
 * both; a token launched from this wallet that the wallet then could not find
 * would be the worst possible first impression of the feature.
 *
 * Cyberia 2.0 runs a third one, crypto/protocol's `Launchpad` (the `kit`
 * venue): the same locked v3 position and fee split, one struct for its
 * arguments, and the token's lending markets, farm and DAO opened by the same
 * transaction.
 *
 * Beside it runs `TokenStudio` (the `studio` venue): the same launchpad with
 * a second way in, for a token its creator describes — part of the supply
 * minted straight to addresses, a minter who may mint more up to a ceiling,
 * the parts of the kit picked one by one. One form serves both: a token that
 * asks for none of that is a plain launch and goes to the launchpad, which
 * alone can open a domain zone (`formVenue`).
 */

const LAUNCHPAD_ABI = [
    'function allTokensLength() view returns (uint256)',
    'function allTokens(uint256) view returns (address)',
    'function pairOf(address) view returns (address)',
];

const ERC20_ABI = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function totalSupply() view returns (uint256)',
];

/** The v3 launchpad's read side: the same list, with a pool instead of a pair. */
const LAUNCHPAD_V3_READ_ABI = [
    'function allTokensLength() view returns (uint256)',
    'function allTokens(uint256) view returns (address)',
    'function poolOf(address) view returns (address)',
];

/**
 * The write side of both launchpads.
 *
 * `launch` differs by two arguments — the fee and the holders' share only exist
 * where a pool can charge what its creator chose — and by what the event calls
 * the market it made. The event's argument *types* are otherwise the same,
 * which is why the token is always the first indexed topic.
 */
const LAUNCH_V2_ABI = [
    'function minLiquidity() view returns (uint256)',
    'function launch(string,string,uint256) payable returns (address,address,uint256)',
    'event TokenLaunched(address indexed token, address indexed creator, address pair, string name, string symbol, uint256 tokenSupply, uint256 cyberLiquidity, uint256 lpBurned)',
];

const LAUNCH_V3_ABI = [
    'function minLiquidity() view returns (uint256)',
    'function launch(string,string,uint256,uint24,uint16) payable returns (address,address,uint256)',
    'event TokenLaunched(address indexed token, address indexed creator, address pool, string name, string symbol, uint256 tokenSupply, uint256 cyberLiquidity)',
];

/**
 * A v3 pool, read for a price and for what it charges.
 *
 * `slot0` declares only its first two fields on purpose: Pancake's struct is
 * wider than Uniswap's (`feeProtocol` is a uint32 there) and a decoder only
 * reads what it is told to, so naming the two that matter keeps this correct
 * on both.
 */
/**
 * The Cyberia 2.0 launchpad, read and write.
 *
 * It keeps no `poolOf`: everything a launch opened is one `Economy` record,
 * so the pool and the kit are read together. `Id` is Morpho's bytes32.
 */
const ECONOMY_OF =
    'function economyOf(address) view returns ((address creator, uint64 launchedAt, address pool, uint256 positionId, address vault, address gauge, address tokenOracle, address cyberOracle, bytes32 borrowCyberMarket, bytes32 borrowTokenMarket, bytes32 borrowAgainstLpMarket, address governor, address timelock, bool zone, string metadataURI))';

const LAUNCHED_EVENT =
    'event Launched(address indexed token, address indexed creator, address pool, string name, string symbol, uint256 totalSupply, uint256 cyberLiquidity)';

const LAUNCH_KIT_ABI = [
    'function minLiquidity() view returns (uint256)',
    'function allTokensLength() view returns (uint256)',
    'function allTokens(uint256) view returns (address)',
    ECONOMY_OF,
    'function launch((string name, string symbol, uint256 totalSupply, uint24 creatorFee, uint16 holdersShareBps, bytes32 salt, uint8 kit, string metadataURI)) payable returns (address)',
    LAUNCHED_EVENT,
];

/**
 * The Cyberia 2.0 token studio: the launchpad's registry and event, and
 * `create` for a token with a supply of its creator's design.
 */
const LAUNCH_STUDIO_ABI = [
    'function minLiquidity() view returns (uint256)',
    'function allTokensLength() view returns (uint256)',
    'function allTokens(uint256) view returns (address)',
    ECONOMY_OF,
    'function create((string name, string symbol, uint256 poolSupply, (address to, uint256 amount)[] allocations, address minter, uint256 maxSupply, uint24 creatorFee, uint16 holdersShareBps, bytes32 salt, uint8 kit, string metadataURI)) payable returns (address)',
    LAUNCHED_EVENT,
];

/** A studio token's supply rules. */
const STUDIO_TOKEN_READ_ABI = [
    'function minter() view returns (address)',
    'function maxSupply() view returns (uint256)',
];

/**
 * Every part of the kit, asked for on every launch: `KIT_CREDIT | KIT_FARM |
 * KIT_ZONE | KIT_DAO`. The contract skips a part whose module is not set and
 * a zone the name does not spell, so asking for all of it never fails a launch.
 */
export const KIT_ALL = 15;

export const KIT_CREDIT = 1;
export const KIT_FARM = 2;
export const KIT_ZONE = 4;
export const KIT_DAO = 8;

/** The parts of the kit a creator picks; the zone follows from the name. */
export type KitChoice = { credit: boolean; farm: boolean; dao: boolean };

/**
 * The kit flags a launch asks for. No choice is all of it. The zone bit is
 * asked of the launchpad whatever was picked — it opens a zone only for a name
 * that spells one — and never of the studio, where `Domains` would refuse it.
 */
export const kitFlags = (
    choice: KitChoice | undefined,
    venue: LaunchVenue,
): number => {
    const picked = choice ?? { credit: true, farm: true, dao: true };

    return (
        (picked.credit ? KIT_CREDIT : 0) |
        (picked.farm ? KIT_FARM : 0) |
        (venue === 'kit' ? KIT_ZONE : 0) |
        (picked.dao ? KIT_DAO : 0)
    );
};

/** The most of a studio token that can exist: StudioToken.MAX_SUPPLY, a trillion. */
export const STUDIO_MAX_SUPPLY = 10n ** 30n;

/** StudioToken.MAX_ALLOCATIONS: addresses a creation may mint to besides the pool. */
export const STUDIO_MAX_ALLOCATIONS = 16;

const POOL_V3_ABI = [
    'function token0() view returns (address)',
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
    'function fee() view returns (uint24)',
];

const BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

const PAIR_ABI = [
    'function token0() view returns (address)',
    'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

export type LaunchVenue = 'v2' | 'v3' | 'kit' | 'studio';

/** What a Cyberia 2.0 launch opened beside its pool. */
export type LaunchKit = {
    /** Lending markets: borrow CYBER against the token, the token against CYBER, CYBER against LP shares. */
    credit: boolean;
    farm: boolean;
    zone: boolean;
    dao: boolean;
};

export type WalletLaunch = {
    /** Contract of the launched token — its identity on this chain. */
    address: string;
    /**
     * Which launchpad made it. A v2 launch burned its LP token; a v3 launch
     * locked a position that keeps collecting fees for its creator and
     * holders. Both are permanent, but they are not the same sentence.
     */
    venue: LaunchVenue;
    /** What a trade in its pool costs, in percent — v3 only, null elsewhere. */
    feePct: number | null;
    /** What the launch opened beside its pool — Cyberia 2.0 only. */
    kit: LaunchKit | null;
    /** Who launched it, where the registry says (Cyberia 2.0); null elsewhere. */
    creator: string | null;
    /** Unix seconds of the launch, where the registry says; null elsewhere. */
    launchedAt: number | null;
    /**
     * A studio token's supply rules: who may mint (the zero address once
     * nobody may) and the ceiling. Null for every other launch, whose supply
     * was fixed the moment it was made.
     */
    minting: { minter: string; maxSupply: bigint } | null;
    name: string;
    symbol: string;
    /** Everything in existence, in the token's own units (always 18 here). */
    supply: bigint;
    /**
     * Native coin locked in the pool, in wei. This is the launch's liquidity
     * and it is burned: it is a floor, not a treasury somebody can withdraw.
     */
    liquidity: bigint;
    /** Price of one token in the chain's native coin, or null with no pool. */
    priceNative: number | null;
    /** Supply × price, in native coin, when both are known. */
    marketCapNative: number | null;
    explorerUrl: string;
    swapUrl: string;
};

/** How many launches one pass reads. Each costs several calls, so it is capped. */
const PAGE = 12;

const providerFor = (target: LaunchpadChain): JsonRpcProvider =>
    new JsonRpcProvider(launchpadReadRpcUrl(target), target.chain.chainId, {
        staticNetwork: true,
        // Cyberia's node refuses a JSON-RPC batch over 20 calls outright.
        batchMaxCount: 20,
    });

/**
 * The reserves of one pool as a price, from the token's side.
 *
 * Reserves are ordered by token address, not by which of the two anyone cares
 * about, so `token0` decides which number is the quote. Getting this backwards
 * inverts every price on the screen — and a token worth 0.0001 CYBER would be
 * drawn as one worth 10,000 — so the ordering is read from the pool rather
 * than assumed, and it is pure here so it can be pinned by a test.
 */
export const poolQuote = (
    token0: string,
    token: string,
    reserves: readonly [bigint, bigint],
): { price: number; liquidity: bigint } | null => {
    const tokenIsFirst = token0.toLowerCase() === token.toLowerCase();
    const tokenReserve = tokenIsFirst ? reserves[0] : reserves[1];
    const nativeReserve = tokenIsFirst ? reserves[1] : reserves[0];

    // An empty side is a pool with no price, not a price of zero.
    if (tokenReserve === 0n) {
        return null;
    }

    return {
        price:
            Number(formatUnits(nativeReserve, 18)) /
            Number(formatUnits(tokenReserve, 18)),
        liquidity: nativeReserve,
    };
};

/**
 * A v3 pool's price, from the token's side.
 *
 * `sqrtPriceX96` is √(token1/token0) in Q64.96, and both sides of a launch
 * pool have 18 decimals, so squaring it is already the price of token0 in
 * token1. Which side the launch's token is on decides whether that is the
 * answer or its reciprocal — the same trap `poolQuote` exists for.
 */
export const sqrtPriceQuote = (
    token0: string,
    token: string,
    sqrtPriceX96: bigint,
): number | null => {
    if (sqrtPriceX96 === 0n) {
        return null;
    }

    const root = Number(sqrtPriceX96) / 2 ** 96;
    const price = root * root;

    return token0.toLowerCase() === token.toLowerCase() ? price : 1 / price;
};

const poolV3Price = async (
    provider: JsonRpcProvider,
    pool: string,
    token: string,
    wrappedNative: string,
): Promise<{
    price: number | null;
    liquidity: bigint;
    feePct: number | null;
}> => {
    try {
        const contract = new Contract(pool, POOL_V3_ABI, provider);
        const wrapped = new Contract(wrappedNative, BALANCE_ABI, provider);
        const [token0, slot0, fee, liquidity] = await Promise.all([
            contract.token0() as Promise<string>,
            contract.slot0() as Promise<[bigint, bigint]>,
            (contract.fee() as Promise<bigint>).catch(() => null),
            // A full-range position is the whole pool, so the coin the pool
            // holds is the launch's liquidity — plus whatever fees are still
            // uncollected, which are also locked there until claimed.
            wrapped.balanceOf(pool) as Promise<bigint>,
        ]);

        return {
            price: sqrtPriceQuote(token0, token, slot0[0]),
            liquidity,
            // The pool's own fee, never its tier: every launch pool is
            // created at 11% and then set down to what its creator chose.
            feePct: fee === null ? null : Number(fee) / 10_000,
        };
    } catch {
        return { price: null, liquidity: 0n, feePct: null };
    }
};

const poolPrice = async (
    provider: JsonRpcProvider,
    pair: string,
    token: string,
): Promise<{ price: number; liquidity: bigint } | null> => {
    try {
        const contract = new Contract(pair, PAIR_ABI, provider);
        const [token0, reserves] = await Promise.all([
            contract.token0() as Promise<string>,
            contract.getReserves() as Promise<[bigint, bigint, bigint]>,
        ]);

        return poolQuote(token0, token, [reserves[0], reserves[1]]);
    } catch {
        // A pool that cannot be read is a launch without a price, not a launch
        // that is worthless — the caller renders the difference.
        return null;
    }
};

/**
 * The most recent launches on one chain, newest first.
 *
 * A launch with no readable pool still appears: it exists on chain, and hiding
 * it because its price could not be fetched would be a quieter lie than showing
 * it with a dash.
 */
export const fetchLaunches = async (
    chainId: number = DEFAULT_LAUNCHPAD_CHAIN_ID,
    limit = PAGE,
): Promise<WalletLaunch[]> => {
    const target = launchpadChain(chainId);

    if (!target || launchVenue(target) === null) {
        return [];
    }

    const provider = providerFor(target);

    /*
     * Cyberia 2.0 has its launchpad and the studio beside it, and nothing
     * older. Both are read and merged by launch time; a studio that cannot be
     * read leaves the launchpad's list standing rather than failing it.
     */
    if (target.launchpadKit) {
        const [launched, made] = await Promise.all([
            readVenue(provider, target, 'kit', target.launchpadKit, limit),
            target.tokenStudio
                ? readVenue(
                      provider,
                      target,
                      'studio',
                      target.tokenStudio,
                      limit,
                  ).catch(() => [])
                : Promise.resolve([]),
        ]);

        return newestFirst([...launched, ...made]).slice(0, limit);
    }

    /*
     * v3 first. Once a chain has the v3 launchpad every launch from the site
     * and from this wallet goes there, so its list is the newer one; the v2
     * list fills whatever room is left.
     */
    const v3 = target.launchpadV3
        ? await readVenue(provider, target, 'v3', target.launchpadV3, limit)
        : [];
    const v2 =
        v3.length < limit && target.launchpad
            ? await readVenue(
                  provider,
                  target,
                  'v2',
                  target.launchpad,
                  limit - v3.length,
              )
            : [];

    return [...v3, ...v2];
};

/** Launches by time, newest first; an undated one keeps its place at the end. */
export const newestFirst = (launches: WalletLaunch[]): WalletLaunch[] =>
    launches
        .map((launch, index) => ({ launch, index }))
        .sort(
            (a, b) =>
                (b.launch.launchedAt ?? -1) - (a.launch.launchedAt ?? -1) ||
                a.index - b.index,
        )
        .map(({ launch }) => launch);

/** Whether a venue's registry is the Cyberia 2.0 `Economy` record. */
const hasEconomy = (venue: LaunchVenue): boolean =>
    venue === 'kit' || venue === 'studio';

/** The newest `limit` launches of one launchpad contract, newest first. */
const readVenue = async (
    provider: JsonRpcProvider,
    target: LaunchpadChain,
    venue: LaunchVenue,
    contract: string,
    limit: number,
): Promise<WalletLaunch[]> => {
    const launchpad = new Contract(
        contract,
        hasEconomy(venue)
            ? LAUNCH_KIT_ABI
            : venue === 'v3'
              ? LAUNCHPAD_V3_READ_ABI
              : LAUNCHPAD_ABI,
        provider,
    );
    const total = Number((await launchpad.allTokensLength()) as bigint);

    if (total === 0) {
        return [];
    }

    const indices: number[] = [];

    for (let i = total - 1; i >= Math.max(0, total - limit); i--) {
        indices.push(i);
    }

    const addresses = (await Promise.all(
        indices.map((index) => launchpad.allTokens(index) as Promise<string>),
    )) as string[];

    return Promise.all(
        addresses.map(async (address): Promise<WalletLaunch> => {
            const token = new Contract(address, ERC20_ABI, provider);
            const [name, symbol, supply, economy, minting] = await Promise.all([
                (token.name() as Promise<string>).catch(() => ''),
                (token.symbol() as Promise<string>).catch(() => ''),
                (token.totalSupply() as Promise<bigint>).catch(() => 0n),
                (hasEconomy(venue)
                    ? (launchpad.economyOf(address) as Promise<EconomyRead>)
                    : (
                          (venue === 'v3'
                              ? launchpad.poolOf(address)
                              : launchpad.pairOf(address)) as Promise<string>
                      ).then((pool) => ({ pool }) as EconomyRead)
                ).catch(() => null),
                venue === 'studio' ? readMinting(provider, address) : null,
            ]);

            const market = economy?.pool ?? ZeroAddress;
            const listed = Boolean(market) && market !== ZeroAddress;
            const pool = !listed
                ? null
                : venue !== 'v2'
                  ? await poolV3Price(
                        provider,
                        market,
                        address,
                        target.wrappedNative,
                    )
                  : await poolPrice(provider, market, address).then(
                        (quote) => quote && { ...quote, feePct: null },
                    );
            const whole = Number(formatUnits(supply, 18));
            const price = pool?.price ?? null;

            return {
                address,
                venue,
                feePct: pool?.feePct ?? null,
                kit: hasEconomy(venue) && economy ? kitOf(economy) : null,
                creator:
                    economy?.creator && economy.creator !== ZeroAddress
                        ? economy.creator
                        : null,
                launchedAt:
                    economy?.launchedAt === undefined
                        ? null
                        : Number(economy.launchedAt),
                minting,
                name: String(name).slice(0, 40),
                symbol: String(symbol).slice(0, 12),
                supply,
                liquidity: pool?.liquidity ?? 0n,
                priceNative: price,
                marketCapNative: price === null ? null : price * whole,
                explorerUrl: target.explorerUrl
                    ? `${target.explorerUrl}/address/${address}`
                    : '',
                swapUrl: `${target.swapUrl}?outputCurrency=${address}`,
            };
        }),
    );
};

/**
 * The part of a launchpad's record for one token this file reads. LaunchpadV3
 * and LaunchpadNative only know the market; Cyberia 2.0 knows the kit too.
 */
type EconomyRead = {
    pool: string;
    creator?: string;
    launchedAt?: bigint;
    gauge?: string;
    tokenOracle?: string;
    governor?: string;
    zone?: boolean;
};

/** A studio token's minter and ceiling, or null when they cannot be read. */
const readMinting = async (
    provider: JsonRpcProvider,
    token: string,
): Promise<WalletLaunch['minting']> => {
    try {
        const contract = new Contract(token, STUDIO_TOKEN_READ_ABI, provider);
        const [minter, maxSupply] = await Promise.all([
            contract.minter() as Promise<string>,
            contract.maxSupply() as Promise<bigint>,
        ]);

        return { minter, maxSupply };
    } catch {
        return null;
    }
};

/** What a Cyberia 2.0 economy record says was opened, from its addresses. */
export const kitOf = (economy: EconomyRead): LaunchKit => ({
    credit: Boolean(economy.tokenOracle && economy.tokenOracle !== ZeroAddress),
    farm: Boolean(economy.gauge && economy.gauge !== ZeroAddress),
    zone: economy.zone === true,
    dao: Boolean(economy.governor && economy.governor !== ZeroAddress),
});

/** What a Cyberia 2.0 launch opened, read from the chain; null elsewhere or unread. */
export const readKit = async (
    chainId: number,
    token: string,
    /** The registry that made it: the launchpad unless named. */
    registry?: string,
): Promise<LaunchKit | null> => {
    const target = launchpadChain(chainId);
    const contract = registry ?? target?.launchpadKit;

    if (!target || !contract) {
        return null;
    }

    try {
        const economy = (await new Contract(
            contract,
            LAUNCH_KIT_ABI,
            providerFor(target),
        ).economyOf(token)) as EconomyRead;

        return economy.pool === ZeroAddress ? null : kitOf(economy);
    } catch {
        return null;
    }
};

/**
 * Launches ordered by market cap, largest first. A launch with no readable
 * price has no market cap rather than one of zero, so it goes last instead of
 * being ranked as the smallest; ties and unpriced launches keep their order.
 */
export const byMarketCap = (launches: WalletLaunch[]): WalletLaunch[] =>
    launches
        .map((launch, index) => ({ launch, index }))
        .sort((a, b) => {
            const left = a.launch.marketCapNative;
            const right = b.launch.marketCapNative;

            if (left === null || right === null) {
                return left === right
                    ? a.index - b.index
                    : left === null
                      ? 1
                      : -1;
            }

            return right - left || a.index - b.index;
        })
        .map(({ launch }) => launch);

/** Chains with a launchpad deployed — the only ones with anything to list. */
export const launchpadChains = (): LaunchpadChain[] =>
    LAUNCHPAD_CHAINS.filter((entry) => entry.launchpad !== null);

/**
 * What the wallet's launchpad offers: Cyberia first, then Cyberia 2.0 — a
 * second core network beside the old one, never in place of it.
 */
export const walletLaunchpadChains = (): LaunchpadChain[] => [
    ...launchpadChains(),
    ...(CYBERIA2_LAUNCHPAD.launchpadKit ? [CYBERIA2_LAUNCHPAD] : []),
];

/* ------------------------------------------------------------- launching --- */

/**
 * Gas a launch may spend, per launchpad.
 *
 * A launch deploys a token *and* a market in one transaction: ~2.83M measured
 * on LaunchpadNative, ~7.9M on the v3 launchpad (a pool, a full-range position
 * and a locker transfer). The fallback is what gets signed when the node will
 * not estimate — this node's estimates are not to be trusted around contract
 * creation — and the cap is what the quoted fee promises, so a launch that
 * would cost more is refused rather than signed for the difference.
 */
export const LAUNCH_GAS = {
    v2: { fallback: 3_600_000n, cap: 4_500_000n },
    v3: { fallback: 10_000_000n, cap: 12_000_000n },
    // 13.0M measured for the first Fuji launch with the whole kit
    // (49407.smoke.json); the block takes 20M.
    kit: { fallback: 16_000_000n, cap: 19_000_000n },
    // 13.04M estimated on Fuji for a studio token with credit, farm, DAO and
    // one address minted to; each further address is a transfer on top.
    studio: { fallback: 16_000_000n, cap: 19_000_000n },
} as const;

/** Headroom over a live estimate, for the drift between quote and mine. */
const GAS_MARGIN = [125n, 100n] as const;

/** What the v3 launchpad lets a creator charge, in percent. */
export const MAX_CREATOR_FEE_PCT = 10;

/** The protocol's share of every v3 launch pool, in hundredths of a bip (1%). */
const PROTOCOL_FEE = 10_000;

const BPS = 10_000;

/** Longest name and ticker the wallet accepts — the list draws no more. */
export const LAUNCH_NAME_MAX = 40;
export const LAUNCH_SYMBOL_MAX = 12;

export type LaunchForm = {
    name: string;
    symbol: string;
    /**
     * Whole tokens, as typed, that go into the pool. On a plain launch that is
     * the whole supply; a studio token adds what `allocations` mint.
     */
    supply: string;
    /** Native coin, as typed. All of it goes into the pool, for good. */
    liquidity: string;
    /** Percent, as typed — v3 only. */
    creatorFeePct: string;
    /** Percent of the creator's fee that goes to holders, as typed — v3 only. */
    holdersSharePct: string;
    /** Cyberia 2.0: whether more can be minted after the launch. */
    mintable?: boolean;
    /** Cyberia 2.0: who may mint, when mintable. */
    minter?: string;
    /** Cyberia 2.0: the ceiling minting can reach, whole tokens; '' for none of its own. */
    maxSupply?: string;
    /** Cyberia 2.0: whole tokens minted straight to addresses, beside the pool. */
    allocations?: { to: string; amount: string }[];
    /** Cyberia 2.0: which parts of the kit to open; all of it when absent. */
    kit?: KitChoice;
};

/** Why a form cannot become a launch yet. Each has a sentence in the UI. */
export type LaunchProblem =
    | 'name'
    | 'symbol'
    | 'supply'
    | 'liquidity'
    | 'liquidityMin'
    | 'fee'
    | 'share'
    | 'allocation'
    | 'minter'
    | 'cap';

/** A decimal string as 18-decimal units, or null when it is not one. */
const units = (value: string): bigint | null => {
    const trimmed = value.trim();

    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
        return null;
    }

    try {
        return parseUnits(trimmed, 18);
    } catch {
        // More than 18 decimals: not a number this chain can hold.
        return null;
    }
};

/** A percentage between 0 and `max`, or null. */
const percent = (value: string, max: number): number | null => {
    const trimmed = value.trim() === '' ? '0' : value.trim();

    if (!/^\d+(\.\d+)?$/.test(trimmed)) {
        return null;
    }

    const parsed = Number(trimmed);

    return parsed <= max ? parsed : null;
};

/**
 * The fee and the holders' share, in the units the contract takes.
 *
 * The fee is in hundredths of a bip (1% = 10000) and the share in basis points
 * of the creator's own fee. Rounded rather than truncated, so "2.5" is 25000
 * and not 24999 because of how 2.5 × 10000 happens to be stored.
 */
export const launchTerms = (
    creatorFeePct: string,
    holdersSharePct: string,
): { creatorFee: number; holdersShareBps: number } | null => {
    const fee = percent(creatorFeePct, MAX_CREATOR_FEE_PCT);
    const share = percent(holdersSharePct, 100);

    if (fee === null || share === null) {
        return null;
    }

    return {
        creatorFee: Math.round(fee * 10_000),
        holdersShareBps: Math.round(share * 100),
    };
};

/**
 * Where every unit of a v3 launch pool's fees goes.
 *
 * `LaunchpadV3.quote` line for line, floors and all: the creator's side is
 * their fee over the pool's, the holders' cut comes out of the creator's side
 * and never out of the protocol's, and rounding lands on the treasury. It is
 * restated rather than called because a screen that has to wait for the node
 * to learn what a slider means is a screen that lags the slider — the test
 * pins it to the contract's own arithmetic.
 */
export const feeSplit = (
    creatorFee: number,
    holdersShareBps: number,
): {
    poolFeePct: number;
    creatorBps: number;
    holdersBps: number;
    treasuryBps: number;
} => {
    const poolFee = creatorFee + PROTOCOL_FEE;
    const creatorSide = Math.floor((BPS * creatorFee) / poolFee);
    const holdersBps = Math.floor((creatorSide * holdersShareBps) / BPS);

    return {
        poolFeePct: poolFee / 10_000,
        creatorBps: creatorSide - holdersBps,
        holdersBps,
        treasuryBps: BPS - creatorSide,
    };
};

/**
 * The first thing wrong with a launch form, or null when it can be priced.
 *
 * Pure, so the button can say *why* it is disabled instead of just being so.
 * `minLiquidity` is the contract's own floor when it has been read, and null
 * before — a floor nobody has read yet is not a reason to refuse.
 */
export const launchProblem = (
    form: LaunchForm,
    venue: LaunchVenue,
    minLiquidity: bigint | null,
): LaunchProblem | null => {
    const name = form.name.trim();
    const symbol = form.symbol.trim();

    if (name === '' || name.length > LAUNCH_NAME_MAX) {
        return 'name';
    }

    // A ticker that spells a domain zone (`.moon` / `DOTMOON`) is as long as
    // its zone needs; the name's own cap already bounds it.
    if (
        symbol === '' ||
        (symbol.length > LAUNCH_SYMBOL_MAX && !zoneFromToken(name, symbol)) ||
        /\s/.test(symbol)
    ) {
        return 'symbol';
    }

    const supply = units(form.supply);

    if (supply === null || supply === 0n) {
        return 'supply';
    }

    if (venue === 'studio') {
        const studio = studioProblem(form, supply);

        if (studio !== null) {
            return studio;
        }
    }

    const liquidity = units(form.liquidity);

    if (liquidity === null || liquidity === 0n) {
        return 'liquidity';
    }

    if (minLiquidity !== null && liquidity < minLiquidity) {
        return 'liquidityMin';
    }

    if (venueHasFee(venue)) {
        if (percent(form.creatorFeePct, MAX_CREATOR_FEE_PCT) === null) {
            return 'fee';
        }

        if (percent(form.holdersSharePct, 100) === null) {
            return 'share';
        }
    }

    return null;
};

/** The addresses and amounts a studio form mints to, or null when one is not. */
export const formAllocations = (
    form: LaunchForm,
): { to: string; amount: bigint }[] | null => {
    const rows = form.allocations ?? [];
    const parsed: { to: string; amount: bigint }[] = [];

    for (const row of rows) {
        const amount = units(row.amount);

        if (!isAddress(row.to.trim()) || amount === null || amount === 0n) {
            return null;
        }

        parsed.push({ to: row.to.trim(), amount });
    }

    return parsed;
};

/** Everything a studio form would make: the pool's part and the addresses'. */
export const formTotalSupply = (form: LaunchForm): bigint | null => {
    const supply = units(form.supply);
    const allocations = formAllocations(form);

    return supply === null || allocations === null
        ? null
        : allocations.reduce((sum, row) => sum + row.amount, supply);
};

/** The ceiling a mintable form names, 0n for the token's own, null when unreadable. */
const formCap = (form: LaunchForm): bigint | null =>
    (form.maxSupply ?? '').trim() === '' ? 0n : units(form.maxSupply ?? '');

const studioProblem = (
    form: LaunchForm,
    supply: bigint,
): LaunchProblem | null => {
    const allocations = formAllocations(form);

    if (allocations === null || allocations.length > STUDIO_MAX_ALLOCATIONS) {
        return 'allocation';
    }

    const total = allocations.reduce((sum, row) => sum + row.amount, supply);

    if (total > STUDIO_MAX_SUPPLY) {
        return 'supply';
    }

    if (form.mintable) {
        if (!isAddress((form.minter ?? '').trim())) {
            return 'minter';
        }

        const cap = formCap(form);

        if (
            cap === null ||
            (cap !== 0n && (cap < total || cap > STUDIO_MAX_SUPPLY))
        ) {
            return 'cap';
        }
    }

    return null;
};

/** Whether a form asks for anything only the studio makes. */
export const wantsStudio = (form: LaunchForm): boolean =>
    form.mintable === true || (form.allocations ?? []).length > 0;

/**
 * Where this form's token is made: the studio when it asks for a minter or
 * addresses to mint to and the chain runs one; otherwise the chain's newest
 * launchpad, as before.
 */
export const formVenue = (
    target: LaunchpadChain,
    form: LaunchForm,
): LaunchVenue | null =>
    target.tokenStudio && wantsStudio(form) ? 'studio' : launchVenue(target);

/** Which launchpad a chain launches on: the newest one it has. */
export const launchVenue = (target: LaunchpadChain): LaunchVenue | null =>
    target.launchpadKit
        ? 'kit'
        : target.launchpadV3
          ? 'v3'
          : target.launchpad
            ? 'v2'
            : null;

/** Whether a venue's pool charges a fee its creator chose. */
export const venueHasFee = (venue: LaunchVenue | null): boolean =>
    venue === 'v3' || venue === 'kit' || venue === 'studio';

const LAUNCH_ABI: Record<LaunchVenue, string[]> = {
    v2: LAUNCH_V2_ABI,
    v3: LAUNCH_V3_ABI,
    kit: LAUNCH_KIT_ABI,
    studio: LAUNCH_STUDIO_ABI,
};

/** The function a venue launches with: the studio `create`s. */
const launchFunction = (venue: LaunchVenue): 'launch' | 'create' =>
    venue === 'studio' ? 'create' : 'launch';

/** The contract a venue launches through on this chain. */
const venueAddress = (target: LaunchpadChain, venue: LaunchVenue): string =>
    (venue === 'studio'
        ? target.tokenStudio
        : venue === 'kit'
          ? target.launchpadKit
          : venue === 'v3'
            ? target.launchpadV3
            : target.launchpad)!;

/** The contract's floor for the coin a launch must be paired with. */
export const readMinLiquidity = async (
    target: LaunchpadChain,
    venue: LaunchVenue | null = launchVenue(target),
): Promise<bigint | null> => {
    if (venue === null) {
        return null;
    }

    const contract = new Contract(
        venueAddress(target, venue),
        LAUNCH_ABI[venue],
        providerFor(target),
    );

    try {
        return (await contract.minLiquidity()) as bigint;
    } catch {
        return null;
    }
};

export type LaunchQuote = {
    chainId: number;
    venue: LaunchVenue;
    /** The launchpad contract this will be sent to. */
    launchpad: string;
    name: string;
    symbol: string;
    /** What goes into the pool: the whole supply, except a studio token's. */
    supply: bigint;
    /** Native coin paired with the supply, in wei — spent for good. */
    liquidity: bigint;
    creatorFee: number;
    holdersShareBps: number;
    /** Studio only: minted straight to these addresses. Empty elsewhere. */
    allocations: { to: string; amount: bigint }[];
    /** Studio only: who may mint more; the zero address for nobody. */
    minter: string;
    /** Studio only: the ceiling minting can reach; 0n for the token's own. */
    maxSupply: bigint;
    /** Cyberia 2.0: the KIT_* flags asked for. */
    kit: number;
    /**
     * Cyberia 2.0 only: picks the token's address among the creator's, so it
     * is drawn once per quote and the call, the estimate and the signature
     * all launch the same token. Zero elsewhere.
     */
    salt: string;
    gasLimit: bigint;
    gasPrice: bigint;
    fee: bigint;
};

/** Refusals `quoteLaunch` can name, so the screen can translate them. */
export class LaunchRefused extends Error {
    readonly code: 'funds' | 'gas' | 'reverted';

    // No parameter properties: the frontend tests run this file through
    // Node's type stripping, which refuses them.
    constructor(code: 'funds' | 'gas' | 'reverted', detail = '') {
        super(detail || code);
        this.code = code;
    }
}

/**
 * The launch contract with its arguments, for a call, an estimate or a send.
 * One place, so the three cannot disagree about what is being launched.
 */
export const launchArgs = (quote: {
    venue: LaunchVenue;
    name: string;
    symbol: string;
    supply: bigint;
    creatorFee: number;
    holdersShareBps: number;
    salt: string;
    kit?: number;
    allocations?: { to: string; amount: bigint }[];
    minter?: string;
    maxSupply?: bigint;
}): unknown[] =>
    quote.venue === 'studio'
        ? [
              {
                  name: quote.name,
                  symbol: quote.symbol,
                  poolSupply: quote.supply,
                  allocations: (quote.allocations ?? []).map((row) => ({
                      to: row.to,
                      amount: row.amount,
                  })),
                  minter: quote.minter ?? ZeroAddress,
                  maxSupply: quote.maxSupply ?? 0n,
                  creatorFee: quote.creatorFee,
                  holdersShareBps: quote.holdersShareBps,
                  salt: quote.salt,
                  kit: quote.kit ?? KIT_ALL,
                  metadataURI: '',
              },
          ]
        : quote.venue === 'kit'
          ? [
                {
                    name: quote.name,
                    symbol: quote.symbol,
                    totalSupply: quote.supply,
                    creatorFee: quote.creatorFee,
                    holdersShareBps: quote.holdersShareBps,
                    salt: quote.salt,
                    kit: quote.kit ?? KIT_ALL,
                    // The description and logo are kept by the server, as on
                    // Cyberia; the creator can still point this at IPFS later.
                    metadataURI: '',
                },
            ]
          : quote.venue === 'v3'
            ? [
                  quote.name,
                  quote.symbol,
                  quote.supply,
                  quote.creatorFee,
                  quote.holdersShareBps,
              ]
            : [quote.name, quote.symbol, quote.supply];

/**
 * Price a launch and prove it would go through, before anything is signed.
 *
 * The launch is first *run* as a call from the real account with the real
 * coin attached, so a revert — a floor, a price the pool cannot represent —
 * surfaces here with the contract's own reason instead of after a hold that
 * spent the gas. Then it is estimated, falling back to the measured figure,
 * and refused above the cap. The balance check covers the coin that goes into
 * the pool *and* the fee, because a launch that can pay for one and not the
 * other fails either way.
 */
export const quoteLaunch = async (request: {
    target: LaunchpadChain;
    form: LaunchForm;
    account: string;
    gasPrice: bigint;
}): Promise<LaunchQuote> => {
    const { target, form, account } = request;
    const venue = formVenue(target, form);

    if (venue === null) {
        throw new LaunchRefused('reverted', 'No launchpad on this network');
    }

    const minLiquidity = await readMinLiquidity(target, venue);
    const problem = launchProblem(form, venue, minLiquidity);

    if (problem !== null) {
        throw new LaunchRefused('reverted', problem);
    }

    const terms = launchTerms(form.creatorFeePct, form.holdersSharePct) ?? {
        creatorFee: 0,
        holdersShareBps: 0,
    };
    const address = venueAddress(target, venue);
    const provider = providerFor(target);
    const contract = new Contract(address, LAUNCH_ABI[venue], provider);
    const charges = venueHasFee(venue);

    const draft = {
        venue,
        name: form.name.trim(),
        symbol: form.symbol.trim(),
        supply: units(form.supply)!,
        creatorFee: charges ? terms.creatorFee : 0,
        holdersShareBps: charges ? terms.holdersShareBps : 0,
        salt: hasEconomy(venue) ? hexlify(randomBytes(32)) : ZeroHash,
        kit: hasEconomy(venue) ? kitFlags(form.kit, venue) : 0,
        allocations: venue === 'studio' ? (formAllocations(form) ?? []) : [],
        minter:
            venue === 'studio' && form.mintable
                ? (form.minter ?? '').trim()
                : ZeroAddress,
        maxSupply:
            venue === 'studio' && form.mintable ? (formCap(form) ?? 0n) : 0n,
    };
    const liquidity = units(form.liquidity)!;
    const gas = LAUNCH_GAS[venue];
    const args = launchArgs(draft);

    const balance = await provider.getBalance(account);

    if (balance < liquidity + gas.fallback * request.gasPrice) {
        throw new LaunchRefused('funds');
    }

    const method = contract.getFunction(launchFunction(venue));

    try {
        await method.staticCall(...args, {
            from: account,
            value: liquidity,
            gasLimit: gas.cap,
        });
    } catch (error) {
        throw new LaunchRefused('reverted', revertReason(error));
    }

    const estimate = await (
        method.estimateGas(...args, {
            from: account,
            value: liquidity,
        }) as Promise<bigint>
    ).catch(() => null);

    const gasLimit =
        estimate === null
            ? gas.fallback
            : (estimate * GAS_MARGIN[0]) / GAS_MARGIN[1];

    if (gasLimit > gas.cap) {
        throw new LaunchRefused('gas');
    }

    return {
        chainId: target.chain.chainId,
        launchpad: address,
        liquidity,
        ...draft,
        gasLimit,
        gasPrice: request.gasPrice,
        fee: gasLimit * request.gasPrice,
    };
};

/** The contract's own words, when a revert carried any. */
const revertReason = (error: unknown): string => {
    const shaped = error as {
        reason?: string | null;
        shortMessage?: string;
        message?: string;
    };

    return (
        shaped.reason ??
        shaped.shortMessage ??
        shaped.message ??
        String(error)
    ).slice(0, 200);
};

/**
 * Sign and broadcast the launch. Returns the transaction hash.
 *
 * Every figure is the one that was quoted and held for; nothing is re-read
 * after the hold, since re-pricing then would sign for a number nobody saw.
 */
export const executeLaunch = async (
    source: WalletKeySource,
    request: { quote: LaunchQuote; rpcUrl?: string },
): Promise<string> => {
    const { quote } = request;
    const target = launchpadChain(quote.chainId);

    if (!target) {
        throw new Error('No launchpad on this network');
    }

    const provider = request.rpcUrl
        ? new JsonRpcProvider(request.rpcUrl, quote.chainId, {
              staticNetwork: true,
          })
        : providerFor(target);
    const signer = evmSigner(source).connect(provider);
    const contract = new Contract(
        quote.launchpad,
        LAUNCH_ABI[quote.venue],
        signer,
    );

    const tx = await contract.getFunction(launchFunction(quote.venue))(
        ...launchArgs(quote),
        {
            value: quote.liquidity,
            gasLimit: quote.gasLimit,
            gasPrice: quote.gasPrice,
        },
    );

    return tx.hash as string;
};

/**
 * The token and market a mined launch made, out of its own receipt.
 *
 * Pure over the logs so it can be pinned: the token is the event's first
 * indexed topic on both launchpads, and only a log emitted *by the launchpad*
 * counts — a token contract could emit an event with the same signature, and
 * reading a stranger's log would hand the user somebody else's address.
 */
export const launchedFromLogs = (
    logs: readonly {
        address: string;
        topics: readonly string[];
        data: string;
    }[],
    venue: LaunchVenue,
    launchpad: string,
): { token: string; market: string } | null => {
    const iface = new Interface(LAUNCH_ABI[venue]);
    const event = hasEconomy(venue) ? 'Launched' : 'TokenLaunched';

    for (const log of logs) {
        if (log.address.toLowerCase() !== launchpad.toLowerCase()) {
            continue;
        }

        try {
            const parsed = iface.parseLog({
                topics: [...log.topics],
                data: log.data,
            });

            if (parsed?.name === event) {
                return {
                    token: parsed.args.token as string,
                    market: (venue === 'v2'
                        ? parsed.args.pair
                        : parsed.args.pool) as string,
                };
            }
        } catch {
            // Not this launchpad's event.
        }
    }

    return null;
};

/**
 * Wait for a launch to be mined and say what it made.
 *
 * `failed` is a revert (the coin came back, the gas did not); a timeout
 * rejects, because it is a fact about the watching and says nothing about
 * the launch — the screen keeps the hash and says so.
 */
export const awaitLaunch = async (
    quote: LaunchQuote,
    hash: string,
): Promise<
    | { status: 'launched'; token: string; market: string }
    | { status: 'failed' }
    | { status: 'unread' }
> => {
    const target = launchpadChain(quote.chainId);

    if (!target) {
        throw new Error('No launchpad on this network');
    }

    const receipt = await providerFor(target).waitForTransaction(
        hash,
        1,
        180_000,
    );

    if (receipt === null) {
        throw new Error('Timed out waiting for a receipt');
    }

    if (receipt.status !== 1) {
        return { status: 'failed' };
    }

    const made = launchedFromLogs(receipt.logs, quote.venue, quote.launchpad);

    return made ? { status: 'launched', ...made } : { status: 'unread' };
};

/* -------------------------------------------------------------- metadata --- */

/**
 * The sentence the server's `LaunchpadController::store` accepts: the token,
 * the chain and a fresh timestamp. Byte-compatible with `/launchpad`'s own,
 * so a launch from here can later be edited there and the other way round.
 */
export const metadataMessage = (
    token: string,
    chainId: number,
    at: Date = new Date(),
): string =>
    `Edit Cyberia Launchpad metadata for ${token.toLowerCase()} on chain ${chainId} at ${at.toISOString()}`;

export type LaunchAbout = {
    description: string;
    x: string;
    telegram: string;
    website: string;
    image: File | null;
};

/** Whether there is anything to attach — nothing typed means nothing signed. */
export const hasAbout = (about: LaunchAbout): boolean =>
    about.description.trim() !== '' ||
    about.x.trim() !== '' ||
    about.telegram.trim() !== '' ||
    about.website.trim() !== '' ||
    about.image !== null;

/**
 * Attach the description, links and logo to a launch.
 *
 * `sign` is the wallet's own message signature: the first signature for a
 * token claims it as its creator's, and the server checks the signer against
 * that from then on — which is why this runs right after the launch, from the
 * same key that paid for it.
 */
export const submitAbout = async (request: {
    token: string;
    chainId: number;
    name: string;
    symbol: string;
    about: LaunchAbout;
    sign: (message: string) => Promise<string>;
}): Promise<void> => {
    const message = metadataMessage(request.token, request.chainId);
    const signature = await request.sign(message);
    const form = new FormData();
    const { about } = request;

    form.append('address', request.token);
    form.append('chain_id', String(request.chainId));
    form.append('message', message);
    form.append('signature', signature);
    form.append('name', request.name);
    form.append('symbol', request.symbol);

    const fields: [string, string][] = [
        ['description', about.description],
        ['x', about.x],
        ['telegram', about.telegram],
        ['website', about.website],
    ];

    for (const [key, value] of fields) {
        if (value.trim() !== '') {
            form.append(key, value.trim());
        }
    }

    if (about.image) {
        form.append('image', about.image);
    }

    const response = await fetch('/api/launchpad/tokens', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        body: form,
    });

    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
            message?: string;
        } | null;

        throw new Error(body?.message ?? `HTTP ${response.status}`);
    }
};

/**
 * Ask the server to read the launchpads now, and hand back the DAO the launch
 * opened.
 *
 * Every launch opens a DAO, lands in the feed and is pushed to everyone
 * (`launchpad:watch`); this only makes it seconds instead of up to a minute.
 * The request names the token so the answer can carry its DAO — nothing in it
 * is believed, the server reads the launch from the contract. A sweep already
 * running elsewhere answers empty, so it is asked a few times; null means the
 * scheduled sweep will get there, never that there is no DAO.
 */
export const watchLaunch = async (
    token: string,
    attempts = 4,
    pauseMs = 4000,
): Promise<{ id: number; name: string } | null> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, pauseMs));
        }

        try {
            const response = await fetch('/api/launchpad/watch', {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ address: token.toLowerCase() }),
            });

            if (!response.ok) {
                continue;
            }

            const body = (await response.json()) as {
                token: { dao: { id: number; name: string } | null } | null;
            };

            if (body.token?.dao) {
                return body.token.dao;
            }
        } catch {
            // Unreachable now is not "no DAO" — the scheduled sweep opens it.
        }
    }

    return null;
};

/** Where a launch transaction can be looked at; null with no explorer. */
export const launchTxUrl = (chainId: number, hash: string): string | null => {
    const explorer = launchpadChain(chainId)?.explorerUrl ?? '';

    return explorer ? `${explorer}/tx/${hash}` : null;
};
