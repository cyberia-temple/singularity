<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Service monitoring
    |--------------------------------------------------------------------------
    |
    | The ecosystem is a dozen separate programs on one host — a chain node, an
    | explorer, a DEX, an IPFS node, two bots, a handful of scheduled commands
    | — and until now the only way to learn that one of them had stopped was to
    | ssh in and look. This registry is the list of everything that is supposed
    | to be running, how to find out whether it is, and how to tell whether
    | anyone is using it.
    |
    | Two questions, deliberately kept apart, because they have different
    | answers and different remedies: a service can be perfectly healthy and
    | used by nobody, and that is a product problem rather than an outage.
    |
    */

    'enabled' => (bool) env('MONITORING_ENABLED', true),

    /*
    |--------------------------------------------------------------------------
    | Host heartbeat
    |--------------------------------------------------------------------------
    |
    | Laravel runs inside a container. It cannot see the host's docker daemon,
    | its tmux sessions, its load average or its disk — which is precisely
    | where the Telegram bot, LainOS and every container except this one live.
    | So the host pushes: `scripts/ops/heartbeat.sh` on a one-minute cron POSTs
    | raw facts to /api/ops/heartbeat and this app maps them onto the registry
    | below. The script stays dumb on purpose — it reports what it sees, and
    | this file remains the only place that decides what any of it means.
    |
    | No token means the endpoint refuses everything: an open ingest would let
    | anyone declare the host healthy, which is worse than no monitoring at all
    | because it would be believed.
    |
    */

    'heartbeat' => [
        'token' => env('OPS_HEARTBEAT_TOKEN'),

        /*
         * How old the last heartbeat may be before everything it backs is
         * reported `unknown`. Not `down`: a heartbeat that stopped arriving
         * says the reporter died, and says nothing whatsoever about the
         * services it was reporting on. Three missed one-minute runs.
         */
        'stale_seconds' => (int) env('OPS_HEARTBEAT_STALE', 240),

        /*
         * The machine a registry entry means when it does not name one. More
         * than one reports: the server runs the chain, the explorer and this
         * app, while LainOS runs on the operator's own machine and was never
         * deployed to the server at all. Unset falls back to whichever host
         * reported most recently, which is right while there is only one.
         */
        'default_host' => env('OPS_HEARTBEAT_DEFAULT_HOST'),
    ],

    /*
    |--------------------------------------------------------------------------
    | Probing
    |--------------------------------------------------------------------------
    */

    'probe' => [
        // Per-request ceiling. HTTP probes run pooled, so a full sweep costs
        // about one timeout even when every endpoint is dead.
        'timeout' => (int) env('MONITORING_TIMEOUT', 10),

        // Above this a service is `degraded` rather than `up`. Slow is a
        // state worth seeing before it becomes an outage.
        'slow_ms' => (int) env('MONITORING_SLOW_MS', 3000),
    ],

    /*
    |--------------------------------------------------------------------------
    | Alerts
    |--------------------------------------------------------------------------
    |
    | Alerts fire on *transitions*, never on state: a service that has been
    | down for a week must not shout every five minutes, or the channel gets
    | muted and the next real outage is invisible. Recovery is announced too —
    | "it is back" is the half of an incident people actually wait for.
    |
    */

    'alerts' => [
        'enabled' => (bool) env('MONITORING_ALERTS', true),

        // Consecutive failed checks before an incident is opened. One failed
        // probe is usually a network hiccup on this host, not an outage.
        'failures_before_alert' => (int) env('MONITORING_FAILURES_BEFORE_ALERT', 2),

        // Consecutive healthy checks before an incident is closed. Without it
        // something that fails more often than it answers produced a
        // "down / recovered" pair every hour, and neither one was news.
        'checks_before_resolve' => (int) env('MONITORING_CHECKS_BEFORE_RESOLVE', 2),

        // Hours before an unresolved incident is repeated once.
        'reminder_hours' => (int) env('MONITORING_REMINDER_HOURS', 12),
    ],

    /*
    |--------------------------------------------------------------------------
    | Retention
    |--------------------------------------------------------------------------
    |
    | Checks are a rolling uptime window, not an archive. Incidents are the
    | history worth keeping, so they live much longer and are far fewer.
    |
    */

    'retention' => [
        'check_days' => (int) env('MONITORING_CHECK_DAYS', 30),
        'incident_days' => (int) env('MONITORING_INCIDENT_DAYS', 365),
    ],

    /*
    |--------------------------------------------------------------------------
    | The registry
    |--------------------------------------------------------------------------
    |
    | Every key is a service. Fields:
    |
    |   group      Where it belongs on the board: chain, web, infra, daemon,
    |              onchain, scheduled.
    |   label      What to call it. Not translated — these are proper names.
    |   critical   Whether an outage is worth waking someone for.
    |   deployed   false marks something that exists in the repo but was never
    |              deployed. It is reported `off`, never `down`, because a
    |              service nobody started is not broken.
    |   check      How to find out. See ServiceProbe for the types.
    |   usage      How to count use, or null when this app genuinely cannot
    |              tell — which is itself worth printing, since "unmeasured"
    |              and "unused" are different findings.
    |   url        Where a human goes to look at it.
    |   note       One line the board prints under the name.
    |
    | A usage entry is `table` + `column`, optionally `where` (column => value)
    | and `distinct` (a column to count uniques of).
    |
    */

    'services' => [

        /* ------------------------------------------------------- chain -- */

        'cyberia-rpc' => [
            'group' => 'chain',
            'label' => 'Cyberia RPC',
            'critical' => true,
            'url' => 'https://rpc.cyberia.church',
            'note' => 'The chain itself: chain id 49406, IBFT PoA.',
            'check' => [
                'type' => 'evm-rpc',
                'url' => env('MONITORING_CYBERIA_RPC')
                    ?: env('BRIDGE_EVM_RPC_URL')
                    ?: env('CYBERIA_RPC_URL', 'https://rpc.cyberia.church'),
                // A PoA chain that answers but has stopped sealing is the
                // failure nobody notices, so the head's age is the check and
                // an HTTP 200 alone is not enough.
                'stale_seconds' => 300,
                'chain_id' => 49406,
            ],
            'usage' => null,
        ],

        'explorer' => [
            'group' => 'chain',
            'label' => 'Blockscout explorer',
            'critical' => true,
            'url' => 'https://explorer.cyberia.church',
            'note' => 'Also the keyless index the wallet, gas station and analytics read.',
            'check' => [
                'type' => 'blockscout',
                'api' => env('MONITORING_EXPLORER_API', 'https://explorer.cyberia.church/api'),
                // Blocks the index may trail the node by before it is
                // degraded. The wallet's history and the gas station's
                // eligibility check both read this, so lag is user-visible.
                'max_lag_blocks' => 200,
                // Whose head to measure the lag against. Named rather than
                // inferred: the node's block number is fetched once for the
                // service below and reused here at no cost.
                'head_from' => 'cyberia-rpc',
            ],
            'usage' => null,
        ],

        'cyberia-node-2' => [
            'group' => 'chain',
            'label' => 'Second Cyberia node',
            'critical' => false,
            'deployed' => false,
            'note' => 'services/cyberia-node — a non-validating RPC follower, prepared and never deployed.',
            'check' => ['type' => 'none'],
            'usage' => null,
        ],

        /* --------------------------------------------------------- web -- */

        'site' => [
            'group' => 'web',
            'label' => 'cyberia.church',
            'critical' => true,
            'url' => 'https://cyberia.church',
            'note' => 'The Laravel app: site, wallet, bridge UI, CRM.',
            'check' => ['type' => 'http', 'url' => 'https://cyberia.church'],
            'usage' => ['table' => 'site_events', 'column' => 'created_at', 'distinct' => 'session_id'],
        ],

        'bridge' => [
            'group' => 'web',
            'label' => 'bridge.cyberia.church',
            'critical' => true,
            'url' => 'https://bridge.cyberia.church',
            'check' => ['type' => 'http', 'url' => 'https://bridge.cyberia.church', 'expect' => [200, 301, 302]],
            'usage' => ['table' => 'bridge_requests', 'column' => 'created_at'],
        ],

        'swap' => [
            'group' => 'web',
            'label' => 'swap.cyberia.church',
            'critical' => true,
            'url' => 'https://swap.cyberia.church',
            'note' => 'Ritual DEX. Its own build, deployed separately from the site.',
            'check' => ['type' => 'http', 'url' => 'https://swap.cyberia.church'],
            'usage' => null,
        ],

        'blog' => [
            'group' => 'web',
            'label' => 'blog.cyberia.church',
            'critical' => false,
            'url' => 'https://blog.cyberia.church',
            'note' => 'frontend/jekyll.',
            'check' => ['type' => 'http', 'url' => 'https://blog.cyberia.church'],
            'usage' => null,
        ],

        'tls' => [
            'group' => 'web',
            'label' => 'TLS certificates',
            'critical' => true,
            'note' => 'Every public hostname. rpc and explorer have expired unnoticed before.',
            'check' => [
                'type' => 'tls',
                'hosts' => [
                    'cyberia.church',
                    'rpc.cyberia.church',
                    'explorer.cyberia.church',
                    'bridge.cyberia.church',
                    'swap.cyberia.church',
                ],
                // Certbot renews at 30 days left; a cert that gets inside this
                // window means renewal itself has stopped working.
                'warn_days' => 14,
                'critical_days' => 3,
            ],
            'usage' => null,
        ],

        /* ------------------------------------------------------- infra -- */

        'database' => [
            'group' => 'infra',
            'label' => 'Database',
            'critical' => true,
            'check' => ['type' => 'database'],
            'usage' => null,
        ],

        'cache' => [
            'group' => 'infra',
            'label' => 'Cache / Redis',
            'critical' => true,
            'note' => 'Quotes, rate limits, alert silence windows and the schedule mutex.',
            'check' => ['type' => 'cache'],
            'usage' => null,
        ],

        'queue' => [
            'group' => 'infra',
            'label' => 'Queue worker',
            'critical' => true,
            'note' => 'Database queue. A backlog that only grows means no worker is running.',
            'check' => ['type' => 'queue', 'max_backlog' => 100, 'max_age_seconds' => 900],
            // Deliberately unmeasured: `jobs` is a work queue whose rows are
            // deleted the moment they are handled, so counting them measures
            // the backlog and calls a healthy empty queue unused.
            'usage' => null,
        ],

        'scheduler' => [
            'group' => 'infra',
            'label' => 'Laravel scheduler',
            'critical' => true,
            'note' => 'Host cron into the container. It silently never ran at all until 2026-08-12.',
            'check' => ['type' => 'scheduler', 'stale_seconds' => 900],
            'usage' => null,
        ],

        'ipfs' => [
            'group' => 'infra',
            'label' => 'IPFS node',
            'critical' => false,
            'note' => 'Pins launchpad token sites and wallet uploads. Bound to localhost.',
            'check' => ['type' => 'ipfs'],
            'usage' => ['table' => 'launchpad_tokens', 'column' => 'updated_at', 'where_not_null' => 'ipfs_cid'],
        ],

        'proxy' => [
            'group' => 'infra',
            'label' => 'nginx proxy',
            'critical' => true,
            'note' => 'Renders templates from /root/blockscout, not from this repo.',
            'check' => ['type' => 'heartbeat', 'container' => 'proxy'],
            'usage' => null,
        ],

        'host' => [
            'group' => 'infra',
            'label' => 'Host',
            'critical' => true,
            'note' => 'Load, memory, disk. 4 cores.',
            'check' => [
                'type' => 'host',
                'max_load_per_cpu' => 3.0,
                'max_disk_percent' => 90,
                'min_memory_percent' => 5,
            ],
            'usage' => null,
        ],

        'heartbeat' => [
            'group' => 'infra',
            'label' => 'Host heartbeat',
            'critical' => true,
            'note' => 'scripts/ops/heartbeat.sh. Everything host-side is blind without it.',
            'check' => ['type' => 'heartbeat-self'],
            'usage' => null,
        ],

        /* ------------------------------------------- containers on host -- */

        'blockscout-backend' => [
            'group' => 'infra',
            'label' => 'Blockscout backend',
            'critical' => true,
            'check' => ['type' => 'heartbeat', 'container' => 'backend'],
            'usage' => null,
        ],

        'blockscout-frontend' => [
            'group' => 'infra',
            'label' => 'Blockscout frontend',
            'critical' => false,
            'check' => ['type' => 'heartbeat', 'container' => 'frontend'],
            'usage' => null,
        ],

        'blockscout-stats' => [
            'group' => 'infra',
            'label' => 'Blockscout stats',
            'critical' => false,
            'check' => ['type' => 'heartbeat', 'container' => 'stats'],
            'usage' => null,
        ],

        /*
         * Both removed from the Blockscout stack on 2026-08-22, and both kept
         * here rather than deleted: `off` with a reason is a decision somebody
         * can revisit, while a deleted row is a service nobody remembers
         * existed. Between them they were restarting six times a minute and
         * burning most of a core on a four-core host.
         */
        'user-ops-indexer' => [
            'group' => 'infra',
            'label' => 'User-ops indexer',
            'critical' => false,
            'deployed' => false,
            'note' => 'Removed: an ERC-4337 indexer on a chain with no account abstraction — the v0.6 EntryPoint has no code on Cyberia.',
            'check' => ['type' => 'heartbeat', 'container' => 'user-ops-indexer'],
            'usage' => null,
        ],

        'nft-media-handler' => [
            'group' => 'infra',
            'label' => 'NFT media handler',
            'critical' => false,
            'deployed' => false,
            'note' => 'Removed: never configured (no nodes map, no bucket), so it crash-looped 4,910 times. Needs object storage before it comes back.',
            'check' => ['type' => 'heartbeat', 'container' => 'nft_media_handler'],
            'usage' => null,
        ],

        /*
         * The rest of the compose stack. Every running container is on the
         * board, so that "unregistered" below means something genuinely new
         * appeared rather than being a permanent list of things nobody looked
         * at. An unwatched container is how a service gets forgotten, which is
         * the failure this whole file exists to stop repeating.
         */
        'node-container' => [
            'group' => 'infra',
            'label' => 'polygon-edge container',
            'critical' => true,
            'note' => 'The process behind the RPC. Separate from the chain check: one is what users feel, this is what an operator restarts.',
            'check' => ['type' => 'heartbeat', 'container' => 'polygon-edge'],
            'usage' => null,
        ],

        'app-container' => [
            'group' => 'infra',
            'label' => 'cyberia_church container',
            'critical' => true,
            'note' => 'This app. If it is down, nothing here was written by it.',
            'check' => ['type' => 'heartbeat', 'container' => 'cyberia_church'],
            'usage' => null,
        ],

        'postgres' => [
            'group' => 'infra',
            'label' => 'Blockscout postgres',
            'critical' => true,
            'check' => ['type' => 'heartbeat', 'container' => 'db'],
            'usage' => null,
        ],

        'stats-db' => [
            'group' => 'infra',
            'label' => 'Blockscout stats postgres',
            'critical' => false,
            'check' => ['type' => 'heartbeat', 'container' => 'stats-db'],
            'usage' => null,
        ],

        'redis' => [
            'group' => 'infra',
            'label' => 'Redis',
            'critical' => true,
            'note' => 'Had restart=no and stayed down through a host reboot.',
            'check' => ['type' => 'heartbeat', 'container' => 'redis-db'],
            'usage' => null,
        ],

        'ipfs-container' => [
            'group' => 'infra',
            'label' => 'IPFS container',
            'critical' => false,
            'check' => ['type' => 'heartbeat', 'container' => 'ipfs'],
            'usage' => null,
        ],

        'visualizer' => [
            'group' => 'infra',
            'label' => 'Blockscout visualizer',
            'critical' => false,
            'check' => ['type' => 'heartbeat', 'container' => 'visualizer'],
            'usage' => null,
        ],

        'sig-provider' => [
            'group' => 'infra',
            'label' => 'Blockscout sig-provider',
            'critical' => false,
            'check' => ['type' => 'heartbeat', 'container' => 'sig-provider'],
            'usage' => null,
        ],

        /* ------------------------------------------------------ daemon -- */

        'telegram-bot' => [
            'group' => 'daemon',
            'label' => 'Telegram bot',
            'critical' => true,
            'note' => 'services/telegram-bot, in tmux. Unsupervised: it has died and stayed dead for 12h before.',
            'check' => ['type' => 'heartbeat', 'tmux' => 'bot'],
            'usage' => null,
        ],

        'lainos' => [
            'group' => 'daemon',
            'label' => 'LainOS daemon',
            'critical' => false,
            'note' => 'services/lainos. Runs on the operator machine, not on the server — there is no node there and never has been.',
            // Named host, so this never reports a daemon as missing from a
            // machine it was never installed on. Until that machine sends a
            // heartbeat this reads `unknown`, which is the honest answer.
            // Checked through its supervisor rather than by matching a
            // process list: systemd already knows, and `pgrep -f` matches the
            // command line of whatever is running the reporting script too.
            'check' => [
                'type' => 'heartbeat',
                'host' => env('MONITORING_LAINOS_HOST'),
                'unit' => 'lainos',
            ],
            'usage' => null,
        ],

        'dex-pool-indexer' => [
            'group' => 'daemon',
            'label' => 'DEX pool indexer',
            'critical' => false,
            'note' => 'The bot half that maintains dex_pools, which /tokens, /liquidity and every USD quote read.',
            'check' => ['type' => 'table-freshness', 'table' => 'dex_pools', 'column' => 'updated_at', 'stale_seconds' => 7200],
            'usage' => null,
        ],

        'distribute-chats' => [
            'group' => 'daemon',
            'label' => 'Chat token distribution',
            'critical' => false,
            'note' => 'One-minute host cron. scripts/ops/logrotate-cyberia-crons keeps its log bounded.',
            // The wrapper rotates at 32 MB. Reaching 64 MB means that policy
            // is absent or failing on the host, with enough headroom to fix it
            // calmly rather than when the disk fills.
            'check' => ['type' => 'heartbeat', 'cron' => 'distribute-chats', 'max_log_mb' => 64],
            'usage' => null,
        ],

        'distribute-tg' => [
            'group' => 'daemon',
            'label' => 'Telegram reward distribution',
            'critical' => false,
            'check' => ['type' => 'heartbeat', 'cron' => 'distribute-tg', 'stale_seconds' => 7200, 'max_log_mb' => 64],
            'usage' => null,
        ],

        /* ----------------------------------------------------- onchain -- */

        'gas-station' => [
            'group' => 'onchain',
            'label' => 'Gas station',
            'critical' => false,
            'note' => 'Sponsored fees. Fails silently: the button just stops appearing.',
            'check' => ['type' => 'gas-station'],
            'usage' => ['table' => 'gas_sponsorships', 'column' => 'created_at', 'distinct' => 'address'],
        ],

        'bridge-relayer' => [
            'group' => 'onchain',
            'label' => 'Bridge relayer',
            'critical' => true,
            'note' => 'The shared EOA that pays out every bridge. It has run dry before.',
            'check' => ['type' => 'relayer', 'min_wei' => '500000000000000000'],
            // The bridge above already counts the same rows. Two services
            // reporting one number would put the same finding on the idle list
            // twice and make it look like two problems.
            'usage' => null,
        ],

        'monero-wallet' => [
            'group' => 'onchain',
            'label' => 'Monero bridge wallet',
            'critical' => false,
            'note' => 'services/monero, a thin client: the keys are here, the chain is a node somebody else runs. Unattached, both XMR routes vanish from the bridge.',
            // Not an HTTP check. `monero-wallet-rpc` answers a version request
            // with no daemon at all, so reachability and health are different
            // questions here and the probe asks the second one.
            'check' => ['type' => 'monero-wallet', 'stale_seconds' => 1200],
            // Printed under every alert. Almost every stall here is the remote
            // node, not the wallet: on 2026-10-05 node.monerodevs.org went dark
            // and the wallet sat on one block for two days.
            'runbook' => 'The remote node is not serving blocks. On cyber.main: point MONERO_DAEMON_ADDRESS in services/monero/.env at a live public node, then `docker compose up -d wallet`.',
            // Deliberately unmeasured: `bridge_requests` is already counted by
            // the bridge service, and counting the XMR rows again would put one
            // quiet corridor on the idle list as if it were a second service.
            'usage' => null,
        ],

        'predictions' => [
            'group' => 'onchain',
            'label' => 'Prediction markets',
            'critical' => false,
            'note' => 'The oracle has 30 days after close, then resolution is disabled forever.',
            'check' => ['type' => 'scheduled-command', 'command' => 'predictions:resolve', 'stale_seconds' => 1800],
            'usage' => null,
        ],

        /* --------------------------------------------------- product -- */

        'wallet' => [
            'group' => 'product',
            'label' => 'Wallet',
            'critical' => true,
            'url' => 'https://cyberia.church/wallet',
            'check' => ['type' => 'http', 'url' => 'https://cyberia.church/wallet'],
            'usage' => ['table' => 'analytics_events', 'column' => 'created_at', 'distinct' => 'analytics_user_id'],
        ],

        'wallet-chat' => [
            'group' => 'product',
            'label' => 'Wallet chat',
            'critical' => false,
            'note' => 'End-to-end encrypted relay. Messages are pruned, so usage is a live count.',
            'check' => ['type' => 'none'],
            'usage' => ['table' => 'wallet_chat_messages', 'column' => 'created_at'],
        ],

        'ai-api' => [
            'group' => 'product',
            'label' => 'Inference API',
            'critical' => false,
            'url' => 'https://cyberia.church/api/ai/v1/models',
            'check' => ['type' => 'http', 'url' => 'https://cyberia.church/api/ai/v1/models'],
            'usage' => ['table' => 'ai_api_requests', 'column' => 'created_at'],
        ],

        'lain-chat' => [
            'group' => 'product',
            'label' => 'Lain chat',
            'critical' => false,
            'url' => 'https://cyberia.church/lain',
            'check' => ['type' => 'none'],
            'usage' => ['table' => 'lain_chat_messages', 'column' => 'created_at'],
        ],

        'launchpad' => [
            'group' => 'product',
            'label' => 'Launchpad',
            'critical' => false,
            'url' => 'https://cyberia.church/launchpad',
            'check' => ['type' => 'http', 'url' => 'https://cyberia.church/launchpad'],
            'usage' => ['table' => 'launchpad_tokens', 'column' => 'created_at'],
        ],

        'dao' => [
            'group' => 'product',
            'label' => 'DAO',
            'critical' => false,
            'url' => 'https://cyberia.church/dao',
            'check' => ['type' => 'http', 'url' => 'https://cyberia.church/dao'],
            'usage' => ['table' => 'proposal_votes', 'column' => 'created_at'],
        ],

        'slots' => [
            'group' => 'product',
            'label' => 'Slots',
            'critical' => false,
            'url' => 'https://cyberia.church/slots',
            'check' => ['type' => 'none'],
            'usage' => ['table' => 'slot_spins', 'column' => 'created_at'],
        ],

        'solana-staking' => [
            'group' => 'product',
            'label' => 'Solana staking',
            'critical' => false,
            'check' => ['type' => 'none'],
            'usage' => ['table' => 'solana_staking_transactions', 'column' => 'created_at'],
        ],

        'feed' => [
            'group' => 'product',
            'label' => 'Feed',
            'critical' => false,
            'url' => 'https://cyberia.church/feed',
            'check' => ['type' => 'none'],
            'usage' => ['table' => 'posts', 'column' => 'created_at'],
        ],
    ],

];
