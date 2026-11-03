<?php

namespace App\Console\Commands;

use App\Services\WalletPriceService;
use Illuminate\Console\Command;

/**
 * Write down every price the wallet shows, so its 24h change can be read for
 * the assets no outside feed reports a change for (Cyberia's tokens, CYBER
 * itself, the tokenised stocks).
 */
class WalletPriceSnapshotCommand extends Command
{
    protected $signature = 'wallet:price-snapshot';

    protected $description = 'Snapshot the wallet USD prices for the 24h change';

    public function handle(WalletPriceService $prices): int
    {
        $this->line('wallet prices: '.$prices->snapshot().' written');

        return self::SUCCESS;
    }
}
