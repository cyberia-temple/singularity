<script setup lang="ts">
import { ExternalLink } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import WalletLaunchCreate from '@/components/wallet/WalletLaunchCreate.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { formatUnits } from '@/lib/wallet';
import { formatUsd, shortAddress } from '@/lib/wallet/format';
import {
    byMarketCap,
    fetchLaunches,
    launchpadChains,
} from '@/lib/wallet/launchpad';
import type { WalletLaunch } from '@/lib/wallet/launchpad';
import { fetchUnderground } from '@/lib/wallet/underground';
import type { UndergroundEntry } from '@/lib/wallet/underground';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The launchpad, read from the chain the wallet is already on.
 *
 * A launch here is a fair launch: the token is deployed, the native coin that
 * paid for it is burned into locked liquidity, and after that it is a pool like
 * any other. There is nothing to reserve, nothing to allocate and nothing to
 * vest, so this screen has no controls for those — it lists what exists and
 * what it costs, and it can launch one (`WalletLaunchCreate`), signed by the
 * key in this vault.
 *
 * Buying is a swap, and the wallet has one — so the detail hands the launch's
 * contract to the swap screen, which reads it from the chain before quoting
 * anything. The DEX link stays alongside it: this screen has no chart, no
 * order book and no depth, and those are real reasons to go there.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** Chain id → (lowercased contract → USD price), for pricing the coin. */
    prices: Record<string, number | null>;
}>();

const emit = defineEmits<{
    swap: [contract: string];
    domains: [];
    dao: [];
    /** Open the workshop on this token: its creator is building its homepage. */
    homepage: [contract: string];
}>();

const { locale, t } = useLocale(walletMessages);

const launches = ref<WalletLaunch[]>([]);
const images = ref<Record<string, string>>({});
const failedImages = ref<Record<string, boolean>>({});

const loadImages = async (): Promise<void> => {
    try {
        const response = await fetch('/api/launchpad/tokens', {
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const data = (await response.json()) as {
            tokens: {
                chain_id: number;
                address: string;
                image_url: string | null;
            }[];
        };
        const chainId = chain.value?.chain.chainId;
        images.value = Object.fromEntries(
            data.tokens
                .filter(
                    (token) => token.chain_id === chainId && token.image_url,
                )
                .map((token) => [
                    token.address.toLowerCase(),
                    token.image_url!,
                ]),
        );
    } catch {
        // Token metadata is optional; the on-chain list remains available.
    }
};
const selected = ref<string | null>(null);
/** The launch composer is open instead of the list. */
const creating = ref(false);
const loading = ref(true);
const failure = ref<string | null>(null);
/**
 * Newest reads one page; by market cap reads every launch, because a ranking
 * of the newest twelve is not a ranking of the launchpad.
 */
const order = ref<'new' | 'cap'>('cap');

const shown = computed(() =>
    order.value === 'cap' ? byMarketCap(launches.value) : launches.value,
);

const chain = computed(() => launchpadChains()[0] ?? null);

const symbol = computed(
    () => chain.value?.chain.nativeCurrency.symbol ?? 'CYBER',
);

/** USD for the coin the launches are priced in, when the page has a quote. */
const nativeUsd = computed(() => props.prices.cyberia ?? null);

const detail = computed(
    () =>
        launches.value.find((entry) => entry.address === selected.value) ??
        null,
);

const usd = (native: number | null): string | null =>
    native === null || nativeUsd.value === null
        ? null
        : formatUsd(native * nativeUsd.value, locale.value);

const amount = (value: bigint, precision = 4): string =>
    formatUnits(value, 18, precision);

/**
 * Every token's homepage, from the underground's directory. A token that has
 * one says so on its screen, and its creator gets the door to the workshop —
 * which is the short way to it; the long way is the layers under Settings.
 */
const homepages = ref<Record<string, UndergroundEntry>>({});

const loadHomepages = async (): Promise<void> => {
    try {
        const directory = await fetchUnderground();

        homepages.value = Object.fromEntries(
            [...directory.homes, ...directory.lots].map((entry) => [
                entry.address,
                entry,
            ]),
        );
    } catch {
        // The launchpad is the chain's; a directory that cannot be read only
        // means the homepage row is not drawn.
    }
};

const myAddresses = computed(() =>
    props.wallet.accounts.value
        .filter((account) => account.family === 'evm')
        .map((account) => account.address.toLowerCase()),
);

const homepage = computed(() =>
    detail.value === null
        ? null
        : (homepages.value[detail.value.address.toLowerCase()] ?? null),
);

const isCreator = computed(
    () =>
        homepage.value?.creator !== null &&
        homepage.value?.creator !== undefined &&
        myAddresses.value.includes(homepage.value.creator),
);

const load = async (): Promise<void> => {
    loading.value = true;
    failure.value = null;
    void loadHomepages();
    void loadImages();

    const wanted = order.value;

    try {
        const read = await fetchLaunches(
            undefined,
            wanted === 'cap' ? Infinity : undefined,
        );

        // A slower read for the order just left must not replace this one.
        if (wanted === order.value) {
            launches.value = read;
        }
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        loading.value = false;
    }
};

const sortBy = (next: 'new' | 'cap'): void => {
    if (order.value !== next) {
        order.value = next;
        void load();
    }
};

onMounted(load);
</script>

<template>
    <div class="cw-stack">
        <WalletLaunchCreate
            v-if="creating"
            :wallet="wallet"
            @back="creating = false"
            @launched="load"
            @swap="(contract) => emit('swap', contract)"
            @domains="emit('domains')"
            @dao="emit('dao')"
        />

        <template v-else-if="detail">
            <button type="button" class="cw-back" @click="selected = null">
                ← {{ t('launchpad') }}
            </button>

            <div
                style="
                    display: flex;
                    align-items: center;
                    gap: 12px;
                    margin: 22px 0 18px;
                "
            >
                <img
                    v-if="
                        images[detail.address.toLowerCase()] &&
                        !failedImages[detail.address.toLowerCase()]
                    "
                    :src="images[detail.address.toLowerCase()]"
                    :alt="detail.symbol"
                    width="40"
                    height="40"
                    style="object-fit: cover; border-radius: 50%"
                    @error="failedImages[detail.address.toLowerCase()] = true"
                />
                <span
                    v-else
                    style="
                        display: flex;
                        min-width: 40px;
                        height: 40px;
                        align-items: center;
                        justify-content: center;
                        padding: 0 9px;
                        border: 1px solid var(--cw-accent);
                        color: var(--cw-accent);
                        font: 500 13px/1 var(--cw-mono);
                        white-space: nowrap;
                    "
                    >{{ detail.symbol || '??' }}</span
                >
                <div style="flex: 1; min-width: 0">
                    <div style="font: 500 19px/1.2 var(--cw-sans)">
                        {{ detail.name || detail.symbol }}
                    </div>
                    <div class="cw-data" style="margin-top: 3px">
                        {{ shortAddress(detail.address) }}
                    </div>
                </div>
            </div>

            <div class="cw-card" style="padding: 14px 16px">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchPrice') }}</span>
                    <span class="cw-kv-val"
                        >{{
                            detail.priceNative === null
                                ? '—'
                                : detail.priceNative.toPrecision(6)
                        }}
                        {{ symbol }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchValue') }}</span>
                    <span class="cw-kv-val">{{
                        usd(detail.priceNative) ?? '—'
                    }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchLiquidity') }}</span>
                    <span class="cw-kv-val"
                        >{{ amount(detail.liquidity) }} {{ symbol }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchCap') }}</span>
                    <span class="cw-kv-val">{{
                        usd(detail.marketCapNative) ??
                        (detail.marketCapNative === null
                            ? '—'
                            : `${detail.marketCapNative.toFixed(2)} ${symbol}`)
                    }}</span>
                </div>
                <div v-if="detail.feePct !== null" class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchNewTradeFee') }}</span>
                    <span class="cw-kv-val">{{ detail.feePct }}%</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchSupply') }}</span>
                    <span class="cw-kv-val">{{
                        amount(detail.supply, 0)
                    }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchContract') }}</span>
                    <span class="cw-kv-val">{{
                        shortAddress(detail.address, 10, 8)
                    }}</span>
                </div>
            </div>

            <div
                v-if="homepage?.site_url || isCreator"
                class="cw-card"
                style="padding: 14px 16px; margin-top: 12px"
            >
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('lpHomepage') }}</span>
                    <a
                        v-if="homepage?.site_url"
                        class="cw-kv-val"
                        :href="homepage.site_url"
                        target="_blank"
                        rel="noopener"
                        >{{
                            homepage.site_url
                                .replace(/^https?:\/\//, '')
                                .replace(/\/$/, '')
                        }}</a
                    >
                    <span v-else class="cw-kv-val">—</span>
                </div>
                <button
                    v-if="isCreator"
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="height: 44px; margin-top: 10px; width: 100%"
                    @click="emit('homepage', detail.address)"
                >
                    {{
                        homepage?.site_url
                            ? t('lpEditHomepage')
                            : t('lpMakeHomepage')
                    }}
                </button>
            </div>

            <p class="cw-note" style="margin-top: 14px">
                <span>{{
                    t(
                        detail.venue === 'v3'
                            ? 'launchLockedBodyV3'
                            : 'launchLockedBody',
                    )
                }}</span>
            </p>

            <div
                class="cw-row"
                style="
                    justify-content: flex-start;
                    gap: 8px;
                    flex-wrap: wrap;
                    margin-top: 12px;
                "
            >
                <a
                    v-for="value in ['1', '5', '10']"
                    :key="'buy' + value"
                    class="cw-chip"
                    :href="`/swap?chain=49406&out=${detail.address}&direction=buy&cyber=${value}`"
                    >Buy {{ value }} CYBER</a
                >
                <a
                    v-for="value in ['1', '5', '10']"
                    :key="'sell' + value"
                    class="cw-chip"
                    :href="`/swap?chain=49406&in=${detail.address}&direction=sell&cyber=${value}`"
                    >Sell {{ value }} CYBER</a
                >
            </div>

            <p class="cw-note cw-note-warn" style="margin-top: 12px">
                <span>{{ t('launchRisk') }}</span>
            </p>

            <div style="display: flex; gap: 8px; margin-top: 20px">
                <button
                    type="button"
                    class="cw-btn cw-btn-primary"
                    style="flex: 1"
                    @click="emit('swap', detail.address)"
                >
                    {{ t('launchBuy') }}
                </button>
                <a
                    class="cw-btn cw-btn-secondary"
                    style="flex: 1; text-decoration: none"
                    :href="detail.swapUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {{ t('launchTrade') }}
                    <ExternalLink :size="14" aria-hidden="true" />
                </a>
                <a
                    class="cw-btn cw-btn-secondary"
                    style="flex: 1; text-decoration: none"
                    :href="detail.explorerUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {{ t('launchExplorer') }}
                    <ExternalLink :size="14" aria-hidden="true" />
                </a>
            </div>
        </template>

        <template v-else>
            <div
                style="
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                    gap: 12px;
                "
            >
                <h2 class="cw-title" style="margin: 0">{{ t('launchpad') }}</h2>
                <span class="cw-label" style="color: var(--cw-faint)">{{
                    chain?.chain.name ?? '—'
                }}</span>
            </div>
            <p class="cw-prose" style="margin-top: 8px">
                {{ t('launchpadBody') }}
            </p>

            <button
                v-if="chain"
                type="button"
                class="cw-btn cw-btn-primary"
                style="margin-top: 16px"
                @click="creating = true"
            >
                {{ t('launchNewOpen') }}
            </button>

            <div class="cw-seg" style="margin-top: 18px">
                <button
                    v-for="option in ['new', 'cap'] as const"
                    :key="option"
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="order === option"
                    @click="sortBy(option)"
                >
                    {{
                        t(option === 'new' ? 'launchSortNew' : 'launchSortCap')
                    }}
                </button>
            </div>

            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 18px"
            >
                <span style="flex: 1">{{ t('launchpadUnreadable') }}</span>
                <button type="button" class="cw-back" @click="load">
                    {{ t('retry') }}
                </button>
            </p>

            <p
                v-else-if="loading"
                class="cw-label"
                style="margin-top: 18px; color: var(--cw-faint)"
            >
                {{ t('launchpadLoading') }}
            </p>

            <p
                v-else-if="launches.length === 0"
                class="cw-prose"
                style="margin-top: 18px"
            >
                {{ t('launchpadEmpty') }}
            </p>

            <div v-else class="cw-stack" style="gap: 8px; margin-top: 18px">
                <button
                    v-for="launch in shown"
                    :key="launch.address"
                    type="button"
                    class="cw-card cw-card-button"
                    @click="selected = launch.address"
                >
                    <div style="display: flex; align-items: center; gap: 12px">
                        <img
                            v-if="
                                images[launch.address.toLowerCase()] &&
                                !failedImages[launch.address.toLowerCase()]
                            "
                            :src="images[launch.address.toLowerCase()]"
                            :alt="launch.symbol"
                            width="34"
                            height="34"
                            style="object-fit: cover; border-radius: 50%"
                            @error="
                                failedImages[launch.address.toLowerCase()] =
                                    true
                            "
                        />
                        <span
                            v-else
                            style="
                                display: flex;
                                min-width: 34px;
                                height: 34px;
                                align-items: center;
                                justify-content: center;
                                padding: 0 8px;
                                border: 1px solid var(--cw-accent);
                                color: var(--cw-accent);
                                font: 500 12px/1 var(--cw-mono);
                                white-space: nowrap;
                            "
                            >{{ launch.symbol || '??' }}</span
                        >
                        <span style="flex: 1; min-width: 0">
                            <span
                                style="
                                    display: block;
                                    font: 500 16px/1.2 var(--cw-sans);
                                    color: var(--cw-text);
                                "
                                >{{ launch.name || launch.symbol }}</span
                            >
                            <span
                                class="cw-data"
                                style="
                                    display: block;
                                    margin-top: 3px;
                                    font-size: 12px;
                                "
                                >{{ amount(launch.liquidity, 2) }} {{ symbol }}
                                {{ t('launchLocked') }}</span
                            >
                        </span>
                        <span style="text-align: right">
                            <span
                                class="cw-num"
                                style="display: block; font-size: 15px"
                                >{{
                                    launch.priceNative === null
                                        ? '—'
                                        : launch.priceNative.toPrecision(4)
                                }}
                                {{ symbol }}</span
                            >
                            <span
                                class="cw-data"
                                style="
                                    display: block;
                                    margin-top: 3px;
                                    font-size: 12px;
                                "
                                >{{ usd(launch.marketCapNative) ?? '—' }}</span
                            >
                        </span>
                    </div>
                </button>
            </div>
        </template>
    </div>
</template>
