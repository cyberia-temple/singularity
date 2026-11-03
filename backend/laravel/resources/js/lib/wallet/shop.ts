import {
    Contract,
    JsonRpcProvider,
    ZeroAddress,
    getAddress,
    hexlify,
    toUtf8Bytes,
    toUtf8String,
} from 'ethers';
import {
    CYBERIA_FUJI_CHAIN_ID,
    CYBERIA_FUJI_PUBLIC_RPC,
} from '@/lib/evmChains';
import type { ChatEnvelope, ChatMeta } from '@/lib/wallet/chatCrypto';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';

/**
 * The shop: digital goods — keys, subscriptions, accounts, gift cards,
 * domains, hosting, AI credits — sold through escrow on the NFT market.
 *
 * `CyberiaShop` (crypto/hardhat/contracts/CyberiaShop.sol) holds the payment
 * while the seller delivers. The good is a secret, so it never sits on chain
 * in the clear: the buyer names their chat key when buying, the seller
 * named theirs when listing, and the secret is sealed under the key those two
 * share — the wallet chat's own scheme, so nothing new needs a backup. Only
 * the `Delivered` event carries it, and the order records the block.
 *
 * The buyer confirms, or the dispute window passes and anyone may release;
 * a seller who never delivers is refunded whole after the delivery window. A
 * dispute goes to a moderator. 2% of what a seller receives goes to the
 * project's fee address; a refund carries no fee.
 *
 * Until the contract is deployed `SHOP_ADDRESS` is null and the screen says so.
 */
export const SHOP_ADDRESS: string | null = '0xb0ac30907c04b61f1482e62ea66ef4562a690917';

export const SHOP_CHAIN_ID = CYBERIA_FUJI_CHAIN_ID;

export const NATIVE = ZeroAddress;

export const SHOP_GAS_CAP = 500_000n;
const APPROVE_GAS = 70_000n;
const GAS_MARGIN = [125n, 100n] as const;
const PAGE = 200n;

/** Contract order — never reorder, the index is what is stored. */
export const SHOP_CATEGORIES = [
    'key',
    'subscription',
    'account',
    'giftCard',
    'domain',
    'hosting',
    'aiCredits',
    'other',
] as const;

export type ShopCategory = (typeof SHOP_CATEGORIES)[number];

export type ShopState =
    | 'none'
    | 'paid'
    | 'delivered'
    | 'disputed'
    | 'released'
    | 'refunded'
    | 'resolved';

const STATES: ShopState[] = [
    'none',
    'paid',
    'delivered',
    'disputed',
    'released',
    'refunded',
    'resolved',
];

/** What a lot says about itself, pinned to IPFS by the seller's browser. */
export type ShopLotMeta = {
    title: string;
    description: string;
    /** What the buyer gets and how: "Steam key, region EU", "login + email". */
    delivers: string;
};

const LISTING_TUPLE =
    'tuple(address seller, address payToken, uint256 price, uint32 stock, uint32 sold, uint8 category, bool closed, bool hidden, uint16 reports, address nft, uint256 nftId, bytes sellerKey, string uri)';
const ORDER_TUPLE =
    'tuple(uint256 listingId, address buyer, address payToken, uint256 amount, uint8 state, uint64 paidAt, uint64 deliveredAt, uint64 deliveredBlock, bytes buyerKey)';

const SHOP_ABI = [
    'function list(address payToken, uint256 price, uint32 stock, uint8 category, bytes sellerKey, string uri, address nft, uint256 nftId) returns (uint256)',
    'function update(uint256 id, uint256 price, uint32 stock)',
    'function close(uint256 id)',
    'function buy(uint256 id, bytes buyerKey, uint256 maxPrice) payable returns (uint256)',
    'function deliver(uint256 orderId, bytes envelope)',
    'function confirm(uint256 orderId)',
    'function dispute(uint256 orderId)',
    'function refund(uint256 orderId)',
    'function release(uint256 orderId)',
    'function sellerRefund(uint256 orderId)',
    'function report(uint256 id, string reason)',
    'function deliveryWindow() view returns (uint64)',
    'function disputeWindow() view returns (uint64)',
    'function feeBps() view returns (uint16)',
    `function getListings(uint256 offset, uint256 limit) view returns (uint256[] ids, ${LISTING_TUPLE}[] page)`,
    `function getOrders(uint256 offset, uint256 limit) view returns (uint256[] ids, ${ORDER_TUPLE}[] page)`,
    'event Delivered(uint256 indexed orderId, bytes envelope)',
];

const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
];
const ERC721_ABI = [
    'function approve(address to, uint256 tokenId)',
    'function getApproved(uint256 tokenId) view returns (address)',
];

export type ShopAsset = { address: string; symbol: string; decimals: number };

export type ShopListing = {
    id: bigint;
    seller: string;
    pay: ShopAsset;
    price: bigint;
    stock: number;
    sold: number;
    category: ShopCategory;
    closed: boolean;
    hidden: boolean;
    reports: number;
    /** The escrowed ERC-721 that goes with the sale, if any. */
    nft: { contract: string; tokenId: bigint } | null;
    sellerKey: string;
    uri: string;
};

export type ShopOrder = {
    id: bigint;
    listingId: bigint;
    buyer: string;
    pay: ShopAsset;
    amount: bigint;
    state: ShopState;
    paidAt: number;
    deliveredAt: number;
    deliveredBlock: number;
    buyerKey: string;
};

export type ShopTerms = {
    deliveryWindow: number;
    disputeWindow: number;
    feeBps: number;
};

/**
 * What may not be sold here. Shown above the listing form and above every
 * report, and the reason a moderator hides a lot: an account or a key that
 * was not the seller's to sell is stolen goods whatever the price.
 */
export const SHOP_FORBIDDEN = [
    'stolen',
    'cracked',
    'personalData',
    'banned',
    'illegal',
] as const;

/**
 * The metadata of the one message a delivery is.
 *
 * Bound to the order, so an envelope delivered for one order cannot be
 * replayed as the delivery of another: AES-GCM authenticates these fields.
 */
export const deliveryMeta = (
    orderId: bigint,
    seller: string,
    buyer: string,
): ChatMeta => ({
    id: `shop:${orderId}`,
    from: seller.toLowerCase(),
    to: buyer.toLowerCase(),
    sentAt: `order:${orderId}`,
});

/** The bytes the contract carries: the envelope as UTF-8 JSON. */
export const encodeEnvelope = (envelope: ChatEnvelope): string =>
    hexlify(toUtf8Bytes(JSON.stringify(envelope)));

export const decodeEnvelope = (data: string): ChatEnvelope => {
    const value = JSON.parse(toUtf8String(data)) as Partial<ChatEnvelope>;

    if (typeof value.iv !== 'string' || typeof value.body !== 'string') {
        throw new Error('That delivery is not an envelope');
    }

    return { iv: value.iv, body: value.body };
};

/** What the seller is paid for an amount: the contract's own rounding. */
export const sellerGets = (amount: bigint, feeBps: number): bigint =>
    amount - (amount * BigInt(feeBps)) / 10_000n;

/** Seconds until an order's next deadline, or null when none applies. */
export const deadlineOf = (
    order: Pick<ShopOrder, 'state' | 'paidAt' | 'deliveredAt'>,
    terms: ShopTerms,
): number | null => {
    if (order.state === 'paid') {
        return order.paidAt + terms.deliveryWindow;
    }

    if (order.state === 'delivered') {
        return order.deliveredAt + terms.disputeWindow;
    }

    return null;
};

/** What the person looking at an order may do to it right now. */
export const orderActions = (
    order: Pick<ShopOrder, 'state' | 'paidAt' | 'deliveredAt' | 'buyer'>,
    seller: string,
    viewer: string,
    terms: ShopTerms,
    now: number,
): Array<
    'deliver' | 'confirm' | 'dispute' | 'refund' | 'release' | 'sellerRefund'
> => {
    const isBuyer = viewer.toLowerCase() === order.buyer.toLowerCase();
    const isSeller = viewer.toLowerCase() === seller.toLowerCase();
    const deadline = deadlineOf(order, terms);
    const past = deadline !== null && now >= deadline;
    const actions: ReturnType<typeof orderActions> = [];

    if (isSeller && order.state === 'paid') {
        actions.push('deliver');
    }

    if (
        isBuyer &&
        (order.state === 'delivered' || order.state === 'disputed')
    ) {
        actions.push('confirm');
    }

    if (isBuyer && order.state === 'delivered' && !past) {
        actions.push('dispute');
    }

    if (isBuyer && order.state === 'paid' && past) {
        actions.push('refund');
    }

    if (order.state === 'delivered' && past) {
        actions.push('release');
    }

    if (
        isSeller &&
        (order.state === 'paid' ||
            order.state === 'delivered' ||
            order.state === 'disputed')
    ) {
        actions.push('sellerRefund');
    }

    return actions;
};

const isNative = (address: string): boolean =>
    address.toLowerCase() === NATIVE.toLowerCase();

const provider = (rpcUrl?: string): JsonRpcProvider =>
    new JsonRpcProvider(rpcUrl || CYBERIA_FUJI_PUBLIC_RPC, SHOP_CHAIN_ID, {
        staticNetwork: true,
    });

const shop = (runner: unknown): Contract => {
    if (!SHOP_ADDRESS) {
        throw new Error('The shop contract is not deployed yet');
    }

    return new Contract(SHOP_ADDRESS, SHOP_ABI, runner as JsonRpcProvider);
};

const assetCache = new Map<string, Promise<ShopAsset>>();

export const readAsset = (
    address: string,
    rpcUrl?: string,
): Promise<ShopAsset> => {
    if (isNative(address)) {
        return Promise.resolve({
            address: NATIVE,
            symbol: 'CYBER',
            decimals: 18,
        });
    }

    const key = address.toLowerCase();
    let pending = assetCache.get(key);

    if (!pending) {
        const token = new Contract(address, ERC20_ABI, provider(rpcUrl));
        pending = Promise.all([token.symbol(), token.decimals()]).then(
            ([symbol, decimals]) => ({
                address: getAddress(address),
                symbol: String(symbol).slice(0, 12),
                decimals: Number(decimals),
            }),
        );
        pending.catch(() => assetCache.delete(key));
        assetCache.set(key, pending);
    }

    return pending;
};

export const readShopTerms = async (rpcUrl?: string): Promise<ShopTerms> => {
    const contract = shop(provider(rpcUrl));
    const [delivery, dispute, fee] = await Promise.all([
        contract.deliveryWindow(),
        contract.disputeWindow(),
        contract.feeBps(),
    ]);

    return {
        deliveryWindow: Number(delivery),
        disputeWindow: Number(dispute),
        feeBps: Number(fee),
    };
};

type RawListing = {
    seller: string;
    payToken: string;
    price: bigint;
    stock: bigint;
    sold: bigint;
    category: bigint;
    closed: boolean;
    hidden: boolean;
    reports: bigint;
    nft: string;
    nftId: bigint;
    sellerKey: string;
    uri: string;
};

type RawOrder = {
    listingId: bigint;
    buyer: string;
    payToken: string;
    amount: bigint;
    state: bigint;
    paidAt: bigint;
    deliveredAt: bigint;
    deliveredBlock: bigint;
    buyerKey: string;
};

/** The newest lots, closed ones included — a buyer's order still names them. */
export const readListings = async (rpcUrl?: string): Promise<ShopListing[]> => {
    const [ids, page] = (await shop(provider(rpcUrl)).getListings(
        0n,
        PAGE,
    )) as [bigint[], RawListing[]];

    return Promise.all(
        page.map(async (row, index) => ({
            id: ids[index],
            seller: getAddress(row.seller),
            pay: await readAsset(row.payToken, rpcUrl),
            price: row.price,
            stock: Number(row.stock),
            sold: Number(row.sold),
            category: SHOP_CATEGORIES[Number(row.category)] ?? 'other',
            closed: row.closed,
            hidden: row.hidden,
            reports: Number(row.reports),
            nft: isNative(row.nft)
                ? null
                : { contract: getAddress(row.nft), tokenId: row.nftId },
            sellerKey: hexlify(row.sellerKey),
            uri: row.uri,
        })),
    );
};

/** Orders `viewer` is a party to, as buyer or as seller of the lot. */
export const readOrders = async (
    viewer: string,
    listings: ShopListing[],
    rpcUrl?: string,
): Promise<ShopOrder[]> => {
    const [ids, page] = (await shop(provider(rpcUrl)).getOrders(0n, PAGE)) as [
        bigint[],
        RawOrder[],
    ];
    const self = viewer.toLowerCase();
    const sellerOf = new Map(
        listings.map((listing) => [listing.id, listing.seller.toLowerCase()]),
    );
    const orders: ShopOrder[] = [];

    for (const [index, row] of page.entries()) {
        if (
            row.buyer.toLowerCase() !== self &&
            sellerOf.get(row.listingId) !== self
        ) {
            continue;
        }

        orders.push({
            id: ids[index],
            listingId: row.listingId,
            buyer: getAddress(row.buyer),
            pay: await readAsset(row.payToken, rpcUrl),
            amount: row.amount,
            state: STATES[Number(row.state)] ?? 'none',
            paidAt: Number(row.paidAt),
            deliveredAt: Number(row.deliveredAt),
            deliveredBlock: Number(row.deliveredBlock),
            buyerKey: hexlify(row.buyerKey),
        });
    }

    return orders;
};

/** The sealed delivery of one order, read from the one block it is in. */
export const readDelivery = async (
    order: Pick<ShopOrder, 'id' | 'deliveredBlock'>,
    rpcUrl?: string,
): Promise<ChatEnvelope | null> => {
    if (order.deliveredBlock === 0) {
        return null;
    }

    const contract = shop(provider(rpcUrl));
    const logs = await contract.queryFilter(
        contract.filters.Delivered(order.id),
        order.deliveredBlock,
        order.deliveredBlock,
    );
    const log = logs[0] as { args?: { envelope?: string } } | undefined;

    return log?.args?.envelope ? decodeEnvelope(log.args.envelope) : null;
};

export type ShopAction =
    | {
          kind: 'list';
          payToken: string;
          price: bigint;
          stock: number;
          category: ShopCategory;
          sellerKey: string;
          uri: string;
          nft: { contract: string; tokenId: bigint } | null;
      }
    | { kind: 'update'; id: bigint; price: bigint; stock: number }
    | { kind: 'close'; id: bigint }
    | { kind: 'buy'; listing: ShopListing; buyerKey: string }
    | { kind: 'deliver'; orderId: bigint; envelope: string }
    | {
          kind: 'confirm' | 'dispute' | 'refund' | 'release' | 'sellerRefund';
          orderId: bigint;
      }
    | { kind: 'report'; id: bigint; reason: string };

const argsOf = (action: ShopAction): unknown[] => {
    switch (action.kind) {
        case 'list':
            return [
                action.payToken,
                action.price,
                action.stock,
                SHOP_CATEGORIES.indexOf(action.category),
                action.sellerKey,
                action.uri,
                action.nft?.contract ?? NATIVE,
                action.nft?.tokenId ?? 0n,
            ];
        case 'update':
            return [action.id, action.price, action.stock];
        case 'close':
            return [action.id];
        case 'buy':
            return [action.listing.id, action.buyerKey, action.listing.price];
        case 'deliver':
            return [action.orderId, action.envelope];
        case 'report':
            return [action.id, action.reason];
        default:
            return [action.orderId];
    }
};

/**
 * Sign one shop action. A token price is approved for exactly the price —
 * never `MaxUint256` — and a lot's NFT for exactly that token, each mined
 * before the action is sent. Returns the action's transaction hash.
 */
export const executeShop = async (
    source: WalletKeySource,
    request: { action: ShopAction; gasPrice: bigint; rpcUrl?: string },
): Promise<string> => {
    const { action, gasPrice } = request;
    const signer = evmSigner(source).connect(provider(request.rpcUrl));
    const contract = shop(signer);
    const owner = await signer.getAddress();
    // Explicit after an approval: on a fast chain the provider's cached nonce
    // would sign the action with the approval's (found on the OTC desk).
    let nonce: number | undefined;
    let value = 0n;

    if (action.kind === 'buy') {
        const pay = action.listing.pay.address;

        if (isNative(pay)) {
            value = action.listing.price;
        } else {
            const token = new Contract(pay, ERC20_ABI, signer);
            const allowance = (await token.allowance(
                owner,
                SHOP_ADDRESS,
            )) as bigint;

            if (allowance < action.listing.price) {
                const approval = await token.approve(
                    SHOP_ADDRESS,
                    action.listing.price,
                    { gasLimit: APPROVE_GAS, gasPrice },
                );
                await approval.wait();
                nonce = (approval.nonce as number) + 1;
            }
        }
    }

    if (action.kind === 'list' && action.nft) {
        const nft = new Contract(action.nft.contract, ERC721_ABI, signer);
        const approved = (await nft.getApproved(action.nft.tokenId)) as string;

        if (approved.toLowerCase() !== String(SHOP_ADDRESS).toLowerCase()) {
            const approval = await nft.approve(
                SHOP_ADDRESS,
                action.nft.tokenId,
                {
                    gasLimit: APPROVE_GAS,
                    gasPrice,
                },
            );
            await approval.wait();
            nonce = (approval.nonce as number) + 1;
        }
    }

    const args = argsOf(action);
    const method = contract.getFunction(action.kind);
    const overrides = value > 0n ? { value } : {};
    const estimate = await method
        .estimateGas(...args, overrides)
        .catch(() => null);
    const gasLimit =
        estimate === null
            ? SHOP_GAS_CAP
            : (estimate * GAS_MARGIN[0]) / GAS_MARGIN[1];

    if (gasLimit > SHOP_GAS_CAP) {
        throw new Error(
            'This costs more gas than this wallet will spend in the shop.',
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
