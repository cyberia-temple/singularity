<?php

use App\Models\Post;
use App\Models\User;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

it('records idempotent reactions, displays reposts, and keeps personal state out of the shared cache', function () {
    $author = User::factory()->create();
    $reader = User::factory()->create(['wallet_address' => '0x'.str_repeat('a', 40)]);
    $other = User::factory()->create(['wallet_address' => '0x'.str_repeat('b', 40)]);
    $post = Post::factory()->create(['user_id' => $author->id]);
    $payload = ['address' => $reader->wallet_address, 'kind' => 'like', 'active' => true];
    $this->postJson("/api/wallet/feed/{$post->id}/reaction", $payload)->assertUnauthorized();
    $this->actingAs($reader)->postJson("/api/wallet/feed/{$post->id}/reaction", $payload)->assertOk()->assertJsonPath('count', 1);
    $this->postJson("/api/wallet/feed/{$post->id}/reaction", $payload)->assertJsonPath('count', 1);
    $this->postJson("/api/wallet/feed/{$post->id}/reaction", [...$payload, 'kind' => 'repost'])->assertJsonPath('count', 1);
    $this->getJson('/api/wallet/feed?tab=posts')->assertJsonFragment(['liked' => true, 'reposted' => true])->assertJsonFragment(['repostId' => DB::table('post_reactions')->where('kind', 'repost')->value('id')]);
    $this->actingAs($other)->getJson('/api/wallet/feed?tab=posts')->assertJsonFragment(['liked' => false, 'reposted' => false]);
    $this->postJson("/api/wallet/feed/{$post->id}/reaction", [...$payload, 'active' => false])->assertStatus(409);
    $this->actingAs($reader)->postJson("/api/wallet/feed/{$post->id}/reaction", [...$payload, 'active' => false])->assertJsonPath('count', 0);
    $this->postJson("/api/wallet/feed/{$post->id}/reaction", [...$payload, 'kind' => 'repost', 'active' => false])->assertJsonPath('count', 0);
    $this->getJson('/api/wallet/feed?tab=posts')->assertJsonMissingPath('items.1.repostId');
});

it('saves and returns replies and counts one view per session per day', function () {
    $post = Post::factory()->create();
    $user = User::factory()->create(['wallet_address' => '0x'.str_repeat('c', 40)]);
    $response = $this->postJson("/api/wallet/feed/{$post->id}/view")->assertJsonPath('count', 1);
    $this->withCredentials()->withCookie(config('session.cookie'), $response->getCookie(config('session.cookie'))->getValue());
    $this->postJson("/api/wallet/feed/{$post->id}/view")->assertJsonPath('count', 1);
    $this->postJson("/api/wallet/feed/{$post->id}/replies", ['body' => 'hi'])->assertUnauthorized();
    $this->actingAs($user)->postJson("/api/wallet/feed/{$post->id}/replies", ['address' => $user->wallet_address, 'body' => 'hello'])->assertOk()->assertJsonPath('replies.0.body', 'hello');
    $this->getJson('/api/wallet/feed?tab=posts')->assertJsonPath('items.0.engagement.replies', 1)->assertJsonPath('items.0.engagement.views', 1);
    $post->forceFill(['hidden_at' => now()])->save();
    Cache::flush();
    $this->getJson("/api/wallet/feed/{$post->id}/replies")->assertNotFound();
    $this->postJson("/api/wallet/feed/{$post->id}/view")->assertNotFound();
    $this->postJson("/api/wallet/feed/{$post->id}/reaction", ['address' => $user->wallet_address, 'kind' => 'like', 'active' => true])->assertNotFound();
});

it('pages older replies without hiding new replies', function () {
    $post = Post::factory()->create();
    $user = User::factory()->create(['wallet_address' => '0x'.str_repeat('d', 40)]);
    foreach (range(1, 102) as $number) {
        DB::table('post_replies')->insert(['post_id' => $post->id, 'user_id' => $user->id, 'body' => "reply {$number}", 'created_at' => now(), 'updated_at' => now()]);
    }
    $page = $this->getJson("/api/wallet/feed/{$post->id}/replies")->assertOk()->assertJsonCount(100, 'replies')->assertJsonPath('hasMore', true)->json();
    expect($page['replies'][0]['body'])->toBe('reply 3');
    $this->getJson("/api/wallet/feed/{$post->id}/replies?before={$page['replies'][0]['id']}")->assertOk()->assertJsonCount(2, 'replies')->assertJsonPath('hasMore', false)->assertJsonPath('replies.0.body', 'reply 1');
    $this->actingAs($user)->postJson("/api/wallet/feed/{$post->id}/replies", ['address' => $user->wallet_address, 'body' => 'latest'])->assertOk()->assertJsonPath('replies.99.body', 'latest');
});
