<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { analytics } from '@/lib/analytics';
import { isValidMnemonic, shippedChains } from '@/lib/wallet';
import { walletMessages } from '@/lib/walletMessages';

/**
 * All that is left of onboarding: the phrase somebody already has.
 *
 * A first launch asks nothing now — the wallet generates a phrase, writes the
 * vault open and shows the portfolio (`Wallet.vue`, `startFresh`). The welcome
 * screen went with that decision, and the risk notice, the held reveal and the
 * backup check went with the welcome screen: they were four forms standing
 * between a person and an address that takes a millisecond to derive. What
 * cannot be generated is the case this screen is for — a wallet that already
 * exists somewhere else — and it is reached from the lock screen, which is also
 * the way back in after a forgotten password.
 *
 * Nothing here talks to the server, and nothing secret outlives the component.
 */

const emit = defineEmits<{
    /**
     * A phrase to put into this device's vault. The arguments are the ones
     * `adopt()` takes on the page, spelled out rather than defaulted: a null
     * password means the owner declined one and never that a field arrived
     * unset, and an imported phrase is by definition written down already —
     * it was typed in from wherever it was kept.
     */
    adopt: [
        phrase: string,
        password: string | null,
        origin: 'imported',
        backedUp: boolean,
    ];
    /** Left without adopting anything — the stored vault is untouched. */
    cancel: [];
}>();

const props = defineProps<{ busy: boolean }>();

const { t } = useLocale(walletMessages);

const step = ref<'import' | 'password'>('import');
const importText = ref('');
const password = ref('');
const passwordAgain = ref('');

/*
 * The import half of the onboarding funnel, counted from the moment this
 * screen opens rather than from a tap on a welcome screen that no longer
 * exists. Nothing here reports what was typed — only that it was entered.
 */
onMounted(() => {
    analytics.track('wallet_import_started');
});

const importWords = computed(
    () => importText.value.trim().split(/\s+/).filter(Boolean).length,
);

const importValid = computed(
    () =>
        (importWords.value === 12 || importWords.value === 24) &&
        isValidMnemonic(importText.value),
);

const pasteImport = async (): Promise<void> => {
    importText.value = await navigator.clipboard.readText();
};

const passwordScore = computed(() =>
    Math.min(4, Math.floor(password.value.length / 3)),
);

const passwordLabel = computed(() => {
    if (password.value.length === 0) {
        return t('strengthUnset');
    }

    return passwordScore.value >= 3
        ? t('strengthStrong')
        : passwordScore.value >= 2
          ? t('strengthOk')
          : t('strengthWeak');
});

const passwordOk = computed(
    () => password.value.length >= 8 && password.value === passwordAgain.value,
);

const adopt = (secret: string | null): void => {
    emit('adopt', importText.value.trim(), secret, 'imported', true);
};

const submit = (): void => {
    if (!passwordOk.value) {
        return;
    }

    adopt(password.value);
};

/**
 * Take the vault with no password on it.
 *
 * The wallet is on this device either way; a password decides who else on this
 * device can spend from it. Somebody on their own phone may reasonably not
 * want a second lock behind the one the phone already has, and forcing one
 * there mostly produces `qwerty12`. The consequence is stated on the screen,
 * not softened, and Security can add a password later without touching a
 * single account.
 */
const skipPassword = (): void => {
    adopt(null);
};

/** Nothing secret outlives this component. */
onBeforeUnmount(() => {
    importText.value = '';
    password.value = '';
    passwordAgain.value = '';
});
</script>

<template>
    <!-- Import -->
    <div v-if="step === 'import'" class="cw-stack cw-screen">
        <button type="button" class="cw-back" @click="emit('cancel')">
            ← {{ t('back') }}
        </button>
        <h2 class="cw-title" style="margin-top: 24px">
            {{ t('importTitle') }}
        </h2>
        <p class="cw-prose" style="margin: 8px 0 20px">{{ t('importBody') }}</p>

        <textarea
            v-model="importText"
            class="cw-textarea"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            :aria-invalid="importWords > 0 && !importValid"
            :aria-label="t('importTitle')"
            :placeholder="t('importPlaceholder')"
        ></textarea>

        <div class="cw-row" style="margin-top: 10px">
            <span
                style="font: 500 13px/1.4 var(--cw-mono)"
                :style="{
                    color:
                        importWords === 0
                            ? 'var(--cw-dim)'
                            : importValid
                              ? 'var(--cw-ok)'
                              : 'var(--cw-pending)',
                }"
            >
                {{
                    importWords === 0
                        ? t('importEmpty')
                        : importValid
                          ? t('importValid')
                          : importWords === 12 || importWords === 24
                            ? t('importInvalid')
                            : t('importCount', { count: importWords })
                }}
            </span>
            <button type="button" class="cw-ghost" @click="pasteImport">
                {{ t('paste') }}
            </button>
        </div>

        <!--
          What one phrase covers, which is a fact about derivation and not
          about the network list: the seed walks every one of these paths
          whatever the portfolio is currently switched on to draw.
        -->
        <div class="cw-card" style="margin-top: 24px">
            <div class="cw-label" style="margin-bottom: 14px">
                {{ t('willDerive') }}
            </div>
            <div class="cw-stack" style="gap: 10px">
                <div
                    v-for="chain in shippedChains()"
                    :key="chain.id"
                    class="cw-row"
                >
                    <span class="cw-data">{{ chain.label }}</span>
                    <span
                        style="
                            font: 500 13px/1 var(--cw-mono);
                            color: var(--cw-dim);
                        "
                        >{{ chain.path }}</span
                    >
                </div>
            </div>
        </div>

        <div class="cw-fill" style="min-height: 20px"></div>
        <button
            type="button"
            class="cw-btn cw-btn-primary"
            style="margin-top: 20px"
            :disabled="!importValid"
            @click="step = 'password'"
        >
            {{ t('continueLabel') }}
        </button>
    </div>

    <!-- Vault password -->
    <form v-else class="cw-stack cw-screen" @submit.prevent="submit">
        <div class="cw-row">
            <button type="button" class="cw-back" @click="step = 'import'">
                ← {{ t('back') }}
            </button>
            <span class="cw-label">{{ t('localVault') }}</span>
        </div>

        <h2 class="cw-title" style="margin-top: 16px">
            {{ t('passwordTitle') }}
        </h2>
        <p class="cw-prose" style="margin: 8px 0 24px">
            {{ t('passwordBody') }}
        </p>

        <div class="cw-stack" style="gap: 14px">
            <label class="cw-stack" style="gap: 8px">
                <span class="cw-label">{{ t('password') }}</span>
                <input
                    v-model="password"
                    type="password"
                    class="cw-input"
                    autocomplete="new-password"
                    placeholder="••••••••••••"
                />
            </label>
            <label class="cw-stack" style="gap: 8px">
                <span class="cw-label">{{ t('passwordAgain') }}</span>
                <input
                    v-model="passwordAgain"
                    type="password"
                    class="cw-input"
                    autocomplete="new-password"
                    placeholder="••••••••••••"
                    :aria-invalid="
                        passwordAgain.length > 0 && password !== passwordAgain
                    "
                />
            </label>
        </div>

        <div style="display: flex; gap: 4px; margin-top: 14px">
            <span
                v-for="bar in 4"
                :key="bar"
                style="flex: 1; height: 3px"
                :style="{
                    background:
                        bar <= passwordScore
                            ? passwordScore >= 3
                                ? 'var(--cw-ok)'
                                : 'var(--cw-pending)'
                            : '#1b2126',
                }"
            />
        </div>
        <div class="cw-row" style="margin-top: 8px">
            <span
                style="font: 500 13px/1 var(--cw-mono)"
                :style="{
                    color:
                        password.length === 0
                            ? 'var(--cw-faint)'
                            : passwordScore >= 3
                              ? 'var(--cw-ok)'
                              : 'var(--cw-pending)',
                }"
                >{{ passwordLabel }}</span
            >
            <span class="cw-label" style="color: var(--cw-faint)">{{
                t('minChars')
            }}</span>
        </div>

        <p
            v-if="passwordAgain.length > 0 && password !== passwordAgain"
            class="cw-note cw-note-bad"
            style="margin-top: 14px"
        >
            <span>{{ t('passwordMismatch') }}</span>
        </p>

        <div class="cw-card" style="margin-top: 24px; padding: 14px 16px">
            <div class="cw-stack" style="gap: 8px">
                <div class="cw-row">
                    <span class="cw-data" style="color: var(--cw-muted)">{{
                        t('encryption')
                    }}</span>
                    <span class="cw-data">{{ t('encryptionValue') }}</span>
                </div>
                <div class="cw-row">
                    <span class="cw-data" style="color: var(--cw-muted)">{{
                        t('keyDerivation')
                    }}</span>
                    <span class="cw-data">{{ t('keyDerivationValue') }}</span>
                </div>
                <div class="cw-row">
                    <span class="cw-data" style="color: var(--cw-muted)">{{
                        t('storage')
                    }}</span>
                    <span class="cw-data">{{ t('storageValue') }}</span>
                </div>
            </div>
        </div>

        <div class="cw-fill" style="min-height: 20px"></div>
        <button
            type="submit"
            class="cw-btn cw-btn-primary"
            style="margin-top: 20px"
            :disabled="!passwordOk || props.busy"
        >
            {{ t('createVault') }}
        </button>
        <!--
          A password decides who else *on this device* can spend; the wallet is
          on the device either way. Somebody on their own phone may reasonably
          decline a second lock behind the one the phone already has, and a
          form that refuses mostly produces `qwerty12`. What is not negotiable
          is saying what it costs, which the sentence under this button does.
        -->
        <button
            type="button"
            class="cw-back"
            style="margin-top: 14px; align-self: center"
            :disabled="props.busy"
            @click="skipPassword"
        >
            {{ t('skipPassword') }}
        </button>
        <p
            class="cw-label"
            style="
                margin-top: 8px;
                text-align: center;
                text-transform: none;
                letter-spacing: 0;
                color: var(--cw-faint);
            "
        >
            {{ t('skipPasswordNote') }}
        </p>
    </form>
</template>
