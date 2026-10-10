<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Wallet-to-wallet encrypted chat
    |--------------------------------------------------------------------------
    |
    | The server is a relay for messages it cannot read, so nothing here is a
    | policy about content — there is no content to have a policy about. These
    | are the limits of the queue itself: how long an undelivered envelope is
    | held, how large one may be, and how many are handed over per poll.
    |
    */

    'chat' => [

        /**
         * Days an envelope is kept before `wallet:chat-prune` deletes it.
         *
         * The wallets at either end hold the conversation; this is only the
         * window in which a wallet that was closed can still collect its mail.
         * Shortening it costs the relay nothing and costs an offline recipient
         * their messages, which is the trade to weigh.
         */
        'retention_days' => (int) env('WALLET_CHAT_RETENTION_DAYS', 30),

        /**
         * Base64 ciphertext characters accepted in one message.
         *
         * The client pads plaintext to a 256-byte block and caps it at 4000
         * bytes, so a legitimate envelope is comfortably under this; the cap
         * exists so the relay cannot be used as free storage.
         */
        'max_body_chars' => (int) env('WALLET_CHAT_MAX_BODY', 8192),

        /** Envelopes handed over in one poll. */
        'page' => 200,

        /**
         * Minutes a signed proof keeps a mailbox open before it is re-signed.
         *
         * Matches the holders' room: long enough that a conversation is not
         * interrupted, short enough that a stolen session cookie stops working
         * without the key behind it.
         */
        'proof_minutes' => 30,
    ],

    /*
    |--------------------------------------------------------------------------
    | Pinning from the wallet
    |--------------------------------------------------------------------------
    |
    | The wallet composes NFT metadata and pages in the browser, but the Kubo
    | API is bound to localhost and is never handed to a browser — it can run
    | any node command. So the bytes come through this app, which pins them and
    | hands back a CID and nothing else.
    |
    | Storage on the node is the cost of this, which is what the cap and the
    | throttle are about. Anything stricter than a cap — a holding gate, an
    | allowlist — goes in `WalletIpfsController::guard()`, the one place both
    | routes ask permission, so the shape of the endpoint does not change when
    | it arrives.
    |
    */

    'ipfs' => [

        /** Off means the wallet screens say pinning is unavailable, not that they fail. */
        'enabled' => (bool) env('WALLET_IPFS_ENABLED', true),

        /**
         * Largest object one call may pin.
         *
         * PHP's own `upload_max_filesize` and `post_max_size` have to be at
         * least this, or a browser gets Laravel's 413 before this cap is ever
         * consulted — which is a worse error message for the same limit.
         */
        'max_bytes' => (int) env('WALLET_IPFS_MAX_BYTES', 10 * 1024 * 1024),
    ],

    /*
    |--------------------------------------------------------------------------
    | Sponsored fees on Cyberia
    |--------------------------------------------------------------------------
    |
    | A fee is payable only in the coin the chain runs on, so an address holding
    | USDC and no CYBER cannot move its USDC. That is the failure people
    | actually hit, and this is the answer to it: the CyberiaGasStation contract
    | hands such an address a small amount of CYBER, and the user then signs
    | their own transaction in the ordinary way. Nothing about signing changes,
    | which is why this covers sends, swaps, mints and everything not yet built.
    |
    | The division of labour is deliberate. What the station will do at most —
    | how much, how often, to whom, up to what daily total — is enforced by the
    | contract and cannot be exceeded by anything on this server, including a
    | stolen sponsor key. Who *deserves* a drip is a question about the world,
    | and that is answered here.
    |
    | Cyberia only. Sponsoring BNB or Base would mean buying ETH for strangers.
    |
    */

    'sponsor' => [

        /** Off means the wallet says fees are not sponsored, not that sending fails. */
        'enabled' => (bool) env('WALLET_GAS_SPONSOR_ENABLED', true),

        /** CyberiaGasStation. Unset disables sponsorship as surely as `enabled` false. */
        'station' => (string) env('WALLET_GAS_STATION_ADDRESS', ''),

        /**
         * The operator key that pulls drips out of the station.
         *
         * Its own balance pays the gas for delivering them, so it needs
         * topping up separately from the tank — `gas:station` watches both.
         *
         * There is deliberately no fallback to BRIDGE_RELAYER_PRIVATE_KEY.
         * That EOA is shared with the Telegram minter and the DCA bot, and
         * transactions from it already lose races for nonces; a sponsorship
         * that fails because a bridge payout went first is a worse outcome
         * than sponsorship being switched off until a key exists.
         */
        'private_key' => (string) env('GAS_SPONSOR_PRIVATE_KEY', ''),

        /** Cyberia's keyless index, used to ask what an address holds. */
        'explorer_api' => (string) env(
            'WALLET_GAS_EXPLORER_API',
            'https://explorer.cyberia.church/api',
        ),

        /**
         * The gate: sponsor an address that already owns something on Cyberia.
         *
         * Which is the same sentence as the problem — "I have something I
         * cannot move" — and it is self-limiting in a way a captcha is not.
         * To farm this faucet a bot would have to first put real assets into
         * every address it invents, and those cost more than the drip.
         *
         * Turning it off makes the station a plain faucet: better onboarding
         * for a genuinely empty wallet, and an open invitation to scripts.
         */
        'require_holding' => (bool) env('WALLET_GAS_REQUIRE_HOLDING', true),

        /**
         * An address that has signed into the site with this wallet is also
         * sponsored, holdings or not. An account here was earned by doing
         * something, which is the same evidence a balance is.
         */
        'allow_site_accounts' => (bool) env('WALLET_GAS_ALLOW_ACCOUNTS', true),

        /**
         * Quotas this server adds on top of the contract's own.
         *
         * The contract bounds the money; these bound the noise. Counted from
         * the `gas_sponsorships` table rather than the cache, so flushing the
         * cache does not reset anyone's day.
         */
        'daily_per_ip' => (int) env('WALLET_GAS_DAILY_PER_IP', 5),
        'daily_total' => (int) env('WALLET_GAS_DAILY_TOTAL', 500),

        /** Seconds a station read is cached. Policy changes rarely; the tank drains. */
        'cache_seconds' => 30,

        /*
         * When `gas:station --alert` starts shouting.
         *
         * Two numbers because there are two ways to run dry, and only one of
         * them is the tank: the operator key pays the gas that *delivers* each
         * drip, so a full station behind a broke key sponsors nobody. The
         * relayer has run empty once before, unnoticed for hours.
         */
        'low_water_drips' => (int) env('WALLET_GAS_LOW_WATER_DRIPS', 50),
        'operator_min_wei' => (string) env('WALLET_GAS_OPERATOR_MIN_WEI', '50000000000000000'),
    ],

    /*
    |--------------------------------------------------------------------------
    | On-chain actions in the feed
    |--------------------------------------------------------------------------
    |
    | Everything the Telegram bot reads off the chain into `activity_events` —
    | swaps on both exchanges, liquidity, lending, staking, bridges, mints —
    | plus every launch (`launchpad:watch`). All of it goes into the feed and
    | is pushed to everyone by `feed:announce-activity`: the project is small
    | enough that each one is news. A floor above zero brings back the old
    | behaviour — only rows priced at or above it reach "All" and the push —
    | for the day a phone buzzing for every 20-cent swap stops being welcome.
    |
    */

    'feed' => [
        'trade_floor_usd' => (float) env('WALLET_TRADE_FLOOR_USD', 0),
    ],

];
