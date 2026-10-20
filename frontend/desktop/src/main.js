'use strict';

/**
 * Cyberia desktop wallet.
 *
 * The app is the Cyberia wallet: the window opens on `/wallet`, which renders
 * from the bundled wallet-dist directory on an app-only origin. Network
 * services supply data; they cannot replace the installed HTML or scripts.
 *
 * Other pages, including the Cyberia site, open in the system browser.
 *
 * The window is deliberately undecorated: one frameless window whose only
 * view is the site. The wallet masthead is its drag region, so no browser-like
 * title or menu strip is left above the product. See `frame.js` for the
 * keyboard commands that replace the missing application menu.
 */

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
    BaseWindow,
    BrowserWindow,
    Menu,
    Tray,
    WebContentsView,
    app,
    dialog,
    ipcMain,
    net,
    nativeImage,
    protocol,
    screen,
    session,
    shell,
} = require('electron');
const {
    PARTITION,
    PROTOCOL,
    describeProxy,
    hasProxyFlag,
    isExternallyOpenable,
    normalizeProxySetting,
    resolveAppUrl,
    resolveProxyDecision,
    resolveStartUrl,
} = require('./config');
const {
    MIN_WINDOW,
    commandForInput,
    resizedBounds,
    usesFramelessWindow,
    windowEdge,
    zoomLevel,
} = require('./frame');
const { createAutostart } = require('./autostart');
const { loadProxySetting, saveProxySetting } = require('./proxy-settings');
const torrent = require('./torrent');
const { STREAM_SCHEME } = require('./torrent-rules');
const { loadWindowState, trackWindowState } = require('./window-state');
const { isLocalWallet, localStartUrl, publicUrl, blocksRemoteCode, createLocalHandler } = require('./local-wallet');

const APP_URL = resolveAppUrl(process.env, process.argv);
const START_URL = localStartUrl(resolveStartUrl(process.env, process.argv));
const OFFLINE_PAGE = path.join(__dirname, 'offline.html');

/*
 * The scheme the wallet plays torrents through.
 *
 * This has to be declared before the app is ready, and it has to be declared
 * `secure`: the site is https, and a media element on an https page will not
 * load `http://127.0.0.1` — that is mixed content, blocked with no visible
 * error and no event. `stream` is what makes range requests and therefore
 * seeking work; `corsEnabled` is what lets the page's own scripts touch it.
 *
 * It resolves only to files inside torrents this client already holds — see
 * `streamResponse` in torrent.js.
 */
protocol.registerSchemesAsPrivileged([
    {
        scheme: STREAM_SCHEME,
        privileges: {
            standard: true,
            secure: true,
            stream: true,
            supportFetchAPI: true,
            corsEnabled: true,
        },
    },
]);
const PROXY_PAGE = path.join(__dirname, 'proxy.html');

const IS_MAC = process.platform === 'darwin';

/** Whether this run removes every window decoration; `--native-frame` opts out. */
const FRAMELESS = usesFramelessWindow(process.env, process.argv);

/** A launch flag pins the proxy for this run, so the window cannot change it. */
const PROXY_LOCKED = hasProxyFlag(process.argv);

/**
 * How long a new proxy gets to answer before it counts as unreachable. Long
 * enough for a tunnel abroad to hand-shake, short enough that a dead port does
 * not look like a frozen window.
 */
const PROBE_TIMEOUT_MS = 12000;

/** A site that never finishes loading must not leave the app with no window. */
const REVEAL_TIMEOUT_MS = 2500;

/** How long the window manager gets to settle before the views are laid out again. */
const SETTLE_MS = 150;

/** Permissions the site legitimately needs; everything else is refused. */
const ALLOWED_PERMISSIONS = new Set([
    'background-sync',
    'clipboard-sanitized-write',
    'fullscreen',
    'notifications',
]);

/** `did-fail-load` fires with this code for navigations we cancelled ourselves. */
const ERR_ABORTED = -3;

let mainWindow = null;
let contentView = null;
let appMenu = null;
let tray = null;
let proxyWindow = null;
let shellSession = null;
let settleTimer = null;
/** The drag in progress on one of the page's resize grips, if any. */
let resizeDrag = null;
let autostart = null;
let quitting = false;
let startHidden = false;

/** The proxy in force right now, what the user saved, and where it came from. */
let activeProxy = null;
let proxySetting = { mode: 'system', server: '' };
let proxySource = 'system';

/** The site's own web contents — the window has none of its own any more. */
function pageContents() {
    if (!contentView || contentView.webContents.isDestroyed()) {
        return null;
    }

    return contentView.webContents;
}

/** One icon for the window, notifications and tray, in dev and packaged runs. */
function appIconPath() {
    return app.isPackaged
        ? path.join(process.resourcesPath, 'icon.png')
        : path.join(__dirname, '..', 'build', 'icon.png');
}

/** A mutating renderer request may only come from this app's own site. */
function isTrustedPageEvent(event) {
    if (event.sender !== pageContents()) {
        return false;
    }

    try {
        const url = new URL(event.senderFrame?.url || event.sender.getURL());

        return isLocalWallet(url.href);
    } catch {
        return false;
    }
}

/**
 * Puts the keyboard on the page.
 *
 * A window holding views focuses none of them by itself, so without this the
 * app opens with a password field that ignores typing until it is clicked —
 * the one screen where that is least forgivable.
 */
function focusPage() {
    pageContents()?.focus();
}

function buildUserAgent() {
    return `${app.userAgentFallback}`
        .replace(/\sElectron\/\S+/, '')
        .replace(/\scyberia-desktop\/\S+/i, '')
        .replace(/\sCyberia\/\S+/, '')
        .concat(` CyberiaDesktop/${app.getVersion()}`);
}

function openExternal(target) {
    // Wallets and Telegram use custom schemes (wc:, metamask:, tg:), so the
    // shell only screens out the schemes that execute or read something.
    if (!isExternallyOpenable(target)) {
        return;
    }

    void shell.openExternal(target);
}

function loadApp(target = START_URL) {
    const url = new URL(target);
    if ((isLocalWallet(target) || url.origin === new URL(APP_URL).origin) &&
        ['/', '/wallet'].includes(url.pathname)) {
        void pageContents()?.loadURL(localStartUrl(target));
    } else {
        openExternal(publicUrl(target, APP_URL));
    }
}

function showOffline(error = '') {
    void pageContents()?.loadFile(OFFLINE_PAGE, {
        query: { url: START_URL, error, proxy: describeProxy(activeProxy) },
    });
}

/**
 * Pins a proxy onto both sessions.
 *
 * Pinned rather than inherited: on Linux desktops Chromium takes its proxy from
 * the desktop settings and ignores http_proxy/https_proxy, so a stale system
 * entry there would fail every request with ERR_PROXY_CONNECTION_FAILED. `null`
 * hands the session back to that system configuration, which is what makes
 * "System" in the proxy window an actual choice rather than a no-op.
 */
async function pinProxy(proxy) {
    const configuration = proxy ?? { mode: 'system' };

    await Promise.all([
        shellSession.setProxy(configuration),
        session.defaultSession.setProxy(configuration),
    ]);

    activeProxy = proxy;
}

/**
 * Asks the site for its headers through whatever proxy is pinned right now.
 *
 * This is what turns the proxy window from a text field into an answer: a
 * setting is only saved once it has actually carried a request, so nobody is
 * left staring at the offline page wondering whether they typed the port wrong
 * or the tunnel is down. A response the site itself sent — even a 404 — proves
 * the connection; a 5xx is the proxy talking about a hop it could not make.
 */
function probeConnection(target) {
    return new Promise((resolve) => {
        let settled = false;

        const request = net.request({
            method: 'HEAD',
            url: target,
            session: shellSession,
            useSessionCookies: false,
        });

        const finish = (result) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timer);
            resolve(result);
        };

        const timer = setTimeout(() => {
            request.abort();
            finish({ ok: false, error: 'ERR_CONNECTION_TIMED_OUT' });
        }, PROBE_TIMEOUT_MS);

        request.on('response', (response) => {
            response.on('data', () => {});
            response.on('end', () => {});

            finish(
                response.statusCode >= 500
                    ? { ok: false, error: `HTTP ${response.statusCode}` }
                    : { ok: true, error: '' },
            );
        });

        request.on('error', (error) => finish({ ok: false, error: error.message }));
        request.end();
    });
}

function proxyState() {
    return {
        mode: proxySetting.mode,
        server: proxySetting.server,
        source: proxySource,
        effective: describeProxy(activeProxy),
        url: START_URL,
        locked: PROXY_LOCKED,
    };
}

/**
 * Applies a setting from the proxy window, keeping it only if it connects.
 *
 * A proxy that does not answer would otherwise be saved over the one that did
 * and survive the restart, leaving the app permanently offline with its only
 * settings window behind the same broken connection.
 */
async function applyProxySetting(payload) {
    if (PROXY_LOCKED) {
        return { ok: false, error: 'locked' };
    }

    const requested = normalizeProxySetting(payload);
    const wanted = payload && typeof payload === 'object' ? String(payload.mode ?? '') : '';

    // A manual entry Chromium cannot use normalises to "system"; silently
    // connecting directly would read as "it worked" for a typed-in typo.
    if (wanted.toLowerCase() === 'manual' && requested.mode !== 'manual') {
        return { ok: false, error: 'invalid' };
    }

    const previous = activeProxy;
    const decision = resolveProxyDecision(process.env, process.argv, requested);

    await pinProxy(decision.proxy);

    const probe = await probeConnection(APP_URL);

    if (!probe.ok) {
        await pinProxy(previous);

        return { ok: false, error: probe.error };
    }

    proxySetting = saveProxySetting(requested);
    proxySource = decision.source;

    loadApp();

    return { ok: true, error: '', ...proxyState() };
}

function openProxyWindow() {
    if (proxyWindow && !proxyWindow.isDestroyed()) {
        proxyWindow.focus();

        return;
    }

    proxyWindow = new BrowserWindow({
        width: 460,
        // Tall enough for the three choices, a wrapped failure and the line
        // saying what is in force — the window never has to scroll to answer.
        height: 700,
        parent: mainWindow ?? undefined,
        modal: Boolean(mainWindow),
        show: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        backgroundColor: '#0b0f10',
        title: 'Cyberia — Proxy',
        autoHideMenuBar: true,
        webPreferences: {
            // Its own preload: reading and changing the proxy is a power the
            // remote site must not be handed along with the rest of the bridge.
            preload: path.join(__dirname, 'preload-proxy.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
        },
    });

    proxyWindow.once('ready-to-show', () => proxyWindow.show());
    proxyWindow.on('closed', () => {
        proxyWindow = null;
    });

    void proxyWindow.loadFile(PROXY_PAGE);
}

function showAbout() {
    void dialog.showMessageBox(mainWindow ?? undefined, {
        type: 'info',
        title: 'Cyberia',
        message: `Cyberia ${app.getVersion()}`,
        detail: `Electron ${process.versions.electron}\n${START_URL}`,
        buttons: ['OK'],
    });
}

function toggleMaximize() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();

        return;
    }

    mainWindow.maximize();
}

function zoomPage(command) {
    const contents = pageContents();

    if (!contents) {
        return;
    }

    contents.setZoomLevel(zoomLevel(contents.getZoomLevel(), command));
}

/**
 * Everything the shell can be asked to do, under one name each.
 *
 * The native-frame menu, tray and key strokes all come through here, which is
 * why a command that touches the page names the page's own contents: the window
 * is a `BaseWindow` holding a view, so Electron's built-in menu roles — which
 * reach for the focused *BrowserWindow* — would find nothing.
 */
const COMMANDS = {
    wallet: () => loadApp(),
    site: () => openExternal(APP_URL),
    browser: () => openExternal(publicUrl(pageContents()?.getURL() || START_URL, APP_URL)),
    proxy: () => openProxyWindow(),
    back: () => pageContents()?.navigationHistory.goBack(),
    forward: () => pageContents()?.navigationHistory.goForward(),
    reload: () => pageContents()?.reload(),
    'force-reload': () => pageContents()?.reloadIgnoringCache(),
    devtools: () => pageContents()?.toggleDevTools(),
    'zoom-in': () => zoomPage('zoom-in'),
    'zoom-out': () => zoomPage('zoom-out'),
    'zoom-reset': () => zoomPage('zoom-reset'),
    undo: () => pageContents()?.undo(),
    redo: () => pageContents()?.redo(),
    cut: () => pageContents()?.cut(),
    copy: () => pageContents()?.copy(),
    paste: () => pageContents()?.paste(),
    'select-all': () => pageContents()?.selectAll(),
    fullscreen: () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()),
    minimize: () => mainWindow?.minimize(),
    maximize: () => toggleMaximize(),
    close: () => mainWindow?.close(),
    quit: () => {
        quitting = true;
        app.quit();
    },
    about: () => showAbout(),
};

/** Runs a command by name. An unknown name is ignored, never guessed at. */
function run(command) {
    if (!Object.prototype.hasOwnProperty.call(COMMANDS, command)) {
        return;
    }

    COMMANDS[command]();
}

function trayLabels() {
    const russian = app.getLocale().toLowerCase().startsWith('ru');

    return russian
        ? {
              open: 'Открыть Cyberia',
              wallet: 'Кошелёк',
              site: 'Сайт Cyberia',
              startup: 'Запускать при входе',
              quit: 'Выйти',
          }
        : {
              open: 'Open Cyberia',
              wallet: 'Wallet',
              site: 'Cyberia Site',
              startup: 'Launch at login',
              quit: 'Quit',
          };
}

function refreshTrayMenu() {
    if (!tray || !autostart) {
        return;
    }

    const labels = trayLabels();
    const startup = autostart.state();

    tray.setContextMenu(
        Menu.buildFromTemplate([
            { label: labels.open, click: () => focusWindow() },
            { label: labels.wallet, click: () => showWindow(START_URL) },
            { label: labels.site, click: () => showWindow(APP_URL) },
            { type: 'separator' },
            ...(startup.available
                ? [
                      {
                          label: labels.startup,
                          type: 'checkbox',
                          checked: startup.enabled,
                          click: (item) => {
                              try {
                                  autostart.set(item.checked);
                              } catch {
                                  console.error(
                                      '[cyberia] could not change login startup',
                                  );
                              } finally {
                                  refreshTrayMenu();
                              }
                          },
                      },
                  ]
                : []),
            { type: 'separator' },
            { label: labels.quit, click: () => run('quit') },
        ]),
    );
}

function createTray() {
    const icon = nativeImage.createFromPath(appIconPath());

    if (icon.isEmpty()) {
        console.error('[cyberia] tray icon is unavailable');

        return false;
    }

    tray = new Tray(
        process.platform === 'linux'
            ? icon.resize({ width: 22, height: 22 })
            : icon,
    );
    tray.setToolTip('Cyberia');
    tray.on('click', () => focusWindow());
    refreshTrayMenu();

    return true;
}

function layoutViews() {
    if (!mainWindow || mainWindow.isDestroyed() || !contentView) {
        return;
    }

    const { width, height } = mainWindow.getContentBounds();

    contentView.setBounds({ x: 0, y: 0, width, height });
}

/**
 * Lays the views out now, and again once the window manager has settled.
 *
 * Both passes are needed on Linux: `unmaximize` is emitted with no `resize`
 * behind it, and around a maximise the sizes that do arrive can be transient
 * ones the window never keeps. A frame left sized for the window's previous
 * shape has its buttons off the edge, so the late pass is worth its 150ms.
 */
function relayout() {
    layoutViews();

    clearTimeout(settleTimer);
    settleTimer = setTimeout(layoutViews, SETTLE_MS);
}

/** The corners the page should draw right now; see `windowEdge`. */
function currentWindowEdge() {
    return windowEdge({
        frameless: FRAMELESS,
        maximized: Boolean(mainWindow?.isMaximized()),
        fullScreen: Boolean(mainWindow?.isFullScreen()),
    });
}

function sendWindowEdge() {
    const contents = pageContents();

    contents?.send('shell:window-edge', currentWindowEdge());
}

/**
 * Starts a drag on a resize grip. The cursor is read here rather than taken
 * from the page, whose coordinates follow its zoom.
 */
function startResize(edge) {
    if (!mainWindow || mainWindow.isDestroyed() || currentWindowEdge() !== 'round') {
        return;
    }

    resizeDrag = { edge, bounds: mainWindow.getBounds(), cursor: screen.getCursorScreenPoint() };
}

function continueResize() {
    if (!resizeDrag || !mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    const cursor = screen.getCursorScreenPoint();

    mainWindow.setBounds(resizedBounds(
        resizeDrag.bounds,
        resizeDrag.edge,
        cursor.x - resizeDrag.cursor.x,
        cursor.y - resizeDrag.cursor.y,
    ));
}

function setWindowTitle(title) {
    const text = typeof title === 'string' && title.trim() !== '' ? title : 'Cyberia';

    mainWindow?.setTitle(text);
}

/**
 * The key strokes the menu bar used to answer.
 *
 * Only where the shell drew the frame itself and there is no native menu bar
 * attached to the window: macOS has a real one at the top of the screen, and a
 * `--native-frame` run gets the application menu back, so in both of those the
 * strokes are already spoken for and answering them again would run every
 * command twice.
 */
function watchKeys(contents) {
    if (!FRAMELESS || IS_MAC) {
        return;
    }

    contents.on('before-input-event', (event, input) => {
        const command = commandForInput(input);

        if (!command) {
            return;
        }

        event.preventDefault();
        run(command);
    });
}

async function configureSession() {
    shellSession = session.fromPartition(PARTITION);

    shellSession.protocol.handle('https', createLocalHandler({
        root: path.join(__dirname, '..', 'wallet-dist'),
        siteUrl: APP_URL,
        fetchRemote: (input, init) => shellSession.fetch(input, init),
        csrfToken: async () => {
            let cookies = await shellSession.cookies.get({ url: APP_URL, name: 'XSRF-TOKEN' });
            if (!cookies.length) {
                await shellSession.fetch(`${APP_URL}/sanctum/csrf-cookie`, {
                    credentials: 'include', bypassCustomProtocolHandlers: true,
                });
                cookies = await shellSession.cookies.get({ url: APP_URL, name: 'XSRF-TOKEN' });
            }
            return cookies[0] ? decodeURIComponent(cookies[0].value) : '';
        },
    }));
    shellSession.webRequest.onBeforeRequest((details, callback) => {
        callback({ cancel: blocksRemoteCode(details) });
    });

    // Registered on the shell's own session rather than globally: nothing but
    // the site's own page has any business asking for a stream.
    shellSession.protocol.handle(STREAM_SCHEME, (request) =>
        torrent.streamResponse(request),
    );

    proxySetting = loadProxySetting();

    const decision = resolveProxyDecision(process.env, process.argv, proxySetting);

    proxySource = decision.source;

    if (decision.proxy) {
        await pinProxy(decision.proxy);
    }

    shellSession.setPermissionRequestHandler((contents, permission, callback) => {
        callback(isLocalWallet(contents.getURL()) && ALLOWED_PERMISSIONS.has(permission));
    });

    shellSession.setPermissionCheckHandler((_contents, permission, origin) =>
        isLocalWallet(origin) && ALLOWED_PERMISSIONS.has(permission),
    );

    // Hardware wallets over WebHID/WebUSB are not wired up yet; refuse the
    // device pickers rather than showing an empty chooser.
    shellSession.setDevicePermissionHandler(() => false);

    return shellSession;
}

function createWindow() {
    const state = loadWindowState();

    mainWindow = new BaseWindow({
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
        minWidth: MIN_WINDOW.width,
        minHeight: MIN_WINDOW.height,
        show: false,
        backgroundColor: FRAMELESS ? '#00000000' : '#0b0f10',
        title: 'Cyberia',
        // The wallet itself is the window. `--native-frame` is retained as an
        // accessibility/compatibility escape hatch for unusual window managers.
        frame: !FRAMELESS,
        // See-through so the wallet can round its own corners (`windowEdge`).
        transparent: FRAMELESS,
        autoHideMenuBar: true,
        icon: process.platform === 'linux' ? appIconPath() : undefined,
    });

    contentView = new WebContentsView({
        webPreferences: {
            partition: PARTITION,
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: true,
        },
    });

    contentView.setBackgroundColor(FRAMELESS ? '#00000000' : '#0b0f10');
    mainWindow.contentView.addChildView(contentView);

    layoutViews();

    if (state.maximized) {
        mainWindow.maximize();
    }

    trackWindowState(mainWindow);

    // Reveal when the site settles; the timer covers a run where it never does.
    const reveal = () => {
        if (startHidden) {
            return;
        }

        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
            mainWindow.show();
            focusPage();
        }
    };

    contentView.webContents.once('did-stop-loading', reveal);
    setTimeout(reveal, REVEAL_TIMEOUT_MS);

    const contents = contentView.webContents;

    watchKeys(contents);

    contents.setWindowOpenHandler(({ url }) => {
        openExternal(publicUrl(url, APP_URL));

        return { action: 'deny' };
    });

    const guardNavigation = (event, url) => {
        if (isLocalWallet(url) || url.startsWith(pathToFileURL(OFFLINE_PAGE).href)) {
            return;
        }

        event.preventDefault();
        openExternal(publicUrl(url, APP_URL));
    };
    contents.on('will-navigate', guardNavigation);
    contents.on('will-redirect', guardNavigation);

    contents.on('did-fail-load', (_event, errorCode, description, _url, isMainFrame) => {
        if (isMainFrame && errorCode !== ERR_ABORTED) {
            showOffline(description);
        }
    });

    contents.on('render-process-gone', (_event, details) => {
        if (details.reason !== 'clean-exit') {
            loadApp();
        }
    });

    // A window with no page of its own has no title of its own either.
    contents.on('page-title-updated', (_event, title) => setWindowTitle(title));

    mainWindow.on('resize', relayout);
    mainWindow.on('restore', relayout);
    mainWindow.on('maximize', relayout);
    mainWindow.on('unmaximize', relayout);
    mainWindow.on('enter-full-screen', relayout);
    mainWindow.on('leave-full-screen', relayout);

    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) {
        mainWindow.on(event, sendWindowEdge);
    }
    mainWindow.on('focus', focusPage);

    // Closing the window leaves the wallet reachable from the tray. Explicit
    // Quit is the one path that tears down its background process.
    mainWindow.on('close', (event) => {
        if (!quitting && tray) {
            event.preventDefault();
            mainWindow?.hide();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        contentView = null;
    });

    loadApp();
}

function focusWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();

        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    if (!mainWindow.isVisible()) {
        mainWindow.show();
    }

    mainWindow.focus();
    focusPage();
}

function showWindow(target) {
    focusWindow();
    loadApp(target);
}

/** `cyberia://profile?tab=xp` -> `<APP_URL>/profile?tab=xp`. */
function handleDeepLink(target) {
    if (typeof target !== 'string' || !target.startsWith(`${PROTOCOL}://`)) {
        return;
    }

    let url;

    try {
        url = new URL(target);
    } catch {
        return;
    }

    const route = `${url.host}${url.pathname}`.replace(/^\/*/, '/');

    focusWindow();
    loadApp(`${APP_URL}${route}${url.search}${url.hash}`);
}

function deepLinkFrom(argv) {
    return argv.find((argument) => argument.startsWith(`${PROTOCOL}://`)) ?? null;
}

/**
 * The application menu used only in native-frame mode (and by macOS).
 *
 * Every item that touches the page has a `click` of its own rather than a role:
 * roles that reload, zoom or toggle the tools ask Electron for the focused
 * BrowserWindow, and this window is a frame holding views instead. The two
 * roles that stay are macOS-only and act on the app or the first responder,
 * which is exactly what they should do.
 */
function menuTemplate() {
    const editItems = [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => run('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => run('redo') },
        { type: 'separator' },
        { label: 'Cut', accelerator: 'CmdOrCtrl+X', click: () => run('cut') },
        { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => run('copy') },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: () => run('paste') },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: () => run('select-all') },
    ];

    return [
        ...(IS_MAC ? [{ role: 'appMenu' }] : []),
        {
            label: 'File',
            submenu: [
                {
                    label: 'Wallet',
                    accelerator: 'CmdOrCtrl+Shift+H',
                    click: () => run('wallet'),
                },
                {
                    label: 'Cyberia Site',
                    accelerator: 'CmdOrCtrl+Shift+S',
                    click: () => run('site'),
                },
                {
                    label: 'Open in Browser',
                    click: () => run('browser'),
                },
                { type: 'separator' },
                {
                    label: 'Proxy…',
                    click: () => run('proxy'),
                },
                { type: 'separator' },
                IS_MAC
                    ? { label: 'Close Window', accelerator: 'Command+W', click: () => run('close') }
                    : { label: 'Quit', accelerator: 'Ctrl+Q', click: () => run('quit') },
            ],
        },
        IS_MAC ? { role: 'editMenu' } : { label: 'Edit', submenu: editItems },
        {
            label: 'View',
            submenu: [
                {
                    label: 'Back',
                    accelerator: 'Alt+Left',
                    click: () => run('back'),
                },
                {
                    label: 'Forward',
                    accelerator: 'Alt+Right',
                    click: () => run('forward'),
                },
                {
                    label: 'Reload',
                    accelerator: 'CmdOrCtrl+R',
                    click: () => run('reload'),
                },
                {
                    label: 'Force Reload',
                    accelerator: 'CmdOrCtrl+Shift+R',
                    click: () => run('force-reload'),
                },
                { type: 'separator' },
                {
                    label: 'Actual Size',
                    accelerator: 'CmdOrCtrl+0',
                    click: () => run('zoom-reset'),
                },
                {
                    label: 'Zoom In',
                    accelerator: 'CmdOrCtrl+=',
                    click: () => run('zoom-in'),
                },
                {
                    label: 'Zoom Out',
                    accelerator: 'CmdOrCtrl+-',
                    click: () => run('zoom-out'),
                },
                { type: 'separator' },
                {
                    label: 'Toggle Full Screen',
                    accelerator: IS_MAC ? 'Control+Command+F' : 'F11',
                    click: () => run('fullscreen'),
                },
                {
                    label: 'Toggle Developer Tools',
                    accelerator: IS_MAC ? 'Alt+Command+I' : 'Ctrl+Shift+I',
                    click: () => run('devtools'),
                },
            ],
        },
        {
            label: 'Window',
            submenu: [
                {
                    label: 'Minimize',
                    // Only where a menu bar is attached to answer it.
                    ...(IS_MAC ? { accelerator: 'Command+M' } : {}),
                    click: () => run('minimize'),
                },
                {
                    label: 'Zoom',
                    click: () => run('maximize'),
                },
                ...(IS_MAC ? [{ type: 'separator' }, { role: 'front' }] : []),
            ],
        },
        {
            label: 'Help',
            submenu: [
                {
                    label: 'About Cyberia',
                    click: () => run('about'),
                },
            ],
        },
    ];
}

/**
 * Builds the menu, and attaches it only where a window may wear one.
 *
 * On Windows and Linux a menu attached to a frameless window would create the
 * browser-like strip this shell deliberately removes, so `watchKeys` answers
 * its useful strokes instead. macOS keeps its real menu bar, and so does a
 * `--native-frame` run.
 */
function buildMenu() {
    appMenu = Menu.buildFromTemplate(menuTemplate());

    Menu.setApplicationMenu(IS_MAC || !FRAMELESS ? appMenu : null);
}

function registerProtocol() {
    if (process.defaultApp && process.argv.length >= 2) {
        app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);

        return;
    }

    app.setAsDefaultProtocolClient(PROTOCOL);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', (_event, argv) => {
        focusWindow();
        handleDeepLink(deepLinkFrom(argv));
    });

    app.on('open-url', (event, url) => {
        event.preventDefault();
        handleDeepLink(url);
    });

    // Before `whenReady`, so `app.getPath('userData')` resolves to the same
    // directory in a dev run as in the packaged app.
    app.setName('Cyberia');

    app.whenReady().then(async () => {
        app.userAgentFallback = buildUserAgent();

        registerProtocol();
        autostart = createAutostart(app);
        startHidden = autostart.wasOpenedAtLogin();
        await configureSession();
        buildMenu();
        if (!createTray()) {
            // A hidden process without a tray has no route back to its window.
            startHidden = false;
        }

        console.log(
            `[cyberia] ${START_URL} via proxy ${describeProxy(activeProxy)} (${proxySource})`,
        );

        ipcMain.on('shell:retry', () => loadApp());
        ipcMain.on('shell:open-external', (_event, url) => openExternal(url));
        // Opening the window is all the site (and the offline page) may do:
        // reading and changing the proxy lives behind the window's own preload.
        ipcMain.on('shell:open-proxy', () => openProxyWindow());
        // The grips the preload draws in a transparent window; see resizedBounds.
        ipcMain.on('shell:resize-start', (_event, edge) => startResize(String(edge)));
        ipcMain.on('shell:resize-move', () => continueResize());
        ipcMain.on('shell:resize-end', () => {
            resizeDrag = null;
        });
        ipcMain.on('shell:info', (event) => {
            event.returnValue = {
                shell: 'desktop',
                platform: process.platform,
                version: app.getVersion(),
                url: START_URL,
                localWallet: true,
                proxy: describeProxy(activeProxy),
                startup: autostart.state(),
                tray: Boolean(tray),
                windowEdge: currentWindowEdge(),
            };
        });
        ipcMain.handle('shell:set-startup', (event, enabled) => {
            if (!isTrustedPageEvent(event)) {
                return { available: false, enabled: false, error: 'forbidden' };
            }

            try {
                const state = autostart.set(Boolean(enabled));

                refreshTrayMenu();

                return { ...state, error: '' };
            } catch {
                return { ...autostart.state(), error: 'write_failed' };
            }
        });
        ipcMain.handle('shell:get-startup', (event) =>
            isTrustedPageEvent(event)
                ? { ...autostart.state(), error: '' }
                : { available: false, enabled: false, error: 'forbidden' },
        );

        // The torrent client. Only the site's own pages may reach it, and it
        // stays unstarted until someone agrees to run one in a dialog no page
        // can draw.
        torrent.register({
            getWindow: () => mainWindow,
            getContents: () => pageContents(),
            isTrusted: isLocalWallet,
            // The tracker a torrent created here announces to is this app's
            // own site, derived rather than accepted from the page.
            appUrl: APP_URL,
        });

        ipcMain.handle('proxy:state', () => proxyState());
        ipcMain.handle('proxy:apply', (_event, setting) => applyProxySetting(setting));
        ipcMain.on('proxy:close', () => {
            if (proxyWindow && !proxyWindow.isDestroyed()) {
                proxyWindow.close();
            }
        });

        createWindow();
        handleDeepLink(deepLinkFrom(process.argv));

        app.on('activate', () => {
            focusWindow();
        });
    });

    // No swarm outlives the window: the client is stopped before the app is.
    app.on('before-quit', () => {
        quitting = true;
        torrent.shutdown();
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin' && !tray) {
            app.quit();
        }
    });
}
