<?php

namespace App\Console\Commands;

use App\Models\ReferralPayout;
use App\Models\ReferralReward;
use App\Services\ReferralService;
use App\Services\TelegramOpsNotifier;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use RuntimeException;

/**
 * The weekly referral payout, with a person at every step that moves money.
 *
 *   referrals:payouts                       what is owed and what is waiting
 *   referrals:payouts --prepare [--notify]  bundle unscheduled earnings, one payout per inviter
 *   referrals:payouts --approve=ID          a person says yes
 *   referrals:payouts --paid=ID --tx=REF    the transfer was made; record it
 *   referrals:payouts --cancel=ID           not sending it; its earnings wait for next week
 *
 * Nothing here sends a transfer. The money is the router's app-fee balance,
 * claimed and sent by whoever holds the fee address's key — this host does not
 * and should not. The schedule only prepares and tells the operator.
 */
#[Signature('referrals:payouts
    {--prepare : Bundle unscheduled earnings into pending payouts}
    {--notify : With --prepare, tell the operator in Telegram}
    {--approve= : Approve a pending payout by id}
    {--paid= : Mark an approved payout as sent, by id}
    {--tx= : With --paid, the transfer hash or reference}
    {--cancel= : Cancel a payout that was not sent, by id}')]
#[Description('Prepare, approve and record referral payouts')]
class ReferralsPayoutsCommand extends Command
{
    public function handle(ReferralService $referrals, TelegramOpsNotifier $telegram): int
    {
        try {
            if ($this->option('approve') !== null) {
                $payout = $referrals->approve($this->payout('approve'));
                $this->info('Approved #'.$payout->getKey().' — $'.number_format((float) $payout->amount_usd, 2)
                    .' to '.($payout->referrer?->wallet_address ?? 'an account with no EVM address'));

                return self::SUCCESS;
            }

            if ($this->option('paid') !== null) {
                $reference = trim((string) $this->option('tx'));

                if ($reference === '') {
                    $this->error('--paid needs --tx: the hash or reference of the transfer that paid it.');

                    return self::FAILURE;
                }

                $payout = $referrals->markPaid($this->payout('paid'), $reference);
                $this->info('Recorded #'.$payout->getKey().' as paid ('.$reference.').');

                return self::SUCCESS;
            }

            if ($this->option('cancel') !== null) {
                $payout = $referrals->cancel($this->payout('cancel'), 'cancelled by operator');
                $this->info('Cancelled #'.$payout->getKey().'; its earnings wait for the next run.');

                return self::SUCCESS;
            }
        } catch (RuntimeException $error) {
            $this->error($error->getMessage());

            return self::FAILURE;
        }

        if ($this->option('prepare')) {
            $prepared = $referrals->preparePayouts();
            $this->info('Prepared '.$prepared->count().' payout(s).');

            if ($this->option('notify') && $prepared->isNotEmpty()) {
                $total = $prepared->sum(fn (ReferralPayout $payout) => (float) $payout->amount_usd);

                $telegram->send(
                    "🤝 <b>Реферальные выплаты ждут подтверждения</b>\n\n"
                    .'Выплат: <b>'.$prepared->count()."</b>\n"
                    .'Сумма: <b>$'.number_format($total, 2)."</b>\n\n"
                    .'Посмотреть: <code>php artisan referrals:payouts</code>',
                );
            }
        }

        $this->report();

        return self::SUCCESS;
    }

    private function payout(string $option): ReferralPayout
    {
        $payout = ReferralPayout::query()->with('referrer')->find((int) $this->option($option));

        if (! $payout instanceof ReferralPayout) {
            throw new RuntimeException('No payout #'.$this->option($option).'.');
        }

        return $payout;
    }

    private function report(): void
    {
        $unscheduled = (float) ReferralReward::query()->whereNull('payout_id')->sum('reward_usd');
        $this->line('Earned, not yet in a payout: $'.number_format($unscheduled, 4));

        $open = ReferralPayout::query()
            ->with('referrer')
            ->whereIn('status', [ReferralPayout::PENDING, ReferralPayout::APPROVED])
            ->orderBy('id')
            ->get();

        if ($open->isEmpty()) {
            $this->line('No payouts waiting.');

            return;
        }

        $this->table(
            ['#', 'status', 'amount', 'to', 'prepared'],
            $open->map(fn (ReferralPayout $payout) => [
                $payout->getKey(),
                $payout->status,
                '$'.number_format((float) $payout->amount_usd, 2),
                $payout->referrer?->wallet_address ?? '(no EVM address)',
                $payout->created_at?->toDateString(),
            ])->all(),
        );
    }
}
