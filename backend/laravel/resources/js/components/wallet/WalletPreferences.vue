<script setup lang="ts">
import { usePage } from '@inertiajs/vue3';
import { Bell, ExternalLink, Power, Volume2 } from 'lucide-vue-next';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { LOCALE_LABELS, useLocale } from '@/composables/useLocale';
import { WALLET_THEMES, useWalletTheme } from '@/composables/useWalletTheme';
import {
    hasNativeTray,
    nativeShell,
    nativeStartup,
    refreshNativeStartup,
    setNativeStartup,
} from '@/lib/native';
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
import { walletMessages } from '@/lib/walletMessages';

defineEmits<{ back: [] }>();

const { t, locale, available, setLocale } = useLocale(walletMessages);

/*
 * Appearance, which used to be two controls bolted to other people's chrome:
 * the theme sat on the context bar and the language on the wallet's masthead,
 * beside the site header's own language button. Both are settings somebody
 * chooses once, so both are here, and both are drawn as the *whole* choice
 * rather than as a cycle — a button that only shows the next value makes you
 * press it twice to find out what the third one was.
 */
const { theme } = useWalletTheme();

const themeLabel = (option: (typeof WALLET_THEMES)[number]): string =>
    t(`theme${option.charAt(0).toUpperCase()}${option.slice(1)}Short`);
const preferences = ref(readWalletPreferences());
const permission = ref(walletNotificationPermission());
const startup = ref(nativeStartup());
const startupBusy = ref(false);
const startupError = ref(false);
const desktop = nativeShell() === 'desktop';
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
 * TEMPORARY — a readout of how this window is actually laid out.
 *
 * The frame's bottom edge is wrong on one person's iPhone and right on every
 * emulator here, and no Safari on this side of the cable can be attached to a
 * home-screen app. So the app states its own numbers and a screenshot carries
 * them back. Delete this block, `frameProbe` and the panel below it as soon as
 * that is answered.
 */
const frameProbe = ref<string[]>([]);

const readFrameProbe = (): void => {
    const px = (value: number | undefined): string =>
        value === undefined ? '—' : String(Math.round(value));

    const probe = document.createElement('div');
    probe.style.cssText =
        'position:fixed;top:0;left:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);visibility:hidden;pointer-events:none';
    document.body.append(probe);
    const insets = getComputedStyle(probe);
    const safe = `${insets.paddingTop} / ${insets.paddingBottom}`;
    probe.remove();

    const rect = (selector: string): string => {
        const element = document.querySelector(selector);

        if (!element) {
            return 'нет';
        }

        const box = element.getBoundingClientRect();
        const style = getComputedStyle(element);

        return `${px(box.top)}–${px(box.bottom)} pad ${style.paddingTop}/${style.paddingBottom}`;
    };

    frameProbe.value = [
        `win ${px(window.innerWidth)}×${px(window.innerHeight)} vv ${px(window.visualViewport?.height)} scr ${px(window.screen.height)}`,
        `client ${px(document.documentElement.clientHeight)} vh ${(() => {
            const unit = document.createElement('div');
            unit.style.cssText =
                'position:fixed;top:0;left:0;width:1px;height:100vh;visibility:hidden;pointer-events:none';
            document.body.append(unit);
            const height = unit.getBoundingClientRect().height;
            unit.remove();

            return px(height);
        })()}`,
        `safe ${safe}`,
        `insets=${document.documentElement.dataset.windowInsets ?? '—'} boot ${
            document.documentElement.dataset.bootHeight ?? '—'
        }`,
        `vp ${document.querySelector<HTMLMetaElement>('meta[name=viewport]')?.content ?? '—'}`,
        `app=${document.documentElement.dataset.appWindow ?? '0'} sa=${
            (window.navigator as { standalone?: boolean }).standalone === true
                ? 1
                : 0
        } dm=${window.matchMedia('(display-mode: standalone)').matches ? 1 : 0}`,
        `frame ${rect('.cw-frame')}`,
        `shell ${rect('.cw-shell')}`,
        `tabs ${rect('.cw-tabs')}`,
        `html ${getComputedStyle(document.documentElement).backgroundColor}`,
        `body ${getComputedStyle(document.body).backgroundColor}`,
    ];
};

onMounted(async () => {
    readFrameProbe();
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

        <div class="cw-label" style="margin-bottom: 9px">
            {{ t('preferencesAppearance') }}
        </div>

        <div class="cw-card" style="padding: 16px; margin-bottom: 18px">
            <div class="cw-label" style="margin-bottom: 9px">
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

        <!--
          The rest of Cyberia. The wallet has no site header over it in any
          container now, and the shells' masthead carries this link; a browser
          tab has its own history but not everybody arrived through it.
        -->
        <a
            href="/"
            class="cw-btn cw-btn-secondary"
            style="height: 48px; margin-top: 8px; text-decoration: none"
        >
            <ExternalLink :size="15" aria-hidden="true" />
            {{ t('openSite') }}
        </a>

        <!-- TEMPORARY: see `readFrameProbe`. Remove with it. -->
        <div
            style="
                margin-top: 20px;
                padding: 10px 12px;
                border: 1px dashed var(--cw-border);
                font: 500 13px/1.6 var(--cw-mono);
                color: var(--cw-faint);
            "
        >
            <div style="margin-bottom: 4px; color: var(--cw-dim)">
                РАМКА ОКНА · ВРЕМЕННО
            </div>
            <div v-for="line in frameProbe" :key="line">{{ line }}</div>
            <button
                type="button"
                class="cw-ghost"
                style="margin-top: 6px"
                @click="readFrameProbe()"
            >
                обновить
            </button>
        </div>
    </div>
</template>
