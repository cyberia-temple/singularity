<?php

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

it('sets the affiliate and two percent commission on SideShift requests on the server', function () {
    config(['services.sideshift.secret' => 'test-secret']);
    Http::fake(['sideshift.ai/*' => Http::response(['id' => 'private', 'depositAddress' => 'address'], 201)]);
    $this->postJson('/api/wallet/sideshift', [
        'depositCoin' => 'ETH', 'depositNetwork' => 'ethereum', 'settleCoin' => 'BTC', 'settleNetwork' => 'bitcoin',
        'settleAddress' => 'recipient', 'refundAddress' => 'refund', 'commissionRate' => '0', 'affiliateId' => 'other',
    ])->assertOk();
    Http::assertSent(fn (Request $r) => $r['affiliateId'] === 'x0hU9rQwn' && $r['commissionRate'] === '0.02' && $r->hasHeader('x-sideshift-secret', 'test-secret') && $r->hasHeader('x-user-ip'));
});

it('refuses to create a shift without a refund address or server secret', function () {
    config(['services.sideshift.secret' => 'test-secret']);
    $this->postJson('/api/wallet/sideshift', ['depositCoin' => 'ETH', 'depositNetwork' => 'ethereum', 'settleCoin' => 'BTC', 'settleNetwork' => 'bitcoin', 'settleAddress' => 'recipient'])->assertUnprocessable();
    config(['services.sideshift.secret' => '']);
    $this->getJson('/api/wallet/sideshift/pair?depositCoin=ETH&depositNetwork=ethereum&settleCoin=BTC&settleNetwork=bitcoin')->assertStatus(503);
});

it('requests the expanded Robinhood catalogue and marks unverified assets', function () {
    config(['crosschain.enabled' => true, 'crosschain.api' => 'https://relay.test']);
    Cache::flush();
    Http::fake(['relay.test/*' => Http::response([[['chainId' => 4663, 'address' => '0x123', 'symbol' => 'TOK', 'metadata' => ['verified' => false]]]], 200)]);
    $this->getJson('/api/wallet/crosschain/tokens?chain=4663')->assertOk()->assertJsonPath('tokens.0.verified', false);
    Http::assertSent(fn (Request $r) => $r['chainIds'] === [4663] && $r['verified'] === false && $r['limit'] === 100);
});

it('keeps the affiliate and commission on SideShift rate requests', function () {
    config(['services.sideshift.secret' => 'test-secret']);
    Http::fake(['sideshift.ai/*' => Http::response(['min' => '0.01', 'max' => '1', 'rate' => '2'])]);
    $this->getJson('/api/wallet/sideshift/pair?depositCoin=ETH&depositNetwork=ethereum&settleCoin=BTC&settleNetwork=bitcoin&amount=0.1&commissionRate=0')->assertOk();
    Http::assertSent(fn (Request $r) => $r['commissionRate'] === '0.02' && $r['affiliateId'] === 'x0hU9rQwn');
});
