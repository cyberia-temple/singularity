# Cyberia Wallet — browser extension

A Manifest V3 wallet for Chrome, Brave, Edge and Firefox 140+. It holds its own
encrypted vault, injects an EIP-1193 provider into the sites you grant it, and
signs transactions and messages for them.

**This is the one build that is not a shell around cyberia.church.** The desktop
and mobile apps render the live site, so a deploy updates them; an extension
cannot do that — a dapp expects `window.ethereum` in its own page, and the code
that answers it has to be installed. The seed phrase is the bridge: import the
phrase you already use in the wallet on the site and both surfaces derive the
same accounts, because both derive `m/44'/60'/0'/0/{index}`.

EVM only, on purpose. A dapp speaks EIP-1193, and EIP-1193 is EVM; Solana,
Monero and the Bitcoin family live in the wallet on the site, where they have
screens instead of a provider.

## Commands

```bash
npm install
npm test             # the rules worth pinning: derivation, permissions, calldata, vault
npm run build        # dist/ (Chromium) and dist-firefox/ (Gecko)
npm run zip          # both zips (the files /download hands out) + the source zip AMO asks for
```

## Two builds, one source

The engines disagree about exactly three things, and `manifest.mjs` plus one
esbuild `define` is the whole of it:

| | Chromium | Firefox |
|---|---|---|
| background | `service_worker` | `scripts` + `"type": "module"` (event page) |
| namespace | `chrome.*` | `browser.*` — promises, which is what this code awaits |
| identity | id from the key | `browser_specific_settings.gecko.id`, needed to sign |

Everything else — vault, provider, popup, tests — is the same bytes. The source
carries no `if (firefox)` branch except where the two genuinely offer different
capabilities, which is the relay below.

## Installing a build

```text
Chrome · Brave · Edge   chrome://extensions → Developer mode → Load unpacked → dist/
Firefox 140+            about:debugging#/runtime/this-firefox → Load Temporary
                        Add-on → dist-firefox/manifest.json
```

Firefox users install from addons.mozilla.org (see _Publishing on
addons.mozilla.org_ below); for Chromium a release is still a zip, and an
unpacked extension stays installed. A build loaded temporarily into Firefox
goes away when it closes.
During development point the browser at the unpacked directory: `npm run build`
rewrites both and the extension reloads with one click.

## What it does, and what it refuses to

- **The page never touches the vault.** A content script bridges the page to a
  service worker over a port; the sealed vault and the signer live in the worker.
  A malicious page can ask — it cannot read.
- **Permissions are per origin.** There is no `<all_urls>` content script.
  `src/background/injection.js` registers the provider at runtime for the origins
  you granted and nowhere else. A site is granted from the popup's **Connect**
  row, which asks the browser for that one origin's host permission in the click
  and reloads the tab — the only way in, since a page without the provider has
  nothing to send `eth_requestAccounts` through. So a random tab cannot
  fingerprint you by asking whether a wallet exists. Revoking an origin unregisters it on the next load and
  rejects anything it left waiting.
- **Every signature stops at a human.** `PASSTHROUGH_METHODS` is the complete
  list of calls that reach the chain without asking you, and a test asserts no
  signing method appears in it. Approvals open in their own window: a toolbar
  popup closes when you click the page behind it, and a prompt that vanishes
  mid-read teaches people to click before reading.
- **An unlimited approval is named as one.** `src/shared/tx.js` reads the
  calldata and says `UNLIMITED` where a dapp asked for an infinite allowance,
  instead of rendering a 78-digit number nobody parses.
- **`eth_sign` is not supported.** It signs 32 arbitrary bytes that can be a
  transaction hash; there is no preview that makes that safe.
- **Limited usage analytics.** Opening the wallet sends a random installation ID
  to Cyberia, which forwards an opening event to Google Analytics. Firefox sends
  this only when its optional technical and interaction data permission is granted.
  No wallet addresses, connected sites or secrets are included. No crash reporter,
  remote config or hosted token list. Balances and tokens come from the chain's own RPC and its
  keyless Blockscout index; USD quotes come from this project's own endpoint and
  a quote that cannot be read stays `null` and renders as a dash.
- **No fonts are fetched.** The stylesheet declares the same stack as the site
  (`Space Grotesk`, `IBM Plex Mono`) and falls back to what the machine has —
  asking a font CDN on every popup open would announce each time you looked at
  your balance.

## The relay

This is the one place where the browser you use changes what the wallet can
honestly offer, so the popup says which one you are getting:

- **Firefox** has `proxy.onRequest`, which asks the extension about each request
  individually. So the default is what the design wanted: the wallet's own RPC,
  token-index and price traffic goes through the relay, and the rest of the
  browser is untouched. A second toggle extends it to every tab if you want that.
- **Chromium** has only `proxy.settings`, which is one setting for the *entire
  browser*. There is no per-extension route in MV3, so turning the relay on
  routes every tab — and the popup carries that sentence permanently instead of
  implying a private tunnel.

Four routes — direct, a SOCKS5 daemon you name, Tor (`127.0.0.1:9050`) and I2P
(`127.0.0.1:4444`). Nothing is bundled and nothing is started; the extension only
points at a daemon that is already running. Either engine fails closed: when the
daemon stops answering, requests fail instead of falling back to your own line.
Localhost always bypasses, so a relay never hides a node on this machine, and on
Firefox names are resolved through the relay (`proxyDNS`) — a DNS lookup that
leaves directly announces every host the wallet talks to.

`proxy` and `privacy` are **optional permissions**, asked for in the click that
turns the relay on and never at install time. WebRTC is closed with
`webRTCIPHandlingPolicy` on Chromium and `peerConnectionEnabled` on Firefox,
which is the same question in the two dialects.

## Layout

```text
manifest.json          MV3: no content_scripts, narrow host_permissions
manifest.mjs           the Gecko dialect of it, and the two build targets
build.mjs              esbuild bundle + static copy + a deterministic zip writer
src/shared/            pure: chains, origins/grants, formatting, calldata reading
src/background/        service worker: vault, keyring, rpc, permissions, requests, relay
src/content/bridge.js  isolated world; the only thing that may hold a port
src/inpage/provider.js page world; EIP-1193 + EIP-6963, holds nothing
src/popup/             the 348px popup: home, receive, send, accounts, sites, relay,
                       connect/sign approvals, locked
src/onboarding/        create or import a phrase, in a tab
```

The vault is AES-256-GCM under a PBKDF2-SHA-256 key (310k iterations), byte-for-
byte the format `backend/laravel/resources/js/lib/wallet/vault.ts` writes, so one
audit covers both. An unlocked session keeps the **key** in
`chrome.storage.session` — memory that survives the service worker being evicted
but not the browser closing — and the phrase is decrypted for the length of one
signature and dropped. Auto-lock is 15 minutes by default.

## Releases

The zip ships with the apps, from the same tag:

```bash
git tag app-v1.0.0 && git push origin app-v1.0.0
```

`.github/workflows/apps.yml` runs the tests, writes the tag into `package.json`
(and from there into both manifests), packs `Cyberia-extension.zip` and
`Cyberia-extension-firefox.zip`, and attaches them to the GitHub release that
https://cyberia.church/download reads. The names carry no version, so
`/releases/latest/download/Cyberia-extension.zip` and
`https://cyberia.church/download/extension` are permanent addresses. Renaming one
means editing `manifest.mjs`, the workflow **and**
`backend/laravel/config/downloads.php` together.

The zip is written without timestamps, so two builds of the same source are the
same bytes and the published checksum means something.

## Publishing on addons.mozilla.org

The Firefox build is a **listed** add-on, live since 2026-10-13 (1.4.1) at
https://addons.mozilla.org/firefox/addon/cyberia-wallet/ — it installs from AMO
and updates itself. Desktop only: approvals open with `windows.create` and
Firefox for Android has no windows API, so the manifest carries no
`gecko_android` key, which is what AMO reads as Android support. Everything AMO
asks for is in `amo/`:

- `amo/listing.md` — name, summary, description (en, ru), categories, links;
- `amo/privacy-policy.md` — the policy text for the listing;
- `amo/reviewer-notes.md` — what to paste into *Notes to Reviewer*: how to
  rebuild the package, what each permission is for, what data leaves;
- `amo/screenshots/` — the listing's screenshots, 1280×800.

```bash
npm ci && npm test && npm run zip
npx web-ext lint --source-dir=dist-firefox      # the linter AMO runs
```

The linter must report 0 errors and exactly one warning,
`KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` — it is about Android, which
this add-on does not claim (see the comment in `manifest.mjs`).

A new version goes up from the add-on's page in the Developer Hub (*Upload New
Version*; the first one went through https://addons.mozilla.org/developers/addon/submit/):
upload `Cyberia-extension-firefox.zip`, answer **yes** to "does it use minified or
bundled code", and upload `Cyberia-extension-source.zip` — AMO rejects a bundled
add-on without its source, and the source zip is exactly the files `npm ci &&
npm run build` needs to reproduce `dist-firefox/` byte for byte.

AMO takes no new add-on without a data declaration, so `manifest.mjs` writes
`data_collection_permissions` into the Gecko manifest (`financialAndPaymentInfo`
and `websiteActivity` — the address goes to RPC nodes, and a connected site's
calls are forwarded to them; the reasoning is in `DATA_COLLECTION`), and Firefox
shows it in its own install prompt from **140**, which is why that is the
floor.

**One version everywhere, and the tag is it.** `/download`, addons.mozilla.org
and the Chrome Web Store carry the same build under the same number, and that
number is the `app-v*` tag: CI writes it into `package.json` and from there into
both manifests. Never bump `package.json` by hand for a store upload — that is
how the three channels drifted to 1.4.0, 1.4.1 and a different extension
altogether. To ship: cut a tag, then upload **the files from that GitHub
release** (`Cyberia-extension-firefox.zip` + `Cyberia-extension-source.zip` to
AMO, `Cyberia-extension.zip` to the Chrome Web Store). A local `npm run zip` at
the tagged commit produces the same bytes, which is how to check them.

Signing an *unlisted* build for side-loading still works with the same
`gecko.id` if it is ever needed:

```bash
npx web-ext sign --source-dir=dist-firefox --channel=unlisted \
    --api-key="$AMO_JWT_ISSUER" --api-secret="$AMO_JWT_SECRET"
```

The credentials come from https://addons.mozilla.org/developers/addon/api/key/
and belong in the environment, never in this repository.

## Publishing on the Chrome Web Store

The Chromium build goes to the Chrome Web Store as an update of the item first
submitted as the one-button phrase generator (1.0.0), so its id and users carry
over. Upload `Cyberia-extension.zip`; every dashboard answer — description,
single purpose, a justification per permission, the data disclosure, test
instructions — is in `cws/listing.md`, with 1280×800 screenshots taken in
Chromium in `cws/screenshots/` and the 440×280 tile in `cws/promo-440x280.png`.
The privacy policy URL the item declares,
https://cyberia.church/privacy/cyberia-wallet-extension.html, is
`backend/laravel/public/privacy/cyberia-wallet-extension.html` and is deployed
with the site.

## Known limits

- **Firefox 140 or newer.** That is where Firefox shows the add-on's data
  declaration in its install prompt (and `world: "MAIN"` for a registered
  content script, without which the provider cannot reach a page, landed in
  128) — so `strict_min_version` refuses an older Firefox.
- **An unsigned Firefox build is temporary.** A build loaded from
  `about:debugging` goes away when Firefox closes; the AMO install does not.
- **No hardware wallets, no WalletConnect, no token approvals screen.** The
  extension signs what a dapp asks for; managing existing allowances is the
  site's job.
- **A pending request dies with the service worker.** The port from the page
  keeps the worker alive while it waits, and if the browser tears everything down
  anyway the page gets a rejection rather than a promise that never settles.
