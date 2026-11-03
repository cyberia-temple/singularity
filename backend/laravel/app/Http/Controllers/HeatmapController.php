<?php

namespace App\Http\Controllers;

use App\Services\Heatmap\CryptoHeatmap;
use App\Services\Heatmap\CyberiaHeatmap;
use Inertia\Inertia;
use Inertia\Response;

/**
 * The market map: tiles sized by market cap, coloured by the day's move, for
 * the crypto market and for Cyberia. Both are read from what `heatmap:snapshot`
 * stored, so a page view calls nobody.
 */
class HeatmapController extends Controller
{
    public function __invoke(CryptoHeatmap $crypto, CyberiaHeatmap $cyberia): Response
    {
        return Inertia::render('Heatmap', [
            'crypto' => $crypto->map(),
            'cyberia' => $cyberia->map(),
        ]);
    }
}
