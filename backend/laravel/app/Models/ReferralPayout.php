<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

/**
 * A week of one inviter's earnings, on its way out of the project.
 *
 * `pending` is what the weekly run proposes, `approved` is a person saying yes,
 * `paid` carries the reference of the transfer that did it. Nothing here sends
 * money: this host holds no key for the fee balance and should not. Cancelling
 * releases the rewards back to the next run rather than deleting them.
 */
class ReferralPayout extends Model
{
    public const PENDING = 'pending';

    public const APPROVED = 'approved';

    public const PAID = 'paid';

    public const CANCELLED = 'cancelled';

    protected $fillable = [
        'referrer_id',
        'amount_usd',
        'status',
        'approved_at',
        'paid_at',
        'tx_reference',
        'note',
    ];

    protected function casts(): array
    {
        return [
            'amount_usd' => 'decimal:6',
            'approved_at' => 'datetime',
            'paid_at' => 'datetime',
        ];
    }

    public function referrer(): BelongsTo
    {
        return $this->belongsTo(User::class, 'referrer_id');
    }

    public function rewards(): HasMany
    {
        return $this->hasMany(ReferralReward::class, 'payout_id');
    }
}
