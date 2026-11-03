<?php

namespace App\Services\Arena;

use App\Models\ArenaAgent;
use App\Models\ArenaRound;
use App\Models\ArenaSeason;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;

/**
 * One reading of the arena for every screen that shows it — the wallet and
 * /arena draw the same component from this. The season's own agents (models
 * the arena runs on paper) and the open league (agents that report their own
 * trades) are one list here: a person asks "who is winning", not "which table
 * is this row in". The figures are display numbers; the records that decide
 * them stay in the rounds and the trades.
 */
class ArenaBoard
{
    public function __construct(private ArenaLeague $league) {}

    /** @return array<string, mixed> */
    public function overview(): array
    {
        $season = $this->season();
        $rounds = $season ? $season->rounds()->orderBy('sequence')->get() : collect();
        $last = $rounds->last();
        $agents = [];
        if ($season) {
            $initial = (float) $season->rules['initial_cash_usd'];
            foreach ($season->rules['agents'] as $slug => $agent) {
                $value = (float) ($last?->result['actors'][$slug]['equity'] ?? $initial);
                $trades = $rounds->filter(fn (ArenaRound $round) => ($round->result['actors'][$slug]['trade'] ?? null) !== null);
                $agents[] = ['slug' => $slug, 'name' => $agent['name'], 'kind' => 'house',
                    'about' => $season->rules['automation']['models'][$slug] ?? null,
                    'valueUsd' => round($value, 2), 'pnlUsd' => round($value - $initial, 2),
                    'returnPct' => $initial > 0 ? round(($value - $initial) / $initial * 100, 2) : null,
                    'trades' => $trades->count(), 'lastTradeAt' => $trades->last()?->filled_at->toIso8601String()];
            }
        }
        foreach ($this->league->standings() as $row) {
            $agents[] = ['slug' => $row['slug'], 'name' => $row['name'], 'kind' => 'open', 'about' => $row['framework'],
                'valueUsd' => null, 'pnlUsd' => round((float) $row['realizedUsd'] + (float) $row['unrealizedUsd'], 2),
                'returnPct' => null, 'trades' => $row['trades'], 'lastTradeAt' => $row['lastTradeAt']];
        }
        usort($agents, fn (array $a, array $b) => [$b['trades'] > 0, $b['pnlUsd']] <=> [$a['trades'] > 0, $a['pnlUsd']]);

        return ['season' => $season ? $this->seasonSummary($season, $rounds) : null, 'agents' => $agents,
            'benchmark' => $season && $last && isset($last->result['benchmark']['equity']) ? [
                'symbol' => $season->rules['benchmark'] ?? 'SOL',
                'returnPct' => round(((float) $last->result['benchmark']['equity'] / (float) $season->rules['initial_cash_usd'] - 1) * 100, 2),
            ] : null,
            'connect' => ['mcp' => url('/api/arena/mcp'), 'register' => url('/api/arena/agents'), 'trades' => url('/api/arena/trades')]];
    }

    /** @return array<string, mixed>|null */
    public function agent(string $slug): ?array
    {
        $season = $this->season();
        if ($season && isset($season->rules['agents'][$slug])) {
            return $this->house($season, $slug);
        }
        $agent = ArenaAgent::query()->where('slug', $slug)->whereNull('hidden_at')->first();

        return $agent ? $this->open($agent) : null;
    }

    private function season(): ?ArenaSeason
    {
        $season = ArenaSeason::query()->where('slug', config('arena.slug'))->first();

        return $season && $season->rules['mode'] === 'automatic-multi' ? $season : null;
    }

    /**
     * @param  Collection<int, ArenaRound>  $rounds
     * @return array<string, mixed>
     */
    private function seasonSummary(ArenaSeason $season, Collection $rounds): array
    {
        $now = CarbonImmutable::now('UTC');
        $interval = intdiv(86400, (int) $season->rules['rounds_per_day']);
        $start = CarbonImmutable::parse($season->starts_at);
        $end = CarbonImmutable::parse($season->ends_at);
        $next = $now->lessThan($start) ? $start
            : $start->addSeconds((intdiv($now->getTimestamp() - $start->getTimestamp(), $interval) + 1) * $interval);
        $latest = $season->cycles()->orderByDesc('slot')->first();
        $partner = $season->rules['partner'] ?? null;

        return ['title' => $season->title, 'startsAt' => $start->toIso8601String(), 'endsAt' => $end->toIso8601String(),
            'status' => $now->lessThan($start) ? 'upcoming' : ($now->greaterThanOrEqualTo($end) ? 'ended' : 'live'),
            'nextRoundAt' => $next->lessThan($end) ? $next->toIso8601String() : null,
            'rounds' => $rounds->count(), 'roundsTotal' => (int) $season->rules['days'] * (int) $season->rules['rounds_per_day'],
            'startUsd' => (float) $season->rules['initial_cash_usd'],
            'lastSkipped' => $latest?->status === 'skipped',
            'partner' => is_array($partner) ? ['name' => $partner['name'] ?? null, 'website' => $partner['website'] ?? null,
                'x' => $partner['x'] ?? null, 'telegram' => $partner['telegram'] ?? null, 'chart' => $partner['chart'] ?? null] : null];
    }

    /** @return array<string, mixed> */
    private function house(ArenaSeason $season, string $slug): array
    {
        $rounds = $season->rounds()->orderBy('sequence')->get();
        $initial = (float) $season->rules['initial_cash_usd'];
        $series = [['at' => $season->starts_at->toIso8601String(), 'value' => $initial]];
        $moves = [];
        foreach ($rounds as $round) {
            $actor = $round->result['actors'][$slug] ?? null;
            if (! $actor) {
                continue;
            }
            $series[] = ['at' => $round->filled_at->toIso8601String(), 'value' => round((float) $actor['equity'], 2)];
            $decision = $round->evidence['decisions'][$slug] ?? [];
            $trade = $actor['trade'];
            $moves[] = ['at' => $round->filled_at->toIso8601String(), 'side' => $trade['action'] ?? 'hold',
                'symbol' => $trade['symbol'] ?? null, 'token' => $trade['token'] ?? ($decision['token'] ?? null),
                'chain' => 'solana', 'valueUsd' => $trade ? round((float) $trade['value'], 2) : null,
                'priceUsd' => $trade ? (float) $trade['price'] : null,
                'pnlUsd' => isset($trade['realized']) ? round((float) $trade['realized'], 2) : null,
                'reason' => $decision['reason'] ?? null, 'refused' => $actor['execution'] !== 'accepted', 'paper' => true, 'txUrl' => null];
        }
        $last = $rounds->last();
        $state = $last?->result['actors'][$slug]['state'] ?? ['cash' => (string) $initial, 'positions' => []];
        $prices = $last?->result['prices'] ?? [];
        $symbols = $last?->result['symbols'] ?? [];
        $positions = [];
        foreach ($state['positions'] as $token => $position) {
            $value = isset($prices[$token]) ? (float) $position['qty'] * (float) $prices[$token] : null;
            $positions[] = ['symbol' => $symbols[$token] ?? null, 'token' => $token, 'chain' => 'solana', 'qty' => (float) $position['qty'],
                'valueUsd' => $value !== null ? round($value, 2) : null,
                'pnlUsd' => $value !== null ? round($value - (float) $position['cost'], 2) : null];
        }
        $value = (float) ($last?->result['actors'][$slug]['equity'] ?? $initial);
        $sells = collect($moves)->whereNotNull('pnlUsd');

        return ['agent' => ['slug' => $slug, 'name' => $season->rules['agents'][$slug]['name'], 'kind' => 'house',
            'about' => $season->rules['automation']['models'][$slug] ?? null, 'description' => $season->rules['agents'][$slug]['method'] ?? null,
            'website' => null, 'since' => $season->starts_at->toIso8601String()],
            'summary' => ['valueUsd' => round($value, 2), 'cashUsd' => round((float) $state['cash'], 2), 'pnlUsd' => round($value - $initial, 2),
                'returnPct' => $initial > 0 ? round(($value - $initial) / $initial * 100, 2) : null,
                'trades' => collect($moves)->where('side', '!=', 'hold')->count(), 'wins' => $sells->where('pnlUsd', '>', 0)->count(),
                'closed' => $sells->count(), 'volumeUsd' => round((float) collect($moves)->sum('valueUsd'), 2)],
            'series' => $series, 'seriesKind' => 'value', 'positions' => $positions, 'moves' => array_reverse($moves)];
    }

    /** @return array<string, mixed> */
    private function open(ArenaAgent $agent): array
    {
        $book = $this->league->book($agent);
        $pnl = (float) $book['realized_usd'] + (float) $book['unrealized_usd'];

        return ['agent' => ['slug' => $agent->slug, 'name' => $agent->name, 'kind' => 'open', 'about' => $agent->framework,
            'description' => $agent->description, 'website' => $agent->website, 'since' => $agent->created_at->toIso8601String()],
            'summary' => ['valueUsd' => null, 'cashUsd' => null, 'pnlUsd' => round($pnl, 2), 'returnPct' => null,
                'trades' => $book['counts']['trades'], 'wins' => $book['counts']['wins'], 'closed' => $book['counts']['closed'],
                'volumeUsd' => round((float) $book['volume_usd'], 2)],
            'series' => array_map(fn (array $point) => ['at' => $point['at'], 'value' => round((float) $point['realized_usd'], 2)], $book['series']),
            'seriesKind' => 'pnl',
            'positions' => array_map(fn (array $row) => ['symbol' => $row['symbol'], 'token' => $row['token'], 'chain' => $row['chain'],
                'qty' => (float) $row['qty'], 'valueUsd' => $row['value_usd'] !== null ? round((float) $row['value_usd'], 2) : null,
                'pnlUsd' => $row['unrealized_usd'] !== null ? round((float) $row['unrealized_usd'], 2) : null], $book['positions']),
            'moves' => array_map(fn (array $row) => ['at' => $row['at'], 'side' => $row['side'], 'symbol' => $row['symbol'], 'token' => $row['token'],
                'chain' => $row['chain'], 'valueUsd' => $row['value_usd'] !== null ? round((float) $row['value_usd'], 2) : null,
                'priceUsd' => $row['price_usd'] !== null ? (float) $row['price_usd'] : null,
                'pnlUsd' => $row['pnl_usd'] !== null ? round((float) $row['pnl_usd'], 2) : null,
                'reason' => $row['reason'], 'refused' => false, 'paper' => (bool) $row['paper'], 'txUrl' => $row['tx_url']], $book['trades'])];
    }
}
