<?php

namespace App\Services;

use App\Services\Monero\MoneroWalletRpc;
use App\Support\BridgeCapacity;
use App\Support\TokenAmount;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * How much of a token the relayer can actually pay out to a destination chain
 * right now — the live withdrawal capacity behind every admission decision.
 *
 * With unified wrappers (one USDC across Solana + Base, one USDT across Solana
 * + BNB, …) a token's Cyberia supply is NOT tied to any single chain's reserve,
 * so the per-chain limit is enforced here from the relayer's live inventory on
 * the destination chain instead of by minting a separate wrapper per chain.
 *
 * Two rules this file exists to keep:
 *
 *  1. **Fail closed.** Every answer is a {@see BridgeCapacity}. A failed read
 *     is `unavailable`, which covers nothing; only a destination the relayer
 *     genuinely mints into is `unlimited`. They are never the same value.
 *  2. **Deliverable, not merely held.** A balance that cannot pay for its own
 *     transaction is not inventory. An ERC20 reserve with no gas coin, or an
 *     SPL reserve on a hot wallet with no lamports, reports zero.
 */
class BridgeInventoryService
{
    public function __construct(
        private BridgeRelayerService $relayer,
        private BridgeFeeService $fee,
    ) {}

    /**
     * Live deliverable capacity for a route + token, as raw integer units in
     * the destination entry's own decimals.
     */
    public function capacity(string $direction, string $token): BridgeCapacity
    {
        $context = $this->destinationContext($direction, $token);

        if ($context === null) {
            return BridgeCapacity::unavailable('route or token is not configured');
        }

        [$chain, $entry, $chainKey] = $context;
        $decimals = (int) ($entry['decimals'] ?? 18);

        if ($this->mintsOnDestination($token, $chainKey, $entry)) {
            return BridgeCapacity::unlimited($decimals);
        }

        $type = (string) ($chain['type'] ?? '');

        if (! in_array($type, (array) config('bridge.inventory.measured_chain_types', []), true)) {
            return BridgeCapacity::unmeasured(
                $decimals,
                "inventory on '{$chainKey}' is held in manual reserves and is not read by this server",
            );
        }

        return match ($type) {
            'evm' => $this->evmCapacity($direction, $token, $chain, $entry),
            'solana' => $this->solanaCapacity($chain, $entry),
            'ton' => $this->tonCapacity($direction, $token, $chain, $entry),
            'monero' => $this->moneroCapacity($entry),
            default => BridgeCapacity::unavailable("no inventory reader for chain type '{$type}'", $decimals),
        };
    }

    /**
     * Identity of the balance a payout spends: destination chain + the exact
     * asset on it. Two corridors landing on the same balance (USDC arriving on
     * Solana from Cyberia and from Base) share one pool and therefore one lock
     * and one reservation ledger; two different assets never do.
     */
    public function poolKey(string $direction, string $token): ?string
    {
        $context = $this->destinationContext($direction, $token);

        if ($context === null) {
            return null;
        }

        [, $entry, $chainKey] = $context;

        $asset = match (true) {
            ($entry['native'] ?? false) === true => 'native',
            is_string($entry['address'] ?? null) && $entry['address'] !== '' => strtolower((string) $entry['address']),
            is_string($entry['mint'] ?? null) && $entry['mint'] !== '' => (string) $entry['mint'],
            is_string($entry['master'] ?? null) && $entry['master'] !== '' => (string) $entry['master'],
            default => $token,
        };

        return $chainKey.':'.$asset;
    }

    /**
     * Decimals the payout is denominated in on the destination chain. Every
     * raw-unit comparison in the admission path is scaled by this and never by
     * the source side's decimals (Cyberia USDC is 6, BSC USDT is 18).
     */
    public function destinationDecimals(string $direction, string $token): ?int
    {
        $context = $this->destinationContext($direction, $token);

        return $context === null ? null : (int) ($context[1]['decimals'] ?? 18);
    }

    /**
     * Legacy display shim: the human capacity string, or null when there is no
     * finite number. **Never branch on this for an admission decision** — null
     * here still conflates "unlimited" with "we could not read it". Use
     * {@see capacity()}.
     */
    public function destinationCapacity(string $direction, string $token): ?string
    {
        return $this->capacity($direction, $token)->availableAmount();
    }

    /**
     * A destination the relayer mints into on demand has no inventory ceiling:
     * on the home chain it mints the wrapper ('mint') or CyberBridge mints on
     * release ('native'); an 'owned' entry (bridged CYBER on Robinhood) is the
     * same relayer-owned mint-on-demand wrapper on a non-home chain.
     *
     * Exception: a native-entry payout (bridged CYBER coming home) spends the
     * relayer's own coin balance, so it IS inventory-capped.
     *
     * @param  array<string, mixed>  $entry
     */
    private function mintsOnDestination(string $token, string $chainKey, array $entry): bool
    {
        $tokenConfig = config('bridge.tokens', [])[$token] ?? [];
        $model = $tokenConfig['model'] ?? 'direct';

        if ($entry['native'] ?? false) {
            return false;
        }

        $mintingHome = $chainKey === config('bridge.home_chain', 'cyberia')
            && in_array($model, ['mint', 'native'], true);

        return $mintingHome || ($model === 'mint' && ($entry['owned'] ?? false));
    }

    /**
     * @return array{0: array<string, mixed>, 1: array<string, mixed>, 2: string}|null
     */
    private function destinationContext(string $direction, string $token): ?array
    {
        $route = config('bridge.routes', [])[$direction] ?? null;

        if (! is_array($route)) {
            return null;
        }

        $chainKey = (string) ($route['destination_chain'] ?? '');
        $chain = config('bridge.chains', [])[$chainKey] ?? null;
        $tokenConfig = config('bridge.tokens', [])[$token] ?? null;

        if (! is_array($chain) || ! is_array($tokenConfig)) {
            return null;
        }

        $entry = $tokenConfig['chains'][$chainKey] ?? null;

        return is_array($entry) ? [$chain, $entry, $chainKey] : null;
    }

    /**
     * @param  array<string, mixed>  $chain
     * @param  array<string, mixed>  $entry
     */
    private function evmCapacity(string $direction, string $token, array $chain, array $entry): BridgeCapacity
    {
        $relayer = $this->relayer->evmAddress();
        $rpc = (string) ($chain['rpc_url'] ?? '');
        $decimals = (int) ($entry['decimals'] ?? 18);

        if ($relayer === null || $rpc === '') {
            return BridgeCapacity::unavailable('relayer address or RPC url is not configured', $decimals);
        }

        $balanceRaw = $this->evmCall($rpc, 'eth_getBalance', [$relayer, 'latest']);

        if ($balanceRaw === null) {
            return BridgeCapacity::unavailable('relayer native balance could not be read', $decimals);
        }

        // Native-coin payout (e.g. ETH on Base, BNB on BSC): balance minus the
        // gas the payout retains, so the shown max is actually deliverable.
        if ($entry['native'] ?? false) {
            $reserveRaw = TokenAmount::toRaw($this->fee->nativePayoutFee($direction, $token), $decimals);

            return BridgeCapacity::available(bcsub($balanceRaw, $reserveRaw, 0), $decimals);
        }

        // ERC20 payout from relayer inventory: balanceOf(relayer), but only if
        // the relayer can pay for the transfer. Tokens it cannot move are not
        // deliverable inventory — that is the "USDC and no CYBER" failure the
        // wallet already names, seen from the relayer's side.
        $address = (string) ($entry['address'] ?? '');

        if ($address === '') {
            return BridgeCapacity::unavailable('token has no contract address on this chain', $decimals);
        }

        if (bccomp($balanceRaw, $this->evmTransferGasCostWei($chain), 0) < 0) {
            Log::warning('Bridge inventory: relayer cannot pay destination gas', [
                'chain' => $chain['key'] ?? null,
                'token' => $token,
            ]);

            return BridgeCapacity::available('0', $decimals);
        }

        $data = '0x70a08231'.str_pad(substr($relayer, 2), 64, '0', STR_PAD_LEFT);
        $tokenRaw = $this->evmCall($rpc, 'eth_call', [['to' => $address, 'data' => $data], 'latest']);

        return $tokenRaw === null
            ? BridgeCapacity::unavailable('relayer token balance could not be read', $decimals)
            : BridgeCapacity::available($tokenRaw, $decimals);
    }

    /**
     * Worst-case gas a token payout costs on this chain, in wei. Uses the
     * configured floor rather than a live quote: this is a solvency check on
     * the relayer, and a floor that fails closed beats an RPC round trip that
     * can itself fail.
     *
     * @param  array<string, mixed>  $chain
     */
    private function evmTransferGasCostWei(array $chain): string
    {
        $floorWei = bcmul(
            (string) config('bridge.fee.native_gas_price_floor_gwei', '3'),
            '1000000000',
            0,
        );
        $gasLimit = (string) config('bridge.inventory.token_transfer_gas_limit', 120000);
        $multiplierBps = (string) config('bridge.fee.native_gas_multiplier_bps', 20000);

        unset($chain);

        return bcdiv(bcmul(bcmul($floorWei, $gasLimit, 0), $multiplierBps, 0), '10000', 0);
    }

    /**
     * Single JSON-RPC read returning a decimal string, or null on any failure.
     *
     * @param  array<int, mixed>  $params
     */
    private function evmCall(string $rpc, string $method, array $params): ?string
    {
        try {
            $response = Http::timeout(8)->post($rpc, [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => $method,
                'params' => $params,
            ]);

            $hex = $response->json('result');

            if (! $response->successful() || ! is_string($hex) || ! str_starts_with($hex, '0x')) {
                return null;
            }

            return TokenAmount::hexToDec($hex);
        } catch (\Throwable $e) {
            Log::warning('Bridge inventory: evm read failed', [
                'method' => $method,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }

    /**
     * TON hot-wallet inventory via tonapi: native Toncoin balance for TON
     * payouts (minus the retained fee reserve), jetton balance for jetton
     * payouts (zero unless the wallet can also pay the message fee).
     *
     * @param  array<string, mixed>  $chain
     * @param  array<string, mixed>  $entry
     */
    private function tonCapacity(string $direction, string $token, array $chain, array $entry): BridgeCapacity
    {
        $hotWallet = (string) ($chain['deposit_address'] ?? '');
        $decimals = (int) ($entry['decimals'] ?? 9);

        if ($hotWallet === '') {
            return BridgeCapacity::unavailable('TON hot wallet is not configured', $decimals);
        }

        $native = $this->tonBalance($chain, '/v2/accounts/'.rawurlencode($hotWallet));

        if ($native === null) {
            return BridgeCapacity::unavailable('TON hot-wallet balance could not be read', $decimals);
        }

        if ($entry['native'] ?? false) {
            $reserveRaw = TokenAmount::toRaw($this->fee->nativePayoutFee($direction, $token), $decimals);

            return BridgeCapacity::available(bcsub($native, $reserveRaw, 0), $decimals);
        }

        $master = (string) ($entry['master'] ?? '');

        if ($master === '') {
            return BridgeCapacity::unavailable('jetton master is not configured', $decimals);
        }

        // Toncoin is what carries a jetton transfer: no gas, no inventory.
        $feeReserve = TokenAmount::toRaw((string) config('bridge.inventory.ton_fee_reserve', '0.1'), 9);

        if (bccomp($native, $feeReserve, 0) < 0) {
            return BridgeCapacity::available('0', $decimals);
        }

        $jetton = $this->tonBalance(
            $chain,
            '/v2/accounts/'.rawurlencode($hotWallet).'/jettons/'.rawurlencode($master),
        );

        return $jetton === null
            ? BridgeCapacity::unavailable('jetton balance could not be read', $decimals)
            : BridgeCapacity::available($jetton, $decimals);
    }

    /**
     * What the bridge's own Monero wallet can actually pay out right now.
     *
     * Monero is the one chain here whose inventory used to be unreadable by
     * definition — an outsider cannot see a balance, which is the point of the
     * chain — so it was declared manual and the corridor carried no number.
     * With a wallet attached to this server that stops being true, and the
     * corridor becomes admission-controlled like every other measurable one.
     * With no wallet it goes back to saying nothing, which is different from
     * saying zero.
     *
     * `unlocked` and not `balance`: an output is locked for ten blocks after
     * it arrives, so the total is a claim about the near future while the
     * unlocked part is what a payout can spend in this minute.
     *
     * @param  array<string, mixed>  $entry
     */
    private function moneroCapacity(array $entry): BridgeCapacity
    {
        $decimals = (int) ($entry['decimals'] ?? 12);
        $wallet = app(MoneroWalletRpc::class);

        if (! $wallet->configured()) {
            return BridgeCapacity::unmeasured(
                $decimals,
                'no Monero wallet is attached to this server; the reserve is held manually',
            );
        }

        $unlocked = $wallet->unlockedBalance();

        if ($unlocked === null) {
            return BridgeCapacity::unavailable('Monero wallet balance could not be read', $decimals);
        }

        // A Monero transaction fee is charged to the sender on top of what it
        // sends, so a balance that exactly covers a payout does not cover it.
        $reserve = TokenAmount::toRaw(
            (string) config('bridge.inventory.monero_fee_reserve_xmr', '0.01'),
            $decimals,
        );

        return BridgeCapacity::available(bcsub($unlocked, $reserve, 0), $decimals);
    }

    /**
     * @param  array<string, mixed>  $chain
     */
    private function tonBalance(array $chain, string $path): ?string
    {
        $apiUrl = rtrim((string) ($chain['api_url'] ?? 'https://tonapi.io'), '/');

        try {
            $request = Http::timeout(8)->acceptJson();

            if (! empty($chain['api_key'])) {
                $request = $request->withToken((string) $chain['api_key']);
            }

            $response = $request->get($apiUrl.$path);

            if (! $response->successful()) {
                return null;
            }

            $balanceRaw = (string) $response->json('balance');

            return ctype_digit($balanceRaw) ? $balanceRaw : null;
        } catch (\Throwable $e) {
            Log::warning('Bridge inventory: ton read failed', ['error' => $e->getMessage()]);

            return null;
        }
    }

    /**
     * @param  array<string, mixed>  $chain
     * @param  array<string, mixed>  $entry
     */
    private function solanaCapacity(array $chain, array $entry): BridgeCapacity
    {
        $hotWallet = (string) ($chain['deposit_address'] ?? '');
        $mint = (string) ($entry['mint'] ?? '');
        $rpc = (string) ($chain['rpc_url'] ?? '');
        $decimals = (int) ($entry['decimals'] ?? 9);

        if ($hotWallet === '' || $rpc === '') {
            return BridgeCapacity::unavailable('Solana hot wallet or RPC url is not configured', $decimals);
        }

        // 0.01 SOL held back: rent-exempt minimum (~0.00089 SOL) plus headroom
        // for the payout fee and one recipient ATA creation.
        $reserveRaw = TokenAmount::toRaw(
            (string) config('bridge.inventory.solana_fee_reserve_sol', '0.01'),
            9,
        );
        $lamports = $this->solanaLamports($hotWallet, $rpc);

        if ($lamports === null) {
            return BridgeCapacity::unavailable('Solana hot-wallet lamports could not be read', $decimals);
        }

        // Native SOL payout: lamports minus the reserve that keeps the account
        // rent-exempt and covers transaction fees.
        if ($entry['native'] ?? false) {
            return BridgeCapacity::available(bcsub($lamports, $reserveRaw, 0), $decimals);
        }

        if ($mint === '') {
            return BridgeCapacity::unavailable('token has no mint on Solana', $decimals);
        }

        // An SPL balance the hot wallet cannot pay to move is not inventory.
        if (bccomp($lamports, $reserveRaw, 0) < 0) {
            Log::warning('Bridge inventory: Solana hot wallet cannot pay payout fees', [
                'mint' => $mint,
            ]);

            return BridgeCapacity::available('0', $decimals);
        }

        try {
            $response = Http::timeout(8)->post($rpc, [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'getTokenAccountsByOwner',
                'params' => [
                    $hotWallet,
                    ['mint' => $mint],
                    ['encoding' => 'jsonParsed'],
                ],
            ]);

            $accounts = $response->json('result.value');

            if (! $response->successful() || ! is_array($accounts)) {
                return BridgeCapacity::unavailable('Solana token accounts could not be read', $decimals);
            }

            $total = '0';

            foreach ($accounts as $account) {
                $raw = $account['account']['data']['parsed']['info']['tokenAmount']['amount'] ?? null;
                $dec = $account['account']['data']['parsed']['info']['tokenAmount']['decimals'] ?? null;

                if (! is_string($raw) || ! ctype_digit($raw) || ! is_int($dec)) {
                    // A malformed account entry is a read failure, not a zero:
                    // silently skipping it would understate — or, with every
                    // entry malformed, invent — the reserve.
                    return BridgeCapacity::unavailable('Solana token account entry was malformed', $decimals);
                }

                // Scale each account into the destination entry's decimals;
                // the mint decides them, not the wrapper on the other side.
                $total = bcadd($total, $this->rescaleRaw($raw, $dec, $decimals), 0);
            }

            return BridgeCapacity::available($total, $decimals);
        } catch (\Throwable $e) {
            Log::warning('Bridge inventory: solana read failed', ['error' => $e->getMessage()]);

            return BridgeCapacity::unavailable('Solana RPC read failed', $decimals);
        }
    }

    private function solanaLamports(string $hotWallet, string $rpc): ?string
    {
        try {
            $response = Http::timeout(8)->post($rpc, [
                'jsonrpc' => '2.0',
                'id' => 1,
                'method' => 'getBalance',
                'params' => [$hotWallet],
            ]);

            $lamports = $response->json('result.value');

            if (! $response->successful()) {
                return null;
            }

            if (is_int($lamports)) {
                return (string) $lamports;
            }

            return is_string($lamports) && ctype_digit($lamports) ? $lamports : null;
        } catch (\Throwable $e) {
            Log::warning('Bridge inventory: solana native read failed', ['error' => $e->getMessage()]);

            return null;
        }
    }

    /**
     * Raw integer rescale between two decimal scales, truncating downwards so
     * a rescale can never conjure a unit that is not there.
     */
    private function rescaleRaw(string $raw, int $from, int $to): string
    {
        if ($from === $to) {
            return $raw;
        }

        return $from < $to
            ? bcmul($raw, bcpow('10', (string) ($to - $from)), 0)
            : bcdiv($raw, bcpow('10', (string) ($from - $to)), 0);
    }
}
