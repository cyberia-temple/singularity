<?php

namespace App\Services\Arena;

use App\Models\ArenaCycle;
use App\Models\ArenaRound;
use App\Models\ArenaSeason;
use Carbon\CarbonImmutable;
use DomainException;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * The runner for a multi-token season. Same discipline as the single-market
 * runner: each slot's decisions are committed (hashed) before the price they
 * are filled at is read, a missed slot is recorded as missed and never
 * backfilled, and every accepted round chains the previous round's hash.
 */
class ArenaMultiAutomation
{
    public function __construct(private ArenaSeasonManager $manager, private ArenaQuoteBoard $board,
        private ArenaModelClient $models, private MultiLedger $ledger) {}

    /** @return array<string, mixed> */
    public static function rules(): array
    {
        $settings = config('arena.automation');
        ArenaModelClient::assertFreeOnly($settings);
        $multi = config('arena.multi');
        $rules = [
            'version' => 5, 'mode' => 'automatic-multi', 'market' => 'Any Solana token, plus Robinhood Chain anchors / USD',
            'days' => (int) config('arena.days'), 'rounds_per_day' => (int) config('arena.rounds_per_day'),
            'initial_cash_usd' => (string) $multi['initial_cash_usd'],
            'fee_bps' => (int) $multi['fee_bps'], 'slippage_bps' => (int) $multi['slippage_bps'],
            'min_liquidity_usd' => (int) $multi['min_liquidity_usd'],
            'universe' => 'any', 'anchors' => array_values(config('arena.anchors')),
            'candidates' => ['source' => 'DexScreener top boosted Solana tokens (paid promotion, not a recommendation)',
                'limit' => (int) config('arena.candidates')],
            'benchmark' => 'SOL', 'benchmark_mint' => 'So11111111111111111111111111111111111111112',
            'agents' => config('arena.agents'),
            'automation' => [
                'pricing_policy' => 'free-only', 'budget_cents' => 0, 'reservation_cents_per_call' => 0,
                'max_price_per_million' => 0, 'max_calls' => 112, 'max_prompt_bytes' => 16000, 'max_output_tokens' => 400,
                'timeout_seconds' => 20, 'opening_window_seconds' => 90, 'decision_window_seconds' => 180,
                'fill_delay_seconds' => 60, 'fill_window_seconds' => 180,
                'max_quote_age_seconds' => (int) $multi['max_quote_age_seconds'],
                'models' => $settings['models'], 'prompt' => ArenaModelClient::MULTI_PROMPT,
                'runtime' => 'Isolated, tool-free paper personas; not the privileged LainOS daemon',
            ],
        ];
        $partner = config('arena.partner');
        if (is_string($partner) && is_array(config('arena.partners.'.$partner))) {
            $rules['partner'] = ['slug' => $partner, ...config('arena.partners.'.$partner)];
        }

        return $rules;
    }

    public function tick(ArenaSeason $season): string
    {
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
    }

    private function advance(ArenaSeason $season): string
    {
        $now = CarbonImmutable::now('UTC');
        $settings = $season->rules['automation'];
        $pending = $season->cycles()->whereIn('status', ['collecting', 'awaiting_fill'])->orderBy('slot')->first();
        if ($pending) {
            if ($pending->status === 'collecting') {
                return $now->greaterThanOrEqualTo($pending->decision_at) ? $this->skip($pending, 'decision_incomplete') : 'collecting';
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
        if (! config('arena.automation.api_key')) {
            $season->update(['automation_error' => 'missing_model_key']);

            return 'missing_model_key';
        }
        $interval = intdiv(86400, $season->rules['rounds_per_day']);
        $slot = intdiv($now->getTimestamp() - $season->starts_at->getTimestamp(), $interval);
        $slotAt = $season->starts_at->addSeconds($slot * $interval);
        $cycle = DB::transaction(function () use ($season, $slot, $slotAt, $settings, $now, $interval): ?ArenaCycle {
            $locked = ArenaSeason::query()->lockForUpdate()->findOrFail($season->id);
            if ($locked->cycles()->where('slot', $slot)->exists()) {
                return null;
            }
            for ($missed = (int) ($locked->cycles()->max('slot') ?? -1) + 1; $missed < $slot; $missed++) {
                $deadline = $season->starts_at->addSeconds($missed * $interval + $settings['decision_window_seconds']);
                $locked->cycles()->create(['slot' => $missed, 'decision_at' => $deadline,
                    'fill_due_at' => $deadline->addSeconds($settings['fill_delay_seconds']),
                    'status' => 'skipped', 'error_code' => 'opening_window_missed', 'record' => []]);
            }
            $deadline = $slotAt->addSeconds($settings['decision_window_seconds']);
            $late = $now->greaterThan($slotAt->addSeconds($settings['opening_window_seconds']));

            return $locked->cycles()->create(['slot' => $slot, 'decision_at' => $deadline,
                'fill_due_at' => $deadline->addSeconds($settings['fill_delay_seconds']),
                'status' => $late ? 'skipped' : 'collecting', 'error_code' => $late ? 'opening_window_missed' : null, 'record' => []]);
        });
        if (! $cycle) {
            return 'slot_already_recorded';
        }

        return $cycle->status === 'skipped' ? 'opening_window_missed' : $this->collect($season, $cycle);
    }

    private function collect(ArenaSeason $season, ArenaCycle $cycle): string
    {
        $rules = $season->rules;
        $settings = $rules['automation'];
        $previous = $season->rounds()->orderByDesc('sequence')->first();
        try {
            $mints = [...$this->held($rules, $previous), ...$this->board->candidates($rules['candidates']['limit'])];
            $board = $this->board->read(array_slice(array_values(array_unique($mints)), 0, 30), $rules['min_liquidity_usd'],
                array_column($rules['anchors'], 'symbol', 'mint'));
        } catch (Throwable) {
            $season->update(['automation_error' => 'market_unavailable']);

            return $this->skip($cycle, 'market_unavailable');
        }
        if ($season->cycles()->sum('reserved_calls') + 2 > $settings['max_calls']) {
            $season->update(['automation_error' => 'budget_exhausted']);

            return $this->skip($cycle, 'budget_exhausted');
        }
        $cycle->update(['reserved_calls' => 2, 'reserved_cents' => 0]);
        $recent = $season->rounds()->orderByDesc('sequence')->limit(6)->get();
        $record = ['rules_hash' => $season->rules_hash, 'slot' => $cycle->slot, 'decision_at' => $cycle->decision_at->toIso8601String(),
            'board' => $board, 'attempts' => [], 'decisions' => []];
        foreach (array_keys($rules['agents']) as $actor) {
            $state = $previous?->result['actors'][$actor]['state'] ?? $this->ledger->initial($rules['initial_cash_usd']);
            $symbols = $previous?->result['symbols'] ?? [];
            $context = ['board' => collect($board['prices'])->map(fn ($row, $mint) => ['mint' => $mint, 'symbol' => $row['symbol'],
                'usd' => $row['usd'], 'liquidity_usd' => $row['liquidity_usd'], 'change_h24' => $row['change_h24']])->values()->all(),
                'portfolio' => ['cash' => $state['cash'], 'positions' => collect($state['positions'])->map(fn ($position, $mint) => [
                    'mint' => $mint, 'symbol' => $symbols[$mint] ?? $board['prices'][$mint]['symbol'] ?? null, ...$position])->values()->all()],
                'equity_usd' => $previous?->result['actors'][$actor]['equity'] ?? $rules['initial_cash_usd'],
                'recent_trades' => $recent->map(fn ($round) => $round->result['actors'][$actor]['trade'] ?? null)->filter()->values()->all(),
                'costs' => ['fee_bps' => $rules['fee_bps'], 'slippage_bps' => $rules['slippage_bps']]];
            $attempt = ['status' => 'started', 'requested_model' => $settings['models'][$actor], 'started_at' => CarbonImmutable::now('UTC')->toIso8601String()];
            try {
                if (CarbonImmutable::now('UTC')->greaterThanOrEqualTo($cycle->decision_at)) {
                    throw new DomainException('decision_deadline_passed');
                }
                $attempt = [...$attempt, ...$this->models->decideMulti($actor, $rules, $context), 'status' => 'ok'];
            } catch (Throwable $exception) {
                $attempt['status'] = 'failed';
                $attempt['error_code'] = 'model_call_failed';
                // Our own refusal codes say why; anything else is named by class
                // only, so no upstream text (or credential) lands in the record.
                $attempt['error_detail'] = $exception instanceof DomainException
                    ? substr($exception->getMessage(), 0, 60) : class_basename($exception);
            }
            $attempt['completed_at'] = CarbonImmutable::now('UTC')->toIso8601String();
            $record['attempts'][$actor] = $attempt;
            $record['decisions'][$actor] = $attempt['decision'] ?? ['action' => 'hold', 'token' => null, 'bps' => 0,
                'reason' => 'Model call failed; no new order. This is a failure fallback, not a model decision.', 'model' => $settings['models'][$actor]];
            $cycle->update(['record' => $record]);
        }
        if (collect($record['attempts'])->every(fn ($attempt) => $attempt['status'] === 'failed')) {
            $season->update(['automation_error' => 'both_models_failed']);

            return $this->skip($cycle, 'both_models_failed');
        }
        $now = CarbonImmutable::now('UTC');
        if ($now->greaterThanOrEqualTo($cycle->decision_at)) {
            return $this->skip($cycle, 'decision_incomplete');
        }
        $record['committed_at'] = $now->toIso8601String();
        $cycle->update(['record' => $record, 'commit_hash' => $this->manager->digest($record), 'status' => 'awaiting_fill']);

        return 'awaiting_fill';
    }

    private function fill(ArenaSeason $season, ArenaCycle $cycle): string
    {
        $rules = $season->rules;
        try {
            $decided = collect($cycle->record['decisions'] ?? [])->pluck('token')->filter()->all();
            $held = $this->held($rules, $season->rounds()->orderByDesc('sequence')->first());
            $board = $this->board->read([...$held, ...$decided], $rules['min_liquidity_usd'], array_column($rules['anchors'], 'symbol', 'mint'));
        } catch (Throwable) {
            $season->update(['automation_error' => 'fill_unavailable']);

            return 'fill_unavailable';
        }
        DB::transaction(function () use ($season, $cycle, $board, $rules): void {
            $locked = ArenaSeason::query()->lockForUpdate()->findOrFail($season->id);
            $lockedCycle = ArenaCycle::query()->lockForUpdate()->findOrFail($cycle->id);
            if ($lockedCycle->status !== 'awaiting_fill' || $lockedCycle->commit_hash !== $this->manager->digest($lockedCycle->record)) {
                return;
            }
            $previous = $locked->rounds()->orderByDesc('sequence')->first();
            // A token missing from this board keeps its last accepted price for
            // valuation; it cannot be traded at a price nobody read.
            $last = $previous?->result['prices'] ?? [];
            $fresh = array_map(fn ($row) => $row['usd'], $board['prices']);
            $symbols = [...($previous?->result['symbols'] ?? []), ...array_map(fn ($row) => $row['symbol'], $board['prices'])];
            $prices = [...$last, ...$fresh];
            $costs = ['fee_bps' => $rules['fee_bps'], 'slippage_bps' => $rules['slippage_bps']];
            $actors = [];
            foreach (array_keys($rules['agents']) as $actor) {
                $state = $previous?->result['actors'][$actor]['state'] ?? $this->ledger->initial($rules['initial_cash_usd']);
                $execution = 'accepted';
                $trade = null;
                try {
                    [$state, $trade] = $this->ledger->apply($state, $lockedCycle->record['decisions'][$actor], $fresh, $costs);
                    if ($trade) {
                        $trade['symbol'] = $symbols[$trade['token']] ?? null;
                    }
                } catch (DomainException $exception) {
                    $execution = 'rejected:'.$exception->getMessage();
                }
                $actors[$actor] = ['state' => $state, 'equity' => $this->ledger->equity($state, $prices, $costs), 'trade' => $trade, 'execution' => $execution];
            }
            $benchmark = $previous?->result['benchmark']['state'] ?? null;
            if ($benchmark === null && isset($fresh[$rules['benchmark_mint']])) {
                [$benchmark] = $this->ledger->apply($this->ledger->initial($rules['initial_cash_usd']),
                    ['action' => 'buy', 'token' => $rules['benchmark_mint'], 'bps' => 10000], $fresh, $costs);
            }
            $benchmark ??= $this->ledger->initial($rules['initial_cash_usd']);
            $result = ['actors' => $actors, 'prices' => $prices, 'symbols' => $symbols,
                'benchmark' => ['state' => $benchmark, 'equity' => $this->ledger->equity($benchmark, $prices, $costs)]];
            $now = CarbonImmutable::now('UTC');
            $evidence = ['sequence' => (int) ($previous?->sequence ?? 0) + 1, 'decision_at' => $lockedCycle->decision_at->toIso8601String(),
                'filled_at' => $now->toIso8601String(), 'decisions' => $lockedCycle->record['decisions'], 'board' => $board,
                'automation' => ['slot' => $lockedCycle->slot, 'commit_hash' => $lockedCycle->commit_hash, 'record' => $lockedCycle->record]];
            $hash = $this->manager->digest($evidence);
            $round = $locked->rounds()->create([
                'sequence' => $evidence['sequence'], 'decision_at' => $lockedCycle->decision_at, 'filled_at' => $now,
                'evidence' => $evidence, 'result' => $result, 'payload_hash' => $hash, 'previous_hash' => $previous?->record_hash,
                'record_hash' => $this->manager->digest(['rules_hash' => $locked->rules_hash, 'previous_hash' => $previous?->record_hash,
                    'evidence' => $evidence, 'result' => $result]),
            ]);
            $lockedCycle->update(['status' => 'complete', 'arena_round_id' => $round->id]);
        });

        return 'complete';
    }

    /**
     * The anchors plus every mint any agent (or the benchmark) still holds:
     * a position has to be priced every round, whatever is in view.
     *
     * @param  array<string, mixed>  $rules
     * @return list<string>
     */
    private function held(array $rules, ?ArenaRound $previous): array
    {
        $mints = array_column($rules['anchors'], 'mint');
        foreach ([...array_values($previous?->result['actors'] ?? []), $previous?->result['benchmark'] ?? []] as $actor) {
            array_push($mints, ...array_keys($actor['state']['positions'] ?? []));
        }

        return array_values(array_unique($mints));
    }

    private function skip(ArenaCycle $cycle, string $code): string
    {
        ArenaCycle::query()->whereKey($cycle->id)->where('status', $cycle->status)->update(['status' => 'skipped', 'error_code' => $code]);

        return $code;
    }
}
