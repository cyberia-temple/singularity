<?php

namespace App\Services\Arena;

use DomainException;

/**
 * Paper portfolio across many tokens: cash in USD, a quantity and a cost basis
 * per token, all exact decimals (bcmath, 18 places). One order per round.
 */
class MultiLedger
{
    public const SCALE = 18;

    /** @return array{cash: string, positions: array<string, array{qty: string, cost: string}>} */
    public function initial(string $cash): array
    {
        return ['cash' => $cash, 'positions' => []];
    }

    /**
     * @param  array{cash: string, positions: array<string, array{qty: string, cost: string}>}  $state
     * @param  array{action: string, token: ?string, bps: int}  $decision
     * @param  array<string, string>  $prices  USD per whole token
     * @param  array{fee_bps: int, slippage_bps: int}  $costs
     * @return array{0: array{cash: string, positions: array<string, array{qty: string, cost: string}>}, 1: ?array<string, mixed>}
     */
    public function apply(array $state, array $decision, array $prices, array $costs): array
    {
        $action = $decision['action'];
        if ($action === 'hold') {
            return [$state, null];
        }
        $token = (string) $decision['token'];
        $price = $prices[$token] ?? null;
        if ($price === null) {
            throw new DomainException('token_unpriced');
        }
        $fraction = bcdiv((string) $decision['bps'], '10000', self::SCALE);
        if ($action === 'buy') {
            $spend = bcmul($state['cash'], $fraction, self::SCALE);
            if (bccomp($spend, '0.01', self::SCALE) < 0) {
                throw new DomainException('insufficient_cash');
            }
            $qty = bcdiv($this->afterCosts($spend, $costs), $price, self::SCALE);
            $position = $state['positions'][$token] ?? ['qty' => '0', 'cost' => '0'];
            $state['cash'] = bcsub($state['cash'], $spend, self::SCALE);
            $state['positions'][$token] = ['qty' => bcadd($position['qty'], $qty, self::SCALE), 'cost' => bcadd($position['cost'], $spend, self::SCALE)];

            return [$state, ['action' => 'buy', 'token' => $token, 'bps' => $decision['bps'], 'qty' => $qty, 'price' => $price, 'value' => $spend]];
        }
        $position = $state['positions'][$token] ?? null;
        if (! $position || bccomp($position['qty'], '0', self::SCALE) <= 0) {
            throw new DomainException('insufficient_position');
        }
        $qty = bcmul($position['qty'], $fraction, self::SCALE);
        $proceeds = $this->afterCosts(bcmul($qty, $price, self::SCALE), $costs);
        $basis = bcmul($position['cost'], $fraction, self::SCALE);
        $state['cash'] = bcadd($state['cash'], $proceeds, self::SCALE);
        $left = bcsub($position['qty'], $qty, self::SCALE);
        if (bccomp($left, '0', self::SCALE) <= 0) {
            unset($state['positions'][$token]);
        } else {
            $state['positions'][$token] = ['qty' => $left, 'cost' => bcsub($position['cost'], $basis, self::SCALE)];
        }

        return [$state, ['action' => 'sell', 'token' => $token, 'bps' => $decision['bps'], 'qty' => $qty, 'price' => $price,
            'value' => $proceeds, 'realized' => bcsub($proceeds, $basis, self::SCALE)]];
    }

    /**
     * Liquidation value: cash plus every position sold now after modeled costs.
     *
     * @param  array{cash: string, positions: array<string, array{qty: string, cost: string}>}  $state
     * @param  array<string, string>  $prices
     * @param  array{fee_bps: int, slippage_bps: int}  $costs
     */
    public function equity(array $state, array $prices, array $costs): string
    {
        $total = $state['cash'];
        foreach ($state['positions'] as $token => $position) {
            if (isset($prices[$token])) {
                $total = bcadd($total, $this->afterCosts(bcmul($position['qty'], $prices[$token], self::SCALE), $costs), self::SCALE);
            }
        }

        return $total;
    }

    /** @param array{fee_bps: int, slippage_bps: int} $costs */
    private function afterCosts(string $value, array $costs): string
    {
        $keep = bcdiv((string) ((10000 - $costs['fee_bps']) * (10000 - $costs['slippage_bps'])), '100000000', self::SCALE);

        return bcmul($value, $keep, self::SCALE);
    }
}
