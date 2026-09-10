<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Cross-chain swaps
    |--------------------------------------------------------------------------
    |
    | A swap inside the wallet trades on Cyberia's own pools. This is the other
    | question — "I hold ETH on Base and want SOL" — and Cyberia has no answer
    | of its own to it: there is no pool here holding both sides, and building
    | one would mean owning inventory on every chain a user might name.
    |
    | So the wallet asks somebody who already does. A router quotes the whole
    | route, takes the deposit on the source chain and delivers on the
    | destination; this app writes down what it will cost, adds Cyberia's own
    | fee to the request, and never touches the money. It holds no key here,
    | signs nothing, and the transaction the user signs is the router's own.
    |
    | Relay (https://relay.link) is the router because of the fee: its app fee
    | is a field in the quote request, paid to an address we name, and needs no
    | account anywhere. The obvious alternative, LI.FI, answers a quote that
    | carries a fee with `Integrator "cyberia" is not configured for collecting
    | fees` until somebody registers a wallet in its portal — a fee that
    | depends on a dashboard nobody on this host can see is a fee that quietly
    | stops arriving. Nothing here is Relay-shaped beyond `CrosschainRouter`,
    | so a second router is that class and a config key, not a redesign.
    |
    */

    /** Off means the wallet says cross-chain swaps are unavailable, not that they fail. */
    'enabled' => (bool) env('CROSSCHAIN_ENABLED', true),

    'api' => (string) env('CROSSCHAIN_API', 'https://api.relay.link'),

    /** Seconds any one call to the router may take before it is a failure. */
    'timeout' => (int) env('CROSSCHAIN_TIMEOUT', 20),

    /**
     * Who is asking, as the router records it. Not a credential and not a
     * fee: it is how this app shows up in the router's own analytics.
     *
     * Read by nothing at the moment. Relay put referrer attribution behind an
     * API key and now answers a quote carrying one with `UNAUTHORIZED_QUOTE`,
     * so `CrosschainRouter::quote()` stopped sending it — see the note there.
     * The value is kept because the name is still ours to claim the day this
     * host has a key.
     */
    'referrer' => (string) env('CROSSCHAIN_REFERRER', 'cyberia.church'),

    /*
    |--------------------------------------------------------------------------
    | Cyberia's fee
    |--------------------------------------------------------------------------
    |
    | Taken out of the input, on the source chain, by the router — which is
    | the only place it can be taken without this host holding a key on every
    | chain in the list. Two halves, and both must be present for a fee to
    | exist at all: an address to pay it to and a size. No address means no fee
    | is asked for, the swaps still work, and every screen says so rather than
    | showing a number nobody collects.
    |
    | `fee_bps` is what this app *asks* for. What the user is shown is always
    | the fee that came back inside the quote, because a router is free to
    | refuse, cap or round it — see CrosschainRouter::quote().
    |
    */

    'fee' => [

        /**
         * Where the fee lands. An ordinary address on the source chain, so it
         * collects in whatever the user was spending — deliberately not the
         * bridge relayer, whose nonces are already contended, and deliberately
         * env-only: an address baked into a config default is an address
         * somebody forgets to change.
         */
        'address' => (string) env('CROSSCHAIN_FEE_ADDRESS', ''),

        /** Basis points of the input amount. 75 = 0.75%. */
        'bps' => (int) env('CROSSCHAIN_FEE_BPS', 75),

        /**
         * The ceiling this app will send, whatever the environment says.
         *
         * A typo in an env file is the realistic way a user gets charged 30%
         * of a transfer, and the quote would show it as calmly as any other
         * number. 300 bps is well above anything defensible here.
         */
        'max_bps' => 300,

        /*
         * Dollars that have to be claimable before the operator is told.
         *
         * The fee does not arrive in a wallet: the router holds it as one
         * off-chain USDC balance against the address above, and it stays there
         * until a person withdraws it — so the realistic way this arrangement
         * fails is not that it stops collecting, but that it collects for a
         * year and nobody knows. `crosschain:fees --alert` is the reminder,
         * and this is the figure below which a reminder is just noise.
         */
        'claim_alert_usd' => (float) env('CROSSCHAIN_FEE_CLAIM_ALERT_USD', 25),
    ],

    /*
    |--------------------------------------------------------------------------
    | Caching
    |--------------------------------------------------------------------------
    |
    | The chain and token lists are the router's catalogue: the same answer for
    | every visitor, so this host asks once. A quote is never cached — it is a
    | price with a deadline attached, and a stale one is a transaction that
    | reverts.
    |
    */

    'cache_seconds' => (int) env('CROSSCHAIN_CACHE_SECONDS', 600),

];
