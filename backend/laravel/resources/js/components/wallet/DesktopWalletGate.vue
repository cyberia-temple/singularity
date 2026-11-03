<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { useMultiWallet } from '@/composables/useMultiWallet';
import { createMnemonic, isValidMnemonic } from '@/lib/wallet';
import { walletMessages } from '@/lib/walletMessages';

const { t } = useLocale(walletMessages);
const wallet = useMultiWallet();
const importing = ref(false);
const phrase = ref('');
const password = ref('');
const again = ref('');
const error = ref('');
const ready = computed(
    () => wallet.exists.value && wallet.protection.value === 'password',
);
const valid = computed(
    () =>
        password.value.length >= 12 &&
        password.value === again.value &&
        (!importing.value || isValidMnemonic(phrase.value)),
);

async function create(): Promise<void> {
    if (!valid.value || wallet.busy.value) {
return;
}

    error.value = '';

    try {
        if (wallet.exists.value && wallet.protection.value === 'none') {
            await wallet.protect(password.value);
        } else {
            await wallet.adopt(
                importing.value ? phrase.value : createMnemonic(24),
                password.value,
                importing.value,
            );
        }
    } catch (failure) {
        error.value =
            failure instanceof Error ? failure.message : String(failure);
    } finally {
        phrase.value = '';
        password.value = '';
        again.value = '';
    }
}

onBeforeUnmount(() => {
    phrase.value = '';
    password.value = '';
    again.value = '';
});
</script>

<template>
    <slot v-if="ready" />
    <main v-else class="cw cw-desktop-setup" data-desktop-setup>
        <form class="cw-stack" @submit.prevent="create">
            <div class="cw-label">CYBERIA / {{ t('localVault') }}</div>
            <h1 class="cw-title">{{ t('passwordTitle') }}</h1>
            <p class="cw-prose">{{ t('passwordBody') }}</p>
            <div v-if="!wallet.exists.value" class="cw-row">
                <button
                    type="button"
                    class="cw-back"
                    :aria-pressed="!importing"
                    @click="importing = false"
                >
                    {{ t('createWallet') }}
                </button>
                <button
                    type="button"
                    class="cw-back"
                    :aria-pressed="importing"
                    @click="importing = true"
                >
                    {{ t('importWallet') }}
                </button>
            </div>
            <textarea
                v-if="importing"
                v-model="phrase"
                class="cw-textarea"
                :aria-label="t('importTitle')"
                :placeholder="t('importPlaceholder')"
                autocomplete="off"
                autocapitalize="none"
                spellcheck="false"
            />
            <label class="cw-stack">
                <span class="cw-label">{{ t('password') }} · 12+</span>
                <input
                    v-model="password"
                    class="cw-input"
                    type="password"
                    autocomplete="new-password"
                    minlength="12"
                    :aria-label="t('password')"
                    data-desktop-password
                />
            </label>
            <label class="cw-stack">
                <span class="cw-label">{{ t('passwordAgain') }}</span>
                <input
                    v-model="again"
                    class="cw-input"
                    type="password"
                    autocomplete="new-password"
                    minlength="12"
                    :aria-label="t('passwordAgain')"
                    data-desktop-password-again
                />
            </label>
            <p v-if="error" role="alert" class="cw-note cw-note-bad">
                {{ error }}
            </p>
            <button
                type="submit"
                class="cw-btn cw-btn-primary"
                :disabled="!valid || wallet.busy.value"
                data-desktop-create
            >
                {{ importing ? t('importWallet') : t('createWallet') }}
            </button>
        </form>
    </main>
</template>

<style scoped>
.cw-desktop-setup {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: 40px 24px;
    background: #0b0f10;
    color: #eee;
}
form {
    width: min(100%, 440px);
    gap: 20px;
}
</style>
