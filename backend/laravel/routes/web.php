<?php

use App\Http\Controllers\AnalyticsController;
use App\Http\Controllers\Api\BridgeController;
use App\Http\Controllers\Api\LaunchpadController;
use App\Http\Controllers\Api\MoneroWalletController;
use App\Http\Controllers\Api\SiteEventController;
use App\Http\Controllers\Api\SolanaStakingController;
use App\Http\Controllers\Api\TgWhaleController;
use App\Http\Controllers\Api\WalletAttachController;
use App\Http\Controllers\Api\WalletChatController;
use App\Http\Controllers\Api\WalletLainController;
use App\Http\Controllers\Api\WalletSocialController;
use App\Http\Controllers\ApiController;
use App\Http\Controllers\AppLinksController;
use App\Http\Controllers\Auth\TwitterAuthController;
use App\Http\Controllers\Auth\Web3LoginController;
use App\Http\Controllers\BridgeAnalyticsController;
use App\Http\Controllers\CategoryController;
use App\Http\Controllers\ChangelogController;
use App\Http\Controllers\ConsoleAiKeysController;
use App\Http\Controllers\ConsoleChatController;
use App\Http\Controllers\ConsoleController;
use App\Http\Controllers\ConsoleMockupController;
use App\Http\Controllers\ConsoleNumbersController;
use App\Http\Controllers\ConsolePushController;
use App\Http\Controllers\ConsoleStrategyController;
use App\Http\Controllers\CrmContactController;
use App\Http\Controllers\CrmController;
use App\Http\Controllers\CrmMessageController;
use App\Http\Controllers\CrmNoteController;
use App\Http\Controllers\CrmTaskCommentController;
use App\Http\Controllers\CrmTaskController;
use App\Http\Controllers\CyberController;
use App\Http\Controllers\DaoController;
use App\Http\Controllers\DownloadController;
use App\Http\Controllers\FediverseController;
use App\Http\Controllers\LainChatController;
use App\Http\Controllers\LeaderboardController;
use App\Http\Controllers\LinkController;
use App\Http\Controllers\LiquidityController;
use App\Http\Controllers\NoCarrierController;
use App\Http\Controllers\NotificationController;
use App\Http\Controllers\PostController;
use App\Http\Controllers\ProductAnalyticsController;
use App\Http\Controllers\ProfileController;
use App\Http\Controllers\ProposalCommentController;
use App\Http\Controllers\ProposalController;
use App\Http\Controllers\ProposalVoteController;
use App\Http\Controllers\PushSubscriptionController;
use App\Http\Controllers\ReactionController;
use App\Http\Controllers\ServiceMonitorController;
use App\Http\Controllers\StakingController;
use App\Http\Controllers\Teams\TeamInvitationController;
use App\Http\Controllers\TokenController;
use App\Http\Controllers\TrackerController;
use App\Http\Controllers\UserFollowController;
use App\Http\Controllers\UserProfileController;
use App\Http\Middleware\EnsureBridgeAdmin;
use App\Http\Middleware\EnsureCrmAdmin;
use App\Services\BridgeConfigService;
use App\Services\BridgeRelayerService;
use App\Services\DexAprService;
use App\Services\GasSponsorService;
use App\Services\LainChatService;
use App\Services\SolanaRpcProxy;
use App\Services\WalletPriceService;
use App\Support\ProfileHandle;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Inertia\Inertia;

Route::get('/{path?}', [LaunchpadController::class, 'showSubdomain'])
    ->domain('{subdomain}.'.config('launchpad.sites_domain'))
    ->where([
        'subdomain' => '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',
        'path' => '.*',
    ])
    ->name('launchpad.subdomain-site');

Route::get('/', fn () => response()->file(resource_path('views/landing/index.html')))->name('home');
Route::get('/thesis', fn () => response()->file(resource_path('views/landing/index1.html')))->name('thesis');
Route::get('/robinhood-chain', function (BridgeConfigService $bridgeConfig) {
    $routes = array_values(array_filter(
        $bridgeConfig->publicRoutes(),
        fn (array $route) => in_array('robinhood', [$route['source'], $route['destination']], true),
    ));
    $faq = [
        [
            'question' => 'Is the Cyberia Robinhood Chain DEX live?',
            'answer' => 'Yes. Ritual has live Robinhood Chain contracts and non-zero ETH/CYBER and ETH/ASH liquidity pools. Users can switch the existing swap and liquidity interfaces to chain ID 4663.',
        ],
        [
            'question' => 'How can I bridge to Robinhood Chain through Cyberia?',
            'answer' => 'Cyberia currently supports the live Robinhood Chain to Cyberia direction for ETH, SPY and CYBER. The Cyberia to Robinhood Chain direction is visible as Coming soon and is not presented as an executable action until relayer gas and inventory are enabled.',
        ],
        [
            'question' => 'Which tokens can I trade on Robinhood Chain?',
            'answer' => 'The curated Ritual interface currently exposes native ETH, bridged CYBER and bridged ASH on Robinhood Chain.',
        ],
        [
            'question' => 'Does Robinhood Chain staking have a fixed APY?',
            'answer' => 'No. The funded farms pay variable ASH rewards. Returns depend on reward funding, allocation, LP balances and market prices, and can change over time.',
        ],
    ];
    $title = 'Robinhood Chain Bridge, DEX and Staking | Cyberia';
    $description = 'Use Cyberia with Robinhood Chain: connect a wallet, switch to chain ID 4663, bridge supported assets, trade on Ritual DEX, add liquidity and use variable-reward farms.';

    return Inertia::render('Growth/RobinhoodChain', [
        'bridgeRoutes' => $routes,
        'faq' => $faq,
        'seo' => [
            'title' => $title,
            'description' => $description,
            'canonical' => 'https://cyberia.church/robinhood-chain',
            'image' => 'https://cyberia.church/cyberia_logo.png',
            'structuredData' => [
                '@context' => 'https://schema.org',
                '@type' => 'FAQPage',
                'mainEntity' => array_map(fn (array $item) => [
                    '@type' => 'Question',
                    'name' => $item['question'],
                    'acceptedAnswer' => [
                        '@type' => 'Answer',
                        'text' => $item['answer'],
                    ],
                ], $faq),
            ],
        ],
    ]);
})->name('growth.robinhood');
Route::get('/partners/{partner}', fn (string $partner) => Inertia::render('Growth/Partner', [
    'partnerSlug' => $partner,
]))->name('partners.show');
Route::inertia('/pioneer-season', 'Growth/PioneerSeason')->name('growth.pioneer');
// Cached per-pool LP APR (written by the scheduled dex:apr command). Public:
// the landing hero and any external site can quote real yield numbers.
Route::get('/api/dex/apr', fn () => response()->json(
    DexAprService::cached()
        ?? ['updated_at' => null, 'window_hours' => 24, 'pools' => [], 'farms' => []],
))->name('dex.apr');
// Funnel-event ingest (page views, wallet connects, swaps, LP adds) feeding
// the CRM analytics page. Web middleware so the session resolves the user;
// CSRF-exempt in bootstrap/app.php so the static landing can report too.
Route::post('/api/events', [SiteEventController::class, 'store'])
    ->middleware('throttle:60,1')
    ->name('site.events');
// Session probe for the static landing: the React nav swaps the Connect CTA
// for an avatar + username chip when a session cookie is present. Lives in
// web.php (not routes/api.php) so the session guard resolves the user.
Route::get('/api/session-user', function (Request $request) {
    $user = $request->user();

    return $user
        ? response()->json([
            'authenticated' => true,
            'name' => $user->name,
            'avatar' => $user->avatar ?? null,
        ])
        : response()->json(['authenticated' => false]);
})->name('session.user');
Route::get('/tonconnect-manifest.json', fn () => response()->json([
    'url' => 'https://cyberia.church/bridge',
    'name' => 'Cyberia Bridge',
    'iconUrl' => 'https://cyberia.church/apple-touch-icon.png',
    'termsOfUseUrl' => 'https://cyberia.church',
    'privacyPolicyUrl' => 'https://cyberia.church',
], 200, [], JSON_UNESCAPED_SLASHES))->name('tonconnect.manifest');
// Lets https://cyberia.church links open in the installed native shells
// (frontend/mobile, frontend/desktop). 404 until the app identity is set.
Route::get('/.well-known/assetlinks.json', [AppLinksController::class, 'assetlinks'])
    ->name('applinks.android');
Route::get('/.well-known/apple-app-site-association', [AppLinksController::class, 'appleAppSiteAssociation'])
    ->name('applinks.ios');
Route::get('/bridge', [ApiController::class, 'index'])->name('bridge');
Route::get('/analytics', [AnalyticsController::class, 'index'])->name('analytics');
// Public token directory + per-token pages the analytics list links into.
// {token} accepts a 0x address or a symbol (e.g. /token/CYBER.sol).
Route::get('/tokens', [TokenController::class, 'index'])->name('tokens.index');
Route::get('/token/{token}', [TokenController::class, 'show'])->name('tokens.show');
// What the coin is for, with the contract behind every claim — and the list of
// things it deliberately does not do yet. Cited by the token pages and the nav.
Route::get('/cyber', CyberController::class)->name('cyber');
Route::get('/changelog', ChangelogController::class)->name('changelog');
// Where the native apps come from. /download/<platform> is the short link worth
// pasting into a message; it redirects to the current file for that platform.
Route::get('/download', [DownloadController::class, 'index'])->name('download');
Route::get('/download/{platform}', [DownloadController::class, 'platform'])
    ->where('platform', 'windows|macos|linux|android|extension')
    ->name('download.platform');
Route::permanentRedirect('/downloads', '/download');
Route::get('/api/downloads', [DownloadController::class, 'json'])
    ->middleware('throttle:60,1')->name('download.json');
Route::get('/lain', [LainChatController::class, 'index'])->name('lain.index');
Route::middleware('auth')->prefix('api/lain')->name('lain.')->group(function () {
    Route::get('sessions/{session}', [LainChatController::class, 'session'])
        ->middleware('throttle:60,1')->name('sessions.show');
    Route::post('chat', [LainChatController::class, 'chat'])
        ->middleware('throttle:10,1')->name('chat');
});
Route::inertia('/market', 'Market')->name('market');
Route::inertia('/pixels', 'PixelBattle')->name('pixels');
Route::get('/liquidity', [LiquidityController::class, 'index'])->name('liquidity');
// On-site swap UI over the Ritual router (same pool seed as /liquidity).
Route::get('/swap', [LiquidityController::class, 'swap'])->name('swap');
// Fixed-rate redeemer for bridged CYBER.sol -> native CYBER. It's a conversion,
// not a swap, hence /convert; the old /cyber-sol-swap path 301s here.
Route::inertia('/convert', 'CyberSolSwap')->name('convert');
Route::permanentRedirect('/cyber-sol-swap', '/convert');
Route::inertia('/lending', 'Lending')->name('lending');
Route::inertia('/farm', 'Farm')->name('farm');
Route::get('/staking', StakingController::class)->name('staking');
Route::inertia('/lending/liquidate', 'Liquidate')->name('lending.liquidate');
Route::inertia('/launchpad', 'Launchpad')->name('launchpad');
Route::get('/launchpad/sites/{address}', [LaunchpadController::class, 'showSite'])
    ->where('address', '0x[a-fA-F0-9]{40}')
    ->name('launchpad.site');
Route::inertia('/slots', 'Slots')->name('slots');
Route::inertia('/predictions', 'Predictions')->name('predictions');
// The tracker. A release is a torrent that exists on the index because a token
// on Cyberia names it, so these pages are a view over the chain and every row
// carries the token it was minted as. Clients talk to /announce (routes/tracker.php).
Route::get('/tracker', [TrackerController::class, 'index'])->name('tracker.index');
Route::get('/tracker/{infoHash}', [TrackerController::class, 'show'])
    ->where('infoHash', '[0-9a-fA-F]{40}')
    ->name('tracker.show');
Route::get('dao', [DaoController::class, 'index'])->name('dao.index');
Route::get('dao/{dao}', [DaoController::class, 'show'])->name('dao.show');
Route::get('proposals/{proposal}', [ProposalController::class, 'show'])->name('proposals.show');
Route::get('u/{user}', [UserProfileController::class, 'legacy'])
    ->whereNumber('user')
    ->name('users.legacy');
Route::get('feed', [PostController::class, 'index'])->name('feed');
// Public XP ranking — social proof for the progression system and the
// entry point into member profiles.
Route::get('leaderboard', LeaderboardController::class)->name('leaderboard');

Route::post('login/web3', Web3LoginController::class)->name('web3.login');

// X (Twitter) OAuth: guests log in / register, signed-in users link the
// account to their profile.
Route::get('/auth/twitter', [TwitterAuthController::class, 'redirect'])->name('twitter.redirect');
Route::get('/auth/twitter/callback', [TwitterAuthController::class, 'callback'])->name('twitter.callback');

Route::get('/wallet-login', fn () => inertia('auth/WalletLogin'))->name('wallet.login')->middleware('guest');

// Telegram whales-chat verification page (opened from the bot's one-time link).
Route::get('/tg/cyber-sol', [TgWhaleController::class, 'page'])->name('tg.cyber-sol');

/**
 * The unified multichain wallet, and the home screen of the desktop and mobile
 * apps.
 *
 * Deliberately public: the wallet is non-custodial and entirely browser-side,
 * so demanding a Cyberia account before a phrase can even be generated would
 * gate a local key behind a server that never sees it. Signing in only adds the
 * XMR payout binding, which is the one part that belongs to a profile.
 *
 * The server hands over a public RPC endpoint, USD quotes and that payout
 * address. Balances, history, fees and signing are read and done by the
 * browser, never by us.
 */
Route::get('wallet', fn (Request $request, WalletPriceService $prices, LainChatService $lain, GasSponsorService $gas, SolanaRpcProxy $solana, BridgeConfigService $bridgeConfig) => Inertia::render('Wallet', [
    // Solana's public cluster answers this server and refuses the browser, so
    // the endpoint handed over is our own relay (/api/solana/rpc). It reads
    // the chain on the page's behalf and nothing else — the keys, the signing
    // and the phrase never leave the device either way.
    'solanaRpcUrl' => $solana->browserEndpoint(
        SolanaRpcProxy::DEFAULT_CLUSTER,
        (string) config('services.staking.public_rpc_url'),
    ),
    'moneroPayoutAddress' => $request->user()?->monero_wallet_address,
    'quotes' => $prices->quotes(),
    // What the holders' room needs to check itself: which contract counts and
    // how much of it. The wallet reads the balance from Cyberia on its own —
    // the server only learns an address once someone chooses to sign in there.
    'lain' => [
        'enabled' => $lain->enabled(),
        'tokenAddress' => (string) config('services.lain.token_address'),
        'minimumShareBps' => (int) config('services.lain.minimum_share_bps', 1000),
    ],
    // Public chain coordinates only. The browser signs every Arena action;
    // Laravel never receives a move secret, seed phrase or private key.
    'arena' => [
        'enabled' => preg_match('/^0x[a-fA-F0-9]{40}$/', (string) config('arena.contract_address')) === 1,
        'contractAddress' => (string) config('arena.contract_address'),
        'rpcUrl' => (string) config('arena.rpc_url'),
        'explorerUrl' => rtrim((string) config('arena.explorer_url'), '/'),
    ],
    // Pinning is the one thing in the wallet this server actually performs, so
    // the limits it will enforce are stated up front rather than discovered by
    // uploading something too large and reading the rejection.
    'ipfs' => [
        'enabled' => (bool) config('wallet.ipfs.enabled'),
        'maxBytes' => (int) config('wallet.ipfs.max_bytes'),
        'gateway' => (string) config('ipfs.gateway'),
    ],
    // Whether fees can be sponsored at all, which is a question of
    // configuration and costs nothing to answer. How much is in the tank and
    // whether *this* address qualifies are live questions, and the browser asks
    // them at /api/wallet/gas when it has a reason to — rendering this page
    // must not wait on an RPC.
    'sponsor' => [
        'enabled' => $gas->enabled(),
        'chain' => 'cyberia',
    ],
    /*
     * The bridge, as the wallet needs to see it: which corridors exist, which
     * are actually open, what each carries, and where a deposit goes.
     *
     * The same tables /bridge is rendered from, so a corridor opened in config
     * opens in both places at once. Nothing secret is in here — a deposit
     * address has to be public to be paid, and the relayer's is the address
     * every bridge transfer on this chain already lands on.
     */
    'bridge' => [
        'chains' => $bridgeConfig->publicChains(),
        'routes' => $bridgeConfig->publicRoutes(),
        'tokens' => $bridgeConfig->publicTokens(),
        'relayer' => app(BridgeRelayerService::class)->evmAddress(),
        'feeBps' => (int) config('bridge.fee.rate_bps', 0),
        'feeFlatUsd' => (float) config('bridge.fee.flat_usd', 0.1),
    ],
]))->name('wallet');

Route::get('arena', fn () => redirect('/wallet?screen=arena'))->name('arena');

/**
 * The $LAIN holders' room inside that wallet (WalletLainController).
 *
 * Public like the wallet itself, and gated by what the address holds rather
 * than by an account: sign a challenge with the wallet's Cyberia key, and the
 * chat opens for as long as the balance holds up.
 */
Route::prefix('api/wallet/lain')->name('wallet.lain.')->group(function () {
    Route::post('nonce', [WalletLainController::class, 'nonce'])
        ->middleware('throttle:30,1')->name('nonce');
    Route::post('verify', [WalletLainController::class, 'verify'])
        ->middleware('throttle:30,1')->name('verify');
    Route::post('chat', [WalletLainController::class, 'chat'])
        ->middleware('throttle:10,1')->name('chat');
});

/**
 * Wallet-to-wallet encrypted chat (WalletChatController).
 *
 * Public like the wallet, and addressed by EVM address rather than by account.
 * The server relays ciphertext it has no key for: it keeps a directory of
 * signed public keys so wallets can find each other, and a queue of sealed
 * envelopes it deletes on a retention window. Reading a mailbox means signing
 * a challenge with the address's own key, exactly as the holders' room does.
 */
Route::prefix('api/wallet/chat')->name('wallet.chat.')->group(function () {
    Route::post('nonce', [WalletChatController::class, 'nonce'])
        ->middleware('throttle:30,1')->name('nonce');
    Route::post('verify', [WalletChatController::class, 'verify'])
        ->middleware('throttle:30,1')->name('verify');
    Route::post('keys', [WalletChatController::class, 'publishKey'])
        ->middleware('throttle:20,1')->name('keys.publish');
    Route::get('keys/{address}', [WalletChatController::class, 'key'])
        ->middleware('throttle:120,1')->name('keys.show');
    Route::get('messages', [WalletChatController::class, 'messages'])
        ->middleware('throttle:120,1')->name('messages');
    Route::post('messages', [WalletChatController::class, 'send'])
        ->middleware('throttle:60,1')->name('send');
});

/**
 * What the wallet reads about the rest of Cyberia (WalletSocialController).
 *
 * Read-only and public, like the wallet itself. The wallet has no session, so
 * there is nobody here to post, comment or vote as; these answer with the same
 * fields the public feed, DAO and profile pages already render, and the wallet
 * links out to those pages for anything that needs an account.
 */
Route::prefix('api/wallet')->name('wallet.social.')->group(function () {
    Route::get('feed', [WalletSocialController::class, 'feed'])
        ->middleware('throttle:60,1')->name('feed');
    Route::get('dao', [WalletSocialController::class, 'dao'])
        ->middleware('throttle:60,1')->name('dao');
    Route::get('dao/proposals/{proposal}', [WalletSocialController::class, 'proposal'])
        ->middleware('throttle:60,1')->name('proposal');
    Route::get('profile/{address}', [WalletSocialController::class, 'profile'])
        ->middleware('throttle:60,1')->name('profile');
});

Route::middleware(['auth', 'verified'])->group(function () {
    Route::inertia('dashboard', 'Dashboard')->name('dashboard');
});

Route::middleware(['auth'])->group(function () {
    Route::prefix('api/staking/solana')->name('staking.solana.')->group(function () {
        Route::get('state', [SolanaStakingController::class, 'state'])->name('state');
        Route::post('deposits/prepare', [SolanaStakingController::class, 'prepareDeposit'])
            ->middleware('throttle:12,1')->name('deposits.prepare');
        Route::post('deposits/confirm', [SolanaStakingController::class, 'confirmDeposit'])
            ->middleware('throttle:30,1')->name('deposits.confirm');
        Route::post('withdrawals', [SolanaStakingController::class, 'withdraw'])
            ->middleware('throttle:6,1')->name('withdrawals.store');
        Route::post('claims', [SolanaStakingController::class, 'claim'])
            ->middleware('throttle:6,1')->name('claims.store');
    });

    // Own profile: account info + bridge deposit addresses for every chain.
    Route::get('profile', [ProfileController::class, 'show'])->name('profile.show');
    Route::post('profile/avatar', [ProfileController::class, 'updateAvatar'])
        ->middleware('throttle:10,1')->name('profile.avatar');
    // On-chain identity: nickname (relayer-submitted) and achievement checks.
    // Throttled — each hit can cost a relayer transaction on Cyberia.
    Route::patch('profile/nickname', [ProfileController::class, 'updateNickname'])
        ->middleware('throttle:6,1')->name('profile.nickname');
    // Spending experience. A POST because it is the one place on this profile
    // where a number goes down and something permanent appears.
    Route::post('profile/enchant', [ProfileController::class, 'enchant'])->name('profile.enchant');

    /*
     * NO CARRIER, behind an unlock. Served through the app rather than from
     * public/, so the gate covers the whole export and not just its entry —
     * an asset path anybody could guess would make the price a formality.
     * The shell asks for its siblings by relative name and Laravel normalises
     * the trailing slash away, so the served page carries a <base>.
     */
    Route::get('game/nocarrier', [NoCarrierController::class, 'show'])->name('nocarrier');
    Route::get('game/nocarrier/{file}', [NoCarrierController::class, 'asset'])
        ->where('file', '[A-Za-z0-9._-]+')
        ->name('nocarrier.asset');
    Route::post('profile/achievements/check', [ProfileController::class, 'checkAchievements'])
        ->middleware('throttle:6,1')->name('profile.achievements.check');
    Route::post('posts', [PostController::class, 'store'])
        ->middleware('throttle:10,1')->name('posts.store');
    Route::post('users/{user}/follow', [UserFollowController::class, 'store'])
        ->name('users.follow.store');
    Route::delete('users/{user}/follow', [UserFollowController::class, 'destroy'])
        ->name('users.follow.destroy');

    Route::get('invitations/{invitation}/accept', [TeamInvitationController::class, 'accept'])->name('invitations.accept');
    Route::resource('links', LinkController::class)->names([
        'index' => 'links',
        'store' => 'links.store',
        'update' => 'links.update',
        'destroy' => 'links.destroy',
    ]);
    Route::resource('categories', CategoryController::class)->except(['show', 'create', 'edit']);

    // Fediverse: resolve an ActivityPub handle/URL to its actor profile.
    Route::get('fediverse', [FediverseController::class, 'index'])->name('fediverse');
    Route::resource('dao', DaoController::class)->only(['store', 'update', 'destroy']);

    // Proposals (nested under dao)
    Route::post('dao/{dao}/proposals', [ProposalController::class, 'store'])->name('dao.proposals.store');

    // Proposal detail
    Route::put('proposals/{proposal}', [ProposalController::class, 'update'])->name('proposals.update');
    // Ends the vote now rather than at the deadline; wider than update, see
    // ProposalPolicy::close.
    Route::post('proposals/{proposal}/close', [ProposalController::class, 'close'])->name('proposals.close');
    Route::delete('proposals/{proposal}', [ProposalController::class, 'destroy'])->name('proposals.destroy');

    // Comments on proposals
    Route::post('proposals/{proposal}/comments', [ProposalCommentController::class, 'store'])->name('proposals.comments.store');
    Route::delete('comments/{comment}', [ProposalCommentController::class, 'destroy'])->name('comments.destroy');

    // Votes on proposals
    Route::post('proposals/{proposal}/votes', [ProposalVoteController::class, 'store'])->name('proposals.votes.store');

    // Emoji reactions on proposals/comments (toggle)
    Route::post('reactions', [ReactionController::class, 'toggle'])->name('reactions.toggle');

    // In-app notifications (bell dropdown + 30s poll)
    Route::get('notifications', [NotificationController::class, 'index'])->name('notifications.index');
    Route::post('notifications/read-all', [NotificationController::class, 'markAllRead'])->name('notifications.readAll');
    Route::post('notifications/{notification}/read', [NotificationController::class, 'markRead'])->name('notifications.read');

    // Web Push subscriptions (service worker)
    Route::post('push-subscriptions', [PushSubscriptionController::class, 'store'])->name('push-subscriptions.store');
    Route::delete('push-subscriptions', [PushSubscriptionController::class, 'destroy'])->name('push-subscriptions.destroy');

    /*
     * The console ("Пульт") — operational lenses on one stream, behind the operator
     * wallet allowlist in config/crm.php; everyone else gets a 404.
     *
     * `/crm` is the queue rather than a list of contacts, because the question
     * an operator arrives with is "what requires me now" and never "what do I
     * want to look at". The original pages are lenses on the same material;
     * API keys adds a read-only inventory. Static routes are declared before the
     * {contact} wildcard so they take precedence.
     */
    Route::prefix('crm')->name('crm.')->middleware(EnsureCrmAdmin::class)->group(function () {
        Route::get('/', [ConsoleController::class, 'index'])->name('index');
        // The console's heartbeat. Every lens is open on more than one desk,
        // so each of them asks this one cheap question every few seconds and
        // re-reads itself only when its own version has moved.
        Route::get('pulse', [ConsoleController::class, 'pulse'])->name('pulse');
        Route::post('snooze', [ConsoleController::class, 'snooze'])->name('snooze');
        Route::delete('snooze', [ConsoleController::class, 'wake'])->name('snooze.wake');

        Route::post('sync', [CrmController::class, 'sync'])->name('sync');
        Route::get('export', [CrmController::class, 'export'])->name('export');

        Route::get('people', [CrmContactController::class, 'index'])->name('people');
        Route::post('people', [CrmContactController::class, 'store'])->name('store');

        // One subject switch instead of two analytics pages: installations of
        // the wallet, or browsers reading the site.
        Route::get('numbers', [ConsoleNumbersController::class, 'index'])->name('numbers');
        Route::get('installs/{user}', [ProductAnalyticsController::class, 'show'])->name('installs.show');
        // Marking an installation as ours, or taking the mark back. A POST
        // because it changes what every number on the console means.
        Route::post('installs/{user}/internal', [ProductAnalyticsController::class, 'internal'])
            ->name('installs.internal');

        // Is everything running, and is anyone using it. Renders the last
        // sweep; the probing itself is `services:check` on the scheduler.
        Route::get('machines', [ServiceMonitorController::class, 'index'])->name('machines');

        // OpenAI-compatible grants bound to user-installed LainOS instances.
        // A full secret leaves the issue response once; the inventory stores
        // and renders only its hash and visible prefix.
        Route::get('api-keys', [ConsoleAiKeysController::class, 'index'])->name('ai-keys');
        Route::post('api-keys', [ConsoleAiKeysController::class, 'store'])->name('ai-keys.store');

        // Saying something to somebody, as opposed to what the schedule says
        // on its own. Carries the key health check with it, because "why did
        // nothing arrive" was the first question push ever raised and the
        // answer lived in a tinker session.
        Route::get('push', [ConsolePushController::class, 'index'])->name('push');
        Route::post('push', [ConsolePushController::class, 'store'])->name('push.send');

        // The editable content plan is framed like the frozen mockup, but its
        // working copy lives on the private disk and changes on an operator action.
        Route::get('strategy', [ConsoleStrategyController::class, 'index'])->name('strategy');
        Route::get('strategy/document', [ConsoleStrategyController::class, 'document'])->name('strategy.document');
        Route::put('strategy', [ConsoleStrategyController::class, 'update'])->name('strategy.update');
        Route::delete('strategy', [ConsoleStrategyController::class, 'reset'])->name('strategy.reset');

        // The design this console was built from, kept where the console is.
        // A canvas link rots and an exported picture loses its text; the
        // artboards themselves outlive both.
        Route::get('mockup', [ConsoleMockupController::class, 'index'])->name('mockup');
        Route::get('mockup/{screen}', [ConsoleMockupController::class, 'screen'])
            ->where('screen', '[a-z]+')
            ->name('mockup.screen');

        /*
         * The room. Static addresses first: `chat/files` is the same stream
         * read as a pile of files, and `chat/{message}` must not swallow it.
         */
        Route::get('chat', [ConsoleChatController::class, 'index'])->name('chat.index');
        Route::get('chat/since', [ConsoleChatController::class, 'since'])->name('chat.since');
        Route::get('chat/files', [ConsoleChatController::class, 'files'])->name('chat.files');
        // A file has no address of its own: the private disk is not served,
        // and this is the only way back out of it.
        Route::get('chat/files/{file}', [ConsoleChatController::class, 'download'])->name('chat.download');
        Route::post('chat', [ConsoleChatController::class, 'store'])->name('chat.store');
        // Which model LainOS answers with — the console is one of the
        // daemon's switch surfaces, and the only one open while its answers
        // are being read. Declared before the {message} routes.
        Route::post('chat/lainos/provider', [ConsoleChatController::class, 'provider'])->name('chat.provider');
        Route::post('chat/{message}/answer', [ConsoleChatController::class, 'answer'])->name('chat.answer');
        Route::post('chat/{message}/task', [ConsoleChatController::class, 'task'])->name('chat.task');
        Route::delete('chat/{message}', [ConsoleChatController::class, 'destroy'])->name('chat.destroy');

        Route::get('tasks', [CrmTaskController::class, 'index'])->name('tasks.index');
        Route::post('tasks', [CrmTaskController::class, 'store'])->name('tasks.store');
        Route::put('tasks/{task}', [CrmTaskController::class, 'update'])->name('tasks.update');
        Route::post('tasks/{task}/comments', [CrmTaskCommentController::class, 'store'])->name('tasks.comments.store');
        Route::post('tasks/{task}/claim', [CrmTaskController::class, 'claim'])->name('tasks.claim');
        Route::delete('tasks/{task}', [CrmTaskController::class, 'destroy'])->name('tasks.destroy');

        /*
         * The addresses the old five pages had. They are in messages, in
         * bookmarks and in the Telegram ops channel, so they keep working and
         * land on the lens that answers the same question.
         */
        Route::redirect('analytics', '/crm/numbers?subject=sessions')->name('analytics');
        Route::redirect('product', '/crm/numbers')->name('product');
        Route::redirect('services', '/crm/machines')->name('services');
        Route::get('product/users/{user}', fn (string $user) => redirect()->route('crm.installs.show', $user))
            ->name('product.user');

        Route::get('{contact}', [CrmContactController::class, 'show'])->name('show');
        Route::put('{contact}', [CrmContactController::class, 'update'])->name('update');
        Route::delete('{contact}', [CrmContactController::class, 'destroy'])->name('destroy');
        Route::post('{contact}/contact-links', [CrmContactController::class, 'storeContactLink'])->name('contact-links.store');
        Route::delete('{contact}/contact-links/{contactLink}', [CrmContactController::class, 'destroyContactLink'])->name('contact-links.destroy');
        Route::post('{contact}/notes', [CrmNoteController::class, 'store'])->name('notes.store');
        /*
         * Same-person links. A person arrives under an account, an EVM address
         * and a Solana address, and the console used to file three strangers;
         * these say which records are one human. Never a merge — the claim is
         * a row, and withdrawing it is a delete.
         */
        Route::post('{contact}/identity', [CrmContactController::class, 'link'])->name('identity.link');
        Route::post('identity-links/{link}/confirm', [CrmContactController::class, 'confirmLink'])->name('identity.confirm');
        Route::delete('identity-links/{link}', [CrmContactController::class, 'unlink'])->name('identity.unlink');
        Route::delete('notes/{note}', [CrmNoteController::class, 'destroy'])->name('notes.destroy');
        Route::post('{contact}/tasks', [CrmTaskController::class, 'store'])->name('tasks.storeForContact');
        /*
         * The correspondence. Written down by an operator now, imported from
         * Telegram and Discord later — the row is the same either way, which
         * is why this is a log and not a send button: nothing here holds an
         * operator's Telegram session, and a console that pretends to deliver
         * is worse than one that only records.
         */
        Route::post('{contact}/messages', [CrmMessageController::class, 'store'])->name('messages.store');
        Route::delete('messages/{message}', [CrmMessageController::class, 'destroy'])->name('messages.destroy');
    });

    // Wallet attach/detach
    Route::post('wallets/evm/attach', [WalletAttachController::class, 'attachEvm'])->name('wallets.evm.attach');
    Route::post('wallets/solana/attach', [WalletAttachController::class, 'attachSolana'])->name('wallets.solana.attach');
    // Monero is not an attachable signing wallet — it is a saved payout
    // address, so it lives in its own controller with no signature flow.
    Route::post('wallets/monero/attach', [MoneroWalletController::class, 'attach'])->name('wallets.monero.attach');
    Route::delete('wallets/evm/detach', [WalletAttachController::class, 'detachEvm'])->name('wallets.evm.detach');
    Route::delete('wallets/solana/detach', [WalletAttachController::class, 'detachSolana'])->name('wallets.solana.detach');
    Route::delete('wallets/monero/detach', [MoneroWalletController::class, 'detach'])->name('wallets.monero.detach');

});

// Bridge (public — no auth required, controller handles optional user)
// Admission: capacity is CLAIMED here, under a server-side lock, before the
// wallet is ever opened. A UI check is not a gate — see BridgeAdmissionService.
Route::post('bridge/reserve', [BridgeController::class, 'reserve'])
    ->middleware('throttle:60,1')
    ->name('bridge.reserve');
Route::post('bridge/submit', [BridgeController::class, 'submit'])->name('bridge.submit');
// Two-phase one-time-address routes (Yenten): prepare commits the recipient
// and returns a unique deposit address; claim verifies the deposit landed on it.
Route::post('bridge/prepare', [BridgeController::class, 'prepare'])->name('bridge.prepare');
Route::post('bridge/claim', [BridgeController::class, 'claim'])->name('bridge.claim');
// Live withdrawal capacity (relayer inventory on the destination chain).
Route::get('bridge/capacity', [BridgeController::class, 'capacity'])->name('bridge.capacity');

// Bridge analytics (admin only)
Route::middleware(['auth', EnsureBridgeAdmin::class])
    ->get('admin/bridge-analytics', [BridgeAnalyticsController::class, 'index'])
    ->name('admin.bridge-analytics');

require __DIR__.'/settings.php';

// Public profile handles live at the root, so this constrained route must stay
// after every application, settings and Fortify route.
Route::get('{user:onchain_nickname}', [UserProfileController::class, 'show'])
    ->where('user', ProfileHandle::routePattern())
    ->name('users.show');
