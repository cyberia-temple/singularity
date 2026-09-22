/**
 * The event taxonomy, browser side.
 *
 * The mirror of `App\Services\Analytics\EventTaxonomy`, and pinned to it by
 * `tests/Frontend/AnalyticsTaxonomyTest.mjs` together with
 * `tests/Feature/Analytics/EventTaxonomyTest.php`. Two copies exist because
 * one of them has to be a TypeScript union — an event name misspelled at a
 * call site should be a build error rather than a row that silently never
 * appears on a dashboard — and neither copy is allowed to drift.
 *
 * The property allowlist is repeated here for a second reason: what is not
 * sent cannot be stored. The server filters again, because a client is not a
 * security boundary, but a wallet whose analytics call is inspected in a
 * network tab should contain nothing worth inspecting.
 */

export type AnalyticsEventName =
    // Application
    | 'first_open'
    | 'app_opened'
    | 'session_started'
    // Onboarding
    | 'wallet_creation_started'
    | 'wallet_created'
    | 'wallet_import_started'
    | 'wallet_imported'
    | 'onboarding_completed'
    // Funding and activation
    | 'wallet_funded'
    | 'first_transaction'
    // Transactions
    | 'transaction_started'
    | 'transaction_signed'
    | 'transaction_submitted'
    | 'transaction_confirmed'
    | 'transaction_failed'
    // Swap and wrap
    | 'swap_opened'
    | 'swap_quote_requested'
    | 'swap_quote_received'
    // A quote that never arrived — no route, or a node that would not price
    // the trade. Deliberately not `swap_failed`: nobody signed anything.
    | 'swap_quote_failed'
    | 'swap_started'
    | 'swap_signed'
    | 'swap_completed'
    | 'swap_failed'
    // Bridge
    | 'bridge_opened'
    | 'bridge_quote_received'
    | 'bridge_started'
    | 'bridge_deposit_confirmed'
    | 'bridge_completed'
    | 'bridge_failed'
    // Farming
    | 'staking_opened'
    | 'staking_started'
    | 'staking_completed'
    | 'staking_withdrawn'
    | 'staking_failed'
    | 'reward_claimed'
    // Liquidity, on the DEX pages and in the wallet's own pool screen
    | 'liquidity_added'
    | 'liquidity_removed'
    // NFT
    | 'nft_mint_started'
    | 'nft_minted'
    | 'nft_mint_failed'
    // Sponsored fees
    | 'gas_sponsorship_requested'
    | 'gas_sponsorship_completed'
    | 'gas_sponsorship_failed';

export const ANALYTICS_EVENTS: readonly AnalyticsEventName[] = [
    'first_open',
    'app_opened',
    'session_started',
    'wallet_creation_started',
    'wallet_created',
    'wallet_import_started',
    'wallet_imported',
    'onboarding_completed',
    'wallet_funded',
    'first_transaction',
    'transaction_started',
    'transaction_signed',
    'transaction_submitted',
    'transaction_confirmed',
    'transaction_failed',
    'swap_opened',
    'swap_quote_requested',
    'swap_quote_received',
    'swap_quote_failed',
    'swap_started',
    'swap_signed',
    'swap_completed',
    'swap_failed',
    'bridge_opened',
    'bridge_quote_received',
    'bridge_started',
    'bridge_deposit_confirmed',
    'bridge_completed',
    'bridge_failed',
    'staking_opened',
    'staking_started',
    'staking_completed',
    'staking_withdrawn',
    'staking_failed',
    'reward_claimed',
    'liquidity_added',
    'liquidity_removed',
    'nft_mint_started',
    'nft_minted',
    'nft_mint_failed',
    'gas_sponsorship_requested',
    'gas_sponsorship_completed',
    'gas_sponsorship_failed',
] as const;

/**
 * A meaningful action: something that settled on a chain.
 *
 * This list *is* the definition of an activated user and of an active user.
 * Opening a screen is not on it, a quote is not on it, and a broadcast is not
 * on it — the send screen in this same wallet says "broadcast is not
 * settlement", and a metric that disagreed with the product would be the one
 * that is wrong.
 */
export const MEANINGFUL_EVENTS: readonly AnalyticsEventName[] = [
    'transaction_confirmed',
    'swap_completed',
    'bridge_completed',
    'staking_completed',
    'staking_withdrawn',
    'reward_claimed',
    'liquidity_added',
    'liquidity_removed',
    'nft_minted',
] as const;

/** The one refusal vocabulary, so a failure aggregates instead of scrolling. */
export const ANALYTICS_ERROR_CODES = [
    'user_rejected',
    'insufficient_funds',
    'insufficient_gas',
    'allowance',
    'slippage',
    'no_route',
    'quote_expired',
    'nonce',
    'reverted',
    'rpc_unreachable',
    'timeout',
    'watch_only',
    'unsupported',
    'server_refused',
    'unknown',
    // GasSponsorService's own vocabulary, reused rather than remapped.
    'hasGas',
    'holdsNothing',
    'coolingDown',
    'dailyCap',
    'empty',
    'quota',
    'unreadable',
    'paused',
    'disabled',
] as const;

export type AnalyticsErrorCode = (typeof ANALYTICS_ERROR_CODES)[number];

export type AnalyticsProperties = {
    chain?: string;
    from_chain?: string;
    to_chain?: string;
    section?: string;
    asset?: string;
    token_in?: string;
    token_out?: string;
    token_type?: 'coin' | 'token';
    transaction_type?:
        | 'send'
        | 'token_transfer'
        | 'swap'
        | 'wrap'
        | 'bridge'
        | 'stake'
        | 'unstake'
        | 'claim'
        | 'mint'
        | 'liquidity';
    amount_usd?: number;
    fee_usd?: number;
    gas_usd?: number;
    price_impact?: number;
    slippage?: number;
    route?: string;
    hops?: number;
    tier?: 'slow' | 'normal' | 'fast';
    duration_ms?: number;
    error_code?: AnalyticsErrorCode;
    watchable?: boolean;
    sponsored?: boolean;
    verified?: boolean;
    origin?: 'created' | 'imported' | 'auto';
    grounds?: 'tokens' | 'nft' | 'account' | 'open';
    pid?: number;
    pool_kind?: 'pair' | 'solo';
};

type Shape = 'slug' | 'route' | 'usd' | 'ratio' | 'count' | 'ms' | 'flag' | 'error';

/** Key → shape, mirroring EventTaxonomy::PROPERTIES exactly. */
export const ANALYTICS_PROPERTY_SHAPES: Record<keyof AnalyticsProperties, Shape> =
    {
        chain: 'slug',
        from_chain: 'slug',
        to_chain: 'slug',
        section: 'slug',
        asset: 'slug',
        token_in: 'slug',
        token_out: 'slug',
        token_type: 'slug',
        transaction_type: 'slug',
        amount_usd: 'usd',
        fee_usd: 'usd',
        gas_usd: 'usd',
        price_impact: 'ratio',
        slippage: 'ratio',
        route: 'route',
        hops: 'count',
        tier: 'slug',
        duration_ms: 'ms',
        error_code: 'error',
        watchable: 'flag',
        sponsored: 'flag',
        verified: 'flag',
        origin: 'slug',
        grounds: 'slug',
        pid: 'count',
        pool_kind: 'slug',
    };

/**
 * A string that is safe to be a label, and nothing else.
 *
 * The two shapes refused here are the ones a secret takes: a long run of hex
 * (a private key, an address, a signature, a hash) and a run of words (a
 * mnemonic). Neither can be a token symbol or a route, so refusing them costs
 * nothing and closes the only hole an allowlist of keys leaves open — a caller
 * putting the wrong variable into the right field.
 */
const label = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }

    const trimmed = value.trim();

    if (trimmed === '' || trimmed.length > max) {
        return undefined;
    }

    if (/[0-9a-fA-F]{32,}/.test(trimmed)) {
        return undefined;
    }

    return (trimmed.match(/[a-zA-Z]{3,}/g)?.length ?? 0) >= 6
        ? undefined
        : trimmed;
};

const bounded = (
    value: unknown,
    min: number,
    max: number,
    integer: boolean,
): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }

    const clamped = Math.min(max, Math.max(min, value));

    return integer ? Math.round(clamped) : Number(clamped.toFixed(6));
};

/**
 * Reduce a property bag to what may leave this device.
 *
 * Unknown keys are dropped rather than rejected: a call site that hands over
 * one extra field should lose the field, not the event.
 */
export const sanitizeProperties = (
    properties: AnalyticsProperties = {},
): Record<string, string | number | boolean> => {
    const clean: Record<string, string | number | boolean> = {};

    for (const [key, shape] of Object.entries(ANALYTICS_PROPERTY_SHAPES)) {
        const value = (properties as Record<string, unknown>)[key];

        if (value === undefined || value === null) {
            continue;
        }

        let cleaned: string | number | boolean | undefined;

        switch (shape) {
            case 'flag':
                cleaned = typeof value === 'boolean' ? value : undefined;
                break;
            case 'count':
                cleaned = bounded(value, 0, 1_000_000, true);
                break;
            case 'ms':
                cleaned = bounded(value, 0, 3_600_000, true);
                break;
            case 'usd':
                cleaned = bounded(value, 0, 1_000_000_000, false);
                break;
            case 'ratio':
                cleaned = bounded(value, -100, 100, false);
                break;
            case 'error':
                cleaned = ANALYTICS_ERROR_CODES.includes(
                    value as AnalyticsErrorCode,
                )
                    ? (value as string)
                    : 'unknown';
                break;
            case 'route':
                cleaned = label(value, 64);
                break;
            default:
                cleaned = label(value, 32);
        }

        if (cleaned !== undefined) {
            clean[key] = cleaned;
        }
    }

    return clean;
};

export const isMeaningful = (event: AnalyticsEventName): boolean =>
    MEANINGFUL_EVENTS.includes(event);
