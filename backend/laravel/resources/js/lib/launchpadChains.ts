import {
    CYBERIA_CHAIN,
    CYBERIA_CHAIN_ID,
    CYBERIA_FUJI_CHAIN_ID,
    EVM_CHAINS,
    cyberiaReadRpcUrl,
} from '@/lib/evmChains';
import type { EvmChain } from '@/lib/evmChains';

/**
 * Launchpad deployment registry.
 *
 * One fair launch can target several chains at once, so every chain that runs
 * a `LaunchpadNative` (contracts/LaunchpadNative.sol) plus the QuickSwap fork
 * it pairs against is listed here. Chain parameters themselves come from the
 * shared registry in `evmChains.ts` — this file only adds the launchpad-side
 * contract addresses, taken from `crypto/hardhat/deployments/*.json`.
 *
 * Adding a chain: run `scripts/deploy-launchpad-satellite.ts` against it, then
 * fill in `launchpad` here (or set the matching `VITE_LAUNCHPAD_<chainId>`
 * build variable) and add the chain id to `config/launchpad.php`.
 */
export type LaunchpadChain = {
    chain: EvmChain;
    /** LaunchpadNative address; null until one is deployed on this chain. */
    launchpad: string | null;
    /**
     * LaunchpadV3, where one is deployed.
     *
     * The difference is not a version number: a v3 launch lets its creator set
     * the trading fee (up to 10%, plus the protocol's 1%) and share any part of
     * it with holders, and its liquidity is a locked position that keeps
     * earning rather than a burned LP token that cannot. A chain with only the
     * v2 launchpad offers neither, so the controls for them are not drawn
     * there — they are not a setting that happens to be missing.
     */
    launchpadV3?: string | null;
    /**
     * The Cyberia 2.0 launchpad (crypto/protocol `Launchpad.sol`), where one
     * is deployed.
     *
     * Its pool and fee are the v3 launchpad's — a locked full-range position,
     * the creator's fee up to 10% plus the protocol's 1% — but the launch also
     * opens the token's "kit" in the same transaction: lending markets, a
     * farm, a domain zone when the name spells one, and a DAO. It takes one
     * struct rather than five arguments, so it is a venue of its own.
     */
    launchpadKit?: string | null;
    factory: string;
    /** Wrapped native token the launch pairs against. */
    wrappedNative: string;
    /**
     * Blockscout instance used for log queries and address links; empty on a
     * chain that has no explorer yet, and then no link is drawn.
     */
    explorerUrl: string;
    /** Built-in swap deep link base; the URL also names the chain. */
    swapUrl: string;
    /** Suggested native liquidity, matching the contract's minLiquidity. */
    defaultLiquidity: string;
};

/**
 * Build-time variables, when there is a build.
 *
 * `import.meta.env` is Vite's injection, so it is simply absent under plain
 * Node — in the test runner and during SSR. Defaulting to an empty object keeps
 * this registry importable there instead of throwing at module scope and taking
 * everything that imports it down with it.
 */
const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

const evmChain = (chainId: number): EvmChain =>
    EVM_CHAINS.find((c) => c.chainId === chainId) ?? CYBERIA_CHAIN;

/** Build-time override so a fresh deployment can be wired without a code edit. */
const deployedAt = (chainId: number, fallback: string | null): string | null =>
    env[`VITE_LAUNCHPAD_${chainId}`] ?? fallback;

/** The same, for the v3 launchpad, which is a different contract on the same chain. */
const deployedV3At = (
    chainId: number,
    fallback: string | null,
): string | null => env[`VITE_LAUNCHPAD_V3_${chainId}`] ?? fallback;

export const LAUNCHPAD_CHAINS: readonly LaunchpadChain[] = [
    {
        // deployments/cyberia-launchpad-native.json
        chain: CYBERIA_CHAIN,
        launchpad: deployedAt(
            CYBERIA_CHAIN_ID,
            '0x8034E6C09E0cEA00B5D692ADfD1A136fab339165',
        ),
        // deployments/cyberia-v3.json, redeployed 2026-09-07
        launchpadV3: deployedV3At(
            CYBERIA_CHAIN_ID,
            '0x6970481a167D8D44527091d0E319e50aD3F79Ee3',
        ),
        factory: '0xB0aC30907c04b61F1482e62eA66eF4562a690917',
        wrappedNative: '0x78272aAd03E4b9d7A9134e874BA6d419B534F6c9',
        explorerUrl: 'https://explorer.cyberia.church',
        swapUrl: '/swap',
        defaultLiquidity: '10',
    },
    {
        // deployments/robinhood-dex.json — the DEX is live, the launchpad is
        // not deployed yet, so this chain shows up greyed out.
        chain: evmChain(4663),
        launchpad: deployedAt(4663, null),
        factory: '0xd199e6ae74b992f017f8940b26fa18a7dd30ee86',
        wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
        explorerUrl: 'https://robinhoodchain.blockscout.com',
        swapUrl: '/swap',
        defaultLiquidity: '0.01',
    },
];

/** The same, for the Cyberia 2.0 launchpad. */
const deployedKitAt = (
    chainId: number,
    fallback: string | null,
): string | null => env[`VITE_LAUNCHPAD_KIT_${chainId}`] ?? fallback;

/**
 * Cyberia 2.0, the Avalanche L1 on Fuji (crypto/protocol/deployments/49407.json).
 *
 * Kept out of `LAUNCHPAD_CHAINS` on purpose: that list is what `/launchpad`
 * launches on in one go, and a launch there goes to LaunchpadNative or
 * LaunchpadV3 — which this chain does not run. The wallet's launchpad offers
 * it beside Cyberia (`walletLaunchpadChains`).
 */
export const CYBERIA2_LAUNCHPAD: LaunchpadChain = {
    // The wallet calls this network Cyberia 2.0; the registry still says Fuji.
    chain: { ...evmChain(CYBERIA_FUJI_CHAIN_ID), name: 'Cyberia 2.0' },
    launchpad: null,
    launchpadV3: null,
    launchpadKit: deployedKitAt(
        CYBERIA_FUJI_CHAIN_ID,
        '0xea0fbc4634f1ad6a5f82df3e7c9de01f964721c0',
    ),
    factory: '0xf5397e55410df25551012757794513aa85071784',
    wrappedNative: '0x000000000000000000000000000000000000c0Fe',
    explorerUrl: '',
    swapUrl: '/swap',
    defaultLiquidity: '100000',
};

export const DEFAULT_LAUNCHPAD_CHAIN_ID = CYBERIA_CHAIN_ID;

export const launchpadChain = (chainId: number): LaunchpadChain | undefined =>
    [...LAUNCHPAD_CHAINS, CYBERIA2_LAUNCHPAD].find(
        (c) => c.chain.chainId === chainId,
    );

/** Chains that can actually take a launch right now. */
export const deployedLaunchpadChains = (): LaunchpadChain[] =>
    LAUNCHPAD_CHAINS.filter((c) => c.launchpad !== null);

/**
 * Read-only RPC endpoint for a launchpad chain: Cyberia goes through the
 * same-origin proxy (no CORS, no mixed content), satellites use their public
 * RPC directly.
 */
export const launchpadReadRpcUrl = (target: LaunchpadChain): string =>
    target.chain.chainId === CYBERIA_CHAIN_ID
        ? cyberiaReadRpcUrl()
        : target.chain.rpcUrls[0];

export const launchpadExplorerAddressUrl = (
    target: LaunchpadChain,
    address: string,
): string => `${target.explorerUrl}/address/${address}`;

export const launchpadExplorerTxUrl = (
    target: LaunchpadChain,
    hash: string,
): string => `${target.explorerUrl}/tx/${hash}`;

export const launchpadSwapUrl = (
    target: LaunchpadChain,
    tokenAddress: string,
): string =>
    `${target.swapUrl}?chain=${target.chain.chainId}&out=${encodeURIComponent(tokenAddress)}`;
