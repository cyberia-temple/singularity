<?php

use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

/**
 * Cross-chain swaps: the fee, and the shape of what a browser is handed.
 *
 * The whole reason this route exists rather than the browser calling the
 * router directly is that Cyberia's fee is a field in the quote request, and a
 * field a browser writes is a field a browser can delete. So the tests that
 * matter most here are about who gets to write that field, and about the app
 * never claiming a fee the router did not actually apply.
 */
const CROSS_API = 'https://router.test';
const CROSS_FEE_ADDRESS = '0x1111111111111111111111111111111111111111';

function crossChains(): array
{
    return [
        'chains' => [
            [
                'id' => 8453,
                'displayName' => 'Base',
                'currency' => ['symbol' => 'ETH', 'decimals' => 18],
                'vmType' => 'evm',
                'explorerUrl' => 'https://basescan.org',
                'tokenSupport' => 'All',
                'depositEnabled' => true,
            ],
            [
                'id' => 792703809,
                'displayName' => 'Solana',
                'currency' => ['symbol' => 'SOL', 'decimals' => 9],
                'vmType' => 'svm',
                'explorerUrl' => 'https://solscan.io',
                'tokenSupport' => 'All',
                'depositEnabled' => true,
            ],
            [
                'id' => 99999,
                'displayName' => 'Paused Chain',
                'currency' => ['symbol' => 'PAU', 'decimals' => 18],
                'vmType' => 'evm',
                'disabled' => true,
            ],
        ],
    ];
}

/** A quote in the shape the live router answers with. */
function crossQuote(array $overrides = []): array
{
    return array_replace_recursive([
        'requestId' => '0xabc',
        'steps' => [[
            'id' => 'deposit',
            'description' => 'Depositing funds',
            'items' => [[
                'status' => 'incomplete',
                'data' => [
                    'from' => '0x2222222222222222222222222222222222222222',
                    'to' => '0x4cd00e387622c35bddb9b4c962c136462338bc31',
                    'data' => '0x49290c1c',
                    'value' => '10000000000000000',
                    'chainId' => 8453,
                    'gas' => '32713',
                    'maxFeePerGas' => '6500000',
                    'maxPriorityFeePerGas' => '1000000',
                ],
                'check' => ['endpoint' => '/intents/status', 'method' => 'GET'],
            ]],
        ]],
        'fees' => [
            'app' => [
                'currency' => ['chainId' => 8453, 'address' => '0x0', 'symbol' => 'ETH', 'decimals' => 18],
                'amount' => '75000000000000',
                'amountUsd' => '0.18',
            ],
            'relayer' => [
                'currency' => ['chainId' => 8453, 'address' => '0x0', 'symbol' => 'ETH', 'decimals' => 18],
                'amount' => '9467784820251',
                'amountUsd' => '0.02',
            ],
            'gas' => [
                'currency' => ['chainId' => 8453, 'address' => '0x0', 'symbol' => 'ETH', 'decimals' => 18],
                'amount' => '164107885132',
                'amountUsd' => '0.0004',
            ],
        ],
        'details' => [
            'currencyIn' => [
                'currency' => ['chainId' => 8453, 'address' => '0x0', 'symbol' => 'ETH', 'decimals' => 18],
                'amount' => '10000000000000000',
                'amountUsd' => '25.13',
            ],
            'currencyOut' => [
                'currency' => ['chainId' => 792703809, 'address' => '11111111111111111111111111111111', 'symbol' => 'SOL', 'decimals' => 9],
                'amount' => '225034122',
                'minimumAmount' => '220533440',
                'amountUsd' => '24.92',
            ],
            'timeEstimate' => 12,
            'slippageTolerance' => ['total' => '200'],
            'totalImpact' => ['percent' => '-1.14'],
        ],
    ], $overrides);
}

function crossPayload(array $overrides = []): array
{
    return array_replace([
        'originChainId' => 8453,
        'destinationChainId' => 792703809,
        'originCurrency' => '0x0000000000000000000000000000000000000000',
        'destinationCurrency' => '11111111111111111111111111111111',
        'user' => '0x2222222222222222222222222222222222222222',
        'recipient' => 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        'amount' => '10000000000000000',
    ], $overrides);
}

beforeEach(function () {
    Cache::flush();
    config()->set('crosschain.enabled', true);
    config()->set('crosschain.api', CROSS_API);
    config()->set('crosschain.referrer', 'cyberia.church');
    config()->set('crosschain.fee.address', CROSS_FEE_ADDRESS);
    config()->set('crosschain.fee.bps', 75);
    config()->set('crosschain.fee.max_bps', 300);

    // The answers live in the container rather than in the stub, so a test can
    // change what the router says without re-registering a fake — a second
    // `Http::fake()` only adds stubs, and the first match keeps winning.
    app()->instance('cross.quote', crossQuote());
    app()->instance('cross.quote.status', 200);
    app()->instance('cross.status', [
        'status' => 'success',
        'inTxHashes' => ['0xin'],
        'txHashes' => ['0xout'],
    ]);

    Http::fake([
        CROSS_API.'/chains' => Http::response(crossChains()),
        CROSS_API.'/quote' => fn () => Http::response(
            app('cross.quote'),
            app('cross.quote.status'),
        ),
        CROSS_API.'/intents/status*' => fn () => Http::response(app('cross.status')),
    ]);
});

it('says what it charges before an amount is typed', function () {
    $this->getJson('/api/wallet/crosschain')
        ->assertOk()
        ->assertJsonPath('enabled', true)
        ->assertJsonPath('fee.address', CROSS_FEE_ADDRESS)
        ->assertJsonPath('fee.bps', 75);
});

it('drops a chain the router has switched off', function () {
    $body = $this->getJson('/api/wallet/crosschain')->json('chains');

    expect(collect($body)->pluck('id')->all())->not->toContain(99999)
        ->and(collect($body)->pluck('id')->all())->toContain(8453, 792703809);
});

it('puts Cyberia’s fee into every quote it asks for', function () {
    $this->postJson('/api/wallet/crosschain/quote', crossPayload())->assertOk();

    Http::assertSent(function (Request $request) {
        if (! str_ends_with($request->url(), '/quote')) {
            return false;
        }

        return $request['appFees'] === [[
            'recipient' => CROSS_FEE_ADDRESS,
            'fee' => '75',
        ]] && $request['tradeType'] === 'EXACT_INPUT';
    });
});

it('sends no referrer, because one costs the whole quote', function () {
    $this->postJson('/api/wallet/crosschain/quote', crossPayload())->assertOk();

    // Relay put referrer attribution behind an API key and answers a quote
    // carrying one with UNAUTHORIZED_QUOTE — it fails the quote rather than
    // ignoring the field, so every swap this host asked for was failing. The
    // fee needs no key and stays.
    Http::assertSent(fn (Request $request) => ! str_ends_with($request->url(), '/quote')
        || ! array_key_exists('referrer', $request->data()));
});

it('never takes the fee from the browser', function () {
    $this->postJson('/api/wallet/crosschain/quote', crossPayload([
        'appFees' => [['recipient' => '0x9999999999999999999999999999999999999999', 'fee' => '0']],
        'referrer' => 'somebody-else',
    ]))->assertOk();

    Http::assertSent(function (Request $request) {
        if (! str_ends_with($request->url(), '/quote')) {
            return false;
        }

        // Composed here from config, never read back from what was posted —
        // and a referrer the browser supplies is dropped with everything else
        // this host does not send.
        return $request['appFees'][0]['recipient'] === CROSS_FEE_ADDRESS
            && $request['appFees'][0]['fee'] === '75'
            && ! array_key_exists('referrer', $request->data());
    });
});

it('asks for no fee at all when no address is configured', function () {
    config()->set('crosschain.fee.address', '');

    $this->postJson('/api/wallet/crosschain/quote', crossPayload())
        ->assertOk()
        ->assertJsonPath('quote.feeRequested', false);

    Http::assertSent(fn (Request $request) => ! str_ends_with($request->url(), '/quote')
        || ! array_key_exists('appFees', $request->data()));

    $this->getJson('/api/wallet/crosschain')->assertJsonPath('fee.bps', 0);
});

it('will not send more than the ceiling however the environment is set', function () {
    config()->set('crosschain.fee.bps', 5000);

    $this->postJson('/api/wallet/crosschain/quote', crossPayload())->assertOk();

    Http::assertSent(fn (Request $request) => ! str_ends_with($request->url(), '/quote')
        || $request['appFees'][0]['fee'] === '300');
});

it('reports the fee the router applied, not the one that was asked for', function () {
    $this->postJson('/api/wallet/crosschain/quote', crossPayload())
        ->assertOk()
        ->assertJsonPath('quote.feeRequested', true)
        ->assertJsonPath('quote.feeApplied', true)
        ->assertJsonPath('quote.fees.app.amount', '75000000000000');

    app()->instance('cross.quote', crossQuote(['fees' => ['app' => null]]));

    $this->postJson('/api/wallet/crosschain/quote', crossPayload())
        ->assertOk()
        ->assertJsonPath('quote.feeRequested', true)
        // Asked for and not charged is a fact about the route, and it travels.
        ->assertJsonPath('quote.feeApplied', false);
});

it('hands the browser one transaction per step and nothing else', function () {
    $step = $this->postJson('/api/wallet/crosschain/quote', crossPayload())
        ->assertOk()
        ->json('quote.steps.0');

    expect($step['id'])->toBe('deposit')
        ->and($step['items'][0])->toBe([
            'chainId' => 8453,
            'to' => '0x4cd00e387622c35bddb9b4c962c136462338bc31',
            'data' => '0x49290c1c',
            'value' => '10000000000000000',
            'gas' => '32713',
            'maxFeePerGas' => '6500000',
            'maxPriorityFeePerGas' => '1000000',
        ]);
});

it('keeps every amount a string, decimals beside it', function () {
    $quote = $this->postJson('/api/wallet/crosschain/quote', crossPayload())
        ->assertOk()
        ->json('quote');

    expect($quote['in']['amount'])->toBe('10000000000000000')
        ->and($quote['out']['minimum'])->toBe('220533440')
        ->and($quote['out']['decimals'])->toBe(9)
        ->and($quote['timeEstimate'])->toBe(12)
        ->and($quote['slippageBps'])->toBe(200);
});

it('refuses an origin leg this wallet could never sign', function () {
    $this->postJson('/api/wallet/crosschain/quote', crossPayload([
        'originChainId' => 792703809,
        'destinationChainId' => 8453,
        'originCurrency' => '11111111111111111111111111111111',
        'destinationCurrency' => '0x0000000000000000000000000000000000000000',
        'recipient' => '0x2222222222222222222222222222222222222222',
    ]))
        ->assertStatus(422)
        ->assertJsonPath('error', 'The wallet can only start a cross-chain swap from an EVM network.');

    Http::assertNotSent(fn (Request $request) => str_ends_with($request->url(), '/quote'));
});

it('refuses a network the router does not serve', function () {
    $this->postJson('/api/wallet/crosschain/quote', crossPayload(['destinationChainId' => 4242]))
        ->assertStatus(422)
        ->assertJsonPath('error', 'This router does not serve the destination network.');
});

it('repeats the router’s own refusal rather than flattening it', function () {
    app()->instance('cross.quote', ['message' => 'Amount is too low']);
    app()->instance('cross.quote.status', 400);

    $this->postJson('/api/wallet/crosschain/quote', crossPayload())
        ->assertStatus(422)
        ->assertJsonPath('error', 'Amount is too low');
});

it('refuses an amount that is not a whole number of units', function () {
    $this->postJson('/api/wallet/crosschain/quote', crossPayload(['amount' => '0.01']))
        ->assertStatus(422);

    $this->postJson('/api/wallet/crosschain/quote', crossPayload(['user' => 'not-an-address']))
        ->assertStatus(422);
});

it('passes the router’s own word for where a swap has got to', function () {
    $this->getJson('/api/wallet/crosschain/status?id=0xabc')
        ->assertOk()
        ->assertJsonPath('status', 'success')
        ->assertJsonPath('transactions.0', ['side' => 'in', 'hash' => '0xin'])
        ->assertJsonPath('transactions.1', ['side' => 'out', 'hash' => '0xout']);
});

it('goes quiet when the host switches it off', function () {
    config()->set('crosschain.enabled', false);

    $this->getJson('/api/wallet/crosschain')
        ->assertOk()
        ->assertJsonPath('enabled', false)
        ->assertJsonPath('chains', []);

    $this->postJson('/api/wallet/crosschain/quote', crossPayload())
        ->assertStatus(422)
        ->assertJsonPath('error', 'Cross-chain swaps are switched off on this host.');
});
