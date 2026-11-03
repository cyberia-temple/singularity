<?php

namespace App\Services\Arena;

use App\Models\ArenaAgent;
use App\Models\ArenaRound;
use App\Models\ArenaSeason;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Throwable;

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
    public function __construct(private ArenaLeague $league, private ArenaQuoteBoard $quotes) {}

    /**
     * Everybody at once: the ranking, every portfolio's value over time on one
     * chart, every trade with the thesis it was made on, and the tokens on the
     * board. Cached briefly — it is read by every visitor and every poll.
     *
     * @return array<string, mixed>
     */
    public function overview(): array
    {
        return Cache::remember('arena.board.overview', 60, fn (): array => $this->build());
    }

    /** @return array<string, mixed> */
    private function build(): array
    {
        $season = $this->season();
        $rounds = $season ? $season->rounds()->orderBy('sequence')->get() : collect();
        $details = [];
        foreach ($season ? array_keys($season->rules['agents']) : [] as $slug) {
            $details[] = $this->house($season, $slug, $rounds);
        }
        $open = collect($this->league->standings())->pluck('slug')->all();
        foreach (ArenaAgent::query()->whereIn('slug', $open)->whereNull('hidden_at')->get() as $agent) {
            $details[] = $this->open($agent);
        }
        $agents = [];
        $feed = [];
        foreach ($details as $detail) {
            $summary = $detail['summary'];
            $total = $summary['valueUsd'] ?? collect($detail['positions'])->sum('valueUsd');
            $held = collect($detail['positions'])->sortByDesc('valueUsd')->take(3)->map(fn (array $row) => ['symbol' => $row['symbol'] ?? substr($row['token'], 0, 4),
                'sharePct' => $total > 0 && $row['valueUsd'] !== null ? round($row['valueUsd'] / $total * 100) : null])->values()->all();
            $trades = collect($detail['moves'])->where('side', '!=', 'hold')->where('refused', false);
            $agents[] = ['slug' => $detail['agent']['slug'], 'name' => $detail['agent']['name'], 'kind' => $detail['agent']['kind'],
                'about' => $detail['agent']['about'], 'valueUsd' => $summary['valueUsd'], 'pnlUsd' => $summary['pnlUsd'],
                'returnPct' => $summary['returnPct'], 'trades' => $summary['trades'], 'lastTradeAt' => $trades->first()['at'] ?? null,
                'holdings' => $held, 'cashPct' => $summary['cashUsd'] !== null && $total > 0 ? round($summary['cashUsd'] / $total * 100) : null];
            foreach ($trades->take(30) as $move) {
                $feed[] = ['agent' => $detail['agent']['slug'], 'name' => $detail['agent']['name'], ...$move];
            }
        }
        usort($agents, fn (array $a, array $b) => [$b['trades'] > 0, $b['pnlUsd']] <=> [$a['trades'] > 0, $a['pnlUsd']]);
        usort($feed, fn (array $a, array $b) => strcmp($b['at'], $a['at']));
        $last = $rounds->last();
        $initial = $season ? (float) $season->rules['initial_cash_usd'] : 0.0;

        return ['season' => $season ? $this->seasonSummary($season, $rounds) : null, 'agents' => $agents,
            'benchmark' => $season && $last && isset($last->result['benchmark']['equity']) ? [
                'symbol' => $season->rules['benchmark'] ?? 'SOL',
                'returnPct' => round(((float) $last->result['benchmark']['equity'] / $initial - 1) * 100, 2),
            ] : null,
            'chart' => ['lines' => collect($details)->where('agent.kind', 'house')->map(fn (array $detail) => ['slug' => $detail['agent']['slug'],
                'name' => $detail['agent']['name'], 'points' => $detail['series']])->values()->all(),
                'benchmark' => $season ? [['at' => $season->starts_at->toIso8601String(), 'value' => $initial],
                    ...$rounds->filter(fn (ArenaRound $round) => isset($round->result['benchmark']['equity']))
                        ->map(fn (ArenaRound $round) => ['at' => $round->filled_at->toIso8601String(), 'value' => round((float) $round->result['benchmark']['equity'], 2)])
                        ->values()->all()] : []],
            'feed' => array_slice($feed, 0, 50),
            'tokens' => $season ? $this->tokens($season) : [],
            'connect' => ['mcp' => url('/api/arena/mcp'), 'register' => url('/api/arena/agents'), 'trades' => url('/api/arena/trades')]];
    }

    /**
     * What the agents can trade right now: the season's anchors first, then
     * the most promoted tokens, priced live from the index. A board that
     * cannot be read is an empty list, never invented prices.
     *
     * @return list<array<string, mixed>>
     */
    private function tokens(ArenaSeason $season): array
    {
        return Cache::remember('arena.board.tokens', 300, function () use ($season): array {
            $anchors = array_column($season->rules['anchors'], 'symbol', 'mint');
            try {
                $board = $this->quotes->read([...array_keys($anchors), ...$this->quotes->candidates((int) $season->rules['candidates']['limit'])],
                    (int) $season->rules['min_liquidity_usd'], $anchors);
            } catch (Throwable) {
                return [];
            }
            $order = array_flip(array_keys($anchors));
            $rows = [];
            foreach ($board['prices'] as $key => $row) {
                $rows[] = ['key' => $key, 'symbol' => $row['symbol'], 'chain' => ArenaQuoteBoard::chain($key),
                    'address' => str_contains($key, ':') ? explode(':', $key, 2)[1] : $key, 'usd' => (float) $row['usd'],
                    'changePct' => $row['change_h24'], 'liquidityUsd' => $row['liquidity_usd'], 'pair' => $row['pair'],
                    'anchor' => isset($order[$key])];
            }
            usort($rows, fn (array $a, array $b) => [$order[$a['key']] ?? 99, -$a['liquidityUsd']] <=> [$order[$b['key']] ?? 99, -$b['liquidityUsd']]);

            return $rows;
        });
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

    /**
     * @param  Collection<int, ArenaRound>|null  $rounds
     * @return array<string, mixed>
     */
    private function house(ArenaSeason $season, string $slug, ?Collection $rounds = null): array
    {
        $rounds ??= $season->rounds()->orderBy('sequence')->get();
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
                'symbol' => $trade['symbol'] ?? null, 'token' => ($key = $trade['token'] ?? ($decision['token'] ?? null)) && str_contains($key, ':') ? explode(':', $key, 2)[1] : $key,
                'chain' => ArenaQuoteBoard::chain((string) ($trade['token'] ?? 'solana')), 'valueUsd' => $trade ? round((float) $trade['value'], 2) : null,
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
            $positions[] = ['symbol' => $symbols[$token] ?? null, 'token' => str_contains($token, ':') ? explode(':', $token, 2)[1] : $token,
                'chain' => ArenaQuoteBoard::chain($token), 'qty' => (float) $position['qty'],
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
