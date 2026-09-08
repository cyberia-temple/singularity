<script setup lang="ts">
import { usePage } from '@inertiajs/vue3';
import { computed } from 'vue';
import PwaInstallPrompt from '@/components/PwaInstallPrompt.vue';
import SiteFooter from '@/components/web3/SiteFooter.vue';
import SiteHeader from '@/components/web3/SiteHeader.vue';

/**
 * One page here is an app and not a document.
 *
 * The wallet claims the viewport under the sticky header so its own tab bar
 * stays pinned at the bottom of the frame. A footer below that frame is a strip
 * of page that exists only to be scrolled to — and scrolling to it drags the
 * tab bar off the top of the screen, which is the whole problem the frame was
 * for. So on that one route the document ends where the viewport does, and the
 * height is handed down the tree (`h-dvh` → `main` → the wallet) rather than
 * subtracted from a header height written twice.
 *
 * The footer's links are not lost: the wallet's own masthead goes to the site,
 * and the header above it is still the site's.
 */
const page = usePage();

const app = computed(() => page.component === 'Wallet');
</script>

<template>
    <div
        class="flex flex-col bg-background text-foreground"
        :class="app ? 'h-dvh overflow-hidden' : 'min-h-screen'"
    >
        <SiteHeader />
        <main class="flex-1" :class="app ? 'flex min-h-0 flex-col' : undefined">
            <slot />
        </main>
        <SiteFooter v-if="!app" />
        <PwaInstallPrompt />
    </div>
</template>
