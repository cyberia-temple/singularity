<script setup lang="ts">
import {
    Maximize2,
    Pause,
    Play,
    Repeat,
    Repeat1,
    SkipBack,
    SkipForward,
    Volume2,
    VolumeX,
} from 'lucide-vue-next';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { formatBytes } from '@/lib/wallet/ipfs';
import { advance, formatTime } from '@/lib/wallet/player';
import type { PlayerTrack } from '@/lib/wallet/player';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The wallet's player, for the two things people actually keep: video and
 * music.
 *
 * One media element for both. A `<video>` plays audio perfectly well, and
 * having two elements would mean two sets of listeners, two volumes and a
 * moment of silence every time a playlist crossed from a film to its
 * soundtrack — so the element is always the same one and only the frame around
 * it changes.
 *
 * The controls are drawn rather than native for one reason: the native ones
 * cannot say *why* nothing is playing. Three of the states here are not
 * failures and all three look identical to a browser — a stream still being
 * asked for from a swarm, a container this engine never decoded, and a file
 * whose peers have not arrived yet. Each gets a sentence.
 *
 * What it will not do: pretend. A track whose URL has to be resolved is
 * resolved when it is played and not when the list is drawn, because asking
 * for forty streams at once tells a torrent client that forty files are
 * urgent, which is how a swarm downloads none of them.
 */

const props = defineProps<{
    tracks: PlayerTrack[];
    heading: string;
    /** Cover art, when the thing being played came with one. */
    poster?: string | null;
    /** Where the release or token this playlist came from can be opened. */
    externalLabel?: string;
    /** True where the shell can hand a file to the system's own player. */
    canOpenExternally?: boolean;
}>();

const emit = defineEmits<{
    back: [];
    /** Play this one outside the browser — the answer for Matroska. */
    openExternally: [track: PlayerTrack];
}>();

const { t } = useLocale(walletMessages);

const media = ref<HTMLVideoElement | null>(null);
const frame = ref<HTMLDivElement | null>(null);

const index = ref(0);
const playing = ref(false);
const currentTime = ref(0);
const duration = ref<number | null>(null);
const volume = ref(1);
const muted = ref(false);
const repeat = ref<'off' | 'all' | 'one'>('off');
const failure = ref<string | null>(null);
const resolving = ref(false);

/** URLs already asked for, so seeking back a track does not ask again. */
const resolved = new Map<string, string>();

const track = computed<PlayerTrack | null>(
    () => props.tracks[index.value] ?? null,
);

const isVideo = computed(() => track.value?.kind === 'video');

/**
 * Whether this browser is expected to refuse the current track.
 *
 * Said before it is tried, because the alternative is a black rectangle: a
 * media element handed a container it cannot decode fails with an error code
 * no one recognises, and most of what is in a swarm is Matroska.
 */
const undecodable = computed(() => track.value?.support === 'external');

const progress = computed(() =>
    duration.value && duration.value > 0
        ? (currentTime.value / duration.value) * 100
        : 0,
);

/** The URL to load, asked for only at the moment it is needed. */
const sourceFor = async (entry: PlayerTrack): Promise<string> => {
    if (entry.url !== '') {
        return entry.url;
    }

    const cached = resolved.get(entry.id);

    if (cached !== undefined) {
        return cached;
    }

    if (!entry.resolve) {
        throw new Error(t('playerNoStream'));
    }

    resolving.value = true;

    try {
        const url = await entry.resolve();
        resolved.set(entry.id, url);

        return url;
    } finally {
        resolving.value = false;
    }
};

const load = async (autoplay: boolean): Promise<void> => {
    const entry = track.value;
    const element = media.value;

    failure.value = null;

    if (!entry || !element) {
        return;
    }

    try {
        const url = await sourceFor(entry);

        // Only reassign when it actually changed: setting `src` to the same
        // string reloads the media and throws away the buffer, which on a
        // torrent stream means asking the swarm for pieces it just delivered.
        if (element.src !== url) {
            element.src = url;
            element.load();
        }

        if (autoplay) {
            await element.play();
        }
    } catch (error) {
        // A refused autoplay is not a broken track — the browser is asking for
        // a gesture, and the play button is right there.
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
            playing.value = false;

            return;
        }

        failure.value = error instanceof Error ? error.message : String(error);
    }
};

const toggle = async (): Promise<void> => {
    const element = media.value;

    if (!element) {
        return;
    }

    if (element.paused) {
        if (element.src === '') {
            await load(true);

            return;
        }

        try {
            await element.play();
        } catch (error) {
            failure.value =
                error instanceof Error ? error.message : String(error);
        }
    } else {
        element.pause();
    }
};

const select = async (next: number): Promise<void> => {
    if (next < 0 || next >= props.tracks.length) {
        return;
    }

    index.value = next;
    currentTime.value = 0;
    duration.value = null;
    await load(true);
};

const step = (delta: number): void => {
    void select(index.value + delta);
};

const onEnded = (): void => {
    const next = advance(index.value, props.tracks.length, repeat.value);

    if (next === null) {
        playing.value = false;

        return;
    }

    if (next === index.value) {
        // Repeat-one: seek rather than reload, so a stream is not re-fetched.
        if (media.value) {
            media.value.currentTime = 0;
            void media.value.play();
        }

        return;
    }

    void select(next);
};

const seek = (event: Event): void => {
    const element = media.value;
    const value = Number((event.target as HTMLInputElement).value);

    if (element && duration.value) {
        element.currentTime = (value / 100) * duration.value;
    }
};

const nudge = (seconds: number): void => {
    const element = media.value;

    if (element) {
        element.currentTime = Math.max(0, element.currentTime + seconds);
    }
};

const setVolume = (event: Event): void => {
    volume.value = Number((event.target as HTMLInputElement).value) / 100;

    if (media.value) {
        media.value.volume = volume.value;
        media.value.muted = false;
    }

    muted.value = false;
};

const toggleMute = (): void => {
    muted.value = !muted.value;

    if (media.value) {
        media.value.muted = muted.value;
    }
};

const cycleRepeat = (): void => {
    repeat.value =
        repeat.value === 'off' ? 'all' : repeat.value === 'all' ? 'one' : 'off';
};

const fullscreen = (): void => {
    void frame.value?.requestFullscreen?.().catch(() => {
        // Some shells refuse it outright; the player keeps working inline,
        // which is the whole of what a refusal costs here.
    });
};

/**
 * The keys everybody already has in their fingers.
 *
 * Bound on the player's own element rather than the document: this screen sits
 * inside a wallet with a search field and a send form on it, and a space bar
 * that pauses music while somebody is typing an address is a bug.
 */
const onKey = (event: KeyboardEvent): void => {
    if (event.key === ' ') {
        event.preventDefault();
        void toggle();
    } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        nudge(5);
    } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        nudge(-5);
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault();
        volume.value = Math.min(
            1,
            Math.max(0, volume.value + (event.key === 'ArrowUp' ? 0.1 : -0.1)),
        );

        if (media.value) {
            media.value.volume = volume.value;
        }
    }
};

const onError = (): void => {
    const code = media.value?.error?.code ?? 0;

    // 4 is MEDIA_ERR_SRC_NOT_SUPPORTED, which is what a container this engine
    // never decoded looks like from here — and it is worth saying so plainly
    // rather than reporting it as a network problem.
    failure.value =
        code === 4
            ? t('playerUndecodable')
            : media.value?.error?.message || t('playerFailed');
    playing.value = false;
};

watch(
    () => props.tracks.map((entry) => entry.id).join('|'),
    () => {
        index.value = 0;
        currentTime.value = 0;
        duration.value = null;
        failure.value = null;
    },
);

onBeforeUnmount(() => {
    // A media element left with a source keeps the connection open, which for
    // a torrent stream means the swarm keeps sending.
    if (media.value) {
        media.value.pause();
        media.value.removeAttribute('src');
        media.value.load();
    }
});
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('back') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 4px">{{ heading }}</h2>
        <p v-if="track" class="cw-data" style="margin-bottom: 12px">
            {{ track.title
            }}<template v-if="track.subtitle"> · {{ track.subtitle }}</template>
            <template v-if="track.length">
                · {{ formatBytes(track.length) }}</template
            >
        </p>

        <p v-if="tracks.length === 0" class="cw-prose">
            {{ t('playerNothing') }}
        </p>

        <template v-else>
            <div
                ref="frame"
                class="cw-card"
                tabindex="0"
                style="padding: 0; outline: none"
                @keydown="onKey"
            >
                <!--
                  One element for both kinds. For audio it is collapsed rather
                  than removed: taking it out of the tree would stop the sound.
                -->
                <div
                    :style="{
                        position: 'relative',
                        background: '#05070a',
                        aspectRatio: isVideo ? '16 / 9' : undefined,
                        height: isVideo ? undefined : '132px',
                    }"
                >
                    <video
                        ref="media"
                        playsinline
                        :poster="poster ?? undefined"
                        :style="{
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                            display: isVideo ? 'block' : 'none',
                            background: '#05070a',
                        }"
                        @play="playing = true"
                        @pause="playing = false"
                        @ended="onEnded"
                        @error="onError"
                        @timeupdate="currentTime = media?.currentTime ?? 0"
                        @loadedmetadata="
                            duration = Number.isFinite(media?.duration ?? NaN)
                                ? (media?.duration ?? null)
                                : null
                        "
                    ></video>

                    <!-- Audio has nothing to look at, so it gets the cover it
                         was published with, or the wallet's own raster. -->
                    <div
                        v-if="!isVideo"
                        class="cw-raster"
                        style="
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            height: 100%;
                        "
                    >
                        <img
                            v-if="poster"
                            :src="poster"
                            alt=""
                            style="max-height: 100%; object-fit: contain"
                        />
                        <span
                            v-else
                            class="cw-label"
                            style="color: var(--cw-faint)"
                        >
                            {{ t('playerAudioOnly') }}
                        </span>
                    </div>
                </div>

                <!-- Seek. A range input rather than a drawn bar: it is
                     keyboard-reachable and screen readers announce it. -->
                <div style="padding: 10px 12px 12px">
                    <input
                        type="range"
                        min="0"
                        max="100"
                        step="0.1"
                        :value="progress"
                        :aria-label="t('playerSeek')"
                        style="width: 100%"
                        @input="seek"
                    />

                    <div class="cw-row" style="gap: 10px; margin-top: 6px">
                        <span class="cw-data" style="font-size: 12px">
                            {{ formatTime(currentTime) }} /
                            {{ formatTime(duration) }}
                        </span>
                        <span style="flex: 1"></span>

                        <button
                            type="button"
                            class="cw-icon-btn"
                            :aria-label="t('playerPrev')"
                            :disabled="index === 0"
                            @click="step(-1)"
                        >
                            <SkipBack :size="13" />
                        </button>
                        <button
                            type="button"
                            class="cw-icon-btn"
                            :aria-label="
                                playing ? t('playerPause') : t('playerPlay')
                            "
                            @click="toggle"
                        >
                            <Pause v-if="playing" :size="14" />
                            <Play v-else :size="14" />
                        </button>
                        <button
                            type="button"
                            class="cw-icon-btn"
                            :aria-label="t('playerNext')"
                            :disabled="index >= tracks.length - 1"
                            @click="step(1)"
                        >
                            <SkipForward :size="13" />
                        </button>
                        <button
                            type="button"
                            class="cw-icon-btn"
                            :aria-label="
                                repeat === 'one'
                                    ? t('playerRepeatOne')
                                    : repeat === 'all'
                                      ? t('playerRepeatAll')
                                      : t('playerRepeatOff')
                            "
                            :aria-pressed="repeat !== 'off'"
                            @click="cycleRepeat"
                        >
                            <Repeat1 v-if="repeat === 'one'" :size="13" />
                            <Repeat
                                v-else
                                :size="13"
                                :style="{ opacity: repeat === 'all' ? 1 : 0.4 }"
                            />
                        </button>
                        <button
                            type="button"
                            class="cw-icon-btn"
                            :aria-label="
                                muted ? t('playerUnmute') : t('playerMute')
                            "
                            @click="toggleMute"
                        >
                            <VolumeX v-if="muted" :size="13" />
                            <Volume2 v-else :size="13" />
                        </button>
                        <input
                            type="range"
                            min="0"
                            max="100"
                            :value="Math.round(volume * 100)"
                            :aria-label="t('playerVolume')"
                            style="width: 64px"
                            @input="setVolume"
                        />
                        <button
                            v-if="isVideo"
                            type="button"
                            class="cw-icon-btn"
                            :aria-label="t('playerFullscreen')"
                            @click="fullscreen"
                        >
                            <Maximize2 :size="13" />
                        </button>
                    </div>
                </div>
            </div>

            <p v-if="resolving" class="cw-note" style="margin-top: 12px">
                <span>{{ t('playerResolving') }}</span>
            </p>

            <!-- Said before anything is tried, not after it silently fails. -->
            <p
                v-if="undecodable"
                class="cw-note cw-note-warn"
                style="margin-top: 12px"
            >
                <span style="flex: 1">{{ t('playerUndecodable') }}</span>
                <button
                    v-if="canOpenExternally && track"
                    type="button"
                    class="cw-back"
                    @click="emit('openExternally', track)"
                >
                    {{ t('playerOpenExternal') }}
                </button>
            </p>

            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 12px"
            >
                <span>{{ failure }}</span>
            </p>

            <template v-if="tracks.length > 1">
                <p class="cw-label" style="margin: 18px 0 8px">
                    {{ t('playerTracks', { count: tracks.length }) }}
                </p>
                <div class="cw-stack" style="gap: 4px">
                    <button
                        v-for="(entry, position) in tracks"
                        :key="entry.id"
                        type="button"
                        class="cw-card cw-card-button"
                        style="padding: 9px 12px"
                        :aria-current="position === index"
                        @click="select(position)"
                    >
                        <div class="cw-row" style="gap: 8px">
                            <span
                                class="cw-data"
                                style="
                                    width: 22px;
                                    font-size: 12px;
                                    color: var(--cw-faint);
                                "
                                >{{ position + 1 }}</span
                            >
                            <span
                                style="
                                    flex: 1;
                                    min-width: 0;
                                    overflow: hidden;
                                    font: 400 14px/1.3 var(--cw-sans);
                                    text-overflow: ellipsis;
                                    white-space: nowrap;
                                "
                                :style="{
                                    color:
                                        position === index
                                            ? 'var(--cw-accent)'
                                            : undefined,
                                }"
                                >{{ entry.title }}</span
                            >
                            <span
                                v-if="entry.support === 'external'"
                                class="cw-badge"
                                >{{ t('playerBadgeExternal') }}</span
                            >
                            <span
                                v-if="entry.length"
                                class="cw-data"
                                style="font-size: 12px"
                                >{{ formatBytes(entry.length) }}</span
                            >
                        </div>
                    </button>
                </div>
            </template>

            <p class="cw-note" style="margin-top: 16px">
                <span>{{ t('playerKeys') }}</span>
            </p>
        </template>
    </div>
</template>
