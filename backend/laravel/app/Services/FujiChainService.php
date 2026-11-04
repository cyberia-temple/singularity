<?php

namespace App\Services;

use App\Support\TokenAmount;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * Everything the wallet's chain panel shows about Cyberia Fuji (49407).
 *
 * Read-only, and read from the chain rather than restated from config: the
 * fee rules from FeeManager, where fees go from RewardManager, who may mint
 * from NativeMinter, how long the validator's P-Chain balance lasts, and the
 * balances of the addresses that stop the chain's services when they run dry.
 *
 * Nothing here signs. Changing a rule is a transaction the admin's own wallet
 * signs in the browser; this class only says who the chain lists as allowed
 * to, so the panel offers the controls to that wallet and to nobody else.
 */
class FujiChainService
{
    private const NATIVE_MINTER = '0x0200000000000000000000000000000000000001';

    private const FEE_MANAGER = '0x0200000000000000000000000000000000000003';

    private const REWARD_MANAGER = '0x0200000000000000000000000000000000000004';

    private const GET_FEE_CONFIG = '0x5fbbc0d2';

    private const FEE_CONFIG_CHANGED_AT = '0x9e05549a';

    private const CURRENT_REWARD_ADDRESS = '0xe915608b';

    private const FEE_RECIPIENTS_ALLOWED = '0xf6542b2e';

    private const READ_ALLOW_LIST = '0xeb54dae1';

    /** FeeManager's getFeeConfig(), in return order. */
    public const FEE_FIELDS = [
        'gasLimit',
        'targetBlockRate',
        'minBaseFee',
        'targetGas',
        'baseFeeChangeDenominator',
        'minBlockGasCost',
        'maxBlockGasCost',
        'blockGasCostStep',
    ];

    public function __construct(
        private FujiRpc $rpc,
        private FujiFaucetService $faucet,
        private BridgeRelayerService $bridge,
        private CyberPriceService $cyberSol,
        private WalletPriceService $prices,
    ) {}

    /**
     * The panel's whole picture, cached briefly because every open wallet asks.
     * With an address, also that address's roles on the two managed precompiles.
     *
     * @return array<string, mixed>
     */
    public function status(?string $address = null): array
    {
        $status = Cache::remember('fuji.chain:status', 15, fn (): array => $this->read());

        if ($address !== null && preg_match('/^0x[a-fA-F0-9]{40}$/', $address) === 1) {
            $status['roles'] = [
                'feeManager' => $this->role(self::FEE_MANAGER, $address),
                'rewardManager' => $this->role(self::REWARD_MANAGER, $address),
            ];
        }

        return $status;
    }

    /**
     * @return array<string, mixed>
     */
    private function read(): array
    {
        $treasury = (string) config('fuji.treasury');

        return [
            'chainId' => $this->rpc->chainId(),
            'block' => $this->latestBlock(),
            'gasPrice' => $this->rpc->quantity('eth_gasPrice'),
            'feeConfig' => $this->feeConfig(),
            'feeConfigChangedAt' => $this->number($this->rpc->call(self::FEE_MANAGER, self::FEE_CONFIG_CHANGED_AT)),
            'rewards' => $this->rewards(),
            'treasury' => ['address' => $treasury, 'balance' => $this->rpc->balance($treasury)],
            'validator' => $this->validator(),
            'wallets' => $this->wallets(),
            'minters' => array_map(
                fn (string $minter): array => ['address' => $minter, 'role' => $this->role(self::NATIVE_MINTER, $minter)],
                (array) config('fuji.chain.native_minters', []),
            ),
            'pricing' => $this->pricing(),
        ];
    }

    /**
     * @return array{number: int, timestamp: int, baseFee: string|null}|null
     */
    private function latestBlock(): ?array
    {
        $block = $this->rpc->request('eth_getBlockByNumber', ['latest', false]);

        if (! is_array($block) || ! is_string($block['number'] ?? null)) {
            return null;
        }

        return [
            'number' => (int) TokenAmount::hexToDec($block['number']),
            'timestamp' => (int) TokenAmount::hexToDec((string) ($block['timestamp'] ?? '0x0')),
            'baseFee' => is_string($block['baseFeePerGas'] ?? null) ? TokenAmount::hexToDec($block['baseFeePerGas']) : null,
        ];
    }

    /**
     * @return array<string, string>|null
     */
    private function feeConfig(): ?array
    {
        $words = $this->words($this->rpc->call(self::FEE_MANAGER, self::GET_FEE_CONFIG));

        if (count($words) < count(self::FEE_FIELDS)) {
            return null;
        }

        return array_combine(self::FEE_FIELDS, array_map(
            fn (string $word): string => TokenAmount::hexToDec($word),
            array_slice($words, 0, count(self::FEE_FIELDS)),
        ));
    }

    /**
     * @return array{address: string|null, feeRecipientsAllowed: bool|null}
     */
    private function rewards(): array
    {
        $address = $this->words($this->rpc->call(self::REWARD_MANAGER, self::CURRENT_REWARD_ADDRESS))[0] ?? null;
        $allowed = $this->words($this->rpc->call(self::REWARD_MANAGER, self::FEE_RECIPIENTS_ALLOWED))[0] ?? null;
        $address = $address !== null ? '0x'.substr($address, -40) : null;

        return [
            // Zero means no single recipient: fees burn, or go to block producers.
            'address' => $address !== null && $address !== '0x'.str_repeat('0', 40) ? $address : null,
            'feeRecipientsAllowed' => $allowed !== null ? TokenAmount::hexToDec($allowed) !== '0' : null,
        ];
    }

    /**
     * The validator's P-Chain balance and how long it lasts at today's price.
     * The P-Chain charges by the second; when the balance is gone, the L1 stops.
     *
     * @return array{validationId: string, nodeId: string|null, balance: string, price: string, secondsLeft: int, haltsAt: string}|null
     */
    private function validator(): ?array
    {
        $validationId = (string) config('fuji.chain.validation_id');

        if ($validationId === '') {
            return null;
        }

        $validator = $this->pchain('platform.getL1Validator', ['validationID' => $validationId]);
        $fee = $this->pchain('platform.getValidatorFeeState', []);

        if (! is_array($validator) || ! isset($validator['balance']) || ! is_array($fee) || ! isset($fee['price'])) {
            return null;
        }

        $balance = (string) $validator['balance'];
        $price = (string) $fee['price'];
        $secondsLeft = bccomp($price, '0') > 0 ? (int) bcdiv($balance, $price, 0) : 0;

        return [
            'validationId' => $validationId,
            'nodeId' => is_string($validator['nodeID'] ?? null) ? $validator['nodeID'] : null,
            'balance' => $balance,
            'price' => $price,
            'secondsLeft' => $secondsLeft,
            'haltsAt' => now()->addSeconds($secondsLeft)->toIso8601String(),
        ];
    }

    /**
     * The addresses whose balance is a service: when one runs dry, the faucet
     * stops, bridge payouts stop, or messages to and from the C-Chain stop.
     *
     * @return list<array{key: string, address: string, balance: string|null}>
     */
    private function wallets(): array
    {
        $wallets = [
            'faucet' => $this->faucet->faucetAddress(),
            'bridge' => $this->bridge->evmAddress(),
            'icm' => (string) config('fuji.chain.icm_relayer'),
            'operator' => (string) config('fuji.chain.operator'),
        ];

        $out = [];

        foreach ($wallets as $key => $address) {
            if (! is_string($address) || preg_match('/^0x[a-fA-F0-9]{40}$/', $address) !== 1) {
                continue;
            }

            if ($key === 'operator'
                && $this->role(self::FEE_MANAGER, $address) !== 2
                && $this->role(self::REWARD_MANAGER, $address) !== 2) {
                continue;
            }

            $out[] = ['key' => $key, 'address' => $address, 'balance' => $this->rpc->balance($address)];
        }

        return $out;
    }

    /**
     * The numbers behind "a transfer costs what it costs on Ethereum": CYBER
     * priced 1:1 with CYBER.sol, ETH and Ethereum's gas price. The minimum
     * base fee that matches is ethGas × ethUsd / cyberUsd, since a transfer
     * is 21,000 gas on both chains.
     *
     * @return array{cyberUsd: float|null, ethUsd: float|null, ethGasPrice: string|null, parityMinBaseFee: string|null}
     */
    private function pricing(): array
    {
        $cyberUsd = Cache::remember('fuji.chain:cyber-usd', 300, function (): ?float {
            $price = $this->cyberSol->get()['priceUsd'] ?? null;

            return is_numeric($price) && (float) $price > 0 ? (float) $price : null;
        });

        // Base's coin is ETH; the wallet's quotes already carry its price.
        $ethUsd = $this->prices->quotes()['prices']['base'] ?? null;
        $ethUsd = is_numeric($ethUsd) && (float) $ethUsd > 0 ? (float) $ethUsd : null;

        $ethGasPrice = Cache::remember('fuji.chain:eth-gas', 300, function (): ?string {
            try {
                $result = Http::connectTimeout(3)->timeout(8)->post((string) config('fuji.chain.ethereum_rpc_url'), [
                    'jsonrpc' => '2.0', 'id' => 1, 'method' => 'eth_gasPrice', 'params' => [],
                ])->json('result');

                return is_string($result) && str_starts_with($result, '0x') ? TokenAmount::hexToDec($result) : null;
            } catch (\Throwable $e) {
                Log::warning('Ethereum gas price read failed', ['error' => $e->getMessage()]);

                return null;
            }
        });

        $parity = $cyberUsd !== null && $ethUsd !== null && $ethGasPrice !== null
            ? bcdiv(bcmul($ethGasPrice, sprintf('%.12F', $ethUsd), 12), sprintf('%.12F', $cyberUsd), 0)
            : null;

        return [
            'cyberUsd' => $cyberUsd,
            'ethUsd' => $ethUsd,
            'ethGasPrice' => $ethGasPrice,
            'parityMinBaseFee' => $parity,
        ];
    }

    /** An allow-list role: 0 none, 1 enabled, 2 admin, 3 manager; null when unreadable. */
    private function role(string $precompile, string $address): ?int
    {
        $word = $this->words($this->rpc->call(
            $precompile,
            self::READ_ALLOW_LIST.str_pad(strtolower(substr($address, 2)), 64, '0', STR_PAD_LEFT),
        ))[0] ?? null;

        return $word !== null ? (int) TokenAmount::hexToDec($word) : null;
    }

    private function pchain(string $method, array $params): mixed
    {
        try {
            return Http::connectTimeout(3)->timeout(10)->post((string) config('fuji.chain.pchain_rpc_url'), [
                'jsonrpc' => '2.0', 'id' => 1, 'method' => $method, 'params' => (object) $params,
            ])->json('result');
        } catch (\Throwable $e) {
            Log::warning('P-Chain read failed', ['method' => $method, 'error' => $e->getMessage()]);

            return null;
        }
    }

    private function number(?string $hex): ?int
    {
        $word = $this->words($hex)[0] ?? null;

        return $word !== null ? (int) TokenAmount::hexToDec($word) : null;
    }

    /**
     * @return list<string>
     */
    private function words(?string $hex): array
    {
        if ($hex === null || strlen($hex) < 66) {
            return [];
        }

        return str_split(substr($hex, 2), 64);
    }
}
