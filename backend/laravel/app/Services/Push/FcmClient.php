<?php

namespace App\Services\Push;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use RuntimeException;

/**
 * Firebase Cloud Messaging, HTTP v1. Signs in with the Firebase project's
 * service account (FCM_CREDENTIALS = the path of its JSON key, which stays on
 * this host) and sends one message per token. Off — and silent — until that
 * key is there.
 */
class FcmClient
{
    private const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

    public function configured(): bool
    {
        return $this->credentials() !== null;
    }

    /**
     * @param  array<string, string>  $data
     * @return 'sent'|'gone'|'failed' gone = the token no longer exists and should be forgotten
     */
    public function send(string $token, string $title, string $body, array $data = []): string
    {
        $credentials = $this->credentials() ?? throw new RuntimeException('FCM_CREDENTIALS is not set.');
        $response = Http::withToken($this->accessToken($credentials))->timeout(10)->acceptJson()
            ->post("https://fcm.googleapis.com/v1/projects/{$credentials['project_id']}/messages:send", [
                'message' => [
                    'token' => $token,
                    'notification' => ['title' => mb_substr($title, 0, 120), 'body' => mb_substr($body, 0, 400)],
                    'data' => array_map('strval', $data),
                    'android' => [
                        'priority' => 'high',
                        'notification' => ['channel_id' => (string) config('services.fcm.channel', 'cyberia'), 'click_action' => 'FCM_PLUGIN_ACTIVITY'],
                    ],
                ],
            ]);

        if ($response->successful()) {
            return 'sent';
        }

        $status = (string) $response->json('error.status');

        return $response->status() === 404 || in_array($status, ['NOT_FOUND', 'UNREGISTERED'], true)
            || ($response->status() === 400 && str_contains((string) $response->json('error.message'), 'registration token'))
            ? 'gone' : 'failed';
    }

    /** @param  array{client_email: string, private_key: string, project_id: string, token_uri?: string}  $credentials */
    private function accessToken(array $credentials): string
    {
        return Cache::remember('fcm-token:'.sha1($credentials['client_email']), 3000, function () use ($credentials) {
            $b64 = fn (string $raw) => rtrim(strtr(base64_encode($raw), '+/', '-_'), '=');
            $now = time();
            $unsigned = $b64(json_encode(['alg' => 'RS256', 'typ' => 'JWT'])).'.'.$b64(json_encode([
                'iss' => $credentials['client_email'],
                'scope' => self::SCOPE,
                'aud' => $credentials['token_uri'] ?? 'https://oauth2.googleapis.com/token',
                'iat' => $now,
                'exp' => $now + 3600,
            ]));
            if (! openssl_sign($unsigned, $signature, $credentials['private_key'], OPENSSL_ALGO_SHA256)) {
                throw new RuntimeException('The Firebase key could not sign.');
            }
            $response = Http::asForm()->timeout(15)->post($credentials['token_uri'] ?? 'https://oauth2.googleapis.com/token', [
                'grant_type' => 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                'assertion' => $unsigned.'.'.$b64($signature),
            ]);
            $token = $response->json('access_token');
            if ($response->failed() || ! is_string($token)) {
                throw new RuntimeException("Google refused the Firebase key ({$response->status()}).");
            }

            return $token;
        });
    }

    /** @return array{client_email: string, private_key: string, project_id: string, token_uri?: string}|null */
    private function credentials(): ?array
    {
        $path = (string) config('services.fcm.credentials');
        if ($path === '' || ! is_readable($path)) {
            return null;
        }
        $json = json_decode((string) file_get_contents($path), true);

        return is_array($json) && is_string($json['client_email'] ?? null) && is_string($json['private_key'] ?? null) && is_string($json['project_id'] ?? null)
            ? $json : null;
    }
}
