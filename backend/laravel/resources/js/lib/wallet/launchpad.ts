import {
    Contract,
    Interface,
    JsonRpcProvider,
    ZeroAddress,
    formatUnits,
    parseUnits,
} from 'ethers';
import {
    DEFAULT_LAUNCHPAD_CHAIN_ID,
    LAUNCHPAD_CHAINS,
    launchpadChain,
    launchpadReadRpcUrl,
} from '@/lib/launchpadChains';
import type { LaunchpadChain } from '@/lib/launchpadChains';
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

export type LaunchVenue = 'v2' | 'v3';

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

    if (!target?.launchpad) {
        return [];
    }

    const provider = providerFor(target);

    /*
     * v3 first. Once a chain has the v3 launchpad every launch from the site
     * and from this wallet goes there, so its list is the newer one; the v2
     * list fills whatever room is left.
     */
    const v3 = target.launchpadV3
        ? await readVenue(provider, target, 'v3', target.launchpadV3, limit)
        : [];
    const v2 =
        v3.length < limit
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
        venue === 'v3' ? LAUNCHPAD_V3_READ_ABI : LAUNCHPAD_ABI,
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
            const [name, symbol, supply, market] = await Promise.all([
                (token.name() as Promise<string>).catch(() => ''),
                (token.symbol() as Promise<string>).catch(() => ''),
                (token.totalSupply() as Promise<bigint>).catch(() => 0n),
                (
                    (venue === 'v3'
                        ? launchpad.poolOf(address)
                        : launchpad.pairOf(address)) as Promise<string>
                ).catch(() => ZeroAddress),
            ]);

            const listed = Boolean(market) && market !== ZeroAddress;
            const pool = !listed
                ? null
                : venue === 'v3'
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
                name: String(name).slice(0, 40),
                symbol: String(symbol).slice(0, 12),
                supply,
                liquidity: pool?.liquidity ?? 0n,
                priceNative: price,
                marketCapNative: price === null ? null : price * whole,
                explorerUrl: `${target.explorerUrl}/address/${address}`,
                swapUrl: `${target.swapUrl}?outputCurrency=${address}`,
            };
        }),
    );
};

/** Chains with a launchpad deployed — the only ones with anything to list. */
export const launchpadChains = (): LaunchpadChain[] =>
    LAUNCHPAD_CHAINS.filter((entry) => entry.launchpad !== null);

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
    /** Whole tokens, as typed. All of it goes into the pool. */
    supply: string;
    /** Native coin, as typed. All of it goes into the pool, for good. */
    liquidity: string;
    /** Percent, as typed — v3 only. */
    creatorFeePct: string;
    /** Percent of the creator's fee that goes to holders, as typed — v3 only. */
    holdersSharePct: string;
};

/** Why a form cannot become a launch yet. Each has a sentence in the UI. */
export type LaunchProblem =
    | 'name'
    | 'symbol'
    | 'supply'
    | 'liquidity'
    | 'liquidityMin'
    | 'fee'
    | 'share';

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

    if (
        symbol === '' ||
        symbol.length > LAUNCH_SYMBOL_MAX ||
        /\s/.test(symbol)
    ) {
        return 'symbol';
    }

    const supply = units(form.supply);

    if (supply === null || supply === 0n) {
        return 'supply';
    }

    const liquidity = units(form.liquidity);

    if (liquidity === null || liquidity === 0n) {
        return 'liquidity';
    }

    if (minLiquidity !== null && liquidity < minLiquidity) {
        return 'liquidityMin';
    }

    if (venue === 'v3') {
        if (percent(form.creatorFeePct, MAX_CREATOR_FEE_PCT) === null) {
            return 'fee';
        }

        if (percent(form.holdersSharePct, 100) === null) {
            return 'share';
        }
    }

    return null;
};

/** Which launchpad a chain launches on: v3 where it has one. */
export const launchVenue = (target: LaunchpadChain): LaunchVenue | null =>
    target.launchpadV3 ? 'v3' : target.launchpad ? 'v2' : null;

/** The contract's floor for the coin a launch must be paired with. */
export const readMinLiquidity = async (
    target: LaunchpadChain,
): Promise<bigint | null> => {
    const venue = launchVenue(target);

    if (venue === null) {
        return null;
    }

    const contract = new Contract(
        venue === 'v3' ? target.launchpadV3! : target.launchpad!,
        venue === 'v3' ? LAUNCH_V3_ABI : LAUNCH_V2_ABI,
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
    supply: bigint;
    /** Native coin paired with the supply, in wei — spent for good. */
    liquidity: bigint;
    creatorFee: number;
    holdersShareBps: number;
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
const launchArgs = (quote: {
    venue: LaunchVenue;
    name: string;
    symbol: string;
    supply: bigint;
    creatorFee: number;
    holdersShareBps: number;
}): unknown[] =>
    quote.venue === 'v3'
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
    const venue = launchVenue(target);

    if (venue === null) {
        throw new LaunchRefused('reverted', 'No launchpad on this network');
    }

    const minLiquidity = await readMinLiquidity(target);
    const problem = launchProblem(form, venue, minLiquidity);

    if (problem !== null) {
        throw new LaunchRefused('reverted', problem);
    }

    const terms = launchTerms(form.creatorFeePct, form.holdersSharePct) ?? {
        creatorFee: 0,
        holdersShareBps: 0,
    };
    const address = venue === 'v3' ? target.launchpadV3! : target.launchpad!;
    const provider = providerFor(target);
    const contract = new Contract(
        address,
        venue === 'v3' ? LAUNCH_V3_ABI : LAUNCH_V2_ABI,
        provider,
    );

    const draft = {
        venue,
        name: form.name.trim(),
        symbol: form.symbol.trim(),
        supply: units(form.supply)!,
        creatorFee: venue === 'v3' ? terms.creatorFee : 0,
        holdersShareBps: venue === 'v3' ? terms.holdersShareBps : 0,
    };
    const liquidity = units(form.liquidity)!;
    const gas = LAUNCH_GAS[venue];
    const args = launchArgs(draft);

    const balance = await provider.getBalance(account);

    if (balance < liquidity + gas.fallback * request.gasPrice) {
        throw new LaunchRefused('funds');
    }

    try {
        await contract.launch.staticCall(...args, {
            from: account,
            value: liquidity,
            gasLimit: gas.cap,
        });
    } catch (error) {
        throw new LaunchRefused('reverted', revertReason(error));
    }

    const estimate = await (
        contract.launch.estimateGas(...args, {
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
        quote.venue === 'v3' ? LAUNCH_V3_ABI : LAUNCH_V2_ABI,
        signer,
    );

    const tx = await contract.launch(...launchArgs(quote), {
        value: quote.liquidity,
        gasLimit: quote.gasLimit,
        gasPrice: quote.gasPrice,
    });

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
    const iface = new Interface(venue === 'v3' ? LAUNCH_V3_ABI : LAUNCH_V2_ABI);

    for (const log of logs) {
        if (log.address.toLowerCase() !== launchpad.toLowerCase()) {
            continue;
        }

        try {
            const parsed = iface.parseLog({
                topics: [...log.topics],
                data: log.data,
            });

            if (parsed?.name === 'TokenLaunched') {
                return {
                    token: parsed.args.token as string,
                    market: (venue === 'v3'
                        ? parsed.args.pool
                        : parsed.args.pair) as string,
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

/** Where a launch transaction can be looked at. */
export const launchTxUrl = (chainId: number, hash: string): string =>
    `${launchpadChain(chainId)?.explorerUrl ?? ''}/tx/${hash}`;
