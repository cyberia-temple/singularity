<?php

namespace App\Console\Commands;

use App\Services\Heatmap\CryptoHeatmap;
use App\Services\Heatmap\CyberiaHeatmap;
use Illuminate\Console\Command;

/**
 * Refresh both market maps on `/heatmap`: the crypto market from CoinGecko and
 * a price snapshot of every Cyberia launch, from which the 24h change is read.
 */
class HeatmapSnapshotCommand extends Command
{
    protected $signature = 'heatmap:snapshot';

    protected $description = 'Refresh the crypto market map and snapshot Cyberia token prices';

    public function handle(CryptoHeatmap $crypto, CyberiaHeatmap $cyberia): int
    {
        $this->line($crypto->refresh() ? 'crypto: refreshed' : 'crypto: CoinGecko did not answer, kept the last map');
        $this->line('cyberia: '.$cyberia->snapshot().' tokens');

        return self::SUCCESS;
    }
}
