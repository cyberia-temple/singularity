<?php

namespace App\Services\Arena;

use App\Models\ArenaCycle;
use App\Models\ArenaSeason;
use Carbon\CarbonImmutable;
use DomainException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Throwable;

class ArenaAutomation
{
    public function __construct(private ArenaSeasonManager $manager, private ArenaMarketFeed $market, private ArenaModelClient $models) {}

    public function tick(): string
    {
        if (! config('arena.enabled') || ! config('arena.automation.enabled')) {
            return 'disabled';
        }
        $season = ArenaSeason::query()->where('slug', config('arena.slug'))->first();
        if ($season && $season->starts_at && $season->rules['mode'] === 'automatic-multi') {
            return Cache::lock('arena-tick-'.$season->id, 180)->get(fn (): string => app(ArenaMultiAutomation::class)->tick($season)) ?? 'busy';
        }
        if (! $season || $season->rules['mode'] !== 'automatic-paper' || ! $season->starts_at) {
            return 'not_scheduled';
        }
        try {
            ArenaModelClient::assertFreeOnly($season->rules['automation']);
        } catch (DomainException) {
            $season->update(['automation_error' => 'free_models_required']);

            return 'free_models_required';
        }

        return Cache::lock('arena-tick-'.$season->id, 180)->get(function () use ($season): string {
            $season->update(['last_tick_at' => CarbonImmutable::now('UTC')]);
            try {
                if ($season->rules_hash !== $this->manager->digest($season->rules)) {
                    throw new DomainException('frozen_rules_changed');
                }
                $result = $this->advance($season);
                if (! in_array($result, ['fill_unavailable', 'market_unavailable', 'both_models_failed', 'missing_model_key', 'budget_exhausted'], true)) {
                    $season->update(['automation_error' => null]);
                }

                return $result;
            } catch (Throwable) {
                $season->update(['automation_error' => 'automation_failed']);

                return 'automation_failed';
            }
        }) ?? 'busy';
    }

    private function advance(ArenaSeason $season): string
    {
        $now = CarbonImmutable::now('UTC');
        $settings = $season->rules['automation'];
        $pending = $season->cycles()->whereIn('status', ['collecting', 'awaiting_fill'])->orderBy('slot')->first();
        if ($pending) {
            if ($pending->status === 'collecting') {
                if ($now->greaterThanOrEqualTo($pending->decision_at)) {
                    return $this->skip($pending, 'decision_incomplete');
                }

                return 'collecting';
            }
            if ($now->lessThan($pending->fill_due_at)) {
                return 'awaiting_fill';
            }
            if ($now->greaterThan($pending->fill_due_at->addSeconds($settings['fill_window_seconds'])) || $now->greaterThan($season->ends_at)) {
                return $this->skip($pending, 'fill_window_missed');
            }

            return $this->fill($season, $pending);
        }
        if ($now->lessThan($season->starts_at)) {
            return 'not_started';
        }
        if ($now->greaterThanOrEqualTo($season->ends_at)) {
            return 'ended';
        }
        if (! ArenaModelClient::hasKeysFor((array) ($settings['models'] ?? []))) {
            $season->update(['automation_error' => 'missing_model_key']);

            return 'missing_model_key';
        }
        $interval = intdiv(86400, $season->rules['rounds_per_day']);
        $slot = intdiv($now->getTimestamp() - $season->starts_at->getTimestamp(), $interval);
        $slotAt = $season->starts_at->addSeconds($slot * $interval);
        $cycle = DB::transaction(function () use ($season, $slot, $slotAt, $settings, $now): ?ArenaCycle {
            $locked = ArenaSeason::query()->lockForUpdate()->findOrFail($season->id);
            if ($locked->cycles()->where('slot', $slot)->exists()) {
                return null;
            }
            // Record missed slots explicitly; never backfill decisions using future observations.
            $firstMissing = (int) ($locked->cycles()->max('slot') ?? -1) + 1;
            for ($missed = $firstMissing; $missed < $slot; $missed++) {
                $deadline = $season->starts_at->addSeconds($missed * intdiv(86400, $season->rules['rounds_per_day']) + $settings['decision_window_seconds']);
                $locked->cycles()->create(['slot' => $missed, 'decision_at' => $deadline,
                    'fill_due_at' => $deadline->addSeconds($settings['fill_delay_seconds']),
                    'status' => 'skipped', 'error_code' => 'opening_window_missed', 'record' => []]);
            }
            $deadline = $slotAt->addSeconds($settings['decision_window_seconds']);
            $missedWindow = $now->greaterThan($slotAt->addSeconds($settings['opening_window_seconds']));

            return $locked->cycles()->create(['slot' => $slot, 'decision_at' => $deadline,
                'fill_due_at' => $deadline->addSeconds($settings['fill_delay_seconds']),
                'status' => $missedWindow ? 'skipped' : 'collecting',
                'error_code' => $missedWindow ? 'opening_window_missed' : null, 'record' => []]);
        });
        if (! $cycle) {
            return 'slot_already_recorded';
        }
        if ($cycle->status === 'skipped') {
            return 'opening_window_missed';
        }

        return $this->collect($season, $cycle);
    }

    private function collect(ArenaSeason $season, ArenaCycle $cycle): string
    {
        $settings = $season->rules['automation'];
        try {
            $observation = $this->market->quote($settings['market_source'], $settings['max_block_age_seconds']);
        } catch (Throwable) {
            $season->update(['automation_error' => 'market_unavailable']);

            return $this->skip($cycle, 'market_unavailable');
        }
        if (CarbonImmutable::now('UTC')->greaterThanOrEqualTo($cycle->decision_at)) {
            return $this->skip($cycle, 'decision_incomplete');
        }
        $reserved = DB::transaction(function () use ($season, $cycle, $settings): bool {
            ArenaSeason::query()->lockForUpdate()->findOrFail($season->id);
            $budget = min($settings['budget_cents'], (int) config('arena.automation.budget_cents'));
            $calls = min($settings['max_calls'], (int) config('arena.automation.max_calls'));
            if ($season->cycles()->sum('reserved_cents') + 2 * $settings['reservation_cents_per_call'] > $budget
                || $season->cycles()->sum('reserved_calls') + 2 > $calls) {
                return false;
            }
            $cycle->update(['reserved_cents' => 2 * $settings['reservation_cents_per_call'], 'reserved_calls' => 2]);

            return true;
        });
        if (! $reserved) {
            $season->update(['automation_error' => 'budget_exhausted']);

            return $this->skip($cycle, 'budget_exhausted');
        }
        $previous = $season->rounds()->orderByDesc('sequence')->first();
        $initial = ['cash' => $season->rules['initial_cash_micros'], 'asset' => '0'];
        $history = $season->rounds()->orderByDesc('sequence')->limit(8)->get()->reverse()->map(fn ($round) => [
            'filled_at' => $round->filled_at->toIso8601String(), 'price_micros' => $round->evidence['price_micros'],
        ])->values()->all();
        $record = ['rules_hash' => $season->rules_hash, 'slot' => $cycle->slot,
            'decision_at' => $cycle->decision_at->toIso8601String(), 'observation' => $observation, 'history' => $history,
            'attempts' => [], 'decisions' => []];
        foreach (['lain', 'challenger'] as $actor) {
            $balance = $previous?->result['actors'][$actor]['balance'] ?? $initial;
            $context = ['observation' => $observation, 'history' => $history, 'balance' => $balance,
                'previous_decision' => $previous?->evidence['decisions'][$actor] ?? null,
                'modeled_costs' => array_intersect_key($season->rules, array_flip(['fee_bps', 'slippage_bps', 'gas_micros']))];
            $attempt = ['status' => 'started', 'requested_model' => $settings['models'][$actor],
                'started_at' => CarbonImmutable::now('UTC')->toIso8601String(), 'context' => $context];
            $record['attempts'][$actor] = $attempt;
            $cycle->update(['record' => $record]);
            try {
                if (CarbonImmutable::now('UTC')->greaterThanOrEqualTo($cycle->decision_at)) {
                    throw new DomainException('decision_deadline_passed');
                }
                $response = $this->models->decide($actor, $season->rules, $context);
                $attempt = [...$attempt, ...$response, 'status' => 'ok'];
            } catch (Throwable) {
                $attempt['status'] = 'failed';
                $attempt['error_code'] = 'model_call_failed';
            }
            $attempt['completed_at'] = CarbonImmutable::now('UTC')->toIso8601String();
            $record['attempts'][$actor] = $attempt;
            $record['decisions'][$actor] = $attempt['decision'] ?? ['action' => 'hold', 'bps' => 0,
                'reason' => 'Model call failed; no new order. This is a failure fallback, not a model decision.', 'model' => $settings['models'][$actor]];
            $cycle->update(['record' => $record]);
        }
        if (CarbonImmutable::now('UTC')->greaterThanOrEqualTo($cycle->decision_at)) {
            return $this->skip($cycle, 'decision_incomplete');
        }
        if (collect($record['attempts'])->every(fn ($attempt) => $attempt['status'] === 'failed')) {
            $season->update(['automation_error' => 'both_models_failed']);

            return $this->skip($cycle, 'both_models_failed');
        }

        return DB::transaction(function () use ($cycle, $record): string {
            $locked = ArenaCycle::query()->lockForUpdate()->findOrFail($cycle->id);
            $now = CarbonImmutable::now('UTC');
            if ($locked->status !== 'collecting' || $now->greaterThanOrEqualTo($locked->decision_at)) {
                if ($locked->status === 'collecting') {
                    $this->skip($locked, 'decision_incomplete');
                }

                return 'decision_incomplete';
            }
            $record['committed_at'] = $now->toIso8601String();
            $locked->update(['record' => $record, 'commit_hash' => $this->manager->digest($record), 'status' => 'awaiting_fill']);

            return 'awaiting_fill';
        });
    }

    private function fill(ArenaSeason $season, ArenaCycle $cycle): string
    {
        $settings = $season->rules['automation'];
        try {
            $quote = $this->market->quote($settings['market_source'], $settings['max_block_age_seconds']);
            if (CarbonImmutable::parse($quote['block_at'])->lessThan($cycle->fill_due_at)) {
                throw new DomainException('fill_block_too_early');
            }
        } catch (Throwable) {
            $season->update(['automation_error' => 'fill_unavailable']);

            return 'fill_unavailable';
        }
        $now = CarbonImmutable::now('UTC');
        if ($now->greaterThan($cycle->fill_due_at->addSeconds($settings['fill_window_seconds'])) || $now->greaterThan($season->ends_at)) {
            return $this->skip($cycle, 'fill_window_missed');
        }
        DB::transaction(function () use ($season, $cycle, $quote, $now): void {
            $locked = ArenaSeason::query()->lockForUpdate()->findOrFail($season->id);
            $lockedCycle = ArenaCycle::query()->lockForUpdate()->findOrFail($cycle->id);
            if ($lockedCycle->status !== 'awaiting_fill') {
                return;
            }
            $round = $this->manager->import($locked, [
                'sequence' => (int) $locked->rounds()->max('sequence') + 1,
                'decision_at' => $lockedCycle->decision_at->toIso8601String(), 'filled_at' => $now->toIso8601String(),
                'price_micros' => $quote['price_micros'], 'source' => $quote['source'], 'decisions' => $lockedCycle->record['decisions'],
            ], $now, $lockedCycle, $quote);
            $lockedCycle->update(['status' => 'complete', 'arena_round_id' => $round->id]);
        });

        return 'complete';
    }

    private function skip(ArenaCycle $cycle, string $code): string
    {
        ArenaCycle::query()->whereKey($cycle->id)->where('status', $cycle->status)
            ->update(['status' => 'skipped', 'error_code' => $code]);

        return $code;
    }
}
