import {
    Contract,
    Interface,
    JsonRpcProvider,
    ZeroAddress,
    getAddress,
    isHexString,
    parseUnits,
} from 'ethers';
import {
    CYBERIA_FUJI_CHAIN_ID,
    CYBERIA_FUJI_PUBLIC_RPC,
} from '@/lib/evmChains';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';

// The gateway deployed by contracts/avalanche-v2 on Cyberia Fuji.
export const TOKEN_GATEWAY = '0xC619D0DA0811a1513eF23EB1abCFfB818540Dbee';
export const gatewayAbi = new Interface([
    'event WrappedCreated(address indexed token,string symbol,uint8 decimals,uint64 originChain,bytes32 originId)',
    'function authority() view returns (address)',
    'function paused() view returns (bool)',
    'function assets(address) view returns (uint8 kind,bool outboundEnabled,uint128 capacity,uint128 refillPerSecond,uint128 available,uint64 lastRefill,uint128 minOut)',
    'function availableToRelease(address) view returns (uint256)',
    'function released(bytes32) view returns (bool)',
    'function outboundCount() view returns (uint256)',
    'function outbound(uint256) view returns (tuple(address sender,address token,uint128 amount,uint64 destChain,uint64 createdAt,uint8 status,bytes recipient))',
    'function createWrapped(string name,string symbol,uint8 decimals,uint64 originChain,bytes32 originId) returns (address)',
    'function setAsset(address token,uint8 kind,uint128 capacity,uint128 refillPerSecond,bool outboundEnabled,uint128 minOut)',
    'function release(address token,address to,uint256 amount,bytes32 sourceId)',
    'function finalize(uint256 nonce,bytes32 payoutRef)',
]);
const tokenAbi = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function originChain() view returns (uint64)',
    'function originId() view returns (bytes32)',
];
const authorityAbi = [
    'function canCall(address caller,address target,bytes4 selector) view returns (bool immediate,uint32 delay)',
];

export type AdminOperation =
    | 'createWrapped'
    | 'setAsset'
    | 'release'
    | 'finalize';
export type AdminRequest = {
    operation: AdminOperation;
    args: (string | number | boolean | bigint)[];
    account: string;
};
export type AdminToken = {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    supply: bigint;
    originChain: bigint;
    originId: string;
    capacity: bigint;
    refill: bigint;
    available: bigint;
    minOut: bigint;
    outboundEnabled: boolean;
};

export const provider = (rpc = CYBERIA_FUJI_PUBLIC_RPC): JsonRpcProvider =>
    new JsonRpcProvider(rpc, undefined, { batchMaxCount: 1 });
export async function checkedProvider(
    rpc = CYBERIA_FUJI_PUBLIC_RPC,
): Promise<JsonRpcProvider> {
    const p = provider(rpc);

    if ((await p.getNetwork()).chainId !== BigInt(CYBERIA_FUJI_CHAIN_ID)) {
        throw new Error('RPC is not Cyberia Fuji (49407)');
    }

    if ((await p.getCode(TOKEN_GATEWAY)) === '0x') {
        throw new Error('Gateway is not deployed on this network');
    }

    return p;
}
export const checkedAddress = (value: string): string => {
    const address = getAddress(value.trim());

    if (address === ZeroAddress) {
        throw new Error('The zero address is not allowed');
    }

    return address;
};
export const checkedHash = (value: string): string => {
    const hash = value.trim();

    if (!isHexString(hash, 32) || /^0x0{64}$/i.test(hash)) {
        throw new Error(
            'Enter a nonzero 32-byte reference (0x followed by 64 hex digits)',
        );
    }

    return hash;
};
export const units = (
    value: string,
    decimals: number,
    allowZero = false,
): bigint => {
    if (!/^\d+(\.\d+)?$/.test(value.trim())) {
        throw new Error('Enter a decimal amount');
    }

    const amount = parseUnits(value.trim(), decimals);

    if (amount < 0n || (!allowZero && amount === 0n)) {
        throw new Error('Amount must be greater than zero');
    }

    return amount;
};
export async function readTokens(): Promise<{
    tokens: AdminToken[];
    paused: boolean;
}> {
    const p = await checkedProvider();
    const gateway = new Contract(TOKEN_GATEWAY, gatewayAbi, p);
    const logs = await p.getLogs({
        address: TOKEN_GATEWAY,
        fromBlock: 0,
        toBlock: 'latest',
        topics: [gatewayAbi.getEvent('WrappedCreated')!.topicHash],
    });
    const tokens = await Promise.all(
        logs.map(async (log) => {
            const address = getAddress(gatewayAbi.parseLog(log)!.args.token);
            const token = new Contract(address, tokenAbi, p);
            const [
                name,
                symbol,
                decimals,
                supply,
                originChain,
                originId,
                asset,
                available,
            ] = await Promise.all([
                token.name(),
                token.symbol(),
                token.decimals(),
                token.totalSupply(),
                token.originChain(),
                token.originId(),
                gateway.assets(address),
                gateway.availableToRelease(address),
            ]);

            return {
                address,
                name: String(name),
                symbol: String(symbol),
                decimals: Number(decimals),
                supply: BigInt(supply),
                originChain: BigInt(originChain),
                originId: String(originId),
                capacity: BigInt(asset.capacity),
                refill: BigInt(asset.refillPerSecond),
                available: BigInt(available),
                minOut: BigInt(asset.minOut),
                outboundEnabled: Boolean(asset.outboundEnabled),
            };
        }),
    );

    return { tokens, paused: Boolean(await gateway.paused()) };
}
export async function prepareOperation(
    request: AdminRequest,
    rpc = CYBERIA_FUJI_PUBLIC_RPC,
): Promise<{ gas: bigint; maxFee: bigint | null }> {
    const p = await checkedProvider(rpc);
    const account = checkedAddress(request.account);
    const gateway = new Contract(TOKEN_GATEWAY, gatewayAbi, p);
    const authority = new Contract(await gateway.authority(), authorityAbi, p);
    const data = gatewayAbi.encodeFunctionData(request.operation, request.args);
    const permission = await authority.canCall(
        account,
        TOKEN_GATEWAY,
        data.slice(0, 10),
    );

    if (!permission.immediate) {
        throw new Error(
            Number(permission.delay)
                ? `This account requires a scheduled authority operation (${permission.delay} seconds); direct signing is unavailable`
                : 'This account has no permission for this operation',
        );
    }

    // Simulation detects unsupported calls, insufficient limits, duplicate references and reverts.
    await p.call({ from: account, to: TOKEN_GATEWAY, data });
    const gas = await p.estimateGas({ from: account, to: TOKEN_GATEWAY, data });
    const fees = await p.getFeeData();
    const price = fees.maxFeePerGas ?? fees.gasPrice;

    return { gas, maxFee: price === null ? null : gas * price };
}
export async function submitOperation(
    source: WalletKeySource,
    request: AdminRequest,
    rpc: string,
): Promise<string> {
    const p = await checkedProvider(rpc);
    const signer = evmSigner(source).connect(p);

    if (
        (await signer.getAddress()).toLowerCase() !==
        checkedAddress(request.account).toLowerCase()
    ) {
        throw new Error(
            'The active account changed; review the operation again',
        );
    }

    await prepareOperation(request, rpc);
    const tx = await signer.sendTransaction({
        to: TOKEN_GATEWAY,
        data: gatewayAbi.encodeFunctionData(request.operation, request.args),
    });

    return tx.hash;
}
export async function receiptStatus(
    hash: string,
): Promise<'pending' | 'confirmed' | 'failed'> {
    const p = await checkedProvider();
    const receipt = await p.getTransactionReceipt(hash);

    return receipt === null
        ? 'pending'
        : receipt.status === 1
          ? 'confirmed'
          : 'failed';
}
export async function readOutbound(nonce: bigint): Promise<{
    sender: string;
    token: string;
    amount: bigint;
    destChain: bigint;
    status: number;
    recipient: string;
}> {
    const p = await checkedProvider();
    const result = await new Contract(TOKEN_GATEWAY, gatewayAbi, p).outbound(
        nonce,
    );

    return {
        sender: getAddress(result.sender),
        token: getAddress(result.token),
        amount: BigInt(result.amount),
        destChain: BigInt(result.destChain),
        status: Number(result.status),
        recipient: String(result.recipient),
    };
}
