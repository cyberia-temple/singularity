<?php

namespace App\Services\Social;

use App\Models\Post;
use App\Notifications\FeedPostNotification;

/**
 * A new post, delivered to everyone who can be reached — see `Broadcaster`
 * for who that is and why the author's own wallet may still hear it (the
 * wallet drops a notification for a post it has just written on that device).
 */
class PostAnnouncer
{
    public function __construct(private Broadcaster $broadcaster) {}

    public function announce(Post $post): void
    {
        $post->loadMissing('user:id,name,onchain_nickname');

        $this->broadcaster->broadcast(FeedPostNotification::for($post), (int) $post->user_id);
    }
}
