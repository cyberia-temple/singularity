<?php

use App\Models\ArenaComment;
use App\Models\ArenaFollower;
use App\Models\ArenaRound;
use App\Models\ArenaSeason;
use App\Models\User;
use App\Services\Arena\ArenaSeasonManager;
use App\Services\Arena\PaperLedger;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Validation\ValidationException;
use Inertia\Testing\AssertableInertia as Assert;

beforeEach(function () {
    $this->withoutVite();
    config()->set('app.key', 'base64:'.base64_encode(str_repeat('a', 32)));
    config()->set('arena.enabled', true);
    config()->set('arena.slug', 'season-zero');
    config()->set('crm.admin_user_ids', []);
    config()->set('crm.admin_wallets', []);
    Http::preventStrayRequests();
});

function arenaPayload(int $sequence = 1): array
{
    return [
        'sequence' => $sequence,
        'decision_at' => '2026-10-01T12:00:00Z',
        'filled_at' => '2026-10-01T12:02:00Z',
        'price_micros' => '2000000000',
        'source' => ['chain_id' => 8453, 'block_number' => '12345678', 'block_hash' => '0x'.str_repeat('1', 64), 'label' => 'Test fixture, not real market data'],
        'decisions' => [
            'lain' => ['action' => 'buy', 'bps' => 10000, 'reason' => 'Fixture decision', 'model' => 'fixture-model'],
            'challenger' => ['action' => 'hold', 'bps' => 0, 'reason' => 'Fixture hold', 'model' => 'fixture-model'],
        ],
    ];
}

function runningArena(): ArenaSeason
{
    return app(ArenaSeasonManager::class)->create('season-zero', CarbonImmutable::parse('2026-10-01T00:00:00Z'));
}

it('keeps the pilot disabled by default configuration', function () {
    config()->set('arena.enabled', false);
    $this->get('/arena')->assertNotFound();
    $this->get('/arena/evidence')->assertNotFound();
});

it('lets a guest read an honest empty preview without creating a season or results', function () {
    $this->get('/arena')->assertSuccessful()->assertInertia(fn (Assert $page) => $page
        ->component('ArenaBoard')->where('board.season', null)->has('board.agents', 0)->where('agent', null));
    expect(ArenaSeason::query()->count())->toBe(0);
    Http::assertNothingSent();
});

it('freezes rules and schedules a draft once without starting paid services', function () {
    $manager = app(ArenaSeasonManager::class);
    $draft = $manager->create('season-zero');
    expect($draft->starts_at)->toBeNull();
    $hash = $draft->rules_hash;
    config()->set('arena.fee_bps', 25);
    $scheduled = $manager->create('season-zero', CarbonImmutable::parse('2026-10-01T00:00:00Z'));
    expect($scheduled->rules_hash)->toBe($hash)->and($scheduled->rules['fee_bps'])->toBe(10)
        ->and($scheduled->ends_at->toDateString())->toBe('2026-10-15');
    Http::assertNothingSent();
    expect(fn () => $manager->create('season-zero', CarbonImmutable::parse('2026-10-02T00:00:00Z')))
        ->toThrow(DomainException::class);
});

it('calculates costs and raw-unit balances without floating point', function () {
    $ledger = app(PaperLedger::class);
    $rules = app(ArenaSeasonManager::class)->rules();
    $buy = $ledger->apply(['cash' => '1000000000', 'asset' => '0'], ['action' => 'buy', 'bps' => 10000], '2000000000', $rules);
    expect($buy)->toBe(['cash' => '0', 'asset' => '499240264500000000']);
    $sold = $ledger->apply($buy, ['action' => 'sell', 'bps' => 10000], '2000000000', $rules);
    expect($sold)->toBe(['cash' => '996963306', 'asset' => '0'])
        ->and($ledger->equity($buy, '2000000000', $rules))->toBe('996963306');
});

it('preserves large exact integers for a hold and cash valuation', function () {
    $ledger = app(PaperLedger::class);
    $rules = app(ArenaSeasonManager::class)->rules();
    $balance = ['cash' => '900719925474099312345', 'asset' => '0'];
    expect($ledger->apply($balance, ['action' => 'hold', 'bps' => 0], '1', $rules))->toBe($balance)
        ->and($ledger->equity($balance, '1', $rules))->toBe($balance['cash']);
});

it('rejects unsafe actions and unfunded orders', function (array $balance, array $decision, string $price) {
    expect(fn () => app(PaperLedger::class)->apply($balance, $decision, $price, app(ArenaSeasonManager::class)->rules()))
        ->toThrow(DomainException::class);
})->with([
    'sell nothing' => [['cash' => '1000000000', 'asset' => '0'], ['action' => 'sell', 'bps' => 10000], '2000000000'],
    'buy without gas' => [['cash' => '100', 'asset' => '0'], ['action' => 'buy', 'bps' => 10000], '2000000000'],
    'negative cash' => [['cash' => '-1', 'asset' => '0'], ['action' => 'hold', 'bps' => 0], '2000000000'],
    'zero price' => [['cash' => '1000000000', 'asset' => '0'], ['action' => 'hold', 'bps' => 0], '0'],
    'arbitrary fraction' => [['cash' => '1000000000', 'asset' => '0'], ['action' => 'buy', 'bps' => 9000], '2000000000'],
    'hold with amount' => [['cash' => '1000000000', 'asset' => '0'], ['action' => 'hold', 'bps' => 10000], '2000000000'],
]);

it('imports one authoritative round and treats a duplicate as the same operation', function () {
    $manager = app(ArenaSeasonManager::class);
    $season = runningArena();
    $now = CarbonImmutable::parse('2026-10-02');
    $round = $manager->import($season, arenaPayload(), $now);
    $duplicate = $manager->import($season, arenaPayload(), $now);
    expect($duplicate->id)->toBe($round->id)->and(ArenaRound::query()->count())->toBe(1)
        ->and($round->result['actors']['lain']['equity'])->toBe('996963306')
        ->and($round->result['actors']['challenger']['equity'])->toBe('1000000000')
        ->and($round->previous_hash)->toBeNull();
    Http::assertNothingSent();
});

it('rejects replacement, missing rounds and frozen-rule tampering', function () {
    $manager = app(ArenaSeasonManager::class);
    $season = runningArena();
    $now = CarbonImmutable::parse('2026-10-02');
    $manager->import($season, arenaPayload(), $now);
    $changed = arenaPayload();
    $changed['price_micros'] = '2100000000';
    expect(fn () => $manager->import($season, $changed, $now))->toThrow(DomainException::class);
    expect(fn () => $manager->import($season, arenaPayload(3), $now))->toThrow(DomainException::class);
    $rules = $season->rules;
    $rules['fee_bps'] = 0;
    $season->update(['rules' => $rules]);
    expect(fn () => $manager->import($season, arenaPayload(2), $now))->toThrow(DomainException::class);
    expect(ArenaRound::query()->count())->toBe(1);
});

it('chains later accepted rounds and preserves the buy-and-hold baseline', function () {
    $manager = app(ArenaSeasonManager::class);
    $season = runningArena();
    $now = CarbonImmutable::parse('2026-10-03');
    $first = $manager->import($season, arenaPayload(), $now);
    $next = arenaPayload(2);
    $next['decision_at'] = '2026-10-02T12:00:00Z';
    $next['filled_at'] = '2026-10-02T12:02:00Z';
    $next['decisions']['lain']['action'] = 'hold';
    $next['decisions']['lain']['bps'] = 0;
    $second = $manager->import($season, $next, $now);
    expect($second->previous_hash)->toBe($first->record_hash)
        ->and($second->result['benchmark']['balance'])->toBe($first->result['benchmark']['balance']);
});

it('rejects premature fills, future results, missing actors and extra tool fields', function (Closure $change, string $exception) {
    $payload = arenaPayload();
    $change($payload);
    expect(fn () => app(ArenaSeasonManager::class)->import(runningArena(), $payload, CarbonImmutable::parse('2026-10-02')))
        ->toThrow($exception);
    expect(ArenaRound::query()->count())->toBe(0);
})->with([
    'fill before delay' => [function (&$p) {
        $p['filled_at'] = '2026-10-01T12:00:30Z';
    }, DomainException::class],
    'future result' => [function (&$p) {
        $p['filled_at'] = '2026-10-03T12:00:00Z';
    }, DomainException::class],
    'missing actor' => [function (&$p) {
        unset($p['decisions']['challenger']);
    }, ValidationException::class],
    'tool instruction' => [function (&$p) {
        $p['decisions']['lain']['tools'] = ['transfer'];
    }, ValidationException::class],
    'float price' => [function (&$p) {
        $p['price_micros'] = 2000.50;
    }, ValidationException::class],
]);

it('requires login for discussion, following, reports and moderation', function () {
    $season = runningArena();
    $comment = ArenaComment::factory()->create(['arena_season_id' => $season->id]);
    $this->post('/arena/comments', ['body' => 'hello'])->assertRedirect('/login');
    $this->put('/arena/follow')->assertRedirect('/login');
    $this->post('/arena/comments/'.$comment->id.'/report')->assertRedirect('/login');
    $this->delete('/arena/comments/'.$comment->id)->assertRedirect('/login');
});

it('writes only validated public text and never rewards posting activity', function () {
    $season = runningArena();
    $user = User::factory()->create();
    $this->actingAs($user)->post('/arena/comments', ['body' => '<script>alert(1)</script> Question', 'user_id' => 999, 'hidden_at' => now()])
        ->assertRedirect('/arena');
    $comment = $season->comments()->first();
    expect($comment->user_id)->toBe($user->id)->and($comment->hidden_at)->toBeNull();
    $this->get('/arena')->assertInertia(fn (Assert $page) => $page->component('Arena')
        ->where('comments.data.0.body', '<script>alert(1)</script> Question')
        ->missing('comments.data.0.wallet_address')->missing('comments.data.0.user_id'));
    expect(DB::table('xp_entries')->where('user_id', $user->id)->count())->toBe(0);
});

it('validates same-season parent and message length', function () {
    runningArena();
    $user = User::factory()->create();
    $foreign = ArenaComment::factory()->create();
    $this->actingAs($user)->post('/arena/comments', ['body' => 'reply', 'parent_id' => $foreign->id])->assertSessionHasErrors('parent_id');
    $this->post('/arena/comments', ['body' => str_repeat('a', 2001)])->assertSessionHasErrors('body');
});

it('saves a season once and allows removing the save', function () {
    runningArena();
    $this->actingAs(User::factory()->create())->put('/arena/follow')->assertRedirect('/arena');
    $this->put('/arena/follow')->assertRedirect('/arena');
    expect(ArenaFollower::query()->count())->toBe(1);
    $this->get('/arena')->assertInertia(fn (Assert $page) => $page->where('following', true)->where('saves', 1));
    $this->delete('/arena/follow')->assertRedirect('/arena');
    expect(ArenaFollower::query()->count())->toBe(0);
});

it('deduplicates private reports and permits author or operator removal', function () {
    $season = runningArena();
    $author = User::factory()->create();
    $reader = User::factory()->create();
    $comment = ArenaComment::factory()->create(['arena_season_id' => $season->id, 'user_id' => $author->id]);
    $this->actingAs($reader)->post('/arena/comments/'.$comment->id.'/report')->assertRedirect('/arena');
    $this->post('/arena/comments/'.$comment->id.'/report')->assertRedirect('/arena');
    expect(DB::table('arena_comment_reports')->count())->toBe(1);
    $this->delete('/arena/comments/'.$comment->id)->assertForbidden();
    $this->get('/arena')->assertInertia(fn (Assert $page) => $page->where('comments.data.0.reports', null));
    config()->set('crm.admin_user_ids', [$reader->id]);
    $this->get('/arena')->assertInertia(fn (Assert $page) => $page->where('comments.data.0.reports', 1));
    $this->delete('/arena/comments/'.$comment->id)->assertRedirect('/arena');
    expect($comment->fresh()->body)->toBeNull()->and($comment->fresh()->hidden_at)->not->toBeNull();
});

it('exports only frozen public evidence and labels unverified imports', function () {
    $season = runningArena();
    app(ArenaSeasonManager::class)->import($season, arenaPayload(), CarbonImmutable::parse('2026-10-02'));
    ArenaComment::factory()->create(['arena_season_id' => $season->id]);
    $this->getJson('/arena/evidence')->assertSuccessful()->assertJsonPath('format', 'cyberia-arena-imported-paper-v1')
        ->assertJsonCount(1, 'rounds')->assertJsonMissingPath('comments')->assertJsonMissingPath('followers');
});

it('enforces the daily allowance without preventing the next day', function () {
    $season = runningArena();
    $manager = app(ArenaSeasonManager::class);
    $now = CarbonImmutable::parse('2026-10-03');
    for ($sequence = 1; $sequence <= 4; $sequence++) {
        $payload = arenaPayload($sequence);
        $at = CarbonImmutable::parse('2026-10-01T12:00:00Z')->addHours($sequence);
        $payload['decision_at'] = $at->toIso8601String();
        $payload['filled_at'] = $at->addMinutes(2)->toIso8601String();
        $payload['decisions']['lain'] = $payload['decisions']['challenger'];
        $manager->import($season, $payload, $now);
    }
    $fifth = arenaPayload(5);
    $fifth['decision_at'] = '2026-10-01T18:00:00Z';
    $fifth['filled_at'] = '2026-10-01T18:02:00Z';
    expect(fn () => $manager->import($season, $fifth, $now))->toThrow(DomainException::class);
    $fifth['decision_at'] = '2026-10-02T12:00:00Z';
    $fifth['filled_at'] = '2026-10-02T12:02:00Z';
    $manager->import($season, $fifth, $now);
    expect($season->rounds()->count())->toBe(5);
});

it('rolls back the whole round if either contestant cannot fund its action', function () {
    $season = runningArena();
    $payload = arenaPayload();
    $payload['decisions']['challenger']['action'] = 'sell';
    $payload['decisions']['challenger']['bps'] = 10000;
    expect(fn () => app(ArenaSeasonManager::class)->import($season, $payload, CarbonImmutable::parse('2026-10-02')))
        ->toThrow(DomainException::class);
    expect($season->rounds()->count())->toBe(0);
});

it('prepares a draft from the console without inference or a market request', function () {
    $this->artisan('arena:season')->assertSuccessful();
    expect(ArenaSeason::query()->sole()->starts_at)->toBeNull();
    Http::assertNothingSent();
    $this->artisan('arena:import-round', ['season' => 'season-zero', 'file' => '/missing-arena-file.json'])
        ->assertFailed();
});

it('accepts a local evidence file through the console without duplicating its round', function () {
    runningArena();
    $file = tempnam(sys_get_temp_dir(), 'arena-evidence-');
    file_put_contents($file, json_encode(arenaPayload(), JSON_THROW_ON_ERROR));
    try {
        $this->artisan('arena:import-round', ['season' => 'season-zero', 'file' => $file])->assertSuccessful();
        $this->artisan('arena:import-round', ['season' => 'season-zero', 'file' => $file])->assertSuccessful();
        expect(ArenaRound::query()->count())->toBe(1);
        Http::assertNothingSent();
    } finally {
        unlink($file);
    }
});

it('preserves earlier season evidence when the active season changes', function () {
    $old = runningArena();
    $round = app(ArenaSeasonManager::class)->import($old, arenaPayload(), CarbonImmutable::parse('2026-10-02'));
    app(ArenaSeasonManager::class)->create('season-zero-free', null, true);
    config()->set('arena.slug', 'season-zero-free');
    $this->get('/arena')->assertInertia(fn (Assert $page) => $page->where('archivedSeasons.0.slug', 'season-zero')->has('rounds', 0));
    $this->get('/arena/seasons/season-zero/evidence')->assertSuccessful()->assertJsonPath('rounds.0.record_hash', $round->record_hash);
    $this->get('/arena/seasons/not-a-season/evidence')->assertNotFound();
    config()->set('arena.enabled', false);
    $this->get('/arena/seasons/season-zero/evidence')->assertNotFound();
});
