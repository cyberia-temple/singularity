<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * The season is a paper-trading cup, so it is called that. Only the title
 * changes: the slug, the addresses and the frozen rules stay as they are.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::table('arena_seasons')->where('slug', 'hatcher-cup')->update(['title' => 'Paper Cup']);
    }

    public function down(): void
    {
        DB::table('arena_seasons')->where('slug', 'hatcher-cup')->update(['title' => 'Hatcher Cup']);
    }
};
