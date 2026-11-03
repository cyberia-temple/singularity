import type { Messages } from '@/composables/useLocale';

/**
 * Strings for /download.
 *
 * Translated for the same reason the wallet is: an install warning somebody
 * cannot read is an install they abandon — and this page is mostly warnings,
 * because none of these builds are signed.
 */
export const downloadMessages: Messages = {
    en: {
        eyebrow: 'Apps',
        title: 'Download',
        intro: 'The Cyberia wallet as a native app. It wraps the live site, so it updates when the site does — you only ever reinstall when the app itself changes.',
        version: 'Version {version}',
        published: 'published {date}',
        unpublished: 'No build has been published yet.',
        unpublishedHint:
            'The installers are built and released from the repository. Until the first release is tagged, run the app from source.',
        unverified:
            'GitHub could not be reached, so the version and size are unknown. The links below always point at the newest release.',
        forYou: 'For this device',
        otherPlatforms: 'Other platforms',
        download: 'Download',
        notPublished: 'Not published yet',
        buildFromSource: 'Build from source',
        windows: 'Windows',
        macos: 'macOS',
        linux: 'Linux',
        android: 'Android',
        ios: 'iPhone and iPad',
        extension: 'Browser extension',
        'extension-zip': 'Chrome · Brave · Edge',
        'extension-firefox': 'Firefox',
        'windows-installer': 'Installer',
        'windows-portable': 'Portable, no install',
        'macos-arm64': 'Apple Silicon',
        'macos-x64': 'Intel',
        'linux-appimage': 'AppImage',
        'linux-deb': 'Debian / Ubuntu',
        'android-apk': 'APK',
        windowsNote:
            'The installer is not signed, so Windows shows “Windows protected your PC”. Choose More info, then Run anyway.',
        macosNote:
            'The app is not signed, so the first launch has to be right-click → Open → Open. After that it opens normally.',
        linuxNote:
            'Make the AppImage executable (chmod +x) and run it, or install the .deb with your package manager.',
        androidNote:
            'The full wallet — sending, swaps, the bridge — is this APK, or the web app: open cyberia.church/wallet in Chrome → ⋮ → Install app. Android asks once to allow installs from your browser. The Google Play build is the social edition: feed, chat and DAO.',
        iosNote:
            'There is no App Store build. Open cyberia.church in Safari, tap Share, then Add to Home Screen — the wallet runs full screen and works offline the same way.',
        extensionNote:
            'Chrome, Brave and Edge: unzip, open chrome://extensions, turn on Developer mode, press Load unpacked. Firefox 128+: unzip, open about:debugging#/runtime/this-firefox and Load Temporary Add-on on manifest.json — until the build is signed, Firefox keeps it only until you close it. Unlike the apps, the extension is a wallet of its own: it signs for dapps in the page, and importing the same seed phrase gives the same accounts.',
        openInBrowser: 'Open the wallet in the browser',
        webAlternative:
            'You do not need any of this to use the wallet — it runs in a browser tab, with the same keys.',
        keysNote:
            'The apps are the same shell around cyberia.church; the browser extension is the one build that holds its own vault. Either way keys are generated on your device and encrypted with your password, and installing nothing sends them anywhere.',
        checksums: 'SHA-256 checksums',
        allReleases: 'All releases',
        sourceCode: 'Source code',
    },
    ru: {
        eyebrow: 'Приложения',
        title: 'Скачать',
        intro: 'Кошелёк Cyberia как приложение. Внутри — живой сайт, поэтому приложение обновляется вместе с ним: переустановка нужна, только когда меняется сама оболочка.',
        version: 'Версия {version}',
        published: 'опубликовано {date}',
        unpublished: 'Сборка ещё не опубликована.',
        unpublishedHint:
            'Установщики собираются и публикуются из репозитория. Пока первый релиз не выпущен, приложение можно запустить из исходников.',
        unverified:
            'GitHub недоступен, поэтому версия и размер неизвестны. Ссылки ниже всегда ведут на самый свежий релиз.',
        forYou: 'Для этого устройства',
        otherPlatforms: 'Другие платформы',
        download: 'Скачать',
        notPublished: 'Пока не опубликовано',
        buildFromSource: 'Собрать из исходников',
        windows: 'Windows',
        macos: 'macOS',
        linux: 'Linux',
        android: 'Android',
        ios: 'iPhone и iPad',
        extension: 'Расширение для браузера',
        'extension-zip': 'Chrome · Brave · Edge',
        'extension-firefox': 'Firefox',
        'windows-installer': 'Установщик',
        'windows-portable': 'Портативная, без установки',
        'macos-arm64': 'Apple Silicon',
        'macos-x64': 'Intel',
        'linux-appimage': 'AppImage',
        'linux-deb': 'Debian / Ubuntu',
        'android-apk': 'APK',
        windowsNote:
            'Установщик без подписи, поэтому Windows покажет «Система Windows защитила ваш компьютер». Нажмите «Подробнее» → «Выполнить в любом случае».',
        macosNote:
            'Приложение без подписи, поэтому первый запуск — правой кнопкой → «Открыть» → «Открыть». Дальше открывается обычно.',
        linuxNote:
            'Сделайте AppImage исполняемым (chmod +x) и запустите, либо установите .deb пакетным менеджером.',
        androidNote:
            'Полный кошелёк — переводы, обмен, мост — это этот APK или веб-приложение: откройте cyberia.church/wallet в Chrome → ⋮ → «Установить приложение». Android один раз попросит разрешить установку из браузера. Версия в Google Play — социальная: лента, чат и DAO.',
        iosNote:
            'Сборки для App Store нет. Откройте cyberia.church в Safari, нажмите «Поделиться» → «На экран «Домой»» — кошелёк откроется на весь экран.',
        extensionNote:
            'Chrome, Brave, Edge: распакуйте архив, откройте chrome://extensions, включите режим разработчика и нажмите «Загрузить распакованное расширение». Firefox 128+: распакуйте, откройте about:debugging#/runtime/this-firefox и «Загрузить временное дополнение», выбрав manifest.json — пока сборка не подписана, Firefox держит её только до закрытия браузера. В отличие от приложений, расширение — самостоятельный кошелёк: оно подписывает транзакции прямо на странице сайта, а с той же seed-фразой счета будут те же.',
        openInBrowser: 'Открыть кошелёк в браузере',
        webAlternative:
            'Ничего из этого не обязательно: кошелёк работает во вкладке браузера с теми же ключами.',
        keysNote:
            'Приложения — одна и та же оболочка вокруг cyberia.church; расширение для браузера — единственная сборка со своим хранилищем. В обоих случаях ключи создаются на устройстве и шифруются вашим паролем, и установка никуда их не отправляет.',
        checksums: 'Контрольные суммы SHA-256',
        allReleases: 'Все релизы',
        sourceCode: 'Исходный код',
    },
    zh: {
        eyebrow: '应用',
        title: '下载',
        intro: 'Cyberia 钱包的原生应用版本。它包着的是线上的网站，所以网站更新它就更新 — 只有外壳本身变了，你才需要重装。',
        version: '版本 {version}',
        published: '发布于 {date}',
        unpublished: '还没有发布过任何版本。',
        unpublishedHint:
            '安装包由代码仓库构建和发布。在第一个版本打好标签之前，可以从源码运行。',
        unverified:
            '连不上 GitHub，所以版本号和大小未知。下面的链接始终指向最新的发布。',
        forYou: '适合这台设备',
        otherPlatforms: '其他平台',
        download: '下载',
        notPublished: '尚未发布',
        buildFromSource: '从源码构建',
        windows: 'Windows',
        macos: 'macOS',
        linux: 'Linux',
        android: 'Android',
        ios: 'iPhone 和 iPad',
        extension: '浏览器扩展',
        'extension-zip': 'Chrome · Brave · Edge',
        'extension-firefox': 'Firefox',
        'windows-installer': '安装程序',
        'windows-portable': '便携版，免安装',
        'macos-arm64': 'Apple 芯片',
        'macos-x64': 'Intel',
        'linux-appimage': 'AppImage',
        'linux-deb': 'Debian / Ubuntu',
        'android-apk': 'APK',
        windowsNote:
            '安装程序没有签名，所以 Windows 会弹出“Windows 已保护你的电脑”。点“更多信息”，然后点“仍要运行”。',
        macosNote:
            '应用没有签名，所以第一次打开必须右键 →“打开”→“打开”。之后就能正常打开了。',
        linuxNote:
            '给 AppImage 加上可执行权限（chmod +x）再运行，或者用你的包管理器安装 .deb。',
        androidNote:
            '完整钱包（转账、兑换、跨链桥）就是这个 APK，或者网页应用：在 Chrome 中打开 cyberia.church/wallet → ⋮ → 安装应用。第一次安装时 Android 会请求允许从浏览器安装。Google Play 版本是社交版：动态、聊天和 DAO。',
        iosNote:
            '没有 App Store 版本。用 Safari 打开 cyberia.church，点“分享”，再点“添加到主屏幕” — 钱包会全屏运行，离线也一样能用。',
        extensionNote:
            'Chrome、Brave、Edge：解压，打开 chrome://extensions，开启开发者模式，点“加载已解压的扩展程序”。Firefox 128+：解压，打开 about:debugging#/runtime/this-firefox，选 manifest.json 点“临时载入附加组件” — 在这个版本被签名之前，Firefox 只保留到你关掉浏览器为止。和应用不同，这个扩展是一个自己的钱包：它在网页里为 dapp 签名，导入同一组助记词就会得到同样的账户。',
        openInBrowser: '在浏览器里打开钱包',
        webAlternative:
            '这些你一样都不需要也能用钱包 — 它就在浏览器标签页里跑，用的是同样的密钥。',
        keysNote:
            '这些应用都是包着 cyberia.church 的同一层外壳；浏览器扩展是唯一有自己保险库的一个。无论哪种，密钥都在你的设备上生成、用你的密码加密，装什么都不会把它们发到任何地方。',
        checksums: 'SHA-256 校验和',
        allReleases: '全部发布',
        sourceCode: '源代码',
    },
};
