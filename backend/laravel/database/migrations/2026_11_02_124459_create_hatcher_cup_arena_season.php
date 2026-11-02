<?php

use App\Models\ArenaSeason;
use App\Services\Arena\ArenaSeasonManager;
use Carbon\CarbonImmutable;
use Illuminate\Database\Migrations\Migration;

/**
 * Opens Hatcher Cup on production: HatcherLabs' AI-trading season, two free
 * model agents paper-trading HATCHER/SOL from 2026-11-03 00:00 UTC.
 *
 * A season is data the deploy cannot otherwise create, and the market and
 * partner are set here rather than read from the host's environment, so the
 * frozen rules are the same whatever the `.env` says. Only production gets a
 * season; a refused configuration (paid models, say) leaves nothing behind.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (! app()->environment('production') || ArenaSeason::query()->where('slug', 'hatcher-cup')->exists()) {
            return;
        }
        config()->set('arena.market', 'solana-hatcher-sol');
        config()->set('arena.partner', 'hatcher');
        config()->set('arena.markets.solana-hatcher-sol', [
            'name' => 'HATCHER / SOL', 'cash' => 'SOL', 'asset' => 'HATCHER', 'lot' => 1000000,
            'initial_cash_micros' => '10000000', 'fee_bps' => 25, 'slippage_bps' => 50, 'gas_micros' => '5000',
        ]);
        config()->set('arena.partners.hatcher', [
            'title' => 'Hatcher Cup', 'name' => 'HatcherLabs', 'website' => 'https://hatcher.host/',
            'x' => 'https://x.com/HatcherLabs', 'telegram' => 'https://t.me/HatcherLabs',
            'chart' => 'https://dexscreener.com/solana/CGH49JQDQSh7U8nQrDhutEV4QB3h1NxsJoe7ho7UtSH3',
        ]);
        try {
            app(ArenaSeasonManager::class)->create('hatcher-cup', CarbonImmutable::parse('2026-11-03T00:00:00Z'), true);
        } catch (DomainException $exception) {
            logger()->warning('Hatcher Cup season not created: '.$exception->getMessage());
        }
    }

    public function down(): void
    {
        ArenaSeason::query()->where('slug', 'hatcher-cup')->whereDoesntHave('rounds')->whereDoesntHave('cycles')->delete();
    }
};
