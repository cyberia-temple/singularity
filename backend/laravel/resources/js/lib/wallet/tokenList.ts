import { getAddress, isAddress } from 'ethers';
import type { WalletChainId } from '@/lib/wallet/chains';
import { sameToken } from '@/lib/wallet/erc20';

/**
 * Tokens the user added by contract address.
 *
 * Only the pair (chain, contract) is stored. Symbol, decimals and balance are
 * re-read from the contract on every unlock, so a token cannot go stale in
 * storage and a wrong decimals value cannot be persisted into a wrong-looking
 * balance. Nothing here is secret — a contract address is public — but it is
 * still a record of what someone holds, so it is cleared with the vault.
 *
 * An address here is not necessarily an EVM one. It was for as long as tokens
 * only existed on EVM chains in this wallet; a Solana mint is now equally a
 * token somebody types in, and it is base58 rather than hex — so the shape is
 * read off the string instead of assumed. Checksumming is applied to the one
 * kind of address that has a checksum, and every other kind is stored exactly
 * as it was given, because on those chains that is the only correct spelling.
 */

const STORAGE_KEY = 'cyberia.wallet.tokens.v1';

export type ManualToken = { chain: WalletChainId; address: string };

export const readManualTokens = (): ManualToken[] => {
    if (typeof window === 'undefined') {
        return [];
    }

    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];

        if (!Array.isArray(parsed)) {
            return [];
        }

        return (parsed as ManualToken[]).filter(
            (entry) =>
                typeof entry?.chain === 'string' &&
                isTokenAddress(entry?.address),
        );
    } catch {
        return [];
    }
};

export const writeManualTokens = (tokens: readonly ManualToken[]): void => {
    if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
    }
};

/**
 * Whether a string can be a token's address at all.
 *
 * Deliberately shape-based rather than asked of the chain registry: this runs
 * while storage is being read, which happens before user-added networks have
 * been registered, and a record thrown away for naming a network that is not
 * loaded *yet* is a token the user silently loses.
 */
const isTokenAddress = (address: unknown): address is string =>
    typeof address === 'string' &&
    (isAddress(address) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address));

/** As the chain writes it: checksummed on EVM, untouched everywhere else. */
export const canonicalTokenAddress = (address: string): string => {
    const trimmed = address.trim();

    return isAddress(trimmed) ? getAddress(trimmed) : trimmed;
};

/** The list with one token added, or unchanged when it is already on it. */
export const withToken = (
    tokens: readonly ManualToken[],
    chain: WalletChainId,
    address: string,
): ManualToken[] =>
    tokens.some(
        (entry) => entry.chain === chain && sameToken(entry.address, address),
    )
        ? [...tokens]
        : [...tokens, { chain, address: canonicalTokenAddress(address) }];

export const withoutToken = (
    tokens: readonly ManualToken[],
    chain: WalletChainId,
    address: string,
): ManualToken[] =>
    tokens.filter(
        (entry) => entry.chain !== chain || !sameToken(entry.address, address),
    );
