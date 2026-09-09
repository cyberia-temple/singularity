<?php

namespace App\Support;

/**
 * What happened when the bridge looked at a one-time deposit address.
 *
 * Three answers, and the difference between them is the difference between a
 * person waiting patiently and a person filing a support ticket:
 *
 *   credited  — money was seen, the amount is on the request, the relay ran.
 *   waiting   — nothing creditable yet, and that is fine: the deposit has not
 *               arrived, or has not gone deep enough, or the network could not
 *               be reached at all. Every one of these is `retryable`, because
 *               none of them is a verdict about the user's money.
 *   expired   — the window closed on an address nobody used. The only state
 *               that ends a request, and it is never reached while anything at
 *               all is visible on the address.
 */
final class BridgeDepositOutcome
{
    private function __construct(
        public readonly bool $credited,
        public readonly ?string $message,
        public readonly bool $retryable,
        public readonly bool $expired,
    ) {}

    public static function credited(): self
    {
        return new self(true, null, false, false);
    }

    public static function waiting(string $message): self
    {
        return new self(false, $message, true, false);
    }

    public static function expired(string $message): self
    {
        return new self(false, $message, false, true);
    }
}
