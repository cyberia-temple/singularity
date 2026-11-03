<?php

use App\Models\User;
use App\Support\WebStats;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;

/**
 * The page counter (Umami on this host): who carries its tag, and the console
 * door that signs an operator into its dashboard.
 */
beforeEach(function () {
    $this->withoutVite();
    config()->set('analytics.respect_dnt', true);
    config()->set('analytics.umami', [
        'enabled' => true,
        'url' => 'https://stats.cyberia.church',
        'internal_url' => 'http://umami:3000',
        'website_id' => '4955f251-c9ac-464b-adce-14c8ea75eaf2',
        'domains' => 'cyberia.church,www.cyberia.church',
        'password' => 'secret-from-bootstrap',
    ]);
    config()->set('crm.admin_user_ids', []);
    config()->set('crm.admin_wallets', []);
});

it('counts an ordinary visitor with the counter on this host', function () {
    $this->get(route('changelog'))
        ->assertOk()
        ->assertSee('src="https://stats.cyberia.church/s.js"', false)
        ->assertSee('data-website-id="4955f251-c9ac-464b-adce-14c8ea75eaf2"', false)
        ->assertSee('data-domains="cyberia.church,www.cyberia.church"', false)
        ->assertSee('window.cyberiaStatsBeforeSend', false);

    expect($this->get(route('home'))->getContent())->toContain('/s.js');
});

it('leaves out whoever the recorder leaves out, and everyone when off', function () {
    $operator = User::factory()->create();
    config()->set('crm.admin_user_ids', [$operator->id]);

    $this->actingAs($operator)->get(route('changelog'))->assertOk()->assertDontSee('/s.js', false);

    expect(WebStats::for(Request::create('/', 'GET', server: ['HTTP_DNT' => '1'])))->toBeNull()
        ->and(WebStats::for(Request::create('/', 'GET', server: ['HTTP_USER_AGENT' => 'Mozilla/5.0 CyberiaStore/play'])))->toBeNull()
        ->and(WebStats::for(Request::create('/')))->not->toBeNull();

    config()->set('analytics.umami.enabled', false);
    expect(WebStats::for(Request::create('/')))->toBeNull();
});

it('signs an operator into the dashboard without showing the password', function () {
    Http::fake(['umami:3000/api/auth/login' => Http::response(['token' => 'tok-123'])]);
    $operator = User::factory()->create();
    config()->set('crm.admin_user_ids', [$operator->id]);

    $this->actingAs($operator)->get('/crm/stats')
        ->assertRedirect('https://stats.cyberia.church/sso?token=tok-123&url=%2Fwebsites');

    Http::assertSent(fn ($request) => $request['username'] === 'admin'
        && $request['password'] === 'secret-from-bootstrap');
});

it('falls back to the dashboard login when it cannot sign in', function (?string $password, int $status) {
    Http::fake(['umami:3000/*' => Http::response(['error' => 'x'], $status)]);
    config()->set('analytics.umami.password', $password);
    $operator = User::factory()->create();
    config()->set('crm.admin_user_ids', [$operator->id]);

    $this->actingAs($operator)->get('/crm/stats')
        ->assertRedirect('https://stats.cyberia.church/login');
})->with([
    'no password yet' => [null, 200],
    'refused' => ['wrong', 401],
    'down' => ['secret-from-bootstrap', 502],
]);

it('is no door at all for anybody else', function () {
    Http::fake();

    $this->actingAs(User::factory()->create())->get('/crm/stats')->assertNotFound();

    Http::assertNothingSent();
});
