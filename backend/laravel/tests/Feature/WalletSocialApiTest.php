<?php

use App\Models\Activity;
use App\Models\Dao;
use App\Models\Post;
use App\Models\Proposal;
use App\Models\ProposalVote;
use App\Models\User;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * What the wallet reads about the rest of Cyberia.
 *
 * The wallet has no session — the seed lives in the browser and this server
 * never learns whose it is — so these endpoints have to answer without one.
 * That is the property worth pinning: a signed-out request gets the same data a
 * signed-in one does, and nothing here can be written to.
 */
uses(RefreshDatabase::class);

beforeEach(function () {
    // Responses are cached for the wallet's refresh cadence; a test that wrote
    // rows and then read a neighbour's cache entry would pass for the wrong
    // reason.
    Cache::flush();
});

it('serves the feed to nobody in particular', function () {
    $author = User::factory()->create(['name' => 'ghostline']);
    Post::factory()->create(['user_id' => $author->id, 'body' => 'the wired is quiet']);

    $response = $this->getJson('/api/wallet/feed');

    $response->assertOk();
    expect($response->json('items'))->toHaveCount(1);
    expect($response->json('items.0.kind'))->toBe('post');
    expect($response->json('items.0.text'))->toBe('the wired is quiet');
    expect($response->json('items.0.who.name'))->toBe('ghostline');
});

it('merges DAO activity into the same stream, newest first', function () {
    $author = User::factory()->create();
    $dao = Dao::factory()->create(['name' => 'Noosphere']);
    $proposal = Proposal::factory()->create([
        'dao_id' => $dao->id,
        'user_id' => $author->id,
        'title' => 'Fund the relay set',
    ]);

    Post::factory()->create([
        'user_id' => $author->id,
        'created_at' => now()->subHour(),
    ]);
    Activity::factory()->create([
        'type' => 'proposal.created',
        'user_id' => $author->id,
        'dao_id' => $dao->id,
        'subject_type' => Proposal::class,
        'subject_id' => $proposal->id,
        'created_at' => now(),
    ]);

    $items = $this->getJson('/api/wallet/feed')->assertOk()->json('items');

    expect($items)->toHaveCount(2);
    expect($items[0]['kind'])->toBe('dao');
    expect($items[0]['type'])->toBe('proposal.created');
    // The type stays a key so the wallet can say it in either language; the
    // title travels beside it because a translated key alone says nothing.
    expect($items[0]['text'])->toBe('Fund the relay set');
    expect($items[1]['kind'])->toBe('post');
});

it('filters the feed down to one source', function () {
    $author = User::factory()->create();
    $dao = Dao::factory()->create();
    $proposal = Proposal::factory()->create(['dao_id' => $dao->id, 'user_id' => $author->id]);

    Post::factory()->create(['user_id' => $author->id]);
    Activity::factory()->create([
        'type' => 'proposal.created',
        'user_id' => $author->id,
        'dao_id' => $dao->id,
        'subject_type' => Proposal::class,
        'subject_id' => $proposal->id,
    ]);

    expect($this->getJson('/api/wallet/feed?tab=posts')->json('items'))
        ->toHaveCount(1)
        ->and($this->getJson('/api/wallet/feed?tab=posts')->json('items.0.kind'))
        ->toBe('post');

    Cache::flush();

    expect($this->getJson('/api/wallet/feed?tab=dao')->json('items.0.kind'))
        ->toBe('dao');
});

it('tallies a proposal by voting power, not by voter count', function () {
    $dao = Dao::factory()->create(['name' => 'Noosphere']);
    $proposal = Proposal::factory()->create([
        'dao_id' => $dao->id,
        'title' => 'Lower the launchpad fee',
        'ends_at' => now()->addDay(),
    ]);

    // Two small votes for, one large vote against: counting voters would call
    // this proposal passing, and counting power says the opposite.
    ProposalVote::factory()->count(2)->create([
        'proposal_id' => $proposal->id,
        'support' => true,
        'voting_power' => '10',
    ]);
    ProposalVote::factory()->create([
        'proposal_id' => $proposal->id,
        'support' => false,
        'voting_power' => '100',
    ]);

    $body = $this->getJson('/api/wallet/dao')->assertOk()->json();

    expect($body['daos'][0]['name'])->toBe('Noosphere');
    expect($body['proposals'][0]['title'])->toBe('Lower the launchpad fee');
    expect($body['proposals'][0]['votes'])->toBe(3);
    expect((float) $body['proposals'][0]['powerFor'])->toBe(20.0);
    expect((float) $body['proposals'][0]['powerAgainst'])->toBe(100.0);
    expect($body['proposals'][0]['status'])->toBe('open');

    $detail = $this->getJson("/api/wallet/dao/proposals/{$proposal->id}")
        ->assertOk()
        ->json('proposal');

    expect($detail['id'])->toBe($proposal->id);
    expect($detail)->toHaveKey('descriptionHtml');
});

it('answers for an address nobody here has claimed', function () {
    $address = '0x'.str_repeat('ab', 20);

    $body = $this->getJson("/api/wallet/profile/{$address}")->assertOk()->json();

    // Not an error: the wallet knows the key it holds and nothing about who
    // signed up on this server, so "unclaimed" is a real answer.
    expect($body['claimed'])->toBeFalse();
    expect($body['address'])->toBe($address);
    expect($body['achievements'])->not->toBeEmpty();
    expect(collect($body['achievements'])->pluck('earned')->unique()->all())->toBe([false]);
});

it('answers for a claimed address without leaking an account', function () {
    $user = User::factory()->create([
        'name' => 'ghostline',
        'wallet_address' => '0x'.str_repeat('cd', 20),
        'email' => 'ghost@example.test',
    ]);
    $dao = Dao::factory()->create();
    Proposal::factory()->create(['dao_id' => $dao->id, 'user_id' => $user->id]);

    // Looked up case-insensitively: the wallet checksums its own addresses and
    // the database holds whatever was stored when the account was linked.
    $body = $this->getJson('/api/wallet/profile/0x'.strtoupper(substr($user->wallet_address, 2)))
        ->assertOk()
        ->json();

    expect($body['claimed'])->toBeTrue();
    expect($body['name'])->toBe('ghostline');
    expect($body['stats']['proposals'])->toBe(1);
    expect($body)->not->toHaveKey('email');
});

it('refuses anything that is not an address', function () {
    $this->getJson('/api/wallet/profile/not-an-address')->assertStatus(422);
    $this->getJson('/api/wallet/profile/0x123')->assertStatus(422);
});

/**
 * `activity_events` belongs to the Telegram bot and is created by it, not by a
 * migration, so the test builds the bot's own schema.
 */
function createActivityEvents(): void
{
    Schema::create('activity_events', function (Blueprint $table) {
        $table->id();
        $table->string('kind');
        $table->float('usd')->nullable();
        $table->string('sym_in')->nullable();
        $table->float('amt_in')->nullable();
        $table->string('sym_out')->nullable();
        $table->float('amt_out')->nullable();
        $table->string('user_addr')->nullable();
        $table->string('tx_hash')->nullable();
        $table->integer('block')->nullable();
        $table->text('meta')->nullable();
        $table->string('created_at')->nullable();
    });
}

it('puts every on-chain action into the feed, named where the address is claimed', function () {
    createActivityEvents();
    User::factory()->create(['name' => 'ghostline', 'wallet_address' => '0xAAAAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);

    DB::table('activity_events')->insert([
        ['kind' => 'swap', 'usd' => 12.5, 'sym_in' => 'CYBER', 'amt_in' => 100, 'sym_out' => 'USDC', 'amt_out' => 12.5,
            'user_addr' => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tx_hash' => '0xfeed', 'meta' => null,
            'created_at' => now('UTC')->subMinutes(3)->format('Y-m-d H:i:s')],
        ['kind' => 'swap', 'usd' => 0.2, 'sym_in' => 'USDC', 'amt_in' => 0.2, 'sym_out' => 'CYBER', 'amt_out' => 1.6,
            'user_addr' => '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'tx_hash' => '0xdust', 'meta' => null,
            'created_at' => now('UTC')->subMinutes(2)->format('Y-m-d H:i:s')],
        ['kind' => 'liq_add', 'usd' => 50, 'sym_in' => 'CYBER', 'amt_in' => 1, 'sym_out' => 'USDC', 'amt_out' => 25,
            'user_addr' => null, 'tx_hash' => '0xlp', 'meta' => null,
            'created_at' => now('UTC')->subMinute()->format('Y-m-d H:i:s')],
        ['kind' => 'pumpfun_buy', 'usd' => null, 'sym_in' => 'SOL', 'amt_in' => 0.5, 'sym_out' => 'CYBER.sol', 'amt_out' => 900,
            'user_addr' => '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'tx_hash' => '5sig', 'meta' => null,
            'created_at' => now('UTC')->format('Y-m-d H:i:s')],
    ]);

    $chain = $this->getJson('/api/wallet/feed?tab=onchain')->assertOk()->json('items');

    expect($chain)->toHaveCount(4)
        ->and($chain[0]['kind'])->toBe('onchain')
        // A Solana buyer is shortened and opens no profile — the wallet's
        // profile lookup takes EVM addresses only — and its receipt is Solscan.
        ->and($chain[0]['onchain']['action'])->toBe('pumpfun_buy')
        ->and($chain[0]['onchain']['usd'])->toBeNull()
        ->and($chain[0]['who']['address'])->toBeNull()
        ->and($chain[0]['url'])->toBe('https://solscan.io/tx/5sig')
        ->and($chain[1]['onchain']['action'])->toBe('liq_add')
        ->and($chain[1]['who'])->toBeNull()
        ->and($chain[2]['who']['name'])->toBe('0xbbbb…bbbb')
        ->and($chain[3]['who']['name'])->toBe('ghostline')
        ->and($chain[3]['onchain'])->toBe(['action' => 'swap', 'in' => '100 CYBER', 'out' => '12.5 USDC', 'detail' => null, 'usd' => 12.5])
        ->and($chain[3]['url'])->toEndWith('/tx/0xfeed');

    // Every one of them is news, so "All" carries every one too.
    expect(collect($this->getJson('/api/wallet/feed?tab=all')->json('items'))->where('kind', 'onchain'))->toHaveCount(4);

    // A wallet left open across the deploy still asks for the old tab name.
    expect($this->getJson('/api/wallet/feed?tab=trades')->json('items'))->toHaveCount(4);

    // And the other tabs carry nothing from the chain.
    expect(collect($this->getJson('/api/wallet/feed?tab=posts')->json('items'))->where('kind', 'onchain'))->toBeEmpty();
});

it('keeps the small and the unpriced off "All" when a floor is set', function () {
    createActivityEvents();
    config()->set('wallet.feed.trade_floor_usd', 1);

    DB::table('activity_events')->insert([
        ['kind' => 'swap', 'usd' => 12.5, 'sym_in' => 'CYBER', 'amt_in' => 100, 'sym_out' => 'USDC', 'amt_out' => 12.5,
            'user_addr' => null, 'tx_hash' => '0x1', 'meta' => null, 'created_at' => now('UTC')->format('Y-m-d H:i:s')],
        ['kind' => 'swap', 'usd' => 0.2, 'sym_in' => 'USDC', 'amt_in' => 0.2, 'sym_out' => 'CYBER', 'amt_out' => 1.6,
            'user_addr' => null, 'tx_hash' => '0x2', 'meta' => null, 'created_at' => now('UTC')->format('Y-m-d H:i:s')],
        ['kind' => 'stake', 'usd' => null, 'sym_in' => 'ASH', 'amt_in' => 5, 'sym_out' => null, 'amt_out' => null,
            'user_addr' => null, 'tx_hash' => '0x3', 'meta' => null, 'created_at' => now('UTC')->format('Y-m-d H:i:s')],
    ]);

    expect(collect($this->getJson('/api/wallet/feed?tab=all')->json('items'))->where('kind', 'onchain'))->toHaveCount(1)
        ->and($this->getJson('/api/wallet/feed?tab=onchain')->json('items'))->toHaveCount(3);
});

it('says where a bridge went', function () {
    createActivityEvents();

    DB::table('activity_events')->insert([
        'kind' => 'bridge', 'usd' => 40, 'sym_in' => 'USDC', 'amt_in' => 40, 'sym_out' => null, 'amt_out' => null,
        'user_addr' => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'tx_hash' => '0xb', 'meta' => 'base_to_evm',
        'created_at' => now('UTC')->format('Y-m-d H:i:s'),
    ]);

    $item = $this->getJson('/api/wallet/feed?tab=onchain')->json('items.0');

    expect($item['onchain']['detail'])->toBe('Base → Cyberia')
        ->and($item['url'])->toBe('https://basescan.org/tx/0xb');
});

it('serves the feed without chain rows when the bot has never run', function () {
    $this->getJson('/api/wallet/feed?tab=onchain')->assertOk()->assertJsonCount(0, 'items');
});
