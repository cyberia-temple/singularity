import {
    CYBER_SOL_ADDRESS,
    USDC_ADDRESS,
    USDT_ADDRESS,
} from '@/lib/cyberiaTokens';
import type { V3Config } from '@/lib/dexV3';
import { V3_FEE_TIERS } from '@/lib/dexV3';
import {
    CYBERIA_CHAIN,
    CYBERIA_CHAIN_ID,
    cyberiaReadRpcUrl,
    EVM_CHAINS,
} from '@/lib/evmChains';
import type { EvmChain } from '@/lib/evmChains';

/**
 * Per-chain wiring for the Ritual DEX liquidity page. Each chain has its own
 * router/factory/pools, so /liquidity reads and trades entirely within the
 * wallet's chain — Robinhood liquidity never mixes with Cyberia's.
 */
export type LiquidityChainConfig = {
    chainId: number;
    evmChain: EvmChain;
    readRpcUrl: string;
    router: string;
    factory: string;
    /** Wrapped native token the NATIVE sentinel maps to (WCYBER / WETH). */
    wrappedNative: string;
    /** Native coin symbol shown in the picker (CYBER / ETH). */
    nativeSymbol: string;
    explorer: string;
    /**
     * Curated pickable tokens (excluding the native coin). Cyberia leaves this
     * empty and draws its token universe from the server pool snapshot +
     * KNOWN_TOKENS; satellites list their bridged assets here.
     */
    tokens: { address: string; symbol: string }[];
    /**
     * Tokens a route may hop through when the two ends share no pool. These
     * are the assets everything else is actually paired against, so a path
     * that fails through them fails everywhere — which is why the list is
     * short and lives next to the router rather than in each screen that
     * quotes one.
     */
    hubs: string[];
    /**
     * The dollar this chain's prices are quoted in.
     *
     * Separate from `hubs` because the two answer different questions: a hub is
     * anything a route may pass *through*, and on Cyberia the first of those is
     * WCYBER itself. Taking `hubs[0]` as the quote asset therefore priced the
     * coin against itself — the market chart came back "no pool connects this
     * to the dollar" for the one token the chain is built around.
     *
     * Absent on a chain with no stablecoin, and a screen that needs one says so
     * rather than picking a hub and hoping.
     */
    dollar?: string;
    /**
     * Cyberia gets its pool list + APR from the server indexer; satellites are
     * client-only (pairs discovered on-chain, no APR snapshot).
     */
    serverPools: boolean;
    /**
     * The concentrated-liquidity stack, where one is deployed.
     *
     * v3 sits *beside* v2 rather than replacing it: both hold real liquidity,
     * so a screen quotes both and takes the better answer. A chain without this
     * field simply has one venue, and every v3 path is skipped rather than
     * guessed at — deriving a pool address from a factory that never deployed
     * one produces a plausible address with nothing at it.
     */
    v3?: V3Config;
};

const ROBINHOOD_CHAIN = EVM_CHAINS.find((c) => c.chainId === 4663)!;

export const LIQUIDITY_CHAINS: readonly LiquidityChainConfig[] = [
    {
        chainId: CYBERIA_CHAIN_ID,
        evmChain: CYBERIA_CHAIN,
        readRpcUrl: cyberiaReadRpcUrl(),
        router: '0x8bECfB12Ab113586D8deD3D343aEfFd8eD54FD62',
        factory: '0xB0aC30907c04b61F1482e62eA66eF4562a690917',
        wrappedNative: '0x78272aAd03E4b9d7A9134e874BA6d419B534F6c9',
        nativeSymbol: 'CYBER',
        explorer: 'https://explorer.cyberia.church',
        tokens: [],
        hubs: [
            '0x78272aAd03E4b9d7A9134e874BA6d419B534F6c9', // WCYBER
            CYBER_SOL_ADDRESS,
            USDC_ADDRESS,
            USDT_ADDRESS,
        ],
        dollar: USDC_ADDRESS,
        serverPools: true,
        // crypto/hardhat/deployments/cyberia-v3.json, redeployed 2026-09-07.
        // `initCodeHash` must equal POOL_INIT_CODE_HASH in PoolAddress.sol: it
        // is what every pool address here is derived from, and a stale one
        // addresses contracts that are not there without erroring.
        v3: {
            poolDeployer: '0x216Caa611CE6F300c6b23f1D00Aa6055F77dE773',
            factory: '0xB6abF60A04fC1ac64Bf225787B7064A94165b496',
            quoter: '0xD583dDAf0f9B1bb227832f9c4948519C697DCF99',
            router: '0xa9f2A35F8dbA643e199Da0FeEbDF7e1c72ee773e',
            positionManager: '0x50A0B7Fd739fE3afC27fF5c8259Ae1c76B569139',
            initCodeHash:
                '0x552a3c12f1630ab391584c8e037aad90f40e97650684de28cdc32815cac7e158',
            tiers: V3_FEE_TIERS,
        },
    },
    {
        chainId: 4663,
        evmChain: ROBINHOOD_CHAIN,
        readRpcUrl: 'https://rpc.mainnet.chain.robinhood.com',
        router: '0xB0aC30907c04b61F1482e62eA66eF4562a690917',
        factory: '0xD199e6ae74B992F017f8940B26Fa18A7dD30eE86',
        wrappedNative: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', // aeWETH
        nativeSymbol: 'ETH',
        explorer: 'https://robinhoodchain.blockscout.com',
        tokens: [
            {
                address: '0x753979e6585CCa139fbB1918966D563a25eEB3B2',
                symbol: 'CYBER',
            },
            {
                address: '0xa284bF7D1d941ED8dEd25f8E592003E9e5373284',
                symbol: 'ASH',
            },
        ],
        // Everything here is paired against the wrapped native and nothing
        // else, so it is the only hop worth trying.
        hubs: ['0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'],
        serverPools: false,
    },
];

export const DEFAULT_LIQUIDITY_CHAIN_ID = CYBERIA_CHAIN_ID;

export const liquidityChainById = (
    chainId: number | null,
): LiquidityChainConfig =>
    LIQUIDITY_CHAINS.find((c) => c.chainId === chainId) ??
    LIQUIDITY_CHAINS.find((c) => c.chainId === DEFAULT_LIQUIDITY_CHAIN_ID)!;
