<script setup lang="ts">
import { computed } from 'vue';
import type { WalletTxStatus } from '@/lib/wallet';

/**
 * Transaction state. Deliberately a different colour family from the network
 * marks — amber/green/red never means "which chain", and a network hue never
 * means "how it went".
 */

const props = defineProps<{
    status: WalletTxStatus | 'signing';
    label: string;
    /** Drop the border and render as a bare dot plus caption. */
    bare?: boolean;
}>();

const COLORS: Record<WalletTxStatus | 'signing', string> = {
    signing: 'var(--cw-text)',
    pending: 'var(--cw-pending)',
    confirmed: 'var(--cw-ok)',
    failed: 'var(--cw-bad)',
};

const color = computed(() => COLORS[props.status]);
</script>

<template>
    <span
        :style="{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '7px',
            height: bare ? 'auto' : '28px',
            padding: bare ? '0' : '0 12px',
            border: bare ? 'none' : `1px solid ${color}59`,
        }"
    >
        <span
            :style="{
                width: '5px',
                height: '5px',
                flex: 'none',
                background: color,
                borderRadius: status === 'failed' ? '0' : '50%',
                animation:
                    status === 'signing' || status === 'pending'
                        ? 'cw-pulse 1.4s infinite'
                        : undefined,
            }"
        />
        <span
            :style="{
                font: `400 ${bare ? '10px' : '11px'}/1 var(--cw-mono)`,
                letterSpacing: '0.12em',
                color,
                textTransform: 'uppercase',
            }"
        >
            {{ label }}
        </span>
    </span>
</template>
