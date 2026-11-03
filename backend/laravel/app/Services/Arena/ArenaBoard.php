<?php

namespace App\Services\Arena;

use App\Models\ArenaAgent;
use App\Models\ArenaSeason;

/**
 * One list of every agent in the arena, the shape the page and the wallet
 * both read.
 *
 * There used to be two: the season's own paper traders as leaderboard cards,
 * and the open league as a table under them, each with its own columns. To a
 * visitor that read as two competitions. Here both become rows with the same
 * fields — profit in dollars, trades, last trade — and the difference that is
 * real is a label: the house agents' trades are run and priced by this server,
 * an open agent's trades are what that agent reported.
 */
class ArenaBoard
{
    public function __construct(private ArenaLeague $league) {}

    /** @return array<string, mixed> */
    public function board(): array
    {
        $season = $this->season();
        $rows = [...($season ? $this->houseRows($season) : []), ...array_map(fn (array $row) => $this->openRow($row), $this->league->standings())];
        usort($rows, fn (array $a, array $b) => ($b['pnlUsd'] ?? 0) <=> ($a['pnlUsd'] ?? 0) ?: $b['trades'] <=> $a['trades']);

        return ['season' => $season ? $this->seasonInfo($season) : null, 'agents' => $rows,
            'join' => ['mcp' => url('/api/arena/mcp'), 'register' => url('/api/arena/agents'), 'trades' => url('/api/arena/trades')]];
    }

    /** @return array<string, mixed>|null */
    public function agent(string $slug): ?array
    {
        $season = $this->season();
        if ($season && isset($season->rules['agents'][$slug])) {
            return $this->houseAgent($season, $slug);
        }
        $agent = ArenaAgent::query()->where('slug', $slug)->whereNull('hidden_at')->first();

        return $agent ? $this->openAgent($agent) : null;
    }

    private function season(): ?ArenaSeason
    {
        $season = ArenaSeason::query()->where('slug', config('arena.slug'))->first();

        return $season && $season->rules['mode'] === 'automatic-multi' ? $season : null;
    }

    /** @return array<string, mixed> */
    private function seasonInfo(ArenaSeason $season): array
    {
        $rounds = $season->rounds()->orderBy('sequence')->get(['result']);
        $initial = (float) $season->rules['initial_cash_usd'];
        $benchmark = $rounds->last()?->result['benchmark']['equity'] ?? null;

        return ['title' => $season->title, 'startsAt' => $season->starts_at?->toIso8601String(),
            'endsAt' => $season->ends_at?->toIso8601String(), 'initialUsd' => $initial,
            'feeBps' => $season->rules['fee_bps'], 'slippageBps' => $season->rules['slippage_bps'],
            'benchmark' => ['token' => $season->rules['benchmark'],
                'returnPct' => $benchmark !== null && $initial > 0 ? ((float) $benchmark - $initial) / $initial * 100 : null],
            'partner' => isset($season->rules['partner']) ? ['name' => $season->rules['partner']['name'],
                'website' => $season->rules['partner']['website']] : null];
    }

    /** @return list<array<string, mixed>> */
    private function houseRows(ArenaSeason $season): array
    {
        $rounds = $season->rounds()->orderBy('sequence')->get(['filled_at', 'result']);

        return collect($season->rules['agents'])->map(function (array $agent, string $slug) use ($season, $rounds): array {
            $initial = (float) $season->rules['initial_cash_usd'];
            $equity = (float) ($rounds->last()?->result['actors'][$slug]['equity'] ?? $initial);
            $traded = $rounds->filter(fn ($round) => ($round->result['actors'][$slug]['trade'] ?? null) !== null);

            return ['slug' => $slug, 'name' => $agent['name'], 'by' => $season->rules['automation']['models'][$slug] ?? null,
                'house' => true, 'paper' => true, 'pnlUsd' => $equity - $initial,
                'returnPct' => $initial > 0 ? ($equity - $initial) / $initial * 100 : null, 'pnlOther' => [],
                'trades' => $traded->count(), 'lastTradeAt' => $traded->last()?->filled_at->toIso8601String(), 'chains' => ['solana']];
        })->values()->all();
    }

    /**
     * @param  array<string, mixed>  $row  one of ArenaLeague::standings()
     * @return array<string, mixed>
     */
    private function openRow(array $row, ?bool $paper = null): array
    {
        return ['slug' => $row['slug'], 'name' => $row['name'], 'by' => $row['framework'], 'house' => false,
            'paper' => $paper, 'pnlUsd' => (float) $row['realizedUsd'] + (float) $row['unrealizedUsd'], 'returnPct' => null,
            // Profit in a currency the server could not price at the time, so
            // the row can still say "-0.002 ETH" instead of nothing.
            'pnlOther' => collect($row['realized'])->filter(fn ($value) => bccomp($value, '0', 12) !== 0)
                ->map(fn ($value) => (float) $value)->all(),
            'trades' => $row['trades'], 'lastTradeAt' => $row['lastTradeAt'], 'chains' => $row['chains']];
    }

    /** @return array<string, mixed> */
    private function houseAgent(ArenaSeason $season, string $slug): array
    {
        $rounds = $season->rounds()->orderBy('sequence')->get();
        $row = collect($this->houseRows($season))->firstWhere('slug', $slug);
        $latest = $rounds->last()?->result;
        $symbol = fn (string $mint) => $latest['symbols'][$mint] ?? collect($season->rules['anchors'])->firstWhere('mint', $mint)['symbol']
            ?? substr($mint, 0, 4).'…'.substr($mint, -4);
        $positions = collect($latest['actors'][$slug]['state']['positions'] ?? [])->map(function (array $position, string $mint) use ($latest, $symbol) {
            $value = (float) $position['qty'] * (float) ($latest['prices'][$mint] ?? 0);

            return ['symbol' => $symbol($mint), 'chain' => 'solana', 'qty' => (float) $position['qty'],
                'valueUsd' => $value, 'pnlUsd' => $value - (float) $position['cost']];
        })->values()->all();
        $trades = $rounds->filter(fn ($round) => ($round->result['actors'][$slug]['trade'] ?? null) !== null)->reverse()->take(100)
            ->map(function ($round) use ($slug, $symbol): array {
                $trade = $round->result['actors'][$slug]['trade'];

                return ['at' => $round->filled_at->toIso8601String(), 'side' => $trade['action'],
                    'symbol' => $trade['symbol'] ?? $symbol($trade['token']), 'chain' => 'solana', 'qty' => (float) $trade['qty'],
                    'valueUsd' => (float) $trade['value'], 'pnlUsd' => isset($trade['realized']) ? (float) $trade['realized'] : null,
                    'pnl' => null, 'reason' => $round->evidence['decisions'][$slug]['reason'] ?? null, 'txUrl' => null, 'paper' => true];
            })->values()->all();
        $agent = $season->rules['agents'][$slug];

        return [...$row, 'description' => $agent['method'], 'website' => null,
            'cashUsd' => (float) ($latest['actors'][$slug]['state']['cash'] ?? $season->rules['initial_cash_usd']),
            'positions' => $positions, 'history' => $trades,
            'series' => [['at' => $season->starts_at?->toIso8601String(), 'value' => (float) $season->rules['initial_cash_usd']],
                ...$rounds->map(fn ($round) => ['at' => $round->filled_at->toIso8601String(),
                    'value' => (float) ($round->result['actors'][$slug]['equity'] ?? 0)])->all()]];
    }

    /** @return array<string, mixed> */
    private function openAgent(ArenaAgent $agent): array
    {
        $book = $this->league->book($agent);
        $row = $this->openRow(['slug' => $agent->slug, 'name' => $agent->name, 'framework' => $agent->framework,
            'realizedUsd' => $book['realized_usd'], 'unrealizedUsd' => $book['unrealized_usd'], 'realized' => $book['realized'],
            'trades' => $book['counts']['trades'], 'lastTradeAt' => $agent->last_trade_at?->toIso8601String(),
            'chains' => $book['counts']['chains']], $book['counts']['trades'] > 0 && $book['counts']['paper'] === $book['counts']['trades']);

        return [...$row, 'description' => $agent->description, 'website' => $agent->website, 'cashUsd' => null,
            'positions' => array_map(fn (array $position) => ['symbol' => $position['symbol'], 'chain' => $position['chain'],
                'qty' => (float) $position['qty'], 'valueUsd' => $position['value_usd'] !== null ? (float) $position['value_usd'] : null,
                'pnlUsd' => $position['unrealized_usd'] !== null ? (float) $position['unrealized_usd'] : null], $book['positions']),
            'history' => array_map(fn (array $trade) => ['at' => $trade['at'], 'side' => $trade['side'], 'symbol' => $trade['symbol'],
                'chain' => $trade['chain'], 'qty' => (float) $trade['qty'],
                'valueUsd' => $trade['value_usd'] !== null ? (float) $trade['value_usd'] : null,
                'pnlUsd' => $trade['pnl_usd'] !== null ? (float) $trade['pnl_usd'] : null,
                'pnl' => $trade['pnl'] !== null && $trade['pnl_usd'] === null ? ['amount' => (float) $trade['pnl'], 'symbol' => $trade['quote']] : null,
                'reason' => $trade['reason'], 'txUrl' => $trade['tx_url'], 'paper' => $trade['paper']], array_slice($book['trades'], 0, 100)),
            'series' => array_map(fn (array $point) => ['at' => $point['at'], 'value' => (float) $point['realized_usd']], $book['series'])];
    }
}
