<?php

namespace App\Services\Analytics;

/**
 * What may be recorded, what counts as activation, and what a property may
 * contain. One class, because all three are the same decision seen from three
 * sides, and because a definition of "active user" that lives in dashboard SQL
 * is a definition that quietly differs between two dashboards.
 *
 * The event list is a whitelist and the property list is an allowlist. That
 * direction matters: a wallet is one long chain of secrets — a seed phrase, a
 * private key, a vault password, a signing payload — and a denylist of things
 * not to store is a promise that the next feature will break. Here, a property
 * that nobody deliberately allowed simply does not arrive in the database.
 *
 * The TypeScript half of this file is `resources/js/lib/analytics/taxonomy.ts`,
 * and `tests/Frontend/AnalyticsTaxonomyTest.mjs` together with
 * `tests/Feature/Analytics/EventTaxonomyTest.php` pin the two to each other.
 */
class EventTaxonomy
{
    /**
     * Every event this system will store. An unknown name is dropped rather
     * than refused, so a client from an older release keeps reporting the
     * events it does know about instead of having its whole batch rejected.
     *
     * @var array<int, string>
     */
    public const EVENTS = [
        // Application
        'first_open',
        'app_opened',
        'session_started',

        // Onboarding
        'wallet_creation_started',
        'wallet_created',
        'wallet_import_started',
        'wallet_imported',
        'onboarding_completed',

        // Funding and activation
        'wallet_funded',
        // Written by this server only, when a user's first value-moving
        // action settles. A client cannot send it, so no retry can move it.
        'first_transaction',

        // Transactions (send, and token transfers)
        'transaction_started',
        'transaction_signed',
        'transaction_submitted',
        'transaction_confirmed',
        'transaction_failed',

        // Swap and wrap
        'swap_opened',
        'swap_quote_requested',
        'swap_quote_received',
        // A quote that never arrived — no route, or a node that would not
        // price the trade. Kept out of `swap_failed` because it is not a
        // failed swap: nobody signed anything, and folding it into the success
        // rate would make "this pair has no pool" read as "swaps are broken".
        'swap_quote_failed',
        'swap_started',
        'swap_signed',
        'swap_completed',
        'swap_failed',

        // Bridge
        'bridge_opened',
        'bridge_quote_received',
        'bridge_started',
        'bridge_deposit_confirmed',
        'bridge_completed',
        'bridge_failed',

        // Farming, which is what "staking" is in this product
        'staking_opened',
        'staking_started',
        'staking_completed',
        'staking_withdrawn',
        'staking_failed',
        'reward_claimed',

        // Liquidity — the DEX pages and, since the wallet grew its own pool
        // screen, the wallet. One event either way: what is worth counting is
        // that somebody put a two-sided position on, not which surface they
        // signed it from.
        'liquidity_added',
        'liquidity_removed',

        // NFT
        'nft_mint_started',
        'nft_minted',
        'nft_mint_failed',

        // Sponsored fees
        'gas_sponsorship_requested',
        'gas_sponsorship_completed',
        'gas_sponsorship_failed',
    ];

    /**
     * The definition of a meaningful action, and therefore of activation and
     * of "active user" — the only copy of it on this side.
     *
     * Every entry is something that settled on a chain. Opening a screen is
     * not here, a quote is not here, and neither is a broadcast: this codebase
     * says "broadcast is not settlement" in the send screen itself, and a
     * metric that disagreed with the product would be the one that is wrong.
     *
     * @var array<int, string>
     */
    public const MEANINGFUL = [
        'transaction_confirmed',
        'swap_completed',
        'bridge_completed',
        'staking_completed',
        'staking_withdrawn',
        'reward_claimed',
        'liquidity_added',
        'liquidity_removed',
        'nft_minted',
    ];

    /**
     * Events that stamp `first_transaction_at` — the subset of meaningful
     * actions that actually moved value on a chain the user paid for. A
     * liquidity event from the site counts; there is no argument for excluding
     * it beyond tidiness, and it is a transaction.
     *
     * Identical to MEANINGFUL today, and separate anyway: "the first thing
     * they did" and "what keeps them counted as active" are two questions, and
     * the day one of them changes the other must not follow silently.
     *
     * @var array<int, string>
     */
    public const TRANSACTIONAL = self::MEANINGFUL;

    /**
     * Whether one recorded event counts as a meaningful action.
     *
     * The one conditional in the definition, and it is here rather than in a
     * query: a chain whose adapter cannot watch for a receipt (a user-added
     * network, a Bitcoin fork with no Esplora endpoint) never produces a
     * `transaction_confirmed`, and refusing to count its users as active would
     * be an artefact of our instrumentation rather than a fact about them. The
     * client marks those transfers `watchable: false` at the moment it gives
     * up watching.
     *
     * @param  array<string, mixed>  $properties
     */
    public static function isMeaningful(string $event, array $properties = []): bool
    {
        if (in_array($event, self::MEANINGFUL, true)) {
            return true;
        }

        return $event === 'transaction_submitted'
            && ($properties['watchable'] ?? true) === false;
    }

    /**
     * Events that could not have happened without an open vault.
     *
     * Onboarding is the one milestone the client can only report *forwards*:
     * `wallet_created` fires while a phrase is being sealed, so an
     * installation that already had a wallet when this instrumentation shipped
     * never emits it and never will. Its funnel then shows a person who funded
     * and swapped without ever having a wallet, and `wallets` — the
     * denominator of the funding rate — stays at zero while the steps after it
     * fill up.
     *
     * These are the events that settle the question in retrospect. Every one
     * of them requires a key this wallet holds: signing, receiving into a
     * derived address, asking for a drip to one. Opening a screen is not here,
     * because a screen opens for a visitor who has nothing.
     *
     * @var array<int, string>
     */
    public const PROVES_WALLET = [
        'wallet_funded',
        'first_transaction',
        'transaction_started',
        'transaction_signed',
        'transaction_submitted',
        'transaction_confirmed',
        'transaction_failed',
        'swap_started',
        'swap_signed',
        'swap_completed',
        'swap_failed',
        'bridge_started',
        'bridge_deposit_confirmed',
        'bridge_completed',
        'bridge_failed',
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
    ];

    /**
     * Whether this event is proof that a vault existed by the time it happened.
     *
     * Used to repair `wallet_created_at` rather than to set it honestly: the
     * origin recorded alongside is `existing`, never `created`, because the
     * only thing established here is that the wallet was already there.
     */
    public static function provesWallet(string $event): bool
    {
        return in_array($event, self::PROVES_WALLET, true);
    }

    /** Whether this event is one whose settlement counts as a transaction. */
    public static function isTransactional(string $event, array $properties = []): bool
    {
        return in_array($event, self::TRANSACTIONAL, true)
            || ($event === 'transaction_submitted' && ($properties['watchable'] ?? true) === false);
    }

    public static function isKnown(string $event): bool
    {
        return in_array($event, self::EVENTS, true);
    }

    /**
     * Product funnels, named once so the dashboard and the documentation
     * cannot drift apart. Each is an ordered list of events; conversion is
     * measured in distinct users, never in event counts, because one user
     * requesting six quotes is one user who wanted a quote.
     *
     * @var array<string, array<int, string>>
     */
    public const FUNNELS = [
        'swap' => [
            'swap_opened',
            'swap_quote_received',
            'swap_started',
            'swap_signed',
            'swap_completed',
        ],
        'bridge' => [
            'bridge_opened',
            'bridge_quote_received',
            'bridge_started',
            'bridge_deposit_confirmed',
            'bridge_completed',
        ],
        'transaction' => [
            'transaction_started',
            'transaction_signed',
            'transaction_submitted',
            'transaction_confirmed',
        ],
        'staking' => [
            'staking_opened',
            'staking_started',
            'staking_completed',
        ],
        'gas' => [
            'gas_sponsorship_requested',
            'gas_sponsorship_completed',
        ],
    ];

    /**
     * Success/failure pairs, for success rates and the error report. The
     * denominator is "attempts that reached the chain", so it starts at the
     * point the user signed — a quote nobody acted on is not a failure.
     *
     * @var array<string, array{attempt: string, success: string, failure: string}>
     */
    public const OUTCOMES = [
        'transaction' => [
            'attempt' => 'transaction_submitted',
            'success' => 'transaction_confirmed',
            'failure' => 'transaction_failed',
        ],
        'swap' => [
            'attempt' => 'swap_signed',
            'success' => 'swap_completed',
            'failure' => 'swap_failed',
        ],
        'bridge' => [
            'attempt' => 'bridge_deposit_confirmed',
            'success' => 'bridge_completed',
            'failure' => 'bridge_failed',
        ],
        'staking' => [
            'attempt' => 'staking_started',
            'success' => 'staking_completed',
            'failure' => 'staking_failed',
        ],
        'nft' => [
            'attempt' => 'nft_mint_started',
            'success' => 'nft_minted',
            'failure' => 'nft_mint_failed',
        ],
        'gas' => [
            'attempt' => 'gas_sponsorship_requested',
            'success' => 'gas_sponsorship_completed',
            'failure' => 'gas_sponsorship_failed',
        ],
    ];

    /**
     * Everything that is a failure, for the error report — the outcome
     * failures above plus the ones that happen before anyone signs, which
     * belong in an error breakdown and nowhere near a success rate.
     *
     * @var array<int, string>
     */
    public const FAILURES = [
        'transaction_failed',
        'swap_failed',
        'swap_quote_failed',
        'bridge_failed',
        'staking_failed',
        'nft_mint_failed',
        'gas_sponsorship_failed',
    ];

    /**
     * Property keys that may be stored, and what shape each one has.
     *
     * `enum` values are matched against a fixed list; `slug` is a short opaque
     * label; `usd` and `ratio` are numbers; `count` and `ms` are integers;
     * `flag` is a boolean. Anything not named here is dropped before the row
     * is written.
     *
     * @var array<string, string>
     */
    public const PROPERTIES = [
        // Where it happened
        'chain' => 'slug',
        'from_chain' => 'slug',
        'to_chain' => 'slug',
        'section' => 'slug',

        // What moved. Symbols only — never contract addresses, which would
        // make the event stream a per-user portfolio.
        'asset' => 'slug',
        'token_in' => 'slug',
        'token_out' => 'slug',
        'token_type' => 'enum:coin,token',
        'transaction_type' => 'enum:send,token_transfer,swap,wrap,bridge,stake,unstake,claim,mint,liquidity',

        // How much it was worth, and what it cost. USD rather than units:
        // a number that is comparable across assets is the only kind a
        // dashboard can add up, and it is coarser than a balance.
        'amount_usd' => 'usd',
        'fee_usd' => 'usd',
        'gas_usd' => 'usd',

        // How the trade was priced
        'price_impact' => 'ratio',
        'slippage' => 'ratio',
        'route' => 'route',
        'hops' => 'count',
        'tier' => 'enum:slow,normal,fast',

        // How it went
        'duration_ms' => 'ms',
        'error_code' => 'error',
        'watchable' => 'flag',
        'sponsored' => 'flag',
        'verified' => 'flag',
        // `auto` is the vault a first launch writes for somebody who has not
        // asked for anything yet; it is deliberately not a kind of `created`,
        // or the funnel would report every visitor as converting.
        'origin' => 'enum:created,imported,auto',
        'grounds' => 'enum:tokens,nft,account,open',
        'pid' => 'count',
        'pool_kind' => 'enum:pair,solo',
    ];

    /**
     * The normalised failure vocabulary. Raw error messages are never stored:
     * they carry addresses, amounts and node URLs, and they are unaggregatable
     * — the same failure reads six ways across six RPC providers.
     *
     * The second half is `GasSponsorService`'s own refusal vocabulary, reused
     * verbatim rather than remapped, so a sponsorship failure reads the same
     * on the dashboard as it does in the wallet and in the server log.
     *
     * @var array<int, string>
     */
    public const ERROR_CODES = [
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

        // GasSponsorService vocabulary
        'hasGas',
        'holdsNothing',
        'coolingDown',
        'dailyCap',
        'empty',
        'quota',
        'unreadable',
        'paused',
        'disabled',
    ];

    /**
     * Reduce a submitted property bag to what may be stored.
     *
     * @param  array<string, mixed>  $properties
     * @return array<string, mixed>
     */
    public static function sanitize(array $properties): array
    {
        $clean = [];

        foreach (self::PROPERTIES as $key => $shape) {
            if (! array_key_exists($key, $properties)) {
                continue;
            }

            $value = self::coerce($shape, $properties[$key]);

            if ($value !== null) {
                $clean[$key] = $value;
            }
        }

        return $clean;
    }

    private static function coerce(string $shape, mixed $value): mixed
    {
        if (str_starts_with($shape, 'enum:')) {
            $allowed = explode(',', substr($shape, 5));

            return is_string($value) && in_array($value, $allowed, true) ? $value : null;
        }

        return match ($shape) {
            'flag' => is_bool($value) ? $value : null,
            'count' => self::integer($value, 0, 1_000_000),
            'ms' => self::integer($value, 0, 3_600_000),
            'usd' => self::number($value, 0, 1_000_000_000),
            'ratio' => self::number($value, -100, 100),
            'error' => is_string($value) && in_array($value, self::ERROR_CODES, true) ? $value : null,
            'slug' => self::text($value, 32),
            'route' => self::text($value, 64),
            default => null,
        };
    }

    private static function integer(mixed $value, int $min, int $max): ?int
    {
        if (is_string($value) && ctype_digit($value)) {
            $value = (int) $value;
        }

        if (! is_int($value) && ! is_float($value)) {
            return null;
        }

        if (is_float($value) && (is_nan($value) || is_infinite($value))) {
            return null;
        }

        // Rounded rather than truncated, because the browser half rounds — two
        // implementations of one allowlist that disagree by a unit are two
        // implementations that will disagree by more later.
        return (int) max($min, min($max, (int) round((float) $value)));
    }

    private static function number(mixed $value, float $min, float $max): ?float
    {
        if (! is_int($value) && ! is_float($value)) {
            return null;
        }

        $number = (float) $value;

        if (is_nan($number) || is_infinite($number)) {
            return null;
        }

        return round(max($min, min($max, $number)), 6);
    }

    /**
     * A short opaque label, and the last line of defence.
     *
     * Even inside the allowlist a string field is a hole somebody could pour a
     * secret into — a "route" of 64 characters is a private key with room to
     * spare. So two shapes are refused outright wherever a label is expected:
     * a long run of hex (keys, addresses, signatures, hashes) and a run of
     * words (a mnemonic). Neither has any business in a token symbol.
     */
    private static function text(mixed $value, int $max): ?string
    {
        if (! is_string($value)) {
            return null;
        }

        $trimmed = trim($value);

        if ($trimmed === '' || mb_strlen($trimmed) > $max) {
            return null;
        }

        // 32+ hex characters in a row: no symbol, chain id or route contains
        // one, and every wallet secret does.
        if (preg_match('/[0-9a-fA-F]{32,}/', $trimmed) === 1) {
            return null;
        }

        // Six or more words: a symbol is one word and a route is arrows.
        if (preg_match_all('/[a-zA-Z]{3,}/', $trimmed) >= 6) {
            return null;
        }

        return $trimmed;
    }
}
