/**
 * The session recorder: rrweb in the page, this project's own server at the
 * other end, and nobody in between.
 *
 * Built on its own (`vite.replay.config.ts`) into one classic script at
 * `/replay/recorder.js`, because lain-os.com and chaos.fm load it from
 * cyberia.church and a module script across origins would need CORS headers
 * on every chunk it imports. Everything it needs to know arrives as data
 * attributes on its own <script> tag, written by whichever server decided this
 * visit may be recorded (`App\Support\SessionReplay`).
 *
 * What it never sends: anything typed (every input is masked), the text under
 * `[data-replay-mask]`, whatever sits under `[data-replay-block]`, the query
 * string, and — anywhere at all, attributes and URLs included — a string
 * shaped like an address, a transaction hash or a key.
 */
import { record } from 'rrweb';

type Click = {
    t: number;
    p: string;
    x: number;
    y: number;
    f: 0 | 1;
    w: number;
    l: string;
    r: 0 | 1;
    d: 0 | 1;
};

type Fault = { t: number; p: string; m: string };

type Snapshot = { t: number; p: string };

type Session = { id: string; seq: number; at: number };

type RecordedEvent = {
    type: number;
    timestamp: number;
    data: Record<string, unknown>;
};

// rrweb's numbering, spelled out so this file needs nothing but `record`.
const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;
const MUTATION = 0;

const MASK = '[data-replay-mask]';
const BLOCK = '[data-replay-block]';
const SESSION = 'cyberia.replay.session';
const IDLE_MS = 30 * 60_000;
const FLUSH_MS = 10_000;
// A keepalive request and a beacon are both refused above 64 KB in flight.
const KEEPALIVE_BYTES = 60_000;
const MAX_FAULTS = 20;

const script = document.currentScript as HTMLScriptElement | null;
const options = script?.dataset ?? {};
const endpoint = options.endpoint ?? '';
const optoutKey = options.optout || 'cyberia.analytics.optout';
const noticeKey = options.notice || 'cyberia.replay.notice';
const pausedPrefixes = (options.paused ?? '')
    .split(',')
    .map((prefix) => prefix.trim())
    .filter(Boolean);

const read = (store: () => Storage, key: string): string | null => {
    try {
        return store().getItem(key);
    } catch {
        return null;
    }
};

const write = (store: () => Storage, key: string, value: string): void => {
    try {
        store().setItem(key, value);
    } catch {
        // Storage refused: the recording simply does not remember.
    }
};

const local = (): Storage => window.localStorage;
const tab = (): Storage => window.sessionStorage;

/**
 * Addresses, hashes and keys, wherever they appear. A masked text node is
 * already asterisks; this is for what masking does not reach — attributes,
 * links to an explorer, a URL path, an error message.
 */
const SECRETS = [
    /0x[0-9a-fA-F]{40,}/g,
    /\b(?:bc|tb|ltc)1[02-9ac-hj-np-z]{20,}\b/g,
    /\b[1-9A-HJ-NP-Za-km-z]{32,}\b/g,
];

const scrub = (value: string): string =>
    SECRETS.reduce((text, pattern) => text.replace(pattern, '…'), value);

const scrubDeep = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
        // Stylesheets and inlined data are left alone: nothing secret is
        // there, and a font cut in half is a broken replay.
        return key === '_cssText' || value.startsWith('data:')
            ? value
            : scrub(value);
    }

    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            value[index] = scrubDeep(value[index]);
        }
    } else if (value && typeof value === 'object') {
        const object = value as Record<string, unknown>;

        for (const name of Object.keys(object)) {
            object[name] = scrubDeep(object[name], name);
        }
    }

    return value;
};

const here = (): string => scrub(window.location.pathname).slice(0, 255);

const paused = (): boolean =>
    pausedPrefixes.some((prefix) =>
        window.location.pathname.startsWith(prefix),
    );

const refusedBefore = (): boolean => {
    const navigatorFlags = window.navigator as Navigator & {
        globalPrivacyControl?: boolean;
    };

    return (
        read(local, optoutKey) === '1' ||
        navigatorFlags.doNotTrack === '1' ||
        navigatorFlags.globalPrivacyControl === true
    );
};

const uuid = (): string => {
    if (typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }

    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));

    return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
};

let stopRecording: (() => void) | null = null;
let events: RecordedEvent[] = [];
let clicks: Click[] = [];
let faults: Fault[] = [];
let snapshots: Snapshot[] = [];
let faultCount = 0;
let lastMutation = 0;
let closed = false;

/**
 * One session per tab, carried across full page loads through
 * sessionStorage, and a fresh one after half an hour of nothing — which must
 * start with a snapshot of its own, or it is a recording of changes to a page
 * nobody can see.
 */
const session = (): Session => {
    const now = Date.now();
    let current: Session | null = null;

    try {
        current = JSON.parse(read(tab, SESSION) ?? 'null') as Session | null;
    } catch {
        current = null;
    }

    if (
        current &&
        typeof current.id === 'string' &&
        now - current.at < IDLE_MS
    ) {
        return current;
    }

    const fresh = { id: uuid(), seq: 0, at: now };

    if (current && stopRecording) {
        events = [];
        snapshots = [];
        record.takeFullSnapshot(true);
    }

    return fresh;
};

const custom = (tag: string, payload: Record<string, unknown>): void => {
    try {
        record.addCustomEvent(tag, payload);
    } catch {
        // Not recording right now.
    }
};

const emit = (event: RecordedEvent): void => {
    if (event.type === META) {
        event.data.href = window.location.origin + here();
    }

    if (event.type === FULL_SNAPSHOT) {
        snapshots.push({ t: event.timestamp, p: here() });
        // The snapshot is the heaviest thing a session sends: send it on its
        // own, now, while an ordinary request can still carry it.
        window.setTimeout(() => void flush(), 0);
    }

    if (event.type === INCREMENTAL && event.data.source === MUTATION) {
        lastMutation = event.timestamp;
    }

    events.push(scrubDeep(event) as RecordedEvent);
};

const gzip = async (text: string): Promise<Blob | null> => {
    if (typeof CompressionStream === 'undefined') {
        return null;
    }

    try {
        const stream = new Blob([text])
            .stream()
            .pipeThrough(new CompressionStream('gzip'));

        return await new Response(stream).blob();
    } catch {
        return null;
    }
};

const halt = (): void => {
    stopRecording?.();
    stopRecording = null;
};

/**
 * Send what has been gathered. `leaving` is the page going away, when only a
 * beacon still gets out and there is no time to compress.
 */
async function flush(leaving = false): Promise<void> {
    if (
        closed ||
        (events.length === 0 && clicks.length === 0 && faults.length === 0)
    ) {
        return;
    }

    const current = session();
    current.seq += 1;
    current.at = Date.now();
    write(tab, SESSION, JSON.stringify(current));

    const installation = options.installation
        ? read(local, options.installation)
        : null;
    const body = JSON.stringify({
        v: 1,
        s: current.id,
        q: current.seq,
        p: here(),
        w: window.innerWidth,
        h: window.innerHeight,
        who: options.who || null,
        inst: installation,
        e: events,
        c: clicks,
        x: faults,
        snap: snapshots,
    });
    events = [];
    clicks = [];
    faults = [];
    snapshots = [];

    if (leaving) {
        if (body.length < KEEPALIVE_BYTES) {
            navigator.sendBeacon?.(
                endpoint,
                new Blob([body], { type: 'text/plain' }),
            );
        }

        return;
    }

    const packed = await gzip(body);
    const size = packed?.size ?? body.length;

    try {
        const response = await fetch(packed ? `${endpoint}?z=1` : endpoint, {
            method: 'POST',
            body: packed ?? body,
            headers: { 'Content-Type': 'text/plain' },
            credentials: 'omit',
            keepalive: size < KEEPALIVE_BYTES,
        });

        // Refused for good — switched off, a session over its size, a site
        // the server does not take: stop rather than keep knocking.
        if ([403, 404, 410, 413].includes(response.status)) {
            closed = true;
            halt();
        }
    } catch {
        // Offline or blocked: this piece of the recording is lost, which is
        // better than a page that retries forever.
    }
}

const start = (): void => {
    if (stopRecording || closed || paused()) {
        return;
    }

    stopRecording =
        record({
            emit: (event) => emit(event as unknown as RecordedEvent),
            maskAllInputs: true,
            maskTextSelector: MASK,
            blockSelector: BLOCK,
            slimDOMOptions: 'all',
            recordCanvas: false,
            collectFonts: false,
            inlineImages: false,
            sampling: {
                mousemove: true,
                mouseInteraction: true,
                scroll: 150,
                media: 800,
                input: 'last',
            },
            errorHandler: () => true,
        }) ?? null;
};

const isFixed = (element: Element): boolean => {
    let node: Element | null = element;

    for (let depth = 0; node && depth < 12; depth++) {
        const position = window.getComputedStyle(node).position;

        if (position === 'fixed' || position === 'sticky') {
            return true;
        }

        node = node.parentElement;
    }

    return false;
};

/**
 * What was clicked, as an operator would name it. Inside a masked region the
 * text is the secret, so only the tag and its first class are said.
 */
const describe = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : '';

    if (/^(input|textarea|select)$/.test(tag)) {
        const type = element.getAttribute('type');

        return `${tag}${type ? `[${type}]` : ''}${id}`.slice(0, 120);
    }

    if (element.closest(MASK) || element.closest(BLOCK)) {
        const first = element.classList[0];

        return `${tag}${id}${first ? `.${first}` : ''}`.slice(0, 120);
    }

    const text = (
        element.getAttribute('aria-label') ||
        (element as HTMLElement).innerText ||
        element.getAttribute('title') ||
        ''
    )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);

    return scrub(`${tag}${id}${text ? ` ${text}` : ''}`).slice(0, 120);
};

const CLICKABLE =
    'a,button,input,select,textarea,label,summary,[role="button"],[role="tab"],[role="link"],[role="menuitem"]';
let burst: { t: number; x: number; y: number }[] = [];

/**
 * Every click, for the heat map — and the two kinds that say something is
 * wrong: a rage click (three within a second on one spot) and a dead click
 * (something that looks clickable, and in a second nothing changed).
 */
const onClick = (event: MouseEvent): void => {
    const target = event.target;

    if (!stopRecording || !(target instanceof Element)) {
        return;
    }

    const at = Date.now();
    const element = target.closest(CLICKABLE) ?? target;
    const fixed = isFixed(element);
    const width = Math.max(document.documentElement.scrollWidth, 1);
    const click: Click = {
        t: at,
        p: here(),
        x: Math.round((event.pageX / width) * 10_000) / 10_000,
        y: Math.round(fixed ? event.clientY : event.pageY),
        f: fixed ? 1 : 0,
        w: window.innerWidth,
        l: describe(element),
        r: 0,
        d: 0,
    };

    burst = burst.filter(
        (previous) =>
            at - previous.t < 1000 &&
            Math.abs(previous.x - event.clientX) < 40 &&
            Math.abs(previous.y - event.clientY) < 40,
    );
    burst.push({ t: at, x: event.clientX, y: event.clientY });

    if (burst.length === 3) {
        click.r = 1;
        custom('rage', { l: click.l });
    }

    const looksClickable =
        element.matches(
            'a,button,[role="button"],[role="tab"],[role="link"],[role="menuitem"],summary',
        ) || window.getComputedStyle(element).cursor === 'pointer';
    const leavesThePage = element.matches(
        'input,select,textarea,label,a[target="_blank"],a[download]',
    );
    const href = window.location.href;
    const scrolled = window.scrollY;

    window.setTimeout(() => {
        if (
            looksClickable &&
            !leavesThePage &&
            !click.r &&
            lastMutation < at &&
            window.location.href === href &&
            Math.abs(window.scrollY - scrolled) < 4
        ) {
            click.d = 1;
            custom('dead', { l: click.l });
        }

        clicks.push(click);
    }, 1000);
};

const onFault = (message: string, source?: string, line?: number): void => {
    if (!stopRecording || faultCount >= MAX_FAULTS) {
        return;
    }

    faultCount += 1;
    const file = source ? source.split('/').pop()?.split('?')[0] : '';
    const text = scrub(message).slice(0, 200);
    faults.push({
        t: Date.now(),
        p: here(),
        m: file ? `${text} @ ${file}:${line ?? 0}` : text,
    });
    custom('error', { m: text });
};

let lastPath = window.location.pathname;
let snapshotTimer = 0;

/**
 * A navigation inside a single-page app. Each page gets its own snapshot a
 * moment after it renders, which is what the heat map is drawn on and what
 * lets the player jump straight to a page.
 */
const onNavigate = (): void => {
    const path = window.location.pathname;

    if (path === lastPath) {
        return;
    }

    lastPath = path;
    window.clearTimeout(snapshotTimer);

    if (paused()) {
        void flush();
        halt();

        return;
    }

    if (!stopRecording) {
        start();

        return;
    }

    snapshotTimer = window.setTimeout(() => {
        if (stopRecording) {
            void flush();
            record.takeFullSnapshot(true);
        }
    }, 700);
};

/**
 * The visitor said no — on the notice or in the wallet's settings. Stop,
 * throw away what has not left yet, and ask the server to forget what has.
 */
const refuse = (): void => {
    write(local, optoutKey, '1');
    write(local, noticeKey, '1');
    halt();
    closed = true;
    events = [];
    clicks = [];
    faults = [];
    snapshots = [];

    const current = read(tab, SESSION);

    if (current) {
        try {
            const { id } = JSON.parse(current) as Session;
            navigator.sendBeacon?.(
                endpoint,
                new Blob([JSON.stringify({ v: 1, s: id, forget: true })], {
                    type: 'text/plain',
                }),
            );
        } catch {
            // Nothing to forget.
        }
    }

    window.dispatchEvent(new CustomEvent('cyberia:replay-refused'));
};

const NOTICE_TEXT: Record<'en' | 'ru' | 'zh', [string, string, string]> = {
    en: [
        'We record how this site is used — clicks, scrolling and pointer movement — to find what is broken or confusing. Recordings stay on our own server and go to nobody else. What you type, keys, addresses and conversations are hidden.',
        'OK',
        'Don’t record',
    ],
    ru: [
        'Мы записываем, как используется сайт — клики, прокрутку и движения мыши, — чтобы находить, что сломано и неудобно. Записи хранятся только на нашем сервере и никому не передаются. Ввод, ключи, адреса и переписка скрыты.',
        'Понятно',
        'Не записывать',
    ],
    zh: [
        '我们会记录本网站的使用方式——点击、滚动和指针移动——以发现故障和难用之处。录制只保存在我们自己的服务器上，不会交给任何第三方。您输入的内容、密钥、地址和对话均被隐藏。',
        '好的',
        '不要录制',
    ],
};

const showNotice = (): void => {
    if (read(local, noticeKey) === '1') {
        return;
    }

    const language = (
        read(local, 'locale') ||
        document.documentElement.lang ||
        navigator.language ||
        'en'
    ).toLowerCase();
    const [text, ok, no] =
        NOTICE_TEXT[
            language.startsWith('ru')
                ? 'ru'
                : language.startsWith('zh')
                  ? 'zh'
                  : 'en'
        ];

    const box = document.createElement('div');
    box.id = 'cyberia-replay-notice';
    box.setAttribute('role', 'status');
    box.setAttribute('data-replay-block', '');
    box.style.cssText =
        'position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:2147483000;max-width:min(420px,calc(100vw - 24px));box-sizing:border-box;padding:12px 14px;border:1px solid #23233a;border-radius:10px;background:#03030b;color:#d9d9ec;font:13px/1.45 system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.5)';

    const body = document.createElement('p');
    body.style.cssText = 'margin:0 0 10px';
    body.textContent = text;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';

    const button = (
        label: string,
        primary: boolean,
        onPress: () => void,
    ): HTMLButtonElement => {
        const element = document.createElement('button');
        element.type = 'button';
        element.textContent = label;
        element.style.cssText =
            'cursor:pointer;border-radius:6px;padding:6px 12px;font:inherit;font-weight:600;' +
            (primary
                ? 'border:0;background:#c7c7ff;color:#03030b'
                : 'border:1px solid #33334d;background:transparent;color:#d9d9ec');
        element.addEventListener('click', onPress);

        return element;
    };

    const close = (): void => {
        write(local, noticeKey, '1');
        box.remove();
    };

    row.append(
        button(no, false, () => {
            close();
            refuse();
        }),
        button(ok, true, close),
    );
    box.append(body, row);
    document.body.append(box);
};

const boot = (): void => {
    if (!endpoint || refusedBefore()) {
        return;
    }

    for (const method of ['pushState', 'replaceState'] as const) {
        const original = history[method];
        history[method] = function (
            this: History,
            ...args: Parameters<History['pushState']>
        ) {
            const result = original.apply(this, args);
            window.setTimeout(onNavigate, 0);

            return result;
        };
    }

    window.addEventListener('popstate', onNavigate);
    document.addEventListener('click', onClick, {
        capture: true,
        passive: true,
    });
    window.addEventListener('error', (event) =>
        onFault(event.message || 'error', event.filename, event.lineno),
    );
    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason as
            | { message?: string }
            | string
            | undefined;
        onFault(
            typeof reason === 'string'
                ? reason
                : (reason?.message ?? 'unhandled rejection'),
        );
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            void flush();
        }
    });
    window.addEventListener('pagehide', () => void flush(true));
    window.setInterval(() => void flush(), FLUSH_MS);

    window.cyberiaReplay = {
        recording: () => stopRecording !== null,
        stop: refuse,
        event: (name: string) =>
            custom('event', { name: String(name).slice(0, 64) }),
    };

    start();
    if (options.hideNotice !== 'true') {
        showNotice();
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
} else {
    boot();
}
