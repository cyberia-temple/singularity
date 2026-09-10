<?php

use App\Http\Controllers\Api\Ai\AiKeyController;
use App\Http\Controllers\Api\Ai\ChatCompletionsController;
use App\Http\Controllers\Api\Ai\ModelsController;
use App\Http\Controllers\Api\AnalyticsIngestController;
use App\Http\Controllers\Api\BridgeController;
use App\Http\Controllers\Api\BridgeEventController;
use App\Http\Controllers\Api\CrmTaskIngestController;
use App\Http\Controllers\Api\LaunchpadController;
use App\Http\Controllers\Api\NFTController;
use App\Http\Controllers\Api\OpsHeartbeatController;
use App\Http\Controllers\Api\SlotsController;
use App\Http\Controllers\Api\SolanaRpcController;
use App\Http\Controllers\Api\SolanaWalletAuthController;
use App\Http\Controllers\Api\TgWhaleController;
use App\Http\Controllers\Api\TrackerController;
use App\Http\Controllers\Api\WalletAuthController;
use App\Http\Controllers\Api\WalletCrosschainController;
use App\Http\Controllers\Api\WalletGasController;
use App\Http\Controllers\Api\WalletIpfsController;
use App\Http\Controllers\Api\WalletMoneroSwapController;
use App\Http\Controllers\Api\WalletPushController;
use App\Http\Controllers\Api\WalletStocksController;
use App\Http\Middleware\AuthenticateAiApiKey;
use App\Http\Middleware\X402Paywall;
use App\Services\WalletPriceService;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Route;

// EVM wallet auth (MetaMask)
Route::prefix('wallet')->group(function () {
    Route::post('nonce', [WalletAuthController::class, 'generateNonce']);
    Route::post('verify', [WalletAuthController::class, 'verify']);

    // USD quotes for the unified wallet's portfolio total. Public and cached:
    // it says nothing about any account, only what a coin is worth.
    Route::get('prices', fn (WalletPriceService $prices) => response()->json($prices->quotes()))
        ->middleware('throttle:60,1');

    /*
     * The tokenised stocks on Robinhood Chain, with what the issuer says a
     * share is worth. Public, cached and account-free — a price is not a
     * disclosure — and read here rather than in the browser so that one call
     * serves every visitor instead of each of them spending the rate limit.
     */
    Route::get('stocks', WalletStocksController::class)->middleware('throttle:60,1');

    // Pinning for the wallet: bytes in, a CID out. Kubo listens on localhost
    // and can run any node command, so the browser never talks to it directly.
    Route::post('ipfs/file', [WalletIpfsController::class, 'file'])->middleware('throttle:20,1');
    Route::post('ipfs/page', [WalletIpfsController::class, 'page'])->middleware('throttle:20,1');

    // Sponsored fees on Cyberia: an address that owns something here but holds
    // no CYBER is handed enough CYBER to move it. Unsigned on purpose — a drip
    // can only ever arrive at the address that was named. See GasSponsorService.
    Route::get('gas', [WalletGasController::class, 'status'])->middleware('throttle:60,1');
    Route::post('gas/claim', [WalletGasController::class, 'claim'])->middleware('throttle:10,1');

    /*
     * Cross-chain swaps. Cyberia has no liquidity on other chains and does not
     * pretend to: a router quotes the whole route and delivers it, and this
     * host's only part is composing the request — Cyberia's fee is a field in
     * it, and a field a browser writes is a field a browser can delete. No key
     * lives behind these routes and nothing here signs.
     *
     * The quote is throttled harder than the catalogue: the lists are cached
     * and identical for every visitor, while a quote is a live call to the
     * router for one person's amount.
     */
    Route::get('crosschain', [WalletCrosschainController::class, 'index'])->middleware('throttle:60,1');
    Route::get('crosschain/tokens', [WalletCrosschainController::class, 'tokens'])->middleware('throttle:60,1');
    Route::post('crosschain/quote', [WalletCrosschainController::class, 'quote'])->middleware('throttle:30,1');
    Route::get('crosschain/status', [WalletCrosschainController::class, 'status'])->middleware('throttle:60,1');
    // Monero is quoted apart from the cross-chain router because no router
    // reaches it: two routes, ours and a partner's, compared on the screen.
    Route::get('monero/swap', [WalletMoneroSwapController::class, 'index'])->middleware('throttle:60,1');
    Route::get('monero/swap/quote', [WalletMoneroSwapController::class, 'quote'])->middleware('throttle:30,1');
});

/*
 * Product analytics for the wallet: acquisition, onboarding, funding,
 * activation, retention. Stateless like everything else under /api — no
 * session, no cookie, and the client omits credentials, so this endpoint never
 * learns which account the browser is signed into.
 *
 * The throttle is generous because the client batches and because being
 * dropped here must never be something a wallet notices: analytics is not a
 * dependency of sending, swapping or bridging. See AnalyticsIngestService.
 */
Route::prefix('analytics')->group(function () {
    Route::post('events', [AnalyticsIngestController::class, 'store'])->middleware('throttle:120,1');
    /*
     * Being notified without having an account. The site's bell hangs off a
     * signed-in user and lives in a header the wallet's own layout does not
     * render, so until this existed push could reach the handful of site
     * accounts and none of the installations. Keyed by the same installation
     * UUID as the events above — see WalletPushController for why not an
     * address.
     */
    Route::post('push', [WalletPushController::class, 'store'])->middleware('throttle:20,1');
    Route::delete('push', [WalletPushController::class, 'destroy'])->middleware('throttle:20,1');
    // The one call that carries an address, kept apart from the event stream
    // so no ordinary event can ever be the thing that leaked one.
    Route::post('funding', [AnalyticsIngestController::class, 'funding'])->middleware('throttle:20,1');
});

// Solana JSON-RPC relay. Solana's public cluster refuses any request carrying
// a browser Origin, and the endpoints that answer browsers want a key in the
// URL — so the browser asks this host and this host asks Solana. It holds no
// key and signs nothing: what arrives is already signed. See SolanaRpcProxy.
Route::post('solana/rpc/{cluster?}', SolanaRpcController::class)
    ->whereAlpha('cluster')
    ->middleware('throttle:240,1');

// Solana wallet auth (Phantom)
Route::prefix('solana-wallet')->group(function () {
    Route::post('nonce', [SolanaWalletAuthController::class, 'generateNonce']);
    Route::post('verify', [SolanaWalletAuthController::class, 'verify']);
});

// Telegram "whales chat" gate — prove Phantom ownership + read CYBER.sol balance.
Route::prefix('tg/cyber-sol')->group(function () {
    Route::post('nonce', [TgWhaleController::class, 'nonce'])->middleware('throttle:30,1');
    Route::post('verify', [TgWhaleController::class, 'verify'])->middleware('throttle:30,1');
});

// Bridge (public)
Route::get('bridge/{bridgeRequest}/status', [BridgeController::class, 'status']);
Route::post('bridge/events', [BridgeEventController::class, 'store'])->middleware('throttle:60,1');

// Slot machine ("одноручный бандит") — Solana-only, decoupled from bridge.
Route::prefix('slots')->group(function () {
    Route::get('pool', [SlotsController::class, 'pool']);
    Route::post('spin/prepare', [SlotsController::class, 'prepare'])->middleware('throttle:6,1');
    Route::post('spin/confirm', [SlotsController::class, 'confirm'])->middleware('throttle:30,1');
});

/*
 * The tracker's index. Reading is open to anyone; publishing is a mint — the
 * body of a registration is a chain and a token id, and every other field on
 * the release is read by this server from the chain and from the document that
 * token points at. See App\Services\Tracker\ReleaseRegistrar.
 *
 * The announce and scrape endpoints torrent clients speak to are not here:
 * they answer in bencode and live outside every middleware group, in
 * routes/tracker.php.
 */
Route::prefix('tracker')->group(function () {
    Route::get('releases', [TrackerController::class, 'index'])->middleware('throttle:120,1');
    Route::get('releases/{infoHash}', [TrackerController::class, 'show'])
        ->where('infoHash', '[0-9a-fA-F]{40}')
        ->middleware('throttle:120,1');
    Route::post('releases', [TrackerController::class, 'store'])->middleware('throttle:20,1');
});

// NFT metadata pin (image + ERC-721 JSON) → tokenURI
Route::post('nft/upload', [NFTController::class, 'upload'])->middleware('throttle:30,1');

// Launchpad off-chain metadata and sandboxed token sites.
Route::prefix('launchpad')->group(function () {
    Route::get('tokens', [LaunchpadController::class, 'index']);
    Route::post('tokens', [LaunchpadController::class, 'store'])->middleware('throttle:30,1');
});

/*
 * The Cyberia inference API: OpenAI-compatible endpoints in front of providers
 * whose keys live on this server, opened by holding the gate token rather than
 * by signing up. See config/ai.php and docs/ai-api.md.
 *
 * Two halves with different credentials. Key self-service is proved by a
 * wallet signature (no session, no account); the API itself is proved by the
 * key that flow hands out, checked in AuthenticateAiApiKey together with the
 * holding behind it and the quota on it.
 */
Route::prefix('ai')->group(function () {
    Route::post('keys/nonce', [AiKeyController::class, 'nonce'])->middleware('throttle:30,1');
    Route::post('keys', [AiKeyController::class, 'store'])->middleware('throttle:10,1');
    Route::post('keys/list', [AiKeyController::class, 'index'])->middleware('throttle:30,1');
    Route::post('keys/revoke', [AiKeyController::class, 'revoke'])->middleware('throttle:30,1');

    Route::prefix('v1')->group(function () {
        // Public: what this is, and what it serves. Both are things you need
        // before you hold anything, so neither sits behind the gate.
        Route::get('/', [ModelsController::class, 'root'])->middleware('throttle:60,1');
        Route::get('models', [ModelsController::class, 'index'])->middleware('throttle:60,1');

        Route::get('me', [AiKeyController::class, 'status'])->middleware(AuthenticateAiApiKey::class);

        /*
         * Two doors, listed in the order a request meets them: pay for this
         * call over x402, or present a key and hold what the gate asks. The
         * order matters and is why this route is not inside a middleware
         * group — group middleware runs first, and the key door would turn a
         * paying caller away before the paywall ever saw them. Each stands
         * aside for the other's callers.
         *
         * Per-key limits are enforced in the key middleware and per-payer ones
         * in the paywall; this coarse IP throttle is only there to keep a
         * flood off the database.
         */
        Route::post('chat/completions', [ChatCompletionsController::class, 'store'])
            ->middleware(['throttle:120,1', X402Paywall::class, AuthenticateAiApiKey::class]);
    });
});

// Cyberia RPC proxy (avoids mixed content on HTTPS sites)
Route::post('rpc/cyberia', function (Request $request) {
    $response = Http::post(config('services.ethereum.rpc_url', 'https://rpc.cyberia.church'), $request->all());

    return response($response->body(), $response->status())
        ->header('Content-Type', 'application/json');
});

// Host heartbeat. Laravel runs inside a container and cannot see the docker
// daemon, the tmux sessions or the disk that everything else on the box lives
// on, so the host pushes those facts here once a minute. Gated on a shared
// token — with none configured the route 404s, because an open heartbeat lets
// anyone declare a dead host healthy.
Route::post('ops/heartbeat', OpsHeartbeatController::class)->middleware('throttle:120,1');

// What LainOS did while nobody was watching. The daemon forges wishes, takes
// profit, fires watches and brings back digests on the host, and none of it
// reached the board that is supposed to say what this project is doing. Same
// gate as the heartbeat — a shared token, and no token means a 404 — but this
// one writes, so it accepts facts only: a title, a detail, whether it is
// already finished, and an id the sender minted so a retry cannot double-file.
Route::post('crm/tasks', CrmTaskIngestController::class)->middleware('throttle:120,1');
