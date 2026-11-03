<?php

namespace App\Http\Controllers;

use App\Models\AnalyticsUser;
use App\Models\ReplaySession;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\Request;
use Illuminate\Http\Response as HttpResponse;
use Illuminate\Support\Facades\DB;
use Inertia\Inertia;
use Inertia\Response;

/**
 * Записи: the session recordings, read where they are kept.
 *
 * The other lenses say *what* happened; this one is for *why*. It opens on the
 * places that are hurting rather than on a list of sessions, because "what is
 * broken" is the question Lev asked and nobody answers it by watching
 * recordings in date order: the pages where people click in rage or click on
 * something that does nothing, the errors their browsers threw, and only then
 * the sessions — filterable by exactly those signs — each one a link to the
 * player. A page's heat map is drawn on a snapshot of that page as a visitor
 * saw it, not on the operator's own copy of it.
 */
class ConsoleReplayController extends Controller
{
    private const PER_PAGE = 40;

    private const WINDOW_DAYS = 7;

    public function index(Request $request): Response
    {
        $filters = $request->validate([
            'site' => ['nullable', 'string', 'max:64'],
            'device' => ['nullable', 'in:phone,tablet,desktop'],
            'flag' => ['nullable', 'in:rage,dead,errors'],
            'path' => ['nullable', 'string', 'max:255'],
        ]);

        $since = now()->subDays(self::WINDOW_DAYS);
        $recent = ReplaySession::query()->where('updated_at', '>=', $since);
        $total = (clone $recent)->count();
        $durations = (clone $recent)->limit(20000)->pluck('duration_ms')->sort()->values();

        $sessions = ReplaySession::query()
            ->when($filters['site'] ?? null, fn (Builder $query, string $site) => $query->where('site', $site))
            ->when($filters['device'] ?? null, fn (Builder $query, string $device) => $query->where('device', $device))
            ->when(($filters['flag'] ?? null) === 'rage', fn (Builder $query) => $query->where('rage_clicks', '>', 0))
            ->when(($filters['flag'] ?? null) === 'dead', fn (Builder $query) => $query->where('dead_clicks', '>', 0))
            ->when(($filters['flag'] ?? null) === 'errors', fn (Builder $query) => $query->where('errors', '>', 0))
            ->when($filters['path'] ?? null, fn (Builder $query, string $path) => $query->whereExists(
                fn ($pages) => $pages->select(DB::raw(1))
                    ->from('replay_pages')
                    ->whereColumn('replay_pages.session_id', 'replay_sessions.id')
                    ->where('replay_pages.path', 'like', '%'.addcslashes($path, '%_\\').'%'),
            ))
            ->orderByDesc('updated_at')
            ->simplePaginate(self::PER_PAGE)
            ->withQueryString();

        $installations = AnalyticsUser::query()
            ->whereIn('id', $sessions->getCollection()->pluck('installation')->filter()->unique())
            ->pluck('id')
            ->flip();

        return Inertia::render('crm/Replays', [
            'filters' => $filters,
            'tiles' => [
                'sessions' => $total,
                'median_ms' => $durations->isEmpty() ? null : (int) $durations[intdiv($durations->count(), 2)],
                'rage' => $total ? (clone $recent)->where('rage_clicks', '>', 0)->count() / $total : null,
                'dead' => $total ? (clone $recent)->where('dead_clicks', '>', 0)->count() / $total : null,
                'errors' => $total ? (clone $recent)->where('errors', '>', 0)->count() / $total : null,
            ],
            'sites' => ReplaySession::query()
                ->where('updated_at', '>=', $since)
                ->select('site', DB::raw('count(*) as sessions'))
                ->groupBy('site')
                ->orderByDesc('sessions')
                ->get(),
            'problems' => DB::table('replay_clicks')
                ->where('created_at', '>=', $since)
                ->select(
                    'site',
                    'path',
                    DB::raw('count(*) as clicks'),
                    DB::raw('sum(case when rage then 1 else 0 end) as rage'),
                    DB::raw('sum(case when dead then 1 else 0 end) as dead'),
                    DB::raw('count(distinct session_id) as sessions'),
                )
                ->groupBy('site', 'path')
                ->orderByRaw('sum(case when rage then 1 else 0 end) + sum(case when dead then 1 else 0 end) desc')
                ->orderByDesc('clicks')
                ->limit(12)
                ->get(),
            'faults' => DB::table('replay_errors')
                ->where('created_at', '>=', $since)
                ->select(
                    'site',
                    'message',
                    DB::raw('count(*) as times'),
                    DB::raw('count(distinct session_id) as sessions'),
                    DB::raw('max(session_id) as example'),
                    DB::raw('max(created_at) as last_at'),
                )
                ->groupBy('site', 'message')
                ->orderByDesc('sessions')
                ->orderByDesc('times')
                ->limit(10)
                ->get(),
            'sessions' => $sessions->through(fn (ReplaySession $session) => [
                ...$this->row($session),
                'installation_known' => $session->installation !== null && $installations->has($session->installation),
            ]),
        ]);
    }

    public function show(ReplaySession $session): Response
    {
        return Inertia::render('crm/Replay', [
            'session' => [
                ...$this->row($session),
                'installation_known' => $session->installation !== null
                    && AnalyticsUser::query()->whereKey($session->installation)->exists(),
            ],
            'pages' => DB::table('replay_pages')
                ->where('session_id', $session->id)
                ->orderBy('at_ms')
                ->get(['path', 'at_ms']),
            'marks' => DB::table('replay_clicks')
                ->where('session_id', $session->id)
                ->where(fn ($query) => $query->where('rage', true)->orWhere('dead', true))
                ->orderBy('at_ms')
                ->limit(200)
                ->get(['path', 'target', 'rage', 'dead', 'at_ms']),
            'faults' => DB::table('replay_errors')
                ->where('session_id', $session->id)
                ->orderBy('at_ms')
                ->limit(200)
                ->get(['path', 'message', 'at_ms']),
        ]);
    }

    /** rrweb's events for the player, or one chunk for a heat map's snapshot. */
    public function events(Request $request, ReplaySession $session): HttpResponse
    {
        $seq = $request->integer('seq') ?: null;

        return response($session->eventsJson($seq))
            ->header('Content-Type', 'application/json')
            ->header('Cache-Control', 'private, max-age=300');
    }

    /**
     * Where people click on one page: every click as a point over a snapshot
     * of that page at that device's width, and the same clicks named, because
     * "the Send button, forty times, nine of them in rage" is the sentence a
     * picture only implies.
     */
    public function heatmap(Request $request): Response
    {
        $filters = $request->validate([
            'site' => ['nullable', 'string', 'max:64'],
            'path' => ['nullable', 'string', 'max:255'],
            'device' => ['nullable', 'in:phone,tablet,desktop'],
            'days' => ['nullable', 'integer', 'in:1,7,30'],
        ]);

        $days = (int) ($filters['days'] ?? self::WINDOW_DAYS);
        $since = now()->subDays($days);
        $site = $filters['site'] ?? ReplaySession::query()->latest('updated_at')->value('site');

        $paths = DB::table('replay_clicks')
            ->where('created_at', '>=', $since)
            ->where('site', $site)
            ->select('path', DB::raw('count(*) as clicks'))
            ->groupBy('path')
            ->orderByDesc('clicks')
            ->limit(40)
            ->get();

        $path = $filters['path'] ?? $paths->first()?->path;

        $devices = DB::table('replay_clicks')
            ->where('created_at', '>=', $since)
            ->where('site', $site)
            ->where('path', $path)
            ->select('device', DB::raw('count(*) as clicks'))
            ->groupBy('device')
            ->orderByDesc('clicks')
            ->pluck('clicks', 'device');

        $device = $filters['device'] ?? ($devices->keys()->first() ?? 'desktop');

        $clicks = DB::table('replay_clicks')
            ->where('created_at', '>=', $since)
            ->where('site', $site)
            ->where('path', $path)
            ->where('device', $device);

        $snapshot = DB::table('replay_pages')
            ->join('replay_sessions', 'replay_sessions.id', '=', 'replay_pages.session_id')
            ->where('replay_pages.site', $site)
            ->where('replay_pages.path', $path)
            ->where('replay_pages.device', $device)
            ->orderByDesc('replay_pages.created_at')
            ->first(['replay_pages.session_id', 'replay_pages.seq', 'replay_pages.at_ms', 'replay_sessions.viewport_width']);

        return Inertia::render('crm/Heatmap', [
            'filters' => ['site' => $site, 'path' => $path, 'device' => $device, 'days' => $days],
            'sites' => ReplaySession::query()->distinct()->orderBy('site')->pluck('site'),
            'paths' => $paths,
            'devices' => $devices,
            'points' => (clone $clicks)->latest('id')->limit(5000)->get(['x', 'y', 'fixed', 'rage', 'dead']),
            'targets' => (clone $clicks)
                ->select(
                    'target',
                    DB::raw('count(*) as clicks'),
                    DB::raw('sum(case when rage then 1 else 0 end) as rage'),
                    DB::raw('sum(case when dead then 1 else 0 end) as dead'),
                )
                ->groupBy('target')
                ->orderByDesc('clicks')
                ->limit(20)
                ->get(),
            'snapshot' => $snapshot ? [
                'session' => $snapshot->session_id,
                'seq' => (int) $snapshot->seq,
                'at_ms' => (int) $snapshot->at_ms,
                'width' => (int) $snapshot->viewport_width,
            ] : null,
        ]);
    }

    /**
     * @return array<string, mixed>
     */
    private function row(ReplaySession $session): array
    {
        return [
            'id' => $session->id,
            'site' => $session->site,
            'device' => $session->device,
            'browser' => $session->browser,
            'os' => $session->os,
            'viewport' => $session->viewport_width.'×'.$session->viewport_height,
            'entry_path' => $session->entry_path,
            'last_path' => $session->last_path,
            'pages' => $session->pages,
            'clicks' => $session->clicks,
            'rage_clicks' => $session->rage_clicks,
            'dead_clicks' => $session->dead_clicks,
            'errors' => $session->errors,
            'duration_ms' => $session->duration_ms,
            'installation' => $session->installation,
            'user_id' => $session->user_id,
            'bytes' => $session->bytes,
            'started_at' => $session->created_at?->toIso8601String(),
            'updated_at' => $session->updated_at?->toIso8601String(),
        ];
    }
}
