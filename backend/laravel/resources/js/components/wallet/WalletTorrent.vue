<script setup lang="ts">
import { ExternalLink, FolderOpen, Pause, Play, X } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { formatBytes, pinFile } from '@/lib/wallet/ipfs';
import {
    bytesToBlob,
    formatEta,
    formatSpeed,
    normalizeTorrentSource,
    torrentBridge,
} from '@/lib/wallet/torrent';
import type { TorrentEngineInfo, TorrentSummary } from '@/lib/wallet/torrent';
import { walletMessages } from '@/lib/walletMessages';

/**
 * A BitTorrent client, where there is one.
 *
 * The desktop app can do this properly: a Node process with real sockets, so
 * the mainline DHT, peer exchange and ordinary TCP/uTP peers all work and a
 * magnet finds the same swarm any other client would. A browser tab cannot —
 * the DHT is UDP and peers are TCP, and a page has neither — so everywhere
 * else this screen explains that instead of shipping a downloader that finds
 * zero peers for almost everything pasted into it.
 *
 * Two things this screen has to keep saying, because they are true and easy to
 * forget: peers see your IP address, and the app's proxy setting does not
 * cover this traffic — it is a browser setting, and these are raw sockets.
 */

const emit = defineEmits<{ back: []; mint: [uri: string] }>();

const { t } = useLocale(walletMessages);

const bridge = torrentBridge();

const info = ref<TorrentEngineInfo | null>(null);
const torrents = ref<TorrentSummary[]>([]);
const source = ref('');
const busy = ref(false);
const failure = ref<string | null>(null);
const pinning = ref<string | null>(null);
const pinned = ref<{ key: string; uri: string } | null>(null);
const confirming = ref<string | null>(null);

let unsubscribe: (() => void) | null = null;

const valid = computed(() => normalizeTorrentSource(source.value) !== null);

const refresh = async (): Promise<void> => {
    if (!bridge) {
        return;
    }

    try {
        torrents.value = await bridge.list();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    }
};

const add = async (): Promise<void> => {
    const normalized = normalizeTorrentSource(source.value);

    if (!bridge || normalized === null) {
        return;
    }

    busy.value = true;
    failure.value = null;

    try {
        await bridge.add(normalized);
        source.value = '';
        await refresh();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
    }
};

const toggle = async (torrent: TorrentSummary): Promise<void> => {
    if (!bridge) {
        return;
    }

    try {
        await (torrent.status === 'paused'
            ? bridge.resume(torrent.infoHash)
            : bridge.pause(torrent.infoHash));
        await refresh();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    }
};

const remove = async (
    infoHash: string,
    deleteFiles: boolean,
): Promise<void> => {
    if (!bridge) {
        return;
    }

    confirming.value = null;

    try {
        await bridge.remove(infoHash, deleteFiles);
        await refresh();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    }
};

/**
 * One downloaded file, pinned to IPFS.
 *
 * This is the whole reason the three screens sit together: a file that came
 * out of a swarm gets a content address, and a content address is what a token
 * can point at. The shell caps what it will hand back, so a film is not
 * offered here — the button is only drawn for files under that cap.
 */
const pin = async (torrent: TorrentSummary, index: number): Promise<void> => {
    if (!bridge) {
        return;
    }

    const key = `${torrent.infoHash}:${index}`;
    pinning.value = key;
    failure.value = null;
    pinned.value = null;

    try {
        const file = await bridge.read(torrent.infoHash, index);
        const result = await pinFile(bytesToBlob(file), file.name);
        pinned.value = { key, uri: result.uri };
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        pinning.value = null;
    }
};

const percent = (torrent: TorrentSummary): number =>
    Math.round(torrent.progress * 100);

const statusLabel = (torrent: TorrentSummary): string =>
    ({
        metadata: t('torrentMeta'),
        downloading: t('torrentDownloading'),
        seeding: t('torrentSeeding'),
        paused: t('torrentPaused'),
        error: t('torrentError'),
    })[torrent.status];

onMounted(async () => {
    if (!bridge) {
        return;
    }

    try {
        info.value = await bridge.info();
    } catch {
        // An engine that cannot describe itself can still be listed and used;
        // the file-pinning button is what needs the cap, and it stays hidden.
    }

    unsubscribe = bridge.subscribe((list) => {
        torrents.value = list;
    });

    await refresh();
});

onBeforeUnmount(() => {
    unsubscribe?.();
});
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('nftTitle') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ t('torrentTitle') }}
        </h2>

        <!-- --------------------------------------------- no engine here --- -->
        <template v-if="!bridge">
            <p class="cw-prose">{{ t('torrentBrowserBody') }}</p>

            <div class="cw-card" style="margin-top: 16px; padding: 14px 16px">
                <p class="cw-prose" style="margin: 0">
                    {{ t('torrentWhyNot') }}
                </p>
            </div>

            <a
                class="cw-btn cw-btn-primary"
                style="height: 48px; margin-top: 18px; text-decoration: none"
                href="/download"
            >
                {{ t('torrentGetDesktop') }}
                <ExternalLink :size="14" aria-hidden="true" />
            </a>

            <p class="cw-note" style="margin-top: 14px">
                <span>{{ t('torrentMobileNote') }}</span>
            </p>
        </template>

        <!-- ------------------------------------------------- the client --- -->
        <template v-else>
            <p class="cw-prose">{{ t('torrentDesktopBody') }}</p>

            <label class="cw-label" style="display: block; margin: 18px 0 6px">
                {{ t('torrentSource') }}
            </label>
            <input
                v-model="source"
                class="cw-input"
                type="text"
                spellcheck="false"
                placeholder="magnet:?xt=urn:btih:…"
                :aria-invalid="source.trim() !== '' && !valid"
                @keyup.enter="add"
            />
            <p class="cw-data" style="margin-top: 6px">
                {{
                    source.trim() !== '' && !valid
                        ? t('torrentBadSource')
                        : t('torrentSourceHint')
                }}
            </p>

            <button
                type="button"
                class="cw-btn cw-btn-primary"
                style="height: 48px; margin-top: 14px"
                :disabled="busy || !valid"
                @click="add"
            >
                {{ busy ? t('torrentAdding') : t('torrentAdd') }}
            </button>

            <p class="cw-note cw-note-warn" style="margin-top: 14px">
                <span>{{ t('torrentPrivacy') }}</span>
            </p>

            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 12px"
            >
                <span>{{ failure }}</span>
            </p>

            <div v-if="info" class="cw-kv" style="margin-top: 16px">
                <span class="cw-kv-key">{{ t('torrentFolder') }}</span>
                <span
                    class="cw-kv-val"
                    style="overflow-wrap: anywhere; text-align: right"
                >
                    {{ info.downloadDir }}
                </span>
            </div>
            <button
                v-if="info"
                type="button"
                class="cw-ghost"
                style="margin-top: 10px"
                @click="bridge.reveal()"
            >
                <FolderOpen :size="13" aria-hidden="true" />
                {{ t('torrentOpenFolder') }}
            </button>

            <p
                v-if="torrents.length === 0"
                class="cw-prose"
                style="margin-top: 22px"
            >
                {{ t('torrentEmpty') }}
            </p>

            <div v-else class="cw-stack" style="gap: 8px; margin-top: 22px">
                <div
                    v-for="torrent in torrents"
                    :key="torrent.infoHash"
                    class="cw-card"
                    style="padding: 13px 14px"
                >
                    <div class="cw-row" style="gap: 10px">
                        <span
                            style="
                                flex: 1;
                                min-width: 0;
                                overflow: hidden;
                                font: 500 15px/1.3 var(--cw-sans);
                                text-overflow: ellipsis;
                                white-space: nowrap;
                            "
                            >{{
                                torrent.name || torrent.infoHash.slice(0, 12)
                            }}</span
                        >
                        <button
                            type="button"
                            class="cw-icon-btn"
                            :aria-label="
                                torrent.status === 'paused'
                                    ? t('torrentResume')
                                    : t('torrentPause')
                            "
                            @click="toggle(torrent)"
                        >
                            <Play
                                v-if="torrent.status === 'paused'"
                                :size="13"
                            />
                            <Pause v-else :size="13" />
                        </button>
                        <button
                            type="button"
                            class="cw-icon-btn"
                            :aria-label="t('torrentRemove')"
                            @click="
                                confirming =
                                    confirming === torrent.infoHash
                                        ? null
                                        : torrent.infoHash
                            "
                        >
                            <X :size="13" />
                        </button>
                    </div>

                    <!-- Progress, drawn rather than described: a number and a bar
                         say different things and both are cheap. -->
                    <div
                        style="
                            height: 3px;
                            margin: 10px 0 8px;
                            background: var(--cw-hairline);
                        "
                    >
                        <div
                            style="height: 100%; background: var(--cw-accent)"
                            :style="{ width: `${percent(torrent)}%` }"
                        ></div>
                    </div>

                    <div class="cw-data" style="font-size: 12px">
                        {{ percent(torrent) }}% · {{ statusLabel(torrent) }} ·
                        {{ formatBytes(torrent.downloaded)
                        }}<template v-if="torrent.length > 0">
                            / {{ formatBytes(torrent.length) }}</template
                        >
                        · ↓{{ formatSpeed(torrent.downloadSpeed) }} · ↑{{
                            formatSpeed(torrent.uploadSpeed)
                        }}
                        · {{ t('torrentPeers', { count: torrent.peers })
                        }}<template v-if="formatEta(torrent.eta)">
                            · {{ formatEta(torrent.eta) }}</template
                        >
                    </div>

                    <p
                        v-if="torrent.error"
                        class="cw-note cw-note-bad"
                        style="margin-top: 10px"
                    >
                        <span>{{ torrent.error }}</span>
                    </p>

                    <div
                        v-if="confirming === torrent.infoHash"
                        style="display: flex; gap: 8px; margin-top: 10px"
                    >
                        <button
                            type="button"
                            class="cw-ghost"
                            style="flex: 1"
                            @click="remove(torrent.infoHash, false)"
                        >
                            {{ t('torrentRemoveKeep') }}
                        </button>
                        <button
                            type="button"
                            class="cw-btn cw-btn-danger"
                            style="flex: 1"
                            @click="remove(torrent.infoHash, true)"
                        >
                            {{ t('torrentRemoveDelete') }}
                        </button>
                    </div>

                    <div
                        v-if="torrent.files.length > 0"
                        class="cw-stack"
                        style="gap: 6px; margin-top: 12px"
                    >
                        <div
                            v-for="(file, index) in torrent.files"
                            :key="file.name"
                            class="cw-row"
                            style="gap: 8px"
                        >
                            <span
                                class="cw-data"
                                style="
                                    flex: 1;
                                    min-width: 0;
                                    overflow: hidden;
                                    font-size: 12px;
                                    text-overflow: ellipsis;
                                    white-space: nowrap;
                                "
                                >{{ file.name }} ·
                                {{ formatBytes(file.length) }}</span
                            >
                            <button
                                v-if="
                                    file.progress >= 1 &&
                                    info &&
                                    file.length <= info.maxReadBytes
                                "
                                type="button"
                                class="cw-back"
                                :disabled="pinning !== null"
                                @click="pin(torrent, index)"
                            >
                                {{
                                    pinning === `${torrent.infoHash}:${index}`
                                        ? t('ipfsPinning')
                                        : t('torrentPinFile')
                                }}
                            </button>
                        </div>
                    </div>

                    <div
                        v-if="pinned && pinned.key.startsWith(torrent.infoHash)"
                        style="margin-top: 10px"
                    >
                        <p class="cw-data" style="overflow-wrap: anywhere">
                            {{ pinned.uri }}
                        </p>
                        <button
                            type="button"
                            class="cw-btn cw-btn-secondary"
                            style="margin-top: 8px"
                            @click="emit('mint', pinned.uri)"
                        >
                            {{ t('ipfsMintThis') }}
                        </button>
                    </div>
                </div>
            </div>

            <p class="cw-note" style="margin-top: 16px">
                <span>{{ t('torrentLawNote') }}</span>
            </p>
        </template>
    </div>
</template>
