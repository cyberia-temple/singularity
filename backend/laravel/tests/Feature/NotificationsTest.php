<?php

use App\Models\User;
use App\Notifications\DaoActivityNotification;

test('guests cannot access notifications', function () {
    $response = $this->getJson('/notifications');

    $response->assertUnauthorized();
});

test('notifications index returns unread count and latest items', function () {
    $user = User::factory()->create();
    $actor = User::factory()->create(['name' => 'Actor']);

    $user->notify(new DaoActivityNotification(
        type: 'comment.posted',
        actor: $actor,
        title: ['en' => 'New comment'],
        body: ['en' => 'Actor commented on your proposal'],
        params: [],
        url: '/proposals/1',
    ));

    $response = $this->actingAs($user)->getJson('/notifications');

    $response->assertOk()
        ->assertJsonPath('unread', 1)
        ->assertJsonPath('notifications.0.data.type', 'comment.posted')
        ->assertJsonPath('notifications.0.data.actor_name', 'Actor')
        ->assertJsonPath('notifications.0.data.url', '/proposals/1')
        ->assertJsonPath('notifications.0.read_at', null);
});

test('mark all read clears unread count', function () {
    $user = User::factory()->create();
    $actor = User::factory()->create();

    $user->notify(new DaoActivityNotification('vote.cast', $actor, ['en' => 'New vote'], ['en' => 'Someone voted'], [], '/proposals/1'));
    $user->notify(new DaoActivityNotification('vote.cast', $actor, ['en' => 'New vote'], ['en' => 'Someone voted'], [], '/proposals/2'));

    $response = $this->actingAs($user)->postJson('/notifications/read-all');

    $response->assertOk()->assertJsonPath('unread', 0);
    expect($user->fresh()->unreadNotifications()->count())->toBe(0);
});

test('mark single notification read', function () {
    $user = User::factory()->create();
    $actor = User::factory()->create();

    $user->notify(new DaoActivityNotification('vote.cast', $actor, ['en' => 'New vote'], ['en' => 'Someone voted'], [], '/proposals/1'));
    $notification = $user->notifications()->first();

    $response = $this->actingAs($user)->postJson("/notifications/{$notification->id}/read");

    $response->assertOk()->assertJsonPath('unread', 0);
    expect($notification->fresh()->read_at)->not->toBeNull();
});

test('users cannot mark other users notifications read', function () {
    $user = User::factory()->create();
    $other = User::factory()->create();
    $actor = User::factory()->create();

    $other->notify(new DaoActivityNotification('vote.cast', $actor, ['en' => 'New vote'], ['en' => 'Someone voted'], [], '/proposals/1'));
    $notification = $other->notifications()->first();

    $response = $this->actingAs($user)->postJson("/notifications/{$notification->id}/read");

    $response->assertNotFound();
    expect($notification->fresh()->read_at)->toBeNull();
});
