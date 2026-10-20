# Cyberia Desktop

Standalone Electron wallet for Linux, Windows, and macOS. Vite compiles the
existing Vue wallet from `backend/laravel` into `wallet-dist/`, which is included
in the installed application. Its HTML, JavaScript and CSS are served locally
on `https://wallet.cyberia.invalid`, an origin handled only inside the app.
Opening the wallet and unlocking its vault work without a server connection.

When building from another worktree, set `CYBERIA_WALLET_SOURCE` to its
`backend/laravel` directory. The current interface lives on `ux/program`;
the older `feat/wallet-networks-crosschain` checkout is refused. The build copies
the chosen frontend into an isolated staging directory, applies the desktop
integration, and records the source revision and input hashes in `source.json`.
It never edits the selected worktree.

RPC, prices and other services still need the network. A same-origin gateway
forwards API requests to `CYBERIA_APP_URL` and returns JSON; an account refresh
extracts the site's Inertia data and always uses the installed Wallet component.
Remote scripts, stylesheets and frames are blocked. A server deploy cannot
replace the installed executable wallet code.

The app is fully frameless: there is no operating-system decoration and no
second title/menu strip drawn above the wallet — see [The window](#the-window).

**The app is the Cyberia wallet.** The window opens on `/wallet`, which renders
without the site header and footer inside a native shell and fills the frame
instead. The masthead and _File → Cyberia Site_ open the public site in the
system browser. The wallet needs no Cyberia account. First launch creates or
imports a password-encrypted vault; creating a wallet generates 24 words locally.
The password cannot be skipped in this build.

The vault uses AES-256-GCM and PBKDF2-SHA-256 (310,000 iterations). It remains in
the local renderer's storage and memory, rather than an isolated native signing
service. Existing browser and older-shell vaults stay on their original origin;
this build does not silently migrate or overwrite them.

`backend/laravel/resources/desktop/bootstrap.json` is a checked-in snapshot of
public service/bridge configuration. It contains no account, session or secret.
Prices are refreshed through the API, and unavailable network reads remain unknown.

## Commands

```bash
npm --prefix ../../backend/laravel ci
# With Laravel dependencies installed, generate route helpers in backend/laravel:
# php artisan wayfinder:generate --with-form
npm install
npm start            # compile and run the bundled wallet
npm test             # navigation rules (no display or Electron binary needed)
npm run build:renderer
npm run test:renderer # offline boot, encrypted creation and password on restart
npm run dist:linux   # dist/Cyberia-<version>.AppImage + .deb
npm run dist:win     # dist/*.exe (NSIS installer + portable)
npm run dist:mac     # dist/*.dmg + .zip
npm run pack         # unpacked build, for a quick look at the bundle
```

`dist:win` builds from Linux only with Wine installed; `dist:mac` needs macOS.
Use the release workflow (`.github/workflows/apps.yml`) to produce all three from
one tag.

## Releases

```bash
git tag app-v1.0.0 && git push origin app-v1.0.0
```

That builds all three platforms and publishes them as a **public GitHub release**
with `SHA256SUMS.txt` attached; https://cyberia.church/download reads that release
and hands each visitor the right file. A manual workflow run builds the same
installers but publishes nothing — workflow artifacts are only reachable by
signed-in GitHub users, which is not distribution.

The tag is the version: CI writes `1.0.0` into `package.json` before building, so
nothing here has to be committed per release.

File names carry **no version** — `Cyberia-Setup-x64.exe`,
`Cyberia-portable-x64.exe`, `Cyberia-mac-arm64.dmg`, `Cyberia-mac-x64.dmg`,
`Cyberia-linux-x86_64.AppImage`, `Cyberia-linux-amd64.deb`. That is what makes
`https://github.com/<owner>/<repo>/releases/latest/download/<name>` a permanent
address. Renaming one is a three-file change: `electron-builder.yml`, the workflow
notes, and `config/downloads.php` in the Laravel app.

### SSH-signed local Linux builds

```bash
CYBERIA_WALLET_SOURCE=/home/lain/random/singularity-ux/backend/laravel \
  npm run dist:linux -- --config.directories.output=dist/local-wallet-1.2.0
npm run test:renderer
npm run test:package
npm run sign:release -- dist/local-wallet-1.2.0 ~/.ssh/id_ed25519.pub
```

Signing uses the matching key in `ssh-agent`. Each installer and `SHA256SUMS.txt`
gets a detached OpenSSH `.sig` in the `cyberia-release` namespace. The directory
also contains the public key, `allowed_signers`, and `RELEASE.json` with the
source revision, working-tree state and hashes of the compiled renderer assets.
These are SSH signatures verified separately from Debian package installation.
Use a separate versioned directory for each release to preserve old installers
and signatures. The package check and signing commands default to the version
in `package.json`.

From the release directory, verify the expected public-key fingerprint, then:

```bash
ssh-keygen -lf SIGNING_KEY.pub
ssh-keygen -Y verify -f allowed_signers -I cyberia-release -n cyberia-release -s SHA256SUMS.txt.sig < SHA256SUMS.txt
sha256sum -c SHA256SUMS.txt
```

## Configuration

| Variable / flag   | Default                  | Purpose                              |
| ----------------- | ------------------------ | ------------------------------------ |
| `CYBERIA_APP_URL`  | `https://cyberia.church` | Backend and external website              |
| `--url=<url>`      | —                        | Same, as a command-line switch       |
| `CYBERIA_APP_PATH` | `/wallet`                | Wallet launch query            |
| `--path=<path>`    | —                        | Same, as a command-line switch       |
| `CYBERIA_PROXY`    | —                        | Proxy for the shell, wins over `*_proxy` |
| `--proxy=<url>`    | —                        | Same, as a command-line switch, and pins this run |
| `--no-proxy`       | —                        | Ignore every proxy, connect directly |
| `CYBERIA_NATIVE_FRAME` | —                    | `1` gives the window back to the desktop's own frame |
| `--native-frame`   | —                        | Same, as a command-line switch        |

The proxy is also settable inside the app (_File → Proxy…_), which is what a
packaged install has instead of a command line — see [Proxies](#proxies).

```bash
CYBERIA_APP_URL=http://localhost:8000 npm start
npm start -- --url=http://localhost:8000 --path=/wallet?section=security
```

Anything that is not `http`/`https` falls back to production, so a bad override
cannot point the app at a local file. `CYBERIA_APP_PATH` must be a same-origin
absolute path: a full URL or `//host` falls back to `/wallet` rather than moving
the whole app to another origin.

### Proxies

Chromium does **not** read `http_proxy`/`https_proxy` on a desktop that publishes
its own proxy settings — GNOME, Cinnamon and KDE hand it their system entry
instead. A stale entry there (a port nothing listens on) fails every request with
`ERR_PROXY_CONNECTION_FAILED`, even while `curl` tunnels happily through the proxy
exported in the shell.

So the shell resolves the proxy itself and pins it onto the session before the
first load:

1. `--no-proxy`, `--proxy=direct`, `--proxy=<url>` — this run was launched with
   an instruction, and it holds for this run.
2. **The setting saved in the app** (_File → Proxy…_, or the button on the
   offline page). It outranks the environment because it is the last thing a
   human chose about this app, and for someone who starts Cyberia from an icon
   it is the only lever that exists.
3. `CYBERIA_PROXY=<url>` or `direct`, then `https_proxy` / `http_proxy` /
   `all_proxy` (either case), with `no_proxy` as the bypass list on top of
   `localhost,127.0.0.1,::1,<local>`.
4. Nothing set — Chromium keeps using the system configuration.

Servers may be written as `host:port` (assumed `http`), `http://`, `https://`,
`socks4://` or `socks5://` (`socks://` is read as SOCKS5). Credentials in the URL
are dropped: Chromium proxy rules cannot carry them.

```bash
CYBERIA_PROXY=http://127.0.0.1:10808 npm start   # xray/v2ray on the usual port
npm start -- --no-proxy                          # straight out, ignore the desktop
```

The startup line `[cyberia] <url> via proxy <rules> (<source>)` says what was
picked and where it came from.

#### The proxy window

`src/proxy.html`, opened from _File → Proxy…_ and from the **Proxy settings**
button on the offline page — the one place it is needed most, since a packaged
app has no command line to relaunch with. System, direct, or an address typed by
hand; the wallet offers the same button when a network read fails inside it.

A setting is applied to the live session, then **checked** with one request to
the site before it is saved to `proxy.json` in `userData`. A proxy that does not
answer is rolled back to the previous one and reported with its error code —
otherwise a typo would be saved over a working connection and survive the
restart, leaving the app permanently offline with its own settings window behind
the same dead tunnel. Nothing needs restarting when it works: the session is
re-pinned and the site reloads.

A run launched with `--proxy=` / `--no-proxy` shows the window read-only and says
so: the flag is this run's instruction, and the window would be lying if it
pretended to override it.

Reading or changing the proxy lives behind that window's own preload
(`src/preload-proxy.js`), which no remote page is ever loaded into. All the site
can do is ask for the window to be raised.

## The window

The app draws no title bar. It is one frameless `BaseWindow` whose single
`WebContentsView` fills every pixel. On the wallet route, the wallet masthead is
the drag surface and a double click there maximises the window; its buttons and
links opt out of dragging. There is no browser-like title, menu strip or row of
window buttons above it.

Two consequences worth knowing before touching `src/main.js`:

- **The window is a `BaseWindow`, not a `BrowserWindow`** — it has no web
  contents of its own, and Electron's menu **roles** that reach for the focused
  `BrowserWindow` (`reload`, `zoomIn`, `toggleDevTools`, `minimize`) would find
  nothing. Every menu item that touches the page is a `click` naming the site's
  own contents instead, through one command table shared by the native-frame
  menu and the keys.
- **Nothing has keyboard focus until something is given it.** A window holding
  views focuses none of them, so the shell focuses the site on show and on every
  window focus — otherwise the app opens with a password field that ignores
  typing until it is clicked.

The window is transparent, and the wallet rounds its own corners like the card
it is on the site (`desktop.css`, `src/offline.html`). The shell tells the page
which corners to draw (`windowEdge` in `src/frame.js`, mirrored onto
`<html data-window-edge>` by the preload): round while the window floats, square
while it is maximised or full screen. A transparent window loses the invisible
resize border Chromium draws around a frameless one, so the preload hangs thin
grips on the page's edges and the shell resizes the window as they are dragged
(`resizedBounds`).

There is no application menu attached to the frameless window. `commandForInput`
in `src/frame.js` answers the useful accelerators directly — matched on the
physical key as well as the letter, so Ctrl+R still reloads on a Cyrillic layout.

`--native-frame` (or `CYBERIA_NATIVE_FRAME=1`) hands the window back to the
desktop: the frame, the menu bar and its accelerators all become the system's
again. It is there for a window manager that decorates windows its own way.

## What the shell adds over a browser tab

- **Persistent session** — cookies and local storage live in the `persist:cyberia`
  partition, so a login survives restarts.
- **Link discipline** — only the bundled wallet may occupy the window. The
  public site, OAuth providers, explorer links and wallet schemes open in the
  system browser or their registered app.
- **Offline fallback** — `src/offline.html` replaces the network error page (in
  English or Russian, following the system language), names the failure —
  including the proxy that refused the connection — and reloads the site by
  itself once the connection returns. It also opens the proxy window, so a
  network that blocks Cyberia is answerable from the screen that reports it.
- **A proxy of its own** — chosen in the app, checked before it is kept, and
  pinned onto the session ahead of the desktop's own setting.
- **`cyberia://` deep links** — `cyberia://profile?tab=xp` focuses the running
  window and navigates it. Registered by the installers; `npm start` registers
  the dev binary.
- **A window of its own** — no system frame and no substitute title strip; the
  wallet itself fills and moves the window. See [The window](#the-window).
- **Tray and login startup** — closing the window keeps Cyberia in the system
  tray; _Quit_ there stops it. The wallet's Alerts & sound screen can register
  the packaged app to start hidden at login, with the tray as its way back.
- **System notifications and sounds** — the wallet can announce incoming
  transfers, messages and completed operations. The preference stays on the
  device; notification text contains no address, transaction hash or key
  material.
- **Remembered geometry** — window size and position are restored, and revalidated
  against the displays that currently exist.
- **A real BitTorrent client** — see below. This is the one capability the site
  cannot have on its own.
- **User agent** — `CyberiaDesktop/<version>` is appended so the site can tell it
  is running inside the app (`resources/js/lib/native.ts`).

## Torrents

The wallet's torrent screen is a downloader only inside this app, and that is
not a product decision: the mainline DHT is UDP and peers are reached over TCP,
and a web page has neither. What a page *can* reach — browser peers over WebRTC
— has almost no members for an ordinary magnet, so the browser build of that
screen explains this and links to the installer instead of shipping a client
that finds nobody.

- `src/torrent-engine.js` runs WebTorrent in an Electron `utilityProcess`:
  piece verification is CPU work that would otherwise compete with the window,
  and a client that dies on a malformed torrent should not take the wallet with
  it. DHT, peer exchange, trackers and local discovery are all on.
- `src/torrent.js` is the main process's side — it owns the download directory,
  the concurrency cap, and the one-time dialog that has to be agreed to before
  any socket opens. That dialog is where the true sentence gets said: **peers
  see your IP address, and the app's proxy setting does not cover this traffic**
  (that setting is for web requests; these are raw sockets).
- `src/preload.js` exposes it as `window.cyberiaNative.torrent`. The page may
  name a magnet and a file index — never a path. `read()` hands back one
  finished file under 10 MB, which is what the wallet pins to IPFS and mints
  against; anything larger is refused.
- `src/torrent-rules.js` holds the limits and the summary shape, and is tested
  under plain Node (`npm test`) like the navigation rules.
- Downloads land in `<Downloads>/Cyberia`. `CYBERIA_TORRENT_DIR` (an absolute
  path) moves that; it is an operator's setting, never the page's.
- WebTorrent is ESM with a top-level await, so it can only be loaded through a
  dynamic `import()` — and Node's ESM loader cannot read an asar archive. The
  engine and `node_modules` are therefore in `asarUnpack`.
- WebTorrent pulls one **optional** native module, `utp-native` (µTP peers).
  `electron-builder` rebuilds it during packaging; if a platform has no prebuild
  the client still runs, over TCP peers only. It also adds ~44 MB of unpacked
  `node_modules` to the installer.
- Bootstrap nodes are resolved to IPv4 in the engine rather than left to the
  DHT. Two of the three defaults have been unreliable for years and the third
  is IPv6-first; on a machine with no IPv6 route that leaves an empty routing
  table, and a client with no peers looks broken rather than blocked.

## Known limits

- Browser extensions do not exist in Electron, so there is no injected MetaMask.
  Connect wallets over WalletConnect (QR) — that path is already live on the site.
- Camera, microphone, geolocation, WebHID, and WebUSB are refused by
  `src/main.js`. Hardware wallets therefore need the WalletConnect route too.
- Installers are unsigned. macOS Gatekeeper and Windows SmartScreen will warn
  until a Developer ID / Authenticode certificate is wired into the build.
- The drawn menu bar is opened with the pointer: there is no Alt to walk it from
  the keyboard, the way there would be with a native one. Every command in it
  has a working accelerator, and `--native-frame` brings the native bar back.
