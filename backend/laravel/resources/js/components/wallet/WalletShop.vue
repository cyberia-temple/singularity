<script setup lang="ts">
import { formatUnits, isAddress, parseUnits } from 'ethers';
import { computed, onMounted, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { shortAddress } from '@/lib/wallet/format';
import { ipfsHttpUrl, pinJson } from '@/lib/wallet/ipfs';
import {
    NATIVE,
    SHOP_ADDRESS,
    SHOP_CATEGORIES,
    SHOP_FORBIDDEN,
    deadlineOf,
    deliveryMeta,
    encodeEnvelope,
    orderActions,
    readAsset,
    readDelivery,
    readListings,
    readOrders,
    readShopTerms,
    sellerGets,
} from '@/lib/wallet/shop';
import type {
    ShopAction,
    ShopCategory,
    ShopListing,
    ShopLotMeta,
    ShopOrder,
    ShopTerms,
} from '@/lib/wallet/shop';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The shop on the NFT market: keys, subscriptions, accounts, gift cards,
 * domains, hosting and AI credits, paid into escrow and delivered sealed.
 *
 * Everything here reads and signs on Cyberia Fuji (49407), where the
 * contract lives. The secret a buyer pays for is sealed in this browser
 * under the chat key the two parties share and opened only in the buyer's —
 * the chain carries ciphertext, the server carries nothing.
 */

const props = defineProps<{ wallet: MultiWallet }>();

const { t } = useLocale(walletMessages);

type View =
    | { kind: 'list' }
    | { kind: 'lot'; id: bigint }
    | { kind: 'sell' }
    | { kind: 'order'; id: bigint };

const view = ref<View>({ kind: 'list' });
const filter = ref<ShopCategory | 'all' | 'mine'>('all');

const listings = ref<ShopListing[]>([]);
const orders = ref<ShopOrder[]>([]);
const terms = ref<ShopTerms | null>(null);
const meta = ref<Record<string, ShopLotMeta | null>>({});
const loading = ref(true);
const failure = ref<string | null>(null);
const busy = ref(false);
const actionError = ref<string | null>(null);
const notice = ref<string | null>(null);

const account = computed(
    () =>
        props.wallet.accounts.value.find(
            (entry) => entry.chain === 'cyberia_fuji',
        ) ?? null,
);
const me = computed(() => account.value?.address.toLowerCase() ?? '');
const canSign = computed(() => account.value?.capabilities.send ?? false);
const identity = computed(() => props.wallet.chatIdentity());

const now = (): number => Math.floor(Date.now() / 1_000);

const amount = (value: bigint, decimals: number): string => {
    const text = formatUnits(value, decimals);

    return text.endsWith('.0') ? text.slice(0, -2) : text;
};

const metaOf = (listing: ShopListing): ShopLotMeta | null =>
    meta.value[listing.id.toString()] ?? null;

const titleOf = (listing: ShopListing): string =>
    metaOf(listing)?.title || `#${listing.id}`;

const loadMeta = async (listing: ShopListing): Promise<void> => {
    const key = listing.id.toString();

    if (key in meta.value) {
        return;
    }

    meta.value[key] = null;

    try {
        const url = listing.uri.startsWith('data:')
            ? listing.uri
            : ipfsHttpUrl(listing.uri);

        if (!url) {
            return;
        }

        const body = (await (await fetch(url)).json()) as Partial<ShopLotMeta>;
        meta.value[key] = {
            title: String(body.title ?? '').slice(0, 80),
            description: String(body.description ?? '').slice(0, 2000),
            delivers: String(body.delivers ?? '').slice(0, 200),
        };
    } catch {
        // An unreadable document leaves the lot titled by its number.
    }
};

const load = async (): Promise<void> => {
    if (!SHOP_ADDRESS) {
        loading.value = false;

        return;
    }

    loading.value = true;
    failure.value = null;

    try {
        const [rows, read] = await Promise.all([
            readListings(),
            readShopTerms(),
        ]);
        listings.value = rows;
        terms.value = read;
        orders.value = me.value ? await readOrders(me.value, rows) : [];
        rows.forEach((row) => void loadMeta(row));
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        loading.value = false;
    }
};

onMounted(load);
watch(me, () => void load());

const visible = computed(() =>
    listings.value.filter((listing) => {
        if (filter.value === 'mine') {
            return listing.seller.toLowerCase() === me.value;
        }

        if (listing.closed || listing.hidden || listing.stock === 0) {
            return false;
        }

        return filter.value === 'all' || listing.category === filter.value;
    }),
);

const lot = computed(() =>
    view.value.kind === 'lot'
        ? (listings.value.find(
              (row) => row.id === (view.value as { id: bigint }).id,
          ) ?? null)
        : null,
);

const order = computed(() =>
    view.value.kind === 'order'
        ? (orders.value.find(
              (row) => row.id === (view.value as { id: bigint }).id,
          ) ?? null)
        : null,
);
const orderLot = computed(() =>
    order.value
        ? (listings.value.find((row) => row.id === order.value?.listingId) ??
          null)
        : null,
);

const run = async (action: ShopAction, done: string): Promise<boolean> => {
    busy.value = true;
    actionError.value = null;
    notice.value = null;

    try {
        await props.wallet.shop(action);
        notice.value = done;
        // The chain has the transaction; give it a block before re-reading.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        await load();

        return true;
    } catch (error) {
        actionError.value =
            error instanceof Error ? error.message : String(error);

        return false;
    } finally {
        busy.value = false;
    }
};

/* -------------------------------------------------------------- buying --- */

const buy = async (): Promise<void> => {
    if (!lot.value || !identity.value) {
        return;
    }

    if (
        await run(
            {
                kind: 'buy',
                listing: lot.value,
                buyerKey: identity.value.publicKey,
            },
            t('shopBought'),
        )
    ) {
        const mine = orders.value.find(
            (row) => row.listingId === lot.value?.id && row.state === 'paid',
        );
        view.value = mine ? { kind: 'order', id: mine.id } : { kind: 'list' };
    }
};

/* ------------------------------------------------------------- selling --- */

const form = ref({
    title: '',
    description: '',
    delivers: '',
    category: 'key' as ShopCategory,
    payToken: NATIVE,
    price: '',
    stock: '1',
    nftContract: '',
    nftId: '',
    agreed: false,
});

const formError = computed((): string | null => {
    const f = form.value;

    if (f.title.trim() === '' || f.delivers.trim() === '') {
        return t('shopFormIncomplete');
    }

    if (!/^\d+(\.\d+)?$/.test(f.price) || Number(f.price) <= 0) {
        return t('shopFormPrice');
    }

    if (!/^\d+$/.test(f.stock) || Number(f.stock) < 1) {
        return t('shopFormStock');
    }

    if (f.payToken !== NATIVE && !isAddress(f.payToken)) {
        return t('shopFormToken');
    }

    if (
        f.nftContract !== '' &&
        (!isAddress(f.nftContract) || !/^\d+$/.test(f.nftId) || f.stock !== '1')
    ) {
        return t('shopFormNft');
    }

    return f.agreed ? null : t('shopFormRules');
});

const list = async (): Promise<void> => {
    if (!identity.value || formError.value) {
        return;
    }

    const f = form.value;
    const document: ShopLotMeta = {
        title: f.title.trim(),
        description: f.description.trim(),
        delivers: f.delivers.trim(),
    };
    busy.value = true;
    actionError.value = null;
    let uri: string;

    try {
        const pay = await readAsset(f.payToken);
        const price = parseUnits(f.price, pay.decimals);

        try {
            uri = (await pinJson(document, 'shop-lot.json')).uri;
        } catch {
            // Pinning is this server's job and can be down; a short lot fits
            // in the URI itself, which the contract caps at 512 bytes.
            uri = `data:application/json,${encodeURIComponent(JSON.stringify(document))}`;

            if (uri.length > 512) {
                throw new Error(t('shopPinFailed'));
            }
        }

        busy.value = false;

        if (
            await run(
                {
                    kind: 'list',
                    payToken: pay.address,
                    price,
                    stock: Number(f.stock),
                    category: f.category,
                    sellerKey: identity.value.publicKey,
                    uri,
                    nft:
                        f.nftContract === ''
                            ? null
                            : {
                                  contract: f.nftContract,
                                  tokenId: BigInt(f.nftId),
                              },
                },
                t('shopListed'),
            )
        ) {
            filter.value = 'mine';
            view.value = { kind: 'list' };
        }
    } catch (error) {
        actionError.value =
            error instanceof Error ? error.message : String(error);
        busy.value = false;
    }
};

/* -------------------------------------------------------------- orders --- */

const secret = ref('');
const revealed = ref<string | null>(null);
const revealError = ref<string | null>(null);
const reportReason = ref('');

watch(view, () => {
    secret.value = '';
    revealed.value = null;
    revealError.value = null;
    actionError.value = null;
});

const actions = computed(() =>
    order.value && orderLot.value && terms.value
        ? orderActions(
              order.value,
              orderLot.value.seller,
              me.value,
              terms.value,
              now(),
          )
        : [],
);

const deliver = async (): Promise<void> => {
    if (!order.value || !orderLot.value || secret.value.trim() === '') {
        return;
    }

    try {
        const envelope = await props.wallet.chatSeal(
            order.value.buyerKey,
            deliveryMeta(
                order.value.id,
                orderLot.value.seller,
                order.value.buyer,
            ),
            secret.value,
        );
        await run(
            {
                kind: 'deliver',
                orderId: order.value.id,
                envelope: encodeEnvelope(envelope),
            },
            t('shopDelivered'),
        );
    } catch (error) {
        actionError.value =
            error instanceof Error ? error.message : String(error);
    }
};

const reveal = async (): Promise<void> => {
    if (!order.value || !orderLot.value) {
        return;
    }

    revealError.value = null;

    try {
        const envelope = await readDelivery(order.value);

        if (!envelope) {
            throw new Error(t('shopNoDelivery'));
        }

        revealed.value = await props.wallet.chatOpen(
            orderLot.value.sellerKey,
            deliveryMeta(
                order.value.id,
                orderLot.value.seller,
                order.value.buyer,
            ),
            envelope,
        );
    } catch {
        revealError.value = t('shopRevealFailed');
    }
};

const act = (
    kind: 'confirm' | 'dispute' | 'refund' | 'release' | 'sellerRefund',
): void => {
    if (order.value) {
        void run({ kind, orderId: order.value.id }, t('shopDone'));
    }
};

const report = (): void => {
    if (orderLot.value && reportReason.value.trim() !== '') {
        void run(
            {
                kind: 'report',
                id: orderLot.value.id,
                reason: reportReason.value.trim().slice(0, 280),
            },
            t('shopReported'),
        );
    }
};

const deadlineText = computed(() => {
    if (!order.value || !terms.value) {
        return null;
    }

    const at = deadlineOf(order.value, terms.value);

    return at === null ? null : new Date(at * 1_000).toLocaleString();
});

const categoryLabel = (category: ShopCategory): string =>
    t(`shopCat_${category}`);

const isSeller = (listing: ShopListing | null): boolean =>
    listing !== null && listing.seller.toLowerCase() === me.value;
</script>

<template>
    <div class="cw-stack">
        <!-- ------------------------------------------------------ lot --- -->
        <template v-if="view.kind === 'lot' && lot">
            <button
                type="button"
                class="cw-back"
                @click="view = { kind: 'list' }"
            >
                ← {{ t('shopTitle') }}
            </button>
            <h2 class="cw-title" style="margin: 18px 0 4px">
                {{ titleOf(lot) }}
            </h2>
            <div class="cw-data">
                {{ categoryLabel(lot.category) }} · #{{ lot.id }} ·
                {{ shortAddress(lot.seller, 6, 4) }}
            </div>
            <p
                v-if="metaOf(lot)?.description"
                class="cw-prose"
                style="margin-top: 14px; white-space: pre-wrap"
            >
                {{ metaOf(lot)?.description }}
            </p>

            <div class="cw-card" style="margin-top: 16px; padding: 14px 16px">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('shopPrice') }}</span>
                    <span class="cw-kv-val"
                        >{{ amount(lot.price, lot.pay.decimals) }}
                        {{ lot.pay.symbol }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('shopDelivers') }}</span>
                    <span class="cw-kv-val">{{
                        metaOf(lot)?.delivers || '—'
                    }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('shopStock') }}</span>
                    <span class="cw-kv-val"
                        >{{ lot.stock }} ·
                        {{ t('shopSold', { n: lot.sold }) }}</span
                    >
                </div>
                <div v-if="lot.nft" class="cw-kv">
                    <span class="cw-kv-key">NFT</span>
                    <span class="cw-kv-val"
                        >{{ shortAddress(lot.nft.contract, 6, 4) }} #{{
                            lot.nft.tokenId
                        }}</span
                    >
                </div>
                <div v-if="lot.reports > 0" class="cw-kv">
                    <span class="cw-kv-key">{{ t('shopReports') }}</span>
                    <span class="cw-kv-val" style="color: var(--cw-bad)">{{
                        lot.reports
                    }}</span>
                </div>
            </div>

            <p v-if="terms" class="cw-note" style="margin-top: 14px">
                <span>{{
                    t('shopEscrowNote', {
                        delivery: Math.round(terms.deliveryWindow / 3600),
                        dispute: Math.round(terms.disputeWindow / 3600),
                        fee: terms.feeBps / 100,
                    })
                }}</span>
            </p>

            <p
                v-if="!identity"
                class="cw-note cw-note-bad"
                style="margin-top: 12px"
            >
                <span>{{ t('shopNeedsKey') }}</span>
            </p>
            <div
                v-else-if="
                    !isSeller(lot) &&
                    !lot.closed &&
                    !lot.hidden &&
                    lot.stock > 0
                "
                style="margin-top: 16px"
            >
                <HoldButton
                    :label="
                        busy
                            ? t('shopWorking')
                            : t('shopBuyHold', {
                                  price: `${amount(lot.price, lot.pay.decimals)} ${lot.pay.symbol}`,
                              })
                    "
                    :disabled="busy || !canSign"
                    @complete="buy"
                />
            </div>
            <div v-if="isSeller(lot) && !lot.closed" style="margin-top: 16px">
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    :disabled="busy"
                    @click="run({ kind: 'close', id: lot.id }, t('shopClosed'))"
                >
                    {{ t('shopClose') }}
                </button>
            </div>
        </template>

        <!-- ---------------------------------------------------- order --- -->
        <template v-else-if="view.kind === 'order' && order && orderLot">
            <button
                type="button"
                class="cw-back"
                @click="view = { kind: 'list' }"
            >
                ← {{ t('shopTitle') }}
            </button>
            <h2 class="cw-title" style="margin: 18px 0 4px">
                {{ t('shopOrder', { id: order.id.toString() }) }} ·
                {{ titleOf(orderLot) }}
            </h2>
            <div class="cw-data">
                {{ t(`shopState_${order.state}`) }} ·
                {{ amount(order.amount, order.pay.decimals) }}
                {{ order.pay.symbol }}
            </div>
            <p
                v-if="deadlineText"
                class="cw-label"
                style="margin-top: 8px; color: var(--cw-faint)"
            >
                {{
                    order.state === 'paid'
                        ? t('shopDeliverBy', { at: deadlineText })
                        : t('shopDisputeBy', { at: deadlineText })
                }}
            </p>
            <p
                v-if="terms && isSeller(orderLot)"
                class="cw-label"
                style="margin-top: 4px; color: var(--cw-faint)"
            >
                {{
                    t('shopYouGet', {
                        amount: amount(
                            sellerGets(order.amount, terms.feeBps),
                            order.pay.decimals,
                        ),
                        symbol: order.pay.symbol,
                    })
                }}
            </p>

            <template v-if="actions.includes('deliver')">
                <textarea
                    v-model="secret"
                    class="cw-input"
                    rows="4"
                    spellcheck="false"
                    style="margin-top: 16px; height: auto"
                    :placeholder="t('shopSecretPlaceholder')"
                />
                <p class="cw-note" style="margin-top: 8px">
                    <span>{{ t('shopSealNote') }}</span>
                </p>
                <div style="margin-top: 12px">
                    <HoldButton
                        :label="busy ? t('shopWorking') : t('shopDeliverHold')"
                        :disabled="
                            busy ||
                            !canSign ||
                            secret.trim() === '' ||
                            !identity
                        "
                        @complete="deliver"
                    />
                </div>
            </template>

            <template
                v-if="
                    order.buyer.toLowerCase() === me && order.deliveredBlock > 0
                "
            >
                <button
                    v-if="revealed === null"
                    type="button"
                    class="cw-btn cw-btn-primary"
                    style="margin-top: 16px"
                    @click="reveal"
                >
                    {{ t('shopReveal') }}
                </button>
                <pre
                    v-else
                    class="cw-card"
                    style="
                        margin-top: 16px;
                        padding: 14px 16px;
                        white-space: pre-wrap;
                        overflow-wrap: anywhere;
                    "
                    >{{ revealed }}</pre
                >
                <p
                    v-if="revealError"
                    class="cw-note cw-note-bad"
                    style="margin-top: 8px"
                >
                    <span>{{ revealError }}</span>
                </p>
                <p
                    v-if="order.state === 'delivered'"
                    class="cw-note"
                    style="margin-top: 8px"
                >
                    <span>{{ t('shopCheckNote') }}</span>
                </p>
            </template>

            <div
                style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    margin-top: 16px;
                "
            >
                <button
                    v-for="kind in actions.filter((a) => a !== 'deliver')"
                    :key="kind"
                    type="button"
                    class="cw-btn"
                    :class="
                        kind === 'confirm'
                            ? 'cw-btn-primary'
                            : 'cw-btn-secondary'
                    "
                    style="flex: 1; min-width: 140px"
                    :disabled="busy || !canSign"
                    @click="act(kind as 'confirm')"
                >
                    {{ t(`shopAct_${kind}`) }}
                </button>
            </div>

            <template v-if="order.buyer.toLowerCase() === me">
                <div class="cw-row" style="margin: 22px 0 8px">
                    <span class="cw-label">{{ t('shopReport') }}</span>
                </div>
                <input
                    v-model="reportReason"
                    class="cw-input"
                    maxlength="280"
                    :placeholder="t('shopReportPlaceholder')"
                />
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="margin-top: 8px"
                    :disabled="busy || reportReason.trim() === ''"
                    @click="report"
                >
                    {{ t('shopReportSend') }}
                </button>
            </template>
        </template>

        <!-- ----------------------------------------------------- sell --- -->
        <template v-else-if="view.kind === 'sell'">
            <button
                type="button"
                class="cw-back"
                @click="view = { kind: 'list' }"
            >
                ← {{ t('shopTitle') }}
            </button>
            <h2 class="cw-title" style="margin: 18px 0 8px">
                {{ t('shopSell') }}
            </h2>

            <div class="cw-card" style="padding: 14px 16px">
                <span class="cw-label">{{ t('shopRulesTitle') }}</span>
                <ul
                    class="cw-prose"
                    style="margin: 8px 0 0; padding-left: 18px"
                >
                    <li v-for="rule in SHOP_FORBIDDEN" :key="rule">
                        {{ t(`shopForbid_${rule}`) }}
                    </li>
                </ul>
                <p class="cw-prose" style="margin-top: 8px">
                    {{ t('shopAccountRule') }}
                </p>
            </div>

            <select
                v-model="form.category"
                class="cw-input"
                style="margin-top: 14px"
            >
                <option
                    v-for="category in SHOP_CATEGORIES"
                    :key="category"
                    :value="category"
                >
                    {{ categoryLabel(category) }}
                </option>
            </select>
            <input
                v-model="form.title"
                class="cw-input"
                style="margin-top: 10px"
                maxlength="80"
                :placeholder="t('shopFormTitle')"
            />
            <input
                v-model="form.delivers"
                class="cw-input"
                style="margin-top: 10px"
                maxlength="200"
                :placeholder="t('shopFormDelivers')"
            />
            <textarea
                v-model="form.description"
                class="cw-input"
                rows="3"
                style="margin-top: 10px; height: auto"
                maxlength="2000"
                :placeholder="t('shopFormDescription')"
            />
            <div style="display: flex; gap: 8px; margin-top: 10px">
                <input
                    v-model="form.price"
                    class="cw-input"
                    inputmode="decimal"
                    :placeholder="t('shopPrice')"
                />
                <input
                    v-model="form.stock"
                    class="cw-input"
                    inputmode="numeric"
                    style="max-width: 110px"
                    :placeholder="t('shopStock')"
                />
            </div>
            <input
                v-model="form.payToken"
                class="cw-input"
                style="margin-top: 10px"
                spellcheck="false"
                :placeholder="t('shopFormTokenPlaceholder')"
            />
            <p class="cw-label" style="margin-top: 4px; color: var(--cw-faint)">
                {{ t('shopFormTokenHint') }}
            </p>

            <template
                v-if="form.category === 'domain' || form.nftContract !== ''"
            >
                <div style="display: flex; gap: 8px; margin-top: 10px">
                    <input
                        v-model="form.nftContract"
                        class="cw-input"
                        spellcheck="false"
                        :placeholder="t('shopFormNftContract')"
                    />
                    <input
                        v-model="form.nftId"
                        class="cw-input"
                        inputmode="numeric"
                        style="max-width: 110px"
                        placeholder="id"
                    />
                </div>
                <p
                    class="cw-label"
                    style="margin-top: 4px; color: var(--cw-faint)"
                >
                    {{ t('shopFormNftHint') }}
                </p>
            </template>

            <label
                class="cw-prose"
                style="
                    display: flex;
                    gap: 8px;
                    margin-top: 14px;
                    align-items: flex-start;
                "
            >
                <input
                    v-model="form.agreed"
                    type="checkbox"
                    style="margin-top: 4px"
                />
                <span>{{ t('shopFormAgree') }}</span>
            </label>

            <p
                v-if="formError"
                class="cw-label"
                style="margin-top: 10px; color: var(--cw-faint)"
            >
                {{ formError }}
            </p>
            <p
                v-if="!identity"
                class="cw-note cw-note-bad"
                style="margin-top: 10px"
            >
                <span>{{ t('shopNeedsKey') }}</span>
            </p>
            <div style="margin-top: 14px">
                <HoldButton
                    :label="busy ? t('shopWorking') : t('shopListHold')"
                    :disabled="
                        busy || !canSign || formError !== null || !identity
                    "
                    @complete="list"
                />
            </div>
        </template>

        <!-- ----------------------------------------------------- list --- -->
        <template v-else>
            <div
                style="
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                    gap: 12px;
                "
            >
                <h2 class="cw-title" style="margin: 0">{{ t('shopTitle') }}</h2>
                <span class="cw-label" style="color: var(--cw-faint)"
                    >Cyberia Fuji</span
                >
            </div>
            <p class="cw-prose" style="margin-top: 8px">{{ t('shopBody') }}</p>

            <p v-if="!SHOP_ADDRESS" class="cw-note" style="margin-top: 14px">
                <span>{{ t('shopNotDeployed') }}</span>
            </p>

            <template v-else>
                <button
                    type="button"
                    class="cw-btn cw-btn-primary"
                    style="height: 48px; margin-top: 16px"
                    :disabled="!canSign"
                    @click="view = { kind: 'sell' }"
                >
                    {{ t('shopSell') }}
                </button>

                <div
                    style="
                        display: flex;
                        flex-wrap: wrap;
                        gap: 6px;
                        margin-top: 14px;
                    "
                >
                    <button
                        v-for="option in [
                            'all',
                            ...SHOP_CATEGORIES,
                            'mine',
                        ] as const"
                        :key="option"
                        type="button"
                        class="cw-chip"
                        :class="{ 'cw-chip-on': filter === option }"
                        @click="filter = option"
                    >
                        {{
                            option === 'all'
                                ? t('shopAll')
                                : option === 'mine'
                                  ? t('shopMine')
                                  : categoryLabel(option)
                        }}
                    </button>
                </div>

                <template v-if="orders.length > 0">
                    <div class="cw-row" style="margin: 20px 0 8px">
                        <span class="cw-label">{{ t('shopOrders') }}</span>
                        <span class="cw-label" style="color: var(--cw-faint)">{{
                            orders.length
                        }}</span>
                    </div>
                    <button
                        v-for="row in orders"
                        :key="`o${row.id}`"
                        type="button"
                        class="cw-card cw-card-button"
                        style="
                            display: flex;
                            justify-content: space-between;
                            gap: 12px;
                            padding: 12px 14px;
                            margin-bottom: 6px;
                            text-align: left;
                        "
                        @click="view = { kind: 'order', id: row.id }"
                    >
                        <span
                            >{{ t('shopOrder', { id: row.id.toString() }) }} ·
                            {{
                                listings.find((l) => l.id === row.listingId)
                                    ? titleOf(
                                          listings.find(
                                              (l) => l.id === row.listingId,
                                          )!,
                                      )
                                    : ''
                            }}</span
                        >
                        <span class="cw-label">{{
                            t(`shopState_${row.state}`)
                        }}</span>
                    </button>
                </template>

                <p
                    v-if="failure"
                    class="cw-note cw-note-bad"
                    style="margin-top: 18px"
                >
                    <span style="flex: 1">{{ t('shopUnreadable') }}</span>
                    <button type="button" class="cw-back" @click="load">
                        {{ t('retry') }}
                    </button>
                </p>
                <p
                    v-else-if="loading"
                    class="cw-label"
                    style="margin-top: 18px; color: var(--cw-faint)"
                >
                    {{ t('shopLoading') }}
                </p>
                <p
                    v-else-if="visible.length === 0"
                    class="cw-prose"
                    style="margin-top: 18px"
                >
                    {{ t('shopEmpty') }}
                </p>
                <template v-else>
                    <div class="cw-row" style="margin: 20px 0 8px">
                        <span class="cw-label">{{ t('shopLots') }}</span>
                        <span class="cw-label" style="color: var(--cw-faint)">{{
                            visible.length
                        }}</span>
                    </div>
                    <button
                        v-for="row in visible"
                        :key="`l${row.id}`"
                        type="button"
                        class="cw-card cw-card-button"
                        style="
                            display: flex;
                            justify-content: space-between;
                            gap: 12px;
                            padding: 12px 14px;
                            margin-bottom: 6px;
                            text-align: left;
                        "
                        @click="view = { kind: 'lot', id: row.id }"
                    >
                        <span style="min-width: 0">
                            <span
                                style="
                                    display: block;
                                    font: 500 14px/1.3 var(--cw-sans);
                                    overflow: hidden;
                                    text-overflow: ellipsis;
                                    white-space: nowrap;
                                "
                                >{{ titleOf(row) }}</span
                            >
                            <span class="cw-data" style="font-size: 12px"
                                >{{ categoryLabel(row.category) }} ·
                                {{ t('shopStockLeft', { n: row.stock })
                                }}<template v-if="row.closed || row.hidden">
                                    · {{ t('shopOff') }}</template
                                ></span
                            >
                        </span>
                        <span class="cw-data" style="white-space: nowrap"
                            >{{ amount(row.price, row.pay.decimals) }}
                            {{ row.pay.symbol }}</span
                        >
                    </button>
                </template>
            </template>

            <p v-if="notice" class="cw-note" style="margin-top: 14px">
                <span>{{ notice }}</span>
            </p>
        </template>

        <p
            v-if="actionError"
            class="cw-note cw-note-bad"
            style="margin-top: 14px"
        >
            <span>{{ actionError }}</span>
        </p>
    </div>
</template>
