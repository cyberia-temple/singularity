<?php

namespace App\Actions\Wallet;

use App\Services\SolanaRpcProxy;
use Illuminate\Support\Facades\Http;

/**
 * Reads an owner's CYBER.sol (SPL token-2022) balance from Solana mainnet.
 *
 * CYBER.sol is the bridge-native token (mint mirrors config/bridge.php). We
 * sum the amount across every token account the owner holds for the mint —
 * normally just the associated token account, but summing is robust if a
 * wallet happens to hold several. No signature is required to read a balance,
 * so the same call powers both the one-time verify and the periodic re-check.
 *
 * The read goes through `SolanaRpcProxy` for its upstream list, not for the
 * browser: one endpoint means one dead credential takes the whole gate down,
 * and it did — a Helius key that answers `401` failed the whales chat at the
 * last step, after the holder had already connected Phantom and signed. The
 * proxy tries the keyed endpoints in order and ends on the keyless public
 * cluster, which answers a server perfectly well, so an expired key costs one
 * request rather than the feature.
 */
class ReadCyberSolBalance
{
    public function __construct(private ?SolanaRpcProxy $rpc = null) {}

    /**
     * @return array{raw: string, amount: string, decimals: int}
     *                                                           raw    — balance in base units (string; arbitrary precision)
     *                                                           amount — human balance with `decimals` places (string)
     */
    public function handle(string $solanaAddress): array
    {
        $mint = config('services.cyber_sol.mint');
        $decimals = (int) config('services.cyber_sol.decimals', 6);

        $call = [
            'jsonrpc' => '2.0',
            'id' => 1,
            'method' => 'getTokenAccountsByOwner',
            'params' => [
                $solanaAddress,
                ['mint' => $mint],
                ['encoding' => 'jsonParsed', 'commitment' => 'confirmed'],
            ],
        ];

        $body = $this->proxy()->enabled()
            ? $this->proxy()->forward($call)
            : $this->direct($call);

        if (isset($body['error'])) {
            throw new \RuntimeException('Solana RPC error: '.json_encode($body['error']));
        }

        $raw = '0';
        foreach (($body['result']['value'] ?? []) as $account) {
            $amount = $account['account']['data']['parsed']['info']['tokenAmount']['amount'] ?? '0';
            $raw = bcadd($raw, (string) $amount, 0);
        }

        return [
            'raw' => $raw,
            'amount' => bcdiv($raw, bcpow('10', (string) $decimals), $decimals),
            'decimals' => $decimals,
        ];
    }

    private function proxy(): SolanaRpcProxy
    {
        return $this->rpc ??= app(SolanaRpcProxy::class);
    }

    /**
     * The single configured endpoint, for when the relay is switched off —
     * exactly the call this action made before the failover existed.
     *
     * @param  array<string, mixed>  $call
     * @return array<string, mixed>
     */
    private function direct(array $call): array
    {
        $res = Http::timeout(15)->acceptJson()->post(config('services.cyber_sol.rpc_url'), $call);

        if (! $res->successful()) {
            throw new \RuntimeException('Solana RPC HTTP '.$res->status());
        }

        return (array) $res->json();
    }

    /** True when `raw` base units meet or exceed `wholeTokens` of CYBER.sol. */
    public function meetsThreshold(string $raw, int|string $wholeTokens, int $decimals = 6): bool
    {
        $thresholdRaw = bcmul((string) $wholeTokens, bcpow('10', (string) $decimals), 0);

        return bccomp($raw, $thresholdRaw, 0) >= 0;
    }
}
