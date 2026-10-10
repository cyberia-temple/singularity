<?php

use App\Models\AnalyticsUser;
use App\Models\Dao;
use App\Models\LaunchpadToken;
use App\Models\User;
use App\Notifications\CommunityNotification;
use App\Services\Launchpad\LaunchWatcher;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Str;

/**
 * A launch opens its token's DAO, lands in the feed and is pushed to everyone —
 * read off the launchpads, whichever screen (or script) made it.
 *
 * The chain is faked at the JSON-RPC level: one launchpad, an `allTokens`
 * array, the launch's own `TokenLaunched` log and the token's name and symbol.
 */
const WATCH_LAUNCHPAD = '0x6970481a167d8d44527091d0e319e50ad3f79ee3';
const WATCH_TOKEN = '0xc921abfc96d7098f184489c0d0cc6895d1a1b01b';
const WATCH_CREATOR = '0x472725293d97dff80ea34c22840872832edbe8dc';
const WATCH_TX = '0x4e5f3687d04f5ac95f160056c1a41596109c4423cfcf39aa2c2a4e4a1bf2dcca';

beforeEach(function () {
    Cache::flush();
    config()->set('launchpad.watch.contracts', [WATCH_LAUNCHPAD]);
    config()->set('launchpad.watch.rpc_url', 'https://rpc.test');
    config()->set('launchpad.watch.explorer_api', 'https://explorer.test/api/v2');

    config()->set('webpush.vapid.public_key', 'BFyCqu6c1-7IfXmNbjkQX4wGEwLVxsoeQ5YZU7iz24zlEdpNsh5i2_Gzv8lzHjuA_CClN7_xRuJQM9LfvPoigJY');
    config()->set('webpush.vapid.private_key', '32q0BGHK6sEQfAIHRhSSFH7p7LyHQWggbt3kMtorb4s');
    config()->set('webpush.vapid.subject', 'https://cyberia.test');
});

function watchAbiString(string $value): string
{
    $hex = bin2hex($value);

    return '0x'.str_pad('20', 64, '0', STR_PAD_LEFT)
        .str_pad(dechex(strlen($value)), 64, '0', STR_PAD_LEFT)
        .str_pad($hex, (int) ceil(max(strlen($hex), 1) / 64) * 64, '0');
}

function watchWord(string $hex): string
{
    return '0x'.str_pad(substr($hex, 2), 64, '0', STR_PAD_LEFT);
}

/**
 * @param  list<string>  $tokens  what allTokens holds
 * @param  array<string, int|null>  $launchedAgo  token => seconds since its launch, null = registered
 */
function fakeLaunchpad(array $tokens, array $launchedAgo, array $names = [], array $explorer = []): void
{
    $head = 20_000_000;

    Http::fake([
        'https://explorer.test/*' => Http::response(['items' => $explorer, 'next_page_params' => null]),
        'https://rpc.test' => function (Request $request) use ($tokens, $launchedAgo, $names, $head) {
            $method = $request['method'];
            $params = $request['params'];
            $result = match ($method) {
                'eth_blockNumber' => '0x'.dechex($head),
                'eth_getBlockByNumber' => ['timestamp' => '0x'.dechex(now()->timestamp - (($head - hexdec($params[0])) * 1))],
                'eth_getLogs' => (function () use ($params, $launchedAgo, $head) {
                    $token = '0x'.substr($params[0]['topics'][1], -40);
                    $ago = $launchedAgo[$token] ?? null;

                    // The node's window is the last thousand blocks — a second each.
                    if ($ago === null || $ago >= 1000) {
                        return [];
                    }

                    return [[
                        'topics' => [LaunchWatcher::LAUNCHED_TOPICS[1], watchWord($token), watchWord(WATCH_CREATOR)],
                        'transactionHash' => WATCH_TX,
                        'blockNumber' => '0x'.dechex($head - $ago),
                    ]];
                })(),
                'eth_call' => (function () use ($params, $tokens, $names) {
                    $to = Str::lower($params[0]['to']);
                    $data = $params[0]['data'];

                    if ($to === WATCH_LAUNCHPAD && $data === '0xdbb80e42') {
                        return watchWord('0x'.dechex(count($tokens)));
                    }

                    if ($to === WATCH_LAUNCHPAD && str_starts_with($data, '0x634282af')) {
                        return watchWord($tokens[hexdec(substr($data, 10))]);
                    }

                    [$name, $symbol] = $names[$to] ?? ['Simple Mail Transfer Protocol', 'SMTP'];

                    return watchAbiString($data === '0x06fdde03' ? $name : $symbol);
                })(),
            };

            return Http::response(['jsonrpc' => '2.0', 'id' => 1, 'result' => $result]);
        },
    ]);
}

function pushAudience(): array
{
    $creator = User::factory()->create(['name' => 'smtp-guy', 'wallet_address' => '0x472725293D97DFF80ea34C22840872832edbe8dc']);
    $creator->updatePushSubscription('https://push.example/creator', 'k', 'a');
    $reader = User::factory()->create();
    $reader->updatePushSubscription('https://push.example/reader', 'k', 'a');

    $install = AnalyticsUser::query()->create([
        'id' => (string) Str::uuid(),
        'first_seen_at' => now(),
        'last_seen_at' => now(),
    ]);
    $install->updatePushSubscription('https://push.example/install', 'k', 'a');

    return [$creator, $reader, $install];
}

it('opens the DAO, records the launch and pushes it to everyone but the creator', function () {
    Notification::fake();
    [$creator, $reader, $install] = pushAudience();
    fakeLaunchpad([WATCH_TOKEN], [WATCH_TOKEN => 30]);

    Artisan::call('launchpad:watch');

    $token = LaunchpadToken::query()->where('address', WATCH_TOKEN)->sole();
    expect($token->chain_id)->toBe(49406)
        ->and($token->name)->toBe('Simple Mail Transfer Protocol')
        ->and($token->symbol)->toBe('SMTP')
        ->and($token->creator)->toBe(WATCH_CREATOR)
        ->and($token->launch_tx)->toBe(WATCH_TX)
        ->and($token->launched_at->diffInSeconds(now()->subSeconds(30), true))->toBeLessThan(5);

    $dao = Dao::query()->sole();
    expect($dao->address)->toBe(WATCH_TOKEN)
        ->and($dao->name)->toBe('Simple Mail Transfer Protocol')
        ->and($dao->user_id)->toBe($creator->id)
        ->and($token->dao_id)->toBe($dao->id);

    Notification::assertSentTo($install, CommunityNotification::class, function ($n) use ($install) {
        return $n->type === 'launch'
            && $n->titleFor($install) === 'New token: SMTP'
            && $n->bodyFor($install) === 'Simple Mail Transfer Protocol · launched by smtp-guy · its DAO is open';
    });
    Notification::assertSentTo($reader, CommunityNotification::class);
    Notification::assertNotSentTo($creator, CommunityNotification::class);
});

it('never opens a second DAO or pushes twice, even after the cursor is lost', function () {
    Notification::fake();
    [, $reader] = pushAudience();
    fakeLaunchpad([WATCH_TOKEN], [WATCH_TOKEN => 30]);

    Artisan::call('launchpad:watch');
    Artisan::call('launchpad:watch');
    Cache::flush();
    Artisan::call('launchpad:watch');

    expect(Dao::query()->count())->toBe(1)
        ->and(LaunchpadToken::query()->count())->toBe(1);
    Notification::assertSentToTimes($reader, CommunityNotification::class, 1);
});

it('opens DAOs for old launches and registered tokens without waking anybody', function () {
    Notification::fake();
    [, $reader] = pushAudience();
    $old = '0x69f1f61c407ed15645422c0b8184842f1a1cd792';
    $registered = '0xd8c1f812add03ccde8d3c7f86fead181980cd7ec';

    fakeLaunchpad([$registered, $old], [$registered => null, $old => 900], [
        $registered => ['Lain', 'LAIN'],
        $old => ['Mine', 'MINE'],
    ]);
    // Fifteen minutes old: still in the node's window, outside the push window.
    config()->set('launchpad.watch.announce_within_minutes', 10);

    Artisan::call('launchpad:watch');

    expect(Dao::query()->orderBy('id')->pluck('name')->all())->toBe(['Lain', 'Mine'])
        ->and(LaunchpadToken::query()->where('address', $registered)->value('launch_tx'))->toBeNull()
        ->and(LaunchpadToken::query()->where('address', $old)->value('launch_tx'))->toBe(WATCH_TX);
    Notification::assertNothingSentTo($reader);
});

it('reads an old launch from the explorer when the node no longer has it', function () {
    fakeLaunchpad([WATCH_TOKEN], [WATCH_TOKEN => 86_400], explorer: [[
        'topics' => [LaunchWatcher::LAUNCHED_TOPICS[1], watchWord(WATCH_TOKEN), watchWord(WATCH_CREATOR)],
        'transaction_hash' => WATCH_TX,
        'block_number' => 19_913_600,
    ]]);

    Artisan::call('launchpad:watch');

    expect(LaunchpadToken::query()->sole())
        ->creator->toBe(WATCH_CREATOR)
        ->launch_tx->toBe(WATCH_TX)
        ->launch_block->toBe(19_913_600);
});

it('links a DAO somebody already opened over the token instead of a second one', function () {
    $existing = Dao::factory()->create(['address' => Str::upper(WATCH_TOKEN), 'name' => 'Hand-made']);
    fakeLaunchpad([WATCH_TOKEN], [WATCH_TOKEN => 30]);

    Artisan::call('launchpad:watch');

    expect(Dao::query()->count())->toBe(1)
        ->and(LaunchpadToken::query()->sole()->dao_id)->toBe($existing->id);
});

it('names the DAO apart from one that already has the token’s name', function () {
    Dao::factory()->create(['name' => 'Simple Mail Transfer Protocol']);
    fakeLaunchpad([WATCH_TOKEN], [WATCH_TOKEN => 30]);

    Artisan::call('launchpad:watch');

    expect(LaunchpadToken::query()->sole()->dao->name)->toBe('Simple Mail Transfer Protocol (SMTP)');
});

it('lets the creator rename the token’s DAO but never delete it', function () {
    [$creator] = pushAudience();
    fakeLaunchpad([WATCH_TOKEN], [WATCH_TOKEN => 30]);
    Artisan::call('launchpad:watch');
    $dao = Dao::query()->sole();

    $this->actingAs($creator)->put("/dao/{$dao->id}", [
        'address' => '0x1111111111111111111111111111111111111111',
        'name' => 'SMTP holders',
    ])->assertRedirect();
    $this->actingAs($creator)->delete("/dao/{$dao->id}")->assertForbidden();

    expect($dao->fresh())
        ->name->toBe('SMTP holders')
        ->address->toBe(WATCH_TOKEN);
});

it('keeps metadata the creator signed and lets only the launcher edit it', function () {
    LaunchpadToken::query()->create([
        'chain_id' => 49406,
        'address' => WATCH_TOKEN,
        'name' => 'Signed name',
        'description' => 'from the creator',
    ]);
    fakeLaunchpad([WATCH_TOKEN], [WATCH_TOKEN => 30]);

    Artisan::call('launchpad:watch');

    expect(LaunchpadToken::query()->sole())
        ->name->toBe('Signed name')
        ->description->toBe('from the creator')
        ->symbol->toBe('SMTP')
        ->creator->toBe(WATCH_CREATOR);
});

it('answers a launch screen’s nudge with the token and its DAO', function () {
    fakeLaunchpad([WATCH_TOKEN], [WATCH_TOKEN => 5]);

    $this->postJson('/api/launchpad/watch', ['address' => '0x'.Str::upper(substr(WATCH_TOKEN, 2))])
        ->assertOk()
        ->assertJsonPath('token.address', WATCH_TOKEN)
        ->assertJsonPath('token.launch_tx', WATCH_TX)
        ->assertJsonPath('token.dao.name', 'Simple Mail Transfer Protocol');

    $this->postJson('/api/launchpad/watch', ['address' => 'not-an-address'])->assertStatus(422);
});

it('puts the launch in the wallet feed with its DAO', function () {
    fakeLaunchpad([WATCH_TOKEN], [WATCH_TOKEN => 30]);
    Artisan::call('launchpad:watch');

    $launch = collect($this->getJson('/api/wallet/feed?tab=onchain')->assertOk()->json('items'))
        ->firstWhere('kind', 'launch');

    expect($launch['launch']['symbol'])->toBe('SMTP')
        ->and($launch['launch']['dao']['name'])->toBe('Simple Mail Transfer Protocol')
        ->and($launch['who']['address'])->toBe(WATCH_CREATOR)
        ->and($launch['url'])->toEndWith('/token/'.WATCH_TOKEN);

    expect(collect($this->getJson('/api/wallet/feed')->json('items'))->where('kind', 'launch'))->toHaveCount(1);
});

it('leaves the cursor where a blinking RPC stopped it', function () {
    Http::fake(['*' => Http::response('bad gateway', 502)]);

    Artisan::call('launchpad:watch');

    expect(Cache::get(LaunchWatcher::CURSOR.WATCH_LAUNCHPAD))->toBeNull()
        ->and(Dao::query()->count())->toBe(0);
});
