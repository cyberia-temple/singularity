<script setup lang="ts">
import {
    Copy,
    Download,
    ExternalLink,
    Play,
    Search,
    Upload,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { formatBytes } from '@/lib/wallet/ipfs';
import { tracksFromRelease, tracksFromTorrent } from '@/lib/wallet/player';
import type { PlayerTrack } from '@/lib/wallet/player';
import { canStream, torrentBridge } from '@/lib/wallet/torrent';
import type { TorrentSummary } from '@/lib/wallet/torrent';
import { fetchReleases } from '@/lib/wallet/tracker';
import type { TrackerContext, TrackerRelease } from '@/lib/wallet/tracker';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The tracker, inside the wallet.
 *
 * A release is on this index because somebody minted it: the token is the
 * publication and the row is a view of it, which is why every row carries the
 * token it came from and why nothing here has an account behind it. Reading
 * needs nothing at all; publishing needs gas.
 *
 * The screen has to answer three different machines honestly. In a browser it
 * is a catalogue: the magnet opens in whatever client the person already has,
 * and the only thing that plays in place is the sample the minter pinned to
 * IPFS. In the desktop app there is a real client, so a release can be
 * downloaded and its files played out of the swarm as they arrive. On a phone
 * it is the browser answer, said plainly.
 */

const props = defineProps<{
    /** This wallet's EVM address, for marking the rows it published. */
    address: string | null;
}>();

const emit = defineEmits<{
    back: [];
    publish: [];
    play: [
        payload: {
            tracks: PlayerTrack[];
            heading: string;
            poster: string | null;
            infoHash: string | null;
        },
    ];
}>();

const { t } = useLocale(walletMessages);

const bridge = torrentBridge();

const releases = ref<TrackerRelease[]>([]);
const context = ref<TrackerContext | null>(null);
const selected = ref<TrackerRelease | null>(null);
const loading = ref(true);
const failure = ref<string | null>(null);
const copied = ref(false);

const query = ref('');
const category = ref('');
const sort = ref('new');
const page = ref(1);
const pages = ref(1);
const total = ref(0);

/** What this client is holding, so a release can say "already downloading". */
const torrents = ref<TorrentSummary[]>([]);
const adding = ref(false);

let unsubscribe: (() => void) | null = null;
let debounce: number | undefined;

const held = computed<TorrentSummary | null>(() =>
    selected.value === null
        ? null
        : (torrents.value.find(
              (torrent) =>
                  torrent.infoHash.toLowerCase() ===
                  selected.value?.info_hash.toLowerCase(),
          ) ?? null),
);

const mine = (release: TrackerRelease): boolean =>
    props.address !== null &&
    release.owner.toLowerCase() === props.address.toLowerCase();

const load = async (): Promise<void> => {
    loading.value = true;
    failure.value = null;

    try {
        const body = await fetchReleases({
            q: query.value,
            category: category.value,
            sort: sort.value,
            page: page.value,
        });

        releases.value = body.releases;
        context.value = body.context;
        total.value = body.total;
        pages.value = body.pages;
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        loading.value = false;
    }
};

/** Typing is not a query. One request when the typing stops, not per letter. */
watch(query, () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => {
        page.value = 1;
        void load();
    }, 350);
});

watch([category, sort], () => {
    page.value = 1;
    void load();
});

const copyMagnet = async (release: TrackerRelease): Promise<void> => {
    try {
        await navigator.clipboard.writeText(release.magnet);
        copied.value = true;
        window.setTimeout(() => {
            copied.value = false;
        }, 1500);
    } catch {
        // A browser that refuses the clipboard leaves the link on screen to be
        // selected by hand, which is where it was before this button existed.
    }
};

/** Join the swarm. Only the desktop shell has a client to join it with. */
const download = async (release: TrackerRelease): Promise<void> => {
    if (!bridge) {
        return;
    }

    adding.value = true;
    failure.value = null;

    try {
        await bridge.add(release.magnet);
        torrents.value = await bridge.list();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        adding.value = false;
    }
};

/**
 * Open the player with whatever this machine can honestly play.
 *
 * Two sources and never both invented: the files of a torrent this client is
 * holding, streamed as the pieces arrive, or the sample the minter pinned. A
 * release with neither opens nothing, and the button is not drawn.
 */
const playable = (release: TrackerRelease): PlayerTrack[] => {
    const torrent = torrents.value.find(
        (entry) =>
            entry.infoHash.toLowerCase() === release.info_hash.toLowerCase(),
    );

    if (torrent && bridge && canStream(bridge)) {
        return tracksFromTorrent(torrent, async (fileIndex) => {
            const stream = await bridge.stream!(torrent.infoHash, fileIndex);

            return stream.url;
        });
    }

    return tracksFromRelease(release);
};

const open = (release: TrackerRelease): void => {
    const tracks = playable(release);

    if (tracks.length === 0) {
        return;
    }

    emit('play', {
        tracks,
        heading: release.name,
        poster: release.cover_url,
        infoHash: release.info_hash,
    });
};

onMounted(async () => {
    await load();

    if (!bridge) {
        return;
    }

    try {
        torrents.value = await bridge.list();
    } catch {
        // No client running yet is the ordinary case, not a failure: nothing
        // starts one until somebody asks for a download.
    }

    unsubscribe = bridge.subscribe((list) => {
        torrents.value = list;
    });
});

onBeforeUnmount(() => {
    window.clearTimeout(debounce);
    unsubscribe?.();
});
</script>

<template>
    <div class="cw-stack">
        <!-- ------------------------------------------------- one release --- -->
        <template v-if="selected">
            <button type="button" class="cw-back" @click="selected = null">
                ← {{ t('trackerTitle') }}
            </button>

            <h2 class="cw-title" style="margin: 22px 0 6px">
                {{ selected.name }}
            </h2>
            <p class="cw-data">
                {{ t(`trackerCat_${selected.category}`) }} ·
                {{ formatBytes(selected.size_bytes) }} ·
                {{ t('trackerFiles', { count: selected.file_count }) }}
            </p>

            <img
                v-if="selected.cover_url"
                :src="
                    selected.cover_url.replace(
                        'ipfs://',
                        'https://ipfs.io/ipfs/',
                    )
                "
                alt=""
                style="
                    width: 100%;
                    margin-top: 14px;
                    border: 1px solid var(--cw-line);
                "
            />

            <p
                v-if="selected.description"
                class="cw-prose"
                style="margin-top: 14px"
            >
                {{ selected.description }}
            </p>

            <div class="cw-grid" style="margin-top: 16px">
                <div class="cw-num">
                    <span class="cw-label">{{ t('trackerSeeders') }}</span>
                    <span class="cw-display">{{ selected.seeders }}</span>
                </div>
                <div class="cw-num">
                    <span class="cw-label">{{ t('trackerLeechers') }}</span>
                    <span class="cw-display">{{ selected.leechers }}</span>
                </div>
            </div>

            <!-- Playing, downloading, and the honest gap between them. -->
            <button
                v-if="playable(selected).length > 0"
                type="button"
                class="cw-btn cw-btn-primary"
                style="height: 48px; margin-top: 16px"
                @click="open(selected)"
            >
                <Play :size="14" aria-hidden="true" />
                {{ held ? t('trackerPlaySwarm') : t('trackerPlayPreview') }}
            </button>

            <template v-if="bridge">
                <button
                    v-if="!held"
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="height: 44px; margin-top: 10px"
                    :disabled="adding"
                    @click="download(selected)"
                >
                    <Download :size="14" aria-hidden="true" />
                    {{ adding ? t('trackerJoining') : t('trackerDownload') }}
                </button>
                <p v-else class="cw-note" style="margin-top: 10px">
                    <span>
                        {{
                            t('trackerHolding', {
                                percent: Math.round(held.progress * 100),
                                peers: held.peers,
                            })
                        }}
                    </span>
                </p>
            </template>
            <p v-else class="cw-note" style="margin-top: 12px">
                <span>{{ t('trackerNoClient') }}</span>
            </p>

            <div style="display: flex; gap: 8px; margin-top: 12px">
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="flex: 1"
                    @click="copyMagnet(selected)"
                >
                    <Copy :size="13" aria-hidden="true" />
                    {{ copied ? t('copiedLabel') : t('trackerCopyMagnet') }}
                </button>
                <a
                    class="cw-btn cw-btn-secondary"
                    style="flex: 1; text-decoration: none"
                    :href="selected.magnet"
                >
                    {{ t('trackerOpenMagnet') }}
                </a>
            </div>

            <p class="cw-label" style="margin: 20px 0 8px">
                {{ t('trackerToken') }}
            </p>
            <div class="cw-card" style="padding: 12px 14px">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('trackerOwner') }}</span>
                    <span
                        class="cw-kv-val"
                        style="overflow-wrap: anywhere; text-align: right"
                    >
                        {{ selected.owner
                        }}<template v-if="mine(selected)">
                            · {{ t('trackerYours') }}</template
                        >
                    </span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('trackerTokenId') }}</span>
                    <span class="cw-kv-val">#{{ selected.token_id }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('trackerInfoHash') }}</span>
                    <span
                        class="cw-kv-val"
                        style="overflow-wrap: anywhere; text-align: right"
                        >{{ selected.info_hash }}</span
                    >
                </div>
            </div>
            <a
                v-if="selected.token_url"
                class="cw-btn cw-btn-secondary"
                style="margin-top: 10px; text-decoration: none"
                :href="selected.token_url"
                target="_blank"
                rel="noopener noreferrer"
            >
                {{ t('trackerOnChain') }}
                <ExternalLink :size="13" aria-hidden="true" />
            </a>

            <template v-if="selected.files.length > 0">
                <p class="cw-label" style="margin: 20px 0 8px">
                    {{ t('trackerFiles', { count: selected.files.length }) }}
                </p>
                <div class="cw-stack" style="gap: 4px">
                    <div
                        v-for="file in selected.files.slice(0, 200)"
                        :key="file.path"
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
                            >{{ file.path }}</span
                        >
                        <span class="cw-data" style="font-size: 12px">{{
                            formatBytes(file.length)
                        }}</span>
                    </div>
                </div>
            </template>

            <p class="cw-note" style="margin-top: 16px">
                <span>{{ t('trackerLawNote') }}</span>
            </p>
        </template>

        <!-- ---------------------------------------------------- the index --- -->
        <template v-else>
            <button type="button" class="cw-back" @click="emit('back')">
                ← {{ t('nftTitle') }}
            </button>

            <h2 class="cw-title" style="margin: 22px 0 8px">
                {{ t('trackerTitle') }}
            </h2>
            <p class="cw-prose">{{ t('trackerBody') }}</p>

            <button
                type="button"
                class="cw-btn cw-btn-primary"
                style="height: 48px; margin-top: 16px"
                @click="emit('publish')"
            >
                <Upload :size="14" aria-hidden="true" />
                {{ t('trackerPublish') }}
            </button>

            <div class="cw-row" style="gap: 8px; margin-top: 18px">
                <Search
                    :size="13"
                    aria-hidden="true"
                    style="color: var(--cw-faint)"
                />
                <input
                    v-model="query"
                    class="cw-input"
                    type="search"
                    spellcheck="false"
                    style="flex: 1"
                    :placeholder="t('trackerSearch')"
                />
            </div>

            <div class="cw-seg" style="margin-top: 10px; flex-wrap: wrap">
                <button
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="category === ''"
                    @click="category = ''"
                >
                    {{ t('trackerCatAll') }}
                </button>
                <button
                    v-for="entry in context?.categories ?? []"
                    :key="entry"
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="category === entry"
                    @click="category = entry"
                >
                    {{ t(`trackerCat_${entry}`) }}
                </button>
            </div>

            <div class="cw-seg" style="margin-top: 8px">
                <button
                    v-for="entry in ['new', 'seeders', 'size', 'name']"
                    :key="entry"
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="sort === entry"
                    @click="sort = entry"
                >
                    {{ t(`trackerSort_${entry}`) }}
                </button>
            </div>

            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 16px"
            >
                <span style="flex: 1">{{ failure }}</span>
                <button type="button" class="cw-back" @click="load">
                    {{ t('retry') }}
                </button>
            </p>

            <p v-else-if="loading" class="cw-prose" style="margin-top: 20px">
                {{ t('trackerLoading') }}
            </p>

            <p
                v-else-if="releases.length === 0"
                class="cw-prose"
                style="margin-top: 20px"
            >
                {{
                    query === '' && category === ''
                        ? t('trackerEmpty')
                        : t('trackerNoMatch')
                }}
            </p>

            <template v-else>
                <p class="cw-label" style="margin: 20px 0 8px">
                    {{ t('trackerCount', { count: total }) }}
                </p>

                <div class="cw-stack" style="gap: 6px">
                    <button
                        v-for="release in releases"
                        :key="release.info_hash"
                        type="button"
                        class="cw-card cw-card-button"
                        style="padding: 12px 14px"
                        @click="selected = release"
                    >
                        <div class="cw-row" style="gap: 8px">
                            <span
                                style="
                                    flex: 1;
                                    min-width: 0;
                                    overflow: hidden;
                                    font: 500 15px/1.3 var(--cw-sans);
                                    text-overflow: ellipsis;
                                    white-space: nowrap;
                                "
                                >{{ release.name }}</span
                            >
                            <span v-if="mine(release)" class="cw-badge">{{
                                t('trackerYours')
                            }}</span>
                        </div>
                        <div
                            class="cw-data"
                            style="margin-top: 6px; font-size: 12px"
                        >
                            {{ t(`trackerCat_${release.category}`) }} ·
                            {{ formatBytes(release.size_bytes) }} ·
                            {{
                                t('trackerSwarm', {
                                    seeders: release.seeders,
                                    leechers: release.leechers,
                                })
                            }}
                        </div>
                    </button>
                </div>

                <div
                    v-if="pages > 1"
                    class="cw-row"
                    style="gap: 8px; margin-top: 14px"
                >
                    <button
                        type="button"
                        class="cw-ghost"
                        :disabled="page <= 1"
                        @click="
                            page -= 1;
                            load();
                        "
                    >
                        ←
                    </button>
                    <span class="cw-data" style="flex: 1; text-align: center">
                        {{ page }} / {{ pages }}
                    </span>
                    <button
                        type="button"
                        class="cw-ghost"
                        :disabled="page >= pages"
                        @click="
                            page += 1;
                            load();
                        "
                    >
                        →
                    </button>
                </div>
            </template>

            <p v-if="context" class="cw-note" style="margin-top: 18px">
                <span>{{
                    t('trackerAnnounceNote', { url: context.announce_url })
                }}</span>
            </p>
        </template>
    </div>
</template>
