<?php

namespace App\Services\Monero;

use Illuminate\Http\Client\PendingRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;

/**
 * The one thing this server cannot do about Monero without a wallet.
 *
 * Every other chain the bridge touches can be read by a stranger: an explorer
 * answers "what landed on this address", an RPC answers "what does this wallet
 * hold". Monero answers neither — an address reveals nothing to anyone without
 * its view key, which is the entire point of it. So a Monero corridor is not a
 * matter of finding the right public API; it is a matter of this server
 * holding a wallet, and `monero-wallet-rpc` is that wallet's interface.
 *
 * Three rules hold everywhere below:
 *
 *   - **null means "cannot tell", never "no".** A wallet that is down, locked
 *     or unreachable must never read as an empty deposit (which would leave a
 *     user's coins uncredited with the request marked failed) or as an empty
 *     balance (which would fail a payout closed rather than retrying it). The
 *     bridge's own vocabulary already distinguishes these; this is where the
 *     distinction starts.
 *   - **amounts are atomic units as decimal strings.** Piconero, twelve
 *     decimals, bcmath the whole way. A float here is a rounding error in
 *     somebody's balance.
 *   - **nothing here decides anything.** It reads and it sends; whether a
 *     deposit is deep enough or a payout is allowed is decided by the bridge
 *     services above, out of config they can be tested against.
 *
 * `services/monero/` carries the compose file that runs the daemon and this
 * wallet; with none configured every method answers null and the corridor says
 * so instead of pretending.
 */
final class MoneroWalletRpc
{
    /** monero-wallet-rpc speaks JSON-RPC 2.0 on one path. */
    private const RPC_PATH = '/json_rpc';

    public function configured(): bool
    {
        return $this->url() !== '';
    }

    private function url(): string
    {
        return rtrim((string) config('bridge.chains.monero.wallet_rpc_url', ''), '/');
    }

    private function accountIndex(): int
    {
        return max(0, (int) config('bridge.chains.monero.wallet_account_index', 0));
    }

    /**
     * Is the wallet actually there and open? Used by the corridor to answer
     * "why is this route unavailable" with something truer than a timeout.
     */
    public function reachable(): bool
    {
        return $this->call('get_version') !== null;
    }

    /** Current wallet-side chain height, or null when it cannot be read. */
    public function height(): ?int
    {
        $result = $this->call('get_height');

        return isset($result['height']) ? (int) $result['height'] : null;
    }

    /**
     * A fresh subaddress, for exactly one bridge request.
     *
     * Deliberately a subaddress and not an integrated address, even though
     * this codebase already derives integrated addresses for profile
     * deposits: a payment id is something the *sender's* wallet has to carry,
     * and a sender who drops it (or pastes the base address by hand) produces
     * a deposit nobody can attribute to a request. A subaddress carries the
     * attribution in the address itself, which is the only part the sender
     * cannot get wrong.
     *
     * @return array{address: string, index: int}|null
     */
    public function createSubaddress(string $label): ?array
    {
        $result = $this->call('create_address', [
            'account_index' => $this->accountIndex(),
            'label' => $label,
        ]);

        if (! isset($result['address'], $result['address_index'])) {
            return null;
        }

        return [
            'address' => (string) $result['address'],
            'index' => (int) $result['address_index'],
        ];
    }

    /**
     * What has arrived on one subaddress, split by whether it is deep enough.
     *
     * `pending` is everything seen but not yet confirmed to the configured
     * depth, including the mempool — it exists so the UI can say "your deposit
     * is in, it needs another eight blocks" rather than "nothing arrived",
     * which is the difference between a person waiting and a person emailing.
     *
     * @return array{confirmed: string, pending: string}|null
     */
    public function incoming(int $subaddressIndex, int $minConfirmations): ?array
    {
        $result = $this->call('get_transfers', [
            'in' => true,
            'pool' => true,
            'account_index' => $this->accountIndex(),
            'subaddr_indices' => [$subaddressIndex],
        ]);

        if ($result === null) {
            return null;
        }

        $confirmed = '0';
        $pending = '0';

        foreach (['in', 'pool', 'pending'] as $bucket) {
            foreach ((array) ($result[$bucket] ?? []) as $transfer) {
                $amount = $this->atomic($transfer['amount'] ?? null);

                if ($amount === null) {
                    // An amount we cannot read is not an amount we may credit,
                    // and it is not zero either.
                    return null;
                }

                $deep = (int) ($transfer['confirmations'] ?? 0) >= $minConfirmations;

                if ($bucket === 'in' && $deep) {
                    $confirmed = bcadd($confirmed, $amount, 0);
                } else {
                    $pending = bcadd($pending, $amount, 0);
                }
            }
        }

        return ['confirmed' => $confirmed, 'pending' => $pending];
    }

    /**
     * Spendable balance of the bridge account, in atomic units.
     *
     * Unlocked, not total: a Monero output is locked for ten blocks after it
     * arrives, so the total balance is a promise about the future and the
     * unlocked one is what a payout can actually spend right now.
     */
    public function unlockedBalance(): ?string
    {
        $result = $this->call('get_balance', [
            'account_index' => $this->accountIndex(),
        ]);

        return $result === null
            ? null
            : $this->atomic($result['unlocked_balance'] ?? null);
    }

    /**
     * Send `$atomicAmount` to `$address`, and tag it with `$note`.
     *
     * The recipient gets exactly the amount asked for; the network fee comes
     * out of the wallet on top of it, which is why the corridor withholds a
     * flat fee upstream and why the capacity reader keeps a reserve back.
     *
     * The note is local wallet metadata, not something that travels with the
     * transaction — it exists so `payoutFor()` can recognise this bridge
     * request's payout later, in the one case that matters: a response that
     * never came back.
     *
     * @return array{tx_hash: string, fee: string, amount: string}|null
     */
    public function transfer(string $address, string $atomicAmount, string $note): ?array
    {
        if (bccomp($atomicAmount, '0', 0) <= 0) {
            return null;
        }

        $result = $this->call('transfer', [
            'destinations' => [[
                'address' => $address,
                // The RPC takes the amount as a number; piconero fits in a
                // 64-bit integer for any amount this bridge will ever send.
                'amount' => (int) $atomicAmount,
            ]],
            'account_index' => $this->accountIndex(),
            'priority' => max(0, (int) config('bridge.chains.monero.payout_priority', 1)),
            'get_tx_key' => true,
        ], $this->payoutTimeout());

        if (! isset($result['tx_hash'])) {
            return null;
        }

        $hash = (string) $result['tx_hash'];

        // Best effort, and deliberately not fatal: the payout is already
        // broadcast by now, so a failed note must not read as a failed payout.
        $this->call('set_tx_notes', ['txids' => [$hash], 'notes' => [$note]]);

        return [
            'tx_hash' => $hash,
            'fee' => $this->atomic($result['fee'] ?? null) ?? '0',
            'amount' => $this->atomic($result['amount'] ?? null) ?? $atomicAmount,
        ];
    }

    /**
     * The payout this bridge request already made, if it made one.
     *
     * This is the answer to the only way a Monero payout can double-pay: the
     * `transfer` call broadcast the transaction and then the HTTP response was
     * lost, so nothing upstream recorded a hash. Before sending anything, the
     * relayer asks the wallet what it has already sent — by the note it stamps
     * on its own payouts, and failing that by destination and exact amount,
     * because a note is written one call after the broadcast and that gap is
     * the whole problem.
     *
     * The destination match is opt-in (`$address` + `$atomicAmount` given)
     * because it is the one that can be wrong: two requests paying the same
     * person the same amount are indistinguishable by it. The caller passes it
     * only for a request that is known to have attempted a payout already —
     * where "possibly already paid" must beat "possibly pay twice".
     */
    public function payoutFor(string $note, ?string $address = null, ?string $atomicAmount = null): ?string
    {
        $height = $this->height();
        $lookback = max(0, (int) config('bridge.chains.monero.payout_lookback_blocks', 720));

        $params = [
            'out' => true,
            'pending' => true,
            'pool' => true,
            'account_index' => $this->accountIndex(),
        ];

        if ($height !== null && $lookback > 0) {
            $params['filter_by_height'] = true;
            $params['min_height'] = max(0, $height - $lookback);
        }

        $result = $this->call('get_transfers', $params);

        if ($result === null) {
            return null;
        }

        foreach (['out', 'pending', 'pool'] as $bucket) {
            foreach ((array) ($result[$bucket] ?? []) as $transfer) {
                if ((string) ($transfer['note'] ?? '') === $note) {
                    return (string) ($transfer['txid'] ?? '') ?: null;
                }

                if ($address === null || $atomicAmount === null) {
                    continue;
                }

                foreach ((array) ($transfer['destinations'] ?? []) as $destination) {
                    $sameAddress = (string) ($destination['address'] ?? '') === $address;
                    $amount = $this->atomic($destination['amount'] ?? null);

                    if ($sameAddress && $amount !== null && bccomp($amount, $atomicAmount, 0) === 0) {
                        return (string) ($transfer['txid'] ?? '') ?: null;
                    }
                }
            }
        }

        return null;
    }

    /**
     * On-chain verdict on a payout hash:
     *   true  = the wallet knows this transaction and it has not failed,
     *   false = the wallet says it failed,
     *   null  = we cannot tell — never re-pay on this answer.
     */
    public function payoutSucceeded(string $txid): ?bool
    {
        $result = $this->call('get_transfer_by_txid', ['txid' => $txid]);

        if ($result === null || ! isset($result['transfer'])) {
            return null;
        }

        $type = (string) ($result['transfer']['type'] ?? '');

        return match ($type) {
            'failed' => false,
            '' => null,
            default => true,
        };
    }

    private function payoutTimeout(): int
    {
        return max(10, (int) config('bridge.relay.monero_timeout_seconds', 240));
    }

    /**
     * One JSON-RPC call. Returns the `result` object, or null for every kind
     * of "did not get an answer" there is — transport, HTTP status, a JSON-RPC
     * error object, or a body that is not what this method promised.
     *
     * @param  array<string, mixed>  $params
     * @return array<string, mixed>|null
     */
    private function call(string $method, array $params = [], ?int $timeout = null): ?array
    {
        $url = $this->url();

        if ($url === '') {
            return null;
        }

        try {
            $response = $this->client($timeout)->post($url.self::RPC_PATH, [
                'jsonrpc' => '2.0',
                'id' => '0',
                'method' => $method,
                'params' => (object) $params,
            ]);

            if (! $response->successful()) {
                Log::warning('Monero wallet RPC: HTTP failure', [
                    'method' => $method,
                    'status' => $response->status(),
                ]);

                return null;
            }

            $body = $response->json();

            if (! is_array($body)) {
                return null;
            }

            if (isset($body['error'])) {
                Log::warning('Monero wallet RPC: error', [
                    'method' => $method,
                    'code' => $body['error']['code'] ?? null,
                    'message' => $body['error']['message'] ?? null,
                ]);

                return null;
            }

            $result = $body['result'] ?? null;

            return is_array($result) ? $result : null;
        } catch (\Throwable $e) {
            Log::warning('Monero wallet RPC: unreachable', [
                'method' => $method,
                'error' => $e->getMessage(),
            ]);

            return null;
        }
    }

    private function client(?int $timeout): PendingRequest
    {
        $request = Http::acceptJson()
            ->timeout($timeout ?? max(3, (int) config('bridge.chains.monero.wallet_rpc_timeout', 15)));

        $user = (string) config('bridge.chains.monero.wallet_rpc_user', '');
        $password = (string) config('bridge.chains.monero.wallet_rpc_password', '');

        // monero-wallet-rpc's --rpc-login is HTTP digest, not basic. Sending
        // basic credentials to it authenticates nothing and reads as a 401.
        return $user === ''
            ? $request
            : $request->withDigestAuth($user, $password);
    }

    /**
     * An atomic amount as a decimal string, or null when the value is not one.
     *
     * A float here would mean the JSON carried an amount larger than a 64-bit
     * integer, which cannot be a real Monero amount — so it is refused rather
     * than rounded into somebody's balance.
     */
    private function atomic(mixed $value): ?string
    {
        if (is_int($value)) {
            return $value >= 0 ? (string) $value : null;
        }

        if (is_string($value) && ctype_digit($value)) {
            return $value;
        }

        return null;
    }
}
