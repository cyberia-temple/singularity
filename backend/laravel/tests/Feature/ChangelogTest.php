<?php

use Illuminate\Support\Facades\Config;
use Inertia\Testing\AssertableInertia as Assert;

beforeEach(function () {
    $this->withoutVite();
});

it('renders the changelog page', function () {
    $this->get(route('changelog'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->component('Changelog')
            ->where('currentVersion', 'v0.16.0')
            ->has('productTracks', 3)
            ->where('productTracks.0.name', 'Cyberia Wallet')
            ->where('productTracks.2.status', 'Not yet released')
            ->has('developmentUpdates', 3)
            ->where('developmentUpdates.0.items.0.title', 'Elysium network support')
            ->has('releases', 18)
            ->where('releases.0.version', 'v0.16.0')
            ->where('releases.0.date', '2026-10-18')
            ->where('releases.0.title', 'Cyberia imageboard')
            ->has('releases.0.sections', 1)
            ->where('releases.0.sections.0.label', 'Added')
            ->has('releases.0.sections.0.items', 2)
            ->where('release.current.version', 'v0.16.0')
            ->where('release.changelogUrl', route('changelog')));
});

it('keeps the example environment aligned with the current release', function () {
    $contents = file_get_contents(base_path('.env.example'));

    expect($contents)->toContain('APP_VERSION='.config('changelog.releases.0.version').PHP_EOL);
});

it('shares only the three latest releases for the header menu', function () {
    Config::set('changelog.current_version', 'v4');
    Config::set('changelog.releases', [
        releaseEntry('v4'),
        releaseEntry('v3'),
        releaseEntry('v2'),
        releaseEntry('v1'),
    ]);

    $this->get(route('changelog'))
        ->assertOk()
        ->assertInertia(fn (Assert $page) => $page
            ->where('currentVersion', 'v4')
            ->has('releases', 4)
            ->has('release.recent', 3)
            ->where('release.recent.0.version', 'v4')
            ->where('release.recent.1.version', 'v3')
            ->where('release.recent.2.version', 'v2'));
});

function releaseEntry(string $version): array
{
    return [
        'version' => $version,
        'date' => '2026-07-16',
        'title' => "Release {$version}",
        'sections' => [
            [
                'label' => 'Added',
                'items' => ["Change {$version}"],
            ],
        ],
    ];
}
