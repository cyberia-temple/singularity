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
 * needs a price per chain and not per DEX pool. CYBER reuses the DexScreener
 * feed the bridge already trusts; everything else comes from CoinGecko, which is
 * the only public source here that covers Monero at all.
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
    private const CACHE_KEY = 'wallet.prices.v2';

    private const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';

    /**
     * Wallet chain id => CoinGecko id for that chain's native coin. CYBER is
     * not listed there and comes from the DEX feed instead. Several chains
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
        private CyberPriceService $cyberPrice,
        private CyberiaPrices $tokenPrices,
        private RobinhoodStockService $stocks,
    ) {}

    /**
     * USD price per wallet chain and per token, plus when the quote was taken.
     *
     * @return array{prices: array<string, float|null>, tokens: array<string, array<string, float>>, fetchedAt: string}
     */
    public function quotes(): array
    {
        /** @var array{prices: array<string, float|null>, tokens: array<string, array<string, float>>, fetchedAt: string} */
        $quotes = Cache::remember(
            self::CACHE_KEY,
            self::TTL_SECONDS,
            fn (): array => [
                'prices' => [
                    'cyberia' => $this->cyberiaUsd(),
                    ...$this->coingeckoUsd(),
                ],
                'tokens' => $this->tokenUsd(),
                'fetchedAt' => now()->toIso8601String(),
            ],
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

        return $quotes;
    }

    /**
     * USD prices for the ERC20s the wallet may hold, keyed by chain and then by
     * lowercased contract address.
     *
     * Only Cyberia has an answer here, and it is the same one the token pages
     * and the analytics dashboard give: prices walked outward from the USD
     * anchors through the DEX pool graph. Tokens on chains with no such graph
     * are simply absent, and the wallet renders them as unpriced rather than
     * inventing a number for a balance someone is about to spend.
     *
     * @return array<string, array<string, float>>
     */
    private function tokenUsd(): array
    {
        if (! Schema::hasTable('dex_pools')) {
            return [];
        }

        return ['cyberia' => $this->tokenPrices->priceFromPools(
            DB::table('dex_pools')->get()
        )];
    }

    /**
     * Native CYBER is priced from CYBER.sol, the only side of the token with a
     * liquid market; the bridge holds them one-to-one.
     */
    private function cyberiaUsd(): ?float
    {
        $price = $this->cyberPrice->get()['priceUsd'] ?? null;

        return is_numeric($price) ? (float) $price : null;
    }

    /**
     * @return array<string, float|null>
     */
    private function coingeckoUsd(): array
    {
        $missing = array_fill_keys(array_keys(self::COINGECKO_IDS), null);

        try {
            $response = Http::timeout(8)->get(self::COINGECKO_URL, [
                'ids' => implode(',', array_unique(array_values(self::COINGECKO_IDS))),
                'vs_currencies' => 'usd',
            ]);

            if ($response->failed()) {
                return $missing;
            }

            $body = $response->json();
        } catch (\Throwable) {
            return $missing;
        }

        $prices = [];

        foreach (self::COINGECKO_IDS as $chain => $id) {
            $price = $body[$id]['usd'] ?? null;
            $prices[$chain] = is_numeric($price) ? (float) $price : null;
        }

        return $prices;
    }
}
