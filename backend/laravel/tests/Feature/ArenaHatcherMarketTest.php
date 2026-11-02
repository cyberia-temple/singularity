<?php

use App\Services\Arena\ArenaMarketFeed;
use App\Services\Arena\ArenaModelClient;
use App\Services\Arena\ArenaSeasonManager;
use Carbon\CarbonImmutable;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    CarbonImmutable::setTestNow(CarbonImmutable::parse('2026-11-02T12:00:00Z'));
    config()->set('arena.market', 'solana-hatcher-sol');
    config()->set('arena.partner', 'hatcher');
    config()->set('solana.rpc.upstreams.mainnet', ['https://solana.test']);
    Http::preventStrayRequests();
});

afterEach(function () {
    CarbonImmutable::setTestNow();
});

function arenaBase58(string $address): string
{
    $alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    $number = '0';
    foreach (str_split($address) as $char) {
        $number = bcadd(bcmul($number, '58'), (string) strpos($alphabet, $char));
    }
    $bytes = '';
    while (bccomp($number, '0') > 0) {
        $bytes = chr((int) bcmod($number, '256')).$bytes;
        $number = bcdiv($number, '256', 0);
    }

    return str_pad($bytes, 32, "\0", STR_PAD_LEFT);
}

/** @param array<string, mixed> $overrides */
function fakeHatcherPool(array $overrides = []): void
{
    $spec = app(ArenaMarketFeed::class)->specification();
    $baseVault = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    $quoteVault = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
    $data = str_repeat("\1", 43).arenaBase58($overrides['base_mint'] ?? $spec['base_mint']).arenaBase58($spec['quote_mint'])
        .str_repeat("\2", 32).arenaBase58($baseVault).arenaBase58($quoteVault).str_repeat("\0", 40);
    $vault = fn (string $mint, int $decimals, string $amount): array => [
        'owner' => 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PeBkAWNCKZ3FV1',
        'data' => ['parsed' => ['info' => ['mint' => $mint, 'owner' => $overrides['authority'] ?? $spec['pool'],
            'tokenAmount' => ['amount' => $amount, 'decimals' => $decimals]]]],
    ];
    Http::fake(function (Request $request) use ($spec, $data, $vault, $baseVault, $quoteVault) {
        $result = match ($request['method']) {
            'getAccountInfo' => ['context' => ['slot' => 900], 'value' => ['owner' => $spec['program'], 'data' => [base64_encode($data), 'base64']]],
            'getMultipleAccounts' => $request['params'][0] === [$baseVault, $quoteVault]
                ? ['context' => ['slot' => 901], 'value' => [
                    $vault($spec['base_mint'], 6, '326908305000000'), $vault($spec['quote_mint'], 9, '70751700000')]]
                : ['context' => ['slot' => 901], 'value' => [null, null]],
            'getBlockTime' => CarbonImmutable::now()->subSeconds(15)->getTimestamp(),
            'getLatestBlockhash' => ['value' => ['blockhash' => 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N']],
        };

        return Http::response(['jsonrpc' => '2.0', 'id' => $request['id'], 'result' => $result]);
    });
}

it('prices one million HATCHER in SOL micros from the pool vaults', function () {
    fakeHatcherPool();
    $feed = app(ArenaMarketFeed::class);
    $quote = $feed->quote($feed->specification(), 90);

    // 70.7517 SOL against 326,908,305 HATCHER = 0.216426 SOL (rounded down) per 1M.
    expect($quote['price_micros'])->toBe('216426')
        ->and($quote['source'])->toMatchArray(['chain_id' => 101, 'block_number' => '901']);
});

it('fails closed when the pool does not hold the expected mint', function () {
    fakeHatcherPool(['base_mint' => 'So11111111111111111111111111111111111111112']);
    $feed = app(ArenaMarketFeed::class);
    $feed->quote($feed->specification(), 90);
})->throws(DomainException::class, 'wrong_market_contract');

it('fails closed when a vault is not owned by the pool', function () {
    fakeHatcherPool(['authority' => 'So11111111111111111111111111111111111111112']);
    $feed = app(ArenaMarketFeed::class);
    $feed->quote($feed->specification(), 90);
})->throws(DomainException::class, 'wrong_market_contract');

it('freezes the partner, units and market wording into a Hatcher season', function () {
    config()->set('arena.automation.models', ['lain' => 'fixture/lain:free', 'challenger' => 'fixture/challenger:free']);
    $rules = app(ArenaSeasonManager::class)->rules(true);

    expect($rules['market'])->toBe('HATCHER / SOL')
        ->and($rules['units'])->toBe(['cash' => 'SOL', 'asset' => 'HATCHER', 'lot' => 1000000])
        ->and($rules['initial_cash_micros'])->toBe('10000000')
        ->and($rules['partner']['title'])->toBe('Hatcher Cup')
        ->and($rules['automation']['prompt'])->toContain('SOL micro-units per lot of 1,000,000 HATCHER')
        ->and($rules['automation']['prompt'])->not->toContain('WETH');
});

it('keeps the original WETH/USDC rules byte for byte', function () {
    config()->set('arena.market', 'base-weth-usdc');
    config()->set('arena.partner', null);
    $rules = app(ArenaSeasonManager::class)->rules();

    expect($rules)->not->toHaveKeys(['units', 'partner'])
        ->and($rules['market'])->toBe('WETH / USDC')
        ->and(ArenaModelClient::prompt(null))->toBe(ArenaModelClient::PROMPT);
});

it('quotes a frozen Hatcher season even when new seasons default to another market', function () {
    fakeHatcherPool();
    $feed = app(ArenaMarketFeed::class);
    $spec = $feed->specification();
    config()->set('arena.market', 'base-weth-usdc');

    expect($feed->quote($spec, 90)['price_micros'])->toBe('216426');
});
