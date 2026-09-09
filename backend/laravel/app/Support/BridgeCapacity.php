<?php

namespace App\Support;

/**
 * What the bridge can actually deliver on a destination chain right now.
 *
 * The whole reason this class exists is that `null` used to mean two opposite
 * things — "the relayer mints on demand, so there is no ceiling" and "the RPC
 * did not answer, so we have no idea" — and the second one silently behaved
 * like the first. A read failure that reads as unlimited is a fail-OPEN gate on
 * an irreversible operation: it is what let request #68 burn a wrapper and then
 * discover the destination could not pay.
 *
 * Four states, and every one of them says something different:
 *
 *   unlimited   — the relayer really does mint the payout asset on this
 *                 destination. There is no inventory to run out of.
 *   available   — a known, finite amount, held as a RAW integer string in the
 *                 destination entry's own decimals. Never a float.
 *   unmeasured  — this destination's inventory is not read by this server
 *                 (manual reserves: Yenten, BTC, LTC — and Monero while no
 *                 wallet is attached to it). Not an error and not a promise:
 *                 the corridor is simply not admission-controlled and says
 *                 so. A chain can move out of this state by giving the server
 *                 something to read, which is what a Monero wallet does.
 *   unavailable — we tried and failed: RPC error, malformed answer, missing
 *                 config. FAIL-CLOSED: this covers nothing.
 */
final class BridgeCapacity
{
    public const UNLIMITED = 'unlimited';

    public const AVAILABLE = 'available';

    public const UNMEASURED = 'unmeasured';

    public const UNAVAILABLE = 'unavailable';

    private function __construct(
        public readonly string $state,
        public readonly ?string $availableRaw,
        public readonly int $decimals,
        public readonly ?string $reason,
    ) {}

    public static function unlimited(int $decimals = 18): self
    {
        return new self(self::UNLIMITED, null, $decimals, null);
    }

    public static function available(string $availableRaw, int $decimals): self
    {
        // Never let a negative reserve subtraction escape as a negative
        // ceiling: "nothing deliverable" is 0, not −1.
        $raw = bccomp($availableRaw, '0', 0) > 0 ? $availableRaw : '0';

        return new self(self::AVAILABLE, $raw, $decimals, null);
    }

    public static function unmeasured(int $decimals = 18, string $reason = 'not measured'): self
    {
        return new self(self::UNMEASURED, null, $decimals, $reason);
    }

    public static function unavailable(string $reason, int $decimals = 18): self
    {
        return new self(self::UNAVAILABLE, null, $decimals, $reason);
    }

    public function isUnlimited(): bool
    {
        return $this->state === self::UNLIMITED;
    }

    public function isAvailable(): bool
    {
        return $this->state === self::AVAILABLE;
    }

    public function isUnmeasured(): bool
    {
        return $this->state === self::UNMEASURED;
    }

    public function isUnavailable(): bool
    {
        return $this->state === self::UNAVAILABLE;
    }

    /**
     * Is this destination admission-controlled at all? Only `available` is —
     * the other three have no number to subtract a reservation from.
     */
    public function isCapped(): bool
    {
        return $this->state === self::AVAILABLE;
    }

    /**
     * Can this capacity deliver $netRaw (raw integer units, destination
     * decimals)? Equality is allowed — exactly the balance is deliverable.
     *
     * `unavailable` covers nothing, which is the entire point.
     */
    public function covers(string $netRaw): bool
    {
        return match ($this->state) {
            self::UNLIMITED, self::UNMEASURED => true,
            self::AVAILABLE => bccomp((string) $this->availableRaw, $netRaw, 0) >= 0,
            default => false,
        };
    }

    /**
     * Subtract already-promised raw units (active reservations + confirmed
     * liabilities). Only a finite capacity can shrink.
     */
    public function minus(string $outstandingRaw): self
    {
        if (! $this->isAvailable() || bccomp($outstandingRaw, '0', 0) <= 0) {
            return $this;
        }

        return self::available(
            bcsub((string) $this->availableRaw, $outstandingRaw, 0),
            $this->decimals,
        );
    }

    /**
     * Human-readable amount, or null when there is no finite number to show.
     * The UI renders null as "—" and never as 0.
     */
    public function availableAmount(): ?string
    {
        return $this->availableRaw === null
            ? null
            : TokenAmount::fromRaw($this->availableRaw, $this->decimals);
    }

    /**
     * @return array{state: string, available: string|null, available_raw: string|null, decimals: int, reason: string|null}
     */
    public function toArray(): array
    {
        return [
            'state' => $this->state,
            'available' => $this->availableAmount(),
            'available_raw' => $this->availableRaw,
            'decimals' => $this->decimals,
            'reason' => $this->reason,
        ];
    }
}
