<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Admin emails allowed to access /admin/bridge-analytics.
    |--------------------------------------------------------------------------
    | Comma-separated list, e.g. "alice@example.com,bob@example.com".
    */

    'admin_emails' => array_values(array_filter(array_map(
        'trim',
        explode(',', (string) env('BRIDGE_ADMIN_EMAILS', '')),
    ))),

    /*
    |--------------------------------------------------------------------------
    | Home chain — where the bridge's wrapper tokens live. Mint-model tokens
    | are minted/burned here; on every other chain the relayer pays out of
    | inventory/reserves instead.
    |--------------------------------------------------------------------------
    */

    'home_chain' => 'cyberia',

    /*
    |--------------------------------------------------------------------------
    | Bridge fee — denominated in USD, paid in the source token.
    |--------------------------------------------------------------------------
    | flat_usd is a fixed dollar fee per transaction. rate_bps adds a percentage
    | on top of the USD amount. The actual fee charged is max(flat, rate*amount).
    | Only tokens with fee_bearing=true are charged (stables).
    */

    'fee' => [
        'flat_usd' => env('BRIDGE_FEE_FLAT_USD', '0.10'),
        'rate_bps' => (int) env('BRIDGE_FEE_RATE_BPS', 0),
        // Native EVM payouts retain enough of the bridged native asset to pay
        // destination gas. The live gas price is multiplied for volatility;
        // the floor also keeps a reserve when an RPC quote is unavailable.
        'native_transfer_gas_limit' => (int) env('BRIDGE_NATIVE_TRANSFER_GAS_LIMIT', 21000),
        'native_gas_price_floor_gwei' => env('BRIDGE_NATIVE_GAS_PRICE_FLOOR_GWEI', '3'),
        'native_gas_multiplier_bps' => (int) env('BRIDGE_NATIVE_GAS_MULTIPLIER_BPS', 20000),
        // Flat YTN retained from evm_to_yenten payouts so the recipient gets
        // the promised net amount exactly; the Yenten network fee (typically
        // well under 0.001 YTN even for many-input transactions) is paid out
        // of this reserve and the remainder accrues to the relayer pool.
        'yenten_payout_fee_ytn' => env('BRIDGE_YENTEN_PAYOUT_FEE_YTN', '0.01'),
        // Flat TON retained from evm_to_ton native payouts; the TON message
        // fee (~0.004 TON) is paid out of this reserve and the remainder
        // accrues to the relayer hot wallet.
        'ton_payout_fee_ton' => env('BRIDGE_TON_PAYOUT_FEE_TON', '0.01'),
        // Flat XMR retained from evm_to_xmr payouts. A Monero transaction fee
        // is charged to the *sender* on top of the amount sent, so the wallet
        // pays it and this is what refills the wallet for it: the recipient
        // gets the net amount exactly, and the reserve absorbs a fee that
        // moves with priority and transaction size (~0.00006 XMR at normal
        // priority, an order of magnitude more when the pool is busy).
        'monero_payout_fee_xmr' => env('BRIDGE_MONERO_PAYOUT_FEE_XMR', '0.0005'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Destination inventory: admission control for capped corridors.
    |--------------------------------------------------------------------------
    | A corridor whose payout comes out of a finite relayer balance is
    | ADMISSION-CONTROLLED: capacity is read live, reserved before the user
    | signs anything, and re-checked under a lock before the relayer burns or
    | pays. An unreadable balance is 'unavailable' and blocks — it is never
    | mistaken for "the relayer mints here, so there is no ceiling".
    |
    | measured_chain_types lists the destination chain types this server can
    | actually read. A type NOT listed is reported 'unmeasured': explicitly
    | not admission-controlled (Yenten/BTC/LTC/XMR run on manual reserves), so
    | the UI shows no number rather than a made-up one.
    */

    'inventory' => [
        'measured_chain_types' => array_values(array_filter(array_map(
            'trim',
            explode(',', (string) env('BRIDGE_INVENTORY_MEASURED_TYPES', 'evm,solana,ton,monero')),
        ))),

        // How long a pre-signature reservation holds capacity. Long enough for
        // a wallet prompt and a source confirmation, short enough that an
        // abandoned tab gives the capacity back on its own.
        'reservation_ttl_seconds' => (int) env('BRIDGE_RESERVATION_TTL_SECONDS', 900),

        // Atomic lock over one destination inventory pool. Held across the
        // read-decide-write of a reservation, and across the relayer's
        // capacity re-check + payout, so two payouts can never both believe
        // they are the last one the balance covers.
        'pool_lock_seconds' => (int) env('BRIDGE_POOL_LOCK_SECONDS', 600),
        'pool_lock_wait_seconds' => (int) env('BRIDGE_POOL_LOCK_WAIT_SECONDS', 5),

        // Per-request lock: one worker, one manual retry, one request.
        'request_lock_seconds' => (int) env('BRIDGE_REQUEST_LOCK_SECONDS', 600),

        // Gas the relayer must be able to pay for a token payout. A balance of
        // USDT with no BNB to move it is not deliverable inventory.
        'token_transfer_gas_limit' => (int) env('BRIDGE_TOKEN_TRANSFER_GAS_LIMIT', 120000),

        // Lamports kept back on the Solana hot wallet: rent exemption plus
        // transaction fees plus one recipient ATA creation.
        'solana_fee_reserve_sol' => env('BRIDGE_SOLANA_FEE_RESERVE_SOL', '0.01'),

        // Toncoin kept back on the TON hot wallet for jetton message fees.
        'ton_fee_reserve' => env('BRIDGE_TON_FEE_RESERVE', '0.1'),

        // XMR kept back in the bridge wallet so the last payout it admits can
        // still pay its own network fee. Monero is 'measured' only when a
        // wallet is attached to this server (see MoneroWalletRpc); with none,
        // the corridor reports 'unmeasured' exactly as it did before, because
        // the reserves are then held somewhere this server cannot read.
        'monero_fee_reserve_xmr' => env('BRIDGE_MONERO_FEE_RESERVE_XMR', '0.01'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Relay subprocess and job budgets.
    |--------------------------------------------------------------------------
    | These three numbers have to stay in this order or the queue itself
    | becomes a double-payment bug: a job that outlives the queue's
    | `retry_after` is handed to a SECOND worker while the first one still has
    | a payout subprocess open.
    |
    |   slowest relay script  <  job timeout  <  queue retry_after
    |
    | `BridgeQueueSafetyTest` pins exactly that, so raising a script timeout
    | fails the suite until the two above it are raised too.
    */

    'relay' => [
        'script_timeout_seconds' => (int) env('BRIDGE_RELAY_SCRIPT_TIMEOUT', 120),
        'solana_timeout_seconds' => (int) env('BRIDGE_RELAY_SOLANA_TIMEOUT', 120),
        'ton_timeout_seconds' => (int) env('BRIDGE_RELAY_TON_TIMEOUT', 240),
        'yenten_timeout_seconds' => (int) env('BRIDGE_RELAY_YENTEN_TIMEOUT', 300),
        // monero-wallet-rpc builds, signs and relays inside the one `transfer`
        // call, and a wallet with many outputs takes its time about it.
        'monero_timeout_seconds' => (int) env('BRIDGE_RELAY_MONERO_TIMEOUT', 240),
        // One request can run a payout AND a burn, so the job must outlive
        // two of the slowest scripts back to back.
        'job_timeout_seconds' => (int) env('BRIDGE_RELAY_JOB_TIMEOUT', 660),
    ],

    /*
    |--------------------------------------------------------------------------
    | Gas drop — top up empty EVM recipients with a small amount of native CYBER
    | so they can pay for their first transaction on Cyberia.
    |--------------------------------------------------------------------------
    */

    'gas_drop' => [
        'enabled' => filter_var(env('BRIDGE_GAS_DROP_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
        'amount_cyber' => env('BRIDGE_GAS_DROP_AMOUNT', '0.01'),
        // Recipients with native balance at or below this threshold (wei) qualify.
        'threshold_wei' => env('BRIDGE_GAS_DROP_THRESHOLD_WEI', '0'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Supported chains.
    |--------------------------------------------------------------------------
    | type drives the verify/payout strategy: evm | solana | ton | yenten |
    | monero.
    | Chains with other type values are manual-review corridors unless a
    | verifier/payout implementation is added and auto_process is enabled.
    | deposit_address is where users send source-chain deposits; null on EVM
    | chains means "the relayer EOA" (same key works on every EVM chain).
    | Adding a new EVM chain = add an entry here (+ routes + token chain maps
    | + an .env RPC var) — no code changes needed.
    */

    'chains' => [
        'cyberia' => [
            'key' => 'cyberia',
            'label' => 'Cyberia EVM',
            'type' => 'evm',
            'address_type' => 'evm',
            'wallet' => 'evm',
            'evm_chain_id' => 49406,
            'rpc_url' => env('BRIDGE_EVM_RPC_URL') ?: env('CYBERIA_RPC_URL', 'https://rpc.cyberia.church'),
            // Browser-facing RPC for client-side reads (bridge token balances).
            // MUST be publicly reachable, CORS-open and HTTPS. Kept separate
            // from rpc_url because on prod that points at the internal node
            // (http://polygon-edge:8545) for the relayer — an address the user's
            // browser cannot reach, which silently zeroed out source balances.
            'public_rpc_url' => env('BRIDGE_EVM_PUBLIC_RPC_URL', 'https://rpc.cyberia.church'),
            'explorer_tx' => 'https://explorer.cyberia.church/tx/{hash}',
            'native_currency' => ['name' => 'Cyber', 'symbol' => 'CYBER', 'decimals' => 18],
            'deposit_address' => null,
        ],
        'solana' => [
            'key' => 'solana',
            'label' => 'Solana',
            'type' => 'solana',
            'address_type' => 'solana',
            'wallet' => 'solana',
            // Keyless on purpose. A credential written here is a credential in
            // a public repository and in its history forever — the key that
            // used to be this default was spent by a stranger. Point
            // BRIDGE_SOLANA_RPC_URL at a keyed endpoint in .env instead; the
            // official cluster answers a server perfectly well (only browsers
            // are refused, which is what /api/solana/rpc is for).
            'rpc_url' => env('BRIDGE_SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
            'explorer_tx' => 'https://solscan.io/tx/{hash}',
            'deposit_address' => env('BRIDGE_SOLANA_HOT_WALLET', 'E6E8AeKoT6i2zmwrGyDF2LwfEfjX9Xg8LfEj2Fu8Yf7w'),
        ],
        'ton' => [
            'key' => 'ton',
            'label' => 'TON',
            'type' => 'ton',
            'address_type' => 'ton',
            // TON Connect (Tonkeeper & friends): deposits are signed in the
            // user's wallet and verified automatically — no manual tx pasting.
            'wallet' => 'ton',
            // tonapi.io — deposit verification + payout tx lookup.
            'api_url' => env('BRIDGE_TON_API_URL', 'https://tonapi.io'),
            'api_key' => env('TONAPI_KEY'),
            // toncenter JSON-RPC — used by the payout relay script.
            'toncenter_rpc_url' => env('BRIDGE_TONCENTER_RPC_URL', 'https://toncenter.com/api/v2/jsonRPC'),
            'explorer_tx' => 'https://tonviewer.com/transaction/{hash}',
            // Operator TON wallet receiving jetton deposits (friendly or raw
            // form). TON routes are hidden from the UI while unset. Should be
            // the wallet controlled by TON_RELAYER_MNEMONIC so the same hot
            // wallet serves both directions.
            'deposit_address' => env('BRIDGE_TON_DEPOSIT_ADDRESS'),
        ],
        'bnb' => [
            'key' => 'bnb',
            'label' => 'BNB Chain',
            'type' => 'evm',
            'address_type' => 'evm',
            'wallet' => 'evm',
            'evm_chain_id' => 56,
            'rpc_url' => env('BRIDGE_BSC_RPC_URL', 'https://bsc-dataseed.binance.org'),
            'explorer_tx' => 'https://bscscan.com/tx/{hash}',
            'native_currency' => ['name' => 'BNB', 'symbol' => 'BNB', 'decimals' => 18],
            'deposit_address' => null,
        ],
        'base' => [
            'key' => 'base',
            'label' => 'Base',
            'type' => 'evm',
            'address_type' => 'evm',
            'wallet' => 'evm',
            'evm_chain_id' => 8453,
            'rpc_url' => env('BRIDGE_BASE_RPC_URL', 'https://mainnet.base.org'),
            'explorer_tx' => 'https://basescan.org/tx/{hash}',
            'native_currency' => ['name' => 'Ethereum', 'symbol' => 'ETH', 'decimals' => 18],
            'deposit_address' => null,
        ],
        'robinhood' => [
            'key' => 'robinhood',
            'label' => 'Robinhood Chain',
            'type' => 'evm',
            'address_type' => 'evm',
            'wallet' => 'evm',
            // Arbitrum-stack L2, mainnet since 2026-07-01. Gas token is ETH.
            'evm_chain_id' => 4663,
            'rpc_url' => env('BRIDGE_ROBINHOOD_RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'),
            'explorer_tx' => 'https://robinhoodchain.blockscout.com/tx/{hash}',
            'native_currency' => ['name' => 'Ethereum', 'symbol' => 'ETH', 'decimals' => 18],
            'deposit_address' => null,
        ],
        'yenten' => [
            'key' => 'yenten',
            'label' => 'Yenten',
            'type' => 'yenten',
            'address_type' => 'yenten',
            'wallet' => 'manual',
            // Chain-level kill switch: a disabled chain disappears from the
            // frontend (bridge + profile) and every route touching it is
            // rejected. Off until per-user deposit crediting runs unattended.
            'enabled' => filter_var(env('BRIDGE_CHAIN_YENTEN_ENABLED', false), FILTER_VALIDATE_BOOLEAN),
            // Official light-wallet API: transaction/UTXO reads and raw-tx
            // broadcast. No local yentend or blockchain download is required.
            'api_url' => env('BRIDGE_YENTEN_API_URL', 'https://api.yentencoin.info'),
            // Deposit detection checks explorer2 first because the old
            // light-wallet API can lag behind the public Blockbook indexer.
            'balance_api_urls' => array_values(array_filter(array_map(
                'trim',
                explode(',', (string) env(
                    'BRIDGE_YENTEN_BALANCE_API_URLS',
                    'https://explorer2.yentencoin.info,https://api.yentencoin.info',
                )),
            ))),
            'explorer_tx' => 'https://explorer.yentencoin.info/tx/{hash}',
            'explorer_tx_fallbacks' => [
                'https://explorer2.yentencoin.info/tx/{hash}',
            ],
            // Central wallet: receives swept deposits and pays out evm_to_yenten.
            'deposit_address' => env('BRIDGE_YENTEN_DEPOSIT_ADDRESS'),
            'relayer_wif' => env('BRIDGE_YENTEN_RELAYER_WIF'),
            // Master seed for per-request one-time deposit addresses. Each
            // request derives its own address (index = request id), binding a
            // deposit to exactly one request + committed recipient so a public
            // deposit tx can't be hijacked. Only the seed is secret.
            'hd_seed' => env('BRIDGE_YENTEN_HD_SEED'),
            'minimum_confirmations' => (int) env('BRIDGE_YENTEN_MIN_CONFIRMATIONS', 1),
            // How long a one-time deposit address is monitored. After the
            // window an empty request is marked expired and its address is
            // never polled again (a deposit that DID land in time is still
            // honored on claim). Keeps dead addresses from accumulating in
            // the API polling set.
            'deposit_ttl_minutes' => (int) env('BRIDGE_YENTEN_DEPOSIT_TTL_MINUTES', 60),
        ],
        'bitcoin' => [
            'key' => 'bitcoin',
            'label' => 'Bitcoin',
            'type' => 'bitcoin',
            'address_type' => 'bitcoin',
            'wallet' => 'manual',
            'enabled' => filter_var(env('BRIDGE_CHAIN_BTC_ENABLED', false), FILTER_VALIDATE_BOOLEAN),
            'explorer_tx' => 'https://mempool.space/tx/{hash}',
            'deposit_address' => env('BRIDGE_BTC_DEPOSIT_ADDRESS'),
            // Master seed for per-user profile deposit addresses (CEX-style).
            // Each user gets a P2PKH address derived at index = user id; the
            // WIF spending key is re-derivable for sweeping. Only the seed is
            // secret. Generate: php -r 'echo bin2hex(random_bytes(32));'
            'hd_seed' => env('BRIDGE_BTC_HD_SEED'),
            'minimum_confirmations' => (int) env('BRIDGE_BTC_MIN_CONFIRMATIONS', 3),
        ],
        'litecoin' => [
            'key' => 'litecoin',
            'label' => 'Litecoin',
            'type' => 'litecoin',
            'address_type' => 'litecoin',
            'wallet' => 'manual',
            'enabled' => filter_var(env('BRIDGE_CHAIN_LTC_ENABLED', false), FILTER_VALIDATE_BOOLEAN),
            'explorer_tx' => 'https://litecoinspace.org/tx/{hash}',
            'deposit_address' => env('BRIDGE_LTC_DEPOSIT_ADDRESS'),
            // Per-user profile deposit addresses — see the bitcoin entry.
            'hd_seed' => env('BRIDGE_LTC_HD_SEED'),
            'minimum_confirmations' => (int) env('BRIDGE_LTC_MIN_CONFIRMATIONS', 6),
        ],
        'monero' => [
            'key' => 'monero',
            'label' => 'Monero',
            'type' => 'monero',
            'address_type' => 'monero',
            'wallet' => 'manual',
            'enabled' => filter_var(env('BRIDGE_CHAIN_XMR_ENABLED', false), FILTER_VALIDATE_BOOLEAN),
            'explorer_tx' => 'https://xmrchain.net/tx/{hash}',
            'deposit_address' => env('BRIDGE_XMR_DEPOSIT_ADDRESS'),
            // Monero has no per-address keys to hand out: per-user deposit
            // addresses are INTEGRATED addresses (deposit_address + an 8-byte
            // payment id derived from this seed at index = user id), so funds
            // land directly in the main wallet while staying attributable.
            // Requires deposit_address to be a standard (4...) address.
            'hd_seed' => env('BRIDGE_XMR_HD_SEED'),
            'minimum_confirmations' => (int) env('BRIDGE_XMR_MIN_CONFIRMATIONS', 10),

            // A Monero corridor is a wallet, not an API key. Nobody can read
            // an address on this chain from outside — that is what the chain
            // is for — so both halves of the corridor go through a
            // `monero-wallet-rpc` this server holds: bridge-in reads what
            // landed on a per-request subaddress, bridge-out sends from the
            // same wallet. Unset means the corridor has no wallet: deposits
            // cannot be seen, payouts cannot be made, and every surface says
            // so rather than failing halfway. `services/monero/` runs both.
            'wallet_rpc_url' => env('BRIDGE_XMR_WALLET_RPC_URL', ''),
            // monero-wallet-rpc's --rpc-login, which is HTTP digest auth.
            'wallet_rpc_user' => env('BRIDGE_XMR_WALLET_RPC_USER', ''),
            'wallet_rpc_password' => env('BRIDGE_XMR_WALLET_RPC_PASSWORD', ''),
            'wallet_rpc_timeout' => (int) env('BRIDGE_XMR_WALLET_RPC_TIMEOUT', 15),
            // Which wallet account the bridge lives in. Subaddresses are
            // created inside it and payouts are spent from it, so changing it
            // after requests exist orphans the indices already handed out.
            'wallet_account_index' => (int) env('BRIDGE_XMR_WALLET_ACCOUNT', 0),
            // 0 = default, 1 = unimportant, 2 = normal, 3 = elevated. A bridge
            // payout is not a race, and priority is paid for in fee.
            'payout_priority' => (int) env('BRIDGE_XMR_PAYOUT_PRIORITY', 1),
            // How far back the relayer looks for a payout it may already have
            // made when a `transfer` response was lost. ~24h of blocks.
            'payout_lookback_blocks' => (int) env('BRIDGE_XMR_PAYOUT_LOOKBACK_BLOCKS', 720),
            // How long a request's deposit subaddress is watched before an
            // EMPTY one is closed. Longer than Yenten's hour because ten
            // Monero confirmations are twenty minutes on their own and the
            // watching costs one filtered RPC call either way. A deposit that
            // did land is honoured whenever it lands — the subaddress belongs
            // to this wallet forever, so the coins are never stranded.
            'deposit_ttl_minutes' => (int) env('BRIDGE_XMR_DEPOSIT_TTL_MINUTES', 1440),
        ],
    ],

    /*
    |--------------------------------------------------------------------------
    | Bridge routes. All auto-processed by the relayer.
    |--------------------------------------------------------------------------
    | 'enabled' gates a corridor: disabled routes vanish from availableRoutes()
    | so they are hidden from the UI and rejected at submit/quote time. Routes
    | already submitted in a disabled direction still auto-process — the job
    | reads config('bridge.routes') directly. Solana <-> Cyberia and TON <-> Cyberia
    | are on by default (TON still hides until its hot wallet is configured);
    | flip the matching env var to reopen/close a corridor without a deploy.
    |
    | 'coming_soon' is the third state: the corridor stays VISIBLE in the UI
    | (greyed out, "Coming soon", not selectable) but is rejected at
    | submit/quote time regardless of 'enabled'. Use it for corridors being
    | teased before operator setup is done.
    */

    'routes' => [
        'sol_to_evm' => [
            'direction' => 'sol_to_evm',
            'source_chain' => 'solana',
            'destination_chain' => 'cyberia',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_SOL_TO_EVM_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
        ],
        'evm_to_sol' => [
            'direction' => 'evm_to_sol',
            'source_chain' => 'cyberia',
            'destination_chain' => 'solana',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_EVM_TO_SOL_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
        ],
        'ton_to_evm' => [
            'direction' => 'ton_to_evm',
            'source_chain' => 'ton',
            'destination_chain' => 'cyberia',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_TON_TO_EVM_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
        ],
        'evm_to_ton' => [
            'direction' => 'evm_to_ton',
            'source_chain' => 'cyberia',
            'destination_chain' => 'ton',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_EVM_TO_TON_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
        ],
        'bnb_to_evm' => [
            'direction' => 'bnb_to_evm',
            'source_chain' => 'bnb',
            'destination_chain' => 'cyberia',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_BNB_TO_EVM_ENABLED', false), FILTER_VALIDATE_BOOLEAN),
        ],
        'evm_to_bnb' => [
            'direction' => 'evm_to_bnb',
            'source_chain' => 'cyberia',
            'destination_chain' => 'bnb',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_EVM_TO_BNB_ENABLED', false), FILTER_VALIDATE_BOOLEAN),
        ],
        'base_to_evm' => [
            'direction' => 'base_to_evm',
            'source_chain' => 'base',
            'destination_chain' => 'cyberia',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_BASE_TO_EVM_ENABLED', false), FILTER_VALIDATE_BOOLEAN),
        ],
        'evm_to_base' => [
            'direction' => 'evm_to_base',
            'source_chain' => 'cyberia',
            'destination_chain' => 'base',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_EVM_TO_BASE_ENABLED', false), FILTER_VALIDATE_BOOLEAN),
        ],
        // Inbound is live by default: deposits go to the relayer EOA on
        // Robinhood Chain and the payout is a mint on Cyberia, so no
        // Robinhood-side gas or inventory is required.
        'robinhood_to_evm' => [
            'direction' => 'robinhood_to_evm',
            'source_chain' => 'robinhood',
            'destination_chain' => 'cyberia',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_ROBINHOOD_TO_EVM_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
        ],
        // Outbound needs relayer ETH on Robinhood Chain for payouts — teased
        // as "Coming soon" until the hot wallet is funded, then flip both vars.
        'evm_to_robinhood' => [
            'direction' => 'evm_to_robinhood',
            'source_chain' => 'cyberia',
            'destination_chain' => 'robinhood',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_EVM_TO_ROBINHOOD_ENABLED', false), FILTER_VALIDATE_BOOLEAN),
            'coming_soon' => filter_var(env('BRIDGE_ROUTE_EVM_TO_ROBINHOOD_COMING_SOON', true), FILTER_VALIDATE_BOOLEAN),
        ],
        // The Yenten/Bitcoin/Litecoin/Monero corridors are teased as "Coming
        // soon" (visible, not selectable) until per-user deposit crediting is
        // trusted to run unattended. Set BRIDGE_ROUTE_*_COMING_SOON=false to
        // open a corridor for real.
        'yenten_to_evm' => [
            'direction' => 'yenten_to_evm',
            'source_chain' => 'yenten',
            'destination_chain' => 'cyberia',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_YENTEN_TO_EVM_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
            'coming_soon' => filter_var(env('BRIDGE_ROUTE_YENTEN_TO_EVM_COMING_SOON', true), FILTER_VALIDATE_BOOLEAN),
        ],
        'evm_to_yenten' => [
            'direction' => 'evm_to_yenten',
            'source_chain' => 'cyberia',
            'destination_chain' => 'yenten',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_EVM_TO_YENTEN_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
            'coming_soon' => filter_var(env('BRIDGE_ROUTE_EVM_TO_YENTEN_COMING_SOON', true), FILTER_VALIDATE_BOOLEAN),
        ],
        'btc_to_evm' => [
            'direction' => 'btc_to_evm',
            'source_chain' => 'bitcoin',
            'destination_chain' => 'cyberia',
            'auto_process' => false,
            'enabled' => filter_var(env('BRIDGE_ROUTE_BTC_TO_EVM_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
            'coming_soon' => filter_var(env('BRIDGE_ROUTE_BTC_TO_EVM_COMING_SOON', true), FILTER_VALIDATE_BOOLEAN),
        ],
        'evm_to_btc' => [
            'direction' => 'evm_to_btc',
            'source_chain' => 'cyberia',
            'destination_chain' => 'bitcoin',
            'auto_process' => false,
            'enabled' => filter_var(env('BRIDGE_ROUTE_EVM_TO_BTC_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
            'coming_soon' => filter_var(env('BRIDGE_ROUTE_EVM_TO_BTC_COMING_SOON', true), FILTER_VALIDATE_BOOLEAN),
        ],
        'ltc_to_evm' => [
            'direction' => 'ltc_to_evm',
            'source_chain' => 'litecoin',
            'destination_chain' => 'cyberia',
            'auto_process' => false,
            'enabled' => filter_var(env('BRIDGE_ROUTE_LTC_TO_EVM_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
            'coming_soon' => filter_var(env('BRIDGE_ROUTE_LTC_TO_EVM_COMING_SOON', true), FILTER_VALIDATE_BOOLEAN),
        ],
        'evm_to_ltc' => [
            'direction' => 'evm_to_ltc',
            'source_chain' => 'cyberia',
            'destination_chain' => 'litecoin',
            'auto_process' => false,
            'enabled' => filter_var(env('BRIDGE_ROUTE_EVM_TO_LTC_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
            'coming_soon' => filter_var(env('BRIDGE_ROUTE_EVM_TO_LTC_COMING_SOON', true), FILTER_VALIDATE_BOOLEAN),
        ],
        // Monero, both ways, through the wallet this server holds: a deposit
        // to a per-request subaddress mints the Cyberia wrapper, and burning
        // the wrapper sends real XMR back out. Both stay "Coming soon" until
        // an operator attaches that wallet — the corridor is honest about
        // having none rather than accepting deposits it cannot see.
        'xmr_to_evm' => [
            'direction' => 'xmr_to_evm',
            'source_chain' => 'monero',
            'destination_chain' => 'cyberia',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_XMR_TO_EVM_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
            'coming_soon' => filter_var(env('BRIDGE_ROUTE_XMR_TO_EVM_COMING_SOON', true), FILTER_VALIDATE_BOOLEAN),
        ],
        'evm_to_xmr' => [
            'direction' => 'evm_to_xmr',
            'source_chain' => 'cyberia',
            'destination_chain' => 'monero',
            'auto_process' => true,
            'enabled' => filter_var(env('BRIDGE_ROUTE_EVM_TO_XMR_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
            'coming_soon' => filter_var(env('BRIDGE_ROUTE_EVM_TO_XMR_COMING_SOON', true), FILTER_VALIDATE_BOOLEAN),
        ],
    ],

    /*
    |--------------------------------------------------------------------------
    | Optional CYBER.sol -> native CYBER auto-conversion (sol_to_evm only).
    |--------------------------------------------------------------------------
    | When the user opts in, the relayer mints the bridged CYBER.sol to itself
    | and redeems it through the CyberSolBurnSwap contract (fixed 1000:1 rate,
    | input burned to 0x...dEaD), then forwards the native CYBER payout to the
    | recipient. Off by default per request — plain CYBER.sol delivery stays
    | the standard flow.
    */

    'convert' => [
        'enabled' => filter_var(env('BRIDGE_CONVERT_ENABLED', true), FILTER_VALIDATE_BOOLEAN),
        'burn_swap_address' => env('BRIDGE_CYBERSOL_BURN_SWAP', '0xa5Ae36E5b1eDb24BCa2F96783d079B28e0BCfd71'),
        // CYBER.sol required per 1 native CYBER (matches CyberSolBurnSwap.RATE).
        'rate' => 1000,
    ],

    /*
    |--------------------------------------------------------------------------
    | Supported tokens with per-chain identifiers.
    |--------------------------------------------------------------------------
    | model: 'native' goes through the CyberBridge contract (CYBER.sol only);
    |        'mint'   — relayer owns the Cyberia wrapper: mint() on bridge-IN,
    |                   burnFrom() on bridge-OUT;
    |        'direct' — plain transfers from relayer inventory.
    | A token is offered on a route iff it has entries for BOTH route chains.
    | chains.<key>: {address|mint|master|native, decimals, token_program?}.
    */

    'tokens' => [
        // CYBER.sol is a wrapped token — mint()/burn() on EVM are gated to the
        // CyberBridge contract, so we cannot use the 'direct' (hot-wallet
        // transfer) flow. Bridging goes through CyberBridge's releaseCyberSol
        // / redeemCyberSol functions.
        'CYBER.sol' => [
            'symbol' => 'CYBER.sol',
            'model' => 'native',
            'chains' => [
                'cyberia' => ['address' => '0x7DcDa19Cf984ca708E5fA228AC148e7d82D508BA', 'decimals' => 18],
                'solana' => ['mint' => 'E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump', 'decimals' => 6, 'token_program' => 'token-2022'],
            ],
        ],
        // USDC — one unified wrapper across every source chain (Solana + Base),
        // all Circle-issued and rebalanceable, so reserves are POOLED. Per-chain
        // withdrawal capacity is enforced from the relayer's live inventory on
        // the destination chain (see BridgeInventoryService), not by minting a
        // separate wrapper per chain.
        'USDC' => [
            'symbol' => 'USDC',
            'model' => 'mint',
            'fee_bearing' => true,
            'chains' => [
                'cyberia' => ['address' => '0xdc25597B19799010047F17e9591EFE08EFd40077', 'decimals' => 6],
                'solana' => ['mint' => 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'decimals' => 6, 'token_program' => 'token'],
                'base' => ['address' => '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'decimals' => 6],
            ],
        ],
        // USDT — one unified wrapper across Solana + BNB Chain (pooled reserves,
        // rebalanceable). The Cyberia wrapper is 6-dec; BSC-USDT is 18-dec, so
        // the bridge scales each side by its own decimals (like CYBER.sol 18/6).
        'USDT' => [
            'symbol' => 'USDT',
            'model' => 'mint',
            'fee_bearing' => true,
            'chains' => [
                'cyberia' => ['address' => '0x94845aF24a3E431593A2b941b2b31836dE45185D', 'decimals' => 6],
                'solana' => ['mint' => 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'decimals' => 6, 'token_program' => 'token'],
                'bnb' => ['address' => '0x55d398326f99059fF775485246999027B3197955', 'decimals' => 18],
            ],
        ],
        // HATCHER — Solana-native token bridged to Cyberia. Mint model: the
        // relayer EOA owns the EVM wrapper and mint()s on bridge-IN / burnFrom()s
        // on bridge-OUT. Canonical SPL mint is Token-2022 / 6 decimals; the EVM
        // wrapper uses 9 (each side scales independently, like CYBER.sol 18/6).
        'HATCHER' => [
            'symbol' => 'HATCHER',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0x621021F18b6404123f98b1395c418868418ACF36', 'decimals' => 9],
                'solana' => ['mint' => 'Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump', 'decimals' => 6, 'token_program' => 'token-2022'],
            ],
        ],
        // ORBV (Orbserv) — Solana-native pump.fun token bridged to Cyberia.
        // Mint model like HATCHER: relayer EOA owns the EVM wrapper and mint()s
        // on bridge-IN / burnFrom()s on bridge-OUT. Both sides are 6 decimals.
        'ORBV' => [
            'symbol' => 'ORBV',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0x19E92D8475522FF6c8f3660372B9dc6674d85cC8', 'decimals' => 6],
                'solana' => ['mint' => 'HQJwmK24WN3e87aQzNHnUVK4SaNgYfrR3tDkGgWTpump', 'decimals' => 6, 'token_program' => 'token-2022'],
            ],
        ],
        // Native SOL bridged into the Cyberia SOL wrapper (9-dec, matching
        // lamports; relayer-owned Ownable mint/burn). Deposits are plain
        // system transfers to the Solana hot wallet; payouts are native SOL
        // from the same wallet (crypto/anchor/scripts/relay-sol-transfer.ts).
        'SOL' => [
            'symbol' => 'SOL',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0x53450B1d205f1e41d10B653FBBDEa74160dafFf4', 'decimals' => 9],
                'solana' => ['native' => true, 'decimals' => 9],
            ],
        ],
        // Native Toncoin bridged into a Cyberia wrapper (deployed via
        // crypto/hardhat/scripts/deploy-ton.ts, relayer-owned mint/burn).
        // Native TON is 9-dec; the wrapper keeps the 18-dec ERC20 default and
        // the bridge scales each side independently.
        'TON' => [
            'symbol' => 'TON',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0x92aBF73698383176Aa2894F1f7263807C3a4e6e6', 'decimals' => 18],
                'ton' => ['native' => true, 'decimals' => 9],
            ],
        ],
        // KARASIQUE — TON jetton bridged to the existing Cyberia ERC20.
        'KRSQ' => [
            'symbol' => 'KRSQ',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0x4945419ccEEF0Dc70B054700DE2750A056B03eE3', 'decimals' => 18],
                'ton' => ['master' => 'EQBcumfGKvl8jD1eAjRMggu7xf0JV7D1n5mj4zfYTOnuCXhp', 'decimals' => 9],
            ],
        ],
        // Goal Bear Coin — TON jetton bridged to the existing Cyberia ERC20.
        'GOAL' => [
            'symbol' => 'GOAL',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0xEb91EC10462a249b9922D6D62FB2BE73Bd084ADe', 'decimals' => 18],
                'ton' => ['master' => 'EQBofbbpUhtSvnZxOsPmzAv84fq1bG0-Mf79OPB4FrEXsT0I', 'decimals' => 9],
            ],
        ],
        // Native Yenten is held by the Yenten relayer wallet; the Cyberia
        // representation is owner-minted and burned on bridge-out.
        'YTN' => [
            'symbol' => 'YTN',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0x3a5820Be90c3fB9c5F3Fb47a4859544193B0f8C6', 'decimals' => 18],
                'yenten' => ['native' => true, 'decimals' => 8],
            ],
        ],
        // Manual Bitcoin/Litecoin/Monero bridge corridors. The Cyberia side is
        // owner-minted/burnable; native-chain deposits and payouts stay pending
        // for operator review until dedicated verifiers/relayers are wired.
        'BTC' => [
            'symbol' => 'BTC',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0x9332081f308BC978fe259237850fA253131b46Fa', 'decimals' => 8],
                'bitcoin' => ['native' => true, 'decimals' => 8],
            ],
        ],
        'LTC' => [
            'symbol' => 'LTC',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0x001AFD19C9d890b0cf0fcd6D654f9BFe4f264F14', 'decimals' => 8],
                'litecoin' => ['native' => true, 'decimals' => 8],
            ],
        ],
        'XMR' => [
            'symbol' => 'XMR',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0xe2E8D51C18d6e0FDDbb9Ff4BF63235D688dd00Ae', 'decimals' => 12],
                'monero' => ['native' => true, 'decimals' => 12],
            ],
        ],
        // ETH — one unified wrapper (the canonical Cyberia ETH, 0xFDa2…1986,
        // also the DEX/lending asset; relayer-owned Ownable mint/burn). Native
        // ETH on every source chain (Base + Robinhood Chain) maps to it;
        // reserves are pooled and rebalanceable via the canonical L2 bridges.
        // Native-coin pattern: mint on bridge-IN, native transfer on bridge-OUT.
        'ETH' => [
            'symbol' => 'ETH',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0xFDa2F6EEB11f1aCc7ccAb559133E8F07d9F81986', 'decimals' => 18],
                'base' => ['native' => true, 'decimals' => 18],
                'robinhood' => ['native' => true, 'decimals' => 18],
            ],
        ],
        // SPY — Robinhood tokenized stock (SPDR S&P 500 ETF Trust) bridged
        // into a Cyberia wrapper (deployed via deploy-spy.ts, relayer-owned
        // mint/burn). Both sides are 18-dec ERC20s; bridge-IN deposits go to
        // the relayer EOA on Robinhood Chain, bridge-OUT pays from that SPY
        // reserve (the evm_to_robinhood corridor stays "Coming soon" until
        // the relayer holds gas + inventory there).
        'SPY' => [
            'symbol' => 'SPY',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => '0x1241FC4F06DB7268243D9439ef56B7a2708DC096', 'decimals' => 18],
                'robinhood' => ['address' => '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C', 'decimals' => 18],
            ],
        ],
        // CYBER — the Cyberia native gas coin bridged to Robinhood Chain
        // (deploy-cyber-robinhood.ts; the "Cyber" ERC20 there is relayer-owned,
        // no premint). 'owned' marks the entry as a relayer-owned wrapper on a
        // non-home chain: outbound MINTS it to the recipient against the
        // native CYBER the user deposited on the relayer EOA on Cyberia, and
        // inbound deposits are BURNED before the native CYBER payout — supply
        // stays 1:1 with the Cyberia-side reserve.
        'CYBER' => [
            'symbol' => 'CYBER',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['native' => true, 'decimals' => 18],
                'robinhood' => ['address' => env('BRIDGE_CYBER_ROBINHOOD_ADDRESS', '0x753979e6585CCa139fbB1918966D563a25eEB3B2'), 'decimals' => 18, 'owned' => true],
            ],
        ],
        // Native BNB bridged into a Cyberia wrapper (deployed via
        // crypto/hardhat/scripts/deploy-bnb.ts). BNB is its own asset (not a
        // per-chain copy of a shared token), so no unification applies.
        'BNB' => [
            'symbol' => 'BNB',
            'model' => 'mint',
            'chains' => [
                'cyberia' => ['address' => env('BRIDGE_BNB_WRAPPER_ADDRESS', ''), 'decimals' => 18],
                'bnb' => ['native' => true, 'decimals' => 18],
            ],
        ],
    ],

];
