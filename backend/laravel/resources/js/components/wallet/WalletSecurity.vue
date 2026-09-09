<script setup lang="ts">
import { usePage } from '@inertiajs/vue3';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import {
    clipboardAutoClear,
    useSecureClipboard,
} from '@/composables/useSecureClipboard';
import { analytics } from '@/lib/analytics';
import { disablePush, enablePush, pushState } from '@/lib/wallet/push';
import type { PushState } from '@/lib/wallet/push';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Security: the seed behind a password, the two settings that decide how long
 * a secret lingers, and the one destructive action, kept behind a typed word
 * rather than a second button.
 *
 * The phrase is never on the portfolio and never in a passive panel — it is
 * shown here only after the password is entered again, and dropped as soon as
 * the panel closes or the component goes away.
 */

const props = defineProps<{ wallet: MultiWallet }>();

const emit = defineEmits<{
    locked: [];
    forgotten: [];
    addNetwork: [];
    proxy: [];
}>();

const { t, locale } = useLocale(walletMessages);
const clipboard = useSecureClipboard();

/**
 * Notifications, offered here because this is the only screen most people
 * running this wallet will ever see.
 *
 * The site has a bell in its header; this app does not render that header, and
 * neither does the PWA, the native shells or the Telegram mini app — so until
 * this row existed, somebody who installed the wallet had no button anywhere
 * to allow notifications at all.
 *
 * Four states rather than a checkbox, because three of them are refusals the
 * person can act on and one is a refusal they cannot: a browser that blocked
 * the permission has to be changed in the browser, and a switch that silently
 * does nothing is worse than a sentence saying so.
 */
const vapidKey = computed(
    () => (usePage().props.vapidPublicKey as string | undefined) ?? null,
);
const push = ref<PushState>('unsupported');
const pushBusy = ref(false);

onMounted(async () => {
    push.value = await pushState(vapidKey.value);
});

const setPush = async (on: boolean): Promise<void> => {
    if (pushBusy.value || vapidKey.value === null) {
        return;
    }

    pushBusy.value = true;

    try {
        push.value = on
            ? await enablePush(vapidKey.value, locale.value)
            : await disablePush();
    } catch {
        push.value = await pushState(vapidKey.value);
    } finally {
        pushBusy.value = false;
    }
};

const pushHint = computed(() => {
    switch (push.value) {
        case 'denied':
            return t('notificationsDenied');
        case 'unsupported':
            return t('notificationsUnsupported');
        case 'unavailable':
            return t('notificationsUnavailable');
        default:
            return t('notificationsHint');
    }
});

const password = ref('');
const phrase = ref<string | null>(null);
const error = ref<string | null>(null);
const deleting = ref(false);
const deleteConfirmation = ref('');

const LOCK_OPTIONS = [5, 15, 60];

/**
 * Anonymous usage statistics, and the switch for them.
 *
 * It belongs on this screen rather than in a settings menu somewhere: this is
 * where the wallet already tells the truth about what leaves the device, and
 * a wallet that collects anything at all owes the person holding it a place to
 * say no. Turning it off drops the local queue and forgets the installation
 * id, so opting back in starts a new anonymous user rather than resuming a
 * profile.
 *
 * When the refusal came from the browser (Do Not Track, Global Privacy
 * Control) the row says so and the switch is left alone — overriding a browser
 * setting from a page would be exactly the behaviour that signal exists to
 * prevent.
 */
const analyticsOn = ref(analytics.enabled());
const analyticsBlocked = analytics.blockedByBrowser();

const setAnalytics = (on: boolean): void => {
    analytics.setEnabled(on);
    analyticsOn.value = analytics.enabled();
};

/** The networks that ship with the wallet, named so "verified" means something. */
/**
 * The networks read through an endpoint this project checked, named as that
 * rather than as a tier. It is the same list the row's "verified" tag is about,
 * and the only thing it separates from the rows below is who vetted the host —
 * not which chains count.
 */
const vetted = computed(() =>
    props.wallet.chains.value
        .filter((chain) => !chain.custom)
        .map((chain) => chain.label)
        .join(' · '),
);

/**
 * Where each account's key comes from, one row per network.
 *
 * This used to be the subtitle of the network screen — the most looked-at line
 * on it — where it answered nothing anybody standing there was asking. Here it
 * answers the question this screen is for: whether this vault can be opened
 * somewhere that is not this browser.
 */
const derivations = computed(() =>
    props.wallet.accounts.value.map((account) => ({
        chain: account.chain,
        label: account.label,
        path: account.path,
        curve: account.curve,
    })),
);

const canDelete = computed(
    () => deleteConfirmation.value.trim().toUpperCase() === t('deleteWord'),
);

/** Whether this device's vault has a password on it at all. */
const unprotected = computed(() => props.wallet.protection.value === 'none');

const reveal = async (): Promise<void> => {
    error.value = null;

    try {
        phrase.value = await props.wallet.reveal(
            unprotected.value ? null : password.value,
        );
    } catch {
        error.value = t('wrongPassword');
    } finally {
        password.value = '';
    }
};

/**
 * Put the phrase away, and record that it has been out.
 *
 * The button says "I wrote it down", so it is taken at its word: this is the
 * only place the skipped-backup warning can be cleared, and clearing it
 * anywhere else would mean the wallet deciding on the owner's behalf that a
 * phrase they never saw is safe.
 */
const hide = (): void => {
    phrase.value = null;
    void props.wallet.markBackedUp();
};

/* ---------------------------------------------------- adding a password -- */

const newPassword = ref('');
const newPasswordAgain = ref('');
const protecting = ref(false);
const protectError = ref<string | null>(null);

const newPasswordOk = computed(
    () =>
        newPassword.value.length >= 8 &&
        newPassword.value === newPasswordAgain.value,
);

const protectVault = async (): Promise<void> => {
    if (!newPasswordOk.value || protecting.value) {
        return;
    }

    protecting.value = true;
    protectError.value = null;

    try {
        await props.wallet.protect(newPassword.value);
        newPassword.value = '';
        newPasswordAgain.value = '';
    } catch (failure) {
        protectError.value =
            failure instanceof Error ? failure.message : String(failure);
    } finally {
        protecting.value = false;
    }
};

const forget = (): void => {
    props.wallet.forget();
    emit('forgotten');
};

onBeforeUnmount(() => {
    phrase.value = null;
    password.value = '';
});
</script>

<template>
    <div class="cw-stack">
        <h2 class="cw-title" style="margin: 6px 0 22px; font-size: 22px">
            {{ t('security') }}
        </h2>

        <div class="cw-label" style="margin-bottom: 10px">
            {{ t('vaultSection') }}
        </div>

        <!--
          The two things somebody can decline at setup, said here for as long
          as they are still declined. Neither is an error and neither blocks
          anything — they are the two facts that decide whether this wallet can
          be got back, and a wallet that stayed quiet about them would be
          keeping a secret from its owner about their own money.
        -->
        <p
            v-if="!wallet.backedUp.value"
            class="cw-note cw-note-warn"
            style="margin-bottom: 10px"
        >
            <span>{{ t('notBackedUp') }}</span>
        </p>

        <div
            v-if="unprotected"
            class="cw-card"
            style="margin-bottom: 10px; padding: 16px"
        >
            <div
                style="font: 400 14px/1.3 var(--cw-sans); color: var(--cw-text)"
            >
                {{ t('noPasswordTitle') }}
            </div>
            <p
                style="
                    margin: 6px 0 0;
                    font: 400 11px/1.6 var(--cw-mono);
                    color: var(--cw-dim);
                    text-wrap: pretty;
                "
            >
                {{ t('noPasswordBody') }}
            </p>

            <form
                class="cw-stack"
                style="gap: 8px; margin-top: 12px"
                @submit.prevent="protectVault"
            >
                <input
                    v-model="newPassword"
                    type="password"
                    class="cw-input"
                    autocomplete="new-password"
                    :aria-label="t('password')"
                    :placeholder="t('password')"
                />
                <input
                    v-model="newPasswordAgain"
                    type="password"
                    class="cw-input"
                    autocomplete="new-password"
                    :aria-label="t('passwordAgain')"
                    :placeholder="t('passwordAgain')"
                    :aria-invalid="
                        newPasswordAgain.length > 0 &&
                        newPassword !== newPasswordAgain
                    "
                />
                <button
                    type="submit"
                    class="cw-btn cw-btn-secondary"
                    style="height: 48px"
                    :disabled="!newPasswordOk || protecting"
                >
                    {{ protecting ? t('addingPassword') : t('addPassword') }}
                </button>
            </form>

            <p
                v-if="protectError"
                class="cw-note cw-note-bad"
                style="margin-top: 10px"
            >
                <span>{{ protectError }}</span>
            </p>
        </div>

        <div class="cw-card" style="padding: 0">
            <!-- Seed backup, password-gated. -->
            <div style="padding: 16px; border-bottom: 1px solid var(--cw-line)">
                <div
                    style="
                        font: 400 14px/1.3 var(--cw-sans);
                        color: var(--cw-text);
                    "
                >
                    {{ t('backupSeed') }}
                </div>
                <div
                    style="
                        margin-top: 3px;
                        font: 400 11px/1.4 var(--cw-mono);
                        color: var(--cw-dim);
                    "
                >
                    {{
                        unprotected
                            ? t('backupSeedHintOpen')
                            : t('backupSeedHint')
                    }}
                </div>

                <!--
                  No password field where there is no password: a check against
                  nothing is a lock drawn on an open door, and typing into it
                  would teach the wrong thing about what protects this wallet.
                -->
                <form
                    v-if="!phrase"
                    style="display: flex; gap: 8px; margin-top: 12px"
                    @submit.prevent="reveal"
                >
                    <input
                        v-if="!unprotected"
                        v-model="password"
                        type="password"
                        class="cw-input"
                        autocomplete="current-password"
                        :aria-label="t('password')"
                        placeholder="••••••••••••"
                    />
                    <button
                        type="submit"
                        class="cw-ghost"
                        :style="
                            unprotected
                                ? { height: '48px', width: '100%' }
                                : { height: '48px', flex: 'none' }
                        "
                        :disabled="!unprotected && password.length === 0"
                    >
                        {{ t('showPhrase') }}
                    </button>
                </form>

                <div v-else style="margin-top: 12px">
                    <ol
                        style="
                            display: grid;
                            grid-template-columns: repeat(
                                auto-fill,
                                minmax(120px, 1fr)
                            );
                            gap: 1px;
                            margin: 0;
                            padding: 0;
                            list-style: none;
                            background: var(--cw-line);
                            border: 1px solid var(--cw-line);
                        "
                    >
                        <li
                            v-for="(word, index) in phrase.split(' ')"
                            :key="index"
                            style="
                                display: flex;
                                gap: 8px;
                                padding: 9px 10px;
                                background: var(--cw-surface);
                                font: 500 13px/1 var(--cw-mono);
                            "
                        >
                            <span style="color: var(--cw-faint)">{{
                                String(index + 1).padStart(2, '0')
                            }}</span>
                            {{ word }}
                        </li>
                    </ol>
                    <div style="display: flex; gap: 8px; margin-top: 10px">
                        <button
                            type="button"
                            class="cw-ghost"
                            @click="clipboard.copy(phrase, 'phrase')"
                        >
                            {{
                                clipboard.copied.value === 'phrase'
                                    ? t('copiedLabel')
                                    : t('copyPhrase')
                            }}
                        </button>
                        <button type="button" class="cw-ghost" @click="hide">
                            {{ t('wroteItDown') }}
                        </button>
                    </div>
                </div>

                <p
                    v-if="error"
                    class="cw-note cw-note-bad"
                    style="margin-top: 10px"
                >
                    <span>{{ error }}</span>
                </p>
            </div>

            <!--
              Auto-lock, and only where there is something to lock: sealing a
              vault whose password does not exist would put the owner in front
              of a prompt with no answer. `lock()` refuses it too — this is the
              first line, not the only one.
            -->
            <div
                v-if="!unprotected"
                class="cw-row"
                style="padding: 16px; border-bottom: 1px solid var(--cw-line)"
            >
                <div style="flex: 1">
                    <div
                        style="
                            font: 400 14px/1.3 var(--cw-sans);
                            color: var(--cw-text);
                        "
                    >
                        {{ t('autoLock') }}
                    </div>
                    <div
                        style="
                            margin-top: 3px;
                            font: 400 11px/1.4 var(--cw-mono);
                            color: var(--cw-dim);
                        "
                    >
                        {{ t('autoLockHint') }}
                    </div>
                </div>
                <div class="cw-seg" style="flex: none">
                    <button
                        v-for="minutes in LOCK_OPTIONS"
                        :key="minutes"
                        type="button"
                        class="cw-seg-item"
                        style="min-width: 52px; min-height: 36px"
                        :aria-pressed="wallet.autoLockMinutes.value === minutes"
                        @click="wallet.setAutoLock(minutes)"
                    >
                        {{ minutes }}m
                    </button>
                </div>
            </div>

            <!-- Clipboard hygiene. -->
            <label class="cw-row" style="padding: 16px; cursor: pointer">
                <span style="flex: 1">
                    <span
                        style="
                            display: block;
                            font: 400 14px/1.3 var(--cw-sans);
                            color: var(--cw-text);
                        "
                        >{{ t('clipboardRow') }}</span
                    >
                    <span
                        style="
                            display: block;
                            margin-top: 3px;
                            font: 400 11px/1.4 var(--cw-mono);
                            color: var(--cw-dim);
                        "
                        >{{ t('clipboardHint') }}</span
                    >
                </span>
                <input
                    v-model="clipboardAutoClear"
                    type="checkbox"
                    style="
                        width: 20px;
                        height: 20px;
                        flex: none;
                        accent-color: var(--cw-accent);
                    "
                />
            </label>

            <!--
              Anonymous usage statistics. Named here, with what is never sent,
              because a wallet that says "keys never leave this device" has to
              be equally specific about what does.
            -->
            <label
                class="cw-row"
                style="
                    padding: 16px;
                    border-top: 1px solid var(--cw-line);
                    cursor: pointer;
                "
            >
                <span style="flex: 1">
                    <span
                        style="
                            display: block;
                            font: 400 14px/1.3 var(--cw-sans);
                            color: var(--cw-text);
                        "
                        >{{ t('analyticsRow') }}</span
                    >
                    <span
                        style="
                            display: block;
                            margin-top: 3px;
                            font: 400 11px/1.4 var(--cw-mono);
                            color: var(--cw-dim);
                        "
                        >{{
                            analyticsBlocked
                                ? t('analyticsBlocked')
                                : t('analyticsHint')
                        }}</span
                    >
                </span>
                <input
                    :checked="analyticsOn"
                    :disabled="analyticsBlocked"
                    type="checkbox"
                    style="
                        width: 20px;
                        height: 20px;
                        flex: none;
                        accent-color: var(--cw-accent);
                    "
                    @change="
                        setAnalytics(
                            ($event.target as HTMLInputElement).checked,
                        )
                    "
                />
            </label>

            <label
                style="
                    display: flex;
                    align-items: flex-start;
                    justify-content: space-between;
                    gap: 16px;
                    cursor: pointer;
                "
            >
                <span>
                    <span
                        style="
                            display: block;
                            font: 400 14px/1.3 var(--cw-sans);
                            color: var(--cw-text);
                        "
                        >{{ t('notificationsRow') }}</span
                    >
                    <span
                        style="
                            display: block;
                            margin-top: 3px;
                            font: 400 11px/1.4 var(--cw-mono);
                            color: var(--cw-dim);
                        "
                        >{{ pushHint }}</span
                    >
                </span>
                <input
                    :checked="push === 'on'"
                    :disabled="
                        pushBusy ||
                        push === 'denied' ||
                        push === 'unsupported' ||
                        push === 'unavailable'
                    "
                    type="checkbox"
                    style="
                        width: 20px;
                        height: 20px;
                        flex: none;
                        accent-color: var(--cw-accent);
                    "
                    @change="
                        setPush(($event.target as HTMLInputElement).checked)
                    "
                />
            </label>
        </div>

        <div class="cw-label" style="margin: 26px 0 6px">
            {{ t('derivationSection') }}
        </div>
        <p class="cw-hint" style="margin: 0 0 10px">
            {{ t('derivationHint') }}
        </p>

        <div class="cw-card" style="padding: 0">
            <div
                v-for="row in derivations"
                :key="row.chain"
                class="cw-row"
                style="
                    padding: 13px 16px;
                    border-bottom: 1px solid var(--cw-line);
                "
            >
                <NetworkMark :chain="row.chain" dot :size="9" />
                <span
                    style="
                        flex: 1;
                        font: 400 13px/1.3 var(--cw-sans);
                        color: var(--cw-text);
                    "
                    >{{ row.label }}</span
                >
                <span
                    style="
                        font: 400 11px/1.4 var(--cw-mono);
                        color: var(--cw-dim);
                        text-align: right;
                        word-break: break-all;
                    "
                    >{{ row.path }} · {{ row.curve }}</span
                >
            </div>
        </div>

        <!--
          Networks. The split that matters is who vouched for the endpoint, so
          that is the split the section draws: everything shipped with the
          wallet on one row, everything typed in here on its own removable one.
        -->
        <div class="cw-label" style="margin: 26px 0 10px">
            {{ t('networksSection') }}
        </div>

        <div class="cw-card" style="padding: 0">
            <div
                class="cw-row"
                style="padding: 16px; border-bottom: 1px solid var(--cw-line)"
            >
                <div style="flex: 1">
                    <div
                        style="
                            font: 400 14px/1.3 var(--cw-sans);
                            color: var(--cw-text);
                        "
                    >
                        {{ t('vettedEndpoints') }}
                    </div>
                    <div
                        style="
                            margin-top: 3px;
                            font: 400 11px/1.4 var(--cw-mono);
                            color: var(--cw-dim);
                        "
                    >
                        {{ vetted }}
                    </div>
                </div>
                <span
                    class="cw-label"
                    style="flex: none; color: var(--cw-faint)"
                    >{{ t('verified') }}</span
                >
            </div>

            <div
                v-for="network in wallet.customNetworks.value"
                :key="network.id"
                class="cw-row"
                style="padding: 16px; border-bottom: 1px solid var(--cw-line)"
            >
                <NetworkMark :chain="network.id" dot :size="9" />
                <div style="flex: 1">
                    <div
                        style="
                            font: 400 14px/1.3 var(--cw-sans);
                            color: var(--cw-text);
                        "
                    >
                        {{ network.name }}
                    </div>
                    <div
                        style="
                            margin-top: 3px;
                            font: 400 11px/1.4 var(--cw-mono);
                            color: var(--cw-dim);
                            word-break: break-all;
                        "
                    >
                        {{
                            network.kind === 'evm'
                                ? `chain ${network.chainId}`
                                : `coin ${network.coinType} · ${network.addressType}`
                        }}
                        · {{ t('addedByYou').toLowerCase() }}
                    </div>
                </div>
                <button
                    type="button"
                    class="cw-back"
                    style="flex: none; color: var(--cw-bad-soft)"
                    @click="wallet.removeNetwork(network.id)"
                >
                    {{ t('removeNetwork') }}
                </button>
            </div>

            <p
                v-if="wallet.customNetworks.value.length > 0"
                class="cw-prose"
                style="
                    margin: 0;
                    padding: 12px 16px;
                    border-bottom: 1px solid var(--cw-line);
                    font-size: 11px;
                "
            >
                {{ t('removeNetworkHint') }}
            </p>

            <button
                type="button"
                class="cw-row"
                style="
                    width: 100%;
                    padding: 16px;
                    border: 0;
                    background: none;
                    cursor: pointer;
                    text-align: left;
                "
                @click="emit('addNetwork')"
            >
                <span style="flex: 1">
                    <span
                        style="
                            display: block;
                            font: 400 14px/1.3 var(--cw-sans);
                            color: var(--cw-text);
                        "
                        >{{ t('addNetworkRow') }}</span
                    >
                    <span
                        style="
                            display: block;
                            margin-top: 3px;
                            font: 400 11px/1.4 var(--cw-mono);
                            color: var(--cw-dim);
                        "
                        >{{ t('addNetworkRowHint') }}</span
                    >
                </span>
                <span
                    style="
                        font: 400 12px/1 var(--cw-mono);
                        color: var(--cw-dim);
                    "
                    >→</span
                >
            </button>

            <!--
              The endpoints above are half the story: which hosts answer for
              this wallet. The other half is what carries the question to them,
              and it belongs next to them rather than in a settings page of its
              own.
            -->
            <button
                type="button"
                class="cw-row"
                style="
                    width: 100%;
                    padding: 16px;
                    border: 0;
                    border-top: 1px solid var(--cw-line);
                    background: none;
                    cursor: pointer;
                    text-align: left;
                "
                @click="emit('proxy')"
            >
                <span style="flex: 1">
                    <span
                        style="
                            display: block;
                            font: 400 14px/1.3 var(--cw-sans);
                            color: var(--cw-text);
                        "
                        >{{ t('proxyTitle') }}</span
                    >
                    <span
                        style="
                            display: block;
                            margin-top: 3px;
                            font: 400 11px/1.4 var(--cw-mono);
                            color: var(--cw-dim);
                        "
                        >{{ t('proxyRowHint') }}</span
                    >
                </span>
                <span
                    style="
                        font: 400 12px/1 var(--cw-mono);
                        color: var(--cw-dim);
                    "
                    >→</span
                >
            </button>
        </div>

        <button
            v-if="!unprotected"
            type="button"
            class="cw-btn cw-btn-secondary"
            style="margin-top: 12px; height: 48px"
            @click="
                wallet.lock();
                emit('locked');
            "
        >
            {{ t('lockNow') }}
        </button>

        <!-- Danger zone. -->
        <div
            style="
                margin-top: 34px;
                padding-top: 20px;
                border-top: 1px dashed #2a1a1c;
            "
        >
            <div
                class="cw-label"
                style="margin-bottom: 10px; color: var(--cw-bad)"
            >
                {{ t('dangerZone') }}
            </div>
            <div
                style="
                    padding: 16px;
                    border: 1px solid rgba(255, 92, 104, 0.24);
                    background: rgba(255, 92, 104, 0.04);
                "
            >
                <div
                    style="
                        font: 400 14px/1.3 var(--cw-sans);
                        color: var(--cw-bad-soft);
                    "
                >
                    {{ t('deleteVault') }}
                </div>
                <p class="cw-prose" style="margin-top: 6px; font-size: 12px">
                    {{ t('deleteVaultBody') }}
                </p>
                <button
                    type="button"
                    class="cw-btn cw-btn-danger"
                    style="height: 44px; margin-top: 14px"
                    @click="
                        deleteConfirmation = '';
                        deleting = true;
                    "
                >
                    {{ t('deleteVaultAction') }}
                </button>
            </div>
        </div>

        <!-- Typed confirmation: a second button is a reflex, a word is not. -->
        <div v-if="deleting" class="cw-modal">
            <div
                style="
                    width: 100%;
                    max-width: 420px;
                    padding: 22px;
                    border: 1px solid rgba(255, 92, 104, 0.35);
                    background: var(--cw-surface);
                "
            >
                <div
                    class="cw-label"
                    style="margin-bottom: 12px; color: var(--cw-bad)"
                >
                    {{ t('irreversible') }}
                </div>
                <h3 class="cw-title" style="font-size: 19px">
                    {{ t('deleteTitle') }}
                </h3>
                <p class="cw-prose" style="margin: 10px 0 18px">
                    {{ t('deleteBody') }}
                </p>
                <label
                    class="cw-label"
                    style="display: block; margin-bottom: 8px"
                >
                    {{ t('typeToConfirm', { word: t('deleteWord') }) }}
                </label>
                <input
                    v-model="deleteConfirmation"
                    type="text"
                    class="cw-input"
                    autocomplete="off"
                    spellcheck="false"
                    :placeholder="t('deleteWord')"
                />
                <div style="display: flex; gap: 8px; margin-top: 18px">
                    <button
                        type="button"
                        class="cw-btn cw-btn-secondary"
                        style="height: 48px"
                        @click="deleting = false"
                    >
                        {{ t('cancel') }}
                    </button>
                    <button
                        type="button"
                        class="cw-btn cw-btn-danger"
                        style="height: 48px"
                        :disabled="!canDelete"
                        @click="forget"
                    >
                        {{ t('deleteConfirm') }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
