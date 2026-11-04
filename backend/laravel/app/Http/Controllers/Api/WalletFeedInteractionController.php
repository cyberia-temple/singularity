<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\Post;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

class WalletFeedInteractionController extends Controller
{
    private function visible(Post $post): void
    {
        abort_if($post->hidden_at !== null, 404);
    }

    private function checkAddress(Request $request): void
    {
        $request->validate(['address' => ['required', 'string']]);
        abort_unless(strtolower($request->user()->wallet_address ?? '') === strtolower($request->input('address')), 409, 'The active wallet differs from the signed-in account.');
    }

    public function reaction(Request $request, Post $post): JsonResponse
    {
        $this->visible($post);
        $this->checkAddress($request);
        $data = $request->validate([
            'kind' => ['required', Rule::in(['like', 'repost'])],
            'active' => ['required', 'boolean'],
        ]);
        $key = ['post_id' => $post->id, 'user_id' => $request->user()->id, 'kind' => $data['kind']];
        if ($data['active']) {
            DB::table('post_reactions')->insertOrIgnore([...$key, 'created_at' => now(), 'updated_at' => now()]);
        } else {
            DB::table('post_reactions')->where($key)->delete();
        }
        Cache::forget('wallet.feed.all');
        Cache::forget('wallet.feed.posts');

        return response()->json(['active' => $data['active'], 'count' => DB::table('post_reactions')->where('post_id', $post->id)->where('kind', $data['kind'])->count()]);
    }

    public function view(Request $request, Post $post): JsonResponse
    {
        $this->visible($post);
        DB::table('post_views')->insertOrIgnore([
            'post_id' => $post->id,
            'viewer' => hash_hmac('sha256', $request->session()->getId(), (string) config('app.key')),
            'day' => now()->toDateString(),
        ]);

        return response()->json(['count' => DB::table('post_views')->where('post_id', $post->id)->count()]);
    }

    public function replies(Request $request, Post $post): JsonResponse
    {
        $this->visible($post);
        $data = $request->validate(['before' => ['sometimes', 'integer', 'min:1']]);
        $replies = DB::table('post_replies')->join('users', 'users.id', '=', 'post_replies.user_id')
            ->where('post_replies.post_id', $post->id)
            ->when(isset($data['before']), fn ($query) => $query->where('post_replies.id', '<', $data['before']))
            ->orderByDesc('post_replies.id')->limit(101)
            ->get(['post_replies.id', 'post_replies.body', 'post_replies.created_at', 'users.name', 'users.wallet_address']);

        $hasMore = $replies->count() > 100;

        return response()->json(['replies' => $replies->take(100)->reverse()->values(), 'hasMore' => $hasMore]);
    }

    public function reply(Request $request, Post $post): JsonResponse
    {
        $this->visible($post);
        $this->checkAddress($request);
        $data = $request->validate(['body' => ['required', 'string', 'max:2000']]);
        DB::table('post_replies')->insert(['post_id' => $post->id, 'user_id' => $request->user()->id, 'body' => $data['body'], 'created_at' => now(), 'updated_at' => now()]);

        return $this->replies($request, $post);
    }
}
