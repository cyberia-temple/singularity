<?php

use App\Models\ServiceCheck;
use App\Models\ServiceHeartbeat;
use App\Models\ServiceIncident;
use App\Services\Monitoring\ServiceMonitor;
use App\Services\Monitoring\ServiceStatus;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

/**
 * The sweep, and the rules that decide who gets told about it.
 *
 * What is pinned here is the judgement, not the plumbing: which answers mean
 * down, which mean "we could not tell", how many failures it takes before
 * anyone is woken up, and — the one that matters most — that a service which
 * has been broken for a week is mentioned once rather than every five minutes.
 *
 * Every probe is faked. A test suite that reaches the real chain is a test
 * suite that fails when the chain does.
 */
beforeEach(function () {
    Cache::flush();
    demoStatus(200);
    telegramOk(true);

    // One service, defined per test, so a change to the real registry cannot
    // silently rewrite what these assertions are about.
    config()->set('monitoring.services', [
        'demo' => [
            'group' => 'web',
            'label' => 'Demo',
            'critical' => true,
            'check' => ['type' => 'http', 'url' => 'https://demo.test'],
            'usage' => null,
        ],
    ]);

    config()->set('monitoring.alerts.failures_before_alert', 2);
    config()->set('services.telegram_ops.bot_token', 'test-token');
    config()->set('services.telegram_ops.chat_id', '123');

    Http::preventStrayRequests();
});

/**
 * What the demo service answers next.
 *
 * A single mutable fake rather than re-faking mid-test: Laravel *merges*
 * successive Http::fake() calls and the earliest matching stub wins, so a
 * second fake meant to make a service recover silently keeps it broken — which
 * is exactly the kind of quiet lie these tests exist to catch elsewhere.
 */
function demoStatus(?int $set = null): int
{
    static $status = 200;

    if ($set !== null) {
        $status = $set;
    }

    return $status;
}

function telegramOk(?bool $set = null): bool
{
    static $ok = true;

    if ($set !== null) {
        $ok = $set;
    }

    return $ok;
}

function sweep(bool $alert = true): array
{
    return app(ServiceMonitor::class)->sweep($alert);
}

/** Every test's default network: one probe target and one alert channel. */
function fakeNetwork(): void
{
    Http::fake(function ($request) {
        if (str_contains($request->url(), 'api.telegram.org')) {
            return telegramOk()
                ? Http::response(['ok' => true])
                : Http::response(['description' => 'nope'], 400);
        }

        return Http::response('body', demoStatus());
    });
}

/** How many alerts actually went out. */
function alertsSent(): int
{
    return Http::recorded(fn ($request) => str_contains($request->url(), 'api.telegram.org'))->count();
}

it('records a check for every service on every sweep', function () {
    fakeNetwork();

    sweep(alert: false);
    sweep(alert: false);

    expect(ServiceCheck::where('service', 'demo')->count())->toBe(2)
        ->and(ServiceCheck::first()->status)->toBe('up');
});

it('does not open an incident on a single failure', function () {
    demoStatus(500);
    fakeNetwork();

    $results = sweep();

    expect($results['demo']->status)->toBe(ServiceStatus::Down)
        // The probe is sure; the monitor is not, and one bad probe is usually
        // this host's own network rather than an outage.
        ->and(ServiceIncident::count())->toBe(0);
});

it('opens and announces an incident once the failure is confirmed', function () {
    demoStatus(500);
    fakeNetwork();

    sweep();
    sweep();

    $incident = ServiceIncident::sole();

    expect($incident->service)->toBe('demo')
        ->and($incident->status)->toBe('down')
        ->and($incident->reason)->toBe('bad-status')
        ->and($incident->notified_at)->not->toBeNull()
        ->and(alertsSent())->toBe(1);
});

it('stays silent while the same incident continues', function () {
    demoStatus(500);
    fakeNetwork();

    // Seven sweeps of one unbroken outage. A monitor that shouts on every one
    // of them is a monitor that gets muted before the next real incident.
    foreach (range(1, 7) as $ignored) {
        sweep();
    }

    expect(ServiceIncident::count())->toBe(1)
        ->and(alertsSent())->toBe(1);
});

it('announces recovery and closes the incident', function () {
    demoStatus(500);
    fakeNetwork();
    sweep();
    sweep();

    demoStatus(200);
    sweep();
    sweep();

    $incident = ServiceIncident::sole();

    expect($incident->resolved_at)->not->toBeNull()
        // Opening and closing are both announced: "it is back" is the half of
        // an incident people are actually waiting for.
        ->and(alertsSent())->toBe(2);
});

it('does not call one good answer a recovery', function () {
    demoStatus(500);
    fakeNetwork();
    sweep();
    sweep();

    // Mostly down, answering now and then: the shape that used to send a
    // "recovered" and a fresh "down" every hour, neither of them news.
    foreach ([200, 500, 200, 500, 500, 200] as $status) {
        demoStatus($status);
        sweep();
    }

    expect(ServiceIncident::sole()->resolved_at)->toBeNull()
        ->and(alertsSent())->toBe(1);
});

it('says what it saw and what to do about it', function () {
    config()->set('monitoring.services.demo.runbook', 'Restart the demo.');
    demoStatus(500);
    fakeNetwork();

    sweep();
    sweep();

    $text = Http::recorded(fn ($request) => str_contains($request->url(), 'api.telegram.org'))
        ->first()[0]['text'];

    expect($text)->toContain('bad-status')
        ->and($text)->toContain('status 500')
        ->and($text)->toContain('→ Restart the demo.');
});

it('never lets unknown open or close an incident', function () {
    config()->set('monitoring.services', [
        'ghost' => [
            'group' => 'infra',
            'label' => 'Ghost',
            'check' => ['type' => 'heartbeat', 'container' => 'ghost'],
            'usage' => null,
        ],
    ]);

    Http::fake();

    sweep();
    sweep();
    sweep();

    // No heartbeat has ever arrived, so the container's state is unknown —
    // which is a statement about the monitor, not about the container.
    expect(ServiceCheck::first()->status)->toBe('unknown')
        ->and(ServiceIncident::count())->toBe(0);
});

it('reports a service that was never deployed as off rather than down', function () {
    config()->set('monitoring.services', [
        'unbuilt' => [
            'group' => 'chain',
            'label' => 'Unbuilt',
            'deployed' => false,
            'check' => ['type' => 'none'],
            'usage' => null,
        ],
    ]);

    Http::fake();

    $results = sweep();

    expect($results['unbuilt']->status)->toBe(ServiceStatus::Off)
        ->and(ServiceIncident::count())->toBe(0);
});

it('calls a chain that answers but has stopped sealing down', function () {
    config()->set('monitoring.services', [
        'chain' => [
            'group' => 'chain',
            'label' => 'Chain',
            'check' => ['type' => 'evm-rpc', 'url' => 'https://rpc.test', 'stale_seconds' => 300],
            'usage' => null,
        ],
    ]);

    // A perfectly formed 200 whose head is an hour old: the exact failure an
    // HTTP check would call healthy.
    Http::fake([
        'https://rpc.test' => Http::response([
            'jsonrpc' => '2.0',
            'id' => 1,
            'result' => [
                'number' => '0x'.dechex(1000),
                'timestamp' => '0x'.dechex(now()->subHour()->timestamp),
            ],
        ]),
        'https://api.telegram.org/*' => Http::response(['ok' => true]),
    ]);

    $results = sweep(alert: false);

    expect($results['chain']->status)->toBe(ServiceStatus::Down)
        ->and($results['chain']->reason)->toBe('stale-head');
});

it('refuses an RPC that is a different chain', function () {
    config()->set('monitoring.services', [
        'chain' => [
            'group' => 'chain',
            'label' => 'Chain',
            'check' => [
                'type' => 'evm-rpc',
                'url' => 'https://rpc.test',
                'stale_seconds' => 300,
                'chain_id' => 49406,
            ],
            'usage' => null,
        ],
    ]);

    Http::fake(function ($request) {
        $method = $request->data()['method'] ?? '';

        return Http::response([
            'jsonrpc' => '2.0',
            'id' => 1,
            'result' => $method === 'eth_chainId'
                ? '0x1'
                : ['number' => '0x1', 'timestamp' => '0x'.dechex(now()->timestamp)],
        ]);
    });

    $results = sweep(alert: false);

    // A fresh head on the wrong chain is worse than no head at all: every
    // balance and fee quote read from it would be fiction.
    expect($results['chain']->status)->toBe(ServiceStatus::Down)
        ->and($results['chain']->reason)->toBe('wrong-chain');
});

it('sees a crash loop hiding behind a running container', function () {
    config()->set('monitoring.services', [
        'looper' => [
            'group' => 'infra',
            'label' => 'Looper',
            'check' => ['type' => 'heartbeat', 'container' => 'looper'],
            'usage' => null,
        ],
    ]);

    Http::fake();

    $report = function (int $restarts) {
        ServiceHeartbeat::query()->updateOrCreate(['host' => 'test'], [
            'payload' => [
                'host' => 'test',
                'containers' => [[
                    // Docker says `running` every time it is asked, because a
                    // process that dies every second is running most of the
                    // times you look at it.
                    'name' => 'looper',
                    'state' => 'running',
                    'status' => 'Up 1 second',
                    'restarts' => $restarts,
                ]],
            ],
            'reported_at' => now(),
        ]);
    };

    $report(4600);
    expect(sweep(alert: false)['looper']->status)->toBe(ServiceStatus::Up);

    $report(4640);
    $result = sweep(alert: false)['looper'];

    expect($result->status)->toBe(ServiceStatus::Down)
        ->and($result->reason)->toBe('crash-loop')
        ->and($result->detail['restarts_since_last_check'])->toBe(40);
});

it('treats one restart between sweeps as a restart, not a loop', function () {
    config()->set('monitoring.services', [
        'looper' => [
            'group' => 'infra',
            'label' => 'Looper',
            'check' => ['type' => 'heartbeat', 'container' => 'looper'],
            'usage' => null,
        ],
    ]);

    Http::fake();

    $report = function (int $restarts) {
        ServiceHeartbeat::query()->updateOrCreate(['host' => 'test'], [
            'payload' => ['host' => 'test', 'containers' => [[
                'name' => 'looper', 'state' => 'running', 'status' => 'Up 2 minutes', 'restarts' => $restarts,
            ]]],
            'reported_at' => now(),
        ]);
    };

    $report(3);
    sweep(alert: false);
    $report(4);

    // A deploy looks exactly like this, so it is reported and not escalated.
    expect(sweep(alert: false)['looper']->reason)->toBe('restarted');
});

it('reports a missing tmux session as down and an unreported one as unknown', function () {
    config()->set('monitoring.services', [
        'bot' => [
            'group' => 'daemon',
            'label' => 'Bot',
            'check' => ['type' => 'heartbeat', 'tmux' => 'bot'],
            'usage' => null,
        ],
    ]);

    Http::fake();

    ServiceHeartbeat::query()->create([
        'host' => 'test',
        'payload' => ['host' => 'test'],
        'reported_at' => now(),
    ]);

    // The host said nothing about tmux at all: that is a gap in the report,
    // not a dead daemon.
    expect(sweep(alert: false)['bot']->status)->toBe(ServiceStatus::Unknown);

    ServiceHeartbeat::query()->updateOrCreate(['host' => 'test'], [
        'payload' => ['host' => 'test', 'tmux' => ['other']],
        'reported_at' => now(),
    ]);

    expect(sweep(alert: false)['bot']->reason)->toBe('tmux-missing');
});

it('goes blind rather than wrong when the heartbeat stops arriving', function () {
    config()->set('monitoring.services', [
        'proxy' => [
            'group' => 'infra',
            'label' => 'Proxy',
            'check' => ['type' => 'heartbeat', 'container' => 'proxy'],
            'usage' => null,
        ],
    ]);

    Http::fake();

    ServiceHeartbeat::query()->create([
        'host' => 'test',
        'payload' => ['host' => 'test', 'containers' => [[
            'name' => 'proxy', 'state' => 'running', 'status' => 'Up', 'restarts' => 0,
        ]]],
        'reported_at' => now()->subHour(),
    ]);

    $result = sweep(alert: false)['proxy'];

    expect($result->status)->toBe(ServiceStatus::Unknown)
        ->and($result->reason)->toBe('heartbeat-stale');
});

it('leaves an incident un-announced when Telegram refuses it', function () {
    demoStatus(500);
    telegramOk(false);
    fakeNetwork();

    sweep();
    sweep();

    // The outage is real and nobody has heard about it, so the next sweep
    // must try again rather than treat it as delivered.
    expect(ServiceIncident::sole()->notified_at)->toBeNull();
});

it('does not blame one machine for a daemon that lives on another', function () {
    config()->set('monitoring.services', [
        'agent' => [
            'group' => 'daemon',
            'label' => 'Agent',
            // Declared, but the environment has not named the machine yet.
            'check' => ['type' => 'heartbeat', 'host' => null, 'process' => 'agent'],
            'usage' => null,
        ],
    ]);

    Http::fake();

    ServiceHeartbeat::create([
        'host' => 'cyber.main',
        // The server is healthy and reporting, and it has never heard of this
        // daemon because it was never installed there.
        'payload' => ['host' => 'cyber.main', 'processes' => ['something-else' => 1]],
        'reported_at' => now(),
    ]);

    $result = sweep(alert: false)['agent'];

    expect($result->status)->toBe(ServiceStatus::Unknown)
        ->and($result->reason)->toBe('host-unreported')
        ->and(ServiceIncident::count())->toBe(0);
});

it('reads a daemon from the machine its entry names', function () {
    config()->set('monitoring.services', [
        'agent' => [
            'group' => 'daemon',
            'label' => 'Agent',
            'check' => ['type' => 'heartbeat', 'host' => 'workstation', 'process' => 'agent'],
            'usage' => null,
        ],
    ]);

    Http::fake();

    foreach ([
        ['cyber.main', ['processes' => ['agent' => 0]]],
        ['workstation', ['processes' => ['agent' => 2]]],
    ] as [$host, $payload]) {
        ServiceHeartbeat::create([
            'host' => $host,
            'payload' => ['host' => $host] + $payload,
            'reported_at' => now(),
        ]);
    }

    // The server says the daemon is absent and the workstation says it is
    // running. The registry decides which of them is being asked.
    expect(sweep(alert: false)['agent']->status)->toBe(ServiceStatus::Up);
});

it('says out loud that a reporting machine has gone quiet', function () {
    config()->set('monitoring.services', [
        'heartbeat' => [
            'group' => 'infra',
            'label' => 'Heartbeat',
            'check' => ['type' => 'heartbeat-self'],
            'usage' => null,
        ],
    ]);

    Http::fake();

    ServiceHeartbeat::create([
        'host' => 'fresh',
        'payload' => ['host' => 'fresh'],
        'reported_at' => now(),
    ]);

    expect(sweep(alert: false)['heartbeat']->status)->toBe(ServiceStatus::Up);

    ServiceHeartbeat::create([
        'host' => 'quiet',
        'payload' => ['host' => 'quiet'],
        'reported_at' => now()->subHour(),
    ]);

    // Every other check goes `unknown` when a report stops, so this is the one
    // that has to say why they all went blind.
    $result = sweep(alert: false)['heartbeat'];

    expect($result->status)->toBe(ServiceStatus::Degraded)
        ->and($result->detail['silent'])->toBe(['quiet']);
});

it('asks the supervisor about a supervised daemon', function () {
    config()->set('monitoring.services', [
        'agent' => [
            'group' => 'daemon',
            'label' => 'Agent',
            'check' => ['type' => 'heartbeat', 'unit' => 'lainos'],
            'usage' => null,
        ],
    ]);

    Http::fake();

    $report = function (?string $state) {
        ServiceHeartbeat::query()->updateOrCreate(['host' => 'workstation'], [
            'payload' => ['host' => 'workstation'] + ($state === null ? [] : ['units' => ['lainos' => $state]]),
            'reported_at' => now(),
        ]);
    };

    // systemd's vocabulary is richer than a boolean, and the differences
    // matter: a unit caught mid-start is not a unit that failed.
    $report('active');
    expect(sweep(alert: false)['agent']->status)->toBe(ServiceStatus::Up);

    $report('activating');
    expect(sweep(alert: false)['agent']->status)->toBe(ServiceStatus::Degraded);

    $report('failed');
    expect(sweep(alert: false)['agent']->reason)->toBe('unit-failed');

    $report(null);
    expect(sweep(alert: false)['agent']->reason)->toBe('unit-unreported');
});

/*
 * The bridge's Monero wallet. Its failure modes are not the usual ones: it is
 * a thin client, so the wallet can be perfectly alive while the chain it reads
 * is gone, and an unattached wallet is a corridor that does not exist rather
 * than a service that is down.
 */

/** The wallet's answer to `get_height` — null to refuse the connection. */
function walletHeight(?int $set = null, bool $refuse = false): ?int
{
    static $height = 100;
    static $down = false;

    if ($refuse) {
        $down = true;
    }

    if ($set !== null) {
        $height = $set;
        $down = false;
    }

    return $down ? null : $height;
}

function fakeWalletNetwork(): void
{
    Http::fake(function ($request) {
        if (str_contains($request->url(), 'api.telegram.org')) {
            return Http::response(['ok' => true]);
        }

        $height = walletHeight();

        if ($height === null) {
            throw new ConnectionException('connection refused');
        }

        return Http::response(['id' => '0', 'jsonrpc' => '2.0', 'result' => ['height' => $height]]);
    });
}

function monitorMoneroWallet(): void
{
    config()->set('monitoring.services', [
        'monero-wallet' => [
            'group' => 'onchain',
            'label' => 'Monero bridge wallet',
            'check' => ['type' => 'monero-wallet', 'stale_seconds' => 1200],
            'usage' => null,
        ],
    ]);

    config()->set('bridge.chains.monero.wallet_rpc_url', 'http://wallet.test:18083');
}

it('reports an unattached Monero wallet as off rather than down', function () {
    monitorMoneroWallet();
    config()->set('bridge.chains.monero.wallet_rpc_url', '');
    fakeWalletNetwork();

    $result = sweep(alert: false)['monero-wallet'];

    // No wallet is a decision, not an outage: BridgeConfigService hides both
    // XMR routes, so there is nothing broken for anyone to see.
    expect($result->status)->toBe(ServiceStatus::Off)
        ->and($result->reason)->toBe('no-wallet')
        ->and(ServiceIncident::count())->toBe(0);
});

it('reports a Monero wallet Laravel cannot reach as down', function () {
    monitorMoneroWallet();
    walletHeight(refuse: true);
    fakeWalletNetwork();

    $result = sweep(alert: false)['monero-wallet'];

    expect($result->status)->toBe(ServiceStatus::Down)
        ->and($result->reason)->toBe('unreachable');
});

it('calls a thin client stalled when its height stops moving', function () {
    monitorMoneroWallet();
    walletHeight(3_700_000);
    fakeWalletNetwork();

    // A wallet whose remote node has gone answers every call as usual — this
    // is the whole reason the probe does not stop at a reply.
    expect(sweep(alert: false)['monero-wallet']->status)->toBe(ServiceStatus::Up);
    expect(sweep(alert: false)['monero-wallet']->status)->toBe(ServiceStatus::Up);

    $this->travel(25)->minutes();

    $result = sweep(alert: false)['monero-wallet'];

    expect($result->status)->toBe(ServiceStatus::Degraded)
        ->and($result->reason)->toBe('daemon-stalled')
        // Stalled since the sweep that first saw this height, not since now.
        ->and($result->detail['stalled_since'])->not->toBeNull();
});

it('keeps the stall clock through the sweeps the wallet does not answer', function () {
    monitorMoneroWallet();
    walletHeight(3_777_376);
    fakeWalletNetwork();

    sweep();
    sweep();
    $this->travel(25)->minutes();
    sweep();
    sweep();
    expect(ServiceIncident::sole()->status)->toBe('degraded');

    // A wallet stuck on a dead node times out on its own refresh loop, so the
    // stall is punctuated by sweeps it does not answer. The frozen height that
    // comes back after one is the same stall, not a recovery.
    foreach (range(1, 3) as $ignored) {
        walletHeight(refuse: true);
        $this->travel(5)->minutes();
        sweep();

        walletHeight(3_777_376);
        $this->travel(5)->minutes();
        expect(sweep()['monero-wallet']->reason)->toBe('daemon-stalled');
        $this->travel(5)->minutes();
        sweep();
    }

    $incident = ServiceIncident::sole();

    // Opened, worsened once to unreachable, and nothing after that.
    expect($incident->resolved_at)->toBeNull()
        ->and(alertsSent())->toBe(2)
        ->and($incident->detail['height'])->toBe(3_777_376);
});

it('clears a stall as soon as blocks arrive again', function () {
    monitorMoneroWallet();
    walletHeight(3_700_000);
    fakeWalletNetwork();

    sweep(alert: false);
    sweep(alert: false);
    $this->travel(25)->minutes();
    expect(sweep(alert: false)['monero-wallet']->status)->toBe(ServiceStatus::Degraded);

    walletHeight(3_700_012);

    $result = sweep(alert: false)['monero-wallet'];

    expect($result->status)->toBe(ServiceStatus::Up)
        ->and($result->detail)->not->toHaveKey('stalled_since');
});
