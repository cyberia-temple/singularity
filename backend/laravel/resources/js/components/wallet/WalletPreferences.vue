<script setup lang="ts">
import { usePage } from '@inertiajs/vue3';
import { Bell, ExternalLink, Power, Volume2 } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import WalletSync from '@/components/wallet/WalletSync.vue';
import WalletTelegramLink from '@/components/wallet/WalletTelegramLink.vue';
import { LOCALE_LABELS, useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useWalletBlocklist } from '@/composables/useWalletBlocklist';
import { WALLET_MODES, useWalletMode } from '@/composables/useWalletMode';
import {
    WALLET_THEMES,
    setThemeFile,
    useWalletTheme,
} from '@/composables/useWalletTheme';
import {
    hasNativeTray,
    nativeShell,
    nativeStartup,
    refreshNativeStartup,
    setNativeStartup,
} from '@/lib/native';
import { storeEdition } from '@/lib/storeEdition';
import { tokenAdminMessages } from '@/lib/tokenAdminMessages';
import {
    enableWalletNotifications,
    playWalletSound,
    readWalletPreferences,
    saveWalletPreferences,
    showWalletNotification,
    subscribeWalletPreferences,
    walletNotificationPermission,
} from '@/lib/wallet/notifications';
import { disablePush, enablePush, pushState } from '@/lib/wallet/push';
import type { PushState } from '@/lib/wallet/push';
import { sessionCall, signInWithWallet } from '@/lib/wallet/session';
import { CUSTOM_PALETTE, WALLET_PALETTES } from '@/lib/wallet/theme';
import {
    BUILT_IN_THEME_FILES,
    FILE_PALETTE,
    THEME_TEMPLATE_URL,
    builtInThemeUrl,
    parseThemeFile,
} from '@/lib/wallet/themeFile';
import { walletMessages } from '@/lib/walletMessages';

const props = defineProps<{
    /** For sync, the Telegram link and deleting the account. */
    wallet?: MultiWallet;
    authenticated?: boolean;
    profileAddress?: string | null;
}>();

defineEmits<{
    back: [];
    restored: [];
    security: [];
    accounts: [];
    networks: [];
    chain: [];
    tokenAdmin: [];
    proxy: [];
    developer: [];
}>();

const { t, locale, available, setLocale } = useLocale(walletMessages);
const { t: tokenAdminText } = useLocale(tokenAdminMessages);

/*
 * Appearance, which used to be two controls bolted to other people's chrome:
 * the theme sat on the context bar and the language on the wallet's masthead,
 * beside the site header's own language button. Both are settings somebody
 * chooses once, so both are here, and both are drawn as the *whole* choice
 * rather than as a cycle — a button that only shows the next value makes you
 * press it twice to find out what the third one was.
 */
const { theme, palette, themeFile } = useWalletTheme();

/**
 * Looks: the wallet's palettes, the theme files it ships, and one CSS file of
 * the person's own (`lib/wallet/themeFile.ts` — variables only).
 */
type LookOption = { id: string; label: string };

const looks = computed<LookOption[]>(() => [
    ...WALLET_PALETTES.filter((entry) => entry.id !== CUSTOM_PALETTE).map(
        (entry) => ({ id: entry.id, label: t(entry.label) }),
    ),
    ...BUILT_IN_THEME_FILES.map((file) => ({
        id: `file:${file.id}`,
        label: file.name,
    })),
    ...(themeFile.value && themeFile.value.source === null
        ? [{ id: 'file:own', label: themeFile.value.name }]
        : []),
]);

const activeLook = computed(() => {
    if (palette.value !== FILE_PALETTE) {
        return palette.value;
    }

    return `file:${themeFile.value?.source ?? 'own'}`;
});

const lookError = ref<string | null>(null);
const lookSkipped = ref<string[]>([]);

const chooseLook = async (id: string): Promise<void> => {
    lookError.value = null;
    lookSkipped.value = [];

    if (!id.startsWith('file:')) {
        palette.value = id;

        return;
    }

    const source = id.slice('file:'.length);

    if (source !== 'own') {
        try {
            const response = await fetch(builtInThemeUrl(source));
            const css = await response.text();
            const name =
                BUILT_IN_THEME_FILES.find((file) => file.id === source)?.name ??
                source;

            setThemeFile({ source, css, name });
        } catch {
            lookError.value = t('themeFileUnreachable');

            return;
        }
    }

    palette.value = FILE_PALETTE;
};

const loadThemeFile = async (event: Event): Promise<void> => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    input.value = '';
    lookError.value = null;
    lookSkipped.value = [];

    if (!file) {
        return;
    }

    const css = await file.text();
    const parsed = parseThemeFile(css, file.name.replace(/\.css$/i, ''));

    if (
        Object.keys(parsed.base).length === 0 &&
        Object.keys(parsed.light).length === 0
    ) {
        lookError.value = t('themeFileEmpty');
        lookSkipped.value = parsed.skipped;

        return;
    }

    setThemeFile({ source: null, css, name: parsed.name });
    lookSkipped.value = parsed.skipped;
    palette.value = FILE_PALETTE;
};
const { mode } = useWalletMode();

const modeLabel = (option: (typeof WALLET_MODES)[number]): string =>
    t(option === 'simple' ? 'modeSimpleShort' : 'modeFullShort');

const themeLabel = (option: (typeof WALLET_THEMES)[number]): string =>
    t(`theme${option.charAt(0).toUpperCase()}${option.slice(1)}Short`);
const preferences = ref(readWalletPreferences());
const permission = ref(walletNotificationPermission());
const startup = ref(nativeStartup());
const startupBusy = ref(false);
const startupError = ref(false);
const desktop = nativeShell() === 'desktop';

/*
 * Deleting the Cyberia account this wallet signed in to — the signature is
 * the proof, made fresh right before the request (WalletAccountController).
 */
const deleting = ref<'idle' | 'confirm' | 'busy' | 'done'>('idle');
const deleteProblem = ref<string | null>(null);

const deleteAccount = async (): Promise<void> => {
    const wallet = props.wallet;
    const address = wallet?.accounts.value.find(
        (account) => account.chain === 'cyberia',
    )?.address;

    if (!wallet || !address || deleting.value === 'busy') {
        return;
    }

    deleting.value = 'busy';
    deleteProblem.value = null;

    try {
        await signInWithWallet(address, (message) =>
            wallet.signMessage('cyberia', message),
        );
        await sessionCall('/api/wallet/account', {
            method: 'DELETE',
            body: JSON.stringify({ confirm: 'delete' }),
        });
        deleting.value = 'done';
    } catch (error) {
        deleteProblem.value =
            error instanceof Error ? error.message : String(error);
        deleting.value = 'confirm';
    }
};

/** Addresses blocked in the feed or the chat, undone in one place. */
const blocklist = useWalletBlocklist();

/** A store build stays on the wallet, so there is no site to open (`lib/storeEdition.ts`). */
const storeBuild = storeEdition() !== null;
const tray = hasNativeTray();

/**
 * One switch, and it covers both halves of being notified.
 *
 * There were two, in two screens, called the same word: this one, which let the
 * wallet raise a notice while it was open, and a second in Security that
 * subscribed the device for web push — the only one that can say anything while
 * the app is closed. Somebody who turned on "Уведомления" here got the
 * permission and no subscription, so the feed's announcement reached them
 * never. They are one decision and are now one control: on means both, off
 * means both, and the state that is drawn is the subscription's, because it is
 * the one that can fail on its own.
 */
const push = ref<PushState>('unsupported');
const pushBusy = ref(false);

const vapidKey = computed(
    () => (usePage().props.vapidPublicKey as string | undefined) ?? null,
);

const notificationsOn = computed(
    () => preferences.value.notifications || push.value === 'on',
);

const notificationsBlocked = computed(
    () =>
        pushBusy.value ||
        permission.value === 'unsupported' ||
        permission.value === 'denied' ||
        push.value === 'denied' ||
        push.value === 'unsupported',
);

const notificationsHint = computed(() => {
    if (permission.value === 'unsupported' || push.value === 'unsupported') {
        return t('preferencesNotificationsUnsupported');
    }

    if (permission.value === 'denied' || push.value === 'denied') {
        return t('preferencesNotificationsDenied');
    }

    // The subscription is what a closed app is reached through, and it can be
    // missing while the permission is granted — a rotated key, a cleared site,
    // a browser that dropped it. Said rather than drawn as "on".
    if (push.value === 'unavailable') {
        return t('preferencesNotificationsUnavailable');
    }

    return t('preferencesNotificationsHint');
});

const toggleNotifications = async (enabled: boolean): Promise<void> => {
    if (pushBusy.value) {
        return;
    }

    pushBusy.value = true;

    try {
        if (enabled) {
            await enableWalletNotifications();

            if (vapidKey.value !== null) {
                push.value = await enablePush(vapidKey.value, locale.value);
            }
        } else {
            saveWalletPreferences({ notifications: false });
            push.value = await disablePush();
        }
    } catch {
        push.value = await pushState(vapidKey.value);
    } finally {
        pushBusy.value = false;
        permission.value = walletNotificationPermission();
        preferences.value = readWalletPreferences();
    }
};

const toggleSounds = (enabled: boolean): void => {
    preferences.value = saveWalletPreferences({ sounds: enabled });

    if (enabled) {
        playWalletSound('success', true);
    }
};

const testAlerts = async (): Promise<void> => {
    if (permission.value === 'prompt') {
        await toggleNotifications(true);
    }

    playWalletSound('message', true);
    showWalletNotification(
        {
            title: t('preferencesTestTitle'),
            body: t('preferencesTestBody'),
            tag: 'cyberia-wallet-test',
        },
        true,
    );
};

const toggleStartup = async (enabled: boolean): Promise<void> => {
    startupBusy.value = true;
    startupError.value = false;

    try {
        startup.value = await setNativeStartup(enabled);
        startupError.value =
            startup.value.error !== undefined && startup.value.error !== '';
    } finally {
        startupBusy.value = false;
    }
};

const unsubscribe = subscribeWalletPreferences((next) => {
    preferences.value = next;
});

/**
 * The line nobody reads, and what it says to somebody who taps it seven
 * times — the way a phone unlocks its own developer options. What it says is
 * one of the secrets of the layers underneath (`lib/wallet/layers.ts`).
 */
const SEVEN = 7;
const taps = ref(0);

const tapVersion = (): void => {
    taps.value = Math.min(SEVEN, taps.value + 1);
};

const versionNote = computed(() => {
    if (taps.value >= SEVEN) {
        return t('layersSevenTaps');
    }

    return taps.value >= 3
        ? t('layersTapsLeft', { count: SEVEN - taps.value })
        : null;
});

onMounted(async () => {
    push.value = await pushState(vapidKey.value);
    startup.value = await refreshNativeStartup();
});

onBeforeUnmount(unsubscribe);
</script>

<template>
    <div class="cw-stack cw-screen">
        <button type="button" class="cw-back" @click="$emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <div style="margin: 24px 0 20px">
            <h2 class="cw-title" style="font-size: 22px">
                {{ t('preferencesTitle') }}
            </h2>
            <p class="cw-prose" style="margin-top: 8px">
                {{ t('preferencesBody') }}
            </p>
        </div>

        <div class="cw-stack" style="gap: 0; margin-bottom: 24px">
            <button
                type="button"
                class="cw-line-row"
                @click="$emit('accounts')"
            >
                {{ t('accounts') }} →
            </button>
            <button
                type="button"
                class="cw-line-row"
                @click="$emit('security')"
            >
                {{ t('navSecurity') }} →
            </button>
            <button
                type="button"
                class="cw-line-row"
                @click="$emit('networks')"
            >
                {{ t('networksSection') }} →
            </button>
            <button
                type="button"
                class="cw-line-row"
                data-test="chain-door"
                @click="$emit('chain')"
            >
                {{ t('chainDoor') }} →
            </button>
            <button type="button" class="cw-line-row" @click="$emit('tokenAdmin')">
                {{ tokenAdminText('door') }} →
            </button>
            <button type="button" class="cw-line-row" @click="$emit('proxy')">
                {{ t('proxyTitle') }} →
            </button>
            <a
                class="cw-line-row"
                href="https://cyberia.church/privacy/cyberia-wallet-app.html"
                target="_blank"
                rel="noopener noreferrer"
            >
                {{ t('privacyPolicy') }} ↗
            </a>
        </div>

        <WalletSync
            v-if="wallet"
            :wallet="wallet"
            :authenticated="authenticated ?? false"
            :profile-address="profileAddress"
            style="margin-bottom: 18px"
            @security="$emit('security')"
            @restored="$emit('restored')"
        />

        <div class="cw-label" style="margin-bottom: 9px">
            {{ t('preferencesAppearance') }}
        </div>

        <div class="cw-card" style="padding: 16px; margin-bottom: 18px">
            <div class="cw-label" style="margin-bottom: 9px">
                {{ t('preferencesMode') }}
            </div>
            <div class="cw-seg">
                <button
                    v-for="option in WALLET_MODES"
                    :key="option"
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="mode === option"
                    @click="mode = option"
                >
                    {{ modeLabel(option) }}
                    <span
                        class="cw-seg-bar"
                        :style="{
                            background:
                                mode === option
                                    ? 'var(--cw-accent)'
                                    : 'transparent',
                        }"
                    />
                </button>
            </div>
            <span class="cw-hint" style="margin-top: 8px">{{
                t('modeHint')
            }}</span>

            <div class="cw-label" style="margin: 18px 0 9px">
                {{ t('preferencesTheme') }}
            </div>
            <div class="cw-seg">
                <button
                    v-for="option in WALLET_THEMES"
                    :key="option"
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="theme === option"
                    @click="theme = option"
                >
                    {{ themeLabel(option) }}
                    <span
                        class="cw-seg-bar"
                        :style="{
                            background:
                                theme === option
                                    ? 'var(--cw-accent)'
                                    : 'transparent',
                        }"
                    />
                </button>
            </div>

            <div class="cw-label" style="margin: 18px 0 9px">
                {{ t('preferencesLook') }}
            </div>
            <div class="cw-seg">
                <button
                    v-for="option in looks"
                    :key="option.id"
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="activeLook === option.id"
                    @click="chooseLook(option.id)"
                >
                    {{ option.label }}
                </button>
            </div>
            <div
                style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 8px;
                    margin-top: 10px;
                "
            >
                <label class="cw-ghost" style="cursor: pointer">
                    {{ t('themeFileLoad') }}
                    <input
                        type="file"
                        accept=".css,text/css"
                        style="display: none"
                        @change="loadThemeFile"
                    />
                </label>
                <a
                    class="cw-ghost"
                    :href="THEME_TEMPLATE_URL"
                    download="cyberia-wallet-theme.css"
                    style="text-decoration: none"
                    >{{ t('themeFileTemplate') }}</a
                >
            </div>
            <span class="cw-hint" style="margin-top: 8px">{{
                t('themeFileHint')
            }}</span>
            <span
                v-if="lookError"
                class="cw-hint"
                style="margin-top: 6px; color: var(--cw-bad-soft)"
                >{{ lookError }}</span
            >
            <span
                v-if="lookSkipped.length > 0"
                class="cw-hint"
                style="margin-top: 6px; color: var(--cw-pending)"
                >{{ t('themeFileSkipped', { count: lookSkipped.length }) }}
                {{ lookSkipped.slice(0, 3).join(' · ') }}</span
            >

            <div class="cw-label" style="margin: 18px 0 9px">
                {{ t('preferencesLanguage') }}
            </div>
            <div class="cw-seg">
                <button
                    v-for="option in available"
                    :key="option"
                    type="button"
                    class="cw-seg-item"
                    :aria-pressed="locale === option"
                    @click="setLocale(option)"
                >
                    {{ LOCALE_LABELS[option] }}
                    <span
                        class="cw-seg-bar"
                        :style="{
                            background:
                                locale === option
                                    ? 'var(--cw-accent)'
                                    : 'transparent',
                        }"
                    />
                </button>
            </div>
        </div>

        <div class="cw-label" style="margin-bottom: 9px">
            {{ t('preferencesAlerts') }}
        </div>

        <WalletTelegramLink
            v-if="wallet"
            :wallet="wallet"
            style="margin-bottom: 12px"
        />

        <div class="cw-card" style="padding: 0">
            <label class="cw-row" style="padding: 16px; cursor: pointer">
                <Bell :size="18" aria-hidden="true" />
                <span style="flex: 1">
                    <span class="cw-data" style="display: block">{{
                        t('preferencesNotifications')
                    }}</span>
                    <span
                        class="cw-label"
                        style="display: block; margin-top: 4px"
                        >{{ notificationsHint }}</span
                    >
                </span>
                <input
                    type="checkbox"
                    :checked="notificationsOn"
                    :disabled="notificationsBlocked"
                    style="
                        width: 20px;
                        height: 20px;
                        accent-color: var(--cw-accent);
                    "
                    @change="
                        toggleNotifications(
                            ($event.target as HTMLInputElement).checked,
                        )
                    "
                />
            </label>

            <label
                class="cw-row"
                style="
                    padding: 16px;
                    border-top: 1px solid var(--cw-line);
                    cursor: pointer;
                "
            >
                <Volume2 :size="18" aria-hidden="true" />
                <span style="flex: 1">
                    <span class="cw-data" style="display: block">{{
                        t('preferencesSounds')
                    }}</span>
                    <span
                        class="cw-label"
                        style="display: block; margin-top: 4px"
                        >{{ t('preferencesSoundsHint') }}</span
                    >
                </span>
                <input
                    type="checkbox"
                    :checked="preferences.sounds"
                    style="
                        width: 20px;
                        height: 20px;
                        accent-color: var(--cw-accent);
                    "
                    @change="
                        toggleSounds(
                            ($event.target as HTMLInputElement).checked,
                        )
                    "
                />
            </label>

            <label
                v-if="startup.available"
                class="cw-row"
                style="
                    padding: 16px;
                    border-top: 1px solid var(--cw-line);
                    cursor: pointer;
                "
            >
                <Power :size="18" aria-hidden="true" />
                <span style="flex: 1">
                    <span class="cw-data" style="display: block">{{
                        t('preferencesStartup')
                    }}</span>
                    <span
                        class="cw-label"
                        style="display: block; margin-top: 4px"
                        >{{ t('preferencesStartupHint') }}</span
                    >
                </span>
                <input
                    type="checkbox"
                    :checked="startup.enabled"
                    :disabled="startupBusy"
                    style="
                        width: 20px;
                        height: 20px;
                        accent-color: var(--cw-accent);
                    "
                    @change="
                        toggleStartup(
                            ($event.target as HTMLInputElement).checked,
                        )
                    "
                />
            </label>
        </div>

        <p
            v-if="startupError"
            class="cw-note cw-note-bad"
            style="margin-top: 12px"
        >
            {{ t('preferencesStartupError') }}
        </p>

        <p v-if="desktop && tray" class="cw-note" style="margin-top: 12px">
            {{ t('preferencesTrayHint') }}
        </p>

        <button
            type="button"
            class="cw-btn cw-btn-secondary"
            style="height: 48px; margin-top: 16px"
            @click="testAlerts"
        >
            {{ t('preferencesTest') }}
        </button>

        <div
            v-if="blocklist.blocked.value.length > 0"
            style="
                display: flex;
                align-items: center;
                gap: 12px;
                margin-top: 16px;
            "
        >
            <span class="cw-prose" style="flex: 1; margin: 0">{{
                t('prefsBlocked', { count: blocklist.blocked.value.length })
            }}</span>
            <button
                type="button"
                class="cw-ghost"
                @click="blocklist.unblockAll()"
            >
                {{ t('prefsUnblockAll') }}
            </button>
        </div>

        <!--
          An account made by signing in from the wallet can be deleted from
          the wallet. Both stores require it, and a signature-made account has
          no password for the site's own form to ask for.
        -->
        <template v-if="(authenticated && wallet) || deleting === 'done'">
            <p
                v-if="deleting === 'done'"
                class="cw-prose"
                role="status"
                style="margin: 16px 0 0"
            >
                {{ t('prefsDeleteAccountDone') }}
            </p>
            <button
                v-else-if="deleting === 'idle'"
                type="button"
                class="cw-line-row"
                style="margin-top: 16px"
                @click="deleting = 'confirm'"
            >
                <span style="flex: 1">{{ t('prefsDeleteAccount') }}</span>
            </button>
            <div v-else class="cw-stack" style="margin-top: 16px">
                <p class="cw-prose" style="margin: 0 0 10px">
                    {{ t('prefsDeleteAccountNote') }}
                </p>
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="height: 44px; color: var(--cw-bad)"
                    :disabled="deleting === 'busy'"
                    @click="deleteAccount"
                >
                    {{ t('prefsDeleteAccountConfirm') }}
                </button>
                <p
                    v-if="deleteProblem"
                    class="cw-prose"
                    role="alert"
                    style="margin: 8px 0 0; color: var(--cw-bad)"
                >
                    {{ deleteProblem }}
                </p>
            </div>
        </template>

        <!--
          The rest of Cyberia. The wallet has no site header over it in any
          container now, and the shells' masthead carries this link; a browser
          tab has its own history but not everybody arrived through it.
        -->
        <a
            v-if="!storeBuild"
            href="/"
            class="cw-btn cw-btn-secondary"
            style="height: 48px; margin-top: 8px; text-decoration: none"
        >
            <ExternalLink :size="15" aria-hidden="true" />
            {{ t('openSite') }}
        </a>

        <!--
          The door down. Quiet on purpose: the wallet above works without
          anything behind it, and whoever opens it already wanted more.
        -->
        <button
            type="button"
            class="cw-line-row"
            style="margin-top: 28px"
            @click="$emit('developer')"
        >
            <span style="flex: 1">{{ t('layersDoor') }}</span>
            →
        </button>

        <button type="button" class="cw-layer-version" @click="tapVersion">
            {{ t('layersVersionLine') }}
        </button>
        <span
            v-if="versionNote"
            class="cw-hint"
            style="margin-top: 4px; text-align: center"
            aria-live="polite"
            >{{ versionNote }}</span
        >
    </div>
</template>
