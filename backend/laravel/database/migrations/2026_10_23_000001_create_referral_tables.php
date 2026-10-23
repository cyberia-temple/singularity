<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * The referral programme: who brought whom, what that earned, and what was paid.
 *
 * Three facts and three places for them. The *link* lives on the user — one
 * code an account hands out, one inviter an account ever has. The *earning* is
 * a row per fee Cyberia actually collected from a friend's swap, keyed by the
 * router's own request id so a second sync can never pay the same swap twice.
 * The *payment* is a row a person approves, because money leaving the project
 * is a decision, not a cron job.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->string('referral_code', 16)->nullable()->unique();
            $table->foreignId('referred_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('referred_at')->nullable();
            $table->index('referred_by');
        });

        Schema::create('referral_payouts', function (Blueprint $table) {
            $table->id();
            $table->foreignId('referrer_id')->constrained('users')->cascadeOnDelete();
            $table->decimal('amount_usd', 18, 6);
            // pending → approved → paid, or cancelled (which frees its rewards).
            $table->string('status', 16)->default('pending');
            $table->timestamp('approved_at')->nullable();
            $table->timestamp('paid_at')->nullable();
            $table->string('tx_reference', 191)->nullable();
            $table->string('note', 255)->nullable();
            $table->timestamps();

            $table->index(['status', 'created_at']);
        });

        Schema::create('referral_rewards', function (Blueprint $table) {
            $table->id();
            $table->foreignId('referrer_id')->constrained('users')->cascadeOnDelete();
            $table->foreignId('referee_id')->constrained('users')->cascadeOnDelete();
            // Where the fee came from, and that source's own id for it.
            $table->string('source', 24);
            $table->string('source_id', 191);
            $table->decimal('fee_usd', 18, 6);
            // The share in force when the row was written, so a later change
            // of the rate never rewrites what somebody was already told.
            $table->unsignedSmallInteger('share_bps');
            $table->decimal('reward_usd', 18, 6);
            $table->timestamp('occurred_at');
            $table->foreignId('payout_id')->nullable()->constrained('referral_payouts')->nullOnDelete();
            $table->timestamps();

            $table->unique(['source', 'source_id']);
            $table->index(['referrer_id', 'occurred_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('referral_rewards');
        Schema::dropIfExists('referral_payouts');

        Schema::table('users', function (Blueprint $table) {
            $table->dropForeign(['referred_by']);
            $table->dropIndex(['referred_by']);
            $table->dropUnique(['referral_code']);
            $table->dropColumn(['referral_code', 'referred_by', 'referred_at']);
        });
    }
};
