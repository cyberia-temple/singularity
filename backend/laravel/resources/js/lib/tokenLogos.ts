import { reactive } from 'vue';
import {
    ROBINHOOD_STOCK_CHAIN_ID,
    stockByAddress,
} from '@/lib/robinhoodStocks';
import { provenanceOf } from '@/lib/wallet/provenance';

// Token logos served from public/token-icons/ (copied from the Ritual DEX), keyed by
// on-chain symbol. Used by both the Lending and Farm pages via <TokenIcon>.
//
// To add a missing one: drop the file in public/token-icons/ and add a line here —
// both pages pick it up. Tokens with no entry render a lettered gradient avatar.
export const TOKEN_LOGOS: Record<string, string> = {
    CYBER: '/token-icons/cyberia.png',
    WCYBER: '/token-icons/cyberia.png',
    'CYBER.sol': '/token-icons/CYBER.png',
    ASH: '/token-icons/ash.png',
    RUB: '/token-icons/rub.png',
    USDC: '/token-icons/usdc.svg',
    USDT: '/token-icons/usdt.svg',
    BTC: '/token-icons/btc.svg',
    LTC: '/token-icons/ltc.svg',
    SILVER: '/token-icons/silver.png',
    SOL: '/token-icons/sol.svg',
    ETH: '/token-icons/eth.svg',
    XMR: '/token-icons/monero.svg',
    TRX: '/token-icons/tron.svg',
    GOLD: '/token-icons/gold.png',
    TRUR: '/token-icons/trur.png',
    TGLD: '/token-icons/tgld.png',
    TMOS: '/token-icons/tmos.png',
    TOFZ: '/token-icons/tofz.png',
    HATCHER: '/token-icons/hatcher.jpg',
    CYBERGUARD: '/token-icons/cyberguard.png',
    KRSQ: '/token-icons/karasique.webp',
    YTN: '/token-icons/yenten.png',
    BNB: '/token-icons/bnb.svg',
    TON: '/token-icons/ton.svg',
    LAIN: '/token-icons/lain.jpg',
    MINE: '/token-icons/mine.jpg',
    GOAL: '/token-icons/goal.webp',
    TG: '/token-icons/telegram.svg',
    SPY: '/token-icons/spy.svg',
    // Robinhood Chain's dollar and its wrapped ether: both were drawing the
    // lettered fallback on the one screen that opens on them by default.
    USDG: '/token-icons/usdg.png',
    WETH: '/token-icons/eth.svg',
};

/**
 * Tokens on networks with no EVM chain id, keyed by mint.
 *
 * A base58 mint names one token on one chain and cannot be spoofed by a
 * contract elsewhere, so here the address alone decides — case-sensitively,
 * because base58 is.
 */
const MINT_SYMBOLS: Record<string, string> = {
    E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump: 'CYBER.sol',
    VANMkCYNDJ5DLpw1s6Jz89Lg7TZxy8SFhuCaFKQpump: 'CYBERGUARD',
};

// Symbols whose <img> failed to load (404). Module-level so a single failure is
// remembered across every icon of that token on the page.
const failed = reactive<Record<string, boolean>>({});

export const logoFor = (symbol: string): string | undefined =>
    TOKEN_LOGOS[symbol];

/**
 * The logo for one token, when the caller knows which chain and which contract.
 *
 * The map above is keyed by ticker, and a ticker is only unique among the
 * handful of assets this project deployed. The tokenised stocks broke that
 * quietly: `F` is Ford on Robinhood Chain and could be anything on Cyberia
 * tomorrow, and drawing Ford's mark on somebody else's token is worse than
 * drawing no mark at all. So an address, where there is one, decides: a
 * contract the stock registry lists gets its company's logo, one the
 * provenance registry lists gets its asset's logo, and anything else gets none.
 */
export const logoForToken = (
    chainId: number | undefined,
    address: string | null | undefined,
    symbol: string,
): string | undefined => {
    if (!address) {
        // A chain's own coin has no contract; its symbol is the only key.
        return TOKEN_LOGOS[symbol];
    }

    if (chainId === undefined) {
        const symbol = MINT_SYMBOLS[address];

        return symbol ? TOKEN_LOGOS[symbol] : undefined;
    }

    if (chainId === ROBINHOOD_STOCK_CHAIN_ID) {
        const stock = stockByAddress(address);

        if (stock) {
            return stock.icon;
        }
    }

    // A contract gets a logo only when the registry says which asset it is.
    // Falling back to the ticker drew Circle's mark on any token that called
    // itself USDC, on any chain.
    const known = provenanceOf(chainId, address);

    return known ? TOKEN_LOGOS[known.symbol] : undefined;
};

export const showLogo = (symbol: string): boolean =>
    !!TOKEN_LOGOS[symbol] && !failed[symbol];

// Keyed by whatever string identifies the image (symbol or explicit URL), so
// TokenIcon can track failures for both the built-in map and registry logos.
export const logoFailed = (key: string): boolean => !!failed[key];

export const markLogoFailed = (key: string): void => {
    failed[key] = true;
};

// Deterministic hue per symbol for the gradient fallback avatar.
export const hueFor = (symbol: string): number => {
    let h = 0;

    for (const c of symbol) {
        h = (h * 31 + c.charCodeAt(0)) % 360;
    }

    return h;
};
