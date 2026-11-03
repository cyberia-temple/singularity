<?php

namespace App\Support;

use Illuminate\Http\Request;

/**
 * Whether this page load carries the page counter, and what it is told.
 *
 * The counter is Umami (services/umami, dashboard at stats.cyberia.church,
 * reached from the console at /crm/stats): visits, pages, sources, countries,
 * devices, funnels, retention and Web Vitals for every visitor — the traffic
 * the product tables leave out by design. It runs on this host and sends
 * nothing anywhere else.
 *
 * Who is never counted is the recorder's list (`SessionReplay::observes`):
 * operators, the store builds, the desktop shell, Do Not Track and Global
 * Privacy Control. The visitor's own refusal (`cyberia.analytics.optout`, the
 * key Wallet → Security writes) is checked in the browser before every send,
 * by the `before-send` hook in `partials/session-replay.blade.php`, which also
 * drops every query parameter except a campaign's.
 */
class WebStats
{
    /**
     * The counter's <script> attributes for this request, or null when it is
     * not counted.
     *
     * @return array<string, string>|null
     */
    public static function for(Request $request): ?array
    {
        $umami = config('analytics.umami');

        if (! $umami['enabled'] || $umami['website_id'] === '' || ! SessionReplay::observes($request)) {
            return null;
        }

        return [
            'src' => $umami['url'].'/s.js',
            'data-website-id' => $umami['website_id'],
            // Only these hostnames count: a local or staging copy of the site
            // loads the same tag and must not write into production numbers.
            'data-domains' => $umami['domains'],
            'data-do-not-track' => 'true',
            'data-performance' => 'true',
            'data-before-send' => 'cyberiaStatsBeforeSend',
        ];
    }
}
