<?php

use App\Models\Proposal;
use App\Models\User;

/**
 * Commenting on a proposal from inside the wallet: the thread is public, and a
 * comment is written as the signed-in address — never one named in the
 * request, the same rule as a vote.
 */
const WALLET_COMMENTER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

it('refuses a comment from a wallet that has not signed in', function () {
    $proposal = Proposal::factory()->create();

    $this->postJson("/api/wallet/dao/proposals/{$proposal->id}/comments", [
        'address' => WALLET_COMMENTER,
        'body' => 'hello',
    ])->assertUnauthorized();

    expect($proposal->comments()->count())->toBe(0);
});

it('comments and replies as the signed-in address, and the thread reads it back', function () {
    $user = User::factory()->create(['wallet_address' => WALLET_COMMENTER]);
    $proposal = Proposal::factory()->create();

    $first = $this->actingAs($user)
        ->postJson("/api/wallet/dao/proposals/{$proposal->id}/comments", [
            'address' => WALLET_COMMENTER,
            'body' => '  **agreed**  ',
        ])
        ->assertCreated()
        ->json('id');

    $this->actingAs($user)
        ->postJson("/api/wallet/dao/proposals/{$proposal->id}/comments", [
            'address' => WALLET_COMMENTER,
            'body' => 'a reply',
            'parent_id' => $first,
        ])
        ->assertCreated();

    $this->getJson("/api/wallet/dao/proposals/{$proposal->id}/comments")
        ->assertOk()
        ->assertJsonCount(1, 'comments')
        ->assertJsonPath('comments.0.id', $first)
        ->assertJsonPath('comments.0.who.address', WALLET_COMMENTER)
        ->assertJsonPath('comments.0.replies.0.who.address', WALLET_COMMENTER)
        ->assertJson(fn ($json) => $json
            ->where('comments.0.bodyHtml', fn ($html) => str_contains($html, '<strong>agreed</strong>'))
            ->etc());

    expect($proposal->comments()->count())->toBe(2);
});

it('refuses a session that belongs to a different wallet', function () {
    $user = User::factory()->create(['wallet_address' => WALLET_COMMENTER]);
    $proposal = Proposal::factory()->create();

    $this->actingAs($user)
        ->postJson("/api/wallet/dao/proposals/{$proposal->id}/comments", [
            'address' => '0xcccccccccccccccccccccccccccccccccccccccc',
            'body' => 'hello',
        ])
        ->assertStatus(409)
        ->assertJsonPath('reason', 'otherAccount');

    expect($proposal->comments()->count())->toBe(0);
});

it('refuses a reply to a comment on another proposal', function () {
    $user = User::factory()->create(['wallet_address' => WALLET_COMMENTER]);
    $proposal = Proposal::factory()->create();
    $elsewhere = Proposal::factory()->create()->comments()->create([
        'user_id' => $user->id,
        'body' => 'elsewhere',
    ]);

    $this->actingAs($user)
        ->postJson("/api/wallet/dao/proposals/{$proposal->id}/comments", [
            'address' => WALLET_COMMENTER,
            'body' => 'hello',
            'parent_id' => $elsewhere->id,
        ])
        ->assertUnprocessable();
});
