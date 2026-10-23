<?php

namespace App\Notifications;

use App\Models\User;
use Illuminate\Notifications\Notification;
use NotificationChannels\WebPush\WebPushChannel;
use NotificationChannels\WebPush\WebPushMessage;

/**
 * "A friend's swap just earned you this."
 *
 * Sent once per recorded reward, after the row is written, so it never
 * announces money the books do not hold. It says *earned*, not *received*:
 * the transfer happens at the weekly payout, and a notification that implied
 * the money was already in the wallet would be the first thing a person
 * checks and the first thing that is wrong.
 */
class ReferralRewardNotification extends Notification
{
    public function __construct(public float $rewardUsd) {}

    /**
     * @return array<int, string>
     */
    public function via(object $notifiable): array
    {
        $channels = ['database'];

        if (config('webpush.vapid.public_key')
            && $notifiable instanceof User
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
            'type' => 'referral_reward',
            'title' => 'Referral reward',
            'body' => $this->body(),
            'url' => '/wallet?section=invite',
            'reward_usd' => $this->rewardUsd,
        ];
    }

    public function toWebPush(object $notifiable, Notification $notification): WebPushMessage
    {
        return (new WebPushMessage)
            ->title('Referral reward')
            ->body($this->body())
            ->icon('/apple-touch-icon.png')
            ->data(['url' => '/wallet?section=invite']);
    }

    private function body(): string
    {
        // Sub-cent shares are real and common: show them rather than "$0.00".
        $amount = $this->rewardUsd >= 0.01
            ? number_format($this->rewardUsd, 2)
            : number_format($this->rewardUsd, 4);

        return 'You earned $'.$amount.' from a friend’s swap fees';
    }
}
