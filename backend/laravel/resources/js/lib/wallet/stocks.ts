import type { StockToken } from '@/lib/robinhoodStocks';
import { ROBINHOOD_STOCKS } from '@/lib/robinhoodStocks';

/**
 * Prices for the tokenised stocks, read from this host rather than the issuer.
 *
 * The browser could ask Robinhood directly — the endpoint is public and
 * keyless — and deliberately does not. Its rate limit is counted per caller, so
 * every visitor asking for themselves spends the same budget separately, and
 * fifty-three tickers refreshed on a wallet screen is exactly the shape of
 * request that gets an IP throttled. One cached read here serves all of them.
 *
 * The list itself never comes over the network. It ships in the bundle
 * (`lib/robinhoodStocks.ts`), because which contract is the real NVDA is not
 * something a wallet should learn from an answer it cannot check — and because
 * a stock whose price could not be read must still be listed, with no price,
 * rather than vanishing from the screen.
 */

export type StockQuote = {
    symbol: string;
    /** USD per **token**: the share's quote times the issuer's multiplier. */
    price: number | null;
    /** USD per share, before the multiplier — what a broker would show. */
    share: number | null;
    high: number | null;
    low: number | null;
    volume: number | null;
    /** Shares per token. One for almost everything, and never assumed. */
    multiplier: number;
    /** The issuer says trading is stopped. Not the same as "no price". */
    halted: boolean;
};

export type StockRow = StockToken & StockQuote;

/** Every listed stock with no price at all — what the screen draws first. */
export const unpricedStocks = (): StockRow[] =>
    ROBINHOOD_STOCKS.map((stock) => ({
        ...stock,
        icon: stock.icon,
        price: null,
        share: null,
        high: null,
        low: null,
        volume: null,
        multiplier: 1,
        halted: false,
    }));

/**
 * The same list with whatever prices came back.
 *
 * The registry leads and the answer follows it: a row the server did not price
 * keeps its place with a dash, and a symbol the server priced that this build
 * does not list is dropped rather than drawn. Both directions matter — the
 * first is an unreadable market, the second is a list that has moved on.
 */
export const fetchStocks = async (): Promise<{
    rows: StockRow[];
    quotedAt: string | null;
}> => {
    const response = await fetch('/api/wallet/stocks', {
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error(`Cyberia returned ${response.status}`);
    }

    const body = (await response.json()) as {
        stocks: (StockToken & Partial<StockQuote>)[];
        quotedAt: string | null;
    };

    const priced = new Map(
        body.stocks.map((row) => [row.symbol.toUpperCase(), row]),
    );

    return {
        rows: ROBINHOOD_STOCKS.map((stock) => {
            const quote = priced.get(stock.symbol);

            return {
                ...stock,
                icon: stock.icon,
                price: quote?.price ?? null,
                share: quote?.share ?? null,
                high: quote?.high ?? null,
                low: quote?.low ?? null,
                volume: quote?.volume ?? null,
                multiplier: quote?.multiplier ?? 1,
                halted: quote?.halted ?? false,
            };
        }),
        quotedAt: body.quotedAt ?? null,
    };
};

/**
 * A stock price, to the cent.
 *
 * The wallet's usual formatter runs to four decimals, because a coin can be
 * worth a fraction of one and rounding it away would render a real balance as
 * zero. A share is not that: it is quoted in cents, nothing here measures it
 * more finely, and multiplying by the issuer's multiplier produces a tail of
 * digits that would advertise a precision the market never published.
 */
export const formatStockUsd = (value: number | null, locale: string): string =>
    value === null
        ? '—'
        : new Intl.NumberFormat(locale, {
              style: 'currency',
              currency: 'USD',
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
          }).format(value);

/**
 * Where the price sits between the day's low and high, 0 to 1, or null.
 *
 * The one derived number this screen draws, and it is arithmetic on three
 * figures the issuer gave rather than a comparison with a close nobody
 * published. A day that has not moved (high equal to low) has no position
 * inside itself and answers null instead of dividing by zero.
 */
export const dayPosition = (row: {
    share: number | null;
    high: number | null;
    low: number | null;
}): number | null => {
    const { share, high, low } = row;

    if (share === null || high === null || low === null || high <= low) {
        return null;
    }

    return Math.min(1, Math.max(0, (share - low) / (high - low)));
};

/** Case-insensitive search over ticker and company name. */
export const searchStockRows = (
    rows: readonly StockRow[],
    term: string,
): StockRow[] => {
    const query = term.trim().toLowerCase();

    if (query === '') {
        return [...rows];
    }

    return rows.filter(
        (row) =>
            row.symbol.toLowerCase().includes(query) ||
            row.name.toLowerCase().includes(query),
    );
};
