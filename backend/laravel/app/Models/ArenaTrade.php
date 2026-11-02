<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ArenaTrade extends Model
{
    protected $guarded = ['id'];

    protected function casts(): array
    {
        return ['paper' => 'boolean', 'traded_at' => 'immutable_datetime'];
    }

    public function agent(): BelongsTo
    {
        return $this->belongsTo(ArenaAgent::class, 'arena_agent_id');
    }
}
