import {
    ComputeBudgetProgram,
    Connection,
    PublicKey,
    SystemProgram,
    Transaction,
} from '@solana/web3.js';
import {
    HDNodeWallet,
    JsonRpcProvider,
    SigningKey,
    Wallet,
    isAddress,
} from 'ethers';
import type { BaseWallet } from 'ethers';
import {
    CYBERIA_CHAIN_ID,
    EVM_CHAINS,
    cyberiaReadRpcUrl,
} from '@/lib/evmChains';
import { isValidMoneroAddress } from '@/lib/monero';
import { solanaRpcUrl } from '@/lib/solanaRpc';
import { fetchDexMarkets, marketFor } from '@/lib/wallet/dexscreener';
import type { DexMarket } from '@/lib/wallet/dexscreener';
import {
    ERC20_TRANSFER_GAS_CAP,
    blockscoutTokens,
    erc20TotalSupply,
    readErc20,
    sendErc20,
} from '@/lib/wallet/erc20';
import type { WalletTokenBalance } from '@/lib/wallet/erc20';
import {
    EVM_PATH,
    SOLANA_PATH,
    evmAddressFromKey,
    evmPath,
    evmSigner,
    solanaAddressFromKey,
    solanaKeypair,
    solanaPath,
} from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';
import { MONERO_PATH, moneroAccountAddress } from '@/lib/wallet/moneroKeys';
import { explorerFailure } from '@/lib/wallet/readError';
import {
    SPL_ACCOUNT_SPACE,
    asTokenBalance,
    readSplHoldings,
    readSplToken,
    splMintProgram,
    splTransferInstructions,
    withoutCollectibles,
} from '@/lib/wallet/spl';
import {
    buildP2wpkhTransaction,
    decodeWif,
    esploraBalance,
    esploraBroadcast,
    esploraConfirmed,
    esploraFeeRates,
    esploraHistory,
    esploraUtxos,
    isValidUtxoAddress,
    p2wpkhVsize,
    publicKeyBytes,
    selectCoins,
    utxoAddress,
    utxoOutputScript,
    utxoPath,
} from '@/lib/wallet/utxo';
import type { UtxoNetwork } from '@/lib/wallet/utxo';

/**
 * Chain adapters of the unified HD wallet.
 *
 * One BIP-39 seed feeds every chain here; each adapter owns the part that is
 * genuinely chain-specific — derivation path, curve, address format, and what
 * the chain can actually do from a browser. Adding a chain means adding one
 * entry to SHIPPED_CHAINS, nothing else: the composable and the page render
 * whatever the registry declares.
 *
 * Secrets never escape an adapter. `derive()` hands back an address and
 * `send()` builds its signer from the seed and drops it; no function here
 * returns a private key to its caller, and none of them log.
 */

export type WalletBuiltinChainId =
    | 'cyberia'
    | 'robinhood'
    | 'bnb'
    | 'base'
    | 'solana'
    | 'monero'
    | 'bitcoin'
    | 'litecoin';

/**
 * A network's id. The shipped ones are known at build time; a network the
 * user adds gets an id derived from what they typed, so the type stays open —
 * `(string & {})` keeps the literals in autocomplete without closing the set.
 */
export type WalletChainId = WalletBuiltinChainId | (string & {});

/**
 * Which key an address belongs to. Every `evm` chain derives the *same*
 * address from the one seed, so the family — not the chain — is what a user is
 * actually looking at when they compare two addresses.
 */
export type WalletChainFamily = 'evm' | 'solana' | 'monero' | 'utxo';

/**
 * How the portfolio groups networks. Chains that share an address belong
 * together; everything else is grouped by what the account model actually is,
 * because "why do these two show the same address" is the question the grouping
 * exists to answer.
 */
export const WALLET_FAMILY_GROUPS: readonly {
    id: 'evm' | 'other' | 'utxo';
    families: readonly WalletChainFamily[];
}[] = [
    { id: 'evm', families: ['evm'] },
    { id: 'other', families: ['solana', 'monero'] },
    { id: 'utxo', families: ['utxo'] },
];

export type WalletMarkShape = 'square' | 'circle' | 'diamond' | 'rounded';

/**
 * The identity of a network on screen: a hue, a shape and two letters, all
 * three carrying the same information. Colour alone collapses for a colour-blind
 * reader and would collide with the amber/green/red that transaction status
 * owns, so the shape is load-bearing rather than decorative.
 */
export type WalletMark = {
    tag: string;
    /** Always a CSS custom property, so the palette lives in `wallet.css`. */
    hue: string;
    shape: WalletMarkShape;
    /** User-added networks are drawn dashed: nothing verified their endpoint. */
    unverified?: boolean;
};

export type WalletCapabilities = {
    /** The browser can read this chain's balance without extra infrastructure. */
    balance: boolean;
    /** A public explorer can show this address's history. */
    history: boolean;
    /** The wallet can build, sign and broadcast a payment. */
    send: boolean;
};

/**
 * How hard a payment bids for inclusion. The tiers are relative to whatever the
 * network is charging right now — none of them is a fixed price, and none of
 * them promises a confirmation time.
 */
export type WalletFeeTier = 'slow' | 'normal' | 'fast';

export const WALLET_FEE_TIERS: readonly WalletFeeTier[] = [
    'slow',
    'normal',
    'fast',
];

/**
 * How a fee was arrived at, as something a dictionary can translate.
 *
 * It used to be a finished English sentence — `network price × 1.25` — built
 * where the quote was, which meant the send form printed English under a
 * Russian interface for every chain in the wallet. A key and its numbers are
 * the same information without the language baked in.
 */
export type WalletFeeBasis = {
    /** Key in `walletMessages`. */
    key: string;
    params?: Record<string, string | number>;
};

export type WalletFeeQuote = {
    tier: WalletFeeTier;
    /** Worst-case cost of the transfer, in the chain's smallest unit. */
    fee: bigint;
    /** What the tier does to the live network price. */
    basis: WalletFeeBasis;
};

export type WalletTxStatus = 'confirmed' | 'pending' | 'failed';

export type WalletTx = {
    hash: string;
    /** Direction as seen from the wallet's own address. */
    direction: 'in' | 'out';
    /** Signed smallest-unit change to this address, sign already applied. */
    amount: bigint;
    /** Unix seconds, or null when the source does not report one. */
    timestamp: number | null;
    status: WalletTxStatus;
    /** The other side of the transfer, when the source identifies one. */
    counterparty: string | null;
    /** Short provenance line — block height, slot, revert reason. */
    meta: string | null;
};

export type WalletChain = {
    id: WalletChainId;
    label: string;
    symbol: string;
    decimals: number;
    /** EVM chain id, for the networks that have one. */
    chainId?: number;
    family: WalletChainFamily;
    mark: WalletMark;
    /**
     * Added by the user rather than shipped with the wallet. The account is as
     * real as any other — it comes from the same seed — but nobody vetted the
     * endpoint it is read through, and the UI has to say so.
     */
    custom?: boolean;
    /**
     * The host this network is actually read through.
     *
     * On a user-added network it is what the row that offers to remove it
     * forgets. On a shipped one it is there for the routing screen, which
     * cannot honestly say what carries a request without naming it — and the
     * answer differs per family: an EVM chain talks to an RPC, Solana talks to
     * this site's own relay, and Monero talks to nobody at all.
     */
    endpoint?: string;
    /**
     * BIP-44/SLIP-0010 path of one account, shown in the UI so the wallet is
     * restorable elsewhere. A function rather than a string because the account
     * number lands in a different segment on every chain — the address segment
     * on EVM, the account segment on Solana and Bitcoin, and nowhere at all on
     * Monero, which numbers subaddresses instead.
     */
    path: (index: number) => string;
    /** Curve the path is walked on — secp256k1 (BIP-32) or ed25519 (SLIP-0010). */
    curve: 'secp256k1' | 'ed25519';
    capabilities: WalletCapabilities;
    /** Why a capability is missing, when one is. */
    note?: string;
    /** Message key explaining why there is no in-app history, when there is none. */
    historyNote?: string;
    derive: (source: WalletKeySource) => string;
    /**
     * The address an imported private key controls, or a throw explaining why
     * the string is not one of this chain's keys.
     *
     * Absent on a chain this wallet cannot spend from anyway: accepting a
     * Monero spend key here would store a live secret in exchange for an
     * address the seed already produces.
     */
    importKey?: (secret: string) => string;
    isValidAddress: (address: string) => boolean;
    /**
     * The shape of an address on this chain, as a literal example — `0x…`,
     * `bc1…`, a base58 run. Not translated, because a prefix is a prefix in
     * every language, and shown as the recipient field's placeholder: the
     * network chip above it names the network, and the field is where somebody
     * finds out they pasted a Bitcoin address into an EVM form.
     */
    addressHint: string;
    explorerAddressUrl: (address: string) => string | null;
    explorerTxUrl: (hash: string) => string | null;
    /** Smallest-unit balance, or null when the chain cannot be read here. */
    fetchBalance?: (address: string, rpcUrl?: string) => Promise<bigint>;
    /**
     * Every token this address holds, from the chain's own keyless index.
     *
     * Absent on a chain with no such index. That is not "this address holds no
     * tokens" and the UI must not render it as such — it is "nobody here can
     * enumerate them", which is why `tokensNote` exists next to it.
     */
    fetchTokens?: (
        address: string,
        rpcUrl?: string,
    ) => Promise<WalletTokenBalance[]>;
    /** One token read straight from its contract, for what no index lists. */
    readToken?: (
        contract: string,
        owner: string,
        rpcUrl?: string,
    ) => Promise<WalletTokenBalance>;
    /**
     * Everything in existence of one token, for a gate that counts a share of
     * a supply rather than an amount.
     */
    readTokenSupply?: (contract: string, rpcUrl?: string) => Promise<bigint>;
    /** Message key explaining why tokens cannot be listed automatically. */
    tokensNote?: string;
    /**
     * Live cost of one transfer at each tier, cheapest first.
     *
     * The address is part of the question, not decoration: on a UTXO chain the
     * fee depends on how many coins have to be spent, so a quote that ignored
     * the wallet's own outputs would be wrong by whatever the coin selection
     * turns out to need.
     */
    fetchFees?: (context: {
        address: string;
        rpcUrl?: string;
        /**
         * Contract of the token being moved, or null for the native coin.
         * A token transfer is a contract call and costs several times what
         * moving the coin itself does, so the quote has to know which it is.
         */
        token?: string | null;
        /**
         * Whether the recipient has code. Paying a contract is a contract call
         * too — its `receive()` runs on the sender's gas — so the coin costs
         * several times what it costs to pay a plain address, and a quote that
         * ignored this would promise a fee that cannot complete the transfer.
         */
        toContract?: boolean;
    }) => Promise<WalletFeeQuote[]>;
    /**
     * Whether an address is a contract. EVM only, and only where a quote or a
     * gas limit turns on the answer.
     */
    hasCode?: (address: string, rpcUrl?: string) => Promise<boolean>;
    /**
     * Live price of one unit of gas at a tier, with the network's floor
     * already applied.
     *
     * Only the chains that price a transaction that way have one, and it
     * exists so that a caller building something other than a transfer — a
     * swap, a wrap, a mint — prices it against the same number a send does.
     * Cyberia's node rejects anything under its pool floor outright, and that
     * floor lives here rather than in every screen that signs.
     */
    gasPrice?: (tier: WalletFeeTier, rpcUrl?: string) => Promise<bigint>;
    /** Most recent transfers touching this address, newest first. */
    fetchHistory?: (address: string, rpcUrl?: string) => Promise<WalletTx[]>;
    /**
     * Waits for a broadcast transaction to settle. Resolves to how it ended,
     * or rejects when the wait itself times out — which says nothing about the
     * transaction, only about the watching.
     */
    awaitOutcome?: (
        hash: string,
        rpcUrl?: string,
    ) => Promise<'confirmed' | 'failed'>;
    /**
     * Signs a plain-text challenge with this chain's key and resolves to the
     * signature — EIP-191 personal-sign on EVM.
     *
     * The only thing in this wallet that uses a key without spending anything:
     * it proves to a server that the browser holds the key behind an address,
     * which is how the $LAIN holders' room can be gated without an account.
     */
    signMessage?: (source: WalletKeySource, message: string) => Promise<string>;
    /**
     * Broadcasts a payment and resolves to the transaction hash.
     *
     * `token` names an ERC20-style contract to move instead of the native coin;
     * `amount` is then in that token's units, not the chain's.
     */
    send?: (
        source: WalletKeySource,
        request: {
            to: string;
            amount: bigint;
            tier: WalletFeeTier;
            rpcUrl?: string;
            token?: string | null;
            /**
             * The decimals `amount` was counted in, when a token is being
             * moved.
             *
             * Not decoration and not a duplicate of what the chain knows: this
             * is the scale the *user's* figure was multiplied by, and handing
             * it to a program that checks it against the mint is what turns a
             * wallet holding a stale decimals value into a transaction that
             * does not land, rather than a transfer of a thousand times the
             * wrong amount.
             */
            decimals?: number;
        },
    ) => Promise<string>;
};

export { EVM_PATH, MONERO_PATH, SOLANA_PATH };

const CYBERIA_EXPLORER = 'https://explorer.cyberia.church';

const SOLANA_EXPLORER = 'https://solscan.io';

/** A plain native transfer to an address that is only an address. */
const EVM_TRANSFER_GAS = 21_000n;

/**
 * Ceiling for a native transfer whose recipient turns out to be a contract.
 *
 * 21000 is the entire cost of paying a plain address and the entire cost of
 * nothing else. A contract's `receive()` runs *after* those 21000 are already
 * spent, so a coin sent to a contract with a 21000 limit does not underpay —
 * it runs out of gas, reverts, and burns the whole fee for nothing. This is
 * the same promise `ERC20_TRANSFER_GAS_CAP` makes: the figure quoted is the
 * figure that will not be exceeded, and an estimate above it is refused rather
 * than signed for more than the sentence said.
 */
export const EVM_CONTRACT_SEND_GAS_CAP = 120_000n;

/**
 * Gas for one native transfer, given what the recipient turned out to be.
 *
 * Stated, never estimated, and that is not caution — it is this chain being
 * measured. Cyberia's node answers `eth_estimateGas` for a value transfer with
 * empty calldata by returning 21000 whether or not the recipient has code: it
 * prices the transaction without running the `receive()` that transaction will
 * run. A wallet that believes that answer signs a transfer which reverts out
 * of gas and keeps the fee, which is exactly how the first payment into the
 * gas station was lost. So the recipient is *read* — code or no code — and a
 * contract is paid at the cap, which is also the figure its quote promised.
 *
 * Unused gas is refunded, so the cost of being generous here is zero; the cost
 * of being tight is a failed transfer that still charges for failing.
 */
export const nativeSendGas = (
    recipientIsContract: boolean,
    cap = EVM_CONTRACT_SEND_GAS_CAP,
): bigint => (recipientIsContract ? cap : EVM_TRANSFER_GAS);

/** Numerator/denominator per tier — a multiplier on the live network price. */
const EVM_TIER_MULTIPLIER: Record<WalletFeeTier, [bigint, bigint]> = {
    slow: [1n, 1n],
    normal: [5n, 4n],
    fast: [8n, 5n],
};

/**
 * How an EVM tier's price was arrived at. Exported because a user-added
 * network prices a transfer exactly the same way, and the two used to build
 * the same sentence twice — in English, in two files.
 */
export const evmFeeBasis = (
    tier: WalletFeeTier,
    gas: bigint | null,
): WalletFeeBasis => {
    const [numerator, denominator] = EVM_TIER_MULTIPLIER[tier];
    const mult = Number(numerator) / Number(denominator);

    return gas === null
        ? { key: 'feeBasisEvm', params: { mult } }
        : { key: 'feeBasisEvmGas', params: { mult, gas: gas.toString() } };
};

/**
 * Recent transfers from a Blockscout instance. Only value-bearing transfers
 * are kept: contract calls belong in the explorer, not in a list whose whole
 * job is "where did my coins go".
 *
 * Etherscan-family explorers speak the same query but now require an API key,
 * so chains behind one simply declare no history source and say so in the UI
 * rather than shipping a key or rendering an empty list as "nothing happened".
 */
const blockscoutHistory = async (
    apiUrl: string,
    address: string,
): Promise<WalletTx[]> => {
    const query = new URLSearchParams({
        module: 'account',
        action: 'txlist',
        address,
        page: '1',
        offset: '20',
        sort: 'desc',
    });
    const response = await fetch(`${apiUrl}?${query}`);

    if (!response.ok) {
        throw explorerFailure(response.status);
    }

    const body = (await response.json()) as {
        status?: string;
        result?: unknown;
    };

    // Blockscout answers "no transactions found" with status 0 and an empty
    // result — an empty history, not a failure.
    if (!Array.isArray(body.result)) {
        return [];
    }

    const mine = address.toLowerCase();

    return (body.result as Record<string, string>[])
        .filter((tx) => tx.value && tx.value !== '0')
        .map((tx) => {
            const outgoing = (tx.from ?? '').toLowerCase() === mine;
            const value = BigInt(tx.value);
            const reverted = tx.isError === '1' || tx.txreceipt_status === '0';

            return {
                hash: tx.hash,
                direction: outgoing ? 'out' : 'in',
                amount: outgoing ? -value : value,
                timestamp: tx.timeStamp ? Number(tx.timeStamp) : null,
                status: reverted ? 'failed' : 'confirmed',
                counterparty: outgoing ? (tx.to ?? null) : (tx.from ?? null),
                meta: tx.blockNumber ? `block ${tx.blockNumber}` : null,
            } satisfies WalletTx;
        });
};

export type EvmSpec = {
    id: WalletChainId;
    /** Entry in the shared EVM registry this chain's parameters come from. */
    chainId: number;
    label: string;
    mark: WalletMark;
    /**
     * Parameters for a chain that is not in `lib/evmChains.ts`.
     *
     * That registry is the handful of networks the *site* switches a browser
     * wallet to — bridge, launchpad, login — and it is short on purpose. The
     * catalogue behind the wallet's network list is two orders of magnitude
     * longer and belongs to the wallet alone, so those entries carry their own
     * parameters here instead of being pushed into a picker they do not belong
     * in. Both kinds are equally shipped, equally vetted, and equally not
     * `custom` — see `lib/wallet/catalogue.ts`.
     */
    params?: {
        symbol: string;
        decimals: number;
        rpcUrl: string;
        explorer: string | null;
    };
    /** Blockscout API root, for the chains that have a keyless one. */
    blockscoutApi?: string;
    /**
     * Pool floor for the gas price. Bidding under a node's floor gets the
     * transaction rejected rather than merely delayed, so it is a floor and
     * not a preference. Only Cyberia publishes one.
     */
    minGasPrice?: bigint;
    note?: string;
    /** Message key explaining why there is no in-app history, when there is none. */
    historyNote?: string;
};

/**
 * One EVM network as a wallet chain.
 *
 * Every EVM chain here derives the *same* address from the one seed — that is
 * the point of BIP-44 coin type 60, and why the wallet shows one card per
 * network rather than one per key. What actually differs is the RPC, the
 * explorer, the gas price and what the native coin is worth.
 */
export const evmChain = (spec: EvmSpec): WalletChain => {
    const registry = EVM_CHAINS.find(
        (candidate) => candidate.chainId === spec.chainId,
    );

    if (!registry && !spec.params) {
        throw new Error(`Chain ${spec.chainId} is not in the EVM registry`);
    }

    const symbol = registry?.nativeCurrency.symbol ?? spec.params!.symbol;
    const decimals = registry?.nativeCurrency.decimals ?? spec.params!.decimals;
    const explorer =
        registry?.blockExplorerUrls?.[0] ?? spec.params?.explorer ?? null;
    const defaultRpc =
        spec.id === 'cyberia'
            ? cyberiaReadRpcUrl()
            : (registry?.rpcUrls[0] ?? spec.params!.rpcUrl);

    const provider = (rpcUrl?: string): JsonRpcProvider =>
        new JsonRpcProvider(rpcUrl || defaultRpc, {
            chainId: spec.chainId,
            name: spec.id,
        });

    /**
     * Does anything live at this address?
     *
     * Cheap, and the answer decides both the quote and the gas limit, so it is
     * asked rather than assumed. A read that fails is answered "yes": paying a
     * plain address at the contract limit costs the sender nothing (the excess
     * is refunded), while paying a contract at 21000 loses the fee outright.
     */
    const hasCode = async (
        address: string,
        rpcUrl?: string,
    ): Promise<boolean> => {
        try {
            const code = await provider(rpcUrl).getCode(address);

            return code !== '0x' && code !== '0x0';
        } catch {
            return true;
        }
    };

    const gasPrice = async (
        tier: WalletFeeTier,
        rpcUrl?: string,
    ): Promise<bigint> => {
        const feeData = await provider(rpcUrl).getFeeData();
        const floor = spec.minGasPrice ?? 0n;
        const base =
            feeData.gasPrice && feeData.gasPrice > floor
                ? feeData.gasPrice
                : floor;

        if (base === 0n) {
            throw new Error('The network did not report a gas price');
        }

        const [numerator, denominator] = EVM_TIER_MULTIPLIER[tier];

        return (base * numerator) / denominator;
    };

    return {
        id: spec.id,
        label: spec.label,
        symbol,
        decimals,
        chainId: spec.chainId,
        family: 'evm',
        mark: spec.mark,
        endpoint: defaultRpc,
        path: evmPath,
        curve: 'secp256k1',
        capabilities: {
            balance: true,
            history: explorer !== null,
            send: true,
        },
        note: spec.note,
        historyNote: spec.historyNote,
        derive: (source) => evmSigner(source).address,
        importKey: evmAddressFromKey,
        isValidAddress: (address) => isAddress(address),
        addressHint: '0x…',
        explorerAddressUrl: (address) =>
            explorer ? `${explorer}/address/${address}` : null,
        explorerTxUrl: (hash) => (explorer ? `${explorer}/tx/${hash}` : null),
        fetchBalance: async (address, rpcUrl) =>
            provider(rpcUrl).getBalance(address),
        fetchTokens: spec.blockscoutApi
            ? (address) => blockscoutTokens(spec.blockscoutApi!, address)
            : undefined,
        tokensNote: spec.blockscoutApi ? undefined : 'tokensNoIndexer',
        readToken: (contract, owner, rpcUrl) =>
            readErc20(provider(rpcUrl), contract, owner),
        readTokenSupply: (contract, rpcUrl) =>
            erc20TotalSupply(provider(rpcUrl), contract),
        signMessage: (source, message) =>
            evmSigner(source).signMessage(message),
        fetchFees: async ({ rpcUrl, token, toContract }) => {
            // Moving a token is a contract call, not a transfer: it costs
            // several times the 21000 the coin itself does, and how much more
            // depends on the token's own code. Paying a *contract* in the coin
            // is a contract call for the same reason — the code at the other
            // end runs on this transaction's gas.
            const gas = token
                ? ERC20_TRANSFER_GAS_CAP
                : toContract
                  ? EVM_CONTRACT_SEND_GAS_CAP
                  : EVM_TRANSFER_GAS;

            return Promise.all(
                WALLET_FEE_TIERS.map(async (tier) => ({
                    tier,
                    fee: (await gasPrice(tier, rpcUrl)) * gas,
                    basis: evmFeeBasis(tier, token || toContract ? gas : null),
                })),
            );
        },
        gasPrice: (tier, rpcUrl) => gasPrice(tier, rpcUrl),
        hasCode: (address, rpcUrl) => hasCode(address, rpcUrl),
        fetchHistory: spec.blockscoutApi
            ? (address) => blockscoutHistory(spec.blockscoutApi!, address)
            : undefined,
        awaitOutcome: async (hash, rpcUrl) => {
            const receipt = await provider(rpcUrl).waitForTransaction(
                hash,
                1,
                120_000,
            );

            if (receipt === null) {
                throw new Error('Timed out waiting for a receipt');
            }

            return receipt.status === 1 ? 'confirmed' : 'failed';
        },
        /*
         * `decimals` travels with a token amount and is deliberately not read
         * here: an ERC-20 `transfer` takes a raw integer and offers nothing to
         * check a scale against. Solana's token program does, and uses it.
         */
        send: async (source, { to, amount, tier, rpcUrl, token }) => {
            const signer = evmSigner(source).connect(provider(rpcUrl));
            const price = await gasPrice(tier, rpcUrl);

            if (token) {
                return sendErc20(signer, token, to, amount, price);
            }

            // Gas is stated rather than estimated: these nodes answer
            // eth_estimateGas for a value transfer by pricing it as if the
            // recipient were a plain address, even when it is a contract whose
            // `receive()` this transaction will run. So what the recipient *is*
            // decides the limit, and that is read rather than guessed.
            const tx = await signer.sendTransaction({
                to,
                value: amount,
                gasLimit: nativeSendGas(await hasCode(to, rpcUrl)),
                gasPrice: price,
            });

            return tx.hash;
        },
    };
};

/**
 * The page is handed an endpoint by Laravel; this is what it falls back to
 * when it is not. Solana's public cluster is not that fallback any more — it
 * answers `403 Access forbidden` to anything carrying a browser `Origin` — so
 * both roads now end at this app's relay. See `@/lib/solanaRpc`.
 */
const solanaConnection = (rpcUrl?: string): Connection =>
    new Connection(rpcUrl || solanaRpcUrl(), 'confirmed');

/** One signature, at the protocol's fixed per-signature price. */
const SOLANA_BASE_FEE = 5_000n;

/**
 * Compute budget requested for a transfer. A system transfer plus the two
 * compute-budget instructions costs well under this; asking for a small,
 * honest limit is what keeps the priority fee small in absolute terms, since
 * the network charges per compute unit.
 */
const SOLANA_COMPUTE_UNITS = 1_000n;

/** Fallback micro-lamports per compute unit when the RPC reports no history. */
const SOLANA_FALLBACK_PRICE: Record<WalletFeeTier, bigint> = {
    slow: 0n,
    normal: 7_000_000n,
    fast: 30_000_000n,
};

const percentile = (sorted: bigint[], fraction: number): bigint =>
    sorted.length === 0
        ? 0n
        : sorted[
              Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
          ];

/**
 * Priority price per tier, taken from what recent blocks actually paid. The
 * RPC reports one prioritization fee per recent slot; the tiers are the low,
 * middle and upper end of that window rather than invented constants.
 */
const solanaPriorityPrices = async (
    rpcUrl?: string,
): Promise<Record<WalletFeeTier, bigint>> => {
    try {
        const recent =
            await solanaConnection(rpcUrl).getRecentPrioritizationFees();
        const fees = recent
            .map((entry) => BigInt(entry.prioritizationFee))
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

        if (fees.length === 0 || fees[fees.length - 1] === 0n) {
            return SOLANA_FALLBACK_PRICE;
        }

        return {
            slow: percentile(fees, 0.25),
            normal: percentile(fees, 0.6),
            fast: percentile(fees, 0.9),
        };
    } catch {
        return SOLANA_FALLBACK_PRICE;
    }
};

/** Total lamports a transfer costs at a given micro-lamport unit price. */
const solanaFee = (unitPrice: bigint): bigint =>
    SOLANA_BASE_FEE +
    (SOLANA_COMPUTE_UNITS * unitPrice + 999_999n) / 1_000_000n;

/**
 * Recent transfers, read as the net lamport change of our own account in each
 * transaction. Deriving the amount from pre/post balances rather than from the
 * instruction list means a transfer still shows up correctly when it arrives
 * inside a program call this wallet knows nothing about.
 */
/**
 * What the pools call a set of mints.
 *
 * Solana keeps a token's name beside its mint rather than in it, so this is
 * the one piece of a Solana token the chain itself will not answer for. The
 * pool index answers instead — and when it cannot, the caller falls back to
 * the mint, which is at least the string the user was given.
 *
 * Never allowed to fail the list: a balance came from the chain and stands on
 * its own, and a token drawn as its own address is worse to read but not less
 * true than one drawn with a symbol.
 */
const solanaNames = async (mints: readonly string[]): Promise<DexMarket[]> => {
    try {
        return await fetchDexMarkets('solana', mints);
    } catch {
        return [];
    }
};

const solanaHistory = async (
    address: string,
    rpcUrl?: string,
): Promise<WalletTx[]> => {
    const connection = solanaConnection(rpcUrl);
    const owner = new PublicKey(address);
    const signatures = await connection.getSignaturesForAddress(owner, {
        limit: 10,
    });

    if (signatures.length === 0) {
        return [];
    }

    const parsed = await connection.getParsedTransactions(
        signatures.map((signature) => signature.signature),
        { maxSupportedTransactionVersion: 0 },
    );

    return signatures
        .map((signature, index) => {
            const transaction = parsed[index];
            const keys = transaction?.transaction.message.accountKeys ?? [];
            const position = keys.findIndex((key) => key.pubkey.equals(owner));
            const pre = transaction?.meta?.preBalances?.[position];
            const post = transaction?.meta?.postBalances?.[position];
            const delta =
                position >= 0 && pre !== undefined && post !== undefined
                    ? BigInt(post) - BigInt(pre)
                    : 0n;
            const counterparty = keys.find(
                (key) => key.signer && !key.pubkey.equals(owner),
            );

            return {
                hash: signature.signature,
                direction: delta < 0n ? 'out' : 'in',
                amount: delta,
                timestamp: signature.blockTime ?? null,
                status: signature.err
                    ? 'failed'
                    : signature.confirmationStatus === 'finalized' ||
                        signature.confirmationStatus === 'confirmed'
                      ? 'confirmed'
                      : 'pending',
                counterparty: counterparty?.pubkey.toBase58() ?? null,
                meta: `slot ${signature.slot}`,
            } satisfies WalletTx;
        })
        .filter((tx) => tx.amount !== 0n);
};

/**
 * One Bitcoin-family chain as a wallet chain.
 *
 * Everything a UTXO chain needs is in `lib/wallet/utxo.ts`; this only binds it
 * to an endpoint. The endpoint has to be an Esplora-compatible HTTPS API —
 * a browser cannot open the TCP connection an Electrum server expects, so the
 * usual `host:50002` of a desktop wallet is not an option here.
 */
const utxoChain = (spec: {
    id: WalletChainId;
    label: string;
    symbol: string;
    network: UtxoNetwork;
    mark: WalletMark;
    custom?: boolean;
}): WalletChain => {
    const { network } = spec;
    const path = (index: number): string => utxoPath(network, index);
    const node = (source: WalletKeySource): BaseWallet =>
        source.kind === 'seed'
            ? HDNodeWallet.fromSeed(source.seed).derivePath(path(source.index))
            : new Wallet(decodeWif(network, source.secret));
    const api = network.api;
    // Only P2WPKH is signed here; a legacy or P2SH account is real and
    // receivable but needs the pre-segwit sighash, which this wallet does not
    // implement rather than half-implements.
    const signable = network.addressType === 'bech32';

    return {
        id: spec.id,
        label: spec.label,
        symbol: spec.symbol,
        decimals: 8,
        family: 'utxo',
        mark: spec.mark,
        custom: spec.custom,
        endpoint: api ?? undefined,
        path,
        curve: 'secp256k1',
        capabilities: {
            balance: api !== null,
            history: api !== null,
            send: api !== null && signable,
        },
        note: signable
            ? undefined
            : 'Receive-only here: spending a legacy or P2SH account needs the pre-segwit sighash, which this wallet does not implement. The same phrase restores it in a full wallet.',
        historyNote: api === null ? 'historyNoEndpoint' : undefined,
        derive: (source) => utxoAddress(network, node(source)),
        importKey: (secret) =>
            utxoAddress(network, new Wallet(decodeWif(network, secret))),
        isValidAddress: (address) => isValidUtxoAddress(network, address),
        // The prefix the chain's own bech32 accounts carry, when it has one;
        // a legacy account has no prefix to promise, only a length.
        addressHint: network.hrp === null ? '1… / 3…' : `${network.hrp}1…`,
        explorerAddressUrl: (address) =>
            network.explorer ? `${network.explorer}/address/${address}` : null,
        explorerTxUrl: (hash) =>
            network.explorer ? `${network.explorer}/tx/${hash}` : null,
        fetchBalance:
            api === null
                ? undefined
                : (address) => esploraBalance(api, address),
        fetchHistory:
            api === null
                ? undefined
                : (address) => esploraHistory(api, address),
        fetchFees:
            api === null
                ? undefined
                : async ({ address }) => {
                      const [rates, utxos] = await Promise.all([
                          esploraFeeRates(api),
                          esploraUtxos(api, address),
                      ]);
                      // Worst case is a sweep: every coin the address holds
                      // becomes an input, and each input is ~68 more vbytes to
                      // pay for. Quoting for one input would understate the fee
                      // of exactly the transfer people make most — "send it all".
                      const vsize = p2wpkhVsize(Math.max(1, utxos.length), 2);

                      return WALLET_FEE_TIERS.map((tier) => ({
                          tier,
                          fee: BigInt(vsize) * BigInt(rates[tier]),
                          basis: {
                              key: 'feeBasisUtxo',
                              params: { rate: rates[tier], vsize },
                          },
                      }));
                  },
        awaitOutcome:
            api === null
                ? undefined
                : async (hash) => {
                      const deadline = Date.now() + 120_000;

                      while (Date.now() < deadline) {
                          if (await esploraConfirmed(api, hash)) {
                              return 'confirmed';
                          }

                          await new Promise((resolve) =>
                              setTimeout(resolve, 15_000),
                          );
                      }

                      // A UTXO transfer that is not mined yet has not failed —
                      // it is simply still in the mempool, and saying otherwise
                      // would invite a second, double-spending attempt.
                      throw new Error('Still unconfirmed');
                  },
        send:
            api === null || !signable
                ? undefined
                : async (source, { to, amount, tier }) => {
                      const wallet = node(source);
                      const own = utxoAddress(network, wallet);
                      const script = utxoOutputScript(network, to);

                      if (script === null) {
                          throw new Error(`Not a valid ${spec.label} address`);
                      }

                      const [utxos, rates] = await Promise.all([
                          esploraUtxos(api, own),
                          esploraFeeRates(api),
                      ]);
                      const selection = selectCoins(utxos, amount, rates[tier]);

                      const outputs = [{ script, value: amount }];
                      const ownScript = utxoOutputScript(network, own);

                      if (selection.change > 0n && ownScript !== null) {
                          outputs.push({
                              // Change returns to the same address this wallet
                              // shows: one address per chain is the whole
                              // premise, and a fresh change address would be a
                              // balance the user cannot find on paper.
                              script: ownScript,
                              value: selection.change,
                          });
                      }

                      return esploraBroadcast(
                          api,
                          buildP2wpkhTransaction(
                              new SigningKey(wallet.privateKey),
                              publicKeyBytes(wallet),
                              selection.inputs,
                              outputs,
                          ),
                      );
                  },
    };
};

/** Bitcoin mainnet parameters — the reference every fork below varies from. */
const BITCOIN_NETWORK: Omit<UtxoNetwork, 'coinType' | 'api' | 'explorer'> = {
    hrp: 'bc',
    p2pkhVersion: 0x00,
    p2shVersion: 0x05,
    addressType: 'bech32',
};

/** The networks that ship with the wallet, in the order the portfolio lists them. */
/**
 * The networks this wallet ships knowing about and switched on.
 *
 * "Shipped on" is a default and not a rank. Every network here is made by the
 * same factories, read through the same adapters and drawn by the same rules as
 * the hundred and twenty in the catalogue; the only thing this list decides is
 * which ones a wallet has on its first day, and that decision is about how many
 * balances a refresh should read, not about which chains matter.
 *
 * Cyberia is the exception, and the only one: it is the chain this wallet is
 * for, so it has no switch.
 */
const SHIPPED_CHAINS: readonly WalletChain[] = [
    evmChain({
        id: 'cyberia',
        chainId: CYBERIA_CHAIN_ID,
        label: 'Cyberia',
        mark: { tag: 'CY', hue: 'var(--cw-net-cyberia)', shape: 'square' },
        blockscoutApi: `${CYBERIA_EXPLORER}/api`,
        // The node rejects anything under its pool floor outright.
        minGasPrice: 1_500_000_000n,
        note: 'One address for every EVM network below — same key, same string.',
    }),
    evmChain({
        id: 'robinhood',
        chainId: 4663,
        label: 'Robinhood',
        mark: { tag: 'RH', hue: 'var(--cw-net-robinhood)', shape: 'square' },
        blockscoutApi: 'https://robinhoodchain.blockscout.com/api',
    }),
    evmChain({
        id: 'bnb',
        chainId: 56,
        label: 'BNB Chain',
        mark: { tag: 'BN', hue: 'var(--cw-net-bnb)', shape: 'square' },
        historyNote: 'historyNoIndexer',
    }),
    evmChain({
        id: 'base',
        chainId: 8453,
        label: 'Base',
        mark: { tag: 'BA', hue: 'var(--cw-net-base)', shape: 'square' },
        historyNote: 'historyNoIndexer',
    }),
    {
        id: 'solana',
        label: 'Solana',
        symbol: 'SOL',
        decimals: 9,
        family: 'solana',
        mark: { tag: 'SO', hue: 'var(--cw-net-solana)', shape: 'circle' },
        // Not a cluster: the public one refuses anything carrying a browser
        // Origin, so every read here goes through this site's own relay, and
        // the routing screen has to be able to say so.
        endpoint: solanaRpcUrl(),
        path: solanaPath,
        curve: 'ed25519',
        capabilities: { balance: true, history: true, send: true },
        derive: (source) => solanaKeypair(source).publicKey.toBase58(),
        importKey: solanaAddressFromKey,
        isValidAddress: (address) => {
            try {
                return new PublicKey(address).toBytes().length === 32;
            } catch {
                return false;
            }
        },
        addressHint: 'base58, 32–44',
        explorerAddressUrl: (address) =>
            `${SOLANA_EXPLORER}/account/${address}`,
        explorerTxUrl: (hash) => `${SOLANA_EXPLORER}/tx/${hash}`,
        fetchBalance: async (address, rpcUrl) =>
            BigInt(
                await solanaConnection(rpcUrl).getBalance(
                    new PublicKey(address),
                ),
            ),
        /*
         * Both token programs, because the newer one is where the tokens
         * people actually trade are minted. See `lib/wallet/spl.ts`.
         */
        fetchTokens: async (address, rpcUrl) => {
            const connection = solanaConnection(rpcUrl);
            const holdings = await withoutCollectibles(
                connection,
                await readSplHoldings(connection, address),
            );

            if (holdings.length === 0) {
                return [];
            }

            const named = await solanaNames(
                holdings.map((holding) => holding.mint),
            );

            return holdings.map((holding) =>
                asTokenBalance(
                    holding,
                    marketFor(named, holding.mint) ?? undefined,
                ),
            );
        },
        readToken: async (mint, owner, rpcUrl) => {
            const holding = await readSplToken(
                solanaConnection(rpcUrl),
                mint,
                owner,
            );
            const named = await solanaNames([mint]);

            return {
                ...asTokenBalance(holding, marketFor(named, mint) ?? undefined),
                manual: true,
            };
        },
        readTokenSupply: async (mint, rpcUrl) =>
            BigInt(
                (
                    await solanaConnection(rpcUrl).getTokenSupply(
                        new PublicKey(mint),
                    )
                ).value.amount,
            ),
        /*
         * A token transfer costs the signature, the priority bid and — when
         * the recipient has never held this token — the rent on the account
         * that has to be opened for them.
         *
         * That rent is quoted whether or not it will be owed, because the
         * recipient is not part of the question this hook is asked. Quoting it
         * always is the safe direction of wrong: the fee shown is a ceiling
         * the transfer cannot exceed, and an account that already exists makes
         * it cheaper than promised rather than more expensive.
         */
        fetchFees: async ({ rpcUrl, token }) => {
            const connection = solanaConnection(rpcUrl);
            const [prices, rent] = await Promise.all([
                solanaPriorityPrices(rpcUrl),
                token
                    ? connection
                          .getMinimumBalanceForRentExemption(SPL_ACCOUNT_SPACE)
                          .then((lamports) => BigInt(lamports))
                          .catch(() => 0n)
                    : Promise.resolve(0n),
            ]);

            return WALLET_FEE_TIERS.map((tier) => ({
                tier,
                fee: solanaFee(prices[tier]) + rent,
                basis:
                    rent > 0n
                        ? { key: 'feeBasisSplRent' }
                        : prices[tier] === 0n
                          ? { key: 'feeBasisSignature' }
                          : {
                                key: 'feeBasisPriority',
                                params: { price: prices[tier].toString() },
                            },
            }));
        },
        fetchHistory: solanaHistory,
        awaitOutcome: async (hash, rpcUrl) => {
            const connection = solanaConnection(rpcUrl);
            const deadline = Date.now() + 60_000;

            while (Date.now() < deadline) {
                const status = (await connection.getSignatureStatuses([hash]))
                    .value[0];

                if (status?.err) {
                    return 'failed';
                }

                if (
                    status?.confirmationStatus === 'confirmed' ||
                    status?.confirmationStatus === 'finalized'
                ) {
                    return 'confirmed';
                }

                await new Promise((resolve) => setTimeout(resolve, 2_000));
            }

            throw new Error('Timed out waiting for confirmation');
        },
        /*
         * The coin, or one of its tokens.
         *
         * `token` used to be ignored here, which is the worst shape a bug can
         * take in a wallet: the screen said "send 6900 CYBER.sol", the
         * signature said "move 6900 lamports of SOL", and both were consistent
         * with each other. Nothing listed SPL tokens at the time, so nothing
         * could reach it — but the two were fixed in the same change, and this
         * branch is the half that makes the other half safe.
         *
         * The mint's owning program is read rather than passed in: an
         * associated account's address is derived *with* that program in the
         * seeds, so guessing it wrong addresses an account that does not exist
         * rather than failing loudly.
         */
        send: async (source, { to, amount, tier, rpcUrl, token, decimals }) => {
            const keypair = solanaKeypair(source);
            const connection = solanaConnection(rpcUrl);
            const unitPrice = (await solanaPriorityPrices(rpcUrl))[tier];
            const transaction = new Transaction().add(
                ComputeBudgetProgram.setComputeUnitLimit({
                    units: Number(SOLANA_COMPUTE_UNITS),
                }),
                ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: unitPrice,
                }),
            );

            if (token) {
                const mint = new PublicKey(token);
                const program = await splMintProgram(connection, token);

                transaction.add(
                    ...splTransferInstructions({
                        mint,
                        program,
                        from: keypair.publicKey,
                        to: new PublicKey(to),
                        amount,
                        // The scale the amount on screen was multiplied by,
                        // handed to a program that compares it with the mint's
                        // own. Reading it back off the chain here would make
                        // the check tautological — it would always agree with
                        // itself and never with the number the user saw.
                        decimals:
                            decimals ??
                            (await connection.getTokenSupply(mint)).value
                                .decimals,
                    }),
                );
            } else {
                transaction.add(
                    SystemProgram.transfer({
                        fromPubkey: keypair.publicKey,
                        toPubkey: new PublicKey(to),
                        lamports: amount,
                    }),
                );
            }

            return connection.sendTransaction(transaction, [keypair]);
        },
    },
    {
        id: 'monero',
        label: 'Monero',
        symbol: 'XMR',
        decimals: 12,
        family: 'monero',
        mark: { tag: 'XM', hue: 'var(--cw-net-monero)', shape: 'diamond' },
        // The account number is a subaddress index, not a path segment: one
        // Monero wallet holds them all, which is why the path never changes.
        path: () => MONERO_PATH,
        curve: 'ed25519',
        // Monero balances are not public: finding your own outputs means
        // scanning every block with the view key, which needs a node the app
        // does not run. The address is derived here, spending happens in a
        // Monero wallet restored from this same seed phrase.
        capabilities: { balance: false, history: false, send: false },
        note: 'Receive-only here: Monero balances and payments require a view-key scan against a Monero node, which the browser cannot do.',
        historyNote: 'historyUnsupported',
        derive: (source) => {
            if (source.kind !== 'seed') {
                // Nothing here can spend Monero, so holding a raw spend key
                // would buy an address the phrase already derives — at the
                // price of storing a live secret for no capability.
                throw new Error('Monero keys cannot be imported here');
            }

            return moneroAccountAddress(source.seed, source.index);
        },
        isValidAddress: isValidMoneroAddress,
        addressHint: '4… / 8…',
        explorerAddressUrl: () => null,
        explorerTxUrl: (hash) => `https://xmrchain.net/tx/${hash}`,
    },
    utxoChain({
        id: 'bitcoin',
        label: 'Bitcoin',
        symbol: 'BTC',
        mark: { tag: 'BT', hue: 'var(--cw-net-bitcoin)', shape: 'rounded' },
        network: {
            ...BITCOIN_NETWORK,
            coinType: 0,
            api: 'https://mempool.space/api',
            explorer: 'https://mempool.space',
        },
    }),
    utxoChain({
        id: 'litecoin',
        label: 'Litecoin',
        symbol: 'LTC',
        mark: { tag: 'LT', hue: 'var(--cw-net-litecoin)', shape: 'rounded' },
        network: {
            coinType: 2,
            hrp: 'ltc',
            p2pkhVersion: 0x30,
            p2shVersion: 0x32,
            addressType: 'bech32',
            api: 'https://litecoinspace.org/api',
            explorer: 'https://litecoinspace.org',
        },
    }),
];

/** The chain this wallet is for. Always on, and the one network with no switch. */
export const HOME_CHAIN: WalletChainId = 'cyberia';

/** Every network that ships switched on, whether or not it currently is. */
export const shippedChains = (): readonly WalletChain[] => SHIPPED_CHAINS;

/**
 * Networks the user added themselves, layered over the shipped registry.
 *
 * Module state rather than a ref, mirroring how the vault holds the decrypted
 * phrase: the registry is a process-wide fact, and every adapter lookup has to
 * see the same one whether it happens inside a component or inside `send()`.
 */
let customChains: readonly WalletChain[] = [];

/**
 * The shipped networks that are currently switched on.
 *
 * A slot rather than the constant itself, because these are switchable now:
 * whichever of them the user has left on is what the portfolio draws, and
 * anything switched off has to leave nothing behind that could still answer a
 * balance read. Until the composable says otherwise every one of them is on,
 * which is the state a wallet opens in.
 */
let shippedOn: readonly WalletChain[] = SHIPPED_CHAINS;

/**
 * Networks switched on from the shipped catalogue.
 *
 * Kept apart from `customChains` because the difference is not cosmetic: these
 * carry an endpoint this project checked and shipped, a user-added one carries
 * an endpoint nobody checked, and every screen that draws a network says which
 * of the two it is looking at. Held the same way, though — as a slot the
 * registry publishes into rather than an import — so `chains.ts` stays the
 * bottom of the dependency graph and the catalogue can be built on top of it.
 */
let catalogueChains: readonly WalletChain[] = [];

export const setCustomWalletChains = (chains: readonly WalletChain[]): void => {
    customChains = chains;
};

export const setShippedWalletChains = (
    chains: readonly WalletChain[],
): void => {
    shippedOn = chains;
};

export const setCatalogueWalletChains = (
    chains: readonly WalletChain[],
): void => {
    catalogueChains = chains;
};

/**
 * Every network this wallet currently has switched on, in the order the
 * portfolio lists them: the shipped ones still on, then the catalogue ones
 * switched on, then the ones the user described themselves.
 *
 * The three groups are an ordering and not a hierarchy — a shipped network and
 * a catalogue one are the same kind of thing in every way that reaches a
 * balance or a signature. What still separates the last group is the one real
 * difference: nobody vetted the endpoint the user typed in.
 */
export const walletChains = (): readonly WalletChain[] => [
    ...shippedOn,
    ...catalogueChains,
    ...customChains,
];

export const walletChain = (id: WalletChainId): WalletChain => {
    const chain = walletChains().find((candidate) => candidate.id === id);

    if (!chain) {
        throw new Error(`Unknown wallet chain "${id}"`);
    }

    return chain;
};

export { utxoChain };

/** Smallest-unit amount for a decimal string typed by a human. */
export const parseUnits = (value: string, decimals: number): bigint => {
    const [whole, fraction = ''] = value.trim().split('.');

    if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) {
        throw new Error('Amount must be a decimal number');
    }

    if (fraction.length > decimals) {
        throw new Error(`At most ${decimals} decimals`);
    }

    return BigInt(`${whole || '0'}${fraction.padEnd(decimals, '0')}`);
};

/** Human amount for a smallest-unit balance, trimmed to `precision` digits. */
export const formatUnits = (
    value: bigint,
    decimals: number,
    precision = 6,
): string => {
    const base = 10n ** BigInt(decimals);
    const whole = value / base;
    const fraction = (value % base).toString().padStart(decimals, '0');
    const trimmed = fraction.slice(0, precision).replace(/0+$/, '');

    return trimmed ? `${whole}.${trimmed}` : whole.toString();
};
