<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class LaunchpadToken extends Model
{
    protected $fillable = [
        'chain_id',
        'address',
        'creator',
        'name',
        'symbol',
        'description',
        'x_handle',
        'telegram_handle',
        'website_url',
        'image_path',
        'html_path',
        'site_subdomain',
        'ipfs_cid',
        'ipfs_pinned_at',
        'launched_at',
        'launch_tx',
        'launch_block',
        'dao_id',
    ];

    /** A token launched on several chains has one row per chain. */
    protected function casts(): array
    {
        return [
            'chain_id' => 'integer',
            'ipfs_pinned_at' => 'datetime',
            'launched_at' => 'datetime',
            'launch_block' => 'integer',
        ];
    }

    /** The DAO the launch opened (`launchpad:watch`), voted in this token. */
    public function dao(): BelongsTo
    {
        return $this->belongsTo(Dao::class);
    }
}
