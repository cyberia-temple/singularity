<?php

return [
    'enabled' => (bool) env('ARENA_ENABLED', false),
    // The season /arena shows and the runner advances. Read from its own
    // variable since Hatcher Cup: production still carries ARENA_SEASON
    // pointing at the archived free pilot.
    'slug' => env('ARENA_CURRENT_SEASON', 'hatcher-cup'),
    'days' => 14,
    'initial_cash_micros' => '1000000000',
    'fee_bps' => 10,
    'slippage_bps' => 5,
    'gas_micros' => '20000',
    'rounds_per_day' => 4,
    /*
     * The reference market a new season freezes into its rules. Each entry
     * overrides the cash, cost and lot figures above; `lot` is how many whole
     * asset tokens one paper "unit" is, so a token worth a fraction of a cent
     * still prices with six significant digits.
     */
    'market' => env('ARENA_MARKET', 'base-weth-usdc'),
    'markets' => [
        'base-weth-usdc' => ['name' => 'WETH / USDC', 'cash' => 'USDC', 'asset' => 'WETH', 'lot' => 1],
        'solana-hatcher-sol' => [
            'name' => 'HATCHER / SOL', 'cash' => 'SOL', 'asset' => 'HATCHER', 'lot' => 1000000,
            'initial_cash_micros' => '10000000', 'fee_bps' => 25, 'slippage_bps' => 50, 'gas_micros' => '5000',
        ],
    ],
    /*
     * The tokens a multi-token season lets its agents trade, priced in USD
     * from DexScreener's deepest pool per mint. Cash is paper USD.
     */
    // No fixed list: an agent may trade any Solana mint with a pool above the
    // liquidity floor. These are always on the board (the benchmark and the
    // partner's token); DexScreener's most promoted mints fill the rest.
    'anchors' => [
        ['symbol' => 'SOL', 'mint' => 'So11111111111111111111111111111111111111112'],
        // Wormhole-wrapped BTC and ETH: the deepest Solana pools for either.
        ['symbol' => 'BTC', 'mint' => '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh'],
        ['symbol' => 'ETH', 'mint' => '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs'],
        ['symbol' => 'CYBER.sol', 'mint' => 'E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump'],
        ['symbol' => 'HATCHER', 'mint' => 'Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump'],
        // Robinhood Chain tokens are keyed `robinhood:<lowercase address>`.
        ['symbol' => 'EQUI', 'mint' => 'robinhood:0x9d783133a3ff9ba27fa1605547368cf9a316341e'],
        ['symbol' => 'LAIN', 'mint' => 'robinhood:0x2b79a071a75dd40f1aca68146d7978204efd156a'],
    ],
    'candidates' => 12,
    'multi' => [
        'initial_cash_usd' => '1000',
        'fee_bps' => 30,
        'slippage_bps' => 50,
        'min_liquidity_usd' => 5000,
        'max_quote_age_seconds' => 300,
    ],
    /*
     * A partner whose brand and token a season carries. The slug must exist in
     * `resources/js/lib/growthCampaigns.ts`, which holds the logo and links.
     */
    'partner' => env('ARENA_PARTNER'),
    'partners' => [
        'hatcher' => [
            'title' => 'Paper Cup',
            'name' => 'HatcherLabs',
            'website' => 'https://hatcher.host/',
            'x' => 'https://x.com/HatcherLabs',
            'telegram' => 'https://t.me/HatcherLabs',
            'chart' => 'https://dexscreener.com/solana/CGH49JQDQSh7U8nQrDhutEV4QB3h1NxsJoe7ho7UtSH3',
        ],
    ],
    'agents' => [
        'lain' => ['name' => 'Lain', 'method' => 'Measured allocation; protect cash when evidence is weak.'],
        'challenger' => ['name' => 'Challenger', 'method' => 'Challenge the position; compare momentum and reversal evidence.'],
    ],
    'automation' => [
        'enabled' => (bool) env('ARENA_AUTOMATION_ENABLED', false),
        'rpc_url' => env('ARENA_MARKET_RPC_URL', 'https://mainnet.base.org'),
        'api_key' => env('ARENA_OPENROUTER_API_KEY'),
        // Hosts a contestant may be named on directly ("groq/<id>"), on the
        // free-tier key config/ai.php already holds. Inference hosts only.
        'direct_providers' => array_values(array_filter(explode(',', (string) env('ARENA_DIRECT_PROVIDERS', 'groq')))),
        'models' => [
            'lain' => env('ARENA_LAIN_MODEL', 'xingchen-agi/xing4.0-29b-a4b:free'),
            'challenger' => env('ARENA_CHALLENGER_MODEL', 'nvidia/nemotron-3.5-super-vl:free'),
        ],
        'pricing_policy' => 'free-only',
        'budget_cents' => 0,
        'reservation_cents_per_call' => 0,
        'max_calls' => 112,
        'max_prompt_bytes' => 12000,
        'max_output_tokens' => 400,
        'max_price_per_million' => 0,
        'timeout_seconds' => 20,
        'opening_window_seconds' => 90,
        'decision_window_seconds' => 180,
        'fill_delay_seconds' => 60,
        'fill_window_seconds' => 180,
        'max_block_age_seconds' => 90,
    ],
];
