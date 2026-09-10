import { Contract, Interface, JsonRpcProvider, getAddress } from 'ethers';
import { nftReadRpcUrl } from '@/lib/nftChains';
import type { NftChain } from '@/lib/nftChains';
import { ipfsHttpUrl } from '@/lib/wallet/ipfs';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';
import { explorerFailure } from '@/lib/wallet/readError';

/**
 * NFTs in the wallet: what this account owns, and minting one.
 *
 * The collection is `CyberiaNFT` — a single ERC-721 anyone may mint into,
 * where the tokenURI is whatever the minter passes. That is the shape of the
 * contract and therefore the shape of this file: there is no deploy step, no
 * allowlist and no per-collection state to read, only a URI and a signature.
 *
 * A tokenURI is a string, not a file. `ipfs://CID` pointing at ERC-721 JSON is
 * the useful case and what the mint screen builds, but the contract takes a
 * bare link or a line of text too — so nothing here assumes a token has an
 * image, and a token without one renders as itself rather than as broken.
 */

/** The one write and the reads a wallet needs. `mint` returns the new id. */
const NFT_ABI = [
    'function mint(string uri) returns (uint256)',
    'function tokenURI(uint256 tokenId) view returns (string)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function nextId() view returns (uint256)',
    // The id a mint produced, which the transaction's return value cannot give
    // a browser: `eth_sendTransaction` answers with a hash, and the value a
    // contract returns is only readable from the log it emitted.
    'event Minted(uint256 indexed tokenId, address indexed creator, string uri)',
];

/**
 * Gas this wallet is willing to spend on a mint, and the ceiling every quote
 * is checked against.
 *
 * A mint is `_safeMint` plus a string written to storage, so it costs several
 * times a transfer and the URI's length is most of the difference — 32 bytes
 * of URI is another storage slot. The cap is what makes the quoted fee a
 * promise: a mint that would cost more than the sentence the user read is
 * refused instead of signed.
 */
export const MINT_GAS_CAP = 400_000n;

/** Headroom over a live estimate, for the drift between quote and mine. */
const GAS_MARGIN = [125n, 100n] as const;

/** One token an address holds. */
export type WalletNft = {
    /** Collection contract — a token is only unique together with this. */
    contract: string;
    tokenId: string;
    /** Collection name and symbol as the contract reports them. */
    collection: string;
    symbol: string;
    standard: string;
    /** How many, which is only ever more than one for ERC-1155. */
    amount: string;
    name: string;
    description: string;
    /** Something a browser can render, or null when there is no image. */
    imageUrl: string | null;
    /** Where the token points, verbatim — usually `ipfs://…`. */
    uri: string | null;
    externalUrl: string | null;
    attributes: { trait: string; value: string }[];
    explorerUrl: string;
    /** Minted into this wallet's own shared collection rather than elsewhere. */
    native: boolean;
};

/** ERC-721 metadata as this wallet writes it. */
export type NftMetadata = {
    name: string;
    description: string;
    image?: string;
    external_url?: string;
    attributes?: { trait_type: string; value: string }[];
};

/**
 * The metadata document, built in the browser.
 *
 * Pure and deliberately small: this is what the CID names and what every
 * marketplace will read forever, so it holds what the user typed and nothing
 * else — no minter address, no timestamp, no provenance nobody asked for.
 */
export const buildMetadata = (fields: {
    name: string;
    description?: string;
    image?: string | null;
    externalUrl?: string | null;
    attributes?: { trait: string; value: string }[];
}): NftMetadata => {
    const metadata: NftMetadata = {
        name: fields.name.trim(),
        description: (fields.description ?? '').trim(),
    };

    if (fields.image) {
        metadata.image = fields.image;
    }

    if (fields.externalUrl) {
        metadata.external_url = fields.externalUrl.trim();
    }

    const attributes = (fields.attributes ?? [])
        .filter(
            (entry) => entry.trait.trim() !== '' && entry.value.trim() !== '',
        )
        .map((entry) => ({
            trait_type: entry.trait.trim(),
            value: entry.value.trim(),
        }));

    if (attributes.length > 0) {
        metadata.attributes = attributes;
    }

    return metadata;
};

const provider = (target: NftChain, rpcUrl?: string): JsonRpcProvider =>
    new JsonRpcProvider(rpcUrl || nftReadRpcUrl(target), target.chain.chainId, {
        staticNetwork: true,
    });

/* ------------------------------------------------------------- reading -- */

type BlockscoutNft = {
    id?: string;
    value?: string;
    image_url?: string;
    media_url?: string;
    external_app_url?: string;
    token_type?: string;
    token?: {
        address_hash?: string;
        address?: string;
        name?: string;
        symbol?: string;
        type?: string;
    };
    metadata?: {
        name?: string;
        description?: string;
        image?: string;
        external_url?: string;
        attributes?: { trait_type?: string; value?: unknown }[];
    };
};

const text = (value: unknown, limit: number): string =>
    typeof value === 'string' ? value.slice(0, limit) : '';

/**
 * Everything one address holds, from the chain's own keyless index.
 *
 * Blockscout resolves the metadata as well as the ownership, which is the
 * reason to ask it rather than the contract: reading a token's name from the
 * chain means fetching `tokenURI`, then fetching that URI from a gateway, per
 * token. One request answers both, and a wallet that has to render fifty rows
 * cannot make a hundred round trips to do it.
 *
 * A token whose metadata the index could not read is still listed — it exists
 * and this address owns it, which is the fact the screen is about.
 */
export const fetchOwnedNfts = async (
    owner: string,
    target: NftChain,
    limit = 60,
): Promise<WalletNft[]> => {
    const url = `${target.explorerUrl}/api/v2/addresses/${owner}/nft?type=ERC-721%2CERC-1155`;
    const response = await fetch(url, {
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw explorerFailure(response.status);
    }

    const body = (await response.json()) as { items?: unknown };

    if (!Array.isArray(body.items)) {
        return [];
    }

    return (body.items as BlockscoutNft[]).slice(0, limit).flatMap((item) => {
        const contract = item.token?.address_hash ?? item.token?.address ?? '';
        const tokenId = String(item.id ?? '');

        if (contract === '' || tokenId === '') {
            return [];
        }

        const metadata = item.metadata ?? {};
        const address = getAddress(contract);

        return [
            {
                contract: address,
                tokenId,
                collection: text(item.token?.name, 40) || 'NFT',
                symbol: text(item.token?.symbol, 12),
                standard: text(item.token_type, 12) || 'ERC-721',
                amount: String(item.value ?? '1'),
                name: text(metadata.name, 120) || `#${tokenId}`,
                description: text(metadata.description, 2000),
                // The index already rewrote `ipfs://` into a gateway link; the
                // raw metadata field is the fallback for an older instance.
                imageUrl:
                    ipfsHttpUrl(item.image_url) ??
                    ipfsHttpUrl(item.media_url) ??
                    ipfsHttpUrl(metadata.image),
                uri: text(metadata.image, 400) || null,
                externalUrl:
                    ipfsHttpUrl(metadata.external_url) ??
                    ipfsHttpUrl(item.external_app_url),
                attributes: (metadata.attributes ?? [])
                    .slice(0, 12)
                    .flatMap((attribute) =>
                        attribute.trait_type && attribute.value !== undefined
                            ? [
                                  {
                                      trait: text(attribute.trait_type, 40),
                                      value: String(attribute.value).slice(
                                          0,
                                          60,
                                      ),
                                  },
                              ]
                            : [],
                    ),
                explorerUrl: `${target.explorerUrl}/token/${address}/instance/${tokenId}`,
                native:
                    target.collection !== null &&
                    address.toLowerCase() === target.collection.toLowerCase(),
            },
        ];
    });
};

/* ------------------------------------------------------------- minting -- */

export type MintQuote = {
    /** Gas the mint is allowed to burn — the number the fee below promises. */
    gasLimit: bigint;
    gasPrice: bigint;
    /** Worst case cost in wei: gasLimit × gasPrice. */
    fee: bigint;
};

/**
 * What this mint will cost, before anything is signed.
 *
 * Estimated against the real URI, because the URI's length is most of the
 * cost. The estimate is padded and then capped: what comes back is the number
 * the user is shown and the number `mintNft` refuses to exceed.
 */
export const quoteMint = async (
    uri: string,
    minter: string,
    target: NftChain,
    rpcUrl?: string,
): Promise<MintQuote> => {
    if (target.collection === null) {
        throw new Error('Nothing to mint into on this network');
    }

    const rpc = provider(target, rpcUrl);
    const contract = new Contract(target.collection, NFT_ABI, rpc);

    const [estimate, feeData] = await Promise.all([
        (
            contract.mint.estimateGas(uri, { from: minter }) as Promise<bigint>
        ).catch((error: unknown) => {
            // The common failure is an empty account, and the node says so
            // in a sentence about gas that reads like a bug in the wallet.
            const message =
                error instanceof Error ? error.message : String(error);

            throw new Error(
                /insufficient funds/i.test(message)
                    ? 'This account has no coin to pay for the mint.'
                    : `The network refused to price this mint: ${message}`,
            );
        }),
        rpc.getFeeData(),
    ]);

    const gasLimit = (estimate * GAS_MARGIN[0]) / GAS_MARGIN[1];

    if (gasLimit > MINT_GAS_CAP) {
        throw new Error(
            'This mint would cost more gas than this wallet will spend on one. Try a shorter link.',
        );
    }

    // A node that will not quote a price cannot have a transaction priced
    // against it, so this fails rather than inventing a number to sign for.
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;

    if (gasPrice === null || gasPrice === undefined) {
        throw new Error('The network did not report a gas price');
    }

    return { gasLimit, gasPrice, fee: gasLimit * gasPrice };
};

/**
 * Mint one token. Returns the transaction hash.
 *
 * `quote` is what the user was shown and held a button to agree to, so it is
 * what gets signed: a live estimate above the quoted limit means this mint
 * costs more than the sentence they read, and it is refused rather than
 * silently signed for more.
 */
export const mintNft = async (
    source: WalletKeySource,
    uri: string,
    target: NftChain,
    quote: MintQuote,
    rpcUrl?: string,
): Promise<string> => {
    if (target.collection === null) {
        throw new Error('Nothing to mint into on this network');
    }

    if (uri.trim() === '') {
        throw new Error('A token needs something to point at');
    }

    const signer = evmSigner(source).connect(provider(target, rpcUrl));
    const contract = new Contract(target.collection, NFT_ABI, signer);

    try {
        const estimate = (await contract.mint.estimateGas(uri)) as bigint;

        if (estimate > quote.gasLimit) {
            throw new Error(
                'This mint now costs more gas than the fee you were shown. Nothing was signed.',
            );
        }
    } catch (error) {
        // Only the refusal above is a reason to stop. A node that answers
        // eth_estimateGas unreliably has already been paid for by the cap the
        // user agreed to, so an unreadable estimate changes nothing they were told.
        if (
            error instanceof Error &&
            error.message.startsWith('This mint now costs')
        ) {
            throw error;
        }
    }

    const tx = await contract.mint(uri, {
        gasLimit: quote.gasLimit,
        gasPrice: quote.gasPrice,
    });

    return tx.hash as string;
};

/**
 * Which token a mint produced.
 *
 * A wallet that mints and then has to *say* what it minted needs the id, and
 * the id does not come back from sending the transaction — a contract's return
 * value is invisible outside the EVM, so the number lives in the `Minted` log.
 * Reading `nextId()` instead would be a race with everyone else minting into
 * the same shared collection.
 *
 * Times out rather than waiting forever: a transaction that has not been mined
 * in three minutes on a one-second chain is a transaction to go and look at on
 * the explorer, and the caller is told the hash rather than left on a spinner.
 */
export const waitForMintedToken = async (
    hash: string,
    target: NftChain,
    rpcUrl?: string,
): Promise<string> => {
    if (target.collection === null) {
        throw new Error('Nothing to mint into on this network');
    }

    const rpc = provider(target, rpcUrl);
    const receipt = await rpc.waitForTransaction(hash, 1, 180_000);

    if (receipt === null) {
        throw new Error('The mint has not been mined yet.');
    }

    if (receipt.status === 0) {
        throw new Error('The mint transaction failed on chain.');
    }

    const contract = target.collection.toLowerCase();
    const abi = new Interface(NFT_ABI);

    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== contract) {
            continue;
        }

        const parsed = abi.parseLog({
            topics: [...log.topics],
            data: log.data,
        });

        if (parsed?.name === 'Minted') {
            return (parsed.args[0] as bigint).toString();
        }
    }

    throw new Error('The mint was mined but did not say which token it made.');
};

/** Where a freshly minted token can be looked at, before any index has it. */
export const mintTxUrl = (target: NftChain, hash: string): string =>
    `${target.explorerUrl}/tx/${hash}`;
