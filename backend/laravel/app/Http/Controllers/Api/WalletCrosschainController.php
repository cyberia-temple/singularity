<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\CrosschainRouter;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Throwable;

/**
 * Cross-chain swaps for the unified wallet.
 *
 * Four reads and no state: what the router can reach, what tokens live on a
 * chain, what one route costs, and where a started swap has got to. Nothing
 * here signs, nothing here is written down, and no account is required —
 * consistent with the rest of `/wallet`, whose whole point is that the server
 * never sees a key.
 *
 * The one thing this endpoint is *for* is composing the quote request, and it
 * is the reason the browser does not call the router directly: Cyberia's fee
 * is a field in that request, and a field a browser writes is a field a
 * browser can delete. See `App\Services\CrosschainRouter`.
 */
class WalletCrosschainController extends Controller
{
    public function __construct(private readonly CrosschainRouter $router) {}

    /**
     * What this host can route, and what it charges for doing so.
     *
     * The fee is stated here, before any amount is typed, because a fee a user
     * discovers on the review screen is a fee they were not told about. The
     * address is published for the same reason: it is where their money goes,
     * and it is visible on chain regardless.
     */
    public function index(): JsonResponse
    {
        return response()->json([
            'enabled' => $this->router->enabled(),
            'fee' => [
                'address' => $this->router->feeAddress(),
                'bps' => $this->router->feeAddress() === null ? 0 : $this->router->feeBps(),
            ],
            'chains' => $this->router->chains(),
        ]);
    }

    public function tokens(Request $request): JsonResponse
    {
        $data = $request->validate([
            'chain' => ['required', 'integer', 'min:1'],
            'q' => ['nullable', 'string', 'max:64'],
        ]);

        return response()->json([
            'tokens' => $this->router->tokens((int) $data['chain'], (string) ($data['q'] ?? '')),
        ]);
    }

    /**
     * Price one route.
     *
     * Everything money-shaped is a string: an amount here is a raw integer in
     * the token's own units, and a JSON number would round it. The addresses
     * are deliberately loose — a destination may be Solana or Bitcoin, whose
     * addresses are not 0x-anything — while `user` is strict, because the
     * origin leg is the one this wallet signs and it is always EVM.
     */
    public function quote(Request $request): JsonResponse
    {
        $data = $request->validate([
            'originChainId' => ['required', 'integer', 'min:1'],
            'destinationChainId' => ['required', 'integer', 'min:1'],
            'originCurrency' => ['required', 'string', 'max:128'],
            'destinationCurrency' => ['required', 'string', 'max:128'],
            /*
             * Who is spending. Constrained where `recipient` is not, because
             * this is the address whose balance the route is priced against
             * and quoting somebody else's is not a mistake worth allowing —
             * and the two shapes here are exactly the two the wallet can put a
             * signature on: an EVM address, or a base58 Solana one. Adding a
             * third means teaching the executor to sign for it first.
             */
            'user' => [
                'required',
                'string',
                'regex:/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/',
            ],
            'recipient' => ['required', 'string', 'max:128'],
            'amount' => ['required', 'string', 'regex:/^[1-9][0-9]{0,39}$/'],
            'slippageBps' => ['nullable', 'integer', 'min:0', 'max:1000'],
        ]);

        try {
            return response()->json(['quote' => $this->router->quote($data)]);
        } catch (Throwable $error) {
            // The router's own sentence, when it gave one: "no route",
            // "amount too small" and "chain paused" are all answers a user can
            // act on, and none of them survives being flattened into 502.
            return response()->json(['error' => $error->getMessage()], 422);
        }
    }

    public function status(Request $request): JsonResponse
    {
        $data = $request->validate([
            'id' => ['required', 'string', 'max:128'],
        ]);

        try {
            return response()->json($this->router->status((string) $data['id']));
        } catch (Throwable $error) {
            return response()->json(['error' => $error->getMessage()], 422);
        }
    }
}
