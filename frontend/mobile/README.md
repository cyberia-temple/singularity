# Cyberia Mobile

Capacitor shell that ships the Cyberia site (`backend/laravel`) as an Android and
iOS application.

Like the desktop shell it renders the live site rather than bundling it: the
native app is a WebView pointed at `https://cyberia.church`, so a production
deploy updates the app without a store release. The only local payload is
`www/`, the page shown when the site cannot be reached.

**The app is the Cyberia wallet.** It launches on `/wallet`, which renders
without the site header and footer inside a native shell and fills the screen
instead. The rest of Cyberia is a link away in the wallet's masthead; every
other route keeps the normal site chrome. The wallet needs no Cyberia account —
the keys are generated and encrypted in the browser — so the app is usable
straight after install.

## Requirements

- Node 20+ (Capacitor 8) — always installed.
- **Android:** JDK 21 and the Android SDK (`platform-tools`, `platforms;android-36`,
  `build-tools;36.0.0`). Point `ANDROID_HOME` at the SDK before building.
- **iOS:** macOS with Xcode 16+. Dependencies are Swift Package Manager, so no
  CocoaPods install is needed.

## Commands

```bash
npm install
npm run www             # regenerate the local fallback pages
npm run sync            # www + copy config/plugins into android/ and ios/
npm run assets          # regenerate icons and splash screens from resources/
npm run open:android    # open the project in Android Studio
npm run open:ios        # open the workspace in Xcode
npm run android:apk     # sync + assembleDebug -> android/app/build/outputs/apk/debug/
npm run android:release # sync + bundleRelease -> .aab for Play
npm test                # URL/navigation rules, no SDK needed
```

`android/` and `ios/` are committed: they carry the deep-link intent filters,
the URL scheme, and the generated icons, none of which Capacitor can regenerate
from config alone.

## Configuration

`CYBERIA_APP_URL` (default `https://cyberia.church`) decides what the app renders
and which hosts stay inside the WebView; `CYBERIA_APP_PATH` (default `/wallet`)
decides which route it launches on. Both are baked into the native project at
sync time, so re-sync after changing either:

```bash
CYBERIA_APP_URL=http://192.168.1.10:8000 npm run sync:android
CYBERIA_APP_PATH=/swap npm run sync:android
```

An `http://` URL automatically enables cleartext traffic for that build; anything
that is not `http`/`https` falls back to production. `CYBERIA_APP_PATH` must be a
same-origin absolute path: a full URL or `//host` falls back to `/wallet` rather
than pointing the whole app at another origin.

## Behaviour

- **Navigation** — `cyberia.church`, its subdomains, and the OAuth providers open
  in the app. Every other URL, including `wc:`, `metamask:`, `phantom:`, and
  `tg:`, is handed to Android/iOS, which is exactly what WalletConnect needs to
  hop into a wallet app and back.
- **Offline** — a failed load shows `www/error.html` (`server.errorPath`), which
  returns to the site as soon as the device is online.
- **Deep links** — `cyberia://feed` works on both platforms. `https://cyberia.church`
  links open the app once the site publishes the association files: set
  `APP_ANDROID_SHA256_FINGERPRINT` (and `APP_IOS_APP_ID`) in the Laravel `.env`,
  which turns on `/.well-known/assetlinks.json` and
  `/.well-known/apple-app-site-association`. On iOS also add the
  `applinks:cyberia.church` associated domain in Xcode — it needs a provisioning
  profile, so it is deliberately not committed.
- **Safe areas** — the WebView draws edge to edge (`ios.contentInset: 'never'`);
  the site pads itself with `env(safe-area-inset-*)`, which is why
  `app.blade.php` sets `viewport-fit=cover`.
- **User agent** — `CyberiaMobile/<version>` is appended so the site can tell it
  is running inside the app (`resources/js/lib/native.ts`).
- **Local vault** — Android backup is disabled, so the encrypted wallet vault
  and WebView storage stay on the device instead of entering a cloud backup.

## Signing and release

An APK is only installable if it is signed, and Android ties updates to the
signature: the same key has to sign every release forever, or users have to
uninstall before they can take the next one. So the key is created once and kept:

```bash
scripts/make-keystore.sh
```

It writes `android/cyberia-release.jks` and `android/keystore.properties` (both
git-ignored, both read by `app/build.gradle`), prints the SHA-256 fingerprint for
`APP_ANDROID_SHA256_FINGERPRINT`, and offers to upload the four repository
secrets CI needs: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. **Back the keystore and its password
up somewhere outside this repository** — losing them means the app can never be
updated in place again.

With the secrets in place:

```bash
git tag app-v1.0.0 && git push origin app-v1.0.0
```

builds a signed release APK, attaches it to the GitHub release as `Cyberia.apk`,
and https://cyberia.church/download starts offering it. Without them the workflow
still builds a *debug* APK for inspection but does not publish it, and the Android
card disappears from the download page rather than pointing at a file that is not
there — a debuggable wallet build is not something to hand strangers.

The tag is also the version: CI passes it in as `CYBERIA_VERSION_NAME`, with
`CYBERIA_VERSION_CODE` derived from it (`1.2.3` → `10203`), so nothing here has to
be committed per release.

## Store builds

Google Play and the App Store get the **store edition**: `npm run sync:play` /
`npm run sync:appstore` set `CYBERIA_STORE`, which appends
`CyberiaStore/<edition>` to the user agent, and the site leaves out what those
stores do not take from an unlicensed developer (the launchpad, tokenised
stocks, torrents on iOS) and keeps the app on `/wallet`. `npm run
android:bundle` builds the Play AAB. `.github/workflows/stores.yml` builds and
uploads both through `fastlane/Fastfile` (Play internal track, TestFlight),
with the listing text and graphics in `fastlane/metadata/`. Secrets and the
console steps are in `docs/developers/store-distribution.md`; `android:release`
still builds an AAB of the whole wallet, which is not the one to send to Play.

## Known limits

- **Web push does not reach the app.** Android WebView has no Push API, and iOS
  WKWebView only supports it for home-screen PWAs. The site's push subscriptions
  keep working in browsers; native notifications need
  `@capacitor/push-notifications` with FCM/APNs.
- **Store review is not guaranteed.** Apple's guideline 4.2 treats thin web
  wrappers poorly and 3.1.5(b) restricts crypto exchange functionality to the
  exchange's own developer account; Google Play has its own crypto policy. Direct
  APK distribution from cyberia.church has no such constraint.
- No in-app wallet is injected — the WalletConnect path is what mobile users get,
  same as mobile browsers.

## iPhone test build without a Mac

The `iOS test build` GitHub Actions workflow runs when a `codex/ios-test-*`
branch is pushed or when it is started manually in Actions (after the workflow
is present on the default branch).
It builds the iPhone device target on a macOS runner without an Apple signing
identity and uploads `Cyberia-unsigned.ipa` and its SHA-256 checksum for seven
days. The workflow has to be committed and pushed to GitHub first. This is an
unsigned personal test artifact, not an App Store or TestFlight release and it
cannot be installed directly by iOS.

To install it on an iPhone, set up [SideStore](https://docs.sidestore.io/docs/installation/prerequisites)
following its current Linux instructions, transfer the IPA to the phone, and
use SideStore to sign and install it with your Apple Account. Free-account apps
need periodic refresh and Apple limits the number of active apps. Device, iOS
version, SideStore setup and Apple account restrictions affect whether this
works. SideStore's own installation and pairing must be completed first.

The app loads the hosted site over the network. Test login, navigation, uploads
and recovery from lost connectivity on a real iPhone. For the wallet, test creation, recovery and
transaction signing with test funds only; WebView storage is separate from the
browser and other apps.
