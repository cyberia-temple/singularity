/**
 * Product analytics for the wallet.
 *
 * One call — `analytics.track(event, properties)` — and everything a row needs
 * beyond that is filled in here: the anonymous installation id, the session,
 * the platform, the app version, the client's own clock. A call site that had
 * to remember to pass those would eventually forget, and the events that
 * matter most are the ones written in the middle of a signing flow where
 * nobody is thinking about analytics.
 *
 * Four properties hold this together, in order of importance:
 *
 *   It cannot break the wallet. Every entry point swallows its own errors,
 *   nothing awaits the network, and a dead endpoint costs a queued event and
 *   nothing else. Sending money must never depend on a metrics server.
 *
 *   It cannot carry a secret. Properties go through the same allowlist the
 *   server enforces, and the two shapes a wallet secret takes — a long run of
 *   hex, a run of words — are refused inside it. There is no field for a seed
 *   phrase, a key, a password or a signed payload to occupy.
 *
 *   It is not a fingerprint. The identity is a UUID this device minted and
 *   keeps; nothing reads a canvas, a font list, a screen size or a hardware
 *   id, and the request omits credentials so the endpoint cannot see which
 *   account the browser is signed into. A browser that says "do not track" is
 *   not tracked.
 *
 *   Its retries are free. Every event carries an id, the server's index is
 *   unique on it, so a replayed outbox is dropped rather than double-counted.
 */
import {
    firstTouch,
    parseAttribution,
    sessionExpired,
} from '@/lib/analytics/attribution';
import type { Attribution } from '@/lib/analytics/attribution';
import { sanitizeProperties } from '@/lib/analytics/taxonomy';
import type {
    AnalyticsEventName,
    AnalyticsProperties,
} from '@/lib/analytics/taxonomy';
import { isNativeShell, nativeShell } from '@/lib/native';
import { replayEvent } from '@/lib/sessionReplay';
import { telegramStartParam } from '@/lib/telegram';
import { statsEvent } from '@/lib/webStats';

export type { AnalyticsEventName, AnalyticsProperties };
export { errorCode } from '@/lib/analytics/errors';

const UID_KEY = 'cyberia.analytics.uid';
const SESSION_KEY = 'cyberia.analytics.session';
/*
 * When this browser last reported an open.
 *
 * `app_opened` is guarded within a page load by a module flag, which says
 * nothing about the next page load — and a full reload three seconds after the
 * first one is not a person opening the app twice. Seen in the data: two opens
 * four seconds apart in the same session, on installations that did nothing
 * else, which is the exact shape that inflates "opens per session" and every
 * engagement number derived from it.
 */
const OPENED_KEY = 'cyberia.analytics.opened';
const REOPEN_GRACE_MS = 30_000;
const ATTRIBUTION_KEY = 'cyberia.analytics.attribution';
const OUTBOX_KEY = 'cyberia.analytics.outbox';
const OPTOUT_KEY = 'cyberia.analytics.optout';
const FUNDED_KEY = 'cyberia.analytics.funded';

const EVENTS_URL = '/api/analytics/events';
const FUNDING_URL = '/api/analytics/funding';

/** Matches `config('analytics.max_batch')`; a larger batch is refused there. */
const MAX_BATCH = 20;

/**
 * How much backlog a device keeps. Bounded because the outbox lives in the
 * same storage as the vault: an analytics queue that grew without limit could
 * fill the quota that the encrypted seed phrase needs.
 */
const MAX_OUTBOX = 100;

const FLUSH_DELAY_MS = 2_000;

/**
 * The chains an address may be reported for — the mirror of
 * `config/analytics.php`'s `verifiable_chains`.
 *
 * Anywhere else the wallet reports only that it was funded and on which
 * network. Sending an address the server cannot read would buy nothing and
 * cost the user a link between their installation and their on-chain
 * identity, which is the whole thing this design is careful about.
 */
const ADDRESS_CHAINS = ['cyberia', 'robinhood', 'solana'];

export type AnalyticsConfig = {
    enabled: boolean;
    respectDnt: boolean;
    sessionTimeoutMinutes: number;
    appVersion: string | null;
};

let config: AnalyticsConfig = {
    enabled: true,
    respectDnt: true,
    sessionTimeoutMinutes: 30,
    appVersion: null,
};

type QueuedEvent = {
    event_id: string;
    event: AnalyticsEventName;
    properties?: Record<string, string | number | boolean>;
    client_time: string;
};

let queue: QueuedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sessionOpened: string | null = null;
let previousSession: string | null = null;
let started = false;

/* ------------------------------------------------------------- storage -- */

const read = (key: string): string | null => {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
};

const write = (key: string, value: string): void => {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        /* A full or blocked store costs an event, never an operation. */
    }
};

const readJson = <T>(key: string): T | null => {
    const raw = read(key);

    if (raw === null) {
        return null;
    }

    try {
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
};

const uuid = (): string => {
    try {
        return window.crypto.randomUUID();
    } catch {
        // Old WebViews (the Android shell has met one) have crypto but no
        // randomUUID. A v4 built from getRandomValues is the same value.
        const bytes = new Uint8Array(16);
        window.crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;

        const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0'));

        return [
            hex.slice(0, 4).join(''),
            hex.slice(4, 6).join(''),
            hex.slice(6, 8).join(''),
            hex.slice(8, 10).join(''),
            hex.slice(10, 16).join(''),
        ].join('-');
    }
};

/* ------------------------------------------------------------- consent -- */

/**
 * A browser-level refusal, honoured rather than argued with.
 *
 * This is a non-custodial wallet whose onboarding screen promises that keys
 * never leave the device. Ignoring the one signal a user has for saying "do
 * not build a profile of me" would make that promise smaller than it reads.
 */
const doNotTrack = (): boolean => {
    if (typeof navigator === 'undefined') {
        return false;
    }

    const nav = navigator as Navigator & {
        msDoNotTrack?: string;
        globalPrivacyControl?: boolean;
    };
    const win = window as Window & { doNotTrack?: string };

    return (
        nav.doNotTrack === '1' ||
        nav.doNotTrack === 'yes' ||
        nav.msDoNotTrack === '1' ||
        win.doNotTrack === '1' ||
        nav.globalPrivacyControl === true
    );
};

const optedOut = (): boolean => read(OPTOUT_KEY) === '1';

const collecting = (): boolean =>
    typeof window !== 'undefined' &&
    config.enabled &&
    !optedOut() &&
    !(config.respectDnt && doNotTrack());

/* ------------------------------------------------------------ identity -- */

/**
 * The anonymous installation id.
 *
 * Not an address, and deliberately so: one person holds an EVM account, a
 * Solana account and any number of imported keys, and counting addresses would
 * multiply every user on the dashboard by however many networks they touched.
 */
const identity = (): { id: string; fresh: boolean } | null => {
    const existing = read(UID_KEY);

    if (existing !== null) {
        return { id: existing, fresh: false };
    }

    if (!collecting()) {
        return null;
    }

    const id = uuid();
    write(UID_KEY, id);

    return { id, fresh: true };
};

/**
 * The installation's id, if it already has one.
 *
 * Deliberately never mints: push notifications must not be the thing that
 * creates an analytics identity for somebody who declined tracking. No id
 * means no subscription, and the wallet says so rather than quietly making
 * one.
 */
export const installationId = (): string | null => read(UID_KEY);

type StoredSession = { id: string; last: number };

const session = (): string | null => {
    const now = Date.now();
    const stored = readJson<StoredSession>(SESSION_KEY);
    const timeout = Math.max(1, config.sessionTimeoutMinutes) * 60_000;

    if (!sessionExpired(now, stored?.last ?? null, timeout)) {
        write(SESSION_KEY, JSON.stringify({ id: stored!.id, last: now }));

        return stored!.id;
    }

    const id = uuid();
    // Remembered so the server can close the session this one replaced,
    // instead of leaving every abandoned visit open forever.
    previousSession = stored?.id ?? null;
    write(SESSION_KEY, JSON.stringify({ id, last: now }));

    if (sessionOpened !== id) {
        sessionOpened = id;
        enqueue('session_started', {});
    }

    return id;
};

const attribution = (): Attribution => {
    const stored = readJson<Attribution>(ATTRIBUTION_KEY);

    const resolved = firstTouch(
        stored,
        parseAttribution(
            window.location.href,
            document.referrer ?? '',
            telegramStartParam(),
        ),
    );

    if (stored === null) {
        write(ATTRIBUTION_KEY, JSON.stringify(resolved));
    }

    return resolved;
};

/**
 * Remember where this visit came from, without becoming a visit.
 *
 * The product client no longer starts on every page of the site — an
 * installation of a wallet and a browser reading the blog are different
 * subjects, and merging them put `/farm` and `/login` in the denominator of a
 * wallet funnel. But first-touch attribution has to be captured on the page
 * the campaign link actually lands on, which is almost never the wallet.
 *
 * So this is the one thing that runs everywhere: a single localStorage write,
 * the first time this browser is seen, of where it came from. It creates no
 * user, sends no request and enqueues no event. By the time somebody opens the
 * wallet, the answer to "which campaign brought them" is already sitting here
 * — captured weeks earlier, on the landing page, by four lines that never
 * spoke to the server.
 */
export const rememberAttribution = (): void => {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        if (readJson<Attribution>(ATTRIBUTION_KEY) === null) {
            attribution();
        }
    } catch {
        /* Storage denied. Attribution is the first thing to lose, not a
           reason for a page to fail. */
    }
};

/**
 * Which surface this is running on.
 *
 * The shells are the interesting distinction — a desktop build that ships its
 * own frame, a phone app, a Mini App inside a chat, an installed PWA and an
 * ordinary tab behave differently enough that a funnel which merged them would
 * hide the one that is broken.
 */
const platform = (): string => {
    const shell = nativeShell();

    if (shell !== null) {
        return shell;
    }

    try {
        if (window.matchMedia('(display-mode: standalone)').matches) {
            return 'pwa';
        }
    } catch {
        /* matchMedia is absent in some embedded views. */
    }

    return 'web';
};

/**
 * The version to report.
 *
 * For a browser that is the site's release, because the site is the app. For
 * the desktop and mobile shells it is the shell's own version instead: they
 * render the live site, so their site version is always today's and tells you
 * nothing, while the shell someone installed in March is exactly the thing a
 * version filter is trying to find.
 */
const appVersion = (): string | null => {
    if (isNativeShell()) {
        const bridge = (
            window as Window & { cyberiaNative?: { version?: string } }
        ).cyberiaNative;

        const declared = bridge?.version;

        if (typeof declared === 'string' && declared !== '') {
            return declared.slice(0, 32);
        }

        const match = navigator.userAgent.match(
            /\bCyberia(?:Desktop|Mobile)\/([\w.-]+)/,
        );

        if (match) {
            return match[1].slice(0, 32);
        }
    }

    return config.appVersion;
};

const language = (): string | null =>
    typeof navigator === 'undefined' ? null : navigator.language?.slice(0, 12);

/* --------------------------------------------------------------- queue -- */

const persist = (): void => {
    write(OUTBOX_KEY, JSON.stringify(queue.slice(-MAX_OUTBOX)));
};

const enqueue = (
    event: AnalyticsEventName,
    properties: AnalyticsProperties,
): void => {
    const clean = sanitizeProperties(properties);

    queue.push({
        event_id: uuid(),
        event,
        properties: Object.keys(clean).length > 0 ? clean : undefined,
        client_time: new Date().toISOString(),
    });

    if (queue.length > MAX_OUTBOX) {
        queue = queue.slice(-MAX_OUTBOX);
    }

    persist();

    if (queue.length >= MAX_BATCH) {
        void flush();

        return;
    }

    if (timer === null) {
        timer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
    }
};

const envelope = (batch: QueuedEvent[], id: string) => ({
    user: {
        id,
        platform: platform(),
        app_version: appVersion(),
        language: language(),
        attribution: attribution(),
    },
    session: sessionOpened
        ? { id: sessionOpened, previous_id: previousSession }
        : undefined,
    events: batch,
});

/**
 * Send what is queued.
 *
 * `beacon` is used when the page is going away, where a fetch would be
 * cancelled mid-flight; it cannot report success, so the batch is dropped
 * optimistically — the event ids make a duplicate harmless, and the
 * alternative is a queue that grows every time somebody closes a tab.
 */
export const flush = async (beacon = false): Promise<void> => {
    if (timer !== null) {
        clearTimeout(timer);
        timer = null;
    }

    if (queue.length === 0 || !collecting()) {
        return;
    }

    const who = identity();

    if (who === null) {
        return;
    }

    const batch = queue.slice(0, MAX_BATCH);
    const body = JSON.stringify(envelope(batch, who.id));

    if (beacon) {
        try {
            navigator.sendBeacon?.(
                EVENTS_URL,
                new Blob([body], { type: 'application/json' }),
            );
        } catch {
            /* Nothing to retry into: the page is closing. */
        }

        queue = queue.slice(batch.length);
        persist();

        return;
    }

    try {
        const response = await fetch(EVENTS_URL, {
            method: 'POST',
            // No cookies: this endpoint must not be able to see which account
            // the browser is signed into.
            credentials: 'omit',
            keepalive: true,
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body,
        });

        if (!response.ok) {
            throw new Error(String(response.status));
        }

        queue = queue.slice(batch.length);
        persist();

        if (queue.length > 0 && timer === null) {
            timer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
        }
    } catch {
        // Left in the outbox for the next flush. Safe to resend: the server
        // drops an event id it has already seen.
        if (timer === null) {
            timer = setTimeout(() => void flush(), FLUSH_DELAY_MS * 4);
        }
    }
};

/* ---------------------------------------------------------------- API --- */

export const analytics = {
    /**
     * Record something that happened.
     *
     * Never throws, never awaits, never returns a value a caller could be
     * tempted to branch on. Anything that happens inside a signing flow has to
     * be exactly this cheap or it does not belong there.
     */
    track(
        event: AnalyticsEventName,
        properties: AnalyticsProperties = {},
    ): void {
        try {
            if (!collecting()) {
                return;
            }

            const who = identity();

            if (who === null) {
                return;
            }

            // A brand-new installation opens with `first_open`, which is what
            // the acquisition funnel counts from. Emitted here rather than at
            // startup so it exists even for a wallet whose first act was a
            // deep link straight into a screen.
            if (who.fresh) {
                queue.push({
                    event_id: uuid(),
                    event: 'first_open',
                    client_time: new Date().toISOString(),
                });
            }

            session();
            enqueue(event, properties);
            // The name alone, so a recording can be found by what happened
            // in it; the properties stay in our own tables.
            replayEvent(event);
            // And the dashboard's funnels, with what the allowlist kept.
            statsEvent(event, sanitizeProperties(properties));
        } catch {
            /* Analytics is never the reason something failed. */
        }
    },

    /**
     * Tell the server this wallet appears to hold something.
     *
     * A candidate, not a fact: the server confirms it against the chain where
     * it can, and stamps the milestone once either way. The address is sent
     * only for the chains that server can actually read — everywhere else this
     * says "funded on litecoin" and nothing more.
     *
     * Called at most once per chain per installation; the local mark is a
     * courtesy to the endpoint, and the real guard is that `funded_at` is
     * write-once on the server.
     */
    reportFunding(chain: string, address?: string | null): void {
        try {
            if (!collecting()) {
                return;
            }

            const marks = readJson<string[]>(FUNDED_KEY) ?? [];

            if (marks.includes(chain) || marks.includes('*')) {
                return;
            }

            const who = identity();

            if (who === null) {
                return;
            }

            write(FUNDED_KEY, JSON.stringify([...marks, chain]));

            void fetch(FUNDING_URL, {
                method: 'POST',
                credentials: 'omit',
                keepalive: true,
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: JSON.stringify({
                    user_id: who.id,
                    chain,
                    address:
                        address && ADDRESS_CHAINS.includes(chain)
                            ? address
                            : undefined,
                }),
            })
                .then(async (response) => {
                    const body = (await response.json().catch(() => ({}))) as {
                        funded?: boolean;
                    };

                    // Confirmed: stop asking about every other network too.
                    if (body.funded) {
                        write(FUNDED_KEY, JSON.stringify(['*']));

                        return;
                    }

                    // Not confirmed — the chain said no, or could not be read.
                    // Forget the mark so a later balance gets another chance.
                    write(
                        FUNDED_KEY,
                        JSON.stringify(marks.filter((mark) => mark !== chain)),
                    );
                })
                .catch(() => {
                    write(FUNDED_KEY, JSON.stringify(marks));
                });
        } catch {
            /* As above: never the reason something failed. */
        }
    },

    /** Whether anything is being collected on this device right now. */
    enabled(): boolean {
        return collecting();
    },

    /** Whether the refusal came from the browser rather than from a setting. */
    blockedByBrowser(): boolean {
        return config.respectDnt && doNotTrack();
    },

    /**
     * Turn collection off, or back on.
     *
     * Turning it off drops what is queued and forgets the installation id, so
     * the next opt-in is a new anonymous user rather than a resumed profile.
     */
    setEnabled(on: boolean): void {
        try {
            if (on) {
                window.localStorage.removeItem(OPTOUT_KEY);

                return;
            }

            queue = [];
            write(OPTOUT_KEY, '1');

            for (const key of [
                UID_KEY,
                SESSION_KEY,
                OUTBOX_KEY,
                FUNDED_KEY,
                OPENED_KEY,
            ]) {
                window.localStorage.removeItem(key);
            }

            sessionOpened = null;
            previousSession = null;
        } catch {
            /* Nothing to do about a storage that refuses to be written. */
        }
    },

    flush,
};

/**
 * Bring the client up, once per page load.
 *
 * Configuration arrives from Inertia's shared props rather than a build-time
 * constant, so switching analytics off on the server switches it off in every
 * open tab at the next navigation instead of at the next deploy.
 */
export const configureAnalytics = (next: Partial<AnalyticsConfig>): void => {
    config = { ...config, ...next };
};

/**
 * Whether this browser already said it opened, moments ago.
 *
 * A reload, a redirect into the wallet and a shell restoring its window all
 * produce a second page load that no person would call a second open. Thirty
 * seconds is short enough that genuinely reopening the app after reading
 * something else still counts, and long enough to absorb every automatic
 * reload observed here.
 */
const recentlyOpened = (): boolean => {
    const now = Date.now();

    try {
        const previous = Number(window.localStorage.getItem(OPENED_KEY) ?? 0);

        window.localStorage.setItem(OPENED_KEY, String(now));

        return Number.isFinite(previous) && now - previous < REOPEN_GRACE_MS;
    } catch {
        // No storage means no way to tell, and an event is better than a hole.
        return false;
    }
};

export const initializeAnalytics = (): void => {
    if (started || typeof window === 'undefined') {
        return;
    }

    started = true;

    // Anything a previous load could not deliver. Safe to resend: the server
    // recognises the ids.
    const stored = readJson<QueuedEvent[]>(OUTBOX_KEY);

    if (Array.isArray(stored) && stored.length > 0) {
        queue = [...stored, ...queue].slice(-MAX_OUTBOX);
    }

    if (!recentlyOpened()) {
        analytics.track('app_opened');
    }

    // Two listeners, because they catch different departures: a tab switched
    // away on a phone (which may never fire `pagehide`) and a page actually
    // going away.
    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            void flush(true);
        }
    });

    window.addEventListener('pagehide', () => void flush(true));
};
