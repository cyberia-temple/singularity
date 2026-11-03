<?php

namespace App\Http\Controllers;

use Illuminate\Support\Facades\Http;
use Inertia\Inertia;
use Symfony\Component\HttpFoundation\Response;
use Throwable;

/**
 * The web analytics dashboard (Umami, services/umami), opened signed in.
 *
 * The console already decided this is an operator, and services/umami's
 * bootstrap left the dashboard's admin password in .env, so the console signs
 * in on their behalf and hands the browser Umami's own SSO page — nobody types
 * or sees that password. Anything that goes wrong on the way (no password yet,
 * Umami down) lands on Umami's login page instead of an error.
 */
class ConsoleStatsController extends Controller
{
    public function __invoke(): Response
    {
        $umami = config('analytics.umami');

        return Inertia::location($this->signedIn($umami) ?? $umami['url'].'/login');
    }

    /**
     * @param  array{url: string, internal_url: string, password: mixed}  $umami
     */
    private function signedIn(array $umami): ?string
    {
        if (! is_string($umami['password']) || $umami['password'] === '') {
            return null;
        }

        try {
            $token = Http::timeout(5)
                ->post($umami['internal_url'].'/api/auth/login', [
                    'username' => 'admin',
                    'password' => $umami['password'],
                ])
                ->throw()
                ->json('token');
        } catch (Throwable) {
            return null;
        }

        if (! is_string($token) || $token === '') {
            return null;
        }

        return $umami['url'].'/sso?'.http_build_query(['token' => $token, 'url' => '/websites']);
    }
}
