<?php

use App\Models\User;
use App\Services\WalletPriceService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;

const DEXSCREENER_URL = 'https://api.dexscreener.com/*';

const COINGECKO_URL = 'https://api.coingecko.com/*';

/*
 * The issuer of the tokenised stocks. Faked in every one of these tests and not
 * only in the ones about stocks: `Http::fake()` with a map lets an unmatched
 * URL through to the network, so leaving it out would make this suite call a
 * third party fifty times a run.
 */
const ROBINHOOD_URL = 'https://api.robinhood.com/*';

beforeEach(function () {
    Cache::flush();
});

/**
 * The DEX pool table the indexer bot owns. It is not a migration — a wallet
 * running against a database without it has to price nothing rather than break.
 */
function indexerTables(): void
{
    DB::statement('CREATE TABLE dex_pools (
        pair_address TEXT PRIMARY KEY, token0 TEXT, token1 TEXT,
        symbol0 TEXT, symbol1 TEXT, reserve0 REAL, reserve1 REAL,
        tvl_usd REAL, updated_at TEXT
    )');
}

/** @param array<string, mixed> $overrides */
function fakePriceFeeds(array $overrides = []): void
{
    Http::fake([
        DEXSCREENER_URL => Http::response(['pairs' => [['priceUsd' => '0.0742', 'priceNative' => '0.0004']]]),
        COINGECKO_URL => Http::response([
            'solana' => ['usd' => 148.5],
            'monero' => ['usd' => 312.25],
            'ethereum' => ['usd' => 2410.0],
            'binancecoin' => ['usd' => 604.5],
            'bitcoin' => ['usd' => 64000.0],
            'litecoin' => ['usd' => 78.0],
        ]),
        ROBINHOOD_URL => Http::response(['assets' => [], 'quotes' => []]),
        ...$overrides,
    ]);
}

/**
 * One live quote, under the same key the default fake uses so it replaces it.
 *
 * Both of the issuer's endpoints answer with this body, which is the point: no
 * `assets`, so no multiplier is known, so the token is worth exactly the share.
 * A separate, narrower pattern would sit *after* the general one in the array
 * and never be reached.
 */
function fakeStockQuotes(): array
{
    return [ROBINHOOD_URL => Http::response(['quotes' => [
        [
            'tokenSymbol' => 'NVDA',
            'bid' => '223',
            'ask' => '223.20',
            'isTradingHalt' => false,
        ],
    ]])];
}

it('quotes every wallet chain in USD, including the ones sharing a coin', function () {
    fakePriceFeeds();

    $quotes = app(WalletPriceService::class)->quotes();

    // Robinhood Chain and Base both pay gas in ETH, so both quote the ETH price.
    expect($quotes['prices'])->toBe([
        'cyberia' => 0.0742,
        'robinhood' => 2410.0,
        'bnb' => 604.5,
        'base' => 2410.0,
        'solana' => 148.5,
        'monero' => 312.25,
        'bitcoin' => 64000.0,
        'litecoin' => 78.0,
    ])->and($quotes['fetchedAt'])->toBeString();
});

it('prices the ERC20s the wallet can hold, from the DEX pool graph', function () {
    fakePriceFeeds();
    indexerTables();

    // One pool anchors USDC at $1 and gives ASH a rate against it: 100 ASH
    // against 50 USDC is $0.50 an ASH.
    DB::table('dex_pools')->insert([
        'pair_address' => '0x'.str_repeat('a', 40),
        'token0' => '0xdc25597B19799010047F17e9591EFE08EFd40077',
        'token1' => '0x992Fca0a89DD95afb17751f6CC233Adb9B089df5',
        'symbol0' => 'USDC',
        'symbol1' => 'ASH',
        'reserve0' => 50,
        'reserve1' => 100,
    ]);

    $tokens = app(WalletPriceService::class)->quotes()['tokens'];

    expect($tokens['cyberia']['0x992fca0a89dd95afb17751f6cc233adb9b089df5'])
        ->toEqualWithDelta(0.5, 0.0001)
        ->and($tokens['cyberia']['0xdc25597b19799010047f17e9591efe08efd40077'])
        ->toEqualWithDelta(1.0, 0.0001);
});

it('leaves tokens unpriced rather than inventing a number for them', function () {
    fakePriceFeeds();
    indexerTables();

    // No pools indexed yet: an unpriced token renders as "—" in the wallet,
    // and a zero here would understate a balance someone is about to spend.
    $tokens = app(WalletPriceService::class)->quotes()['tokens'];

    expect($tokens['cyberia'] ?? [])->toBe([]);
});

it('serves a wallet with no indexer at all rather than failing', function () {
    fakePriceFeeds();

    // dex_pools is created by the indexer bot, not by a migration, so a fresh
    // deployment genuinely does not have it.
    expect(app(WalletPriceService::class)->quotes()['tokens'])->toBe([]);
});

it('asks the price feed for each coin once, not once per chain', function () {
    fakePriceFeeds();

    app(WalletPriceService::class)->quotes();

    Http::assertSent(function ($request) {
        if (! str_contains($request->url(), 'coingecko')) {
            return false;
        }

        $ids = explode(',', $request['ids']);

        return $ids === array_unique($ids) && in_array('ethereum', $ids, true);
    });
});

it('reports a missing price as null rather than zero', function () {
    fakePriceFeeds([COINGECKO_URL => Http::response('rate limited', 429)]);

    $prices = app(WalletPriceService::class)->quotes()['prices'];

    expect($prices['cyberia'])->toBe(0.0742)
        ->and($prices['solana'])->toBeNull()
        ->and($prices['monero'])->toBeNull()
        ->and($prices['base'])->toBeNull()
        ->and($prices['bitcoin'])->toBeNull();
});

it('serves a cached quote instead of hitting the feeds on every page view', function () {
    fakePriceFeeds();

    app(WalletPriceService::class)->quotes();
    app(WalletPriceService::class)->quotes();

    /*
     * The coin feeds, and only them. A total count would also be counting the
     * stock quotes, which are deliberately *not* inside this five-minute cache
     * — a share moves through the whole window, and a portfolio five minutes
     * behind the ticker on the next screen is one app disagreeing with itself.
     */
    $coinFeeds = 0;

    Http::assertSent(function ($request) use (&$coinFeeds) {
        if (str_contains($request->url(), 'coingecko')
            || str_contains($request->url(), 'dexscreener')) {
            $coinFeeds++;
        }

        return true;
    });

    expect($coinFeeds)->toBe(2);
});

it('prices the tokenised stocks beside every other token', function () {
    fakePriceFeeds(fakeStockQuotes());

    $tokens = app(WalletPriceService::class)->quotes()['tokens'];

    // Keyed by contract, lowercased, exactly as the wallet reads every other
    // token price — the stock is not a special case once it has a number.
    expect($tokens['robinhood']['0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec'])
        ->toBe(223.1);
});

it('leaves the stock chain out entirely when no quote came back', function () {
    fakePriceFeeds();

    $tokens = app(WalletPriceService::class)->quotes()['tokens'];

    // Absent, never an empty map and never zeros: "unpriced" is a state the
    // wallet renders as a dash, and it has to survive the trip.
    expect($tokens)->not->toHaveKey('robinhood');
});

it('hands the wallet page its opening quotes', function () {
    fakePriceFeeds();

    $this->actingAs(User::factory()->create())
        ->get('/wallet')
        ->assertOk()
        ->assertInertia(fn ($page) => $page
            ->component('Wallet')
            ->where('quotes.prices.solana', 148.5));
});

it('exposes quotes to the browser without requiring a session', function () {
    fakePriceFeeds();

    $this->getJson('/api/wallet/prices')
        ->assertOk()
        ->assertJsonPath('prices.monero', 312.25);
});
