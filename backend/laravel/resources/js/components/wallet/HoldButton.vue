<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

/**
 * Hold-to-confirm.
 *
 * A tap is something a thumb does by accident; holding for a second is not.
 * This is the last control before a signature, so it also cannot be a control
 * only a mouse can operate — holding Space or Enter runs the same countdown,
 * and releasing early cancels it with nothing signed.
 */

const props = withDefaults(
    defineProps<{ label: string; holdMs?: number; disabled?: boolean }>(),
    { holdMs: 1_200, disabled: false },
);

const emit = defineEmits<{ complete: [] }>();

const progress = ref(0);

let frame: number | null = null;
let startedAt = 0;

const stop = (): void => {
    if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
    }

    progress.value = 0;
};

const tick = (): void => {
    progress.value = Math.min(
        1,
        (performance.now() - startedAt) / props.holdMs,
    );

    if (progress.value >= 1) {
        stop();
        emit('complete');

        return;
    }

    frame = requestAnimationFrame(tick);
};

const start = (): void => {
    if (props.disabled || frame !== null) {
        return;
    }

    startedAt = performance.now();
    frame = requestAnimationFrame(tick);
};

const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === ' ' || event.key === 'Enter') {
        // Held keys repeat; only the first press starts the countdown.
        event.preventDefault();
        start();
    }
};

const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === ' ' || event.key === 'Enter') {
        stop();
    }
};

onBeforeUnmount(stop);
</script>

<template>
    <button
        type="button"
        :disabled="disabled"
        :aria-label="label"
        style="
            position: relative;
            height: 54px;
            width: 100%;
            overflow: hidden;
            border: 1px solid var(--cw-accent);
            border-radius: 4px;
            background: #0e1114;
            cursor: pointer;
            user-select: none;
            touch-action: none;
        "
        :style="
            disabled
                ? {
                      borderColor: '#1b2126',
                      cursor: 'not-allowed',
                      opacity: 0.5,
                  }
                : {}
        "
        @pointerdown.prevent="start"
        @pointerup="stop"
        @pointerleave="stop"
        @pointercancel="stop"
        @keydown="onKeyDown"
        @keyup="onKeyUp"
        @blur="stop"
    >
        <span
            aria-hidden="true"
            :style="{
                position: 'absolute',
                inset: '0 auto 0 0',
                width: `${progress * 100}%`,
                background: 'var(--cw-accent)',
            }"
        />
        <span
            style="
                position: relative;
                font: 600 15px/1 var(--cw-mono);
                letter-spacing: 0.07em;
                color: var(--cw-text);
                mix-blend-mode: difference;
            "
        >
            {{ label }}
        </span>
    </button>
</template>
