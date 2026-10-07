<?php

namespace App\Services\Monitoring;

use App\Services\BridgeRelayerService;
use App\Services\GasSponsorService;
use App\Services\Monero\MoneroWalletRpc;
use Carbon\CarbonImmutable;
use Illuminate\Http\Client\Pool;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Schema;
use Throwable;

/**
 * Finding out whether a service is alive.
 *
 * Every probe here is a *read*: nothing in this file signs, writes, funds,
 * restarts or fixes anything. A monitor that can change the system it watches
 * is a monitor that eventually takes production down at three in the morning,
 * and this one is scheduled to run unattended every five minutes.
 *
 * The network probes are issued as one pool, so a sweep of thirty services
 * costs about one timeout rather than thirty. This matters more than it looks:
 * a sequential sweep with a ten-second timeout takes five minutes on the day
 * everything is broken, which is the one day it must not overrun its own
 * schedule.
 *
 * What each probe refuses to do is as deliberate as what it does. An HTTP 200
 * is not accepted as proof that the chain is alive (a node that stopped
 * sealing still answers), and a heartbeat that never mentioned a container is
 * not read as that container being down.
 */
class ServiceProbe
{
    public function __construct(
        private BridgeRelayerService $relayer,
        private GasSponsorService $sponsor,
        private MoneroWalletRpc $monero,
    ) {}

    /**
     * @param  array<int, ServiceDefinition>  $definitions
     * @param  array<string, array<string, mixed>>  $previous  what the last sweep saw, per service
     * @return array<string, ProbeResult>
     */
    public function probeAll(array $definitions, array $previous = []): array
    {
        $responses = $this->fetch($definitions);
        $fleet = HeartbeatFleet::load();

        $results = [];

        foreach ($definitions as $definition) {
            $results[$definition->key] = $this->evaluate(
                $definition,
                $responses,
                $fleet,
                $previous[$definition->key] ?? [],
            );
        }

        return $results;
    }

    /* ------------------------------------------------------------ network -- */

    /**
     * Issue every network probe at once.
     *
     * @param  array<int, ServiceDefinition>  $definitions
     * @return array<string, Response|Throwable>
     */
    private function fetch(array $definitions): array
    {
        $specs = [];

        foreach ($definitions as $definition) {
            foreach ($this->requestsFor($definition) as $name => $spec) {
                $specs[$name] = $spec;
            }
        }

        if ($specs === []) {
            return [];
        }

        $timeout = (int) config('monitoring.probe.timeout', 10);

        /** @var array<string, Response|Throwable> $responses */
        $responses = Http::pool(function (Pool $pool) use ($specs, $timeout) {
            $requests = [];

            foreach ($specs as $name => $spec) {
                $request = $pool->as($name)
                    ->timeout($timeout)
                    ->connectTimeout(min($timeout, 5))
                    // Named so an operator reading an access log can tell a
                    // health check apart from a user, and so a WAF has
                    // something to allowlist that is not an IP.
                    ->withHeaders(['User-Agent' => 'CyberiaMonitor/1.0'])
                    ->withOptions(['http_errors' => false]);

                $requests[] = ($spec['method'] ?? 'get') === 'post'
                    ? $request->post($spec['url'], $spec['json'] ?? [])
                    : $request->get($spec['url']);
            }

            return $requests;
        });

        return $responses;
    }

    /**
     * The network calls one service needs, keyed so the evaluator can find
     * them again. A service may need more than one — the explorer's lag is
     * only meaningful next to the node's own head.
     *
     * @return array<string, array{method?: string, url: string, json?: array<string, mixed>}>
     */
    private function requestsFor(ServiceDefinition $definition): array
    {
        if (! $definition->isProbed()) {
            return [];
        }

        return match ($definition->checkType()) {
            'http' => [
                $definition->key => ['url' => (string) $definition->checkOption('url')],
            ],

            'evm-rpc' => [
                $definition->key => [
                    'method' => 'post',
                    'url' => (string) $definition->checkOption('url'),
                    'json' => $this->rpcCall('eth_getBlockByNumber', ['latest', false]),
                ],
                $definition->key.':chain' => [
                    'method' => 'post',
                    'url' => (string) $definition->checkOption('url'),
                    'json' => $this->rpcCall('eth_chainId'),
                ],
            ],

            'blockscout' => [
                $definition->key => [
                    'url' => rtrim((string) $definition->checkOption('api'), '/')
                        .'?module=block&action=eth_block_number',
                ],
            ],

            'ipfs' => [
                // Kubo's API is POST-only, and a GET returns 405 — which would
                // read as a dead node on a perfectly healthy one.
                $definition->key => [
                    'method' => 'post',
                    'url' => rtrim((string) config('ipfs.api_url'), '/').'/api/v0/version',
                ],
            ],

            'relayer' => $this->relayerRequest($definition),

            default => [],
        };
    }

    /** @return array<string, array{method: string, url: string, json: array<string, mixed>}> */
    private function relayerRequest(ServiceDefinition $definition): array
    {
        $address = $this->relayerAddress();

        if ($address === null) {
            return [];
        }

        return [
            $definition->key => [
                'method' => 'post',
                'url' => $this->cyberiaRpc(),
                'json' => $this->rpcCall('eth_getBalance', [$address, 'latest']),
            ],
        ];
    }

    /** @return array<string, mixed> */
    private function rpcCall(string $method, array $params = []): array
    {
        return ['jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => $params];
    }

    /* --------------------------------------------------------- evaluation -- */

    /**
     * @param  array<string, Response|Throwable>  $responses
     * @param  array<string, mixed>  $previous
     */
    private function evaluate(
        ServiceDefinition $definition,
        array $responses,
        HeartbeatFleet $fleet,
        array $previous = [],
    ): ProbeResult {
        if (! $definition->deployed) {
            return ProbeResult::off('not-deployed', ['note' => $definition->note]);
        }

        try {
            return match ($definition->checkType()) {
                'http' => $this->evaluateHttp($definition, $responses),
                'evm-rpc' => $this->evaluateRpc($definition, $responses),
                'blockscout' => $this->evaluateBlockscout($definition, $responses),
                'ipfs' => $this->evaluateIpfs($definition, $responses),
                'relayer' => $this->evaluateRelayer($definition, $responses),
                'tls' => $this->evaluateTls($definition),
                'database' => $this->evaluateDatabase(),
                'cache' => $this->evaluateCache(),
                'queue' => $this->evaluateQueue($definition),
                'scheduler' => $this->evaluateScheduler($definition),
                'scheduled-command' => $this->evaluateScheduledCommand($definition),
                'table-freshness' => $this->evaluateTableFreshness($definition),
                'gas-station' => $this->evaluateGasStation(),
                'monero-wallet' => $this->evaluateMoneroWallet($definition, $previous),
                'heartbeat' => $this->evaluateHeartbeatBacked($definition, $this->snapshotFor($definition, $fleet), $previous),
                'heartbeat-self' => $this->evaluateHeartbeatSelf($fleet),
                'host' => $this->evaluateHost($definition, $this->snapshotFor($definition, $fleet)),
                // `none` is not an oversight. Some things here have no health
                // of their own to read — a page the site renders, a feature
                // whose only failure mode is the site being down — and they
                // are judged by whether anyone used them instead.
                default => ProbeResult::unknown('usage-only'),
            };
        } catch (Throwable $e) {
            // A probe that throws must never take the sweep down with it: the
            // other twenty-nine services still need reporting, and "the check
            // itself broke" is its own answer.
            return ProbeResult::unknown('probe-failed', ['error' => $e->getMessage()]);
        }
    }

    /** @param array<string, Response|Throwable> $responses */
    private function evaluateHttp(ServiceDefinition $definition, array $responses): ProbeResult
    {
        $response = $responses[$definition->key] ?? null;

        if (! $response instanceof Response) {
            return ProbeResult::down('unreachable', $this->errorDetail($response));
        }

        $latency = $this->latencyOf($response);
        /** @var array<int, int> $expected */
        $expected = (array) $definition->checkOption('expect', [200]);
        $detail = ['status' => $response->status(), 'url' => $definition->checkOption('url')];

        if (! in_array($response->status(), $expected, true)) {
            return ProbeResult::down('bad-status', $detail, $latency);
        }

        $contains = $definition->checkOption('body_contains');

        if (is_string($contains) && ! str_contains($response->body(), $contains)) {
            return ProbeResult::degraded('unexpected-body', $detail, $latency);
        }

        return $this->slowOrUp($detail, $latency);
    }

    /**
     * A chain is alive when it is still sealing blocks, not when its RPC
     * returns 200. The node kept answering through every incident this project
     * has had; what stopped was the head moving.
     *
     * @param  array<string, Response|Throwable>  $responses
     */
    private function evaluateRpc(ServiceDefinition $definition, array $responses): ProbeResult
    {
        $response = $responses[$definition->key] ?? null;

        if (! $response instanceof Response || $response->failed()) {
            return ProbeResult::down('unreachable', $this->errorDetail($response));
        }

        $latency = $this->latencyOf($response);
        $block = $response->json('result');

        if (! is_array($block) || ! isset($block['number'], $block['timestamp'])) {
            return ProbeResult::down('bad-rpc-response', [
                'error' => $response->json('error.message'),
            ], $latency);
        }

        $number = (int) hexdec((string) $block['number']);
        $sealedAt = CarbonImmutable::createFromTimestampUTC((int) hexdec((string) $block['timestamp']));
        $age = $sealedAt->diffInSeconds(CarbonImmutable::now(), true);

        $detail = [
            'block' => $number,
            'head_age_seconds' => $age,
            'sealed_at' => $sealedAt->toIso8601String(),
        ];

        $chain = $responses[$definition->key.':chain'] ?? null;

        if ($chain instanceof Response && is_string($chain->json('result'))) {
            $detail['chain_id'] = (int) hexdec($chain->json('result'));
            $expected = $definition->checkOption('chain_id');

            // A right-looking node on the wrong chain is worse than a dead
            // one: every balance and every fee quote read from it is fiction.
            if ($expected !== null && $detail['chain_id'] !== (int) $expected) {
                return ProbeResult::down('wrong-chain', $detail + ['expected_chain_id' => (int) $expected], $latency);
            }
        }

        $stale = (int) $definition->checkOption('stale_seconds', 300);

        if ($age > $stale) {
            return ProbeResult::down('stale-head', $detail, $latency);
        }

        // Half the staleness budget spent is a chain that is sealing slowly —
        // visible here long before anyone notices a pending transaction.
        if ($age > $stale / 2) {
            return ProbeResult::degraded('slow-head', $detail, $latency);
        }

        return $this->slowOrUp($detail, $latency);
    }

    /** @param array<string, Response|Throwable> $responses */
    private function evaluateBlockscout(ServiceDefinition $definition, array $responses): ProbeResult
    {
        $response = $responses[$definition->key] ?? null;

        if (! $response instanceof Response || $response->failed()) {
            return ProbeResult::down('unreachable', $this->errorDetail($response));
        }

        $latency = $this->latencyOf($response);
        $result = $response->json('result');

        if (! is_string($result)) {
            return ProbeResult::down('bad-api-response', ['body' => mb_substr($response->body(), 0, 200)], $latency);
        }

        $indexed = (int) hexdec($result);
        $detail = ['indexed_block' => $indexed];

        // The node's head came back in the same pool, so the lag costs nothing
        // extra to compute — and lag, not reachability, is what users feel:
        // the wallet's history and the gas station's eligibility both read
        // this index.
        $head = $this->headFromPool($responses, (string) $definition->checkOption('head_from', ''));

        if ($head !== null) {
            $detail['node_block'] = $head;
            $detail['lag_blocks'] = max(0, $head - $indexed);

            if ($detail['lag_blocks'] > (int) $definition->checkOption('max_lag_blocks', 200)) {
                return ProbeResult::degraded('index-lag', $detail, $latency);
            }
        }

        return $this->slowOrUp($detail, $latency);
    }

    /**
     * The node head fetched for another service in this same sweep.
     *
     * Named explicitly by the registry rather than sniffed out of the pool: a
     * lag figure computed against whichever response happened to look like a
     * block would be a number nobody could check.
     *
     * @param  array<string, Response|Throwable>  $responses
     */
    private function headFromPool(array $responses, string $from): ?int
    {
        $response = $responses[$from] ?? null;

        if (! $response instanceof Response) {
            return null;
        }

        $block = $response->json('result');

        return is_array($block) && isset($block['number'])
            ? (int) hexdec((string) $block['number'])
            : null;
    }

    /** @param array<string, Response|Throwable> $responses */
    private function evaluateIpfs(ServiceDefinition $definition, array $responses): ProbeResult
    {
        $response = $responses[$definition->key] ?? null;

        if (! $response instanceof Response || $response->failed()) {
            return ProbeResult::down('unreachable', $this->errorDetail($response));
        }

        return $this->slowOrUp(
            ['version' => $response->json('Version')],
            $this->latencyOf($response),
        );
    }

    /** @param array<string, Response|Throwable> $responses */
    private function evaluateRelayer(ServiceDefinition $definition, array $responses): ProbeResult
    {
        $address = $this->relayerAddress();

        if ($address === null) {
            return ProbeResult::unknown('no-relayer-key');
        }

        $response = $responses[$definition->key] ?? null;

        if (! $response instanceof Response || ! is_string($response->json('result'))) {
            return ProbeResult::unknown('balance-unreadable', $this->errorDetail($response));
        }

        // Wei overflows PHP's integers, so the comparison stays in strings all
        // the way down — the same reason GasStationCommand uses bccomp.
        $wei = $this->hexToDecimalString($response->json('result'));
        $minimum = (string) $definition->checkOption('min_wei', '0');

        $detail = [
            'address' => $address,
            'balance_cyber' => $this->weiToCyber($wei),
        ];

        // An empty relayer does not fail loudly: bridges simply stop paying
        // out, and this has happened before and gone unnoticed for a day.
        if (bccomp($wei, $minimum) < 0) {
            return ProbeResult::degraded('relayer-low', $detail, $this->latencyOf($response));
        }

        return ProbeResult::up($detail, $this->latencyOf($response));
    }

    /**
     * Certificate expiry, which is not an HTTP question — a cert three days
     * from expiry serves a perfect 200 until the morning it does not.
     *
     * Cached for hours: an expiry date does not change between sweeps, and a
     * TLS handshake per host per five minutes is a cost with no reader.
     */
    private function evaluateTls(ServiceDefinition $definition): ProbeResult
    {
        /** @var array<int, string> $hosts */
        $hosts = (array) $definition->checkOption('hosts', []);
        $warn = (int) $definition->checkOption('warn_days', 14);
        $critical = (int) $definition->checkOption('critical_days', 3);

        $days = [];
        $failed = [];

        foreach ($hosts as $host) {
            $left = Cache::remember(
                'monitoring.tls:'.$host,
                now()->addHours(6),
                fn () => $this->certificateDaysLeft($host),
            );

            if ($left === null) {
                $failed[] = $host;

                continue;
            }

            $days[$host] = $left;
        }

        $detail = ['days_left' => $days, 'unreadable' => $failed];

        if ($days === []) {
            return ProbeResult::unknown('tls-unreadable', $detail);
        }

        $soonest = min($days);
        $detail['soonest'] = array_search($soonest, $days, true);

        if ($soonest <= 0) {
            return ProbeResult::down('certificate-expired', $detail);
        }

        if ($soonest <= $critical) {
            return ProbeResult::down('certificate-expiring', $detail);
        }

        if ($soonest <= $warn) {
            return ProbeResult::degraded('certificate-expiring', $detail);
        }

        return $failed === []
            ? ProbeResult::up($detail)
            : ProbeResult::degraded('tls-unreadable', $detail);
    }

    private function certificateDaysLeft(string $host): ?int
    {
        $context = stream_context_create([
            'ssl' => ['capture_peer_cert' => true, 'verify_peer' => false, 'verify_peer_name' => false],
        ]);

        $client = @stream_socket_client(
            'ssl://'.$host.':443',
            $errno,
            $errstr,
            5,
            STREAM_CLIENT_CONNECT,
            $context,
        );

        if ($client === false) {
            return null;
        }

        $params = stream_context_get_params($client);
        fclose($client);

        $certificate = $params['options']['ssl']['peer_certificate'] ?? null;

        if ($certificate === null) {
            return null;
        }

        $parsed = openssl_x509_parse($certificate);

        if (! is_array($parsed) || ! isset($parsed['validTo_time_t'])) {
            return null;
        }

        return (int) floor(((int) $parsed['validTo_time_t'] - time()) / 86400);
    }

    /* ----------------------------------------------------------- internal -- */

    private function evaluateDatabase(): ProbeResult
    {
        $started = microtime(true);
        DB::select('select 1 as ok');
        $latency = (int) round((microtime(true) - $started) * 1000);

        return $this->slowOrUp(['driver' => DB::getDriverName()], $latency);
    }

    private function evaluateCache(): ProbeResult
    {
        $started = microtime(true);
        $token = (string) random_int(1, PHP_INT_MAX);

        Cache::put('monitoring.ping', $token, now()->addMinute());
        $read = Cache::get('monitoring.ping');

        $latency = (int) round((microtime(true) - $started) * 1000);

        // A cache that accepts a write and returns something else is worse
        // than one that is down, because everything above it keeps running on
        // wrong answers.
        return $read === $token
            ? $this->slowOrUp(['store' => config('cache.default')], $latency)
            : ProbeResult::down('cache-mismatch', ['store' => config('cache.default')], $latency);
    }

    /**
     * A database queue tells you whether a worker is running by the shape of
     * its backlog: jobs arriving and never leaving means nobody is consuming.
     */
    private function evaluateQueue(ServiceDefinition $definition): ProbeResult
    {
        if (! Schema::hasTable('jobs')) {
            return ProbeResult::unknown('no-jobs-table');
        }

        $pending = DB::table('jobs')->count();
        $oldest = DB::table('jobs')->min('available_at');
        $failed = Schema::hasTable('failed_jobs')
            ? DB::table('failed_jobs')->where('failed_at', '>=', now()->subDay())->count()
            : 0;

        $age = $oldest === null ? 0 : max(0, time() - (int) $oldest);

        $detail = ['pending' => $pending, 'oldest_seconds' => $age, 'failed_24h' => $failed];

        // Age, not depth, is the signal: a thousand jobs that all arrived a
        // second ago is a busy queue, and one job sitting for an hour is a
        // dead worker.
        if ($age > (int) $definition->checkOption('max_age_seconds', 900)) {
            return ProbeResult::down('queue-stalled', $detail);
        }

        if ($pending > (int) $definition->checkOption('max_backlog', 100)) {
            return ProbeResult::degraded('queue-backlog', $detail);
        }

        return $failed > 0
            ? ProbeResult::degraded('jobs-failing', $detail)
            : ProbeResult::up($detail);
    }

    private function evaluateScheduler(ServiceDefinition $definition): ProbeResult
    {
        $last = ScheduledTaskLog::lastSchedulerRun();

        if ($last === null) {
            return ProbeResult::unknown('never-seen');
        }

        $age = $last->diffInSeconds(CarbonImmutable::now(), true);
        $detail = ['last_run' => $last->toIso8601String(), 'age_seconds' => $age];

        return $age > (int) $definition->checkOption('stale_seconds', 900)
            ? ProbeResult::down('scheduler-stalled', $detail)
            : ProbeResult::up($detail);
    }

    private function evaluateScheduledCommand(ServiceDefinition $definition): ProbeResult
    {
        $command = (string) $definition->checkOption('command');
        $record = ScheduledTaskLog::last($command);

        if ($record === null) {
            return ProbeResult::unknown('never-seen', ['command' => $command]);
        }

        $at = CarbonImmutable::parse($record['at']);
        $age = $at->diffInSeconds(CarbonImmutable::now(), true);
        $detail = ['command' => $command, 'last_run' => $record['at'], 'age_seconds' => $age];

        if (! ($record['ok'] ?? true)) {
            return ProbeResult::down('command-failing', $detail);
        }

        return $age > (int) $definition->checkOption('stale_seconds', 1800)
            ? ProbeResult::degraded('command-stale', $detail)
            : ProbeResult::up($detail);
    }

    /**
     * A table another program is supposed to keep current. The Telegram bot
     * maintains `dex_pools`, and every USD quote on the site reads it — so the
     * bot's indexing half can die while the bot itself stays up, and nothing
     * else in this app would ever notice.
     */
    private function evaluateTableFreshness(ServiceDefinition $definition): ProbeResult
    {
        $table = (string) $definition->checkOption('table');
        $column = (string) $definition->checkOption('column', 'updated_at');

        if (! Schema::hasTable($table)) {
            return ProbeResult::unknown('no-table', ['table' => $table]);
        }

        if (! Schema::hasColumn($table, $column)) {
            return ProbeResult::unknown('no-column', ['table' => $table, 'column' => $column]);
        }

        $latest = DB::table($table)->max($column);

        if ($latest === null) {
            return ProbeResult::unknown('empty-table', ['table' => $table]);
        }

        $at = CarbonImmutable::parse($latest);
        $age = $at->diffInSeconds(CarbonImmutable::now(), true);
        $detail = ['table' => $table, 'updated_at' => $at->toIso8601String(), 'age_seconds' => $age];

        return $age > (int) $definition->checkOption('stale_seconds', 7200)
            ? ProbeResult::down('table-stale', $detail)
            : ProbeResult::up($detail);
    }

    /**
     * The bridge's Monero wallet, which is a different question from "is the
     * container running".
     *
     * This host runs it as a thin client: the keys are here, the chain is on
     * a node somebody else operates. When that node goes away the wallet keeps
     * answering — opening a wallet and reporting its version are local acts —
     * and simply stops learning about new blocks. So a reply proves nothing on
     * its own and the *height moving between sweeps* is the check, in the same
     * spirit as the chain's head age and a container's restart delta.
     *
     * A stalled wallet is `degraded` rather than `down` on purpose. Deposits
     * already seen stay credited, payouts already made stay made, and the
     * corridor recovers by itself the moment blocks arrive again; what it
     * cannot do meanwhile is notice anything new, which is worth a person
     * looking and not worth calling an outage.
     *
     * @param  array<string, mixed>  $previous
     */
    private function evaluateMoneroWallet(ServiceDefinition $definition, array $previous = []): ProbeResult
    {
        if (! $this->monero->configured()) {
            // Not a failure. With no wallet attached both XMR routes vanish
            // from the bridge — a corridor that does not exist, rather than
            // one that is broken.
            return ProbeResult::off('no-wallet');
        }

        $height = $this->monero->height();

        if ($height === null) {
            // Unreachable covers the whole span from "the container is gone"
            // to "Laravel and the wallet are on different docker networks",
            // which is what actually happened on 2026-09-13 and went unseen
            // for ten hours because nothing here was watching it.
            //
            // The last height seen and the stall clock ride through it. A
            // wallet whose remote node is dead spends its refresh loop timing
            // out against it, and while it does `get_height` times out too —
            // so a stall is *punctuated* by unreachable sweeps. Dropping the
            // clock there read the next answer, the same frozen height, as a
            // fresh start and announced a recovery: on 2026-10-07 that was
            // nine "recovered" messages over a node that had been dead for two
            // days, and not one of them said so.
            return ProbeResult::down('unreachable', array_filter([
                'height' => $previous['height'] ?? null,
                'stalled_since' => $previous['stalled_since'] ?? null,
            ], fn ($value) => $value !== null));
        }

        $before = isset($previous['height']) ? (int) $previous['height'] : null;
        $detail = ['height' => $height];

        if ($before === null || $height !== $before) {
            return ProbeResult::up($detail);
        }

        // Stalled since the first sweep that saw this height, not since this
        // one: a wallet that stopped an hour ago should say an hour.
        $since = isset($previous['stalled_since'])
            ? CarbonImmutable::parse((string) $previous['stalled_since'])
            : CarbonImmutable::now();

        $detail['stalled_since'] = $since->toIso8601String();

        // Monero aims at a block every two minutes, so twenty without one is
        // not a quiet stretch of chain — it is nobody serving us blocks.
        $threshold = max(60, (int) $definition->checkOption('stale_seconds', 1200));

        if ($since->addSeconds($threshold)->isPast()) {
            return ProbeResult::degraded('daemon-stalled', $detail);
        }

        return ProbeResult::up($detail);
    }

    private function evaluateGasStation(): ProbeResult
    {
        if (! $this->sponsor->enabled()) {
            return ProbeResult::off('sponsorship-disabled');
        }

        $summary = $this->sponsor->summary();

        if ($summary === null) {
            // The station's own command is emphatic about this distinction:
            // an unreadable station is an RPC problem, not an empty tank.
            return ProbeResult::unknown('station-unreadable');
        }

        $drip = $summary['drip'] === '0' ? '1' : $summary['drip'];
        $left = (int) bcdiv($summary['tank'], $drip, 0);

        $detail = [
            'drips_left' => $left,
            'tank_cyber' => $this->weiToCyber($summary['tank']),
            'paused' => $summary['paused'],
        ];

        if ($summary['paused']) {
            return ProbeResult::off('paused', $detail);
        }

        if ($left < (int) config('wallet.sponsor.low_water_drips', 50)) {
            return ProbeResult::degraded('tank-low', $detail);
        }

        return ProbeResult::up($detail);
    }

    /* ---------------------------------------------------------- heartbeat -- */

    /** @param array<string, mixed> $previous */
    private function evaluateHeartbeatBacked(
        ServiceDefinition $definition,
        HeartbeatSnapshot $heartbeat,
        array $previous = [],
    ): ProbeResult {
        // A machine that has never reported and one that has gone quiet are
        // different problems — the first is usually a heartbeat that was never
        // installed there, the second a host that stopped — and both are
        // `unknown`, because neither says anything about the service itself.
        if ($heartbeat->missing()) {
            return ProbeResult::unknown('host-unreported', ['host' => $heartbeat->host]);
        }

        if ($heartbeat->stale()) {
            return ProbeResult::unknown('heartbeat-stale', [
                'host' => $heartbeat->host,
                'age_seconds' => $heartbeat->ageSeconds(),
            ]);
        }

        return match (true) {
            $definition->checkOption('container') !== null => $this->containerStatus((string) $definition->checkOption('container'), $heartbeat, $previous),
            $definition->checkOption('tmux') !== null => $this->tmuxStatus((string) $definition->checkOption('tmux'), $heartbeat),
            $definition->checkOption('unit') !== null => $this->unitStatus((string) $definition->checkOption('unit'), $heartbeat),
            $definition->checkOption('process') !== null => $this->processStatus((string) $definition->checkOption('process'), $heartbeat),
            $definition->checkOption('cron') !== null => $this->cronStatus($definition, $heartbeat),
            default => ProbeResult::unknown('no-heartbeat-target'),
        };
    }

    /** @param array<string, mixed> $previous */
    private function containerStatus(string $name, HeartbeatSnapshot $heartbeat, array $previous = []): ProbeResult
    {
        $container = $heartbeat->container($name);

        if ($container === null) {
            // Never mentioned. Either the container was removed or the name in
            // the registry is wrong; both are worth looking at, and neither is
            // an outage of the thing the name was meant to describe.
            return ProbeResult::unknown('container-absent', ['container' => $name]);
        }

        $detail = ['container' => $name, 'status' => $container['status'], 'restarts' => $container['restarts']];

        if ($container['state'] !== 'running') {
            return match ($container['state']) {
                // Docker's own word for a container it cannot keep alive.
                'restarting' => ProbeResult::down('crash-loop', $detail),
                'paused' => ProbeResult::degraded('container-paused', $detail),
                default => ProbeResult::down('container-'.$container['state'], $detail),
            };
        }

        // The state alone is not enough, and this is not hypothetical: on this
        // host a container sat at `running` with four and a half thousand
        // restarts behind it, because `docker ps` reports whatever it is doing
        // in the instant it is asked, and a process that dies every second is
        // running most of the times you look. Only the restart counter moving
        // between two sweeps tells them apart.
        $before = isset($previous['restarts']) ? (int) $previous['restarts'] : null;

        if ($before !== null && $container['restarts'] > $before) {
            $delta = $container['restarts'] - $before;
            $detail['restarts_since_last_check'] = $delta;

            return $delta > 1
                ? ProbeResult::down('crash-loop', $detail)
                // Exactly one restart between sweeps is also what a deploy or
                // a deliberate `docker restart` looks like, so it is reported
                // and not escalated.
                : ProbeResult::degraded('restarted', $detail);
        }

        return ProbeResult::up($detail);
    }

    private function tmuxStatus(string $session, HeartbeatSnapshot $heartbeat): ProbeResult
    {
        $present = $heartbeat->hasTmux($session);

        if ($present === null) {
            return ProbeResult::unknown('tmux-unreported', ['session' => $session]);
        }

        return $present
            ? ProbeResult::up(['session' => $session])
            // Nothing supervises these: a session that ends stays ended until
            // a person notices, which has already cost twelve hours once.
            : ProbeResult::down('tmux-missing', ['session' => $session]);
    }

    private function unitStatus(string $name, HeartbeatSnapshot $heartbeat): ProbeResult
    {
        $state = $heartbeat->unitState($name);

        if ($state === null) {
            return ProbeResult::unknown('unit-unreported', ['unit' => $name]);
        }

        $detail = ['unit' => $name, 'state' => $state];

        return match ($state) {
            'active' => ProbeResult::up($detail),
            // Caught mid-start. Once is a restart; every sweep is a unit
            // systemd cannot keep up, which is the daemon equivalent of a
            // container crash loop.
            'activating', 'reloading', 'deactivating' => ProbeResult::degraded('unit-'.$state, $detail),
            'failed' => ProbeResult::down('unit-failed', $detail),
            'inactive' => ProbeResult::down('unit-inactive', $detail),
            default => ProbeResult::unknown('unit-'.$state, $detail),
        };
    }

    private function processStatus(string $name, HeartbeatSnapshot $heartbeat): ProbeResult
    {
        $count = $heartbeat->processCount($name);

        if ($count === null) {
            return ProbeResult::unknown('process-unreported', ['process' => $name]);
        }

        return $count > 0
            ? ProbeResult::up(['process' => $name, 'count' => $count])
            : ProbeResult::down('process-missing', ['process' => $name]);
    }

    private function cronStatus(ServiceDefinition $definition, HeartbeatSnapshot $heartbeat): ProbeResult
    {
        $name = (string) $definition->checkOption('cron');
        $cron = $heartbeat->cron($name);

        if ($cron === null || $cron['log_age_seconds'] === null) {
            return ProbeResult::unknown('cron-unreported', ['cron' => $name]);
        }

        $detail = ['cron' => $name, 'log_age_seconds' => $cron['log_age_seconds'], 'log_size_mb' => $cron['log_size_mb']];

        if ($cron['log_age_seconds'] > (int) $definition->checkOption('stale_seconds', 3600)) {
            return ProbeResult::down('cron-silent', $detail);
        }

        // An unrotated log is not an outage today and is an outage the day the
        // disk fills, which takes everything on the host with it.
        if (($cron['log_size_mb'] ?? 0) > (float) $definition->checkOption('max_log_mb', 512)) {
            return ProbeResult::degraded('log-unrotated', $detail);
        }

        return ProbeResult::up($detail);
    }

    /**
     * The reporting itself, across every machine.
     *
     * This is the one heartbeat-backed check that may legitimately be `down`:
     * everything else goes `unknown` when the report stops, so something has
     * to say out loud that the reason they all went blind is that nobody is
     * reporting.
     */
    private function evaluateHeartbeatSelf(HeartbeatFleet $fleet): ProbeResult
    {
        if ($fleet->isEmpty()) {
            return ProbeResult::down('never-reported', [
                'hint' => 'scripts/ops/heartbeat.sh is not installed on the host cron.',
            ]);
        }

        $stale = [];
        $fresh = [];

        foreach ($fleet->all() as $host => $snapshot) {
            $snapshot->stale() ? $stale[] = $host : $fresh[] = $host;
        }

        $detail = ['reporting' => $fresh, 'silent' => $stale];

        if ($fresh === []) {
            return ProbeResult::down('heartbeat-stale', $detail);
        }

        return $stale === []
            ? ProbeResult::up($detail)
            : ProbeResult::degraded('heartbeat-stale', $detail);
    }

    /** Which machine a service lives on. Unnamed means the default host. */
    private function snapshotFor(ServiceDefinition $definition, HeartbeatFleet $fleet): HeartbeatSnapshot
    {
        $host = $definition->checkOption('host');

        if (is_string($host) && $host !== '') {
            return $fleet->for($host);
        }

        return $definition->declaresHost()
            ? HeartbeatSnapshot::absent()
            : $fleet->for(null);
    }

    private function evaluateHost(ServiceDefinition $definition, HeartbeatSnapshot $heartbeat): ProbeResult
    {
        if ($heartbeat->missing()) {
            return ProbeResult::unknown('host-unreported', ['host' => $heartbeat->host]);
        }

        if ($heartbeat->stale()) {
            return ProbeResult::unknown('heartbeat-stale', ['age_seconds' => $heartbeat->ageSeconds()]);
        }

        $metrics = $heartbeat->metrics();
        $problems = [];

        $cpus = max(1, (int) ($metrics['cpus'] ?? 1));
        $load = is_array($metrics['load'] ?? null) ? (float) ($metrics['load'][0] ?? 0) : null;

        if ($load !== null && $load / $cpus > (float) $definition->checkOption('max_load_per_cpu', 3.0)) {
            $problems[] = 'load';
        }

        $disk = is_array($metrics['disk'] ?? null) ? (float) ($metrics['disk']['used_percent'] ?? 0) : null;

        if ($disk !== null && $disk > (float) $definition->checkOption('max_disk_percent', 90)) {
            $problems[] = 'disk';
        }

        $memory = is_array($metrics['memory'] ?? null) ? $metrics['memory'] : null;

        if ($memory !== null && (float) ($memory['total_mb'] ?? 0) > 0) {
            $free = (float) ($memory['available_mb'] ?? 0) / (float) $memory['total_mb'] * 100;

            if ($free < (float) $definition->checkOption('min_memory_percent', 5)) {
                $problems[] = 'memory';
            }
        }

        return $problems === []
            ? ProbeResult::up($metrics)
            // Pressure, not failure: the host is still serving, and it is the
            // hour before it stops that is worth having.
            : ProbeResult::degraded('host-pressure', $metrics + ['problems' => $problems]);
    }

    /* ------------------------------------------------------------ helpers -- */

    /** @param array<string, mixed> $detail */
    private function slowOrUp(array $detail, ?int $latency): ProbeResult
    {
        $slow = (int) config('monitoring.probe.slow_ms', 3000);

        return $latency !== null && $latency > $slow
            ? ProbeResult::degraded('slow', $detail, $latency)
            : ProbeResult::up($detail, $latency);
    }

    private function latencyOf(Response $response): ?int
    {
        $stats = $response->handlerStats();

        return isset($stats['total_time'])
            ? (int) round(((float) $stats['total_time']) * 1000)
            : null;
    }

    /** @return array<string, mixed> */
    private function errorDetail(mixed $response): array
    {
        if ($response instanceof Throwable) {
            return ['error' => $response->getMessage()];
        }

        if ($response instanceof Response) {
            return ['status' => $response->status()];
        }

        return ['error' => 'no response'];
    }

    private function relayerAddress(): ?string
    {
        try {
            return $this->relayer->evmAddress();
        } catch (Throwable) {
            return null;
        }
    }

    private function cyberiaRpc(): string
    {
        return (string) (config('monitoring.services.cyberia-rpc.check.url')
            ?: config('services.bridge.evm_rpc_url')
            ?: 'https://rpc.cyberia.church');
    }

    /** Hex quantity to a decimal string, because wei does not fit in an int. */
    private function hexToDecimalString(string $hex): string
    {
        $hex = ltrim(strtolower($hex), '0x');

        if ($hex === '') {
            return '0';
        }

        $decimal = '0';

        foreach (str_split($hex) as $digit) {
            $decimal = bcadd(bcmul($decimal, '16'), (string) hexdec($digit));
        }

        return $decimal;
    }

    private function weiToCyber(string $wei): string
    {
        return rtrim(rtrim(bcdiv($wei, bcpow('10', '18'), 4), '0'), '.') ?: '0';
    }
}
