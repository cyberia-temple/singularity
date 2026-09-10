<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\RobinhoodStockService;
use Illuminate\Http\JsonResponse;

/**
 * The tokenised stocks, priced.
 *
 * One endpoint for three readers — the wallet's stock list, the swap screen's
 * ticker line and the landing page — because the alternative is three places
 * deciding separately what a price is. It carries no account, reads no session
 * and is the same answer for everybody, which is what lets it be cached once
 * for the whole host rather than per visitor.
 *
 * The registry travels with the quotes even though the browser already ships
 * it: the landing page is plain HTML with no bundle, and a second copy of the
 * list written into it by hand is exactly the copy that goes stale.
 */
class WalletStocksController extends Controller
{
    public function __invoke(RobinhoodStockService $stocks): JsonResponse
    {
        $quotes = $stocks->quotes();

        $rows = array_map(function (array $stock) use ($quotes): array {
            $quote = $quotes[$stock['symbol']] ?? null;

            return [
                ...$stock,
                /*
                 * `null` where the market could not be read, and the client
                 * renders it as "—". A stock is one of the few assets here that
                 * can be genuinely halted, so "no price" has to stay
                 * distinguishable from "zero" and from "stale".
                 */
                'price' => $quote['price'] ?? null,
                'share' => $quote['share'] ?? null,
                'high' => $quote['high'] ?? null,
                'low' => $quote['low'] ?? null,
                'volume' => $quote['volume'] ?? null,
                'multiplier' => $quote['multiplier'] ?? 1.0,
                'halted' => $quote['halted'] ?? false,
            ];
        }, $stocks->stocks());

        return response()->json([
            'chainId' => $stocks->chainId(),
            'stocks' => $rows,
            /*
             * When the issuer generated the newest quote in this batch — not
             * when this host answered. A page that says "as of" must say it
             * about the market and not about its own cache.
             */
            'quotedAt' => collect($quotes)->pluck('at')->filter()->max(),
        ]);
    }
}
