import { computed, ref, watch, watchEffect } from 'vue';
import {
    CUSTOM_PALETTE,
    DEFAULT_PALETTE,
    derivePalette,
    paletteCss,
    readCustomTheme,
    readPalette,
    writeCustomTheme,
    writePalette,
} from '@/lib/wallet/theme';
import type { CustomTheme } from '@/lib/wallet/theme';

export const WALLET_THEMES = ['system', 'dark', 'light'] as const;

export type WalletTheme = (typeof WALLET_THEMES)[number];

/**
 * What the wallet is actually painted as, once `system` has been resolved.
 * `data-cw-theme` is written with this and never with the preference, so the
 * stylesheet only ever has two *faces* to define per palette.
 */
export type WalletScheme = 'dark' | 'light';

const STORAGE_KEY = 'cyberia.wallet.theme';

/**
 * The wallet's light/dark preference.
 *
 * Three states and not two, because "dark" and "follow the system" are
 * different answers that happen to look the same on a dark laptop: a wallet
 * pinned to dark stays dark when the phone turns light at sunrise, and a wallet
 * on `system` does not. Collapsing them would silently make one of the two
 * unreachable, and it is the default that would go.
 *
 * The preference is per device, like the vault it decorates — it rides in
 * localStorage rather than on an account, so it survives a lock and never
 * reaches Laravel. `system` is the default: the first honest answer about a
 * user we know nothing about is the one their OS already gave.
 */
function isTheme(value: unknown): value is WalletTheme {
    return WALLET_THEMES.includes(value as WalletTheme);
}

function stored(): WalletTheme {
    if (typeof window === 'undefined') {
        return 'system';
    }

    try {
        const value = window.localStorage.getItem(STORAGE_KEY);

        return isTheme(value) ? value : 'system';
    } catch {
        // Private mode, or site data switched off. A preference nobody can
        // save is still a preference for this tab.
        return 'system';
    }
}

// Module-level, so the toggle in the context bar and any screen that reacts to
// the scheme are looking at one value.
const theme = ref<WalletTheme>(stored());

/**
 * What the OS is asking for, kept live. A media query read once at boot is a
 * value that goes stale the moment the phone crosses into night mode, which is
 * exactly the case `system` exists to serve.
 */
const systemDark = ref(true);

if (typeof window !== 'undefined' && window.matchMedia) {
    const query = window.matchMedia('(prefers-color-scheme: dark)');

    systemDark.value = query.matches;
    query.addEventListener('change', (event) => {
        systemDark.value = event.matches;
    });
}

/**
 * Which palette is on, and the one somebody wrote themselves.
 *
 * Orthogonal to the preference above, and that is the whole reason there are two
 * settings rather than one list of twelve: `abyss` is a set of colours and
 * `light` is a time of day, and every shipped palette names both of its faces so
 * a person who picked blue at noon is still on blue after dark. The custom
 * palette is the exception, and `scheme` below is where it is handled.
 */
const palette = ref(
    typeof window === 'undefined' ? DEFAULT_PALETTE : readPalette(),
);

const custom = ref<CustomTheme | null>(
    typeof window === 'undefined' ? null : readCustomTheme(),
);

watch(palette, writePalette);

/**
 * The palettes as a stylesheet, installed once and kept current.
 *
 * At module scope and not in a component, for the same reason an unprotected
 * vault is opened synchronously: this runs while the wallet page's modules are
 * still being evaluated, before Vue has mounted anything, so a wallet on a
 * palette other than the shipped one is painted in it from the first frame
 * rather than flashing the default and then correcting itself.
 */
if (typeof document !== 'undefined') {
    const sheet = document.createElement('style');

    sheet.id = 'cw-palettes';
    document.head.append(sheet);

    watchEffect(() => {
        sheet.textContent = paletteCss(custom.value);
    });
}

const scheme = computed<WalletScheme>(() => {
    /*
     * A custom palette is one face and answers for its own polarity.
     *
     * It has to: what it does not override — the network hues, the three state
     * colours — still comes from the base theme in `wallet.css`, and that base
     * is selected by this very value. A wallet painted in somebody's near-black
     * ground while `data-cw-theme` said `light` would take Solana's violet and
     * the amber of "waiting" from the theme written for paper, and put them on
     * black. So the ground is measured and the preference above steps aside,
     * which is what Settings says while these colours are on rather than leaving
     * three buttons that do nothing.
     */
    if (palette.value === CUSTOM_PALETTE && custom.value) {
        return derivePalette(custom.value).polarity;
    }

    if (theme.value === 'system') {
        return systemDark.value ? 'dark' : 'light';
    }

    return theme.value;
});

watch(theme, (next) => {
    try {
        window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
        // Same as reading: the choice still holds for this tab.
    }
});

/**
 * Replace the custom palette, or drop it.
 *
 * Writing it is not selecting it — the editor draws its swatch live while it is
 * being written and the person is still free to walk away on a palette they
 * already had.
 */
export function setCustomTheme(next: CustomTheme): void {
    custom.value = next;
    writeCustomTheme(next);
}

/*
 * There was a `cycleTheme()` here, for a one-button switch on the context bar.
 * The button is gone — Preferences draws the choice as all three of its states,
 * which is the honest shape for a setting whose middle value is "whatever the
 * system says" — and a cycle nobody calls is not a spare part, it is a second
 * definition of the same setting waiting to disagree with the first.
 */
export function useWalletTheme() {
    return { theme, scheme, palette, custom, setCustomTheme };
}
