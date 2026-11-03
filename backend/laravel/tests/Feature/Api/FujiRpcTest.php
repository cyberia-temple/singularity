<?php

use App\Services\BridgeConfigService;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Route;

beforeEach(function () {
    config()->set('bridge.fuji_rpc_upstream', 'https://fuji-private.test/rpc?key=secret-upstream-key');
    Http::preventStrayRequests();
});

test('forwards an allowed read only after verifying Cyberia Fuji chain identity', function () {
    $call = ['jsonrpc' => '2.0', 'id' => 7, 'method' => 'eth_getBalance', 'params' => ['0x'.str_repeat('1', 40), 'latest']];

    Http::fake(fn (Request $request) => Http::response([
        'jsonrpc' => '2.0',
        'id' => $request['id'],
        'result' => $request['id'] === 'chain-check' ? '0xc0ff' : '0x123',
    ]));

    $this->postJson(route('api.fuji.rpc'), $call)->assertSuccessful()->assertExactJson([
        'jsonrpc' => '2.0', 'id' => 7, 'result' => '0x123',
    ]);

    Http::assertSentCount(2);
    Http::assertSent(fn (Request $request) => $request->data() === $call);
});

test('relays the subnet-evm reads the Avalanche console needs', function (string $method) {
    Http::fake(fn (Request $request) => Http::response([
        'jsonrpc' => '2.0',
        'id' => $request['id'],
        'result' => $request['id'] === 'chain-check' ? '0xc0ff' : ['ok' => true],
    ]));

    $this->postJson(route('api.fuji.rpc'), [
        'jsonrpc' => '2.0', 'id' => 3, 'method' => $method, 'params' => [],
    ])->assertSuccessful()->assertJsonPath('result.ok', true);
})->with(['eth_getChainConfig', 'eth_getActiveRulesAt', 'eth_feeConfig', 'eth_baseFee']);

test('forwards a user signed raw transaction without signing or changing its bytes', function () {
    $call = ['jsonrpc' => '2.0', 'id' => 'send', 'method' => 'eth_sendRawTransaction', 'params' => ['0x02abcd']];

    Http::fakeSequence()
        ->push(['jsonrpc' => '2.0', 'id' => 'chain-check', 'result' => '0xc0ff'])
        ->push(['jsonrpc' => '2.0', 'id' => 'send', 'result' => '0x'.str_repeat('a', 64)]);

    $this->postJson(route('api.fuji.rpc'), $call)->assertSuccessful()->assertJsonPath('id', 'send');

    Http::assertSent(fn (Request $request) => $request->data() === $call);
    Http::assertSentCount(2);
});

test('refuses non allowlisted RPC methods before making any upstream request', function (string $method) {
    Http::fake();

    $this->postJson(route('api.fuji.rpc'), [
        'jsonrpc' => '2.0', 'id' => 9, 'method' => $method, 'params' => [],
    ])->assertBadRequest()->assertJsonPath('error.code', -32601)->assertJsonPath('id', 9);

    Http::assertNothingSent();
})->with(['admin_peers', 'debug_traceTransaction', 'eth_sendTransaction', 'personal_unlockAccount', 'eth_sign']);

test('refuses malformed JSON RPC requests before contacting the node', function (string $body, int $code) {
    Http::fake();

    $this->call('POST', route('api.fuji.rpc'), [], [], [], [
        'CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json',
    ], $body)->assertBadRequest()->assertJsonPath('error.code', $code);

    Http::assertNothingSent();
})->with([
    'invalid JSON' => ['{', -32700],
    'scalar' => ['42', -32600],
    'empty batch' => ['[]', -32600],
    'missing method' => ['{"jsonrpc":"2.0","id":1,"params":[]}', -32600],
    'wrong version' => ['{"jsonrpc":"1.0","id":1,"method":"eth_chainId","params":[]}', -32600],
    'object params' => ['{"jsonrpc":"2.0","id":1,"method":"eth_call","params":{}}', -32600],
    'null params' => ['{"jsonrpc":"2.0","id":1,"method":"eth_call","params":null}', -32600],
    'string params' => ['{"jsonrpc":"2.0","id":1,"method":"eth_call","params":"latest"}', -32600],
    'invalid id' => ['{"jsonrpc":"2.0","id":[],"method":"eth_chainId","params":[]}', -32600],
    'invalid batch member' => ['[{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]},false]', -32600],
]);

test('rejects requests exceeding the 64 KiB body limit', function () {
    Http::fake();

    $this->call('POST', route('api.fuji.rpc'), [], [], [], [
        'CONTENT_TYPE' => 'application/json', 'HTTP_ACCEPT' => 'application/json',
    ], str_repeat(' ', 65537))->assertStatus(413)->assertJsonPath('error.code', -32600);

    Http::assertNothingSent();
});

test('refuses an oversized batch and validates all methods before forwarding', function (bool $tooMany) {
    Http::fake();
    $call = ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'eth_blockNumber', 'params' => []];
    $batch = $tooMany ? array_fill(0, 26, $call) : [$call, array_replace($call, ['method' => 'admin_peers'])];

    $this->postJson(route('api.fuji.rpc'), $batch)->assertBadRequest();

    Http::assertNothingSent();
})->with([true, false]);

test('forwards a batch of 25 reads in one upstream request after the chain check', function () {
    $calls = array_map(fn (int $id) => [
        'jsonrpc' => '2.0', 'id' => $id, 'method' => 'eth_blockNumber', 'params' => [],
    ], range(1, 25));
    $replies = array_map(fn (array $call) => [
        'jsonrpc' => '2.0', 'id' => $call['id'], 'result' => '0x123',
    ], $calls);

    Http::fakeSequence()
        ->push(['jsonrpc' => '2.0', 'id' => 'chain-check', 'result' => '0xc0ff'])
        ->push($replies);

    $this->postJson(route('api.fuji.rpc'), $calls)->assertSuccessful()->assertExactJson($replies);

    Http::assertSentCount(2);
    Http::assertSent(fn (Request $request) => $request->data() === $calls);
});

test('refuses an upstream answering with another chain identity', function (string $chainId) {
    Http::fakeSequence()->push(['jsonrpc' => '2.0', 'id' => 'chain-check', 'result' => $chainId]);

    $response = $this->postJson(route('api.fuji.rpc'), [
        'jsonrpc' => '2.0', 'id' => 7, 'method' => 'eth_getBalance', 'params' => [],
    ])->assertStatus(502)->assertJsonPath('id', 7)->assertJsonPath('error.code', -32603);

    expect($response->getContent())->not->toContain('fuji-private.test', 'secret-upstream-key');
    Http::assertSentCount(1);
})->with(['0xc0fe', '0xa869', '0x1']);

test('rechecks upstream chain identity after its ten second cache expires', function () {
    Http::fake(function (Request $request) {
        return Http::response([
            'jsonrpc' => '2.0', 'id' => $request['id'],
            'result' => $request['id'] === 'chain-check' ? '0xc0ff' : '0x123',
        ]);
    });
    $call = ['jsonrpc' => '2.0', 'id' => 1, 'method' => 'eth_blockNumber', 'params' => []];

    $this->postJson(route('api.fuji.rpc'), $call)->assertSuccessful();
    $this->postJson(route('api.fuji.rpc'), $call)->assertSuccessful();
    Http::assertSentCount(3);

    $this->travel(11)->seconds();
    $this->postJson(route('api.fuji.rpc'), $call)->assertSuccessful();
    Http::assertSentCount(5);
});

test('returns sanitized failures when the upstream is down or unreadable', function (bool $invalidJson) {
    Http::fakeSequence()
        ->push(['jsonrpc' => '2.0', 'id' => 'chain-check', 'result' => '0xc0ff'])
        ->push('secret-upstream-key at https://fuji-private.test/rpc', $invalidJson ? 200 : 500);

    $response = $this->postJson(route('api.fuji.rpc'), [
        'jsonrpc' => '2.0', 'id' => 'read', 'method' => 'eth_blockNumber', 'params' => [],
    ])->assertStatus(502)->assertJsonPath('error.code', -32603)->assertJsonPath('id', 'read');

    expect($response->getContent())->not->toContain('fuji-private.test', 'secret-upstream-key');
})->with([true, false]);

test('does not expose upstream diagnostics while preserving hexadecimal EVM revert data', function () {
    Http::fakeSequence()
        ->push(['jsonrpc' => '2.0', 'id' => 'chain-check', 'result' => '0xc0ff'])
        ->push([
            'jsonrpc' => '2.0', 'id' => 1,
            'error' => ['code' => -32000, 'message' => 'secret-upstream-key https://fuji-private.test/rpc', 'data' => '0x08c379a0'],
            'upstream' => 'secret-upstream-key',
        ]);

    $response = $this->postJson(route('api.fuji.rpc'), [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'eth_estimateGas', 'params' => [],
    ])->assertSuccessful()->assertJsonPath('error.code', -32000)->assertJsonPath('error.data', '0x08c379a0');

    expect($response->getContent())->not->toContain('fuji-private.test', 'secret-upstream-key', 'upstream');
});

test('requires a private upstream and never publishes it to browser bridge configuration', function () {
    config()->set('bridge.chains.cyberia_fuji.enabled', true);

    expect(json_encode(app(BridgeConfigService::class)->publicChains()))->not->toContain('fuji-private.test', 'secret-upstream-key');

    config()->set('bridge.fuji_rpc_upstream', '');
    Http::fake();

    $this->postJson(route('api.fuji.rpc'), [
        'jsonrpc' => '2.0', 'id' => 1, 'method' => 'eth_chainId', 'params' => [],
    ])->assertServiceUnavailable();

    Http::assertNothingSent();
    expect(Route::getRoutes()->getByName('api.fuji.rpc')->gatherMiddleware())->toContain('throttle:120,1');
});
