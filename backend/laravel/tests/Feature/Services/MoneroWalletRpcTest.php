<?php

use App\Services\Monero\MoneroWalletRpc;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;

/**
 * The wallet this server has to hold for Monero to work at all.
 *
 * Everything here is about one distinction: a wallet that says "nothing
 * arrived" and a wallet that did not say anything. On every other chain the
 * difference is cosmetic because a second source can be asked; here there is
 * no second source, so a timeout that reads as an empty balance is a user's
 * deposit going uncredited or a payout going out twice.
 */
const XMR_RPC = 'http://127.0.0.1:18083';

beforeEach(function () {
    config()->set('bridge.chains.monero.wallet_rpc_url', XMR_RPC);
    config()->set('bridge.chains.monero.wallet_account_index', 0);
    config()->set('bridge.chains.monero.payout_lookback_blocks', 720);
});

/** Answer each JSON-RPC method with a canned `result`, or an error object. */
function fakeWallet(array $results): void
{
    Http::fake([
        '127.0.0.1:18083/json_rpc' => function (Request $request) use ($results) {
            $method = $request->data()['method'] ?? '';
            $answer = $results[$method] ?? null;

            if ($answer === null) {
                return Http::response([
                    'jsonrpc' => '2.0',
                    'error' => ['code' => -32601, 'message' => "Method not found: {$method}"],
                ]);
            }

            return Http::response(['jsonrpc' => '2.0', 'result' => $answer]);
        },
    ]);
}

test('a corridor with no wallet configured answers nothing at all, and says so', function () {
    config()->set('bridge.chains.monero.wallet_rpc_url', '');
    Http::fake();

    $wallet = app(MoneroWalletRpc::class);

    expect($wallet->configured())->toBeFalse()
        ->and($wallet->unlockedBalance())->toBeNull()
        ->and($wallet->createSubaddress('bridge:1'))->toBeNull()
        ->and($wallet->incoming(3, 10))->toBeNull();

    // Nothing was even attempted: an unset wallet is a config fact, not a
    // network one, and it must not cost a request to find out.
    Http::assertNothingSent();
});

test('a deposit address is minted by the wallet, with the request written into its label', function () {
    fakeWallet(['create_address' => ['address' => '8Bridge…Sub', 'address_index' => 7]]);

    expect(app(MoneroWalletRpc::class)->createSubaddress('bridge:42'))
        ->toBe(['address' => '8Bridge…Sub', 'index' => 7]);

    Http::assertSent(fn (Request $r) => $r->data()['method'] === 'create_address'
        && ((array) $r->data()['params'])['label'] === 'bridge:42');
});

test('what landed is split by depth, and the mempool is never creditable', function () {
    fakeWallet([
        'get_transfers' => [
            'in' => [
                ['amount' => 500000000000, 'confirmations' => 12],  // 0.5 XMR, deep
                ['amount' => 250000000000, 'confirmations' => 3],   // seen, not deep
            ],
            'pool' => [
                ['amount' => 100000000000, 'confirmations' => 0],
            ],
        ],
    ]);

    expect(app(MoneroWalletRpc::class)->incoming(7, 10))->toBe([
        'confirmed' => '500000000000',
        'pending' => '350000000000',
    ]);
});

test('an unreadable amount is refused rather than credited as part of a total', function () {
    fakeWallet([
        'get_transfers' => ['in' => [['amount' => 'not-a-number', 'confirmations' => 30]]],
    ]);

    expect(app(MoneroWalletRpc::class)->incoming(7, 10))->toBeNull();
});

test('a JSON-RPC error is null, never zero', function () {
    fakeWallet([]); // every method answers a JSON-RPC error object

    expect(app(MoneroWalletRpc::class)->incoming(7, 10))->toBeNull()
        ->and(app(MoneroWalletRpc::class)->unlockedBalance())->toBeNull();
});

test('an unreachable wallet is null, never zero', function () {
    Http::fake(['127.0.0.1:18083/*' => Http::response('gateway down', 502)]);

    expect(app(MoneroWalletRpc::class)->unlockedBalance())->toBeNull()
        ->and(app(MoneroWalletRpc::class)->reachable())->toBeFalse();
});

test('spendable balance is the unlocked one, because an output is locked for ten blocks', function () {
    fakeWallet([
        'get_balance' => ['balance' => 900000000000, 'unlocked_balance' => 400000000000],
    ]);

    expect(app(MoneroWalletRpc::class)->unlockedBalance())->toBe('400000000000');
});

test('a payout is sent once and tagged with the request it belongs to', function () {
    fakeWallet([
        'transfer' => ['tx_hash' => 'deadbeef', 'fee' => 30000000, 'amount' => 200000000000],
        'set_tx_notes' => [],
    ]);

    expect(app(MoneroWalletRpc::class)->transfer('4Recipient', '200000000000', 'bridge:9'))
        ->toBe(['tx_hash' => 'deadbeef', 'fee' => '30000000', 'amount' => '200000000000']);

    Http::assertSent(function (Request $r) {
        $params = (array) $r->data()['params'];

        return $r->data()['method'] === 'transfer'
            && $params['destinations'][0]['address'] === '4Recipient'
            && $params['destinations'][0]['amount'] === 200000000000;
    });

    // The note is what a later run recognises its own payout by.
    Http::assertSent(function (Request $r) {
        $params = (array) $r->data()['params'];

        return $r->data()['method'] === 'set_tx_notes'
            && $params['txids'] === ['deadbeef']
            && $params['notes'] === ['bridge:9'];
    });
});

test('a payout already made is found by its note', function () {
    fakeWallet([
        'get_height' => ['height' => 3000000],
        'get_transfers' => [
            'out' => [
                ['txid' => 'aaa', 'note' => 'bridge:5', 'destinations' => []],
            ],
        ],
    ]);

    expect(app(MoneroWalletRpc::class)->payoutFor('bridge:5'))->toBe('aaa');
    expect(app(MoneroWalletRpc::class)->payoutFor('bridge:6'))->toBeNull();
});

test('matching by destination and amount is opt-in, because it can be wrong', function () {
    fakeWallet([
        'get_height' => ['height' => 3000000],
        'get_transfers' => [
            'out' => [[
                'txid' => 'bbb',
                'note' => '',
                'destinations' => [['address' => '4Recipient', 'amount' => 200000000000]],
            ]],
        ],
    ]);

    $wallet = app(MoneroWalletRpc::class);

    // Two requests paying the same person the same amount look identical, so
    // the fallback is only used where "possibly already paid" must win.
    expect($wallet->payoutFor('bridge:5'))->toBeNull()
        ->and($wallet->payoutFor('bridge:5', '4Recipient', '200000000000'))->toBe('bbb')
        ->and($wallet->payoutFor('bridge:5', '4Recipient', '199999999999'))->toBeNull();
});

test('a payout the wallet knows about reads as made', function () {
    fakeWallet(['get_transfer_by_txid' => ['transfer' => ['type' => 'out']]]);

    expect(app(MoneroWalletRpc::class)->payoutSucceeded('aaa'))->toBeTrue();
});

test('a payout the wallet calls failed reads as failed, which is what allows another', function () {
    fakeWallet(['get_transfer_by_txid' => ['transfer' => ['type' => 'failed']]]);

    expect(app(MoneroWalletRpc::class)->payoutSucceeded('aaa'))->toBeFalse();
});

test('a payout the wallet cannot answer about stays unknown, and is never re-sent', function () {
    fakeWallet([]);

    expect(app(MoneroWalletRpc::class)->payoutSucceeded('aaa'))->toBeNull();
});

test('a wallet behind an rpc-login is authenticated with digest, which is what it speaks', function () {
    config()->set('bridge.chains.monero.wallet_rpc_user', 'bridge');
    config()->set('bridge.chains.monero.wallet_rpc_password', 'secret');
    fakeWallet(['get_version' => ['version' => 65539]]);

    expect(app(MoneroWalletRpc::class)->reachable())->toBeTrue();

    // Basic auth against --rpc-login authenticates nothing and reads as a 401,
    // so the header must not be a pre-emptive Basic one.
    Http::assertSent(fn (Request $r) => ! str_starts_with(
        $r->header('Authorization')[0] ?? '',
        'Basic ',
    ));
});
