<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Session recordings, kept on this server.
 *
 * The recording itself — rrweb's events — is files on the private disk, one
 * gzip per chunk under `replay/<session>/`, because a session is megabytes and
 * nothing ever queries inside it. What the console filters and aggregates by is
 * here: the session with its counters, the pages it took a snapshot of (what a
 * heat map is drawn on and where the player can jump), every click (the heat
 * map, rage and dead clicks) and every JavaScript error. Nothing here holds an
 * IP address, and nothing typed: the recorder masks inputs before sending.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('replay_sessions', function (Blueprint $table) {
            // Minted by the recorder, one per tab, a new one after half an
            // hour of nothing.
            $table->uuid('id')->primary();
            $table->string('site', 64)->index();
            // The wallet installation (analytics_users.id) and the signed-in
            // account, when there is one.
            $table->uuid('installation')->nullable()->index();
            $table->unsignedBigInteger('user_id')->nullable()->index();
            $table->string('device', 8);
            $table->unsignedSmallInteger('viewport_width');
            $table->unsignedSmallInteger('viewport_height');
            $table->string('browser', 24)->nullable();
            $table->string('os', 24)->nullable();
            $table->string('entry_path', 255);
            $table->string('last_path', 255);
            // The browser's clock, used only for offsets inside one recording.
            $table->unsignedBigInteger('started_ms');
            $table->unsignedInteger('duration_ms')->default(0);
            $table->unsignedInteger('pages')->default(0);
            $table->unsignedInteger('clicks')->default(0);
            $table->unsignedInteger('rage_clicks')->default(0);
            $table->unsignedInteger('dead_clicks')->default(0);
            $table->unsignedInteger('errors')->default(0);
            $table->unsignedInteger('chunks')->default(0);
            $table->unsignedBigInteger('bytes')->default(0);
            $table->timestamps();
            $table->index('updated_at');
        });

        Schema::create('replay_pages', function (Blueprint $table) {
            $table->id();
            $table->foreignUuid('session_id')->constrained('replay_sessions')->cascadeOnDelete();
            $table->string('site', 64);
            $table->string('path', 255);
            $table->string('device', 8);
            // Which chunk holds the snapshot, and where in the recording it is.
            $table->unsignedInteger('seq');
            $table->unsignedBigInteger('at_ms');
            $table->timestamp('created_at');
            $table->index(['site', 'path', 'device', 'created_at']);
        });

        Schema::create('replay_clicks', function (Blueprint $table) {
            $table->id();
            $table->foreignUuid('session_id')->constrained('replay_sessions')->cascadeOnDelete();
            $table->string('site', 64);
            $table->string('path', 255);
            $table->string('device', 8);
            // Across the page as a fraction of its width; down it in pixels —
            // from the top of the viewport for something fixed on screen.
            $table->float('x');
            $table->unsignedInteger('y');
            $table->boolean('fixed')->default(false);
            $table->unsignedSmallInteger('viewport_width');
            $table->string('target', 120);
            $table->boolean('rage')->default(false);
            $table->boolean('dead')->default(false);
            // The browser's clock, like every timestamp inside the recording,
            // so the player can jump to the moment.
            $table->unsignedBigInteger('at_ms');
            $table->timestamp('created_at');
            $table->index(['site', 'path', 'device', 'created_at']);
            $table->index(['created_at', 'rage', 'dead']);
        });

        Schema::create('replay_errors', function (Blueprint $table) {
            $table->id();
            $table->foreignUuid('session_id')->constrained('replay_sessions')->cascadeOnDelete();
            $table->string('site', 64);
            $table->string('path', 255);
            $table->string('message', 255);
            $table->unsignedBigInteger('at_ms');
            $table->timestamp('created_at')->index();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('replay_errors');
        Schema::dropIfExists('replay_clicks');
        Schema::dropIfExists('replay_pages');
        Schema::dropIfExists('replay_sessions');
    }
};
