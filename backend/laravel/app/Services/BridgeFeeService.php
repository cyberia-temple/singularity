<?php

namespace App\Services;

use App\Support\TokenAmount;
use Illuminate\Support\Facades\Http;

class BridgeFeeService
{
    public function __construct(
        private CyberPriceService $cyberPrice,
    ) {}

    /**
     * Compute the bridge fee for a given token + amount, denominated in USD
     * and expressed in token units. Returns [feeAmountToken, feeUsd, tokenPriceUsd].
     *
     * CYBER.sol bridges are fee-free by policy — only USD-pegged stablecoins
     * (USDC/USDT/USDG/JupUSD) carry the bridge fee.
     */
    public function feeForBridge(string $token, string $amount, ?string $direction = null): array
    {
        $price = $this->priceUsd($token);
        $feeUsd = '0';
        $feeAmount = '0';

        if ($this->isFeeBearing($token)) {
            $amountUsd = bcmul($amount, $price, 8);
            $flatUsd = (string) config('bridge.fee.flat_usd', '0.10');
            $rateBps = (int) config('bridge.fee.rate_bps', 0);
            $rateUsd = bcdiv(bcmul($amountUsd, (string) $rateBps, 8), '10000', 8);

            // max(flat, rate*amount)
            $feeUsd = bccomp($flatUsd, $rateUsd, 8) >= 0 ? $flatUsd : $rateUsd;
            $feeAmount = bccomp($price, '0', 8) > 0
                ? bcdiv($feeUsd, $price, 18)
                : '0';
        }

        $nativeGasFee = $direction
            ? $this->nativePayoutFee($direction, $token)
            : '0';

        if (bccomp($nativeGasFee, $feeAmount, 18) > 0) {
            $feeAmount = $nativeGasFee;
        }

        return [
            'fee_amount' => $feeAmount,
            'fee_usd' => $feeUsd,
            'token_price_usd' => $price,
        ];
    }

    /**
     * Fee retained from a native-coin payout to cover the destination network
     * fee (EVM gas, TON message fee, Yenten transaction fee, Monero ring
     * signature). EVM quotes use the larger of the configured gas-price floor
     * and the live RPC price, then apply a safety multiplier for price
     * movement; TON, Yenten and Monero use flat configured amounts.
     */
    public function nativePayoutFee(string $direction, string $token, bool $live = true): string
    {
        $route = config('bridge.routes', [])[$direction] ?? null;

        if (! is_array($route)) {
            return '0';
        }

        $chainKey = (string) ($route['destination_chain'] ?? '');
        $chain = config('bridge.chains', [])[$chainKey] ?? null;
        $tokenConfig = config('bridge.tokens', [])[$token] ?? null;
        $tokenEntry = is_array($tokenConfig)
            ? ($tokenConfig['chains'][$chainKey] ?? null)
            : null;

        if (! is_array($chain)
            || ! is_array($tokenEntry)
            || ! ($tokenEntry['native'] ?? false)) {
            return '0';
        }

        if (($chain['type'] ?? null) === 'yenten') {
            return (string) config('bridge.fee.yenten_payout_fee_ytn', '0.01');
        }

        if (($chain['type'] ?? null) === 'ton') {
            return (string) config('bridge.fee.ton_payout_fee_ton', '0.01');
        }

        // Monero charges its fee to the sender on top of the amount sent, so
        // the recipient gets the net figure exactly and this reserve is what
        // pays the wallet back for the transaction that delivered it.
        if (($chain['type'] ?? null) === 'monero') {
            return (string) config('bridge.fee.monero_payout_fee_xmr', '0.0005');
        }

        // A native EVM payout: the token's destination entry is flagged native
        // (checked above), so the payout IS this chain's native coin regardless
        // of the wrapper's symbol. Do NOT gate on native_currency symbol ==
        // token — a wrapper whose symbol differs from the chain's native coin
        // (e.g. the unified ETH wrapper paying native ETH on Base) would
        // otherwise wrongly get a zero gas reserve.
        if (($chain['type'] ?? null) !== 'evm') {
            return '0';
        }

        $floorWei = bcmul(
            (string) config('bridge.fee.native_gas_price_floor_gwei', '3'),
            '1000000000',
            0,
        );
        $gasPriceWei = $floorWei;

        if ($live && ! empty($chain['rpc_url'])) {
            try {
                $response = Http::timeout(5)->post((string) $chain['rpc_url'], [
                    'jsonrpc' => '2.0',
                    'id' => 1,
                    'method' => 'eth_gasPrice',
                    'params' => [],
                ]);
                $hex = $response->json('result');

                if ($response->successful() && is_string($hex)) {
                    $quotedWei = TokenAmount::hexToDec($hex);

                    if (bccomp($quotedWei, $gasPriceWei, 0) > 0) {
                        $gasPriceWei = $quotedWei;
                    }
                }
            } catch (\Throwable) {
                // The configured floor remains the safe fallback.
            }
        }

        $gasLimit = (string) config('bridge.fee.native_transfer_gas_limit', 21000);
        $multiplierBps = (string) config('bridge.fee.native_gas_multiplier_bps', 20000);
        $feeRaw = bcdiv(
            bcmul(bcmul($gasPriceWei, $gasLimit, 0), $multiplierBps, 0),
            '10000',
            0,
        );

        return TokenAmount::fromRaw($feeRaw, (int) ($tokenEntry['decimals'] ?? 18));
    }

    /** @return array<string, array<string, float>> */
    public function frontendNativeFees(): array
    {
        $fees = [];

        foreach (config('bridge.routes', []) as $direction => $route) {
            foreach (config('bridge.tokens', []) as $token => $tokenConfig) {
                // Only tokens that actually ride this route: a token with no
                // entry on the source chain (e.g. CYBER on Yenten) must not
                // leak a fee for a corridor it can never use.
                if (! isset($tokenConfig['chains'][$route['source_chain'] ?? ''])) {
                    continue;
                }

                $fee = $this->nativePayoutFee((string) $direction, (string) $token, false);

                if (bccomp($fee, '0', 18) > 0) {
                    $fees[(string) $direction][(string) $token] = (float) $fee;
                }
            }
        }

        return $fees;
    }

    /**
     * Only tokens flagged fee_bearing in config/bridge.php pay the bridge fee
     * (USD-pegged stablecoins).
     */
    public function isFeeBearing(string $token): bool
    {
        $config = config('bridge.tokens', [])[$token] ?? null;

        return (bool) ($config['fee_bearing'] ?? false);
    }

    /**
     * USD price for a supported token. Stablecoins return '1', CYBER.sol uses
     * the DexScreener price feed. Falls back to '0' on lookup failure.
     */
    public function priceUsd(string $token): string
    {
        if (in_array($token, ['USDC', 'USDT', 'USDG', 'JupUSD'], true)) {
            return '1';
        }

        if ($token === 'CYBER.sol') {
            $data = $this->cyberPrice->get();
            $price = $data['priceUsd'] ?? null;

            return $price !== null ? (string) $price : '0';
        }

        return '0';
    }
}
