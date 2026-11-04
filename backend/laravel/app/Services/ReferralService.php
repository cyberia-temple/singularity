<?php

namespace App\Services;

use App\Exceptions\ReferralRefused;
use App\Models\ReferralPayout;
use App\Models\ReferralReward;
use App\Models\User;
use App\Notifications\ReferralRewardNotification;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;
use Throwable;

/**
 * Invite a friend, get a share of the fee Cyberia collected from them.
 *
 * Every rule here follows from one decision: the programme only ever hands out
 * part of a fee that already arrived. That is what makes it safe to run with
 * nobody watching — it costs nothing on a quiet day, it can never pay more
 * than it took, and inviting yourself from a second wallet loses money by
 * construction (you pay the whole fee to get a quarter of it back). It is also
 * what keeps it on the right side of the team's rule against paying for
 * volume: nobody is paid for trading, only given back part of what a friend's
 * trading already paid.
 *
 * The link is account to account, like the daily board, because a referral is
 * a fact about people: the account that invited and the account that came.
 * The earning is read from the router, which recorded the sender and the fee
 * it took; nothing a browser says can create one.
 */
class ReferralService
{
    /** The code alphabet: no 0/O, 1/I/L — it gets read aloud and typed. */
    private const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

    private const CODE_LENGTH = 8;

    /** What a code looks like on the way in, before it is looked up. */
    public const CODE_PATTERN = '/^[2-9A-HJ-NP-Za-hj-np-z]{6,16}$/';

    public const SOURCE_CROSSCHAIN = 'crosschain';

    public function __construct(private readonly CrosschainRouter $router) {}

    public function enabled(): bool
    {
        return (bool) config('referrals.enabled', true) && $this->shareBps() > 0;
    }

    /** The inviter's share, clamped to the ceiling in config. */
    public function shareBps(): int
    {
        $bps = (int) config('referrals.share_bps', 0);
        $max = (int) config('referrals.max_share_bps', 5000);

        return max(0, min($bps, $max));
    }

    /**
     * Whether there is any fee to share right now.
     *
     * The programme can be switched on while the router collects nothing —
     * no fee address on this host — and then every earning is zero for a
     * reason that is not the inviter's. The screen says that instead of
     * showing a balance that cannot move.
     */
    public function collecting(): bool
    {
        return $this->router->enabled() && $this->router->feeAddress() !== null;
    }

    /**
     * The rules as the screen states them, the same for everyone.
     *
     * @return array<string, mixed>
     */
    public function program(): array
    {
        return [
            'enabled' => $this->enabled(),
            'collecting' => $this->collecting(),
            'shareBps' => $this->shareBps(),
            'feeBps' => $this->router->feeBps(),
            'sources' => [self::SOURCE_CROSSCHAIN],
            'attachWindowDays' => $this->attachWindowDays(),
            'payout' => [
                'cadence' => 'weekly',
                'asset' => (string) config('referrals.payout.asset', 'USDC'),
                'minimumUsd' => $this->minimumPayoutUsd(),
            ],
        ];
    }

    /**
     * This account's code, made on first ask.
     *
     * Random rather than derived from the address: a code is something people
     * post, and one that can be turned back into a wallet address would make
     * every shared link a pointer to somebody's balance.
     */
    public function codeFor(User $user): string
    {
        if (is_string($user->referral_code) && $user->referral_code !== '') {
            return $user->referral_code;
        }

        for ($attempt = 0; $attempt < 8; $attempt++) {
            $code = $this->randomCode();

            if (! User::query()->where('referral_code', $code)->exists()) {
                $user->forceFill(['referral_code' => $code])->save();

                return $code;
            }
        }

        throw new \RuntimeException('Could not find a free referral code.');
    }

    public function link(string $code): string
    {
        return url('/r/'.$code);
    }

    /**
     * Make `$code`'s owner this account's inviter.
     *
     * Once, forever, and only for an account that is actually new: an invite
     * is a claim that somebody arrived because of you, and an account that has
     * been here for months did not. Refusals carry a reason the screen can say
     * in the reader's language.
     *
     * @throws ReferralRefused
     */
    public function attach(User $user, string $code): User
    {
        if (! $this->enabled()) {
            throw new ReferralRefused('disabled', 'Invites are switched off right now.');
        }

        $code = strtoupper(trim($code));

        if (! preg_match(self::CODE_PATTERN, $code)) {
            throw new ReferralRefused('unknown_code', 'That invite code does not exist.');
        }

        return DB::transaction(function () use ($user, $code): User {
            /** @var User $fresh */
            $fresh = User::query()->lockForUpdate()->findOrFail($user->getKey());

            $inviter = User::query()->where('referral_code', $code)->first();

            if (! $inviter instanceof User || $inviter->merged_into_id !== null) {
                throw new ReferralRefused('unknown_code', 'That invite code does not exist.');
            }

            if ($inviter->is($fresh)) {
                throw new ReferralRefused('own_code', 'That is your own invite code.');
            }

            if ($fresh->referred_by !== null) {
                throw new ReferralRefused('already_invited', 'This account already has an inviter.');
            }

            if ($fresh->created_at !== null
                && $fresh->created_at->lt(now()->subDays($this->attachWindowDays()))) {
                throw new ReferralRefused(
                    'too_old',
                    'Invites are for new accounts — this one is older than '.$this->attachWindowDays().' days.',
                );
            }

            // Two people inviting each other would let the pair split one fee
            // twice over. One level is all this pays, so one step is all it
            // has to look.
            if ($inviter->referred_by !== null && (int) $inviter->referred_by === (int) $fresh->getKey()) {
                throw new ReferralRefused('circular', 'You invited this person — they cannot invite you back.');
            }

            $fresh->forceFill([
                'referred_by' => $inviter->getKey(),
                'referred_at' => now(),
            ])->save();

            return $fresh;
        });
    }

    /**
     * Everything the invite screen draws.
     *
     * One shape whether or not anybody is signed in: the public half is the
     * rules, the account half is `null` when there is no account — never a
     * row of zeroes that reads like a score.
     *
     * @return array<string, mixed>
     */
    public function board(?User $user): array
    {
        if (! $user instanceof User) {
            return ['program' => $this->program(), 'signedIn' => false, 'account' => null];
        }

        $code = $this->enabled() ? $this->codeFor($user) : $user->referral_code;

        $rewards = ReferralReward::query()->where('referrer_id', $user->getKey());

        $earned = (float) (clone $rewards)->sum('reward_usd');
        $paid = (float) (clone $rewards)
            ->whereHas('payout', fn ($query) => $query->where('status', ReferralPayout::PAID))
            ->sum('reward_usd');

        $recent = (clone $rewards)
            ->with('payout:id,status')
            ->latest('occurred_at')
            ->limit(12)
            ->get()
            ->map(fn (ReferralReward $reward): array => [
                'id' => $reward->getKey(),
                'rewardUsd' => (float) $reward->reward_usd,
                'feeUsd' => (float) $reward->fee_usd,
                'source' => $reward->source,
                'at' => $reward->occurred_at?->toIso8601String(),
                'state' => match ($reward->payout?->status) {
                    ReferralPayout::PAID => 'paid',
                    ReferralPayout::PENDING, ReferralPayout::APPROVED => 'scheduled',
                    default => 'accrued',
                },
            ])
            ->all();

        return [
            'program' => $this->program(),
            'signedIn' => true,
            'account' => [
                'code' => $code,
                'link' => $code ? $this->link($code) : null,
                'invited' => $user->referrals()->count(),
                'earning' => (clone $rewards)->distinct()->count('referee_id'),
                'earnedUsd' => round($earned, 6),
                'paidUsd' => round($paid, 6),
                'pendingUsd' => round(max(0.0, $earned - $paid), 6),
                'invitedBy' => $user->referred_by !== null,
                'canAccept' => $user->referred_by === null
                    && ($user->created_at === null
                        || $user->created_at->gte(now()->subDays($this->attachWindowDays()))),
                'recent' => $recent,
            ],
        ];
    }

    /**
     * Read one invited account's finished swaps and write what they earned.
     *
     * Every address the account has proved is asked, from the moment it was
     * invited: a swap made before the invite was not made because of it.
     * Returns the rewards it wrote; a swap already on the books is skipped by
     * the unique key, so running this every hour is safe.
     *
     * @return Collection<int, ReferralReward>
     */
    public function syncReferee(User $referee): Collection
    {
        $written = collect();

        if (! $this->enabled() || ! $this->collecting()
            || $referee->referred_by === null || $referee->referred_at === null) {
            return $written;
        }

        $since = $referee->referred_at->getTimestamp();
        $share = $this->shareBps();

        $addresses = array_values(array_unique(array_filter([
            $referee->wallet_address,
            $referee->solana_wallet_address,
        ], fn ($address) => is_string($address) && $address !== '')));

        foreach ($addresses as $address) {
            foreach ($this->router->finishedSwapsBy($address, $since) as $swap) {
                if ($swap['at'] < $since) {
                    continue;
                }

                $reward = ReferralReward::query()->firstOrCreate(
                    ['source' => self::SOURCE_CROSSCHAIN, 'source_id' => $swap['id']],
                    [
                        'referrer_id' => $referee->referred_by,
                        'referee_id' => $referee->getKey(),
                        'fee_usd' => round($swap['feeUsd'], 6),
                        'share_bps' => $share,
                        'reward_usd' => round($swap['feeUsd'] * $share / 10_000, 6),
                        'occurred_at' => now()->setTimestamp($swap['at']),
                    ],
                );

                if ($reward->wasRecentlyCreated) {
                    $written->push($reward);
                }
            }
        }

        return $written;
    }

    /**
     * Tell an inviter what a friend's swap just earned them.
     *
     * Best effort and after the fact: the row is the money, the notification
     * is only news of it, and a push service that is down must never undo or
     * block a write.
     */
    public function announce(ReferralReward $reward): void
    {
        try {
            $reward->referrer?->notify(new ReferralRewardNotification((float) $reward->reward_usd));
        } catch (Throwable) {
            // The earning is recorded; the screen will show it either way.
        }
    }

    /**
     * Gather every unscheduled earning into one payout per inviter.
     *
     * An inviter under the minimum waits for a later week rather than being
     * sent a transfer that costs more than it carries. Nothing is sent here.
     *
     * @return Collection<int, ReferralPayout>
     */
    public function preparePayouts(): Collection
    {
        $minimum = $this->minimumPayoutUsd();

        return DB::transaction(function () use ($minimum): Collection {
            $totals = ReferralReward::query()
                ->whereNull('payout_id')
                ->selectRaw('referrer_id, SUM(reward_usd) as total')
                ->groupBy('referrer_id')
                ->get();

            $payouts = collect();

            foreach ($totals as $row) {
                $total = round((float) $row->total, 6);

                if ($total < $minimum) {
                    continue;
                }

                $payout = ReferralPayout::query()->create([
                    'referrer_id' => $row->referrer_id,
                    'amount_usd' => $total,
                    'status' => ReferralPayout::PENDING,
                ]);

                ReferralReward::query()
                    ->whereNull('payout_id')
                    ->where('referrer_id', $row->referrer_id)
                    ->update(['payout_id' => $payout->getKey()]);

                $payouts->push($payout);
            }

            return $payouts;
        });
    }

    public function approve(ReferralPayout $payout): ReferralPayout
    {
        $this->expect($payout, [ReferralPayout::PENDING]);

        $payout->forceFill(['status' => ReferralPayout::APPROVED, 'approved_at' => now()])->save();

        return $payout;
    }

    public function markPaid(ReferralPayout $payout, string $reference): ReferralPayout
    {
        $this->expect($payout, [ReferralPayout::APPROVED]);

        $payout->forceFill([
            'status' => ReferralPayout::PAID,
            'paid_at' => now(),
            'tx_reference' => $reference,
        ])->save();

        return $payout;
    }

    /** Cancel a payout that was not sent, and let its rewards wait for the next one. */
    public function cancel(ReferralPayout $payout, ?string $note = null): ReferralPayout
    {
        $this->expect($payout, [ReferralPayout::PENDING, ReferralPayout::APPROVED]);

        return DB::transaction(function () use ($payout, $note): ReferralPayout {
            $payout->rewards()->update(['payout_id' => null]);
            $payout->forceFill(['status' => ReferralPayout::CANCELLED, 'note' => $note])->save();

            return $payout;
        });
    }

    public function attachWindowDays(): int
    {
        return max(1, (int) config('referrals.attach_window_days', 30));
    }

    private function minimumPayoutUsd(): float
    {
        return max(0.0, (float) config('referrals.payout.minimum_usd', 1.0));
    }

    /**
     * @param  array<int, string>  $states
     */
    private function expect(ReferralPayout $payout, array $states): void
    {
        if (! in_array($payout->status, $states, true)) {
            throw new \RuntimeException(
                'Payout #'.$payout->getKey().' is '.$payout->status.', not '.implode(' or ', $states).'.',
            );
        }
    }

    private function randomCode(): string
    {
        $code = '';
        $last = strlen(self::ALPHABET) - 1;

        for ($i = 0; $i < self::CODE_LENGTH; $i++) {
            $code .= self::ALPHABET[random_int(0, $last)];
        }

        return $code;
    }
}
