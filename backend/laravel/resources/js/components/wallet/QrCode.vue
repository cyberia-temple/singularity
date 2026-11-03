<script setup lang="ts">
import { computed } from 'vue';
import { qrMatrix, qrSvgPath } from '@/lib/wallet/qr';

/**
 * A receive address as a QR symbol. Drawn as one SVG path so it stays crisp at
 * any size and prints without a raster step — a phone camera and a photocopier
 * both have to be able to read it.
 */

const props = withDefaults(
    defineProps<{ value: string; label: string; size?: number }>(),
    { size: 188 },
);

const QUIET_ZONE = 4;

const symbol = computed(() => {
    const matrix = qrMatrix(props.value);

    return {
        extent: matrix.size + QUIET_ZONE * 2,
        path: qrSvgPath(matrix, QUIET_ZONE),
    };
});
</script>

<template>
    <!-- A QR code is an address in another alphabet: recordings get a blank box. -->
    <svg
        data-replay-block
        :viewBox="`0 0 ${symbol.extent} ${symbol.extent}`"
        :width="size"
        :height="size"
        role="img"
        :aria-label="label"
        shape-rendering="crispEdges"
        style="border-radius: 4px; background: #e8edf2"
    >
        <path :d="symbol.path" fill="#07080a" />
    </svg>
</template>
