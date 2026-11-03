<?php

namespace App\Services\Heatmap;

use App\Services\WalletPriceService;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Schema;
use Throwable;

/**
 * Cyberia's own tokens as a market map: every launch on both launchpads, sized
 * by supply × pool price and coloured by how that price moved in a day.
 *
 * Nothing on chain remembers yesterday's price, so `snapshot()` writes one down
 * every few minutes (`heatmap:snapshot`) and the change is today's pool price
 * against the snapshot taken a day earlier. Until a day of snapshots exists the
 * change is null and the tile is drawn grey — never a 0%, which would be a move
 * nobody measured. The change is in CYBER, because that is what each pool
 * quotes; the two tokens that trade elsewhere (CYBER.sol, LAIN) come with
 * DexScreener's own USD change.
 */
class CyberiaHeatmap
{
    private const ALL_TOKENS_LENGTH = '0xdbb80e42';

    private const ALL_TOKENS = '0x634282af';

    private const POOL_OF = '0x988b1fa7';

    private const PAIR_OF = '0xa7465bdb';

    private const SYMBOL = '0x95d89b41';

    private const NAME = '0x06fdde03';

    private const TOTAL_SUPPLY = '0x18160ddd';

    private const TOKEN0 = '0x0dfe1681';

    private const SLOT0 = '0x3850c7bd';

    private const GET_RESERVES = '0x0902f1ac';

    /** Cyberia's node refuses a JSON-RPC batch over 20 calls. */
    private const BATCH = 20;

    public function __construct(private readonly WalletPriceService $prices) {}

    /**
     * Read every launch and its pool price, and store them as one snapshot.
     *
     * @return int how many tokens were written
     */
    public function snapshot(): int
    {
        $now = now();
        $rows = [];

        foreach ((array) config('heatmap.cyberia.launchpads') as $venue => $launchpad) {
            foreach ($this->readVenue((string) $venue, strtolower((string) $launchpad)) as $token) {
                $rows[] = $token + ['captured_at' => $now];
            }
        }

        if ($rows !== []) {
            DB::table('heatmap_prices')->insert($rows);
        }

        DB::table('heatmap_prices')
            ->where('captured_at', '<', $now->copy()->subHours((int) config('heatmap.cyberia.keep_hours', 72)))
            ->delete();

        return count($rows);
    }

    /**
     * The map as the page draws it.
     *
     * @return array{generatedAt: string|null, cyberUsd: float|null, sectors: list<array{key: string, label: string, tiles: list<array<string, mixed>>}>, unpriced: int}
     */
    public function map(): array
    {
        $cyberUsd = $this->cyberUsd();
        $latestAt = Schema::hasTable('heatmap_prices') ? DB::table('heatmap_prices')->max('captured_at') : null;
        $tiles = ['core' => $this->externalTiles(), 'service' => [], 'launchpad' => []];
        $unpriced = 0;

        if ($latestAt !== null) {
            $latest = Carbon::parse($latestAt);
            $dayAgoAt = DB::table('heatmap_prices')
                ->where('captured_at', '<=', $latest->copy()->subDay())
                ->where('captured_at', '>=', $latest->copy()->subHours(26))
                ->max('captured_at');
            $dayAgo = $dayAgoAt === null ? collect() : DB::table('heatmap_prices')
                ->where('captured_at', $dayAgoAt)
                ->pluck('price_cyber', 'address');

            foreach (DB::table('heatmap_prices')->where('captured_at', $latestAt)->get() as $row) {
                $price = $row->price_cyber === null ? null : (float) $row->price_cyber;

                if ($price === null || $price <= 0 || $row->supply <= 0) {
                    $unpriced++;

                    continue;
                }

                $before = $dayAgo[$row->address] ?? null;
                $capCyber = $price * (float) $row->supply;

                $tiles[$row->sector][] = [
                    'symbol' => $row->symbol ?: substr($row->address, 0, 8),
                    'name' => $row->name,
                    'address' => $row->address,
                    'marketCap' => $cyberUsd === null ? $capCyber : $capCyber * $cyberUsd,
                    'change' => $before === null || (float) $before <= 0 ? null : ($price / (float) $before - 1) * 100,
                    'url' => '/token/'.$row->address,
                ];
            }
        }

        $labels = ['core' => 'CYBER & LAIN', 'service' => 'Cyberia services', 'launchpad' => 'Launchpad'];
        $sectors = [];

        foreach ($tiles as $key => $list) {
            if ($list !== []) {
                usort($list, fn (array $a, array $b): int => $b['marketCap'] <=> $a['marketCap']);
                $sectors[] = ['key' => $key, 'label' => $labels[$key], 'tiles' => $list];
            }
        }

        return [
            'generatedAt' => $latestAt === null ? null : Carbon::parse($latestAt)->toIso8601String(),
            'cyberUsd' => $cyberUsd,
            'sectors' => $sectors,
            'unpriced' => $unpriced,
        ];
    }

    /**
     * CYBER.sol and LAIN from DexScreener: market cap and the day's move in USD,
     * from the deepest pool each one has.
     *
     * @return list<array<string, mixed>>
     */
    private function externalTiles(): array
    {
        return cache()->remember('heatmap.cyberia.external', 300, function (): array {
            $tiles = [];

            foreach ((array) config('heatmap.cyberia.external') as $token) {
                try {
                    $pairs = Http::timeout(8)
                        ->get("https://api.dexscreener.com/tokens/v1/{$token['chain']}/{$token['address']}")
                        ->json();
                } catch (Throwable) {
                    continue;
                }

                $best = collect(is_array($pairs) ? $pairs : [])
                    ->filter(fn ($pair): bool => is_array($pair))
                    ->sortByDesc(fn (array $pair): float => (float) ($pair['liquidity']['usd'] ?? 0))
                    ->first();
                $cap = $best['marketCap'] ?? $best['fdv'] ?? null;

                if (! is_numeric($cap) || $cap <= 0) {
                    continue;
                }

                $change = $best['priceChange']['h24'] ?? null;

                $tiles[] = [
                    'symbol' => $token['symbol'],
                    'name' => $token['name'],
                    'address' => $token['address'],
                    'marketCap' => (float) $cap,
                    'change' => is_numeric($change) ? (float) $change : null,
                    'url' => (string) ($best['url'] ?? 'https://dexscreener.com'),
                ];
            }

            return $tiles;
        });
    }

    private function cyberUsd(): ?float
    {
        try {
            $usd = $this->prices->quotes()['prices']['cyberia'] ?? null;
        } catch (Throwable) {
            return null;
        }

        return is_numeric($usd) && $usd > 0 ? (float) $usd : null;
    }

    /**
     * Every token of one launchpad with its supply and pool price in CYBER.
     *
     * @return list<array<string, mixed>>
     */
    private function readVenue(string $venue, string $launchpad): array
    {
        $length = $this->batch([[$launchpad, self::ALL_TOKENS_LENGTH]])[0] ?? null;
        $total = $length === null ? 0 : (int) $this->uint($length);

        if ($total === 0) {
            return [];
        }

        $addresses = array_values(array_filter(array_map(
            fn (?string $word): ?string => $word === null ? null : $this->address($word),
            $this->batch(array_map(
                fn (int $i): array => [$launchpad, self::ALL_TOKENS.$this->word(dechex($i))],
                range(0, $total - 1),
            )),
        )));

        $calls = [];

        foreach ($addresses as $address) {
            $calls[] = [$address, self::SYMBOL];
            $calls[] = [$address, self::NAME];
            $calls[] = [$address, self::TOTAL_SUPPLY];
            $calls[] = [$launchpad, ($venue === 'v3' ? self::POOL_OF : self::PAIR_OF).$this->word(substr($address, 2))];
        }

        $meta = $this->batch($calls);
        $pools = [];
        $poolCalls = [];

        foreach ($addresses as $i => $address) {
            $pool = isset($meta[$i * 4 + 3]) ? $this->address($meta[$i * 4 + 3]) : null;

            if ($pool !== null && $pool !== '0x'.str_repeat('0', 40)) {
                $pools[$i] = $pool;
                $poolCalls[$i * 2] = [$pool, self::TOKEN0];
                $poolCalls[$i * 2 + 1] = [$pool, $venue === 'v3' ? self::SLOT0 : self::GET_RESERVES];
            }
        }

        $poolData = $this->batch($poolCalls);
        $service = array_map('strtolower', (array) config('heatmap.cyberia.service_tokens'));
        $serviceSymbols = (array) config('heatmap.cyberia.service_symbols');
        $tokens = [];

        foreach ($addresses as $i => $address) {
            $symbol = $this->text($meta[$i * 4] ?? null);
            $token0 = isset($poolData[$i * 2]) ? $this->address($poolData[$i * 2]) : null;
            $state = $poolData[$i * 2 + 1] ?? null;
            $price = isset($pools[$i]) && $token0 !== null && $state !== null
                ? $this->price($venue, $state, $token0 === $address)
                : null;

            $tokens[] = [
                'address' => $address,
                'symbol' => $symbol === null ? null : mb_substr($symbol, 0, 32),
                'name' => ($name = $this->text($meta[$i * 4 + 1] ?? null)) === null ? null : mb_substr($name, 0, 64),
                'venue' => $venue,
                'sector' => in_array($address, $service, true) || in_array(strtoupper((string) $symbol), $serviceSymbols, true)
                    ? 'service'
                    : 'launchpad',
                'supply' => isset($meta[$i * 4 + 2]) ? $this->uint($meta[$i * 4 + 2]) / 1e18 : 0.0,
                'price_cyber' => $price,
            ];
        }

        return $tokens;
    }

    /**
     * The token's price in the pool's other asset (CYBER). Every launch is 18
     * decimals against WCYBER's 18, so no scaling is needed.
     */
    public function price(string $venue, string $state, bool $tokenIsToken0): ?float
    {
        $data = substr($state, 2);

        if ($venue === 'v3') {
            $root = $this->uint('0x'.substr($data, 0, 64)) / 2 ** 96;
            $price = $root * $root;

            return $price > 0 ? ($tokenIsToken0 ? $price : 1 / $price) : null;
        }

        $reserve0 = $this->uint('0x'.substr($data, 0, 64));
        $reserve1 = $this->uint('0x'.substr($data, 64, 64));

        if ($reserve0 <= 0 || $reserve1 <= 0) {
            return null;
        }

        return $tokenIsToken0 ? $reserve1 / $reserve0 : $reserve0 / $reserve1;
    }

    /**
     * `eth_call`s in batches of twenty, keyed as given; a failed call is absent.
     *
     * @param  array<int, array{0: string, 1: string}>  $calls
     * @return array<int, string>
     */
    private function batch(array $calls): array
    {
        $results = [];

        foreach (array_chunk($calls, self::BATCH, true) as $chunk) {
            $payload = [];

            foreach ($chunk as $id => [$to, $data]) {
                $payload[] = [
                    'jsonrpc' => '2.0',
                    'id' => $id,
                    'method' => 'eth_call',
                    'params' => [['to' => $to, 'data' => $data], 'latest'],
                ];
            }

            try {
                $answers = Http::timeout(20)->post((string) config('heatmap.cyberia.rpc_url'), $payload)->json();
            } catch (Throwable) {
                continue;
            }

            foreach (is_array($answers) ? $answers : [] as $answer) {
                $result = is_array($answer) ? ($answer['result'] ?? null) : null;

                if (is_string($result) && preg_match('/^0x[0-9a-fA-F]{2,}$/', $result) && isset($answer['id'])) {
                    $results[(int) $answer['id']] = $result;
                }
            }
        }

        return $results;
    }

    /** A 256-bit word as a float — precise enough to draw, never to settle. */
    private function uint(string $hex): float
    {
        $value = 0.0;

        foreach (str_split(ltrim(substr($hex, 2), '0') ?: '0') as $digit) {
            $value = $value * 16 + hexdec($digit);
        }

        return $value;
    }

    private function word(string $hex): string
    {
        return str_pad(strtolower($hex), 64, '0', STR_PAD_LEFT);
    }

    private function address(string $word): ?string
    {
        $hex = substr($word, 2);

        return strlen($hex) >= 40 ? '0x'.strtolower(substr($hex, 24, 40)) : null;
    }

    /** An ABI string, or a bytes32 on old tokens. */
    private function text(?string $result): ?string
    {
        if ($result === null) {
            return null;
        }

        $data = substr($result, 2);
        $bytes = null;

        if (strlen($data) >= 128) {
            $length = (int) hexdec(substr($data, 64, 64));
            $bytes = $length <= 256 ? substr($data, 128, $length * 2) : null;
        } elseif (strlen($data) === 64) {
            $bytes = rtrim($data, '0');
            $bytes .= strlen($bytes) % 2 ? '0' : '';
        }

        $decoded = is_string($bytes) && ctype_xdigit($bytes) ? hex2bin($bytes) : false;

        if ($decoded === false) {
            return null;
        }

        $clean = trim((string) preg_replace('/[\x00-\x1F\x7F]/u', '', mb_scrub($decoded, 'UTF-8')));

        return $clean === '' ? null : $clean;
    }
}
