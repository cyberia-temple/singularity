<script setup lang="ts">
/**
 * The frame the wallet gets, in a browser tab exactly as in the apps.
 *
 * It began as the shells' chrome — a native app that opens on a web navbar
 * reads as a browser somebody forgot to close — and the site header stayed on
 * `/wallet` in a browser for a while longer. That was the wrong half of the
 * argument. The wallet is an application wherever it is opened: it owns the
 * viewport, it has its own navigation along the bottom and its own bar along
 * the top, and above all of that sat a second navigation, a second brand and a
 * second account menu belonging to something else. On a phone that stack cost
 * about a fifth of the screen before the first balance.
 *
 * So there is no site chrome here in any container. What is left is background,
 * safe-area insets and full height, with the page painting everything inside.
 * The rest of Cyberia is not amputated — the wallet links out to it — and every
 * other route still renders with the normal site layout.
 *
 * The frame is `h-dvh`, not `min-h-screen`, and `main` may shrink below its
 * content: an app window does not scroll as a page. A minimum only says "at
 * least this tall", which leaves the height indefinite, so the wallet's own
 * scrolling panes (the rail, the screen body) grow the document instead of
 * scrolling inside it — a maximized window ended up a few dozen pixels taller
 * than the screen.
 */
</script>

<template>
    <div
        class="flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground"
    >
        <main class="flex min-h-0 flex-1 flex-col">
            <slot />
        </main>
    </div>
</template>
