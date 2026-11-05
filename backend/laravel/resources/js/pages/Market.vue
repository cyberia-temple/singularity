<script setup lang="ts">
import { Head } from '@inertiajs/vue3';
import {
    Contract,
    JsonRpcProvider,
    MaxUint256,
    formatUnits,
    parseUnits,
} from 'ethers';
import { Loader2 } from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useWallet } from '@/composables/useWallet';
import {
    CYBERIA_CHAIN_ID,
    cyberiaReadRpcUrl,
    ensureCyberiaNetwork,
} from '@/lib/evmChains';

const env =
    (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
// Baked-in production deploys (deployments/cyberia-nft-market.json); env vars
// only override them for staging/redeploys.
const NFT_CONTRACT =
    env.VITE_NFT_CONTRACT || '0x546462FAbf30734E63b64f32B30EC8ADD9B6EBa7';
const NFT_MARKET =
    env.VITE_NFT_MARKET || '0x12C3EC2019E814be06Bf6386df0F22aBB673Db90';
const IPFS_GATEWAY = env.VITE_IPFS_GATEWAY ?? 'https://ipfs.io/ipfs/';
const CYBER_SOL_ADDRESS = '0x7DcDa19Cf984ca708E5fA228AC148e7d82D508BA';

const NFT_ABI = [
    'function nextId() view returns (uint256)',
    'function ownerOf(uint256) view returns (address)',
    'function tokenURI(uint256) view returns (string)',
    'function getApproved(uint256) view returns (address)',
    'function isApprovedForAll(address,address) view returns (bool)',
    'function approve(address,uint256)',
    'function setApprovalForAll(address,bool)',
    'function mint(string) returns (uint256)',
];

const MARKET_ABI = [
    'function listingsLength() view returns (uint256)',
    'function listings(uint256) view returns (address nft, uint256 tokenId, address seller, address paymentToken, uint256 price, bool active)',
    'function list(address,uint256,address,uint256) returns (uint256)',
    'function updatePrice(uint256,uint256)',
    'function cancel(uint256)',
    'function buy(uint256)',
    'function feeBps() view returns (uint256)',
];

const ERC20_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
];

type NFTMetadata = {
    name?: string;
    description?: string;
    image?: string;
};

type Listing = {
    listingId: number;
    nft: string;
    tokenId: bigint;
    seller: string;
    paymentToken: string;
    price: bigint;
    active: boolean;
    paymentSymbol?: string;
    paymentDecimals?: number;
};

type NFTItem = {
    tokenId: bigint;
    owner: string;
    tokenURI: string;
    metadata?: NFTMetadata;
    imageUrl?: string;
    listing?: Listing;
};

const wallet = useWallet();

const items = ref<NFTItem[]>([]);
const loading = ref(false);
const status = ref<string | null>(null);
const error = ref<string | null>(null);

const mintName = ref('');
const mintDescription = ref('');
const mintExternalUrl = ref('');
const mintImage = ref<File | null>(null);
const mintImagePreview = ref<string | null>(null);
const mintBusy = ref(false);
const mintError = ref<string | null>(null);

const listForms = ref<
    Record<
        string,
        { token: string; price: string; busy: boolean; error: string | null }
    >
>({});
const buyBusy = ref<Record<string, boolean>>({});

// Connected wallet's balance of each listing's payment token, keyed by lowercased
// token address. A missing key means "not loaded yet" — we don't block the buy
// button on an unknown balance, only on one we've confirmed is too low.
const payBalances = ref<Record<string, bigint>>({});

const isConfigured = computed(() => !!NFT_CONTRACT && !!NFT_MARKET);

const readProvider = new JsonRpcProvider(
    cyberiaReadRpcUrl(),
    { chainId: CYBERIA_CHAIN_ID, name: 'cyberia' },
    { batchMaxCount: 10 },
);

const ipfsToHttp = (uri: string): string => {
    if (uri.startsWith('ipfs://')) {
        return IPFS_GATEWAY + uri.replace(/^ipfs:\/\//, '');
    }

    return uri;
};

const fetchJson = async (url: string): Promise<NFTMetadata | undefined> => {
    try {
        const res = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) {
            return undefined;
        }

        return (await res.json()) as NFTMetadata;
    } catch {
        return undefined;
    }
};

const erc20Cache = new Map<string, { symbol: string; decimals: number }>();
const getErc20 = async (
    addr: string,
): Promise<{ symbol: string; decimals: number }> => {
    const key = addr.toLowerCase();
    const cached = erc20Cache.get(key);

    if (cached) {
        return cached;
    }

    try {
        const c = new Contract(addr, ERC20_ABI, readProvider);
        const [symbol, decimals] = await Promise.all([
            c.symbol().catch(() => '?'),
            c.decimals().catch(() => 18),
        ]);
        const meta = { symbol: String(symbol), decimals: Number(decimals) };
        erc20Cache.set(key, meta);

        return meta;
    } catch {
        const meta = { symbol: '?', decimals: 18 };
        erc20Cache.set(key, meta);

        return meta;
    }
};

// Read the connected wallet's balance for every distinct payment token in the
// active listings, so the buy button can be disabled when funds are short.
const loadBalances = async (listings: Listing[]): Promise<void> => {
    const addr = wallet.address.value;

    if (!addr) {
        payBalances.value = {};

        return;
    }

    const tokens = Array.from(
        new Set(listings.map((l) => l.paymentToken.toLowerCase())),
    );
    const entries = await Promise.all(
        tokens.map(async (token) => {
            try {
                const c = new Contract(token, ERC20_ABI, readProvider);

                return [token, (await c.balanceOf(addr)) as bigint] as const;
            } catch {
                return [token, undefined] as const;
            }
        }),
    );
    const next: Record<string, bigint> = {};

    for (const [token, bal] of entries) {
        if (bal !== undefined) {
            next[token] = bal;
        }
    }

    payBalances.value = next;
};

let galleryGeneration = 0;

const loadGallery = async (): Promise<void> => {
    if (!isConfigured.value) {
        return;
    }

    const generation = ++galleryGeneration;
    loading.value = true;
    error.value = null;

    try {
        const nft = new Contract(NFT_CONTRACT, NFT_ABI, readProvider);
        const market = new Contract(NFT_MARKET, MARKET_ABI, readProvider);

        const [nextIdBn, listingsLenBn] = await Promise.all([
            nft.nextId(),
            market.listingsLength(),
        ]);
        const nextId = Number(nextIdBn);
        const listingsLen = Number(listingsLenBn);

        const rawListings = await Promise.all(
            Array.from({ length: listingsLen }, (_, i) => market.listings(i)),
        );
        const activeListings: Listing[] = [];

        for (let i = 0; i < rawListings.length; i++) {
            const r = rawListings[i];

            if (!r.active) {
                continue;
            }

            if (String(r.nft).toLowerCase() !== NFT_CONTRACT.toLowerCase()) {
                continue;
            }

            const meta = await getErc20(r.paymentToken);
            activeListings.push({
                listingId: i,
                nft: r.nft,
                tokenId: r.tokenId,
                seller: r.seller,
                paymentToken: r.paymentToken,
                price: r.price,
                active: true,
                paymentSymbol: meta.symbol,
                paymentDecimals: meta.decimals,
            });
        }

        const byTokenId = new Map<string, Listing>();

        for (const l of activeListings) {
            byTokenId.set(l.tokenId.toString(), l);
        }

        if (generation !== galleryGeneration) {
            return;
        }

        items.value = [];
        let failed = 0;

        // Keep RPC batches small and show each page as soon as it arrives.
        // A single unavailable token must not hide the entire collection.
        for (let end = nextId; end > 0; end -= 10) {
            const ids = Array.from({ length: Math.min(10, end) }, (_, i) =>
                BigInt(end - i),
            );
            const tokens = await Promise.all(
                ids.map(async (id) => {
                    try {
                        const [owner, uri] = await Promise.all([
                            nft.ownerOf(id),
                            nft.tokenURI(id),
                        ]);

                        return {
                            tokenId: id,
                            owner,
                            tokenURI: uri,
                            listing: byTokenId.get(id.toString()),
                        } as NFTItem;
                    } catch {
                        failed++;

                        return null;
                    }
                }),
            );

            if (generation !== galleryGeneration) {
                return;
            }

            items.value.push(
                ...tokens.filter((token): token is NFTItem => token !== null),
            );
        }

        if (failed) {
            error.value = `Could not load ${failed} NFT${failed === 1 ? '' : 's'} from the network. Reload to retry.`;
        }

        await loadBalances(activeListings);

        // Metadata gateways can be slow or unavailable. They must never block
        // ownership or listing display, and should not receive 400 requests at once.
        const metadataItems = [...items.value];
        let cursor = 0;
        const loadMetadata = async (): Promise<void> => {
            while (
                cursor < metadataItems.length &&
                generation === galleryGeneration
            ) {
                const item = metadataItems[cursor++];
                const metadata = await fetchJson(ipfsToHttp(item.tokenURI));

                if (generation !== galleryGeneration) {
                    return;
                }

                if (!metadata && !error.value) {
                    error.value =
                        'Some NFT details could not be loaded from their metadata source. Reload to retry.';
                }

                if (metadata) {
                    item.metadata = metadata;
                    item.imageUrl = metadata.image
                        ? ipfsToHttp(metadata.image)
                        : undefined;
                }
            }
        };
        void Promise.all(Array.from({ length: 8 }, () => loadMetadata()));
    } catch (e) {
        if (generation === galleryGeneration) {
            error.value = (e as Error).message ?? String(e);
        }
    } finally {
        if (generation === galleryGeneration) {
            loading.value = false;
        }
    }
};

watch(() => wallet.address.value, loadGallery);
onMounted(() => {
    loadGallery();
});

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const onMintImageChange = (event: Event): void => {
    const target = event.target as HTMLInputElement;
    const file = target.files?.[0] ?? null;
    mintError.value = null;

    if (file && file.size > MAX_IMAGE_BYTES) {
        mintError.value = `Image must be ≤ 2 MB (got ${(file.size / 1024 / 1024).toFixed(2)} MB)`;
        target.value = '';
        mintImage.value = null;

        return;
    }

    mintImage.value = file;

    if (mintImagePreview.value) {
        URL.revokeObjectURL(mintImagePreview.value);
    }

    mintImagePreview.value = file ? URL.createObjectURL(file) : null;
};

const handleMint = async (): Promise<void> => {
    mintError.value = null;

    if (!mintName.value.trim()) {
        mintError.value = 'Name is required';

        return;
    }

    mintBusy.value = true;

    try {
        status.value = 'Uploading metadata…';
        const form = new FormData();
        form.append('name', mintName.value.trim());
        form.append('description', mintDescription.value.trim());

        if (mintExternalUrl.value.trim()) {
            form.append('external_url', mintExternalUrl.value.trim());
        }

        if (mintImage.value) {
            form.append('image', mintImage.value);
        }

        const res = await fetch('/api/nft/upload', {
            method: 'POST',
            headers: { Accept: 'application/json' },
            body: form,
        });

        if (!res.ok) {
            const t = await res.text().catch(() => '');

            throw new Error(
                `Upload failed: HTTP ${res.status} ${t.slice(0, 200)}`,
            );
        }

        const { token_uri: tokenUri } = (await res.json()) as {
            token_uri: string;
        };

        status.value = 'Confirm mint() in your wallet…';
        const provider = await ensureCyberiaNetwork();
        const signer = await provider.getSigner();
        const nft = new Contract(NFT_CONTRACT, NFT_ABI, signer);
        const tx = await nft.mint(tokenUri);
        status.value = 'Waiting for block…';
        await tx.wait();

        status.value = 'Minted!';
        mintName.value = '';
        mintDescription.value = '';
        mintExternalUrl.value = '';
        mintImage.value = null;

        if (mintImagePreview.value) {
            URL.revokeObjectURL(mintImagePreview.value);
            mintImagePreview.value = null;
        }

        await loadGallery();
    } catch (e) {
        mintError.value = (e as Error).message ?? String(e);
    } finally {
        mintBusy.value = false;
    }
};

const openListForm = (item: NFTItem): void => {
    listForms.value[item.tokenId.toString()] = {
        token: CYBER_SOL_ADDRESS,
        price: '1',
        busy: false,
        error: null,
    };
};

const closeListForm = (item: NFTItem): void => {
    delete listForms.value[item.tokenId.toString()];
};

const handleList = async (item: NFTItem): Promise<void> => {
    const key = item.tokenId.toString();
    const form = listForms.value[key];

    if (!form) {
        return;
    }

    form.error = null;
    form.busy = true;

    try {
        const provider = await ensureCyberiaNetwork();
        const signer = await provider.getSigner();
        const nft = new Contract(NFT_CONTRACT, NFT_ABI, signer);

        const approved = await nft.getApproved(item.tokenId);

        if (String(approved).toLowerCase() !== NFT_MARKET.toLowerCase()) {
            status.value = 'Approving NFT for market…';
            const tx = await nft.approve(NFT_MARKET, item.tokenId);
            await tx.wait();
        }

        const erc20 = await getErc20(form.token);
        const price = parseUnits(form.price || '0', erc20.decimals);

        if (price <= 0n) {
            throw new Error('Price must be > 0');
        }

        const market = new Contract(NFT_MARKET, MARKET_ABI, signer);
        status.value = 'Listing NFT…';
        const tx = await market.list(
            NFT_CONTRACT,
            item.tokenId,
            form.token,
            price,
        );
        await tx.wait();

        status.value = 'Listed.';
        closeListForm(item);
        await loadGallery();
    } catch (e) {
        form.error = (e as Error).message ?? String(e);
    } finally {
        form.busy = false;
    }
};

const priceForms = ref<
    Record<string, { price: string; busy: boolean; error: string | null }>
>({});

const openPriceForm = (item: NFTItem): void => {
    if (!item.listing) {
        return;
    }

    priceForms.value[item.tokenId.toString()] = {
        price: formatUnits(
            item.listing.price,
            item.listing.paymentDecimals ?? 18,
        ),
        busy: false,
        error: null,
    };
};

const closePriceForm = (item: NFTItem): void => {
    delete priceForms.value[item.tokenId.toString()];
};

const handleUpdatePrice = async (item: NFTItem): Promise<void> => {
    if (!item.listing) {
        return;
    }

    const key = item.tokenId.toString();
    const form = priceForms.value[key];

    if (!form) {
        return;
    }

    form.error = null;
    form.busy = true;

    try {
        const newPrice = parseUnits(
            form.price || '0',
            item.listing.paymentDecimals ?? 18,
        );

        if (newPrice <= 0n) {
            throw new Error('Price must be > 0');
        }

        const provider = await ensureCyberiaNetwork();
        const signer = await provider.getSigner();
        const market = new Contract(NFT_MARKET, MARKET_ABI, signer);
        status.value = 'Updating price…';
        const tx = await market.updatePrice(item.listing.listingId, newPrice);
        await tx.wait();

        status.value = 'Price updated.';
        closePriceForm(item);
        await loadGallery();
    } catch (e) {
        form.error = (e as Error).message ?? String(e);
    } finally {
        form.busy = false;
    }
};

const handleCancel = async (item: NFTItem): Promise<void> => {
    if (!item.listing) {
        return;
    }

    buyBusy.value[item.tokenId.toString()] = true;

    try {
        const provider = await ensureCyberiaNetwork();
        const signer = await provider.getSigner();
        const market = new Contract(NFT_MARKET, MARKET_ABI, signer);
        status.value = 'Cancelling…';
        const tx = await market.cancel(item.listing.listingId);
        await tx.wait();
        status.value = 'Cancelled.';
        await loadGallery();
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
    } finally {
        buyBusy.value[item.tokenId.toString()] = false;
    }
};

const handleBuy = async (item: NFTItem): Promise<void> => {
    if (!item.listing) {
        return;
    }

    buyBusy.value[item.tokenId.toString()] = true;

    try {
        const provider = await ensureCyberiaNetwork();
        const signer = await provider.getSigner();
        const signerAddr = await signer.getAddress();
        const pay = new Contract(item.listing.paymentToken, ERC20_ABI, signer);

        const balance = (await pay.balanceOf(signerAddr)) as bigint;

        if (balance < item.listing.price) {
            throw new Error(
                `Insufficient ${item.listing.paymentSymbol ?? 'token'} balance to buy this NFT.`,
            );
        }

        const allowance = (await pay.allowance(
            signerAddr,
            NFT_MARKET,
        )) as bigint;

        if (allowance < item.listing.price) {
            status.value = `Approving ${item.listing.paymentSymbol ?? 'token'}…`;
            const tx = await pay.approve(NFT_MARKET, MaxUint256);
            await tx.wait();
        }

        const market = new Contract(NFT_MARKET, MARKET_ABI, signer);
        status.value = 'Buying…';
        const tx = await market.buy(item.listing.listingId);
        await tx.wait();
        status.value = 'Bought!';
        await loadGallery();
    } catch (e) {
        error.value = (e as Error).message ?? String(e);
    } finally {
        buyBusy.value[item.tokenId.toString()] = false;
    }
};

const isMine = (addr: string): boolean =>
    !!wallet.address.value &&
    wallet.address.value.toLowerCase() === addr.toLowerCase();

// True only when we've loaded the balance and it's below the asking price.
const insufficient = (item: NFTItem): boolean => {
    if (!item.listing || !wallet.address.value) {
        return false;
    }

    const bal = payBalances.value[item.listing.paymentToken.toLowerCase()];

    if (bal === undefined) {
        return false;
    } // unknown — let the on-chain check decide

    return bal < item.listing.price;
};

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

const formatPrice = (p: bigint, decimals: number): string => {
    const v = Number(formatUnits(p, decimals));

    if (!isFinite(v)) {
        return '—';
    }

    if (v >= 1_000_000) {
        return `${(v / 1_000_000).toFixed(2)}M`;
    }

    if (v >= 1_000) {
        return `${(v / 1_000).toFixed(2)}K`;
    }

    return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
};
</script>

<template>
    <Head title="Cyberia NFT Market" />

    <div class="market-page">
        <div class="market">
            <header class="intro">
                <h1>NFT Market</h1>
                <p>
                    Shared NFT collection (ERC-721). Anyone can mint — with an
                    image, or just a link or a piece of text. Listings are
                    fixed-price in any ERC-20. The market takes a 1% fee.
                </p>
            </header>

            <div v-if="!isConfigured" class="banner banner--warn">
                Set <code>VITE_NFT_CONTRACT</code> and
                <code>VITE_NFT_MARKET</code> in <code>.env</code> and rebuild
                the frontend.
            </div>

            <section class="card">
                <h2>Mint NFT</h2>
                <div class="grid">
                    <label>
                        <span>Name</span>
                        <Input
                            v-model="mintName"
                            placeholder="e.g. Cyberial Sunset"
                        />
                    </label>
                    <label>
                        <span>Image (optional, ≤ 2 MB)</span>
                        <input
                            type="file"
                            accept="image/*"
                            class="file"
                            @change="onMintImageChange"
                        />
                        <img
                            v-if="mintImagePreview"
                            :src="mintImagePreview"
                            class="preview"
                        />
                    </label>
                    <label class="full">
                        <span>Link (optional)</span>
                        <Input
                            v-model="mintExternalUrl"
                            type="url"
                            placeholder="https://… (an NFT can be just a link)"
                        />
                    </label>
                    <label class="full">
                        <span>Description / text</span>
                        <textarea
                            v-model="mintDescription"
                            rows="2"
                            maxlength="2000"
                            class="textarea"
                        ></textarea>
                    </label>
                </div>
                <div class="actions">
                    <Button
                        v-if="!wallet.isConnected.value"
                        @click="wallet.connect()"
                    >
                        Connect wallet
                    </Button>
                    <Button
                        v-else
                        :disabled="mintBusy || !mintName"
                        @click="handleMint"
                    >
                        <Loader2 v-if="mintBusy" class="spin" />
                        Mint
                    </Button>
                </div>
                <div v-if="mintError" class="hint hint--err">
                    {{ mintError }}
                </div>
            </section>

            <section class="card">
                <div class="cardHead">
                    <h2>Gallery</h2>
                    <button
                        class="reloadBtn"
                        :disabled="loading"
                        @click="loadGallery"
                    >
                        {{ loading ? 'Loading…' : 'Reload' }}
                    </button>
                </div>
                <div v-if="status" class="hint">{{ status }}</div>
                <div v-if="error" class="hint hint--err">{{ error }}</div>

                <div
                    v-if="!items.length && !loading && !error"
                    class="muted small"
                >
                    No NFTs minted yet.
                </div>

                <div class="grid-cards">
                    <div
                        v-for="item in items"
                        :key="item.tokenId.toString()"
                        class="nftCard"
                    >
                        <div class="nftImg">
                            <img
                                v-if="item.imageUrl"
                                :src="item.imageUrl"
                                :alt="item.metadata?.name"
                            />
                            <span v-else class="nftImgFallback"
                                >#{{ item.tokenId.toString() }}</span
                            >
                        </div>
                        <div class="nftBody">
                            <div class="nftTitle">
                                {{
                                    item.metadata?.name ||
                                    `Token #${item.tokenId.toString()}`
                                }}
                            </div>
                            <div class="muted small">
                                Owner: <code>{{ short(item.owner) }}</code>
                            </div>
                            <div
                                v-if="item.metadata?.description"
                                class="nftDesc"
                            >
                                {{ item.metadata.description }}
                            </div>

                            <div v-if="item.listing" class="priceRow">
                                <strong>
                                    {{
                                        formatPrice(
                                            item.listing.price,
                                            item.listing.paymentDecimals ?? 18,
                                        )
                                    }}
                                    {{ item.listing.paymentSymbol ?? '?' }}
                                </strong>
                            </div>

                            <div class="actions">
                                <template v-if="item.listing">
                                    <template
                                        v-if="isMine(item.listing.seller)"
                                    >
                                        <Button
                                            v-if="
                                                !priceForms[
                                                    item.tokenId.toString()
                                                ]
                                            "
                                            :disabled="
                                                !!buyBusy[
                                                    item.tokenId.toString()
                                                ]
                                            "
                                            @click="openPriceForm(item)"
                                        >
                                            Change price
                                        </Button>
                                        <Button
                                            :disabled="
                                                !!buyBusy[
                                                    item.tokenId.toString()
                                                ]
                                            "
                                            @click="handleCancel(item)"
                                        >
                                            Cancel listing
                                        </Button>
                                    </template>
                                    <Button
                                        v-else-if="wallet.isConnected.value"
                                        :disabled="
                                            !!buyBusy[
                                                item.tokenId.toString()
                                            ] || insufficient(item)
                                        "
                                        @click="handleBuy(item)"
                                    >
                                        <Loader2
                                            v-if="
                                                buyBusy[item.tokenId.toString()]
                                            "
                                            class="spin"
                                        />
                                        {{
                                            insufficient(item)
                                                ? `Insufficient ${item.listing.paymentSymbol ?? 'balance'}`
                                                : 'Buy'
                                        }}
                                    </Button>
                                </template>
                                <template v-else-if="isMine(item.owner)">
                                    <Button
                                        v-if="
                                            !listForms[item.tokenId.toString()]
                                        "
                                        @click="openListForm(item)"
                                    >
                                        List for sale
                                    </Button>
                                </template>
                            </div>

                            <div
                                v-if="
                                    item.listing &&
                                    priceForms[item.tokenId.toString()]
                                "
                                class="listForm"
                            >
                                <label>
                                    <span
                                        >New price ({{
                                            item.listing.paymentSymbol ??
                                            'token'
                                        }})</span
                                    >
                                    <Input
                                        v-model="
                                            priceForms[item.tokenId.toString()]
                                                .price
                                        "
                                        type="text"
                                        inputmode="decimal"
                                    />
                                </label>
                                <div
                                    v-if="
                                        priceForms[item.tokenId.toString()]
                                            .error
                                    "
                                    class="hint hint--err"
                                >
                                    {{
                                        priceForms[item.tokenId.toString()]
                                            .error
                                    }}
                                </div>
                                <div class="actions">
                                    <Button
                                        :disabled="
                                            priceForms[item.tokenId.toString()]
                                                .busy
                                        "
                                        @click="handleUpdatePrice(item)"
                                    >
                                        <Loader2
                                            v-if="
                                                priceForms[
                                                    item.tokenId.toString()
                                                ].busy
                                            "
                                            class="spin"
                                        />
                                        Save price
                                    </Button>
                                    <button
                                        type="button"
                                        class="editBtn"
                                        :disabled="
                                            priceForms[item.tokenId.toString()]
                                                .busy
                                        "
                                        @click="closePriceForm(item)"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>

                            <div
                                v-if="
                                    !item.listing &&
                                    listForms[item.tokenId.toString()]
                                "
                                class="listForm"
                            >
                                <label>
                                    <span>Payment token (ERC-20 address)</span>
                                    <Input
                                        v-model="
                                            listForms[item.tokenId.toString()]
                                                .token
                                        "
                                        placeholder="0x…"
                                    />
                                </label>
                                <label>
                                    <span>Price</span>
                                    <Input
                                        v-model="
                                            listForms[item.tokenId.toString()]
                                                .price
                                        "
                                        type="text"
                                        inputmode="decimal"
                                    />
                                </label>
                                <div
                                    v-if="
                                        listForms[item.tokenId.toString()].error
                                    "
                                    class="hint hint--err"
                                >
                                    {{
                                        listForms[item.tokenId.toString()].error
                                    }}
                                </div>
                                <div class="actions">
                                    <Button
                                        :disabled="
                                            listForms[item.tokenId.toString()]
                                                .busy
                                        "
                                        @click="handleList(item)"
                                    >
                                        <Loader2
                                            v-if="
                                                listForms[
                                                    item.tokenId.toString()
                                                ].busy
                                            "
                                            class="spin"
                                        />
                                        Confirm listing
                                    </Button>
                                    <button
                                        type="button"
                                        class="editBtn"
                                        :disabled="
                                            listForms[item.tokenId.toString()]
                                                .busy
                                        "
                                        @click="closeListForm(item)"
                                    >
                                        Cancel
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
        </div>
    </div>
</template>

<style scoped>
.market-page {
    min-height: 100vh;
    background: var(--background, #0d0d0d);
    color: var(--foreground, #e5e7eb);
}
.market {
    max-width: 1100px;
    margin: 0 auto;
    padding: 32px 16px 64px;
}
.intro h1 {
    margin: 0 0 6px;
    font-size: 28px;
    font-weight: 700;
}
.intro p {
    color: var(--muted-foreground, #94a3b8);
    margin: 0 0 24px;
    line-height: 1.5;
    max-width: 720px;
}
.banner {
    padding: 12px 14px;
    border-radius: 8px;
    margin-bottom: 16px;
    font-size: 13px;
}
.banner--warn {
    background: rgba(234, 179, 8, 0.1);
    border: 1px solid rgba(234, 179, 8, 0.4);
    color: #facc15;
}
.card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 20px;
    margin-bottom: 20px;
}
.cardHead {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 14px;
}
.card h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
}
.reloadBtn {
    background: transparent;
    color: var(--muted-foreground, #94a3b8);
    border: 1px solid var(--border);
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 12px;
    cursor: pointer;
}
.grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
}
.grid label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
    color: var(--muted-foreground, #94a3b8);
}
.grid label.full {
    grid-column: 1 / -1;
}
.textarea {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    color: var(--foreground, #e5e7eb);
    font: inherit;
    resize: vertical;
}
.file {
    color: var(--muted-foreground, #94a3b8);
    font-size: 13px;
}
.preview {
    margin-top: 8px;
    max-width: 160px;
    max-height: 160px;
    border-radius: 12px;
    object-fit: cover;
    border: 1px solid var(--border);
}
.actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
    flex-wrap: wrap;
}
.hint {
    margin-top: 10px;
    font-size: 13px;
    color: var(--muted-foreground, #94a3b8);
    word-break: break-all;
}
.hint--err {
    color: #f87171;
}
.spin {
    width: 16px;
    height: 16px;
    margin-right: 6px;
    animation: spin 0.8s linear infinite;
}
.muted {
    color: var(--muted-foreground, #94a3b8);
}
.small {
    font-size: 11px;
}
@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}
.grid-cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 14px;
}
.nftCard {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
}
.nftImg {
    aspect-ratio: 1 / 1;
    background: var(--muted);
    display: flex;
    align-items: center;
    justify-content: center;
}
.nftImg img {
    width: 100%;
    height: 100%;
    object-fit: cover;
}
.nftImgFallback {
    color: var(--muted-foreground, #94a3b8);
    font-weight: 700;
}
.nftBody {
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.nftTitle {
    font-weight: 600;
    font-size: 15px;
}
.nftDesc {
    font-size: 12px;
    color: var(--foreground, #e5e7eb);
    line-height: 1.4;
    max-height: 4.2em;
    overflow: hidden;
}
.priceRow {
    margin-top: 4px;
    color: #86efac;
    font-size: 15px;
}
.listForm {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    color: var(--muted-foreground, #94a3b8);
}
.editBtn {
    border: 1px solid var(--input);
    background: transparent;
    color: var(--foreground, #e5e7eb);
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 13px;
    cursor: pointer;
}
@media (max-width: 640px) {
    .grid {
        grid-template-columns: 1fr;
    }
}
</style>
