<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ReplaySession;
use App\Support\SessionReplay;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;

/**
 * Where the session recorder sends what it saw: cyberia.church, lain-os.com
 * and chaos.fm all post here, and nothing is sent anywhere else.
 *
 * Stateless and credential-less like the product ingest — no cookie, no
 * session, no IP stored — so a request proves nothing about who sent it, and
 * three things keep that honest: the site is read from the browser's own
 * `Origin` (a page cannot name another site), an account is only ever filed
 * from a tag this server signed into the page, and every request and every
 * session has a size cap, past which the recorder is told to stop.
 *
 * The body is `text/plain` on purpose: that keeps a cross-site POST a "simple"
 * request with no preflight, and keeps Laravel from parsing it. `?z=1` means
 * the browser gzipped it.
 */
class ReplayIngestController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        abort_unless(config('replay.enabled'), 404);

        $site = $this->site($request);

        if ($site === null) {
            return response()->json(['error' => 'site'], 403);
        }

        $raw = $request->getContent();

        if (strlen($raw) > (int) config('replay.max_chunk_bytes')) {
            return response()->json(['error' => 'too_large'], 413);
        }

        if ($request->query('z') === '1') {
            $raw = @gzdecode($raw, (int) config('replay.max_unpacked_bytes'));

            if ($raw === false) {
                return response()->json(['error' => 'encoding'], 400);
            }
        }

        $payload = json_decode($raw, true);

        if (! is_array($payload)) {
            return response()->json(['error' => 'json'], 400);
        }

        if (($payload['forget'] ?? false) === true) {
            return $this->forget($payload, $site);
        }

        $validator = Validator::make($payload, [
            'v' => ['required', 'integer', 'in:1'],
            's' => ['required', 'uuid'],
            'q' => ['required', 'integer', 'min:1', 'max:1000000'],
            'p' => ['required', 'string', 'max:255'],
            'w' => ['required', 'integer', 'min:1', 'max:65535'],
            'h' => ['required', 'integer', 'min:1', 'max:65535'],
            'who' => ['nullable', 'string', 'max:64'],
            'inst' => ['nullable', 'uuid'],
            // rrweb's events are checked by hand below: a wildcard rule over
            // ten thousand mouse moves is seconds of validator per request.
            'e' => ['present', 'array', 'max:20000'],
            'c' => ['present', 'array', 'max:500'],
            'c.*.t' => ['required', 'integer', 'min:0'],
            'c.*.p' => ['required', 'string', 'max:255'],
            'c.*.x' => ['required', 'numeric', 'between:0,1'],
            'c.*.y' => ['required', 'integer', 'min:0', 'max:4000000'],
            'c.*.f' => ['required', 'in:0,1'],
            'c.*.w' => ['required', 'integer', 'min:1', 'max:65535'],
            'c.*.l' => ['required', 'string', 'max:120'],
            'c.*.r' => ['required', 'in:0,1'],
            'c.*.d' => ['required', 'in:0,1'],
            'x' => ['present', 'array', 'max:50'],
            'x.*.t' => ['required', 'integer', 'min:0'],
            'x.*.p' => ['required', 'string', 'max:255'],
            'x.*.m' => ['required', 'string', 'max:300'],
            'snap' => ['present', 'array', 'max:50'],
            'snap.*.t' => ['required', 'integer', 'min:0'],
            'snap.*.p' => ['required', 'string', 'max:255'],
        ]);

        // Answered in JSON whatever the request accepted: a beacon asks for
        // nothing, and a redirect back is meaningless to it.
        if ($validator->fails()) {
            return response()->json(['error' => 'invalid', 'fields' => $validator->errors()->keys()], 422);
        }

        $data = $validator->validated();

        $events = $this->events($data['e']);

        if ($events === null) {
            return response()->json(['error' => 'events'], 422);
        }

        $id = strtolower($data['s']);
        $seq = (int) $data['q'];
        $disk = Storage::disk('local');
        $file = ReplaySession::chunkPath($id, $seq);

        // A chunk sent twice — a retried beacon, a duplicated tab — is the
        // same chunk. Answered as accepted, written once.
        if ($disk->exists($file)) {
            return response()->json(['ok' => true], 202);
        }

        $times = array_merge(
            array_column($events, 'timestamp'),
            array_column($data['c'], 't'),
            array_column($data['x'], 't'),
        );
        $first = $times === [] ? (int) (microtime(true) * 1000) : (int) min($times);
        $last = $times === [] ? $first : (int) max($times);

        DB::table('replay_sessions')->insertOrIgnore([
            'id' => $id,
            'site' => $site,
            'device' => self::device((int) $data['w']),
            'viewport_width' => (int) $data['w'],
            'viewport_height' => (int) $data['h'],
            'browser' => self::browser((string) $request->userAgent()),
            'os' => self::os((string) $request->userAgent()),
            'entry_path' => $data['p'],
            'last_path' => $data['p'],
            'started_ms' => $first,
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $session = ReplaySession::query()->findOrFail($id);

        if ($session->site !== $site) {
            return response()->json(['error' => 'site'], 403);
        }

        $packed = (string) gzencode((string) json_encode($events), 6);

        if ($session->bytes + strlen($packed) > (int) config('replay.max_session_bytes')) {
            return response()->json(['error' => 'session_full'], 413);
        }

        $disk->put($file, $packed);

        DB::transaction(function () use ($session, $data, $seq, $site, $packed, $last): void {
            $now = now();
            $device = $session->device;

            DB::table('replay_pages')->insert(array_map(fn (array $snap) => [
                'session_id' => $session->id,
                'site' => $site,
                'path' => $snap['p'],
                'device' => $device,
                'seq' => $seq,
                'at_ms' => (int) $snap['t'],
                'created_at' => $now,
            ], $data['snap']));

            foreach (array_chunk($data['c'], 100) as $clicks) {
                DB::table('replay_clicks')->insert(array_map(fn (array $click) => [
                    'session_id' => $session->id,
                    'site' => $site,
                    'path' => $click['p'],
                    'device' => $device,
                    'x' => round((float) $click['x'], 4),
                    'y' => (int) $click['y'],
                    'fixed' => (bool) $click['f'],
                    'viewport_width' => (int) $click['w'],
                    'target' => $click['l'],
                    'rage' => (bool) $click['r'],
                    'dead' => (bool) $click['d'],
                    'at_ms' => (int) $click['t'],
                    'created_at' => $now,
                ], $clicks));
            }

            DB::table('replay_errors')->insert(array_map(fn (array $fault) => [
                'session_id' => $session->id,
                'site' => $site,
                'path' => $fault['p'],
                'message' => mb_substr($fault['m'], 0, 255),
                'at_ms' => (int) $fault['t'],
                'created_at' => $now,
            ], $data['x']));

            $clicks = collect($data['c']);

            ReplaySession::query()->whereKey($session->id)->incrementEach([
                'pages' => count($data['snap']),
                'clicks' => $clicks->count(),
                'rage_clicks' => $clicks->where('r', 1)->count(),
                'dead_clicks' => $clicks->where('d', 1)->count(),
                'errors' => count($data['x']),
                'chunks' => 1,
                'bytes' => strlen($packed),
            ], array_filter([
                'last_path' => $data['p'],
                'duration_ms' => min(max($session->duration_ms, $last - $session->started_ms), 4_000_000_000),
                'installation' => $session->installation ?? ($data['inst'] ?? null),
                'user_id' => $session->user_id ?? SessionReplay::account($data['who'] ?? null),
                'updated_at' => $now,
            ], fn ($value) => $value !== null));
        });

        return response()->json(['ok' => true], 202);
    }

    /**
     * The visitor refused after some of the session had already left: delete
     * it. The id is random and only that tab ever knew it.
     *
     * @param  array<string, mixed>  $payload
     */
    private function forget(array $payload, string $site): JsonResponse
    {
        $id = $payload['s'] ?? null;

        // Only ever a session id: anything else would name a path on disk.
        // A chunk written without its row is left to `replay:prune`.
        if (is_string($id) && Str::isUuid($id)) {
            $session = ReplaySession::query()->find(strtolower($id));

            if ($session && $session->site === $site) {
                $session->forget();
            }
        }

        return response()->json(['ok' => true], 202);
    }

    /**
     * rrweb's events, each an object with a numeric type and timestamp.
     *
     * @param  array<int, mixed>  $events
     * @return list<array<string, mixed>>|null
     */
    private function events(array $events): ?array
    {
        $checked = [];

        foreach ($events as $event) {
            if (! is_array($event) || ! is_int($event['type'] ?? null) || ! is_int($event['timestamp'] ?? null)) {
                return null;
            }

            $checked[] = $event;
        }

        return $checked;
    }

    /** The page's site, from the header the browser writes itself. */
    private function site(Request $request): ?string
    {
        $origin = $request->headers->get('Origin') ?: $request->headers->get('Referer');
        $host = is_string($origin) ? parse_url($origin, PHP_URL_HOST) : null;

        if (! is_string($host) || $host === '') {
            return null;
        }

        $host = preg_replace('/^www\./', '', strtolower($host));
        $own = preg_replace('/^www\./', '', strtolower((string) parse_url((string) config('app.url'), PHP_URL_HOST)));
        $allowed = array_map(fn (string $site) => preg_replace('/^www\./', '', strtolower($site)), config('replay.sites', []));

        return $host === $own || in_array($host, $allowed, true) ? $host : null;
    }

    public static function device(int $width): string
    {
        return match (true) {
            $width < 640 => 'phone',
            $width < 1024 => 'tablet',
            default => 'desktop',
        };
    }

    private static function browser(string $agent): ?string
    {
        foreach (['Edg/' => 'Edge', 'OPR/' => 'Opera', 'YaBrowser/' => 'Yandex', 'Firefox/' => 'Firefox', 'Chrome/' => 'Chrome', 'Safari/' => 'Safari'] as $needle => $name) {
            if (str_contains($agent, $needle)) {
                return $name;
            }
        }

        return null;
    }

    private static function os(string $agent): ?string
    {
        foreach (['Android' => 'Android', 'iPhone' => 'iOS', 'iPad' => 'iOS', 'Windows' => 'Windows', 'Mac OS' => 'macOS', 'CrOS' => 'ChromeOS', 'Linux' => 'Linux'] as $needle => $name) {
            if (str_contains($agent, $needle)) {
                return $name;
            }
        }

        return null;
    }
}
