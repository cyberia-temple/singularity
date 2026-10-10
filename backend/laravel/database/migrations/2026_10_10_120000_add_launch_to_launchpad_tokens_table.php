<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A launchpad row stops being only what a creator chose to tell us.
 *
 * Until now a row existed only once somebody signed metadata for a token, and
 * a launch with nothing typed into "about" never got one. `launchpad:watch`
 * reads the launchpads themselves, so the facts with an on-chain source — the
 * launch transaction, its block and time — are written here whether or not
 * anybody ever signs anything, and so is the DAO the launch opened.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('launchpad_tokens', function (Blueprint $table) {
            $table->timestamp('launched_at')->nullable();
            $table->string('launch_tx', 66)->nullable();
            $table->unsignedBigInteger('launch_block')->nullable();
            $table->foreignId('dao_id')->nullable()->constrained('daos')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('launchpad_tokens', function (Blueprint $table) {
            $table->dropConstrainedForeignId('dao_id');
            $table->dropColumn(['launched_at', 'launch_tx', 'launch_block']);
        });
    }
};
