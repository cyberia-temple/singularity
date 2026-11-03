# Product analytics for the Cyberia Wallet

What this system is for: understanding one path, end to end.

```
acquisition → onboarding → funding → activation → retention
```

Every table, event and metric below exists because it answers a question on
that path. Nothing is collected because it *could* be.

All paths in this document are relative to `backend/laravel/`.

---

## 1. Architecture

Three pieces, all inside the existing Laravel + Inertia + SQLite application.
No new service, no new database, no third-party SaaS.

```
 browser                          Laravel                      SQLite
┌────────────────────┐   POST    ┌──────────────────────┐    ┌──────────────────┐
│ lib/analytics/     │──────────▶│ AnalyticsIngest      │───▶│ analytics_users  │
│  index.ts          │  /api/    │  Controller          │    │ analytics_events │
│  taxonomy.ts       │ analytics │   → EventTaxonomy    │    │ analytics_sess.  │
│  attribution.ts    │  /events  │   → AnalyticsIngest  │    │ analytics_addr.  │
│  errors.ts         │           │      Service         │    └──────────────────┘
└────────────────────┘           └──────────────────────┘             │
        │                                                             │
        │ POST /api/analytics/funding (the only call carrying an address)
        ▼                                                             ▼
┌────────────────────┐                                     ┌──────────────────────┐
│ FundingVerifier    │  eth_getBalance / Blockscout /       │ ProductMetricsService│
│                    │  SolanaRpcProxy                      │  → /crm/product      │
└────────────────────┘                                     └──────────────────────┘
```

### Why it is separate from `site_events`

`site_events` + `/crm/analytics` already answer *"did a browser visiting
cyberia.church convert"*. This answers a different question about a different
product: *"of the people who installed the wallet, how many funded it, used it
and came back"*. The subjects differ — a site session is a browser reading
pages, an analytics user is an installation of a non-custodial wallet — so
merging them would have made both harder to read. Both dashboards link to each
other.

### Files

| Path | What it is |
|---|---|
| `database/migrations/2026_08_21_090000_create_product_analytics_tables.php` | The four tables |
| `config/analytics.php` | Switches, session timeout, verifiable chains, retention buckets |
| `app/Services/Analytics/EventTaxonomy.php` | **The definitions**: events, activation, funnels, property allowlist |
| `app/Services/Analytics/AnalyticsIngestService.php` | Upsert, dedupe, milestones, attribution |
| `app/Services/Analytics/FundingVerifier.php` | On-chain confirmation of `wallet_funded` |
| `app/Services/Analytics/ProductMetricsService.php` | Every dashboard number |
| `app/Services/Analytics/AnalyticsFilters.php` | The filter value object |
| `app/Http/Controllers/Api/AnalyticsIngestController.php` | `POST /api/analytics/{events,funding}` |
| `app/Http/Controllers/ProductAnalyticsController.php` | `/crm/installs/{id}` (one installation) |
| `app/Services/Console/NumbersReport.php` | the six questions on `/crm/numbers` |
| `app/Console/Commands/AnalyticsVerifyFundingCommand.php` | `analytics:verify-funding`, every 30 min |
| `resources/js/lib/analytics/*` | The client |
| `resources/js/pages/crm/Numbers.vue`, `Install.vue` | The numbers lens and one installation |

---

## 2. Database schema

### `analytics_users` — one installation

The primary key **is** the `anonymous_user_id`: a UUID the client generates on
first run and keeps in `localStorage`.

| Column | Notes |
|---|---|
| `id` (uuid, PK) | The anonymous id. Not an address, not a fingerprint |
| `created_at`, `first_seen_at`, `last_seen_at` | Server time |
| `platform`, `app_version`, `language` | **Last seen** — a person upgrades |
| `source`, `medium`, `campaign`, `content`, `referrer`, `landing_path` | **First touch, write-once** |
| `wallet_created_at`, `wallet_origin` | `created` \| `imported` |
| `funded_at`, `funded_chain`, `funded_source` | `onchain` \| `client` |
| `activated_at`, `activation_event` | |
| `first_transaction_at` | |

The four milestone timestamps are **write-once**. They are the numerators of
every headline metric; if a client could move them, a client could set them.

### `analytics_events`

| Column | Notes |
|---|---|
| `event_id` (uuid, **unique**) | The idempotency key — see §Data quality |
| `user_id`, `session_id` | |
| `event` | From the whitelist |
| `chain` | Promoted out of `properties` so a chain filter can use an index |
| `properties` (json) | Allowlisted keys only |
| `created_at` | **Server time**, the source of truth |
| `client_time` | Kept only so clock skew is measurable; no metric reads it |

Indexes: `event_id` (unique), `(event, created_at)`, `(user_id, created_at)`,
`created_at`, `(user_id, event, created_at)`, `(session_id, created_at)`.

### `analytics_sessions`

`id` (uuid, PK), `user_id`, `started_at`, `last_activity_at`, `ended_at`,
`platform`, `app_version`.

### `analytics_addresses`

`user_id`, `chain`, `address`, unique on `(user_id, chain, address)`, plus an
index on `address` for the sponsored-gas join. **Only stored for chains this
server can read without an API key** — see §5.

---

## 3. Event taxonomy

Defined once in `EventTaxonomy::EVENTS` (PHP) and mirrored in
`resources/js/lib/analytics/taxonomy.ts` (TypeScript, so a misspelled name is a
build error). `tests/Feature/Analytics/EventTaxonomyTest.php` pins the two lists
to each other; they cannot drift.

### Application

| Event | When |
|---|---|
| `first_open` | The installation id was minted (first run ever) |
| `app_opened` | Every page load |
| `session_started` | A new session began (30 min inactivity) |

### Onboarding

| Event | Where |
|---|---|
| `wallet_creation_started` | `WalletOnboarding.vue`, "Create wallet" |
| `wallet_created` | `Wallet.vue:adopt()` — the vault is sealed and open |
| `wallet_import_started` | `WalletOnboarding.vue`, "Import wallet" |
| `wallet_imported` | `Wallet.vue:adopt()` |
| `onboarding_completed` | Beside the two above |

### Funding and activation

| Event | Written by |
|---|---|
| `wallet_funded` | **The server**, once, from `AnalyticsIngestService::stampFunded()` |
| `first_transaction` | **The server**, once, on the first settled action |

Neither can be sent by a client.

### Transactions (send, token transfer)

`transaction_started` → `transaction_signed` → `transaction_submitted` →
`transaction_confirmed` \| `transaction_failed`. From `WalletSend.vue`.

`transaction_submitted` carries `watchable`: false when the chain adapter has no
`awaitOutcome` (a user-added network, a Bitcoin fork with no Esplora endpoint).

### Swap and wrap — `WalletSwap.vue`

`swap_opened` → `swap_quote_requested` → `swap_quote_received` \|
`swap_quote_failed` → `swap_started` → `swap_signed` → `swap_completed` \|
`swap_failed`.

`swap_quote_failed` is deliberately **not** `swap_failed`: nobody signed
anything, so it must not enter the swap success rate. It still appears in the
error report.

### Bridge — `WalletBridge.vue`

`bridge_opened` → `bridge_quote_received` → `bridge_started` →
`bridge_deposit_confirmed` → `bridge_completed` \| `bridge_failed`.

`bridge_completed` means the deposit registered with the relayer, not that the
payout landed — the wallet never learns that, and says so on screen.

### Staking — `WalletEarn.vue`

`staking_opened` → `staking_started` → `staking_completed` \|
`staking_withdrawn` \| `reward_claimed` \| `staking_failed`.

Three acts, three completions: stake, unstake and claim are three different
agreements in this product and are counted as three.

### Liquidity — `pages/Liquidity.vue`

`liquidity_added`, `liquidity_removed`. Adding liquidity lives on the DEX pages,
not in the wallet (the wallet links out, because a two-sided position with a
moving ratio is the one thing it cannot fully quote before signing).

### NFT — `WalletNftMint.vue`

`nft_mint_started` → `nft_minted` \| `nft_mint_failed`.

### Sponsored gas — `GasSponsor.vue`

`gas_sponsorship_requested` → `gas_sponsorship_completed` \|
`gas_sponsorship_failed`.

### Deliberately absent

- **`dapp_connected`** — the wallet has no dapp connection. `WalletBrowse.vue`
  is a directory of links; the *browser extension* is what mediates a page's
  access to a wallet, per origin, and it is a separate build with its own vault.
  Adding the event would mean inventing the feature.
- **Screen views in general.** Only three exist (`swap_opened`,
  `bridge_opened`, `staking_opened`) and each is the denominator of a
  conversion that matters. A taxonomy that recorded every tap would answer no
  question anybody asks and would bury the events that do.

---

## 4. Event properties

Allowlisted in `EventTaxonomy::PROPERTIES` and mirrored in
`ANALYTICS_PROPERTY_SHAPES`. Anything not named is dropped — on the client
before sending, and again on the server before writing.

| Key | Shape | Notes |
|---|---|---|
| `chain`, `from_chain`, `to_chain`, `section` | slug ≤32 | |
| `asset`, `token_in`, `token_out` | slug ≤32 | **Symbols, never contract addresses** |
| `token_type` | `coin` \| `token` | |
| `transaction_type` | `send`, `token_transfer`, `swap`, `wrap`, `bridge`, `stake`, `unstake`, `claim`, `mint`, `liquidity` | |
| `amount_usd`, `fee_usd`, `gas_usd` | number 0…1e9 | **USD, never units** |
| `price_impact`, `slippage` | number −100…100 | percent |
| `route` | ≤64 chars | e.g. `CYBER → WCYBER → USDC` |
| `hops`, `pid` | int 0…1e6 | |
| `tier` | `slow` \| `normal` \| `fast` | |
| `duration_ms` | int 0…3.6e6 | |
| `error_code` | fixed vocabulary | see below |
| `watchable`, `sponsored`, `verified` | bool | |
| `origin` | `created` \| `imported` | |
| `grounds` | `tokens` \| `nft` \| `account` \| `open` | gas-station gate |
| `pool_kind` | `pair` \| `solo` | |

**Amounts are USD, not units.** An amount in units plus a symbol is a
fingerprint of one transfer on a public chain; a rounded dollar figure is a row
in a total. USD is also the only figure that can be added across assets.

### Error codes

`user_rejected`, `insufficient_funds`, `insufficient_gas`, `allowance`,
`slippage`, `no_route`, `quote_expired`, `nonce`, `reverted`,
`rpc_unreachable`, `timeout`, `watch_only`, `unsupported`, `server_refused`,
`unknown` — plus `GasSponsorService`'s own vocabulary reused verbatim
(`hasGas`, `holdsNothing`, `coolingDown`, `dailyCap`, `empty`, `quota`,
`unreadable`, `paused`, `disabled`), so a refusal reads the same on the
dashboard as it does in the wallet and in the server log.

Raw error messages are **never** stored. They carry addresses, amounts and node
URLs, and they do not aggregate — the same failure reads six ways across six RPC
providers. `resources/js/lib/analytics/errors.ts` maps a thrown thing to a code;
anything it cannot place becomes `unknown` rather than leaking its text.

---

## 5. Privacy rules

### Never collected, structurally

Seed phrases, private keys, vault passwords, encryption keys, PINs, signed
message payloads, transaction hashes, recipient addresses, exact amounts.

This is enforced by an **allowlist of property keys**, not a denylist of
forbidden values: a wallet is one long chain of secrets, and a denylist is a
promise that the next feature will break it. There is no field any of the above
could occupy.

The one hole an allowlist of keys leaves is the right field with the wrong
variable in it, so string values are additionally refused when they contain 32+
consecutive hex characters (a key, an address, a signature, a hash) or six or
more words (a mnemonic). Neither can be a token symbol or a route.

### No fingerprinting

No canvas, no font enumeration, no screen size, no hardware identifiers, no IP
stored on any analytics row. The identity is a UUID the device minted itself.

### No account linkage

The ingest endpoint lives under `/api` (stateless — no session, no CSRF) and the
client sends `credentials: 'omit'`. The endpoint cannot see which Cyberia
account the browser is signed into.

### Addresses

Stored **only** for chains listed in `config('analytics.verifiable_chains')`:
`cyberia`, `robinhood`, `solana`. Those are the chains this server can read
without an API key, and they buy exactly two things — confirming that a wallet
was funded, and joining `gas_sponsorships` to find what a sponsored drip cost.

On BNB, Base, Bitcoin, Litecoin and Monero **no address is ever sent**; a
funding claim from them records the chain and nothing else. Addresses never
travel on the event endpoint at all — `POST /api/analytics/funding` is a
separate call for exactly that reason.

The User Explorer shows a **count** of linked addresses, never the addresses.

### Consent

`navigator.doNotTrack` / `globalPrivacyControl` are honoured
(`config('analytics.respect_dnt')`, on by default), and Wallet → Security has an
"Anonymous usage statistics" switch in en/ru/zh. Turning it off drops the local
queue and forgets the installation id, so opting back in starts a new anonymous
user rather than resuming a profile.

### Session recordings

Replays, click heat maps and rage/dead clicks are a different system with a
different promise: they record *how* screens are used, these tables record
*what* happened. They are recorded by rrweb in the browser and kept on this
server (`/api/replay` → `replay_*` tables and gzip chunks on the private disk,
read at `/crm/replays`); nothing is sent to a third party, which is why this is
not a hosted tool. The two systems share one refusal — the recorder's notice
and the switch above both write `cyberia.analytics.optout`, and the recorder
records nothing while it is set — and recordings hear the event *names* from
this client, never their properties. Who is never sent the recorder is decided
in `App\Support\SessionReplay` (operators, store builds, the desktop shell,
DNT/GPC). What leaves a recorded page: every input masked, text under
`data-replay-mask` as asterisks, `data-replay-block` as an empty box, no query
string, and every string scrubbed of address-, hash- and key-shaped values
before it is sent. Settings and the console are paused. Recordings are kept
`replay.keep_days` (30) and then deleted with their rows by `replay:prune`.

### Web analytics (Umami)

Traffic — visits, sources and campaigns, countries, devices, funnels,
retention, journeys, Web Vitals — is counted for every visitor by Umami
(`services/umami/`, dashboard `stats.cyberia.church`, opened signed in from
`/crm/stats`), on this host and nowhere else. It answers a question these
tables refuse by design: they count installations of the wallet, while Umami
counts browsers reading pages. It is skipped for exactly the people the recorder
skips. It honours the same refusal and passes the installation id as its
distinct id. It keeps only `utm_*` and `ref` from a query string and drops the
referrer's query. Each event this client records is mirrored there by name,
with the properties the allowlist kept, so a funnel can be built from wallet
milestones. Its numbers are not this document's numbers. A Umami "visitor" is a
browser, and nothing there knows whether a wallet was funded.

### Referrers and landing paths

Referrers are reduced to `scheme://host` before storage; landing paths have
their query string removed. A full referring URL is somebody's browsing history.

---

## 6. Definition of Active User

> An installation that performed at least one **meaningful action** in the
> window.

**Not** an installation that opened the app. `overview.dau/wau/mau` are all
built on this.

The gap between the two is on the dashboard's first chart: the grey bars are
"opened the app", the coloured bars are "did something".

---

## 7. Definition of Activated User

> An installation with `activated_at IS NOT NULL` — stamped, once, at its first
> meaningful action.

**Meaningful action** = `EventTaxonomy::MEANINGFUL`, the single definition:

```
transaction_confirmed   swap_completed        bridge_completed
staking_completed       staking_withdrawn     reward_claimed
liquidity_added         liquidity_removed     nft_minted
```

Plus one conditional, in `EventTaxonomy::isMeaningful()` and nowhere else:
`transaction_submitted` counts **when `properties.watchable === false`**. A
chain whose adapter cannot watch for a receipt never produces a
`transaction_confirmed`, and refusing to count its users would be a fact about
our instrumentation rather than about them.

Everything that is *not* activation: opening a screen, requesting a quote,
receiving a quote, creating a wallet, being funded, receiving sponsored gas, and
broadcasting a transaction on a watchable chain. **Broadcast is not
settlement** — the send screen in this wallet says so, and a metric that
disagreed with the product would be the one that is wrong.

---

## 8. Definition of Funded User

> An installation with `funded_at IS NOT NULL`.

Stamped once, write-once, in one of two ways:

- **`funded_source = 'onchain'`** — this server read a positive native balance
  or a positive token balance for a linked address (`FundingVerifier`). Cyberia
  and Robinhood via `eth_getBalance` + keyless Blockscout `tokenlist`; Solana via
  `SolanaRpcProxy` (`getBalance` + `getTokenAccountsByOwner`).
- **`funded_source = 'client'`** — the browser observed a balance on a chain
  this server cannot read without an API key. Recorded as the claim it is, and
  reported **separately** on the dashboard (`funded_onchain` /
  `funded_claimed`). Never merged.

A token balance counts. A wallet holding USDC and no CYBER is funded — and is in
fact the exact wallet the gas station exists for.

The milestone cannot re-fire: a balance that goes up and down, a reload, a
second chain reporting later, all hit the write-once guard.
`analytics:verify-funding` (every 30 min) catches the case the browser could not
report — a wallet funded while closed, a deposit that confirmed after the tab
was gone.

---

## 9. Definition of Weekly Active Funded Users (North Star)

> Distinct `analytics_users.id` that are **funded** and performed at least one
> **meaningful action** in the last 7 days.

```sql
SELECT COUNT(DISTINCT e.user_id)
  FROM analytics_events e
  JOIN analytics_users u ON u.id = e.user_id
 WHERE u.funded_at IS NOT NULL
   AND e.event IN ('transaction_confirmed','swap_completed','bridge_completed',
                   'staking_completed','staking_withdrawn','reward_claimed',
                   'liquidity_added','liquidity_removed','nft_minted')
   AND e.created_at >= datetime(:to, '-7 days')
   AND e.created_at <= :to;
```

Implementation: `ProductMetricsService::weeklyActiveFundedUsers()`. The window
comes from `config('analytics.north_star_days')`.

Both halves are load-bearing. A funded wallet nobody uses is not a user of this
product; an active wallet with no money in it is somebody looking around.

**One person counts once.** The count is over `analytics_users.id`, never over
addresses — that is the whole reason this system has an anonymous id. Pinned by
`ProductMetricsTest`: an installation with four addresses on four chains and
four settled swaps is `1`.

---

## 10. Funnel definitions

### Main funnel — `ProductMetricsService::mainFunnel()`

Measured on **the cohort acquired inside the window**, followed forward. Not
five independent counts: counting "wallets created this month" against "users
first seen this month" mixes in people who arrived earlier and eventually
produces conversions above 100%.

| Step | Condition on the cohort |
|---|---|
| First open | `created_at` in range |
| Wallet created or imported | `wallet_created_at IS NOT NULL` — stamped by `wallet_created`/`wallet_imported`, or repaired from any event that proves a vault existed (`wallet_origin = 'existing'`) |
| Funded | `funded_at IS NOT NULL` |
| Activated | `activated_at IS NOT NULL` |
| Retained | a meaningful action **≥ 1 day after** `activated_at` |

"Retained" is the one step that cannot be satisfied in a single sitting, and it
needs no maturity window to be honest.

Each step reports the absolute count, `of_top` (conversion from step 1) and
`of_previous` (step-to-step).

### Product funnels — `EventTaxonomy::FUNNELS`

Measured in **distinct users per step**, never event counts — one person asking
for six quotes is one person who wanted a quote.

```
swap        swap_opened → swap_quote_received → swap_started → swap_signed → swap_completed
bridge      bridge_opened → bridge_quote_received → bridge_started → bridge_deposit_confirmed → bridge_completed
transaction transaction_started → transaction_signed → transaction_submitted → transaction_confirmed
staking     staking_opened → staking_started → staking_completed
gas         gas_sponsorship_requested → gas_sponsorship_completed
```

### Success rates — `EventTaxonomy::OUTCOMES`

`rate = success / (success + failure)`. The denominator starts where the user
**committed** — a signature, a broadcast deposit, a claim request — not where
they opened a screen. An abandoned quote is not a failed swap; folding it in
would make the number say "people change their minds" instead of "this breaks".

---

## 11. Retention calculation

`ProductMetricsService::retentionCohorts()`.

- **Cohort key**: the ISO week of `activated_at`, not of first open. This
  product's question is whether people who did something once do it again; an
  install that never activated has nothing to be retained from.
- **Buckets**: D1, D7, D30 (`config('analytics.retention_buckets')`).
- **"Returned by day N"**: any meaningful action from day 1 through day N after
  activation. Same convention as `UserAnalyticsService`, so the two dashboards
  in this app never report retention two different ways.
- **Maturity**: a bucket is `null` until the *youngest* member of the cohort has
  had time to reach it (`week start + 6 + N days ≤ now`). Reporting 0% for a
  three-day-old cohort would say "nobody came back" when it means "nobody has
  had the chance".

The headline `d7_retention` tile is the newest cohort with a non-null D7.

---

## 12. Attribution logic

**First touch, write-once.** `analytics_users` attribution columns are written
only when the row is created; a later tagged link never overwrites them. This is
the single most common way an acquisition report ends up crediting the
retargeting campaign for users the launch announcement brought in.

The candidate is built by `parseAttribution(href, referrer, startParam)` from
three sources, in order of trust:

1. **`utm_source` / `utm_medium` / `utm_campaign` / `utm_content`** (plus `ref`
   as a shorthand for source) on the landing URL. `lib/track.ts:attributedUrl()`
   already propagates UTM across same-origin links, so a visitor who arrived on
   the landing page and walked to `/wallet` still carries them.
2. **Telegram's `startapp` payload** — `t.me/<bot>/app?startapp=<campaign>`
   arrives as `tgWebAppStartParam`. Inside a chat there is no URL bar to hold a
   `utm_source` and no referrer to read, so this is the only campaign channel a
   Mini App has. Recorded as `source=telegram`, `medium=mini_app`,
   `campaign=<payload>`.
3. **The referring site**, reduced to its origin. Same-origin referrers are
   navigation, not acquisition, and are ignored.

### What attribution cannot do, honestly

**A campaign cannot follow an installer download.** Someone clicks
`cyberia.church/download?utm_source=x`, their *browser* is attributed, they
install the APK or the .exe — and that is a different client with different
storage. Bridging it would need a device identifier, which this system does not
use and will not add. What is measurable instead:

- the web-side click-through to `/download` (site funnel, `site_events`);
- `platform` on every analytics user (`web`, `pwa`, `desktop`, `mobile`,
  `telegram`), so shell adoption is visible even when its campaign is not.

The desktop and mobile shells render the live site from a build-time
`CYBERIA_APP_URL` with no campaign in it. If per-download attribution is ever
needed, the honest way is a signed, short-lived claim code baked into the
downloaded artifact — which is real work, and is listed as a next step rather
than pretended at.

---

## 13. How to add a new event

1. **Add the name to both taxonomies**, in the same position:
   - `app/Services/Analytics/EventTaxonomy::EVENTS`
   - `resources/js/lib/analytics/taxonomy.ts` — both the
     `AnalyticsEventName` union and `ANALYTICS_EVENTS`.
   `EventTaxonomyTest` fails if they disagree.
2. **Decide whether it is meaningful.** If it settles value on a chain, add it
   to `MEANINGFUL` (PHP) *and* `MEANINGFUL_EVENTS` (TS). If not, do not — this
   list is the definition of an activated user, and widening it silently
   re-bases every activation and retention number you have.
3. **If it has an outcome pair**, add it to `OUTCOMES` (for the success rate)
   and its failure to `FAILURES` (for the error report). A failure that happens
   before anyone signs goes in `FAILURES` only.
4. **If it belongs to a funnel**, add it to `FUNNELS` in the right position and
   add a `funnel_<name>` / step label to `productAnalyticsMessages.ts`.
5. **Call it**: `analytics.track('my_event', { chain, amount_usd })`. Common
   properties are added automatically; never pass `anonymous_user_id`,
   `session_id`, `platform`, `app_version` or a timestamp by hand.
6. **Test it** in `tests/Feature/Analytics/`.

If it needs a property nobody has used yet, add the key to
`EventTaxonomy::PROPERTIES` **and** `ANALYTICS_PROPERTY_SHAPES` with the same
shape — and think about whether the value can identify one transaction. If it
can, it does not belong here.

## 14. How to add a new metric

Add a method to `ProductMetricsService` and a key to the controller's Inertia
payload; render it in `crm/Product.vue` with a label in
`productAnalyticsMessages.ts` (en **and** ru — an English-only operator UI in
this project has already been shown to go unused).

Rules the existing methods follow:

- Conversions are **distinct users**, never event counts.
- A rate with a zero denominator is `null`, rendered `—`. Never `0%`.
- A cohort question bounds by `analytics_users.created_at`; an activity question
  bounds by `analytics_events.created_at`. Say which you mean.
- Never define "active", "funded" or "activated" in a query. Use
  `EventTaxonomy::MEANINGFUL` and the milestone columns.

## 15. What is deliberately not collected

| Not collected | Why |
|---|---|
| Seed phrases, private keys, passwords, vault material, PINs | Non-custodial wallet. No field exists for them |
| Signed message payloads | Same |
| Transaction hashes | Identify one transaction on a public chain |
| Recipient addresses | Identify a counterparty |
| Exact amounts in token units | A fingerprint of one transfer; USD is used instead |
| Contract addresses of traded tokens | Symbols are enough for a product question |
| IP addresses | Not stored on any analytics row |
| Device fingerprints, screen size, fonts, canvas, hardware ids | Would defeat the point of an anonymous id |
| Full referring URLs | A browsing history. Origin only |
| Landing-page query strings | May carry tokens |
| Raw error messages | Carry addresses and amounts; do not aggregate |
| Addresses on BNB, Base, Bitcoin, Litecoin, Monero | Unreadable from here, so storing them buys nothing |
| The Cyberia account behind a browser | Ingest is credential-less by design |
| Page views inside the wallet | Only three screen-open events, each a funnel denominator |

---

## 16. Data quality

| Hazard | Defence |
|---|---|
| Duplicate events | `event_id` unique index + `insertOrIgnore`. Milestones only run when the insert actually inserted |
| Retries | Safe by construction — a resent batch is dropped, not double-counted |
| Network failure | Bounded `localStorage` outbox (100 events), retried on the next flush |
| Frontend reload | Outbox survives it; the ids make the replay harmless |
| Repeated blockchain detection | `funded_at` is write-once; the client also keeps a local mark |
| Clock skew | Server time is the truth. A client time is honoured only if it is in the past and within 48 h — enough to file a late flush on the right day, not enough to let a wrong clock move a cohort |
| Old app versions | An unknown event name is dropped and the rest of the batch is kept; an unknown property key is dropped and the event is kept |
| Analytics outage | The client never awaits, never throws, and the endpoint always answers 202. Sending, swapping and bridging do not depend on it |
| **Our own traffic** | Internal installations are marked (`internal_at`) and excluded from every metric by default. See §20 |
| **A notional the trade refutes** | `amount_usd` above `notional_max_price_impact` is dropped from volume and reported separately. See §20 |
| **A funnel step overtaking the one before it** | Any event that could only come from an open vault stamps `wallet_created_at` if nothing else did (`EventTaxonomy::PROVES_WALLET`), with `wallet_origin = 'existing'` |
| **A page that is not the wallet** | The product client starts only on a wallet surface — see §21. `site_events` keeps counting everything, because that is its subject |
| **A reload counted as an open** | `app_opened` is suppressed within 30 s of the previous one in the same browser |

The five events that must never inflate — `wallet_funded`, `first_transaction`,
activation, `transaction_confirmed`, `gas_sponsorship_completed` — are covered
specifically:

- `wallet_funded` and `first_transaction` are **written by the server**, once,
  and cannot be sent by a client at all.
- Activation is a write-once column, not a count.
- `transaction_confirmed` is deduped by `event_id` like everything else.
- **Sponsored gas cost never reads a client event.** It is summed from
  `gas_sponsorships.amount_wei` — what the server that signed the drip recorded
  the contract as releasing. Six resent `gas_sponsorship_completed` events add
  nothing to the spend (pinned by `ProductMetricsTest`).

---

## 17. Performance

No pre-aggregation, no rollup tables, no cache. At current volumes every
dashboard query is a plain aggregate over an index. Query plans as of writing:

| Query | Plan |
|---|---|
| WAFU | `SEARCH … USING COVERING INDEX analytics_events_user_id_event_created_at_index` |
| Retention day sets | same covering index |
| Daily active series | `SEARCH … USING INDEX analytics_events_created_at_index (range)` |
| Acquisition | `SEARCH analytics_users USING INDEX analytics_users_created_at_index` |
| Sponsored-gas join | `SEARCH analytics_addresses USING INDEX analytics_addresses_address_index` |
| Dedupe on ingest | `SEARCH … USING COVERING INDEX analytics_events_event_id_unique` |

To re-check after a schema change:

```bash
sqlite3 database/database.sqlite "EXPLAIN QUERY PLAN <your query>;"
```

**When a rollup becomes necessary** (a dashboard load stops being instant), it
goes in front of `activeOverTime()` and `retentionCohorts()` and nowhere else —
those two are the only ones whose cost grows with total history rather than with
the window. Everything else is bounded by the date range. Do not add one before
that happens.

The one caveat: `acquisition()` runs `retentionCohorts()` once per
source/campaign row (capped at 25) to fill its D1/D7 columns. That is the
heaviest thing on the page and the first candidate for a rollup.

---

## 18. Dashboard

**`/crm/numbers`** — the console's numbers lens, behind `EnsureCrmAdmin` (the
operator wallet allowlist); anyone else gets a 404, so it is not discoverable.
`/crm/product` redirects here.

Six questions, each with an answer, its evidence and one line of what follows
from it: are we growing · do they reach money · do they come back · where do
the ones who stay come from · what breaks · what does an activated user cost.
A tile is a number without a question, and a number without a question is read
as whatever the reader already believed.

`?subject=installs` (default) counts installations; `?subject=sessions` counts
browsers reading the site, out of `site_events`. One switch rather than two
pages, because the confusion between the two subjects is the expensive one —
and a question this subject cannot answer says so instead of borrowing the
other one's number.

Filters: date range (7/30/90 days or explicit `from`/`to`), platform, app
version, source, campaign, chain. Platform/version/source/campaign narrow the
**population** and everything is then measured inside it; chain narrows the
**activity** without changing the denominator.

**`/crm/installs/{uuid}`** — one installation: attribution, milestones,
sessions and a 200-row timeline with meaningful actions marked, plus how many
installations are stuck at the same step this month. Linked addresses are shown
as a count only. `/crm/product/users/{uuid}` redirects here.

---

## 19. Operations

```bash
# Confirm funding the browser never got to report (scheduled every 30 min)
php artisan analytics:verify-funding --limit=200 --days=14

# Repair milestones and mark our own installations. Idempotent; --dry-run
# prints every row it would touch and writes nothing.
php artisan analytics:repair --dry-run
php artisan analytics:repair
```

Environment:

| Variable | Default | Effect |
|---|---|---|
| `ANALYTICS_ENABLED` | `true` | Off: ingest writes nothing, client stops sending |
| `ANALYTICS_RESPECT_DNT` | `true` | Honour Do Not Track / GPC |
| `ANALYTICS_SESSION_TIMEOUT` | `30` | Minutes of inactivity before a new session |
| `ANALYTICS_FUNDING_CACHE` | `10` | Minutes a positive balance answer is reused |
| `ANALYTICS_FUNDING_SWEEP_LIMIT` | `200` | Addresses per sweep |
| `ANALYTICS_FUNDING_SWEEP_DAYS` | `14` | Only users seen this recently |
| `ANALYTICS_INTERNAL_WALLETS` | — | Extra addresses that mark an installation as ours; added to `crm.admin_wallets` |
| `ANALYTICS_INTERNAL_USER_IDS` | — | Extra site accounts that mark a session as ours; added to `crm.admin_user_ids` |
| `ANALYTICS_NOTIONAL_MAX_IMPACT` | `25.0` | Price impact (%) above which a trade's `amount_usd` is not summed into volume |

There is no retention/pruning job yet. `analytics_events` holds no personal
data, so nothing forces one; add a `analytics:prune` on the `ai:prune-usage`
model if the table's size ever becomes the problem.

---

## 20. What the numbers leave out, and why they say so

Two exclusions are applied to every product number by default. Both were found
in live data, not reasoned about in advance, and both are **reported on screen**
rather than silently applied — a total that quietly got smaller is as misleading
as one that counts everything.

### Our own traffic

The two people who build this wallet are also its heaviest users. In the first
five weeks of `site_events`, **68 of the 70 recorded swaps belonged to the two
console operators**, and 4 sessions produced every conversion in the funnel. A
conversion rate computed over that population is a description of testing.

- `analytics_users.internal_at` marks an installation as ours, with
  `internal_reason` recording how it was recognised: `address` (an address on
  `analytics.internal.wallets` was linked to it) or `manual` (an operator said
  so on `/crm/installs/{uuid}`). The manual route exists because the address
  lists catch the wallets we wrote down, which is not the set we test from —
  the first installation this system ever recorded was an operator on an
  address that appears on no list anywhere.
- `ProductMetricsService` excludes them from **both** the population and the
  event stream. Narrowing only the population would leave their swaps counting
  against a denominator they are not in.
- `site_events` has no `internal_at`, but it does have a user id, so
  `InternalTraffic` excludes **whole sessions** that ever carried an internal
  user id or wallet address. Whole sessions, because an operator browses signed
  in and some of their rows are attributed while others are not: dropping only
  the attributed half would remove the conversions and keep the visits, making
  the funnel look *worse* than reality.
- `?internal=1` on any console lens puts them back, and the page says so.
- Bridge events are the one place the exclusion cannot reach — `bridge_events`
  keeps its own session ids, which no site session can be matched against. The
  funnel prints that caveat rather than implying the step is filtered.

### A notional the trade itself refutes

`amount_usd` is the input priced at the quote that existed *before* the trade.
Through a deep pool that is very nearly what changed hands. Through a pool too
thin to absorb it, it describes nothing: **the first swap this system recorded
reported $67,548.63 at 99.98% price impact** — a dust pool being drained — and
it was the entire swap volume figure on the dashboard.

Price impact is the trade's own testimony about its own notional, so it decides.
Above `analytics.notional_max_price_impact` (default 25%) the dollar figure is
dropped from `swap_volume_usd` / `bridge_volume_usd` and reported as
`volume_excluded` / `volume_excluded_usd`. The trade still counts everywhere
else — it activated its user, it is in the funnel, it settled on a chain. Only
its price is disbelieved. An event that never reported a price impact (a bridge,
a wrap, a plain transfer) keeps its amount: not reporting one is not the same as
reporting a high one.

---

## 21. What counts as an installation

`analytics_users` is defined as *one installation of the wallet*, and the North
Star counts funded installations. Until 2026-08-22 the client was started from
`app.ts` on every Inertia navigation, so every reader of `/farm`, `/login` and
`/download` became one: **of the first eight rows the table ever held, seven
were people who never opened a wallet**, and they were diluting the funnel the
product is steered by.

The client now starts only on a wallet surface — `isWalletSurface()` in
`app.ts`. Three ways to qualify, and one is enough:

1. the page is a wallet screen (`Wallet`);
2. the app is running inside a shell — desktop, phone, Mini App — where the
   wallet is the whole product;
3. a vault exists in this browser's `localStorage`, so whoever is reading this
   page has a wallet here and their return visit is retention.

**Attribution is not gated.** `rememberAttribution()` runs on every navigation
everywhere: one `localStorage` write, no user row, no request. Campaign links
land on the landing page, not on `/wallet`, so first touch has to be captured
where it happens — and by the time someone opens the wallet weeks later, the
answer is already sitting in storage.

`site_events` still counts every page on the site. Nothing was lost; two
questions stopped sharing one denominator.
