# Service monitoring for the Cyberia ecosystem

Two questions about every program this project runs, kept deliberately apart:

```
is it running?          ──▶  health, incidents, alerts
is anyone using it?     ──▶  usage, the idle list
```

They lead to different work. A service can be perfectly healthy and used by
nobody — that is a product decision, not an outage — and until this existed
neither question had an answer anywhere except an `ssh` session.

Paths are relative to `backend/laravel/` unless stated otherwise.

---

## 1. Why a push and a pull

Laravel runs inside the `cyberia_church` container. From in there it can reach
the public internet and its own database, and it can see **none** of this:

- the docker daemon and every other container on the host
- the tmux sessions holding the Telegram bot and LainOS
- load average, memory, swap, disk
- host cron logs

That is most of what this project actually runs. So the monitor has two halves.

```
     the host (cyber.main)                      the app container
┌──────────────────────────────┐          ┌──────────────────────────────┐
│ scripts/ops/heartbeat.sh     │  POST    │ Api\OpsHeartbeatController   │
│  docker ps -a + inspect      │─────────▶│  X-Ops-Token, constant time  │
│  tmux ls                     │  every   │            │                 │
│  pgrep -fc                   │  minute  │            ▼                 │
│  /proc/loadavg, df, stat     │          │      service_heartbeats      │
└──────────────────────────────┘          │      (one row per host)      │
                                          └──────────────────────────────┘
                                                       │
   the outside world                                   │
┌──────────────────────────────┐          ┌────────────▼─────────────────┐
│ rpc / explorer / site / dex  │◀─────────│ ServiceProbe  (one Http pool)│
│ TLS handshakes               │  pulled  │ ServiceMonitor               │
└──────────────────────────────┘          │   → service_checks           │
                                          │   → service_incidents        │
                                          │   → TelegramOpsNotifier      │
                                          └──────────────────────────────┘
```

The script is deliberately dumb: it reports **facts** and never judgements.
What a fact *means* is decided by `config/monitoring.php` on the app side, so
adding or renaming a service never means redeploying anything to the host.

A compromised reporter can lie about the host. It cannot make the app run
anything, and it cannot invent a service that is not already in the registry.

### More than one machine

`cyber.main` runs the chain, the explorer and the site. LainOS runs on the
operator's own machine and **has never been deployed to the server** — there is
no `node` there at all. `services/cyberia-node` is a prepared second node
waiting for a third machine.

So a registry entry may name its host, and `HeartbeatFleet` resolves it:

```php
'check' => ['type' => 'heartbeat', 'host' => env('MONITORING_LAINOS_HOST'), 'process' => 'lainos'],
```

Declaring the `host` key **at all** is the statement "this is not on the
default host", even when the value is still empty. Without that rule, LainOS
would be checked against the server and reported missing from a machine it was
never installed on — a false alarm that never stops, which is the fastest way
to teach someone to ignore a board. An entry with no `host` key takes the
default (`OPS_HEARTBEAT_DEFAULT_HOST`, or the most recent reporter).

---

## 2. The registry

`config/monitoring.php` is the single source of truth: every program that is
supposed to be running, how to find out whether it is, and how to count use.

```php
'cyberia-rpc' => [
    'group'    => 'chain',
    'label'    => 'Cyberia RPC',
    'critical' => true,
    'url'      => 'https://rpc.cyberia.church',
    'check'    => ['type' => 'evm-rpc', 'url' => …, 'stale_seconds' => 300, 'chain_id' => 49406],
    'usage'    => null,
],
```

`deployed => false` marks something the repo carries and nobody ever started
(`services/cyberia-node`). It stays on the board and is reported `off`, never
`down` — deleting it from the list is exactly how it got forgotten last time.

### Check types

| type | what it actually asks |
|---|---|
| `http` | status code, optional body substring, latency |
| `evm-rpc` | the head block's **age** and the chain id — not just a 200 |
| `blockscout` | the indexed head, and how far it trails the node |
| `ipfs` | Kubo `POST /api/v0/version` (a GET is 405 on a healthy node) |
| `tls` | days left on the certificate, cached 6h |
| `database`, `cache`, `queue` | a real round trip, a write-then-read, backlog **age** |
| `scheduler`, `scheduled-command` | when the scheduler and each command last finished |
| `table-freshness` | a table another program is supposed to keep current |
| `relayer`, `gas-station` | on-chain balances that fail silently when empty |
| `heartbeat` | a container, a tmux session, a process, a cron log — on the machine the entry names |
| `heartbeat-self` | whether each machine is still reporting at all |
| `host` | load per cpu, free memory, disk |
| `none` | nothing to probe — judged by usage alone |

### Checks that exist because of a real incident

- **`evm-rpc` measures the head's age.** A PoA node that stops sealing keeps
  answering `200`. Reachability would have called every such outage healthy.
- **`heartbeat` compares restart counters between sweeps.** On this host a
  container sat at `running` with 4,600 restarts behind it: `docker ps` reports
  whatever it is doing in the instant you ask, and a process that dies every
  second is running most of the times you look.
- **`queue` keys on the oldest job's age, not the backlog's depth.** A thousand
  jobs that arrived a second ago is a busy queue; one job sitting for an hour
  is a dead worker.
- **`tls` exists at all** because rpc and explorer both expired unnoticed.
- **`scheduler` exists** because the host cron called a `php` that lived only
  inside the container, and every scheduled command lay dormant for months.
- **`heartbeat-self` is the only heartbeat check allowed to be `down`.** When a
  report stops, every service it backed goes `unknown`; something has to say
  out loud *why* they all went blind.

---

## 3. The five states

| state | meaning |
|---|---|
| `up` | it answered, and the answer was right |
| `degraded` | it answered, and something in the answer is wrong |
| `down` | it did not answer, or answered wrongly |
| `unknown` | **we could not find out** |
| `off` | deliberately not running |

`unknown` is the load-bearing one. A missing heartbeat says the reporter died
and says nothing about what it was reporting on; printing that as `down` sends
someone to fix a healthy service while the real fault stays invisible.

Consequences, all enforced in `ServiceMonitor`:

- `unknown` never opens an incident and never closes one.
- `unknown` is excluded from **both halves** of the uptime fraction, so a
  heartbeat lapse cannot retroactively invent downtime for twenty services.

---

## 4. Alerting

Alerts fire on **transitions**, never on state. The alternative is a message
every five minutes for as long as something is broken, which ends with the
channel muted — and a muted channel is worse than no channel, because it looks
like monitoring while being silence.

An incident is a **row**, not a cache entry, so a restarted scheduler or a
flushed cache cannot turn one outage into a stream of identical messages.

1. Opened only after `failures_before_alert` (default 2) consecutive failures.
   One failed probe is usually this host's own network.
2. Announced once, as **one message per sweep** however many services changed —
   five services going down together is almost always one cause.
3. Reminded about at most once every `reminder_hours` (default 12).
4. Announced again when it resolves — after `checks_before_resolve` (default 2)
   consecutive healthy checks, with no `unknown` among them. "It's back" is the
   half people wait for, and a false one is how they learn not to: something
   that fails more often than it answers used to produce a down/recovered pair
   every hour.
5. Every alert but a recovery carries what the probe saw (the scalar half of
   its `detail`, timestamps as "how long ago") and, when the registry entry
   declares one, a `runbook` line saying what to do. A reason key alone is a
   name, not information.
6. `notified_at` is stamped **only when Telegram accepted the message**, so a
   refused alert is retried instead of being silently counted as delivered.

---

## 5. Usage, and the difference between two kinds of zero

`ServiceUsageService` returns one of three answers per service:

- **used** — someone did the thing recently (7d / 30d counts, distinct actors,
  days since last use)
- **unused** — the table exists, is readable, and is empty for the window
- **unmeasured** — this app genuinely cannot tell

The third is not a cop-out; it is the point. Collapsing `unmeasured` into
`unused` would put the RPC, the explorer and the DEX — three of the most used
things here — on a list recommending their deletion, purely because their
traffic is recorded in someone else's access log. Only measurable services can
appear on the idle list.

Two usage sources were deliberately removed after they proved misleading:

- `jobs` (a work queue whose rows are deleted when handled — counting them
  measures the backlog and calls a healthy empty queue unused)
- a second entry pointing at `bridge_requests` (one number reported by two
  services reads as two separate problems)

---

## 6. Files

| path | what it is |
|---|---|
| `config/monitoring.php` | the registry and every threshold |
| `app/Services/Monitoring/ServiceProbe.php` | all probing; **reads only** |
| `app/Services/Monitoring/ServiceMonitor.php` | sweep, incidents, alerts |
| `app/Services/Monitoring/ServiceBoard.php` | the read side for the page |
| `app/Services/Monitoring/ServiceUsageService.php` | who is using what |
| `app/Services/Monitoring/ScheduledTaskLog.php` | scheduler freshness |
| `app/Services/Monitoring/HeartbeatFleet.php` | which machine a service lives on |
| `app/Http/Controllers/Api/OpsHeartbeatController.php` | host ingest |
| `app/Http/Controllers/ServiceMonitorController.php` | `/crm/machines` (`/crm/services` redirects) |
| `app/Services/Console/ServiceStrips.php` | a day per service, one cell an hour |
| `resources/js/pages/crm/Machines.vue` | the machine lens of the console (en/ru) |
| `scripts/ops/heartbeat.sh` | the host reporter |
| `scripts/ops/logrotate-cyberia-crons` | bounded retention for host cron logs |

Nothing in `ServiceProbe` signs, writes, funds, restarts or repairs anything.
It runs unattended every five minutes, which is exactly the kind of job that
must not be able to act on what it finds.

---

## 7. Operating it

```bash
php artisan services:check            # one sweep, printed, no alerts
php artisan services:check --usage    # plus who is using what, plus the idle list
php artisan services:check --alert    # what the scheduler runs
php artisan services:prune            # retention (daily at 04:10)
```

Scheduled in `routes/console.php`: `services:check --alert` every five minutes,
`services:prune` daily. A full sweep of ~46 services takes about 3 seconds
because every network probe goes out in one `Http::pool`.

### Installing the host heartbeat

On the host, as root:

```bash
ln -s /root/singularity/scripts/ops/heartbeat.sh /usr/local/bin/cyberia-heartbeat
printf 'OPS_HEARTBEAT_TOKEN=%s\nOPS_HEARTBEAT_URL=%s\n' \
    "$(openssl rand -hex 32)" "https://cyberia.church/api/ops/heartbeat" \
    > /etc/cyberia-heartbeat.env
chmod 600 /etc/cyberia-heartbeat.env
( crontab -l; echo '* * * * * /usr/local/bin/cyberia-heartbeat >/dev/null 2>&1' ) | crontab -
```

Put the same token in the app's `.env` as `OPS_HEARTBEAT_TOKEN` and run
`php artisan config:cache` — config **is** cached on prod.

To see what would be sent without sending it:

```bash
OPS_HEARTBEAT_PRINT=1 OPS_HEARTBEAT_TOKEN=x cyberia-heartbeat
```

With no token configured the endpoint 404s and every host-side check reads
`unknown`. That is intentional: an open ingest would let anyone declare a dead
host healthy, and it would be believed.

### Cron log rotation

The chat-token and Telegram reward crons append to host files that the
heartbeat age-checks. `scripts/python/distribute-chats.sh` applies the shared
rotation policy before each distribution, so a normal cron run is enough to
activate it after deploy. To clear an already oversized log immediately:

```bash
logrotate -f --state /var/lib/logrotate/cyberia-crons.status \
    /root/singularity/scripts/ops/logrotate-cyberia-crons
```

The policy rotates daily or early at 32 MB, retains 14 compressed generations
and uses `copytruncate` because cron already has the current file open. A
rotation failure never blocks token distribution.

### Adding a service

One entry in `config/monitoring.php`. If it is a container or a daemon on the
host, that is the whole change — the heartbeat script already reports every
container it can see, and anything running but absent from the registry is
listed on the board under *"Running but not on this board"*.

---

## 8. Tests

`tests/Feature/Monitoring/` pins the judgement, not the plumbing:

- one failure does not open an incident; two do
- an ongoing outage is announced once across seven sweeps
- `unknown` opens nothing and closes nothing
- a chain answering `200` with an hour-old head is `down`
- a right-looking node on the wrong chain id is `down`
- a `running` container whose restart counter climbed is a crash loop
- a daemon on an unreported machine is `unknown`, and opens no incident
- a named host wins over the default when both are reporting
- a refused Telegram leaves the incident un-announced
- `unmeasured` never becomes `unused`
- the board renders without touching the network
