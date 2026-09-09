<script setup lang="ts">
import { Check, Copy, Maximize2, Minimize2 } from 'lucide-vue-next';
import { computed, ref } from 'vue';
import { addressGroups } from '@/lib/wallet/format';

/**
 * An address, truncated but never hidden: head and tail are always readable,
 * the full string is one control away, and copying is one tap. Truncation is
 * what people actually compare against a paper note; the expand exists so the
 * comparison can be finished character by character before a payment.
 */

const props = defineProps<{
    address: string;
    label: string;
    copied: boolean;
    copyLabel: string;
    copiedLabel: string;
    expandLabel: string;
}>();

const emit = defineEmits<{ copy: [] }>();

const full = ref(false);

const shown = computed(() =>
    full.value || props.address.length <= 20
        ? props.address
        : `${props.address.slice(0, 8)}…${props.address.slice(-6)}`,
);

/**
 * Expanded, the string is there to be compared character by character — which
 * is the one thing an unbroken run is worst at. Truncated it is short enough
 * to read whole, so it stays as it is.
 */
const groups = computed(() =>
    full.value ? addressGroups(props.address) : null,
);
</script>

<template>
    <div>
        <div class="cw-label" style="margin-bottom: 8px">{{ label }}</div>
        <div style="display: flex; align-items: center; gap: 10px">
            <span
                v-if="groups"
                class="cw-addr"
                style="flex: 1; min-width: 0"
                :title="address"
            >
                <span v-for="(group, at) in groups" :key="at">{{ group }}</span>
            </span>
            <span
                v-else
                class="cw-data"
                style="flex: 1; min-width: 0; word-break: break-all"
                >{{ shown }}</span
            >
            <button
                type="button"
                class="cw-icon-btn"
                :aria-label="expandLabel"
                :aria-pressed="full"
                @click="full = !full"
            >
                <component
                    :is="full ? Minimize2 : Maximize2"
                    :size="14"
                    aria-hidden="true"
                />
            </button>
            <button
                type="button"
                class="cw-icon-btn"
                :aria-label="copied ? copiedLabel : copyLabel"
                :style="
                    copied
                        ? {
                              borderColor: 'var(--cw-accent)',
                              color: 'var(--cw-accent)',
                          }
                        : {}
                "
                @click="emit('copy')"
            >
                <component
                    :is="copied ? Check : Copy"
                    :size="14"
                    aria-hidden="true"
                />
            </button>
        </div>
    </div>
</template>
