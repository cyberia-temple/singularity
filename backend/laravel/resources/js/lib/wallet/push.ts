/**
 * Notifications for a wallet that has no account.
 *
 * The site's bell hangs off a signed-in user and lives in a header this app
 * never renders, so until now a person who installed the wallet had no button
 * anywhere to allow notifications. The subscription is stored against the
 * installation id the analytics client already holds — not the EVM address,
 * because an address needs a signature before anybody has a reason to give one
 * and one person holds several.
 *
 * Everything here fails quietly and reports why. A wallet whose send screen
 * broke because a notification endpoint was down would be a worse product than
 * one that never offered notifications.
 */
import { installationId } from '@/lib/analytics';
import { nativePush } from '@/lib/mobileShell';

export type PushState = 'unsupported' | 'unavailable' | 'denied' | 'off' | 'on';

const SW = '/sw.js';

/** VAPID keys arrive as base64url; PushManager wants raw bytes. */
function decodeKey(key: string): Uint8Array {
    const padded = (key + '='.repeat((4 - (key.length % 4)) % 4))
        .replace(/-/g, '+')
        .replace(/_/g, '/');
    const raw = atob(padded);
    const bytes = new Uint8Array(raw.length);

    for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i);
    }

    return bytes;
}

function sameKey(subscription: PushSubscription, key: string): boolean {
    const applied = subscription.options?.applicationServerKey;

    if (!applied) {
        return true;
    }

    const current = decodeKey(key);
    const existing = new Uint8Array(applied);

    return (
        existing.length === current.length &&
        existing.every((byte, i) => byte === current[i])
    );
}

export function pushSupported(vapidKey: string | null): boolean {
    // The Android/iOS app: a WebView holds no Web Push subscription, so the
    // same button registers with Firebase instead (lib/mobileShell.ts).
    if (nativePush() !== null) {
        return true;
    }

    return (
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        typeof window !== 'undefined' &&
        'PushManager' in window &&
        'Notification' in window &&
        !!vapidKey
    );
}

/** What the button should say, without asking the user for anything. */
export async function pushState(vapidKey: string | null): Promise<PushState> {
    if (!pushSupported(vapidKey)) {
        return 'unsupported';
    }

    // No installation id means the analytics client never started — under Do
    // Not Track, or in a browser that cleared its storage. There is nothing to
    // attach a subscription to, and minting an identity here would go behind
    // the back of somebody who declined one.
    if (installationId() === null) {
        return 'unavailable';
    }

    const native = nativePush();

    if (native !== null) {
        return native.state();
    }

    if (Notification.permission === 'denied') {
        return 'denied';
    }

    try {
        const registration = await navigator.serviceWorker.getRegistration(SW);
        const subscription = await registration?.pushManager.getSubscription();

        return subscription && sameKey(subscription, vapidKey!) ? 'on' : 'off';
    } catch {
        return 'off';
    }
}

export async function enablePush(
    vapidKey: string,
    locale: string,
): Promise<PushState> {
    const install = installationId();

    if (install === null) {
        return 'unavailable';
    }

    const native = nativePush();

    if (native !== null) {
        return native.enable(install, locale);
    }

    if ((await Notification.requestPermission()) !== 'granted') {
        return Notification.permission === 'denied' ? 'denied' : 'off';
    }

    const registration = await navigator.serviceWorker.register(SW);
    await navigator.serviceWorker.ready;

    // A subscription made with a previous VAPID key cannot be replaced in
    // place — subscribe() rejects while a different key is held — so rotating
    // the server's keys must not cost somebody their notifications forever.
    const existing = await registration.pushManager.getSubscription();

    if (existing && !sameKey(existing, vapidKey)) {
        await existing.unsubscribe();
    }

    const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(vapidKey) as BufferSource,
    });

    const response = await fetch('/api/analytics/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Credential-less like every other analytics call: this endpoint never
        // learns which account the browser is signed into.
        credentials: 'omit',
        body: JSON.stringify({
            ...subscription.toJSON(),
            user_id: install,
            locale,
        }),
    });

    if (!response.ok) {
        await subscription.unsubscribe();

        return 'off';
    }

    return 'on';
}

export async function disablePush(): Promise<PushState> {
    const install = installationId();
    const native = nativePush();

    if (native !== null) {
        return native.disable();
    }

    try {
        const registration = await navigator.serviceWorker.getRegistration(SW);
        const subscription = await registration?.pushManager.getSubscription();

        if (subscription) {
            const endpoint = subscription.endpoint;
            await subscription.unsubscribe();

            if (install !== null) {
                await fetch('/api/analytics/push', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'omit',
                    body: JSON.stringify({ user_id: install, endpoint }),
                });
            }
        }
    } catch {
        // Already gone, or a browser that will not say. Either way the button
        // should now read "off".
    }

    return 'off';
}
