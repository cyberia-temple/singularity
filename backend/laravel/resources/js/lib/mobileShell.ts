/**
 * What the Android/iOS app (frontend/mobile, Capacitor) adds on top of a
 * browser tab: the system share sheet, the vibration motor, the camera for QR
 * codes, and links that open the app (home-screen shortcuts, `cyberia://…`).
 *
 * The app renders this site, so these are reached through the plugin proxies
 * Capacitor puts on `window.Capacitor.Plugins` — nothing here is bundled from
 * `@capacitor/*`, and every helper degrades to the web API (or to nothing) in
 * a browser, the desktop app and Telegram.
 */
import { nativeShell } from '@/lib/native';

interface CapacitorPlugins {
    App?: {
        addListener: (
            event: 'appUrlOpen',
            handler: (data: { url: string }) => void,
        ) => unknown;
        getLaunchUrl?: () => Promise<{ url?: string } | undefined>;
    };
    Share?: {
        share: (options: {
            title?: string;
            text?: string;
            url?: string;
        }) => Promise<unknown>;
    };
    Haptics?: {
        impact: (options: {
            style: 'LIGHT' | 'MEDIUM' | 'HEAVY';
        }) => Promise<void>;
        notification: (options: {
            type: 'SUCCESS' | 'WARNING' | 'ERROR';
        }) => Promise<void>;
    };
}

function plugins(): CapacitorPlugins | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const capacitor = window.Capacitor as
        | { Plugins?: CapacitorPlugins }
        | undefined;

    return capacitor?.Plugins ?? null;
}

export type ShareOutcome = 'shared' | 'copied' | 'failed';

/**
 * The system share sheet where there is one (the app, a phone browser), the
 * clipboard otherwise. A person closing the sheet is not a failure.
 */
export async function nativeShare(content: {
    title?: string;
    text?: string;
    url?: string;
}): Promise<ShareOutcome> {
    const share = plugins()?.Share;

    try {
        if (share) {
            await share.share(content);

            return 'shared';
        }

        if (
            typeof navigator !== 'undefined' &&
            typeof navigator.share === 'function'
        ) {
            await navigator.share(content);

            return 'shared';
        }
    } catch (error) {
        if (
            error instanceof Error &&
            /cancel|abort/i.test(`${error.name} ${error.message}`)
        ) {
            return 'shared';
        }
    }

    try {
        await navigator.clipboard.writeText(
            [content.text, content.url].filter(Boolean).join(' '),
        );

        return 'copied';
    } catch {
        return 'failed';
    }
}

export type HapticKind = 'tap' | 'success' | 'warning';

/** A short buzz, where the device has a motor and somebody is holding it. */
export function haptic(kind: HapticKind): void {
    const motor = plugins()?.Haptics;

    if (motor) {
        void (
            kind === 'tap'
                ? motor.impact({ style: 'LIGHT' })
                : motor.notification({
                      type: kind === 'success' ? 'SUCCESS' : 'WARNING',
                  })
        ).catch(() => undefined);

        return;
    }

    if (
        typeof navigator !== 'undefined' &&
        typeof navigator.vibrate === 'function'
    ) {
        navigator.vibrate(
            kind === 'tap'
                ? 10
                : kind === 'success'
                  ? [12, 40, 24]
                  : [30, 60, 30],
        );
    }
}

/** Whether this browser can read QR codes off the camera by itself. */
export function qrScanSupported(): boolean {
    return (
        typeof window !== 'undefined' &&
        'BarcodeDetector' in window &&
        typeof navigator !== 'undefined' &&
        typeof navigator.mediaDevices?.getUserMedia === 'function'
    );
}

/**
 * The path on this site a link that opened the app points to:
 * `cyberia://wallet?section=chat` → `/wallet?section=chat`,
 * `https://cyberia.church/feed` → `/feed`. Anything else is not ours to open.
 */
export function deepLinkPath(link: string, siteHost: string): string | null {
    let url: URL;

    try {
        url = new URL(link);
    } catch {
        return null;
    }

    if (url.protocol === 'cyberia:') {
        // A custom scheme puts the first segment in the host: cyberia://wallet/… .
        const path =
            `/${url.host}${url.pathname === '/' ? '' : url.pathname}`.replace(
                /\/+/g,
                '/',
            );

        return `${path === '/' ? '/wallet' : path}${url.search}`;
    }

    if (
        url.protocol === 'https:' &&
        (url.host === siteHost || url.host === `www.${siteHost}`)
    ) {
        return `${url.pathname}${url.search}`;
    }

    return null;
}

/**
 * In the app, follow the links that open it — the one it was launched with and
 * every later one — to the screen they name. A browser has nothing to do here.
 */
export function initMobileShell(): void {
    if (nativeShell() !== 'mobile') {
        return;
    }

    const app = plugins()?.App;

    if (!app) {
        return;
    }

    const open = (link: string | undefined): void => {
        const path = link ? deepLinkPath(link, window.location.host) : null;

        if (
            path !== null &&
            path !== `${window.location.pathname}${window.location.search}`
        ) {
            window.location.assign(path);
        }
    };

    app.addListener('appUrlOpen', ({ url }) => open(url));
    void app
        .getLaunchUrl?.()
        .then((launch) => open(launch?.url))
        .catch(() => undefined);
}
