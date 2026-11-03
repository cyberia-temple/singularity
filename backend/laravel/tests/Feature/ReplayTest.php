<?php

use App\Models\ReplaySession;
use App\Models\User;
use App\Support\SessionReplay;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Inertia\Testing\AssertableInertia as Assert;

/**
 * Session recordings end to end on this server: the ingest files what a
 * recorder sends (and refuses what it should), the console reads it back, and
 * the prune forgets it.
 */
beforeEach(function () {
    $this->withoutVite();
    Storage::fake('local');
    config()->set('replay.enabled', true);
    config()->set('replay.sites', ['cyberia.church', 'lain-os.com', 'chaos.fm']);
    config()->set('crm.admin_wallets', []);
    config()->set('crm.admin_user_ids', []);
});

/**
 * @param  array<string, mixed>  $overrides
 * @return array<string, mixed>
 */
function replayChunk(string $session, int $seq, array $overrides = []): array
{
    return array_merge([
        'v' => 1,
        's' => $session,
        'q' => $seq,
        'p' => '/wallet',
        'w' => 1440,
        'h' => 900,
        'who' => null,
        'inst' => null,
        'e' => [
            ['type' => 4, 'timestamp' => 1_000_000, 'data' => ['href' => 'https://lain-os.com/wallet', 'width' => 1440, 'height' => 900]],
            ['type' => 2, 'timestamp' => 1_000_001, 'data' => ['node' => ['type' => 0, 'childNodes' => []]]],
            ['type' => 3, 'timestamp' => 1_004_000, 'data' => ['source' => 1, 'positions' => []]],
        ],
        'c' => [
            ['t' => 1_002_000, 'p' => '/wallet', 'x' => 0.5, 'y' => 300, 'f' => 0, 'w' => 1440, 'l' => 'button Send', 'r' => 1, 'd' => 0],
            ['t' => 1_003_000, 'p' => '/wallet', 'x' => 0.25, 'y' => 40, 'f' => 1, 'w' => 1440, 'l' => 'a Swap', 'r' => 0, 'd' => 1],
        ],
        'x' => [['t' => 1_003_500, 'p' => '/wallet', 'm' => 'TypeError: x is undefined @ app.js:1']],
        'snap' => [['t' => 1_000_001, 'p' => '/wallet']],
    ], $overrides);
}

function sendReplay(array $body, string $origin = 'https://lain-os.com', bool $gzip = false): TestResponse
{
    $json = json_encode($body);

    return test()->call(
        'POST',
        '/api/replay'.($gzip ? '?z=1' : ''),
        server: ['HTTP_ORIGIN' => $origin, 'CONTENT_TYPE' => 'text/plain'],
        content: $gzip ? gzencode($json) : $json,
    );
}

it('files a chunk, its pages, clicks and errors', function () {
    $id = (string) Str::uuid();

    sendReplay(replayChunk($id, 1), gzip: true)->assertStatus(202);

    $session = ReplaySession::findOrFail($id);
    expect($session->site)->toBe('lain-os.com')
        ->and($session->device)->toBe('desktop')
        ->and($session->clicks)->toBe(2)
        ->and($session->rage_clicks)->toBe(1)
        ->and($session->dead_clicks)->toBe(1)
        ->and($session->errors)->toBe(1)
        ->and($session->pages)->toBe(1)
        ->and($session->duration_ms)->toBe(4000)
        ->and(DB::table('replay_clicks')->where('session_id', $id)->count())->toBe(2)
        ->and(DB::table('replay_pages')->where('session_id', $id)->value('seq'))->toBe(1);

    Storage::disk('local')->assertExists("replay/{$id}/1.json.gz");
    expect(json_decode($session->eventsJson(), true))->toHaveCount(3);
});

it('writes a chunk sent twice only once', function () {
    $id = (string) Str::uuid();

    sendReplay(replayChunk($id, 1))->assertStatus(202);
    sendReplay(replayChunk($id, 1))->assertStatus(202);

    expect(ReplaySession::findOrFail($id)->clicks)->toBe(2);
});

it('joins chunks in the order they were sent', function () {
    $id = (string) Str::uuid();

    sendReplay(replayChunk($id, 2, ['e' => [['type' => 3, 'timestamp' => 1_009_000, 'data' => ['source' => 2]]], 'c' => [], 'x' => [], 'snap' => []]))->assertStatus(202);
    sendReplay(replayChunk($id, 1))->assertStatus(202);

    $events = json_decode(ReplaySession::findOrFail($id)->eventsJson(), true);

    expect(array_column($events, 'timestamp'))->toBe([1_000_000, 1_000_001, 1_004_000, 1_009_000])
        ->and(json_decode(ReplaySession::findOrFail($id)->eventsJson(2), true))->toHaveCount(1);
});

it('refuses a site it does not take, and a session moving between sites', function () {
    $id = (string) Str::uuid();

    sendReplay(replayChunk($id, 1), 'https://evil.example')->assertStatus(403);
    sendReplay(replayChunk($id, 1), 'https://www.chaos.fm')->assertStatus(202);
    sendReplay(replayChunk($id, 2), 'https://lain-os.com')->assertStatus(403);

    expect(ReplaySession::findOrFail($id)->site)->toBe('chaos.fm');
});

it('stops a session past its size cap and anything when switched off', function () {
    $id = (string) Str::uuid();
    config()->set('replay.max_session_bytes', 10);

    sendReplay(replayChunk($id, 1))->assertStatus(413);

    config()->set('replay.enabled', false);
    sendReplay(replayChunk((string) Str::uuid(), 1))->assertNotFound();
});

it('refuses events that are not rrweb events', function () {
    sendReplay(replayChunk((string) Str::uuid(), 1, ['e' => [['type' => 'x']]]))->assertStatus(422);
    sendReplay(['v' => 1])->assertStatus(422);
});

it('files an account only from a tag this server signed', function () {
    $user = User::factory()->create();
    $signed = (string) Str::uuid();
    $forged = (string) Str::uuid();

    sendReplay(replayChunk($signed, 1, ['who' => SessionReplay::who($user->id)]))->assertStatus(202);
    sendReplay(replayChunk($forged, 1, ['who' => $user->id.'.'.str_repeat('a', 32)]))->assertStatus(202);

    expect(ReplaySession::findOrFail($signed)->user_id)->toBe($user->id)
        ->and(ReplaySession::findOrFail($forged)->user_id)->toBeNull();
});

it('forgets a session the visitor refused', function () {
    $id = (string) Str::uuid();
    sendReplay(replayChunk($id, 1))->assertStatus(202);

    sendReplay(['v' => 1, 's' => $id, 'forget' => true], 'https://chaos.fm')->assertStatus(202);
    expect(ReplaySession::find($id))->not->toBeNull();

    sendReplay(['v' => 1, 's' => $id, 'forget' => true])->assertStatus(202);
    expect(ReplaySession::find($id))->toBeNull()
        ->and(DB::table('replay_clicks')->where('session_id', $id)->count())->toBe(0);
    Storage::disk('local')->assertMissing("replay/{$id}/1.json.gz");
});

it('never takes a refusal for anything but a session id', function () {
    $id = (string) Str::uuid();
    sendReplay(replayChunk($id, 1))->assertStatus(202);

    foreach (['.', '..', '../replay', 'x/../..', ''] as $path) {
        sendReplay(['v' => 1, 's' => $path, 'forget' => true])->assertStatus(202);
    }

    Storage::disk('local')->assertExists("replay/{$id}/1.json.gz");
    expect(ReplaySession::find($id))->not->toBeNull()
        ->and(fn () => ReplaySession::directory('..'))->toThrow(InvalidArgumentException::class);
});

it('shows recordings to operators only', function () {
    $id = (string) Str::uuid();
    sendReplay(replayChunk($id, 1))->assertStatus(202);

    $this->get('/crm/replays')->assertRedirect();
    $this->actingAs(User::factory()->create())->get('/crm/replays')->assertNotFound();

    $operator = User::factory()->create();
    config()->set('crm.admin_user_ids', [$operator->id]);

    $this->actingAs($operator)->get('/crm/replays?flag=rage')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('crm/Replays')
            ->where('tiles.sessions', 1)
            ->where('problems.0.path', '/wallet')
            ->where('faults.0.example', $id)
            ->has('sessions.data', 1)
            ->where('sessions.data.0.id', $id));

    $this->actingAs($operator)->get('/crm/replays?flag=errors&path=nowhere')
        ->assertInertia(fn (Assert $page) => $page->has('sessions.data', 0));

    $this->actingAs($operator)->get("/crm/replays/{$id}")
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('crm/Replay')
            ->has('marks', 2)
            ->has('faults', 1));

    expect($this->actingAs($operator)->get("/crm/replays/{$id}/events")->assertOk()->json())->toHaveCount(3);

    $this->actingAs($operator)->get('/crm/replays/heatmap?site=lain-os.com&path=/wallet&device=desktop')
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('crm/Heatmap')
            ->has('points', 2)
            ->where('snapshot.session', $id)
            ->where('snapshot.seq', 1)
            ->where('targets.0.clicks', 1));
});

it('prunes recordings past the retention window', function () {
    $old = (string) Str::uuid();
    $fresh = (string) Str::uuid();
    sendReplay(replayChunk($old, 1))->assertStatus(202);
    sendReplay(replayChunk($fresh, 1))->assertStatus(202);
    ReplaySession::query()->whereKey($old)->update(['updated_at' => now()->subDays(31)]);

    $this->artisan('replay:prune')->assertSuccessful();

    expect(ReplaySession::find($old))->toBeNull()
        ->and(ReplaySession::find($fresh))->not->toBeNull()
        ->and(DB::table('replay_clicks')->where('session_id', $old)->count())->toBe(0);
    Storage::disk('local')->assertMissing("replay/{$old}/1.json.gz");
    Storage::disk('local')->assertExists("replay/{$fresh}/1.json.gz");
});
