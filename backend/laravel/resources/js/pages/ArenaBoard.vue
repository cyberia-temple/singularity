<script setup lang="ts">
import { Head } from '@inertiajs/vue3';
import TradingArena from '@/components/arena/TradingArena.vue';
import type {
    ArenaAgentData,
    ArenaBoardData,
} from '@/components/arena/TradingArena.vue';
import { useWalletTheme } from '@/composables/useWalletTheme';

/**
 * /arena: the wallet's arena screen on a page of its own.
 *
 * No site header, no sidebar — the arena is one column, drawn in the wallet's
 * own look, and the wallet shows exactly this component.
 */
defineProps<{
    board: ArenaBoardData;
    agent: ArenaAgentData | null;
}>();

const { scheme, palette } = useWalletTheme();
</script>

<template>
    <Head
        :title="agent ? `${agent.name} · AI trading arena` : 'AI trading arena'"
    />
    <div
        class="cw arena-page"
        :data-cw-theme="scheme"
        :data-cw-palette="palette"
    >
        <main class="arena-column">
            <a href="/" class="arena-home">Cyberia</a>
            <TradingArena :board="board" :agent="agent" />
        </main>
    </div>
</template>

<style src="../../css/wallet.css"></style>

<style scoped>
.arena-page {
    min-height: 100dvh;
    background: var(--cw-canvas);
    color: var(--cw-body);
    font-family: var(--cw-sans);
}

.arena-column {
    display: flex;
    flex-direction: column;
    gap: 18px;
    max-width: 640px;
    margin: 0 auto;
    padding: 28px 16px 64px;
}

.arena-home {
    font: 600 13px/1 var(--cw-sans);
    letter-spacing: 0.04em;
    color: var(--cw-faint);
    text-decoration: none;
}

.arena-home:hover {
    color: var(--cw-accent);
}
</style>
