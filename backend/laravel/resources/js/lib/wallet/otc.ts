import { Contract, JsonRpcProvider, ZeroAddress, getAddress } from 'ethers';
import {
    CYBERIA_FUJI_CHAIN_ID,
    CYBERIA_FUJI_PUBLIC_RPC,
} from '@/lib/evmChains';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';

/**
 * OTC offers: trades at a price somebody names, with no pool in between and
 * no platform fee.
 *
 * `CyberiaOTC` (crypto/hardhat/contracts/CyberiaOTC.sol) holds what a maker
 * sells until a taker pays the stated price for all of it or — if the maker
 * allows — for a part no smaller than `minFill`. The taker's payment goes to
 * the maker in full, in the same transaction; gas is the only cost. The
 * number a taker agrees to is `payFor()`, and it travels into the transaction
 * as `maxPay`, so a reprice that lands first makes the fill revert rather
 * than overpay.
 *
 * A deal discussed in chat becomes binding as a private offer: one side
 * escrows its half and names the other side's address as the only taker.
 *
 * Deployed 2026-10-25, block 134 (crypto/hardhat/deployments/cyberia-otc-49407.json).
 */
export const OTC_ADDRESS: string | null =
    '0xD199e6ae74B992F017f8940B26Fa18A7dD30eE86';

/** The desk lives on the new network, Cyberia Fuji L1. */
export const OTC_CHAIN_ID = CYBERIA_FUJI_CHAIN_ID;

/** `address(0)` in the contract is the native coin. */
export const NATIVE = ZeroAddress;

/**
 * Gas a desk call may spend. A create or a fill is two transfers, a storage
 * write and an event; the cap is what the screen promises, so a call that
 * would cost more is refused instead of signed for the difference.
 */
export const OTC_GAS_CAP = 400_000n;
const APPROVE_GAS = 70_000n;
const GAS_MARGIN = [125n, 100n] as const;

/** How many of the newest offers the book reads. */
const BOOK_DEPTH = 200n;

export type OtcAsset = { address: string; symbol: string };

/**
 * What the picker offers before anyone types an address: the coin and the
 * assets of the new protocol (resources/chaos-protocol.json in lain-labs/backend).
 * Anything else is a pasted contract address, read from the chain.
 */
export const OTC_ASSETS: OtcAsset[] = [
    { address: NATIVE, symbol: 'CYBER' },
    { address: '0x000000000000000000000000000000000000c0fe', symbol: 'WCYBER' },
    { address: '0x1e0537ce7e47947477a5442b9b59113ca9e483c0', symbol: 'ASH' },
    {
        address: '0xa084bcd3a16be2cf141b62ea94b330f2db818a1d',
        symbol: 'AVAX.FUJI',
    },
];

const ORDER_TUPLE =
    'tuple(address maker, address sellToken, address buyToken, address taker, uint256 priceSell, uint256 priceBuy, uint256 remaining, uint256 minFill, uint64 expiry, bool partialFill, bool closed)';

const OTC_ABI = [
    'function create(address sellToken, uint256 sellAmount, address buyToken, uint256 buyAmount, address taker, uint64 expiry, bool partialFill, uint256 minFill) payable returns (uint256)',
    'function fill(uint256 id, uint256 amount, uint256 maxPay) payable',
    'function reprice(uint256 id, uint256 priceSell, uint256 priceBuy)',
    'function topUp(uint256 id, uint256 amount) payable',
    'function reduce(uint256 id, uint256 amount)',
    'function cancel(uint256 id)',
    'function reclaim(uint256 id)',
    `function getOrders(uint256 offset, uint256 limit) view returns (uint256[] ids, ${ORDER_TUPLE}[] page)`,
];

const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
];

export type OtcSide = { address: string; symbol: string; decimals: number };

export type OtcOrder = {
    id: bigint;
    maker: string;
    /** Null when anyone may fill. */
    taker: string | null;
    sell: OtcSide;
    buy: OtcSide;
    /** The price: `priceBuy` of the buy asset per `priceSell` of the sell asset. */
    priceSell: bigint;
    priceBuy: bigint;
    remaining: bigint;
    minFill: bigint;
    /** Unix seconds, null when the offer never expires. */
    expiry: number | null;
    partialFill: boolean;
    /** Past its expiry with something still escrowed: anyone may reclaim it. */
    expired: boolean;
};

/**
 * What a taker pays for `amount` of an offer's sell asset — the contract's
 * `quote()`, rounded up so the maker never sells below the stated price.
 */
export const payFor = (
    order: Pick<OtcOrder, 'priceSell' | 'priceBuy'>,
    amount: bigint,
): bigint =>
    amount === 0n ? 0n : (amount * order.priceBuy - 1n) / order.priceSell + 1n;

/**
 * The most a taker can buy with `budget` of the buy asset, never above what
 * remains — what the screen offers when somebody cannot pay for all of it.
 */
export const affordable = (
    order: Pick<OtcOrder, 'priceSell' | 'priceBuy' | 'remaining'>,
    budget: bigint,
): bigint => {
    const most = (budget * order.priceSell) / order.priceBuy;

    return most < order.remaining ? most : order.remaining;
};

/** Whether `amount` is a fill the contract will accept. */
export const fillAllowed = (
    order: Pick<OtcOrder, 'remaining' | 'minFill' | 'partialFill'>,
    amount: bigint,
): boolean =>
    amount > 0n &&
    amount <= order.remaining &&
    (amount === order.remaining ||
        (order.partialFill && amount >= order.minFill));

/** Largest valid partial fill for a CYBER budget, without exceeding it. */
export const quickCyberFill = (
    order: Pick<
        OtcOrder,
        | 'priceSell'
        | 'priceBuy'
        | 'remaining'
        | 'minFill'
        | 'partialFill'
        | 'buy'
    >,
    budget: bigint,
): bigint | null => {
    if (
        !order.partialFill ||
        order.buy.address.toLowerCase() !== NATIVE.toLowerCase() ||
        budget <= 0n ||
        order.priceBuy <= 0n ||
        order.priceSell <= 0n
    ) {
        return null;
    }

    const value = affordable(order, budget);
    return fillAllowed(order, value) ? value : null;
};

/** An offer a taker can still act on at `now` (unix seconds). */
export const isOpen = (
    order: { closed: boolean; remaining: bigint; expiry: bigint },
    now: number,
): boolean =>
    !order.closed &&
    order.remaining > 0n &&
    (order.expiry === 0n || Number(order.expiry) > now);

/** Text for the chat composer that points the other side at an offer. */
export const discussText = (order: OtcOrder, unitPrice: string): string =>
    `OTC #${order.id}: ${order.sell.symbol} @ ${unitPrice} — https://cyberia.church/wallet?section=otc&offer=${order.id}`;

const isNative = (address: string): boolean =>
    address.toLowerCase() === NATIVE.toLowerCase();

const provider = (rpcUrl?: string): JsonRpcProvider =>
    new JsonRpcProvider(rpcUrl || CYBERIA_FUJI_PUBLIC_RPC, OTC_CHAIN_ID, {
        staticNetwork: true,
    });

const desk = (runner: unknown): Contract => {
    if (!OTC_ADDRESS) {
        throw new Error('The OTC contract is not deployed yet');
    }

    return new Contract(OTC_ADDRESS, OTC_ABI, runner as JsonRpcProvider);
};

const sideCache = new Map<string, Promise<OtcSide>>();

/** Symbol and decimals of one asset, read once per page from its contract. */
export const readSide = (
    address: string,
    rpcUrl?: string,
): Promise<OtcSide> => {
    if (isNative(address)) {
        return Promise.resolve({
            address: NATIVE,
            symbol: 'CYBER',
            decimals: 18,
        });
    }

    const key = address.toLowerCase();
    let pending = sideCache.get(key);

    if (!pending) {
        const token = new Contract(address, ERC20_ABI, provider(rpcUrl));
        pending = Promise.all([token.symbol(), token.decimals()]).then(
            ([symbol, decimals]) => ({
                address: getAddress(address),
                symbol: String(symbol).slice(0, 12),
                decimals: Number(decimals),
            }),
        );
        pending.catch(() => sideCache.delete(key));
        sideCache.set(key, pending);
    }

    return pending;
};

/** What `owner` holds of one asset on the desk's network. */
export const readBalance = async (
    asset: string,
    owner: string,
    rpcUrl?: string,
): Promise<bigint> =>
    isNative(asset)
        ? provider(rpcUrl).getBalance(owner)
        : ((await new Contract(asset, ERC20_ABI, provider(rpcUrl)).balanceOf(
              owner,
          )) as bigint);

type RawOrder = {
    maker: string;
    sellToken: string;
    buyToken: string;
    taker: string;
    priceSell: bigint;
    priceBuy: bigint;
    remaining: bigint;
    minFill: bigint;
    expiry: bigint;
    partialFill: boolean;
    closed: boolean;
};

/**
 * The live part of the book, newest first, plus the expired offers that
 * still hold something — those are shown to their maker with "take back".
 */
export const readOtcBook = async (rpcUrl?: string): Promise<OtcOrder[]> => {
    const [ids, page] = (await desk(provider(rpcUrl)).getOrders(
        0n,
        BOOK_DEPTH,
    )) as [bigint[], RawOrder[]];
    const now = Math.floor(Date.now() / 1_000);
    const orders: OtcOrder[] = [];

    for (const [index, row] of page.entries()) {
        if (row.closed || row.remaining === 0n) {
            continue;
        }

        const [sell, buy] = await Promise.all([
            readSide(row.sellToken, rpcUrl),
            readSide(row.buyToken, rpcUrl),
        ]);

        orders.push({
            id: ids[index],
            maker: getAddress(row.maker),
            taker: isNative(row.taker) ? null : getAddress(row.taker),
            sell,
            buy,
            priceSell: row.priceSell,
            priceBuy: row.priceBuy,
            remaining: row.remaining,
            minFill: row.minFill,
            expiry: row.expiry === 0n ? null : Number(row.expiry),
            partialFill: row.partialFill,
            expired: !isOpen(row, now),
        });
    }

    return orders;
};

export type OtcAction =
    | {
          kind: 'create';
          sell: string;
          sellAmount: bigint;
          buy: string;
          buyAmount: bigint;
          taker: string | null;
          expiry: number | null;
          partialFill: boolean;
          minFill: bigint;
      }
    | { kind: 'fill'; order: OtcOrder; amount: bigint; maxPay: bigint }
    | { kind: 'reprice'; id: bigint; priceSell: bigint; priceBuy: bigint }
    | { kind: 'topUp'; order: OtcOrder; amount: bigint }
    | { kind: 'reduce'; id: bigint; amount: bigint }
    | { kind: 'cancel'; id: bigint }
    | { kind: 'reclaim'; id: bigint };

/** What an action takes out of the signer's wallet, if anything. */
const spendOf = (
    action: OtcAction,
): { token: string; amount: bigint } | null => {
    switch (action.kind) {
        case 'create':
            return { token: action.sell, amount: action.sellAmount };
        case 'fill':
            return { token: action.order.buy.address, amount: action.maxPay };
        case 'topUp':
            return { token: action.order.sell.address, amount: action.amount };
        default:
            return null;
    }
};

const argsOf = (action: OtcAction): unknown[] => {
    switch (action.kind) {
        case 'create':
            return [
                action.sell,
                action.sellAmount,
                action.buy,
                action.buyAmount,
                action.taker ?? NATIVE,
                BigInt(action.expiry ?? 0),
                action.partialFill,
                action.minFill,
            ];
        case 'fill':
            return [action.order.id, action.amount, action.maxPay];
        case 'reprice':
            return [action.id, action.priceSell, action.priceBuy];
        case 'topUp':
            return [action.order.id, action.amount];
        case 'reduce':
            return [action.id, action.amount];
        case 'cancel':
        case 'reclaim':
            return [action.id];
    }
};

/**
 * Sign one desk action. An ERC-20 leg is approved for exactly its amount
 * first — never `MaxUint256` — and the action is sent once that approval is
 * mined. Returns the action's transaction hash.
 */
export const executeOtc = async (
    source: WalletKeySource,
    request: { action: OtcAction; gasPrice: bigint; rpcUrl?: string },
): Promise<string> => {
    const { action, gasPrice } = request;
    const signer = evmSigner(source).connect(provider(request.rpcUrl));
    const contract = desk(signer);
    const owner = await signer.getAddress();
    const spend = spendOf(action);
    /*
     * Set after an approval: the provider caches its nonce answer for a
     * moment, and on a fast chain the approval is mined inside that moment,
     * so asking again would sign the action with the approval's nonce.
     */
    let nonce: number | undefined;

    if (spend && !isNative(spend.token)) {
        const token = new Contract(spend.token, ERC20_ABI, signer);
        const allowance = (await token.allowance(owner, OTC_ADDRESS)) as bigint;

        if (allowance < spend.amount) {
            const approval = await token.approve(OTC_ADDRESS, spend.amount, {
                gasLimit: APPROVE_GAS,
                gasPrice,
            });
            await approval.wait();
            nonce = (approval.nonce as number) + 1;
        }
    }

    const value = spend && isNative(spend.token) ? spend.amount : 0n;
    const args = argsOf(action);
    const method = contract.getFunction(action.kind);
    const overrides = value > 0n ? { value } : {};
    const estimate = await method
        .estimateGas(...args, overrides)
        .catch(() => null);
    const gasLimit =
        estimate === null
            ? OTC_GAS_CAP
            : (estimate * GAS_MARGIN[0]) / GAS_MARGIN[1];

    if (gasLimit > OTC_GAS_CAP) {
        throw new Error(
            'This costs more gas than this wallet will spend on an offer.',
        );
    }

    const tx = await method(...args, {
        ...overrides,
        gasLimit,
        gasPrice,
        ...(nonce === undefined ? {} : { nonce }),
    });

    return tx.hash as string;
};
