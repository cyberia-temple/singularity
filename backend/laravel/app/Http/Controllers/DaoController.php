<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreDaoRequest;
use App\Http\Requests\UpdateDaoRequest;
use App\Models\Activity;
use App\Models\Dao;
use App\Models\LaunchpadToken;
use App\Models\Proposal;
use App\Models\ProposalComment;
use App\Models\ProposalVote;
use App\Services\Dao\DaoNotifier;
use Illuminate\Database\Eloquent\Relations\MorphTo;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Gate;
use Inertia\Inertia;

class DaoController extends Controller
{
    public function index()
    {
        return Inertia::render('dao/Index', [
            'activities' => Activity::with([
                'user:id,name,onchain_nickname,avatar_path,wallet_address',
                'dao:id,name',
                'subject' => function (MorphTo $morphTo) {
                    $morphTo->morphWith([
                        Proposal::class => ['dao:id,name'],
                        ProposalComment::class => ['proposal:id,title'],
                        ProposalVote::class => ['proposal:id,title'],
                    ]);
                },
            ])
                ->latest('id')
                ->paginate(20),
            'daos' => Dao::withCount('proposals')
                ->orderByDesc('proposals_count')
                ->get(),
        ]);
    }

    public function show(Dao $dao)
    {
        return Inertia::render('dao/Show', [
            'dao' => $dao,
            'proposals' => $dao->proposals()
                ->with(['user:id,name,onchain_nickname,avatar_path,wallet_address'])
                ->withCount(['comments', 'votes'])
                ->withSum('votesFor as power_for', 'voting_power')
                ->withSum('votesAgainst as power_against', 'voting_power')
                ->latest()
                ->paginate(15),
        ]);
    }

    public function store(StoreDaoRequest $request, DaoNotifier $notifier): RedirectResponse
    {
        $dao = Dao::create([
            ...$request->validated(),
            'user_id' => $request->user()->id,
        ]);

        $notifier->daoCreated($dao);

        return back()->with('success', 'DAO created');
    }

    public function update(UpdateDaoRequest $request, Dao $dao): RedirectResponse
    {
        Gate::authorize('update', $dao);

        $data = $request->validated();

        // A launched token's DAO is voted in that token and in nothing else;
        // its owner may rename it, never point it at another contract.
        if (LaunchpadToken::query()->where('dao_id', $dao->id)->exists()) {
            unset($data['address']);
        }

        $dao->update($data);

        return back()->with('success', 'DAO updated');
    }

    public function destroy(Dao $dao): RedirectResponse
    {
        Gate::authorize('delete', $dao);

        $dao->delete();

        return back()->with('success', 'DAO deleted');
    }
}
