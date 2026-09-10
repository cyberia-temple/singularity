<?php

namespace App\Console\Commands;

use App\Services\CrosschainRouter;
use App\Services\TelegramOpsNotifier;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;
use Throwable;

/**
 * What the wallet's routed swaps have earned, and a shout when it is worth claiming.
 *
 * The fee on a routed swap is taken *along the route*, by the router, out of
 * the input — there is no leg of our own and no key of ours in the path. What
 * that buys in safety it costs in visibility: the money does not land in a
 * wallet anybody watches, and it does not land per chain. It accrues as one
 * off-chain USDC balance held against the EVM address in
 * `CROSSCHAIN_FEE_ADDRESS`, and it sits there until a person withdraws it.
 *
 * So the failure mode this command exists for is not "the fee stopped
 * working". It is a fee that works perfectly for a year while nobody knows
 * there is anything to collect. Reads only — withdrawing needs the key for
 * that address, which this host does not have and should not.
 */
#[Signature('crosschain:fees {--alert : Tell the operator when there is enough to claim}')]
#[Description('Show the app-fee balance the wallet’s routed swaps have accrued')]
class CrosschainFeesCommand extends Command
{
    /** Days between repeats: there is nothing urgent about money sitting still. */
    private const ALERT_SILENCE_DAYS = 7;

    public function handle(CrosschainRouter $router, TelegramOpsNotifier $telegram): int
    {
        if (! $router->enabled()) {
            $this->warn('Cross-chain routing is switched off on this host.');

            return self::SUCCESS;
        }

        $address = $router->feeAddress();

        if ($address === null) {
            $this->warn('No fee is being asked for.');
            $this->line('  CROSSCHAIN_FEE_ADDRESS is unset, or CROSSCHAIN_FEE_BPS is zero.');
            $this->line('  Both halves are required: an address with no size and a size with no');
            $this->line('  address are the same thing, and every screen says so rather than');
            $this->line('  showing a number nobody collects.');

            return self::SUCCESS;
        }

        try {
            $balance = $router->appFeeBalance();
        } catch (Throwable $error) {
            // An unreadable balance says nothing about whether the fee is
            // being collected — the router is still taking it either way.
            $this->error('The router would not answer: '.$error->getMessage());

            return self::FAILURE;
        }

        if ($balance === null) {
            $this->error('The router answered nothing.');

            return self::FAILURE;
        }

        $this->line('Claim address: '.$address.'  ('.$router->feeBps().' bps of every routed swap)');
        $this->line('Claimable now: $'.number_format($balance['available'], 2));
        $this->line('Total accrued: $'.number_format($balance['total'], 2)
            .($balance['pending'] > 0
                ? '  (of which $'.number_format($balance['pending'], 2).' is still settling)'
                : ''));

        foreach ($balance['currencies'] as $row) {
            $this->line('  · '.($row['currency']['symbol'] ?? '?')
                .' '.($row['amountFormatted'] ?? $row['amount'] ?? '0')
                .'  $'.number_format((float) ($row['amountUsd'] ?? 0), 2));
        }

        if ($balance['available'] <= 0) {
            $this->line('');
            $this->line('Nothing to claim yet. The fee accrues per swap and settles after the fill.');

            return self::SUCCESS;
        }

        $this->line('');
        $this->line('Claim at https://relay.link/app-balance, signed in as the claim address.');
        $this->line('Free on Base; any other chain or currency costs the router’s own fee.');

        $threshold = (float) config('crosschain.fee.claim_alert_usd', 25);

        if ($this->option('alert') && $balance['available'] >= $threshold) {
            $this->notifyOperator($telegram, $address, $balance);
        }

        return self::SUCCESS;
    }

    /**
     * @param  array{available: float, total: float, pending: float, currencies: array<int, array<string, mixed>>}  $balance
     */
    private function notifyOperator(
        TelegramOpsNotifier $telegram,
        string $address,
        array $balance,
    ): void {
        // Once a week at most. This is a reminder to go and collect money, not
        // an incident, and an hourly one would be muted inside a day.
        $key = 'crosschain.fees:alerted';

        if (Cache::has($key)) {
            return;
        }

        $sent = $telegram->send(
            "💸 <b>Комиссия кошелька ждёт вывода</b>\n\n"
            .'К выводу: <b>$'.number_format($balance['available'], 2)."</b>\n"
            .'Всего накоплено: $'.number_format($balance['total'], 2)."\n"
            .'Адрес: <code>'.e($address)."</code>\n\n"
            .'Забрать: https://relay.link/app-balance — на Base бесплатно.',
        );

        if ($sent) {
            Cache::put($key, true, now()->addDays(self::ALERT_SILENCE_DAYS));
        }
    }
}
