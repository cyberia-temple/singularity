<?php

use App\Services\CyberPriceService;
use App\Services\WalletPriceService;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;

const FUJI_CHAIN_OPERATOR = '0x472725293d97dff80ea34c22840872832edbe8dc';
const FUJI_CHAIN_STRANGER = '0x3333333333333333333333333333333333333333';
const FUJI_CHAIN_TREASURY = '0x96cd117786ebc0fdbef56a6559feb2bd2bae3393';
const FUJI_CHAIN_MINTER = '0x386f2a822653f4af8a35774d3fbe80bf87adc71f';

function fujiWord(string|int $value): string
{
    $decimal = (string) $value;
    $hex = '';

    while (bccomp($decimal, '0') > 0) {
        $hex = dechex((int) bcmod($decimal, '16')).$hex;
        $decimal = bcdiv($decimal, '16', 0);
    }

    return str_pad($hex === '' ? '0' : $hex, 64, '0', STR_PAD_LEFT);
}

/**
 * The L1, the P-Chain and Ethereum, faked by method and by call data: what
 * the panel reads is dispatched on the precompile and its selector.
 */
function fakeFujiNetworks(bool $pchainUp = true): void
{
    Http::fake([
        'fuji.test/*' => function ($request) {
            $method = $request->data()['method'] ?? '';
            $params = $request->data()['params'] ?? [];
            $call = strtolower((string) ($params[0]['to'] ?? '')).':'.substr((string) ($params[0]['data'] ?? ''), 0, 10);
            $argument = '0x'.substr((string) ($params[0]['data'] ?? ''), -40);

            $result = match (true) {
                $method === 'eth_getBlockByNumber' => ['number' => '0x86', 'timestamp' => '0x6adc4e2a', 'baseFeePerGas' => '0x19945ca2620000'],
                $method === 'eth_gasPrice' => '0x19945ca2620001',
                $method === 'eth_getBalance' => '0x'.ltrim(fujiWord('1000000000000000000000'), '0'),
                $call === '0x0200000000000000000000000000000000000003:0x5fbbc0d2' => '0x'.implode('', array_map(fujiWord(...), [
                    20000000, 2, '7200000000000000', 60000000, 36, 0, 1000000, 200000,
                ])),
                $call === '0x0200000000000000000000000000000000000003:0x9e05549a' => '0x'.fujiWord(126),
                $call === '0x0200000000000000000000000000000000000004:0xe915608b' => '0x'.str_pad(substr(FUJI_CHAIN_TREASURY, 2), 64, '0', STR_PAD_LEFT),
                $call === '0x0200000000000000000000000000000000000004:0xf6542b2e' => '0x'.fujiWord(0),
                str_ends_with($call, ':0xeb54dae1') => '0x'.fujiWord(match ($argument) {
                    FUJI_CHAIN_OPERATOR => 2,
                    FUJI_CHAIN_MINTER => 1,
                    default => 0,
                }),
                default => null,
            };

            return Http::response(['jsonrpc' => '2.0', 'id' => 1, 'result' => $result]);
        },
        'pchain.test/*' => function ($request) use ($pchainUp) {
            if (! $pchainUp) {
                return Http::response('down', 502);
            }

            return Http::response(['jsonrpc' => '2.0', 'id' => 1, 'result' => match ($request->data()['method'] ?? '') {
                'platform.getL1Validator' => ['nodeID' => 'NodeID-test', 'balance' => '86400000'],
                'platform.getValidatorFeeState' => ['price' => 1000, 'excess' => 0],
                default => null,
            }]);
        },
        'eth.test/*' => Http::response(['jsonrpc' => '2.0', 'id' => 1, 'result' => '0x2faf080']),
    ]);
}

beforeEach(function () {
    config()->set('bridge.chains.cyberia_fuji.rpc_url', 'https://fuji.test/rpc');
    config()->set('fuji.chain.pchain_rpc_url', 'https://pchain.test/ext/bc/P');
    config()->set('fuji.chain.ethereum_rpc_url', 'https://eth.test/rpc');
    config()->set('fuji.treasury', FUJI_CHAIN_TREASURY);
    config()->set('fuji.chain.operator', FUJI_CHAIN_OPERATOR);
    config()->set('fuji.faucet.private_key', '');
    config()->set('services.bridge.relayer_address', '0x4444444444444444444444444444444444444444');

    $this->mock(CyberPriceService::class, fn ($mock) => $mock->shouldReceive('get')->andReturn(['priceUsd' => '0.00002']));
    $this->mock(WalletPriceService::class, fn ($mock) => $mock->shouldReceive('quotes')->andReturn(['prices' => ['base' => 2000.0]]));

    Cache::flush();
});

it('reads the fee rules, where fees go, who may mint and the validator runway from the chain', function () {
    fakeFujiNetworks();

    $this->getJson('/api/fuji/chain')
        ->assertOk()
        ->assertJsonPath('chainId', 49407)
        ->assertJsonPath('block.number', 134)
        ->assertJsonPath('block.baseFee', '7200000000000000')
        ->assertJsonPath('gasPrice', '7200000000000001')
        ->assertJsonPath('feeConfig.minBaseFee', '7200000000000000')
        ->assertJsonPath('feeConfig.baseFeeChangeDenominator', '36')
        ->assertJsonPath('feeConfigChangedAt', 126)
        ->assertJsonPath('rewards.address', FUJI_CHAIN_TREASURY)
        ->assertJsonPath('rewards.feeRecipientsAllowed', false)
        ->assertJsonPath('treasury.balance', '1000000000000000000000')
        ->assertJsonPath('minters.0.role', 1)
        // 86,400,000 nAVAX at 1,000 nAVAX a second is a day.
        ->assertJsonPath('validator.balance', '86400000')
        ->assertJsonPath('validator.secondsLeft', 86400)
        ->assertJsonPath('wallets.0.key', 'bridge')
        ->assertJsonPath('wallets.2.key', 'operator')
        ->assertJsonPath('wallets.2.address', FUJI_CHAIN_OPERATOR)
        ->assertJsonMissingPath('roles');
});

/**
 * Ethereum gas 50,000,000 wei × $2,000 ÷ $0.00002 per CYBER: the minimum base
 * fee at which a CYBER transfer costs what an ETH transfer costs.
 */
it('does not label a configured address as admin without an on-chain admin role', function () {
    fakeFujiNetworks();
    config()->set('fuji.chain.operator', FUJI_CHAIN_STRANGER);

    $this->getJson('/api/fuji/chain')
        ->assertOk()
        ->assertJsonMissing(['key' => 'operator']);
});

it('works out the minimum base fee that prices a transfer like Ethereum', function () {
    fakeFujiNetworks();

    $this->getJson('/api/fuji/chain')
        ->assertOk()
        ->assertJsonPath('pricing.ethGasPrice', '50000000')
        ->assertJsonPath('pricing.parityMinBaseFee', '5000000000000000');
});

it('names the roles an address holds, which is what decides whether the controls show', function () {
    fakeFujiNetworks();

    $this->getJson('/api/fuji/chain?address='.FUJI_CHAIN_OPERATOR)
        ->assertOk()
        ->assertJsonPath('roles.feeManager', 2)
        ->assertJsonPath('roles.rewardManager', 2);

    $this->getJson('/api/fuji/chain?address='.FUJI_CHAIN_STRANGER)
        ->assertOk()
        ->assertJsonPath('roles.feeManager', 0)
        ->assertJsonPath('roles.rewardManager', 0);
});

it('still answers when the P-Chain does not, and says the runway is unknown', function () {
    fakeFujiNetworks(pchainUp: false);

    $this->getJson('/api/fuji/chain')
        ->assertOk()
        ->assertJsonPath('validator', null)
        ->assertJsonPath('feeConfig.minBaseFee', '7200000000000000');
});

it('rejects an address that is not one', function () {
    $this->getJson('/api/fuji/chain?address=nope')->assertUnprocessable();
});
