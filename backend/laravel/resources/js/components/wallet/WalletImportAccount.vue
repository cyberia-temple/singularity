<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { isValidMnemonic, walletChain } from '@/lib/wallet';
import type { WalletChainId } from '@/lib/wallet';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Bringing an account in from outside the seed tree.
 *
 * Three doors, and they are genuinely different things rather than three
 * spellings of one. A phrase is a whole second root with its own backup; a
 * private key is one chain's key and lives only on this device; a watched
 * address holds nothing at all and can never sign. Each says which of those it
 * is *before* the paste, because that is the fact the user will need later and
 * the moment they need it is not a good moment to learn it.
 *
 * Nothing typed here is checked anywhere but in this browser, and nothing is
 * stored until the vault accepts it — a mistyped key fails in front of the
 * person who typed it.
 */

const props = defineProps<{
    wallet: MultiWallet;
}>();

const emit = defineEmits<{
    back: [];
    imported: [];
}>();

const { t } = useLocale(walletMessages);

type Kind = 'phrase' | 'key' | 'watch';

const kind = ref<Kind>('key');
const chain = ref<WalletChainId>('cyberia');
const secret = ref('');
const label = ref('');
const busy = ref(false);
const failure = ref<string | null>(null);

const KINDS: { id: Kind; label: string; hint: string }[] = [
    { id: 'phrase', label: 'importKindPhrase', hint: 'importKindPhraseHint' },
    { id: 'key', label: 'importKindKey', hint: 'importKindKeyHint' },
    { id: 'watch', label: 'importKindWatch', hint: 'importKindWatchHint' },
];

/**
 * Which networks can take a pasted key at all.
 *
 * Monero is absent on purpose rather than by omission: nothing here can spend
 * it, so storing a live spend key would buy an address the phrase already
 * derives at the price of holding a secret for no capability.
 */
const keyChains = computed(() =>
    props.wallet.chains.value.filter((entry) => entry.importKey !== undefined),
);

/** A watched address needs no key, so every network can hold one. */
const watchChains = computed(() => props.wallet.chains.value);

const chains = computed(() =>
    kind.value === 'key' ? keyChains.value : watchChains.value,
);

const words = computed(
    () => secret.value.trim().split(/\s+/).filter(Boolean).length,
);

/** Whether what has been typed so far could possibly be accepted. */
const looksValid = computed(() => {
    const value = secret.value.trim();

    if (value.length === 0) {
        return false;
    }

    if (kind.value === 'phrase') {
        return isValidMnemonic(value);
    }

    if (kind.value === 'watch') {
        try {
            return walletChain(chain.value).isValidAddress(value);
        } catch {
            return false;
        }
    }

    return value.replace(/^0x/, '').length >= 32;
});

const status = computed(() => {
    if (secret.value.trim().length === 0) {
        return {
            text: t(
                kind.value === 'phrase'
                    ? 'importAwaitPhrase'
                    : kind.value === 'key'
                      ? 'importAwaitKey'
                      : 'importAwaitAddress',
            ),
            tone: 'var(--cw-faint)',
        };
    }

    if (kind.value === 'phrase' && !looksValid.value) {
        return {
            text: t('importPhraseProgress', { count: words.value }),
            tone: 'var(--cw-pending)',
        };
    }

    return looksValid.value
        ? { text: t('importLooksValid'), tone: 'var(--cw-ok)' }
        : { text: t('importUnrecognised'), tone: 'var(--cw-pending)' };
});

const warning = computed(() =>
    t(
        kind.value === 'phrase'
            ? 'importWarnPhrase'
            : kind.value === 'key'
              ? 'importWarnKey'
              : 'importWarnWatch',
    ),
);

// A key is a key of one chain, so switching to a kind that names one has to
// land on a network that can actually take it.
watch([kind, keyChains], () => {
    failure.value = null;

    if (
        kind.value === 'key' &&
        !keyChains.value.some((entry) => entry.id === chain.value)
    ) {
        chain.value = keyChains.value[0]?.id ?? 'cyberia';
    }
});

const submit = async (): Promise<void> => {
    if (!looksValid.value || busy.value) {
        return;
    }

    busy.value = true;
    failure.value = null;

    try {
        const problem = await props.wallet.importAccount({
            kind: kind.value,
            chain: chain.value,
            secret: secret.value,
            label: label.value.trim() || null,
        });

        if (problem !== null) {
            failure.value = problem;

            return;
        }

        // The secret is dropped the instant the vault has it, so a screen left
        // open behind a navigation is not still holding a private key.
        secret.value = '';
        label.value = '';
        emit('imported');
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('accounts') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ t('importAccountTitle') }}
        </h2>
        <p class="cw-prose">{{ t('importAccountBody') }}</p>

        <div style="display: flex; gap: 6px; margin-top: 20px">
            <button
                v-for="entry in KINDS"
                :key="entry.id"
                type="button"
                class="cw-tile"
                :aria-pressed="kind === entry.id"
                :style="
                    kind === entry.id
                        ? {
                              borderColor: 'var(--cw-accent)',
                              background: 'var(--cw-raised)',
                          }
                        : undefined
                "
                @click="kind = entry.id"
            >
                <span
                    class="cw-label"
                    :style="{
                        color:
                            kind === entry.id
                                ? 'var(--cw-text)'
                                : 'var(--cw-muted)',
                    }"
                    >{{ t(entry.label) }}</span
                >
                <span class="cw-label" style="color: var(--cw-faint)">{{
                    t(entry.hint)
                }}</span>
            </button>
        </div>

        <!--
          A phrase spans every network by itself, so asking which one it is for
          would be asking a question with no answer.
        -->
        <template v-if="kind !== 'phrase'">
            <div class="cw-label" style="margin-top: 22px">
                {{ t('importNetwork') }}
            </div>
            <div
                style="
                    display: flex;
                    gap: 6px;
                    flex-wrap: wrap;
                    margin-top: 8px;
                "
            >
                <button
                    v-for="entry in chains"
                    :key="entry.id"
                    type="button"
                    class="cw-ghost"
                    :aria-pressed="chain === entry.id"
                    :style="
                        chain === entry.id
                            ? {
                                  borderColor: 'var(--cw-accent)',
                                  color: 'var(--cw-text)',
                              }
                            : undefined
                    "
                    @click="chain = entry.id"
                >
                    <NetworkMark :chain="entry.id" dot :size="7" />
                    {{ entry.label }}
                </button>
            </div>
            <p
                v-if="
                    kind === 'key' &&
                    keyChains.length < wallet.chains.value.length
                "
                class="cw-label"
                style="margin-top: 8px; color: var(--cw-faint)"
            >
                {{ t('importKeyChainsNote') }}
            </p>
        </template>

        <div class="cw-label" style="margin-top: 22px">
            {{ t('importName') }}
        </div>
        <input
            v-model="label"
            class="cw-input"
            style="margin-top: 8px"
            :placeholder="t('importNamePlaceholder')"
        />

        <div class="cw-label" style="margin-top: 18px">
            {{ kind === 'watch' ? t('importAddress') : t('importSecret') }}
        </div>
        <textarea
            v-model="secret"
            class="cw-textarea"
            style="margin-top: 8px; height: 120px"
            :aria-invalid="
                secret.trim().length > 0 && !looksValid ? 'true' : undefined
            "
            :placeholder="
                kind === 'phrase'
                    ? t('importPlaceholderPhrase')
                    : kind === 'key'
                      ? t('importPlaceholderKey')
                      : t('importPlaceholderAddress')
            "
            spellcheck="false"
            autocomplete="off"
        ></textarea>
        <div
            style="margin-top: 10px; font: 500 13px/1 var(--cw-mono)"
            :style="{ color: status.tone }"
        >
            {{ status.text }}
        </div>

        <p class="cw-note cw-note-warn" style="margin-top: 18px">
            <span>{{ warning }}</span>
        </p>

        <p v-if="failure" class="cw-note cw-note-bad" style="margin-top: 12px">
            <span>{{ failure }}</span>
        </p>

        <button
            type="button"
            class="cw-btn cw-btn-primary"
            style="margin-top: 20px"
            :disabled="!looksValid || busy"
            @click="submit"
        >
            {{ kind === 'watch' ? t('importWatchAction') : t('importAction') }}
        </button>
    </div>
</template>
