<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class SiteEvent extends Model
{
    public const UPDATED_AT = null;

    /** Whitelist enforced at ingest; extend alongside lib/track.ts. */
    public const EVENTS = [
        'page_view',
        'landing_view',
        'wallet_connect_started',
        'wallet_connected',
        'network_switch',
        'bridge_started',
        'bridge_completed',
        'swap_started',
        'swap_completed',
        'staking_started',
        'staking_completed',
        'partner_cta_clicked',
        // The landing's tokenised-stock grid. Its own name rather than a
        // `partner_cta_clicked` with a ticker in the metadata: what it measures
        // is whether an equity is the thing that brings somebody in at all,
        // and folding it into another funnel step would answer that question
        // by averaging it away.
        'stock_cta_clicked',
        'liquidity_added',
    ];

    /**
     * Names this ingest no longer accepts, which reports still have to read.
     *
     * `swap_executed` was the first name for a completed swap and stopped
     * being emitted on 2026-07-27, when `swap_completed` replaced it. Thirty-
     * one rows carry it, inside the window a ninety-day report asks about, so
     * a lens that read only the new name would show the swap step collapsing
     * on a date nothing happened. Accepting it again would be worse: two names
     * for one act is how a funnel quietly starts double-counting.
     *
     * @var array<int, string>
     */
    public const RETIRED_EVENTS = [
        'swap_executed',
    ];

    protected $fillable = [
        'session_id',
        'user_id',
        'event',
        'page',
        'metadata',
    ];

    protected function casts(): array
    {
        return [
            'metadata' => 'array',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
