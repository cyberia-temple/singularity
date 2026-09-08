<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Monero\MoneroSwapService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * Swapping Monero, from the wallet, by two routes at once.
 *
 * Two reads and no state, in the shape the rest of `/wallet` uses: what the
 * two routes are and what they cost, and what the partner exchanger pays for
 * a given amount. Nothing here signs and no account is required.
 *
 * The partner quote goes through this host for one reason — the affiliate key
 * and Cyberia's share are composed server-side, and a fee a browser writes is
 * a fee a browser can delete. Our own route's DEX leg deliberately does not
 * come from here: the browser already holds both AMM versions and the pool
 * graph, and a second implementation of the number somebody is about to sign
 * against is how the two disagree.
 */
class WalletMoneroSwapController extends Controller
{
    public function __construct(private readonly MoneroSwapService $swaps) {}

    /**
     * Both routes, before an amount is typed.
     *
     * A route that cannot run right now is listed with its reason rather than
     * dropped: "the Monero corridor is not switched on yet" and "we do not do
     * this" are different sentences, and only one of them is true here.
     */
    public function index(): JsonResponse
    {
        return response()->json([
            'enabled' => $this->swaps->enabled(),
            'fee_bps' => $this->swaps->feeBps(),
            'routes' => [
                $this->swaps->ownRoute(),
                $this->swaps->partnerRoute(),
            ],
        ]);
    }

    /**
     * What the partner exchanger pays for this trade, our share included.
     *
     * The amount is a decimal string all the way through — Monero has twelve
     * decimals and a float loses the last of them silently.
     */
    public function quote(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'from' => ['required', 'string', 'max:12', 'regex:/^[A-Za-z0-9]+$/'],
            'to' => ['required', 'string', 'max:12', 'regex:/^[A-Za-z0-9]+$/'],
            'amount' => ['required', 'string', 'max:40', 'regex:/^\d+(\.\d+)?$/'],
            'side' => ['nullable', 'in:from,to'],
        ]);

        if (strcasecmp($validated['from'], $validated['to']) === 0) {
            return response()->json(['ok' => false, 'reason' => 'same_asset'], 422);
        }

        // One of the two sides must be Monero: this endpoint exists because no
        // aggregator routes XMR, and it is not a general swap desk.
        if (strcasecmp($validated['from'], 'XMR') !== 0 && strcasecmp($validated['to'], 'XMR') !== 0) {
            return response()->json(['ok' => false, 'reason' => 'not_a_monero_swap'], 422);
        }

        if ((float) $validated['amount'] <= 0) {
            return response()->json(['ok' => false, 'reason' => 'zero_amount'], 422);
        }

        $quote = $this->swaps->partnerQuote(
            $validated['from'],
            $validated['to'],
            $validated['amount'],
            $validated['side'] ?? 'from',
        );

        // A refusal is an answer, not a server error: the screen draws the
        // other route and says why this one is missing.
        return response()->json($quote, $quote['ok'] ? 200 : 200);
    }
}
