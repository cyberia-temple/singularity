<?php

use Illuminate\Support\Str;

beforeEach(function () {
    $this->withoutVite();
});

it('links the PWA metadata from the application shell', function () {
    $this->get(route('changelog'))
        ->assertOk()
        ->assertSee('<link rel="manifest" href="/manifest.webmanifest">', false)
        ->assertSee('<meta name="theme-color" content="#0b0f10">', false)
        ->assertSee(
            '<meta name="apple-mobile-web-app-capable" content="yes">',
            false,
        );
});

/**
 * iOS does not ask where the home screen icon should point: Safari takes the
 * manifest's `start_url` and discards whatever page the icon was added from.
 * With `/` there, an iPhone that installed the wallet got the landing page.
 *
 * `id` stays `/` even so — it is the app's identity, and moving it would make
 * every existing install look like a second, different app.
 */
it('publishes a valid installable web app manifest', function () {
    $manifest = json_decode(
        file_get_contents(public_path('manifest.webmanifest')),
        true,
        flags: JSON_THROW_ON_ERROR,
    );

    expect($manifest)
        ->toMatchArray([
            'id' => '/',
            'name' => 'Cyberia',
            'short_name' => 'Cyberia',
            'start_url' => '/wallet',
            'scope' => '/',
            'display' => 'standalone',
            // The wallet's own ground, not the site's. An installed app opens
            // on `/wallet` and the system paints its splash — and the band it
            // keeps for the navigation — from these two, at install time and
            // never from the live page, so a near-black belonging to the site
            // is a seam under the one screen the app actually launches on.
            'background_color' => '#07080a',
            'theme_color' => '#07080a',
        ])
        ->and($manifest['icons'])->toHaveCount(3)
        ->and($manifest['icons'][0])->toMatchArray([
            'src' => '/pwa/icon-192.png',
            'sizes' => '192x192',
            'type' => 'image/png',
            'purpose' => 'any',
        ])
        ->and($manifest['icons'][1]['sizes'])->toBe('512x512')
        ->and($manifest['icons'][2]['purpose'])->toBe('maskable');

    foreach ($manifest['icons'] as $icon) {
        expect(public_path(Str::after($icon['src'], '/')))->toBeFile();
    }
});

/**
 * The landing page is a static file served outside the Inertia app, and it is
 * where every copy installed before the manifest said `/wallet` still launches
 * — an iOS icon reads `start_url` once, when it is created, and never again.
 * So the page forwards the launch itself, and the two guards are the test: a
 * same-origin referrer is somebody following the wallet's own link out to the
 * site, and the session flag is that window having been forwarded already.
 */
it('opens the wallet when the landing page is the installed app launching', function () {
    $landing = file_get_contents(resource_path('views/landing/index.html'));

    expect($landing)
        ->toContain('<link rel="manifest" href="/manifest.webmanifest" />')
        ->toContain("window.matchMedia('(display-mode: standalone)').matches")
        ->toContain('window.navigator.standalone === true')
        ->toContain('document.referrer ||')
        ->toContain("sessionStorage.getItem('cyberia.pwa.launched')")
        ->toContain("sessionStorage.setItem('cyberia.pwa.launched', '1')")
        ->toContain("location.replace('/wallet')");

    $this->get('/')->assertOk();
});

/**
 * That link is what the referrer guard above is protecting: the wallet has no
 * site header in any container, so Settings is the one way back to the rest of
 * Cyberia, and a landing page that bounced it would close the door.
 */
it('keeps the wallet link out of the app pointing at the landing page', function () {
    expect(file_get_contents(
        resource_path('js/components/wallet/WalletPreferences.vue'),
    ))->toContain('href="/"');
});

it('keeps authenticated pages out of the service worker cache', function () {
    $serviceWorker = file_get_contents(public_path('sw.js'));

    preg_match(
        "/if \\(request\\.mode === 'navigate'\\) \\{(?<handler>.*?)\\n\\s*\\}/s",
        $serviceWorker,
        $matches,
    );

    expect($serviceWorker)
        ->toContain("const OFFLINE_URL = '/offline.html';")
        ->toContain("url.pathname.startsWith('/build/')")
        ->and($matches['handler'] ?? null)->not->toBeNull()
        ->toContain('fetch(request).catch')
        ->not->toContain('cacheFirst')
        ->not->toContain('cache.put');
});

it('ships a self contained offline fallback', function () {
    $offlinePage = file_get_contents(public_path('offline.html'));

    expect($offlinePage)
        ->toContain('You are outside the Wired.')
        ->toContain('<a href="/">Try again</a>')
        ->not->toContain('<script');
});
