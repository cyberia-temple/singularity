'use strict';

/**
 * The only bridge between the site and the shell.
 *
 * `window.cyberiaNative` is what the Laravel frontend feature-detects to know
 * it is running inside the desktop app (see resources/js/lib/native.ts); the
 * offline page uses `retry()` and `openProxySettings()`.
 *
 * Nothing here changes a setting. `openProxySettings()` raises a window the
 * user then has to act in, so the worst a hostile page could do with it is
 * annoy; the proxy itself is readable and writable only from that window's own
 * preload (`preload-proxy.js`), which no remote content is ever loaded into.
 *
 * `torrent` is the one capability a web page genuinely cannot have on its own:
 * the mainline DHT is UDP and peers are TCP, so a real client needs this
 * process. Every method is a message to the main process, which decides what
 * may happen — the page can name a magnet and a file index, never a path.
 */

const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('shell:info');

/** How far into the window a side grip reaches, and a corner grip. */
const GRIP = 6;
const CORNER_GRIP = 16;

/**
 * Resize grips for the transparent window, which has lost the invisible border
 * Chromium draws around a frameless one. They hang off `<html>`, outside the
 * body the page clips to its rounded corners, and exist only while the corners
 * are round: a maximised window is not resized by its edges.
 */
const GRIPS = {
    n: { top: 0, left: CORNER_GRIP, right: CORNER_GRIP, height: GRIP, cursor: 'ns-resize' },
    s: { bottom: 0, left: CORNER_GRIP, right: CORNER_GRIP, height: GRIP, cursor: 'ns-resize' },
    e: { right: 0, top: CORNER_GRIP, bottom: CORNER_GRIP, width: GRIP, cursor: 'ew-resize' },
    w: { left: 0, top: CORNER_GRIP, bottom: CORNER_GRIP, width: GRIP, cursor: 'ew-resize' },
    nw: { top: 0, left: 0, width: CORNER_GRIP, height: CORNER_GRIP, cursor: 'nwse-resize' },
    se: { bottom: 0, right: 0, width: CORNER_GRIP, height: CORNER_GRIP, cursor: 'nwse-resize' },
    ne: { top: 0, right: 0, width: CORNER_GRIP, height: CORNER_GRIP, cursor: 'nesw-resize' },
    sw: { bottom: 0, left: 0, width: CORNER_GRIP, height: CORNER_GRIP, cursor: 'nesw-resize' },
};

let grips = [];

const createGrip = (edge, placement) => {
    const grip = document.createElement('div');
    const { cursor, ...box } = placement;

    Object.assign(grip.style, { position: 'fixed', zIndex: '2147483647', cursor });
    grip.style.setProperty('-webkit-app-region', 'no-drag');

    for (const [side, value] of Object.entries(box)) {
        grip.style[side] = `${value}px`;
    }

    grip.addEventListener('pointerdown', (event) => {
        if (!event.isTrusted || event.button !== 0) {
            return;
        }

        event.preventDefault();
        grip.setPointerCapture(event.pointerId);
        ipcRenderer.send('shell:resize-start', edge);
    });
    grip.addEventListener('pointermove', (event) => {
        if (event.isTrusted && grip.hasPointerCapture(event.pointerId)) {
            ipcRenderer.send('shell:resize-move');
        }
    });
    grip.addEventListener('lostpointercapture', () => ipcRenderer.send('shell:resize-end'));

    return grip;
};

const showGrips = (round) => {
    if (!document.body) {
        document.addEventListener('DOMContentLoaded', () => showGrips(round), { once: true });

        return;
    }

    for (const grip of grips) {
        grip.remove();
    }

    grips = round
        ? Object.entries(GRIPS).map(([edge, placement]) => createGrip(edge, placement))
        : [];
    document.documentElement.append(...grips);
};

/**
 * Round or square corners, mirrored onto `<html data-window-edge>` for the
 * page's CSS: the window is transparent, so the wallet draws its own corners
 * and squares them while the window is maximised or full screen.
 */
const showWindowEdge = (edge) => {
    if (!document.documentElement) {
        document.addEventListener('DOMContentLoaded', () => showWindowEdge(edge), { once: true });

        return;
    }

    const round = edge === 'round';

    document.documentElement.dataset.windowEdge = round ? 'round' : 'square';
    showGrips(round);
};

showWindowEdge(info.windowEdge);
ipcRenderer.on('shell:window-edge', (_event, edge) => showWindowEdge(edge));

/** Progress is pushed from the engine; listeners live only in this scope. */
const torrentListeners = new Set();

ipcRenderer.on('torrent:update', (_event, torrents) => {
    for (const listener of torrentListeners) {
        listener(torrents);
    }
});

contextBridge.exposeInMainWorld('cyberiaNative', {
    shell: info.shell,
    platform: info.platform,
    version: info.version,
    localWallet: info.localWallet === true,
    url: info.url,
    proxy: info.proxy,
    tray: info.tray === true,
    retry: () => ipcRenderer.send('shell:retry'),
    openExternal: (url) => ipcRenderer.send('shell:open-external', url),
    openProxySettings: () => ipcRenderer.send('shell:open-proxy'),
    startup: {
        available: Boolean(info.startup?.available),
        enabled: Boolean(info.startup?.enabled),
        get: () => ipcRenderer.invoke('shell:get-startup'),
        set: (enabled) =>
            ipcRenderer.invoke('shell:set-startup', Boolean(enabled)),
    },
    torrent: {
        // 2 — seeding, streaming and per-file paths. The page reads this
        // rather than assuming the desktop app has everything: an older shell
        // is a real thing to run into, and calling a method that is not there
        // is worse than drawing a screen without the button.
        version: 2,
        info: () => ipcRenderer.invoke('torrent:info'),
        add: (source) => ipcRenderer.invoke('torrent:add', String(source)),
        // The page asks for a picker, never for a path: what it gets back is a
        // torrent that already exists and is already being shared.
        seed: (mode) =>
            ipcRenderer.invoke('torrent:seed', mode === 'folder' ? 'folder' : 'files'),
        stream: (infoHash, fileIndex) =>
            ipcRenderer.invoke('torrent:stream', String(infoHash), Number(fileIndex)),
        openFile: (infoHash, fileIndex) =>
            ipcRenderer.invoke('torrent:openFile', String(infoHash), Number(fileIndex)),
        list: () => ipcRenderer.invoke('torrent:list'),
        pause: (infoHash) => ipcRenderer.invoke('torrent:pause', String(infoHash)),
        resume: (infoHash) => ipcRenderer.invoke('torrent:resume', String(infoHash)),
        remove: (infoHash, deleteFiles) =>
            ipcRenderer.invoke('torrent:remove', String(infoHash), Boolean(deleteFiles)),
        read: (infoHash, fileIndex) =>
            ipcRenderer.invoke('torrent:read', String(infoHash), Number(fileIndex)),
        reveal: () => ipcRenderer.invoke('torrent:reveal'),
        subscribe: (listener) => {
            torrentListeners.add(listener);

            return () => torrentListeners.delete(listener);
        },
    },
});
