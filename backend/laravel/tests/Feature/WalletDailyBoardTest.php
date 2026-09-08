<?php

use App\Models\User;
use App\Services\GamificationService;
use Illuminate\Support\Facades\Cache;

/**
 * The wallet's daily board.
 *
 * Two things are worth pinning here and they are both about honesty rather
 * than arithmetic: a board read by nobody must not report zeroes as if they
 * were somebody's score, and a check-in must say what it actually granted —
 * the second press of a day grants nothing, and a screen that celebrated it
 * anyway would be paying in a currency it did not mint.
 */
beforeEach(function () {
    Cache::flush();
});

it('answers a wallet with no account with the catalogue and no score', function () {
    $response = $this->getJson('/api/wallet/daily');

    $response->assertOk()
        ->assertJsonPath('signedIn', false)
        ->assertJsonPath('standing', null)
        ->assertJsonPath('account', null);

    $quests = $response->json('quests');

    expect($quests)->not->toBeEmpty();

    // Null and never 0: nobody is standing here, so there is no progress to
    // report about them.
    foreach ($quests as $quest) {
        expect($quest['progress'])->toBeNull()
            ->and($quest['completed'])->toBeFalse()
            ->and($quest['actions'])->toBeArray();
    }
});

it('sends what a streak pays before anybody has a streak', function () {
    $response = $this->getJson('/api/wallet/daily');

    expect($response->json('streakBonuses'))
        ->toBe(array_map('intval', config('gamification.streak_bonuses')));
});

it('reports the signed-in account’s own standing and progress', function () {
    $user = User::factory()->create();

    app(GamificationService::class)->recordAction($user, 'swap', '0xdeadbeef');

    $response = $this->actingAs($user)->getJson('/api/wallet/daily');

    $response->assertOk()
        ->assertJsonPath('signedIn', true)
        ->assertJsonPath('standing.activeToday', true);

    expect($response->json('standing.xp'))->toBeGreaterThan(0)
        ->and($response->json('standing.currentStreak'))->toBe(1);

    $trade = collect($response->json('quests'))->firstWhere('key', 'daily_trade');

    expect($trade['progress'])->toBe(1)
        ->and($trade['completed'])->toBeTrue();
});

it('refuses a check-in from a wallet with no account', function () {
    $this->postJson('/api/wallet/daily/check-in')->assertStatus(401);
});

it('grants the visit once a day and says so on the second press', function () {
    $user = User::factory()->create();

    $first = $this->actingAs($user)->postJson('/api/wallet/daily/check-in');

    $first->assertOk();
    expect($first->json('granted'))->toBeGreaterThanOrEqual(
        (int) config('gamification.xp.visit'),
    );
    expect($first->json('standing.currentStreak'))->toBe(1);

    $second = $this->actingAs($user)->postJson('/api/wallet/daily/check-in');

    $second->assertOk();
    expect($second->json('granted'))->toBe(0)
        ->and($second->json('standing.xp'))->toBe($first->json('standing.xp'));
});

it('checking in is the same event as showing up, so the visit quest moves', function () {
    $user = User::factory()->create();

    $response = $this->actingAs($user)->postJson('/api/wallet/daily/check-in');

    $visit = collect($response->json('quests'))->firstWhere('key', 'daily_visit');

    // The board draws this row right under the button that was just pressed;
    // leaving it at 0/1 would be two answers to one question.
    expect($visit['progress'])->toBe(1)
        ->and($visit['completed'])->toBeTrue();
});

it('names the next thing experience buys, and never one already bought', function () {
    $user = User::factory()->create();

    $response = $this->actingAs($user)->getJson('/api/wallet/daily');

    $unlock = $response->json('nextUnlock');

    expect($unlock['key'])->toBe('nocarrier')
        ->and($unlock['state'])->not->toBe('owned')
        ->and($unlock['cost'])->toBe((int) config('gamification.unlocks.0.cost'));
});
