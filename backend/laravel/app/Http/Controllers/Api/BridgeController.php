<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Jobs\ProcessBridgeRequest;
use App\Models\BridgeRequest;
use App\Rules\ValidDestinationAddress;
use App\Services\BridgeAdmissionService;
use App\Services\BridgeConfigService;
use App\Services\BridgeDepositCredit;
use App\Services\BridgeDepositWatcher;
use App\Services\BridgeEventLogger;
use App\Services\BridgeFeeService;
use App\Services\BridgeService;
use App\Services\CyberiaRpcService;
use App\Services\TonApiService;
use App\Support\BridgeCapacity;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\Rule;

class BridgeController extends Controller
{
    public function __construct(
        private BridgeService $bridgeService,
        private BridgeEventLogger $eventLogger,
        private BridgeFeeService $feeService,
        private BridgeConfigService $bridgeConfig,
        private CyberiaRpcService $rpc,
    ) {}

    /**
     * Live withdrawal capacity for a route+token: how much can be paid out to
     * the destination chain right now, minus everything already promised to
     * somebody else.
     *
     * The payload names its own state, because `available: null` used to mean
     * both "no ceiling" and "we could not read it" and the UI could not tell
     * them apart:
     *
     *   unlimited   — the relayer mints here; there is nothing to run out of.
     *   available   — a real number, with its raw integer form and decimals so
     *                 the browser can compare without touching a float.
     *   unmeasured  — manual reserves; this server does not read them.
     *   unavailable — the read failed. The UI must NOT let a signature happen.
     */
    public function capacity(Request $request, BridgeAdmissionService $admission): JsonResponse
    {
        $validated = $request->validate([
            'direction' => ['required', 'string'],
            'token' => ['required', 'string'],
        ]);

        $direction = $validated['direction'];
        $token = $validated['token'];

        // Only answer for corridors/tokens that are actually offered. A
        // corridor nobody may use has no capacity to quote — and saying
        // "unavailable" keeps the browser from treating silence as a ceiling.
        if (! isset($this->bridgeConfig->availableRoutes()[$direction])
            || ! isset($this->bridgeConfig->tokensForRoute($direction)[$token])) {
            return response()->json(
                BridgeCapacity::unavailable('this corridor is not currently available')->toArray()
            );
        }

        return response()->json($admission->availableCapacity($direction, $token)->toArray());
    }

    /**
     * Claim destination capacity BEFORE the user is asked to sign anything.
     *
     * This is the admission gate, and it is the server's, not the interface's.
     * A browser check cannot hold the invariant: between reading a balance and
     * signing a transfer there is a wallet prompt, a person, and possibly
     * another person doing exactly the same thing against the same reserve.
     * The reservation is written under a lock over the destination pool, so
     * two requests for 0.6 of a 1.0 balance cannot both be told yes.
     */
    public function reserve(Request $request, BridgeAdmissionService $admission): JsonResponse
    {
        $direction = $request->input('direction');
        $routes = $this->bridgeConfig->availableRoutes();

        $validated = $request->validate([
            'direction' => ['required', Rule::in(array_keys($routes))],
            'token' => ['nullable', 'string', 'in:'.implode(',', array_keys(config('bridge.tokens', [])))],
            'sender_address' => ['nullable', 'string'],
            'recipient_address' => [
                'required',
                'string',
                new ValidDestinationAddress(is_string($direction) ? $direction : ''),
            ],
            'amount' => ['required', 'numeric', 'gt:0'],
        ]);

        $token = $validated['token'] ?? 'CYBER.sol';

        if (! isset($this->bridgeConfig->tokensForRoute($validated['direction'])[$token])) {
            return response()->json(['message' => 'Token is not supported on this bridge route.'], 422);
        }

        $result = $admission->reserve(
            $validated['direction'],
            $token,
            (string) $validated['amount'],
            $validated['sender_address'] ?? null,
            $validated['recipient_address'],
        );

        if ($result['ok'] !== true) {
            return response()->json([
                'message' => $result['message'],
                'reason' => $result['reason'],
                'capacity' => $result['capacity']->toArray(),
            ], $result['reason'] === 'busy' ? 409 : 422);
        }

        $reservation = $result['reservation'];

        return response()->json([
            'reservation' => [
                'reference' => $reservation->reference,
                'direction' => $reservation->direction,
                'token' => $reservation->token,
                'amount' => $reservation->amount,
                'net_raw' => $reservation->net_raw,
                'decimals' => $reservation->decimals,
                'expires_at' => $reservation->expires_at?->toIso8601String(),
            ],
        ], 201);
    }

    /**
     * Submit a bridge request after the user has locked tokens on the source chain.
     */
    public function submit(Request $request): JsonResponse
    {
        $direction = $request->input('direction');
        $supportedTokens = array_keys(config('bridge.tokens', []));
        $routes = config('bridge.routes', []);
        $supportedDirections = array_keys($routes);

        $validated = $request->validate([
            'direction' => ['required', Rule::in($supportedDirections)],
            'token' => ['nullable', 'string', 'in:'.implode(',', $supportedTokens)],
            'source_tx_hash' => ['required', 'string'],
            'source_nonce' => ['required', 'integer', 'min:0'],
            'sender_address' => ['required', 'string'],
            'recipient_address' => [
                'required',
                'string',
                new ValidDestinationAddress(is_string($direction) ? $direction : ''),
            ],
            'amount' => ['required', 'numeric', 'gt:0'],
            'convert_to_native' => ['nullable', 'boolean'],
            'reservation' => ['nullable', 'string', 'max:64'],
            'session_id' => ['nullable', 'uuid'],
        ]);

        $route = $routes[$validated['direction']] ?? null;

        if (! is_array($route)) {
            return response()->json(['message' => 'Unsupported bridge direction.'], 422);
        }

        $sourceChain = (string) $route['source_chain'];
        $token = $validated['token'] ?? 'CYBER.sol';

        if (! isset($this->bridgeConfig->tokensForRoute($validated['direction'])[$token])) {
            return response()->json(['message' => 'Token is not supported on this bridge route.'], 422);
        }

        $destinationChain = $this->bridgeConfig->chain((string) $route['destination_chain']);

        if (($sourceChain === 'yenten' || ($destinationChain['key'] ?? null) === 'yenten')
            && $this->bridgeConfig->depositAddress('yenten') === null) {
            return response()->json(['message' => 'Yenten bridge address is not configured.'], 422);
        }

        $yentenChain = $this->bridgeConfig->chain('yenten');

        if (($sourceChain === 'yenten' || ($destinationChain['type'] ?? null) === 'yenten')
            && empty($yentenChain['relayer_wif'])) {
            return response()->json(['message' => 'Yenten bridge relayer is not configured.'], 422);
        }

        // Chain-specific guards above give precise messages; anything else
        // filtered out of availableRoutes() gets the generic refusal.
        if (! isset($this->bridgeConfig->availableRoutes()[$validated['direction']])) {
            return response()->json(['message' => 'This bridge route is not currently available.'], 422);
        }

        // Auto-conversion into native CYBER only applies to CYBER.sol arriving
        // on Cyberia, and only when the feature is enabled server-side.
        $convertToNative = ($validated['convert_to_native'] ?? false)
            && $validated['direction'] === 'sol_to_evm'
            && $token === 'CYBER.sol'
            && config('bridge.convert.enabled', true);

        $fee = $this->feeService->feeForBridge(
            $token,
            (string) $validated['amount'],
            $validated['direction'],
        );

        [$gasDropPlanned, $gasDropAmount] = $this->planGasDrop(
            $validated['direction'],
            $validated['recipient_address'],
        );

        // Normalize TON hashes (hex vs base64 encodings of the same tx) so the
        // source_tx_hash unique constraint can't be replayed via re-encoding.
        $sourceTxHash = $validated['source_tx_hash'];

        if ($sourceChain === 'ton') {
            $normalized = TonApiService::normalizeTxHash($sourceTxHash);

            if ($normalized === null) {
                return response()->json(['message' => 'Invalid TON transaction hash.'], 422);
            }

            $sourceTxHash = $normalized;
        }

        try {
            $bridgeRequest = $this->bridgeService->createRequest(
                userId: $request->user()?->id,
                direction: $validated['direction'],
                sourceChain: $sourceChain,
                sourceTxHash: $sourceTxHash,
                sourceNonce: $validated['source_nonce'],
                senderAddress: $validated['sender_address'],
                recipientAddress: $validated['recipient_address'],
                amount: $validated['amount'],
                token: $token,
                feeAmount: $fee['fee_amount'],
                feeUsd: $fee['fee_usd'],
                gasDropPlanned: $gasDropPlanned,
                gasDropAmount: $gasDropAmount,
                convertToNative: $convertToNative,
            );
        } catch (UniqueConstraintViolationException) {
            return response()->json([
                'message' => 'This transaction has already been submitted to the bridge.',
            ], 422);
        }

        // Turn the claim into an obligation — or record one for a transfer
        // that never claimed anything (someone who sent tokens straight to the
        // relayer's public address). Submit is reached only AFTER the source
        // transfer is signed, so it can refuse nothing: what it can do is make
        // sure the relayer knows it owes this payout before deciding whether
        // it can make it. See BridgeAdmissionService::commit().
        app(BridgeAdmissionService::class)->commit(
            $bridgeRequest,
            $validated['reservation'] ?? null,
        );

        if (! empty($validated['session_id'])) {
            $this->eventLogger->log('bridge_request_created', [
                'session_id' => $validated['session_id'],
                'user_id' => $request->user()?->id,
                'bridge_request_id' => $bridgeRequest->id,
                'direction' => $validated['direction'],
                'amount' => $validated['amount'],
                'source_address' => $validated['sender_address'],
                'destination_address' => $validated['recipient_address'],
                'metadata' => ['token' => $token],
            ], $request);
        }

        if ($this->shouldAutoProcess($validated['direction'])) {
            ProcessBridgeRequest::dispatchSync($bridgeRequest->id, $validated['session_id'] ?? null);
        }

        $bridgeRequest->refresh();

        return response()->json([
            'message' => $bridgeRequest->isCompleted() ? 'Bridge completed' : 'Bridge request submitted',
            'bridge_request' => [
                'id' => $bridgeRequest->id,
                'direction' => $bridgeRequest->direction,
                'token' => $bridgeRequest->token,
                'status' => $bridgeRequest->status,
                'amount' => $bridgeRequest->amount,
                'fee_amount' => $bridgeRequest->fee_amount,
                'fee_usd' => $bridgeRequest->fee_usd,
                'gas_drop_planned' => $bridgeRequest->gas_drop_planned,
                'gas_drop_amount' => $bridgeRequest->gas_drop_amount,
                'convert_to_native' => $bridgeRequest->convert_to_native,
                'converted' => $bridgeRequest->converted,
                'destination_tx_hash' => $bridgeRequest->destination_tx_hash,
                'error_message' => $bridgeRequest->error_message,
                'created_at' => $bridgeRequest->created_at,
            ],
        ], 201);
    }

    /**
     * Phase 1 of a one-time-address deposit route: commit the recipient and
     * hand back an address that belongs to this request alone. Binding a
     * deposit to a single request with a pre-committed recipient is what
     * prevents hijacking a public deposit transaction — and on Monero it is
     * the only thing that makes a deposit attributable at all, since nobody
     * outside the receiving wallet can see one.
     */
    public function prepare(Request $request): JsonResponse
    {
        $direction = $request->input('direction');
        $routes = $this->bridgeConfig->availableRoutes();

        $validated = $request->validate([
            'direction' => ['required', Rule::in(array_keys($routes))],
            'token' => ['nullable', 'string', 'in:'.implode(',', array_keys(config('bridge.tokens', [])))],
            'recipient_address' => [
                'required',
                'string',
                new ValidDestinationAddress(is_string($direction) ? $direction : ''),
            ],
            'session_id' => ['nullable', 'uuid'],
        ]);

        $route = $routes[$validated['direction']];
        $sourceChain = $this->bridgeConfig->chain((string) $route['source_chain']);

        $watcher = app(BridgeDepositWatcher::class);

        if (! $watcher->supports($sourceChain)) {
            return response()->json([
                'message' => 'This route does not use a prepared deposit address.',
            ], 422);
        }

        $routeTokens = $this->bridgeConfig->tokensForRoute($validated['direction']);
        // The route's own first token, not a hardcoded one: this endpoint
        // serves every address-bound corridor now, and each has its own asset.
        $token = $validated['token'] ?? (string) array_key_first($routeTokens);

        if (! isset($routeTokens[$token])) {
            return response()->json(['message' => 'Token is not supported on this bridge route.'], 422);
        }

        // Amount is unknown until the user deposits — 0 for now, set at claim
        // time from the detected balance.
        $bridgeRequest = $this->bridgeService->createRequest(
            userId: $request->user()?->id,
            direction: $validated['direction'],
            sourceChain: (string) $route['source_chain'],
            sourceTxHash: null,
            sourceNonce: 0,
            senderAddress: null,
            recipientAddress: $validated['recipient_address'],
            amount: '0',
            token: $token,
            status: 'awaiting_deposit',
        );

        // Give it its address: derived from a seed on Yenten, minted by the
        // wallet on Monero. A refusal here is a real reason a person can act
        // on, not a blank field — and the row is closed rather than left
        // waiting for a deposit to an address that does not exist.
        $failure = $watcher->issue($bridgeRequest, $sourceChain);

        if ($failure !== null) {
            $bridgeRequest->markExpired();

            return response()->json(['message' => $failure, 'retryable' => true], 422);
        }

        $bridgeRequest->refresh();

        return response()->json([
            'bridge_request' => [
                'id' => $bridgeRequest->id,
                'direction' => $bridgeRequest->direction,
                'token' => $bridgeRequest->token,
                'deposit_address' => $bridgeRequest->deposit_address,
                'recipient_address' => $bridgeRequest->recipient_address,
                'status' => $bridgeRequest->status,
                'confirmations' => max(1, (int) ($sourceChain['minimum_confirmations'] ?? 1)),
                'expires_at' => $bridgeRequest->created_at
                    ->addMinutes($watcher->depositTtlMinutes($sourceChain))
                    ->toIso8601String(),
            ],
        ], 201);
    }

    /**
     * Phase 2: the user has sent (any amount of) coins to the request's
     * one-time address. Detect what landed on it and mint exactly that much to
     * the committed recipient — no amount and no tx hash from the user.
     *
     * The same button on a corridor whose deposits are also swept in the
     * background (`bridge:sweep-deposits`): a person who is watching the page
     * gets an answer now, and a person who closed the tab gets the same one a
     * minute later. Both go through BridgeDepositCredit, so they cannot disagree.
     */
    public function claim(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'id' => ['required', 'integer'],
            'session_id' => ['nullable', 'uuid'],
        ]);

        $bridgeRequest = BridgeRequest::find($validated['id']);

        // Expired requests answer without touching any network: the whole
        // point of the deposit window is to stop polling dead addresses.
        if ($bridgeRequest && $bridgeRequest->isExpired()) {
            return response()->json([
                'message' => 'The deposit window has expired and this address is no longer monitored — start a new transfer.',
                'expired' => true,
            ], 422);
        }

        if (! $bridgeRequest || ! $bridgeRequest->isAwaitingDeposit()) {
            return response()->json(['message' => 'Bridge request is not awaiting a deposit.'], 422);
        }

        $outcome = app(BridgeDepositCredit::class)->credit(
            $bridgeRequest,
            $validated['session_id'] ?? null,
        );

        if ($outcome->message !== null) {
            return response()->json(array_filter([
                'message' => $outcome->message,
                'retryable' => $outcome->retryable ?: null,
                'expired' => $outcome->expired ?: null,
            ]), 422);
        }

        $bridgeRequest->refresh();

        return response()->json([
            'bridge_request' => [
                'id' => $bridgeRequest->id,
                'direction' => $bridgeRequest->direction,
                'token' => $bridgeRequest->token,
                'status' => $bridgeRequest->status,
                'destination_tx_hash' => $bridgeRequest->destination_tx_hash,
                'error_message' => $bridgeRequest->error_message,
            ],
        ]);
    }

    private function shouldAutoProcess(string $direction): bool
    {
        $route = config('bridge.routes', [])[$direction] ?? null;

        return is_array($route) && ($route['auto_process'] ?? false) === true;
    }

    /**
     * Decide whether a sol_to_evm bridge should also drop native CYBER on the
     * recipient so they can pay for their first transaction. Returns
     * [planned, amount].
     *
     * @return array{0: bool, 1: string|null}
     */
    private function planGasDrop(string $direction, string $recipient): array
    {
        $route = config('bridge.routes', [])[$direction] ?? null;

        if (! is_array($route) || ($route['destination_chain'] ?? null) !== 'cyberia') {
            return [false, null];
        }

        if (! config('bridge.gas_drop.enabled', true)) {
            return [false, null];
        }

        $balance = $this->rpc->nativeBalanceWei($recipient);

        if ($balance === null) {
            return [false, null];
        }

        $threshold = (string) config('bridge.gas_drop.threshold_wei', '0');

        if (bccomp($balance, $threshold, 0) > 0) {
            return [false, null];
        }

        return [true, (string) config('bridge.gas_drop.amount_cyber', '0.01')];
    }

    /**
     * Get the status of a bridge request.
     */
    public function status(BridgeRequest $bridgeRequest): JsonResponse
    {
        return response()->json([
            'id' => $bridgeRequest->id,
            'direction' => $bridgeRequest->direction,
            'source_chain' => $bridgeRequest->source_chain,
            'source_tx_hash' => $bridgeRequest->source_tx_hash,
            'sender_address' => $bridgeRequest->sender_address,
            'recipient_address' => $bridgeRequest->recipient_address,
            'amount' => $bridgeRequest->amount,
            'status' => $bridgeRequest->status,
            'convert_to_native' => $bridgeRequest->convert_to_native,
            'converted' => $bridgeRequest->converted,
            'destination_tx_hash' => $bridgeRequest->destination_tx_hash,
            'error_message' => $bridgeRequest->error_message,
            'created_at' => $bridgeRequest->created_at,
            'completed_at' => $bridgeRequest->completed_at,
        ]);
    }

    /**
     * List bridge requests for the authenticated user.
     */
    public function index(Request $request): JsonResponse
    {
        $requests = BridgeRequest::where('user_id', $request->user()->id)
            ->orderByDesc('created_at')
            ->limit(50)
            ->get([
                'id', 'direction', 'source_chain', 'source_tx_hash',
                'sender_address', 'recipient_address', 'amount',
                'status', 'destination_tx_hash', 'created_at', 'completed_at',
            ]);

        return response()->json(['data' => $requests]);
    }
}
