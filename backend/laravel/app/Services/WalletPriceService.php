<?php

namespace App\Services;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Schema;

/**
 * USD prices for the assets the unified wallet holds.
 *
 * The wallet page shows one portfolio total across every chain it derives, so it
 * needs a price per chain and not per DEX pool. Native CYBER is priced from
 * WCYBER in the Cyberia pool graph; everything else comes from CoinGecko,
 * which is the only public source here that covers Monero at all.
 *
 * A missing price is returned as null rather than zero: the UI renders "—" and
 * marks the total partial, because a silent zero would understate a balance the
 * user is about to spend from.
 */
class WalletPriceService
{
    /** Long enough that a page refresh is free, short enough to stay usable. */
    private const TTL_SECONDS = 300;

    // Bumped with the payload shape: a cached v1 entry has no `tokens` key,
    // and would serve a wallet that silently shows every token as unpriced
    // for the first five minutes after a deploy.
    private const CACHE_KEY = 'wallet.prices.v4';

    /** How long the snapshot from a day ago is reused before it is read again. */
    private const DAY_AGO_TTL_SECONDS = 600;

    /** Snapshots older than this are of no use to a 24h change and are dropped. */
    private const KEEP_HOURS = 50;

    private const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';

    /**
     * Wallet chain id => CoinGecko id for that chain's native coin. CYBER is
     * not listed there and comes from Cyberia's own pool graph instead. Several chains
     * share a coin — Robinhood Chain and Base both pay gas in ETH — so the
     * request is deduplicated before it goes out.
     */
    private const COINGECKO_IDS = [
        'robinhood' => 'ethereum',
        'bnb' => 'binancecoin',
        'base' => 'ethereum',
        'solana' => 'solana',
        'monero' => 'monero',
        'bitcoin' => 'bitcoin',
        'litecoin' => 'litecoin',
    ];

    public function __construct(
        private CyberiaPrices $tokenPrices,
        private RobinhoodStockService $stocks,
        private CyberPriceService $cyberSol,
    ) {}

    /**
     * USD price per wallet chain and per token, plus when the quote was taken.
     *
     * `changes` is the move over the last 24 hours in percent, in USD, for
     * the same keys. A change nobody measured is absent rather than 0%: the
     * wallet draws nothing for it, because "0%" is a claim that it held still.
     *
     * @return array{prices: array<string, float|null>, tokens: array<string, array<string, float>>, changes: array{prices: array<string, float>, tokens: array<string, array<string, float>>}, fetchedAt: string}
     */
    public function quotes(): array
    {
        /** @var array{prices: array<string, float|null>, tokens: array<string, array<string, float>>, changes: array{prices: array<string, float>, tokens: array<string, array<string, float>>}, fetchedAt: string} */
        $quotes = Cache::remember(
            self::CACHE_KEY,
            self::TTL_SECONDS,
            function (): array {
                $coingecko = $this->coingecko();
                [$tokens, $tokenChanges] = $this->tokenUsd();

                return [
                    'prices' => [
                        'cyberia' => $this->cyberiaUsd(),
                        ...$coingecko['prices'],
                    ],
                    'tokens' => $tokens,
                    'changes' => ['prices' => $coingecko['changes'], 'tokens' => $tokenChanges],
                    'fetchedAt' => now()->toIso8601String(),
                ];
            },
        );

        /*
         * The stock tokens are merged in *after* the cache, on purpose.
         *
         * Five minutes is the right staleness for a coin whose price is a pool
         * and the wrong one for a share: the market moves through the whole
         * cache window, and a portfolio quietly five minutes behind the ticker
         * on the next screen is two numbers disagreeing inside one app. So they
         * keep their own, much shorter cache (`config/robinhood.php`) and are
         * put on top of this answer rather than frozen inside it.
         */
        $stocks = $this->stocks->priceMap();

        if ($stocks !== []) {
            $quotes['tokens']['robinhood'] = $stocks;
        }

        $quotes['changes'] = $this->withMeasuredChanges($quotes);

        return $quotes;
    }

    /**
     * Write the current prices down, so that tomorrow there is a yesterday to
     * compare them with. Nothing on Cyberia's chain remembers a past price,
     * and neither does the issuer's stock feed, so the 24h change of anything
     * no outside source reports a change for is read from these rows.
     *
     * @return int how many prices were written
     */
    public function snapshot(): int
    {
        if (! Schema::hasTable('wallet_price_snapshots')) {
            return 0;
        }

        $quotes = $this->quotes();
        $now = now();
        $rows = [];

        foreach ($quotes['prices'] as $chain => $usd) {
            if (is_numeric($usd) && $usd > 0) {
                $rows[] = ['chain' => $chain, 'asset' => '', 'usd' => (float) $usd, 'captured_at' => $now];
            }
        }

        foreach ($quotes['tokens'] as $chain => $prices) {
            foreach ($prices as $asset => $usd) {
                if (is_numeric($usd) && $usd > 0) {
                    $rows[] = ['chain' => $chain, 'asset' => strtolower((string) $asset), 'usd' => (float) $usd, 'captured_at' => $now];
                }
            }
        }

        foreach (array_chunk($rows, 500) as $chunk) {
            DB::table('wallet_price_snapshots')->insert($chunk);
        }

        DB::table('wallet_price_snapshots')
            ->where('captured_at', '<', $now->copy()->subHours(self::KEEP_HOURS))
            ->delete();

        Cache::forget(self::CACHE_KEY.'.day-ago');

        return count($rows);
    }

    /**
     * The outside sources' own changes, plus one measured against the snapshot
     * from a day ago for every price they say nothing about.
     *
     * @param  array{prices: array<string, float|null>, tokens: array<string, array<string, float>>, changes?: array{prices: array<string, float>, tokens: array<string, array<string, float>>}}  $quotes
     * @return array{prices: array<string, float>, tokens: array<string, array<string, float>>}
     */
    private function withMeasuredChanges(array $quotes): array
    {
        $changes = $quotes['changes'] ?? ['prices' => [], 'tokens' => []];
        $dayAgo = $this->dayAgo();

        if ($dayAgo === []) {
            return $changes;
        }

        foreach ($quotes['prices'] as $chain => $usd) {
            $before = $dayAgo[$chain][''] ?? null;

            if (! isset($changes['prices'][$chain]) && $before !== null && is_numeric($usd) && $usd > 0) {
                $changes['prices'][$chain] = ((float) $usd / $before - 1) * 100;
            }
        }

        foreach ($quotes['tokens'] as $chain => $prices) {
            foreach ($prices as $asset => $usd) {
                $before = $dayAgo[$chain][$asset] ?? null;

                if (! isset($changes['tokens'][$chain][$asset]) && $before !== null && $usd > 0) {
                    $changes['tokens'][$chain][$asset] = ((float) $usd / $before - 1) * 100;
                }
            }
        }

        return $changes;
    }

    /**
     * The snapshot taken closest to a day ago, keyed chain → asset ('' for the
     * chain's coin) → USD. A day ago means 24 hours where such a snapshot
     * exists, with 23 to 26 hours tolerated for a missed run; a two-day-old
     * one is not yesterday.
     *
     * @return array<string, array<string, float>>
     */
    private function dayAgo(): array
    {
        if (! Schema::hasTable('wallet_price_snapshots')) {
            return [];
        }

        return Cache::remember(self::CACHE_KEY.'.day-ago', self::DAY_AGO_TTL_SECONDS, function (): array {
            // The newest snapshot at least a day old; failing that (the
            // snapshot due then was missed), the oldest one under a day.
            $at = DB::table('wallet_price_snapshots')
                ->where('captured_at', '<=', now()->subDay())
                ->where('captured_at', '>=', now()->subHours(26))
                ->max('captured_at')
                ?? DB::table('wallet_price_snapshots')
                    ->where('captured_at', '>', now()->subDay())
                    ->where('captured_at', '<=', now()->subHours(23))
                    ->min('captured_at');

            if ($at === null) {
                return [];
            }

            $map = [];

            foreach (DB::table('wallet_price_snapshots')->where('captured_at', $at)->get() as $row) {
                if ((float) $row->usd > 0) {
                    $map[$row->chain][$row->asset] = (float) $row->usd;
                }
            }

            return $map;
        });
    }

    /**
     * USD prices for the tokens the wallet may hold, keyed by chain and then by
     * lowercased contract address — or mint, on Solana, lowercased the same way
     * because that is how every wallet screen looks a price up.
     *
     * Cyberia's answer is the same one the token pages and the analytics
     * dashboard give: prices walked outward from the USD anchors through the
     * DEX pool graph. On Solana only the project's own CYBER.sol is priced,
     * from its pool on DexScreener. Anything else is simply absent, and the
     * wallet renders it as unpriced rather than inventing a number for a
     * balance someone is about to spend.
     *
     * The second half is CYBER.sol's own 24h change from that same pool.
     *
     * @return array{0: array<string, array<string, float>>, 1: array<string, array<string, float>>}
     */
    private function tokenUsd(): array
    {
        $tokens = [];
        $changes = [];

        if (Schema::hasTable('dex_pools')) {
            $tokens['cyberia'] = $this->tokenPrices->priceFromPools(
                DB::table('dex_pools')->get()
            );
        }

        $market = $this->cyberSol->get();
        $cyberSol = $market['priceUsd'] ?? null;

        if (is_numeric($cyberSol) && (float) $cyberSol > 0) {
            $mint = strtolower((string) config('cyber.contracts.cyber_sol_mint'));
            $tokens['solana'] = [$mint => (float) $cyberSol];

            if (is_numeric($market['change24h'] ?? null)) {
                $changes['solana'] = [$mint => (float) $market['change24h']];
            }
        }

        return [$tokens, $changes];
    }

    /**
     * Native CYBER is priced from WCYBER, its 1:1 tradable wrapper on Cyberia.
     * CYBER.sol is a different Solana-issued asset and must never set the
     * native coin's portfolio value.
     */
    private function cyberiaUsd(): ?float
    {
        if (! Schema::hasTable('dex_pools')) {
            return null;
        }

        $wcyber = strtolower((string) config('cyber.contracts.wcyber'));
        $price = $this->tokenPrices->priceFromPools(
            DB::table('dex_pools')->get()
        )[$wcyber] ?? null;

        return is_numeric($price) ? (float) $price : null;
    }

    /**
     * Each chain's coin in USD, and how it moved over 24 hours.
     *
     * @return array{prices: array<string, float|null>, changes: array<string, float>}
     */
    private function coingecko(): array
    {
        $missing = ['prices' => array_fill_keys(array_keys(self::COINGECKO_IDS), null), 'changes' => []];

        try {
            $response = Http::timeout(8)->get(self::COINGECKO_URL, [
                'ids' => implode(',', array_unique(array_values(self::COINGECKO_IDS))),
                'vs_currencies' => 'usd',
                'include_24hr_change' => 'true',
            ]);

            if ($response->failed()) {
                return $missing;
            }

            $body = $response->json();
        } catch (\Throwable) {
            return $missing;
        }

        $prices = [];
        $changes = [];

        foreach (self::COINGECKO_IDS as $chain => $id) {
            $price = $body[$id]['usd'] ?? null;
            $prices[$chain] = is_numeric($price) ? (float) $price : null;
            $change = $body[$id]['usd_24h_change'] ?? null;

            if ($prices[$chain] !== null && is_numeric($change)) {
                $changes[$chain] = (float) $change;
            }
        }

        return ['prices' => $prices, 'changes' => $changes];
    }
}
