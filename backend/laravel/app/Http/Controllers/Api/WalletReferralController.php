<?php

namespace App\Http\Controllers\Api;

use App\Exceptions\ReferralRefused;
use App\Http\Controllers\Controller;
use App\Models\User;
use App\Services\ReferralService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;

/**
 * The wallet's invite screen.
 *
 * Account-based for the reason the daily board is: a referral is a fact about
 * two people, the one who invited and the one who came. Signed out, the
 * screen still gets the rules — what is shared, from which fee, how it is
 * paid — and is told the rest belongs to an account the wallet can prove.
 */
class WalletReferralController extends Controller
{
    public function __construct(private readonly ReferralService $referrals) {}

    public function show(Request $request): JsonResponse
    {
        return response()->json($this->referrals->board($request->user()));
    }

    /**
     * Accept an invite for the signed-in account.
     *
     * A refusal answers 422 with the reason key next to the sentence, so the
     * wallet can say "this account is too old for an invite" in Russian
     * without parsing English.
     */
    public function attach(Request $request): JsonResponse
    {
        $user = $request->user();

        if (! $user instanceof User) {
            return response()->json([
                'message' => 'Sign in with this wallet to accept an invite.',
                'reason' => 'signed_out',
            ], 401);
        }

        $data = $request->validate([
            'code' => ['required', 'string', 'max:16'],
        ]);

        try {
            $fresh = $this->referrals->attach($user, (string) $data['code']);
        } catch (ReferralRefused $refused) {
            return response()->json([
                'message' => $refused->getMessage(),
                'reason' => $refused->reason,
            ], 422);
        }

        return response()->json($this->referrals->board($fresh));
    }

    /**
     * `/r/{code}` — the link people actually share.
     *
     * It lands on the wallet's invite screen carrying the code; the wallet
     * keeps it until this browser has an account to attach it to. `invite`
     * rather than `ref`, because `?ref=` already means an on-ramp order when
     * a provider sends somebody back to the wallet.
     */
    public function landing(string $code): RedirectResponse
    {
        $query = preg_match(ReferralService::CODE_PATTERN, $code)
            ? '?section=invite&invite='.strtoupper($code)
            : '?section=invite';

        return redirect('/wallet'.$query);
    }
}
