# addons.mozilla.org listing — Cyberia Wallet

Fields for the listing page. The summary has a 250-character limit; everything
else has none that matters here.

## Name

Cyberia Wallet

## Add-on URL (slug)

cyberia-wallet

## Summary (en-US)

Non-custodial wallet for Cyberia and other EVM networks. Keys are created and encrypted on your device and never leave it. Connect only the sites you choose, and approve every signature yourself.

## Summary (ru)

Некастодиальный кошелёк для Cyberia и других EVM-сетей. Ключи создаются и шифруются на вашем устройстве и никуда не уходят. Подключайте только выбранные сайты и подтверждайте каждую подпись сами.

## Description (en-US)

Cyberia Wallet keeps your keys in your browser and nowhere else.

**One phrase, every account.** Create a wallet or import the recovery phrase you already use on cyberia.church — the same phrase gives the same accounts. Hold CYBER and tokens on Cyberia, Robinhood Chain, BNB Chain and Base from one address.

**Sites see the wallet only when you say so.** The wallet does not appear on any website until you press Connect on it. A site you have not connected cannot even tell the wallet is installed.

**Every signature is yours.** Transactions and messages open in a separate window that shows what you are signing — an unlimited token approval is labelled as unlimited — and you hold the button to sign.

**Private by design.** No account or email. Extension openings are measured with Google Analytics; the privacy policy explains what is sent. An optional relay can route its requests through Tor, I2P or your own SOCKS5 proxy.

Requires Firefox 140 or newer.

## Description (ru)

Cyberia Wallet хранит ключи в вашем браузере и больше нигде.

**Одна фраза — все аккаунты.** Создайте кошелёк или импортируйте фразу восстановления, которой уже пользуетесь на cyberia.church: та же фраза даёт те же аккаунты. CYBER и токены в Cyberia, Robinhood Chain, BNB Chain и Base — на одном адресе.

**Сайты видят кошелёк, только когда вы разрешили.** Кошелёк не появляется ни на одном сайте, пока вы не нажмёте «Подключить». Неподключённый сайт даже не узнает, что кошелёк установлен.

**Каждая подпись — ваша.** Транзакции и сообщения открываются в отдельном окне, где видно, что именно вы подписываете (безлимитное разрешение на токен так и подписано), и подпись ставится удержанием кнопки.

**Приватность по устройству.** Без аккаунта и почты. Открытия расширения измеряются с помощью Google Analytics; состав данных описан в политике конфиденциальности. По желанию запросы можно пустить через Tor, I2P или свой SOCKS5-прокси.

Нужен Firefox 140 или новее.

## Categories

Privacy & Security (primary), Other

## Tags

crypto, wallet, ethereum, web3, privacy

## Support

- Homepage: https://cyberia.church/wallet
- Support site: https://cyberia.church

## License

MIT (as declared in `package.json`)

## Privacy policy

Paste `amo/privacy-policy.md`.

## Screenshots

Upload the four in `amo/screenshots/`, in order (1280×800, the size AMO
recommends). They are composed from a throwaway wallet in a real Firefox 154:
the onboarding tab, the popup's home screen, an approval window for a
`personal_sign` from cyberia.church, and the relay screen.

## Fixing the live listing (1.4.1, public since 2026-10-13)

The first submission went up with the manifest's text only, so the public page
at https://addons.mozilla.org/firefox/addon/cyberia-wallet/ is thin. In the
Developer Hub → Cyberia Wallet → **Edit Product Page**:

1. **Locale.** The listing was created from a Russian-language session, so `ru`
   is its default locale and currently holds the *English* manifest text. Put
   the Russian name/summary/description above into `ru`, then switch the
   editing locale to **English (US)** and paste the English ones.
2. **Categories:** Privacy & Security (it is listed under Other only).
3. **Privacy policy:** paste `amo/privacy-policy.md` (the page has none).
4. **Screenshots:** the four files above (the page has none).
5. **Support:** homepage https://cyberia.church/wallet, support site
   https://cyberia.church.
6. **Android.** 1.4.1 is listed for Firefox for Android because its manifest
   carried `gecko_android`; signing cannot work there (no windows API for the
   approval window). 1.4.2 drops the key — upload `Cyberia-extension-firefox.zip`
   from the `app-v1.4.2` GitHub release through **Upload New
   Version** with the source zip and `amo/reviewer-notes.md`, and the Android
   listing goes away with it.
