<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Product analytics for the wallet
    |--------------------------------------------------------------------------
    |
    | Off means the ingest endpoint answers 202 and writes nothing, and the
    | client stops sending. It never means an operation fails: analytics is not
    | a dependency of sending, swapping or bridging, and a wallet whose swap
    | broke because a metrics endpoint was down would be a worse product than
    | one with no metrics at all.
    |
    */

    'enabled' => (bool) env('ANALYTICS_ENABLED', true),

    /*
    | Do Not Track / Global Privacy Control.
    |
    | This is a non-custodial wallet: a person who has said "do not track me"
    | in their browser has said it about exactly this. Honouring it costs us
    | some users in the denominator; ignoring it would make every privacy claim
    | on the onboarding screen a little less true.
    */

    'respect_dnt' => (bool) env('ANALYTICS_RESPECT_DNT', true),

    /*
    | How long a device may be quiet before the next event starts a new session.
    | Thirty minutes is the convention, and the client is the side that applies
    | it — it is the only side that knows the app was idle rather than offline.
    */

    'session_timeout_minutes' => (int) env('ANALYTICS_SESSION_TIMEOUT', 30),

    /*
    |--------------------------------------------------------------------------
    | Web analytics: Umami, on this host
    |--------------------------------------------------------------------------
    |
    | Traffic — visits, pages, sources, countries, devices, funnels, retention,
    | Web Vitals — for everybody who opens a page, wallet or not, which the
    | product tables in this file deliberately do not count. Umami runs beside
    | this app (services/umami) and nothing it collects leaves the host. The
    | website id is fixed because services/umami/bootstrap.sh creates the site
    | under it; lain-os.com and chaos.fm have their own in lain-labs/backend.
    |
    | `password` is the dashboard's admin password, which the bootstrap writes
    | into .env so /crm/stats can sign an operator in. Unset, that page sends
    | them to Umami's own login instead.
    */

    'umami' => [
        'enabled' => (bool) env('UMAMI_ENABLED', true),
        'url' => rtrim((string) env('UMAMI_URL', 'https://stats.cyberia.church'), '/'),
        'internal_url' => rtrim((string) env('UMAMI_INTERNAL_URL', 'http://umami:3000'), '/'),
        'website_id' => (string) env('UMAMI_WEBSITE_ID', '4955f251-c9ac-464b-adce-14c8ea75eaf2'),
        'domains' => (string) env('UMAMI_DOMAINS', 'cyberia.church,www.cyberia.church'),
        'password' => env('UMAMI_ADMIN_PASSWORD'),
    ],

    /*
    | Rows accepted in one ingest call. The client batches to keep the wallet
    | from making one request per tap; this bounds what one request can cost.
    */

    'max_batch' => 20,

    /*
    |--------------------------------------------------------------------------
    | Funding verification
    |--------------------------------------------------------------------------
    |
    | `wallet_funded` is a milestone the client cannot be trusted with alone: a
    | browser can claim it was funded, and a balance that ticks up and down
    | would otherwise re-fire it. So the client reports a *candidate* and this
    | server confirms it by reading the chain, exactly once per user.
    |
    | Only chains readable from here without an API key are listed, and an
    | address is only ever stored for a chain on this list — holding an address
    | we cannot check buys nothing and costs the user a linkage. Etherscan-
    | family networks (BNB, Base) are deliberately absent for that reason; a
    | funding claim from them is recorded as `client` and counted separately.
    |
    */

    'verifiable_chains' => [

        /*
         * The same endpoints the rest of this app reads these chains through,
         * by the same env vars — on prod `BRIDGE_EVM_RPC_URL` points at the
         * internal node, which is the right thing for a server-side balance
         * read and is what GasSponsorService already uses. Deploying this
         * needs no new environment.
         */
        'cyberia' => [
            'type' => 'evm',
            'rpc' => env('ANALYTICS_CYBERIA_RPC')
                ?: env('BRIDGE_EVM_RPC_URL')
                ?: env('CYBERIA_RPC_URL', 'https://rpc.cyberia.church'),
            // The keyless index the gas station reads holdings from.
            'explorer_api' => env('WALLET_GAS_EXPLORER_API', 'https://explorer.cyberia.church/api'),
        ],

        'robinhood' => [
            'type' => 'evm',
            'rpc' => env('ANALYTICS_ROBINHOOD_RPC')
                ?: env('BRIDGE_ROBINHOOD_RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'),
            'explorer_api' => env(
                'ANALYTICS_ROBINHOOD_EXPLORER_API',
                'https://robinhoodchain.blockscout.com/api',
            ),
        ],

        // Read through this app's own relay, because Solana's public cluster
        // refuses a browser but answers this server. See SolanaRpcProxy.
        'solana' => [
            'type' => 'solana',
        ],
    ],

    /*
    | Minutes an address's "is it funded yet" answer is reused. Funding happens
    | once per wallet, so re-reading a chain for the same empty address on
    | every heartbeat would be the endpoint's whole cost.
    */

    'funding_cache_minutes' => (int) env('ANALYTICS_FUNDING_CACHE', 10),

    /*
    | Users the scheduled sweep re-checks per run, and how far back it looks
    | for someone worth re-checking. Bounded so a growing table cannot turn the
    | scheduler into a chain-scanning job.
    */

    'funding_sweep_limit' => (int) env('ANALYTICS_FUNDING_SWEEP_LIMIT', 200),
    'funding_sweep_days' => (int) env('ANALYTICS_FUNDING_SWEEP_DAYS', 14),

    /*
    |--------------------------------------------------------------------------
    | Retention
    |--------------------------------------------------------------------------
    |
    | Day offsets reported as retention buckets, and the window a cohort is
    | measured in. A bucket is reported as null until the youngest member of a
    | cohort has had time to reach it, so "0% D30" never means "too early".
    |
    */

    'retention_buckets' => [1, 7, 30],

    /*
    |--------------------------------------------------------------------------
    | North Star
    |--------------------------------------------------------------------------
    |
    | Weekly Active Funded Users: distinct analytics users who are funded and
    | performed at least one meaningful action in the last N days. Never
    | counted by address — one person with five addresses is one user.
    |
    */

    'north_star_days' => 7,

    /*
    |--------------------------------------------------------------------------
    | Internal traffic
    |--------------------------------------------------------------------------
    |
    | The two people who build this product also use it, and on a chain this
    | young they use it more than anyone: as of this writing 68 of 70 recorded
    | swaps on the site were theirs. Left in, every conversion rate on the
    | console is a self-portrait — it says the funnel converts, because the
    | operator converts every time they test the thing they just deployed.
    |
    | So internal installations and internal sessions are excluded from the
    | product numbers by default. Two rules, because there are two ways an
    | operator is recognisable:
    |
    |   - `wallets` — an address seen on an installation. The two console keys
    |     always count; these are the extras, because a wallet used for testing
    |     is not necessarily the one that opens /crm.
    |   - `user_ids` — accounts on this site, for `site_events`, which has a
    |     user id where the product tables deliberately do not. The console's
    |     own admin ids always count; these are the extras.
    |
    | Excluding is not hiding: every report that drops internal rows also says
    | how many it dropped, and `?internal=1` puts them back. A number that got
    | quietly smaller is the other way a dashboard lies.
    */

    'internal' => [

        /*
         * Only this file's own environment. The console's two operators are
         * merged in by `InternalTraffic`, at use rather than here: config
         * files are loaded alphabetically, `analytics` comes before `crm`, and
         * a `config('crm.…')` call from this file returns an empty array —
         * silently, leaving an exclusion that appears configured and excludes
         * nobody.
         */

        'wallets' => array_values(array_filter(array_map(
            fn (string $address) => strtolower(trim($address)),
            explode(',', (string) env('ANALYTICS_INTERNAL_WALLETS', '')),
        ))),

        'user_ids' => array_values(array_filter(array_map(
            fn (string $id) => (int) trim($id),
            explode(',', (string) env('ANALYTICS_INTERNAL_USER_IDS', '')),
        ))),

    ],

    /*
    |--------------------------------------------------------------------------
    | The bound past which a trade's own notional is not evidence
    |--------------------------------------------------------------------------
    |
    | `amount_usd` is what the input was worth at the quoted price *before* the
    | trade. A swap through a pool too thin to absorb it moves that price so
    | far that the notional describes nothing that happened: the first swap
    | ever recorded here reported $67,548 at 99.98% price impact, which is a
    | dust pool being emptied, not five figures of volume.
    |
    | A trade whose price impact is above this is still a real trade and still
    | counts as an action — it is only its *dollar figure* that is thrown away,
    | and reported separately so the exclusion is visible rather than a total
    | that quietly shrank.
    */

    'notional_max_price_impact' => (float) env('ANALYTICS_NOTIONAL_MAX_IMPACT', 25.0),

];
