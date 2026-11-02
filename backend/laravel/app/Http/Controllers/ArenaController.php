<?php

namespace App\Http\Controllers;

use App\Http\Middleware\EnsureCrmAdmin;
use App\Http\Requests\StoreArenaCommentRequest;
use App\Models\ArenaComment;
use App\Models\ArenaSeason;
use App\Services\Arena\ArenaSeasonManager;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Inertia\Inertia;
use Inertia\Response;

class ArenaController extends Controller
{
    public function index(Request $request, ArenaSeasonManager $manager): Response
    {
        abort_unless(config('arena.enabled'), 404);
        $season = ArenaSeason::query()->where('slug', config('arena.slug'))->first();
        if ($season && $season->rules['mode'] === 'automatic-multi') {
            return $this->multi($season, null);
        }
        $user = $request->user();
        $moderator = EnsureCrmAdmin::allows($user);
        $comments = $season?->comments()->with('user:id,name')->latest('id')->paginate(30);
        $reports = $moderator && $comments
            ? DB::table('arena_comment_reports')->whereIn('arena_comment_id', $comments->pluck('id'))->groupBy('arena_comment_id')
                ->selectRaw('arena_comment_id, count(*) as total')->pluck('total', 'arena_comment_id')
            : collect();
        $comments?->through(fn (ArenaComment $comment): array => [
            'id' => $comment->id, 'parentId' => $comment->parent_id,
            'body' => $comment->hidden_at ? null : $comment->body,
            'author' => $comment->user?->name ?? 'Member',
            'createdAt' => $comment->created_at->toIso8601String(),
            'canRemove' => $user && ! $comment->hidden_at && ($moderator || $comment->user_id === $user->id),
            'reports' => $moderator ? (int) ($reports[$comment->id] ?? 0) : null,
        ]);
        $rounds = $season?->rounds()->orderBy('sequence')->get() ?? collect();

        return Inertia::render('Arena', [
            'season' => $season ? [
                'title' => $season->title, 'slug' => $season->slug,
                'startsAt' => $season->starts_at?->toIso8601String(),
                'endsAt' => $season->ends_at?->toIso8601String(),
                'rulesHash' => $season->rules_hash,
            ] : null,
            'rules' => $season?->rules ?? $manager->rules(),
            'archivedSeasons' => ArenaSeason::query()->where('slug', '!=', config('arena.slug'))->whereHas('rounds')
                ->latest('id')->limit(5)->get(['slug', 'title']),
            'automation' => $season && $season->rules['mode'] === 'automatic-paper' ? [
                'enabled' => (bool) config('arena.automation.enabled'),
                'lastTickAt' => $season->last_tick_at?->toIso8601String(),
                'error' => $season->automation_error,
                'reservedCents' => (int) $season->cycles()->sum('reserved_cents'),
                'reservedCalls' => (int) $season->cycles()->sum('reserved_calls'),
                'cycles' => $season->cycles()->orderByDesc('slot')->limit(8)->get()->map(fn ($cycle) => [
                    'slot' => $cycle->slot, 'status' => $cycle->status, 'error' => $cycle->error_code,
                    'fillDueAt' => $cycle->fill_due_at->toIso8601String(), 'commitHash' => $cycle->commit_hash,
                    'decisions' => $cycle->record['decisions'] ?? null,
                    'attempts' => collect($cycle->record['attempts'] ?? [])->map(fn ($attempt) => $attempt['status']),
                ]),
            ] : null,
            'rounds' => $rounds->map(fn ($round) => [
                'sequence' => $round->sequence, 'decisionAt' => $round->decision_at->toIso8601String(),
                'filledAt' => $round->filled_at->toIso8601String(),
                'evidence' => $round->evidence, 'result' => $round->result,
                'previousHash' => $round->previous_hash, 'recordHash' => $round->record_hash,
            ]),
            'comments' => $comments,
            'following' => $user && $season ? $season->followers()->where('user_id', $user->id)->exists() : false,
            'saves' => $season?->followers()->count() ?? 0,
            'signedIn' => $user !== null,
        ]);
    }

    public function agent(string $agent): Response
    {
        abort_unless(config('arena.enabled'), 404);
        $season = ArenaSeason::query()->where('slug', config('arena.slug'))->firstOrFail();
        abort_unless($season->rules['mode'] === 'automatic-multi' && isset($season->rules['agents'][$agent]), 404);

        return $this->multi($season, $agent);
    }

    /**
     * The multi-token arena: a leaderboard, or one agent's whole record. The
     * page derives charts, holdings and statistics from the rounds, which are
     * the same records the evidence download carries.
     */
    private function multi(ArenaSeason $season, ?string $agent): Response
    {
        $pending = $season->cycles()->whereIn('status', ['collecting', 'awaiting_fill'])->orderBy('slot')->first();

        return Inertia::render('ArenaMulti', [
            'agent' => $agent,
            'season' => ['title' => $season->title, 'slug' => $season->slug, 'startsAt' => $season->starts_at?->toIso8601String(),
                'endsAt' => $season->ends_at?->toIso8601String(), 'rulesHash' => $season->rules_hash],
            'rules' => collect($season->rules)->except('automation')->all()
                + ['models' => $season->rules['automation']['models']],
            'automation' => ['enabled' => (bool) config('arena.automation.enabled'), 'lastTickAt' => $season->last_tick_at?->toIso8601String(),
                'error' => $season->automation_error],
            'pending' => $pending ? ['status' => $pending->status, 'fillDueAt' => $pending->fill_due_at->toIso8601String(),
                'commitHash' => $pending->commit_hash,
                'decisions' => $pending->status === 'awaiting_fill' ? ($pending->record['decisions'] ?? null) : null] : null,
            'skipped' => $season->cycles()->where('status', 'skipped')->orderByDesc('slot')->limit(5)->get(['slot', 'error_code'])
                ->map(fn ($cycle) => ['slot' => $cycle->slot, 'error' => $cycle->error_code]),
            'rounds' => $season->rounds()->orderBy('sequence')->get()->map(fn ($round) => [
                'sequence' => $round->sequence, 'decisionAt' => $round->decision_at->toIso8601String(),
                'filledAt' => $round->filled_at->toIso8601String(), 'recordHash' => $round->record_hash,
                'decisions' => $round->evidence['decisions'],
                'board' => collect($round->evidence['board']['prices'] ?? [])->map(fn ($row) => [
                    'usd' => $row['usd'], 'change' => $row['change_h24'], 'liquidity' => $row['liquidity_usd'], 'pair' => $row['pair']]),
                'result' => $round->result,
            ]),
        ]);
    }

    public function comment(StoreArenaCommentRequest $request): RedirectResponse
    {
        $season = $this->season();
        $season->comments()->create([
            'user_id' => $request->user()->id,
            'body' => $request->validated('body'),
            'parent_id' => $request->validated('parent_id'),
        ]);

        return to_route('arena.index');
    }

    public function remove(Request $request, ArenaComment $comment): RedirectResponse
    {
        abort_unless($comment->arena_season_id === $this->season()->id, 404);
        abort_unless($comment->user_id === $request->user()->id || EnsureCrmAdmin::allows($request->user()), 403);
        $comment->update(['body' => null, 'hidden_at' => now()]);

        return to_route('arena.index');
    }

    public function report(Request $request, ArenaComment $comment): RedirectResponse
    {
        abort_unless($comment->arena_season_id === $this->season()->id && ! $comment->hidden_at, 404);
        DB::table('arena_comment_reports')->insertOrIgnore([
            'arena_comment_id' => $comment->id, 'user_id' => $request->user()->id, 'created_at' => now(),
        ]);

        return to_route('arena.index');
    }

    public function follow(Request $request): RedirectResponse
    {
        $this->season()->followers()->firstOrCreate(['user_id' => $request->user()->id]);

        return to_route('arena.index');
    }

    public function unfollow(Request $request): RedirectResponse
    {
        $this->season()->followers()->where('user_id', $request->user()->id)->delete();

        return to_route('arena.index');
    }

    public function evidence(): JsonResponse
    {
        return $this->exportEvidence($this->season());
    }

    public function archive(ArenaSeason $season): JsonResponse
    {
        abort_unless(config('arena.enabled'), 404);

        return $this->exportEvidence($season);
    }

    private function exportEvidence(ArenaSeason $season): JsonResponse
    {
        return response()->json([
            'format' => match ($season->rules['mode']) {
                'automatic-multi' => 'cyberia-arena-automatic-multi-v3',
                'automatic-paper' => 'cyberia-arena-automatic-paper-v2',
                default => 'cyberia-arena-imported-paper-v1',
            },
            'integrity' => 'Server-attested records, not independently verified results. Paper fills use modeled costs, not executable order quotes. Hashes are not onchain commitments.',
            'rules' => $season->rules, 'rules_hash' => $season->rules_hash,
            'cycles' => $season->cycles()->orderBy('slot')->get(['slot', 'decision_at', 'fill_due_at', 'status', 'error_code', 'record', 'commit_hash', 'reserved_cents', 'reserved_calls']),
            'rounds' => $season->rounds()->orderBy('sequence')->get()->map(fn ($round) => [
                'sequence' => $round->sequence, 'evidence' => $round->evidence, 'result' => $round->result,
                'previous_hash' => $round->previous_hash, 'record_hash' => $round->record_hash,
            ]),
        ])->header('Content-Disposition', 'attachment; filename="cyberia-arena-evidence.json"');
    }

    private function season(): ArenaSeason
    {
        abort_unless(config('arena.enabled'), 404);

        return ArenaSeason::query()->where('slug', config('arena.slug'))->firstOrFail();
    }
}
