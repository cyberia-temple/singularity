<script setup lang="ts">
import { Copy, ExternalLink } from 'lucide-vue-next';
import { computed, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { formatBytes, pinFile, pinPage } from '@/lib/wallet/ipfs';
import type { Pinned } from '@/lib/wallet/ipfs';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Putting something into IPFS from the wallet.
 *
 * What comes back is a CID, and the screen is built around that rather than
 * around the link: the CID is the content's real name, and it keeps resolving
 * from any node that has the bytes long after this server, this domain and
 * this gateway are gone. The https link is a convenience for a browser that
 * cannot resolve `ipfs://` itself, and it is labelled as one.
 *
 * A page is pinned differently from a file — wrapped as `index.html` inside a
 * directory, so a gateway renders the bare CID as a site instead of offering
 * it as a download. That is the entire difference between publishing a page
 * and publishing a file, and it is why they are two buttons.
 *
 * Honest about the parts nobody likes: our node pins it now, and nothing here
 * promises it forever. Pin the CID elsewhere too if it matters.
 */

const props = defineProps<{
    ipfs: { enabled: boolean; maxBytes: number; gateway: string };
}>();

const emit = defineEmits<{ back: []; mint: [uri: string] }>();

const { t } = useLocale(walletMessages);

const mode = ref<'file' | 'page'>('file');
const file = ref<File | null>(null);
const html = ref('');
const busy = ref(false);
const failure = ref<string | null>(null);
const result = ref<Pinned | null>(null);
const copied = ref<string | null>(null);

const limit = computed(() => formatBytes(props.ipfs.maxBytes));

const ready = computed(() =>
    mode.value === 'file' ? file.value !== null : html.value.trim() !== '',
);

const pick = (event: Event): void => {
    const chosen = (event.target as HTMLInputElement).files?.[0] ?? null;

    if (chosen && chosen.size > props.ipfs.maxBytes) {
        failure.value = t('ipfsTooLarge', { size: limit.value });
        file.value = null;

        return;
    }

    failure.value = null;
    file.value = chosen;
};

const submit = async (): Promise<void> => {
    busy.value = true;
    failure.value = null;
    result.value = null;

    try {
        result.value =
            mode.value === 'file' && file.value
                ? await pinFile(file.value)
                : await pinPage(html.value);
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
    }
};

const copy = async (value: string, key: string): Promise<void> => {
    try {
        await navigator.clipboard.writeText(value);
        copied.value = key;
        window.setTimeout(() => {
            copied.value = null;
        }, 1500);
    } catch {
        // A browser that refuses the clipboard leaves the text on screen to be
        // selected by hand, which is what it was before this button existed.
    }
};

const again = (): void => {
    result.value = null;
    file.value = null;
    html.value = '';
    failure.value = null;
};
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('nftTitle') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ t('ipfsTitle') }}
        </h2>
        <p class="cw-prose">{{ t('ipfsBody') }}</p>

        <p
            v-if="!ipfs.enabled"
            class="cw-note cw-note-warn"
            style="margin-top: 16px"
        >
            <span>{{ t('ipfsOff') }}</span>
        </p>

        <!-- ----------------------------------------------------- result --- -->
        <template v-else-if="result">
            <div class="cw-card" style="margin-top: 18px; padding: 14px 16px">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('ipfsCid') }}</span>
                    <span
                        class="cw-kv-val"
                        style="overflow-wrap: anywhere; text-align: right"
                        >{{ result.cid }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('ipfsSize') }}</span>
                    <span class="cw-kv-val">{{
                        formatBytes(result.bytes)
                    }}</span>
                </div>
            </div>

            <div style="display: flex; gap: 8px; margin-top: 12px">
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="flex: 1"
                    @click="copy(result.uri, 'uri')"
                >
                    <Copy :size="13" aria-hidden="true" />
                    {{ copied === 'uri' ? t('copiedLabel') : t('ipfsCopyUri') }}
                </button>
                <a
                    class="cw-btn cw-btn-secondary"
                    style="flex: 1; text-decoration: none"
                    :href="result.gatewayUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {{ t('ipfsOpen') }}
                    <ExternalLink :size="13" aria-hidden="true" />
                </a>
            </div>

            <p class="cw-note" style="margin-top: 14px">
                <span>{{ t('ipfsGatewayNote') }}</span>
            </p>
            <p class="cw-note cw-note-warn" style="margin-top: 10px">
                <span>{{ t('ipfsPersistenceNote') }}</span>
            </p>

            <button
                type="button"
                class="cw-btn cw-btn-primary"
                style="height: 48px; margin-top: 18px"
                @click="emit('mint', result.uri)"
            >
                {{ t('ipfsMintThis') }}
            </button>
            <button
                type="button"
                class="cw-ghost"
                style="margin-top: 10px"
                @click="again"
            >
                {{ t('ipfsAgain') }}
            </button>
        </template>

        <!-- ---------------------------------------------------- compose --- -->
        <template v-else>
            <div class="cw-seg" style="margin-top: 18px">
                <button
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="mode === 'file'"
                    @click="mode = 'file'"
                >
                    {{ t('ipfsFile') }}
                </button>
                <button
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="mode === 'page'"
                    @click="mode = 'page'"
                >
                    {{ t('ipfsPage') }}
                </button>
            </div>

            <template v-if="mode === 'file'">
                <p class="cw-prose" style="margin-top: 14px">
                    {{ t('ipfsFileBody') }}
                </p>
                <input
                    class="cw-input"
                    style="margin-top: 14px"
                    type="file"
                    @change="pick"
                />
                <p class="cw-data" style="margin-top: 6px">
                    {{
                        file
                            ? `${file.name} · ${formatBytes(file.size)}`
                            : t('ipfsUpTo', { size: limit })
                    }}
                </p>
            </template>

            <template v-else>
                <p class="cw-prose" style="margin-top: 14px">
                    {{ t('ipfsPageBody') }}
                </p>
                <textarea
                    v-model="html"
                    class="cw-textarea"
                    rows="10"
                    spellcheck="false"
                    style="margin-top: 14px; font: 400 14px/1.6 var(--cw-mono)"
                    placeholder="<!doctype html>…"
                ></textarea>
                <p class="cw-data" style="margin-top: 6px">
                    {{ t('ipfsUpTo', { size: limit }) }}
                </p>
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
                style="height: 48px; margin-top: 18px"
                :disabled="busy || !ready"
                @click="submit"
            >
                {{ busy ? t('ipfsPinning') : t('ipfsPin') }}
            </button>

            <p class="cw-note" style="margin-top: 14px">
                <span>{{ t('ipfsRelayNote') }}</span>
            </p>
        </template>
    </div>
</template>
