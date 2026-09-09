<?php

namespace App\Services;

use App\Jobs\ProcessBridgeRequest;
use App\Models\BridgeRequest;
use App\Support\BridgeDepositOutcome;
use App\Support\TokenAmount;
use Illuminate\Support\Facades\Log;

/**
 * Turning "something landed on that address" into an obligation.
 *
 * This used to live inside the claim endpoint, which meant it could only ever
 * happen while somebody had the page open — fine for Yenten, where a
 * confirmation is a minute, and useless for Monero, where ten of them are
 * twenty minutes and nobody is going to sit there. So it is a service now,
 * called from two places that must never disagree: the button a person can
 * press, and the sweep that runs whether or not anyone is watching.
 *
 * The order is the whole safety argument, and it is the same one the rest of
 * the bridge uses: read the deposit, write the amount, **commit the
 * obligation**, then relay. A mint that fails afterwards puts the request back
 * to awaiting_deposit with the coins still sitting on their own address — the
 * one place they are safe — rather than leaving a half-finished transfer.
 */
final class BridgeDepositCredit
{
    public function __construct(
        private readonly BridgeDepositWatcher $watcher,
        private readonly BridgeAdmissionService $admission,
    ) {}

    public function credit(BridgeRequest $request, ?string $sessionId = null): BridgeDepositOutcome
    {
        $chain = (array) (config('bridge.chains', [])[$request->source_chain] ?? []);
        $label = (string) ($chain['label'] ?? $request->source_chain);

        if (! $this->watcher->supports($chain)) {
            return BridgeDepositOutcome::waiting('This route does not use a prepared deposit address.');
        }

        $balances = $this->watcher->balances($request, $chain);

        // Unreadable is not empty. A wallet that is down must never close a
        // deposit window or report an empty address.
        if ($balances === null) {
            return BridgeDepositOutcome::waiting(
                "Could not read the {$label} deposit right now — try again shortly."
            );
        }

        if (bccomp($balances['confirmed'], '0', 0) <= 0) {
            return $this->nothingCreditable($request, $chain, $label, $balances['pending']);
        }

        $decimals = (int) (
            config('bridge.tokens', [])[$request->token]['chains'][$request->source_chain]['decimals'] ?? 8
        );

        $request->update([
            'amount' => TokenAmount::fromRaw($balances['confirmed'], $decimals),
            'status' => BridgeRequest::PENDING,
        ]);

        // The coins are on the request's own address: from here this is an
        // obligation, whatever the payout does next.
        $this->admission->commit($request, null);

        if (($chain['type'] ?? null) !== null && $this->autoProcesses($request->direction)) {
            ProcessBridgeRequest::dispatchSync($request->id, $sessionId);
        }

        $request->refresh();

        // The mint failed (a transient RPC, usually). Put it back: the deposit
        // is still on its own address and the next sweep will try again.
        if ($request->status === BridgeRequest::FAILED) {
            $this->admission->releaseFor(
                $request,
                'the deposit did not mint; it is still on its own address',
            );
            $request->update([
                'status' => BridgeRequest::AWAITING_DEPOSIT,
                'amount' => '0',
                'error_message' => null,
                'source_verified_at' => null,
            ]);

            Log::warning('Bridge: deposit seen but the mint failed; back to awaiting', [
                'id' => $request->id,
                'chain' => $request->source_chain,
            ]);

            return BridgeDepositOutcome::waiting('Deposit not credited yet — wait a moment and try again.');
        }

        return BridgeDepositOutcome::credited();
    }

    /**
     * Nothing spendable on the address: either it is on its way, or nobody
     * ever used it and the window has closed.
     *
     * @param  array<string, mixed>  $chain
     */
    private function nothingCreditable(
        BridgeRequest $request,
        array $chain,
        string $label,
        string $pending,
    ): BridgeDepositOutcome {
        // Seen but not deep enough. Said out loud, because "nothing arrived" to
        // somebody who just sent money is the sentence that starts a panic.
        if (bccomp($pending, '0', 0) > 0) {
            $confirmations = max(1, (int) ($chain['minimum_confirmations'] ?? 1));

            return BridgeDepositOutcome::waiting(
                "Deposit detected — waiting for {$confirmations} {$label} confirmation"
                .($confirmations === 1 ? '' : 's').'. This page updates on its own.'
            );
        }

        $expiresAt = $request->created_at->addMinutes($this->watcher->depositTtlMinutes($chain));

        // Only an address nobody used is ever closed, and only after the
        // window: a deposit already in flight is honoured whenever it lands.
        if ($expiresAt->isPast()) {
            $request->markExpired();

            return BridgeDepositOutcome::expired(
                'The deposit window has expired and this address is no longer monitored — start a new transfer.'
            );
        }

        return BridgeDepositOutcome::waiting(
            "No deposit detected yet — send {$request->token} to the address and try again."
        );
    }

    private function autoProcesses(string $direction): bool
    {
        $route = config('bridge.routes', [])[$direction] ?? null;

        return is_array($route) && ($route['auto_process'] ?? false) === true;
    }
}
