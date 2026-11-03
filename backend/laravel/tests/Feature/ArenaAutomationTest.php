<?php

use App\Models\ArenaCycle;
use App\Models\ArenaRound;
use App\Models\ArenaSeason;
use App\Services\Arena\ArenaAutomation;
use App\Services\Arena\ArenaMarketFeed;
use App\Services\Arena\ArenaModelClient;
use App\Services\Arena\ArenaSeasonManager;
use Carbon\CarbonImmutable;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Inertia\Testing\AssertableInertia;

beforeEach(function () {
    $this->withoutVite();
    CarbonImmutable::setTestNow(CarbonImmutable::parse('2026-10-01T12:00:00Z'));
    config()->set('app.key', 'base64:'.base64_encode(str_repeat('a', 32)));
    config()->set('arena.enabled', true);
    config()->set('arena.slug', 'season-zero');
    config()->set('arena.automation.enabled', true);
    config()->set('arena.automation.api_key', 'test-only-not-a-real-key');
    config()->set('arena.automation.models', ['lain' => 'fixture/lain:free', 'challenger' => 'fixture/challenger:free']);
    Http::preventStrayRequests();
});

afterEach(function () {
    CarbonImmutable::setTestNow();
});

function fakeArenaMarket(?Closure $change = null, ?Closure $modelResponse = null): void
{
    Http::fake(function (Request $request) use ($change, $modelResponse) {
        if ($request->url() === 'https://openrouter.ai/api/v1/chat/completions') {
            $model = $request['model'];
            $decision = ['action' => $model === 'fixture/lain:free' ? 'buy' : 'hold',
                'bps' => $model === 'fixture/lain:free' ? 5000 : 0, 'reason' => 'Public fixture rationale'];
            $result = ['model' => $model, 'choices' => [['finish_reason' => 'stop', 'message' => ['content' => json_encode($decision)]]]];

            return $modelResponse ? $modelResponse($result, $request) : Http::response($result);
        }
        $spec = app(ArenaMarketFeed::class)->specification();
        $word = fn (string $value): string => str_pad($value, 64, '0', STR_PAD_LEFT);
        $head = ['number' => '0x100', 'hash' => '0x'.str_repeat('a', 64),
            'timestamp' => '0x'.dechex(CarbonImmutable::now()->subSeconds(2)->getTimestamp())];
        $rows = [];
        foreach ($request->data() as $call) {
            $method = $call['method'];
            $params = $call['params'];
            $result = match ($method) {
                'eth_chainId' => '0x2105',
                'eth_getBlockByNumber' => $head,
                'eth_call' => match (substr($params[0]['data'], 0, 10)) {
                    '0x1698ee82' => '0x'.$word(substr($spec['pool'], 2)),
                    '0x0dfe1681' => '0x'.$word(substr($spec['token0'], 2)),
                    '0xd21220a7' => '0x'.$word(substr($spec['token1'], 2)),
                    '0xddca3f43' => '0x'.$word('1f4'),
                    '0x3850c7bd' => '0x'.$word('2ee4cc6d5cdcef8c522f2').str_repeat($word('0'), 5).$word('1'),
                    '0x1a686502' => '0x'.$word('100000'),
                    '0x313ce567' => '0x'.$word($params[0]['to'] === $spec['token0'] ? '12' : '6'),
                },
            };
            $rows[] = ['jsonrpc' => '2.0', 'id' => $call['id'], 'result' => $change ? $change($result, $call) : $result];
        }

        return Http::response($rows);
    });
}

function automaticArena(): ArenaSeason
{
    return app(ArenaSeasonManager::class)->create('season-zero', CarbonImmutable::now('UTC'), true);
}

it('requires explicit model identities and freezes settings without secrets or network calls', function () {
    $season = automaticArena();
    expect($season->rules['mode'])->toBe('automatic-paper')->and($season->rules['automation']['max_calls'])->toBe(112)
        ->and(json_encode($season->rules))->not->toContain('test-only-not-a-real-key', 'rpc_url', 'api_key');
    Http::assertNothingSent();
    config()->set('arena.automation.models.lain', 'openrouter/free');
    expect(fn () => app(ArenaSeasonManager::class)->create('another-season', null, true))->toThrow(DomainException::class);
});

it('does not switch an imported draft into an automatic season', function () {
    $manager = app(ArenaSeasonManager::class);
    $manager->create('season-zero');
    expect(fn () => automaticArena())->toThrow(DomainException::class);
});

it('verifies exact pool state and rejects a stale, wrong-chain or wrong-token quote', function (string $failure) {
    fakeArenaMarket(function ($result, $call) use ($failure) {
        if ($failure === 'chain' && $call['method'] === 'eth_chainId') {
            return '0x1';
        }
        if ($failure === 'stale' && $call['method'] === 'eth_getBlockByNumber') {
            $result['timestamp'] = '0x'.dechex(CarbonImmutable::now()->subMinutes(5)->getTimestamp());
        }
        if ($failure === 'token' && ($call['params'][0]['data'] ?? null) === '0xd21220a7') {
            return '0x'.str_repeat('0', 64);
        }

        return $result;
    });
    $market = app(ArenaMarketFeed::class);
    expect(fn () => $market->quote($market->specification(), 90))->toThrow(DomainException::class);
})->with(['chain', 'stale', 'token']);

it('commits both model decisions before a later fill and keeps evidence hashes reproducible', function () {
    fakeArenaMarket();
    $season = automaticArena();
    $runner = app(ArenaAutomation::class);
    expect($runner->tick())->toBe('awaiting_fill')->and(ArenaRound::query()->count())->toBe(0);
    $cycle = $season->cycles()->sole();
    expect($cycle->record['attempts']['lain']['status'])->toBe('ok')->and($cycle->reserved_calls)->toBe(2)
        ->and($cycle->reserved_cents)->toBe(0)->and($cycle->commit_hash)->toBe(app(ArenaSeasonManager::class)->digest($cycle->record));
    $calls = count(Http::recorded());
    expect($runner->tick())->toBe('awaiting_fill');
    expect(count(Http::recorded()))->toBe($calls);
    CarbonImmutable::setTestNow(CarbonImmutable::now()->addMinutes(4)->addSeconds(3));
    expect($runner->tick())->toBe('complete');
    $round = $season->rounds()->sole();
    $manager = app(ArenaSeasonManager::class);
    expect($round->record_hash)->toBe($manager->digest(['rules_hash' => $season->rules_hash, 'previous_hash' => null,
        'evidence' => $round->evidence, 'result' => $round->result]))
        ->and($round->payload_hash)->toBe($manager->digest($round->evidence))
        ->and($cycle->fresh()->commit_hash)->toBe($cycle->commit_hash)
        ->and($round->evidence['automation']['record']['decisions'])->toBe($cycle->record['decisions']);
    $calls = count(Http::recorded());
    expect($runner->tick())->toBe('slot_already_recorded')->and(count(Http::recorded()))->toBe($calls);
    Http::assertSent(fn (Request $request) => $request->url() === 'https://openrouter.ai/api/v1/chat/completions'
        && $request['max_tokens'] === 400 && $request['provider']['allow_fallbacks'] === false
        && $request['provider']['max_price'] === ['prompt' => 0, 'completion' => 0, 'request' => 0]
        && ! isset($request['tools']) && ! isset($request['models']));
});

it('does not run when disabled, before the start, or without an explicit key', function () {
    $season = automaticArena();
    config()->set('arena.automation.enabled', false);
    expect(app(ArenaAutomation::class)->tick())->toBe('disabled');
    config()->set('arena.automation.enabled', true);
    CarbonImmutable::setTestNow($season->starts_at->subMinute());
    expect(app(ArenaAutomation::class)->tick())->toBe('not_started');
    CarbonImmutable::setTestNow($season->starts_at);
    config()->set('arena.automation.api_key', null);
    expect(app(ArenaAutomation::class)->tick())->toBe('missing_model_key');
    Http::assertNothingSent();
});

it('does not repeat model requests after a crash or after their deadline', function () {
    $season = automaticArena();
    $cycle = ArenaCycle::factory()->create(['arena_season_id' => $season->id, 'reserved_cents' => 0, 'reserved_calls' => 2]);
    expect(app(ArenaAutomation::class)->tick())->toBe('collecting');
    CarbonImmutable::setTestNow(CarbonImmutable::now()->addMinutes(3));
    expect(app(ArenaAutomation::class)->tick())->toBe('decision_incomplete')
        ->and($cycle->fresh()->status)->toBe('skipped')->and($cycle->fresh()->reserved_cents)->toBe(0);
    Http::assertNothingSent();
});

it('records missed slots without inventing historical decisions', function () {
    $season = automaticArena();
    CarbonImmutable::setTestNow($season->starts_at->addHours(12)->addMinutes(2));
    expect(app(ArenaAutomation::class)->tick())->toBe('opening_window_missed')
        ->and($season->cycles()->count())->toBe(3)->and($season->cycles()->sum('reserved_calls'))->toBe(0);
    Http::assertNothingSent();
});

it('counts failed free requests against the bounded call allowance', function () {
    fakeArenaMarket(null, fn () => Http::response(['error' => 'fixture'], 429));
    $season = automaticArena();
    expect(app(ArenaAutomation::class)->tick())->toBe('both_models_failed')->and($season->cycles()->sum('reserved_cents'))->toBe(0);
    config()->set('arena.automation.max_calls', 3);
    CarbonImmutable::setTestNow($season->starts_at->addHours(6));
    expect(app(ArenaAutomation::class)->tick())->toBe('budget_exhausted')->and($season->cycles()->sum('reserved_calls'))->toBe(2);
    expect(Http::recorded(fn (Request $request) => str_contains($request->url(), 'openrouter.ai')))->toHaveCount(2);
});

it('makes a single model failure explicit while retaining the other decision', function () {
    fakeArenaMarket(null, fn ($result, Request $request) => $request['model'] === 'fixture/lain:free'
        ? Http::response(['error' => 'fixture'], 500) : Http::response($result));
    $season = automaticArena();
    expect(app(ArenaAutomation::class)->tick())->toBe('awaiting_fill');
    $cycle = $season->cycles()->sole();
    expect($cycle->record['attempts']['lain']['status'])->toBe('failed')
        ->and($cycle->record['decisions']['lain']['action'])->toBe('hold')
        ->and($cycle->record['decisions']['lain']['reason'])->toContain('failure fallback')
        ->and($cycle->record['attempts']['challenger']['status'])->toBe('ok');
});

it('skips a missed fill instead of executing old orders at a convenient later price', function () {
    fakeArenaMarket();
    $season = automaticArena();
    app(ArenaAutomation::class)->tick();
    $calls = count(Http::recorded());
    CarbonImmutable::setTestNow($season->starts_at->addMinutes(8));
    expect(app(ArenaAutomation::class)->tick())->toBe('fill_window_missed')->and(ArenaRound::query()->count())->toBe(0)
        ->and(count(Http::recorded()))->toBe($calls);
});

it('refuses tampered decisions and operator imports into an automatic season', function () {
    fakeArenaMarket();
    $season = automaticArena();
    app(ArenaAutomation::class)->tick();
    $cycle = $season->cycles()->sole();
    $record = $cycle->record;
    $record['decisions']['lain']['bps'] = 10000;
    $cycle->update(['record' => $record]);
    CarbonImmutable::setTestNow($season->starts_at->addMinutes(4)->addSeconds(3));
    expect(app(ArenaAutomation::class)->tick())->toBe('automation_failed')->and(ArenaRound::query()->count())->toBe(0);
    expect(fn () => app(ArenaSeasonManager::class)->import($season, [], CarbonImmutable::now()))->toThrow(DomainException::class);
});

it('reads a reproducible integer reference price even when JSON object keys are reordered', function () {
    fakeArenaMarket();
    $market = app(ArenaMarketFeed::class);
    $spec = array_reverse($market->specification(), true);
    $quote = $market->quote($spec, 90);
    expect($quote['price_micros'])->toBe('1999999999')->and($quote['source']['block_number'])->toBe('256');
});

it('never resurrects a collecting cycle that another process has skipped', function () {
    fakeArenaMarket(null, function ($result, Request $request) {
        if ($request['model'] === 'fixture/challenger:free') {
            ArenaCycle::query()->update(['status' => 'skipped', 'error_code' => 'decision_incomplete']);
        }

        return Http::response($result);
    });
    $season = automaticArena();
    expect(app(ArenaAutomation::class)->tick())->toBe('decision_incomplete')
        ->and($season->cycles()->sole()->status)->toBe('skipped')->and(ArenaRound::query()->count())->toBe(0);
});

it('rejects late commitments even when their content hash has been recomputed', function () {
    fakeArenaMarket();
    $season = automaticArena();
    app(ArenaAutomation::class)->tick();
    $cycle = $season->cycles()->sole();
    $record = $cycle->record;
    $record['committed_at'] = $cycle->decision_at->addSecond()->toIso8601String();
    $cycle->update(['record' => $record, 'commit_hash' => app(ArenaSeasonManager::class)->digest($record)]);
    CarbonImmutable::setTestNow($cycle->fill_due_at->addSeconds(3));
    expect(app(ArenaAutomation::class)->tick())->toBe('automation_failed')->and(ArenaRound::query()->count())->toBe(0);
});

it('rejects an unfunded model order without rewriting its committed decision or blocking the round', function () {
    fakeArenaMarket(null, function ($result, Request $request) {
        if ($request['model'] === 'fixture/challenger:free') {
            $result['choices'][0]['message']['content'] = json_encode(['action' => 'sell', 'bps' => 10000, 'reason' => 'An unfunded fixture order']);
        }

        return Http::response($result);
    });
    $season = automaticArena();
    app(ArenaAutomation::class)->tick();
    CarbonImmutable::setTestNow($season->starts_at->addMinutes(4)->addSeconds(3));
    expect(app(ArenaAutomation::class)->tick())->toBe('complete');
    $round = $season->rounds()->sole();
    expect($round->evidence['decisions']['challenger']['action'])->toBe('sell')
        ->and($round->result['actors']['challenger']['execution'])->toBe('rejected')
        ->and($round->result['actors']['challenger']['balance'])->toBe(['cash' => '1000000000', 'asset' => '0']);
});

it('publishes pending commitments and failure state without exposing credentials or private agent tools', function () {
    fakeArenaMarket();
    automaticArena();
    app(ArenaAutomation::class)->tick();
    $response = $this->get('/arena')->assertSuccessful()->assertInertia(fn (AssertableInertia $page) => $page
        ->where('automation.enabled', true)->where('automation.reservedCents', 0)->where('automation.cycles.0.status', 'awaiting_fill')
        ->where('automation.cycles.0.attempts.lain', 'ok')->has('automation.cycles.0.commitHash'));
    expect($response->getContent())->not->toContain('test-only-not-a-real-key');
    $export = $this->get('/arena/evidence')->assertSuccessful()->assertJsonPath('format', 'cyberia-arena-automatic-paper-v2');
    expect($export->getContent())->not->toContain('test-only-not-a-real-key', 'Authorization');
});

it('does not retry truncated, wrong-model or tool-bearing responses', function (string $failure) {
    fakeArenaMarket(null, function ($result) use ($failure) {
        if ($failure === 'truncated') {
            $result['choices'][0]['finish_reason'] = 'length';
        } elseif ($failure === 'model') {
            $result['model'] = 'fixture/undeclared-model';
        } else {
            $result['choices'][0]['message']['tool_calls'] = [['name' => 'transfer']];
        }

        return Http::response($result);
    });
    automaticArena();
    expect(app(ArenaAutomation::class)->tick())->toBe('both_models_failed')
        ->and(Http::recorded(fn (Request $request) => str_contains($request->url(), 'openrouter.ai')))->toHaveCount(2);
})->with(['truncated', 'model', 'tools']);

it('rejects paid or routed model IDs before any inference request', function (string $model) {
    $rules = automaticArena()->rules;
    $rules['automation']['models']['lain'] = $model;
    expect(fn () => app(ArenaModelClient::class)->decide('lain', $rules, []))->toThrow(DomainException::class);
    config()->set('arena.automation.models.lain', $model);
    expect(fn () => app(ArenaSeasonManager::class)->rules(true))->toThrow(DomainException::class);
    Http::assertNothingSent();
})->with(['fixture/paid', 'openrouter/free', 'openrouter/auto', 'fixture/model:free:online']);

it('refuses nonzero provider prices even for a free model ID', function () {
    $rules = automaticArena()->rules;
    $rules['automation']['max_price_per_million'] = 1;
    expect(fn () => app(ArenaModelClient::class)->decide('lain', $rules, []))->toThrow(DomainException::class);
    Http::assertNothingSent();
});

it('blocks an intact older paid season without rewriting its rules or making calls', function () {
    $season = automaticArena();
    $rules = $season->rules;
    unset($rules['automation']['pricing_policy']);
    $rules['automation']['models']['lain'] = 'fixture/paid';
    $hash = app(ArenaSeasonManager::class)->digest($rules);
    $season->update(['rules' => $rules, 'rules_hash' => $hash]);
    expect(app(ArenaAutomation::class)->tick())->toBe('free_models_required')
        ->and($season->fresh()->rules_hash)->toBe($hash)->and($season->cycles()->count())->toBe(0);
    Http::assertNothingSent();
});

it('accepts a canonical served identity while keeping the requested free variant in the record', function () {
    fakeArenaMarket(null, function ($result) {
        $result['model'] = substr($result['model'], 0, -5);

        return Http::response($result);
    });
    $season = automaticArena();
    expect(app(ArenaAutomation::class)->tick())->toBe('awaiting_fill');
    $attempt = $season->cycles()->sole()->record['attempts']['lain'];
    expect($attempt['served_model'])->toBe('fixture/lain')->and($attempt['decision']['model'])->toBe('fixture/lain:free');
});

it('asks a groq contestant on the Groq free-tier key, without OpenRouter fields', function () {
    config()->set('ai.providers.groq', ['api_key' => 'groq-test-key', 'base_url' => 'https://api.groq.com/openai/v1']);
    $rules = automaticArena()->rules;
    $rules['automation']['models']['lain'] = 'groq/llama-3.3-70b-versatile';
    Http::fake(['https://api.groq.com/openai/v1/chat/completions' => Http::response([
        'model' => 'llama-3.3-70b-versatile',
        'choices' => [['finish_reason' => 'stop', 'message' => ['content' => json_encode(['action' => 'hold', 'bps' => 0, 'reason' => 'Fixture'])]]],
    ])]);

    $result = app(ArenaModelClient::class)->decide('lain', $rules, []);

    expect($result['decision']['action'])->toBe('hold');
    Http::assertSent(fn (Request $request) => $request->url() === 'https://api.groq.com/openai/v1/chat/completions'
        && $request['model'] === 'llama-3.3-70b-versatile'
        && ! isset($request['provider'], $request['reasoning'])
        && $request->hasHeader('Authorization', 'Bearer groq-test-key'));
});

it('needs the OpenRouter key only for the models that go through OpenRouter', function () {
    config()->set('ai.providers.groq', ['api_key' => 'groq-test-key', 'base_url' => 'https://api.groq.com/openai/v1']);
    config()->set('arena.automation.api_key', null);
    expect(ArenaModelClient::hasKeysFor(['lain' => 'groq/openai/gpt-oss-120b', 'challenger' => 'groq/qwen/qwen3-32b']))->toBeTrue()
        ->and(ArenaModelClient::hasKeysFor(['lain' => 'groq/openai/gpt-oss-120b', 'challenger' => 'fixture/challenger:free']))->toBeFalse();
    config()->set('ai.providers.groq.api_key', null);
    expect(ArenaModelClient::hasKeysFor(['lain' => 'groq/openai/gpt-oss-120b', 'challenger' => 'groq/qwen/qwen3-32b']))->toBeFalse();
});

it('refuses a groq contestant when there is no Groq key', function () {
    config()->set('ai.providers.groq', ['api_key' => null, 'base_url' => 'https://api.groq.com/openai/v1']);
    $rules = automaticArena()->rules;
    $rules['automation']['models']['lain'] = 'groq/llama-3.3-70b-versatile';
    expect(fn () => app(ArenaModelClient::class)->decide('lain', $rules, []))->toThrow(DomainException::class);
    Http::assertNothingSent();
});
