<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { formatUnits, parseUnits } from '@/lib/wallet';
import { walletChain, walletChains } from '@/lib/wallet/chains';
import type { WalletChainId } from '@/lib/wallet/chains';
import { shortAddress } from '@/lib/wallet/format';
import {
    NATIVE,
    OTC_DEFAULT_CHAIN,
    OTC_DEPLOYMENTS,
    affordable,
    discussText,
    fillAllowed,
    nativeGasReserve,
    otcAssets,
    payFor,
    quickCyberFill,
    readBalance,
    readOtcBook,
    readSide,
    unitPriceOf,
} from '@/lib/wallet/otc';
import type { OtcAction, OtcAsset, OtcOrder, OtcSide } from '@/lib/wallet/otc';
import { walletMessages } from '@/lib/walletMessages';

/**
 * OTC: offers at a price somebody names, on any network the desk is
 * deployed on — one book per network, because an offer is escrowed where its
 * assets live.
 *
 * A pool prices a trade against itself, so the bigger the trade the worse the
 * price. Here the seller names the price for the whole amount, puts it in
 * escrow, and a buyer pays exactly that — for all of it or, when allowed, a
 * part. There is no platform fee: the buyer's payment goes to the seller in
 * full, and gas is the only cost on either side.
 *
 * Two acts, two tabs: take an offer from the book, or put one in it. A third
 * thing happens between people rather than on the chain — "Discuss" opens the
 * encrypted chat with the seller, and "Counter-offer" turns what was agreed
 * there into a private offer only that seller can accept. Only the chain
 * binds anyone; the chat is where the terms are found.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** Open a new offer selling this token, from the token's own screen. */
    prefill?: { chain: WalletChainId; sell: string } | null;
}>();
const emit = defineEmits<{
    back: [];
    /** Open the encrypted chat with an address, with a line ready to send. */
    discuss: [address: string, text: string];
}>();

const { t } = useLocale(walletMessages);

const tab = ref<'book' | 'new'>(props.prefill ? 'new' : 'book');

const params =
    typeof window === 'undefined'
        ? new URLSearchParams()
        : new URL(window.location.href).searchParams;

/** Every network with a desk, in the wallet's own order. */
const networks = walletChains().filter(
    (chain) => chain.family === 'evm' && OTC_DEPLOYMENTS[chain.id],
);

const initialChain = (): WalletChainId => {
    const wanted = props.prefill?.chain ?? params.get('chain');
    const found = networks.find((chain) => chain.id === wanted);

    return (
        found?.id ??
        networks.find((chain) => chain.id === OTC_DEFAULT_CHAIN)?.id ??
        networks[0]?.id ??
        OTC_DEFAULT_CHAIN
    );
};

const chainId = ref<WalletChainId>(initialChain());
const chain = computed(() => walletChain(chainId.value));
const desk = computed(() => props.wallet.otcDeskFor(chainId.value));
const deployed = computed(() => desk.value !== null);

/** One key, one address on every EVM network — the desk's included. */
const me = computed(
    () =>
        props.wallet.accounts.value.find(
            (entry) => entry.chain === chainId.value,
        )?.address ?? null,
);

const isMine = (address: string): boolean =>
    me.value !== null && address.toLowerCase() === me.value.toLowerCase();

const book = ref<OtcOrder[]>([]);
const loading = ref(false);
const failure = ref<string | null>(null);
const sent = ref<string | null>(null);
const sentUrl = computed(() =>
    sent.value ? chain.value.explorerTxUrl(sent.value) : null,
);

/** An offer named by a link (`?offer=12`), opened on arrival. */
const linked = (() => {
    const value = params.get('offer');

    return value && /^\d+$/.test(value) ? BigInt(value) : null;
})();

const load = async (): Promise<void> => {
    const current = desk.value;

    if (!current) {
        book.value = [];

        return;
    }

    loading.value = true;
    failure.value = null;

    try {
        const read = await readOtcBook(current);

        // The network changed while this was in flight.
        if (desk.value?.chain !== current.chain) {
            return;
        }

        book.value = read;
        const wanted = book.value.find((order) => order.id === linked);

        if (wanted && !selected.value) {
            void open(wanted);
        }
    } catch (error) {
        failure.value = (error as Error).message;
    } finally {
        loading.value = false;
    }
};

onMounted(load);

const run = async (action: OtcAction): Promise<boolean> => {
    failure.value = null;
    sent.value = null;

    try {
        sent.value = await props.wallet.otc(chainId.value, action);
        selected.value = null;
        editing.value = null;
        // The book is read from the chain; give the block a moment to land.
        setTimeout(load, 2_500);

        return true;
    } catch (error) {
        failure.value = (error as Error).message;

        return false;
    }
};

const amount = (value: bigint, side: OtcSide, digits = 6): string =>
    `${formatUnits(value, side.decimals, digits)} ${side.symbol}`;

const parse = (text: string, decimals: number): bigint | null => {
    try {
        const value = parseUnits(text.trim() || '0', decimals);

        return value > 0n ? value : null;
    } catch {
        return null;
    }
};

/** Price of one unit of the sell asset, in the buy asset. */
const unitPrice = (order: OtcOrder): string =>
    amount(
        (10n ** BigInt(order.sell.decimals) * order.priceBuy) / order.priceSell,
        order.buy,
        8,
    );

/** All offers, or only the ones this wallet made or was offered. */
const filter = ref<'all' | 'mine'>('all');

const visible = computed(() =>
    book.value.filter(
        (order) =>
            (!order.expired || isMine(order.maker)) &&
            (filter.value === 'all' ||
                isMine(order.maker) ||
                (order.taker !== null && isMine(order.taker))),
    ),
);

/* ---------------------------------------------------------------- take --- */

const selected = ref<OtcOrder | null>(null);
const takeInput = ref('');
/** What the buyer holds of the asset this offer is paid in. */
const budget = ref<bigint | null>(null);

const takeAmount = computed((): bigint | null => {
    const order = selected.value;

    if (!order) {
        return null;
    }

    const value = order.partialFill
        ? parse(takeInput.value, order.sell.decimals)
        : order.remaining;

    return value !== null && fillAllowed(order, value) ? value : null;
});

const takePay = computed(() =>
    selected.value && takeAmount.value
        ? payFor(selected.value, takeAmount.value)
        : null,
);

const shortOfFunds = computed(
    () =>
        takePay.value !== null &&
        budget.value !== null &&
        takePay.value > budget.value,
);

const quickAmounts = [100n, 200n, 500n] as const;
const quickFill = (order: OtcOrder, cyber: bigint): bigint | null =>
    quickCyberFill(order, cyber * 10n ** BigInt(order.buy.decimals));
const selectQuickFill = (order: OtcOrder, cyber: bigint): void => {
    const value = quickFill(order, cyber);
    if (value !== null) {
        takeInput.value = formatUnits(
            value,
            order.sell.decimals,
            order.sell.decimals,
        );
    }
};

const open = async (order: OtcOrder): Promise<void> => {
    selected.value = order;
    budget.value = null;
    takeInput.value = order.partialFill
        ? formatUnits(order.remaining, order.sell.decimals, order.sell.decimals)
        : '';
    const initialInput = takeInput.value;

    if (!me.value) {
        return;
    }

    try {
        const balance = await readBalance(
            desk.value!,
            order.buy.address,
            me.value,
        );
        if (selected.value?.id !== order.id) return;
        budget.value = balance;

        // Cannot pay for all of it: offer the most that can be paid for.
        if (
            order.partialFill &&
            takeInput.value === initialInput &&
            payFor(order, order.remaining) > budget.value
        ) {
            const most = affordable(order, budget.value);

            takeInput.value =
                most >= order.minFill && most > 0n
                    ? formatUnits(
                          most,
                          order.sell.decimals,
                          order.sell.decimals,
                      )
                    : '';
        }
    } catch {
        budget.value = null;
    }
};

const discuss = (order: OtcOrder): void =>
    emit(
        'discuss',
        order.maker,
        discussText(chainId.value, order, unitPrice(order)),
    );

/* ----------------------------------------------------- the maker's own --- */

type Edit = 'reprice' | 'topUp' | 'reduce';

const editing = ref<{ id: bigint; kind: Edit } | null>(null);
const editInput = ref('');

const startEdit = (order: OtcOrder, kind: Edit): void => {
    editing.value = { id: order.id, kind };
    editInput.value = '';
};

const editAction = (order: OtcOrder): OtcAction | null => {
    const kind = editing.value?.kind;

    if (kind === 'reprice') {
        // The new price, as a total for what remains.
        const total = parse(editInput.value, order.buy.decimals);

        return total
            ? {
                  kind: 'reprice',
                  id: order.id,
                  priceSell: order.remaining,
                  priceBuy: total,
              }
            : null;
    }

    const value = parse(editInput.value, order.sell.decimals);

    if (!value) {
        return null;
    }

    if (kind === 'topUp') {
        return { kind: 'topUp', order, amount: value };
    }

    return value < order.remaining
        ? { kind: 'reduce', id: order.id, amount: value }
        : null;
};

/* ----------------------------------------------------------------- make -- */

const CUSTOM = 'custom';

/**
 * What can be picked on this network: the coin, what this wallet holds here,
 * and the protocol's own tokens — anything else is a pasted address.
 */
const assets = computed((): OtcAsset[] => {
    const current = desk.value;

    if (!current) {
        return [];
    }

    const held = (props.wallet.tokens.value[chainId.value]?.items ?? []).map(
        (token) => ({ address: token.address, symbol: token.symbol }),
    );

    return otcAssets(current, held);
});

/** The two legs of a new offer: which asset, a typed address for any other, how much. */
const legs = reactive({
    sell: { asset: NATIVE, custom: '', value: '' },
    buy: { asset: CUSTOM, custom: '', value: '' },
});

/** Default the buy side to the first asset that is not the sell side. */
const resetLegs = (): void => {
    legs.sell.asset = props.prefill?.sell ?? NATIVE;
    legs.sell.custom = '';
    legs.buy.asset =
        assets.value.find(
            (asset) =>
                asset.address.toLowerCase() !== legs.sell.asset.toLowerCase(),
        )?.address ?? CUSTOM;
    legs.buy.custom = '';

    if (pickerValue(legs.sell.asset) === CUSTOM) {
        legs.sell.custom = legs.sell.asset;
        legs.sell.asset = CUSTOM;
    }
};

/** Both legs resolved to their contracts, once each address reads. */
const sides = reactive<{ sell: OtcSide | null; buy: OtcSide | null }>({
    sell: null,
    buy: null,
});
/** What this wallet holds of the asset being sold. */
const sellHeld = ref<bigint | null>(null);

/** One counter per leg: only the newest resolution may write its result. */
const resolving = { sell: 0, buy: 0 };

const resolveLeg = async (key: 'sell' | 'buy'): Promise<void> => {
    const current = desk.value;
    const leg = legs[key];
    const address = leg.asset === CUSTOM ? leg.custom.trim() : leg.asset;
    const generation = ++resolving[key];
    const stale = (): boolean => resolving[key] !== generation;

    sides[key] = null;

    if (key === 'sell') {
        sellHeld.value = null;
    }

    if (!current || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        return;
    }

    try {
        const side = await readSide(current, address);

        if (stale()) {
            return;
        }

        sides[key] = side;

        if (key === 'sell' && me.value) {
            const [held, reserve] = await Promise.all([
                readBalance(current, side.address, me.value),
                side.address === NATIVE
                    ? nativeGasReserve(current)
                    : Promise.resolve(0n),
            ]);

            if (!stale()) {
                // What can be escrowed: the coin keeps back its own gas.
                sellHeld.value = held > reserve ? held - reserve : 0n;
            }
        }
    } catch {
        if (!stale()) {
            sides[key] = null;
        }
    }
};

watch(
    () => [chainId.value, legs.sell.asset, legs.sell.custom, me.value],
    () => void resolveLeg('sell'),
    { immediate: true },
);
watch(
    () => [chainId.value, legs.buy.asset, legs.buy.custom],
    () => void resolveLeg('buy'),
    { immediate: true },
);

const maxSell = (): void => {
    const side = sides.sell;

    if (side && sellHeld.value !== null) {
        legs.sell.value = formatUnits(
            sellHeld.value,
            side.decimals,
            side.decimals,
        );
    }
};

/**
 * The deal as one sentence, before anything is signed: what leaves this
 * wallet, what comes back, and the price of one unit.
 */
const summary = computed((): string | null => {
    const sell = sides.sell;
    const buy = sides.buy;

    if (!sell || !buy) {
        return null;
    }

    const give = parse(legs.sell.value, sell.decimals);
    const get = parse(legs.buy.value, buy.decimals);
    const unit = give && get ? unitPriceOf(give, get, sell.decimals) : null;

    if (!give || !get || unit === null) {
        return null;
    }

    return t('otcSummary', {
        give: amount(give, sell),
        get: amount(get, buy),
        unit: amount(unit, buy, 8),
        symbol: sell.symbol,
    });
});

const overBalance = computed(() => {
    const side = sides.sell;
    const give = side ? parse(legs.sell.value, side.decimals) : null;

    return give !== null && sellHeld.value !== null && give > sellHeld.value;
});
const takerInput = ref('');
const partialFill = ref(true);
const minFillInput = ref('');
const expiryDays = ref(0);

const sideOf = async (choice: string, custom: string): Promise<OtcSide> =>
    readSide(desk.value!, choice === CUSTOM ? custom.trim() : choice);

const pickerValue = (address: string): string =>
    assets.value.find(
        (asset) => asset.address.toLowerCase() === address.toLowerCase(),
    )?.address ?? CUSTOM;

/**
 * The other side of an offer, addressed to its maker: what was agreed in
 * chat, made binding. The buyer escrows the payment; only the maker can
 * accept it.
 */
const counter = (order: OtcOrder): void => {
    legs.sell.asset = pickerValue(order.buy.address);
    legs.sell.custom = legs.sell.asset === CUSTOM ? order.buy.address : '';
    legs.sell.value = formatUnits(
        payFor(order, order.remaining),
        order.buy.decimals,
        order.buy.decimals,
    );
    legs.buy.asset = pickerValue(order.sell.address);
    legs.buy.custom = legs.buy.asset === CUSTOM ? order.sell.address : '';
    legs.buy.value = formatUnits(
        order.remaining,
        order.sell.decimals,
        order.sell.decimals,
    );
    takerInput.value = order.maker;
    partialFill.value = false;
    tab.value = 'new';
};

const makeReady = computed(
    () =>
        summary.value !== null &&
        !overBalance.value &&
        sides.sell?.address.toLowerCase() !== sides.buy?.address.toLowerCase(),
);

const make = async (): Promise<void> => {
    failure.value = null;

    try {
        const [sell, buy] = await Promise.all([
            sideOf(legs.sell.asset, legs.sell.custom),
            sideOf(legs.buy.asset, legs.buy.custom),
        ]);
        const sellAmount = parseUnits(legs.sell.value.trim(), sell.decimals);

        if (me.value) {
            const held = await readBalance(desk.value!, sell.address, me.value);

            if (held < sellAmount) {
                failure.value = t('otcNotEnough', {
                    amount: amount(held, sell),
                });

                return;
            }
        }

        const taker = takerInput.value.trim();
        const done = await run({
            kind: 'create',
            sell: sell.address,
            sellAmount,
            buy: buy.address,
            buyAmount: parseUnits(legs.buy.value.trim(), buy.decimals),
            taker: taker === '' ? null : taker,
            expiry:
                expiryDays.value === 0
                    ? null
                    : Math.floor(Date.now() / 1_000) +
                      expiryDays.value * 86_400,
            partialFill: partialFill.value,
            minFill:
                partialFill.value && minFillInput.value.trim() !== ''
                    ? parseUnits(minFillInput.value.trim(), sell.decimals)
                    : 0n,
        });

        if (done) {
            legs.sell.value = '';
            legs.buy.value = '';
            takerInput.value = '';
            minFillInput.value = '';
            tab.value = 'book';
        }
    } catch (error) {
        failure.value = (error as Error).message;
    }
};

watch(tab, () => {
    failure.value = null;
});

watch(chainId, () => {
    // Offers are numbered per network: a card left from the last one would
    // act on whatever carries its id here.
    book.value = [];
    selected.value = null;
    editing.value = null;
    sent.value = null;
    failure.value = null;
    resetLegs();
    void load();
});

resetLegs();
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navMore') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">{{ t('otcTitle') }}</h2>
        <p class="cw-prose">{{ t('otcIntro') }}</p>

        <!-- One book per network: an offer is escrowed where its assets live. -->
        <div
            v-if="networks.length > 1"
            class="cw-row"
            style="
                gap: 8px;
                margin-top: 14px;
                justify-content: flex-start;
                flex-wrap: wrap;
            "
        >
            <button
                v-for="network in networks"
                :key="network.id"
                type="button"
                class="cw-chip"
                :class="{ 'cw-chip-on': chainId === network.id }"
                :aria-pressed="chainId === network.id"
                @click="chainId = network.id"
            >
                {{ network.label }}
            </button>
        </div>

        <p
            v-if="!deployed"
            class="cw-note cw-note-warn"
            style="margin-top: 18px"
        >
            <span>{{ t('otcNotDeployed') }}</span>
        </p>

        <template v-else>
            <div class="cw-seg" style="margin-top: 18px">
                <button
                    v-for="option in ['book', 'new'] as const"
                    :key="option"
                    type="button"
                    class="cw-seg-item"
                    :class="{ 'cw-seg-bar': tab === option }"
                    :aria-pressed="tab === option"
                    @click="tab = option"
                >
                    {{ option === 'book' ? t('otcBook') : t('otcNew') }}
                </button>
            </div>

            <p v-if="sent" class="cw-note" style="margin-top: 14px">
                <span
                    >{{ t('otcSent') }}
                    <a
                        v-if="sentUrl"
                        :href="sentUrl"
                        target="_blank"
                        rel="noopener noreferrer"
                        >{{ shortAddress(sent) }} ↗</a
                    ><template v-else>{{ shortAddress(sent) }}</template></span
                >
            </p>
            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 14px"
            >
                <span>{{ failure }}</span>
            </p>

            <!-- ----------------------------------------------------- book -- -->
            <template v-if="tab === 'book'">
                <div
                    class="cw-row"
                    style="
                        gap: 8px;
                        margin-top: 14px;
                        justify-content: flex-start;
                    "
                >
                    <button
                        v-for="option in ['all', 'mine'] as const"
                        :key="option"
                        type="button"
                        class="cw-chip"
                        :class="{ 'cw-chip-on': filter === option }"
                        @click="filter = option"
                    >
                        {{ option === 'all' ? t('otcAll') : t('otcMine') }}
                    </button>
                    <button
                        type="button"
                        class="cw-chip"
                        :disabled="loading"
                        @click="load()"
                    >
                        ↻
                    </button>
                </div>
                <p v-if="loading" class="cw-prose" style="margin-top: 18px">
                    {{ t('otcLoading') }}
                </p>
                <div v-else-if="visible.length === 0" style="margin-top: 18px">
                    <p class="cw-prose">
                        {{ t('otcEmptyOn', { network: chain.label }) }}
                    </p>
                    <button
                        type="button"
                        class="cw-btn cw-btn-primary"
                        style="margin-top: 12px"
                        @click="tab = 'new'"
                    >
                        {{ t('otcPlaceFirst') }}
                    </button>
                </div>

                <div
                    v-for="order in visible"
                    :key="String(order.id)"
                    class="cw-card"
                    style="margin-top: 12px"
                >
                    <div class="cw-row">
                        <span style="font: 500 16px/1.2 var(--cw-sans)">
                            {{ amount(order.remaining, order.sell) }}
                        </span>
                        <span class="cw-label">#{{ String(order.id) }}</span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('otcPrice') }}</span>
                        <span class="cw-kv-val">{{ unitPrice(order) }}</span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('otcForAll') }}</span>
                        <span class="cw-kv-val">{{
                            amount(payFor(order, order.remaining), order.buy)
                        }}</span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('otcMaker') }}</span>
                        <span class="cw-kv-val">{{
                            isMine(order.maker)
                                ? t('otcYou')
                                : shortAddress(order.maker)
                        }}</span>
                    </div>
                    <p class="cw-label" style="margin-top: 6px">
                        <template v-if="!order.partialFill">{{
                            t('otcAllOrNothing')
                        }}</template>
                        <template v-else-if="order.minFill > 0n">{{
                            t('otcMinFill', {
                                amount: amount(order.minFill, order.sell),
                            })
                        }}</template>
                        <template v-else>{{ t('otcPartialOk') }}</template>
                        <template v-if="order.taker">
                            · {{ t('otcPrivate') }}
                            {{
                                isMine(order.taker)
                                    ? t('otcYou')
                                    : shortAddress(order.taker)
                            }}</template
                        ><template v-if="order.expired">
                            · {{ t('otcExpired') }}</template
                        ><template v-else-if="order.expiry">
                            ·
                            {{
                                t('otcUntil', {
                                    date: new Date(
                                        order.expiry * 1_000,
                                    ).toLocaleString(),
                                })
                            }}</template
                        >
                    </p>

                    <!-- The maker's own offer: change it or take it back. -->
                    <template v-if="isMine(order.maker)">
                        <div v-if="order.expired" style="margin-top: 12px">
                            <HoldButton
                                :label="t('otcReclaim')"
                                :disabled="wallet.busy.value"
                                @complete="
                                    run({ kind: 'reclaim', id: order.id })
                                "
                            />
                        </div>
                        <template v-else>
                            <div
                                class="cw-row"
                                style="
                                    gap: 8px;
                                    margin-top: 12px;
                                    justify-content: flex-start;
                                    flex-wrap: wrap;
                                "
                            >
                                <button
                                    v-for="kind in [
                                        'reprice',
                                        'topUp',
                                        'reduce',
                                    ] as const"
                                    :key="kind"
                                    type="button"
                                    class="cw-chip"
                                    :class="{
                                        'cw-chip-on':
                                            editing?.id === order.id &&
                                            editing?.kind === kind,
                                    }"
                                    @click="startEdit(order, kind)"
                                >
                                    {{
                                        kind === 'reprice'
                                            ? t('otcReprice')
                                            : kind === 'topUp'
                                              ? t('otcTopUp')
                                              : t('otcReduce')
                                    }}
                                </button>
                            </div>
                            <template v-if="editing?.id === order.id">
                                <span
                                    class="cw-label"
                                    style="display: block; margin-top: 12px"
                                    >{{
                                        editing.kind === 'reprice'
                                            ? t('otcRepriceHint', {
                                                  amount: amount(
                                                      order.remaining,
                                                      order.sell,
                                                  ),
                                                  symbol: order.buy.symbol,
                                              })
                                            : t('otcAmount', {
                                                  symbol: order.sell.symbol,
                                              })
                                    }}</span
                                >
                                <input
                                    v-model="editInput"
                                    class="cw-input"
                                    inputmode="decimal"
                                    spellcheck="false"
                                    placeholder="0.0"
                                />
                                <div style="margin-top: 10px">
                                    <HoldButton
                                        :label="t('holdToSign')"
                                        :disabled="
                                            editAction(order) === null ||
                                            wallet.busy.value
                                        "
                                        @complete="run(editAction(order)!)"
                                    />
                                </div>
                            </template>
                            <div style="margin-top: 12px">
                                <HoldButton
                                    :label="t('otcCancel')"
                                    :disabled="wallet.busy.value"
                                    @complete="
                                        run({ kind: 'cancel', id: order.id })
                                    "
                                />
                            </div>
                        </template>
                    </template>

                    <!-- Somebody else's: take it, or talk about it. -->
                    <template
                        v-else-if="
                            !order.expired &&
                            (!order.taker || isMine(order.taker))
                        "
                    >
                        <div
                            class="cw-row"
                            style="
                                gap: 8px;
                                margin-top: 12px;
                                justify-content: flex-start;
                                flex-wrap: wrap;
                            "
                        >
                            <button
                                v-if="selected?.id !== order.id"
                                type="button"
                                class="cw-btn"
                                @click="open(order)"
                            >
                                {{ t('otcTake') }}
                            </button>
                            <button
                                type="button"
                                class="cw-btn cw-btn-secondary"
                                @click="discuss(order)"
                            >
                                {{ t('otcDiscuss') }}
                            </button>
                            <button
                                type="button"
                                class="cw-btn cw-btn-secondary"
                                @click="counter(order)"
                            >
                                {{ t('otcCounter') }}
                            </button>
                        </div>

                        <template v-if="selected?.id === order.id">
                            <template v-if="order.partialFill">
                                <span
                                    class="cw-label"
                                    style="display: block; margin-top: 12px"
                                    >{{
                                        t('otcAmount', {
                                            symbol: order.sell.symbol,
                                        })
                                    }}</span
                                >
                                <input
                                    v-model="takeInput"
                                    class="cw-input"
                                    inputmode="decimal"
                                    spellcheck="false"
                                    placeholder="0.0"
                                />
                                <div
                                    v-if="
                                        order.buy.address.toLowerCase() ===
                                        NATIVE.toLowerCase()
                                    "
                                    class="cw-row"
                                    style="
                                        justify-content: flex-start;
                                        gap: 8px;
                                        flex-wrap: wrap;
                                        margin-top: 8px;
                                    "
                                >
                                    <button
                                        v-for="cyber in quickAmounts"
                                        :key="cyber.toString()"
                                        type="button"
                                        class="cw-chip"
                                        :disabled="
                                            quickFill(order, cyber) === null
                                        "
                                        @click="selectQuickFill(order, cyber)"
                                    >
                                        ≤ {{ cyber.toString() }} CYBER
                                    </button>
                                </div>
                            </template>
                            <div
                                v-if="takePay !== null"
                                style="margin-top: 10px"
                            >
                                <div class="cw-kv">
                                    <span class="cw-kv-key">{{
                                        t('otcYouPay')
                                    }}</span>
                                    <span class="cw-kv-val">{{
                                        amount(
                                            takePay,
                                            order.buy,
                                            order.buy.decimals,
                                        )
                                    }}</span>
                                </div>
                                <div class="cw-kv">
                                    <span class="cw-kv-key">{{
                                        t('otcYouGet')
                                    }}</span>
                                    <span class="cw-kv-val">{{
                                        amount(
                                            takeAmount ?? 0n,
                                            order.sell,
                                            order.sell.decimals,
                                        )
                                    }}</span>
                                </div>
                                <div class="cw-kv">
                                    <span class="cw-kv-key">{{
                                        t('otcFee')
                                    }}</span>
                                    <span class="cw-kv-val">{{
                                        t('otcGasOnly')
                                    }}</span>
                                </div>
                            </div>
                            <p
                                v-if="shortOfFunds"
                                class="cw-note cw-note-warn"
                                style="margin-top: 10px"
                            >
                                <span>{{
                                    t('otcNotEnough', {
                                        amount: amount(budget ?? 0n, order.buy),
                                    })
                                }}</span>
                            </p>
                            <div style="margin-top: 12px">
                                <HoldButton
                                    :label="t('holdToSign')"
                                    :disabled="
                                        takePay === null ||
                                        shortOfFunds ||
                                        wallet.busy.value
                                    "
                                    @complete="
                                        run({
                                            kind: 'fill',
                                            order,
                                            amount: takeAmount!,
                                            maxPay: takePay!,
                                        })
                                    "
                                />
                            </div>
                        </template>
                    </template>

                    <!-- Expired and not ours: anyone may send it back to its maker. -->
                    <div v-else-if="order.expired" style="margin-top: 12px">
                        <HoldButton
                            :label="t('otcReclaim')"
                            :disabled="wallet.busy.value"
                            @complete="run({ kind: 'reclaim', id: order.id })"
                        />
                    </div>
                </div>
            </template>

            <!-- ------------------------------------------------------ new -- -->
            <template v-else>
                <template v-for="key in ['sell', 'buy'] as const" :key="key">
                    <span
                        class="cw-label"
                        style="display: block; margin-top: 18px"
                        >{{ key === 'sell' ? t('otcSell') : t('otcBuy') }}</span
                    >
                    <div class="cw-row" style="gap: 8px; margin-top: 8px">
                        <select
                            v-model="legs[key].asset"
                            class="cw-input"
                            style="flex: 0 0 40%"
                        >
                            <option
                                v-for="asset in assets"
                                :key="asset.address"
                                :value="asset.address"
                            >
                                {{ asset.symbol }}
                            </option>
                            <option :value="CUSTOM">{{ t('otcOther') }}</option>
                        </select>
                        <input
                            v-model="legs[key].value"
                            class="cw-input"
                            inputmode="decimal"
                            spellcheck="false"
                            placeholder="0.0"
                        />
                    </div>
                    <input
                        v-if="legs[key].asset === CUSTOM"
                        v-model="legs[key].custom"
                        class="cw-input"
                        style="margin-top: 8px"
                        spellcheck="false"
                        placeholder="0x…"
                    />
                    <div
                        v-if="key === 'sell' && sides.sell && sellHeld !== null"
                        class="cw-row"
                        style="margin-top: 6px"
                    >
                        <span class="cw-label">{{
                            t('otcBalance', {
                                amount: amount(sellHeld, sides.sell),
                            })
                        }}</span>
                        <button
                            type="button"
                            class="cw-chip"
                            :disabled="sellHeld === 0n"
                            @click="maxSell()"
                        >
                            Max
                        </button>
                    </div>
                </template>

                <p v-if="summary" class="cw-note" style="margin-top: 16px">
                    <span>{{ summary }}</span>
                </p>
                <p
                    v-if="overBalance && sides.sell && sellHeld !== null"
                    class="cw-note cw-note-warn"
                    style="margin-top: 10px"
                >
                    <span>{{
                        t('otcNotEnough', {
                            amount: amount(sellHeld, sides.sell),
                        })
                    }}</span>
                </p>

                <span
                    class="cw-label"
                    style="display: block; margin-top: 18px"
                    >{{ t('otcTaker') }}</span
                >
                <input
                    v-model="takerInput"
                    class="cw-input"
                    style="margin-top: 8px"
                    spellcheck="false"
                    placeholder="0x…"
                />

                <label class="cw-row" style="margin-top: 14px; gap: 10px">
                    <span class="cw-label">{{ t('otcPartialOk') }}</span>
                    <input v-model="partialFill" type="checkbox" />
                </label>
                <template v-if="partialFill">
                    <span
                        class="cw-label"
                        style="display: block; margin-top: 10px"
                        >{{ t('otcMinFillLabel') }}</span
                    >
                    <input
                        v-model="minFillInput"
                        class="cw-input"
                        style="margin-top: 8px"
                        inputmode="decimal"
                        spellcheck="false"
                        placeholder="0.0"
                    />
                </template>

                <span
                    class="cw-label"
                    style="display: block; margin-top: 14px"
                    >{{ t('otcExpiry') }}</span
                >
                <div
                    class="cw-row"
                    style="
                        gap: 8px;
                        margin-top: 8px;
                        justify-content: flex-start;
                    "
                >
                    <button
                        v-for="days in [0, 1, 7, 30]"
                        :key="days"
                        type="button"
                        class="cw-chip"
                        :class="{ 'cw-chip-on': expiryDays === days }"
                        @click="expiryDays = days"
                    >
                        {{
                            days === 0
                                ? t('otcNever')
                                : t('otcDays', { days: String(days) })
                        }}
                    </button>
                </div>

                <p class="cw-note" style="margin-top: 18px">
                    <span>{{ t('otcEscrowNote') }}</span>
                </p>

                <div style="margin-top: 14px">
                    <HoldButton
                        :label="t('holdToSign')"
                        :disabled="!makeReady || wallet.busy.value"
                        @complete="make()"
                    />
                </div>
            </template>
        </template>
    </div>
</template>
