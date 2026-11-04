<?php

namespace App\Console\Commands;

use App\Models\User;
use App\Services\ReferralService;
use Illuminate\Console\Attributes\Description;
use Illuminate\Console\Attributes\Signature;
use Illuminate\Console\Command;
use Throwable;

/**
 * Turn invited friends' finished swaps into their inviters' earnings.
 *
 * Asks the router, per invited account, what that account swapped since it
 * was invited and what fee it paid us; writes a row per swap and tells the
 * inviter. Idempotent — the router's request id is the key — so the hourly
 * schedule can overlap a manual run without paying anything twice.
 *
 * One friend's failure is reported and skipped, not fatal: a router that will
 * not answer about one address says nothing about the next.
 */
#[Signature('referrals:sync {--user= : Only this invited account (id)}')]
#[Description('Record what invited friends’ swaps earned their inviters')]
class ReferralsSyncCommand extends Command
{
    public function handle(ReferralService $referrals): int
    {
        if (! $referrals->enabled()) {
            $this->warn('Referrals are switched off (REFERRALS_ENABLED / REFERRALS_SHARE_BPS).');

            return self::SUCCESS;
        }

        if (! $referrals->collecting()) {
            $this->warn('No cross-chain fee is being collected, so there is nothing to share.');
            $this->line('  Set CROSSCHAIN_FEE_ADDRESS and CROSSCHAIN_FEE_BPS for earnings to start.');

            return self::SUCCESS;
        }

        $query = User::query()
            ->whereNotNull('referred_by')
            ->whereNotNull('referred_at')
            ->whereNull('merged_into_id');

        if ($this->option('user') !== null) {
            $query->whereKey((int) $this->option('user'));
        }

        $friends = 0;
        $written = 0;
        $failed = 0;

        foreach ($query->lazyById(100) as $referee) {
            $friends++;

            try {
                $rewards = $referrals->syncReferee($referee);
            } catch (Throwable $error) {
                $failed++;
                $this->warn('  #'.$referee->getKey().': '.$error->getMessage());

                continue;
            }

            foreach ($rewards as $reward) {
                $written++;
                $referrals->announce($reward);
                $this->line(sprintf(
                    '  #%d → #%d  fee $%.4f  reward $%.4f  (%s)',
                    $reward->referee_id,
                    $reward->referrer_id,
                    (float) $reward->fee_usd,
                    (float) $reward->reward_usd,
                    $reward->source_id,
                ));
            }
        }

        $this->info("Invited accounts read: {$friends}. New rewards: {$written}.".($failed ? " Failed: {$failed}." : ''));

        return $failed > 0 && $failed === $friends ? self::FAILURE : self::SUCCESS;
    }
}
