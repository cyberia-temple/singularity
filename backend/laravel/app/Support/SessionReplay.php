<?php

namespace App\Support;

use App\Http\Middleware\EnsureCrmAdmin;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/**
 * Whether this page load carries the session recorder, and what it is told.
 *
 * The product tables (`analytics_*`) answer *what* happened — a swap failed, a
 * wallet was funded — and say nothing about *why*: the button nobody found, the
 * screen somebody left after three taps on something that is not a button.
 * Recordings are the other half: replays, click heat maps, rage and dead
 * clicks, JavaScript errors — recorded by rrweb in the browser and kept on this
 * server (`/api/replay`, read at `/crm/replays`), never sent anywhere else.
 *
 * Who is never recorded is decided here, before the script is even named:
 *
 *   - nobody, while `replay.enabled` is off or the recorder was not built;
 *   - the operators — their sessions are the noise the console already
 *     excludes from every product number, and the console itself is the most
 *     private screen this site has;
 *   - the store builds (`CyberiaStore/`), whose Data safety and App Privacy
 *     answers declare no session recording, and the desktop shell;
 *   - a browser that sends Do Not Track or Global Privacy Control, under the
 *     same switch the product analytics honour.
 *
 * The person's own "do not record" lives in the browser
 * (`cyberia.analytics.optout`, the same key Wallet → Security writes), and the
 * recorder checks it before it records anything.
 */
class SessionReplay
{
    /**
     * The recorder's <script> attributes for this request, or null when it is
     * not recorded.
     *
     * @return array<string, string>|null
     */
    public static function for(Request $request): ?array
    {
        $script = public_path('replay/recorder.js');

        if (! config('replay.enabled') || ! is_file($script) || ! self::observes($request)) {
            return null;
        }

        $user = $request->user();

        return array_filter([
            'src' => '/replay/recorder.js?v='.filemtime($script),
            'data-endpoint' => url('/api/replay'),
            'data-paused' => implode(',', config('replay.paused_paths')),
            'data-installation' => 'cyberia.analytics.uid',
            'data-hide-notice' => 'true',
            'data-who' => $user ? self::who((int) $user->getKey()) : null,
        ]);
    }

    /**
     * Whether this visitor is observed at all — recorded here, counted by the
     * page counter (`WebStats`). The list above is the same for both: a person
     * the recorder leaves alone is not counted behind its back either.
     */
    public static function observes(Request $request): bool
    {
        if (EnsureCrmAdmin::allows($request->user())) {
            return false;
        }

        $agent = (string) $request->userAgent();

        if (str_contains($agent, 'CyberiaStore/') || str_contains($agent, 'CyberiaDesktop/')) {
            return false;
        }

        return ! (config('analytics.respect_dnt') && ($request->header('DNT') === '1' || $request->header('Sec-GPC') === '1'));
    }

    /**
     * An account named in a recording, signed: the ingest is open to anyone,
     * and an unsigned id would let anyone file recordings under somebody else.
     */
    public static function who(int $userId): string
    {
        return $userId.'.'.substr(hash_hmac('sha256', 'replay:'.$userId, (string) config('app.key')), 0, 32);
    }

    /** The account a signed tag names, or null when it was not signed here. */
    public static function account(?string $who): ?int
    {
        if (! is_string($who) || ! preg_match('/^(\d{1,18})\.[0-9a-f]{32}$/', $who, $match)) {
            return null;
        }

        return hash_equals(self::who((int) $match[1]), $who) ? (int) $match[1] : null;
    }

    /**
     * A static page, with the recorder put in front of its `</head>`.
     *
     * The landing pages are plain HTML files rather than Blade, and the landing
     * page is where most visits begin — leaving it out would start every
     * recording one page after the first impression.
     */
    public static function page(string $path): Response
    {
        $html = (string) file_get_contents($path);
        $tag = view('partials.session-replay')->render();

        if (trim($tag) !== '') {
            $html = preg_replace('~</head>~i', $tag.'</head>', $html, 1) ?? $html;
        }

        return response($html)->header('Content-Type', 'text/html; charset=UTF-8');
    }
}
