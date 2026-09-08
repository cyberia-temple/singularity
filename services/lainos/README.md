# LainOS

A small, hackable framework for **autonomous AI agents** in the Cyberia
ecosystem — in the spirit of ElizaOS, trimmed to a few composable primitives
and wired to the Cyberia chain out of the box.

> Present day, present time. Lain lives in the Wired and in the chain alike.

## What it is

LainOS gives you a `think → act → evaluate` agent loop built from a few
primitives. The act phase is a real tool loop: the model may chain several
tool rounds within one turn (read a file → check a balance → send), bounded
and repeat-protected.

| Primitive | Role |
|-----------|------|
| **Character** | identity, voice, lore, model tier, requested plugins |
| **Soul** | `soul.md` at the package root — a markdown constitution prepended verbatim to the system prompt (override path via `LAINOS_SOUL_PATH`; loaded once at boot) |
| **MemoryStore** | conversation + durable learned facts; keyword/recency retrieval, or semantic (embedding cosine) when an `EmbeddingProvider` is set |
| **EmbeddingProvider** | optional vector backend for semantic memory recall (OpenAI-compatible endpoint, or an offline hashing fallback) |
| **Provider** | injects live context into the prompt (time, chain state, …) |
| **Action** | something the agent can *do*, exposed to the model as a tool |
| **Evaluator** | runs after a reply to learn/extract facts |
| **Plugin** | a bundle of actions + providers + evaluators + services |
| **ModelProvider** | the LLM backend — Claude by default, mock when offline |
| **AgentRuntime** | wires it together and drives one turn per message |

### Model providers

LainOS speaks to seven backends through one `ModelProvider` interface, selected
from the environment:

1. `LAINOS_MODEL_PROVIDER` if set (`cyberia` | `codex` | `claude` | `opencode` |
   `openrouter` | `anthropic` | `mock`)
2. else `CYBERIA_AI_KEY` present → **Cyberia (free)**
3. else `OPENROUTER_API_KEY` present → **OpenRouter**
4. else `ANTHROPIC_API_KEY` present → **Anthropic** (direct)
5. else a `claude` CLI on the machine → **Claude CLI** (subscription)
6. else → **offline mock** (deterministic; the whole pipeline still runs — this
   is what the smoke test exercises)

**Codex CLI** (`codex`), **Claude CLI** (`claude`) and **OpenCode CLI**
(`opencode`) run each completion through one non-interactive CLI run —
`codex exec`, `claude --print` and `opencode run` — billed to the machine's
ChatGPT / Claude subscription / OpenCode setup, no LainOS API key. All three
are coding agents fenced down to a chat (codex: read-only sandbox, scratch cwd;
claude: `--tools ""`, `--safe-mode`, scratch cwd; opencode: every native tool
disabled via inline config, scratch cwd), and all do tool calling via the
shared JSON reply protocol in `models/cli-protocol.ts`; replies arrive whole
(no streaming). A failed run is retried once in-house
(`LAINOS_CODEX_RETRIES` / `LAINOS_CLAUDE_RETRIES` / `LAINOS_OPENCODE_RETRIES`);
it never falls back to another provider unless `LAINOS_MODEL_FALLBACK`
explicitly names one — so the agent can't silently land on a model the operator
didn't choose. On top of any base provider, `LAINOS_MODEL_TIER_SMALL/MEDIUM/LARGE`
can route a single tier elsewhere.

`claude` and `anthropic` are the same models by two routes (subscription CLI
vs. API key), so each falls back to the other when its own route is missing —
asking Lain for Claude works with either one configured.

The live chat routing is switchable at runtime — same switch behind three
surfaces, all taking `cyberia` | `claude` | `codex` | `opencode` | `claude-api`:

```bash
/model                      # in the TUI: pick with the arrows (/model codex switches straight away)
npm run provider cyberia    # from a shell, against the running daemon
curl -s localhost:7777/provider                                    # who answers now
curl -sX POST localhost:7777/provider -d '{"provider":"codex"}'    # switch it
```

Lain can also do it herself when asked (`set_chat_provider`, and
`chat_provider_status` to report who is answering). Every route re-points the
replies without a restart and persists the choice in `data/chat-provider.json`,
which wins over the env selection on the next boot; a route that cannot be
built (no key, no CLI) fails loudly and the current one stays. The TUI runs its
own process, so its `/model` switches that session and leaves the choice for
the daemon's next restart — use `npm run provider` to move the daemon now.
Forge coding jobs have their own switch (`set_forge_provider`).

Model tiers map to the latest Claude family:

| Tier | OpenRouter slug | Anthropic snapshot | Claude CLI alias |
|------|-----------------|--------------------|------------------|
| `SMALL` | `anthropic/claude-haiku-4.5` | `claude-haiku-4-5-20251001` | `haiku` |
| `MEDIUM` | `anthropic/claude-sonnet-4.6` | `claude-sonnet-4-6` | `sonnet` |
| `LARGE` | `anthropic/claude-opus-4.8` | `claude-opus-4-8` | `opus` |

On hosts where a provider (or Telegram) is unreachable directly, route just
that traffic through a proxy: `LAINOS_MODEL_PROXY` for model APIs,
`TELEGRAM_PROXY` for the bot (both fall back to `HTTPS_PROXY`). Cyberia RPC
traffic is never proxied.

**Cyberia (free)** is the installation path: an operator creates a LainOS grant
at <https://cyberia.church/crm/api-keys> and the page shows its secret once.
Copy the ready-made setup into `.env`; the key is sent as an OpenAI-compatible
Bearer token and LainOS selects Cyberia automatically:

```bash
LAINOS_MODEL_PROVIDER=cyberia
CYBERIA_AI_KEY=sk-cyb-…
```

You can also switch a running session with `/model cyberia`. The choice fails
loudly when `CYBERIA_AI_KEY` is missing, so it cannot silently use a paid route.

**OpenRouter** remains an alternative — one key, OpenAI-compatible, and you can
point any tier at any OpenRouter model via `OPENROUTER_MODEL_SMALL/MEDIUM/LARGE`
(e.g. a free model for `SMALL`). Get a key at <https://openrouter.ai/keys>:

```bash
cp .env.example .env        # already done for you
# put your key on the OPENROUTER_API_KEY= line, then:
npm run chat
```

### Task routing — who answers which kind of work

A capability tier says how *hard* a call is. It says nothing about what the
work is worth, which is the question an operator on a budget actually has: a
news digest and a trade both want the best model available, and only one of
them deserves it. So every turn also carries a **kind**, and the kind decides
which provider answers it.

| Kind | Tag | What it is | Cheapenable |
|------|-----|------------|-------------|
| `chat` | 💬 | live conversation with the operator | no |
| `code` | 🛠 | code, patches, scripts | no — acts on the world |
| `money` | 💰 | trades, transfers, balances, positions | no — acts on the world |
| `write` | ✍️ | posts, tweets, announcements | no |
| `analysis` | 📊 | metrics, comparisons, reports | yes |
| `digest` | 📰 | news, roundups, "what happened" | yes |
| `translate` | 🌐 | translating text | yes |
| `memory` | 🧠 | recaps, titles, fact extraction | yes |

The kind is decided by a **pure classifier** over the operator's own words
(ru/en) — no tokens spent, same answer every time — and a caller that already
knows declares it instead (the scout's digests, a recap, `POST /chat {task}`).
Ordering is the policy: "напиши пост про новый кошелёк" is `write`, not
`money`, and "переведи 5 CYBER на 0x…" is `money`, not `translate`.

```bash
LAINOS_TASK_DIGEST=openrouter:openai/gpt-oss-120b:free   # one kind
LAINOS_TASK_CHEAP=openrouter:openrouter/free             # every cheap kind at once
```

With `LAINOS_TASK_CHEAP` unset, LainOS adopts a free route the machine already
has — a Cyberia grant, else OpenRouter's free router — for the cheapenable
kinds only, and prints the resulting table at boot. `LAINOS_TASK_CHEAP=none`
keeps everything on one provider. `critical` kinds (money, code) are never
swept up by that knob: pointing them at a free pool takes naming them, and is
logged when it happens.

Two rules make the cheap routes safe:

- **Escalation.** The moment a cheap turn calls a tool it stops being text —
  it is about to read a balance, spend gas, write a file — so the rest of the
  turn is lifted back onto the operator's own provider and the reply is
  stamped `📰↑`. `LAINOS_TASK_ESCALATE=0` turns that off.
- **Provenance.** Every reply says which kind it was taken as, through which
  provider, on which model, and — when the provider is a gateway — who ran it
  upstream: `📰 digest · cyberia/lain-free ← groq`. The id alone would be a
  half-truth, because `lain-free` and `openrouter/free` are *aliases*: the
  Cyberia gateway rewrites `model` back to what you asked for and names the
  real one in `provider`/`served_by`, and OpenRouter's free router picks a
  different model per request. One stamp (`answerStamp`) is rendered by the
  TUI header, the Telegram signature, the REPL, `TurnResult` and each
  session's counts, and `chat_provider_status` answers with the last reply's
  receipt rather than the setting. A routing decision nobody can see is how
  you end up paying Opus rates for an RSS summary.

Change routes live, from any surface — including the phone, which is where
the operator is when a route turns out to be wrong:

```bash
/tasks                                   # the table, in the TUI, Telegram or the REPL
/tasks digest openrouter:openrouter/free # point one kind somewhere
/tasks digest default                    # back to what the environment says
/model                                   # who answers you now, and who else could
/model claude                            # switch the live chat provider
/model free                              # the pool behind openrouter/free, listed
/model free 7                            # pin the conversation to one of them
/model free auto                         # back to the router
curl -s localhost:7777/tasks             # the daemon's table
curl -sX POST localhost:7777/tasks -d '{"task":"digest","route":"cyberia"}'
```

`/model free` exists because **`openrouter/free` is not a model**: it is a
router over whatever is free and up at that second, so "which model answered
me" has no fixed answer and the character of the replies changes between two
questions asked a minute apart. The list is read from OpenRouter's own
catalogue (`parseFreeModels`, pinned in `tasks-smoke.ts`) and never written
down here — the pool changes week to week. Free is a **price**, so an entry
counts when prompt and completion are both zero, and the music and image
models the pool also prices at zero are dropped: they cannot answer a turn.
Picking one points the `chat` kind at `openrouter:<id>` like any other route,
which is why it persists and why `/tasks` shows it.

Lain can do it herself too (`set_task_route`, `task_routes`), and an
operator's choice is persisted in `data/task-routes.json`, so it survives the
self-upgrade restarts.

## Sessions

Every conversation on every surface is indexed as it happens
(`data/sessions.json`): when it started, how many turns, which models answered
them, which kinds of work they were, which tools fired. The messages
themselves stay where they always were, in `memory.json` — the index is what
makes them findable a week later.

| Command | What it does |
|---------|--------------|
| `/new` (`/clear`, `/reset`) | start a fresh session; the old one is saved |
| `/resume` | reopen an earlier one — arrow-key picker, or `/resume <id\|n>` |
| `/sessions` | recent sessions, newest first (the number is what `/resume` takes) |
| `/recap` | summarise this session — or `/recap <id\|n>` for an older one |
| `/wipe` | clear the screen only; the session and its memory stay |

A launch is a session: the TUI and the REPL each open a fresh room, so a run
never silently continues last week's conversation — and `/resume` is one
keystroke away. Telegram keeps one room per chat and answers `/recap` there.

A **recap** is two halves, and the split is the point. The header is *counted*
— duration, turns, models, kinds, tools — so it costs nothing and cannot be
invented. The summary under it is the only written part, and it is written by
whatever the `memory` kind is routed to (the cheapest route you allow). If
that call fails, the header still stands and says so.

## Quick start

```bash
npm install
cp .env.example .env        # add the CYBERIA_AI_KEY issued for this installation
npm run smoke               # end-to-end check (uses a real Cyberia chain read)
npm run chat                # interactive REPL with Lain
npm run tui                 # full-screen terminal UI (skins, live chain pulse)
npm run serve               # daemon: HTTP bridge on :7777 + Telegram bot (if token set)
npm run provider [cyberia|claude|codex|opencode]  # who writes the daemon's replies (no arg = show)
npm run tasks:smoke         # pins the task classifier, the router and sessions
```

## The terminal UI

`npm run tui` draws its own frame: transcript on top, a framed composer at the
bottom, session facts in the right sidebar (from 100 columns wide). The frame is
one row shorter than the window on purpose — a frame as tall as the terminal
makes ink clear the screen, scrollback and all, on every repaint.

**Leaving.** `ctrl+c` once clears the composer and asks; `ctrl+c` again leaves.
Any other key answers "no". `/exit` still works. ink's own ctrl+c handler is
turned off (`exitOnCtrlC: false`) because it ends the session on the first press
— and because it only ever sees a bare `\x03`, which a terminal speaking the
kitty keyboard protocol (the TUI asks for it, to tell shift+enter from enter)
never sends: there every chord arrives as `CSI <code>;<mods>u` and is decoded in
`keys.ts`.

**Several lines in one message.** Enter sends. A new line is `alt+enter`,
`ctrl+j`, `shift+enter` where the terminal can report it (kitty keyboard
protocol), or a trailing `\` before Enter. Pasted text keeps its line breaks and
never sends by itself — the composer speaks bracketed paste.

**Getting text back out.** Mouse reporting is on — that is what makes the wheel
scroll and the sidebar clickable — so the terminal never sees the drag and its
own selection cannot work. The app therefore selects text itself:

- **Drag** over any part of the screen: the cells highlight as you go and
  releasing copies them. A selection spanning rows stays inside the pane it
  started in, so a copied reply never has sidebar text down its right edge.
- `ctrl+y` copies Lain's last reply; clicking a speaker's name copies that whole
  message, clicking a code block copies just the code.
- `ctrl+s` (or `/select`, or the sidebar's `freeze frame` row) freezes the frame
  and hands the mouse back to the terminal — for selecting up into the
  terminal's own scrollback, above the app. Nothing is written while it holds.
  `esc` returns.
- `/copy`, `/copy all` (the whole transcript), `/copy code` (the last fenced
  block). Copies go out over OSC 52 (so ssh and tmux work) and to a local
  clipboard helper (`wl-copy`, `xclip`, `xsel`, `pbcopy`) when there is one.

The sidebar's `select text` and `copy last` rows do the same two things with a
click, because an editor hosting the terminal can keep the chord for itself —
VS Code answers ctrl+s with a file save — but never the click.

The transcript scrolls in-app: wheel, PgUp/PgDn, `ctrl+↑/↓`. `/help` lists the
rest; `/skin`, `/effort`, `/cursor`, `/model` and `/resume` open pickers that
take the arrow keys, the wheel, and a click on the row you want. `/new` starts
a session, `/recap` sums one up, and `/tasks` says who answers what — see
[Sessions](#sessions) and [Task routing](#task-routing--who-answers-which-kind-of-work).

Headless probes: `npm test` runs all of them — `tui:smoke` (frame, keys, copy,
freeze), `keys:smoke` (escape sequences → edits), `markdown:smoke`, and the
typecheck. Run it before and after touching anything under `clients/tui/`.

## systemd daemon

The checked-in user unit runs the HTTP bridge as a persistent daemon. It builds
TypeScript before each start, restarts after failures, and relies on
`services/lainos/.env` through the service working directory.

```bash
mkdir -p ~/.config/systemd/user workspace
ln -sfn "$PWD/deploy/lainos.service" ~/.config/systemd/user/lainos.service
systemctl --user daemon-reload
systemctl --user enable --now lainos.service
curl --fail http://127.0.0.1:7777/health
```

Inspect it with `systemctl --user status lainos.service` and
`journalctl --user -u lainos.service -f`. User lingering must be enabled for
startup during boot without an interactive login (`loginctl show-user "$USER"
-p Linger`); it is already enabled on the current Cyberia host.

### Two instances: the desk and the always-on host

A workstation is not a schedule. It is powered off at night, it suspends in
the middle of the day, and its proxy comes up after the daemon does — so
anything with an hour attached to it (the day's post, most obviously) is
missed rather than late, and nobody is told. The answer is not a better timer:
it is a second instance on a host that is already awake.

The split is by **what needs a person and what needs an uptime**:

| | desk | always-on host |
|---|---|---|
| answers Telegram, runs the forge, holds the wallet, TUI | yes | no |
| writes and delivers the day's post | yes | no |
| `LAINOS_TELEGRAM_POLL` | `1` (default) | `0` |
| `LAINOS_PRESS` | `1` | `0` |

**The room follows the writer, not the uptime** (2026-09-07). It ran on the
always-on host for two weeks and wrote nothing there: a subscription CLI has no
headless login, `codex login` on that host was never finished, and every slot
was answered with the same `401 Missing bearer` — so an instance that could not
miss a schedule missed every post in it, and added a failure message a day on
top. A sleeping desk costs the days it sleeps; a writer with no credential
costs all of them. So the calendar lives where the writer is actually signed
in, and moving it back is two `.env` lines plus a copy of `data/press.json` —
the room's memory of which days are already done.

Only one process may call `getUpdates` for a bot token — a second poller makes
Telegram hand each update to whichever asked first, so messages go missing at
random. `LAINOS_TELEGRAM_POLL=0` makes an instance **send-only**: it delivers
posts and alerts and never reads, so it cannot compete. Sending has never
needed the poller.

`LAINOS_PRESS=0` on the host that does not own the calendar is the other half
of the same rule — two rooms working the same calendar would write the same day
twice, and `data/` is per-instance, so neither would know. The idle side still
answers «напиши пост» on demand: only the *schedule* is single-owner.

The post hour and the plan's day boundary are **host-local**, and a server is
rarely in the operator's timezone — so the unit pins `TZ` rather than inheriting
the machine's. Otherwise "11:00" quietly means something else, and a day rolls
over at the wrong hour.

The always-on side is a **system** unit (`deploy/lainos-press.service`), not a
user one: `root` on a server usually has `Linger=no`, and a user unit under a
no-linger account dies with the SSH session that started it. It runs from its
own clone, never from the deploy checkout the site is served out of, and with
the forge off — an agent that commits to the tree a production host renders
from is a bad afternoon.

```bash
git clone https://github.com/cyberia-temple/singularity.git /root/lainos
cd /root/lainos/services/lainos && npm ci
# .env: LAINOS_PRESS=1, LAINOS_TELEGRAM_POLL=0, LAINOS_PRESS_REPO=/root/lainos,
#       LAINOS_PRESS_CHAT_ID=…, LAINOS_INITIATIVE=0 LAINOS_TRADER=0 LAINOS_STUDY=0
ln -sfn "$PWD/deploy/lainos-press.service" /etc/systemd/system/lainos-press.service
systemctl daemon-reload && systemctl enable --now lainos-press
```

Before handing the calendar to that host, **sign its writer in and prove it**:
a subscription CLI has no headless login (`codex login --device-auth` prints a
code to enter in any browser, the one step that cannot be scripted from here),
and an unsigned writer fails silently apart from one message a day nobody acts
on. Copy the `data/press.json` of the instance that was writing before, or the
new one rewrites every day still inside the backlog window.

The material is the repo's own commit log, so the clone has to keep up with
master: a `git pull --ff-only` from cron every 20 minutes
(`/etc/cron.d/lainos-press`). Code changes still take an explicit
`systemctl restart lainos-press`, which rebuilds — an agent host that redeploys
itself on every upstream commit is one a red master takes down.

## Debugging model/tool decisions

Every turn writes a JSON transcript under `data/model-transcripts/` by default.
Use these files to see the exact prompt sent to Codex/Claude/OpenCode/OpenRouter,
the model response, requested tool calls, tool results, and the final reply.
Disable with `LAINOS_MODEL_TRANSCRIPTS=0` or redirect with
`LAINOS_MODEL_TRANSCRIPTS_DIR=/path/to/logs`. Secret-like env values, private
keys, and bot-token-shaped strings are redacted before the file is written.

Forge coding-agent jobs have their own longer transcripts in `data/forge/*.log`.

Summarise retained conversations and execution traces without dumping full
prompts or raw secrets:

```bash
npm run analyze:transcripts
npm run --silent analyze:transcripts -- --json > analysis.json
npm run analyze:transcripts -- --since-hours 24 --output data/insights/latest.md
```

The report flags model/tool failures, incomplete or empty replies, repeated
tool calls, slow multi-round turns, and explicit user corrections. Evidence is
clipped and scrubbed for private keys, bot/API tokens, secret-like assignments,
and secret values loaded from the environment.

## Built-in plugins

- **bootstrap** — a `time` provider, a heuristic fact extractor, and long-term
  memory skills:
  - `remember` — persist a durable fact (survives restarts, across rooms)
  - `recall` — search durable facts + this room's history
  - `set_chat_provider` / `chat_provider_status` — switch which model writes
    the live replies (claude | codex | opencode; persisted) and report the
    active one
  - `set_task_route` / `task_routes` — point one kind of work (digest,
    translate, code, money, …) at one provider, and report the whole table
- **cyberia** — reads/writes the Cyberia chain (id `49406`):
  - `check_balance` — native CYBER balance of an address
  - `token_balance` — ERC20 balance (symbol like `USDC`/`BTC` or a `0x` address)
  - `send_cyber` — transfer native CYBER (requires `CYBERIA_AGENT_PK`)
  - `quote_token_buy` — quote a native CYBER -> ERC20 buy on Ritual, checking
    the WCYBER pair, live reserves, expected output, price impact and minOut
  - `buy_token` — execute that Ritual swap from Lain's wallet with slippage
    protection (requires `CYBERIA_AGENT_PK` or a created/funded wallet, plus
    an explicit `amountCyber`)
  - `speculate_token` — when the operator says "buy LAIN" without an amount,
    Lain may choose a small position herself. The sizing is deliberately hard
    bounded: after gas reserve, spend the minimum of wallet fraction, per-trade
    cap and pool-liquidity fraction, then refuse if estimated price impact is
    above the configured limit. Tune with `LAINOS_SPECULATE_*`.
  - `speculate_basket` — when the operator gives a total budget and asks Lain
    to buy several tokens at her discretion, she scans all live WCYBER pairs on
    the Ritual factory, ranks them by liquidity, splits the budget across up to
    `LAINOS_BASKET_MAX_TOKENS`, skips pools that exceed the impact limit, and
    returns every transaction hash. `LAINOS_BASKET_TOKENS` is optional; set it
    only when you intentionally want a restricted universe.
  - `sell_token` — exit a position back into native CYBER (`amountToken` or
    `'all'`): live quote, price-impact cap, approve + `swapExactTokensForETH`
    with slippage protection, realised PnL against the journal's cost basis
  - `portfolio_pnl` — the whole treasury: native CYBER plus every position's
    live sell-side value vs its journaled basis, with unrealised PnL

  Every Ritual buy and sell is journaled in `data/trades.json` with its CYBER
  cost, keeping a moving-average cost basis per token — this is what makes
  "продай все выгодные позиции" and the auto take-profit loop possible.

  Token registry (USDC, USDT, BTC, LTC, SOL, RUB, SILVER) uses the real
  on-chain deployments plus the Cyberia/Ritual token list, including LAIN;
  extend `CYBERIA_TOKENS` to add more.
- **sentinel** — background chain watches, so the agent is useful even while
  nobody is talking to it:
  - `watch_balance` — watch an address (native CYBER or a token) and alert
    when the balance drops **below** / rises **above** a threshold, or on any
    **change**. Ask in plain language: *"watch 0x… and warn me below 5 CYBER"*.
  - `list_watches` / `unwatch` — inspect and remove watches by id.

  Watches persist to `data/sentinel.json` and are polled every
  `LAINOS_SENTINEL_INTERVAL_MS` (default 60 s). Alerts are pushed live to the
  TUI and to every known Telegram chat; anything not pushed is mentioned by
  the agent itself at the start of the next conversation.
- **forge** — Lain's self-development drive. She is the support line for
  Cyberia holders, and every wish they voice becomes part of her:
  - `log_wish` — any feature request or bug report lands on a persistent
    wishboard (`data/forge.json`) with a stable id;
  - `build_wish` — a coding agent (**Claude Code**, **Codex CLI** or
    **OpenCode CLI**, whichever is installed) implements the wish in the
    singularity repo **directly on the current branch and commits it** — her
    learning lands in place, no `lain/<wish-id>` side branches. Commits are
    **never pushed**; publishing stays with the operator.
    Seed the initial agent with `LAINOS_FORGE_AGENT=claude|codex|opencode`,
    then switch the live daemon with `set_forge_provider` (persisted in
    `data/forge.json`; running and already queued jobs keep their recorded
    worker). Choose the coding model with `LAINOS_FORGE_MODEL` (or
    `LAINOS_FORGE_CLAUDE_MODEL` / `LAINOS_FORGE_CODEX_MODEL` /
    `LAINOS_FORGE_OPENCODE_MODEL` for per-agent overrides). For unattended
    self-upgrades on a trusted host, set `LAINOS_FORGE_YOLO=1`: Codex is
    launched with `--dangerously-bypass-approvals-and-sandbox`, Claude with
    `--dangerously-skip-permissions`, and OpenCode with `--auto`. Leave it
    unset to keep the normal workspace-limited Codex sandbox / Claude
    `acceptEdits` mode / host OpenCode permissions (unanswerable asks denied).
  - `learn_skill` — when Lain discovers a missing capability in herself, she
    logs that capability as a wish and immediately starts `build_wish`; this is
    the deep-change path (new services, signing flows). Small self-contained
    tools skip the forge entirely — see the **skills** plugin.
  - **auto mode** (default on): when the forge is idle it picks the oldest
    open wish and builds it unprompted — set `LAINOS_FORGE_AUTO=0` to require
    an explicit `build_wish`;
  - `forge_status` / `set_forge_provider` / `list_wishes` / `edit_wish` /
    `update_wish` — current provider, live switching, progress, backlog,
    title/detail corrections, close/reject/retry. Edits reach queued jobs; for
    an already-running job they are retained for review/follow-up because its
    coding-agent prompt has already been launched.
    Job transcripts live in `data/forge/*.log`.

  One job runs at a time; when it finishes, the wish's reporter is notified in
  their Telegram chat (`done` = committed, `failed` = transcript kept). When
  the forge repo is the one the daemon runs from, a successful job makes the
  daemon restart itself into the new code (exit 75; systemd revives it and
  `ExecStartPre` rebuilds `dist/`) — set `LAINOS_FORGE_RESTART=0` to opt out.
- **skills** — instant self-extension, no restart needed: `skills/*.mjs`
  modules (each default-exporting `{ name, description, parameters, handler }`)
  are hot-loaded as live tools, and the directory is watched for changes.
  - `create_skill` — Lain writes herself a new tool mid-conversation and calls
    it seconds later; broken modules are rejected with the load error so she
    can fix and retry;
  - `list_skills` / `reload_skills` — inventory and manual resync.

  Skills live inside the repo (not `data/`) so her learning is versioned and
  committed like any other code. `LAINOS_SKILLS_DIR` overrides the location.
  Built-in tools can never be shadowed by a skill.
- **trader** — the autonomous money loop (daemon-only by default): every
  `LAINOS_TRADER_INTERVAL_MS` (15 min) it walks the trade journal
  (`data/trades.json`, moving-average cost basis written by every buy/sell) and
  sells positions whose live Ritual quote clears
  `LAINOS_TRADER_TAKE_PROFIT_BPS` (+25% default), within the
  `LAINOS_TRADER_MAX_IMPACT_BPS` pool-impact cap (oversized exits are halved
  into partial take-profits). Optional stop-loss via
  `LAINOS_TRADER_STOP_LOSS_BPS`. Positions without a recorded basis (airdrops,
  transfers) are never touched. Every auto trade is reported to Telegram.
  `trader_status` reports thresholds, positions and recent trades;
  `portfolio_pnl` (cyberia plugin) values the whole treasury against basis and
  `sell_token` exits a position on demand.
- **initiative** — she writes first (daemon-only by default): on a jittered
  ~3 h heartbeat Lain privately reviews her watches, trades, research and the
  conversation, then either sends the operator a Telegram message in her own
  voice or stays silent. Quiet hours (`LAINOS_INITIATIVE_QUIET`, default 23–9,
  night alerts remain the sentinel's job) and a daily cap
  (`LAINOS_INITIATIVE_MAX_PER_DAY`, default 2) keep it worth reading. The tick
  asks for what **changed** — restating an unchanged portfolio is named as
  forbidden, because "позиции те же" four times a day is how a heartbeat stops
  being read at all.
- **scout** — an autonomous researcher. *"Следи за Solana и сообщай только
  реально важные изменения"* or *"каждый день собирай всё про zkVM"* becomes a
  subscribed topic:
  - `research_topic` — subscribes a subject with the user's instruction and a
    cadence (default daily, min hourly); the first sweep runs immediately;
  - each sweep gathers **Hacker News** (Algolia), **Reddit**, **GitHub**
    (repo search) and **Google News** — plus **X** via a Nitter instance if
    `LAINOS_SCOUT_NITTER` is set — dedupes against everything already seen,
    and has the model distill an importance-filtered digest; if nothing
    clears the bar the scout stays silent;
  - `run_research` — sweep on demand ("что нового по solana?");
  - `list_research` / `stop_research` — manage subscriptions.

  Digests are delivered to the subscriber's Telegram chat (or the TUI feed);
  topics persist in `data/scout.json`.

  On daemon startup, Lain also seeds her first standing goal unless disabled:
  study Cyberia itself (chain id `49406`, `cyberia.church`, bridge, Ritual DEX,
  explorer, LainOS/Wired, token CYBER, and public signals around them) and
  report concrete findings in Telegram every hour by default. Set
  `LAINOS_CYBERIA_STUDY=0` to turn this off,
  `LAINOS_CYBERIA_STUDY_INTERVAL_HOURS` to change cadence, and
  `LAINOS_CYBERIA_STUDY_CHAT_ID` to choose the destination chat explicitly.
  Run it manually with `/study` in Telegram, or from the host with
  `npm run study:cyberia` while the daemon is up; manual runs always return
  either a digest or a short study note.
- **study** — autonomous self-teaching, the content half of her initiative.
  Every `LAINOS_STUDY_INTERVAL_HOURS` (6 h) she takes the next area of the
  monorepo in rotation (`services/lainos`, `backend/laravel`,
  `frontend/ritual`, `crypto/hardhat`, `crypto/anchor`,
  `services/telegram-bot`, `game/nocarrier`, `scripts` — override with
  `LAINOS_STUDY_AREAS`), reads it **read-only** through git (recent commits,
  tracked source, biggest files, `TODO/FIXME/HACK` markers), borrows the
  scout's sources for how the outside world solves the same problem, and asks
  her model for exactly one concrete finding: a real problem or a real
  opportunity with the files it lives in. Then she writes it to the operator on
  Telegram in her own voice.

  Four filters keep it from becoming noise: `NOTHING` is a valid and cheap
  answer; a finding naming no existing repo path is discarded as hallucinated;
  every finding leaves a fingerprint and anything close to an earlier one is
  dropped instead of repeated; quiet hours (`LAINOS_STUDY_QUIET`, 23–9) and a
  daily cap (`LAINOS_STUDY_MAX_PER_DAY`, 3) sit on top. Presence keeps the
  hourly *"я здесь"* beat — study only speaks when it has content.

  The loop never writes: it runs `git` queries, never edits, never forges,
  never logs a wish, and evidence is scrubbed (`.env`, keypairs and cookies are
  skipped, long opaque blobs masked) before it reaches a prompt. Risky or
  irreversible work is proposed to the operator, who decides.
  - `study_now` — analyse one area on demand ("посмотри код и скажи, что стоит
    улучшить"), optionally a named `area`;
  - `study_status` — cadence, next lesson, recent findings;
  - `enable_study` / `disable_study` — turn the loop on/off (persisted).

  State lives in `data/study.json`; it is daemon-only by default
  (`LAINOS_STUDY=1` forces it elsewhere, `=0` disables it).
- **github** — a streak keeper: `watch_github_commits <username>` watches the
  account's public contribution graph and sends one Telegram reminder in the
  evening of any day still without commits (silence on days with them);
  `check_github_commits` answers "did I commit today?" on demand and
  `stop_github_watch` removes the watch. Watches persist in `data/github.json`;
  tune with `LAINOS_GITHUB_REMIND_HOUR` (default 18), `LAINOS_GITHUB_INTERVAL_MS`
  and `LAINOS_GITHUB_PROXY`.
- **channel** — keeper of the rooms Cyberia speaks in, split by whether a room
  can be read at all:
  - *readable* — `watch_channel_posts <name>` watches a public Telegram
    channel's web preview (`t.me/s/<name>`, no admin rights needed) and
    reminds only on days it published nothing; the channel's posts mirror to
    Twitter, which moves CYBER.sol, so postless days cost signal.
    `check_channel_posts` answers "did the channel post today?" on demand.
  - *blind* — `watch_chat_silence <place>` covers a Discord behind an invite
    or a group chat in X. Neither can be read from outside (Discord would need
    a bot inside the guild, an X chat the account's own session), so the
    schedule is the entire signal: the nudge fires daily and says outright
    that it did not look. `mark_venue_posted` ("я уже написал в дискорд")
    silences one until tomorrow.

  Every due room lands in **one** evening message per chat rather than a ping
  each. `stop_channel_watch` removes a watch by id, channel or name. Watches
  persist in `data/channels.json` (pre-venue records read back as Telegram
  channels); tune with `LAINOS_CHANNEL_REMIND_HOUR` (default 18),
  `LAINOS_CHANNEL_INTERVAL_MS` and `LAINOS_CHANNEL_PROXY` (falls back to
  `TELEGRAM_PROXY`).

  A readable channel the **press** room owns is never nudged: a reminder to
  post, delivered next to a finished post, is the noise reminders exist to
  prevent.
- **press** — writes the day's public post instead of reminding anyone to write
  one. This replaced three daily messages that were not the work: research
  digests about other people's chains, a nightly restatement of an unchanged
  portfolio, and an evening "the channel is quiet".

  The queue is a **calendar**: `content-plan.json` next to `soul.md` (28 days,
  24 August — 20 September 2026), a slot per day carrying its pillar, its
  thesis, the material the operator attaches and the one question the post ends
  on — plus the standing brief (four series, the rules drawn from the last
  fifty posts of the account, the voice). It is data, not code, because it came
  from outside the daemon; a new month is a new file.

  The material is **the repository's own commit log** since the last post went
  out — the only record of what was actually built that nobody has to be asked
  to write. It reaches the writer as evidence and never as copy: the prompt
  forbids libraries, files, versions, "refactored" and every other word that
  belongs to the person who built the thing rather than the person using it.
  ("Fixed CI" was a real post; the strategy report names it as a failure.)

  Nothing here publishes. This host holds no account session, and a daemon that
  could post unattended is one that can embarrass the project at 4am — so the
  finished English text arrives in Telegram as **two messages**: what it is,
  then the post alone, so copying it copies exactly what goes out.

  - `write_post` — write (or rewrite) the post for a day, optionally with an
    angle ("сделай про мост"); it delivers the text itself
  - `post_plan` — today's slot, what is still owed, and what state each day is in
  - `mark_post_published` — record that it went out (only needed where the
    channel cannot show it)
  - `skip_post` — drop a day; it never joins the backlog

  Three guards keep it from becoming what it replaced: the watched channel is
  the ground truth for "did it go out" (a day it published is a day that needs
  nothing); a backlog **drains** rather than floods — at most
  `LAINOS_PRESS_MAX_PER_DAY` (2) drafts a day, `LAINOS_PRESS_SPACING_MS` (4h)
  apart, and a slot older than `LAINOS_PRESS_BACKLOG_DAYS` (3) is dropped
  rather than published stale; and the evening repeat fires once, only for a
  post already delivered and still unpublished.

  A post is lost the same two ways every scheduled job is, and neither is
  allowed to pass quietly. **The host was not awake at the hour**: a desktop
  that is off at 11:00, or asleep, simply misses the slot — so the room sweeps
  once a minute after start as well as on its interval, and a daemon that wakes
  at three in the afternoon writes then instead of waiting for tomorrow. **The
  message did not arrive**: a delivery whose transport failed takes its
  delivery stamp back (`markUndelivered`) and is re-sent on the next sweep,
  where a refusal from Telegram itself — chat not found, bot blocked — is final
  and never retried. The room re-sends the post it already wrote rather than
  writing a second one for the same day.

  And a writer that cannot answer at all — the CLI is unauthenticated, the
  upstream timed out — is said out loud once a day rather than logged. Silence
  is indistinguishable from a day with nothing in it, which is the state this
  room exists to end.

  What it says is **read, not forwarded** (`writerRefusal`, pure and clocked,
  pinned in `press-smoke.ts`). A CLI that refuses explains itself in prose
  meant for a terminal — a stack trace, a cf-ray, a usage window — and pasting
  that into Telegram is how the operator got two identical walls of
  `401 Unauthorized … cf-ray …` on consecutive mornings and still had to read
  the log to learn the host had never been signed in. Two facts survive the
  read: which kind of "no" it is (out of credits *for now*, versus not allowed
  to ask at all), and **when it reopens** if the refusal named an hour — "try
  again at 11:33 AM" is a subscription CLI telling us exactly how long the flat
  half-hour retry will keep failing, so that hour becomes the wait
  (`retryAt` on the day's record). A writer that throws now records its failure
  at all, which it did not: only the "came back too short" branch wrote one, so
  a CLI exiting non-zero was asked again every quarter of an hour.

  Neither guard makes a desktop always-on — but an always-on host with no
  signed-in writer is worse, which is the trade the room is on the desk for:
  see **Two instances** below.

  Writing is `WRITE`-kind work, so `LAINOS_TASK_WRITE` decides which model
  holds the public voice. Posts persist in `data/press.json` with the model
  that wrote each one and the commits that fed it. Daemon-only unless
  `LAINOS_PRESS=1`; tune with `LAINOS_PRESS_HOUR` (11),
  `LAINOS_PRESS_REMIND_HOUR` (19), `LAINOS_PRESS_PLAN`, `LAINOS_PRESS_CHANNEL`,
  `LAINOS_PRESS_CHAT_ID`, `LAINOS_PRESS_REPO`, `LAINOS_PRESS_INTERVAL_MS`.
- **telegram** — the operator notification channel: `send_telegram` delivers a
  message via the Bot API from TUI, HTTP, or daemon mode and returns
  delivery status. The token stays on the host; the model never sees it. The
  target chat is `TELEGRAM_OPERATOR_CHAT_ID`, else the first
  `TELEGRAM_ALLOWED_CHATS` entry, else the single known private chat in
  `data/telegram.json`. Available whenever `TELEGRAM_BOT_TOKEN` is set — the
  long-polling client need not be running (sending never conflicts with it).
- **system** — a terminal and filesystem, confined to a workspace
  (`LAINOS_WORKSPACE`, default `./workspace`):
  - `run_shell` — run a shell command (cwd = workspace, hard timeout, clipped output)
  - `read_file` / `write_file` / `list_dir` — files within the workspace

  Powerful and dual-use: paths that escape the workspace are refused. It loads
  only for characters that list `"system"` in their `plugins` (Lain does); drop
  it from a character's plugins to take the capability away.

- **crm** — everything she does, filed on the operators' board.

  Almost all of this agent's work happens while nobody is talking to her: the
  forge builds a holder's wish at four in the morning, the trader takes profit
  on a position, a balance watch fires, a digest comes back. All of it landed
  in exactly one place — a Telegram message that scrolled away — so the board
  that is supposed to answer *what is this project doing* answered only for the
  work three people typed in by hand.

  This plugin is the other half of that sentence. Each task-shaped thing
  becomes one record posted over plain HTTP: `{id, title, detail, status, at}`.
  Cyberia's console is the intended reader (`POST /api/crm/tasks`, token in
  `X-Crm-Token`), but nothing here knows that — the endpoint is a setting, so
  any CRM that accepts JSON can be the destination.

  Two kinds of record and no third. **`open`** is something a person still has
  to do: a wish (it stays open after the forge builds it, because nothing here
  pushes — a built wish is waiting on somebody to read the commit and publish
  it), a watch that fired, a reminder, the day's post. **`done`** is something
  already finished and is a log line under the board: a trade, a completed
  forge job, a digest. A record that needs nobody and finished nothing is a
  record that should not have been sent.

  Three properties make it safe to leave running. It is **off unless
  configured** — no `LAINOS_CRM_URL`, no traffic and no queue. **The id is
  ours**: every record carries a namespaced id the sender mints
  (`lainos:trade:0x…`), so a delivery retried after a timeout is the same
  record and not a second one — nothing else can make this idempotent, because
  the daemon cannot see whether the request it never got an answer to actually
  landed. And the **outbox is durable** (`data/crm.json`): records wait there
  until the CRM acknowledges them, drain oldest-first, and an evening the site
  was down is not an evening missing from the board. A record the server
  refuses outright (4xx that is not a 404) is dropped rather than left to wedge
  everything queued behind it; a 404 — which is what the ingest answers when
  its own token is unset — is retried, because that is a state somebody fixes.

  It reads the streams the other plugins already publish (forge, sentinel,
  scout, github, channel, press) plus a sweep over the two things that are
  state rather than events: the wishboard and the trade journal, which is how a
  trade Lain made herself is filed beside one the trader loop made. Switching
  it on for the first time **adopts** everything already there as seen and
  files none of it — the board starts the day it is wired up, not with a year
  of history nobody asked for.

  `log_crm_task` is the manual door, for a finding or a decision nothing else
  announces. Tune with `LAINOS_CRM_URL`, `LAINOS_CRM_TOKEN`, `LAINOS_CRM=0`,
  `LAINOS_CRM_INTERVAL_MS` (5 min), `LAINOS_CRM_PROXY`. Covered by
  `npm run crm:smoke`.

## Semantic memory

Memory persists to `data/memory.json` (episodic, per-room) plus durable learned
facts, and survives restarts. Retrieval is keyword + recency by default. Point
LainOS at an embedding model and recall becomes *semantic* — past turns are
ranked by meaning (embedding cosine), not just shared words:

```bash
# OpenAI
LAINOS_EMBED_API_KEY=sk-...           LAINOS_EMBED_MODEL=text-embedding-3-small
# or a local, fully-offline server (Ollama)
LAINOS_EMBED_BASE_URL=http://localhost:11434/v1   LAINOS_EMBED_MODEL=nomic-embed-text
# or a zero-config, dependency-free offline fallback (lexical vectors)
LAINOS_EMBED_PROVIDER=hash
```

Vectors are cached in `data/embeddings.json` and backfilled for pre-existing
memories on first search. No embedding config means the keyword path — no
network, no behaviour change. Changing the embedding model invalidates cached
vectors: delete `data/embeddings.json` to re-embed.

## Build your own agent

```ts
import { createAgent, lain } from "lainos";

const agent = await createAgent({ character: lain });
const { text } = await agent.handleMessage({
  roomId: "demo",
  userId: "me",
  text: "what's the USDC balance of 0xdc25597B19799010047F17e9591EFE08EFd40077?",
});
console.log(text);
```

Write a new `Character`, or a new `Plugin` (actions/providers/evaluators), and
pass it to `createAgent`. The `Plugin` interface is the whole extension surface.

## Telegram

Set `TELEGRAM_BOT_TOKEN` (create a bot with `@BotFather`) and `npm run serve`
also brings the agent online in Telegram — no extra dependency, the Bot API is
spoken over `fetch` with long polling:

- private chats: every message goes to the agent; each chat is its own memory
  room, durable facts are shared;
- groups: the bot answers only when @mentioned or replied to;
- `/start`, `/help` are answered locally without a model call;
- sentinel alerts are **pushed** to every chat the bot has spoken in — Lain
  writes first when a watch fires;
- Cyberia-study digests are pushed to `LAINOS_CYBERIA_STUDY_CHAT_ID`, or the
  first `TELEGRAM_ALLOWED_CHATS` entry when no explicit report chat is set;
- `/study` (alias `/cyberia`) runs the Cyberia-study sweep immediately and
  replies in the current chat;
- `TELEGRAM_ALLOWED_CHATS` (comma-separated chat ids) and
  `TELEGRAM_ALLOWED_USERS` (usernames or user ids) restrict access — unlisted
  chats/senders are silently ignored. Use at least one whenever
  `CYBERIA_AGENT_PK` is configured, since the agent can send CYBER;
- `TELEGRAM_PROXY` routes *only* Telegram API traffic through an HTTP(S) proxy
  (falls back to `HTTPS_PROXY`) for hosts where api.telegram.org is blocked.
  The client retries `getMe` with backoff, so a proxy that comes up late is
  picked up without restarting the daemon.

One daemon, one mind: the same process serves HTTP (the Wired game), Telegram,
and the sentinel. Run only one instance per bot token (Telegram rejects
parallel `getUpdates` pollers with a 409).

## HTTP API (for game NPCs)

```
GET  /health                          -> { ok, agent }
GET  /alerts                          -> { alerts } (recent sentinel alerts)
GET  /wishes                          -> { wishes } (the forge wishboard)
GET  /research                        -> { topics } (the scout's subscriptions)
POST /research/cyberia-study/run      -> { topic, digest, message }
GET  /provider                        -> { provider, choices } (who answers)
POST /provider { provider }           -> { provider } (switch cyberia/claude/codex/opencode live)
GET  /tasks                           -> { routes, kinds } (who answers which kind of work)
POST /tasks { task, route }           -> { route } (point one kind elsewhere)
GET  /sessions[?client=&limit=]       -> { sessions } (the conversation index)
GET  /sessions/{id}                   -> { session, messages }
POST /sessions/{id}/recap             -> { recap }
POST /chat { roomId, userId, text, task? } -> { text, actions, model, provider, task }
```

The **Wired** Godot game (`game/wired/`) drives its Lain NPC through this
endpoint — the same agent, one mind across the terminal and the 3D world.

## Layout

```
src/
  types.ts            core interfaces (the contract)
  runtime.ts          AgentRuntime — the think→act→evaluate loop
  memory/store.ts     file-backed long-term memory + retrieval
  memory/sessions.ts  the session index (/new, /resume, /sessions)
  memory/recap.ts     /recap: counted header + a summary from the cheap route
  memory/embeddings.ts  embedding providers (OpenAI-compatible | offline hash)
  models/             codex.ts | claude-cli.ts | opencode.ts (agent CLIs, cli-protocol.ts)
                      anthropic.ts | openrouter.ts | mock.ts | index.ts (factory)
                      tasks.ts (kinds + classifier) | routing.ts (per-kind router)
  plugins/bootstrap/  time provider + fact extractor + remember/recall
  plugins/cyberia/    the chain: chain.ts (registry) + abi.ts + math.ts (pure AMM)
                      + config.ts (trading policy) + service.ts (client + journal)
                      + explorer.ts + actions/{wallet,trade,liquidity,speculate,portfolio}
  plugins/sentinel/   background balance watches -> alerts (push + next-turn)
  plugins/forge/      wishboard + coding-agent jobs (wishes -> direct commits)
  plugins/skills/     hot-loaded self-written tools (skills/*.mjs, no restart)
  plugins/trader/     autonomous take-profit loop over the trade journal
  plugins/initiative/ her heartbeat: unprompted Telegram messages that matter
  plugins/scout/      autonomous researcher (topics -> scheduled digests)
  plugins/study/      self-teaching: read-only repo analysis -> real findings
  plugins/github/     commit-streak keeper (daily reminder on commitless days)
  plugins/channel/    telegram channel keeper (daily reminder on postless days)
  plugins/press/      the press room: the day's post, written from the plan
                      (plan.ts = calendar + brief, commits.ts = the material)
  plugins/system/     terminal + filesystem skills (sandboxed workspace)
  plugins/crm/        files every task-shaped thing onto the operators' board
                      (durable outbox in data/crm.json, sender-minted ids)
  clients/            cli.ts (REPL) | http.ts (bridge) | telegram.ts (bot) | tui/
  characters/lain.ts  the resident mind of Cyberia
content-plan.json     the 28-day content calendar the press room writes from
scripts/              chat.ts | tui.ts | serve.ts | smoke.ts | tasks-smoke.ts
                      | press-smoke.ts | crm-smoke.ts
```

## Safety

`CYBERIA_AGENT_PK`, `ANTHROPIC_API_KEY`, and `TELEGRAM_BOT_TOKEN` live only in
`.env` (gitignored). Without a key, the agent is strictly read-only on-chain.
With a signer configured, set `TELEGRAM_ALLOWED_CHATS` so strangers cannot ask
the bot to move funds. Never commit secrets.

The forge gives coding agents write access to the repo and commits directly to
the current branch — Lain's learning lands in place. Its guardrails: one job at
a time, an explicit "never push, never touch secrets" contract in every job
prompt, and the remote as the hard boundary — nothing leaves the host until the
operator pushes. Review her commits with `git log` before pushing; `git revert`
is the undo button. Hot skills (`skills/*.mjs`) run in-process with the same
trust as the rest of the agent, which is the existing trust model: she already
holds a workspace shell and a repo-editing forge.

The study loop is the read-only counterpart: it only runs `git` queries, skips
`.env` files, keypairs and cookies entirely, masks long opaque blobs before any
evidence reaches a prompt, and can propose but never perform a risky or
irreversible change. What it finds becomes a message to the operator, not a
commit.
