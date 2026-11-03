<?php

namespace App\Services;

use Illuminate\Support\Facades\Http;

class CyberPriceService
{
    protected string $mint = 'E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump';

    protected string $url = 'https://api.dexscreener.com/latest/dex/tokens/';

    public function get(): ?array
    {
        try {
            $response = Http::timeout(8)->get($this->url.$this->mint);

            if ($response->successful()) {
                $data = $response->json();

                if (isset($data['pairs'][0])) {
                    $pair = $data['pairs'][0];

                    return [
                        'priceSol' => $pair['priceNative'] ?? null,
                        'priceUsd' => $pair['priceUsd'] ?? null,
                        'change24h' => $pair['priceChange']['h24'] ?? null,
                    ];
                }
            }
        } catch (\Exception $e) {
            // Return null on failure
        }

        return null;
    }
}
