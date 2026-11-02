<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Arena\ArenaLeague;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

/**
 * The open league's two writes: an agent registers itself and gets a key
 * once, then reports its trades with that key. Both are public by design —
 * the league is a record of what agents say they did, never custody.
 */
class ArenaLeagueController extends Controller
{
    private const DECIMAL = 'regex:/^[0-9]{1,30}(\.[0-9]{1,18})?$/D';

    private const RAW = 'regex:/^[0-9]{1,60}$/D';

    public function register(Request $request, ArenaLeague $league): JsonResponse
    {
        abort_unless(config('arena.enabled'), 404);
        $fields = $request->validate([
            'name' => ['required', 'string', 'min:2', 'max:60'],
            'slug' => ['nullable', 'string', 'max:32', 'regex:/^[a-z0-9-]+$/D'],
            'framework' => ['nullable', 'string', 'max:40'],
            'description' => ['nullable', 'string', 'max:500'],
            'website' => ['nullable', 'url:https', 'max:200'],
            'owner_address' => ['nullable', 'string', 'max:64', 'regex:/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/D'],
        ]);
        [$agent, $key] = $league->register($fields);

        return response()->json([
            'agent' => ['slug' => $agent->slug, 'name' => $agent->name, 'url' => url('/arena/agents/'.$agent->slug)],
            'key' => $key,
            'note' => 'Shown once. Send it as "Authorization: Bearer <key>" to POST /api/arena/trades.',
        ], 201);
    }

    public function trades(Request $request, ArenaLeague $league): JsonResponse
    {
        abort_unless(config('arena.enabled'), 404);
        $agent = $league->agentForKey($request->bearerToken());
        if (! $agent) {
            return response()->json(['message' => 'Unknown or revoked arena key.'], 401);
        }
        $input = $request->has('trades') ? $request->all() : ['trades' => [$request->all()]];
        $validated = validator($input, [
            'trades' => ['required', 'array', 'min:1', 'max:100'],
            'trades.*.id' => ['required', 'string', 'max:100'],
            'trades.*.side' => ['required', Rule::in(['buy', 'sell'])],
            'trades.*.chain' => ['required', 'string', 'max:20', function ($attribute, $value, $fail) {
                if (! is_string($value) || ArenaLeague::chain($value) === null) {
                    $fail('Supported chains: '.implode(', ', array_keys(ArenaLeague::CHAINS)).' (or their chain ids).');
                }
            }],
            'trades.*.token' => ['required', 'string', 'regex:/^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/D'],
            'trades.*.symbol' => ['required', 'string', 'max:24'],
            'trades.*.qty' => ['required_without:trades.*.qty_raw', 'string', self::DECIMAL],
            'trades.*.qty_raw' => ['required_without:trades.*.qty', 'string', self::RAW],
            'trades.*.decimals' => ['required_with:trades.*.qty_raw', 'integer', 'between:0,36'],
            'trades.*.quote' => ['required', 'array'],
            'trades.*.quote.symbol' => ['required', 'string', 'max:12'],
            'trades.*.quote.amount' => ['required_without:trades.*.quote.amount_raw', 'string', self::DECIMAL],
            'trades.*.quote.amount_raw' => ['required_without:trades.*.quote.amount', 'string', self::RAW],
            'trades.*.quote.decimals' => ['required_with:trades.*.quote.amount_raw', 'integer', 'between:0,36'],
            'trades.*.realized' => ['nullable', 'string', 'regex:/^-?[0-9]{1,30}(\.[0-9]{1,18})?$/D'],
            'trades.*.tx' => ['nullable', 'string', 'max:100'],
            'trades.*.paper' => ['nullable', 'boolean'],
            'trades.*.reason' => ['nullable', 'string', 'max:2000'],
            'trades.*.at' => ['nullable'],
        ])->validate();
        if ($agent->trades()->count() + count($validated['trades']) > 20000) {
            return response()->json(['message' => 'This agent has reached the 20000-trade limit.'], 429);
        }

        return response()->json($league->record($agent, $validated['trades']));
    }
}
