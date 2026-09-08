<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Where a launched token can be followed.
     *
     * A launchpad row already carries what the token *is* (name, image, a
     * description, a site) and nothing about where its project talks, so the
     * two links every buyer looks for first — X and Telegram — were the ones
     * the page could not show. They are stored **bare** (`cyberia_network`,
     * not `https://t.me/cyberia_network`), the way `crm_contacts` stores them,
     * because `App\Support\Handles` collapses every spelling on the way in and
     * decides on the way out whether a stored value can be a link at all.
     */
    public function up(): void
    {
        Schema::table('launchpad_tokens', function (Blueprint $table) {
            $table->string('x_handle', 100)->nullable()->after('description');
            $table->string('telegram_handle', 100)->nullable()->after('x_handle');
            $table->string('website_url', 255)->nullable()->after('telegram_handle');
        });
    }

    public function down(): void
    {
        Schema::table('launchpad_tokens', function (Blueprint $table) {
            $table->dropColumn(['x_handle', 'telegram_handle', 'website_url']);
        });
    }
};
