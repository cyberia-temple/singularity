import { logoForToken } from '@/lib/tokenLogos';
import { formatUnits, walletChain } from '@/lib/wallet';
import type {
    WalletAccount,
    WalletChainId,
    WalletTokenBalance,
} from '@/lib/wallet';
import { usdValue } from '@/lib/wallet/format';
import { partnerMint, provenanceOf } from '@/lib/wallet/provenance';

/**
 * What a person holds, one asset a row, across every network — the list the
 * simple home shows and the one Send picks from.
 *
 * A row is a network's own coin or a token with a balance. Tokens nobody
 * prices and the registry doesn't know are almost always airdropped dust (and
 * sometimes bait named after a real coin), so they are left out unless asked
 * for, and counted, so a list that hides them can say how many it hid.
 */
export type HoldingTag = 'bridged' | 'wrapped' | 'partner' | 'unverified';

export type Holding = {
    key: string;
    chain: WalletChainId;
    /** Null for the network's own coin. */
    token: WalletTokenBalance | null;
    name: string;
    symbol: string;
    /** The balance at four decimals; `<0.0001` rather than a false zero. */
    amount: string;
    usd: number | null;
    logo?: string;
    tag: HoldingTag | null;
};

export type HoldingsInput = {
    accounts: Pick<WalletAccount, 'chain' | 'label' | 'symbol' | 'decimals'>[];
    /** Chain → the coin balance, null when it couldn't be read. */
    balances: Partial<Record<WalletChainId, bigint | null>>;
    tokens: Partial<Record<WalletChainId, WalletTokenBalance[]>>;
    /** Chain → the coin's USD price. */
    prices: Partial<Record<WalletChainId, number | null>>;
    /** Chain → lowercased contract → USD price. */
    tokenPrices: Partial<Record<WalletChainId, Record<string, number>>>;
};

export type HoldingsOptions = {
    /** Keep a network's coin at zero — Send offers it as a network to use. */
    emptyCoins?: boolean;
    /** Keep unpriced tokens the registry doesn't know, tagged unverified. */
    unverified?: boolean;
};

const shown = (balance: bigint, decimals: number): string => {
    const amount = formatUnits(balance, decimals, 4);

    return balance > 0n && amount === '0' ? '<0.0001' : amount;
};

export const holdings = (
    input: HoldingsInput,
    options: HoldingsOptions = {},
): { rows: Holding[]; hidden: number } => {
    const rows: Holding[] = [];
    let hidden = 0;

    for (const account of input.accounts) {
        const chainId = walletChain(account.chain).chainId;
        const balance = input.balances[account.chain] ?? null;

        if (
            (balance !== null && balance > 0n) ||
            (options.emptyCoins && balance !== null)
        ) {
            rows.push({
                key: account.chain,
                chain: account.chain,
                token: null,
                name: account.label,
                symbol: account.symbol,
                amount: shown(balance, account.decimals),
                usd: usdValue(
                    balance,
                    account.decimals,
                    input.prices[account.chain] ?? null,
                ),
                logo: logoForToken(chainId, null, account.symbol),
                tag: null,
            });
        }

        const quotes = input.tokenPrices[account.chain] ?? {};

        for (const token of input.tokens[account.chain] ?? []) {
            if (token.balance <= 0n) {
                continue;
            }

            const price = quotes[token.address.toLowerCase()] ?? null;
            const known = provenanceOf(chainId, token.address);
            // Solana and the Bitcoin family have no registry here: no claim
            // either way rather than calling every SPL token unverified.
            const unverified = !known && chainId !== undefined;

            if (price === null && !known && !options.unverified) {
                hidden += 1;

                continue;
            }

            rows.push({
                key: `${account.chain}:${token.address}`,
                chain: account.chain,
                token,
                name: token.name || token.symbol,
                symbol: token.symbol,
                amount: shown(token.balance, token.decimals),
                usd: usdValue(token.balance, token.decimals, price),
                logo: logoForToken(chainId, token.address, token.symbol),
                tag:
                    known?.kind === 'bridged' ||
                    known?.kind === 'wrapped' ||
                    known?.kind === 'partner'
                        ? known.kind
                        : chainId === undefined && partnerMint(token.address)
                          ? 'partner'
                          : unverified
                          ? 'unverified'
                          : null,
            });
        }
    }

    // Most valuable first; what has no price after everything that has one,
    // and unverified strangers last of all.
    const rank = (row: Holding): number =>
        row.tag === 'unverified' && row.usd === null ? -2 : (row.usd ?? -1);

    rows.sort((a, b) => rank(b) - rank(a));

    return { rows, hidden };
};

/** Case-insensitive match on ticker, name, network or contract address. */
export const matchesHolding = (row: Holding, query: string): boolean => {
    const needle = query.trim().toLowerCase();

    if (needle === '') {
        return true;
    }

    return [row.symbol, row.name, row.chain, row.token?.address ?? '']
        .join(' ')
        .toLowerCase()
        .includes(needle);
};
