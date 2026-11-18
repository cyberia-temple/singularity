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
  stakes.py      chat-token escrow shared by the games (one place moves a balance)
  rps.py         rock-paper-scissors duels on that escrow
  slots.py       🎰 slot machine: Telegram's own dice, a per-chat bank
  pumpfun.py     pump.fun buy detection (Solana RPC + market feed) and the post
  buybot.py      opt-in LAIN/Pons v4 buy cards and ecosystem buttons
  music.py       songs on request: Yandex Music/VK links, /track, "Artist — Title"
  market_gaps.py sized V2 buy/sell comparisons against outside reference markets
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

### LAIN buybot (Robinhood Chain)

An administrator adds the existing bot **@cyberia_network_bot** as a group
administrator with permission to post, then sends `/buybot on` there. No second BotFather token,
new process, paid model or signing key is needed. Destinations are **off by
default** and stored in the existing `bot_kv` table. `/buybot off` disables
only that group's LAIN notices. `/buybot status` shows configuration and any
last polling error; `/buybot reset` starts at the current confirmed head again.
Repeated `/buybot on` is idempotent and never skips a pending purchase.

`/buybot preview` sends a card only when an administrator requests it. It
loads the operator-provided historical transaction from the chain and labels
the card **PREVIEW · historical transaction**. It does not subscribe the group
or move its cursor. Tests use the same receipt without contacting Telegram.

This first version watches **one verified pool**, not every venue or chain:

- Chain: Robinhood mainnet, **4663**.
- Token: `0x2b79a071a75dd40f1aca68146d7978204efd156a` (LAIN, 18 decimals).
- Manager: `0x8366a39cc670b4001a1121b8f6a443a643e40951`.
- Native ETH/LAIN pool id: `0x9103c042ae23fbcc5141b202dee6d9016d57b649bdc6e9c2a5764b0ad9f2cf9c`.
- Reference: [operator's purchase](https://robin.etherscan.io/tx/0x2bb92603b4fe4d41310de00eccedc19f3b7f7ab8faf49aab459bff9700c7933d).

Only successful pool Swap events count: sells, liquidity operations, unrelated
transfers and net round trips do not become buy alerts. Multiple pool swaps in
one transaction produce one card. All buybot captions and command replies
are in English. The token amount displayed is the pool Swap output; the
recipient's amount after fees is not displayed. The sender and main token
recipient are separate address fields. Where token transfers identify a unique
recipient with at least 90% of the pool output, its address is shown.
Ambiguous recipients are left unspecified.
There is no unverified “New Holder” claim. FDV uses the event's post-swap
price and total supply read at its block; it is **not circulating market cap**.
USD/FDV are indicative, use the latest optional GeckoTerminal ETH quote and
are omitted when unavailable. The alert still works without that feed.

The inline URL keyboard omits `style` so Telegram uses the client's own
button colors and theme:

| Button | Destination |
| --- | --- |
| Buy on Pons | `LAIN_BUYBOT_PONS_URL` (LAIN's token page on `ponsfamily.com`) |
| X / Twitter | `LAIN_BUYBOT_X_URL` (`https://x.com/lain___os`) |
| Roadmap | `LAIN_BUYBOT_ROADMAP_URL` (`https://lain-os.com/roadmap`) |
| 🎲 Cyberia Wallet | `WALLET_MINI_APP_URL` (our `/wallet`) |

The trading button opens LAIN's page on Pons; the wallet opens Cyberia Wallet.
The payment line contains only the ETH amount and optional approximate USD
value. The verified transaction and pool chart remain linked in the caption.
The image uses the founder-provided
Lain OS logo at `/token-icons/lain-os-buybot.png`, preserved unchanged. Set
`LAIN_BUYBOT_PHOTO_URL` to a public JPEG/PNG to change it, or leave it
empty for text. A rejected photo falls back to text with the same keyboard.

Each group has a durable block/log cursor, initialized at the head with no
backfill. Defaults: 30-second poll, 64-block confirmation depth, 0.001 ETH
minimum pool input, 10-minute maximum alert age. RPC requests run off the
event loop and check chain id; unavailable providers fall back. A changed
cursor block hash stops that group until `/buybot reset` (which deliberately
skips the intervening history). Depth reduces shallow reorg exposure; it is
not L1 finality. An explicit send failure retains the cursor for retry. Telegram
does not offer an idempotency key: a successful send whose response is lost,
or a crash before saving its cursor, can still cause a duplicate. No claim of
exactly-once delivery is made. Failed groups do not block other destinations.
No RPC or market requests run when every group is opted out. Public RPC and
price services have availability/rate limits; no paid API is required.

Verify offline:

```bash
PYTHONPATH=services/telegram-bot DB_PATH=/tmp/bot-tests.sqlite \
  python -m unittest discover -s services/telegram-bot/tests -p test_buybot.py -v
```

CI runs each Telegram test file in a separate interpreter because some older
tests pin process-wide configuration before the bot's first import.

Telegram references: [InlineKeyboardButton](https://core.telegram.org/bots/api#inlinekeyboardbutton),
[python-telegram-bot 22.7](https://docs.python-telegram-bot.org/en/v22.7/telegram.inlinekeyboardbutton.html).
Pool event layout: [Uniswap v4 IPoolManager](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol).

### pump.fun buy bot

Every CYBER.sol buy worth at least `PUMPFUN_MIN_BUY_USD` (default $5) gets its
own post in `PUMPFUN_ANNOUNCE_CHAT` — amount in SOL and USD, amount in
CYBER.sol, buyer and transaction on Solscan, what the buy did to the buyer's
bag, and indicative FDV. Leave `PUMPFUN_ANNOUNCE_CHAT` empty to turn it off.

The English photo cards use the founder-provided Cyberia cube at
`/token-icons/cyberia-buybot.png`, a 🎲 size row and buttons inheriting Telegram's
theme: Buy on pump.fun, X / Twitter (`PROJECT_X_URL`), Roadmap
(`PUMPFUN_ROADMAP_URL`, the public `/whitepaper` roadmap) and 🎲 Cyberia Wallet.
`PUMPFUN_PHOTO_URL` selects the image; empty sends text. Explicit image
rejections fall back to text; ambiguous timeouts retain the delivery cursor.
The trade amount comes from the pool's balance delta, without a separate net
amount after fees. FDV uses total supply, not verified circulating supply.

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

USD value and — unless `PUMPFUN_POOL_ADDRESS` pins one — the pool address come
from the DexScreener pair feed. Without a readable SOL price the tick is
deferred rather than posting a buy it cannot size, so nothing is lost. On a
fresh install the cursor starts at the pool's current head: history is never
replayed into the chat.

The market cap is **not** the feed's. DexScreener's `marketCap` prices the coin
at the last trade's *average fill*, which for a buy always sits below the price
that same trade ended at, while the pump.fun page the post links to prices it
off the pool's reserves. Announcing a buy is exactly when the two disagree
most: a 6.94 SOL buy into an 88 SOL pool read $43.1k on the page while the feed
still said $39.9k, and the bigger the buy the wider the gap. So the cap is the
pool's own reserves as the announced trade left them — already present in the
balances the buy was parsed out of, so it costs no extra call and each buy in a
batch carries its own figure — times the mint's supply, read from the chain
every `PUMPFUN_SUPPLY_TTL_SECONDS` (default 3600, since a supply only moves on
a burn). If either is unreadable the post falls back to the feed's figure.

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

Automatic summaries cover new activity since the previous window and new or
materially changed market gaps, at most once per `DIGEST_INTERVAL_SECONDS`
(`0` mutes them). With neither, the window stays silent. The full price table
and CYBER.sol price line are available on demand via `/stats [window]`.

Sent as Telegram HTML in blocks separated by blank lines —
Telegram gives every line the same weight, so eight stacked lines read as one
grey paragraph. Each block leads with its headline number in bold and carries
its detail as `•` bullets under it; prices are an aligned `<pre>` table rather
than a run-on line of `SYM $price` pairs that wraps differently on every phone.

Numbers are formatted for a reader, not for `%g`: `_fmt_amount` never emits
scientific notation (a five-million-CYBER.sol bridge used to arrive as
`5.14993e+06`), `_fmt_usd` keeps three significant figures below a cent instead
of rounding to `$0.0000`, and `_fmt_price_usd` keeps four so a sub-cent coin
still differs from the next one. Token symbols come off pairs anyone may
create, so every dynamic string is HTML-escaped. In `/stats`, small changes in
the separate CYBER.sol price line are hidden by default
(`DIGEST_PRICE_CHANGE_MIN_BPS=100`) and `DIGEST_PRICE_TOKEN_LIMIT` caps the price
table. `tests/test_digest_format.py` pins the formatting.

Market gaps compare BTC, LTC, SOL, ETH, BNB, XMR, TRX and YTN wrappers from
`crypto/hardhat/deployments/cyberia-tokens.json` against CoinGecko IDs, and
CYBER.sol against its exact Solana mint on DexScreener. Unmapped assets such as
WCYBER and ASH are not matched to unrelated coins by ticker. Missing, stale or
unreadable references produce no signal; the Solana feed must have a trade in
its five-minute bucket and at least $1,000 of liquidity. USDC/USDT use their
external USD quotes rather than an assumed peg.

The scanner reads V2 reserves at one fresh Cyberia block, walks routes through
the configured anchors/relays (up to three pools), and calculates raw integer
outputs with each pool's 0.3% fee. It tries $1, $10 and $100 by default
(`MARKET_GAP_SIZES_USD`) and applies a 0.5% output buffer
(`MARKET_GAP_SLIPPAGE_BPS`). Only an edge of at least 3%
(`MARKET_GAP_MIN_BPS`) and $0.25 (`MARKET_GAP_MIN_USD`) is posted as an English
URL button, buys first and sells second. Each button names Cyberia, the token,
and the discount/premium, and opens `/swap` with the
correct input/output tokens on chain 49406. The message carries only a short
caption and the costs excluded from the comparison. This is a V2 comparison, not a
search of V3 or an executable quote on the outside venue. Gas, bridge capacity,
bridge fees and outside execution costs are not measured, so the post labels
the difference before these costs and never calls it net arbitrage profit.

An unchanged gap is not repeated. The next post requires a new token/side or a
change of at least two percentage points from the last published edge
(`MARKET_GAP_CHANGE_BPS`). A confirmed disappearance resets the signal; a
failed read preserves it. State is written to `bot_kv` only after delivery (or
a silent window with confirmed disappearances), so a failed Telegram send can
retry. `MARKET_GAPS_ENABLED=0` disables comparisons without muting activity.
`tests/test_market_gaps.py` covers sizing, price impact, freshness and delivery.

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

### Music: tracks on request

Three ways to get a song posted as an audio file:

* a **Yandex Music or VK track link** anywhere in a message, in any chat
  (`music.yandex.ru/album/…/track/…`, `music.yandex.ru/track/…`,
  `vk.com/audio-…_…`);
* **`/track Artist — Title`** (free words work too), or `/track` in reply to
  a message with a link or such a line;
* a **bare one-line "Artist — Title"** message. This one is answered only when
  a search returns that very song: artist and title must both match, in either
  order, a surname being enough for the artist. Anything else, a sentence with
  a dash in it included, gets no reply at all, and no 30-second preview is
  posted for it. Admins switch this off per chat with `/music off`
  (`/music` shows the state and the sources).

Sources, in the order they are tried for the file:

1. **Yandex Music in full**: needs `YANDEX_MUSIC_TOKEN` of an account with
   Plus. Search and track pages need no account.
2. **The same recording on VK**: artist and title match, length within
   ~6 %. Needs `VK_AUDIO_TOKEN`, a user token of the **Kate Mobile** client,
   the only kind `audio.*` still accepts. VK gives an mp3, or an HLS playlist
   of AES-128 MPEG-TS segments that `bot/music.py` decrypts and demuxes into
   one mp3 itself (no ffmpeg; pycryptodome, already there through web3).
3. **The Yandex 30-second preview**, only for a link or `/track`, captioned as
   a fragment, and never cached.

**Yandex Music answers HTTP 451 to hosts outside Russia**, and prod is in
Germany. Without `YANDEX_MUSIC_PROXY_URL` (an `http(s)://` proxy in Russia;
`socks5://` needs the `socksio` package, which is not installed) prod cannot
open a Yandex link at all: the source is parked for 30 minutes after a 451 and
the log says so once, and bare lines are searched on VK only.

Telegram's `file_id` of every full track sent is kept in `bot_kv`
(`music:tg:<source>:<id>`), so a song asked for again is one `sendAudio`
and no download. The handler is non-blocking: a download never holds up the
rest of the bot. Bot API uploads stop at 50 MB. `tests/test_music.py` pins
what counts as a request, the matching, the source order and the HLS reader.

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

### Камень–ножницы–бумага на токены чата

В группе `/rps 10` создаёт открытую дуэль на 10 токенов **этого чата**
(SOC23, CYBERIA_CHAT и любой токен из `chat_tokens`). Доступна каждому
участнику, без прав администратора, whale-проверки и привязки кошелька.
Используется накопленный внутренний баланс `pending_rewards`, который виден
в `/balance`: уже выведенные в кошелёк токены бот не списывает.

Автор резервирует ставку командой, первый другой участник резервирует такую
же ставку нажатием своего хода. Ходы скрыты до выбора обоих и не меняются.
Победитель получает обе ставки без комиссии на тот же баланс; `/claim`
выводит его обычным способом. Ничья возвращает обе ставки. Автор может
отменить вызов до вступления соперника. Через 10 минут от создания незавершённая
дуэль возвращает ставки обоим, независимо от того, кто успел выбрать ход.
Одна незавершённая дуэль на участника в каждом чате.

Состояние и резерв хранятся в SQLite (`rps_games`); списание, результат и
возврат атомарны, повторное нажатие не платит дважды. Фоновая проверка каждые
15 секунд возвращает просроченные ставки, в том числе после перезапуска.
Обработчики денежных операций синхронны внутри стандартного последовательного
диспетчера бота: не включайте `concurrent_updates` и не переносите `/claim`
в поток без отдельного протокола резервирования выплат.

### 🎰 Слоты на токены чата

`/slots 10` — автомат в чате, играющий на тот же внутренний баланс
(`pending_rewards`), что и `/rps`. Без аргумента `/slots` показывает сам
автомат: таблицу выплат, кассу, ваш баланс и максимальную ставку.

**Барабаны — Telegram'а.** Бот отправляет нативный 🎰-дайс и записывает то, что
вернул сервер: выбрать значение, подсмотреть заранее или переиграть он не может.
В игре на деньги «поверьте в честность бота» — не ответ, а `random.randint` был
бы именно им.

**Ничего не эмитируется.** Проигранная ставка уходит в кассу чата, выигрыш
приходит из неё, так что сумма всех `pending_rewards` плюс касса не меняется ни
при каком раскладе барабанов. Касса и есть главная часть конструкции, и ведётся
она как инвентарь моста: **ставка отклоняется до того, как крутятся барабаны,
если касса не потянет джекпот** — и никогда после. Каждый спин держит свой
худший случай (`ставка × 28`) до расчёта, поэтому два спина в одну секунду не
могут быть обещаны одними и теми же деньгами, а максимальная ставка печатается
на экране, а не выясняется проигрышем.

Таблица выплат (множитель на всю ставку):

| Комбинация | Выплата | Шанс |
|---|---|---|
| `7️⃣ 7️⃣ 7️⃣` | ×28 | 1/64 |
| `BAR BAR BAR` | ×13 | 1/64 |
| `🍋 🍋 🍋` | ×6 | 1/64 |
| `🍇 🍇 🍇` | ×4 | 1/64 |
| `7️⃣ 7️⃣ + любой` | ставка назад | 9/64 |

Возврат — **93.75%**, и это число `rtp()` считает из самой таблицы, а не
написано рядом с ней: первая редакция этих множителей читалась как 93.75%, а
платила 112.5%, потому что «две семёрки» — девять исходов из 64, а не три
(лишний барабан может стоять на любой из трёх позиций с любым из трёх других
символов). Цифра, которую таблица может опровергнуть, рано или поздно её
опровергнет.

Касса пополняется вручную: `/slots_bank` показывает её, `/slots_bank 500`
(только админы чата) переводит туда токены со своего накопленного баланса.
Обратно касса не выводится — возврат потребовал бы долей вкладчиков, то есть
пула ликвидности, а не автомата; вместо этого касса растёт на 6.25% оборота.
Пустая касса — закрытый автомат, и он так и пишет.

Ставка и резерв кассы берутся **до** отправки дайса, потому что после анимации
честно отказать уже нельзя. Если дайс не вернулся (бот умер в этом односекундном
окне), спин висит `spinning` и фоновая проверка возвращает ставку: значение
осталось на стороне Telegram, и выплатить его — значит его выдумать. Результат
публикуется отдельной фоновой задачей через ~2.4 с, ровно чтобы не выдать его до
конца анимации; расчёт к этому моменту уже в базе, так что потеря задачи стоит
сообщения, но не выплаты.

Один спин на игрока за раз и не чаще раза в 5 секунд: автомат печатает два
сообщения на дёрг, и неограниченный цикл — это флуд со ставкой.

Все участники чата по-прежнему крутят `/slots` от своего аккаунта. Дополнительно
создатель чата может крутить его анонимно от имени самого чата. Telegram не
передаёт боту ID автора такого сообщения, поэтому это разрешено только когда
создатель — **единственный** анонимный администратор: иначе анонимного
администратора нельзя отличить от создателя, и команда не имеет права тратить
баланс владельца. Команды от связанного канала также не допускаются.

Состояние — `slots_bank` и `slots_spins`. Деньги обеих игр живут в одном модуле
`bot/stakes.py`: два места, умеющих двигать баланс, — это два способа заплатить
ставку дважды.
