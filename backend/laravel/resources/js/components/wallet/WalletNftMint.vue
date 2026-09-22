<script setup lang="ts">
import { ExternalLink } from 'lucide-vue-next';
import { computed, onMounted, ref } from 'vue';
import GasSponsor from '@/components/wallet/GasSponsor.vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { analytics, errorCode } from '@/lib/analytics';
import { mintableChains } from '@/lib/nftChains';
import { formatUnits, walletChains } from '@/lib/wallet';
import { formatBytes, pinFile, pinJson } from '@/lib/wallet/ipfs';
import { buildMetadata, mintTxUrl, quoteMint } from '@/lib/wallet/nft';
import type { MintQuote } from '@/lib/wallet/nft';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Minting one token into the shared collection.
 *
 * Two things happen and the screen never blurs them: first the metadata is
 * pinned, which is free and reversible in the sense that nobody has to use the
 * CID; then the CID is written on chain, which costs gas and is permanent. The
 * fee is quoted against the real URI before the hold, because the URI's length
 * is most of what a mint costs.
 *
 * The image is optional on purpose — `CyberiaNFT.mint` takes any string, so a
 * token can be a link, a page or a line of text. What it cannot be is empty.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** Pinning limits this server enforces, so they can be said in advance. */
    ipfs: { enabled: boolean; maxBytes: number };
    /** A CID pinned a moment ago on the IPFS screen, ready to be minted. */
    preset: string | null;
}>();

const emit = defineEmits<{ back: []; minted: [] }>();

const { t } = useLocale(walletMessages);

type Stage = 'compose' | 'confirm' | 'done';

const stage = ref<Stage>('compose');
const busy = ref(false);
const failure = ref<string | null>(null);

const name = ref('');
const description = ref('');
const externalUrl = ref('');
const image = ref<File | null>(null);

/** Point at something that already exists instead of composing metadata. */
const direct = ref(false);
const uri = ref('');

/** What will actually be written on chain, once it is known. */
const tokenUri = ref('');
const quote = ref<MintQuote | null>(null);
const hash = ref<string | null>(null);

const target = computed(() => mintableChains()[0] ?? null);

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

const symbol = computed(() => target.value?.chain.nativeCurrency.symbol ?? '');

/** A watched address can hold NFTs and can never mint one. */
const canSign = computed(() => account.value?.capabilities.send ?? false);

const ready = computed(() =>
    direct.value ? uri.value.trim() !== '' : name.value.trim() !== '',
);

const feeText = computed(() =>
    quote.value === null
        ? '—'
        : `${formatUnits(quote.value.fee, 18, 6)} ${symbol.value}`,
);

/** The coin the mint fee is paid in, which is not the thing being minted. */
const gasBalance = computed(() =>
    chainId.value === null
        ? null
        : (props.wallet.balances.value[chainId.value]?.value ?? null),
);

/** Gas arrived from the station; re-read the balance that was short. */
const onFunded = (): void => {
    void props.wallet.refreshBalances();
};

const pickImage = (event: Event): void => {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;

    failure.value =
        file && file.size > props.ipfs.maxBytes
            ? t('ipfsTooLarge', { size: formatBytes(props.ipfs.maxBytes) })
            : null;
    image.value = failure.value === null ? file : null;
};

/**
 * Pin what is needed, then price the mint.
 *
 * Nothing is signed here. It ends on a screen that says exactly what will be
 * written and what it will cost, which is the last point where changing your
 * mind costs nothing.
 */
const prepare = async (): Promise<void> => {
    if (!target.value || !account.value) {
        return;
    }

    busy.value = true;
    failure.value = null;

    try {
        if (direct.value) {
            tokenUri.value = uri.value.trim();
        } else {
            const pinnedImage = image.value ? await pinFile(image.value) : null;

            const metadata = await pinJson(
                buildMetadata({
                    name: name.value,
                    description: description.value,
                    image: pinnedImage?.uri ?? null,
                    externalUrl: externalUrl.value || null,
                }),
            );

            tokenUri.value = metadata.uri;
        }

        quote.value = await quoteMint(
            tokenUri.value,
            account.value.address,
            target.value,
        );
        stage.value = 'confirm';
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
    }
};

const mint = async (): Promise<void> => {
    if (!chainId.value || quote.value === null) {
        return;
    }

    busy.value = true;
    failure.value = null;

    const startedAt = Date.now();

    // The chain and that a mint was attempted. Nothing about *what* is being
    // minted — the name, the description, the file and the tokenURI are the
    // user's content, and this is a product metric, not a catalogue.
    const traits = {
        chain: chainId.value ?? undefined,
        transaction_type: 'mint' as const,
    };

    analytics.track('nft_mint_started', traits);

    try {
        hash.value = await props.wallet.mintNft(
            chainId.value,
            tokenUri.value,
            quote.value,
        );
        stage.value = 'done';
        analytics.track('nft_minted', {
            ...traits,
            duration_ms: Date.now() - startedAt,
        });
        emit('minted');
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);

        analytics.track('nft_mint_failed', {
            ...traits,
            error_code: errorCode(error),
            duration_ms: Date.now() - startedAt,
        });
    } finally {
        busy.value = false;
    }
};

const again = (): void => {
    stage.value = 'compose';
    name.value = '';
    description.value = '';
    externalUrl.value = '';
    image.value = null;
    uri.value = '';
    tokenUri.value = '';
    quote.value = null;
    hash.value = null;
    failure.value = null;
};

onMounted(() => {
    if (props.preset) {
        direct.value = true;
        uri.value = props.preset;
    }
});
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('nftTitle') }}
        </button>

        <!-- ------------------------------------------------------ done --- -->
        <template v-if="stage === 'done'">
            <h2 class="cw-title" style="margin: 22px 0 8px">
                {{ t('mintSentTitle') }}
            </h2>
            <p class="cw-prose">{{ t('mintSentBody') }}</p>

            <div class="cw-card" style="margin-top: 16px; padding: 14px 16px">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('mintUri') }}</span>
                    <span
                        class="cw-kv-val"
                        style="overflow-wrap: anywhere; text-align: right"
                        >{{ tokenUri }}</span
                    >
                </div>
            </div>

            <a
                v-if="hash && target"
                class="cw-btn cw-btn-secondary"
                style="margin-top: 16px; text-decoration: none"
                :href="mintTxUrl(target, hash)"
                target="_blank"
                rel="noopener noreferrer"
            >
                {{ t('mintExplorer') }}
                <ExternalLink :size="14" aria-hidden="true" />
            </a>

            <button
                type="button"
                class="cw-ghost"
                style="margin-top: 10px"
                @click="again"
            >
                {{ t('mintAnother') }}
            </button>
        </template>

        <!-- --------------------------------------------------- confirm --- -->
        <template v-else-if="stage === 'confirm'">
            <h2 class="cw-title" style="margin: 22px 0 8px">
                {{ t('mintConfirmTitle') }}
            </h2>

            <div class="cw-card" style="margin-top: 8px; padding: 14px 16px">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('mintCollection') }}</span>
                    <span class="cw-kv-val">{{ target?.chain.name }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('mintUri') }}</span>
                    <span
                        class="cw-kv-val"
                        style="overflow-wrap: anywhere; text-align: right"
                        >{{ tokenUri }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('mintFee') }}</span>
                    <span class="cw-kv-val">{{ feeText }}</span>
                </div>
            </div>

            <p class="cw-note cw-note-warn" style="margin-top: 14px">
                <span>{{ t('mintPermanent') }}</span>
            </p>

            <!--
              A mint is a contract call and costs more gas than a transfer, so
              this is where a wallet with no coin discovers it. Silent unless
              the fee above is genuinely out of reach.
            -->
            <GasSponsor
                v-if="chainId !== null"
                :chain="chainId"
                :address="account?.address"
                :fee="quote?.fee ?? null"
                :gas-balance="gasBalance"
                :symbol="symbol"
                :decimals="18"
                @funded="onFunded"
            />

            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 12px"
            >
                <span>{{ failure }}</span>
            </p>

            <div style="margin-top: 18px">
                <HoldButton
                    :label="t('mintHold')"
                    :disabled="busy || !canSign"
                    @complete="mint"
                />
            </div>

            <button
                type="button"
                class="cw-ghost"
                style="margin-top: 10px"
                :disabled="busy"
                @click="stage = 'compose'"
            >
                {{ t('cancel') }}
            </button>
        </template>

        <!-- --------------------------------------------------- compose --- -->
        <template v-else>
            <h2 class="cw-title" style="margin: 22px 0 8px">
                {{ t('mintTitle') }}
            </h2>
            <p class="cw-prose">{{ t('mintBody') }}</p>

            <p
                v-if="!account"
                class="cw-note cw-note-warn"
                style="margin-top: 16px"
            >
                <span>{{ t('mintNoAccount') }}</span>
            </p>
            <p
                v-else-if="!canSign"
                class="cw-note cw-note-warn"
                style="margin-top: 16px"
            >
                <span>{{ t('mintWatchOnly') }}</span>
            </p>

            <div class="cw-seg" style="margin-top: 18px">
                <button
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="!direct"
                    @click="direct = false"
                >
                    {{ t('mintCompose') }}
                </button>
                <button
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="direct"
                    @click="direct = true"
                >
                    {{ t('mintDirect') }}
                </button>
            </div>

            <template v-if="direct">
                <p class="cw-prose" style="margin-top: 14px">
                    {{ t('mintDirectBody') }}
                </p>
                <label
                    class="cw-label"
                    style="display: block; margin: 16px 0 6px"
                >
                    {{ t('mintUri') }}
                </label>
                <input
                    v-model="uri"
                    class="cw-input"
                    type="text"
                    spellcheck="false"
                    placeholder="ipfs://bafy…"
                />
            </template>

            <template v-else>
                <p
                    v-if="!ipfs.enabled"
                    class="cw-note cw-note-warn"
                    style="margin-top: 16px"
                >
                    <span>{{ t('ipfsOff') }}</span>
                </p>

                <label
                    class="cw-label"
                    style="display: block; margin: 18px 0 6px"
                >
                    {{ t('mintName') }}
                </label>
                <input
                    v-model="name"
                    class="cw-input"
                    type="text"
                    maxlength="120"
                    :placeholder="t('mintNamePlaceholder')"
                />

                <label
                    class="cw-label"
                    style="display: block; margin: 14px 0 6px"
                >
                    {{ t('mintDescription') }}
                </label>
                <textarea
                    v-model="description"
                    class="cw-textarea"
                    rows="3"
                    maxlength="2000"
                ></textarea>

                <label
                    class="cw-label"
                    style="display: block; margin: 14px 0 6px"
                >
                    {{ t('mintImage') }}
                </label>
                <input
                    class="cw-input"
                    type="file"
                    accept="image/*,video/*,audio/*"
                    @change="pickImage"
                />
                <p class="cw-data" style="margin-top: 6px">
                    {{
                        image
                            ? `${image.name} · ${formatBytes(image.size)}`
                            : t('mintImageOptional')
                    }}
                </p>

                <label
                    class="cw-label"
                    style="display: block; margin: 14px 0 6px"
                >
                    {{ t('mintLink') }}
                </label>
                <input
                    v-model="externalUrl"
                    class="cw-input"
                    type="url"
                    spellcheck="false"
                    placeholder="https://"
                />
            </template>

            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 16px"
            >
                <span>{{ failure }}</span>
            </p>

            <button
                type="button"
                class="cw-btn cw-btn-primary"
                style="height: 48px; margin-top: 20px"
                :disabled="busy || !ready || !canSign"
                @click="prepare"
            >
                {{ busy ? t('mintPreparing') : t('mintContinue') }}
            </button>

            <p class="cw-note" style="margin-top: 14px">
                <span>{{ t('mintPinNote') }}</span>
            </p>
        </template>
    </div>
</template>
