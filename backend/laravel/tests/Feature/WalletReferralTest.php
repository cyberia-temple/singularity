<?php

use App\Models\ReferralPayout;
use App\Models\ReferralReward;
use App\Models\User;
use App\Notifications\ReferralRewardNotification;
use App\Services\ReferralService;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Notification;

/**
 * Referrals: a share of the fee a friend actually paid, and nothing else.
 *
 * The tests that matter are about who can create an earning. An invite only
 * attaches to a new account, once, and never to its own inviter; an earning
 * only comes from a swap the router recorded as finished, sent by the invited
 * account after the invite, with an app fee paid to *this* host's address —
 * and reading the same swap twice pays it once.
 */
const REF_API = 'https://router.test';
const REF_FEE_ADDRESS = '0x2222222222222222222222222222222222222222';

/**
 * A router request, by default made ten minutes ago — after refPair()'s invite
 * an hour ago. A fixed date here turns into "before the invite" once the
 * calendar passes it, and the sync rightly skips swaps from before an invite.
 */
function refRequest(string $id, string $status, float $feeUsd, string $recipient = REF_FEE_ADDRESS, ?string $at = null): array
{
    return [
        'id' => $id,
        'status' => $status,
        'user' => '0xfriend',
        'createdAt' => $at ?? now()->subMinutes(10)->toIso8601ZuluString(),
        'data' => [
            'appFees' => [
                'quoted' => [['recipient' => $recipient, 'bps' => '75', 'amount' => '1']],
                'actual' => [['recipient' => $recipient, 'bps' => '75', 'amount' => '1', 'amountUsd' => (string) $feeUsd]],
            ],
        ],
    ];
}

function refFakeRouter(array $requests): void
{
    Http::fake([
        REF_API.'/requests/v3*' => Http::response(['requests' => $requests]),
    ]);
}

/** An inviter with a code, and a fresh friend who accepted it an hour ago. */
function refPair(): array
{
    $inviter = User::factory()->create(['wallet_address' => '0x'.str_repeat('a', 40)]);
    $code = app(ReferralService::class)->codeFor($inviter);

    $friend = User::factory()->create(['wallet_address' => '0x'.str_repeat('b', 40)]);
    $friend->forceFill(['referred_by' => $inviter->id, 'referred_at' => now()->subHour()])->save();

    return [$inviter, $friend, $code];
}

beforeEach(function () {
    Cache::flush();
    config()->set('crosschain.enabled', true);
    config()->set('crosschain.api', REF_API);
    config()->set('crosschain.fee.address', REF_FEE_ADDRESS);
    config()->set('crosschain.fee.bps', 75);
    config()->set('referrals.enabled', true);
    config()->set('referrals.share_bps', 2500);
    config()->set('referrals.attach_window_days', 30);
    config()->set('referrals.payout.minimum_usd', 1.0);
});

it('tells a signed-out wallet the rules and nothing about anybody', function () {
    $this->getJson('/api/wallet/referrals')
        ->assertOk()
        ->assertJsonPath('signedIn', false)
        ->assertJsonPath('account', null)
        ->assertJsonPath('program.shareBps', 2500)
        ->assertJsonPath('program.collecting', true)
        ->assertJsonPath('program.payout.cadence', 'weekly');
});

it('gives a signed-in account its own code and link, once', function () {
    $user = User::factory()->create();

    $first = $this->actingAs($user)->getJson('/api/wallet/referrals')->assertOk();
    $code = $first->json('account.code');

    expect($code)->toMatch('/^[2-9A-HJ-NP-Z]{8}$/')
        ->and($first->json('account.link'))->toEndWith('/r/'.$code)
        ->and($first->json('account.invited'))->toBe(0);

    // Asking again does not mint a second code.
    $this->actingAs($user)->getJson('/api/wallet/referrals')->assertJsonPath('account.code', $code);
});

it('says plainly when no fee is collected, so nothing can be earned', function () {
    config()->set('crosschain.fee.address', '');

    $this->getJson('/api/wallet/referrals')->assertJsonPath('program.collecting', false);
});

it('attaches a new account to the inviter whose code it brings', function () {
    $inviter = User::factory()->create();
    $code = app(ReferralService::class)->codeFor($inviter);
    $friend = User::factory()->create();

    $this->actingAs($friend)
        ->postJson('/api/wallet/referrals/attach', ['code' => strtolower($code)])
        ->assertOk()
        ->assertJsonPath('account.invitedBy', true);

    expect($friend->fresh()->referred_by)->toBe($inviter->id)
        ->and($inviter->referrals()->count())->toBe(1);
});

it('refuses to accept an invite without an account', function () {
    $this->postJson('/api/wallet/referrals/attach', ['code' => 'ABCDEFGH'])
        ->assertStatus(401)
        ->assertJsonPath('reason', 'signed_out');
});

it('refuses an account its own code', function () {
    $user = User::factory()->create();
    $code = app(ReferralService::class)->codeFor($user);

    $this->actingAs($user)
        ->postJson('/api/wallet/referrals/attach', ['code' => $code])
        ->assertStatus(422)
        ->assertJsonPath('reason', 'own_code');
});

it('never moves an account to a second inviter', function () {
    [$inviter, $friend] = refPair();
    $other = User::factory()->create();
    $otherCode = app(ReferralService::class)->codeFor($other);

    $this->actingAs($friend)
        ->postJson('/api/wallet/referrals/attach', ['code' => $otherCode])
        ->assertStatus(422)
        ->assertJsonPath('reason', 'already_invited');

    expect($friend->fresh()->referred_by)->toBe($inviter->id);
});

it('refuses an account that was here long before the invite', function () {
    $inviter = User::factory()->create();
    $code = app(ReferralService::class)->codeFor($inviter);
    $old = User::factory()->create(['created_at' => now()->subDays(45)]);

    $this->actingAs($old)
        ->postJson('/api/wallet/referrals/attach', ['code' => $code])
        ->assertStatus(422)
        ->assertJsonPath('reason', 'too_old');
});

it('refuses two people inviting each other', function () {
    [$inviter, $friend] = refPair();
    $friendCode = app(ReferralService::class)->codeFor($friend);

    $this->actingAs($inviter)
        ->postJson('/api/wallet/referrals/attach', ['code' => $friendCode])
        ->assertStatus(422)
        ->assertJsonPath('reason', 'circular');
});

it('refuses a code nobody owns', function () {
    $this->actingAs(User::factory()->create())
        ->postJson('/api/wallet/referrals/attach', ['code' => 'ZZZZZZZZ'])
        ->assertStatus(422)
        ->assertJsonPath('reason', 'unknown_code');
});

it('pays the inviter a quarter of the fee a friend’s finished swap paid us', function () {
    Notification::fake();
    [$inviter, $friend] = refPair();

    refFakeRouter([
        refRequest('0xdone', 'success', 2.0),
        refRequest('0xrefunded', 'refund', 5.0),
        refRequest('0xpending', 'pending', 5.0),
        refRequest('0xsomebodyelse', 'success', 9.0, '0x3333333333333333333333333333333333333333'),
    ]);

    $this->artisan('referrals:sync')->assertSuccessful();

    $rewards = ReferralReward::all();

    expect($rewards)->toHaveCount(1)
        ->and($rewards[0]->source_id)->toBe('0xdone')
        ->and($rewards[0]->referrer_id)->toBe($inviter->id)
        ->and($rewards[0]->referee_id)->toBe($friend->id)
        ->and((float) $rewards[0]->fee_usd)->toBe(2.0)
        ->and((float) $rewards[0]->reward_usd)->toBe(0.5)
        ->and($rewards[0]->share_bps)->toBe(2500);

    Notification::assertSentTo($inviter, ReferralRewardNotification::class);

    // The router was asked about the friend's own address, from the invite on.
    Http::assertSent(fn (Request $request) => str_contains($request->url(), '/requests/v3')
        && $request['user'] === $friend->wallet_address
        && (int) $request['startTimestamp'] === $friend->referred_at->getTimestamp());
});

it('pays a swap once however many times it is read', function () {
    Notification::fake();
    refPair();
    refFakeRouter([refRequest('0xdone', 'success', 2.0)]);

    $this->artisan('referrals:sync')->assertSuccessful();
    $this->artisan('referrals:sync')->assertSuccessful();

    expect(ReferralReward::count())->toBe(1);
    Notification::assertSentTimes(ReferralRewardNotification::class, 1);
});

it('ignores swaps made before the invite', function () {
    Notification::fake();
    refPair();
    refFakeRouter([refRequest('0xbefore', 'success', 2.0, REF_FEE_ADDRESS, now()->subDays(3)->toIso8601String())]);

    $this->artisan('referrals:sync')->assertSuccessful();

    expect(ReferralReward::count())->toBe(0);
});

it('earns nothing while no fee is collected', function () {
    refPair();
    config()->set('crosschain.fee.address', '');
    Http::fake();

    $this->artisan('referrals:sync')->assertSuccessful();

    expect(ReferralReward::count())->toBe(0);
    Http::assertNothingSent();
});

it('shows the inviter what they earned and what was paid', function () {
    Notification::fake();
    [$inviter] = refPair();
    refFakeRouter([refRequest('0xone', 'success', 4.0), refRequest('0xtwo', 'success', 2.0)]);
    $this->artisan('referrals:sync')->assertSuccessful();

    $this->actingAs($inviter)->getJson('/api/wallet/referrals')
        ->assertJsonPath('account.invited', 1)
        ->assertJsonPath('account.earning', 1)
        ->assertJsonPath('account.earnedUsd', 1.5)
        ->assertJsonPath('account.paidUsd', 0)
        ->assertJsonPath('account.pendingUsd', 1.5)
        ->assertJsonPath('account.recent.0.state', 'accrued');
});

it('prepares, approves and records a weekly payout, with a person at each step', function () {
    Notification::fake();
    [$inviter] = refPair();
    refFakeRouter([refRequest('0xone', 'success', 4.0), refRequest('0xtwo', 'success', 2.0)]);
    $this->artisan('referrals:sync')->assertSuccessful();

    $this->artisan('referrals:payouts --prepare')->assertSuccessful();

    $payout = ReferralPayout::sole();
    expect($payout->status)->toBe(ReferralPayout::PENDING)
        ->and((float) $payout->amount_usd)->toBe(1.5)
        ->and(ReferralReward::whereNull('payout_id')->count())->toBe(0);

    // Not paid before somebody approves it.
    $this->artisan('referrals:payouts --paid='.$payout->id.' --tx=0xabc')->assertFailed();

    $this->artisan('referrals:payouts --approve='.$payout->id)->assertSuccessful();
    $this->artisan('referrals:payouts --paid='.$payout->id.' --tx=0xabc')->assertSuccessful();

    expect($payout->fresh()->status)->toBe(ReferralPayout::PAID)
        ->and($payout->fresh()->tx_reference)->toBe('0xabc');

    $this->actingAs($inviter)->getJson('/api/wallet/referrals')
        ->assertJsonPath('account.paidUsd', 1.5)
        ->assertJsonPath('account.pendingUsd', 0)
        ->assertJsonPath('account.recent.0.state', 'paid');
});

it('holds a balance under the minimum for a later week', function () {
    Notification::fake();
    refPair();
    refFakeRouter([refRequest('0xsmall', 'success', 0.4)]);
    $this->artisan('referrals:sync')->assertSuccessful();

    $this->artisan('referrals:payouts --prepare')->assertSuccessful();

    expect(ReferralPayout::count())->toBe(0)
        ->and(ReferralReward::whereNull('payout_id')->count())->toBe(1);
});

it('returns a cancelled payout’s earnings to the next run', function () {
    Notification::fake();
    refPair();
    refFakeRouter([refRequest('0xone', 'success', 8.0)]);
    $this->artisan('referrals:sync')->assertSuccessful();
    $this->artisan('referrals:payouts --prepare')->assertSuccessful();

    $payout = ReferralPayout::sole();
    $this->artisan('referrals:payouts --cancel='.$payout->id)->assertSuccessful();

    expect($payout->fresh()->status)->toBe(ReferralPayout::CANCELLED)
        ->and(ReferralReward::whereNull('payout_id')->count())->toBe(1);
});

it('forwards a shared link to the wallet’s invite screen with the code', function () {
    $this->get('/r/abcd2345')->assertRedirect('/wallet?section=invite&invite=ABCD2345');
    $this->get('/r/!!')->assertNotFound();
});
