<?php

namespace App\Services\Push;

use App\Models\AnalyticsUser;
use App\Models\FcmToken;
use Illuminate\Notifications\Notification;
use NotificationChannels\WebPush\WebPushMessage;
use Throwable;

/**
 * The same public notification the browsers get as Web Push, to the native
 * apps through FCM: a WebView holds no Web Push subscription, so until now the
 * app never rang. Each token is addressed as its installation (so the title is
 * in that installation's language), a token Firebase says is gone is forgotten,
 * and the same ceiling as the Web Push fan-out keeps it a bounded loop.
 */
class FcmFanOut
{
    private const CEILING = 2000;

    public function __construct(private readonly FcmClient $client) {}

    public function send(Notification $notification): int
    {
        if (! $this->client->configured() || ! method_exists($notification, 'toWebPush')) {
            return 0;
        }

        $sent = 0;
        FcmToken::query()->with('installation')->orderBy('id')->chunkById(200, function ($tokens) use ($notification, &$sent) {
            foreach ($tokens as $token) {
                if ($sent >= self::CEILING) {
                    return false;
                }
                try {
                    $recipient = $token->installation ?? new AnalyticsUser(['notification_locale' => $token->locale]);
                    /** @var WebPushMessage $message */
                    $message = $notification->toWebPush($recipient, $notification);
                    $payload = $message->toArray();
                    $url = (string) ($payload['data']['url'] ?? $payload['data']['link'] ?? '/wallet');
                    $outcome = $this->client->send($token->token, (string) ($payload['title'] ?? 'Cyberia'), (string) ($payload['body'] ?? ''), ['url' => $url]);
                    if ($outcome === 'gone') {
                        $token->delete();
                    } elseif ($outcome === 'sent') {
                        $sent++;
                    }
                } catch (Throwable $e) {
                    report($e);
                }
            }

            return true;
        });

        return $sent;
    }
}
