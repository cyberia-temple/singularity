<?php

use App\Console\Commands\FeedAnnounceActivityCommand;
use App\Models\Activity;
use App\Models\AnalyticsUser;
use App\Models\Dao;
use App\Models\Proposal;
use App\Models\ProposalComment;
use App\Models\User;
use App\Notifications\CommunityNotification;
use App\Notifications\DaoActivityNotification;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Notification;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

/**
 * Only the DAO's own notifications. Acting in a DAO is also activity, so the
 * actor may collect a gamification notice in the same request — counting every
 * unread row made these assertions quietly depend on the quest board.
 */
function daoUnread(User $user): int
{
    return $user->fresh()->unreadNotifications()
        ->where('type', DaoActivityNotification::class)
        ->count();
}

test('a new proposal notifies prior dao participants but not the author', function () {
    $author = User::factory()->create();
    $participant = User::factory()->create();
    $dao = Dao::factory()->create();

    // The participant acted in this DAO before.
    Activity::factory()->create([
        'user_id' => $participant->id,
        'dao_id' => $dao->id,
    ]);

    $this->actingAs($author)->post("/dao/{$dao->id}/proposals", [
        'dao_id' => $dao->id,
        'title' => 'Notify me',
        'ends_at' => now()->addWeek()->toIso8601String(),
    ]);

    expect(daoUnread($participant))->toBe(1)
        ->and(daoUnread($author))->toBe(0);

    $data = $participant->fresh()->unreadNotifications()
        ->where('type', DaoActivityNotification::class)->first()->data;
    expect($data['type'])->toBe('proposal.created');
});

test('a comment notifies the proposal author', function () {
    $author = User::factory()->create();
    $commenter = User::factory()->create();
    $proposal = Proposal::factory()->create(['user_id' => $author->id]);

    $this->actingAs($commenter)->post("/proposals/{$proposal->id}/comments", [
        'body' => 'ping',
    ]);

    expect(daoUnread($author))->toBe(1);
});

test('a reply notifies the parent comment author too', function () {
    $proposalAuthor = User::factory()->create();
    $parentAuthor = User::factory()->create();
    $replier = User::factory()->create();
    $proposal = Proposal::factory()->create(['user_id' => $proposalAuthor->id]);
    $parent = ProposalComment::factory()->create([
        'proposal_id' => $proposal->id,
        'user_id' => $parentAuthor->id,
    ]);

    $this->actingAs($replier)->post("/proposals/{$proposal->id}/comments", [
        'body' => 'reply',
        'parent_id' => $parent->id,
    ]);

    expect(daoUnread($parentAuthor))->toBe(1)
        ->and(daoUnread($proposalAuthor))->toBe(1)
        ->and(daoUnread($replier))->toBe(0);
});

test('a vote notifies the proposal author', function () {
    $author = User::factory()->create();
    $voter = User::factory()->create();
    $proposal = Proposal::factory()->open()->create(['user_id' => $author->id]);

    $this->actingAs($voter)->post("/proposals/{$proposal->id}/votes", [
        'wallet_address' => '0x1234567890abcdef1234567890abcdef12345678',
        'support' => true,
    ]);

    expect(daoUnread($author))->toBe(1);
});

test('a reaction notifies the content author but not self-reactions', function () {
    $author = User::factory()->create();
    $reactor = User::factory()->create();
    $proposal = Proposal::factory()->create(['user_id' => $author->id]);

    $this->actingAs($reactor)->post('/reactions', [
        'reactable_type' => 'proposal',
        'reactable_id' => $proposal->id,
        'emoji' => '🔥',
    ]);
    // Self-reaction must not notify.
    $this->actingAs($author)->post('/reactions', [
        'reactable_type' => 'proposal',
        'reactable_id' => $proposal->id,
        'emoji' => '👍',
    ]);

    expect(daoUnread($author))->toBe(1)
        ->and(daoUnread($reactor))->toBe(0);
});

/**
 * Everyone hears about everything: an action reaches every account and every
 * wallet installation that allowed push — not only the people it is about —
 * and never the account that did it.
 */
function subscribedAudience(): array
{
    config()->set('webpush.vapid.public_key', 'BFyCqu6c1-7IfXmNbjkQX4wGEwLVxsoeQ5YZU7iz24zlEdpNsh5i2_Gzv8lzHjuA_CClN7_xRuJQM9LfvPoigJY');
    config()->set('webpush.vapid.private_key', '32q0BGHK6sEQfAIHRhSSFH7p7LyHQWggbt3kMtorb4s');
    config()->set('webpush.vapid.subject', 'https://cyberia.test');

    $actor = User::factory()->create(['wallet_address' => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    $actor->updatePushSubscription('https://push.example/actor', 'k', 'a');
    $reader = User::factory()->create();
    $reader->updatePushSubscription('https://push.example/reader', 'k', 'a');
    $silent = User::factory()->create();

    $install = AnalyticsUser::query()->create([
        'id' => (string) Str::uuid(),
        'first_seen_at' => now(),
        'last_seen_at' => now(),
    ]);
    $install->updatePushSubscription('https://push.example/install', 'k', 'a');

    return [$actor, $reader, $silent, $install];
}

test('a proposal and a vote on it reach everyone subscribed, not the actor', function () {
    Notification::fake();
    [$actor, $reader, $silent, $install] = subscribedAudience();
    $dao = Dao::factory()->create();

    $this->actingAs($actor)->post("/dao/{$dao->id}/proposals", [
        'dao_id' => $dao->id,
        'title' => 'Everyone should hear',
        'ends_at' => now()->addWeek()->toIso8601String(),
    ]);
    $proposal = Proposal::query()->latest('id')->first();

    $this->actingAs($actor)->postJson("/api/wallet/dao/proposals/{$proposal->id}/vote", [
        'address' => $actor->wallet_address,
        'support' => true,
    ])->assertOk();

    foreach (['proposal.created', 'vote.cast'] as $type) {
        Notification::assertSentTo($reader, DaoActivityNotification::class, fn ($n) => $n->type === $type);
        Notification::assertSentTo($install, DaoActivityNotification::class, fn ($n) => $n->type === $type);
    }

    Notification::assertNotSentTo($actor, DaoActivityNotification::class);
    Notification::assertNotSentTo($silent, DaoActivityNotification::class);
});

test('a new DAO and a comment are announced, and land on the proposal in the wallet', function () {
    Notification::fake();
    [$actor, $reader, , $install] = subscribedAudience();
    $proposal = Proposal::factory()->create();

    $this->actingAs($actor)->postJson("/api/wallet/dao/proposals/{$proposal->id}/comments", [
        'address' => $actor->wallet_address,
        'body' => 'hello all',
    ])->assertCreated();

    Notification::assertSentTo($install, DaoActivityNotification::class, function ($n) use ($install, $proposal) {
        return $n->type === 'comment.posted'
            && $n->url === "/wallet?section=dao&proposal={$proposal->id}"
            && str_contains($n->bodyFor($install), 'hello all');
    });
    Notification::assertSentTo($reader, DaoActivityNotification::class, fn ($n) => $n->type === 'comment.posted');
});

test('the notification speaks the recipient\'s language', function () {
    $reader = User::factory()->create(['notification_locale' => 'ru']);
    $notification = new DaoActivityNotification(
        type: 'vote.cast',
        actor: null,
        title: ['en' => 'New vote on {title}', 'ru' => 'Новый голос: {title}'],
        body: ['en' => '{name} voted for', 'ru' => '{name} проголосовал за'],
        params: ['title' => 'X', 'name' => 'lain'],
        url: '/wallet?section=dao',
    );

    expect($notification->titleFor($reader))->toBe('Новый голос: X')
        ->and($notification->bodyFor($reader))->toBe('lain проголосовал за');
});

function createBotActivityTable(): void
{
    Schema::create('activity_events', function ($table) {
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

test('every new on-chain action is pushed to everyone once, history excepted', function () {
    Notification::fake();
    [$actor, $reader, , $install] = subscribedAudience();
    Cache::forget(FeedAnnounceActivityCommand::CURSOR);
    createBotActivityTable();

    $swap = fn (?float $usd) => ['kind' => 'swap', 'usd' => $usd, 'sym_in' => 'CYBER', 'amt_in' => 100,
        'sym_out' => 'USDC', 'amt_out' => $usd ?? 1, 'user_addr' => $actor->wallet_address, 'tx_hash' => '0x1', 'meta' => null];

    // History: the first run only marks where "new" begins.
    DB::table('activity_events')->insert($swap(50));
    Artisan::call('feed:announce-activity');
    Notification::assertNothingSent();

    DB::table('activity_events')->insert([
        $swap(12.5),
        $swap(0.2),
        $swap(null),
        ['kind' => 'liq_add', 'usd' => 50, 'sym_in' => 'CYBER', 'amt_in' => 1, 'sym_out' => 'USDC', 'amt_out' => 25,
            'user_addr' => '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'tx_hash' => '0x2', 'meta' => null],
        ['kind' => 'bridge', 'usd' => 40, 'sym_in' => 'USDC', 'amt_in' => 40, 'sym_out' => null, 'amt_out' => null,
            'user_addr' => '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'tx_hash' => '0x3', 'meta' => 'sol_to_evm'],
    ]);
    Artisan::call('feed:announce-activity');
    Artisan::call('feed:announce-activity');

    // Every one of them, dust and unpriced included — each pushed once.
    Notification::assertSentToTimes($reader, CommunityNotification::class, 5);
    Notification::assertSentTo($install, CommunityNotification::class, function ($n) use ($install) {
        return $n->type === 'trade' && $n->bodyFor($install) === '100 CYBER → 12.5 USDC · $12.50';
    });
    Notification::assertSentTo($install, CommunityNotification::class, function ($n) use ($install) {
        return $n->type === 'trade' && $n->bodyFor($install) === '100 CYBER → 1 USDC';
    });
    Notification::assertSentTo($install, CommunityNotification::class, function ($n) use ($install) {
        return $n->type === 'chain.liq_add'
            && $n->titleFor($install) === '0xbbbb…bbbb added liquidity'
            && $n->bodyFor($install) === '1 CYBER + 25 USDC · $50.00';
    });
    Notification::assertSentTo($install, CommunityNotification::class, function ($n) use ($install) {
        return $n->type === 'chain.bridge' && $n->bodyFor($install) === '40 USDC · Solana → Cyberia · $40.00';
    });
    // The actor hears about somebody else's two actions and none of their own.
    Notification::assertSentToTimes($actor, CommunityNotification::class, 2);
});

test('a dollar floor brings back pushing only what clears it', function () {
    Notification::fake();
    [, $reader] = subscribedAudience();
    config()->set('wallet.feed.trade_floor_usd', 1);
    createBotActivityTable();
    Cache::forever(FeedAnnounceActivityCommand::CURSOR, 0);

    DB::table('activity_events')->insert([
        ['kind' => 'swap', 'usd' => 12.5, 'sym_in' => 'CYBER', 'amt_in' => 100, 'sym_out' => 'USDC', 'amt_out' => 12.5],
        ['kind' => 'swap', 'usd' => 0.2, 'sym_in' => 'CYBER', 'amt_in' => 1, 'sym_out' => 'USDC', 'amt_out' => 0.2],
        ['kind' => 'stake', 'usd' => null, 'sym_in' => 'ASH', 'amt_in' => 5, 'sym_out' => null, 'amt_out' => null],
    ]);

    // The old name still runs, for whoever typed it from memory.
    Artisan::call('feed:announce-trades');

    Notification::assertSentToTimes($reader, CommunityNotification::class, 1);
});
