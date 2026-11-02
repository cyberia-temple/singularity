/**
 * Detects the native shells that wrap this site.
 *
 * `frontend/desktop` (Electron) exposes `window.cyberiaNative` and appends
 * `CyberiaDesktop/<version>` to the user agent; `frontend/mobile` (Capacitor)
 * appends `CyberiaMobile/<version>`. Telegram opens the same pages in its own
 * web view as a Mini App, which is a shell in every way that matters here: it
 * owns the frame, so the site header and footer would be a second chrome
 * inside someone's chat. Everything else — browsers and the installed PWA — is
 * not a native shell.
 */
import { isTelegramMiniApp } from '@/lib/telegram';
import type { TorrentBridge } from '@/lib/wallet/torrent';

export type NativeShell = 'desktop' | 'mobile' | 'telegram' | null;

export interface NativeStartupState {
    available: boolean;
    enabled: boolean;
    error?: string;
}

interface DesktopStartupBridge extends NativeStartupState {
    get?: () => Promise<NativeStartupState>;
    set?: (enabled: boolean) => Promise<NativeStartupState>;
}

interface DesktopBridge {
    shell?: string;
    version?: string;
    /** The proxy in force for this window, as the shell describes it. */
    proxy?: string;
    tray?: boolean;
    openExternal?: (url: string) => void;
    openProxySettings?: () => void;
    /** Login startup is owned by the installed desktop shell, never the site. */
    startup?: DesktopStartupBridge;
    /**
     * A real BitTorrent client, which only the desktop shell can host — the
     * DHT is UDP and peers are TCP, neither of which a web view has.
     */
    torrent?: TorrentBridge;
}

declare global {
    interface Window {
        cyberiaNative?: DesktopBridge;
        Capacitor?: unknown;
    }
}

let detected: NativeShell = null;

function detect(): NativeShell {
    if (typeof window === 'undefined') {
        return null;
    }

    const userAgent = window.navigator.userAgent;

    if (
        window.cyberiaNative?.shell === 'desktop' ||
        /\bCyberiaDesktop\//.test(userAgent)
    ) {
        return 'desktop';
    }

    if (window.Capacitor !== undefined || /\bCyberiaMobile\//.test(userAgent)) {
        return 'mobile';
    }

    // Read off the launch parameters in the URL rather than off the SDK: the
    // layout is chosen before any script has loaded, and a wallet that flashes
    // a site header inside a chat looks like the wrong page opened.
    return isTelegramMiniApp() ? 'telegram' : null;
}

/**
 * Resolves the shell once and mirrors it onto `<html data-native-shell>` so CSS
 * can react to it too.
 */
export function initializeNativeShell(): NativeShell {
    detected = detect();

    if (detected && typeof document !== 'undefined') {
        document.documentElement.dataset.nativeShell = detected;
    }

    return detected;
}

export function nativeShell(): NativeShell {
    return detected;
}

export function isNativeShell(): boolean {
    return detected !== null;
}

/**
 * Whether the shell has network settings of its own to open.
 *
 * Only the desktop app does: a browser tab cannot choose a proxy, and on a
 * phone that choice belongs to the system. Feature-detected rather than
 * inferred from the shell name, because an older desktop build has no such
 * window and would give the user a button that does nothing.
 */
export function canOpenProxySettings(): boolean {
    return (
        typeof window !== 'undefined' &&
        typeof window.cyberiaNative?.openProxySettings === 'function'
    );
}

/** Raises the shell's proxy window. No-op anywhere else. */
export function openProxySettings(): void {
    window.cyberiaNative?.openProxySettings?.();
}

/**
 * What the shell says is carrying this window's requests: `direct`, `system`,
 * or the proxy rules in force (`socks5://host:port`). Null everywhere else,
 * which is the honest answer — a browser tab is not told.
 *
 * Read at page load and never after: the shell only reapplies a proxy by
 * restarting its sessions, so a value that changed since would mean the page
 * had been reloaded anyway.
 */
export function nativeProxy(): string | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const described = window.cyberiaNative?.proxy;

    return typeof described === 'string' && described !== '' ? described : null;
}

/** Whether this packaged desktop build can register itself at login. */
export function nativeStartup(): NativeStartupState {
    if (typeof window === 'undefined') {
        return { available: false, enabled: false };
    }

    const startup = window.cyberiaNative?.startup;

    return {
        available: startup?.available === true,
        enabled: startup?.enabled === true,
    };
}

/** True only for a desktop build that keeps a real operating-system tray. */
export function hasNativeTray(): boolean {
    return typeof window !== 'undefined' && window.cyberiaNative?.tray === true;
}

/** Re-read login startup after it may have changed from the tray menu. */
export async function refreshNativeStartup(): Promise<NativeStartupState> {
    const startup = window.cyberiaNative?.startup;

    return typeof startup?.get === 'function' ? startup.get() : nativeStartup();
}

/** Ask the desktop shell to change its own login item. */
export async function setNativeStartup(
    enabled: boolean,
): Promise<NativeStartupState> {
    const startup = window.cyberiaNative?.startup;

    if (typeof startup?.set !== 'function') {
        return { available: false, enabled: false, error: 'unavailable' };
    }

    return startup.set(enabled);
}

type CapacitorListener = { remove: () => Promise<void> | void };

type CapacitorAppPlugin = {
    addListener: (
        event: 'backButton',
        handler: () => void,
    ) => Promise<CapacitorListener> | CapacitorListener;
    minimizeApp?: () => Promise<void>;
    exitApp?: () => Promise<void>;
};

function capacitorApp(): CapacitorAppPlugin | null {
    if (typeof window === 'undefined') {
        return null;
    }

    const plugins = (
        window.Capacitor as { Plugins?: Record<string, unknown> } | undefined
    )?.Plugins;
    const app = plugins?.App as CapacitorAppPlugin | undefined;

    return app && typeof app.addListener === 'function' ? app : null;
}

/**
 * The phone's own back button (or back gesture) in the mobile shell.
 *
 * Capacitor's App plugin, with nobody listening, only steps the web view's
 * history — and the wallet moves between screens with `replaceState`, so there
 * was no history to step and the button did nothing at all, not even put the
 * app away. `handler` answers whether it moved somewhere; when it did not, the
 * app is minimised, which is what Android's back does on a top-level screen.
 */
export function onHardwareBack(handler: () => boolean): () => void {
    const app = capacitorApp();

    if (app === null) {
        return () => {};
    }

    let listener: CapacitorListener | null = null;
    let released = false;

    void Promise.resolve(
        app.addListener('backButton', () => {
            if (handler()) {
                return;
            }

            void (app.minimizeApp ?? app.exitApp)?.call(app);
        }),
    ).then((handle) => {
        listener = handle;

        if (released) {
            void handle.remove();
        }
    });

    return () => {
        released = true;
        void listener?.remove();
    };
}
