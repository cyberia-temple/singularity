<?php

namespace App\Services\Arena;

use App\Models\ArenaAgent;
use App\Models\ArenaTrade;
use App\Services\WalletPriceService;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use Throwable;

/**
 * The open league: any agent registers, gets a key, and reports its own
 * trades. Nothing here verifies that a trade happened — a record is what the
 * agent says it did, a transaction hash is a link anyone can follow, and the
 * page says so. What the server does own is the arithmetic: positions, the
 * moving-average cost basis and realized P&L are recomputed from the trades
 * on every read, the same way for every agent.
 */
class ArenaLeague
{
    public const SCALE = 18;

    /** Chain slug => [native coin, explorer tx url, DexScreener slug]. */
    public const CHAINS = [
        'solana' => ['SOL', 'https://solscan.io/tx/', 'solana'],
        'cyberia' => ['CYBER', 'https://explorer.cyberia.church/tx/', null],
        'robinhood' => ['ETH', 'https://robinhoodchain.blockscout.com/tx/', 'robinhood'],
        'base' => ['ETH', 'https://basescan.org/tx/', 'base'],
        'bnb' => ['BNB', 'https://bscscan.com/tx/', 'bsc'],
        'ethereum' => ['ETH', 'https://etherscan.io/tx/', 'ethereum'],
    ];

    private const ALIASES = ['49406' => 'cyberia', '4663' => 'robinhood', '8453' => 'base', '56' => 'bnb', 'bsc' => 'bnb',
        '1' => 'ethereum', 'eth' => 'ethereum', 'sol' => 'solana'];

    private const STABLES = ['USD', 'USDC', 'USDT', 'USDS', 'DAI', 'USDC.E', 'USDBC'];

    /** Slugs the house agents and the arena's own pages already use. */
    public const RESERVED = ['lain', 'challenger', 'register', 'trades', 'api', 'admin', 'house', 'cyberia'];

    public function __construct(private WalletPriceService $prices) {}

    public static function chain(string $chain): ?string
    {
        $chain = strtolower(trim($chain));
        $chain = self::ALIASES[$chain] ?? $chain;

        return isset(self::CHAINS[$chain]) ? $chain : null;
    }

    /**
     * @param  array{name: string, framework?: ?string, description?: ?string, website?: ?string, owner_address?: ?string, slug?: ?string}  $fields
     * @return array{0: ArenaAgent, 1: string}
     */
    public function register(array $fields): array
    {
        $base = Str::limit(Str::slug($fields['slug'] ?? $fields['name']), 32, '') ?: 'agent';
        $slug = $base;
        for ($n = 2; in_array($slug, self::RESERVED, true) || ArenaAgent::query()->where('slug', $slug)->exists(); $n++) {
            $slug = $base.'-'.$n;
        }
        $key = 'arena_'.Str::random(40);
        $agent = ArenaAgent::query()->create(['slug' => $slug, 'name' => $fields['name'],
            'framework' => $fields['framework'] ?? null, 'description' => $fields['description'] ?? null,
            'website' => $fields['website'] ?? null, 'owner_address' => $fields['owner_address'] ?? null,
            'key_hash' => hash('sha256', $key), 'key_prefix' => substr($key, 0, 12)]);

        return [$agent, $key];
    }

    public function agentForKey(?string $key): ?ArenaAgent
    {
        return $key && str_starts_with($key, 'arena_')
            ? ArenaAgent::query()->where('key_hash', hash('sha256', $key))->whereNull('hidden_at')->first()
            : null;
    }

    /**
     * Writes validated trades; a repeated id is the same trade and is ignored.
     *
     * @param  list<array<string, mixed>>  $trades
     * @return array{accepted: int, duplicates: int}
     */
    public function record(ArenaAgent $agent, array $trades): array
    {
        $native = $this->prices->quotes()['prices'] ?? [];
        $now = CarbonImmutable::now('UTC');
        $rows = [];
        foreach ($trades as $trade) {
            $chain = self::chain((string) $trade['chain']);
            $at = $this->time($trade['at'] ?? null) ?? $now;
            $quote = strtoupper((string) $trade['quote']['symbol']);
            $amount = $this->decimal($trade['quote']);
            $qty = $this->decimal($trade);
            // USD is fixed at the time of recording, so a backfilled trade
            // older than a few hours gets none rather than today's price.
            $usd = match (true) {
                in_array($quote, self::STABLES, true) => $amount,
                $quote === self::CHAINS[$chain][0] && $at->greaterThan($now->subHours(6))
                    && is_numeric($native[$chain === 'ethereum' ? 'base' : $chain] ?? null) => bcmul($amount, (string) $native[$chain === 'ethereum' ? 'base' : $chain], self::SCALE),
                default => null,
            };
            $rows[] = ['arena_agent_id' => $agent->id, 'external_id' => (string) $trade['id'], 'side' => $trade['side'],
                'chain' => $chain, 'token' => $chain === 'solana' ? (string) $trade['token'] : strtolower((string) $trade['token']),
                'symbol' => mb_substr((string) $trade['symbol'], 0, 24), 'qty' => $qty, 'quote_symbol' => mb_substr($quote, 0, 12),
                'quote_amount' => $amount, 'value_usd' => $usd,
                'price_usd' => $usd !== null && bccomp($qty, '0', self::SCALE) > 0 ? bcdiv($usd, $qty, self::SCALE) : null,
                'realized' => isset($trade['realized']) ? $this->decimal(['qty' => $trade['realized']]) : null,
                'tx_hash' => $trade['tx'] ?? null, 'paper' => (bool) ($trade['paper'] ?? false),
                'reason' => isset($trade['reason']) ? mb_substr((string) $trade['reason'], 0, 600) : null,
                'traded_at' => $at, 'created_at' => $now, 'updated_at' => $now];
        }
        $accepted = 0;
        foreach (array_chunk($rows, 50) as $chunk) {
            $accepted += ArenaTrade::query()->insertOrIgnore($chunk);
        }
        if ($accepted > 0) {
            $agent->update(['last_trade_at' => ArenaTrade::query()->where('arena_agent_id', $agent->id)->max('traded_at')]);
            Cache::forget("arena.league.book.{$agent->id}");
            Cache::forget('arena.league.standings');
        }

        return ['accepted' => $accepted, 'duplicates' => count($rows) - $accepted];
    }

    /**
     * One agent's whole record, recomputed from its trades: positions with a
     * moving-average basis, realized P&L per quote currency (and in USD where
     * both legs were priced), a running series for the chart, and the open
     * positions valued at the current index price.
     *
     * @return array<string, mixed>
     */
    public function book(ArenaAgent $agent): array
    {
        return Cache::remember("arena.league.book.{$agent->id}", 60, function () use ($agent): array {
            $trades = $agent->trades()->orderBy('traded_at')->orderBy('id')->limit(20000)->get();
            $positions = [];
            $realized = [];
            $realizedUsd = '0';
            $volumeUsd = '0';
            $series = [];
            $log = [];
            foreach ($trades as $trade) {
                $key = $trade->chain.':'.$trade->token;
                $position = $positions[$key] ?? ['chain' => $trade->chain, 'token' => $trade->token, 'symbol' => $trade->symbol,
                    'quote' => $trade->quote_symbol, 'qty' => '0', 'cost' => '0', 'cost_usd' => '0', 'usd_known' => true, 'paper' => $trade->paper];
                $pnl = null;
                $pnlUsd = null;
                if ($trade->side === 'buy') {
                    $position['qty'] = bcadd($position['qty'], $trade->qty, self::SCALE);
                    $position['cost'] = bcadd($position['cost'], $trade->quote_amount, self::SCALE);
                    $position['usd_known'] = $position['usd_known'] && $trade->value_usd !== null;
                    $position['cost_usd'] = bcadd($position['cost_usd'], $trade->value_usd ?? '0', self::SCALE);
                } elseif (bccomp($position['qty'], '0', self::SCALE) > 0) {
                    $fraction = bccomp($trade->qty, $position['qty'], self::SCALE) >= 0 ? '1' : bcdiv($trade->qty, $position['qty'], self::SCALE);
                    $basis = bcmul($position['cost'], $fraction, self::SCALE);
                    $basisUsd = bcmul($position['cost_usd'], $fraction, self::SCALE);
                    $pnl = bcsub($trade->quote_amount, $basis, self::SCALE);
                    if ($position['usd_known'] && $trade->value_usd !== null) {
                        $pnlUsd = bcsub($trade->value_usd, $basisUsd, self::SCALE);
                    }
                    $position['qty'] = bcsub($position['qty'], bcmul($position['qty'], $fraction, self::SCALE), self::SCALE);
                    $position['cost'] = bcsub($position['cost'], $basis, self::SCALE);
                    $position['cost_usd'] = bcsub($position['cost_usd'], $basisUsd, self::SCALE);
                } else {
                    // A sell with no recorded buy: the basis is unknown, so the
                    // agent's own figure is shown and the server adds nothing.
                    $pnl = $trade->realized;
                }
                $positions[$key] = $position;
                if ($pnl !== null) {
                    $realized[$trade->quote_symbol] = bcadd($realized[$trade->quote_symbol] ?? '0', $pnl, self::SCALE);
                }
                if ($pnlUsd !== null) {
                    $realizedUsd = bcadd($realizedUsd, $pnlUsd, self::SCALE);
                }
                $volumeUsd = bcadd($volumeUsd, $trade->value_usd ?? '0', self::SCALE);
                $series[] = ['at' => $trade->traded_at->toIso8601String(), 'realized' => $realized, 'realized_usd' => $realizedUsd, 'volume_usd' => $volumeUsd];
                $log[] = ['id' => $trade->external_id, 'side' => $trade->side, 'chain' => $trade->chain, 'token' => $trade->token,
                    'symbol' => $trade->symbol, 'qty' => $trade->qty, 'quote' => $trade->quote_symbol, 'amount' => $trade->quote_amount,
                    'price_usd' => $trade->price_usd, 'value_usd' => $trade->value_usd, 'pnl' => $pnl, 'pnl_usd' => $pnlUsd,
                    'tx' => $trade->tx_hash, 'tx_url' => $trade->tx_hash && ! $trade->paper && self::CHAINS[$trade->chain][1]
                        && ! str_contains($trade->tx_hash, '/') ? self::CHAINS[$trade->chain][1].$trade->tx_hash : null,
                    'paper' => $trade->paper, 'reason' => $trade->reason, 'at' => $trade->traded_at->toIso8601String()];
            }
            $open = array_values(array_filter($positions, fn ($row) => bccomp($row['qty'], '0', 12) > 0));
            $marks = $this->marks($open);
            $open = array_map(function (array $row) use ($marks): array {
                $mark = $marks[$row['chain'].':'.$row['token']] ?? null;
                $value = $mark !== null ? bcmul($row['qty'], $mark, self::SCALE) : null;

                return [...$row, 'mark_usd' => $mark, 'value_usd' => $value,
                    'unrealized_usd' => $value !== null && $row['usd_known'] ? bcsub($value, $row['cost_usd'], self::SCALE) : null];
            }, $open);
            $sells = $trades->where('side', 'sell');
            $closed = collect($log)->whereNotNull('pnl');

            return [
                'positions' => $open, 'realized' => $realized, 'realized_usd' => $realizedUsd, 'volume_usd' => $volumeUsd,
                'unrealized_usd' => collect($open)->whereNotNull('unrealized_usd')->reduce(fn ($sum, $row) => bcadd($sum, $row['unrealized_usd'], self::SCALE), '0'),
                'open_value_usd' => collect($open)->whereNotNull('value_usd')->reduce(fn ($sum, $row) => bcadd($sum, $row['value_usd'], self::SCALE), '0'),
                'counts' => ['trades' => $trades->count(), 'buys' => $trades->count() - $sells->count(), 'sells' => $sells->count(),
                    'wins' => $closed->filter(fn ($row) => bccomp($row['pnl'], '0', self::SCALE) > 0)->count(), 'closed' => $closed->count(),
                    'paper' => $trades->where('paper', true)->count(), 'tokens' => count($positions),
                    'chains' => $trades->pluck('chain')->unique()->values()->all()],
                'series' => $this->thin($series, 400),
                'trades' => array_reverse(array_slice($log, -300)),
                'first_at' => $trades->first()?->traded_at->toIso8601String(),
                'priced_at' => CarbonImmutable::now('UTC')->toIso8601String(),
            ];
        });
    }

    /** @return list<array<string, mixed>> */
    public function standings(): array
    {
        return Cache::remember('arena.league.standings', 60, fn (): array => ArenaAgent::query()->whereNull('hidden_at')
            ->whereNotNull('last_trade_at')->orderByDesc('last_trade_at')->limit(50)->get()
            ->map(function (ArenaAgent $agent): array {
                $book = $this->book($agent);

                return ['slug' => $agent->slug, 'name' => $agent->name, 'framework' => $agent->framework,
                    'lastTradeAt' => $agent->last_trade_at?->toIso8601String(), 'trades' => $book['counts']['trades'],
                    'chains' => $book['counts']['chains'], 'realized' => $book['realized'], 'realizedUsd' => $book['realized_usd'],
                    'unrealizedUsd' => $book['unrealized_usd'], 'volumeUsd' => $book['volume_usd'], 'positions' => count($book['positions'])];
            })->all());
    }

    /**
     * Current USD per whole token for open positions: Cyberia's own pool
     * graph where it prices the token, DexScreener's deepest pool elsewhere.
     *
     * @param  list<array<string, mixed>>  $positions
     * @return array<string, string>
     */
    private function marks(array $positions): array
    {
        $marks = [];
        $tokens = $this->prices->quotes()['tokens'] ?? [];
        $ask = [];
        foreach ($positions as $row) {
            $local = $tokens[$row['chain']][strtolower($row['token'])] ?? null;
            if (is_numeric($local) && $local > 0) {
                $marks[$row['chain'].':'.$row['token']] = number_format((float) $local, 12, '.', '');
            } elseif (self::CHAINS[$row['chain']][2]) {
                $ask[self::CHAINS[$row['chain']][2]][$row['token']] = $row['chain'];
            }
        }
        foreach ($ask as $slug => $byToken) {
            foreach (array_chunk(array_keys($byToken), 30) as $chunk) {
                $pairs = Cache::remember('arena.league.marks.'.$slug.'.'.md5(implode(',', $chunk)), 120, function () use ($slug, $chunk): array {
                    try {
                        $rows = Http::acceptJson()->connectTimeout(3)->timeout(8)
                            ->get("https://api.dexscreener.com/tokens/v1/{$slug}/".implode(',', $chunk))->json();
                    } catch (Throwable) {
                        return [];
                    }

                    return is_array($rows) && array_is_list($rows) ? $rows : [];
                });
                $depth = [];
                foreach ($pairs as $pair) {
                    $token = (string) ($pair['baseToken']['address'] ?? '');
                    $match = collect($chunk)->first(fn ($candidate) => strcasecmp($candidate, $token) === 0);
                    $liquidity = (float) ($pair['liquidity']['usd'] ?? 0);
                    if ($match === null || ! is_numeric($pair['priceUsd'] ?? null) || $liquidity < 1000 || $liquidity <= ($depth[$match] ?? 0)) {
                        continue;
                    }
                    $depth[$match] = $liquidity;
                    $marks[$byToken[$match].':'.$match] = (string) $pair['priceUsd'];
                }
            }
        }

        return $marks;
    }

    /** @param array<string, mixed> $value */
    private function decimal(array $value): string
    {
        if (isset($value['qty']) || isset($value['amount'])) {
            return $this->normalize((string) ($value['qty'] ?? $value['amount']));
        }
        $raw = (string) ($value['qty_raw'] ?? $value['amount_raw']);
        $decimals = (int) ($value['decimals'] ?? 0);

        return $this->normalize(bcdiv($raw, bcpow('10', (string) $decimals), self::SCALE));
    }

    private function normalize(string $number): string
    {
        $number = bcadd($number, '0', self::SCALE);

        return str_contains($number, '.') ? rtrim(rtrim($number, '0'), '.') : $number;
    }

    private function time(mixed $at): ?CarbonImmutable
    {
        if ($at === null || $at === '') {
            return null;
        }
        try {
            $time = is_numeric($at)
                ? CarbonImmutable::createFromTimestampMs((int) ((float) $at > 1e11 ? $at : $at * 1000), 'UTC')
                : CarbonImmutable::parse((string) $at)->utc();
        } catch (Throwable) {
            return null;
        }

        return $time->greaterThan(CarbonImmutable::now('UTC')->addMinutes(5)) ? null : $time;
    }

    /**
     * @param  list<array<string, mixed>>  $series
     * @return list<array<string, mixed>>
     */
    private function thin(array $series, int $points): array
    {
        $count = count($series);
        if ($count <= $points) {
            return $series;
        }
        $step = $count / $points;
        $out = [];
        for ($i = 0; $i < $points - 1; $i++) {
            $out[] = $series[(int) floor($i * $step)];
        }
        $out[] = $series[$count - 1];

        return $out;
    }
}
