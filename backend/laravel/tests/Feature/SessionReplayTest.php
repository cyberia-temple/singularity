<?php

use App\Models\User;
use App\Support\SessionReplay;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\File;

/**
 * Who carries the session recorder, decided before the script is named.
 *
 * Pinned: an ordinary visitor gets our own recorder (and no third-party tag)
 * on Inertia pages and on the static landing page; operators, store builds,
 * the desktop shell, a browser saying Do Not Track and a switched-off or
 * unbuilt recorder get nothing; and an account is named only by a tag this
 * server signed.
 */
beforeEach(function () {
    $this->withoutVite();
    config()->set('replay.enabled', true);
    config()->set('analytics.respect_dnt', true);
    config()->set('crm.admin_user_ids', []);
    config()->set('crm.admin_wallets', []);

    $this->recorder = public_path('replay/recorder.js');
    $this->builtHere = ! is_file($this->recorder);

    if ($this->builtHere) {
        File::ensureDirectoryExists(dirname($this->recorder));
        File::put($this->recorder, '/* recorder */');
    }
});

afterEach(function () {
    if ($this->builtHere) {
        File::delete($this->recorder);
    }
});

it('records an ordinary visitor with our own recorder', function () {
    $this->get(route('changelog'))
        ->assertOk()
        ->assertSee('src="/replay/recorder.js?v=', false)
        ->assertSee('data-endpoint="'.url('/api/replay').'"', false)
        ->assertSee('data-paused="/crm,/settings,/teams,/admin"', false)
        ->assertSee('data-hide-notice="true"', false)
        ->assertDontSee('clarity.ms', false);
});

it('records the static landing page too', function () {
    $html = $this->get(route('home'))->assertOk()->getContent();

    expect($html)->toContain('/replay/recorder.js')
        ->toContain('data-hide-notice="true"')
        ->and(strpos($html, '/replay/recorder.js'))->toBeLessThan(strpos($html, '</head>'));
});

it('serves the landing page untouched when recording and counting are off', function () {
    config()->set('replay.enabled', false);
    config()->set('analytics.umami.enabled', false);

    expect($this->get(route('home'))->assertOk()->getContent())
        ->toBe(file_get_contents(resource_path('views/landing/index.html')));
});

it('names a signed-in account only through a signed tag', function () {
    $user = User::factory()->create();
    $who = SessionReplay::who($user->id);

    $this->actingAs($user)->get(route('changelog'))
        ->assertOk()
        ->assertSee('data-who="'.$who.'"', false);

    expect(SessionReplay::account($who))->toBe($user->id)
        ->and(SessionReplay::account($user->id.'.'.str_repeat('0', 32)))->toBeNull()
        ->and(SessionReplay::account((string) $user->id))->toBeNull();
});

it('never records an operator', function () {
    $operator = User::factory()->create();
    config()->set('crm.admin_user_ids', [$operator->id]);

    $this->actingAs($operator)->get(route('changelog'))
        ->assertOk()
        ->assertDontSee('/replay/recorder.js', false);
});

it('respects the browser and the shells that declare no recording', function (array $server) {
    // Asked of the gate itself: a store build is confined to /wallet, so a
    // page request from one is a redirect before any layout renders.
    expect(SessionReplay::for(Request::create('/changelog', 'GET', server: $server)))->toBeNull()
        ->and(SessionReplay::for(Request::create('/changelog')))->not->toBeNull();
})->with([
    'do not track' => [['HTTP_DNT' => '1']],
    'global privacy control' => [['HTTP_SEC_GPC' => '1']],
    'store build' => [['HTTP_USER_AGENT' => 'Mozilla/5.0 CyberiaStore/play']],
    'desktop shell' => [['HTTP_USER_AGENT' => 'Mozilla/5.0 CyberiaDesktop/1.0']],
]);

it('loads nothing when the recorder was not built', function () {
    File::move($this->recorder, $this->recorder.'.bak');

    try {
        $this->get(route('changelog'))->assertOk()->assertDontSee('/replay/recorder.js', false);
    } finally {
        File::move($this->recorder.'.bak', $this->recorder);
    }
});
