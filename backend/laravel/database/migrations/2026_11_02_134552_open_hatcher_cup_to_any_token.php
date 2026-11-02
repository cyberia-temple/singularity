<?php

use App\Models\ArenaSeason;
use App\Services\Arena\ArenaMultiAutomation;
use App\Services\Arena\ArenaSeasonManager;
use Carbon\CarbonImmutable;
use Illuminate\Database\Migrations\Migration;

/**
 * Hatcher Cup has no fixed token list: the agents may trade any Solana mint.
 * The fixed-basket season never started, so it is replaced in place (same
 * slug, same start). A season that already holds a round or a decision cycle
 * is left exactly as it is, because its rules are frozen.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! app()->environment('production')) {
            return;
        }
        $existing = ArenaSeason::query()->where('slug', 'hatcher-cup')->first();
        if ($existing && (($existing->rules['version'] ?? 0) >= 4 || $existing->rounds()->exists() || $existing->cycles()->exists())) {
            return;
        }
        config()->set('arena.partner', 'hatcher');
        config()->set('arena.partners.hatcher', [
            'title' => 'Hatcher Cup', 'name' => 'HatcherLabs', 'website' => 'https://hatcher.host/',
            'x' => 'https://x.com/HatcherLabs', 'telegram' => 'https://t.me/HatcherLabs',
            'chart' => 'https://dexscreener.com/solana/CGH49JQDQSh7U8nQrDhutEV4QB3h1NxsJoe7ho7UtSH3',
        ]);
        config()->set('arena.anchors', [
            ['symbol' => 'SOL', 'mint' => 'So11111111111111111111111111111111111111112'],
            ['symbol' => 'HATCHER', 'mint' => 'Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump'],
        ]);
        config()->set('arena.candidates', 12);
        config()->set('arena.multi', ['initial_cash_usd' => '1000', 'fee_bps' => 30, 'slippage_bps' => 50,
            'min_liquidity_usd' => 5000, 'max_quote_age_seconds' => 300]);
        try {
            $rules = ArenaMultiAutomation::rules();
        } catch (DomainException $exception) {
            logger()->warning('Hatcher Cup any-token season not created: '.$exception->getMessage());

            return;
        }
        $start = CarbonImmutable::parse('2026-11-03T00:00:00Z');
        $existing?->delete();
        ArenaSeason::query()->create(['slug' => 'hatcher-cup', 'title' => 'Hatcher Cup', 'starts_at' => $start,
            'ends_at' => $start->addDays($rules['days']), 'rules' => $rules,
            'rules_hash' => app(ArenaSeasonManager::class)->digest($rules)]);
    }

    public function down(): void {}
};
