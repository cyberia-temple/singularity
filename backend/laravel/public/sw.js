/**
 * Cyberia PWA service worker.
 *
 * Authenticated HTML and API responses are deliberately never cached. Only
 * versioned build assets and public PWA shell files use Cache Storage.
 * Push payloads are JSON: { title, body, url } (see DaoActivityNotification).
 */

const CACHE_PREFIX = 'cyberia-pwa';
const STATIC_CACHE = `${CACHE_PREFIX}-static-v1`;
const OFFLINE_URL = '/offline.html';
const SHELL_FILES = [
    OFFLINE_URL,
    '/manifest.webmanifest',
    '/pwa/icon-192.png',
    '/pwa/icon-512.png',
    '/pwa/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches
            .open(STATIC_CACHE)
            .then((cache) => cache.addAll(SHELL_FILES))
            .then(() => self.skipWaiting()),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter(
                            (key) =>
                                key.startsWith(CACHE_PREFIX) &&
                                key !== STATIC_CACHE,
                        )
                        .map((key) => caches.delete(key)),
                ),
            )
            .then(() => self.clients.claim()),
    );
});

async function cacheFirst(request) {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);

    if (cached) {
        return cached;
    }

    const response = await fetch(request);

    if (response.ok) {
        await cache.put(request, response.clone());
    }

    return response;
}

self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') {
        return;
    }

    const url = new URL(request.url);

    if (url.origin !== self.location.origin) {
        return;
    }

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(() => caches.match(OFFLINE_URL)),
        );

        return;
    }

    if (
        url.pathname.startsWith('/build/') ||
        url.pathname.startsWith('/pwa/')
    ) {
        event.respondWith(cacheFirst(request));
    }
});

self.addEventListener('push', (event) => {
    if (!event.data) {
        return;
    }

    let payload;
    try {
        payload = event.data.json();
    } catch {
        payload = { title: 'Cyberia', body: event.data.text() };
    }

    const title = payload.title || 'Cyberia';
    const options = {
        body: payload.body || '',
        icon: payload.icon || '/apple-touch-icon.png',
        badge: '/favicon.ico',
        data: { url: (payload.data && payload.data.url) || payload.url || '/' },
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    let target = new URL('/', self.location.origin);
    try {
        const candidate = new URL(
            (event.notification.data && event.notification.data.url) || '/',
            self.location.origin,
        );
        if (candidate.origin === self.location.origin) {
            target = candidate;
        }
    } catch {
        // An invalid notification target opens the site home.
    }

    event.waitUntil(
        self.clients
            .matchAll({ type: 'window', includeUncontrolled: true })
            .then(async (clients) => {
                for (const client of clients) {
                    const current = new URL(client.url);

                    if (
                        current.origin === target.origin &&
                        current.pathname === target.pathname &&
                        'focus' in client
                    ) {
                        if (current.href === target.href) {
                            return client.focus();
                        }
                        if ('navigate' in client) {
                            const navigated = await client.navigate(target.href);
                            if (navigated) {
                                return navigated.focus();
                            }
                        }
                    }
                }

                return self.clients.openWindow(target.href);
            }),
    );
});
