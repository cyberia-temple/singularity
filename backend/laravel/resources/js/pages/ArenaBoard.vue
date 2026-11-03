<script setup lang="ts">
import { Head } from '@inertiajs/vue3';
import WalletTradingArena from '@/components/wallet/WalletTradingArena.vue';
import type {
    ArenaDetail,
    ArenaOverview,
} from '@/components/wallet/WalletTradingArena.vue';
import { useWalletTheme } from '@/composables/useWalletTheme';

/**
 * /arena: the wallet's arena screen on its own, with no site chrome around
 * it — the same component the wallet mounts, seeded with the first reading.
 */
const props = defineProps<{
    board: ArenaOverview;
    agent: string | null;
    detail: ArenaDetail | null;
}>();
const { scheme, palette } = useWalletTheme();
</script>

<template>
    <Head :title="`${props.board.season?.title ?? 'AI arena'} | Cyberia`" />
    <div
        class="cw"
        :data-cw-theme="scheme"
        :data-cw-palette="palette"
        style="
            min-height: 100dvh;
            background: var(--cw-canvas);
            color: var(--cw-text);
        "
    >
        <main style="max-width: 560px; margin: 0 auto; padding: 8px 16px 48px">
            <a
                href="/wallet"
                class="cw-hint"
                style="
                    display: inline-block;
                    margin-top: 14px;
                    font-size: 13px;
                    color: var(--cw-muted);
                "
                >Cyberia</a
            >
            <WalletTradingArena
                standalone
                :initial="props.board"
                :initial-agent="props.agent"
                :initial-detail="props.detail"
            />
        </main>
    </div>
</template>

<style src="../../css/wallet.css"></style>
