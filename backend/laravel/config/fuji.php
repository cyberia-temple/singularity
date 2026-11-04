<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Cyberia Fuji faucet
    |--------------------------------------------------------------------------
    |
    | Test CYBER for anyone building on the Fuji L1 (49407), handed out from
    | its own hot wallet. The chain itself (RPC, id, coin) is described once,
    | in config/bridge.php under chains.cyberia_fuji, and read from there.
    |
    | Fees on this chain cost what an Ethereum mainnet transfer costs, counted
    | in CYBER (minBaseFee 7.2e15 wei: a plain transfer is ~151 CYBER), so the
    | drip is sized in transactions, not in coins: 10,000 CYBER is about sixty
    | transfers or one contract deployment.
    |
    */

    /**
     * The DAO treasury on 49407: the protocol's 2-of-3 Safe. RewardManager
     * sends every fee here; the page names it only while the chain says so.
     */
    'treasury' => (string) env('FUJI_DAO_TREASURY', '0x96cd117786EBC0fDbef56a6559FEB2bd2BaE3393'),

    /*
    |--------------------------------------------------------------------------
    | The chain panel (wallet → Settings → Cyberia Fuji)
    |--------------------------------------------------------------------------
    |
    | What the panel reads besides the precompiles themselves: the validator
    | whose P-Chain balance keeps the L1 alive, the addresses that must not run
    | dry, and the market prices behind "fees like an Ethereum transfer".
    |
    */

    'chain' => [

        /** The L1 validator; its balance pays the P-Chain fee by the second. */
        'validation_id' => (string) env('FUJI_VALIDATION_ID', '2KZnTnX6QqZ1WNAFd7BCp9cKgXWYd3MXoj1zpccdSfVG14ULLJ'),
        'pchain_rpc_url' => (string) env('FUJI_PCHAIN_RPC_URL', 'https://api.avax-test.network/ext/bc/P'),

        /** Address shown as chain admin; actual permissions are read from the precompiles. */
        'operator' => (string) env('FUJI_OPERATOR_ADDRESS', '0x472725293D97dFf80eA34C22840872832Edbe8DC'),

        /** Pays Teleporter deliveries on the L1. */
        'icm_relayer' => (string) env('FUJI_ICM_RELAYER_ADDRESS', '0xEc2D561301e9A9cfd07DAB3524Aa6be6a5988480'),

        /** Who NativeMinter lets mint CYBER: the ICTT NativeTokenRemote only. */
        'native_minters' => ['0x386F2a822653F4Af8a35774d3FBE80Bf87AdC71f'],

        /** Mainnet gas price for the "same fee as Ethereum" reference. */
        'ethereum_rpc_url' => (string) env('FUJI_ETHEREUM_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
    ],

    'faucet' => [

        /** Off means the page says the faucet is closed, not that it errors. */
        'enabled' => (bool) env('FUJI_FAUCET_ENABLED', true),

        /**
         * The faucet's own EOA, holding only what it gives away.
         *
         * Never the bridge relayer's key: that address pays bridge payouts on
         * the same chain, and two senders on one nonce sequence lose races.
         */
        'private_key' => (string) env('FUJI_FAUCET_PRIVATE_KEY', ''),

        /** Whole CYBER per drip. */
        'drip_cyber' => (string) env('FUJI_FAUCET_DRIP_CYBER', '10000'),

        /** One drip per address per this many hours. */
        'cooldown_hours' => (int) env('FUJI_FAUCET_COOLDOWN_HOURS', 24),

        /**
         * Quotas over the last 24 hours, counted from `fuji_faucet_claims`
         * rather than the cache, so flushing the cache hands nobody a fresh
         * allowance.
         */
        'daily_per_ip' => (int) env('FUJI_FAUCET_DAILY_PER_IP', 3),
        'daily_total' => (int) env('FUJI_FAUCET_DAILY_TOTAL', 20),
    ],

];
