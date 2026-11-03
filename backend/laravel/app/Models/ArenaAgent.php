<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;

class ArenaAgent extends Model
{
    protected $guarded = ['id'];

    protected $hidden = ['key_hash'];

    protected function casts(): array
    {
        return ['last_trade_at' => 'immutable_datetime', 'hidden_at' => 'immutable_datetime'];
    }

    public function trades(): HasMany
    {
        return $this->hasMany(ArenaTrade::class);
    }
}
