<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('wallet_price_snapshots', function (Blueprint $table) {
            $table->id();
            $table->string('chain', 32);
            // '' for the chain's own coin, otherwise the lowercased contract or mint.
            $table->string('asset', 64)->default('');
            $table->double('usd');
            $table->timestamp('captured_at')->index();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('wallet_price_snapshots');
    }
};
