# AGENTS.md

Guidelines for AI agents working on Singularity.

---

## Project Snapshot

Singularity is the Cyberia monorepo. It contains the Cyberia Laravel bridge/site, the Ritual DEX frontend, static landing/blog pages, EVM and Solana contracts, Blockscout deployment config, daemon services, and operational scripts.

Cyberia network constants used across the repo:

- RPC: `https://rpc.cyberia.church`
- Chain ID: `49406`
- Native token: `CYBER`
- Explorer: `https://explorer.cyberia.church`
- Bridge: `https://bridge.cyberia.church`
- Site: `https://cyberia.church`
- DEX: `https://swap.cyberia.church`
- CYBER.sol mint: `E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump`

---

## Project Components

```text
singularity/
├── backend/laravel/      # Laravel 13 + Vue 3 + Inertia app, bridge UI/backend
├── frontend/ritual/      # Ritual DEX, React 18 / CRA / react-app-rewired
├── frontend/landing/     # Static HTML landing/brand pages
├── frontend/jekyll/      # Jekyll Cyberia blog/static site
├── frontend/desktop/     # Cyberia desktop app (Electron shell over the live site)
├── frontend/mobile/      # Cyberia mobile app (Capacitor shell, Android + iOS)
├── frontend/extension/   # Cyberia Wallet browser extension (MV3, own vault, EIP-1193)
├── crypto/hardhat/       # EVM contracts, Hardhat 3 + viem
├── crypto/anchor/        # Solana/Anchor bridge contracts and scripts
├── crypto/quickswap-core/ # Legacy QuickSwap/Uniswap v2 core contracts
├── services/blockscout/  # Cyberia explorer: Blockscout docker-compose deploy config (official images)
├── services/cyberia-node/ # Cyberia L1 second node (polygon-edge follower/RPC); prepared, not deployed
├── services/ipfs/        # IPFS docker-compose config
├── services/lisp/        # Common Lisp daemon/http services
├── services/telegram-bot/ # Cyberia Telegram bot (Python): rewards, announcers, pump.fun buy bot, whales gate, wallet Mini App, AI assistant with a per-user free-model picker
├── services/lainos/      # LainOS: autonomous AI agent framework (TypeScript), Cyberia chain plugin
├── game/wired/           # Wired: 3D on-chain game (Godot 4), NPCs powered by LainOS
├── game/nocarrier/       # NO CARRIER: netstalking survival-horror sim (Godot 4, en/ru, optional on-chain NFT sealing)
├── scripts/              # Python, JS, and Lisp operational scripts/bots
├── linux/                # Cyberia OS build notes/config
└── logs/                 # Runtime logs
```

Do not rely on older docs that refer to `hardhat/` at the repo root; contracts now live under `crypto/`.

---

## General Rules

- Keep changes focused and atomic. Avoid unrelated formatting churn.
- Do not overwrite user changes. Check `git status --short` before and after edits.
- Prefer existing local patterns and helpers over introducing new abstractions.
- Do not edit generated dependency folders (`node_modules/`, `vendor/`, `target/`) or generated build outputs unless the user explicitly asks for deploy/build artifacts.
- Always verify changes with the narrowest useful command. If verification cannot pass because of known repo state, report the exact blocker and the command used.
- For production/deploy requests, confirm the expected artifact exists after building, especially `frontend/ritual/build/index.html` and `frontend/ritual/build/static/`.
- When drafting posts for the user, assume there is no character limit unless the user explicitly sets one.

LLM orientation:

- Treat `AGENTS.md` as the cross-repo source of truth, and nested `AGENTS.md` files as authoritative inside their subtree.
- `CLAUDE.md` mirrors this guidance for Claude Code; keep it in sync when changing broad repo instructions.
- Root `README.md` is user-facing and currently less complete than these agent notes. Do not copy stale README paths such as root `hardhat/`.
- Avoid broad filesystem walks through generated/runtime trees. Prefer `rg --files` and exclude `node_modules/`, `vendor/`, `target/`, `build/`, `_site/`, `artifacts/`, `cache/`, `test-ledger/`, `logs/`, and `linux/custom-root/` unless the task is specifically about those paths.
- Never print secrets from `.env`, wallet keypair JSON files, cookies, bot tokens, private keys, or Blockscout production env files. Report variable names, not values.

Important generated/runtime paths:

- Dependency folders: `backend/laravel/vendor/`, `**/node_modules/`
- Build outputs: `frontend/ritual/build/`, `frontend/jekyll/_site/`, `frontend/desktop/dist/`, `frontend/mobile/www/`, `frontend/mobile/android/app/build/`, `frontend/extension/dist/`
- Contract outputs: `crypto/hardhat/artifacts/`, `crypto/hardhat/cache/`, `crypto/anchor/target/`, `crypto/anchor/test-ledger/`
- Blockscout data volumes under `services/blockscout/docker-compose/services/*-data/`, `services/blockscout/docker-compose/services/dets/`, and Redis dumps
- OS/rootfs artifacts under `linux/custom-root/`

---

## Laravel Backend

See [`backend/laravel/AGENTS.md`](backend/laravel/AGENTS.md) for Laravel Boost and Laravel-specific rules. Those instructions are authoritative for Laravel work.

Stack:

- PHP 8.3+
- Laravel 13
- Inertia v3 + Vue 3
- Fortify + Sanctum
- Wayfinder
- Pest 4
- Laravel Pint
- Tailwind CSS v4

Common commands:

```bash
cd backend/laravel
composer install
npm install
composer run dev
npm run build
composer run ci:check
php artisan test --compact
vendor/bin/pint --dirty --format agent
```

Notes:

- Use Wayfinder route helpers from `@/routes` and `@/actions` instead of hardcoded Laravel route URLs when wiring Laravel Inertia pages.
- Vue pages live in `backend/laravel/resources/js/pages`.
- The bridge welcome page is intentionally layoutless in `resources/js/app.ts`.
- `npm run types:check` may expose pre-existing TypeScript issues in old pages; do not hide new errors inside that noise.
- The interface language is a **browser-side** choice and never Laravel's locale: `composables/useLocale.ts` holds one shared reactive `locale` for the whole app (English, Russian, Simplified Chinese), persists it in localStorage, guesses it from `navigator.language` on a first visit, and stamps a full BCP-47 tag onto `<html lang>` — Chinese needs its region there, because a browser given a bare `zh` can draw unified Han characters with Japanese glyph shapes. Copy lives in per-feature dictionaries (`lib/{wallet,download,progress,console}Messages.ts`); **English is the only language a dictionary has to carry** and `t()` falls through to it, so a surface translated into two languages and one translated into three both work. A page's one-button switch cycles only the languages *its own* dictionary has — the operator-facing console is en/ru and therefore offers no Chinese — while the site-wide picker in `components/web3/WalletMenu.vue` lists all of them. Key sets and `{placeholders}` are pinned across every dictionary by `tests/Frontend/LocaleMessagesTest.mjs`, because a missing key is otherwise invisible: it renders in English and the screen keeps working.
- **The bridge never starts an irreversible step on a number it does not have** (`App\Services\BridgeAdmissionService`, `BridgeInventoryService`, `App\Support\BridgeCapacity`, table `bridge_reservations`, `POST /bridge/reserve`, `bridge:release-reservations`, `config/bridge.php` under `inventory` and `relay`; `resources/js/lib/bridgeCapacity.ts` for the browser half). The invariant: confirmed obligations plus active reservations never exceed the destination inventory that is actually *deliverable*, and with unknown or insufficient inventory no source-side burn or payout may begin. Rules that must not be relaxed. **Capacity has four states and `null` is not one of them** — `unlimited` only where the relayer genuinely mints, `available` as a RAW integer in the destination entry's own decimals, `unmeasured` for reserves held by hand, and `unavailable`, which covers nothing; conflating the last two with the first is exactly the fail-open gate that let request #68 burn a wrapper it could not pay for. **Every comparison is integer bcmath**, scaled by the destination's decimals, and equality is allowed — a float rounds a 6-decimal stablecoin at the cent. **Deliverable, not merely held**: an ERC20 reserve with no gas coin, or an SPL reserve on a hot wallet under its rent+fee floor, is zero. **The interface is not the gate** — capacity is *claimed* server-side under a lock over the destination pool before the wallet opens, and `/bridge/submit` (reached only after the transfer is signed) refuses nothing: it consumes the claim, or records an obligation for a transfer that never made one. **The order is capacity → payout → durable hash → confirm → burn**, never burn first; every relay script prints `broadcastTxHash` before waiting on a receipt and Laravel writes it from the output stream, so `hasPayout()` makes a second payout unreachable from the queue, from a retry, and from `bridge:relay --force`. `awaiting_liquidity` and `burn_pending` are load-bearing states, not diagnostics — the first means a verified deposit with nothing burned and nothing sent, the second means the recipient has their money and only our own accounting is owed. The queue's numbers are part of it: slowest relay script < job timeout < connection `retry_after`, pinned by `BridgeQueueSafetyTest`. `redeemCyberSol()` burns inside the *user's* transaction, so a reservation is the most a server can do for that corridor; the rest needs a contract-level signed reservation or an escrow, and is deliberately not built.
- Progression (XP, levels, daily streaks, quests) lives in `App\Services\GamificationService` with rules in `config/gamification.php`, surfaced on `/profile` and `/leaderboard`. XP is paid through the append-only `xp_entries` ledger keyed by `(source, reference)`; the browser may only report visits/page views, while swaps, liquidity, bridges and governance are credited from ground truth by `gamification:sync`. Do not pay value XP from client-reported events.
- The wallet reads that same progression on **Daily** (`components/wallet/WalletDaily.vue`, `lib/wallet/daily.ts`, `Api\WalletDailyController`, routes `api/wallet/daily{,/check-in}` in `routes/web.php`, pinned in `tests/Frontend/WalletDailyTest.mjs` and `tests/Feature/WalletDailyBoardTest.php`). One ledger and never a second one keyed by address: experience is a fact about a *person* and the wallet holds a *key*, so a swap made here pays the row the profile page reads or it pays nothing. That is also why this is the only wallet surface that wants a session — its routes are declared in `routes/web.php` rather than `routes/api.php`, which carries none — and why a wallet with no account is shown the half that is genuinely public (the quest catalogue, what a streak pays, the board `/leaderboard` already publishes) and told plainly that progress belongs to an account, never a zero dressed as a score. The one press that changes that signs the site's **login** challenge and no other wording (`signInWithWallet()`), because a proof minted under a different message that a login endpoint would also accept is a proof for one thing becoming a proof for another. The check-in is recorded as `recordAction($user, 'page_view')` and not a bare `touch()`: only the former advances the quests that *are* showing up, and a board that checked you in and then kept printing "Jack in — 0/1" was giving two answers to one question. Daily and weekly quests are two lists with two headers because they reset on two clocks. The faucet card on that screen is the gas station and is keyed by **address**, not account — it is the one panel there whose subject is the key.
- The operator console ("Пульт") is `/crm` and everything under it: `docs/console.md`, `App\Services\Console\*`, `ConsoleController`/`ConsoleNumbersController`, `layouts/ConsoleLayout.vue`, `resources/css/console.css`, `lib/consoleMessages.ts`, table `console_snoozes`. Five pages with the same anatomy became five lenses on one stream — Сейчас, Люди, Задачи, Числа, Машины — and the home is a queue rather than a list, because the operators come in between other work and arrive with "what requires me now". Rules that carry the design: every queue row shows **time-in-state** in the left column and that column is the priority; one action per row plus "until morning" (`Snooze` — a snoozed row moves to the watch list with its wake-up time, it never disappears); **silence is a designed state** and must print the last sweep, the count that answered it and how long it has been quiet; filters are **segments** (a saved question with its rule visible), never a bar of dropdowns; Люди is also the one place a person is **written down** — a composer on the lens (`POST /crm/people`) that stays open across a handful of entries and returns to the list, and the dossier's "Кто это" panel editing in place (`PUT /crm/{contact}`), while the timeline under it stays a log; the import button prints how old the base is beside it, from a row per run in `crm_syncs` that also says whether the run was complete (an empty holder scan is a rate-limit, not an empty chain); somebody who stopped holding is written down as type `lead` / status `sold` with the balance zeroed and is **never deleted**, while an operator's `lost` is never overwritten; a contact carries `x_handle` beside `telegram`, both stored bare through `App\Support\Handles`, which also refuses to build a link out of the numeric Telegram ids the whale sync writes; colour is spent only on anomaly — four signals and hatching for "no data", which never enters an arithmetic; the banner, the rail badge and the list come from one cached build so they cannot disagree; and a number that cannot be read is `null` rendered as an em dash, never zero. The console probes nothing and writes only explicit operator actions. A sixth lens, **Чат** (`/crm/chat`, `ConsoleChatController`, `Console\ChatRoom` + `Console\LainOsRoom`, `crm/Chat.vue` and `crm/ChatFiles.vue`, tables `crm_chat_{messages,files,reads}`, `crm:chat-prune`), is the operators' room and the file dump at the same time: a file cannot exist without the message that brought it, so it always carries an author and a reason, and `/crm/chat/files` is that stream read as segments. Rules that carry it: one room and no channels; the left column is time of day, not time-in-state; the one action on a line is **В задачу**; LainOS answers only when called as `@lainos` (never `@lain`, an operator) and every answer is stamped with which backend gave it — the daemon with tools (`LAINOS_HTTP_URL`) or the tool-less persona — and with what it was allowed to see; an unreachable LainOS is hatched with a retry and never a made-up answer. **It is told the state of the project before it is asked anything** (`Console\ConsoleBriefing`, `CRM_CHAT_LAINOS_BRIEFING`): the queue, the machines, the chain (head, indexer lag, prices, the pool snapshot, the gas tank in CYBER), the bridge ledger, the thirty-day tiles and the board, composed from the caches the lenses already render — a correspondent instructed not to invent numbers and handed none could only ever answer «посмотри в линзе». Every figure carries its age, anything unreadable says so instead of becoming a zero, and the two backends are told different things about the briefing: the daemon that it is a starting point for its own tools, the persona that it is the end of the line. Files live on the private disk and are served only through the console gate; executables are refused, and a message and its bytes are pruned together. **No lens waits for F5**: the shell holds one heartbeat for the whole console (`GET /crm/pulse`, `ConsolePulse`, `composables/useConsolePulse.ts`) — every five seconds while the tab is visible, paused while it is hidden, beaten once when it comes back — and it answers with an opaque version per lens plus the rail's counts, so a lens re-reads only its own props when its own version moved (`useConsoleLive`) and nothing anybody is typing is disturbed. It is a poll and not a socket on purpose (a push needs a process nobody watches), and it fails out loud: three failed beats and the top bar says «не обновляется». A version is a count plus the newest `updated_at`, Сейчас stamps the material under its cached queue instead of rebuilding it, and `attention` comes from the warm cache only — `null` when cold, never 0. The room does not use a version at all: whole-second columns can hide two writes in one second, so it asks `GET /crm/chat/since` on every beat and gets lines said, changed and taken back against the window it holds, with `>=` on the boundary second. Presence is stamped only for whoever has `/crm/chat` open and is sent with its UTC offset — a bare `Y-m-d H:i:s` is read by a browser as local time. Finding one person is a different task from reading a segment, so Люди carries a narrow strip (type, status, search, order — all in the address): `updated_at` there is really the half-hourly balance refresh talking, which put a hand-entered lead outside the candidate rows entirely, so the default order pulls in the recently written down and `sort=added` asks outright, while the search reads `@name` and pasted profile URLs as the bare handles they are stored as. The dossier is where a conversation is written down: `crm_messages` (`CrmMessageController`, `POST /crm/{contact}/messages`) is a table and not notes with a convention, because only `direction` lets the console state "we wrote four days ago and they have not answered", and `sent_at` is when it was said rather than when it was typed — the same rows are what a Telegram/Discord import will fill, deduplicated by a per-channel unique `external_id`. It records and never sends; "Написать" stays a link out. "Отвечает" is the median gap from the first unanswered line we sent, and reads "ещё ни разу не ответил" rather than 0. The stream is filtered on the server (`?events=all|touch|money`, in the address) and its counts are counts of the record, never of the page. Every shortened value carries a copy button (`CopyValue.vue`) that copies the whole string and confirms in place. Old addresses redirect: `/crm/analytics` → `?subject=sessions`, `/crm/product` → `/crm/numbers`, `/crm/services` → `/crm/machines`, `/crm/product/users/{id}` → `/crm/installs/{id}`. Two desk-only rail items sit beside the five lenses: **API-ключи** (`/crm/api-keys`) inventories LainOS grants and issues a free, gate-exempt instance key on an operator action; the plaintext is returned once while the table retains only its prefix and hash. **Макет** (`/crm/mockup`) serves the artboards the console was drawn as out of `resources/console-mockup/` — frozen source nothing imports, each one framed in a `sandbox=""` iframe because an artboard is a whole page of its own CSS; the request names a key the manifest already knows, never a path. Access to all of it is two accounts named twice in `config/crm.php` (`admin_wallets` = the key, `admin_user_ids` = the person, env-only and empty by default), and anyone else gets a 404 rather than a 403 so the console is not discoverable.
- Retention analytics (DAU/WAU/MAU, new vs returning, weekly cohorts, progression health) live in `App\Services\UserAnalyticsService` and feed the console's `sessions` subject (`/crm/numbers?subject=sessions`).
- Product analytics for the wallet is a second, separate system: `/crm/numbers` (+ `/crm/installs/{uuid}`), `docs/product-analytics.md`, `config/analytics.php`, `App\Services\Analytics\*`, `Api\AnalyticsIngestController` (`POST /api/analytics/{events,funding}`), `resources/js/lib/analytics/*`, tables `analytics_{users,sessions,events,addresses}`. It answers acquisition → onboarding → funding → activation → retention for *installations of the wallet*, while `site_events` answers whether a browser reading cyberia.church converted; the two subjects differ, so they are not merged. The identity is an anonymous UUID the client mints on first run — **never a blockchain address**, because one person holds several and counting them would multiply every user. `App\Services\Analytics\EventTaxonomy` is the single source of truth for the event whitelist, the property allowlist and the definition of a *meaningful action* (settled on chain; broadcast is not settlement, unless the chain adapter declares it cannot watch), mirrored in `resources/js/lib/analytics/taxonomy.ts` and pinned to it by `tests/Feature/Analytics/EventTaxonomyTest.php`. North Star = Weekly Active Funded Users. Never define "active", "funded" or "activated" in a query — use `EventTaxonomy::MEANINGFUL` and the write-once milestone columns. Never derive sponsored-gas cost from a client event: it is summed from `gas_sponsorships.amount_wei`. Never add a property key without adding it to both allowlists, and never one whose value could identify a single transaction. Two exclusions are applied to every product number by default and reported on screen: internal installations (`analytics_users.internal_at`; `InternalTraffic` excludes whole sessions from `site_events`) and `amount_usd` from trades whose price impact exceeds `analytics.notional_max_price_impact` — see `docs/product-analytics.md` §20. Never remove an exclusion silently and never apply one silently; `?internal=1` restores ours. The client starts only on a wallet surface (`isWalletSurface()` in `app.ts`) — do not start it on every navigation again, that is what made site visitors into wallet installations — but attribution is captured everywhere via `rememberAttribution()`. `EventTaxonomy::PROVES_WALLET` keeps `wallet_created_at` from being null under a later milestone; `analytics:repair` backfills.
- Service monitoring and usage is a third, separate system: `/crm/machines`, `docs/monitoring.md`, `config/monitoring.php`, `App\Services\Monitoring\*`, `Api\OpsHeartbeatController` (`POST /api/ops/heartbeat`), `scripts/ops/heartbeat.sh`, tables `service_{checks,incidents,heartbeats}`, commands `services:check` and `services:prune`. It answers "is every program in this project running, and is anyone using it" — neither of which `site_events` or the wallet funnel can see. `config/monitoring.php` is the single source of truth for what exists; **add a service there, never in a migration**. Laravel runs in a container, so host-side facts (containers, tmux, load, disk, cron logs) are pushed by a one-minute host cron behind `OPS_HEARTBEAT_TOKEN`; everything reachable is pulled in one `Http::pool`. Rules that must not be relaxed: `ServiceProbe` is **read-only** — never make a probe restart, fund or fix anything, it runs unattended every five minutes; `unknown` means *we could not find out* and must never open an incident or count as downtime; alerts fire on **transitions** only and are stamped `notified_at` only on a delivered message; a chain's health is the **age of its head**, never an HTTP 200; a container's health includes its **restart delta between sweeps**, never its instantaneous state; and usage has three outcomes — `used`, `unused`, `unmeasured` — where folding `unmeasured` into `unused` would condemn every service whose traffic is recorded in someone else's access log.
- **What LainOS did is on the board too** (`POST /api/crm/tasks`, `Api\CrmTaskIngestController`, `config/crm.php` → `ingest`, column `crm_tasks.external_id`, and `services/lainos/src/plugins/crm/` at the other end): the daemon forges wishes, takes profit, fires watches and brings back digests on a machine this app cannot see, and until now all of that existed as a Telegram message that scrolled away — so the board that answers *what is this project doing* answered only for the work three people typed in. It is the heartbeat's gate (a shared token compared in constant time, no token = 404) with the heartbeat's rule: **facts, never instructions** — a record cannot assign an operator, cannot set a deadline, cannot reach a contact and cannot edit a task that already exists, so the worst a stolen token buys is visible, deletable noise. The **id is the sender's** (`lainos:trade:0x…`), because a daemon retrying a request whose answer it never saw must not write the same line twice; repeats are answered with the row that exists. Two statuses and no third: `open` for something a person still has to do (a wish stays open after the forge builds it — nothing there pushes, so it is waiting on somebody to read the commit and publish it), `done` for something already finished, which is a log line under the board. Machine rows are excluded from the board's **median task life** — they arrive already closed, so counting them would drag the one number that says whether the board is a plan or a graveyard to zero. On the LainOS side it is off unless `LAINOS_CRM_URL` is set, the outbox is durable (`data/crm.json`, drained oldest-first, a 4xx dropped so it cannot wedge the queue and a 404 retried because that is the ingest's own token being unset), and the first run **adopts** the existing wishboard and journal instead of filing a year of history.
- The prediction-market oracle is `predictions:resolve` (every five minutes, `App\Services\Predictions\*`, `config/predictions.php`). The contract accepts bets from anyone but gives its oracle a hard 30-day window after a market closes, after which resolution is permanently impossible — so the scheduled command is not a convenience, it is the only thing keeping markets settleable. A question either answers itself or waits on a person: `resources/js/lib/predictions.ts` and `PredictionQuestion.php` are **byte-identical mirrors** of one format (prose plus a trailing `[px:SOL>80@coingecko]` tag), and a market created in a browser that the server cannot parse is a market nobody can settle — change one file and you change both, keeping the shared vectors in `tests/Frontend/PredictionQuestionTest.mjs` and `tests/Feature/Predictions/` green. Tagged markets settle from the first quote read after close and the comparison is strict; untagged ones are reported to Telegram daily and cancelled (full refunds, no fee) shortly before the window would strand them. Keep `plan()` pure and clock-injected — it is where the money is decided — and keep signing in `crypto/hardhat/scripts/predictions-resolve.ts`, which has no opinion about outcomes and shares the relayer key, so its transactions stay strictly sequential.
- The unified multichain wallet (`/wallet`, `resources/js/lib/wallet/`, screens in `resources/js/components/wallet/`) is non-custodial and lives entirely in the browser: one BIP-39 seed phrase, one chain adapter per network in `chains.ts` (every EVM network — Cyberia, Robinhood, BNB, Base — on BIP-44 coin type 60 and therefore sharing one address; Solana and Monero on SLIP-0010; Bitcoin and Litecoin on BIP-84), the phrase AES-GCM encrypted in localStorage. Balances, history, fee quotes and signing are browser-side too; Laravel only serves the Solana RPC endpoint (its own relay, see below), cached USD quotes and the saved XMR payout address. Never route a seed, phrase or private key through Laravel, an Inertia prop or a log line. Derivation vectors, amount formatting, QR encoding and history parsing are covered by `npm run test:frontend` (`tests/Frontend/*Test.mjs`, run with the `@/` alias hook).
- Browser-side Solana goes through this app's own relay (`POST /api/solana/rpc[/{cluster}]`, `App\Services\SolanaRpcProxy`, `Api\SolanaRpcController`, `config/solana.php`). Solana's public cluster answers a server and refuses a browser — the same JSON-RPC call comes back `403 Access forbidden` as soon as it carries an `Origin` header — and the endpoints that do answer browsers want an api key in the URL, which in a bundle is a key anyone may spend. So the page asks Laravel and Laravel asks Solana. It holds no Solana key and signs nothing: a transaction arrives already signed. Upstreams are tried in order (keyed first, public cluster last), so an exhausted key costs latency rather than availability; the method allowlist is the gate, because a name says nothing about a call's cost (`getProgramAccounts` reads a whole program's state); only chain-wide reads are cached, never an account read and never a write, since behind a relay the public cluster's per-IP limits are this server's for every visitor at once. Never hardcode a Solana endpoint in the frontend again — `@/lib/solanaRpc` is the one source, and `confirmSignature()` there replaces `Connection.confirmTransaction()`, which would open a WebSocket the relay cannot be.
- The Bitcoin family is built and signed in-browser (`lib/wallet/utxo.ts` plus `bech32.ts`/`base58check.ts` — no third-party Bitcoin dependency): P2WPKH only, BIP-143 sighash, coin selection largest-first, dust folded into the fee, broadcast through an Esplora API (mempool.space, litecoinspace.org). A browser cannot speak the Electrum protocol, so every UTXO endpoint must be a CORS-open HTTPS Esplora root. Everything in that file is pinned to the BIPs' own vectors in `tests/Frontend/WalletUtxoTest.mjs`; do not change an address, digest or signature path without those staying green. Legacy/P2SH accounts derive and receive but are deliberately not signed.
- ERC20 tokens on EVM networks live in `lib/wallet/erc20.ts` and `tokenList.ts`, surfaced by `components/wallet/TokenList.vue` inside the network screen — a token shares the network's account, address and gas coin, so it is never a card of its own in the portfolio. Never hardcode a token's decimals: they come from the chain's Blockscout `tokenlist` index or from `decimals()` on the contract, because Cyberia's own USDC and USDT are six-decimal and a guessed eighteen is off by a factor of a trillion. Sending estimates gas but never exceeds `ERC20_TRANSFER_GAS_CAP`, which is the figure the fee quote and the signing sentence promised. Fee quotes are per asset — `wallet.feesFor(chain, token)` — and "not enough token" and "not enough gas" are separate states, since holding USDC with no CYBER is the failure people actually hit. The same rows read two ways: inside the network screen, and as one cross-network roll-up in `WalletTokens.vue` (portfolio → Tokens, one section per token-capable chain) whose rows open `WalletToken.vue` — balance, value, decimals, contract, and whether the row came from the chain's index or from the user's own hand. There is no price chart on that screen and there should not be one: the wallet receives point-in-time pool quotes, so any curve between them would be invented.
- `components/wallet/WalletAnalytics.vue` (portfolio → Analytics) is computed entirely in the browser out of balances and quotes the page already holds — nothing about a vault's composition is sent anywhere to be analysed. It shows allocation per holding, the split between network coins and tokens, and a seven-day transfer histogram built from the histories already loaded. Holdings that could not be priced are counted and named as excluded instead of folded in at zero, and the histogram states how many of the networks have an index a browser can read at all. There is deliberately no value-over-time curve: nothing keeps a history of this vault, and a chart drawn from a single snapshot would be a claim about the past that nobody made.
- The wallet ships knowing **120 further EVM networks** and starts with all of them switched off (`lib/wallet/catalogue.ts`, screen `WalletNetworks.vue`, `setCatalogueWalletChains()` in `chains.ts`, hues `--cw-net-cat-1..8` in `wallet.css`, pinned by `tests/Frontend/WalletCatalogueTest.mjs`). The seed already derives every one of them — coin type 60 is one key — so a switch is never about accounts; it is about whether the portfolio draws a card and reads a balance on each refresh, and 120 cards reading 120 balances is a load test rather than a portfolio. That is the whole reason the default is off, and it is what the screen says. A catalogue entry is an **endpoint plus a promise**, both verified against the live network before the row was written: the RPC has to answer a request carrying a browser `Origin` with its own chain id (a node that answers curl and refuses a page is a network that would render as permanently unreachable), and where a keyless Blockscout index answers the same `tokenlist` call the built-ins use, the row carries it — about a third do, and the rest declare `tokensNote`/`historyNote` instead of drawing an empty list. **The file is generated from those probes; do not hand-edit a row into it without running the same checks.** Catalogue chains go through the *same* `evmChain()` factory as Cyberia and Base (which now takes explicit `params` for chains outside `lib/evmChains.ts`, so a wallet-only network never has to be pushed into the site's chain picker), and they are **not** `custom`: a user-added network is dashed because nobody vetted its endpoint, and blurring the two in either direction is a lie about the only thing that separates them. `walletChains()` is now built-ins + catalogue + custom, in that order. Ids and two-letter tags are unique across the whole set, because the tag is what a colour-blind reader actually reads off the tile; the hue is one of eight picked by chain id, since a per-chain colour would be invented information.
- Users can add networks themselves (`lib/wallet/customChains.ts`, screen `WalletAddNetwork.vue`): an EVM chain by chain id + HTTPS RPC, or a Bitcoin fork by SLIP-44 coin type + address type + prefix + Esplora API. The record is stored in localStorage and the account is re-derived from the vault, so removing a network forgets an endpoint and never coins. Custom chains are layered over the built-in registry via `setCustomWalletChains()`; `walletChains()` is the combined list and `WALLET_CHAINS` is the built-ins only. Every user-added network is marked `custom` and drawn violet + dashed, and its unverified-endpoint warning appears on receive and above the send form.
- The `$LAIN` holders' room (`components/wallet/WalletLain.vue`, `Api\WalletLainController`, `/api/wallet/lain/{nonce,verify,chat}`) is a chat with Lain gated on a *balance*, not an account: the wallet reads its share of the live `$LAIN` supply from the contract in the browser first, and only sends an address anywhere once the user chooses to open the room. Opening it signs a challenge the server composed (EIP-191, one-shot nonce, wording deliberately unlike the login message so a proof can never be replayed against `/api/wallet/verify`), the address is recovered server-side and its share re-read from the chain on **every** turn — an expired proof or a sold-out balance closes the room mid-conversation. The transcript lives in localStorage (`lib/wallet/lainChat.ts`), is replayed to the model as capped context and is never stored by Laravel; it is cleared with the vault. Threshold and contract come from `services.lain.*`, shared with the account-based `/lain` chat.
- The **inference API** (`/api/ai/v1`, `config/ai.php`, `App\Services\Ai\*`, `App\Http\Controllers\Api\Ai\*`, `AuthenticateAiApiKey`, docs in `docs/ai-api.md`) is OpenAI-compatible on purpose: an existing client changes its base URL and its key and nothing else, `stream: true` included. It is a gateway, not a proxy — the model catalogue is an **allowlist** of Cyberia ids mapped to a provider and an upstream id, because the account being spent is ours; an unknown id is a 400, never a bill, and a model whose provider is not configured drops out of `/v1/models` instead of failing at request time. The provider registry mirrors free-claude-code's 49 OpenAI-compatible upstreams; credentials stay server-side, local providers are explicitly enabled, and provider quirks (headers, token field, URL composition) stay declarative in `config/ai.php`. Each model names the one it **falls back** to on a rate limit, a timeout or a vanished model — followed at most once, never after the first byte of a stream, and reported as `served_by` rather than hidden. Access is a holding, not a signup: keys are issued to an address that signs a challenge (EIP-191, one-shot nonce, worded so it cannot be replayed at `/api/wallet/verify` or the holders' room), stored only as a SHA-256, and re-checked against the chain on **every** request (`AiHolderGate`, default $LAIN ≥ 0.5% of supply — far below the room's 10%, since an API is not a room). The gate fails closed: an unreadable RPC is a 503, not an open door. Listing and revoking need the signature but not the holding, so someone who sold out can still kill what they left behind; Cyberia's own daemons get `ai:key issue … --service` keys that skip the gate and nothing else. Quotas are per key (`AiUsageMeter`: minute in the rate limiter, day counted from the log, so a cache flush cannot reset it), `max_tokens` is clamped rather than refused, and the metering table has no column a prompt could go in — `ai:prune-usage` drops it after 90 days. Errors are OpenAI's envelope throughout, and an upstream 401 surfaces as a 502 because the rejected key was this server's, not the caller's. Covered by `tests/Feature/Ai/AiApiTest.php`.
- The **paid door** to that same URL (`config/x402.php`, `App\Services\X402\*`, `X402Paywall`, table `x402_payments`, command `x402:check`, tests `tests/Feature/Ai/AiX402Test.php`) is [x402](https://docs.x402.org): a holder proves a position, but an agent arriving for the first time has no account, no key and nothing held, and can simply pay a cent for the call. One exchange, entirely in headers — an unpaid request is answered `402` with the terms base64'd into `PAYMENT-REQUIRED`, a request carrying `PAYMENT-SIGNATURE` is verified with a facilitator before the work and settled with it after, and the transaction is reported in `PAYMENT-RESPONSE`. **This host holds no wallet and signs nothing**: verification and settlement belong to the facilitator, which is the party that pays gas and broadcasts, and that is the whole reason accepting USDC on Base costs no key, no RPC and no nonce here. It is also why the facilitator is *chosen* and not implied — the default `https://x402.org/facilitator` serves Base **Sepolia** only, so quoting mainnet terms against it is a paywall that collects nothing, which `x402:check` reports before a caller has to discover it. Order is the design: verification is free and precedes the work, so a bad authorization costs nothing upstream; settlement follows the answer but precedes its first byte — a `StreamedResponse` has already pulled its first chunk by the time the middleware sees it — so a failed answer is never charged for, and an answer whose payment did not settle is returned as a 402 rather than given away. The requirements handed to the facilitator are always rebuilt from this server's config and never read back from the caller's payload, since a payer's copy of the terms is a payer's opinion. Prices are flat per call because `exact` charges before the token count exists; metering a call to its actual usage is the `upto` scheme's job and is deliberately not implemented. The two doors never overlap — a key skips the paywall, a payment skips the key **and** the holding — and the metering row names whichever one paid (`ai_api_requests.x402_payment_id`), while an unsettled `x402_payments` row is the record of money promised and never collected.
- Wallet-to-wallet **end-to-end encrypted chat**, addressed by EVM address (`lib/wallet/chatCrypto.ts` + `chat.ts`, `components/wallet/WalletChat.vue`, `Api\WalletChatController`, `/api/wallet/chat/{nonce,verify,keys,keys/{address},messages}`). Laravel is a relay for ciphertext it has no key for, and that is structural: the conversation key is an ECDH between two wallets' messaging keys and neither half is ever sent anywhere. Three rules hold it up. **The messaging key is not the spending key** — each account derives a separate secp256k1 key from its EVM private key by one-way hash (`evmChatKey` in `keys.ts`), so it needs no backup of its own and its compromise reveals conversations, never funds; a `watch` account has none and cannot chat, exactly as it cannot spend. **The directory is not trusted** — an address is a hash and cannot be encrypted to, so keys are published with an EIP-191 signature over a statement naming address *and* key, and `lookupChatKey` re-verifies every record before use and pins it on first sight, so a hostile relay can withhold a key but never substitute one; the statement in `chatKeyStatement` and in `WalletChatController::keyStatement` must stay byte-identical or the whole directory is invalidated. **There is no forward secrecy and the metadata is not private** — the key is static, so whoever obtains an account's key reads its history, and the relay sees who talks to whom and when; the UI says both. Pinning is not verification, so the thread's fingerprint opens a **safety-number screen** where two people compare the same twelve groups out of band; the result is stored on this device only (`verifiedAt` on the pinned record, `markChatKeyVerified`/`chatKeyVerifiedAt`) and is dropped the moment that address publishes a different key — a check carried across a re-key would turn "we compared these" into "this address was verified once", which is the claim an interception wants to inherit. Messages are AES-GCM with the id, sender, recipient and timestamp as AAD (a relay that rewrites any of them produces a message that fails to open, never a plausible lie), padded to 256-byte blocks, and cached on the device as *ciphertext* so a locked wallet holds no readable mail. Reading a mailbox proves the address the same way the holders' room does; `sent_at`/`issued_at` are stored as strings because a signature covers those exact characters. The relay is a queue, not an archive — `wallet:chat-prune` and `config/wallet.php`. Pinned in `tests/Frontend/WalletChatTest.mjs` (the encryption, including what must fail) and `tests/Feature/WalletChatRelayTest.php` (what the server can still get wrong).
- A vault holds several accounts (`lib/wallet/accounts.ts`, `WalletAccounts.vue`, `WalletImportAccount.vue`). Four kinds, and the distinction is not cosmetic — it is what the user's one backup covers: `seed` (a BIP-44 account off the vault phrase, present on every network at once), `phrase` (a second phrase imported whole: its own root, needing its own backup), `key` (one private key, one chain, this device only) and `watch` (an address, `capabilities.send` forced to false so no send screen can build a transaction that dies at signing). Every screen that spends from a non-`seed` account has to keep saying which it is. The account number goes wherever that ecosystem puts it — the address segment on EVM, the account segment on Solana and the Bitcoin family, nowhere on Monero, which numbers subaddresses — via `chain.path(index)` and `WalletKeySource`; keep `deriveAccounts(phrase, record)` and `useMultiWallet`'s `sourceFor()` the only two places that branch on kind. **The vault seals a JSON document now, not a bare phrase** (`VaultContents`, record `version: 2`), because an imported private key has no business being less protected than the seed; `unsealVault()` hands back a `reseal` closure over the derived AES key so account changes never re-prompt for the password and the password itself is never kept. Vaults written before accounts (`version: 1`, plaintext = the phrase) still open and are migrated only when something is written; `tests/Frontend/WalletVaultTest.mjs` builds one by hand to pin that.
- Feed, DAO and profile inside the wallet are read-only because the wallet has no session, not because they are unfinished (`Api\WalletSocialController`, `GET /api/wallet/{feed,dao,dao/proposals/{id},profile/{address}}`, client `lib/wallet/social.ts`). There is nobody here to post, comment or vote as — say so on the screen and link out to the site rather than drawing a control that cannot work. Return only what the equivalent public page already renders; these endpoints must never become a way to read something `/dao`, `/feed` or a user profile would not show a stranger. Vote bars are drawn from **voting power** and never from the number of voters (`tally()` in `social.ts`, pinned in `tests/Frontend/WalletSocialTest.mjs`), and an address nobody has claimed is a first-class answer rather than a 404.
- A Launchpad token's uploaded page is pinned to IPFS and addressed by its CID (`App\Services\IpfsService` over the Kubo API in `services/ipfs/`, `App\Services\LaunchpadSiteService`, `config/ipfs.php`, `launchpad_tokens.ipfs_cid`). The copy served on `<subdomain>.cyberia.church` is a mirror and says so — it carries `Link: <gateway>; rel="canonical"` — while `site_url` falls back to the gateway link, not a path on this host, for a site whose creator never claimed a name. The page is wrapped in a directory as `index.html` so a bare CID renders as a site instead of a download, and replacing the page clears the old CID, which named the old bytes. Pinning is **best-effort by design**: a creator's upload must not fail because the node is restarting, so a failed pin is logged, the page is stored anyway, and `launchpad:pin-sites` (hourly, `--force` to re-pin everything onto a fresh node) fills in whatever is missing a CID. A launch also carries an X account, a Telegram and a website (`x_handle`, `telegram_handle`, `website_url`, written at create time or edited later behind the same wallet signature as the rest of the metadata). Handles are stored **bare** through `App\Support\Handles`, the way the console stores a contact's, so `@name`, `name` and a pasted profile URL collapse to one value and the API answers with both the handle and a link; the edit form always submits all three fields, because sending one back empty is how a link is removed.
- Cyberia V3 trading in the browser (`lib/dexV3.ts`, per-chain `v3` block in `liquidityChains.ts`, `tests/Frontend/DexV3Test.mjs`). v2 and v3 hold real liquidity on the same chain, so `/swap` quotes both and takes the better answer; the venue and the pool's own fee are shown with the quote. Pool addresses are derived by CREATE2 over the **pool deployer** (not the factory) against `POOL_INIT_CODE_HASH` — a stale hash silently addresses nothing, so the constant is pinned to an address the contracts derived themselves. The fee in a pool key is the **tier**, never what the pool charges: this fork's fee is mutable, and `v3RouteFeePct` reads `pool.fee()` for exactly that reason. Quotes are `staticCall`s on QuoterV2 because tick-spread liquidity has no closed form. `v3Swap()` holds the signing side, including the `multicall` the coin legs need (`unwrapWETH9` out, `refundETH` on an exact-output overpayment). `crypto/hardhat/scripts/v3-seed-pool.ts` opens a treasury market: the pool is created **from the EOA**, because the factory records whoever called `createPool` as its creator and the position manager can never spend that record.
- Swapping Monero, two routes at once (`config/moneroswap.php`, `App\Services\Monero\MoneroSwapService`, `/api/wallet/monero/swap[/quote]`, `lib/wallet/moneroSwap.ts`): our own bridge-then-DEX route and a partner exchanger, quoted after every fee, better one marked, neither presented as the safe one. Cyberia's share is taken on both and composed server-side — a fee a browser can write is a fee a browser can delete — and the displayed figure is always the one that came back in the quote (`fee_applied` false is printed, not absorbed). An unavailable route is listed with its reason, so the comparison ships before the Monero corridor opens.
- The wallet's launchpad screen (`lib/wallet/launchpad.ts`, `WalletLaunchpad.vue`) reads LaunchpadNative on Cyberia directly from the browser through `lib/launchpadChains.ts`. Cyberia runs a *fair launch*: the native coin that paid for a launch is burned into permanently locked liquidity, so there are no rounds, tiers, allocations, vesting schedules or caps — do not add UI for any of them. Buying a launched token is a swap and the wallet has one now: the detail passes the launch's contract to the swap screen, which reads the token from the chain rather than trusting the row that was tapped, and the DEX link stays beside it for the chart and depth this screen deliberately lacks. `poolQuote()` is kept pure so it can be tested: pair reserves are ordered by token address, and taking `token0` the wrong way round silently inverts every price on the screen.
- **Swapping and wrapping** live on one screen and are never blurred into one act (`components/wallet/WalletSwap.vue`, `lib/wallet/swap.ts` and `lib/wallet/wrap.ts`; an overlay like send/receive, opened from the portfolio, a network, a token or a launch). A swap is exact-input against the QuickSwap fork in `lib/liquidityChains.ts` — the one registry `/swap`, `/liquidity` and the wallet now share, extended with each chain's routing `hubs` so all three route through the same assets. Rules that must not be relaxed: **the route is searched, not assumed** (`swapPaths()` builds candidates over the factory's own pair graph — direct, one hop, two hops, plus hubs — and every candidate is priced by `getAmountsOut`, because a pair with no direct pool is a hop away and not "no liquidity"); **the quote does not survive the hold, the floor does** (`applySlippage`, default 0.5%, is what `swapExact*` is signed with, so a moved pool reverts the swap instead of executing it at a worse price); **allowances are exactly the trade's amount** and never `MaxUint256`, including the extra zeroing transaction USDT-style tokens demand, with both priced into the fee the user reads; **gas is capped at `SWAP_GAS_CAP`/`WRAP_GAS_CAP`**, which is what makes the quoted fee a promise, and a node that will not estimate falls back to that cap rather than to a guess. Wrapping is `deposit`/`withdraw` on the chain's WETH9 (`WCYBER` on Cyberia, aeWETH on Robinhood): one for one, no route, no slippage, no impact — `wrapDirection()` recognises a coin-and-its-own-wrapper pair and moves it to the wrap tab instead of asking a router to price a pool that cannot exist. Every gas price comes from the chain adapter's `chain.gasPrice(tier)` so Cyberia's 1.5 gwei pool floor lives in exactly one place. Decimals are never assumed here either: a token the wallet does not hold is read from its contract when it is chosen. The pure parts — `swapPaths`, `applySlippage`, `priceImpactPct`, `wrapDirection` — are pinned in `tests/Frontend/WalletSwapTest.mjs`. The composer also draws **the pair's own history** — the quote's route resolved through `lib/wallet/marketHistory.ts` and replayed out of the pools' `Sync` events, keyed on the quote's `path` so the strip and the trade can never come from two different routes, loaded after the quote and absent entirely when the pools have never traded (a flat line is a claim about the price rather than about the data). A quote now also carries the routes it **beat** (`SwapQuote.alternatives`): the search priced every candidate and threw the losers away, and keeping three of them is the only way the screen can say "the best of several" instead of asserting one path. Both route lists read through one `symbolsOf()`, so the wrapped native keeps its own ticker in all of them — a path that said CYBER where WCYBER is would name a pool that does not exist.
- **Cross-chain swaps** are the other question and a separate screen (`components/wallet/WalletCrossSwap.vue`, `lib/wallet/crosschain.ts`, `App\Services\CrosschainRouter`, `Api\WalletCrosschainController` on `/api/wallet/crosschain{,/tokens,/quote,/status}`, `config/crosschain.php`). Cyberia's liquidity is on Cyberia; "USDC on Base for SOL on Solana" needs somebody holding both sides of every pair anyone might name, so a router is asked — Relay, chosen for one reason: its app fee is a field in the quote request paid to an address we name, needing no account anywhere, while LI.FI answers a quote carrying a fee with `Integrator "cyberia" is not configured for collecting fees` until somebody registers a wallet in a portal nobody on this host can see. Rules that must not be relaxed: **the fee is composed on the server and never read back from the request** — a field a browser writes is a field a browser deletes, which is why the quote goes through Laravel at all — and it is **clamped to `fee.max_bps`**, because a typo in an env file is the realistic way somebody gets charged 30% of a transfer; **the fee shown is the one in the answered quote, never the configured one** (`crossFeeShareBps` computes it from the two amounts; a router that caps, rounds or declines it makes `feeApplied` false and the screen says so); **only the fields of one transaction reach the signer** (`presentQuote` strips each step item to `to`/`data`/`value`/gas, so a `from` that is not this account or a field added next month never lands in `sendTransaction`), and a step naming another chain is refused outright; **the origin leg is EVM and switched on in this wallet**, which is where both the endpoint and the balance the user already saw come from; **the destination is a chain this wallet can validate an address on** — EVM, Solana, Bitcoin — because a cross-chain swap has no cancel and a typo into an unvalidated string is final, so TON, Tron and XRP are listed with that as their reason rather than dropped. No key lives on this side and nothing is signed there: the deposit goes from the user's own address to the router's contract, which is the sentence sitting above the hold. `CROSSCHAIN_FEE_ADDRESS` is env-only and deliberately not the bridge relayer, whose nonces are already contended; unset means no fee is asked for and every screen says so instead of showing a number nobody collects. Pinned in `tests/Frontend/WalletCrosschainTest.mjs` (eligibility, the fee share, the wire form) and `tests/Feature/WalletCrosschainTest.php` (who gets to write the fee).
- The NFT tab is one tab holding three screens that are one sequence — get a file, give it an address, own it (`WalletNft.vue`, `WalletNftMint.vue`, `WalletIpfs.vue`, `WalletTorrent.vue`, `lib/wallet/{nft,ipfs,torrent}.ts`, registry `lib/nftChains.ts`). **Minting** goes into `CyberiaNFT` (`0x546462FAbf30734E63b64f32B30EC8ADD9B6EBa7` on Cyberia, `crypto/hardhat/deployments/cyberia-nft-market.json`), one ERC-721 anyone may mint into with the tokenURI supplied at mint time — so a token can be a CID, a link or a line of text, and nothing in that path may assume an image exists. Metadata is composed in the browser (`buildMetadata`), the mint is quoted against the real URI before the hold-to-sign (the URI's length is most of the gas) and refused above `MINT_GAS_CAP`, exactly like `sendErc20`; what an address owns is read from Blockscout's keyless v2 `nft` endpoint, which resolves the metadata in the same request. **Pinning** is the one thing the server actually performs for the wallet (`Api\WalletIpfsController`, `POST /api/wallet/ipfs/{file,page}`, caps in `config/wallet.php` under `ipfs`, surfaced to the page as the `ipfs` Inertia prop): the Kubo API can run any node command, so it stays on localhost and the bytes travel through Laravel, which pins them and returns a CID and nothing else. A page is wrapped as `index.html` so the bare CID renders as a site, like a launchpad token site. `WalletIpfsController::guard()` is the single place a holding gate or an allowlist would slot in. **Torrents** are real only in the desktop shell and that is physical, not a choice: the mainline DHT is UDP and peers are TCP, and a web page has neither — so `torrentBridge()` is feature-detected, and everywhere else the screen explains why and links to `/download` rather than shipping a WebRTC-only client that finds nobody. Pinned in `tests/Frontend/WalletNftTest.mjs` and `tests/Feature/WalletIpfsPinTest.php`.
- The tracker is a BitTorrent tracker whose listings are tokens (`/tracker`, `/announce`, `/scrape`, `docs/tracker.md` is authoritative, `config/tracker.php`, `App\Services\Tracker\*`, `App\Support\Bencode`, tables `tracker_{releases,peers}`, commands `tracker:prune` hourly and `tracker:sync` daily, wallet screens `WalletTracker.vue` + `WalletTrackerPublish.vue`, public page `pages/Tracker.vue`, client `lib/wallet/{tracker,bencode}.ts`). **The rule the whole thing rests on is `no token, no release`.** `POST /api/tracker/releases` accepts exactly `chain_id` and `token_id`; the server reads `ownerOf` and `tokenURI` from the chain in `config/tracker.php` (Cyberia only — the point of the check is that this host can perform it), fetches the document behind that URI (`ipfs://` through the read gateway or https, with a timeout, a size cap and no other scheme) and parses it with the pure `ReleaseMetadata`. The document is ordinary ERC-721 JSON with one extra `torrent` key — info hash, name, length, files, magnet, category — mirrored into `attributes` so a marketplace that never heard of this index still renders something; a magnet naming a *different* torrent than the token does is discarded and rebuilt from the info hash, because that mismatch is the one way a listing could show one thing and hand out another. One info hash is one release, re-registering the same token picks up a new owner (a token is transferable and a sold release moves with it), and a takedown is `hidden_at` and never a delete — the token cannot be unminted, and a deleted row could be re-registered by anyone the same minute. **The announce endpoints are not part of the site**: they are registered in `routes/tracker.php` through the `then:` callback in `bootstrap/app.php`, outside every middleware group, because clients call them several times an hour and a session cookie per announce is a session record per announce. Three things there are load-bearing rather than stylistic — every refusal answers **200** with a bencoded `failure reason` (a 4xx is reported by clients as "tracker is down" and the sentence is never seen); the query string is decoded from `QUERY_STRING` by `AnnounceRequest::pairs()` with `rawurldecode`, since an info hash is twenty arbitrary bytes and framework input handling trims the ones starting with 0x20; and an announce for an info hash nobody minted is refused, because an open tracker is a stranger's infrastructure by lunchtime. Peers come back compact (BEP 23, with IPv6 in `peers6` per BEP 7), a leecher is handed seeders first, and a peer that stops announcing is deleted — `tracker:prune` exists for the swarms nobody announces to any more, which would otherwise keep showing the seeders they had the day the last client closed. Covered by `tests/Unit/BencodeTest.php`, `tests/Feature/TrackerAnnounceTest.php`, `tests/Feature/TrackerRegisterTest.php` and `tests/Frontend/WalletTrackerTest.mjs`; the announce tests build every query string by hand because `http_build_query` writes a space as `+`, which is the exact bug the endpoint exists to survive.
- Creating and streaming a torrent is the desktop shell's job, and that is physics rather than a preference (engine version 2, `frontend/desktop/src/torrent-{rules,engine}.js` and `torrent.js`). `seed(mode)` has the page ask for a **picker**, never a path: the shell opens a native dialog, hashes what was chosen, writes its own site's `/announce` into the torrent (derived from `APP_URL`, never accepted from the page) and seeds the files where they already are. `stream(infoHash, index)` hands back a `cyberia-media://` URL — a scheme registered `secure`/`standard`/`stream` before app ready and handled only on the shell session, proxying to WebTorrent's loopback server with `Range` forwarded — because the wallet is served over https and a media element there cannot load `http://127.0.0.1` (mixed content, blocked with no visible error), and because a download in progress is a sparse file whose holes play as garbage. The loopback server is bound to `127.0.0.1` and refuses any request whose `Host` is not that, which closes DNS rebinding from any browser on the machine. `openFile()` hands one file to the system player, which is the honest answer for Matroska and AVI.
- The wallet's media player is `components/wallet/WalletPlayer.vue` over the pure `lib/wallet/player.ts`. One `<video>` element serves video and audio both — two elements would mean two volumes and a gap of silence whenever a playlist crossed from a film to its soundtrack — and the controls are drawn rather than native because the native ones cannot say *why* nothing is playing: a stream still being asked of a swarm, a container no browser ever decoded, and a file whose peers have not arrived are three different problems that all look like a black rectangle. `formatSupport()` says which containers this engine will refuse **before** anything is tried, and `MEDIA_ERR_SRC_NOT_SUPPORTED` says it after. A track's URL is resolved at the moment it is played and never when the list is drawn, because asking for a stream tells the client that file is urgent and doing it for forty files at once downloads none of them. `tracksFromRelease()` returns only what the publisher pinned to IPFS, which plays in any browser with no client at all; `tracksFromTorrent()` reads the file list from the engine rather than from the release's metadata, since the index a stream is asked for has to be an index into the torrent this client actually holds.
- **Sponsored fees** are the answer to the one failure the wallet already names as its own state — holding USDC with no CYBER (`crypto/hardhat/contracts/CyberiaGasStation.sol` + `scripts/{deploy-gas-station,gas-station}.ts`, `App\Services\GasSponsorService`, `Api\WalletGasController` on `/api/wallet/gas{,/claim}`, `config/wallet.php` under `sponsor`, `lib/wallet/gas.ts`, `components/wallet/GasSponsor.vue`, table `gas_sponsorships`, command `gas:station`). The mechanism is a drip and not a meta-transaction, and that is the load-bearing choice: the station sends the address a fixed amount of CYBER and the user signs the transaction they were already building, so sends, token transfers, swaps, mints, votes and every screen nobody has written yet are covered by one thing, and no signing path — none of which is cheap to get right twice — is touched at all. Rules that must not be relaxed: **the contract owns the limits** (fixed drip, balance ceiling, per-address cooldown, daily cap, pause, operator allowlist), because the sponsor key lives on a web-facing server and the tank must not be that key's to empty; **the server owns eligibility**, and the gate is the problem restated — the address already owns something on Cyberia (or has a site account), since an empty address has nothing to move and a bot would have to fund every sybil address with more than the drip is worth; **an unreadable index is not "owns nothing"** and an unreadable station is not "empty", so both fail closed and say which; **the sponsor key is dedicated** and never `BRIDGE_RELAYER_PRIVATE_KEY`, which is shared with the Telegram minter and the DCA bot and already loses nonce races, and because that key pays the gas delivering each drip it needs a balance of its own — `gas:station --alert` watches it and the tank, hourly, because both fail silently and a wallet that never offered anything gets no bug report. The request carries no signature and should not grow one: a drip can only arrive at the address named in it, so a signature would prove possession of a key anyone can generate for free and would cost a real person a tap. Cyberia only. The pure parts (`canAskForGas`, `dripCovers`, `sponsorReasonKey`) are pinned in `tests/Frontend/WalletGasTest.mjs`, the contract in `contracts/CyberiaGasStation.t.sol`, the gate in `tests/Feature/WalletGasSponsorTest.php`. One rule the station taught the wallet, and it belongs to sends rather than to sponsorship: **a native transfer to a contract is not 21000 and must never be estimated here**. Cyberia's node prices a value transfer with empty calldata at 21000 whether or not the recipient has code — it does not run the `receive()` the transaction will run — so a wallet that believes it signs a transfer that reverts out of gas and keeps the fee, which is exactly how the first CYBER sent to the station was lost (real cost 22491). `nativeSendGas()` therefore *reads* `eth_getCode` and states `EVM_CONTRACT_SEND_GAS_CAP` (120000) for anything with code; unused gas is refunded, so generous costs nothing and tight costs the whole fee. The fee quote is keyed on the same answer (`feeKey(chain, token, toContract)`), because the sentence above the signature promises a number.
- Wallet UI rules, in order of importance: a number that could not be read renders as "—" and never as `0`; every signature is preceded by one plain-language sentence and a hold-to-sign control; the seed phrase appears only behind a held finger or a re-entered password, never passively; the phone gets seven destinations (wallet, chat, feed, launchpad, NFT, DAO, Lain) and everything that is a *way of reading your holdings* — tokens, analytics, accounts, security — and everything that is a thing *done* with them — gas station, bridge, cross-chain swap, earn, the dapp directory, networks, proxy & routing — is a place inside the wallet tab rather than an eighth label; networks are encoded by hue **plus** shape **plus** a two-letter tile carried on the chain adapter's own `mark` (square = EVM and every square shares one address, circle = Solana, diamond = Monero, soft square = Bitcoin family, violet + dashed = added by the user), and transaction status uses a separate amber/green/red family. The portfolio groups networks by that family. The surface stays dark in either site theme (`resources/css/wallet.css`, `cw-` namespace) and every string goes through `walletMessages`, in all three languages — a warning about custody or about what cannot be undone says the same thing in each.

---

## Ritual DEX Frontend

Path: `frontend/ritual/`

Stack:

- React 18
- Create React App via `react-app-rewired`
- TypeScript 4.1-era project with newer dependency types
- Material UI v4
- Ethers v5, Web3Modal, QuickSwap-derived swap code

Common commands:

```bash
cd frontend/ritual
npm install
npm start
npm run build
npm run test
npm run ipfs-deploy
```

Known build reality:

- Plain `npm run build` currently runs ESLint and TypeScript gates and can fail on existing lint/type drift.
- If the user explicitly wants a deployable artifact without code fixes, use:

```bash
cd frontend/ritual
DISABLE_ESLINT_PLUGIN=true TSC_COMPILE_ON_ERROR=true npm run build
```

- After any Ritual build, verify:

```bash
test -f build/index.html
test -d build/static
find build/static -maxdepth 2 -type f | wc -l
```

- `npm run ipfs-deploy` uses `ipfs-deploy build`. It may fail on modern Node with `RequestInit: duplex option is required when sending a body`; report that exactly rather than pretending deployment succeeded.
- Be careful with `frontend/ritual/build/`: it is an artifact directory. Only modify or deploy it when the user explicitly asks for build/deploy work.

---

## Native App Shells

Paths: `frontend/desktop/` (Electron), `frontend/mobile/` (Capacitor)

Both ship the Laravel site as an installable app. Neither bundles the frontend: they render `CYBERIA_APP_URL` (default `https://cyberia.church`) in a native window/WebView, so a production deploy is also an app update. The per-directory `README.md` files are authoritative.

**Both apps are the Cyberia wallet first.** They launch on `CYBERIA_APP_PATH` (default `/wallet`), and inside a native shell that route drops the site header and footer and fills the frame (`resources/js/layouts/NativeShellLayout.vue`, chosen in `app.ts` from `isNativeShell()`); everything else in the shell keeps the normal site chrome, and the wallet's masthead links back to the site. `/wallet` is a public route so the app works straight after install — the keys are browser-side and were never the server's to gate; signing in only adds the XMR payout binding. `CYBERIA_APP_PATH` is validated as a same-origin absolute path: a full URL or `//host` falls back to `/wallet` instead of repointing the app at another origin.

```bash
cd frontend/desktop
npm install
npm test
npm run dist:linux      # AppImage + deb; dist:win needs Wine, dist:mac needs macOS

cd frontend/mobile
npm install
npm test
npm run sync            # regenerate www/ and copy config into android/ and ios/
npm run android:apk     # needs a local Android SDK + JDK 21
```

- Windows/macOS installers and the Android APK are built by `.github/workflows/apps.yml` (tag `app-v*` or manual dispatch). A tag also **publishes** a GitHub release with every installer and `SHA256SUMS.txt` attached; a manual run only leaves workflow artifacts, which nobody outside GitHub can fetch.
- Artifact names deliberately carry no version (`Cyberia-Setup-x64.exe`, `Cyberia-mac-arm64.dmg`, `Cyberia-linux-x86_64.AppImage`, `Cyberia-linux-amd64.deb`, `Cyberia.apk`), so `/releases/latest/download/<name>` is a permanent address. Renaming one means editing `electron-builder.yml`, the workflow **and** `config/downloads.php` together.
- The APK is only published when the Android signing secrets exist (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`; created by `frontend/mobile/scripts/make-keystore.sh`). Without them the job builds a debug APK and keeps it off the release — a debuggable wallet is not something to hand strangers. Android ties updates to the signature, so that key can never be replaced.
- Users get all of this from `https://cyberia.church/download` (`DownloadController` + `AppDownloadService`), not from GitHub.
- `frontend/mobile/android/` and `frontend/mobile/ios/` are committed: they hold the `cyberia://` scheme, the App Links intent filters, and the generated icons.
- Deep links only resolve to the apps once `APP_ANDROID_SHA256_FINGERPRINT` / `APP_IOS_APP_ID` are set in the Laravel `.env`; both `/.well-known/` association files 404 until then.
- The site detects the shells from the `CyberiaDesktop/` and `CyberiaMobile/` user-agent suffixes (`backend/laravel/resources/js/lib/native.ts`).
- The desktop window is fully **frameless**: one `BaseWindow`, one site `WebContentsView`, no system decoration and no substitute title/menu strip. The wallet masthead is the drag region in the desktop shell and its interactive descendants opt out with `-webkit-app-region: no-drag`; this is what keeps a borderless window movable. There is no application menu in this mode, so `commandForInput` in `src/frame.js` answers its useful accelerators by physical key (Ctrl+R survives a Cyrillic layout). Two `BaseWindow` rules remain: menu **roles** that reach for a focused `BrowserWindow` are dead, so every page command is a `click` naming the site's contents; and no view has keyboard focus until the shell gives it focus. `--native-frame` / `CYBERIA_NATIVE_FRAME=1` is the compatibility escape hatch that restores desktop decorations and its menu.
- The desktop shell carries the **one capability the site cannot have on its own**: a real BitTorrent client (`src/torrent-engine.js` in an Electron `utilityProcess`, `src/torrent.js` in the main process, exposed as `window.cyberiaNative.torrent` from `src/preload.js`, limits and summary shape in the testable `src/torrent-rules.js`). The mainline DHT is UDP and peers are TCP, so no web view — browser, mobile or Telegram — can be one. The page may name a magnet and a file index and never a path; downloads land in `<Downloads>/Cyberia` (`CYBERIA_TORRENT_DIR` is an operator override), `read()` returns one finished file under 10 MB for the IPFS handoff, and nothing starts until a native dialog has been agreed to once — the dialog says that peers see the user's IP and that **the app's proxy setting does not cover this traffic**, because that setting is Chromium's and these are raw sockets. WebTorrent is ESM with a top-level await, so it loads only through `import()` and only from outside the archive: `asarUnpack` covers the engine and `node_modules`. DHT bootstrap hostnames are resolved to IPv4 in the engine — the upstream defaults include an IPv6-first host, and a machine with no IPv6 route otherwise starts from an empty routing table and looks broken rather than blocked.

---

## Telegram Mini App

The wallet inside Telegram is **the site's own `/wallet` page in Telegram's web view** — no second app, no second vault. `services/telegram-bot` hands out `WALLET_MINI_APP_URL` (default `https://cyberia.church/wallet`) from `/open`, the ☰ menu button set in `post_init`, and a button under `/app`; `mini_app_markup()` falls back to a plain link outside private chats because Telegram rejects `web_app` buttons there. None of it needs BotFather — that is only for a `t.me/<bot>/<app>` link.

On the site, `resources/js/lib/telegram.ts` decides the frame from the launch parameters Telegram appends to the URL, synchronously, so `initializeNativeShell()` returns `'telegram'` and `app.ts` picks `NativeShellLayout` before anything paints. The SDK is fetched from telegram.org **only** inside the frame. Rules that are load-bearing rather than cosmetic:

- **Telegram is told nothing.** `initData` is never forwarded and `CloudStorage` is never touched — a vault synced through Telegram is a vault Telegram holds. The custody sentence is the first thing on the portfolio there (`tgCustody`).
- **Creating a wallet works in the frame**, with the same risk notice, held reveal and backup check as anywhere else — a Mini App that cannot make a wallet turns away every newcomer at the moment they were willing to start. What `WalletOnboarding`'s `telegram` prop adds is the sentence that is only true here: the vault lands in Telegram's own web-view storage, which Telegram empties without asking, so the recovery phrase is what makes it survivable (`tgStorageWarning`, shown before a phrase exists).
- **The main button never signs.** It mirrors a screen's primary action where that action is a tap; every signature stays a hold in the page, because a tap is not a hold. Telegram's back arrow is wired to the wallet's own navigation, or it closes the whole app mid-send.

Covered by `tests/Frontend/WalletTelegramTest.mjs` (frame detection) and `services/telegram-bot/tests/test_mini_app.py` (the buttons and what the reply promises).

---

## Browser Extension

Path: `frontend/extension/` (Manifest V3, esbuild, ethers v6). The per-directory `README.md` is authoritative.

**Not a shell.** A dapp expects `window.ethereum` in its own page, so this build carries a wallet: an MV3 service worker with an AES-256-GCM / PBKDF2-SHA-256 (310k) vault in the same format as `resources/js/lib/wallet/vault.ts`, EVM accounts on `m/44'/60'/0'/0/{index}`, and an EIP-1193 + EIP-6963 provider. Importing the phrase from the wallet on the site gives the same accounts — that is the only thing the two surfaces share; there is no sync.

```bash
cd frontend/extension
npm install
npm test                # derivation vectors, grant rules, calldata reading, vault, relay config
npm run build           # dist/ (Chromium) + dist-firefox/ (Gecko)
npm run zip             # Cyberia-extension.zip + Cyberia-extension-firefox.zip
```

- **No `<all_urls>`.** `manifest.json` ships no `content_scripts` at all; `src/background/injection.js` registers `inpage.js` (MAIN world) and `content.js` (ISOLATED) for granted origins only and re-syncs on every grant or revoke. A test asserts the manifest never acquires a blanket host pattern.
- **Signing always stops at a human**, in a window of its own (`chrome.windows.create`), never in the toolbar popup that closes when the page is clicked. `PASSTHROUGH_METHODS` in `src/shared/protocol.js` is the complete set of unattended calls; `eth_sign` is refused outright and `wallet_addEthereumChain` is not offered — a page does not get to choose which RPC sees your addresses.
- **The relay differs per engine, and the popup says which one you have.** Firefox has `proxy.onRequest`, so only the wallet's own RPC/token/price traffic is routed (`routesThrough()`, `proxyDNS: true`, localhost always direct) with an opt-in toggle for the whole browser; Chromium has only `proxy.settings`, which is browser-wide or nothing. `proxy` and `privacy` are optional permissions requested inside the click that enables them, and both engines fail closed.
- Balances come from the chain RPC, tokens from that chain's keyless Blockscout index (so decimals are never hardcoded), USD from `cyberia.church/api/wallet/prices`; an unreadable price stays `null` and renders as a dash.
- Released from the same `app-v*` tag as the apps (`.github/workflows/apps.yml`, job `extension`). The asset name carries no version, so `/releases/latest/download/Cyberia-extension.zip` and `https://cyberia.church/download/extension` are permanent. Renaming means editing `build.mjs`, the workflow and `backend/laravel/config/downloads.php` together.
- **Two targets from one source** (`manifest.mjs` + one esbuild `define`): Chromium gets `background.service_worker` and `chrome.*`, Gecko gets an ES-module event page, `browser.*` (promises) and `browser_specific_settings.gecko.id = wallet@cyberia.church`. `strict_min_version` is 128.0, where `world: "MAIN"` for registered content scripts landed. Verify the Gecko build with `npx web-ext lint --source-dir=dist-firefox --self-hosted` (0 errors; the two `innerHTML` warnings are the popup's own escaped rendering).
- **A Firefox build is temporary until Mozilla signs it** — `about:debugging` → Load Temporary Add-on, gone when the browser closes. `npx web-ext sign --channel=unlisted` with AMO credentials produces a permanently installable `.xpi` under the same id; the credentials belong in the environment, never in the repo.
- Firefox MV3 treats `host_permissions` as opt-in, so `popupState()` reports `networkGranted`/`networkOrigins` and both the onboarding and the popup offer a one-click grant rather than letting every balance read as unavailable.

---

## Static Frontends

### Landing Pages

Path: `frontend/landing/`

- Plain static HTML/CSS files.
- No build step is required for `index.html` and the brand identity HTML files.
- Keep styling inline with the existing editorial/brand-document look.
- External Cyberia links should use `target="_blank"` and `rel="noopener noreferrer"`.

### Jekyll Blog

Path: `frontend/jekyll/`

Common commands:

```bash
cd frontend/jekyll
bundle install
bundle exec jekyll serve
bundle exec jekyll build
```

- Posts are in `_posts/`.
- Do not edit `_site/` unless the user explicitly asks for generated static output.

---

## Contracts

### EVM / Hardhat

Path: `crypto/hardhat/`

Stack:

- Hardhat 3
- viem
- TypeScript
- OpenZeppelin contracts
- Foundry-compatible Solidity tests

Common commands:

```bash
cd crypto/hardhat
npm install
npx hardhat test
npx hardhat test solidity
npx hardhat test nodejs
```

- Deployment scripts/modules live under Hardhat project folders such as `ignition/` and scripts.
- `hardhat.config.ts` requires `DEPLOYER_PK` at import time. If running local compile/test commands without a real deploy key, use a throwaway 32-byte private key in the environment rather than reading or printing `.env`.
- Mint/burn administration for deployed Cyberia ERC20s is centralized in `scripts/token-admin.ts`, backed by `deployments/cyberia-tokens.json`. Bridge-specific one-shot scripts are `scripts/relay-mint.ts` and `scripts/relay-burn.ts`.
- `PredictionMarket` (`deployments/cyberia-predictions.json`) takes bets from anyone and lets only its owner report outcomes, with a hard 30-day refund window after close: miss it and resolution is disabled forever. `scripts/predictions-admin.ts` is the human CLI; `scripts/predictions-resolve.ts` is the one Laravel calls, and it signs only — every decision is made in PHP (see the Laravel section).
- Never commit private keys or `.env` secrets.

### Solana / Anchor

Path: `crypto/anchor/`

Stack:

- Anchor
- Solana Web3.js
- SPL Token
- Rust + TypeScript tests/scripts

Common commands:

```bash
cd crypto/anchor
npm install
anchor build
anchor test
npm run lint
npm run lint:fix
```

- `test-ledger/` and `target/` are generated/runtime artifacts.
- Scripts include bridge initialization and relayer helpers in `scripts/`.

---

## Blockscout / Explorer

Path: `services/blockscout/`

This is **deployment configuration only** — Cyberia docker-compose files that run the official Blockscout images (`ghcr.io/blockscout/blockscout`, pinned to a tagged release; `backend`/`nft_media_handler` are pinned to `11.0.0`). The explorer's Elixir source is **not** vendored here. The compose setup points backend JSON-RPC to `host.docker.internal:8545` and uses Cyberia `CHAIN_ID=49406`.

Common commands:

```bash
cd services/blockscout/docker-compose
docker compose up -d
docker compose down
```

Important files:

- `services/blockscout/docker-compose/docker-compose.yml`
- `services/blockscout/docker-compose/services/nginx.yml`
- `services/blockscout/docker-compose/proxy/default.conf.template`
- `services/blockscout/docker-compose/proxy/explorer.conf.template`

Be careful editing compose files: some paths are production-host-specific, e.g. `/root/singularity/...`.

---

## Lisp Services

Paths:

- `services/lisp/` for daemon/http service code
- `scripts/lisp/` for small script experiments

Common commands:

```bash
sbcl --noinform --load services/lisp/daemon.lisp
sbcl --noinform --load services/lisp/run-server.lisp
```

- Modules live in `services/lisp/modules/`.
- Logs are written under `logs/`.
- Some service helpers call Python scripts for price data.

---

## Operational Scripts

Path: `scripts/`

- `scripts/python/` contains Telegram/GitHub/X airdrop and crawler bots.
- `scripts/js/price.js` contains JS price tooling.
- `.env` files and cookie files in scripts may contain secrets. Do not print or commit sensitive values.

Python setup:

```bash
cd scripts/python
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
```

JS setup:

```bash
cd scripts/js
npm install
node price.js
```

---

## Verification Checklist

Use the smallest relevant checks:

- Laravel PHP change: `cd backend/laravel && vendor/bin/pint --dirty --format agent && php artisan test --compact`
- Laravel frontend change: `cd backend/laravel && npm run lint:check && npm run types:check && npm run build`
- Ritual change: `cd frontend/ritual && npx eslint <changed files>`; for deploy artifact use the build command noted above.
- Hardhat change: `cd crypto/hardhat && npx hardhat test`
- Anchor change: `cd crypto/anchor && anchor test` or at least `anchor build`
- Jekyll change: `cd frontend/jekyll && bundle exec jekyll build`
- Desktop shell change: `cd frontend/desktop && npm test`; add `npm run pack` when the Electron main process changed.
- Mobile shell change: `cd frontend/mobile && npm test && npm run sync`
- Browser extension change: `cd frontend/extension && npm test && npm run build`
- Static landing change: inspect the HTML and, if possible, open it locally or run an HTML validator if available.
- Blockscout compose/proxy change: `cd services/blockscout/docker-compose && docker compose config`
- Host heartbeat script change: `bash -n scripts/ops/heartbeat.sh`, then `OPS_HEARTBEAT_PRINT=1 OPS_HEARTBEAT_TOKEN=x ENV_FILE=/dev/null bash scripts/ops/heartbeat.sh | python3 -m json.tool` — it assembles JSON by hand, so a malformed field only shows up in the payload

If a command is unavailable or fails because of the existing repo state, say so plainly and include the command and high-signal error.
