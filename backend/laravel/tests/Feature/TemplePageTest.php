<?php

use App\Http\Controllers\TempleController;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Symfony\Component\HttpKernel\Exception\HttpException;

/**
 * /3d builds its rings of doors from TempleController::doors() and links every
 * one of them, so what goes stale without anyone noticing is a door, or a
 * button under it, pointing at a page this site no longer serves.
 */
it('draws every door, and links only the ones that are open', function () {
    $html = $this->get(route('temple'))->assertOk()->getContent();
    $doors = TempleController::doors();

    foreach ([...$doors['chain'], ...$doors['beyond']] as $door) {
        expect($html)->toContain('data-icon="'.$door['icon'].'" data-status="'.$door['status'].'"');

        if ($door['status'] === 'dev') {
            expect($door['href'])->toBeNull("{$door['name']} is in development");
        } else {
            expect($door['href'])->toBeString("{$door['name']} is open");
        }
    }
});

it('sends every door and button to a page this site serves', function () {
    $html = $this->get(route('temple'))->assertOk()->getContent();

    preg_match_all('~href="(/[^"#?]*)~', $html, $links);
    $paths = collect($links[1])
        ->unique()
        ->reject(fn (string $path) => (bool) preg_match('~\.(css|js|svg|png|ico)$~', $path));

    expect($paths)->toContain('/wallet', '/launchpad', '/swap');

    foreach ($paths as $path) {
        try {
            Route::getRoutes()->match(Request::create($path, 'GET'));
        } catch (HttpException) {
            $this->fail("No route serves {$path}, which /3d links to.");
        }
    }
});

/*
 * The swap window on /3d prices routes through the wallet's own cross-chain
 * endpoints. Renaming one of them would leave the window quoting a 404 with
 * nothing failing anywhere else, so the page's configuration is checked
 * against the router.
 */
it('prices the swap window through cross-chain routes this site serves', function () {
    $html = $this->get(route('temple'))->assertOk()->getContent();

    expect($html)->toContain('id="swap"');

    foreach (['GET' => '/api/wallet/crosschain', 'POST' => '/api/wallet/crosschain/quote'] as $method => $path) {
        expect($html)->toContain(json_encode(url($path)));

        try {
            Route::getRoutes()->match(Request::create($path, $method));
        } catch (HttpException) {
            $this->fail("No route serves {$method} {$path}, which the swap window on /3d calls.");
        }
    }
});
