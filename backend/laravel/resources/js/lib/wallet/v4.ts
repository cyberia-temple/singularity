import {
    AbiCoder,
    Contract,
    Interface,
    JsonRpcProvider,
    ZeroAddress,
    getAddress,
    keccak256,
} from 'ethers';
import type { Provider } from 'ethers';
import { CYBERIA_FUJI_PUBLIC_RPC } from '@/lib/evmChains';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';

/** One verified native/token pool. Fee is in millionths: 20,000 = 2% to LPs. */
export type V4Config = {
    chainId: number;
    manager: string;
    router: string;
    permit2: string;
    quoter: string;
    stateView: string;
    token: string;
    fee: number;
    tickSpacing: number;
};
export const V4_FUJI: V4Config | null = {
    chainId: 49407,
    manager: '0x176C70dD7CF17056596D8c4C7E2b1f2537df978F',
    router: '0x4A769e45654ECeEc46CF2764C7a47EbCfb1CF23c',
    permit2: '0x78272aAd03E4b9d7A9134e874BA6d419B534F6c9',
    quoter: '0xCCA4Ae05A6bf4c8Fcb50eE0B771428DC6A0693D3',
    stateView: '0xfA97C3659958983bD68431CAEf23fa2e9DDcc551',
    token: '0xa084bcd3a16be2cf141b62ea94b330f2db818a1d',
    fee: 20_000,
    tickSpacing: 60,
};
const KEY_TYPE =
    'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const QUOTER = [
    `function quoteExactInputSingle(tuple(${KEY_TYPE} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns (uint256 amountOut,uint256 gasEstimate)`,
    'function poolManager() view returns (address)',
];
const ROUTER = [
    'function poolManager() view returns (address)',
    'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
];
const TOKEN = [
    'function allowance(address,address) view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
];
const PERMIT = [
    'function allowance(address,address,address) view returns (uint160 amount,uint48 expiration,uint48 nonce)',
    'function approve(address token,address spender,uint160 amount,uint48 expiration)',
];
const STATE = [
    'function poolManager() view returns (address)',
    'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)',
];
const SWAP_GAS = 600_000n;
const APPROVAL_GAS = 120_000n;
const MAX_UINT128 = (1n << 128n) - 1n;

export type V4Quote = {
    config: V4Config;
    owner: string;
    nativeIn: boolean;
    amountIn: bigint;
    amountOut: bigint;
    minOut: bigint;
    impactPct: number | null;
    gasPrice: bigint;
    maxFee: bigint;
    deadline: number;
    tokenApproval: boolean;
    permitApproval: boolean;
};

export const v4Provider = (rpc = CYBERIA_FUJI_PUBLIC_RPC): JsonRpcProvider =>
    new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
const key = (config: V4Config) => [
    ZeroAddress,
    getAddress(config.token),
    config.fee,
    config.tickSpacing,
    ZeroAddress,
];

export async function v4Balances(
    provider: Provider,
    config: V4Config,
    owner: string,
): Promise<{ native: bigint; token: bigint }> {
    const [native, token] = await Promise.all([
        provider.getBalance(owner),
        new Contract(config.token, TOKEN, provider).balanceOf(owner),
    ]);
    return { native, token };
}

async function check(
    provider: Provider,
    config: V4Config,
    blockTag?: number,
): Promise<bigint> {
    if (
        (await provider.getNetwork()).chainId !== BigInt(config.chainId) ||
        config.fee !== 20_000 ||
        config.tickSpacing !== 60 ||
        getAddress(config.token) === ZeroAddress
    )
        throw new Error('Invalid network or pool configuration');
    const addresses = [
        config.manager,
        config.router,
        config.permit2,
        config.quoter,
        config.stateView,
        config.token,
    ];
    if (
        (await Promise.all(addresses.map((a) => provider.getCode(a)))).some(
            (code) => code === '0x',
        )
    )
        throw new Error('DEX contracts are not deployed on this network');
    const state = new Contract(config.stateView, STATE, provider);
    const [routerManager, quoterManager, stateManager] = await Promise.all([
        new Contract(config.router, ROUTER, provider).poolManager(),
        new Contract(config.quoter, QUOTER, provider).poolManager(),
        state.poolManager(),
    ]);
    if (
        [routerManager, quoterManager, stateManager].some(
            (address) => getAddress(address) !== getAddress(config.manager),
        )
    )
        throw new Error('DEX contract configuration does not match');
    const poolId = keccak256(
        AbiCoder.defaultAbiCoder().encode([KEY_TYPE], [key(config)]),
    );
    const slot = await state.getSlot0(
        poolId,
        blockTag === undefined ? {} : { blockTag },
    );
    if (
        slot.sqrtPriceX96 === 0n ||
        slot.lpFee !== BigInt(config.fee) ||
        slot.protocolFee !== 0n
    )
        throw new Error('Pool is unavailable or its fee has changed');
    return slot.sqrtPriceX96;
}

async function allowances(
    provider: Provider,
    config: V4Config,
    owner: string,
    amount: bigint,
    deadline: number,
): Promise<{ tokenApproval: boolean; permitApproval: boolean }> {
    const [erc, permit] = await Promise.all([
        new Contract(config.token, TOKEN, provider).allowance(
            owner,
            config.permit2,
        ),
        new Contract(config.permit2, PERMIT, provider).allowance(
            owner,
            config.token,
            config.router,
        ),
    ]);
    return {
        tokenApproval: erc < amount,
        permitApproval: permit.amount < amount || permit.expiration < deadline,
    };
}

export async function quoteV4(
    provider: Provider,
    config: V4Config,
    owner: string,
    nativeIn: boolean,
    amountIn: bigint,
): Promise<V4Quote> {
    if (amountIn <= 0n || amountIn > MAX_UINT128)
        throw new Error('Invalid swap amount');
    owner = getAddress(owner);
    const blockTag = await provider.getBlockNumber();
    const sqrtPrice = await check(provider, config, blockTag);
    const deadline = Math.floor(Date.now() / 1000) + 1200;
    const approvals = nativeIn
        ? { tokenApproval: false, permitApproval: false }
        : await allowances(provider, config, owner, amountIn, deadline);
    const [result, fees] = await Promise.all([
        new Contract(
            config.quoter,
            QUOTER,
            provider,
        ).quoteExactInputSingle.staticCall(
            [key(config), nativeIn, amountIn, '0x'],
            { blockTag },
        ),
        provider.getFeeData(),
    ]);
    if (fees.gasPrice === null || result.amountOut <= 0n)
        throw new Error('Quote or gas price unavailable');
    const minOut = (result.amountOut * 99n) / 100n;
    if (minOut <= 0n) throw new Error('Output too small');
    const priceSquared = sqrtPrice * sqrtPrice;
    const spotOut = nativeIn
        ? (amountIn * priceSquared) / (1n << 192n)
        : (amountIn * (1n << 192n)) / priceSquared;
    const afterFee = (spotOut * 98n) / 100n;
    const impactPct =
        afterFee === 0n
            ? null
            : result.amountOut >= afterFee
              ? 0
              : Number(((afterFee - result.amountOut) * 10_000n) / afterFee) /
                100;
    const gas =
        SWAP_GAS +
        (approvals.tokenApproval ? APPROVAL_GAS : 0n) +
        (approvals.permitApproval ? APPROVAL_GAS : 0n);
    return {
        config: { ...config },
        owner,
        nativeIn,
        amountIn,
        amountOut: result.amountOut,
        minOut,
        impactPct,
        gasPrice: fees.gasPrice,
        maxFee: gas * fees.gasPrice,
        deadline,
        ...approvals,
    };
}

/** The approved quote controls input, minimum output, gas cap and expiry. */
export async function executeV4(
    source: WalletKeySource,
    provider: Provider,
    quote: V4Quote,
    expectedConfig: V4Config | null = V4_FUJI,
    onSubmitted?: (step: 'approval' | 'swap', hash: string) => void,
    onConfirmed?: (
        step: 'approval',
        hash: string,
        outcome: 'confirmed' | 'failed',
    ) => void,
): Promise<string> {
    const signer = evmSigner(source).connect(provider);
    if (
        getAddress(signer.address) !== getAddress(quote.owner) ||
        Math.floor(Date.now() / 1000) >= quote.deadline
    )
        throw new Error('Quote expired or belongs to another account');
    if (
        !expectedConfig ||
        JSON.stringify(quote.config) !== JSON.stringify(expectedConfig)
    )
        throw new Error('DEX configuration changed');
    await check(provider, quote.config);
    const submit = async (
        step: 'approval' | 'swap',
        to: string,
        data: string,
        gasLimit: bigint,
        value = 0n,
    ): Promise<string> => {
        const request = await signer.populateTransaction({
            to,
            data,
            gasLimit,
            gasPrice: quote.gasPrice,
            value,
            type: 0,
        });
        const raw = await signer.signTransaction(request);
        const hash = keccak256(raw);
        onSubmitted?.(step, hash);
        // The signed hash is known before broadcasting. If the response is
        // lost, the UI retains it and never silently creates a replacement.
        await provider.broadcastTransaction(raw);
        return hash;
    };
    if (!quote.nativeIn) {
        const now = await allowances(
            provider,
            quote.config,
            quote.owner,
            quote.amountIn,
            quote.deadline,
        );
        if (
            (now.tokenApproval && !quote.tokenApproval) ||
            (now.permitApproval && !quote.permitApproval)
        )
            throw new Error('Allowances changed; request a new quote');
        if (now.tokenApproval) {
            const data = new Interface(TOKEN).encodeFunctionData('approve', [
                quote.config.permit2,
                quote.amountIn,
            ]);
            const hash = await submit(
                'approval',
                quote.config.token,
                data,
                APPROVAL_GAS,
            );
            const outcome = await awaitV4Outcome(provider, hash);
            onConfirmed?.('approval', hash, outcome);
            if (outcome !== 'confirmed')
                throw new Error(`Token approval failed: ${hash}`);
        }
        if (now.permitApproval) {
            const data = new Interface(PERMIT).encodeFunctionData('approve', [
                quote.config.token,
                quote.config.router,
                quote.amountIn,
                quote.deadline,
            ]);
            const hash = await submit(
                'approval',
                quote.config.permit2,
                data,
                APPROVAL_GAS,
            );
            const outcome = await awaitV4Outcome(provider, hash);
            onConfirmed?.('approval', hash, outcome);
            if (outcome !== 'confirmed')
                throw new Error(`Permit2 approval failed: ${hash}`);
        }
    }
    if (Math.floor(Date.now() / 1000) >= quote.deadline)
        throw new Error('Quote expired after approval');
    const coder = AbiCoder.defaultAbiCoder();
    const swap = coder.encode(
        [
            `tuple(${KEY_TYPE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`,
        ],
        [
            [
                key(quote.config),
                quote.nativeIn,
                quote.amountIn,
                quote.minOut,
                '0x',
            ],
        ],
    );
    const inputCurrency = quote.nativeIn ? ZeroAddress : quote.config.token;
    const outputCurrency = quote.nativeIn ? quote.config.token : ZeroAddress;
    const settle = coder.encode(
        ['address', 'uint256'],
        [inputCurrency, quote.amountIn],
    );
    const take = coder.encode(
        ['address', 'uint256'],
        [outputCurrency, quote.minOut],
    );
    const plan = coder.encode(
        ['bytes', 'bytes[]'],
        ['0x060c0f', [swap, settle, take]],
    );
    const data = new Interface(ROUTER).encodeFunctionData('execute', [
        '0x10',
        [plan],
        quote.deadline,
    ]);
    return submit(
        'swap',
        quote.config.router,
        data,
        SWAP_GAS,
        quote.nativeIn ? quote.amountIn : 0n,
    );
}

/** The L1 can stop producing blocks when idle, so poll receipts, not block events. */
export async function awaitV4Outcome(
    provider: Provider,
    hash: string,
): Promise<'confirmed' | 'failed'> {
    const until = Date.now() + 120_000;
    while (Date.now() < until) {
        const receipt = await provider.getTransactionReceipt(hash);
        if (receipt) return receipt.status === 1 ? 'confirmed' : 'failed';
        await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`Transaction outcome is unknown: ${hash}`);
}
