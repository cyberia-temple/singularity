<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Http\Requests\ExtensionAnalyticsRequest;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Support\Facades\Http;
use Symfony\Component\HttpFoundation\Response;

class ExtensionAnalyticsController extends Controller
{
    public function __invoke(ExtensionAnalyticsRequest $request): Response
    {
        $secret = config('services.extension_analytics.api_secret');
        if (! $secret) {
            return response()->noContent();
        }

        try {
            Http::connectTimeout(2)->timeout(4)->post('https://www.google-analytics.com/mp/collect?'.http_build_query([
                'measurement_id' => config('services.extension_analytics.measurement_id'),
                'api_secret' => $secret,
            ]), [
                'client_id' => $request->validated('client_id'),
                'events' => [[
                    'name' => 'extension_open',
                    'params' => ['session_id' => time(), 'engagement_time_msec' => 100],
                ]],
            ]);
        } catch (ConnectionException) {
            // The URL contains a secret; do not report the exception.
        }

        return response()->noContent();
    }
}
