import { formatUnits } from '@/lib/wallet/chains';

/**
 * Presentation helpers for the wallet page.
 *
 * Amounts are formatted from bigints and never from floats: a balance that
 * round-trips through a double is a balance that can be off by a wei, and the
 * send screen subtracts fees from exactly these numbers.
 */

/** Head and tail preserved — the two ends people actually check. */
export const shortAddress = (address: string, head = 6, tail = 4): string =>
    address.length > head + tail + 2
        ? `${address.slice(0, head)}…${address.slice(-tail)}`
        : address;

/** A signed, fixed-precision amount, e.g. "−120.0000". */
export const signedAmount = (
    value: bigint,
    decimals: number,
    precision = 4,
): string => {
    const magnitude = formatUnits(value < 0n ? -value : value, decimals, 12);
    const [whole, fraction = ''] = magnitude.split('.');

    return `${value < 0n ? '−' : '+'}${whole}.${fraction.padEnd(precision, '0').slice(0, precision)}`;
};

const RELATIVE_STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
];

/** "2h ago" / "2 ч назад", from a unix-seconds timestamp. */
export const relativeTime = (
    timestamp: number | null,
    locale: string,
): string => {
    if (timestamp === null) {
        return '';
    }

    const elapsed = Math.round(Date.now() / 1000) - timestamp;
    const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

    for (const [unit, seconds] of RELATIVE_STEPS) {
        if (Math.abs(elapsed) >= seconds) {
            return formatter.format(-Math.round(elapsed / seconds), unit);
        }
    }

    return formatter.format(-elapsed, 'second');
};

/**
 * A USD figure, or null when no price was available. Callers render null as a
 * dash rather than as zero — an unknown price is not a worthless balance.
 */
export const usdValue = (
    value: bigint | null,
    decimals: number,
    price: number | null,
): number | null => {
    if (value === null || price === null) {
        return null;
    }

    return Number(formatUnits(value, decimals, 12)) * price;
};

/**
 * A USD amount.
 *
 * Two decimals for anything a cent can express, and significant digits below
 * that. CYBER trades in the tens of microdollars, so a fixed two decimals
 * printed every Cyberia balance in this wallet — the coin card, the network
 * screen, the portfolio total — as "$0.00", which reads as an empty wallet
 * rather than as a cheap coin. Zero itself is still "$0.00": that one is a
 * fact about the balance.
 */
export const formatUsd = (value: number | null, locale: string): string => {
    if (value === null) {
        return '—';
    }

    const magnitude = Math.abs(value);

    return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
        ...(magnitude > 0 && magnitude < 0.01
            ? { maximumSignificantDigits: 3 }
            : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    }).format(value);
};

/**
 * What one unit costs — a rate rather than a holding.
 *
 * Same rule as above at the bottom of the range, and four decimals rather than
 * two in the middle of it: a price is the number people compare between
 * screens, and $1.0000 against $1.0004 is a difference worth seeing.
 */
export const formatUsdPrice = (value: number | null, locale: string): string =>
    value === null
        ? '—'
        : new Intl.NumberFormat(locale, {
              style: 'currency',
              currency: 'USD',
              ...(Math.abs(value) < 0.01
                  ? { maximumSignificantDigits: 4 }
                  : { minimumFractionDigits: 2, maximumFractionDigits: 4 }),
          }).format(value);

/**
 * An address split into groups of four, the way a card number is read.
 *
 * Addresses are compared by eye — against a paper note, against another
 * screen, against the field something was already pasted into — and a
 * forty-two character run wrapping wherever the box ends is the shape that
 * makes people lose their place on the second line. The copy button beside
 * every one of these is still how the whole string moves.
 */
export const addressGroups = (address: string, size = 4): string[] =>
    address.match(new RegExp(`.{1,${size}}`, 'g')) ?? [];
