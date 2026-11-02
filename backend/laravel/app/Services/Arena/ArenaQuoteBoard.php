<?php

namespace App\Services\Arena;

use Carbon\CarbonImmutable;
use DomainException;
use Illuminate\Support\Facades\Http;

/**
 * USD prices for a multi-token season's universe, one DexScreener call.
 *
 * Each token is priced from its deepest pool whose base token is exactly that
 * mint, and only above a liquidity floor; anything else is absent from the
 * board rather than priced from a pool somebody seeded with a few dollars.
 * This is an index quote, not an on-chain read, and the rules say so.
 */
class ArenaQuoteBoard
{
    /**
     * @param  array<int, array{symbol: string, mint: string}>  $universe
     * @return array{observed_at: string, source: string, prices: array<string, array<string, mixed>>}
     */
    public function read(array $universe, int $minLiquidityUsd): array
    {
        $mints = array_column($universe, 'mint');
        $response = Http::acceptJson()->connectTimeout(3)->timeout(10)
            ->get('https://api.dexscreener.com/tokens/v1/solana/'.implode(',', $mints));
        $pairs = $response->json();
        if (! $response->successful() || ! is_array($pairs) || ! array_is_list($pairs)) {
            throw new DomainException('market_unavailable');
        }
        $prices = [];
        foreach ($universe as $token) {
            $best = null;
            foreach ($pairs as $pair) {
                $liquidity = (float) ($pair['liquidity']['usd'] ?? 0);
                $price = (string) ($pair['priceUsd'] ?? '');
                if (($pair['chainId'] ?? null) !== 'solana' || ($pair['baseToken']['address'] ?? null) !== $token['mint']
                    || $liquidity < $minLiquidityUsd || ! preg_match('/^[0-9]{1,12}(\.[0-9]{1,18})?$/D', $price)
                    || bccomp($price, '0', 18) <= 0) {
                    continue;
                }
                if ($best === null || $liquidity > $best['liquidity_usd']) {
                    $best = ['usd' => $price, 'liquidity_usd' => (int) $liquidity, 'pair' => (string) ($pair['pairAddress'] ?? ''),
                        'dex' => (string) ($pair['dexId'] ?? ''), 'change_h24' => (float) ($pair['priceChange']['h24'] ?? 0)];
                }
            }
            if ($best) {
                $prices[$token['symbol']] = $best;
            }
        }
        if ($prices === []) {
            throw new DomainException('market_unavailable');
        }

        return ['observed_at' => CarbonImmutable::now('UTC')->toIso8601String(),
            'source' => 'DexScreener index quote (deepest Solana pool per mint); not an on-chain read', 'prices' => $prices];
    }
}
