import { Contract, getAddress, isAddress } from 'ethers';
import type { JsonRpcProvider, Signer } from 'ethers';
import { explorerFailure } from '@/lib/wallet/readError';

/**
 * ERC20 assets on an EVM network.
 *
 * A token is not a chain: it shares the account, the address and the gas coin
 * of the network it lives on, and only its balance and its transfer are its
 * own. So this file holds exactly those two things plus the metadata needed to
 * render an amount — and nothing here invents a decimals value, because a
 * six-decimal USDC displayed as eighteen is off by twelve orders of magnitude.
 *
 * Which tokens an address holds is answered by the chain's own keyless index
 * (Blockscout), the same source the history panel already uses. A chain without
 * one cannot enumerate, and says so rather than showing an empty list — the
 * user can still add a contract by hand, which reads the token directly.
 */

/** The five reads and the one write this wallet ever performs on a token. */
const ERC20_ABI = [
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    'function name() view returns (string)',
    'function totalSupply() view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
];

export type WalletTokenBalance = {
    /** Checksummed contract address — the token's identity on this chain. */
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    balance: bigint;
    /** Added by hand rather than found by the chain's index. */
    manual?: boolean;
};

const erc20 = (address: string, runner: JsonRpcProvider | Signer): Contract =>
    new Contract(address, ERC20_ABI, runner);

/**
 * Gas this wallet is willing to spend moving a token, and the number the fee
 * quote is built from.
 *
 * A plain OpenZeppelin transfer costs 35–55k; tokens with hooks, fees or
 * rebases cost more. Quoting a cap rather than an estimate is what lets the
 * signing sentence promise "up to" a number and keep that promise: the send
 * estimates for real and refuses if the true cost would exceed what was shown,
 * instead of quietly charging more.
 */
export const ERC20_TRANSFER_GAS_CAP = 120_000n;

/** Headroom over a live estimate, for the state drift between quote and mine. */
const GAS_MARGIN = [125n, 100n] as const;

/**
 * One token read straight from its contract: what it calls itself, how it
 * counts, and what this address holds of it.
 *
 * Used for tokens no index lists — a chain without Blockscout, or a token too
 * new to be indexed. Four calls, so it is deliberately not the bulk path.
 */
export const readErc20 = async (
    provider: JsonRpcProvider,
    contract: string,
    owner: string,
): Promise<WalletTokenBalance> => {
    if (!isAddress(contract)) {
        throw new Error('Not a contract address');
    }

    const token = erc20(contract, provider);

    const [symbol, name, decimals, balance] = await Promise.all([
        token.symbol() as Promise<string>,
        token.name() as Promise<string>,
        token.decimals() as Promise<bigint>,
        token.balanceOf(owner) as Promise<bigint>,
    ]);

    // A contract that answers `symbol()` and `decimals()` is an ERC20 as far as
    // a wallet can tell; anything that does not simply threw above.
    return {
        address: getAddress(contract),
        symbol: String(symbol).slice(0, 12),
        name: String(name).slice(0, 40),
        decimals: Number(decimals),
        balance,
        manual: true,
    };
};

/** Balance of one already-known token, for refreshing without re-reading metadata. */
export const erc20Balance = async (
    provider: JsonRpcProvider,
    contract: string,
    owner: string,
): Promise<bigint> =>
    (await erc20(contract, provider).balanceOf(owner)) as bigint;

/**
 * Everything in existence of one token.
 *
 * The denominator when what matters is a share of a supply rather than an
 * amount — the $LAIN holders' room is gated on one, and a share computed
 * against a stale hard-coded supply would let the wrong wallets in.
 */
export const erc20TotalSupply = async (
    provider: JsonRpcProvider,
    contract: string,
): Promise<bigint> => (await erc20(contract, provider).totalSupply()) as bigint;

/**
 * Move a token. Returns the transaction hash.
 *
 * `gasCap` is the number the user was shown and agreed to; a live estimate
 * above it means the transfer costs more than the sentence they read, so it is
 * refused rather than signed.
 */
export const sendErc20 = async (
    signer: Signer,
    contract: string,
    to: string,
    amount: bigint,
    gasPrice: bigint,
    gasCap = ERC20_TRANSFER_GAS_CAP,
): Promise<string> => {
    const token = erc20(contract, signer);
    let gasLimit = gasCap;

    try {
        const estimate = (await token.transfer.estimateGas(
            to,
            amount,
        )) as bigint;

        gasLimit = (estimate * GAS_MARGIN[0]) / GAS_MARGIN[1];
    } catch {
        // Some nodes answer eth_estimateGas unreliably. The cap is already the
        // figure the user approved, so falling back to it changes nothing they
        // were told — it only removes the estimate's opinion.
        gasLimit = gasCap;
    }

    if (gasLimit > gasCap) {
        throw new Error(
            'This transfer costs more gas than the fee you were shown. Nothing was signed.',
        );
    }

    const tx = await token.transfer(to, amount, { gasLimit, gasPrice });

    return tx.hash as string;
};

/* ------------------------------------------------------------ discovery -- */

type BlockscoutToken = {
    balance?: string;
    contractAddress?: string;
    decimals?: string;
    name?: string;
    symbol?: string;
    type?: string;
};

/**
 * Every ERC20 an address holds, from a Blockscout instance.
 *
 * One keyless request returns the contract, the symbol, the *decimals* and the
 * balance together, which is the whole reason to ask an index rather than a
 * curated list: a hard-coded decimals value is a display bug waiting for the
 * one token that disagrees, and on Cyberia USDC and USDT already do — they are
 * six-decimal, not eighteen.
 */
export const blockscoutTokens = async (
    apiUrl: string,
    address: string,
): Promise<WalletTokenBalance[]> => {
    const query = new URLSearchParams({
        module: 'account',
        action: 'tokenlist',
        address,
    });
    const response = await fetch(`${apiUrl}?${query}`);

    if (!response.ok) {
        throw explorerFailure(response.status);
    }

    const body = (await response.json()) as { result?: unknown };

    // "No tokens found" comes back as status 0 with an empty result — an empty
    // wallet, not a failure.
    if (!Array.isArray(body.result)) {
        return [];
    }

    return (body.result as BlockscoutToken[])
        .filter((token) => (token.type ?? 'ERC-20') === 'ERC-20')
        .flatMap((token) => {
            const contract = token.contractAddress ?? '';
            // Tested as a string before it is a number: `Number('')` is 0, not
            // NaN, so a missing decimals field would otherwise pass every
            // numeric check and render an 18-decimal balance a trillion times
            // too large.
            const raw = token.decimals ?? '';
            const decimals = /^\d{1,2}$/.test(raw) ? Number(raw) : -1;

            // A token whose decimals cannot be read cannot have its balance
            // rendered as a number, so it is dropped rather than guessed at.
            if (!isAddress(contract) || decimals < 0 || decimals > 36) {
                return [];
            }

            return [
                {
                    address: getAddress(contract),
                    symbol: (token.symbol || '???').slice(0, 12),
                    name: (token.name || '').slice(0, 40),
                    decimals,
                    balance: BigInt(token.balance ?? '0'),
                },
            ];
        });
};

/**
 * The same token written two ways.
 *
 * Case-insensitive on EVM, where the checksum is decoration over a hex string
 * and the same contract is routinely written three ways in one afternoon —
 * and exact everywhere else, because this is now also asked about Solana
 * mints, and base58 uses upper and lower case as *different characters*. A
 * lowercased mint is not a quieter spelling of an address; it is a different
 * address, or none.
 */
export const sameToken = (left: string, right: string): boolean =>
    left === right ||
    (left.startsWith('0x') &&
        right.startsWith('0x') &&
        left.toLowerCase() === right.toLowerCase());

/**
 * The index's tokens with the user's own on top, de-duplicated.
 *
 * A token added by hand stays listed even at zero balance — it was an explicit
 * act — while an indexed one at zero is noise the index happens to remember.
 */
export const mergeTokens = (
    indexed: readonly WalletTokenBalance[],
    manual: readonly WalletTokenBalance[],
): WalletTokenBalance[] => {
    const held = indexed.filter(
        (token) =>
            token.balance > 0n &&
            !manual.some((entry) => sameToken(entry.address, token.address)),
    );

    return [...manual, ...held].sort((a, b) =>
        a.symbol.localeCompare(b.symbol),
    );
};
