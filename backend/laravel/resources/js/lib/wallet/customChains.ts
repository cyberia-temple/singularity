import { JsonRpcProvider, isAddress } from 'ethers';
import { EVM_CHAINS } from '@/lib/evmChains';
import {
    EVM_CONTRACT_SEND_GAS_CAP,
    WALLET_FEE_TIERS,
    nativeSendGas,
    utxoChain,
} from '@/lib/wallet/chains';
import type { WalletChain, WalletFeeTier } from '@/lib/wallet/chains';
import {
    ERC20_TRANSFER_GAS_CAP,
    readErc20,
    sendErc20,
} from '@/lib/wallet/erc20';
import { evmAddressFromKey, evmPath, evmSigner } from '@/lib/wallet/keys';
import type { UtxoAddressType } from '@/lib/wallet/utxo';

/**
 * Networks the user adds themselves.
 *
 * The seed already covers them — an EVM chain is the same key at a different
 * chain id, and a Bitcoin fork is the same key at a different SLIP-44 coin
 * type — so adding one derives an account without ever asking for the phrase
 * again. What the user actually supplies is an *endpoint*, and that is the part
 * nobody can verify for them: a hostile node can report a balance that is not
 * there and a fee that is not real. Hence `custom: true` on every chain built
 * here, and the dashed, violet mark that goes with it everywhere on screen.
 *
 * Only the record is stored. The account is re-derived from the vault on every
 * unlock, so forgetting a network forgets its RPC and never its coins.
 */

export type CustomEvmNetwork = {
    kind: 'evm';
    id: string;
    name: string;
    symbol: string;
    chainId: number;
    rpcUrl: string;
    explorer: string | null;
};

export type CustomUtxoNetwork = {
    kind: 'utxo';
    id: string;
    name: string;
    symbol: string;
    /** SLIP-44 coin type: the slot that makes this a different account. */
    coinType: number;
    addressType: UtxoAddressType;
    /**
     * bech32 prefix for a segwit fork, or the base58 version byte otherwise.
     * The design's mock left this out; without it there is no address to
     * compute, so the form asks for it and the presets fill it in.
     */
    hrp: string | null;
    p2pkhVersion: number;
    p2shVersion: number;
    /** Esplora-compatible HTTPS API root. */
    api: string;
    explorer: string | null;
};

export type CustomNetwork = CustomEvmNetwork | CustomUtxoNetwork;

const STORAGE_KEY = 'cyberia.wallet.networks.v1';

/** Stable id from what the user typed, so re-adding the same chain collides. */
export const customNetworkId = (
    kind: CustomNetwork['kind'],
    symbol: string,
    discriminator: number,
): string =>
    `${kind}-${symbol.toLowerCase().replace(/[^a-z0-9]/g, '') || 'net'}-${discriminator}`;

export const readCustomNetworks = (): CustomNetwork[] => {
    if (typeof window === 'undefined') {
        return [];
    }

    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];

        return Array.isArray(parsed) ? (parsed as CustomNetwork[]) : [];
    } catch {
        // A corrupt list is a settings problem, never a funds problem: the
        // accounts come back from the seed the moment a valid entry is added.
        return [];
    }
};

export const writeCustomNetworks = (
    networks: readonly CustomNetwork[],
): void => {
    if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(networks));
    }
};

/**
 * Two letters for the tile.
 *
 * A multi-word name gives its initials, so "Bitcoin Gold" reads BG rather than
 * colliding with Bitcoin's own BT. The first two of the ticker are the fallback
 * for everything else.
 */
export const customNetworkTag = (name: string, symbol: string): string => {
    const words = name.trim().split(/\s+/).filter(Boolean);

    if (words.length > 1) {
        return (words[0][0] + words[1][0]).toUpperCase();
    }

    return (
        symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || 'NA'
    ).toUpperCase();
};

/** A plain native transfer to an address that is only an address. */
const EVM_TRANSFER_GAS = 21_000n;

const EVM_TIER_MULTIPLIER: Record<WalletFeeTier, [bigint, bigint]> = {
    slow: [1n, 1n],
    normal: [5n, 4n],
    fast: [8n, 5n],
};

/**
 * A user-added EVM chain.
 *
 * Deliberately not routed through the shipped `evmChain()`: that one reads its
 * parameters from `lib/evmChains.ts`, the registry of networks Cyberia ships
 * and stands behind. A chain typed into a form has no entry there and must not
 * borrow the credibility of one.
 */
const customEvmChain = (network: CustomEvmNetwork): WalletChain => {
    const provider = (rpcUrl?: string): JsonRpcProvider =>
        new JsonRpcProvider(rpcUrl || network.rpcUrl, {
            chainId: network.chainId,
            name: network.id,
        });

    const gasPrice = async (tier: WalletFeeTier): Promise<bigint> => {
        const feeData = await provider().getFeeData();

        if (!feeData.gasPrice || feeData.gasPrice === 0n) {
            throw new Error('The network did not report a gas price');
        }

        const [numerator, denominator] = EVM_TIER_MULTIPLIER[tier];

        return (feeData.gasPrice * numerator) / denominator;
    };

    return {
        id: network.id,
        label: network.name,
        symbol: network.symbol,
        decimals: 18,
        chainId: network.chainId,
        family: 'evm',
        mark: {
            tag: customNetworkTag(network.name, network.symbol),
            hue: 'var(--cw-net-custom)',
            shape: 'square',
            unverified: true,
        },
        custom: true,
        endpoint: network.rpcUrl,
        path: evmPath,
        curve: 'secp256k1',
        capabilities: { balance: true, history: false, send: true },
        // No keyless index is promised for a chain nobody registered, so the
        // history panel says why instead of rendering an empty list.
        historyNote: 'historyNoIndexer',
        derive: (source) => evmSigner(source).address,
        importKey: evmAddressFromKey,
        signMessage: (source, message) =>
            evmSigner(source).signMessage(message),
        isValidAddress: (address) => isAddress(address),
        explorerAddressUrl: (address) =>
            network.explorer ? `${network.explorer}/address/${address}` : null,
        explorerTxUrl: (hash) =>
            network.explorer ? `${network.explorer}/tx/${hash}` : null,
        fetchBalance: (address, rpcUrl) => provider(rpcUrl).getBalance(address),
        // No index exists for a chain nobody registered, so tokens here are
        // added by contract address and read straight from the contract.
        tokensNote: 'tokensNoIndexer',
        readToken: (contract, owner, rpcUrl) =>
            readErc20(provider(rpcUrl), contract, owner),
        hasCode: async (address, rpcUrl) => {
            try {
                const code = await provider(rpcUrl).getCode(address);

                return code !== '0x' && code !== '0x0';
            } catch {
                // Unreadable is answered "contract": overpaying a plain
                // address costs nothing, underpaying a contract loses the fee.
                return true;
            }
        },
        fetchFees: async ({ token, toContract }) => {
            const gas = token
                ? ERC20_TRANSFER_GAS_CAP
                : toContract
                  ? EVM_CONTRACT_SEND_GAS_CAP
                  : EVM_TRANSFER_GAS;

            return Promise.all(
                WALLET_FEE_TIERS.map(async (tier) => ({
                    tier,
                    fee: (await gasPrice(tier)) * gas,
                    basis: `network price × ${
                        Number(EVM_TIER_MULTIPLIER[tier][0]) /
                        Number(EVM_TIER_MULTIPLIER[tier][1])
                    }${token || toContract ? ` × ${gas} gas` : ''}`,
                })),
            );
        },
        awaitOutcome: async (hash) => {
            const receipt = await provider().waitForTransaction(
                hash,
                1,
                120_000,
            );

            if (receipt === null) {
                throw new Error('Timed out waiting for a receipt');
            }

            return receipt.status === 1 ? 'confirmed' : 'failed';
        },
        send: async (source, { to, amount, tier, token }) => {
            const signer = evmSigner(source).connect(provider());
            const price = await gasPrice(tier);

            if (token) {
                return sendErc20(signer, token, to, amount, price);
            }

            // Paying a contract runs its code on this transaction's gas, and
            // 21000 does not cover a single opcode of it. See nativeSendGas.
            const code = await provider()
                .getCode(to)
                .catch(() => '0x1');

            const tx = await signer.sendTransaction({
                to,
                value: amount,
                gasLimit: nativeSendGas(code !== '0x' && code !== '0x0'),
                gasPrice: price,
            });

            return tx.hash;
        },
    };
};

/** A user-added chain as a wallet chain, whichever account model it uses. */
export const customWalletChain = (network: CustomNetwork): WalletChain =>
    network.kind === 'evm'
        ? customEvmChain(network)
        : utxoChain({
              id: network.id,
              label: network.name,
              symbol: network.symbol,
              custom: true,
              mark: {
                  tag: customNetworkTag(network.name, network.symbol),
                  hue: 'var(--cw-net-custom)',
                  shape: 'rounded',
                  unverified: true,
              },
              network: {
                  coinType: network.coinType,
                  hrp: network.hrp,
                  p2pkhVersion: network.p2pkhVersion,
                  p2shVersion: network.p2shVersion,
                  addressType: network.addressType,
                  api: network.api,
                  explorer: network.explorer,
              },
          });

export type CustomNetworkProblem =
    | 'name'
    | 'symbol'
    | 'chainId'
    | 'rpc'
    | 'coinType'
    | 'api'
    | 'explorer'
    | 'prefix'
    | 'duplicate';

/** A browser-safe public endpoint: protocol and host must both be explicit. */
const isHttpsUrl = (value: string): boolean => {
    try {
        const url = new URL(value);

        return url.protocol === 'https:' && url.hostname.length > 0;
    } catch {
        return false;
    }
};

/**
 * What is wrong with a draft network, or null when it can be added.
 *
 * HTTPS is required rather than preferred: the wallet page is served over TLS,
 * so a plain-HTTP endpoint is blocked by the browser as mixed content and would
 * show up as a network that silently never loads.
 */
export const validateCustomNetwork = (
    draft: CustomNetwork,
    existing: readonly { id: string; chainId?: number }[],
): CustomNetworkProblem | null => {
    if (draft.name.trim().length < 2) {
        return 'name';
    }

    if (!/^[A-Za-z0-9]{2,8}$/.test(draft.symbol.trim())) {
        return 'symbol';
    }

    if (existing.some((chain) => chain.id === draft.id)) {
        return 'duplicate';
    }

    // Explorer links are optional, but once supplied they become an `href` in
    // the wallet. Keep them HTTPS just like read/broadcast endpoints rather
    // than letting a user-supplied `javascript:` URL escape the app on click.
    if (draft.explorer !== null && !isHttpsUrl(draft.explorer)) {
        return 'explorer';
    }

    if (draft.kind === 'evm') {
        if (!Number.isInteger(draft.chainId) || draft.chainId <= 0) {
            return 'chainId';
        }

        if (existing.some((chain) => chain.chainId === draft.chainId)) {
            return 'duplicate';
        }

        return isHttpsUrl(draft.rpcUrl) ? null : 'rpc';
    }

    if (!Number.isInteger(draft.coinType) || draft.coinType < 0) {
        return 'coinType';
    }

    if (!isHttpsUrl(draft.api)) {
        return 'api';
    }

    if (draft.addressType === 'bech32') {
        return draft.hrp && /^[a-z]{2,6}$/.test(draft.hrp) ? null : 'prefix';
    }

    const version =
        draft.addressType === 'legacy' ? draft.p2pkhVersion : draft.p2shVersion;

    return Number.isInteger(version) && version >= 0 && version <= 255
        ? null
        : 'prefix';
};

export type ForkPreset = Omit<CustomUtxoNetwork, 'kind' | 'id'>;

/**
 * Parameters for the forks people actually ask for, so the form is a
 * confirmation rather than a research task. The endpoint is left blank on
 * purpose: there is no public Esplora instance the wallet can promise for
 * these, and inventing one would be the exact unverified endpoint the warning
 * on this screen is about.
 */
export const FORK_PRESETS: readonly { label: string; values: ForkPreset }[] = [
    {
        label: 'Bitcoin Gold',
        values: {
            name: 'Bitcoin Gold',
            symbol: 'BTG',
            coinType: 156,
            addressType: 'bech32',
            hrp: 'btg',
            p2pkhVersion: 0x26,
            p2shVersion: 0x17,
            api: '',
            explorer: null,
        },
    },
    {
        label: 'Dogecoin',
        values: {
            name: 'Dogecoin',
            symbol: 'DOGE',
            coinType: 3,
            addressType: 'legacy',
            hrp: null,
            p2pkhVersion: 0x1e,
            p2shVersion: 0x16,
            api: '',
            explorer: null,
        },
    },
    {
        label: 'Dash',
        values: {
            name: 'Dash',
            symbol: 'DASH',
            coinType: 5,
            addressType: 'legacy',
            hrp: null,
            p2pkhVersion: 0x4c,
            p2shVersion: 0x10,
            api: '',
            explorer: null,
        },
    },
    {
        label: 'Bitcoin Cash',
        values: {
            name: 'Bitcoin Cash',
            symbol: 'BCH',
            coinType: 145,
            addressType: 'legacy',
            hrp: null,
            p2pkhVersion: 0x00,
            p2shVersion: 0x05,
            api: '',
            explorer: null,
        },
    },
];

export type EvmPreset = Omit<CustomEvmNetwork, 'kind' | 'id'>;

/**
 * Quick fill for the EVM chains the site already talks to elsewhere — bridge,
 * swap, launchpad — but that the wallet does not ship as its own network. They
 * come from `lib/evmChains.ts` rather than from a list typed out here, so a
 * chain the rest of Cyberia adds shows up in this form for free, with the
 * endpoint the rest of Cyberia already uses.
 */
export const evmPresets = (
    taken: readonly number[],
): { label: string; values: EvmPreset }[] =>
    EVM_CHAINS.filter(
        (chain) => chain.status === 'live' && !taken.includes(chain.chainId),
    ).map((chain) => ({
        label: chain.name,
        values: {
            name: chain.name,
            symbol: chain.nativeCurrency.symbol,
            chainId: chain.chainId,
            rpcUrl: chain.rpcUrls[0],
            explorer: chain.blockExplorerUrls?.[0] ?? null,
        },
    }));
