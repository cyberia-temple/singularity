<?php

namespace App\Support;

/**
 * "100 CYBER", "0.00012 SOL": an amount from the bot's `activity_events` the
 * way the feed and its notifications print it — trailing zeros dropped, more
 * places below one so a small amount is not printed as nothing.
 */
class TradeAmount
{
    public static function format(mixed $amount, mixed $symbol): ?string
    {
        if ($symbol === null) {
            return null;
        }

        if ($amount === null) {
            return (string) $symbol;
        }

        $value = (float) $amount;
        $places = $value >= 1 ? 4 : 8;

        return rtrim(rtrim(number_format($value, $places, '.', ''), '0'), '.').' '.$symbol;
    }
}
