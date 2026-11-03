<?php

namespace App\Services\Arena;

use App\Models\ArenaCycle;
use App\Models\ArenaRound;
use App\Models\ArenaSeason;
use Carbon\CarbonImmutable;
use DomainException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;

class ArenaSeasonManager
{
    public function __construct(private PaperLedger $ledger) {}

    /** @return array<string, mixed> */
    public function rules(bool $automatic = false): array
    {
        $market = (array) config('arena.markets.'.config('arena.market'), []);
        if (! isset($market['name'], $market['cash'], $market['asset'], $market['lot'])) {
            throw new DomainException('Unknown arena market.');
        }
        $rules = [
            'version' => 1,
            'mode' => 'imported-paper',
            'market' => $market['name'],
            'days' => (int) config('arena.days'),
            'rounds_per_day' => (int) config('arena.rounds_per_day'),
            'initial_cash_micros' => (string) ($market['initial_cash_micros'] ?? config('arena.initial_cash_micros')),
            'fee_bps' => (int) ($market['fee_bps'] ?? config('arena.fee_bps')),
            'slippage_bps' => (int) ($market['slippage_bps'] ?? config('arena.slippage_bps')),
            'gas_micros' => (string) ($market['gas_micros'] ?? config('arena.gas_micros')),
            'agents' => config('arena.agents'),
        ];
        // Seasons frozen before markets were configurable carry no units and
        // render as WETH/USDC; adding the key only for other markets keeps
        // their rules hash identical.
        if (config('arena.market') !== 'base-weth-usdc') {
            $rules['units'] = ['cash' => $market['cash'], 'asset' => $market['asset'], 'lot' => (int) $market['lot']];
        }
        $partner = config('arena.partner');
        if (is_string($partner) && $partner !== '') {
            $details = config('arena.partners.'.$partner);
            if (! is_array($details)) {
                throw new DomainException('Unknown arena partner.');
            }
            $rules['partner'] = ['slug' => $partner, ...$details];
        }
        if ($automatic) {
            $settings = config('arena.automation');
            ArenaModelClient::assertFreeOnly($settings);
            $limits = ['budget_cents' => 0, 'reservation_cents_per_call' => 0, 'max_calls' => 112,
                'max_prompt_bytes' => 12000, 'max_output_tokens' => 400, 'max_price_per_million' => 0,
                'timeout_seconds' => 20, 'opening_window_seconds' => 90, 'decision_window_seconds' => 180,
                'fill_delay_seconds' => 60, 'fill_window_seconds' => 180, 'max_block_age_seconds' => 90];
            foreach ($limits as $key => $maximum) {
                if (! is_int($settings[$key]) || $settings[$key] < ($maximum === 0 ? 0 : 1) || $settings[$key] > $maximum) {
                    throw new DomainException('Automatic season limits exceed the pilot allowance.');
                }
            }
            if ($settings['fill_delay_seconds'] !== 60
                || $settings['decision_window_seconds'] !== 180 || $settings['opening_window_seconds'] > 90
                || $rules['rounds_per_day'] !== 4 || $rules['days'] < 1 || $rules['days'] > 14) {
                throw new DomainException('Automatic seasons require the bounded pilot schedule and reservations.');
            }
            $rules['version'] = 2;
            $rules['mode'] = 'automatic-paper';
            $rules['automation'] = [...array_intersect_key($settings, $limits),
                'pricing_policy' => 'free-only',
                'models' => $settings['models'], 'prompt' => ArenaModelClient::prompt($rules['units'] ?? null),
                'market_source' => app(ArenaMarketFeed::class)->specification(),
                'runtime' => 'Isolated, tool-free paper personas; not the privileged LainOS daemon'];
        }

        return $rules;
    }

    public function create(string $slug, ?CarbonImmutable $start = null, bool $automatic = false): ArenaSeason
    {
        $rules = $this->rules($automatic);
        $season = ArenaSeason::query()->firstOrCreate(['slug' => $slug], [
            'title' => $rules['partner']['title'] ?? 'Season Zero',
            'starts_at' => $start,
            'ends_at' => $start?->addDays($rules['days']),
            'rules' => $rules,
            'rules_hash' => $this->digest($rules),
        ]);
        if ($season->rules['mode'] !== $rules['mode']) {
            throw new DomainException('A frozen season cannot switch modes. Use a new season slug.');
        }
        if ($start) {
            return DB::transaction(function () use ($season, $start) {
                $locked = ArenaSeason::query()->lockForUpdate()->findOrFail($season->id);
                if ($locked->starts_at && ! $locked->starts_at->equalTo($start)) {
                    throw new DomainException('An existing season start cannot be changed.');
                }
                if (! $locked->starts_at) {
                    $locked->update(['starts_at' => $start, 'ends_at' => $start->addDays($locked->rules['days'])]);
                }

                return $locked;
            });
        }

        return $season;
    }

    /** @param array<string, mixed> $payload */
    public function import(ArenaSeason $season, array $payload, CarbonImmutable $now, ?ArenaCycle $cycle = null, ?array $fillQuote = null): ArenaRound
    {
        if ($season->rules['mode'] === 'automatic-paper'
            && (! $cycle || $cycle->arena_season_id !== $season->id || $cycle->status !== 'awaiting_fill'
                || $cycle->commit_hash !== $this->digest($cycle->record))) {
            throw new DomainException('Automatic rounds require an intact committed decision cycle.');
        }
        $data = Validator::make($payload, [
            'sequence' => ['required', 'integer', 'min:1'],
            'decision_at' => ['required', 'date'],
            'filled_at' => ['required', 'date', 'after:decision_at'],
            'price_micros' => ['required', 'string', 'regex:/^[1-9][0-9]{0,19}$/D'],
            'source' => ['required', 'array:chain_id,block_number,block_hash,label'],
            'source.chain_id' => ['required', 'integer', 'min:1'],
            'source.block_number' => ['required', 'string', 'regex:/^[1-9][0-9]{0,19}$/D'],
            'source.block_hash' => ['required', 'string', 'regex:/^(0x[a-fA-F0-9]{64}|[1-9A-HJ-NP-Za-km-z]{32,44})$/D'],
            'source.label' => ['required', 'string', 'max:100'],
            'decisions' => ['required', 'array:lain,challenger'],
            'decisions.lain' => ['required', 'array:action,bps,reason,model'],
            'decisions.challenger' => ['required', 'array:action,bps,reason,model'],
            'decisions.*.action' => ['required', Rule::in(['hold', 'buy', 'sell'])],
            'decisions.*.bps' => ['required', 'integer', Rule::in([0, 2500, 5000, 10000])],
            'decisions.*.reason' => ['required', 'string', 'max:1200'],
            'decisions.*.model' => ['required', 'string', 'max:100'],
        ])->validated();
        $data['sequence'] = (int) $data['sequence'];
        $data['source']['chain_id'] = (int) $data['source']['chain_id'];
        foreach (['lain', 'challenger'] as $actor) {
            $data['decisions'][$actor]['bps'] = (int) $data['decisions'][$actor]['bps'];
        }
        $decisionAt = CarbonImmutable::parse($data['decision_at'])->utc();
        $filledAt = CarbonImmutable::parse($data['filled_at'])->utc();
        if (! $season->starts_at || $decisionAt->lessThan($season->starts_at)
            || $filledAt->greaterThan($season->ends_at) || $filledAt->greaterThan($now)
            || $filledAt->lessThan($decisionAt->addSeconds(60))) {
            throw new DomainException('Round timestamps fall outside the season or its forward-fill rule.');
        }
        $data['decision_at'] = $decisionAt->toIso8601String();
        $data['filled_at'] = $filledAt->toIso8601String();
        if ($cycle) {
            if (! $decisionAt->equalTo($cycle->decision_at)
                || CarbonImmutable::parse($cycle->record['committed_at'])->greaterThanOrEqualTo($decisionAt)
                || CarbonImmutable::parse($cycle->record['observation']['observed_at'])->greaterThan(CarbonImmutable::parse($cycle->record['committed_at']))
                || $filledAt->lessThan($cycle->fill_due_at)
                || $this->digest($data['decisions']) !== $this->digest($cycle->record['decisions'])) {
                throw new DomainException('Committed decisions cannot change at execution.');
            }
            if (! $fillQuote || $fillQuote['price_micros'] !== $data['price_micros']
                || CarbonImmutable::parse($fillQuote['block_at'])->lessThan($cycle->fill_due_at)
                || $this->digest($fillQuote['source']) !== $this->digest($data['source'])) {
                throw new DomainException('Automatic execution requires matching market evidence.');
            }
            $data['automation'] = ['slot' => $cycle->slot, 'commit_hash' => $cycle->commit_hash, 'record' => $cycle->record, 'fill_quote' => $fillQuote];
        }

        return DB::transaction(function () use ($season, $data, $decisionAt, $filledAt, $cycle) {
            $locked = ArenaSeason::query()->lockForUpdate()->findOrFail($season->id);
            if ($locked->rules_hash !== $this->digest($locked->rules)) {
                throw new DomainException('Frozen season rules were changed.');
            }
            if ($data['sequence'] > $locked->rules['days'] * $locked->rules['rounds_per_day']) {
                throw new DomainException('Season round allowance exhausted.');
            }
            $hash = $this->digest($data);
            $existing = $locked->rounds()->where('sequence', $data['sequence'])->first();
            if ($existing) {
                if ($existing->payload_hash !== $hash) {
                    throw new DomainException('An accepted round cannot be replaced.');
                }

                return $existing;
            }
            $previous = $locked->rounds()->orderByDesc('sequence')->first();
            if ($data['sequence'] !== ($previous?->sequence ?? 0) + 1
                || ($previous && $decisionAt->lessThanOrEqualTo($previous->filled_at))) {
                throw new DomainException('Rounds must be sequential and cannot reuse earlier market time.');
            }
            if ($locked->rounds()->whereDate('decision_at', $decisionAt->toDateString())->count() >= $locked->rules['rounds_per_day']) {
                throw new DomainException('Daily round allowance exhausted.');
            }
            $price = $data['price_micros'];
            $rules = $locked->rules;
            $initial = ['cash' => $rules['initial_cash_micros'], 'asset' => '0'];
            $actors = [];
            foreach (array_keys($rules['agents']) as $actor) {
                $balance = $previous?->result['actors'][$actor]['balance'] ?? $initial;
                try {
                    $next = $this->ledger->apply($balance, $data['decisions'][$actor], $price, $rules);
                    $execution = 'accepted';
                } catch (DomainException $exception) {
                    if (! $cycle) {
                        throw $exception;
                    }
                    $next = $balance;
                    $execution = 'rejected';
                }
                $actors[$actor] = ['balance' => $next, 'equity' => $this->ledger->equity($next, $price, $rules)];
                if ($cycle) {
                    $actors[$actor]['execution'] = $execution;
                }
            }
            $benchmark = $previous?->result['benchmark']['balance']
                ?? $this->ledger->apply($initial, ['action' => 'buy', 'bps' => 10000], $price, $rules);
            $result = [
                'actors' => $actors,
                'benchmark' => ['balance' => $benchmark, 'equity' => $this->ledger->equity($benchmark, $price, $rules)],
                'cash_equity' => $rules['initial_cash_micros'],
            ];
            $previousHash = $previous?->record_hash;
            $recordHash = $this->digest(['rules_hash' => $locked->rules_hash, 'previous_hash' => $previousHash, 'evidence' => $data, 'result' => $result]);

            return $locked->rounds()->create([
                'sequence' => $data['sequence'], 'decision_at' => $decisionAt, 'filled_at' => $filledAt,
                'evidence' => $data, 'result' => $result, 'payload_hash' => $hash,
                'previous_hash' => $previousHash, 'record_hash' => $recordHash,
            ]);
        });
    }

    /** @param array<mixed> $value */
    public function digest(array $value): string
    {
        return hash('sha256', json_encode($this->canonical($value), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    }

    /** @param array<mixed> $value
     * @return array<mixed>
     */
    private function canonical(array $value): array
    {
        if (! array_is_list($value)) {
            ksort($value);
        }
        foreach ($value as $key => $entry) {
            if (is_array($entry)) {
                $value[$key] = $this->canonical($entry);
            }
        }

        return $value;
    }
}
