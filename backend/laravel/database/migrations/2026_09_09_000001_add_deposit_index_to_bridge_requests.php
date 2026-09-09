<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Which subaddress inside the bridge's Monero wallet belongs to this request.
 *
 * A Monero deposit address is not derivable from a seed the way a Bitcoin one
 * is — it is minted by the wallet, which hands back an index — and every read
 * of "what landed here" is a wallet call filtered by that index. Storing the
 * address alone would mean asking the wallet to look the index up again on
 * every poll, which is a second call that can fail on its own.
 *
 * Null everywhere else: Yenten deposits carry a key instead (deposit_wif), and
 * every other corridor is bound to a transaction hash.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('bridge_requests', function (Blueprint $table) {
            $table->unsignedInteger('deposit_index')->nullable()->after('deposit_wif');
        });
    }

    public function down(): void
    {
        Schema::table('bridge_requests', function (Blueprint $table) {
            $table->dropColumn('deposit_index');
        });
    }
};
