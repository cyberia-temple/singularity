<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'extension_analytics' => [
        'measurement_id' => 'G-TNT5C5CBCP',
        'api_secret' => env('GA_EXTENSION_API_SECRET'),
    ],

    'postmark' => [
        'key' => env('POSTMARK_API_KEY'),
    ],

    'resend' => [
        'key' => env('RESEND_API_KEY'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    'ethereum' => [
        'rpc_url' => env('CYBERIA_RPC_URL'),
    ],

    // "Talk to Lain" web chat (LainChatService): a tool-less Lain persona
    // answered straight by OpenRouter — the LainOS daemon is not involved.
    // Without an API key the /lain page renders but chat reports itself off.
    'lain' => [
        'openrouter_api_key' => env('OPENROUTER_API_KEY'),
        // openrouter/free is OpenRouter's $0 router over available free models.
        'model' => env('LAIN_CHAT_MODEL', 'openrouter/free'),
        // Tried when the pinned model errors (free tiers rate-limit upstream).
        'fallback_model' => env('LAIN_CHAT_FALLBACK_MODEL', 'openrouter/free'),
        'timeout_seconds' => (int) env('LAIN_CHAT_TIMEOUT_SECONDS', 90),
        // Holder gate (LainHolderAccessService): the signed-in wallet must
        // hold this share of the live $LAIN supply. 1000 bps = 10%.
        'token_address' => env('LAIN_TOKEN_ADDRESS', '0x05cd1afd5b2df3cca6ceab80cbc21168ec981e8b'),
        'minimum_share_bps' => (int) env('LAIN_MINIMUM_SHARE_BPS', 1000),
        // The lain bot on irc.cyberia.church (services/irc/lain-bot) and this
        // app share this token; unset = /api/irc/lain answers 404.
        'irc_token' => env('IRC_LAIN_TOKEN'),
    ],

    // The LainOS daemon itself (services/lainos), which is a different
    // correspondent from the persona above: it has tools, memory and a
    // wallet. It listens on the host's loopback, so the URL is only ever
    // reachable from this machine — unset means the console's room falls back
    // to the tool-less persona and says which one answered.
    'lainos' => [
        'url' => env('LAINOS_HTTP_URL'),
        'timeout_seconds' => (int) env('LAINOS_HTTP_TIMEOUT', 60),
        // The room id the daemon files this conversation under, so the
        // console's room is not mixed into Telegram's or the game's.
        'room' => env('LAINOS_CONSOLE_ROOM', 'cyberia-console'),
    ],

    'cyberia' => [
        'explorer_url' => env('CYBERIA_EXPLORER_URL', 'https://explorer.cyberia.church'),
        // Analytics token-price walker (AnalyticsController). $1-pegged anchor
        // tokens the walk starts from (comma-separated addresses; default USDC +
        // USDT) and the minimum USD depth a pool's priced side must hold to be
        // trusted as a route — keeps 1-wei dust pools from poisoning prices.
        'usd_anchors' => env(
            'ANALYTICS_USD_ANCHORS',
            '0xdc25597B19799010047F17e9591EFE08EFd40077,0x94845aF24a3E431593A2b941b2b31836dE45185D',
        ),
        'price_min_pool_usd' => (float) env('ANALYTICS_PRICE_MIN_POOL_USD', 0.01),
    ],

    // X (Twitter) OAuth 2.0 login — Socialite's twitter-oauth-2 driver.
    // Create the app at developer.x.com with the callback
    // {APP_URL}/auth/twitter/callback ("users.read tweet.read" scopes).
    'twitter-oauth-2' => [
        'client_id' => env('TWITTER_CLIENT_ID'),
        'client_secret' => env('TWITTER_CLIENT_SECRET'),
        'redirect' => env('TWITTER_REDIRECT_URI', '/auth/twitter/callback'),
    ],

    // Link-only GitHub OAuth. No scopes are requested because the immutable
    // account id and public username are all the profile needs.
    'github' => [
        'client_id' => env('GITHUB_OAUTH_CLIENT_ID'),
        'client_secret' => env('GITHUB_OAUTH_CLIENT_SECRET'),
        'redirect' => env(
            'GITHUB_OAUTH_REDIRECT_URI',
            rtrim((string) env('APP_URL', 'http://localhost'), '/').'/settings/connections/github/callback',
        ),
    ],

    // Telegram's official OIDC Authorization Code flow with PKCE.
    'telegram' => [
        'client_id' => env('TELEGRAM_LOGIN_CLIENT_ID'),
        'client_secret' => env('TELEGRAM_LOGIN_CLIENT_SECRET'),
        'redirect' => env(
            'TELEGRAM_LOGIN_REDIRECT_URI',
            rtrim((string) env('APP_URL', 'http://localhost'), '/').'/settings/connections/telegram/callback',
        ),
        'authorization_url' => 'https://oauth.telegram.org/auth',
        'token_url' => 'https://oauth.telegram.org/token',
        'jwks_url' => 'https://oauth.telegram.org/.well-known/jwks.json',
    ],

    // One-way operator alerts (TelegramOpsNotifier). Unrelated to the login
    // flow above and to the Python bot: nothing here receives updates, it only
    // lets a scheduled command reach a human. Unset means alerts are silently
    // skipped, which is a supported deploy, not a broken one.
    // The community bot (`services/telegram-bot`), for links into it.
    'telegram_bot' => [
        'username' => env('TELEGRAM_BOT_USERNAME', 'cyberia_network_bot'),
        // The numeric half of the bot token before the colon — public, and
        // all a Mini App's initData needs to be checked without the token:
        // Telegram signs it with Ed25519 for third parties (Bot API 8.0).
        'id' => env('TELEGRAM_BOT_ID', '7709137739'),
        'webapp_public_key' => env(
            'TELEGRAM_WEBAPP_PUBLIC_KEY',
            'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d',
        ),
    ],

    'telegram_ops' => [
        'bot_token' => env('TELEGRAM_OPS_BOT_TOKEN'),
        // A list, because there is more than one operator. Commas, spaces or
        // newlines all separate; every entry is a numeric chat id, since
        // Telegram resolves @name for channels and never for a private chat.
        // A person appears here only after they have started the bot —
        // `php artisan telegram:whoami` reads the id off getUpdates.
        'chat_id' => env('TELEGRAM_OPS_CHAT_ID'),
        // Who gets the daily product report. Unset means "the same people who
        // get the alerts": reports and incidents are different kinds of
        // message and can want different rooms, but defaulting them apart
        // would mean a deploy that alerts nobody about anything.
        'analytics_chat_id' => env('TELEGRAM_ANALYTICS_CHAT_ID'),
    ],

    'bridge' => [
        'evm_rpc_url' => env('BRIDGE_EVM_RPC_URL', env('CYBERIA_RPC_URL')),
        'evm_bridge_address' => env('BRIDGE_EVM_CONTRACT_ADDRESS', '0xEf2c8E731006EEDD8F44f5Ea03A389635BB28f90'),
        // The relayer is the same EOA as the contract deployer / owner.
        // BRIDGE_RELAYER_PRIVATE_KEY exists for backwards compat; canonical
        // name is DEPLOYER_PK. `?:` (not the env() default) is used because
        // env('X', $fallback) only kicks in when X is unset, not when it's
        // set to an empty string.
        'relayer_private_key' => env('BRIDGE_RELAYER_PRIVATE_KEY') ?: env('DEPLOYER_PK'),
        // Optional override. If empty, BridgeRelayerService derives the address
        // from the private key automatically (EIP-55 checksum) and caches it.
        'relayer_address' => env('BRIDGE_RELAYER_ADDRESS'),
        'solana_rpc_url' => env('BRIDGE_SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
        // TON payout relayer (crypto/ton/scripts/relay-jetton-transfer.ts).
        'ton_relayer_mnemonic' => env('TON_RELAYER_MNEMONIC'),
        'toncenter_api_key' => env('TONCENTER_API_KEY'),
        'solana_bridge_program' => env('BRIDGE_SOLANA_PROGRAM_ID'),
    ],

    // CYBER.sol balance reads + Telegram "whales chat" gate. Mint mirrors
    // config/bridge.php (tokens.CYBER.sol). RPC prefers Helius (SOLANA_RPC_URL),
    // falling back to the bridge RPC, then the public mainnet endpoint.
    'cyber_sol' => [
        'rpc_url' => env('SOLANA_RPC_URL')
            ?: env('BRIDGE_SOLANA_RPC_URL')
            ?: 'https://api.mainnet-beta.solana.com',
        'mint' => env('CYBER_SOL_MINT', 'E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump'),
        'decimals' => (int) env('CYBER_SOL_DECIMALS', 6),
        'price_usd' => env('CYBER_SOL_PRICE_USD', '0.00009235'),
        // Minimum whole CYBER.sol to qualify for the whales chat.
        'whale_threshold' => env('WHALE_MIN_CYBER_SOL', 10000000),
    ],

    // Custodial CYBER.sol staking. This intentionally uses a dedicated
    // treasury instead of mixing user stakes with the bridge reserve.
    'staking' => [
        'enabled' => filter_var(env('STAKING_SOLANA_ENABLED', false), FILTER_VALIDATE_BOOLEAN),
        'cluster' => env('STAKING_SOLANA_CLUSTER', 'mainnet'),
        'rpc_url' => env('STAKING_SOLANA_RPC_URL') ?: env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
        'public_rpc_url' => env('STAKING_SOLANA_PUBLIC_RPC_URL', 'https://api.mainnet-beta.solana.com'),
        'treasury_address' => env('STAKING_SOLANA_TREASURY_ADDRESS'),
        'keypair_path' => env('STAKING_SOLANA_KEYPAIR_PATH'),
        'cyber_sol_mint' => env('CYBER_SOL_MINT', 'E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump'),
        'cyber_sol_decimals' => (int) env('CYBER_SOL_DECIMALS', 6),
        'token_program' => 'token-2022',
        'ash_address' => env('STAKING_ASH_ADDRESS', '0x992Fca0a89DD95afb17751f6CC233Adb9B089df5'),
        'ash_decimals' => 18,
        'ash_per_cyber_per_day' => env('STAKING_ASH_PER_CYBER_PER_DAY', '0'),
        'evm_rpc_url' => env('STAKING_EVM_RPC_URL') ?: env('CYBERIA_RPC_URL', 'https://rpc.cyberia.church'),
        'evm_chain_id' => 49406,
        'evm_private_key' => env('STAKING_EVM_PRIVATE_KEY'),
    ],

    'slots' => [
        'hot_wallet_address' => env('SLOT_HOT_WALLET_ADDRESS'),
        'hot_wallet_keypair_path' => env('SLOT_HOT_WALLET_KEYPAIR_PATH'),
        'cluster' => env('SLOT_CLUSTER', 'devnet'),
        'rpc_url' => env('SLOT_RPC_URL') ?: (env('SLOT_CLUSTER', 'devnet') === 'mainnet'
            ? 'https://api.mainnet-beta.solana.com'
            : 'https://api.devnet.solana.com'),
        'burn_bps' => env('SLOT_BURN_BPS', 200),
        'house_edge_bps' => env('SLOT_HOUSE_EDGE_BPS', 400),
        'jackpot_threshold_bps' => env('SLOT_JACKPOT_THRESHOLD_BPS', 10),
        'max_single_win_bps' => env('SLOT_MAX_SINGLE_WIN_BPS', 2000),
        'max_bet_usd' => env('SLOT_MAX_BET_USD', 50),
        'metadata_ttl_hours' => env('SLOT_METADATA_TTL_HOURS', 24),
        'prepare_ttl_minutes' => env('SLOT_PREPARE_TTL_MINUTES', 5),
        // Pump.fun auto-whitelist (Phase 2).
        'pumpfun_api_base' => env('SLOT_PUMPFUN_API_BASE', 'https://frontend-api-v3.pump.fun'),
        'pumpfun_auto_enable' => env('SLOT_PUMPFUN_AUTO_ENABLE', true),
        'pumpfun_min_mcap_usd' => env('SLOT_PUMPFUN_MIN_MCAP_USD', 10000),
        'pumpfun_lazy_enabled' => env('SLOT_PUMPFUN_LAZY_ENABLED', true),
        'pumpfun_bulk_top_n' => env('SLOT_PUMPFUN_BULK_TOP_N', 200),
    ],

    // CyberiaProfile contract (on-chain nicknames + achievements). Deployed
    // 2026-07-10 via crypto/hardhat/scripts/deploy-profile.ts; owner = bridge
    // relayer. Set CYBERIA_PROFILE_ADDRESS= (empty) to hide the profile-page
    // section, or to a new address after a redeploy.
    'profile' => [
        'contract_address' => env('CYBERIA_PROFILE_ADDRESS', '0xa9101ee859850c037b0867156b3535F78A387C0d'),
    ],

];
