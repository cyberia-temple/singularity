/**
 * The store editions of the mobile app.
 *
 * `frontend/mobile` is one shell with three ways out of the building: the APK
 * this site serves at /download, the Google Play build and the App Store
 * build. The first is the whole wallet. The other two are reviewed by
 * somebody else's rules, and every one of those rules reads the live site the
 * shell renders as part of the app — so a store build appends
 * `CyberiaStore/<edition>` to its user agent and the wallet leaves out exactly
 * what that store does not take from an unlicensed developer:
 *
 * - the launchpad: minting and selling a new token is what Apple's 3.1.5(iv)
 *   calls an ICO and reserves for banks and brokers, and it is what Play's
 *   financial-services declaration asks a licence for;
 * - tokenised stocks: trading a share, however it is wrapped, is securities
 *   trading under both stores' policies;
 * - torrents and the tracker, on the App Store only: Apple has never listed a
 *   BitTorrent client, and the wallet's own screen there is only a pointer to
 *   the desktop app anyway.
 *
 * Prediction markets and the rest of the site are not wallet screens at all;
 * `App\Http\Middleware\ConfineStoreEdition` keeps a store build on the wallet,
 * which is the half of this that a page cannot be talked out of.
 *
 * The browser, the desktop app, the extension and the APK never carry the
 * token, so nothing changes for them. Pinned in
 * `tests/Frontend/StoreEditionTest.mjs`.
 */

export type StoreEdition = 'play' | 'appstore';

const STORE_TOKEN = /\bCyberiaStore\/(play|appstore)\b/;

/**
 * The Google Play build is the social half of the wallet and nothing else: no
 * balances, sending, swaps, NFTs, domains, DAO or token screens. Play asks an
 * organisation account for anything that holds or moves crypto, so this build
 * lists what it shows rather than what it hides — a screen added later stays
 * out of it until somebody puts it here.
 */
const PLAY_SCREENS: readonly string[] = [
    'feed',
    'profile',
    'chat',
    'preferences',
    'security',
];

/** Where a store build lands when it has no portfolio to show. */
export function homeScreenIn(edition: StoreEdition | null): string {
    return edition === 'play' ? 'feed' : 'portfolio';
}

/** Whether this build has no balances, sending or swapping at all. */
export function socialOnlyIn(edition: StoreEdition | null): boolean {
    return edition === 'play';
}

const HIDDEN: Record<StoreEdition, readonly string[]> = {
    play: [],
    appstore: [
        'launchpad',
        'stocks',
        'arena',
        'shop',
        'torrent',
        'tracker',
        'trackerPublish',
    ],
};

/** Rows of The Wired that lead off the wallet onto a page a store build cannot open. */
const HIDDEN_DAPPS = [
    'launchpad',
    'predictions',
    'staking',
    'lending',
    'tokens',
];

export function storeEditionOf(userAgent: string): StoreEdition | null {
    const match = STORE_TOKEN.exec(userAgent);

    return match ? (match[1] as StoreEdition) : null;
}

let detected: StoreEdition | null | undefined;

/** The edition this page runs in, or null outside a store build. */
export function storeEdition(): StoreEdition | null {
    if (detected === undefined) {
        detected =
            typeof navigator === 'undefined'
                ? null
                : storeEditionOf(navigator.userAgent);
    }

    return detected;
}

export function isHiddenIn(
    edition: StoreEdition | null,
    section: string,
): boolean {
    if (edition === 'play') {
        return !PLAY_SCREENS.includes(section);
    }

    return edition !== null && HIDDEN[edition].includes(section);
}

/** Whether a wallet screen is left out of this build. */
export function hiddenInStore(section: string): boolean {
    return isHiddenIn(storeEdition(), section);
}

/** A list of screens without the ones this build leaves out. */
export function visibleInStore<T extends string>(sections: readonly T[]): T[] {
    return sections.filter((section) => !hiddenInStore(section));
}

/** A list of screens without the ones this build leaves out. */
export function homeScreen(): string {
    return homeScreenIn(storeEdition());
}

export function socialOnly(): boolean {
    return socialOnlyIn(storeEdition());
}

export function isDappHiddenIn(
    edition: StoreEdition | null,
    key: string,
): boolean {
    return edition !== null && HIDDEN_DAPPS.includes(key);
}
