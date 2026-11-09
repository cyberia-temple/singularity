import { Contract, Interface, JsonRpcProvider, ZeroAddress } from 'ethers';
import { launchpadChain, launchpadReadRpcUrl } from '@/lib/launchpadChains';
import type { LaunchpadChain } from '@/lib/launchpadChains';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';
import { kitOf } from '@/lib/wallet/launchpad';
import type { LaunchKit } from '@/lib/wallet/launchpad';

/**
 * Running a Cyberia 2.0 token from the wallet: what `crypto/hardhat/scripts/
 * token-admin.ts` does for the old chain's tokens from a terminal, for the
 * tokens the launchpad and the studio made.
 *
 * Everything here is a plain call on a contract anyone can read. Who may do
 * what is the contracts' rule, not this file's: the minter mints and hands the
 * right on, a holder burns their own, anyone collects a position's fees (they
 * go where the lock says) and anyone opens a part of the kit that is not open
 * yet. The screen only offers an action to someone the contract would accept
 * it from, and every action is run as a call first, so a refusal is read with
 * the contract's reason before anything is signed.
 */

const REGISTRY_ABI = [
    'function locker() view returns (address)',
    'function economyOf(address) view returns ((address creator, uint64 launchedAt, address pool, uint256 positionId, address vault, address gauge, address tokenOracle, address cyberOracle, bytes32 borrowCyberMarket, bytes32 borrowTokenMarket, bytes32 borrowAgainstLpMarket, address governor, address timelock, bool zone, string metadataURI))',
    'function openCredit(address)',
    'function openFarm(address)',
    'function openDAO(address)',
];

const TOKEN_ABI = [
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
    'function minter() view returns (address)',
    'function maxSupply() view returns (uint256)',
    'function mint(address to, uint256 amount)',
    'function setMinter(address minter)',
    'function burn(uint256 amount)',
];

const LOCKER_ABI = ['function collect(uint256 tokenId)'];

export type KitPart = 'credit' | 'farm' | 'dao';

export type TokenControl = {
    chainId: number;
    token: string;
    /** The registry that made it: the launchpad or the studio. */
    registry: string;
    /** Where its pool's liquidity is locked and its fees are collected. */
    locker: string;
    creator: string;
    positionId: bigint;
    kit: LaunchKit;
    /** The DAO's timelock — the account that executes what it votes — or null. */
    timelock: string | null;
    /**
     * Who may mint: an address, or null for nobody. A launchpad token never
     * had one; a studio token may have given it up.
     */
    minter: string | null;
    /** The ceiling minting can reach; null where nothing can be minted. */
    maxSupply: bigint | null;
    totalSupply: bigint;
    /** The account's own balance of the token. */
    balance: bigint;
    /** Whether the token has `burn` — the studio's do, the launchpad's do not. */
    burnable: boolean;
};

export type TokenAction =
    | { kind: 'mint'; to: string; amount: bigint }
    | { kind: 'setMinter'; minter: string }
    | { kind: 'burn'; amount: bigint }
    | { kind: 'collect' }
    | { kind: 'open'; part: KitPart };

const providerFor = (target: LaunchpadChain): JsonRpcProvider =>
    new JsonRpcProvider(launchpadReadRpcUrl(target), target.chain.chainId, {
        staticNetwork: true,
        batchMaxCount: 20,
    });

const same = (a: string | null | undefined, b: string | null | undefined) =>
    Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();

/**
 * Read one token's controls, for `account`. Null when neither registry on the
 * chain made it.
 */
export const readTokenControl = async (
    chainId: number,
    token: string,
    account: string | null,
): Promise<TokenControl | null> => {
    const target = launchpadChain(chainId);

    if (!target) {
        return null;
    }

    const provider = providerFor(target);
    const registries = [target.tokenStudio, target.launchpadKit].filter(
        (entry): entry is string => Boolean(entry),
    );

    for (const registry of registries) {
        const contract = new Contract(registry, REGISTRY_ABI, provider);
        const economy = (await contract.economyOf(token).catch(() => null)) as {
            creator: string;
            pool: string;
            positionId: bigint;
            gauge: string;
            tokenOracle: string;
            governor: string;
            timelock: string;
            zone: boolean;
        } | null;

        if (!economy || economy.pool === ZeroAddress) {
            continue;
        }

        const erc20 = new Contract(token, TOKEN_ABI, provider);
        const studio = same(registry, target.tokenStudio);
        const [locker, totalSupply, balance, minter, maxSupply] =
            await Promise.all([
                contract.locker() as Promise<string>,
                erc20.totalSupply() as Promise<bigint>,
                account
                    ? (erc20.balanceOf(account) as Promise<bigint>)
                    : Promise.resolve(0n),
                studio
                    ? (erc20.minter() as Promise<string>)
                    : Promise.resolve(ZeroAddress),
                studio
                    ? (erc20.maxSupply() as Promise<bigint>)
                    : Promise.resolve(null),
            ]);

        return {
            chainId,
            token,
            registry,
            locker,
            creator: economy.creator,
            positionId: economy.positionId,
            kit: kitOf(economy),
            timelock:
                economy.timelock === ZeroAddress ? null : economy.timelock,
            minter: minter === ZeroAddress ? null : minter,
            maxSupply: minter === ZeroAddress ? null : maxSupply,
            totalSupply,
            balance,
            burnable: studio,
        };
    }

    return null;
};

/** What `account` may do with a token, as the contracts would see it. */
export const tokenRights = (
    control: TokenControl,
    account: string | null,
): {
    mint: boolean;
    handOver: boolean;
    burn: boolean;
    collect: boolean;
    open: KitPart[];
} => {
    const isMinter = same(control.minter, account);
    const room =
        control.maxSupply === null
            ? 0n
            : control.maxSupply - control.totalSupply;

    return {
        mint: isMinter && room > 0n,
        handOver: isMinter,
        burn: control.burnable && control.balance > 0n,
        // Anyone may collect, and it pays the lock's shares wherever the
        // lock says; it is offered to the one it pays most directly.
        collect: same(control.creator, account),
        open: (['credit', 'farm', 'dao'] as const).filter(
            (part) => !control.kit[part],
        ),
    };
};

/** How much more can be minted, or null where nothing can. */
export const mintRoom = (control: TokenControl): bigint | null =>
    control.maxSupply === null
        ? null
        : control.maxSupply > control.totalSupply
          ? control.maxSupply - control.totalSupply
          : 0n;

const registryIface = new Interface(REGISTRY_ABI);
const tokenIface = new Interface(TOKEN_ABI);
const lockerIface = new Interface(LOCKER_ABI);

/**
 * The call an action is, as a contract and its calldata. Pure, so the
 * encoding is pinned by a test against the deployed signatures.
 */
export const tokenActionCall = (
    control: TokenControl,
    action: TokenAction,
): { to: string; data: string } => {
    switch (action.kind) {
        case 'mint':
            return {
                to: control.token,
                data: tokenIface.encodeFunctionData('mint', [
                    action.to,
                    action.amount,
                ]),
            };
        case 'setMinter':
            return {
                to: control.token,
                data: tokenIface.encodeFunctionData('setMinter', [
                    action.minter,
                ]),
            };
        case 'burn':
            return {
                to: control.token,
                data: tokenIface.encodeFunctionData('burn', [action.amount]),
            };
        case 'collect':
            return {
                to: control.locker,
                data: lockerIface.encodeFunctionData('collect', [
                    control.positionId,
                ]),
            };
        case 'open':
            return {
                to: control.registry,
                data: registryIface.encodeFunctionData(
                    action.part === 'credit'
                        ? 'openCredit'
                        : action.part === 'farm'
                          ? 'openFarm'
                          : 'openDAO',
                    [control.token],
                ),
            };
    }
};

/**
 * Gas when the node will not estimate. Opening credit makes three oracles and
 * three markets; a farm deploys a gauge; a DAO clones a governor and a
 * timelock. The rest are a transfer or two.
 */
const FALLBACK_GAS: Record<TokenAction['kind'] | KitPart, bigint> = {
    mint: 250_000n,
    setMinter: 120_000n,
    burn: 200_000n,
    collect: 800_000n,
    open: 6_000_000n,
    credit: 6_000_000n,
    farm: 5_000_000n,
    dao: 3_000_000n,
};

const GAS_CAP = 19_000_000n;
const GAS_MARGIN = [125n, 100n] as const;

export type TokenActionQuote = {
    control: TokenControl;
    action: TokenAction;
    to: string;
    data: string;
    gasLimit: bigint;
    gasPrice: bigint;
    fee: bigint;
};

/** Refusals the screen can name. */
export class TokenActionRefused extends Error {
    readonly code: 'funds' | 'reverted';

    constructor(code: 'funds' | 'reverted', detail = '') {
        super(detail || code);
        this.code = code;
    }
}

const reasonOf = (error: unknown): string => {
    const shaped = error as {
        reason?: string | null;
        shortMessage?: string;
        message?: string;
    };

    return (
        shaped.reason ??
        shaped.shortMessage ??
        shaped.message ??
        String(error)
    ).slice(0, 200);
};

/**
 * Run an action as a call from `account`, then price it. Nothing is signed;
 * a refusal carries the contract's own reason.
 */
export const quoteTokenAction = async (request: {
    control: TokenControl;
    action: TokenAction;
    account: string;
    gasPrice: bigint;
}): Promise<TokenActionQuote> => {
    const { control, action, account, gasPrice } = request;
    const target = launchpadChain(control.chainId);

    if (!target) {
        throw new TokenActionRefused('reverted', 'Unknown network');
    }

    const provider = providerFor(target);
    const call = tokenActionCall(control, action);

    try {
        await provider.call({ ...call, from: account });
    } catch (error) {
        throw new TokenActionRefused('reverted', reasonOf(error));
    }

    const estimate = await provider
        .estimateGas({ ...call, from: account })
        .catch(() => null);
    const fallback =
        FALLBACK_GAS[action.kind === 'open' ? action.part : action.kind];
    const gasLimit =
        estimate === null
            ? fallback
            : (estimate * GAS_MARGIN[0]) / GAS_MARGIN[1];
    const fee = (gasLimit > GAS_CAP ? GAS_CAP : gasLimit) * gasPrice;

    if ((await provider.getBalance(account)) < fee) {
        throw new TokenActionRefused('funds');
    }

    return {
        control,
        action,
        ...call,
        gasLimit: gasLimit > GAS_CAP ? GAS_CAP : gasLimit,
        gasPrice,
        fee,
    };
};

/** Sign and send a quoted action. Returns the transaction hash. */
export const executeTokenAction = async (
    source: WalletKeySource,
    request: { quote: TokenActionQuote; rpcUrl?: string },
): Promise<string> => {
    const { quote } = request;
    const target = launchpadChain(quote.control.chainId);

    if (!target) {
        throw new Error('Unknown network');
    }

    const provider = request.rpcUrl
        ? new JsonRpcProvider(request.rpcUrl, quote.control.chainId, {
              staticNetwork: true,
          })
        : providerFor(target);
    const signer = evmSigner(source).connect(provider);
    const tx = await signer.sendTransaction({
        to: quote.to,
        data: quote.data,
        gasLimit: quote.gasLimit,
        gasPrice: quote.gasPrice,
    });

    return tx.hash;
};

/** Wait for an action to be mined: true when it went through. */
export const awaitTokenAction = async (
    chainId: number,
    hash: string,
): Promise<boolean> => {
    const target = launchpadChain(chainId);

    if (!target) {
        return false;
    }

    const receipt = await providerFor(target).waitForTransaction(
        hash,
        1,
        120_000,
    );

    return receipt?.status === 1;
};
