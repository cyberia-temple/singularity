<?php

namespace App\Services\Monitoring;

use App\Models\ServiceCheck;
use App\Models\ServiceIncident;
use App\Services\TelegramOpsNotifier;
use Carbon\CarbonImmutable;

/**
 * One sweep: probe everything, write it down, and decide who needs telling.
 *
 * The alerting rule is the whole design. Alerts fire on *transitions* and
 * never on state, because the alternative — a message every five minutes for
 * as long as something is broken — ends with the channel muted, and a muted
 * channel is worse than none: it looks like monitoring while being silence.
 *
 * So an incident is a row, not a cache entry. It is opened once, after enough
 * consecutive failures that a single network hiccup on this host cannot open
 * it; announced once; reminded about at most once a day; and announced again
 * when it closes — after as many good checks as it took bad ones to open
 * it — because "it's back" is the half people are waiting for, and a false
 * "it's back" is the fastest way to teach them not to wait.
 *
 * `unknown` never opens an incident and never closes one. Going blind is not
 * the same as going down, and a monitor that shouts when it loses sight of
 * something teaches people to ignore it at exactly the wrong moment.
 */
class ServiceMonitor
{
    public function __construct(
        private ServiceRegistry $registry,
        private ServiceProbe $probe,
        private TelegramOpsNotifier $telegram,
    ) {}

    /**
     * @return array<string, ProbeResult>
     */
    public function sweep(bool $alert = false): array
    {
        $definitions = array_values($this->registry->all());
        // Some faults are only visible as a difference between two sweeps — a
        // container whose restart counter is climbing reads as `running` every
        // time you look at it — so the probe is handed what the last sweep saw.
        $results = $this->probe->probeAll($definitions, $this->lastSeen());
        $now = CarbonImmutable::now();

        $transitions = [];

        foreach ($definitions as $definition) {
            $result = $results[$definition->key] ?? ProbeResult::unknown('not-probed');

            ServiceCheck::create([
                'service' => $definition->key,
                'status' => $result->status->value,
                'latency_ms' => $result->latencyMs,
                'detail' => $result->reason === null
                    ? $result->detail
                    : ['reason' => $result->reason] + $result->detail,
                'checked_at' => $now,
            ]);

            $transition = $this->reconcile($definition, $result, $now);

            if ($transition !== null) {
                $transitions[] = $transition;
            }
        }

        if ($alert && $transitions !== [] && config('monitoring.alerts.enabled', true)) {
            $this->announce($transitions);
        }

        return $results;
    }

    /**
     * The detail each service reported last time, for probes that compare.
     *
     * @return array<string, array<string, mixed>>
     */
    private function lastSeen(): array
    {
        $checks = ServiceCheck::query()
            ->whereIn('id', ServiceCheck::latestIds())
            ->get(['service', 'detail']);

        $seen = [];

        foreach ($checks as $check) {
            $seen[$check->service] = is_array($check->detail) ? $check->detail : [];
        }

        return $seen;
    }

    /**
     * Move the service's incident record to match what we just saw.
     *
     * @return array{kind: string, definition: ServiceDefinition, incident: ServiceIncident}|null
     */
    private function reconcile(
        ServiceDefinition $definition,
        ProbeResult $result,
        CarbonImmutable $now,
    ): ?array {
        /** @var ServiceIncident|null $open */
        $open = ServiceIncident::query()->open()->where('service', $definition->key)->first();

        if ($result->status === ServiceStatus::Unknown) {
            return null;
        }

        if (! $result->status->isIncident()) {
            if ($open === null || ! $this->recovered($definition)) {
                return null;
            }

            $open->update(['resolved_at' => $now]);

            return ['kind' => 'resolved', 'definition' => $definition, 'incident' => $open];
        }

        if ($open !== null) {
            // A service that slid from degraded to down is the same incident
            // with worse news; recording the worst state it reached is what
            // makes the history readable afterwards.
            if ($open->status !== $result->status->value
                && ServiceStatus::from($open->status)->severity() < $result->status->severity()
            ) {
                $open->update([
                    'status' => $result->status->value,
                    'reason' => $result->reason,
                    'detail' => $result->detail,
                ]);

                return ['kind' => 'worsened', 'definition' => $definition, 'incident' => $open];
            }

            return $this->maybeRemind($definition, $open, $now);
        }

        if (! $this->confirmed($definition, $now)) {
            return null;
        }

        $incident = ServiceIncident::create([
            'service' => $definition->key,
            'status' => $result->status->value,
            'reason' => $result->reason,
            'detail' => $result->detail,
            'started_at' => $now,
        ]);

        return ['kind' => 'opened', 'definition' => $definition, 'incident' => $incident];
    }

    /**
     * Whether the last few checks agree that this is really broken.
     *
     * One failed probe is usually this host's own network, and opening an
     * incident on it costs more trust than the incident is worth.
     */
    private function confirmed(ServiceDefinition $definition, CarbonImmutable $now): bool
    {
        $required = max(1, (int) config('monitoring.alerts.failures_before_alert', 2));

        $recent = ServiceCheck::query()
            ->where('service', $definition->key)
            ->orderByDesc('checked_at')
            ->orderByDesc('id')
            ->limit($required)
            ->pluck('status');

        if ($recent->count() < $required) {
            return false;
        }

        return $recent->every(fn (string $status) => ServiceStatus::from($status)->isIncident());
    }

    /**
     * Whether the last few checks agree that it really came back.
     *
     * The mirror of `confirmed()`. Opening took two failures and closing took
     * one success, so anything that fails more often than not but answers now
     * and then — a wallet behind a dying node, an endpoint at the edge of its
     * timeout — produced a "down / recovered" pair every hour, each pair
     * carrying no news. An `unknown` in the window holds the incident open:
     * going blind is not coming back.
     */
    private function recovered(ServiceDefinition $definition): bool
    {
        $required = max(1, (int) config('monitoring.alerts.checks_before_resolve', 2));

        $recent = ServiceCheck::query()
            ->where('service', $definition->key)
            ->orderByDesc('checked_at')
            ->orderByDesc('id')
            ->limit($required)
            ->pluck('status');

        return $recent->count() >= $required
            && $recent->every(function (string $status) {
                $status = ServiceStatus::from($status);

                return $status !== ServiceStatus::Unknown && ! $status->isIncident();
            });
    }

    /** @return array{kind: string, definition: ServiceDefinition, incident: ServiceIncident}|null */
    private function maybeRemind(
        ServiceDefinition $definition,
        ServiceIncident $incident,
        CarbonImmutable $now,
    ): ?array {
        $hours = (int) config('monitoring.alerts.reminder_hours', 12);
        $since = $incident->reminded_at ?? $incident->notified_at ?? $incident->started_at;

        if ($since === null || CarbonImmutable::parse($since)->addHours($hours)->isFuture()) {
            return null;
        }

        $incident->update(['reminded_at' => $now]);

        return ['kind' => 'reminder', 'definition' => $definition, 'incident' => $incident];
    }

    /**
     * One message per sweep, however many services changed.
     *
     * Five services going down at once is almost always one cause — the host,
     * the proxy, the network — and five separate messages would hide that.
     *
     * @param  array<int, array{kind: string, definition: ServiceDefinition, incident: ServiceIncident}>  $transitions
     */
    private function announce(array $transitions): void
    {
        $lines = [];

        foreach ($transitions as $transition) {
            $definition = $transition['definition'];
            $incident = $transition['incident'];
            $status = ServiceStatus::from($incident->status);

            $lines[] = match ($transition['kind']) {
                'resolved' => '🟢 <b>'.e($definition->label).'</b> recovered after '
                    .$this->duration($incident->durationSeconds()),
                'reminder' => $status->emoji().' <b>'.e($definition->label).'</b> still '
                    .$status->value.' — '.$this->duration($incident->durationSeconds()),
                'worsened' => $status->emoji().' <b>'.e($definition->label).'</b> got worse: '
                    .e((string) $incident->reason),
                default => $status->emoji().' <b>'.e($definition->label).'</b> is '
                    .$status->value.' — '.e((string) $incident->reason),
            };

            // A recovery needs no more than its duration. Everything else is
            // a request for somebody's attention, and a reason key alone told
            // them only that something somewhere had a name: what was seen
            // and what to do about it is the part that makes it actionable.
            if ($transition['kind'] === 'resolved') {
                continue;
            }

            $facts = $this->facts(is_array($incident->detail) ? $incident->detail : []);

            if ($facts !== '') {
                $lines[] = '    '.$facts;
            }

            if ($definition->runbook !== null) {
                $lines[] = '    → '.e($definition->runbook);
            }
        }

        $sent = $this->telegram->send(
            "🩺 <b>Cyberia services</b>\n\n".implode("\n", $lines)
            ."\n\n<a href=\"".e(url('/crm/services')).'">Board</a>',
        );

        if (! $sent) {
            return;
        }

        // Only stamp what was actually delivered: an unconfigured or refusing
        // Telegram must leave the incident looking un-announced, so the next
        // sweep tries again instead of going quiet about a live outage.
        foreach ($transitions as $transition) {
            if ($transition['kind'] === 'opened') {
                $transition['incident']->update(['notified_at' => CarbonImmutable::now()]);
            }
        }
    }

    /**
     * The scalar half of a probe's detail, as one line.
     *
     * `detail` is free-form per probe, so this does not know what any key
     * means — only that a timestamp reads better as how long ago it was.
     *
     * @param  array<string, mixed>  $detail
     */
    private function facts(array $detail): string
    {
        $parts = [];

        foreach ($detail as $key => $value) {
            if (! is_scalar($value) || $value === '' || count($parts) >= 4) {
                continue;
            }

            $label = str_replace('_', ' ', (string) $key);

            if (is_string($value) && str_ends_with((string) $key, '_since')) {
                try {
                    $at = CarbonImmutable::parse($value)->utc();
                    $value = $at->format('d.m H:i').' UTC ('.$this->duration((int) $at->diffInSeconds(CarbonImmutable::now())).' ago)';
                } catch (\Throwable) {
                    // Not a date after all; print it as it came.
                }
            } elseif (is_bool($value)) {
                $value = $value ? 'yes' : 'no';
            }

            $parts[] = e($label).' '.e((string) $value);
        }

        return implode(' · ', $parts);
    }

    private function duration(int $seconds): string
    {
        if ($seconds < 90) {
            return $seconds.'s';
        }

        if ($seconds < 5400) {
            return round($seconds / 60).'m';
        }

        return $seconds < 172800
            ? round($seconds / 3600, 1).'h'
            : round($seconds / 86400, 1).'d';
    }
}
