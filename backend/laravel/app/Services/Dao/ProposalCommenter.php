<?php

namespace App\Services\Dao;

use App\Models\Proposal;
use App\Models\ProposalComment;
use App\Models\User;

/**
 * Commenting on a proposal: one sequence, whether the site's thread or the
 * wallet posted it — the row, the feed entry and the notification to the
 * author and everyone already in the thread.
 */
class ProposalCommenter
{
    public function __construct(
        private ActivityRecorder $activityRecorder,
        private DaoNotifier $notifier,
    ) {}

    public function post(User $user, Proposal $proposal, string $body, ?int $parentId = null): ProposalComment
    {
        $comment = $proposal->comments()->create([
            'body' => $body,
            'parent_id' => $parentId,
            'user_id' => $user->id,
        ]);

        $this->activityRecorder->record('comment.posted', $user, $comment, $proposal->dao);

        $this->notifier->commentPosted($comment);

        return $comment;
    }
}
