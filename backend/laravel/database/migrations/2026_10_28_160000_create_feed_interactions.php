<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('post_reactions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('post_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->string('kind', 10);
            $table->timestamps();
            $table->unique(['post_id', 'user_id', 'kind']);
            $table->index(['kind', 'created_at']);
        });
        Schema::create('post_replies', function (Blueprint $table) {
            $table->id();
            $table->foreignId('post_id')->constrained()->cascadeOnDelete();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();
            $table->text('body');
            $table->timestamps();
        });
        Schema::create('post_views', function (Blueprint $table) {
            $table->foreignId('post_id')->constrained()->cascadeOnDelete();
            $table->string('viewer', 64);
            $table->date('day');
            $table->unique(['post_id', 'viewer', 'day']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('post_views');
        Schema::dropIfExists('post_replies');
        Schema::dropIfExists('post_reactions');
    }
};
