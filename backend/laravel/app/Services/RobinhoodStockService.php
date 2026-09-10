<?php

namespace App\Services;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * What a Robinhood stock token is worth, read from the issuer.
 *
 * These tokens are the one asset in this wallet with a price that does not come
 * from a pool. There is a pool — Uniswap's, on Robinhood Chain, and it is where
 * a trade actually happens — but what the pool tracks is a share, and the share
 * has a quote of its own that exists whether or not anybody has traded the
 * token today. So both numbers are read and neither is presented as the other:
 * this class is the issuer's, `lib/dexV3.ts` is the market's, and a screen that
 * shows one says which it is.
 *
 * Two things about the source shape everything here.
 *
 * **The quote is for the share, not the token.** Robinhood's `/prices` passes
 * the underlying equity's bid and ask through unchanged, while the token
 * carries a `currentMultiplier` — shares per token — that moves on splits and
 * dividends. NVDA's is 1.0007 and SGOV's is 1.0051, so ignoring it is a price
 * that is quietly wrong by a fraction of a percent and gets wronger every
 * dividend. The multiplier comes from `/assets`, on its own much longer cache,
 * because corporate actions are a daily event and quotes are a per-second one.
 *
 * **A price that could not be read is absent.** Never zero, never the last one
 * seen with no note that it is old: an unreadable market is what a halted stock
 * looks like from the outside, and the two must not render the same.
 */
class RobinhoodStockService
{
    private const QUOTES_CACHE = 'robinhood.stocks.quotes.v1';

    private const ASSETS_CACHE = 'robinhood.stocks.assets.v1';

    /**
     * The listed tokens, in the order the screens draw them.
     *
     * @return list<array{symbol: string, name: string, address: string, decimals: int, kind: string, isin: string}>
     */
    public function stocks(): array
    {
        /** @var list<array{symbol: string, name: string, address: string, decimals: int, kind: string, isin: string}> */
        return (array) config('robinhood.stocks', []);
    }

    public function chainId(): int
    {
        return (int) config('robinhood.chain_id', 4663);
    }

    /** Ticker => the row, for the two lookups this class does constantly. */
    private function bySymbol(): array
    {
        return collect($this->stocks())->keyBy('symbol')->all();
    }

    /**
     * Live quotes for every listed stock, keyed by ticker.
     *
     * The bulk endpoint is asked for all of them at once rather than one call
     * per ticker: fifty-three calls into a per-second rate limit is how a page
     * that works alone stops working when two people open it.
     *
     * @return array<string, array{
     *     symbol: string,
     *     address: string,
     *     price: float|null,
     *     share: float|null,
     *     bid: float|null,
     *     ask: float|null,
     *     high: float|null,
     *     low: float|null,
     *     volume: float|null,
     *     multiplier: float,
     *     halted: bool,
     *     at: string|null,
     * }>
     */
    public function quotes(): array
    {
        /** @var array<string, array<string, mixed>> */
        return Cache::remember(
            self::QUOTES_CACHE,
            max(5, (int) config('robinhood.quote_ttl', 30)),
            fn (): array => $this->readQuotes(),
        );
    }

    /**
     * Contract address (lowercased) => USD per token.
     *
     * The shape the wallet's portfolio already speaks, so a stock is priced by
     * the same code that prices every other ERC-20 it holds. Only quotes that
     * came back are in it — an absent key is what "unpriced" is made of.
     *
     * @return array<string, float>
     */
    public function priceMap(): array
    {
        $prices = [];

        foreach ($this->quotes() as $quote) {
            if ($quote['price'] !== null) {
                $prices[strtolower($quote['address'])] = $quote['price'];
            }
        }

        return $prices;
    }

    /**
     * @return array<string, array<string, mixed>>
     */
    private function readQuotes(): array
    {
        $multipliers = $this->multipliers();
        $bySymbol = $this->bySymbol();

        try {
            $response = $this->client(8)->get($this->endpoint('prices'));

            if ($response->failed()) {
                /*
                 * Said out loud, because the alternative is a wallet quietly
                 * drawing dashes where prices go. An issuer that stops
                 * answering is not a state anybody can debug from the screen.
                 */
                Log::warning('Robinhood stock quotes: refused', [
                    'status' => $response->status(),
                ]);

                return [];
            }

            $body = (array) $response->json();
        } catch (\Throwable $e) {
            Log::warning('Robinhood stock quotes: unreachable', [
                'error' => $e->getMessage(),
            ]);

            return [];
        }

        $quotes = [];

        foreach ((array) ($body['quotes'] ?? []) as $row) {
            $symbol = (string) ($row['tokenSymbol'] ?? '');
            $stock = $bySymbol[$symbol] ?? null;

            if ($stock === null) {
                continue;
            }

            $bid = $this->number($row['bid'] ?? null);
            $ask = $this->number($row['ask'] ?? null);
            $multiplier = $multipliers[$symbol] ?? 1.0;

            /*
             * The middle of the book, and deliberately not the last trade —
             * `/prices` does not carry one. A spread of a cent on a $220 share
             * makes the choice between bid, ask and mid immaterial for a
             * portfolio total; taking the ask would quietly overstate every
             * holding by half a spread, which on a thin ticker is not
             * immaterial at all.
             */
            $share = $bid !== null && $ask !== null
                ? ($bid + $ask) / 2
                : ($bid ?? $ask);

            $quotes[$symbol] = [
                'symbol' => $symbol,
                'address' => $stock['address'],
                'price' => $share === null ? null : $share * $multiplier,
                'share' => $share,
                'bid' => $bid,
                'ask' => $ask,
                'high' => $this->number($row['dailyHigh'] ?? null),
                'low' => $this->number($row['dailyLow'] ?? null),
                'volume' => $this->number($row['dailyTradingVolume'] ?? null),
                'multiplier' => $multiplier,
                'halted' => (bool) ($row['isTradingHalt'] ?? false),
                'at' => isset($row['generatedAt']) ? (string) $row['generatedAt'] : null,
            ];
        }

        return $quotes;
    }

    /**
     * Ticker => shares per token, from the issuer's asset registry.
     *
     * Cached far longer than a price and read separately, because it is a
     * different kind of fact: a quote is stale in seconds and a multiplier
     * changes on a corporate action. An unreadable registry answers 1.0 rather
     * than nothing — the quote is still very nearly right, and refusing to
     * price a portfolio over a rounding factor helps nobody.
     *
     * @return array<string, float>
     */
    private function multipliers(): array
    {
        /** @var array<string, float> */
        return Cache::remember(
            self::ASSETS_CACHE,
            max(60, (int) config('robinhood.asset_ttl', 3600)),
            function (): array {
                try {
                    $response = $this->client(10)->get($this->endpoint('assets'));

                    if ($response->failed()) {
                        return [];
                    }

                    $body = (array) $response->json();
                } catch (\Throwable) {
                    return [];
                }

                $multipliers = [];

                foreach ((array) ($body['assets'] ?? []) as $asset) {
                    $symbol = (string) ($asset['tokenSymbol'] ?? '');
                    $value = $this->number($asset['currentMultiplier'] ?? null);

                    if ($symbol !== '' && $value !== null && $value > 0) {
                        $multipliers[$symbol] = $value;
                    }
                }

                return $multipliers;
            },
        );
    }

    /**
     * The client both calls are made with.
     *
     * A single place, so that the quotes and the multipliers cannot end up
     * reaching the issuer over different routes — one succeeding and the other
     * failing would price every token at exactly the share, silently.
     */
    private function client(int $seconds): PendingRequest
    {
        $request = Http::timeout($seconds)->acceptJson();
        $proxy = trim((string) config('robinhood.proxy', ''));

        return $proxy === '' ? $request : $request->withOptions(['proxy' => $proxy]);
    }

    private function endpoint(string $path): string
    {
        return rtrim((string) config('robinhood.api', ''), '/').'/'.$path;
    }

    private function number(mixed $value): ?float
    {
        return is_numeric($value) ? (float) $value : null;
    }
}
