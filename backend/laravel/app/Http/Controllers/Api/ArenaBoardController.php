<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Arena\ArenaBoard;
use Illuminate\Http\JsonResponse;

/**
 * The arena as the wallet reads it: everyone on one board, and one agent's
 * whole record. The same arrays seed /arena, so both draw one component.
 */
class ArenaBoardController extends Controller
{
    public function index(ArenaBoard $board): JsonResponse
    {
        abort_unless(config('arena.enabled'), 404);

        return response()->json($board->overview());
    }

    public function agent(string $agent, ArenaBoard $board): JsonResponse
    {
        abort_unless(config('arena.enabled'), 404);

        return response()->json($board->agent($agent) ?? abort(404));
    }
}
