import { computed, ref, watch } from 'vue';

export const WALLET_THEMES = ['system', 'dark', 'light'] as const;

export type WalletTheme = (typeof WALLET_THEMES)[number];

/**
 * What the wallet is actually painted as, once `system` has been resolved.
 * `data-cw-theme` is written with this and never with the preference, so the
 * stylesheet only ever has two palettes to define.
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

const scheme = computed<WalletScheme>(() => {
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

export function useWalletTheme() {
    /**
     * The cycle is system → dark → light → system. It starts at whatever is
     * stored, so a user who has never touched it goes to dark first — the
     * wallet's own house style, and the answer to "can I get the old look
     * back" without a settings screen.
     */
    const nextTheme = computed<WalletTheme>(() => {
        const at = WALLET_THEMES.indexOf(theme.value);

        return WALLET_THEMES[(at + 1) % WALLET_THEMES.length];
    });

    const cycleTheme = (): void => {
        theme.value = nextTheme.value;
    };

    return { theme, scheme, nextTheme, cycleTheme };
}
