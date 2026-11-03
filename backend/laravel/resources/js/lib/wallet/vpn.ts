import { Contract, JsonRpcProvider } from 'ethers';
import { CYBERIA_CHAIN_ID, CYBERIA_PUBLIC_RPC } from '@/lib/evmChains';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';

/**
 * Cyberia VPN: days of access bought for CYBER, a link handed out by a node.
 *
 * `CyberiaVpnPass` (crypto/hardhat/contracts/CyberiaVpnPass.sol) is one number
 * per address — when its access ends — and splits each payment in the same
 * transaction: 90% to whoever pays the nodes, 10% to the protocol's fee
 * address. A node (services/vpn) lets in every address with a running pass.
 * To get the link, the wallet proves it holds the key by signing
 * `vpnChallenge()`, which it builds itself from the address, the node's id and
 * the node's nonce — so a node can never get this wallet to sign other text.
 *
 * Until the contract is deployed `VPN_PASS_ADDRESS` is null, and until a node
 * is listed `VPN_NODES` is empty; the screen says which.
 */
export const VPN_PASS_ADDRESS: string | null = '0x3a7b1aF57EbF55a607344333E6Ba9023C405BeC7';

/** The pass lives on Cyberia, where CYBER is the coin that pays for it. */
export const VPN_CHAIN_ID = CYBERIA_CHAIN_ID;

export type VpnNode = {
    id: string;
    /** Where the node is, for a person choosing one. */
    label: string;
    /** The node's gate, HTTPS, ending in /api/vpn. */
    gate: string;
};

export const VPN_NODES: VpnNode[] = [];

/** Days the screen offers; the contract takes 1..366. */
export const VPN_PLANS = [7, 30, 90] as const;

/** A purchase is one storage write, an event and two transfers. */
export const VPN_GAS_CAP = 150_000n;
const GAS_MARGIN = [125n, 100n] as const;

const PASS_ABI = [
    'function pricePerDay() view returns (uint256)',
    'function feeBps() view returns (uint16)',
    'function paused() view returns (bool)',
    'function expiresAt(address user) view returns (uint64)',
    'function buy(address user, uint32 days_) payable returns (uint64)',
];

/**
 * The exact text signed to be given a link — `challengeMessage` in
 * services/vpn/src/gate.mjs, byte for byte (both pinned to one vector).
 */
export const vpnChallenge = (
    address: string,
    node: string,
    nonce: string,
): string =>
    [
        'Cyberia VPN: issue my connection link.',
        'This signature spends nothing.',
        `Address: ${address.toLowerCase()}`,
        `Node: ${node}`,
        `Nonce: ${nonce}`,
    ].join('\n');

export type VpnPass = {
    pricePerDay: bigint;
    feeBps: number;
    paused: boolean;
    /** Unix seconds; 0 = never bought. */
    expiresAt: number;
};

/** Whole days left at `now` (unix seconds), rounded up; 0 when expired. */
export const daysLeft = (expiresAt: number, now: number): number =>
    expiresAt > now ? Math.ceil((expiresAt - now) / 86_400) : 0;

/** When access would end after buying `days` more at `now`. */
export const extendedUntil = (
    expiresAt: number,
    days: number,
    now: number,
): number => Math.max(expiresAt, now) + days * 86_400;

const provider = (rpcUrl?: string): JsonRpcProvider =>
    new JsonRpcProvider(rpcUrl || CYBERIA_PUBLIC_RPC, VPN_CHAIN_ID, {
        staticNetwork: true,
    });

const passContract = (runner: unknown): Contract => {
    if (!VPN_PASS_ADDRESS) {
        throw new Error('The VPN pass contract is not deployed yet');
    }

    return new Contract(VPN_PASS_ADDRESS, PASS_ABI, runner as JsonRpcProvider);
};

/** The price, the split and `owner`'s pass, read from the contract. */
export const readVpnPass = async (
    owner: string,
    rpcUrl?: string,
): Promise<VpnPass> => {
    const pass = passContract(provider(rpcUrl));
    const [pricePerDay, feeBps, paused, expiresAt] = await Promise.all([
        pass.pricePerDay(),
        pass.feeBps(),
        pass.paused(),
        pass.expiresAt(owner),
    ]);

    return {
        pricePerDay: pricePerDay as bigint,
        feeBps: Number(feeBps),
        paused: Boolean(paused),
        expiresAt: Number(expiresAt),
    };
};

/**
 * Buy `days` for the signing address. `pricePerDay` is the price the user saw:
 * the contract wants the exact amount, so a price change that lands first
 * makes this revert rather than charge a different number.
 */
export const buyVpnPass = async (
    source: WalletKeySource,
    request: {
        days: number;
        pricePerDay: bigint;
        gasPrice: bigint;
        rpcUrl?: string;
    },
): Promise<string> => {
    const signer = evmSigner(source).connect(provider(request.rpcUrl));
    const pass = passContract(signer);
    const owner = await signer.getAddress();
    const value = request.pricePerDay * BigInt(request.days);
    const estimate = await pass.buy
        .estimateGas(owner, request.days, { value })
        .catch(() => null);
    const gasLimit =
        estimate === null
            ? VPN_GAS_CAP
            : (estimate * GAS_MARGIN[0]) / GAS_MARGIN[1];

    if (gasLimit > VPN_GAS_CAP) {
        throw new Error(
            'This costs more gas than this wallet will spend on a pass.',
        );
    }

    const tx = await pass.buy(owner, request.days, {
        value,
        gasLimit,
        gasPrice: request.gasPrice,
    });
    await tx.wait();

    return tx.hash as string;
};

export type VpnLink = { link: string; expiresAt: number; node: string };

export type VpnLinkError =
    | 'noPass'
    | 'badSignature'
    | 'staleChallenge'
    | 'unreachable';

export class VpnLinkRefused extends Error {
    readonly reason: VpnLinkError;

    constructor(reason: VpnLinkError) {
        super(reason);
        this.reason = reason;
    }
}

/** Ask `node` for `address`'s link, signing its challenge with `sign`. */
export const requestVpnLink = async (
    node: VpnNode,
    address: string,
    sign: (message: string) => Promise<string>,
): Promise<VpnLink> => {
    const call = async (path: string, init?: RequestInit) => {
        try {
            return await fetch(`${node.gate}${path}`, init);
        } catch {
            throw new VpnLinkRefused('unreachable');
        }
    };

    const issued = await call(
        `/challenge?address=${encodeURIComponent(address)}`,
    );

    if (!issued.ok) {
        throw new VpnLinkRefused('unreachable');
    }

    const { node: id, nonce } = (await issued.json()) as {
        node: string;
        nonce: string;
    };

    if (id !== node.id || !/^[0-9a-f]{32}$/.test(nonce)) {
        throw new VpnLinkRefused('unreachable');
    }

    const signature = await sign(vpnChallenge(address, node.id, nonce));
    const answer = await call('/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address, nonce, signature }),
    });
    const body = (await answer.json().catch(() => ({}))) as Partial<VpnLink> & {
        error?: VpnLinkError;
    };

    if (!answer.ok || typeof body.link !== 'string') {
        throw new VpnLinkRefused(body.error ?? 'unreachable');
    }

    if (!body.link.startsWith('vless://')) {
        throw new VpnLinkRefused('unreachable');
    }

    return {
        link: body.link,
        expiresAt: Number(body.expiresAt),
        node: node.id,
    };
};
