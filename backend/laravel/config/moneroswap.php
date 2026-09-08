<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Swapping Monero
    |--------------------------------------------------------------------------
    |
    | Monero is the one asset in this wallet that no aggregator routes and no
    | pool holds. It has no EVM side to sign with, no bridge contract anybody
    | can audit into existence, and every router in `config/crosschain.php`
    | refuses it — privacy is exactly what makes an automated route hard.
    |
    | So there are two ways to move it, they are genuinely different bargains,
    | and this app quotes BOTH and lets the person choose:
    |
    |   - **ours.** Real XMR arrives at a deposit address this project controls
    |     and a wrapper is minted on Cyberia, where the DEX takes over. It is
    |     custodial for the length of one deposit, the fee is ours, and the
    |     wrapper it produces is liquidity on our own pools — which is the
    |     whole reason to want it.
    |   - **a partner exchanger.** An instant exchanger swaps XMR for whatever
    |     the user asked for and never touches this host. No custody here, no
    |     Monero node here, and a spread we do not set.
    |
    | Neither is presented as the safe one. Both are quoted, the better rate is
    | marked, and the trade-off is stated in the user's own terms — because a
    | comparison that hides the loser is an advert.
    |
    */

    /** Off means the screen says so; it never means a swap fails halfway. */
    'enabled' => (bool) env('MONEROSWAP_ENABLED', true),

    /*
    |--------------------------------------------------------------------------
    | Cyberia's own fee
    |--------------------------------------------------------------------------
    |
    | Taken on both routes, and taken differently on each, because the two
    | routes hand us different things to take it out of:
    |
    |   - on our own route the deposit lands in our wallet, so the fee is
    |     withheld from the amount that gets wrapped — one number, ours;
    |   - on a partner route nothing lands here at all, so the fee is the
    |     exchanger's own affiliate share, asked for in the quote and paid by
    |     them. What is displayed is always what came back in the quote: a
    |     partner may cap it, round it, or refuse it, and a fee nobody actually
    |     collects must not appear on a screen as though somebody did.
    |
    */

    'fee' => [
        /** Basis points of the input. 75 = 0.75%, matching the cross-chain swaps. */
        'bps' => (int) env('MONEROSWAP_FEE_BPS', 75),

        /**
         * The ceiling this app will ever ask for, whatever the environment says.
         * An env typo is the realistic way somebody gets charged 30% of a swap.
         */
        'max_bps' => 300,
    ],

    /*
    |--------------------------------------------------------------------------
    | Our own route
    |--------------------------------------------------------------------------
    |
    | The terms come from `config/bridge.php` — the corridor, the deposit
    | address, the confirmations, the wrapper — because there is exactly one
    | Monero bridge and this is a second opinion about it, not a second one.
    | What lives here is only what the *swap screen* needs to say out loud.
    |
    */

    'ours' => [
        /**
         * Minimum deposit. Below it the Monero network fee and ten
         * confirmations of waiting cost more than the swap is worth, and a
         * dust deposit is a support ticket rather than a trade.
         */
        'minimum_xmr' => env('MONEROSWAP_MIN_XMR', '0.05'),

        /**
         * Roughly how long the whole thing takes, in minutes, said honestly:
         * ten Monero confirmations at two minutes a block, plus the swap.
         */
        'minutes' => (int) env('MONEROSWAP_MINUTES', 25),
    ],

    /*
    |--------------------------------------------------------------------------
    | Partner exchangers
    |--------------------------------------------------------------------------
    |
    | Trocador is the default because it aggregates the exchangers that
    | actually hold Monero, quotes without an account, and carries an affiliate
    | share in the quote itself — the same property that made Relay the
    | cross-chain router. It is off until it has a key: a partner route drawn
    | on screen that nobody can execute is worse than one absent route.
    |
    | Nothing here is Trocador-shaped beyond this block and the adapter, so a
    | second exchanger is a config entry and a mapping, not a redesign.
    |
    */

    'partner' => [
        'enabled' => (bool) env('MONEROSWAP_PARTNER_ENABLED', false),
        'name' => (string) env('MONEROSWAP_PARTNER_NAME', 'Trocador'),
        'api' => (string) env('MONEROSWAP_PARTNER_API', 'https://api.trocador.app'),

        /** Server-side only. A key in a bundle is a key anyone may spend. */
        'api_key' => (string) env('MONEROSWAP_PARTNER_API_KEY', ''),

        /** How this app identifies itself for the affiliate share. */
        'referral' => (string) env('MONEROSWAP_PARTNER_REFERRAL', ''),

        'timeout' => (int) env('MONEROSWAP_PARTNER_TIMEOUT', 20),
    ],

    /** A quote is a price with a clock on it and is never cached. Catalogues are. */
    'cache_seconds' => (int) env('MONEROSWAP_CACHE_SECONDS', 600),

];
