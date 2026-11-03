<?php

use App\Models\AnalyticsUser;
use App\Models\FcmToken;
use App\Notifications\FeedPostNotification;
use App\Services\Social\Broadcaster;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;

/*
 * The native app rings: its FCM token is kept against the installation, and
 * every public notification the browsers get as Web Push also goes through
 * Firebase. A token Firebase says is gone is forgotten.
 */

function fcmInstall(): AnalyticsUser
{
    return AnalyticsUser::create([
        'id' => (string) Str::uuid(),
        'created_at' => now(),
        'first_seen_at' => now(),
        'last_seen_at' => now(),
        'platform' => 'android',
    ]);
}

function fcmCredentials(): string
{
    $key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
    openssl_pkey_export($key, $pem);
    $path = tempnam(sys_get_temp_dir(), 'fcm');
    file_put_contents($path, json_encode([
        'type' => 'service_account',
        'project_id' => 'cyberia-test',
        'client_email' => 'push@cyberia-test.iam.gserviceaccount.com',
        'private_key' => $pem,
        'token_uri' => 'https://oauth2.googleapis.com/token',
    ]));

    return $path;
}

it('keeps an installation\'s FCM token and refuses an unknown installation', function () {
    $install = fcmInstall();

    $this->postJson('/api/analytics/push/fcm', ['user_id' => $install->id, 'token' => str_repeat('t', 40), 'locale' => 'ru'])
        ->assertOk()->assertJson(['registered' => true]);
    $this->postJson('/api/analytics/push/fcm', ['user_id' => (string) Str::uuid(), 'token' => str_repeat('u', 40)])
        ->assertNotFound();

    expect(FcmToken::where('analytics_user_id', $install->id)->count())->toBe(1);

    $this->deleteJson('/api/analytics/push/fcm', ['token' => str_repeat('t', 40)])->assertOk();
    expect(FcmToken::count())->toBe(0);
});

it('sends a public notification to the apps through Firebase and forgets a dead token', function () {
    config()->set('services.fcm.credentials', fcmCredentials());
    $live = FcmToken::create(['token' => str_repeat('a', 40), 'analytics_user_id' => fcmInstall()->id]);
    $dead = FcmToken::create(['token' => str_repeat('b', 40), 'analytics_user_id' => fcmInstall()->id]);
    Http::fake([
        'oauth2.googleapis.com/*' => Http::response(['access_token' => 'ya29.test', 'expires_in' => 3600]),
        'fcm.googleapis.com/*' => fn (Request $request) => $request['message']['token'] === $dead->token
            ? Http::response(['error' => ['status' => 'NOT_FOUND', 'message' => 'Requested entity was not found.']], 404)
            : Http::response(['name' => 'projects/cyberia-test/messages/1']),
    ]);

    app(Broadcaster::class)->broadcast(new FeedPostNotification('lain', 'gm from the feed', '/wallet?section=feed'));

    Http::assertSent(fn (Request $request) => str_contains($request->url(), 'projects/cyberia-test/messages:send')
        && $request['message']['token'] === $live->token
        && $request['message']['data']['url'] === '/wallet?section=feed'
        && $request->hasHeader('Authorization', 'Bearer ya29.test'));
    expect(FcmToken::whereKey($dead->id)->exists())->toBeFalse()
        ->and(FcmToken::whereKey($live->id)->exists())->toBeTrue();
});

it('sends nothing to Firebase while it is not configured', function () {
    config()->set('services.fcm.credentials', null);
    FcmToken::create(['token' => str_repeat('a', 40), 'analytics_user_id' => fcmInstall()->id]);
    Http::fake();

    app(Broadcaster::class)->broadcast(new FeedPostNotification('lain', 'gm', '/wallet'));

    Http::assertNotSent(fn (Request $request) => str_contains($request->url(), 'googleapis.com'));
});
