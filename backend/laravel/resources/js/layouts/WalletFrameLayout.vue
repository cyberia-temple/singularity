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
 *
 * An app window also does not *zoom*, and that is the other half of the same
 * complaint. Clipping the document stopped it scrolling and the app still moved
 * under the finger, because a zoomed page does not scroll — it pans, in the
 * visual viewport, where no `overflow` rule can reach it. A pinch nobody meant
 * to make, or an input smaller than 16px taking focus on iOS, and from then on
 * the whole thing drags: background, frame and tab bar together, which is
 * exactly what a scroll looks like. So while this frame is on screen the page
 * is pinned at scale 1.
 *
 * Only in a window that is an application — an installed PWA, a shell, a Mini
 * App. In an ordinary browser tab the page stays zoomable, because a wallet
 * draws 11px labels and taking magnification away from somebody who needs it is
 * not a bug fix. The site's own meta is restored on the way out, so the rest of
 * Cyberia is untouched by this.
 */
import { onBeforeUnmount, onMounted, watch } from 'vue';
import { useWalletTheme } from '@/composables/useWalletTheme';
import { isNativeShell } from '@/lib/native';

const { scheme, palette } = useWalletTheme();

/**
 * The window as it was before this file touched anything, kept for the readout
 * in Settings. iOS lays a standalone window out once, and if the number changes
 * after we edit the viewport meta then the edit is what shrank it.
 */
const bootWindowHeight = typeof window === 'undefined' ? 0 : window.innerHeight;

/**
 * The zoom clamps, added to whatever the document already asked for.
 *
 * It used to be a whole viewport string written here, which meant every launch
 * had its viewport *replaced* a moment after it was read — and on iOS a
 * standalone window is laid out from that meta, once. Rewriting it wholesale is
 * the kind of thing that re-runs the layout with a different answer, so now
 * nothing is restated: the document's own `width`, `initial-scale` and, above
 * all, `viewport-fit=cover` stay exactly as they were written, and only what is
 * missing is appended.
 */
const lockedViewport = (current: string): string => {
    const parts = current
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

    const declares = (name: string): boolean =>
        parts.some((part) => part.split('=')[0].trim() === name);

    if (!declares('viewport-fit')) {
        parts.push('viewport-fit=cover');
    }

    if (!declares('maximum-scale')) {
        parts.push('maximum-scale=1');
    }

    if (!declares('user-scalable')) {
        parts.push('user-scalable=no');
    }

    return parts.join(', ');
};

/**
 * Is this window an application rather than a tab?
 *
 * The shells say so themselves. An installed PWA does not — `native.ts` is
 * deliberate that it is not a shell, since it runs the site's own code with no
 * bridge of any kind — so it is recognised by `display-mode`, plus the older
 * `navigator.standalone` that iOS home-screen apps still answer instead.
 */
const isAppWindow = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }

    const displayed = ['standalone', 'fullscreen', 'minimal-ui'].some(
        (mode) => window.matchMedia(`(display-mode: ${mode})`).matches,
    );

    return (
        isNativeShell() ||
        displayed ||
        (window.navigator as { standalone?: boolean }).standalone === true
    );
};

/**
 * Who has already paid for the system's bands — the window, or the page?
 *
 * An app window is supposed to be the whole screen, and then `env(safe-area-*)`
 * is the page's share of it: the strip under the status bar, the strip over the
 * home indicator. That is what the frame pads for.
 *
 * An iPhone home-screen app does not work that way. iOS hands the web view a
 * window that is *already* inset — 848 of an 896pt screen, the missing 48 being
 * the status bar — and goes on reporting the insets anyway. Padding by them
 * there counts the same space twice: 48pt of dead ground above the account
 * chips, and 34 under the tab bar, which is the strip that reads as a band
 * pushing the navigation up off the bottom of the screen.
 *
 * So the question is asked of the window rather than assumed: a window shorter
 * than the screen has had its insets taken out of it already, and the page adds
 * nothing. It is re-asked on resize, because a rotation changes both numbers.
 */
const windowCoversScreen = (): boolean => {
    const screenHeight = window.screen?.height ?? 0;

    return (
        screenHeight === 0 ||
        document.documentElement.clientHeight >= screenHeight - 1
    );
};

const readWindowInsets = (): void => {
    document.documentElement.dataset.windowInsets = windowCoversScreen()
        ? 'page'
        : 'system';
    paintWindowChrome();
};

const metaTag = (name: string): HTMLMetaElement | null =>
    document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);

let siteViewport: string | null = null;
let siteThemeColour: string | null = null;

/**
 * The bands the system paints around an app window, and they do not all come
 * from the same place.
 *
 * `theme-color` is the one that is documented and the one everybody reaches for
 * first: it colours the status bar at the top and the address bar in a tab, and
 * it is what took the black strip off the top of the installed app. The *bottom*
 * band — the area Android keeps for the gesture handle or the three buttons —
 * ignores it. That one is tinted from the page's own ground, so the document
 * has to actually be the colour the wallet is painted in, rather than a dark
 * site background hidden under a frame that covers it.
 *
 * `color-scheme` is deliberately *not* sent with them, though it was for one
 * release. The wallet already declares it on `.cw`, where it does the job it is
 * for — the scrollbars and the native controls the wallet does not draw. Saying
 * it again on the root says it to the system as well, and the system answered by
 * painting the bottom band in contrast: a white strip under a dark wallet and a
 * black one under a light wallet, which turned one band into two.
 *
 * Both values are read off the frame's own `--cw-app` rather than written down
 * again here: the palette lives in one file, and a second copy of a hex value is
 * a copy that goes stale the first time somebody adjusts the ground.
 */
const paintWindowChrome = (): void => {
    const frame = document.querySelector('.cw-frame');

    if (!frame) {
        return;
    }

    const ground = getComputedStyle(frame).getPropertyValue('--cw-app').trim();

    if (!ground) {
        return;
    }

    const meta = metaTag('theme-color');

    if (meta) {
        if (siteThemeColour === null) {
            siteThemeColour = meta.content;
        }

        meta.content = ground;
    }

    /*
     * The canvas — what shows beyond the viewport — is the one thing a page can
     * put in a strip it cannot otherwise reach. Where the viewport stops short
     * of the window that strip sits directly under the tab bar, so it is
     * painted the bar's own panel rather than the ground: the alternative is a
     * band of a second colour under the navigation, which is what it looked
     * like. Where the window is covered there is no strip, and the ground is
     * what belongs there.
     */
    const panel = getComputedStyle(frame).getPropertyValue('--cw-panel').trim();
    const canvas = windowCoversScreen() || panel === '' ? ground : panel;

    document.documentElement.style.backgroundColor = canvas;
    document.body.style.backgroundColor = canvas;
};

onMounted(() => {
    paintWindowChrome();

    const meta = metaTag('viewport');

    if (!meta || !isAppWindow()) {
        return;
    }

    siteViewport = meta.content;
    document.documentElement.dataset.bootHeight = String(bootWindowHeight);
    document.documentElement.dataset.appWindow = 'true';
    readWindowInsets();
    window.addEventListener('resize', readWindowInsets);

    const locked = lockedViewport(siteViewport);

    if (locked !== siteViewport) {
        meta.content = locked;
    }
});

/*
 * Both of them, because both change what `--cw-app` resolves to: the scheme
 * picks the face and the palette picks the colours, and the band the system
 * paints around the window is read off that token rather than written down here.
 */
watch([scheme, palette], () => paintWindowChrome());

onBeforeUnmount(() => {
    const viewport = metaTag('viewport');
    const themeColour = metaTag('theme-color');

    if (viewport && siteViewport !== null) {
        viewport.content = siteViewport;
    }

    if (themeColour && siteThemeColour !== null) {
        themeColour.content = siteThemeColour;
    }

    document.documentElement.style.removeProperty('background-color');
    document.body.style.removeProperty('background-color');

    siteViewport = null;
    siteThemeColour = null;
    window.removeEventListener('resize', readWindowInsets);
    delete document.documentElement.dataset.appWindow;
    delete document.documentElement.dataset.windowInsets;
    delete document.documentElement.dataset.bootHeight;
});
</script>

<template>
    <div
        class="cw-window flex h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground"
    >
        <main class="flex min-h-0 flex-1 flex-col">
            <slot />
        </main>
    </div>
</template>
