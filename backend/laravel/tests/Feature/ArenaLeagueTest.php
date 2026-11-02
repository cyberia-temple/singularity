<?php

use App\Models\ArenaAgent;
use Illuminate\Support\Facades\Http;
use Inertia\Testing\AssertableInertia;

beforeEach(function () {
    $this->withoutVite();
    config()->set('arena.enabled', true);
    Http::preventStrayRequests();
    Http::fake([
        'api.coingecko.com/*' => Http::response(['solana' => ['usd' => 200], 'ethereum' => ['usd' => 3000]]),
        'api.dexscreener.com/tokens/v1/solana/*' => Http::response([['chainId' => 'solana',
            'baseToken' => ['address' => 'Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump'], 'priceUsd' => '0.00003', 'liquidity' => ['usd' => 20000]]]),
        '*' => Http::response([], 404),
    ]);
});

function registerAgent(): array
{
    return test()->postJson('/api/arena/agents', ['name' => 'Lain', 'framework' => 'LainOS'])->assertCreated()->json();
}

it('registers an agent, shows its key once and never takes a reserved slug', function () {
    $body = registerAgent();

    expect($body['agent']['slug'])->toBe('lain-2')
        ->and($body['key'])->toStartWith('arena_')
        ->and(ArenaAgent::query()->sole()->key_hash)->toBe(hash('sha256', $body['key']));
});

it('records trades once, computes the basis and renders the agent page', function () {
    $key = registerAgent()['key'];
    $trade = fn (string $id, string $side, string $qty, string $sol, ?string $at = null) => ['id' => $id, 'side' => $side,
        'chain' => 'solana', 'token' => 'Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump', 'symbol' => 'HATCHER',
        'qty' => $qty, 'quote' => ['symbol' => 'SOL', 'amount' => $sol], 'tx' => 'sig'.$id, 'at' => $at];

    $this->withToken($key)->postJson('/api/arena/trades', ['trades' => [
        $trade('1', 'buy', '100000', '1', now()->subHour()->toIso8601String()),
        $trade('2', 'sell', '50000', '0.75'),
    ]])->assertOk()->assertJson(['accepted' => 2, 'duplicates' => 0]);
    $this->withToken($key)->postJson('/api/arena/trades', $trade('2', 'sell', '50000', '0.75'))
        ->assertOk()->assertJson(['accepted' => 0, 'duplicates' => 1]);

    $this->get('/arena/agents/lain-2')->assertOk()->assertInertia(fn (AssertableInertia $page) => $page
        ->component('ArenaLeagueAgent')
        ->where('book.counts.trades', 2)
        ->where('book.realized.SOL', '0.250000000000000000')
        ->where('book.realized_usd', '50.000000000000000000')
        ->where('book.positions.0.qty', '50000.000000000000000000')
        ->where('book.positions.0.mark_usd', '0.00003')
        ->where('book.trades.0.tx_url', 'https://solscan.io/tx/sig2'));
});

it('refuses an unknown key and an unsupported chain', function () {
    $this->withToken('arena_nope')->postJson('/api/arena/trades', [])->assertUnauthorized();
    $key = registerAgent()['key'];
    $this->withToken($key)->postJson('/api/arena/trades', ['id' => 'x', 'side' => 'buy', 'chain' => 'tron',
        'token' => 'So11111111111111111111111111111111111111112', 'symbol' => 'SOL', 'qty' => '1',
        'quote' => ['symbol' => 'USDC', 'amount' => '200']])->assertUnprocessable()->assertJsonValidationErrors('trades.0.chain');
});

it('takes raw units the way a LainOS journal stores them', function () {
    $key = registerAgent()['key'];
    $this->withToken($key)->postJson('/api/arena/trades', ['trades' => [['id' => '4663:paper-main:paper-1', 'side' => 'sell',
        'chain' => '4663', 'token' => '0x2b79A071a75dd40f1aca68146d7978204eFD156A', 'symbol' => 'LAIN',
        'qty_raw' => '2500000000000000000', 'decimals' => 18,
        'quote' => ['symbol' => 'ETH', 'amount_raw' => '10000000000000000', 'decimals' => 18],
        'realized' => '-0.002', 'paper' => true, 'at' => 1762000000000]]])->assertOk()->assertJson(['accepted' => 1]);

    expect(ArenaAgent::query()->sole()->trades()->sole())
        ->qty->toBe('2.5')->quote_amount->toBe('0.01')->chain->toBe('robinhood')->token->toBe('0x2b79a071a75dd40f1aca68146d7978204efd156a')
        ->and($this->get('/arena/agents/lain-2')->inertiaProps('book.realized.ETH'))->toBe('-0.002000000000000000');
});
