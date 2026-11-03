<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/** The native app's Firebase Cloud Messaging token for one installation (see App\Services\Push\FcmFanOut). */
#[Fillable(['token', 'analytics_user_id', 'platform', 'locale', 'last_seen_at'])]
class FcmToken extends Model
{
    protected function casts(): array
    {
        return ['last_seen_at' => 'datetime'];
    }

    public function installation(): BelongsTo
    {
        return $this->belongsTo(AnalyticsUser::class, 'analytics_user_id');
    }
}
