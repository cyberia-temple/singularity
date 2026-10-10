<?php

namespace App\Notifications;

use App\Models\AnalyticsUser;
use App\Models\User;
use App\Support\Localised;
use Illuminate\Notifications\Notification;
use NotificationChannels\WebPush\WebPushChannel;
use NotificationChannels\WebPush\WebPushMessage;

/**
 * Something somebody did, announced to the community (`Broadcaster`).
 *
 * Title and body are locale maps with `{placeholders}`, resolved per recipient:
 * a notification speaks to somebody who is not looking at a browser, so it
 * writes in whatever the browser said when it registered for push and falls
 * back to English exactly as `t()` does. What somebody *wrote* travels as a
 * placeholder value and is never translated.
 *
 * An account gets the bell row and, with a subscription, the push; a wallet
 * installation has no bell, so it gets the push only.
 */
class CommunityNotification extends Notification
{
    /**
     * @param  array<string, string>  $title
     * @param  array<string, string>  $body
     * @param  array<string, string|int>  $params
     */
    public function __construct(
        public string $type,
        public ?User $actor,
        public array $title,
        public array $body,
        public array $params,
        public string $url,
    ) {}

    /** Named for the notifiable, because Notification::locale() is taken. */
    private function localeOf(object $notifiable): ?string
    {
        return $notifiable instanceof User || $notifiable instanceof AnalyticsUser
            ? $notifiable->notification_locale
            : null;
    }

    public function titleFor(object $notifiable): string
    {
        return Localised::pick($this->title, $this->localeOf($notifiable), $this->params);
    }

    public function bodyFor(object $notifiable): string
    {
        return Localised::pick($this->body, $this->localeOf($notifiable), $this->params);
    }

    /**
     * @return array<int, string>
     */
    public function via(object $notifiable): array
    {
        $channels = $notifiable instanceof AnalyticsUser ? [] : ['database'];

        if (config('webpush.vapid.public_key')
            && ($notifiable instanceof User || $notifiable instanceof AnalyticsUser)
            && $notifiable->pushSubscriptions()->exists()) {
            $channels[] = WebPushChannel::class;
        }

        return $channels;
    }

    /**
     * @return array<string, mixed>
     */
    public function toArray(object $notifiable): array
    {
        return [
            'type' => $this->type,
            'actor_id' => $this->actor?->id,
            'actor_name' => $this->actor?->name,
            'actor_wallet' => $this->actor?->wallet_address,
            'title' => $this->titleFor($notifiable),
            'body' => $this->bodyFor($notifiable),
            'url' => $this->url,
        ];
    }

    public function toWebPush(object $notifiable, Notification $notification): WebPushMessage
    {
        return (new WebPushMessage)
            ->title($this->titleFor($notifiable))
            ->body($this->bodyFor($notifiable))
            ->icon('/apple-touch-icon.png')
            ->data(['url' => $this->url]);
    }
}
