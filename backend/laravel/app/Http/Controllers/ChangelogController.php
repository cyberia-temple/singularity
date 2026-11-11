<?php

namespace App\Http\Controllers;

use App\Support\Changelog;
use Inertia\Inertia;
use Inertia\Response;

class ChangelogController extends Controller
{
    public function __invoke(): Response
    {
        return Inertia::render('Changelog', [
            'currentVersion' => Changelog::currentVersion(),
            'productTracks' => config('changelog.product_tracks', []),
            'developmentUpdates' => config('changelog.development_updates', []),
            'releases' => Changelog::releases(),
        ]);
    }
}
