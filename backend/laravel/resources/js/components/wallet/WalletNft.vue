<script setup lang="ts">
import { ExternalLink } from 'lucide-vue-next';
import { computed, onMounted, ref, watch } from 'vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { mintableChains } from '@/lib/nftChains';
import { walletChains } from '@/lib/wallet';
import { shortAddress } from '@/lib/wallet/format';
import { fetchOwnedNfts } from '@/lib/wallet/nft';
import type { WalletNft } from '@/lib/wallet/nft';
import { walletMessages } from '@/lib/walletMessages';

/**
 * What this account owns as tokens that are not fungible.
 *
 * The collection is a commons: one ERC-721 anyone may mint into, where the
 * whole of what a token *is* lives in the URI its minter wrote. So this screen
 * lists everything the address holds — the ones minted here and the ones from
 * anywhere else on the same chain — and marks which is which rather than
 * pretending the wallet's own collection is the only one that exists.
 *
 * Ownership comes from the chain's keyless index, which resolves the metadata
 * in the same request. Reading it from the contract would mean a `tokenURI`
 * call and a gateway fetch per token, and fifty tokens would be a hundred
 * round trips before the first row appeared.
 */

const props = defineProps<{ wallet: MultiWallet }>();

const emit = defineEmits<{
    mint: [];
    ipfs: [];
    torrents: [];
    tracker: [];
}>();

const { t } = useLocale(walletMessages);

const items = ref<WalletNft[]>([]);
const selected = ref<string | null>(null);
const loading = ref(true);
const failure = ref<string | null>(null);

/** The one chain with a collection deployed. Mint and list are both about it. */
const target = computed(() => mintableChains()[0] ?? null);

/** That chain as this wallet knows it, so the account can be found. */
const chainId = computed(() => {
    const evmChainId = target.value?.chain.chainId;

    return (
        walletChains().find((chain) => chain.chainId === evmChainId)?.id ?? null
    );
});

const account = computed(() =>
    chainId.value === null
        ? null
        : (props.wallet.accounts.value.find(
              (entry) => entry.chain === chainId.value,
          ) ?? null),
);

const detail = computed(
    () =>
        items.value.find(
            (item) => `${item.contract}:${item.tokenId}` === selected.value,
        ) ?? null,
);

const load = async (): Promise<void> => {
    const owner = account.value?.address;
    const chain = target.value;

    if (!owner || !chain) {
        loading.value = false;

        return;
    }

    loading.value = true;
    failure.value = null;

    try {
        items.value = await fetchOwnedNfts(owner, chain);
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        loading.value = false;
    }
};

onMounted(load);

// A different account owns different tokens, and the ones on screen belonged
// to the previous one.
watch(
    () => account.value?.address,
    () => {
        items.value = [];
        selected.value = null;
        void load();
    },
);
</script>

<template>
    <div class="cw-stack">
        <template v-if="detail">
            <button type="button" class="cw-back" @click="selected = null">
                ← {{ t('nftTitle') }}
            </button>

            <img
                v-if="detail.imageUrl"
                :src="detail.imageUrl"
                :alt="detail.name"
                loading="lazy"
                style="
                    width: 100%;
                    max-height: 360px;
                    margin-top: 18px;
                    border: 1px solid var(--cw-hairline);
                    object-fit: contain;
                    background: #08090b;
                "
            />

            <h2 class="cw-title" style="margin: 18px 0 4px">
                {{ detail.name }}
            </h2>
            <div class="cw-data">
                {{ detail.collection }} · #{{ detail.tokenId }}
            </div>

            <p
                v-if="detail.description"
                class="cw-prose"
                style="margin-top: 14px"
            >
                {{ detail.description }}
            </p>

            <div class="cw-card" style="margin-top: 16px; padding: 14px 16px">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('nftStandard') }}</span>
                    <span class="cw-kv-val">{{ detail.standard }}</span>
                </div>
                <div v-if="detail.amount !== '1'" class="cw-kv">
                    <span class="cw-kv-key">{{ t('nftAmount') }}</span>
                    <span class="cw-kv-val">{{ detail.amount }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('nftContract') }}</span>
                    <span class="cw-kv-val">{{
                        shortAddress(detail.contract, 10, 8)
                    }}</span>
                </div>
                <div v-if="detail.uri" class="cw-kv">
                    <span class="cw-kv-key">{{ t('nftPointsAt') }}</span>
                    <span
                        class="cw-kv-val"
                        style="overflow-wrap: anywhere; text-align: right"
                        >{{ detail.uri }}</span
                    >
                </div>
                <div
                    v-for="attribute in detail.attributes"
                    :key="attribute.trait"
                    class="cw-kv"
                >
                    <span class="cw-kv-key">{{ attribute.trait }}</span>
                    <span class="cw-kv-val">{{ attribute.value }}</span>
                </div>
            </div>

            <div style="display: flex; gap: 8px; margin-top: 18px">
                <a
                    class="cw-btn cw-btn-secondary"
                    style="flex: 1; text-decoration: none"
                    :href="detail.explorerUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {{ t('nftExplorer') }}
                    <ExternalLink :size="14" aria-hidden="true" />
                </a>
                <a
                    v-if="detail.externalUrl"
                    class="cw-btn cw-btn-secondary"
                    style="flex: 1; text-decoration: none"
                    :href="detail.externalUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {{ t('nftExternal') }}
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
                <h2 class="cw-title" style="margin: 0">{{ t('nftTitle') }}</h2>
                <span class="cw-label" style="color: var(--cw-faint)">{{
                    target?.chain.name ?? '—'
                }}</span>
            </div>
            <p class="cw-prose" style="margin-top: 8px">
                {{ t('nftBody') }}
            </p>

            <button
                type="button"
                class="cw-btn cw-btn-primary"
                style="height: 48px; margin-top: 18px"
                :disabled="!account"
                @click="emit('mint')"
            >
                {{ t('nftMint') }}
            </button>

            <!--
              The three things around a token: somewhere for the file to live,
              a way to have the file at all, and the index where a file that
              was minted becomes something other people can find.
            -->
            <button
                type="button"
                class="cw-btn cw-btn-secondary"
                style="height: 44px; margin-top: 12px"
                @click="emit('tracker')"
            >
                {{ t('trackerTitle') }}
            </button>

            <div class="cw-tiles" style="margin-top: 12px">
                <button type="button" class="cw-tile" @click="emit('ipfs')">
                    <span style="font: 500 12px/1 var(--cw-sans)">{{
                        t('ipfsTitle')
                    }}</span>
                    <span class="cw-label" style="font-size: 9px">{{
                        t('tileIpfsHint')
                    }}</span>
                </button>
                <button type="button" class="cw-tile" @click="emit('torrents')">
                    <span style="font: 500 12px/1 var(--cw-sans)">{{
                        t('torrentTitle')
                    }}</span>
                    <span class="cw-label" style="font-size: 9px">{{
                        t('tileTorrentHint')
                    }}</span>
                </button>
            </div>

            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 18px"
            >
                <span style="flex: 1">{{ t('nftUnreadable') }}</span>
                <button type="button" class="cw-back" @click="load">
                    {{ t('retry') }}
                </button>
            </p>

            <p
                v-else-if="loading"
                class="cw-label"
                style="margin-top: 18px; color: var(--cw-faint)"
            >
                {{ t('nftLoading') }}
            </p>

            <p
                v-else-if="items.length === 0"
                class="cw-prose"
                style="margin-top: 18px"
            >
                {{ t('nftEmpty') }}
            </p>

            <template v-else>
                <div class="cw-row" style="margin: 22px 0 10px">
                    <span class="cw-label">{{ t('nftOwned') }}</span>
                    <span class="cw-label" style="color: var(--cw-faint)">{{
                        items.length
                    }}</span>
                </div>

                <div
                    style="
                        display: grid;
                        gap: 8px;
                        grid-template-columns: repeat(
                            auto-fill,
                            minmax(140px, 1fr)
                        );
                    "
                >
                    <button
                        v-for="item in items"
                        :key="`${item.contract}:${item.tokenId}`"
                        type="button"
                        class="cw-card cw-card-button"
                        style="padding: 0; overflow: hidden; text-align: left"
                        @click="selected = `${item.contract}:${item.tokenId}`"
                    >
                        <img
                            v-if="item.imageUrl"
                            :src="item.imageUrl"
                            :alt="item.name"
                            loading="lazy"
                            style="
                                display: block;
                                width: 100%;
                                aspect-ratio: 1;
                                object-fit: cover;
                                background: #08090b;
                            "
                        />
                        <!--
                          A token with no image is not a broken token: the
                          contract takes any string, so plenty of them are a
                          link or a line of text and nothing else.
                        -->
                        <span
                            v-else
                            class="cw-label"
                            style="
                                display: flex;
                                aspect-ratio: 1;
                                align-items: center;
                                justify-content: center;
                                background: #08090b;
                                color: var(--cw-faint);
                            "
                            >{{ item.symbol || 'NFT' }}</span
                        >
                        <span style="display: block; padding: 9px 10px 11px">
                            <span
                                style="
                                    display: block;
                                    overflow: hidden;
                                    font: 500 12px/1.3 var(--cw-sans);
                                    color: var(--cw-text);
                                    text-overflow: ellipsis;
                                    white-space: nowrap;
                                "
                                >{{ item.name }}</span
                            >
                            <span
                                class="cw-data"
                                style="
                                    display: block;
                                    margin-top: 3px;
                                    font-size: 10px;
                                "
                                >{{
                                    item.native
                                        ? t('nftMintedHere')
                                        : item.collection
                                }}</span
                            >
                        </span>
                    </button>
                </div>

                <p class="cw-note" style="margin-top: 14px">
                    <span>{{ t('nftGatewayNote') }}</span>
                </p>
            </template>
        </template>
    </div>
</template>
