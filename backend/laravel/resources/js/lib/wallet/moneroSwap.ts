/**
 * Swapping Monero, by two routes, with the better one marked.
 *
 * Every other swap surface in this wallet has one venue and uses it. Monero
 * has two that are not the same bargain, so this module's whole job is to make
 * them comparable without flattening the difference:
 *
 *   - **ours** — real XMR to a deposit address this project controls, a
 *     wrapper minted on Cyberia, then our own pools. Custodial for the length
 *     of one deposit, slow as Monero's confirmations, and the only route whose
 *     output is liquidity on the chain this wallet is for;
 *   - **a partner exchanger** — never touches this host, faster, and priced by
 *     somebody whose spread we do not set.
 *
 * Cyberia's fee is taken on both — that is a decision, not an accident — but
 * it is taken out of different places, so it is stated per route rather than
 * as one number over the screen. And what is compared is what the user
 * actually receives, after every fee on each route: comparing headline rates
 * is how a worse route wins.
 */

/** What a route promises, in the units the user reads. */
export type MoneroRouteQuote = {
    key: 'cyberia' | 'partner';
    label: string;
    /** Smallest units of the asset being received. */
    amountOut: bigint;
    decimalsOut: number;
    /** Cyberia's share of this route, in basis points of the input. */
    feeBps: number;
    /** False when the fee was asked for and the venue did not honour it. */
    feeApplied: boolean;
    /** Roughly how long, start to finish. */
    minutes: number | null;
    /** Who holds the coins while it happens. Never null: somebody always does. */
    custodian: string;
    /** Anything the user must be told before choosing this one. */
    notes: string[];
};

export type MoneroComparison = {
    routes: MoneroRouteQuote[];
    best: MoneroRouteQuote | null;
    /** How much more the winner pays, in percent, or null when only one answered. */
    advantagePct: number | null;
};

/**
 * Order two quotes by what they actually pay out.
 *
 * Same asset, same decimals on both sides — the caller guarantees that,
 * because a comparison between two different assets is not a comparison. A
 * route that could not be quoted is simply absent; it is the screen's job to
 * say why, and this function's job never to invent a zero for it.
 */
export const compareMoneroRoutes = (
    quotes: (MoneroRouteQuote | null)[],
): MoneroComparison => {
    const routes = quotes
        .filter((q): q is MoneroRouteQuote => q !== null && q.amountOut > 0n)
        .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1));

    const best = routes[0] ?? null;
    const runnerUp = routes[1] ?? null;

    return {
        routes,
        best,
        advantagePct:
            best && runnerUp && runnerUp.amountOut > 0n
                ? (Number(best.amountOut - runnerUp.amountOut) /
                      Number(runnerUp.amountOut)) *
                  100
                : null,
    };
};

/**
 * What actually reaches the pools after a deposit, on our own route.
 *
 * Two fees, and they are different animals: ours is a share of the deposit,
 * the bridge's is a flat cost in dollars that must be converted at the price
 * of the day. A flat fee is why a small deposit is a bad deal here, and the
 * screen has to be able to show that rather than discover it afterwards.
 *
 * Returns zero rather than a negative when the fees exceed the deposit — a
 * deposit that cannot pay its own costs is refused, not inverted.
 */
export const ourNetXmr = (
    depositPiconero: bigint,
    feeBps: number,
    bridgeFlatUsd: number,
    bridgeRateBps: number,
    xmrUsd: number | null,
): bigint => {
    if (depositPiconero <= 0n) {
return 0n;
}

    if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) {
        throw new Error('A fee must be between 0 and 100 percent');
    }

    const afterShare =
        (depositPiconero * BigInt(10_000 - feeBps - clampBps(bridgeRateBps))) /
        10_000n;

    // No price means the flat fee cannot be converted. Charging nothing for it
    // would understate the cost, so it is the caller's job to notice the null
    // and say the quote is partial — here it is simply not deducted.
    if (!xmrUsd || xmrUsd <= 0 || bridgeFlatUsd <= 0) {
        return afterShare > 0n ? afterShare : 0n;
    }

    const flatPiconero = BigInt(Math.round((bridgeFlatUsd / xmrUsd) * 1e12));

    return afterShare > flatPiconero ? afterShare - flatPiconero : 0n;
};

const clampBps = (bps: number): number =>
    Number.isInteger(bps) && bps > 0 ? Math.min(bps, 9_999) : 0;

/** Why a route is not on offer, in the user's terms rather than the config's. */
export const moneroRouteReason = (reason: string | null): string | null =>
    reason === null
        ? null
        : ({
              monero_chain_disabled:
                  'The Monero side is switched off on this server.',
              no_deposit_address: 'No Monero deposit address is configured.',
              corridor_coming_soon:
                  'The Monero corridor is built but not open yet.',
              partner_not_configured:
                  'No partner exchanger is connected on this server.',
              disabled: 'Monero swaps are switched off here.',
              unreachable: 'The exchanger did not answer.',
              refused: 'The exchanger refused this trade.',
              unreadable: 'The exchanger answered something unreadable.',
          }[reason] ?? 'This route is unavailable.');

export type MoneroRoutesResponse = {
    enabled: boolean;
    fee_bps: number;
    routes: {
        key: 'cyberia' | 'partner';
        label: string;
        available: boolean;
        reason: string | null;
        custodial: boolean;
        [key: string]: unknown;
    }[];
};

/** Both routes and their terms, before an amount is typed. */
export const fetchMoneroRoutes = async (): Promise<MoneroRoutesResponse> => {
    const response = await fetch('/api/wallet/monero/swap', {
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error(`Monero routes unavailable (${response.status})`);
    }

    return (await response.json()) as MoneroRoutesResponse;
};

export type PartnerQuote = {
    ok: boolean;
    reason?: string;
    provider?: string;
    amount_to?: string;
    amount_from?: string;
    eta_minutes?: number | null;
    fee_bps?: number;
    fee_applied?: boolean;
};

/**
 * The partner's price for one trade.
 *
 * Always through this host: the affiliate key and Cyberia's share are composed
 * on the server, and a fee a browser could write is a fee a browser could
 * delete.
 */
export const fetchPartnerQuote = async (
    from: string,
    to: string,
    amount: string,
    side: 'from' | 'to' = 'from',
): Promise<PartnerQuote> => {
    const query = new URLSearchParams({ from, to, amount, side });
    const response = await fetch(`/api/wallet/monero/swap/quote?${query}`, {
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        return { ok: false, reason: 'refused' };
    }

    return (await response.json()) as PartnerQuote;
};
