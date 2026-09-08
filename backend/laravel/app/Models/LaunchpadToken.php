<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

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
    ];

    /** A token launched on several chains has one row per chain. */
    protected function casts(): array
    {
        return [
            'chain_id' => 'integer',
            'ipfs_pinned_at' => 'datetime',
        ];
    }
}
