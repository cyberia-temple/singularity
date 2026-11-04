<?php

use App\Models\BridgeRequest;
use App\Services\BridgeService;
use Illuminate\Process\Exceptions\ProcessTimedOutException;
use Illuminate\Process\PendingProcess;
use Illuminate\Process\ProcessResult;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Process;

beforeEach(function () {
    config()->set('services.bridge.relayer_private_key', '0x'.str_repeat('1', 64));
    config()->set('bridge.chains.cyberia.rpc_url', 'https://wrapper-burn.test');
    Http::preventStrayRequests();
});

function wrapperBurnRequest(array $overrides = []): BridgeRequest
{
    return BridgeRequest::create(array_merge([
        'direction' => 'evm_to_cyberia_fuji',
        'token' => 'AVAX.FUJI',
        'source_chain' => 'cyberia',
        'source_tx_hash' => '0x'.str_repeat('d', 64),
        'source_nonce' => 0,
        'sender_address' => '0x'.str_repeat('b', 40),
        'recipient_address' => '0x'.str_repeat('c', 40),
        'amount' => '0.0004',
        'fee_amount' => '0',
        'status' => BridgeRequest::BURN_PENDING,
        'destination_tx_hash' => '0x'.str_repeat('a', 64),
        'source_verified_at' => now(),
        'payout_confirmed_at' => now(),
    ], $overrides));
}

test('a previously mined wrapper burn completes without starting another subprocess', function () {
    $hash = '0x'.str_repeat('e', 64);
    $request = wrapperBurnRequest(['wrapper_burn_tx_hash' => $hash]);
    Http::fake(['https://wrapper-burn.test' => Http::response(['result' => ['status' => '0x1']])]);
    Process::fake();

    expect(app(BridgeService::class)->processDirectRelay($request))->toBeTrue()
        ->and($request->refresh()->status)->toBe(BridgeRequest::COMPLETED)
        ->and($request->wrapper_burned)->toBeTrue()
        ->and($request->wrapper_burn_tx_hash)->toBe($hash)
        ->and($request->destination_tx_hash)->toBe('0x'.str_repeat('a', 64));

    Process::assertNothingRan();
    Http::assertSent(fn ($call) => $call['method'] === 'eth_getTransactionReceipt' && $call['params'] === [$hash]);
});

test('an unknown wrapper burn remains pending and is never repeated', function (mixed $receipt, int $httpStatus) {
    $hash = '0x'.str_repeat('e', 64);
    $request = wrapperBurnRequest(['wrapper_burn_tx_hash' => $hash]);
    Http::fake(['https://wrapper-burn.test' => Http::response(['result' => $receipt], $httpStatus)]);
    Process::fake();

    $service = app(BridgeService::class);

    expect($service->processDirectRelay($request))->toBeFalse()
        ->and($service->processDirectRelay($request->refresh()))->toBeFalse()
        ->and($request->refresh()->status)->toBe(BridgeRequest::BURN_PENDING)
        ->and($request->wrapper_burned)->toBeFalse()
        ->and($request->wrapper_burn_tx_hash)->toBe($hash)
        ->and($request->destination_tx_hash)->toBe('0x'.str_repeat('a', 64));

    Process::assertNothingRan();
})->with([
    'receipt not found' => [null, 200],
    'receipt without status' => [[], 200],
    'unrecognized receipt status' => [['status' => 'pending'], 200],
    'HTTP error cannot prove a revert' => [['status' => '0x0'], 503],
]);

test('an unreachable wrapper burn RPC retains the recorded hash', function () {
    $hash = '0x'.str_repeat('e', 64);
    $request = wrapperBurnRequest(['wrapper_burn_tx_hash' => $hash]);
    Http::fake(['https://wrapper-burn.test' => Http::failedConnection()]);
    Process::fake();

    expect(app(BridgeService::class)->processDirectRelay($request))->toBeFalse()
        ->and($request->refresh()->status)->toBe(BridgeRequest::BURN_PENDING)
        ->and($request->wrapper_burn_tx_hash)->toBe($hash)
        ->and($request->wrapper_burned)->toBeFalse();

    Process::assertNothingRan();
});

test('a proven reverted wrapper burn permits one new burn without another payout', function () {
    $previousHash = '0x'.str_repeat('e', 64);
    $nextHash = '0x'.str_repeat('f', 64);
    $request = wrapperBurnRequest(['wrapper_burn_tx_hash' => $previousHash]);
    Http::fake(['https://wrapper-burn.test' => Http::response(['result' => ['status' => '0x0']])]);
    Process::fake(['*relay-burn*' => Process::result(output: json_encode(['txHash' => $nextHash]))]);
    Process::preventStrayProcesses();

    expect(app(BridgeService::class)->processDirectRelay($request))->toBeTrue()
        ->and($request->refresh()->status)->toBe(BridgeRequest::COMPLETED)
        ->and($request->wrapper_burned)->toBeTrue()
        ->and($request->wrapper_burn_tx_hash)->toBe($nextHash)
        ->and($request->destination_tx_hash)->toBe('0x'.str_repeat('a', 64));

    Process::assertRanTimes(fn ($process) => $process->command[2] === 'scripts/relay-burn.ts', 1);
    Process::assertRan(fn ($process) => $process->environment['EVM_CHAIN_ID'] === '49406'
        && $process->command[4] === '400000000000000');
});

test('the wrapper burn hash is durable during output streaming before subprocess completion', function (bool $timeout, ?string $receiptStatus) {
    $hash = '0x'.str_repeat('e', 64);
    $request = wrapperBurnRequest();
    $stdout = json_encode(['broadcastTxHash' => $hash])."\n";
    Http::fake(['https://wrapper-burn.test' => Http::response([
        'result' => $receiptStatus === null ? null : ['status' => $receiptStatus],
    ])]);
    $failed = Process::result(errorOutput: 'receipt unavailable', exitCode: 1);
    $pending = Mockery::mock(PendingProcess::class);
    $pending->shouldReceive('env')->once()->andReturnSelf();
    $pending->shouldReceive('timeout')->once()->andReturnSelf();
    $pending->shouldReceive('run')->once()->andReturnUsing(function ($command, $output) use ($request, $stdout, $hash, $timeout, $failed) {
        expect($command[2])->toBe('scripts/relay-burn.ts');
        $output('out', substr($stdout, 0, 20));
        expect($request->fresh()->wrapper_burn_tx_hash)->toBeNull();
        $output('out', substr($stdout, 20));
        expect($request->fresh()->wrapper_burn_tx_hash)->toBe($hash);

        if ($timeout) {
            $process = new Symfony\Component\Process\Process(['true']);

            throw new ProcessTimedOutException(
                new Symfony\Component\Process\Exception\ProcessTimedOutException(
                    $process,
                    Symfony\Component\Process\Exception\ProcessTimedOutException::TYPE_GENERAL,
                ),
                new ProcessResult($process),
            );
        }

        return $failed;
    });
    Process::shouldReceive('path')->once()->andReturn($pending);

    $service = app(BridgeService::class);
    $succeeded = $receiptStatus === '0x1';

    expect($service->processDirectRelay($request))->toBe($succeeded)
        ->and($request->refresh()->wrapper_burn_tx_hash)->toBe($hash)
        ->and($request->wrapper_burned)->toBe($succeeded)
        ->and($request->status)->toBe($succeeded ? BridgeRequest::COMPLETED : BridgeRequest::BURN_PENDING);

    $service->processDirectRelay($request->refresh());
})->with([
    'failed process and unknown receipt' => [false, null],
    'failed process and mined receipt' => [false, '0x1'],
    'timeout and unknown receipt' => [true, null],
    'timeout and mined receipt' => [true, '0x1'],
]);

test('a failure before signing can retry only the burn', function () {
    $hash = '0x'.str_repeat('e', 64);
    $request = wrapperBurnRequest();
    Process::fake(['*relay-burn*' => Process::sequence([
        Process::result(errorOutput: 'insufficient gas', exitCode: 1),
        Process::result(output: json_encode(['txHash' => $hash])),
    ])]);
    Process::preventStrayProcesses();
    $service = app(BridgeService::class);

    expect($service->processDirectRelay($request))->toBeFalse()
        ->and($request->refresh()->status)->toBe(BridgeRequest::BURN_PENDING)
        ->and($request->wrapper_burn_tx_hash)->toBeNull()
        ->and($service->processDirectRelay($request->refresh()))->toBeTrue()
        ->and($request->refresh()->status)->toBe(BridgeRequest::COMPLETED)
        ->and($request->wrapper_burn_tx_hash)->toBe($hash)
        ->and($request->wrapper_burned)->toBeTrue();

    Process::assertRanTimes(fn ($process) => $process->command[2] === 'scripts/relay-burn.ts', 2);
    Http::assertNothingSent();
});

test('a wrapper burn cannot complete without a transaction hash', function () {
    $request = wrapperBurnRequest();
    Process::fake(['*relay-burn*' => Process::result()]);

    expect(app(BridgeService::class)->processDirectRelay($request))->toBeFalse()
        ->and($request->refresh()->status)->toBe(BridgeRequest::BURN_PENDING)
        ->and($request->wrapper_burn_tx_hash)->toBeNull()
        ->and($request->wrapper_burned)->toBeFalse();
});
