<?php

namespace App\Services\Arena;

use App\Services\SolanaRpcProxy;
use Carbon\CarbonImmutable;
use DomainException;
use Illuminate\Support\Facades\Http;

class ArenaMarketFeed
{
    private const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    private const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PeBkAWNCKZ3FV1'];

    public function __construct(private SolanaRpcProxy $solana) {}

    /** @return array<string, mixed> */
    public function specification(?string $market = null): array
    {
        if (($market ?? config('arena.market')) === 'solana-hatcher-sol') {
            return [
                'kind' => 'solana-pumpswap', 'cluster' => 'mainnet',
                'program' => 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
                'pool' => 'CGH49JQDQSh7U8nQrDhutEV4QB3h1NxsJoe7ho7UtSH3',
                'base_mint' => 'Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump',
                'quote_mint' => 'So11111111111111111111111111111111111111112',
                'base_decimals' => 6, 'quote_decimals' => 9, 'lot' => 1000000,
                'label' => 'Solana PumpSwap HATCHER/SOL spot per 1M HATCHER; modeled paper execution',
            ];
        }

        return [
            'chain_id' => 8453,
            'factory' => '0x33128a8fc17869897dce68ed026d694621f6fdfd',
            'pool' => '0xd0b53d9277642d899df5c87a3966a349a798f224',
            'token0' => '0x4200000000000000000000000000000000000006',
            'token1' => '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
            'decimals0' => 18, 'decimals1' => 6, 'pool_fee' => 500,
            'label' => 'Base Uniswap V3 WETH/USDC 0.05% spot; modeled paper execution',
        ];
    }

    /** @param array<string, mixed> $spec
     * @return array<string, mixed>
     */
    public function quote(array $spec, int $maxAge): array
    {
        // A frozen season is checked against its own market, whatever market
        // a new season would be created on today.
        $expected = $this->specification(($spec['kind'] ?? null) === 'solana-pumpswap' ? 'solana-hatcher-sol' : 'base-weth-usdc');
        ksort($spec);
        ksort($expected);
        if ($spec !== $expected) {
            throw new DomainException('market_specification_changed');
        }
        if (($spec['kind'] ?? null) === 'solana-pumpswap') {
            return $this->solanaQuote($spec, $maxAge);
        }
        $head = $this->batch([['eth_chainId', []], ['eth_getBlockByNumber', ['latest', false]]]);
        $block = $head[1];
        if ($this->decimal($head[0]) !== '8453' || ! is_array($block)
            || ! preg_match('/^0x[a-fA-F0-9]{64}$/D', $block['hash'] ?? '')) {
            throw new DomainException('invalid_market_head');
        }
        $number = $this->decimal($block['number'] ?? '');
        $timestamp = $this->decimal($block['timestamp'] ?? '');
        if (strlen($timestamp) > 11 || $number === '0') {
            throw new DomainException('invalid_market_head');
        }
        $blockAt = CarbonImmutable::createFromTimestampUTC((int) $timestamp);
        $now = CarbonImmutable::now('UTC');
        if ($blockAt->lessThan($now->subSeconds($maxAge)) || $blockAt->greaterThan($now->addSeconds(5))) {
            throw new DomainException('stale_market_head');
        }
        $poolData = '0x1698ee82'.str_pad(substr($spec['token0'], 2), 64, '0', STR_PAD_LEFT)
            .str_pad(substr($spec['token1'], 2), 64, '0', STR_PAD_LEFT).str_pad(dechex($spec['pool_fee']), 64, '0', STR_PAD_LEFT);
        $calls = [[$spec['factory'], $poolData], [$spec['pool'], '0x0dfe1681'], [$spec['pool'], '0xd21220a7'],
            [$spec['pool'], '0xddca3f43'], [$spec['pool'], '0x3850c7bd'], [$spec['pool'], '0x1a686502'],
            [$spec['token0'], '0x313ce567'], [$spec['token1'], '0x313ce567']];
        $values = $this->batch(array_map(fn ($call) => ['eth_call', [['to' => $call[0], 'data' => $call[1]], $block['number']]], $calls));
        foreach ([0 => $spec['pool'], 1 => $spec['token0'], 2 => $spec['token1']] as $index => $address) {
            if (! is_string($values[$index]) || strtolower($values[$index]) !== '0x'.str_repeat('0', 24).substr($address, 2)) {
                throw new DomainException('wrong_market_contract');
            }
        }
        if ($this->decimal($values[3]) !== '500' || $this->decimal($values[6]) !== '18'
            || $this->decimal($values[7]) !== '6' || ! is_string($values[4]) || ! preg_match('/^0x[a-fA-F0-9]{448}$/D', $values[4])
            || $this->decimal('0x'.substr($values[4], -64)) !== '1' || $this->decimal($values[5]) === '0') {
            throw new DomainException('invalid_market_state');
        }
        $check = $this->batch([['eth_getBlockByNumber', [$block['number'], false]]])[0];
        if (! is_array($check) || ($check['hash'] ?? null) !== $block['hash']) {
            throw new DomainException('market_block_changed');
        }
        if ($blockAt->lessThan(CarbonImmutable::now('UTC')->subSeconds($maxAge))) {
            throw new DomainException('stale_market_head');
        }
        $sqrtPrice = $this->decimal('0x'.substr($values[4], 2, 64));
        $price = bcdiv(bcmul(bcmul($sqrtPrice, $sqrtPrice, 0), '1000000000000000000', 0), bcpow('2', '192', 0), 0);
        if (bccomp($price, '1', 0) < 0 || bccomp($price, '100000000000000', 0) > 0) {
            throw new DomainException('invalid_market_price');
        }

        return [
            'price_micros' => $price, 'observed_at' => CarbonImmutable::now('UTC')->toIso8601String(),
            'block_at' => $blockAt->toIso8601String(),
            'source' => ['chain_id' => 8453, 'block_number' => $number, 'block_hash' => $block['hash'], 'label' => $spec['label']],
            'sqrt_price_x96' => $sqrtPrice, 'liquidity' => $this->decimal($values[5]),
        ];
    }

    /**
     * Spot price of a PumpSwap pool from its two vaults at one finalized slot.
     *
     * The vaults are read out of the pool account and then checked from the
     * other side — each must be a token account of the expected mint whose
     * authority is the pool — so a wrong layout assumption fails closed
     * instead of pricing some other pair.
     *
     * @param  array<string, mixed>  $spec
     * @return array<string, mixed>
     */
    private function solanaQuote(array $spec, int $maxAge): array
    {
        $pool = $this->solanaCall('getAccountInfo', [$spec['pool'], ['encoding' => 'base64', 'commitment' => 'finalized']]);
        $data = base64_decode((string) ($pool['value']['data'][0] ?? ''), true);
        if (($pool['value']['owner'] ?? null) !== $spec['program'] || ! is_string($data) || strlen($data) < 203
            || substr($data, 43, 32) !== $this->base58Decode($spec['base_mint'])
            || substr($data, 75, 32) !== $this->base58Decode($spec['quote_mint'])) {
            throw new DomainException('wrong_market_contract');
        }
        $vaults = [$this->base58Encode(substr($data, 139, 32)), $this->base58Encode(substr($data, 171, 32))];
        $read = $this->solanaCall('getMultipleAccounts', [$vaults, ['encoding' => 'jsonParsed', 'commitment' => 'finalized',
            'minContextSlot' => (int) ($pool['context']['slot'] ?? 0)]]);
        $slot = (int) ($read['context']['slot'] ?? 0);
        $amounts = [];
        foreach ([[$spec['base_mint'], $spec['base_decimals']], [$spec['quote_mint'], $spec['quote_decimals']]] as $index => [$mint, $decimals]) {
            $account = $read['value'][$index] ?? null;
            $info = $account['data']['parsed']['info'] ?? null;
            if (! is_array($account) || ! in_array($account['owner'] ?? null, self::TOKEN_PROGRAMS, true) || ! is_array($info)
                || ($info['mint'] ?? null) !== $mint || ($info['owner'] ?? null) !== $spec['pool']
                || ($info['tokenAmount']['decimals'] ?? null) !== $decimals
                || ! preg_match('/^[1-9][0-9]{0,24}$/D', (string) ($info['tokenAmount']['amount'] ?? ''))) {
                throw new DomainException('wrong_market_contract');
            }
            $amounts[] = (string) $info['tokenAmount']['amount'];
        }
        $timestamp = $this->solanaCall('getBlockTime', [$slot]);
        if ($slot < 1 || ! is_int($timestamp)) {
            throw new DomainException('invalid_market_head');
        }
        $blockAt = CarbonImmutable::createFromTimestampUTC($timestamp);
        $now = CarbonImmutable::now('UTC');
        if ($blockAt->lessThan($now->subSeconds($maxAge)) || $blockAt->greaterThan($now->addSeconds(5))) {
            throw new DomainException('stale_market_head');
        }
        $hash = $this->solanaCall('getLatestBlockhash', [['commitment' => 'finalized']])['value']['blockhash'] ?? null;
        if (! is_string($hash) || ! preg_match('/^[1-9A-HJ-NP-Za-km-z]{32,44}$/D', $hash)) {
            throw new DomainException('invalid_market_head');
        }
        // Cash micros per lot: quote/10^qd * 10^6 per (base/10^bd / lot).
        $price = bcdiv(bcmul(bcmul($amounts[1], (string) $spec['lot'], 0), bcpow('10', (string) (6 + $spec['base_decimals']), 0), 0),
            bcmul($amounts[0], bcpow('10', (string) $spec['quote_decimals'], 0), 0), 0);
        if (bccomp($price, '1', 0) < 0 || bccomp($price, '100000000000000', 0) > 0) {
            throw new DomainException('invalid_market_price');
        }

        return [
            'price_micros' => $price, 'observed_at' => $now->toIso8601String(), 'block_at' => $blockAt->toIso8601String(),
            'source' => ['chain_id' => 101, 'block_number' => (string) $slot, 'block_hash' => $hash, 'label' => $spec['label']],
            'reserves' => ['base' => $amounts[0], 'quote' => $amounts[1]],
        ];
    }

    /** @param array<mixed> $params */
    private function solanaCall(string $method, array $params): mixed
    {
        try {
            $response = $this->solana->forward(['jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => $params]);
        } catch (\RuntimeException) {
            throw new DomainException('market_rpc_failed');
        }
        if (isset($response['error']) || ! array_key_exists('result', $response)) {
            throw new DomainException('invalid_market_rpc_response');
        }

        return $response['result'];
    }

    private function base58Decode(string $input): string
    {
        $number = '0';
        foreach (str_split($input) as $char) {
            $digit = strpos(self::BASE58, $char);
            if ($digit === false) {
                throw new DomainException('invalid_market_address');
            }
            $number = bcadd(bcmul($number, '58', 0), (string) $digit, 0);
        }
        $bytes = '';
        while (bccomp($number, '0', 0) > 0) {
            $bytes = chr((int) bcmod($number, '256')).$bytes;
            $number = bcdiv($number, '256', 0);
        }

        return str_repeat("\0", strspn($input, '1')).$bytes;
    }

    private function base58Encode(string $bytes): string
    {
        $number = '0';
        foreach (str_split($bytes) as $byte) {
            $number = bcadd(bcmul($number, '256', 0), (string) ord($byte), 0);
        }
        $output = '';
        while (bccomp($number, '0', 0) > 0) {
            $output = self::BASE58[(int) bcmod($number, '58')].$output;
            $number = bcdiv($number, '58', 0);
        }

        return str_repeat('1', strlen($bytes) - strlen(ltrim($bytes, "\0"))).$output;
    }

    /** @param array<int, array{0: string, 1: array<mixed>}> $calls
     * @return array<mixed>
     */
    private function batch(array $calls): array
    {
        $url = (string) config('arena.automation.rpc_url');
        if (parse_url($url, PHP_URL_SCHEME) !== 'https') {
            throw new DomainException('market_rpc_requires_https');
        }
        $payload = [];
        foreach ($calls as $id => [$method, $params]) {
            $payload[] = ['jsonrpc' => '2.0', 'id' => $id, 'method' => $method, 'params' => $params];
        }
        $response = Http::acceptJson()->connectTimeout(3)->timeout(10)->withOptions(['allow_redirects' => false])->post($url, $payload);
        $body = $response->json();
        if (! $response->successful() || strlen($response->body()) > 262144 || ! is_array($body) || count($body) !== count($calls)) {
            throw new DomainException('market_rpc_failed');
        }
        $results = [];
        foreach ($body as $row) {
            if (! is_array($row) || ! is_int($row['id'] ?? null) || ! array_key_exists($row['id'], $calls)
                || array_key_exists($row['id'], $results) || isset($row['error']) || ! isset($row['result'])) {
                throw new DomainException('invalid_market_rpc_response');
            }
            $results[$row['id']] = $row['result'];
        }
        ksort($results);

        return array_values($results);
    }

    private function decimal(mixed $hex): string
    {
        if (! is_string($hex) || ! preg_match('/^0x[a-fA-F0-9]{1,64}$/D', $hex)) {
            throw new DomainException('invalid_market_integer');
        }
        $result = '0';
        foreach (str_split(substr($hex, 2)) as $digit) {
            $result = bcadd(bcmul($result, '16', 0), (string) hexdec($digit), 0);
        }

        return $result;
    }
}
