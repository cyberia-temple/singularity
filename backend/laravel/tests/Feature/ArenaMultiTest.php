<?php

use App\Models\ArenaSeason;
use App\Services\Arena\ArenaAutomation;
use App\Services\Arena\ArenaMultiAutomation;
use App\Services\Arena\ArenaSeasonManager;
use App\Services\Arena\MultiLedger;
use Carbon\CarbonImmutable;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Inertia\Testing\AssertableInertia;

beforeEach(function () {
    $this->withoutVite();
    CarbonImmutable::setTestNow(CarbonImmutable::parse('2026-11-03T00:00:10Z'));
    config()->set('arena.enabled', true);
    config()->set('arena.slug', 'hatcher-cup');
    config()->set('arena.partner', 'hatcher');
    config()->set('arena.automation.enabled', true);
    config()->set('arena.automation.api_key', 'test-only-not-a-real-key');
    config()->set('arena.automation.models', ['lain' => 'fixture/lain:free', 'challenger' => 'fixture/challenger:free']);
    Http::preventStrayRequests();
    $GLOBALS['arenaFaked'] = false;
    unset($GLOBALS['arenaLainDecision']);
});

afterEach(function () {
    CarbonImmutable::setTestNow();
});

function multiArena(): ArenaSeason
{
    $rules = ArenaMultiAutomation::rules();
    $start = CarbonImmutable::parse('2026-11-03T00:00:00Z');

    return ArenaSeason::query()->create(['slug' => 'hatcher-cup', 'title' => 'Hatcher Cup', 'starts_at' => $start,
        'ends_at' => $start->addDays(14), 'rules' => $rules, 'rules_hash' => app(ArenaSeasonManager::class)->digest($rules)]);
}

function fakeMultiMarket(string $hatcher = '0.00002'): void
{
    $GLOBALS['arenaHatcherPrice'] = $hatcher;
    if ($GLOBALS['arenaFaked'] ?? false) {
        return;
    }
    $GLOBALS['arenaFaked'] = true;
    Http::fake(function (Request $request) {
        $hatcher = $GLOBALS['arenaHatcherPrice'];
        if ($request->url() === 'https://api.dexscreener.com/token-boosts/top/v1') {
            return Http::response([['chainId' => 'base', 'tokenAddress' => '0xabc'], ['chainId' => 'solana', 'tokenAddress' => 'Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump']]);
        }
        if (str_starts_with($request->url(), 'https://api.dexscreener.com/')) {
            $pair = fn (string $mint, string $price, int $liquidity) => ['chainId' => 'solana', 'dexId' => 'pumpswap',
                'pairAddress' => 'pair'.substr($mint, 0, 4), 'baseToken' => ['address' => $mint, 'symbol' => $mint === 'Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump' ? 'HATCHER' : 'SOL'], 'priceUsd' => $price,
                'liquidity' => ['usd' => $liquidity], 'priceChange' => ['h24' => 1.5]];

            return Http::response([
                $pair('So11111111111111111111111111111111111111112', '150', 9000000),
                $pair('Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump', $hatcher, 13000),
                $pair('Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump', '1', 100), // too shallow to trust
            ]);
        }
        $lain = $request['model'] === 'fixture/lain:free';
        $decision = $lain && isset($GLOBALS['arenaLainDecision']) ? $GLOBALS['arenaLainDecision'] : ($lain ? ['action' => 'buy', 'token' => '$hatcher', 'bps' => 5000, 'reason' => 'Partner token, half size.']
            : ['action' => 'hold', 'token' => null, 'bps' => 0, 'reason' => 'Waiting.']);

        return Http::response(['model' => $request['model'], 'choices' => [['finish_reason' => 'stop', 'message' => ['content' => json_encode($decision)]]]]);
    });
}

it('commits decisions, fills them later and records the trade', function () {
    $season = multiArena();
    fakeMultiMarket();
    expect(app(ArenaAutomation::class)->tick())->toBe('awaiting_fill');

    CarbonImmutable::setTestNow(CarbonImmutable::parse('2026-11-03T00:04:30Z'));
    fakeMultiMarket('0.000025');
    expect(app(ArenaAutomation::class)->tick())->toBe('complete');

    $round = $season->rounds()->sole();
    $lain = $round->result['actors']['lain'];
    expect($lain['trade'])->toMatchArray(['action' => 'buy', 'token' => 'Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump', 'symbol' => 'HATCHER', 'price' => '0.000025'])
        ->and(bccomp($lain['state']['cash'], '500', 6))->toBe(0)
        ->and($round->result['actors']['challenger']['trade'])->toBeNull()
        ->and($round->result['prices']['Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump'])->toBe('0.000025')
        ->and($round->result['benchmark']['state']['positions'])->toHaveKey('So11111111111111111111111111111111111111112');
});

it('sells against the cost basis and reports realized profit', function () {
    $ledger = new MultiLedger;
    $costs = ['fee_bps' => 0, 'slippage_bps' => 0];
    [$state] = $ledger->apply($ledger->initial('1000'), ['action' => 'buy', 'token' => 'SOL', 'bps' => 10000], ['SOL' => '100'], $costs);
    [$state, $trade] = $ledger->apply($state, ['action' => 'sell', 'token' => 'SOL', 'bps' => 5000], ['SOL' => '120'], $costs);

    expect(bccomp($trade['realized'], '100', 6))->toBe(0)
        ->and(bccomp($state['cash'], '600', 6))->toBe(0)
        ->and(bccomp($ledger->equity($state, ['SOL' => '120'], $costs), '1200', 6))->toBe(0);

    $ledger->apply($state, ['action' => 'sell', 'token' => 'JUP', 'bps' => 2500], ['JUP' => '1'], $costs);
})->throws(DomainException::class, 'insufficient_position');

it('renders the leaderboard and an agent page', function () {
    multiArena();
    $this->get('/arena')->assertOk()->assertInertia(fn (AssertableInertia $page) => $page->component('ArenaMulti')
        ->where('agent', null)->where('rules.partner.slug', 'hatcher')->where('rules.universe', 'any')->has('rules.anchors', 2));
    $this->get('/arena/agents/lain')->assertOk()->assertInertia(fn (AssertableInertia $page) => $page->component('ArenaMulti')->where('agent', 'lain'));
    $this->get('/arena/agents/nobody')->assertNotFound();
});

it('takes any mint, but refuses a ticker that is not on the board', function () {
    $season = multiArena();
    fakeMultiMarket();
    $GLOBALS['arenaLainDecision'] = ['action' => 'buy', 'token' => 'NOTONBOARD', 'bps' => 2500, 'reason' => 'Unknown ticker.'];
    app(ArenaAutomation::class)->tick();

    expect($season->cycles()->sole()->record['attempts']['lain']['status'])->toBe('failed')
        ->and($season->cycles()->sole()->record['attempts']['challenger']['status'])->toBe('ok');
});

it('records why a model call failed and accepts the dated slug OpenRouter serves', function () {
    $season = multiArena();
    Http::fake(function (Request $request) {
        if ($request->url() === 'https://api.dexscreener.com/token-boosts/top/v1') {
            return Http::response([]);
        }
        if (str_starts_with($request->url(), 'https://api.dexscreener.com/')) {
            return Http::response([['chainId' => 'solana', 'baseToken' => ['address' => 'So11111111111111111111111111111111111111112', 'symbol' => 'SOL'],
                'priceUsd' => '150', 'liquidity' => ['usd' => 9000000]]]);
        }
        if ($request['model'] === 'fixture/challenger:free') {
            return Http::response(['error' => ['message' => 'No endpoints found']], 404);
        }

        return Http::response(['model' => 'fixture/lain-20261015', 'choices' => [['finish_reason' => 'stop',
            'message' => ['content' => json_encode(['action' => 'hold', 'token' => null, 'bps' => 0, 'reason' => 'Waiting.'])]]]]);
    });
    app(ArenaAutomation::class)->tick();

    $attempts = $season->cycles()->sole()->record['attempts'];
    expect($attempts['lain']['status'])->toBe('ok')
        ->and($attempts['challenger']['error_detail'])->toBe('model_http_404');
});

it('retries a per-minute 429 and names the daily free allowance when it runs out', function () {
    config()->set('arena.automation.retry_microseconds', 0);
    $season = multiArena();
    $GLOBALS['arenaCalls'] = 0;
    Http::fake(function (Request $request) {
        if ($request->url() === 'https://api.dexscreener.com/token-boosts/top/v1') {
            return Http::response([]);
        }
        if (str_starts_with($request->url(), 'https://api.dexscreener.com/')) {
            return Http::response([['chainId' => 'solana', 'baseToken' => ['address' => 'So11111111111111111111111111111111111111112', 'symbol' => 'SOL'],
                'priceUsd' => '150', 'liquidity' => ['usd' => 9000000]]]);
        }
        if ($request['model'] === 'fixture/challenger:free') {
            return Http::response(['error' => ['message' => 'Rate limit exceeded: free-models-per-day. Add 10 credits']], 429);
        }
        if (++$GLOBALS['arenaCalls'] === 1) {
            return Http::response(['error' => ['message' => 'Rate limit exceeded: free-models-per-min.']], 429);
        }

        return Http::response(['model' => 'fixture/lain', 'choices' => [['finish_reason' => 'stop',
            'message' => ['content' => json_encode(['action' => 'hold', 'token' => null, 'bps' => 0, 'reason' => 'Waiting.'])]]]]);
    });
    app(ArenaAutomation::class)->tick();

    $attempts = $season->cycles()->sole()->record['attempts'];
    expect($attempts['lain']['status'])->toBe('ok')
        ->and($attempts['challenger']['error_detail'])->toBe('model_http_429_daily');
});
