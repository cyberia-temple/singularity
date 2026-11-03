<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use JsonException;
use RuntimeException;
use stdClass;

class FujiRpcController extends Controller
{
    private const METHODS = [
        'eth_chainId', 'net_version', 'web3_clientVersion', 'eth_syncing',
        'eth_blockNumber', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory',
        'eth_getBalance', 'eth_getCode', 'eth_getStorageAt', 'eth_getTransactionCount',
        'eth_call', 'eth_estimateGas', 'eth_getBlockByNumber', 'eth_getBlockByHash',
        'eth_getBlockTransactionCountByNumber', 'eth_getBlockTransactionCountByHash',
        'eth_getTransactionByHash', 'eth_getTransactionByBlockHashAndIndex',
        'eth_getTransactionByBlockNumberAndIndex', 'eth_getTransactionReceipt',
        'eth_getLogs', 'eth_sendRawTransaction',
        // subnet-evm reads the Avalanche Builder Console uses to show the
        // chain's precompiles and fee configuration; all read-only.
        'eth_getChainConfig', 'eth_getActiveRulesAt', 'eth_feeConfig', 'eth_baseFee',
    ];

    public function __invoke(Request $request): JsonResponse
    {
        $body = $request->getContent();

        if (strlen($body) > 65536) {
            return $this->error(413, -32600, 'Request larger than 65536 bytes.');
        }

        try {
            $decoded = json_decode($body, false, 32, JSON_THROW_ON_ERROR);
        } catch (JsonException) {
            return $this->error(400, -32700, 'Expected valid JSON.');
        }

        $batch = is_array($decoded);
        $calls = $batch ? $decoded : [$decoded];

        if ($calls === [] || count($calls) > 25) {
            return $this->error(400, -32600, 'A batch must hold between 1 and 25 calls.');
        }

        foreach ($calls as $call) {
            if ($refusal = $this->refuseCall($call)) {
                return $refusal;
            }
        }

        $upstream = trim((string) config('bridge.fuji_rpc_upstream', ''));

        if ($upstream === '') {
            return $this->error(503, -32603, 'The Fuji relay is not configured.');
        }

        $payload = $batch
            ? array_map(get_object_vars(...), $calls)
            : get_object_vars($decoded);

        try {
            $this->verifyChain($upstream);

            $reply = Http::connectTimeout(3)->timeout(20)
                ->post($upstream, $payload)->throw()->json();

            if (! is_array($reply) || $reply === [] || array_is_list($reply) !== $batch) {
                throw new RuntimeException('Invalid Fuji RPC response.');
            }

            return response()->json($batch
                ? array_map($this->publicReply(...), $reply)
                : $this->publicReply($reply));
        } catch (\Throwable) {
            return $this->error(502, -32603, 'Fuji is unreachable from here right now.', $batch ? null : ($decoded->id ?? null));
        }
    }

    private function refuseCall(mixed $call): ?JsonResponse
    {
        if (! $call instanceof stdClass) {
            return $this->error(400, -32600, 'Expected a JSON-RPC request object.');
        }

        $id = $call->id ?? null;

        if ($id !== null && ! is_string($id) && ! is_int($id)) {
            return $this->error(400, -32600, 'Invalid JSON-RPC id.');
        }

        if (($call->jsonrpc ?? null) !== '2.0'
            || ! is_string($call->method ?? null)
            || (property_exists($call, 'params') && ! is_array($call->params))) {
            return $this->error(400, -32600, 'Expected JSON-RPC 2.0 with a method and array params.', $id);
        }

        if (! in_array($call->method, self::METHODS, true)) {
            return $this->error(400, -32601, 'This JSON-RPC method is not relayed.', $id);
        }

        return null;
    }

    private function verifyChain(string $upstream): void
    {
        Cache::remember('bridge:fuji:chain:'.hash('sha256', $upstream), 10, function () use ($upstream): bool {
            $chain = Http::connectTimeout(3)->timeout(8)->post($upstream, [
                'jsonrpc' => '2.0', 'id' => 'chain-check', 'method' => 'eth_chainId', 'params' => [],
            ])->throw()->json('result');

            if (! is_string($chain) || strtolower($chain) !== '0xc0ff') {
                throw new RuntimeException('Unexpected Fuji chain.');
            }

            return true;
        });
    }

    /**
     * @param  array<string, mixed>  $reply
     * @return array<string, mixed>
     */
    private function publicReply(array $reply): array
    {
        if (($reply['jsonrpc'] ?? null) !== '2.0'
            || ! array_key_exists('id', $reply)
            || (! array_key_exists('result', $reply) && ! is_array($reply['error'] ?? null))) {
            throw new RuntimeException('Invalid Fuji RPC response.');
        }

        $envelope = ['jsonrpc' => '2.0', 'id' => $reply['id']];

        if (array_key_exists('result', $reply)) {
            return $envelope + ['result' => $reply['result']];
        }

        $error = [
            'code' => is_int($reply['error']['code'] ?? null) ? $reply['error']['code'] : -32603,
            'message' => 'The Fuji RPC request failed.',
        ];
        $data = $reply['error']['data'] ?? null;

        if (is_string($data) && preg_match('/^0x[0-9a-fA-F]*$/D', $data) === 1) {
            $error['data'] = $data;
        }

        return $envelope + ['error' => $error];
    }

    private function error(int $status, int $code, string $message, mixed $id = null): JsonResponse
    {
        return response()->json([
            'jsonrpc' => '2.0',
            'id' => $id,
            'error' => ['code' => $code, 'message' => $message],
        ], $status);
    }
}
