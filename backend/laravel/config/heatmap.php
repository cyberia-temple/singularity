<?php

/*
| The market map (`/heatmap`): two treemaps, sized by market cap and coloured
| by the day's move — the crypto market by sector, and Cyberia's own tokens.
*/
return [

    'crypto' => [
        // How many of the largest coins are drawn, after exclusions.
        'limit' => (int) env('HEATMAP_CRYPTO_LIMIT', 120),

        /*
         * CoinGecko categories, first match wins. A coin is drawn in the first
         * sector it belongs to, so the narrow ones (memes, AI) come before the
         * wide ones (L1) — DOGE is a meme before it is a chain.
         */
        'sectors' => [
            'meme-token' => 'Memes',
            'artificial-intelligence' => 'AI',
            'layer-2' => 'L2',
            'decentralized-finance-defi' => 'DeFi',
            'exchange-based-tokens' => 'Exchange tokens',
            'layer-1' => 'L1',
        ],

        // Not markets of their own: a dollar, a receipt for a coin, a staked coin.
        'exclude' => ['stablecoins', 'wrapped-tokens', 'liquid-staking-tokens', 'bridged-tokens'],

        // Category membership changes slowly and costs a call each.
        'categories_per_run' => 3,
    ],

    'cyberia' => [
        'rpc_url' => env('HEATMAP_RPC_URL', env('CYBERIA_RPC_URL', 'https://rpc.cyberia.church')),

        'launchpads' => [
            'v2' => env('LAUNCHPAD_NATIVE_ADDRESS', '0x8034E6C09E0cEA00B5D692ADfD1A136fab339165'),
            'v3' => env('LAUNCHPAD_V3_ADDRESS', '0x6970481a167D8D44527091d0E319e50aD3F79Ee3'),
        ],

        // Cyberia's service tokens (crypto/hardhat/deployments/cyberia-service-tokens.json).
        'service_tokens' => [
            '0x8bb022060e4946b9498d11f3e87666dc7129ccbc', // NFT
            '0xba6bdda1988e72e796032c1cebfc4192ac5a8497', // LEND
            '0x0a2d855d70728fea342c338f3668b91ecc330cb5', // PRED
            '0x9ba523b368fd338d45594616b4515f6d421b21d2', // FARM
            '0x0f5cee1f315a84e109b5817839b5474e0ca7431d', // STAKE
            '0xe17f466e3501d80650f955c66a8ad4336bfd17c8', // LAUNCH
            '0x82708a8d873ca89f9f341307cca949a4a5a240f3', // BRIDGE
            '0xbf763e079584a35d19968fd5e2d528087d9bc3fe', // WALLET
            '0xdb003b50dd2f5e9dcd1d177ca07d85cf3e3c6b48', // CLOUD
            '0xdd390535a353317625bcd8c27582abcc5e151186', // INFER
            '0x28084a351a87f20219ef04e596b6d3b84dd0afd3', // IPFS
            '0x7d01915b2ef0c5931f2520b7fa2523d1bd6b0cb5', // SEED
            '0xde99a012a910419736e4c33228df6972fbcf0e72', // SCAN
            '0x7911085dc26825349b0ce2518b72d49ff4a26ee8', // GAS
        ],

        // Services launched before that list existed, recognised by ticker.
        'service_symbols' => ['CVPN', 'IRC', 'DNS', 'SMTP', 'LAIN'],

        /*
         * The two tokens that trade outside Cyberia, read from DexScreener's
         * own market cap and 24h change: CYBER.sol on Solana, LAIN on Robinhood.
         */
        'external' => [
            ['symbol' => 'CYBER.sol', 'name' => 'CYBER on Solana', 'chain' => 'solana', 'address' => 'E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump'],
            ['symbol' => 'LAIN', 'name' => 'Lain-OS.com on Robinhood Chain', 'chain' => 'robinhood', 'address' => '0x2b79A071a75dd40f1aca68146d7978204eFD156A'],
        ],

        // Snapshots older than this are deleted; the 24h change needs one day.
        'keep_hours' => 72,
    ],
];
