<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * The Android/iOS app's push address. A WebView cannot hold a Web Push
     * subscription, so the app registers with Firebase Cloud Messaging and
     * hands the token here, against the same installation UUID the wallet's
     * Web Push subscription uses (see WalletPushController).
     */
    public function up(): void
    {
        Schema::create('fcm_tokens', function (Blueprint $table) {
            $table->id();
            $table->string('token', 512)->unique();
            $table->uuid('analytics_user_id')->nullable()->index();
            $table->string('platform', 16)->default('android');
            $table->string('locale', 12)->nullable();
            $table->timestamp('last_seen_at')->nullable();
            $table->timestamps();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('fcm_tokens');
    }
};
