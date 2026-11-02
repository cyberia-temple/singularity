<?php

namespace App\Services\Arena;

use Carbon\CarbonImmutable;
use DomainException;
use Illuminate\Support\Facades\Http;
use Throwable;

/**
 * USD prices for Solana tokens, read from DexScreener.
 *
 * A season has no fixed list: an agent may name any mint. Each mint is priced
 * from its deepest pool whose base token is exactly that mint, and only above
 * a liquidity floor; anything else is absent from the board (and cannot be
 * traded) rather than priced from a pool somebody seeded with a few dollars.
 * This is an index quote, not an on-chain read, and the rules say so.
 */
class ArenaQuoteBoard
{
    public const MINT = '/^[1-9A-HJ-NP-Za-km-z]{32,44}$/D';

    /**
     * Mints worth putting in front of an agent this round: the Solana tokens
     * DexScreener currently promotes most. That ranking is paid promotion,
     * which the rules say; it is a list of what is in view, not a pick.
     *
     * @return list<string>
     */
    public function candidates(int $limit): array
    {
        try {
            $rows = Http::acceptJson()->connectTimeout(3)->timeout(8)
                ->get('https://api.dexscreener.com/token-boosts/top/v1')->json();
        } catch (Throwable) {
            return [];
        }
        $mints = [];
        foreach (is_array($rows) && array_is_list($rows) ? $rows : [] as $row) {
            $mint = (string) ($row['tokenAddress'] ?? '');
            if (($row['chainId'] ?? null) === 'solana' && preg_match(self::MINT, $mint) && ! in_array($mint, $mints, true)) {
                $mints[] = $mint;
            }
            if (count($mints) >= $limit) {
                break;
            }
        }

        return $mints;
    }

    /**
     * @param  list<string>  $mints
     * @return array{observed_at: string, source: string, prices: array<string, array<string, mixed>>}
     */
    public function read(array $mints, int $minLiquidityUsd): array
    {
        $mints = array_values(array_unique(array_filter($mints, fn ($mint) => is_string($mint) && preg_match(self::MINT, $mint))));
        $pairs = [];
        foreach (array_chunk($mints, 30) as $chunk) {
            $response = Http::acceptJson()->connectTimeout(3)->timeout(10)
                ->get('https://api.dexscreener.com/tokens/v1/solana/'.implode(',', $chunk));
            $rows = $response->json();
            if (! $response->successful() || ! is_array($rows) || ! array_is_list($rows)) {
                throw new DomainException('market_unavailable');
            }
            array_push($pairs, ...$rows);
        }
        $prices = [];
        foreach ($pairs as $pair) {
            $mint = (string) ($pair['baseToken']['address'] ?? '');
            $liquidity = (float) ($pair['liquidity']['usd'] ?? 0);
            $price = (string) ($pair['priceUsd'] ?? '');
            if (($pair['chainId'] ?? null) !== 'solana' || ! in_array($mint, $mints, true)
                || $liquidity < $minLiquidityUsd || ! preg_match('/^[0-9]{1,12}(\.[0-9]{1,18})?$/D', $price)
                || bccomp($price, '0', 18) <= 0) {
                continue;
            }
            if (! isset($prices[$mint]) || $liquidity > $prices[$mint]['liquidity_usd']) {
                $symbol = preg_replace('/[^\p{L}\p{N}$._-]/u', '', (string) ($pair['baseToken']['symbol'] ?? ''));
                $prices[$mint] = ['symbol' => mb_substr($symbol !== '' ? $symbol : substr($mint, 0, 4), 0, 16), 'usd' => $price,
                    'liquidity_usd' => (int) $liquidity, 'pair' => (string) ($pair['pairAddress'] ?? ''),
                    'dex' => (string) ($pair['dexId'] ?? ''), 'change_h24' => (float) ($pair['priceChange']['h24'] ?? 0)];
            }
        }
        if ($prices === []) {
            throw new DomainException('market_unavailable');
        }

        return ['observed_at' => CarbonImmutable::now('UTC')->toIso8601String(),
            'source' => 'DexScreener index quote (deepest Solana pool per mint); not an on-chain read', 'prices' => $prices];
    }
}
