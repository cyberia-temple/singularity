<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\User;
use App\Services\GamificationService;
use Carbon\Carbon;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;

/**
 * The wallet's daily board: what today pays, what the streak is worth, and who
 * is ahead.
 *
 * Every number here comes from the gamification system the site already runs —
 * one XP ledger, one streak, one quest board — rather than from a second one
 * keyed by address. That is the whole design decision. A wallet is a key and
 * an account is a person, and experience is a fact about the person: two
 * ledgers would mean a swap made from this screen paid XP the profile page had
 * never heard of.
 *
 * Which is why this is the one wallet surface that wants a session. Everything
 * else in the wallet is deliberately account-less; here the account *is* the
 * subject, so a wallet with no session gets the half that is genuinely public
 * — the quest catalogue, what a streak pays, the board — and is told plainly
 * that the progress half belongs to an account it can prove with its own key.
 * It is never shown a zero that looks like a score.
 */
class WalletDailyController extends Controller
{
    /** Rows on the board. Enough to find yourself, short enough to read. */
    private const BOARD_LIMIT = 12;

    /** The board is the same for everyone, so it is built once a minute. */
    private const BOARD_TTL = 60;

    public function __construct(private GamificationService $gamification) {}

    /**
     * The board, with or without somebody standing at it.
     *
     * One shape either way: the screen draws the same sections and the absent
     * half is `null` rather than missing, because a client that has to guess
     * which keys arrived is a client that renders zeroes on a slow day.
     */
    public function show(Request $request): JsonResponse
    {
        return response()->json($this->board($request->user()));
    }

    /**
     * The check-in.
     *
     * Recorded as the site's own "somebody showed up" event rather than as a
     * bare `touch()`. The difference is visible on the screen that calls this:
     * `touch()` moves the streak and pays the visit, but only `recordAction()`
     * advances the quests that *are* showing up — so a board that checked you
     * in and then went on showing "Jack in — 0/1" was reporting two different
     * answers to one question. `page_view` pays no XP of its own; everything
     * granted here comes from the streak and from the quests it completes.
     *
     * Idempotent within the UTC day, and it answers with what it actually
     * granted rather than with a promise: a second press grants 0 and says so.
     */
    public function checkIn(Request $request): JsonResponse
    {
        $user = $request->user();

        if (! $user instanceof User) {
            return response()->json([
                'message' => 'Sign in with this wallet to check in.',
            ], 401);
        }

        $granted = $this->gamification->recordAction($user, 'page_view');

        return response()->json([...$this->board($user), 'granted' => $granted]);
    }

    /**
     * @return array<string, mixed>
     */
    private function board(?User $user): array
    {
        return [
            'signedIn' => $user !== null,
            'account' => $user === null ? null : [
                'name' => $user->onchain_nickname ?: $user->name,
                'address' => $user->wallet_address,
                'profileUrl' => $user->profile_url,
            ],
            'standing' => $user === null ? null : $this->standing($user),
            'quests' => $this->quests($user),
            'nextUnlock' => $this->nextUnlock($user),
            /*
             * What a streak is worth, as a table rather than a sentence: the
             * strip on the screen has to be able to say what day 7 pays before
             * anybody has reached day 7.
             */
            'streakBonuses' => array_map(
                'intval',
                (array) config('gamification.streak_bonuses', []),
            ),
            'xpPerAction' => array_map(
                'intval',
                (array) config('gamification.xp', []),
            ),
            'board' => Cache::remember(
                'wallet.daily.board',
                self::BOARD_TTL,
                fn () => $this->gamification->leaderboard(self::BOARD_LIMIT),
            ),
            /*
             * When the daily quests reset. UTC midnight, because that is the
             * boundary `periodKey()` uses — a screen that counted down to the
             * viewer's own midnight would be counting to the wrong minute for
             * everyone outside UTC.
             */
            'resetsAt' => Carbon::now('UTC')->addDay()->startOfDay()->toIso8601String(),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function standing(User $user): array
    {
        $progress = $this->gamification->progressFor($user);

        return [
            'xp' => $progress['xp'],
            'level' => $progress['level'],
            'title' => $progress['title'],
            'levelFloorXp' => $progress['level_floor_xp'],
            'nextLevelXp' => $progress['next_level_xp'],
            'progressPct' => $progress['progress_pct'],
            'currentStreak' => $progress['current_streak'],
            'longestStreak' => $progress['longest_streak'],
            'lastActiveOn' => $progress['last_active_on'],
            'activeToday' => $progress['active_today'],
            'rank' => $progress['rank'],
            'spendable' => $progress['spendable'],
        ];
    }

    /**
     * Today's and this week's quests.
     *
     * Signed out this is the catalogue — what the quests *are*, with no
     * progress attached. Progress is per-account and is not published for
     * somebody else's address: the board above already says what the XP added
     * up to, which is the part the leaderboard page has always shown.
     *
     * @return array<int, array<string, mixed>>
     */
    private function quests(?User $user): array
    {
        /*
         * The actions travel with the quest so the wallet can put a button on
         * the row that goes where the quest is satisfied. Deriving that from
         * the key would be a second copy of this list in TypeScript, and it
         * would be the copy that went stale when a quest was renamed.
         */
        $actions = array_column(
            (array) config('gamification.quests', []),
            'actions',
            'key',
        );

        if ($user !== null) {
            return array_map(
                fn (array $quest): array => [
                    ...$quest,
                    'progress' => (int) $quest['progress'],
                    'actions' => array_values((array) ($actions[$quest['key']] ?? [])),
                ],
                $this->gamification->questBoard($user),
            );
        }

        return array_map(fn (array $quest): array => [
            'key' => $quest['key'],
            'period' => $quest['period'],
            'title' => $quest['title'],
            'description' => $quest['description'],
            'target' => (int) $quest['target'],
            // Null and not zero: nobody is standing here, so there is no
            // progress to report. A zero would read as "you have done none of
            // it today", which is a claim about a person this server has not
            // met.
            'progress' => null,
            'completed' => false,
            'xp' => (int) $quest['xp'],
            'actions' => array_values((array) ($quest['actions'] ?? [])),
        ], (array) config('gamification.quests', []));
    }

    /**
     * The cheapest thing experience still buys, and why it is out of reach.
     *
     * One row and not the whole table: this screen answers "what is the next
     * thing", and the table itself lives on the profile where it is spent.
     *
     * @return array<string, mixed>|null
     */
    private function nextUnlock(?User $user): ?array
    {
        $catalogue = $this->gamification->catalogue();

        if ($catalogue === []) {
            return null;
        }

        $rows = $user === null
            ? array_map(fn (array $entry): array => [...$entry, 'state' => 'xp'], $catalogue)
            : $this->gamification->enchantments($user);

        // Everything already bought is not "next". A wallet that owns the whole
        // table gets no card rather than a card for something it already has.
        $wanted = array_values(array_filter(
            $rows,
            fn (array $row): bool => ($row['state'] ?? 'xp') !== 'owned',
        ));

        if ($wanted === []) {
            return null;
        }

        usort($wanted, fn (array $a, array $b): int => (int) $a['cost'] <=> (int) $b['cost']);

        $next = $wanted[0];

        return [
            'key' => $next['key'],
            'title' => $next['title'],
            'description' => $next['description'],
            'cost' => (int) $next['cost'],
            'level' => (int) $next['level'],
            'state' => $next['state'] ?? 'xp',
        ];
    }
}
