<?php

namespace App\Services\Dao;

use App\Models\Activity;
use App\Models\Dao;
use App\Models\Proposal;
use App\Models\ProposalComment;
use App\Models\ProposalVote;
use App\Models\Reaction;
use App\Models\User;
use App\Notifications\DaoActivityNotification;
use App\Services\Social\Broadcaster;
use Illuminate\Support\Str;

/**
 * Announces DAO activity to the whole community (`Broadcaster`).
 *
 * It used to notify only the people an action was *about* — a proposal's
 * prior participants, the author of what was commented on or voted on — so
 * somebody who opened a proposal and voted on it heard nothing, and neither
 * did anybody else, and no wallet installation ever heard about the DAO at
 * all. Now every action reaches everyone who allowed notifications, and the
 * people it is about still get the bell row even without push.
 *
 * Delivery is deferred with dispatch(...)->afterResponse() because production
 * runs no queue worker: the work happens in the same PHP process right after
 * the response is flushed, so the user never waits on push HTTP calls.
 */
class DaoNotifier
{
    public function __construct(private Broadcaster $broadcaster) {}

    public function daoCreated(Dao $dao): void
    {
        $actor = $dao->user;

        if (! $actor) {
            return;
        }

        $this->send($actor, [], new DaoActivityNotification(
            type: 'dao.created',
            actor: $actor,
            title: ['en' => 'New DAO: {dao}', 'ru' => 'Новое DAO: {dao}', 'zh' => '新的 DAO：{dao}'],
            body: ['en' => 'Created by {name}', 'ru' => 'Создал {name}', 'zh' => '由 {name} 创建'],
            params: ['dao' => Str::limit($dao->name, 60), 'name' => $this->actorName($actor)],
            url: '/wallet?section=dao',
        ));
    }

    public function proposalCreated(Proposal $proposal): void
    {
        $actor = $proposal->user;

        if (! $actor) {
            return;
        }

        // The DAO's prior participants, who used to be the only audience,
        // still get the bell row whether or not they allowed push.
        $participants = Activity::where('dao_id', $proposal->dao_id)->distinct()->pluck('user_id');

        $this->send($actor, $participants, new DaoActivityNotification(
            type: 'proposal.created',
            actor: $actor,
            title: ['en' => 'New proposal in {dao}', 'ru' => 'Новое предложение в {dao}', 'zh' => '{dao} 有新提案'],
            body: ['en' => '{name}: {title}', 'ru' => '{name}: {title}', 'zh' => '{name}：{title}'],
            params: [
                'dao' => $proposal->dao?->name ?? 'DAO',
                'name' => $this->actorName($actor),
                'title' => Str::limit($proposal->title, 80),
            ],
            url: $this->proposalUrl($proposal->id),
        ));
    }

    public function commentPosted(ProposalComment $comment): void
    {
        $actor = $comment->user;
        $proposal = $comment->proposal;

        if (! $actor || ! $proposal) {
            return;
        }

        $involved = collect([$proposal->user_id, $comment->parent?->user_id])
            ->merge($proposal->comments()->pluck('user_id'));

        $this->send($actor, $involved, new DaoActivityNotification(
            type: 'comment.posted',
            actor: $actor,
            title: ['en' => 'New comment on {title}', 'ru' => 'Новый комментарий: {title}', 'zh' => '新评论：{title}'],
            body: ['en' => '{name}: {body}', 'ru' => '{name}: {body}', 'zh' => '{name}：{body}'],
            params: [
                'title' => Str::limit($proposal->title, 60),
                'name' => $this->actorName($actor),
                'body' => Str::limit($comment->body, 80),
            ],
            url: $this->proposalUrl($proposal->id),
        ));
    }

    public function voteCast(ProposalVote $vote): void
    {
        $actor = $vote->user;
        $proposal = $vote->proposal;

        if (! $actor || ! $proposal) {
            return;
        }

        $this->send($actor, [$proposal->user_id], new DaoActivityNotification(
            type: 'vote.cast',
            actor: $actor,
            title: ['en' => 'New vote on {title}', 'ru' => 'Новый голос: {title}', 'zh' => '新投票：{title}'],
            body: $vote->support
                ? ['en' => '{name} voted for', 'ru' => '{name} проголосовал за', 'zh' => '{name} 投了赞成票']
                : ['en' => '{name} voted against', 'ru' => '{name} проголосовал против', 'zh' => '{name} 投了反对票'],
            params: ['title' => Str::limit($proposal->title, 60), 'name' => $this->actorName($actor)],
            url: $this->proposalUrl($proposal->id),
        ));
    }

    public function reactionAdded(Reaction $reaction): void
    {
        $actor = $reaction->user;
        $reactable = $reaction->reactable;

        if (! $actor || ! $reactable) {
            return;
        }

        $isComment = $reactable instanceof ProposalComment;
        $proposalId = $isComment ? $reactable->proposal_id : $reactable->getKey();

        $this->send($actor, [$reactable->user_id], new DaoActivityNotification(
            type: 'reaction.added',
            actor: $actor,
            title: ['en' => '{name} reacted {emoji}', 'ru' => '{name}: реакция {emoji}', 'zh' => '{name} 回应了 {emoji}'],
            body: $isComment
                ? ['en' => '{emoji} on a comment', 'ru' => '{emoji} на комментарий', 'zh' => '{emoji} 评论']
                : ['en' => '{emoji} on a proposal', 'ru' => '{emoji} на предложение', 'zh' => '{emoji} 提案'],
            params: ['name' => $this->actorName($actor), 'emoji' => $reaction->emoji],
            url: $this->proposalUrl((int) $proposalId),
        ));
    }

    /**
     * The wallet is where these people are, and it opens the proposal itself
     * (`?proposal=`); the site's own page stays one tap away from there.
     */
    private function proposalUrl(int $id): string
    {
        return "/wallet?section=dao&proposal={$id}";
    }

    /**
     * @param  iterable<int|null>  $involved
     */
    private function send(User $actor, iterable $involved, DaoActivityNotification $notification): void
    {
        $involved = collect($involved)->all();
        $deliver = fn () => $this->broadcaster->broadcast($notification, $actor->id, $involved);

        // Terminating callbacks accumulate across requests inside one test
        // (and would re-fire), so only defer in real HTTP lifecycles.
        if (app()->runningUnitTests()) {
            $deliver();

            return;
        }

        dispatch($deliver)->afterResponse();
    }

    private function actorName(User $actor): string
    {
        return $actor->onchain_nickname ?: ($actor->name
            ?: ($actor->wallet_address
                ? substr($actor->wallet_address, 0, 6).'…'.substr($actor->wallet_address, -4)
                : 'Someone'));
    }
}
