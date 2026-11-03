<?php

use App\Models\ArenaAgent;
use App\Services\Arena\ArenaLeague;
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

    $book = app(ArenaLeague::class)->book(ArenaAgent::query()->where('slug', 'lain-2')->sole());
    expect($book['counts']['trades'])->toBe(2)
        ->and($book['realized']['SOL'])->toBe('0.250000000000000000')
        ->and($book['realized_usd'])->toBe('50.000000000000000000')
        ->and($book['positions'][0]['qty'])->toBe('50000.000000000000000000')
        ->and($book['positions'][0]['mark_usd'])->toBe('0.00003');

    $this->get('/arena/agents/lain-2')->assertOk()->assertInertia(fn (AssertableInertia $page) => $page
        ->component('ArenaBoard')
        ->where('detail.agent.kind', 'open')
        ->where('detail.summary.trades', 2)
        ->where('detail.moves.0.txUrl', 'https://solscan.io/tx/sig2')
        ->where('board.agents.0.slug', 'lain-2'));
    $this->getJson('/api/arena/agents/lain-2')->assertOk()->assertJsonPath('summary.trades', 2);
    $this->getJson('/api/arena')->assertOk()->assertJsonPath('feed.0.agent', 'lain-2')->assertJsonPath('feed.0.side', 'sell')
        ->assertJsonPath('agents.0.holdings.0.symbol', 'HATCHER');
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
        ->and(app(ArenaLeague::class)->book(ArenaAgent::query()->sole())['realized']['ETH'])->toBe('-0.002000000000000000');
});

it('lets an agent register and report trades over MCP', function () {
    $rpc = fn (string $method, array $params = [], int $id = 1) => $this->postJson('/api/arena/mcp',
        ['jsonrpc' => '2.0', 'id' => $id, 'method' => $method, 'params' => $params])->assertOk();

    $rpc('initialize', ['protocolVersion' => '2025-06-18'])->assertJsonPath('result.serverInfo.name', 'cyberia-arena');
    $this->postJson('/api/arena/mcp', ['jsonrpc' => '2.0', 'method' => 'notifications/initialized'])->assertStatus(202);
    expect(collect($rpc('tools/list')->json('result.tools'))->pluck('name')->all())
        ->toBe(['arena_guide', 'register_agent', 'report_trades', 'leaderboard', 'agent_record']);

    $key = $rpc('tools/call', ['name' => 'register_agent', 'arguments' => ['name' => 'Hatcher Agent', 'framework' => 'Hatcher']])
        ->json('result.structuredContent.key');
    $rpc('tools/call', ['name' => 'report_trades', 'arguments' => ['key' => $key, 'trades' => [['id' => 'p1', 'side' => 'buy',
        'chain' => 'solana', 'token' => 'Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump', 'symbol' => 'HATCHER', 'qty' => '1000',
        'quote' => ['symbol' => 'USDC', 'amount' => '25'], 'paper' => true]]]])
        ->assertJsonPath('result.isError', false)->assertJsonPath('result.structuredContent.accepted', 1);
    $rpc('tools/call', ['name' => 'agent_record', 'arguments' => ['slug' => 'hatcher-agent']])
        ->assertJsonPath('result.structuredContent.counts.trades', 1);
    $rpc('tools/call', ['name' => 'report_trades', 'arguments' => ['key' => 'arena_wrong', 'trades' => []]])
        ->assertJsonPath('result.isError', true);
});
