# Chrome Web Store — Cyberia Wallet (full wallet)

Everything the Developer Dashboard (https://chrome.google.com/webstore/devconsole)
asks for, in its own order. This is an **update of the existing item** — the one
first submitted as the one-button phrase generator (1.0.0, built from
`~/random/cyberia-wallet-chrome`) — so the item id, its users and its reviews stay.

## Package

`.github/workflows/stores.yml` uploads and submits the package through the
Chrome Web Store API v2 on every `app-v*` tag (staged: it goes live when
somebody presses Publish after review); see
`docs/developers/store-distribution.md` for the secrets. By hand: upload
**`Cyberia-extension.zip` from the `app-v*` GitHub release** under
*Package → Upload new package* — the same version the Firefox add-on and
`/download` carry (the tag is the version; see the README). 1.4.2 is higher than
the item's 1.0.0, which is all the store requires. To check the file, run at the
tagged commit:

```bash
npm ci && npm test && npm run zip   # the same bytes as the release asset
```

This version asks for permissions 1.0.0 did not (it had none), so Chrome will ask
anyone who installed 1.0.0 to accept them before it updates, and the review is a
full one rather than an automated pass.

## Store listing

**Name:** Cyberia Wallet (from the manifest)

**Summary** (from the manifest, 132 characters max):
Non-custodial wallet for Cyberia and other EVM chains. Keys are generated on this device and never leave it.

**Description**

Cyberia Wallet keeps your keys in your browser and nowhere else.

One phrase, every account. Create a wallet or import the recovery phrase you already use on cyberia.church — the same phrase gives the same accounts. Hold CYBER and tokens on Cyberia, Robinhood Chain, BNB Chain and Base from one address.

Sites see the wallet only when you say so. The wallet does not appear on any website until you press Connect on it. A site you have not connected cannot even tell the wallet is installed.

Every signature is yours. Transactions and messages open in a separate window that shows what you are signing — an unlimited token approval is labelled as unlimited — and you hold the button to sign.

Private by design. No account or email. Extension openings are measured with Google Analytics; the privacy policy explains what is sent. An optional relay can route its requests through Tor, I2P or your own SOCKS5 proxy; Chrome applies it to the whole browser, and the wallet tells you so before you turn it on.

**Category:** Tools (Productivity)

**Language:** English

**Graphic assets**

- Store icon: from the package (`icons/icon-128.png`)
- Screenshots, in this order (1280×800, taken in Chromium 155 from this build):
  1. `cws/screenshots/1-onboarding.png` — create or import
  2. `cws/screenshots/2-home.png` — the popup
  3. `cws/screenshots/3-approval.png` — a signature request from cyberia.church
  4. `cws/screenshots/4-relay.png` — the relay, with Chrome's whole-browser warning
- Small promo tile: `cws/promo-440x280.png`
- Marquee: optional, not prepared

**Homepage URL:** https://cyberia.church/wallet

**Support URL:** https://cyberia.church

**Mature content:** No

## Store listing — Russian

Dashboard → Store listing → language *Русский*. The name and the summary come
from the manifest and stay English; the description is per language.

**Description (ru)**

Cyberia Wallet хранит ключи в вашем браузере и больше нигде.

Одна фраза — все аккаунты. Создайте кошелёк или импортируйте фразу восстановления, которой уже пользуетесь на cyberia.church: та же фраза даёт те же аккаунты. CYBER и токены в Cyberia, Robinhood Chain, BNB Chain и Base — на одном адресе.

Сайты видят кошелёк, только когда вы разрешили. Кошелёк не появляется ни на одном сайте, пока вы не нажмёте «Подключить». Неподключённый сайт даже не узнает, что кошелёк установлен.

Каждая подпись — ваша. Транзакции и сообщения открываются в отдельном окне, где видно, что именно вы подписываете (безлимитное разрешение на токен так и подписано), и подпись ставится удержанием кнопки.

Приватность по устройству. Без аккаунта и почты. Открытия расширения измеряются с помощью Google Analytics; состав данных описан в политике конфиденциальности. По желанию запросы можно пустить через Tor, I2P или свой SOCKS5-прокси; Chrome применяет его ко всему браузеру, и кошелёк предупреждает об этом до включения.

## Privacy practices

**Single purpose**

A non-custodial crypto wallet for EVM networks: it keeps the user's keys encrypted in the browser, shows their balances, sends the transactions they approve, and lets websites the user connects ask them to sign.

**Permission justifications**

| Permission | Justification to paste |
|---|---|
| `storage` | Stores the user's encrypted wallet vault, their settings and the list of websites they connected. |
| `alarms` | Locks the wallet automatically after the inactivity period the user chose. |
| `scripting` | Registers the wallet's provider script (window.ethereum) only on websites the user connected, via scripting.registerContentScripts. There is no static content script and no access to sites the user did not connect. |
| `activeTab` | Reads which website the popup was opened on, so the popup can offer to connect that one site. |
| `proxy` (optional) | Requested only when the user turns on the relay, to route the wallet's network requests through a SOCKS5, Tor or I2P service the user runs. Chrome applies it to the whole browser; the wallet says so on that screen. |
| `privacy` (optional) | Requested together with the relay, to set webRTCIPHandlingPolicy so WebRTC cannot reveal the user's IP address around the relay. |
| Host permissions | The fixed hosts are the blockchain RPC nodes and token index the wallet reads balances from and broadcasts approved transactions to (rpc.cyberia.church, explorer.cyberia.church, Robinhood Chain, BNB Chain and Base public RPCs) and cyberia.church for USD prices. The optional `https://*/*` and `http://localhost/*` are never requested at install: when the user presses Connect on a site, the wallet asks Chrome for that one site's origin only. |

**Remote code:** No, I am not using remote code. All JavaScript is in the package
(bundled with esbuild, minified, with source maps included); the content security
policy allows scripts from the extension only. Data from RPC nodes is JSON and is
never executed.

**Data usage** — what to tick:

- [x] **Financial and payment information** — the user's public wallet address goes
  to the blockchain RPC nodes and token index to read balances, and transactions the
  user approves are broadcast to them.
- **Extension usage:** a random installation identifier and an extension-open event
  are sent to Cyberia and forwarded to Google Analytics. Review the current Chrome
  Web Store data-use categories and update the dashboard before publishing.
- The recovery phrase, keys and password never leave the device. No browsing
  history, page content or personal communications are sent.

Certify all three: not sold or transferred to third parties outside the approved use
cases; not used or transferred for purposes unrelated to the single purpose; not used
or transferred to determine creditworthiness or for lending.

**Privacy policy URL:** https://cyberia.church/privacy/cyberia-wallet-extension.html
(source: `backend/laravel/public/privacy/cyberia-wallet-extension.html`; rewritten
for the full wallet on 2026-10-15 — it described the 1.0.0 generator before).

## Test instructions (optional tab)

No account or setup is needed.

1. After install a tab opens: press **Create wallet** (or Import phrase) and set a password.
2. Open https://cyberia.church/swap, click the toolbar icon and press **Connect**;
   the page reloads with the wallet's provider present.
3. Anything the page asks to sign opens an approval window that must be held to sign;
   **Reject** returns an error to the page. `eth_sign` is refused by design.
4. The relay (popup footer → relay) is optional and needs a SOCKS5/Tor/I2P service
   running locally; it can be left off for review.

## Distribution

Public, all regions — unchanged from 1.0.0.
