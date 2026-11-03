<?php

use App\Models\ArenaSeason;
use App\Services\Arena\ArenaMultiAutomation;
use App\Services\Arena\ArenaSeasonManager;
use Carbon\CarbonImmutable;
use Illuminate\Database\Migrations\Migration;

/**
 * Hatcher Cup's 06:00 and 12:00 UTC slots were skipped too: OpenRouter named
 * Lain's model by a slug the served check did not accept, and the challenger's
 * free model was rate-limited upstream. The check is relaxed in code; the
 * challenger model is frozen in the rules, so the season is restarted from
 * 18:00 UTC with one that is served. A season holding a round is never touched.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! app()->environment('production')) {
            return;
        }
        $existing = ArenaSeason::query()->where('slug', 'hatcher-cup')->first();
        if (! $existing || $existing->rounds()->exists() || $existing->cycles()->where('status', '!=', 'skipped')->exists()
            || ($existing->rules['mode'] ?? null) !== 'automatic-multi') {
            return;
        }
        config()->set('arena.automation.models', [
            'lain' => 'xingchen-agi/xing4.0-29b-a4b:free',
            'challenger' => 'nvidia/nemotron-3.5-super-vl:free',
        ]);
        $partner = $existing->rules['partner'] ?? null;
        if (is_array($partner)) {
            config()->set('arena.partner', $partner['slug']);
            config()->set('arena.partners.'.$partner['slug'], collect($partner)->except('slug')->all());
        }
        config()->set('arena.anchors', $existing->rules['anchors']);
        config()->set('arena.candidates', $existing->rules['candidates']['limit']);
        config()->set('arena.multi', ['initial_cash_usd' => $existing->rules['initial_cash_usd'], 'fee_bps' => $existing->rules['fee_bps'],
            'slippage_bps' => $existing->rules['slippage_bps'], 'min_liquidity_usd' => $existing->rules['min_liquidity_usd'],
            'max_quote_age_seconds' => $existing->rules['automation']['max_quote_age_seconds']]);
        try {
            $rules = ArenaMultiAutomation::rules();
        } catch (DomainException $exception) {
            logger()->warning('Hatcher Cup not restarted: '.$exception->getMessage());

            return;
        }
        $start = CarbonImmutable::parse('2026-11-03T18:00:00Z');
        $existing->delete();
        ArenaSeason::query()->create(['slug' => 'hatcher-cup', 'title' => 'Hatcher Cup', 'starts_at' => $start,
            'ends_at' => $start->addDays($rules['days']), 'rules' => $rules,
            'rules_hash' => app(ArenaSeasonManager::class)->digest($rules)]);
    }

    public function down(): void {}
};
