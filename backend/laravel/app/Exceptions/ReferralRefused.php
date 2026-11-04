<?php

namespace App\Exceptions;

use RuntimeException;

/**
 * An invite that cannot be accepted, with a reason the screen can translate.
 *
 * The message is English for logs and API callers; `reason` is the stable key
 * the wallet turns into the reader's language.
 */
class ReferralRefused extends RuntimeException
{
    public function __construct(public readonly string $reason, string $message)
    {
        parent::__construct($message);
    }
}
