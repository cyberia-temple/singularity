<?php

use Illuminate\Support\Facades\Http;

/**
 * Swapping Monero by two routes.
 *
 * What is pinned here is everything that decides what a person is told: that a
 * route which cannot run says why instead of vanishing, that the fee this app
 * asks for is composed here and cannot be named by the caller, and that the
 * fee shown is the one the exchanger agreed to rather than the one we wanted.
 */
beforeEach(function () {
    config()->set('moneroswap.enabled', true);
    config()->set('moneroswap.fee.bps', 75);
    config()->set('moneroswap.partner.enabled', true);
    config()->set('moneroswap.partner.api_key', 'test-key');
    config()->set('moneroswap.partner.api', 'https://partner.test');
    config()->set('moneroswap.partner.referral', 'cyberia');
});

it('lists both routes, and says why one cannot run', function () {
    config()->set('bridge.chains.monero.enabled', false);

    $response = $this->getJson('/api/wallet/monero/swap');

    $response->assertOk();
    $routes = collect($response->json('routes'))->keyBy('key');

    expect($routes)->toHaveKeys(['cyberia', 'partner']);
    expect($routes['cyberia']['available'])->toBeFalse();
    expect($routes['cyberia']['reason'])->toBe('monero_chain_disabled');
    // Still described in full: the wrapper exists, the terms are real, and the
    // route is switched off rather than absent.
    expect($routes['cyberia']['wrapper']['decimals'])->toBe(12);
    expect($routes['partner']['available'])->toBeTrue();
});

it('names the corridor, not the chain, when the chain is on but the route is not', function () {
    config()->set('bridge.chains.monero.enabled', true);
    config()->set('bridge.chains.monero.deposit_address', '4'.str_repeat('A', 94));
    config()->set('bridge.routes.xmr_to_evm.coming_soon', true);
    config()->set('bridge.routes.evm_to_xmr.coming_soon', true);

    $routes = collect($this->getJson('/api/wallet/monero/swap')->json('routes'))->keyBy('key');

    expect($routes['cyberia']['reason'])->toBe('corridor_coming_soon');
    expect($routes['cyberia']['directions'])->toBe([
        'xmr_to_cyberia' => false,
        'cyberia_to_xmr' => false,
    ]);
});

it('is available once the corridor is actually open', function () {
    config()->set('bridge.chains.monero.enabled', true);
    config()->set('bridge.chains.monero.deposit_address', '4'.str_repeat('A', 94));
    config()->set('bridge.routes.xmr_to_evm.enabled', true);
    config()->set('bridge.routes.xmr_to_evm.coming_soon', false);

    $routes = collect($this->getJson('/api/wallet/monero/swap')->json('routes'))->keyBy('key');

    expect($routes['cyberia']['available'])->toBeTrue();
    expect($routes['cyberia']['reason'])->toBeNull();
    expect($routes['cyberia']['directions']['xmr_to_cyberia'])->toBeTrue();
    expect($routes['cyberia']['directions']['cyberia_to_xmr'])->toBeFalse();
});

it('asks the partner for our share and never lets the caller name it', function () {
    Http::fake(['partner.test/*' => Http::response([
        'amount_from' => '1', 'amount_to' => '0.0125', 'rate' => '0.0125',
        'provider' => 'SomeExchanger', 'markup' => '0.75', 'trade_id' => 'abc',
        'min_amount' => '0.01', 'max_amount' => '50', 'eta' => 15,
    ])]);

    $response = $this->getJson(
        '/api/wallet/monero/swap/quote?from=XMR&to=ETH&amount=1&markup=0&ref=someone-else',
    );

    $response->assertOk();
    expect($response->json('ok'))->toBeTrue();
    expect($response->json('fee_bps'))->toBe(75);
    expect($response->json('fee_applied'))->toBeTrue();
    expect($response->json('provider'))->toBe('SomeExchanger');

    Http::assertSent(function ($request) {
        // Ours, composed here — not the caller's.
        expect($request['markup'])->toBe('0.75');
        expect($request['ref'])->toBe('cyberia');
        expect($request['ticker_from'])->toBe('xmr');
        expect($request['amount_from'])->toBe('1');
        expect($request->header('API-Key')[0])->toBe('test-key');

        return true;
    });
});

it('clamps a fee an env file got wrong', function () {
    config()->set('moneroswap.fee.bps', 5000);
    Http::fake(['partner.test/*' => Http::response([
        'amount_from' => '1', 'amount_to' => '0.01', 'markup' => '3',
    ])]);

    $this->getJson('/api/wallet/monero/swap/quote?from=XMR&to=ETH&amount=1')->assertOk();

    Http::assertSent(fn ($request) => $request['markup'] === '3.00');
});

it('reports a fee the exchanger did not honour as unapplied', function () {
    Http::fake(['partner.test/*' => Http::response([
        'amount_from' => '1', 'amount_to' => '0.0125', 'markup' => '0',
    ])]);

    $response = $this->getJson('/api/wallet/monero/swap/quote?from=XMR&to=ETH&amount=1');

    expect($response->json('ok'))->toBeTrue();
    expect($response->json('fee_applied'))->toBeFalse();
});

it('answers a refusal as an answer, so the other route still draws', function () {
    Http::fake(['partner.test/*' => Http::response(['error' => 'below minimum'], 400)]);

    $response = $this->getJson('/api/wallet/monero/swap/quote?from=XMR&to=ETH&amount=0.00001');

    $response->assertOk();
    expect($response->json('ok'))->toBeFalse();
    expect($response->json('reason'))->toBe('refused');
    expect($response->json('detail'))->toBe('below minimum');
});

it('says the partner is not configured rather than calling nothing', function () {
    config()->set('moneroswap.partner.api_key', '');
    Http::fake();

    $response = $this->getJson('/api/wallet/monero/swap/quote?from=XMR&to=ETH&amount=1');

    expect($response->json('reason'))->toBe('partner_not_configured');
    Http::assertNothingSent();
});

it('refuses a swap that has no Monero in it', function () {
    Http::fake();

    $this->getJson('/api/wallet/monero/swap/quote?from=ETH&to=BTC&amount=1')
        ->assertStatus(422)
        ->assertJson(['reason' => 'not_a_monero_swap']);

    Http::assertNothingSent();
});

it('refuses an amount that is not a number', function () {
    $this->getJson('/api/wallet/monero/swap/quote?from=XMR&to=ETH&amount=1e9')
        ->assertStatus(422);
    $this->getJson('/api/wallet/monero/swap/quote?from=XMR&to=XMR&amount=1')
        ->assertStatus(422);
});
