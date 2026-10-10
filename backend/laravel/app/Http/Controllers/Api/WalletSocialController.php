<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Activity;
use App\Models\Dao;
use App\Models\LaunchpadToken;
use App\Models\Post;
use App\Models\Proposal;
use App\Models\ProposalComment;
use App\Models\ProposalVote;
use App\Models\User;
use App\Services\AchievementService;
use App\Support\ChainActivity;
use App\Support\TradeAmount;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Relations\MorphTo;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;

/**
 * What the wallet reads about the rest of Cyberia: the feed, the DAO and a
 * public profile.
 *
 * All of it is read-only, and that is a consequence of the wallet rather than a
 * shortcut. The wallet has no session — the seed is generated in the browser and
 * this server never learns whose it is — so there is nobody here to post as,
 * comment as or vote as. Every screen that consumes this says so plainly and
 * links out to the site for the parts that need an account.
 *
 * Nothing returned here is new disclosure: the DAO index, a proposal and a user
 * profile are already public pages, and these endpoints answer with the same
 * fields those pages render.
 */
class WalletSocialController extends Controller
{
    /** Rows any one feed request will return. */
    private const FEED_LIMIT = 40;

    /** Top-level comments one thread will return; the site pages past this. */
    private const COMMENT_LIMIT = 100;

    /** Long enough to absorb a wallet's refresh, short enough to feel live. */
    private const TTL_SECONDS = 30;

    public function __construct(private AchievementService $achievements) {}

    /**
     * The merged stream: community posts and DAO activity, newest first.
     *
     * Two sources rather than one table, because that is what Cyberia actually
     * has. They are merged here instead of in the browser so the wallet does
     * not have to page two lists against each other to show one column.
     */
    public function feed(Request $request): JsonResponse
    {
        $data = $request->validate([
            // `trades` is what the on-chain tab was called while it held swaps
            // only, and a wallet left open across a deploy still asks for it.
            'tab' => ['sometimes', 'string', 'in:all,posts,dao,onchain,trades'],
        ]);

        $tab = ($data['tab'] ?? 'all') === 'trades' ? 'onchain' : ($data['tab'] ?? 'all');

        $items = Cache::remember(
            "wallet.feed.{$tab}",
            self::TTL_SECONDS,
            fn () => $this->feedItems($tab),
        );

        return response()->json(['items' => $items]);
    }

    /**
     * Every DAO and its proposals, with the tallies the list draws.
     *
     * Voting power is summed per side by the database. It is a decimal string
     * on the way out, never a float: a governance total that has been through a
     * double is a total that can disagree with the votes it came from.
     */
    public function dao(): JsonResponse
    {
        $daos = Cache::remember(
            'wallet.dao.index',
            self::TTL_SECONDS,
            fn () => Dao::query()
                ->withCount('proposals')
                ->orderByDesc('proposals_count')
                ->get()
                ->map(fn (Dao $dao): array => [
                    'id' => $dao->id,
                    'name' => $dao->name,
                    'address' => $dao->address,
                    'proposals' => $dao->proposals_count,
                ])
                ->all(),
        );

        $proposals = Cache::remember(
            'wallet.dao.proposals',
            self::TTL_SECONDS,
            fn () => $this->proposalQuery()
                ->latest('id')
                ->limit(self::FEED_LIMIT)
                ->get()
                ->map(fn (Proposal $proposal) => $this->proposalSummary($proposal))
                ->all(),
        );

        return response()->json(['daos' => $daos, 'proposals' => $proposals]);
    }

    /** One proposal in full, with its body and its tally. */
    public function proposal(Proposal $proposal): JsonResponse
    {
        $proposal->loadMissing(['dao:id,name', 'user:id,name,avatar_path,wallet_address'])
            ->loadCount(['comments', 'votes'])
            ->loadSum('votesFor as power_for', 'voting_power')
            ->loadSum('votesAgainst as power_against', 'voting_power');

        return response()->json([
            'proposal' => $this->proposalSummary($proposal) + [
                'descriptionHtml' => $proposal->description_html,
            ],
        ]);
    }

    /**
     * A proposal's discussion: top-level comments oldest first, each with its
     * replies (the site threads one level deep, and so does this).
     *
     * Oldest first rather than the site's newest first, because the wallet
     * draws the whole thread under the proposal and a conversation reads
     * downwards. Bodies are the same sanitised markdown the site renders.
     */
    public function comments(Proposal $proposal): JsonResponse
    {
        $present = fn (ProposalComment $comment): array => [
            'id' => $comment->id,
            'at' => $comment->created_at?->toIso8601String(),
            'who' => $this->person($comment->user),
            'bodyHtml' => $comment->body_html,
        ];

        $comments = $proposal->comments()
            ->whereNull('parent_id')
            ->with([
                'user:id,name,avatar_path,wallet_address',
                'replies' => fn ($query) => $query->oldest('id'),
                'replies.user:id,name,avatar_path,wallet_address',
            ])
            ->oldest('id')
            ->limit(self::COMMENT_LIMIT)
            ->get()
            ->map(fn (ProposalComment $comment): array => $present($comment) + [
                'replies' => $comment->replies->map($present)->values()->all(),
            ])
            ->all();

        return response()->json(['comments' => $comments]);
    }

    /**
     * The public face of one address.
     *
     * Keyed by address rather than by user id because that is the only identity
     * the wallet has: it knows the key it holds, and nothing about an account
     * on this server. An address nobody here has claimed is a valid answer —
     * the wallet renders it as an unclaimed profile rather than as an error.
     */
    public function profile(string $address): JsonResponse
    {
        if (! preg_match('/^0x[a-fA-F0-9]{40}$/', $address)) {
            return response()->json(['message' => 'Not an EVM address.'], 422);
        }

        $address = Str::lower($address);

        return response()->json(Cache::remember(
            "wallet.profile.{$address}",
            self::TTL_SECONDS * 2,
            fn () => $this->profileFor($address),
        ));
    }

    /** @return array<string, mixed> */
    private function profileFor(string $address): array
    {
        $user = User::query()
            ->whereRaw('lower(wallet_address) = ?', [$address])
            ->first();

        if ($user === null) {
            return [
                'claimed' => false,
                'address' => $address,
                'achievements' => array_map(
                    fn (array $definition): array => [...$definition, 'earned' => false],
                    $this->achievements->definitions(),
                ),
            ];
        }

        return [
            'claimed' => true,
            'address' => $address,
            'name' => $user->name,
            // Whether the name is a name someone typed or one this address owns
            // on chain — the wallet marks the second differently, because only
            // that one is verifiable from where it is standing.
            'onchainNickname' => $user->getRawOriginal('onchain_nickname'),
            'avatar' => $user->avatar,
            'profileUrl' => $user->profile_url,
            'joinedAt' => $user->created_at?->toIso8601String(),
            'stats' => [
                'proposals' => Proposal::query()->where('user_id', $user->id)->count(),
                'votes' => ProposalVote::query()->where('user_id', $user->id)->count(),
                'posts' => Post::query()->where('user_id', $user->id)->count(),
            ],
            'achievements' => $this->achievements->forProfile($user),
        ];
    }

    /**
     * @return Builder<Proposal>
     */
    private function proposalQuery()
    {
        return Proposal::query()
            ->with(['dao:id,name', 'user:id,name,avatar_path,wallet_address'])
            ->withCount(['comments', 'votes'])
            ->withSum('votesFor as power_for', 'voting_power')
            ->withSum('votesAgainst as power_against', 'voting_power');
    }

    /** @return array<string, mixed> */
    private function proposalSummary(Proposal $proposal): array
    {
        return [
            'id' => $proposal->id,
            'title' => $proposal->title,
            'summary' => Str::limit(strip_tags($proposal->description), 220),
            'status' => $proposal->status,
            'endsAt' => $proposal->ends_at?->toIso8601String(),
            'dao' => $proposal->dao === null ? null : [
                'id' => $proposal->dao->id,
                'name' => $proposal->dao->name,
            ],
            'author' => $this->person($proposal->user),
            'comments' => (int) ($proposal->comments_count ?? 0),
            'votes' => (int) ($proposal->votes_count ?? 0),
            // Strings, because voting power is a decimal(*,18) and the browser
            // is only ever going to draw a proportion out of it.
            'powerFor' => (string) ($proposal->power_for ?? '0'),
            'powerAgainst' => (string) ($proposal->power_against ?? '0'),
            'url' => route('dao.show', $proposal->dao_id).'#proposal-'.$proposal->id,
        ];
    }

    /**
     * @return list<array<string, mixed>>
     */
    private function feedItems(string $tab): array
    {
        $items = [];

        if ($tab === 'all' || $tab === 'posts') {
            $items = array_merge($items, Post::query()
                ->with('user:id,name,avatar_path,wallet_address')
                ->latest('id')
                ->limit(self::FEED_LIMIT)
                ->get()
                ->map(fn (Post $post): array => [
                    'kind' => 'post',
                    'id' => "post-{$post->id}",
                    'at' => $post->created_at?->toIso8601String(),
                    'who' => $this->person($post->user),
                    'text' => $post->body,
                    'meta' => null,
                    'url' => route('feed'),
                ])
                ->all());
        }

        if ($tab === 'all' || $tab === 'dao') {
            $items = array_merge($items, Activity::query()
                ->with([
                    'user:id,name,avatar_path,wallet_address',
                    'dao:id,name',
                    // Loaded rather than walked lazily: without this every row
                    // fetches its own subject, and the feed is forty rows.
                    'subject' => function (MorphTo $morphTo) {
                        $morphTo->morphWith([
                            Proposal::class => [],
                            ProposalComment::class => ['proposal:id,title'],
                            ProposalVote::class => ['proposal:id,title'],
                        ]);
                    },
                ])
                ->latest('id')
                ->limit(self::FEED_LIMIT)
                ->get()
                ->map(fn (Activity $activity): array => [
                    'kind' => 'dao',
                    'id' => "activity-{$activity->id}",
                    'at' => $activity->created_at?->toIso8601String(),
                    'who' => $this->person($activity->user),
                    // The wallet says this in either language, so the type
                    // stays a key and the title travels beside it — a
                    // translation of "vote.cast" that could not name the
                    // proposal would be useless.
                    'type' => $activity->type,
                    'text' => $this->subjectTitle($activity),
                    'meta' => $activity->dao?->name,
                    'url' => $activity->dao_id === null
                        ? route('dao.index')
                        : route('dao.show', $activity->dao_id),
                ])
                ->all());
        }

        if ($tab === 'onchain' || $tab === 'all') {
            $items = array_merge($items, $this->onchainItems($tab === 'all'), $this->launchItems());
        }

        usort($items, fn (array $a, array $b) => ($b['at'] ?? '') <=> ($a['at'] ?? ''));

        return array_slice($items, 0, self::FEED_LIMIT);
    }

    /**
     * Everything the Telegram bot read off the chain (`activity_events`):
     * swaps on both exchanges, liquidity, lending, staking, conversions,
     * pump.fun buys, bridges, mints — every one of them, not only the ones
     * made in this wallet, which is the point of putting them in a feed.
     *
     * "All" carries them too: the project is small enough that each is news.
     * A dollar floor above zero (`wallet.feed.trade_floor_usd`) keeps the
     * small and the unpriced ones on the On-chain tab only.
     *
     * The actor is an address; where somebody here has claimed it the row
     * carries their name, and otherwise the address stands for them. The
     * table belongs to the bot and may be absent (a fresh install, a test
     * database), in which case there is simply nothing from the chain.
     *
     * @return list<array<string, mixed>>
     */
    private function onchainItems(bool $forAll): array
    {
        if (! Schema::hasTable('activity_events')) {
            return [];
        }

        $floor = (float) config('wallet.feed.trade_floor_usd');

        $rows = DB::table('activity_events')
            ->when($forAll && $floor > 0, fn ($query) => $query->where('usd', '>=', $floor))
            ->orderByDesc('id')
            ->limit(self::FEED_LIMIT)
            ->get(['id', 'kind', 'usd', 'sym_in', 'amt_in', 'sym_out', 'amt_out', 'user_addr', 'tx_hash', 'meta', 'created_at']);

        $users = $this->claimedBy($rows->pluck('user_addr'));

        return $rows->map(function ($row) use ($users): array {
            $address = $row->user_addr === null ? null : (string) $row->user_addr;
            $user = $address === null ? null : $users->get(Str::lower($address));

            return [
                'kind' => 'onchain',
                'id' => "onchain-{$row->id}",
                // The bot writes SQLite's UTC `datetime('now')`, with no zone.
                'at' => $row->created_at === null ? null : Carbon::parse($row->created_at, 'UTC')->toIso8601String(),
                'who' => $user !== null ? $this->person($user) : ChainActivity::person($address),
                'text' => null,
                'meta' => null,
                'onchain' => [
                    'action' => (string) $row->kind,
                    'in' => TradeAmount::format($row->amt_in, $row->sym_in),
                    'out' => TradeAmount::format($row->amt_out, $row->sym_out),
                    'detail' => ChainActivity::detail($row),
                    // Null when the price walker found no route — never 0.
                    'usd' => $row->usd === null ? null : round((float) $row->usd, 2),
                ],
                'url' => ChainActivity::txUrl($row) ?? ChainActivity::explorer(),
            ];
        })->all();
    }

    /**
     * Tokens launched on the launchpads, as `launchpad:watch` read them off
     * the chain — with the logo and the description where the creator signed
     * them, and the DAO the launch opened.
     *
     * @return list<array<string, mixed>>
     */
    private function launchItems(): array
    {
        $rows = LaunchpadToken::query()
            ->with('dao:id,name')
            ->whereNotNull('launched_at')
            ->latest('launched_at')
            ->limit(self::FEED_LIMIT)
            ->get();

        $users = $this->claimedBy($rows->pluck('creator'));

        return $rows->map(function (LaunchpadToken $token) use ($users): array {
            $user = $token->creator ? $users->get(Str::lower($token->creator)) : null;

            return [
                'kind' => 'launch',
                'id' => "launch-{$token->id}",
                'at' => $token->launched_at?->toIso8601String(),
                'who' => $user !== null ? $this->person($user) : ChainActivity::person($token->creator),
                'text' => $token->description,
                'meta' => null,
                'launch' => [
                    'address' => Str::lower($token->address),
                    'name' => $token->name,
                    'symbol' => $token->symbol,
                    'image' => $token->image_path ? Storage::disk('public')->url($token->image_path) : null,
                    'dao' => $token->dao ? ['id' => $token->dao->id, 'name' => $token->dao->name] : null,
                ],
                'url' => ChainActivity::explorer().'/token/'.Str::lower($token->address),
            ];
        })->all();
    }

    /**
     * The accounts that claimed these addresses, keyed by lowercase address.
     *
     * @param  Collection<int, mixed>  $addresses
     * @return Collection<string, User>
     */
    private function claimedBy(Collection $addresses): Collection
    {
        $wanted = $addresses->filter(fn ($a) => is_string($a) && preg_match('/^0x[0-9a-fA-F]{40}$/', $a))
            ->map(fn ($a) => Str::lower((string) $a))
            ->unique()
            ->values();

        return $wanted->isEmpty() ? collect() : User::query()
            ->whereIn(DB::raw('lower(wallet_address)'), $wanted->all())
            ->get(['id', 'name', 'avatar_path', 'wallet_address'])
            ->keyBy(fn (User $user) => Str::lower($user->wallet_address));
    }

    /** What an activity row is about, named by the proposal behind it. */
    private function subjectTitle(Activity $activity): ?string
    {
        $subject = $activity->subject;

        return match (true) {
            $subject instanceof Proposal => $subject->title,
            $subject instanceof ProposalComment => $subject->proposal?->title,
            $subject instanceof ProposalVote => $subject->proposal?->title,
            default => null,
        };
    }

    /** @return array<string, mixed>|null */
    private function person(?User $user): ?array
    {
        return $user === null ? null : [
            'name' => $user->name,
            'avatar' => $user->avatar,
            'address' => $user->wallet_address,
            'url' => $user->profile_url,
        ];
    }
}
