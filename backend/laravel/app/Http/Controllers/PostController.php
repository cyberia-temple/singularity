<?php

namespace App\Http\Controllers;

use App\Http\Requests\StorePostRequest;
use App\Models\Post;
use App\Services\GamificationService;
use App\Services\Social\PostAnnouncer;
use Illuminate\Http\RedirectResponse;
use Illuminate\Support\Facades\Cache;
use Inertia\Inertia;
use Inertia\Response;

class PostController extends Controller
{
    public function index(): Response
    {
        return Inertia::render('Feed', [
            'posts' => Post::query()
                ->visible()
                ->with(['user:id,name,onchain_nickname,avatar_path,wallet_address'])
                ->latest('id')
                ->paginate(20),
        ]);
    }

    public function store(
        StorePostRequest $request,
        GamificationService $gamification,
        PostAnnouncer $announcer,
    ): RedirectResponse {
        $post = $request->user()->posts()->create($request->validated());
        Cache::forget('wallet.feed.all');
        Cache::forget('wallet.feed.posts');

        // The wall paid nothing until now, which made it the one place on this
        // site where taking part was worth less than opening a page. Keyed by
        // the post so editing or reloading cannot pay twice.
        $gamification->recordAction($request->user(), 'post', (string) $post->getKey());

        /*
         * And everybody who allowed notifications hears about it — written
         * here or written in the wallet, it is the same feed and the same
         * audience. After the response, because this host has no queue worker
         * and the person who wrote the post should not wait on the fan-out.
         */
        dispatch(fn () => $announcer->announce($post))->afterResponse();

        return back()->with('status', 'post-created');
    }
}
