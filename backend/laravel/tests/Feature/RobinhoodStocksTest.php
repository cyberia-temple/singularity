<?php

use App\Services\RobinhoodStockService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

/**
 * The stock registry and the price behind it.
 *
 * Two registries exist because two languages read them — `config/robinhood.php`
 * for this host and `resources/js/lib/robinhoodStocks.ts` for the browser — and
 * one script writes both. The first test here is what makes that safe: a hand
 * edit to either one is caught, rather than discovered as a wallet drawing a
 * price for a contract the exchange page will not trade.
 */
beforeEach(function () {
    Cache::flush();
});

it('keeps the PHP and browser registries identical', function () {
    $source = file_get_contents(
        resource_path('js/lib/robinhoodStocks.ts')
    );

    expect($source)->not->toBeFalse();

    foreach (config('robinhood.stocks') as $stock) {
        expect($source)
            ->toContain("symbol: '{$stock['symbol']}'")
            ->toContain("address: '{$stock['address']}'")
            ->toContain("isin: '{$stock['isin']}'")
            // The icon path carries the file's real extension, so a drift here
            // is eight broken images rather than a wrong label.
            ->toContain("icon: '{$stock['icon']}'");
    }

    // …and nothing extra on the browser's side either: both files are written
    // by one run, so a count that differs means one of them was edited.
    expect(substr_count($source, "        symbol: '"))
        ->toBe(count(config('robinhood.stocks')));
});

it('prices a token as the share times the issuer’s multiplier', function () {
    Http::fake([
        '*/rhj/assets' => Http::response(['assets' => [
            ['tokenSymbol' => 'NVDA', 'currentMultiplier' => '1.500000000000000000'],
        ]]),
        '*/rhj/prices' => Http::response(['quotes' => [
            [
                'tokenSymbol' => 'NVDA',
                'bid' => '200',
                'ask' => '202',
                'dailyHigh' => '205',
                'dailyLow' => '199',
                'dailyTradingVolume' => '4200',
                'isTradingHalt' => false,
                'generatedAt' => '2026-09-10T09:00:00Z',
            ],
        ]]),
    ]);

    $quote = app(RobinhoodStockService::class)->quotes()['NVDA'];

    // The middle of the book, and never the ask.
    expect($quote['share'])->toBe(201.0);
    // A token is one and a half shares here, so it is worth one and a half.
    expect($quote['price'])->toBe(301.5);
    expect($quote['high'])->toBe(205.0);
    expect($quote['halted'])->toBeFalse();
});

it('drops a symbol this build does not list', function () {
    Http::fake([
        '*/rhj/assets' => Http::response(['assets' => []]),
        '*/rhj/prices' => Http::response(['quotes' => [
            ['tokenSymbol' => 'NOTLISTED', 'bid' => '1', 'ask' => '2'],
        ]]),
    ]);

    expect(app(RobinhoodStockService::class)->quotes())->toBe([]);
});

it('answers nothing rather than zero when the market cannot be read', function () {
    Http::fake([
        '*/rhj/assets' => Http::response([], 503),
        '*/rhj/prices' => Http::response([], 503),
    ]);

    $stocks = app(RobinhoodStockService::class);

    expect($stocks->quotes())->toBe([]);
    expect($stocks->priceMap())->toBe([]);
});

it('serves the whole registry even when no price came back', function () {
    Http::fake([
        '*/rhj/assets' => Http::response([], 503),
        '*/rhj/prices' => Http::response([], 503),
    ]);

    $response = $this->getJson('/api/wallet/stocks');

    $response->assertOk()
        ->assertJsonPath('chainId', 4663)
        ->assertJsonCount(count(config('robinhood.stocks')), 'stocks')
        ->assertJsonPath('stocks.0.price', null)
        ->assertJsonPath('stocks.0.icon', config('robinhood.stocks.0.icon'));
});

it('carries the price and the issuer’s own timestamp', function () {
    Http::fake([
        '*/rhj/assets' => Http::response(['assets' => []]),
        '*/rhj/prices' => Http::response(['quotes' => [
            [
                'tokenSymbol' => 'NVDA',
                'bid' => '223.12',
                'ask' => '223.18',
                'isTradingHalt' => true,
                'generatedAt' => '2026-09-10T09:39:03Z',
            ],
        ]]),
    ]);

    $this->getJson('/api/wallet/stocks')
        ->assertOk()
        ->assertJsonPath('stocks.0.symbol', 'NVDA')
        ->assertJsonPath('stocks.0.price', 223.15)
        ->assertJsonPath('stocks.0.halted', true)
        ->assertJsonPath('quotedAt', '2026-09-10T09:39:03Z');
});
