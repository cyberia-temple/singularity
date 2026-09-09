<?php

namespace App\Services;

use App\Models\BridgeRequest;
use App\Services\Monero\MoneroWalletRpc;
use App\Services\Yenten\YentenAddressDeriver;

/**
 * The half of the bridge where nobody signs anything.
 *
 * Most corridors start with a transaction hash: the user signs a transfer, the
 * hash names it, and the relayer looks it up. Two chains here cannot work that
 * way — Yenten because a light wallet's hash is not a thing the user can hand
 * over reliably, Monero because an outsider cannot look up anything at all —
 * so both use the same shape instead: the bridge hands out an address that
 * belongs to exactly one request, and whatever lands on it is the deposit.
 *
 * That shape is what this class is. It answers two questions per chain and
 * nothing else — "give this request its own address" and "what has arrived on
 * it" — so the controller, the relayer and the sweeper can all be written once
 * for both chains, and a third chain of the same kind is a match arm.
 *
 * The rule the whole thing rests on: **null is not zero.** A network that
 * cannot be reached, a wallet that is not open, an API that answers garbage —
 * all of them are null, and the callers keep waiting. Only a real, readable
 * balance of nothing is zero, and only that closes a deposit window.
 */
final class BridgeDepositWatcher
{
    /** Chain types whose deposits are bound to an address instead of a hash. */
    public const ONE_TIME_ADDRESS_TYPES = ['yenten', 'monero'];

    public function __construct(private readonly MoneroWalletRpc $monero) {}

    /**
     * @param  array<string, mixed>  $chain
     */
    public function supports(array $chain): bool
    {
        return in_array((string) ($chain['type'] ?? ''), self::ONE_TIME_ADDRESS_TYPES, true);
    }

    /**
     * Give this request an address of its own, and write it onto the request.
     *
     * Returns a reason string when it cannot — the caller turns that into the
     * message a person reads, because "the Monero wallet is not attached to
     * this server" and "we could not derive an address" are different
     * problems with different people to call.
     *
     * @param  array<string, mixed>  $chain
     */
    public function issue(BridgeRequest $request, array $chain): ?string
    {
        return match ((string) ($chain['type'] ?? '')) {
            'yenten' => $this->issueYenten($request),
            'monero' => $this->issueMonero($request),
            default => 'This route does not use a prepared deposit address.',
        };
    }

    /**
     * What has landed on this request's address, in the source chain's own raw
     * units: `confirmed` is creditable, `pending` is seen but not deep enough.
     *
     * @param  array<string, mixed>  $chain
     * @return array{confirmed: string, pending: string}|null
     */
    public function balances(BridgeRequest $request, array $chain): ?array
    {
        $address = (string) ($request->deposit_address ?? '');

        if ($address === '') {
            return null;
        }

        return match ((string) ($chain['type'] ?? '')) {
            'yenten' => app(YentenApiService::class)->addressBalances($address),
            'monero' => $request->deposit_index === null
                ? null
                : $this->monero->incoming(
                    (int) $request->deposit_index,
                    max(1, (int) ($chain['minimum_confirmations'] ?? 10)),
                ),
            default => null,
        };
    }

    /**
     * Just the creditable part, which is what the relayer verifies against.
     *
     * @param  array<string, mixed>  $chain
     */
    public function confirmedBalance(BridgeRequest $request, array $chain): ?string
    {
        return $this->balances($request, $chain)['confirmed'] ?? null;
    }

    /**
     * How long an empty address stays watched. A deposit that DID arrive is
     * honoured whenever it arrives; this only decides when an address nobody
     * used stops being polled.
     *
     * @param  array<string, mixed>  $chain
     */
    public function depositTtlMinutes(array $chain): int
    {
        return max(1, (int) ($chain['deposit_ttl_minutes'] ?? 60));
    }

    private function issueYenten(BridgeRequest $request): ?string
    {
        $deriver = YentenAddressDeriver::fromConfig();

        $request->update([
            'deposit_address' => $deriver->depositAddress($request->id),
            'deposit_wif' => $deriver->childWif($request->id),
        ]);

        return null;
    }

    private function issueMonero(BridgeRequest $request): ?string
    {
        if (! $this->monero->configured()) {
            return 'The Monero corridor has no wallet attached to this server yet.';
        }

        // Labelled with the request it belongs to, so the same fact is legible
        // from inside the wallet as well as from the database — an operator
        // reading `monero-wallet-cli` should not have to guess whose deposit
        // an address is.
        $created = $this->monero->createSubaddress("bridge:{$request->id}");

        if ($created === null) {
            return 'Could not reach the Monero wallet — try again shortly.';
        }

        $request->update([
            'deposit_address' => $created['address'],
            // A subaddress has no key of its own to store: it is spendable by
            // the wallet that made it, which is why Monero deposits need no
            // sweeping at all. `deposit_wif` stays null on purpose.
            'deposit_index' => $created['index'],
        ]);

        return null;
    }
}
