<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One fee a friend paid, and the inviter's share of it.
 *
 * Written only from what the fee's own source recorded — the router's request,
 * with its sender and the app fee it actually took — never from what a browser
 * reported. `(source, source_id)` is unique, so reading the same swap twice
 * changes nothing.
 */
class ReferralReward extends Model
{
    protected $fillable = [
        'referrer_id',
        'referee_id',
        'source',
        'source_id',
        'fee_usd',
        'share_bps',
        'reward_usd',
        'occurred_at',
        'payout_id',
    ];

    protected function casts(): array
    {
        return [
            'fee_usd' => 'decimal:6',
            'reward_usd' => 'decimal:6',
            'share_bps' => 'integer',
            'occurred_at' => 'datetime',
        ];
    }

    public function referrer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'referrer_id');
    }

    public function referee(): BelongsTo
    {
        return $this->belongsTo(User::class, 'referee_id');
    }

    public function payout(): BelongsTo
    {
        return $this->belongsTo(ReferralPayout::class, 'payout_id');
    }
}
