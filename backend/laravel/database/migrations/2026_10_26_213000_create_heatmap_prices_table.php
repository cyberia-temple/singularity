<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('heatmap_prices', function (Blueprint $table) {
            $table->id();
            $table->string('address', 42);
            $table->string('symbol', 32)->nullable();
            $table->string('name', 64)->nullable();
            $table->string('venue', 4);
            $table->string('sector', 16);
            $table->double('supply');
            $table->double('price_cyber')->nullable();
            $table->timestamp('captured_at')->index();
            $table->index(['address', 'captured_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('heatmap_prices');
    }
};
