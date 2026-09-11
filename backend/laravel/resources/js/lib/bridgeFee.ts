import type { BridgeTokenSymbol } from '@/lib/bridgeTokens';

export type BridgeFeeConfig = {
    flatUsd: number;
    rateBps: number;
    nativeRouteFees?: Record<string, Record<string, number>>;
};

export type TokenPrices = {
    cyberSolUsd: number | null;
};

export type FeeResult = {
    feeUsd: number;
    feeToken: number;
    tokenPriceUsd: number;
};

export const DEFAULT_FEE: BridgeFeeConfig = {
    flatUsd: 0.1,
    rateBps: 0,
    nativeRouteFees: {},
};

export const priceUsd = (
    token: BridgeTokenSymbol,
    prices: TokenPrices,
): number => {
    if (
        token === 'USDC' ||
        token === 'USDT' ||
        token === 'USDG' ||
        token === 'JupUSD'
    ) {
        return 1;
    }

    if (token === 'CYBER.sol') {
        return prices.cyberSolUsd ?? 0;
    }

    return 0;
};

export const isFeeBearing = (
    token: BridgeTokenSymbol,
    direction?: string,
    config: BridgeFeeConfig = DEFAULT_FEE,
): boolean =>
    token === 'USDC' ||
    token === 'USDT' ||
    token === 'USDG' ||
    token === 'JupUSD' ||
    (direction !== undefined &&
        (config.nativeRouteFees?.[direction]?.[token] ?? 0) > 0);

export const computeFee = (
    token: BridgeTokenSymbol,
    amount: string,
    prices: TokenPrices,
    config: BridgeFeeConfig = DEFAULT_FEE,
    direction?: string,
): FeeResult => {
    const amt = parseFloat(amount);
    const price = priceUsd(token, prices);
    const nativeFee =
        direction !== undefined
            ? (config.nativeRouteFees?.[direction]?.[token] ?? 0)
            : 0;

    if (!isFeeBearing(token, direction, config)) {
        return { feeUsd: 0, feeToken: 0, tokenPriceUsd: price };
    }

    if (nativeFee > 0) {
        return { feeUsd: 0, feeToken: nativeFee, tokenPriceUsd: price };
    }

    if (!Number.isFinite(amt) || amt <= 0 || price <= 0) {
        return { feeUsd: 0, feeToken: 0, tokenPriceUsd: price };
    }

    const amountUsd = amt * price;
    const rateUsd = amountUsd * (config.rateBps / 10000);
    const feeUsd = Math.max(config.flatUsd, rateUsd);
    const feeToken = feeUsd / price;

    return { feeUsd, feeToken, tokenPriceUsd: price };
};
