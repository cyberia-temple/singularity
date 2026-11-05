<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Throwable;

class WalletSideShiftController extends Controller
{
    private const API = 'https://sideshift.ai/api/v2';

    private const AFFILIATE = 'x0hU9rQwn';

    private const COMMISSION = '0.02';

    private function call(Request $request, string $path, array $data = [], bool $post = false): JsonResponse
    {
        $secret = config('services.sideshift.secret');
        if (! is_string($secret) || $secret === '') {
            return response()->json(['error' => 'SideShift is not configured.'], 503);
        }
        try {
            $http = Http::timeout(20)->acceptJson()->withHeaders(['x-sideshift-secret' => $secret, 'x-user-ip' => $request->ip()]);
            $response = $post ? $http->post(self::API.$path, $data) : $http->get(self::API.$path, $data);
            if (! $response->successful()) {
                return response()->json(['error' => (string) ($response->json('error.message') ?? 'SideShift could not process this request.')], 502);
            }

            return response()->json($response->json());
        } catch (Throwable) {
            return response()->json(['error' => 'SideShift is unavailable.'], 502);
        }
    }

    public function coins(): JsonResponse
    {
        try {
            $coins = Cache::remember('sideshift.coins.v1', 300, function () {
                $response = Http::timeout(20)->acceptJson()->get(self::API.'/coins');
                if (! $response->successful() || ! is_array($response->json())) {
                    throw new \RuntimeException;
                }

                return $response->json();
            });

            return response()->json($coins);
        } catch (Throwable) {
            return response()->json(['error' => 'SideShift is unavailable.'], 502);
        }
    }

    private function pairRules(): array
    {
        return [
            'depositCoin' => ['required', 'string', 'max:80', 'regex:/^[a-zA-Z0-9.]+$/'],
            'depositNetwork' => ['required', 'string', 'max:40', 'regex:/^[a-zA-Z0-9]+$/'],
            'settleCoin' => ['required', 'string', 'max:80', 'regex:/^[a-zA-Z0-9.]+$/'],
            'settleNetwork' => ['required', 'string', 'max:40', 'regex:/^[a-zA-Z0-9]+$/'],
        ];
    }

    public function pair(Request $request): JsonResponse
    {
        $data = $request->validate($this->pairRules() + ['amount' => ['nullable', 'numeric', 'gt:0']]);
        $from = $data['depositCoin'].'-'.$data['depositNetwork'];
        $to = $data['settleCoin'].'-'.$data['settleNetwork'];

        return $this->call($request, '/pair/'.rawurlencode($from).'/'.rawurlencode($to), array_filter(['affiliateId' => self::AFFILIATE, 'commissionRate' => self::COMMISSION, 'amount' => $data['amount'] ?? null], fn ($value) => $value !== null));
    }

    public function create(Request $request): JsonResponse
    {
        $data = $request->validate($this->pairRules() + ['settleAddress' => ['required', 'string', 'max:256'], 'refundAddress' => ['required', 'string', 'max:256'], 'settleMemo' => ['nullable', 'string', 'max:256'], 'refundMemo' => ['nullable', 'string', 'max:256']]);

        return $this->call($request, '/shifts/variable', array_merge($data, ['affiliateId' => self::AFFILIATE, 'commissionRate' => self::COMMISSION]), true);
    }
}
