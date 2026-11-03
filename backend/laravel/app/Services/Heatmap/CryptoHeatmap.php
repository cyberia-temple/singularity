<?php

namespace App\Services\Heatmap;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * The crypto market as a map: the largest coins by market cap from CoinGecko,
 * grouped into sectors by CoinGecko's own categories and coloured by the 24h
 * change.
 *
 * The keyless API allows a handful of calls a minute, so a page view never
 * calls it: `refresh()` runs on the scheduler, asks for the market once and for
 * at most a few categories, and keeps each category's membership for a day.
 * The map is therefore a few minutes old and says when it was taken.
 */
class CryptoHeatmap
{
    private const API = 'https://api.coingecko.com/api/v3/coins/markets';

    private const MAP_KEY = 'heatmap.crypto.map';

    public function refresh(): bool
    {
        $this->refreshCategories();

        try {
            $response = Http::timeout(15)->get(self::API, [
                'vs_currency' => 'usd',
                'order' => 'market_cap_desc',
                'per_page' => 250,
                'page' => 1,
                'price_change_percentage' => '24h',
            ]);
        } catch (Throwable) {
            return false;
        }

        $coins = $response->json();

        if (! $response->successful() || ! is_array($coins) || $coins === []) {
            return false;
        }

        Cache::forever(self::MAP_KEY, $this->build($coins));

        return true;
    }

    /**
     * @return array{generatedAt: string|null, sectors: list<array{key: string, label: string, tiles: list<array<string, mixed>>}>}
     */
    public function map(): array
    {
        return Cache::get(self::MAP_KEY, ['generatedAt' => null, 'sectors' => []]);
    }

    /**
     * @param  list<array<string, mixed>>  $coins
     * @return array{generatedAt: string, sectors: list<array{key: string, label: string, tiles: list<array<string, mixed>>}>}
     */
    public function build(array $coins): array
    {
        $sectors = (array) config('heatmap.crypto.sectors');
        $excluded = [];

        foreach ((array) config('heatmap.crypto.exclude') as $category) {
            $excluded += array_flip($this->members($category));
        }

        $membership = [];

        foreach (array_keys($sectors) as $category) {
            $membership[$category] = array_flip($this->members($category));
        }

        $grouped = [];
        $drawn = 0;

        foreach ($coins as $coin) {
            $id = (string) ($coin['id'] ?? '');
            $cap = $coin['market_cap'] ?? null;

            if ($id === '' || isset($excluded[$id]) || ! is_numeric($cap) || $cap <= 0) {
                continue;
            }

            $sector = 'other';

            foreach ($membership as $category => $members) {
                if (isset($members[$id])) {
                    $sector = $category;

                    break;
                }
            }

            $change = $coin['price_change_percentage_24h'] ?? null;
            $grouped[$sector][] = [
                'symbol' => strtoupper((string) ($coin['symbol'] ?? $id)),
                'name' => (string) ($coin['name'] ?? $id),
                'address' => $id,
                'marketCap' => (float) $cap,
                'change' => is_numeric($change) ? (float) $change : null,
                'url' => "https://www.coingecko.com/en/coins/{$id}",
            ];

            if (++$drawn >= (int) config('heatmap.crypto.limit', 120)) {
                break;
            }
        }

        $result = [];

        foreach ([...array_keys($sectors), 'other'] as $key) {
            if (isset($grouped[$key])) {
                $result[] = ['key' => $key, 'label' => $sectors[$key] ?? 'Other', 'tiles' => $grouped[$key]];
            }
        }

        return ['generatedAt' => now()->toIso8601String(), 'sectors' => $result];
    }

    /**
     * Fetch the categories whose membership is missing or a day old, a few per
     * run, exclusions first.
     */
    private function refreshCategories(): void
    {
        $budget = (int) config('heatmap.crypto.categories_per_run', 3);
        $all = [...(array) config('heatmap.crypto.exclude'), ...array_keys((array) config('heatmap.crypto.sectors'))];

        foreach ($all as $category) {
            if ($budget <= 0) {
                return;
            }

            if (Cache::has("heatmap.crypto.fresh.{$category}")) {
                continue;
            }

            $budget--;

            try {
                $response = Http::timeout(15)->get(self::API, [
                    'vs_currency' => 'usd',
                    'category' => $category,
                    'order' => 'market_cap_desc',
                    'per_page' => 250,
                    'page' => 1,
                ]);
            } catch (Throwable) {
                continue;
            }

            $coins = $response->json();

            if ($response->successful() && is_array($coins)) {
                Cache::forever("heatmap.crypto.category.{$category}", array_values(array_filter(array_column($coins, 'id'), 'is_string')));
                Cache::put("heatmap.crypto.fresh.{$category}", true, now()->addDay());
            }
        }
    }

    /** @return list<string> */
    private function members(string $category): array
    {
        return Cache::get("heatmap.crypto.category.{$category}", []);
    }
}
