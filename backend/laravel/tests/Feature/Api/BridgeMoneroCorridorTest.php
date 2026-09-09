<?php

use App\Models\BridgeRequest;
use App\Services\BridgeConfigService;
use App\Services\BridgeInventoryService;
use App\Services\BridgeService;
use App\Support\BridgeCapacity;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Process;

/**
 * Monero, both ways.
 *
 * The corridor is unlike every other one here in a single respect that decides
 * its whole shape: nobody outside the receiving wallet can see a Monero
 * deposit. There is no explorer to ask, no transaction hash a user can hand
 * over that this server could check, and no balance a third party can read. So
 * the bridge holds a wallet, hands out a subaddress per request, and reads
 * what landed through that wallet — and every failure mode below is a variant
 * of the same question: what happens when the wallet does not answer.
 */
const XMR_WALLET = 'http://127.0.0.1:18083';
const XMR_EVM_RECIPIENT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const XMR_PAYOUT_ADDRESS = '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge';

beforeEach(function () {
    config()->set('services.bridge.relayer_address', '0x0000000000000000000000000000000000abcdef');
    config()->set('services.bridge.relayer_private_key', '0x'.str_repeat('1', 64));
    config()->set('bridge.chains.monero.enabled', true);
    config()->set('bridge.chains.monero.wallet_rpc_url', XMR_WALLET);
    config()->set('bridge.chains.monero.minimum_confirmations', 10);
    config()->set('bridge.chains.monero.deposit_ttl_minutes', 1440);
    config()->set('bridge.routes.xmr_to_evm.enabled', true);
    config()->set('bridge.routes.xmr_to_evm.coming_soon', false);
    config()->set('bridge.routes.evm_to_xmr.enabled', true);
    config()->set('bridge.routes.evm_to_xmr.coming_soon', false);
});

/**
 * One fake wallet, answering by JSON-RPC method. Anything not named answers a
 * JSON-RPC error, which is how this client reads "I could not tell you".
 */
function fakeMoneroWallet(array $results): void
{
    Http::fake([
        '127.0.0.1:18083/json_rpc' => function (Request $request) use ($results) {
            $method = $request->data()['method'] ?? '';

            return array_key_exists($method, $results)
                ? Http::response(['jsonrpc' => '2.0', 'result' => $results[$method]])
                : Http::response([
                    'jsonrpc' => '2.0',
                    'error' => ['code' => -32601, 'message' => $method],
                ]);
        },
    ]);
}

/** A confirmed XMR deposit of `$atomic` piconero on the request's subaddress. */
function moneroDeposit(string $atomic, int $confirmations = 12): array
{
    return ['in' => [['amount' => (int) $atomic, 'confirmations' => $confirmations]]];
}

function prepareMonero(): array
{
    return test()->postJson('/bridge/prepare', [
        'direction' => 'xmr_to_evm',
        'token' => 'XMR',
        'recipient_address' => XMR_EVM_RECIPIENT,
    ])->json('bridge_request');
}

test('a deposit address comes from the wallet, and the request remembers which one', function () {
    fakeMoneroWallet(['create_address' => ['address' => XMR_PAYOUT_ADDRESS, 'address_index' => 12]]);

    $prepared = prepareMonero();

    expect($prepared['deposit_address'])->toBe(XMR_PAYOUT_ADDRESS)
        ->and($prepared['status'])->toBe('awaiting_deposit')
        ->and($prepared['recipient_address'])->toBe(XMR_EVM_RECIPIENT)
        // Said out loud so the screen can say how long the wait is.
        ->and($prepared['confirmations'])->toBe(10);

    // The index, not just the address: every later read of "what landed here"
    // is a wallet call filtered by it.
    expect(BridgeRequest::find($prepared['id'])->deposit_index)->toBe(12);
});

test('with no wallet attached the corridor is not offered at all', function () {
    config()->set('bridge.chains.monero.wallet_rpc_url', '');

    $routes = app(BridgeConfigService::class)->availableRoutes();

    expect($routes)->not->toHaveKey('xmr_to_evm')
        ->and($routes)->not->toHaveKey('evm_to_xmr');
});

test('a wallet that cannot be reached refuses to hand out an address instead of handing out a dead one', function () {
    Http::fake(['127.0.0.1:18083/*' => Http::response('down', 502)]);

    $response = $this->postJson('/bridge/prepare', [
        'direction' => 'xmr_to_evm',
        'token' => 'XMR',
        'recipient_address' => XMR_EVM_RECIPIENT,
    ]);

    $response->assertStatus(422);
    expect($response->json('message'))->toContain('Monero wallet');

    // And the row it opened is closed, not left waiting for a deposit to an
    // address that was never created.
    expect(BridgeRequest::latest('id')->first()->status)->toBe('expired');
});

test('a confirmed deposit is credited for exactly what landed, and mints the wrapper', function () {
    fakeMoneroWallet([
        'create_address' => ['address' => XMR_PAYOUT_ADDRESS, 'address_index' => 3],
        // 0.5 XMR, twelve confirmations deep.
        'get_transfers' => moneroDeposit('500000000000'),
    ]);
    Process::fake(['*relay-mint*' => Process::result(output: json_encode(['txHash' => '0xxmrmint']))]);

    $prepared = prepareMonero();

    $this->postJson('/bridge/claim', ['id' => $prepared['id']])->assertOk();

    $request = BridgeRequest::find($prepared['id']);

    expect($request->status)->toBe('completed')
        ->and((float) $request->amount)->toBe(0.5)
        ->and($request->recipient_address)->toBe(XMR_EVM_RECIPIENT)
        ->and($request->destination_tx_hash)->toBe('0xxmrmint');
});

test('a deposit that has not gone deep enough says so, and stays claimable', function () {
    fakeMoneroWallet([
        'create_address' => ['address' => XMR_PAYOUT_ADDRESS, 'address_index' => 3],
        'get_transfers' => ['in' => [['amount' => 500000000000, 'confirmations' => 2]]],
    ]);

    $prepared = prepareMonero();
    $response = $this->postJson('/bridge/claim', ['id' => $prepared['id']]);

    $response->assertStatus(422);
    expect($response->json('message'))->toContain('10 Monero confirmations')
        ->and($response->json('retryable'))->toBeTrue()
        ->and(BridgeRequest::find($prepared['id'])->status)->toBe('awaiting_deposit');
});

test('a wallet that goes quiet never closes a deposit window and never reads as empty', function () {
    fakeMoneroWallet(['create_address' => ['address' => XMR_PAYOUT_ADDRESS, 'address_index' => 3]]);
    $prepared = prepareMonero();

    // The window is long past, and the wallet cannot be asked what is on the
    // address. Expiring here would abandon a deposit that may well be sitting
    // in the wallet already.
    BridgeRequest::find($prepared['id'])->update(['created_at' => now()->subDays(10)]);
    Http::fake(['127.0.0.1:18083/*' => Http::response('down', 502)]);

    $response = $this->postJson('/bridge/claim', ['id' => $prepared['id']]);

    $response->assertStatus(422);
    expect($response->json('expired'))->toBeNull()
        ->and(BridgeRequest::find($prepared['id'])->status)->toBe('awaiting_deposit');
});

test('a deposit is credited with nobody watching', function () {
    fakeMoneroWallet([
        'create_address' => ['address' => XMR_PAYOUT_ADDRESS, 'address_index' => 3],
        'get_transfers' => moneroDeposit('250000000000'),
    ]);
    Process::fake(['*relay-mint*' => Process::result(output: json_encode(['txHash' => '0xsweptmint']))]);

    $prepared = prepareMonero();

    // Ten confirmations is twenty minutes; the tab is long gone by then.
    $this->artisan('bridge:sweep-deposits --chain=monero')->assertSuccessful();

    $request = BridgeRequest::find($prepared['id']);

    expect($request->status)->toBe('completed')
        ->and((float) $request->amount)->toBe(0.25)
        ->and($request->destination_tx_hash)->toBe('0xsweptmint');
});

/** An EVM deposit of the XMR wrapper into the relayer, as the receipt shows it. */
function fakeWrapperDeposit(string $rawAmount, array $walletResults): void
{
    Http::fake([
        '127.0.0.1:18083/json_rpc' => function (Request $request) use ($walletResults) {
            $method = $request->data()['method'] ?? '';

            return array_key_exists($method, $walletResults)
                ? Http::response(['jsonrpc' => '2.0', 'result' => $walletResults[$method]])
                : Http::response(['jsonrpc' => '2.0', 'error' => ['code' => -1, 'message' => $method]]);
        },
        'https://rpc.cyberia.church' => Http::response([
            'result' => [
                'status' => '0x1',
                'logs' => [[
                    'address' => '0xe2E8D51C18d6e0FDDbb9Ff4BF63235D688dd00Ae',
                    'topics' => [
                        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                        '0x0000000000000000000000005555555555555555555555555555555555555555',
                        '0x0000000000000000000000000000000000000000000000000000000000abcdef',
                    ],
                    'data' => '0x'.str_pad(dechex((int) $rawAmount), 64, '0', STR_PAD_LEFT),
                ]],
            ],
        ]),
    ]);
}

function makeXmrPayoutRequest(array $overrides = []): BridgeRequest
{
    return BridgeRequest::create(array_merge([
        'direction' => 'evm_to_xmr',
        'token' => 'XMR',
        'source_chain' => 'cyberia',
        'source_tx_hash' => '0xevmxmr'.uniqid(),
        'source_nonce' => random_int(1, PHP_INT_MAX),
        'sender_address' => '0x5555555555555555555555555555555555555555',
        'recipient_address' => XMR_PAYOUT_ADDRESS,
        'amount' => '1',
        'fee_amount' => '0',
        'status' => 'pending',
    ], $overrides));
}

test('burning the wrapper sends real XMR, net of the fee that pays for the transaction', function () {
    fakeWrapperDeposit('1000000000000', [
        'get_balance' => ['balance' => 5000000000000, 'unlocked_balance' => 5000000000000],
        'get_height' => ['height' => 3000000],
        'get_transfers' => [],
        'transfer' => ['tx_hash' => 'xmrpayout1', 'fee' => 30000000, 'amount' => 999500000000],
        'set_tx_notes' => [],
    ]);
    Process::fake(['*relay-burn*' => Process::result(output: json_encode(['txHash' => '0xburned']))]);

    $request = makeXmrPayoutRequest();
    app(BridgeService::class)->processDirectRelay($request);
    $request->refresh();

    expect($request->status)->toBe('completed')
        ->and($request->destination_tx_hash)->toBe('xmrpayout1');

    // 1 XMR less the 0.0005 flat reserve = 0.9995 XMR in piconero. Monero
    // charges its fee to the sender on top, so the recipient gets this exactly.
    Http::assertSent(function (Request $r) {
        if (($r->data()['method'] ?? '') !== 'transfer') {
            return false;
        }

        $destination = ((array) $r->data()['params'])['destinations'][0];

        return $destination['address'] === XMR_PAYOUT_ADDRESS
            && $destination['amount'] === 999500000000;
    });
});

test('a payout whose answer was lost is adopted, never sent a second time', function () {
    fakeWrapperDeposit('1000000000000', [
        'get_balance' => ['balance' => 5000000000000, 'unlocked_balance' => 5000000000000],
        'get_height' => ['height' => 3000000],
        // The wallet already sent it: the transfer went through and only the
        // HTTP answer was lost, so nothing on the row recorded a hash.
        'get_transfers' => ['out' => [[
            'txid' => 'xmrpayout-already',
            'note' => '',
            'destinations' => [['address' => XMR_PAYOUT_ADDRESS, 'amount' => 999500000000]],
        ]]],
        'transfer' => ['tx_hash' => 'SECOND-PAYOUT', 'fee' => 1, 'amount' => 1],
        'set_tx_notes' => [],
    ]);
    Process::fake(['*relay-burn*' => Process::result(output: json_encode(['txHash' => '0xburned']))]);

    // A payout timestamp with no hash beside it is what a lost response leaves
    // behind, and it is what licenses the destination-and-amount match.
    $request = makeXmrPayoutRequest([
        'status' => BridgeRequest::PAYING_OUT,
        'payout_broadcast_at' => now(),
    ]);
    app(BridgeService::class)->processDirectRelay($request);
    $request->refresh();

    expect($request->destination_tx_hash)->toBe('xmrpayout-already');
    Http::assertNotSent(fn (Request $r) => ($r->data()['method'] ?? '') === 'transfer');
});

test('capacity is the unlocked balance less what the next transaction costs', function () {
    fakeMoneroWallet([
        'get_balance' => ['balance' => 5000000000000, 'unlocked_balance' => 3000000000000],
    ]);

    $capacity = app(BridgeInventoryService::class)->capacity('evm_to_xmr', 'XMR');

    // 3 XMR unlocked, less the 0.01 XMR reserve.
    expect($capacity->state)->toBe(BridgeCapacity::AVAILABLE)
        ->and($capacity->availableRaw)->toBe('2990000000000')
        ->and($capacity->decimals)->toBe(12);
});

test('an unreadable wallet fails closed, and an absent one simply says nothing', function () {
    Http::fake(['127.0.0.1:18083/*' => Http::response('down', 502)]);

    expect(app(BridgeInventoryService::class)->capacity('evm_to_xmr', 'XMR')->state)
        ->toBe(BridgeCapacity::UNAVAILABLE);

    // No wallet is not a failure: the reserve is real and held by hand, which
    // is what 'unmeasured' has always meant on this corridor.
    config()->set('bridge.chains.monero.wallet_rpc_url', '');

    expect(app(BridgeInventoryService::class)->capacity('evm_to_xmr', 'XMR')->state)
        ->toBe(BridgeCapacity::UNMEASURED);
});
