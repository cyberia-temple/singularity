# Notes for the addons.mozilla.org reviewer

Paste this into **Notes to Reviewer** on the version's submission page, and
upload `Cyberia-extension-source.zip` as the source code.

---

Cyberia Wallet is a non-custodial EVM wallet. The seed phrase is generated in
the extension's background page, encrypted with the user's password
(AES-256-GCM, key from PBKDF2-SHA-256 with 310,000 iterations) and stored in
`storage.local`. It is never transmitted anywhere.

## What changed in 1.4.2

Only the manifest: `browser_specific_settings.gecko_android` is removed, because
approvals open in a window of their own (`windows.create`) and Firefox for
Android has no windows API — the add-on should not have been offered there.
The bundles are unchanged from 1.4.1. `web-ext lint` reports one warning,
`KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`, which concerns Android only.

## Building from the uploaded source

The add-on is bundled and minified with esbuild, so the uploaded source is what
produces it. The build is deterministic: the same source gives the same files.

Requirements: Node.js 22.2 or newer (built with Node 24.10.0, npm 11.6.1), on
Linux, macOS or Windows.

```bash
unzip Cyberia-extension-source.zip -d cyberia-extension
cd cyberia-extension
npm ci
npm run build
```

The Firefox package is the contents of `dist-firefox/` (the Chromium build in
`dist/` is produced alongside it and is not part of this submission). `npm test`
runs the unit tests. Source maps are shipped next to every bundle, so the
original source can also be read in the debugger.

Third-party code: `ethers` 6.16 (pinned in `package-lock.json`) for key
derivation, signing and ABI decoding, bundled from `node_modules`. Its licence
notices are kept in the `*.LEGAL.txt` files esbuild writes beside each bundle.

| Bundle | Source entry point |
|---|---|
| `background.js` | `src/background/index.js` |
| `content.js` | `src/content/bridge.js` |
| `inpage.js` | `src/inpage/provider.js` |
| `popup.js` | `src/popup/popup.js` |
| `onboarding.js` | `src/onboarding/onboarding.js` |

## How it reaches pages

There is no `content_scripts` entry and no `<all_urls>`. The EIP-1193 provider
is registered with `scripting.registerContentScripts` only for origins the user
has connected, from the popup's **Connect** button (which asks for that one
origin's host permission through `permissions.request`) or by approving a
site's `eth_requestAccounts` in the approval window. `inpage.js` runs in
`world: "MAIN"` because a dapp reads `window.ethereum`; it holds no keys and
only passes messages to `content.js`, which forwards them to the background
over a port. The background takes the origin from `sender.origin`, never from
the message.

## Permissions

| Permission | Why |
|---|---|
| `storage` | the encrypted vault, settings and per-site grants |
| `alarms` | auto-lock after inactivity |
| `scripting` | registering the provider for connected origins only |
| `activeTab` | reading which site the popup was opened on, to offer Connect |
| host permissions (fixed list) | the RPC nodes and token index the wallet reads balances from |
| optional `https://*/*`, `http://localhost/*` | requested per site when the user connects that site |
| optional `proxy`, `privacy` | only if the user turns on the relay (route the wallet's requests through a SOCKS5/Tor/I2P daemon they run) and to close WebRTC; requested in that click |

## Data

Declared in `data_collection_permissions` as `financialAndPaymentInfo` and
`websiteActivity`:

- the account address goes to each chain's RPC node and token index to read
  balances (rpc.cyberia.church, explorer.cyberia.church, and the public RPCs of
  Robinhood Chain, BNB Chain and Base);
- transactions the user approves are broadcast to that chain's RPC;
- a connected site's read-only JSON-RPC calls (`eth_call`, `eth_getLogs`, …)
  are forwarded to the chain's RPC; every signing method opens an approval
  window first.

The price request to `https://cyberia.church/api/wallet/prices` carries no
address or identifier. With the optional Firefox technical and interaction data permission, opening the wallet sends a random installation ID to Cyberia, which forwards the opening event to Google Analytics. No wallet data or connected-site information is included. There is no crash reporting or remote configuration.

## Testing it

1. Install, create a wallet in the tab that opens (or import a phrase).
2. Open any https dapp, e.g. https://cyberia.church/swap, click the toolbar
   icon and press **Connect**; the page reloads with `window.ethereum` present.
3. A transaction or signature request from the page opens an approval window
   that must be held to sign. `eth_sign` is refused by design.
