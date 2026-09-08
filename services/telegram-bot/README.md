# Cyberia Telegram airdrop bot

The community Telegram bot for Cyberia: wallet linking and hourly TG/chat-token
rewards, per-chat reward tokens, the CYBER.sol "whales" gate, and on-chain
announcers (bridge, Ritual DEX swaps/liquidity, lending, CYBER.sol→CYBER
conversions, solo-pool staking, pump.fun buys) plus a periodic activity digest and the market snapshot that backs
the Laravel `/analytics` page. It also includes an optional Cyberia-scoped AI
assistant backed by any OpenAI-compatible chat completions API.

Previously a single 3.6k-line `scripts/python/telegram_airdrop_bot.py`; now a
small package. That old path still exists as a thin shim so the existing prod
launch keeps working unchanged.

## Layout

```
bot/
  config.py      env vars, contract ABIs/topics, .env discovery, logging
  utils.py       pure format/parse helpers
  db.py          SQLite engine, schema, key/value store, activity log, cursors
  chain.py       web3 client, log decoders, on-chain USD price walker
  handlers.py    Telegram command/message handlers
  ai.py          Cyberia AI prompt, provider client, and message handlers
  ai_models.py   the free-model pool and the per-user /model picker
  cyberia_knowledge.md  operator-approved facts supplied to the model
  pumpfun.py     pump.fun buy detection (Solana RPC + market feed) and the post
  announcers.py  background loops (bridge/swap/liquidity/lending/convert/
                 staking/pumpfun/digest/snapshot/whale) + run_snapshot_once
  app.py         build app, register handlers, schedule loops, main()
  __main__.py    `python -m bot`
```

## Run

```bash
cd services/telegram-bot
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then fill in TELEGRAM_BOT_TOKEN, DEPLOYER_PK, DB_PATH
python -m bot
```

Refresh only the analytics market snapshot (no Telegram token needed):

```bash
python -m bot --snapshot-once
```

## Configuration

All settings come from the environment; see `.env.example`. `.env` is discovered
from, in order: `$BOT_ENV_FILE`, `services/telegram-bot/.env`,
`services/telegram-bot/bot/.env`, then the legacy
`scripts/python/.env` (so the prod shim keeps working). `DEPLOYER_PK` is never
logged.

### Wallet Mini App

The bot opens the Cyberia wallet inside Telegram. There is nothing to build
here and nothing to host: the Mini App is `WALLET_MINI_APP_URL`
(default `https://cyberia.church/wallet`), the same page a browser gets, so a
site deploy updates it. The bot hands out a URL and learns nothing about what
happens inside — the keys are made and encrypted by the page, in the web view's
own storage.

Three ways in, none of which needs BotFather:

- the **☰ menu button** beside the input box, set at startup (`WALLET_MINI_APP_MENU=0` turns it off);
- **`/open`**, which explains what Telegram cannot see and then offers the button;
- **`/app`**, which lists the installable builds and offers the Mini App underneath.

A `web_app` button is legal only in a private chat, so in groups the same page
is offered as an ordinary link — `mini_app_markup()` makes that choice and
`tests/test_mini_app.py` pins it. Configuring "Mini App" in BotFather is needed
only for a `t.me/<bot>/<app>` direct link, which nothing here depends on.

A wallet can be created inside the frame as well as imported, with the same
risk notice, held reveal and backup check the site uses. The one warning added
there is that the vault lives in Telegram's own storage, which Telegram clears
without asking — the recovery phrase is what brings it back.

### pump.fun buy bot

Every CYBER.sol buy worth at least `PUMPFUN_MIN_BUY_USD` (default $5) gets its
own post in `PUMPFUN_ANNOUNCE_CHAT` — amount in SOL and USD, amount in
CYBER.sol, buyer and transaction on Solscan, what the buy did to the buyer's
bag, and the market cap. Leave `PUMPFUN_ANNOUNCE_CHAT` empty to turn it off.

The bag line is "New Holder!" when they held none before and
"Position: N% Up!" when they did — the growth of everything that address holds
of the coin, across all of its token accounts, read off the same balances the
buy itself is read off. A buyer who kept nothing (an arbitrage passing through)
gets neither line, and neither does growth under `PUMPFUN_MIN_POSITION_PCT`
(default 1), which would round to "0% Up!". The post is laid out in three
blocks separated by blank lines — headline and size, the trade, then the
`PUMPFUN_CHART_URL` / `PUMPFUN_TRADE_URL` links — because Telegram gives every
line the same weight and an unbroken run of emoji lines reads as one paragraph.

CYBER.sol has graduated off the pump.fun bonding curve, so buys settle on the
PumpSwap AMM pool its pump.fun page trades against. `bot/pumpfun.py` reads them
off that pool's **balance deltas** — the coin side leaving while the SOL side
arrives — instead of decoding pump.fun or router instructions, so a buy routed
through an aggregator reads like a direct one, and a liquidity deposit (both
sides moving in) is never mistaken for a buy. The buyer is whoever the coin
landed with, which stays correct when someone else paid the fee.

USD value, market cap and — unless `PUMPFUN_POOL_ADDRESS` pins one — the pool
address come from the DexScreener pair feed. Without a readable SOL price the
tick is deferred rather than posting a buy it cannot size, so nothing is lost.
On a fresh install the cursor starts at the pool's current head: history is
never replayed into the chat.

The loop polls Solana every `PUMPFUN_POLL_SECONDS` (default 30) and makes one
`getTransaction` call per new pool transaction. The default public RPC is enough
at current volume; point `SOLANA_RPC_URL` at a dedicated endpoint if posts start
arriving late. A buy older than `PUMPFUN_MAX_AGE_SECONDS` (default 30 min) is
recorded for the digest but not posted: when the watcher returns from an outage
its cursor is hours behind, and the catch-up scan would otherwise announce
yesterday's trades one after another as if they had just happened.

### Solana RPC failover

Every Solana read in the bot — the buy bot and the whales gate — goes through
`bot/solana.py`, which tries endpoints in order until one answers:
`SOLANA_RPC_URL`, then the comma-separated `SOLANA_RPC_FALLBACK_URL`, then the
keyless public cluster, always last. One URL is one point of failure and it
failed: on 2026-08-14 the keyed provider began answering `401 Unauthorized`, and
because both surfaces called the same URL, buy posts and balance re-checks went
silent together for a day. The public cluster answers a *server* perfectly well
(it is browsers it refuses, over the `Origin` header), so it is the floor under
every key rather than a plan.

An endpoint that refuses — a status about the endpoint rather than the request,
a transport error, or a rate-limit JSON-RPC code — is parked for
`SOLANA_RPC_COOLDOWN_SECONDS` (default 300), so a dead key costs one call and
not one per request; when everything is parked the parks are dropped and the
list is walked again. A method error (bad params, unknown signature) is raised
as it arrives, since the next endpoint would answer the same. Only hosts are
logged: these URLs carry api keys. `tests/test_solana_failover.py` pins it.

### Activity digest

Posted every `DIGEST_INTERVAL_SECONDS` (`0` mutes it), and on demand via
`/stats [window]`. Sent as Telegram HTML in blocks separated by blank lines —
Telegram gives every line the same weight, so eight stacked lines read as one
grey paragraph. Each block leads with its headline number in bold and carries
its detail as `•` bullets under it; prices are an aligned `<pre>` table rather
than a run-on line of `SYM $price` pairs that wraps differently on every phone.

Numbers are formatted for a reader, not for `%g`: `_fmt_amount` never emits
scientific notation (a five-million-CYBER.sol bridge used to arrive as
`5.14993e+06`), `_fmt_usd` keeps three significant figures below a cent instead
of rounding to `$0.0000`, and `_fmt_price_usd` keeps four so a sub-cent coin
still differs from the next one. Token symbols come off pairs anyone may
create, so every dynamic string is HTML-escaped. Small price changes are hidden
by default (`DIGEST_PRICE_CHANGE_MIN_BPS=100`) and `DIGEST_PRICE_TOKEN_LIMIT`
caps the price table. `tests/test_digest_format.py` pins the formatting.

### AI assistant

The assistant is **off by default**: with `AI_ENABLED` unset (or falsy) the bot
registers no AI handlers at all — no `/ask`, no DM/mention answers, and no
"not configured" replies. Set `AI_ENABLED=1` to turn the feature on.

Then set `AI_API_KEY` to enable the assistant. `AI_API_URL` defaults to OpenAI's chat
completions endpoint and `AI_MODEL` defaults to `gpt-4.1-mini`; both can be
changed for another OpenAI-compatible provider. When no direct AI/OpenAI key is
set, a monorepo checkout automatically reuses `services/lainos/.env`'s
`OPENROUTER_API_KEY` and `OPENROUTER_MODEL_SMALL`, with OpenRouter's chat
completions endpoint. The key remains in one file and is never logged.

Users can call `/ask <question>` anywhere. Normal text is treated as a question
in private chats; in groups the bot responds only when mentioned or replied to,
so it does not consume every conversation. Short per-chat history is held in
Telegram application memory and is not written to the database. Edit
`bot/cyberia_knowledge.md` to update operator-approved project facts.

#### Which model answers: `/model`

`openrouter/free` — the default when the OpenRouter key is the one in use — is
not a model. It is a **router** over whatever free models are up at that
second, so the answer's character changes between two questions asked a minute
apart: one of them is a reasoning model that spends its whole budget thinking
and returns nothing, the next is a 2.6B model that is instant and shallow. The
person asking is the only one who knows which trade-off they want, so `/model`
hands them the pool (`bot/ai_models.py`).

The pool is **read from the provider**, never listed in code: `GET
{base}/models`, derived from `AI_API_URL`, which every OpenAI-compatible
provider serves. Free is a *price* — an entry qualifies when the catalogue
prices both prompt and completion at zero — and a provider that publishes no
prices at all (Cyberia's own gateway is holder-gated, not billed per token) is
offered whole, because "nothing here is priced" is not "nothing here is free".
Music and image models are priced at zero too and are dropped: a model belongs
in this menu only when text is the whole of what it emits.

* `/model` — the keyboard, paged, with the current choice ticked.
* `/model <id or part of a name>` — pick without the keyboard.
* `/model auto` — back to the router.

A choice is **per user** and survives a restart (`bot_kv`, key
`ai_model:<user id>`); an unset user gets `AI_MODEL`. When a pinned free model
is out of capacity or gone (free models are rate-limited by design — 400/402/
404/429, and an empty reply counts too) the answer still arrives through the
router, and says so instead of pretending the pinned model wrote it. On the
router the reply carries one line naming who actually answered, because the id
we send is not the id that replies.

`AI_MODEL_CHOICE=0` removes `/model` and leaves one model for everyone.
`AI_MODELS_CACHE_SECONDS` (default 1800) is how long a catalogue is reused,
`AI_MODELS_PAGE_SIZE` (default 8) how many rows a page holds, `AI_MODELS_URL`
overrides the derived catalogue endpoint, and `AI_PROXY_URL` sends both the
catalogue and the answers through a proxy on a host where the provider is
blocked. `tests/test_ai_models.py` pins the reading of the catalogue and the
size of what a button carries.

## Production runbook

The bot runs on prod from a long-lived process. The historical launch
(`cd /root/singularity/scripts/python` then running
`telegram_airdrop_bot.py` / `python -m scripts.python.telegram_airdrop_bot`)
**keeps working as-is** via the shim — after `git pull`, just restart the bot's
supervisor.

Recommended clean cutover:

1. `cd /root/singularity/services/telegram-bot`
2. Reuse the existing venv or create one and `pip install -r requirements.txt`.
3. Point the bot at its config and the live DB:
   - `.env` at `scripts/python/.env` is still picked up automatically; or set
     `BOT_ENV_FILE=/root/singularity/scripts/python/.env`.
   - `DB_PATH=/root/singularity/backend/laravel/database/database.sqlite`
   - optionally `BOT_LOG_FILE=/root/singularity/scripts/python/bot.log` to keep
     logs at the path ops already watch.
4. Launch with `python -m bot` and restart under the same supervisor.

The DB-coupled cron scripts (`distribute_tg.py`, `distribute_chat_tokens.py`)
were intentionally left in `scripts/python/` and are unaffected.
