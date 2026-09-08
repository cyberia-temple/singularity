import { CYBERIA_CHAIN_ID } from '@/lib/evmChains';
import { walletChain, walletChains } from '@/lib/wallet/chains';
import type { WalletChain, WalletChainId } from '@/lib/wallet/chains';

/**
 * What the wallet can draw a price history for, and where that history comes
 * from.
 *
 * Two sources, and they are never blurred, because they answer with different
 * authority. An asset that trades on exchanges has a real order book somewhere
 * and TradingView already draws it better than this wallet ever will. An asset
 * that trades only in this chain's own pools has no book at all — its history
 * exists as `Sync` events and nothing else — so those candles are rebuilt from
 * the chain, hop by hop, by `lib/marketCandles.ts`.
 *
 * Neither source is offered as the other. A pair with no exchange listing does
 * not get an empty TradingView frame, and a pair whose pools this browser
 * cannot read does not get a flat line: it says which of the two it is.
 */

export type MarketSource =
    /** Drawn by TradingView, from a real exchange's book. */
    | 'exchange'
    /** Rebuilt here from the pools' own `Sync` events. */
    | 'onchain'
    /** Neither: nobody lists it and no pool graph here can price it. */
    | 'none';

export type Market = {
    /** Stable id, used as the route parameter and the list key. */
    id: string;
    /** What is being priced. */
    symbol: string;
    /** Human name of the asset. */
    label: string;
    /** What it is priced in — always USD or a dollar stablecoin. */
    quote: string;
    source: MarketSource;
    /** The network whose colour and tag the row wears. */
    chain: WalletChainId;
    /**
     * TradingView's own symbol, exchange included. Present only when `source`
     * is `exchange`, and never guessed: an id TradingView does not know renders
     * as an empty chart with no error, which is worse than saying we have none.
     */
    tvSymbol?: string;
    /** ERC-20 contract, for the markets priced from this chain's pools. */
    address?: string;
    /** Why there is no chart, when there is none. */
    note?: 'noListing' | 'noPool' | 'receiveOnly';
};

/**
 * Exchange listings for the coins the wallet holds natively.
 *
 * Hand-written and deliberately short. Every entry was checked to exist on the
 * venue it names, because TradingView answers an unknown symbol with a blank
 * frame rather than a 404 — a wrong guess here is indistinguishable from a
 * broken chart. The venue is part of the answer: Monero is not on Binance (it
 * was delisted in 2024), so it is read from Kraken or not at all.
 */
const EXCHANGE_SYMBOLS: Partial<Record<WalletChainId, string>> = {
    bitcoin: 'BINANCE:BTCUSDT',
    litecoin: 'BINANCE:LTCUSDT',
    solana: 'BINANCE:SOLUSDT',
    bnb: 'BINANCE:BNBUSDT',
    monero: 'KRAKEN:XMRUSD',
    // Base and Robinhood are settled in ether, and ether is what a chart of
    // them would be. Both point at the same book on purpose.
    base: 'BINANCE:ETHUSDT',
    robinhood: 'BINANCE:ETHUSDT',
};

/**
 * The exchange symbol for a network's own coin, or null.
 *
 * Only the networks in the table above are answered, and that table is short
 * because each line was checked rather than because those chains are special.
 * Any other network may well have a listed coin; nothing here has verified
 * which, and a symbol assembled from a ticker (`BINANCE:` + symbol + `USDT`) is
 * exactly the guess that renders blank.
 */
export const exchangeSymbol = (chain: WalletChainId): string | null =>
    EXCHANGE_SYMBOLS[chain] ?? null;

/**
 * The URL of TradingView's embedded chart.
 *
 * It is loaded as an `iframe` pointing at TradingView's own origin, and never
 * as their `tv.js` loader. The loader injects a script into the page that
 * embeds it, and this page is a wallet: it decrypts a seed phrase into memory
 * and keeps a vault in this origin's localStorage. Third-party script here
 * would run with all of that in reach, and no chart is worth that. In an iframe
 * the same widget is a different origin and can reach none of it.
 */
export const exchangeChartUrl = (
    tvSymbol: string,
    options: { theme: 'light' | 'dark'; locale: string; interval?: string },
): string => {
    const params = new URLSearchParams({
        symbol: tvSymbol,
        interval: options.interval ?? '60',
        theme: options.theme,
        style: '1',
        locale: options.locale,
        hide_side_toolbar: '1',
        allow_symbol_change: '0',
        save_image: '0',
        withdateranges: '1',
        timezone: 'Etc/UTC',
    });

    return `https://s.tradingview.com/widgetembed/?${params.toString()}`;
};

/**
 * TradingView localises its own chrome, and answers an unknown locale in
 * English. Only the languages the wallet itself speaks are mapped.
 */
export const exchangeChartLocale = (locale: string): string => {
    if (locale === 'ru') {
        return 'ru';
    }

    if (locale === 'zh') {
        return 'zh_CN';
    }

    return 'en';
};

/** Whether this network's own coin can be charted, and how. */
const coinSource = (chain: WalletChain): MarketSource => {
    if (exchangeSymbol(chain.id)) {
        return 'exchange';
    }

    // Cyberia's coin has no listing anywhere; its price exists as this chain's
    // own pools and is charted from them.
    return chain.id === 'cyberia' ? 'onchain' : 'none';
};

/**
 * One row per network the wallet has switched on, priced in dollars.
 *
 * The list is the wallet's own networks and not a venue's catalogue: these are
 * the things the person opening this screen actually holds, and a market list
 * that opens on eight thousand pairs they own none of is a screen about
 * somebody else's portfolio.
 */
export const coinMarkets = (): Market[] =>
    walletChains().map((chain) => {
        const source = coinSource(chain);

        return {
            id: `coin:${chain.id}`,
            symbol: chain.symbol,
            label: chain.label,
            quote: 'USD',
            source,
            chain: chain.id,
            tvSymbol: exchangeSymbol(chain.id) ?? undefined,
            note: source === 'none' ? 'noListing' : undefined,
        };
    });

/**
 * A market for one ERC-20 on Cyberia, priced against the dollar through the
 * DEX's own routing. Tokens on other chains are not offered: the routed history
 * is rebuilt from pools this wallet knows how to walk, and that graph is the
 * Cyberia fork's.
 */
export const tokenMarket = (token: {
    chain: WalletChainId;
    address: string;
    symbol: string;
    name?: string;
}): Market => {
    const onCyberia = token.chain === 'cyberia';

    return {
        id: `token:${token.chain}:${token.address.toLowerCase()}`,
        symbol: token.symbol,
        label: token.name?.trim() || token.symbol,
        quote: 'USD',
        source: onCyberia ? 'onchain' : 'none',
        chain: token.chain,
        address: token.address,
        note: onCyberia ? undefined : 'noPool',
    };
};

/** The EVM chain id a market's on-chain history is read from, when it has one. */
export const marketChainId = (market: Market): number | null => {
    if (market.source !== 'onchain') {
        return null;
    }

    try {
        return walletChain(market.chain).chainId ?? CYBERIA_CHAIN_ID;
    } catch {
        return CYBERIA_CHAIN_ID;
    }
};

/**
 * Case-insensitive search over what a person would actually type: the ticker,
 * the name, and a pasted contract address.
 */
export const searchMarkets = (
    markets: readonly Market[],
    query: string,
): Market[] => {
    const needle = query.trim().toLowerCase();

    if (needle === '') {
        return [...markets];
    }

    return markets.filter(
        (market) =>
            market.symbol.toLowerCase().includes(needle) ||
            market.label.toLowerCase().includes(needle) ||
            (market.address ?? '').toLowerCase().includes(needle),
    );
};
