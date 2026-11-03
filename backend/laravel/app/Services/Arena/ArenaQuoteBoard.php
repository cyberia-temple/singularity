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
     * A token anywhere on the board: a bare Solana mint, or `chain:0x…` for a
     * token on an EVM chain the index covers (EQUI and LAIN live on Robinhood
     * Chain). Bare mints stay bare so earlier seasons' ledgers read the same.
     */
    public const KEY = '/^(?:[1-9A-HJ-NP-Za-km-z]{32,44}|(?:robinhood|base|ethereum|bsc):0x[0-9a-f]{40})$/D';

    /** The chain a board key is on, as DexScreener names it. */
    public static function chain(string $key): string
    {
        return str_contains($key, ':') ? explode(':', $key, 2)[0] : 'solana';
    }

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
     * @param  list<string>  $mints  board keys (see KEY)
     * @param  array<string, string>  $names  key => symbol to show instead of the pool's own
     * @return array{observed_at: string, source: string, prices: array<string, array<string, mixed>>}
     */
    public function read(array $mints, int $minLiquidityUsd, array $names = []): array
    {
        $mints = array_values(array_unique(array_filter($mints, fn ($mint) => is_string($mint) && preg_match(self::KEY, $mint))));
        $byChain = [];
        foreach ($mints as $key) {
            $byChain[self::chain($key)][str_contains($key, ':') ? explode(':', $key, 2)[1] : $key] = $key;
        }
        $pairs = [];
        foreach ($byChain as $chain => $addresses) {
            foreach (array_chunk(array_keys($addresses), 30) as $chunk) {
                $response = Http::acceptJson()->connectTimeout(3)->timeout(10)
                    ->get("https://api.dexscreener.com/tokens/v1/{$chain}/".implode(',', $chunk));
                $rows = $response->json();
                if (! $response->successful() || ! is_array($rows) || ! array_is_list($rows)) {
                    throw new DomainException('market_unavailable');
                }
                foreach ($rows as $row) {
                    $address = (string) ($row['baseToken']['address'] ?? '');
                    $key = $addresses[$chain === 'solana' ? $address : strtolower($address)] ?? null;
                    if (($row['chainId'] ?? null) === $chain && $key !== null) {
                        $pairs[] = [$key, $row];
                    }
                }
            }
        }
        $prices = [];
        foreach ($pairs as [$mint, $pair]) {
            $liquidity = (float) ($pair['liquidity']['usd'] ?? 0);
            $price = (string) ($pair['priceUsd'] ?? '');
            if ($liquidity < $minLiquidityUsd || ! preg_match('/^[0-9]{1,12}(\.[0-9]{1,18})?$/D', $price)
                || bccomp($price, '0', 18) <= 0) {
                continue;
            }
            if (! isset($prices[$mint]) || $liquidity > $prices[$mint]['liquidity_usd']) {
                $symbol = preg_replace('/[^\p{L}\p{N}$._-]/u', '', (string) ($names[$mint] ?? $pair['baseToken']['symbol'] ?? ''));
                $prices[$mint] = ['symbol' => mb_substr($symbol !== '' ? $symbol : substr($mint, 0, 4), 0, 16), 'usd' => $price,
                    'liquidity_usd' => (int) $liquidity, 'pair' => (string) ($pair['pairAddress'] ?? ''),
                    'dex' => (string) ($pair['dexId'] ?? ''), 'change_h24' => (float) ($pair['priceChange']['h24'] ?? 0)];
            }
        }
        if ($prices === []) {
            throw new DomainException('market_unavailable');
        }

        return ['observed_at' => CarbonImmutable::now('UTC')->toIso8601String(),
            'source' => 'DexScreener index quote (deepest pool per token); not an on-chain read', 'prices' => $prices];
    }
}
