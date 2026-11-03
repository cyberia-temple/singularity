import { BrowserProvider, Interface, JsonRpcProvider, getAddress } from 'ethers';
import type { Signer } from 'ethers';
import { CYBERIA_FUJI_CHAIN_ID as FUJI_ID, EVM_CHAINS, ensureEvmChain } from '@/lib/evmChains';
import { CYBERIA_FUJI_CHAIN_ID } from '@/lib/evmChains';
import { getSelectedEvmProvider } from '@/lib/evmProvider';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';
import { chain as chainStatusRoute } from '@/routes/api/fuji';

/**
 * Cyberia 2.0's own rules, as the wallet's chain panel reads and changes them.
 *
 * Two Subnet-EVM precompiles hold everything adjustable: FeeManager (what gas
 * costs) and RewardManager (where the fees go). Each keeps an allow list, and
 * the chain refuses a change from anyone not on it — so the panel only offers
 * the controls to an account the chain lists, and signs with that account's
 * key here in the browser like every other transaction in this wallet.
 */

export const FEE_MANAGER = '0x0200000000000000000000000000000000000003';
export const REWARD_MANAGER = '0x0200000000000000000000000000000000000004';

/** FeeManager's fields, in the order setFeeConfig takes them. */
export const FEE_FIELDS = [
    'gasLimit',
    'targetBlockRate',
    'minBaseFee',
    'targetGas',
    'baseFeeChangeDenominator',
    'minBlockGasCost',
    'maxBlockGasCost',
    'blockGasCostStep',
] as const;

export type FeeField = (typeof FEE_FIELDS)[number];

export type FeeConfig = Record<FeeField, string>;

export type ChainWalletKey = 'faucet' | 'bridge' | 'icm' | 'operator';

export type ChainStatus = {
    chainId: number;
    block: { number: number; timestamp: number; baseFee: string | null } | null;
    gasPrice: string | null;
    feeConfig: FeeConfig | null;
    feeConfigChangedAt: number | null;
    rewards: { address: string | null; feeRecipientsAllowed: boolean | null };
    treasury: { address: string; balance: string | null };
    validator: {
        validationId: string;
        nodeId: string | null;
        balance: string;
        price: string;
        secondsLeft: number;
        haltsAt: string;
    } | null;
    wallets: { key: ChainWalletKey; address: string; balance: string | null }[];
    minters: { address: string; role: number | null }[];
    pricing: {
        cyberUsd: number | null;
        ethUsd: number | null;
        ethGasPrice: string | null;
        parityMinBaseFee: string | null;
    };
    roles?: { feeManager: number | null; rewardManager: number | null };
};

/** A plain transfer, on Cyberia and on Ethereum alike. */
export const TRANSFER_GAS = 21_000n;

const FEE_MANAGER_ABI = new Interface([
    'function setFeeConfig(uint256 gasLimit, uint256 targetBlockRate, uint256 minBaseFee, uint256 targetGas, uint256 baseFeeChangeDenominator, uint256 minBlockGasCost, uint256 maxBlockGasCost, uint256 blockGasCostStep)',
]);

const REWARD_MANAGER_ABI = new Interface([
    'function setRewardAddress(address addr)',
    'function allowFeeRecipients()',
]);

/** The panel's picture of the chain, with this address's roles when one is named. */
export const fetchChainStatus = async (
    address?: string,
): Promise<ChainStatus | null> => {
    try {
        const response = await fetch(
            chainStatusRoute.url(address ? { query: { address } } : undefined),
            { headers: { Accept: 'application/json' } },
        );

        return response.ok ? ((await response.json()) as ChainStatus) : null;
    } catch {
        return null;
    }
};

/** Enabled (1), Admin (2) and Manager (3) may all call the precompile. */
export const canManage = (role: number | null | undefined): boolean =>
    typeof role === 'number' && role >= 1;

/** What a plain transfer costs at this base fee, in wei. */
export const transferCost = (baseFee: bigint): bigint => baseFee * TRANSFER_GAS;

/** The minimum base fee at which a plain transfer costs `cyber` whole CYBER. */
export const minBaseFeeForTransfer = (cyber: string): bigint => {
    const [whole, fraction = ''] = cyber.trim().split('.');
    const wei =
        BigInt(whole || '0') * 10n ** 18n +
        BigInt((fraction + '0'.repeat(18)).slice(0, 18) || '0');

    return wei / TRANSFER_GAS;
};

/** How many plain transfers a balance pays for at this base fee. */
export const transfersLeft = (balance: bigint, baseFee: bigint): bigint =>
    baseFee > 0n ? balance / transferCost(baseFee) : 0n;

export const feeConfigCalldata = (config: FeeConfig): string =>
    FEE_MANAGER_ABI.encodeFunctionData(
        'setFeeConfig',
        FEE_FIELDS.map((field) => BigInt(config[field])),
    );

/**
 * One address takes every fee, or — with null — each block's producer does.
 * The zero address is refused: on Subnet-EVM it burns the fees, which is a
 * decision of its own and not one to make by clearing a text field.
 */
export const feeRecipientCalldata = (recipient: string | null): string => {
    if (recipient === null) {
        return REWARD_MANAGER_ABI.encodeFunctionData('allowFeeRecipients');
    }

    const address = getAddress(recipient);

    if (BigInt(address) === 0n) {
        throw new Error('The zero address would burn every fee');
    }

    return REWARD_MANAGER_ABI.encodeFunctionData('setRewardAddress', [address]);
};

/**
 * Fees that get into the next block whatever it charges: twice the higher of
 * the latest block's base fee and the minimum, plus a one-wei tip.
 *
 * Wallets that price from the latest block alone underbid right after the
 * minimum goes up, which is the case this panel exists to handle.
 */
export const clearingFees = (
    latestBaseFee: bigint,
    minBaseFee: bigint,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } => ({
    maxFeePerGas:
        2n * (latestBaseFee > minBaseFee ? latestBaseFee : minBaseFee),
    maxPriorityFeePerGas: 1n,
});

const signerOn = (source: WalletKeySource, rpcUrl: string) =>
    evmSigner(source).connect(
        new JsonRpcProvider(
            rpcUrl,
            { chainId: CYBERIA_FUJI_CHAIN_ID, name: 'cyberia_fuji' },
            // The public relay takes small batches; one call per request
            // keeps every read inside what it accepts.
            { staticNetwork: true, batchMaxCount: 1 },
        ),
    );

/**
 * Change the fee rules.
 *
 * When the minimum goes above what the latest block charged, every wallet
 * that prices from the latest block (MetaMask and ethers among them) bids too
 * low until a block at the new fee exists — and on an L1 that only makes
 * blocks for transactions, none would come. So the panel makes that block
 * itself: an empty transfer to its own address, priced to clear.
 */
const submitFeeConfigWithSigner = async (
    signer: Signer,
    request: { config: FeeConfig; latestBaseFee: bigint; rpcUrl: string },
): Promise<{ hash: string; nudge: string | null }> => {
    const minBaseFee = BigInt(request.config.minBaseFee);

    const tx = await signer.sendTransaction({
        to: FEE_MANAGER,
        data: feeConfigCalldata(request.config),
        ...clearingFees(request.latestBaseFee, minBaseFee),
    });
    const receipt = await tx.wait();

    if (receipt?.status !== 1) {
        throw new Error(`setFeeConfig failed: ${tx.hash}`);
    }

    if (minBaseFee <= request.latestBaseFee) {
        return { hash: tx.hash, nudge: null };
    }

    const nudge = await signer.sendTransaction({
        to: await signer.getAddress(),
        value: 0n,
        gasLimit: TRANSFER_GAS,
        ...clearingFees(request.latestBaseFee, minBaseFee),
    });
    await nudge.wait();

    return { hash: tx.hash, nudge: nudge.hash };
};

export const submitFeeConfig = async (
    source: WalletKeySource,
    request: { config: FeeConfig; latestBaseFee: bigint; rpcUrl: string },
): Promise<{ hash: string; nudge: string | null }> =>
    submitFeeConfigWithSigner(signerOn(source, request.rpcUrl), request);

/** Use the connected wallet only after verifying both its network and account. */
export const submitConnectedFeeConfig = async (
    address: string,
    request: { config: FeeConfig; latestBaseFee: bigint; rpcUrl: string },
): Promise<{ hash: string; nudge: string | null }> => {
    const provider = getSelectedEvmProvider();
    const chain = EVM_CHAINS.find((item) => item.chainId === FUJI_ID);

    if (!provider || !chain) {
throw new Error('Connect an EVM wallet first');
}

    await ensureEvmChain(provider, chain);
    const currentChain = await provider.request({ method: 'eth_chainId' });

    if (parseInt(String(currentChain), 16) !== FUJI_ID) {
        throw new Error('The wallet did not switch to Cyberia Fuji');
    }

    const signer = await new BrowserProvider(provider).getSigner();

    if ((await signer.getAddress()).toLowerCase() !== address.toLowerCase()) {
        throw new Error('The connected wallet account changed; refresh and review the transaction');
    }

    return submitFeeConfigWithSigner(signer, request);
};

/** Send every fee to one address, or back to each block's producer. */
export const submitFeeRecipient = async (
    source: WalletKeySource,
    request: {
        recipient: string | null;
        latestBaseFee: bigint;
        minBaseFee: bigint;
        rpcUrl: string;
    },
): Promise<string> => {
    const signer = signerOn(source, request.rpcUrl);

    const tx = await signer.sendTransaction({
        to: REWARD_MANAGER,
        data: feeRecipientCalldata(request.recipient),
        ...clearingFees(request.latestBaseFee, request.minBaseFee),
    });
    const receipt = await tx.wait();

    if (receipt?.status !== 1) {
        throw new Error(`RewardManager call failed: ${tx.hash}`);
    }

    return tx.hash;
};
