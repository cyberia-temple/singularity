<?php

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;

it('forwards only the installation id and the fixed opening event', function () {
    config(['services.extension_analytics.api_secret' => 'test-secret']);
    Http::preventStrayRequests();
    Http::fake(['www.google-analytics.com/*' => Http::response('', 204)]);

    $this->postJson('/api/extension/analytics', [
        'client_id' => '9ef1587a-d01b-4bd3-b876-b317b303debb',
        'address' => 'must-not-be-forwarded',
    ])->assertNoContent();

    Http::assertSent(fn (Request $request) => str_contains($request->url(), 'measurement_id=G-TNT5C5CBCP')
        && $request['client_id'] === '9ef1587a-d01b-4bd3-b876-b317b303debb'
        && $request['events'][0]['name'] === 'extension_open'
        && ! isset($request['address']));
});

it('does not forward invalid identifiers or send without a secret', function () {
    Http::preventStrayRequests();
    Http::fake();
    config(['services.extension_analytics.api_secret' => null]);

    $this->postJson('/api/extension/analytics', ['client_id' => 'invalid'])->assertUnprocessable();
    $this->postJson('/api/extension/analytics', ['client_id' => '9ef1587a-d01b-4bd3-b876-b317b303debb'])->assertNoContent();
    Http::assertNothingSent();
});
