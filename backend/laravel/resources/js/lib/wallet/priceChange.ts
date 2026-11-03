/**
 * How prices moved over the last 24 hours, and what that did to a balance.
 *
 * The server reports a change only where somebody measured one — an outside
 * feed's own figure, or today's price against yesterday's snapshot — and a
 * missing change stays missing here: nothing is drawn for it, because "0%" is
 * a claim that the price held still.
 */
export type PriceChanges = {
    /** Chain id → the coin's 24h change, in percent. */
    prices: Record<string, number>;
    /** Chain id → lowercased contract → 24h change, in percent. */
    tokens: Record<string, Record<string, number>>;
};

export const NO_CHANGES: PriceChanges = { prices: {}, tokens: {} };

/** The 24h change of a chain's coin (no token) or of one of its tokens. */
export const changeOf = (
    changes: PriceChanges | null | undefined,
    chain: string,
    token?: string | null,
): number | null => {
    const value = token
        ? changes?.tokens?.[chain]?.[token.toLowerCase()]
        : changes?.prices?.[chain];

    return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

/**
 * How many dollars a holding worth `usd` now gained or lost in the move: what
 * it is worth minus what the same amount was worth a day ago.
 */
export const usdDelta = (
    usd: number | null,
    pct: number | null,
): number | null => {
    if (usd === null || pct === null || pct <= -100) {
        return null;
    }

    return usd - usd / (1 + pct / 100);
};

/**
 * The move of several holdings together. Only holdings whose change is known
 * take part — on both sides of the ratio — so an unmeasured one neither drags
 * the figure towards zero nor is counted as having moved. Null when none of
 * them was measured.
 */
export const combinedChange = (
    items: { usd: number | null; change: number | null }[],
): { usd: number; pct: number } | null => {
    let now = 0;
    let delta = 0;
    let measured = false;

    for (const item of items) {
        const moved = usdDelta(item.usd, item.change);

        if (moved === null || item.usd === null) {
            continue;
        }

        measured = true;
        now += item.usd;
        delta += moved;
    }

    const before = now - delta;

    if (!measured || before <= 0) {
        return null;
    }

    return { usd: delta, pct: (delta / before) * 100 };
};

/** "+3.25%", "−0.40%" — always signed, so a fall is never read as a rise. */
export const formatChangePct = (pct: number, locale: string): string =>
    new Intl.NumberFormat(locale, {
        signDisplay: 'exceptZero',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(pct) + '%';

/** Which colour a move is drawn in: up, down, or flat. */
export const changeTone = (pct: number | null): 'up' | 'down' | 'flat' =>
    pct === null || Math.abs(pct) < 0.005 ? 'flat' : pct > 0 ? 'up' : 'down';
