<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\AnalyticsUser;
use App\Models\FcmToken;
use App\Support\Localised;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The native app's push address, kept like the wallet's Web Push subscription
 * (WalletPushController): against the installation UUID, credential-less, and
 * revealing nothing in return. The worst a forged call does is make a device
 * receive the public notifications everybody receives.
 */
class WalletFcmController extends Controller
{
    public function store(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'user_id' => ['required', 'uuid'],
            'token' => ['required', 'string', 'min:20', 'max:512'],
            'platform' => ['sometimes', 'string', 'in:android,ios'],
            'locale' => ['sometimes', 'nullable', 'string', 'max:12'],
        ]);

        if (AnalyticsUser::find($validated['user_id']) === null) {
            return response()->json(['registered' => false, 'reason' => 'unknown'], 404);
        }

        FcmToken::updateOrCreate(['token' => $validated['token']], [
            'analytics_user_id' => $validated['user_id'],
            'platform' => $validated['platform'] ?? 'android',
            'locale' => Localised::normalise($validated['locale'] ?? null),
            'last_seen_at' => now(),
        ]);

        return response()->json(['registered' => true]);
    }

    public function destroy(Request $request): JsonResponse
    {
        $validated = $request->validate(['token' => ['required', 'string', 'max:512']]);
        FcmToken::where('token', $validated['token'])->delete();

        return response()->json(['registered' => false]);
    }
}
