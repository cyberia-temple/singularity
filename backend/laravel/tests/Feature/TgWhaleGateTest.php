<?php

use App\Actions\Wallet\ReadCyberSolBalance;
use Illuminate\Support\Facades\Http;

use function Pest\Laravel\get;

it('offers the Phantom in-app browser, where a phone actually has a wallet', function () {
    $page = get('/tg/cyber-sol?t=nope');

    $page->assertOk();
    // The whole point: a link tapped in Telegram lands in a web view with no
    // provider, so the page must be able to hand the user over to Phantom.
    // Both spellings: a web view hands the scheme to the OS, a real browser
    // resolves the universal link.
    $page->assertSee("'phantom://' + BROWSE", false);
    $page->assertSee("'https://phantom.app/ul/' + BROWSE", false);
    $page->assertSee('Открыть в Phantom', false);
});

it('refuses an unknown token before anything else is offered', function () {
    get('/tg/cyber-sol?t=nope')->assertOk()->assertSee('const VALID = false', false);
});

it('reads the balance past a dead key instead of failing the holder', function () {
    // The gate broke here, not at "connect": a Helius key answering 401 threw
    // "Solana RPC HTTP 401" at the user *after* they had signed.
    config()->set('solana.rpc.enabled', true);
    config()->set('solana.rpc.upstreams.mainnet', [
        'https://expired.example/?api-key=dead',
        'https://api.mainnet-beta.solana.com',
    ]);

    Http::preventStrayRequests();
    Http::fake([
        // No trailing slash in the patterns: these upstreams are bare hosts.
        'expired.example*' => Http::response('Unauthorized', 401),
        'api.mainnet-beta.solana.com*' => Http::response([
            'jsonrpc' => '2.0',
            'id' => 1,
            'result' => ['value' => [
                ['account' => ['data' => ['parsed' => ['info' => [
                    'tokenAmount' => ['amount' => '12000000000000'],
                ]]]]],
            ]],
        ]),
    ]);

    $balance = app(ReadCyberSolBalance::class)->handle('So11111111111111111111111111111111111111112');

    expect($balance['raw'])->toBe('12000000000000')
        ->and(app(ReadCyberSolBalance::class)->meetsThreshold($balance['raw'], 10000000))->toBeTrue();
});
