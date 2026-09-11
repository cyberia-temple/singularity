<?php

use App\Services\BridgeConfigService;

beforeEach(function () {
    config()->set('services.bridge.relayer_address', '0x0000000000000000000000000000000000abcdef');
    config()->set('bridge.chains.yenten.deposit_address', 'YXandTfYjFC7fuR8h9aRCo5ZwAz4tvbvDL');
});

test('exposes both Yenten routes after the light relayer is configured', function () {
    config()->set('bridge.chains.yenten.relayer_wif', 'configured-secret');
    config()->set('bridge.routes.yenten_to_evm.enabled', true);
    config()->set('bridge.routes.evm_to_yenten.enabled', true);
    config()->set('bridge.routes.yenten_to_evm.coming_soon', false);
    config()->set('bridge.routes.evm_to_yenten.coming_soon', false);

    $routes = app(BridgeConfigService::class)->availableRoutes();

    expect($routes)->toHaveKeys(['yenten_to_evm', 'evm_to_yenten']);
    expect(app(BridgeConfigService::class)->tokensForRoute('yenten_to_evm'))
        ->toHaveKey('YTN');
});

test('a disabled corridor is dropped while the Solana pair stays available', function () {
    config()->set('bridge.routes.bnb_to_evm.enabled', false);

    $routes = app(BridgeConfigService::class)->availableRoutes();

    expect($routes)->toHaveKeys(['sol_to_evm', 'evm_to_sol']);
    expect($routes)->not->toHaveKey('bnb_to_evm');
});

test('native SOL is offered on both Solana routes', function () {
    $service = app(BridgeConfigService::class);

    expect($service->tokensForRoute('sol_to_evm'))->toHaveKey('SOL');
    expect($service->tokensForRoute('evm_to_sol'))->toHaveKey('SOL');
});

test('USDG is offered only on its Solana and Robinhood corridors', function () {
    $service = app(BridgeConfigService::class);

    foreach (['sol_to_evm', 'evm_to_sol', 'robinhood_to_evm', 'evm_to_robinhood'] as $direction) {
        expect($service->tokensForRoute($direction))->toHaveKey('USDG');
    }
    foreach (['base_to_evm', 'evm_to_base', 'bnb_to_evm', 'evm_to_bnb'] as $direction) {
        expect($service->tokensForRoute($direction))->not->toHaveKey('USDG');
    }

    $token = collect($service->publicTokens())->firstWhere('symbol', 'USDG');
    expect($token['model'])->toBe('mint')
        ->and($token['chains']['cyberia']['address'])->toBe('0xDaDa615b767120cC0767067f075Ac799957508Da')
        ->and($token['chains']['solana']['mint'])->toBe('2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH')
        ->and($token['chains']['solana']['tokenProgram'])->toBe('token-2022')
        ->and($token['chains']['robinhood']['address'])->toBe('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168')
        ->and($token['chains']['robinhood']['decimals'])->toBe(6);
});

test('JupUSD uses the existing wrapper and canonical SPL mint only on Solana routes', function () {
    $service = app(BridgeConfigService::class);
    foreach (['sol_to_evm', 'evm_to_sol'] as $direction) {
        expect($service->tokensForRoute($direction))->toHaveKey('JupUSD');
    }
    foreach (['base_to_evm', 'evm_to_base', 'bnb_to_evm', 'evm_to_bnb', 'robinhood_to_evm', 'evm_to_robinhood'] as $direction) {
        expect($service->tokensForRoute($direction))->not->toHaveKey('JupUSD');
    }
    $token = collect($service->publicTokens())->firstWhere('symbol', 'JupUSD');
    expect($token['model'])->toBe('mint')
        ->and($token['chains']['cyberia']['address'])->toBe('0x03EB2fb8473C0370c8F6463efEE5f5Cf4EC011c7')
        ->and($token['chains']['cyberia']['decimals'])->toBe(6)
        ->and($token['chains']['solana']['mint'])->toBe('JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD')
        ->and($token['chains']['solana']['decimals'])->toBe(6)
        ->and($token['chains']['solana']['tokenProgram'])->toBe('token');
});

test('hides Yenten routes until the relayer WIF is configured', function () {
    config()->set('bridge.chains.yenten.relayer_wif', null);

    $routes = app(BridgeConfigService::class)->availableRoutes();

    expect($routes)->not->toHaveKeys(['yenten_to_evm', 'evm_to_yenten']);
});

test('external BTC LTC XMR routes require a configured wallet before submit', function () {
    $service = app(BridgeConfigService::class);

    expect($service->availableRoutes())->not->toHaveKeys([
        'btc_to_evm',
        'evm_to_btc',
        'ltc_to_evm',
        'evm_to_ltc',
        'xmr_to_evm',
        'evm_to_xmr',
    ]);

    config()->set('bridge.chains.bitcoin.deposit_address', '12ZEw5Hcv1hTb6YUQJ69y1V7uhcoDz92PH');
    config()->set('bridge.routes.btc_to_evm.enabled', true);
    config()->set('bridge.routes.evm_to_btc.enabled', true);
    config()->set('bridge.routes.btc_to_evm.coming_soon', false);
    config()->set('bridge.routes.evm_to_btc.coming_soon', false);

    $routes = $service->availableRoutes();

    expect($routes)->toHaveKeys(['btc_to_evm', 'evm_to_btc'])
        ->and($routes['btc_to_evm']['auto_process'])->toBeFalse()
        ->and($service->tokensForRoute('btc_to_evm'))->toHaveKey('BTC')
        ->and($service->tokensForRoute('evm_to_btc'))->toHaveKey('BTC');
});

test('external routes are visible before operator setup but marked unavailable', function () {
    $service = app(BridgeConfigService::class);
    $routes = collect($service->publicRoutes())->keyBy('direction');

    expect($routes)->toHaveKeys([
        'btc_to_evm',
        'evm_to_btc',
        'ltc_to_evm',
        'evm_to_ltc',
        'xmr_to_evm',
        'evm_to_xmr',
    ]);

    expect($routes['btc_to_evm']['operational'])->toBeFalse()
        ->and($routes['btc_to_evm']['tokens'])->toBe(['BTC'])
        ->and($routes['ltc_to_evm']['tokens'])->toBe(['LTC'])
        ->and($routes['xmr_to_evm']['tokens'])->toBe(['XMR']);
});

test('coming-soon corridors are visible but rejected everywhere', function () {
    // Fully operational on paper — coming_soon alone must still block it.
    config()->set('bridge.chains.bitcoin.deposit_address', '12ZEw5Hcv1hTb6YUQJ69y1V7uhcoDz92PH');
    config()->set('bridge.chains.bitcoin.enabled', true);
    config()->set('bridge.routes.btc_to_evm.enabled', true);

    $service = app(BridgeConfigService::class);
    $routes = collect($service->publicRoutes())->keyBy('direction');

    expect($routes['btc_to_evm']['operational'])->toBeFalse()
        ->and($routes['btc_to_evm']['unavailableReason'])->toBe('Coming soon');
    expect($service->availableRoutes())->not->toHaveKey('btc_to_evm');
});

test('a disabled chain vanishes from public config and its non-teased routes', function () {
    // Fully configured — only the chain-level switch turns it off.
    config()->set('bridge.chains.bitcoin.deposit_address', '12ZEw5Hcv1hTb6YUQJ69y1V7uhcoDz92PH');
    config()->set('bridge.chains.bitcoin.enabled', false);

    $service = app(BridgeConfigService::class);

    expect(collect($service->publicChains())->pluck('key'))->not->toContain('bitcoin');
    expect($service->availableRoutes())->not->toHaveKeys(['btc_to_evm', 'evm_to_btc']);

    // Coming-soon teasers deliberately survive the chain switch…
    $public = collect($service->publicRoutes())->keyBy('direction');
    expect($public['btc_to_evm']['operational'])->toBeFalse()
        ->and($public['btc_to_evm']['unavailableReason'])->toBe('Coming soon');

    // …but without the tease the routes vanish along with the chain.
    config()->set('bridge.routes.btc_to_evm.coming_soon', false);
    config()->set('bridge.routes.evm_to_btc.coming_soon', false);
    expect(collect($service->publicRoutes())->pluck('direction'))
        ->not->toContain('btc_to_evm')
        ->not->toContain('evm_to_btc');
    // Backend processing of in-flight requests still reads the chain config.
    expect($service->chain('bitcoin'))->not->toBeNull();
    expect($service->chainEnabled('bitcoin'))->toBeFalse();
});

test('public chain config exposes Yenten explorer fallback', function () {
    $chains = collect(app(BridgeConfigService::class)->publicChains())->keyBy('key');

    expect($chains['yenten']['explorerTx'])->toBe('https://explorer.yentencoin.info/tx/{hash}')
        ->and($chains['yenten']['explorerTxFallbacks'])->toContain('https://explorer2.yentencoin.info/tx/{hash}');
});
