<?php

use App\Services\Heatmap\CryptoHeatmap;
use App\Services\Heatmap\CyberiaHeatmap;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Inertia\Testing\AssertableInertia;

/**
 * The market map: Cyberia's launches priced from their pools, with the day's
 * change read against a snapshot a day older, and the crypto market grouped
 * by CoinGecko's categories with stablecoins left out.
 */
const HEAT_V3 = '0x00000000000000000000000000000000000000a3';
const HEAT_TOKEN = '0x7911085dc26825349b0ce2518b72d49ff4a26ee8';
const HEAT_POOL = '0x00000000000000000000000000000000000000b1';
const HEAT_WCYBER = '0x78272aad03e4b9d7a9134e874ba6d419b534f6c9';

function heatWord(string $hex): string
{
    return str_pad(ltrim($hex, '0x') === '' ? '0' : substr($hex, 2), 64, '0', STR_PAD_LEFT);
}

function heatHex(float $value): string
{
    $hex = '';

    while ($value >= 1) {
        $hex = dechex((int) fmod($value, 16)).$hex;
        $value = floor($value / 16);
    }

    return '0x'.($hex === '' ? '0' : $hex);
}

function heatString(string $value): string
{
    return '0x'.heatWord('0x20').heatWord('0x'.dechex(strlen($value))).str_pad(bin2hex($value), 64, '0');
}

function fakeHeatChain(float $sqrtPrice): void
{
    // Read when the call is made: a second Http::fake would sit behind the first.
    config()->set('heatmap.test_sqrt_price', $sqrtPrice);

    Http::fake([
        'https://rpc.test' => function (Request $request) {
            $sqrtPrice = (float) config('heatmap.test_sqrt_price');
            $answers = [];

            foreach ($request->data() as $call) {
                $to = strtolower($call['params'][0]['to']);
                $data = $call['params'][0]['data'];
                $result = match (true) {
                    $to === HEAT_V3 && $data === '0xdbb80e42' => '0x'.heatWord('0x1'),
                    $to === HEAT_V3 && str_starts_with($data, '0x634282af') => '0x'.heatWord(HEAT_TOKEN),
                    $to === HEAT_V3 && str_starts_with($data, '0x988b1fa7') => '0x'.heatWord(HEAT_POOL),
                    $to === HEAT_TOKEN && $data === '0x95d89b41' => heatString('GAS'),
                    $to === HEAT_TOKEN && $data === '0x06fdde03' => heatString('Cyberia Gas'),
                    $to === HEAT_TOKEN && $data === '0x18160ddd' => '0x'.heatWord('0xd3c21bcecceda1000000'),
                    $to === HEAT_POOL && $data === '0x0dfe1681' => '0x'.heatWord(HEAT_WCYBER),
                    $to === HEAT_POOL && $data === '0x3850c7bd' => '0x'.heatWord(heatHex($sqrtPrice * 2 ** 96)).heatWord('0x0'),
                    default => null,
                };

                $answers[] = $result === null
                    ? ['jsonrpc' => '2.0', 'id' => $call['id'], 'error' => ['code' => -32000, 'message' => 'revert']]
                    : ['jsonrpc' => '2.0', 'id' => $call['id'], 'result' => $result];
            }

            return Http::response($answers);
        },
        '*' => Http::response([]),
    ]);
}

beforeEach(function () {
    Cache::flush();
    config()->set('heatmap.cyberia.rpc_url', 'https://rpc.test');
    config()->set('heatmap.cyberia.launchpads', ['v3' => HEAT_V3]);
    Cache::put('wallet.prices.v4', ['prices' => ['cyberia' => 0.5], 'tokens' => [], 'changes' => ['prices' => [], 'tokens' => []], 'fetchedAt' => now()->toIso8601String()], 300);
});

test('a launch is priced from its pool and its change is read against yesterday', function () {
    // WCYBER is token0, so the pool quotes GAS per CYBER: 4 → 0.25 CYBER a GAS.
    $this->travelTo(now()->subDay());
    fakeHeatChain(2.0);
    app(CyberiaHeatmap::class)->snapshot();

    $this->travelBack();
    // 6.25 GAS per CYBER → 0.16 CYBER a GAS: down 36%.
    fakeHeatChain(sqrt(6.25));
    expect(app(CyberiaHeatmap::class)->snapshot())->toBe(1);

    $map = app(CyberiaHeatmap::class)->map();
    $tile = $map['sectors'][0]['tiles'][0];

    expect($map['sectors'][0]['key'])->toBe('service')
        ->and($tile['symbol'])->toBe('GAS')
        ->and($tile['marketCap'])->toEqualWithDelta(1_000_000 * 0.16 * 0.5, 1e-6)
        ->and($tile['change'])->toEqualWithDelta(-36.0, 1e-6);
});

test('the first snapshot has no change rather than a zero one', function () {
    fakeHeatChain(2.0);
    app(CyberiaHeatmap::class)->snapshot();

    expect(app(CyberiaHeatmap::class)->map()['sectors'][0]['tiles'][0]['change'])->toBeNull();
});

test('the crypto map groups by category and leaves stablecoins out', function () {
    Cache::forever('heatmap.crypto.category.stablecoins', ['tether']);
    Cache::forever('heatmap.crypto.category.meme-token', ['dogecoin']);
    Cache::forever('heatmap.crypto.category.layer-1', ['bitcoin', 'dogecoin']);

    $map = app(CryptoHeatmap::class)->build([
        ['id' => 'bitcoin', 'symbol' => 'btc', 'name' => 'Bitcoin', 'market_cap' => 1e12, 'price_change_percentage_24h' => 1.5],
        ['id' => 'tether', 'symbol' => 'usdt', 'name' => 'Tether', 'market_cap' => 1e11, 'price_change_percentage_24h' => 0.0],
        ['id' => 'dogecoin', 'symbol' => 'doge', 'name' => 'Dogecoin', 'market_cap' => 1e10, 'price_change_percentage_24h' => -2],
        ['id' => 'mystery', 'symbol' => 'mys', 'name' => 'Mystery', 'market_cap' => 1e9, 'price_change_percentage_24h' => null],
    ]);

    expect(collect($map['sectors'])->mapWithKeys(fn ($s) => [$s['label'] => array_column($s['tiles'], 'symbol')])->all())
        ->toBe(['Memes' => ['DOGE'], 'L1' => ['BTC'], 'Other' => ['MYS']]);
});

test('the page renders both maps from what was stored', function () {
    $this->withoutVite();
    Http::fake(['*' => Http::response([])]);

    $this->get('/heatmap')
        ->assertOk()
        ->assertInertia(fn (AssertableInertia $page) => $page
            ->component('Heatmap')
            ->has('crypto.sectors')
            ->has('cyberia.sectors'));
});
