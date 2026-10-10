<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreProposalCommentRequest;
use App\Models\Proposal;
use App\Models\ProposalComment;
use App\Services\Dao\ProposalCommenter;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Gate;

class ProposalCommentController extends Controller
{
    public function __construct(private ProposalCommenter $commenter) {}

    public function store(StoreProposalCommentRequest $request, Proposal $proposal): RedirectResponse
    {
        $this->commenter->post(
            $request->user(),
            $proposal,
            $request->validated('body'),
            $request->validated('parent_id'),
        );

        return back()->with('success', 'Comment added');
    }

    public function destroy(ProposalComment $comment): RedirectResponse
    {
        Gate::authorize('delete', $comment);

        $comment->delete();

        return back()->with('success', 'Comment deleted');
    }
}
