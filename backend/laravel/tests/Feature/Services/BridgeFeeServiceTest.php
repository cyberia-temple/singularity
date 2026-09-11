<?php

use App\Services\BridgeFeeService;
use App\Services\CyberPriceService;
use Illuminate\Support\Facades\Http;

beforeEach(function () {
    config()->set('bridge.fee.flat_usd', '0.10');
    config()->set('bridge.fee.rate_bps', 0);
});

test('USDC fee is denominated in USD (price = 1)', function () {
    $service = new BridgeFeeService(new CyberPriceService);
    $result = $service->feeForBridge('USDC', '100');

    expect($result['fee_usd'])->toBe('0.10');
    expect($result['fee_amount'])->toContain('0.1');
    expect($result['token_price_usd'])->toBe('1');
});

test('USDT fee is denominated in USD', function () {
    $service = new BridgeFeeService(new CyberPriceService);
    $result = $service->feeForBridge('USDT', '500');

    expect($result['fee_usd'])->toBe('0.10');
    expect($result['fee_amount'])->toContain('0.1');
});

test('USDG charges the larger of the flat and percentage stablecoin fees', function () {
    $service = app(BridgeFeeService::class);

    expect($service->isFeeBearing('USDG'))->toBeTrue();
    $flat = $service->feeForBridge('USDG', '5');
    expect($flat['token_price_usd'])->toBe('1')
        ->and($flat['fee_amount'])->toBe('0.100000000000000000');

    config()->set('bridge.fee.rate_bps', 100);
    $rate = $service->feeForBridge('USDG', '1000');
    expect($rate['fee_amount'])->toBe('10.000000000000000000');
});

test('flat USD fee combined with rate takes the maximum', function () {
    config()->set('bridge.fee.flat_usd', '0.10');
    config()->set('bridge.fee.rate_bps', 100); // 1%

    $service = new BridgeFeeService(new CyberPriceService);

    // For amount 5 USDC, 1% = $0.05, but flat is $0.10 — flat wins
    $small = $service->feeForBridge('USDC', '5');
    expect($small['fee_usd'])->toBe('0.10');

    // For amount 1000 USDC, 1% = $10 — rate wins
    $large = $service->feeForBridge('USDC', '1000');
    expect((float) $large['fee_usd'])->toEqual(10.0);
});

test('CYBER.sol bridges are fee-free regardless of amount', function () {
    $service = new BridgeFeeService(new CyberPriceService);

    $small = $service->feeForBridge('CYBER.sol', '1');
    expect($small['fee_usd'])->toBe('0');
    expect($small['fee_amount'])->toBe('0');

    $large = $service->feeForBridge('CYBER.sol', '1000000');
    expect($large['fee_usd'])->toBe('0');
    expect($large['fee_amount'])->toBe('0');
});

test('isFeeBearing reports correctly per token', function () {
    $service = new BridgeFeeService(new CyberPriceService);

    expect($service->isFeeBearing('USDC'))->toBeTrue();
    expect($service->isFeeBearing('USDT'))->toBeTrue();
    expect($service->isFeeBearing('CYBER.sol'))->toBeFalse();
});

test('native BNB payout fee reserves destination gas with a safety margin', function () {
    config()->set('bridge.fee.native_transfer_gas_limit', 21000);
    config()->set('bridge.fee.native_gas_price_floor_gwei', '3');
    config()->set('bridge.fee.native_gas_multiplier_bps', 20000);

    Http::fake([
        '*' => Http::response(['result' => '0x29b92700']), // 0.7 gwei; floor wins
    ]);

    $service = new BridgeFeeService(new CyberPriceService);
    $result = $service->feeForBridge('BNB', '1', 'evm_to_bnb');

    expect($result['fee_amount'])->toBe('0.000126000000000000');
    expect($result['fee_usd'])->toBe('0');
});

test('native ETH payout fee reserves Base gas (unified ETH wrapper)', function () {
    config()->set('bridge.fee.native_transfer_gas_limit', 21000);
    config()->set('bridge.fee.native_gas_price_floor_gwei', '3');
    config()->set('bridge.fee.native_gas_multiplier_bps', 20000);

    Http::fake([
        '*' => Http::response(['result' => '0x29b92700']), // 0.7 gwei; floor wins
    ]);

    $service = new BridgeFeeService(new CyberPriceService);
    $result = $service->feeForBridge('ETH', '1', 'evm_to_base');

    expect($result['fee_amount'])->toBe('0.000126000000000000');
    expect($result['fee_usd'])->toBe('0');

    // And the frontend fee table must advertise it on the evm_to_base route.
    $fees = $service->frontendNativeFees();
    expect($fees['evm_to_base']['ETH'] ?? null)->not->toBeNull();
    expect($fees['evm_to_base']['ETH'])->toBeGreaterThan(0.0);
});

test('evm_to_yenten payouts retain the flat YTN fee', function () {
    config()->set('bridge.fee.yenten_payout_fee_ytn', '0.01');

    $service = new BridgeFeeService(new CyberPriceService);
    $result = $service->feeForBridge('YTN', '2', 'evm_to_yenten');

    expect($result['fee_amount'])->toBe('0.01');
    expect($result['fee_usd'])->toBe('0');
});

test('yenten_to_evm mints stay fee-free', function () {
    config()->set('bridge.fee.yenten_payout_fee_ytn', '0.01');

    $service = new BridgeFeeService(new CyberPriceService);

    expect($service->nativePayoutFee('yenten_to_evm', 'YTN'))->toBe('0');
    expect($service->feeForBridge('YTN', '2', 'yenten_to_evm')['fee_amount'])->toBe('0');
});

test('frontend native fees include the Yenten payout route', function () {
    config()->set('bridge.fee.yenten_payout_fee_ytn', '0.01');

    $service = new BridgeFeeService(new CyberPriceService);
    $fees = $service->frontendNativeFees();

    expect($fees['evm_to_yenten']['YTN'])->toBe(0.01);
    expect($fees)->not->toHaveKey('yenten_to_evm');
});

test('native BNB payout fee follows a live gas-price spike', function () {
    config()->set('bridge.fee.native_transfer_gas_limit', 21000);
    config()->set('bridge.fee.native_gas_price_floor_gwei', '3');
    config()->set('bridge.fee.native_gas_multiplier_bps', 20000);

    Http::fake([
        '*' => Http::response(['result' => '0x12a05f200']), // 5 gwei
    ]);

    $service = new BridgeFeeService(new CyberPriceService);

    expect($service->nativePayoutFee('evm_to_bnb', 'BNB'))
        ->toBe('0.000210000000000000');
});
