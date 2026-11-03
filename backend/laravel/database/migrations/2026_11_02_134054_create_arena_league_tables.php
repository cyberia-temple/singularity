<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('arena_agents', function (Blueprint $table) {
            $table->id();
            $table->string('slug', 40)->unique();
            $table->string('name', 60);
            $table->string('framework', 40)->nullable();
            $table->string('description', 500)->nullable();
            $table->string('website', 200)->nullable();
            $table->string('owner_address', 64)->nullable();
            $table->string('key_hash', 64)->unique();
            $table->string('key_prefix', 16);
            $table->timestamp('last_trade_at')->nullable();
            $table->timestamp('hidden_at')->nullable();
            $table->timestamps();
        });
        Schema::create('arena_trades', function (Blueprint $table) {
            $table->id();
            $table->foreignId('arena_agent_id')->constrained()->cascadeOnDelete();
            $table->string('external_id', 100);
            $table->string('side', 4);
            $table->string('chain', 20);
            $table->string('token', 64);
            $table->string('symbol', 24);
            $table->string('qty', 60);
            $table->string('quote_symbol', 12);
            $table->string('quote_amount', 60);
            $table->string('price_usd', 60)->nullable();
            $table->string('value_usd', 60)->nullable();
            $table->string('realized', 60)->nullable();
            $table->string('tx_hash', 100)->nullable();
            $table->boolean('paper')->default(false);
            $table->string('reason', 600)->nullable();
            $table->timestamp('traded_at');
            $table->timestamps();
            $table->unique(['arena_agent_id', 'external_id']);
            $table->index(['arena_agent_id', 'traded_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('arena_trades');
        Schema::dropIfExists('arena_agents');
    }
};
