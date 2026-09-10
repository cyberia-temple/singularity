<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * A tokenised stock's mark: the company's own, or its ticker.
 *
 * The image is served from this origin (`public/token-icons/stocks/`) and never
 * from the issuer's CDN — partly because Robinhood answers every one of these
 * addresses with the same lime feather, and partly because a wallet fetching
 * fifty-three images from a third party tells that third party which stocks the
 * person is looking at.
 *
 * A logo that fails to load falls back to the ticker rather than to a broken
 * image or to somebody else's mark: on this screen the ticker is the thing that
 * identifies the row, and the picture is decoration on top of it.
 */
const props = withDefaults(
    defineProps<{ symbol: string; src?: string | null; size?: number }>(),
    { src: null, size: 28 },
);

const broken = ref(false);

const dimension = computed(() => `${props.size}px`);
const shown = computed(() => props.src !== null && !broken.value);
</script>

<template>
    <img
        v-if="shown"
        :src="src!"
        :alt="symbol"
        class="cw-stock-icon"
        :style="{ width: dimension, height: dimension }"
        loading="lazy"
        @error="broken = true"
    />
    <span
        v-else
        class="cw-stock-icon cw-stock-icon-none"
        :style="{ width: dimension, height: dimension }"
        >{{ symbol.slice(0, 4) }}</span
    >
</template>
