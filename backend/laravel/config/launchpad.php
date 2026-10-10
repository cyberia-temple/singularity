<?php

return [
    'sites_domain' => env('LAUNCHPAD_SITES_DOMAIN', 'cyberia.church'),

    /*
     * Chains a token can be launched on. One launch may target several of
     * them; every deployment gets its own metadata row keyed by
     * (chain_id, address). The browser-side contract addresses live in
     * resources/js/lib/launchpadChains.ts — keep the two lists in sync.
     */
    'default_chain_id' => (int) env('LAUNCHPAD_DEFAULT_CHAIN_ID', 49406),

    'chains' => [
        49406 => 'Cyberia',
        4663 => 'Robinhood Chain',
    ],

    /*
     * `launchpad:watch` — what happens when a token is launched.
     *
     * Every launch opens a DAO voted in that token, lands in the wallet's feed
     * and is pushed to everyone, whichever screen (or script) launched it: the
     * launchpads are read directly, so a launch with no metadata signed is
     * seen exactly like one with a page and a logo. Cyberia only, because a
     * DAO's votes are weighed against Cyberia's RPC (TokenSnapshotService) and
     * no other chain runs a launchpad yet.
     *
     * `contracts` mirrors resources/js/lib/launchpadChains.ts — LaunchpadNative
     * and LaunchpadV3 both keep an `allTokens` array, which is what is walked.
     * `announce_within_minutes` is how old a launch may be and still be pushed:
     * a first run, or one after a long outage, opens DAOs for everything it
     * has not seen but does not wake anybody up for last month's launches.
     */
    'watch' => [
        'chain_id' => 49406,
        'rpc_url' => env('LAUNCHPAD_RPC_URL', env('CYBERIA_RPC_URL', 'https://rpc.cyberia.church')),
        'explorer_api' => env('LAUNCHPAD_EXPLORER_API', 'https://explorer.cyberia.church/api/v2'),
        'contracts' => array_values(array_filter([
            env('LAUNCHPAD_NATIVE_ADDRESS', '0x8034E6C09E0cEA00B5D692ADfD1A136fab339165'),
            env('LAUNCHPAD_V3_ADDRESS', '0x6970481a167D8D44527091d0E319e50aD3F79Ee3'),
        ])),
        'announce_within_minutes' => (int) env('LAUNCHPAD_ANNOUNCE_WITHIN_MINUTES', 60),
    ],

    'reserved_subdomains' => [
        'admin',
        'api',
        'app',
        'assets',
        'blog',
        'bridge',
        'cdn',
        'docs',
        'explorer',
        'ftp',
        'ipfs',
        'mail',
        'mx',
        'node',
        'ns1',
        'ns2',
        'rpc',
        'static',
        'status',
        'swap',
        'www',
    ],
];
