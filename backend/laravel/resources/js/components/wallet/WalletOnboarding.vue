<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { useSecureClipboard } from '@/composables/useSecureClipboard';
import { analytics } from '@/lib/analytics';
import { createMnemonic, isValidMnemonic, walletChains } from '@/lib/wallet';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Onboarding: welcome → risk notice → seed → backup check → password, or the
 * import branch that skips straight to the password.
 *
 * The phrase is generated here and lives in this component only. It is shown
 * exactly once, behind a held finger, and is dropped when the component goes
 * away. Nothing on this path talks to the server: the very first screen has to
 * be true, or none of the custody claims after it are.
 */

const emit = defineEmits<{
    /**
     * A phrase the user has backed up, ready to be sealed with a password.
     * The third argument says which branch produced it — the two are the same
     * thing by the time they are stored, and completely different funnels.
     */
    adopt: [
        phrase: string,
        /** Null when the owner declined one and the vault is stored open. */
        password: string | null,
        origin: 'created' | 'imported',
        /** False when the backup check was skipped. */
        backedUp: boolean,
    ];
    /** Left the flow without adopting anything — the vault is untouched. */
    cancel: [];
}>();

type Step = 'welcome' | 'risk' | 'seed' | 'confirm' | 'import' | 'password';

const props = withDefaults(
    defineProps<{
        busy: boolean;
        /**
         * Where to open. Restoring after a forgotten password lands on import
         * directly, and can be abandoned without touching the stored vault.
         */
        start?: Step;
        cancellable?: boolean;
        /**
         * Inside Telegram's frame.
         *
         * Creating a wallet works here exactly as it does anywhere else —
         * risk notice, held reveal, backup check — because a Mini App that
         * cannot make a wallet sends every newcomer away at the one moment
         * they were willing to start. What is different is where the vault
         * lands: Telegram's own web-view storage, which Telegram empties
         * without asking. That is said on the first screen, before a phrase
         * exists, since the phrase is what makes it survivable.
         */
        telegram?: boolean;
    }>(),
    { start: 'welcome', cancellable: false, telegram: false },
);

const { t } = useLocale(walletMessages);
const clipboard = useSecureClipboard();

const step = ref<Step>(props.start);
const words = ref<12 | 24>(12);
const phrase = ref('');
const revealed = ref(false);
const latched = ref(false);
const acknowledged = ref(false);
const importText = ref('');
const password = ref('');
const passwordAgain = ref('');
const slots = ref<(string | null)[]>([null, null, null]);
/** Whether the phrase was actually written down before the vault was made. */
const backedUp = ref(true);
const wrongOrder = ref(false);

/** True while the user came in through import rather than generation. */
const importing = computed(
    () => phrase.value === '' || step.value === 'import',
);

const seedWords = computed(() => phrase.value.split(' ').filter(Boolean));

/**
 * Positions the user has to prove they wrote down. Drawn once per phrase and
 * spread across it, so copying only the first line does not pass.
 */
const targets = ref<number[]>([]);

const pickTargets = (count: number): number[] => {
    const third = Math.floor(count / 3);
    const random = (from: number, to: number): number =>
        from + Math.floor(Math.random() * (to - from));

    return [
        random(0, third),
        random(third, third * 2),
        random(third * 2, count),
    ];
};

const generate = (): void => {
    phrase.value = createMnemonic(words.value);
    targets.value = pickTargets(words.value);
    slots.value = [null, null, null];
    wrongOrder.value = false;
    revealed.value = false;
    latched.value = false;
};

/** Backing out of import: to the welcome screen, or out of the flow entirely. */
const leaveImport = (): void => {
    if (props.cancellable && props.start === 'import') {
        emit('cancel');
    } else {
        step.value = 'welcome';
    }
};

const goSeed = (): void => {
    generate();
    step.value = 'seed';
};

/*
 * Onboarding funnel. The two branches are counted separately from the first
 * tap, because they answer different questions: creations are new users this
 * product made, imports are users it took from somewhere else, and a number
 * that added them together would flatter whichever one is failing.
 *
 * Nothing here reports what was typed, generated or chosen — only that a
 * branch was entered.
 */
const startCreate = (): void => {
    analytics.track('wallet_creation_started');
    step.value = 'risk';
};

const startImport = (): void => {
    analytics.track('wallet_import_started');
    step.value = 'import';
};

const setWords = (next: 12 | 24): void => {
    words.value = next;
    generate();
};

/** The three answers plus decoys taken from the phrase the user just saw. */
const chips = computed(() => {
    const answers = targets.value.map((index) => seedWords.value[index]);
    const decoys = seedWords.value.filter((word) => !answers.includes(word));
    const pool = [...answers, ...decoys.slice(0, 5)];

    // Deterministic shuffle keyed on the phrase: stable across re-renders, so
    // chips do not jump under a finger mid-tap.
    return pool
        .map((word) => ({ word, key: `${word}:${phrase.value.length}` }))
        .sort((a, b) => (a.key < b.key ? -1 : 1))
        .map((entry) => entry.word);
});

const backupOk = computed(() =>
    targets.value.every(
        (target, index) => slots.value[index] === seedWords.value[target],
    ),
);

const pickChip = (word: string): void => {
    if (slots.value.includes(word)) {
        return;
    }

    const free = slots.value.indexOf(null);

    if (free < 0) {
        return;
    }

    slots.value[free] = word;
    wrongOrder.value = false;
};

const clearSlot = (index: number): void => {
    slots.value[index] = null;
    wrongOrder.value = false;
};

const confirmBackup = (): void => {
    if (backupOk.value) {
        backedUp.value = true;
        step.value = 'password';
    } else {
        wrongOrder.value = true;
    }
};

/**
 * Move on without writing the phrase down.
 *
 * It is the owner's phrase and refusing to continue without a ritual only
 * teaches people to copy twelve words into a screenshot to get past the form.
 * What this cannot do is pretend it did not happen: the vault carries
 * `backedUp: false`, Security says so until the phrase has actually left the
 * device, and the sentence on the button says what is being accepted.
 */
const skipBackup = (): void => {
    backedUp.value = false;
    step.value = 'password';
};

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
    emit(
        'adopt',
        importing.value ? importText.value.trim() : phrase.value,
        secret,
        importing.value ? 'imported' : 'created',
        // An imported phrase is by definition written down somewhere already:
        // it was typed in from wherever it was kept.
        importing.value ? true : backedUp.value,
    );
};

const submit = (): void => {
    if (!passwordOk.value) {
        return;
    }

    adopt(password.value);
};

/**
 * Create the vault with no password on it.
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

/**
 * Press-and-hold reveal, with a latch.
 *
 * A press shows the phrase at once and a release hides it again — a peek costs
 * a deliberate gesture, which is the point. But the phone is held in the hand
 * that has to write twelve words down, so a hold carried past `SEED_LATCH_MS`
 * leaves the phrase open until it is closed by hand. Without that the words are
 * only ever visible while a thumb is on the screen, which is not enough time to
 * copy them onto paper.
 */
const SEED_LATCH_MS = 900;

const holdProgress = ref(0);

let holdFrame: number | null = null;
let holdStartedAt = 0;

const stopHold = (): void => {
    if (holdFrame !== null) {
        cancelAnimationFrame(holdFrame);
        holdFrame = null;
    }

    holdProgress.value = 0;
};

const tickHold = (): void => {
    holdProgress.value = Math.min(
        1,
        (performance.now() - holdStartedAt) / SEED_LATCH_MS,
    );

    if (holdProgress.value >= 1) {
        latched.value = true;
        stopHold();

        return;
    }

    holdFrame = requestAnimationFrame(tickHold);
};

const pressReveal = (): void => {
    // Latched, the same button is the way back to a covered screen.
    if (latched.value) {
        latched.value = false;
        revealed.value = false;

        return;
    }

    revealed.value = true;

    if (holdFrame === null) {
        holdStartedAt = performance.now();
        holdFrame = requestAnimationFrame(tickHold);
    }
};

const releaseReveal = (): void => {
    stopHold();

    if (!latched.value) {
        revealed.value = false;
    }
};

const onRevealKey = (event: KeyboardEvent, pressed: boolean): void => {
    if (event.key !== ' ' && event.key !== 'Enter') {
        return;
    }

    // A held key repeats; only the first press starts the countdown.
    event.preventDefault();

    if (pressed) {
        if (!event.repeat) {
            pressReveal();
        }

        return;
    }

    releaseReveal();
};

/** Nothing secret outlives this component. */
onBeforeUnmount(() => {
    stopHold();
    phrase.value = '';
    importText.value = '';
    password.value = '';
    passwordAgain.value = '';
});
</script>

<template>
    <!-- Welcome -->
    <div
        v-if="step === 'welcome'"
        class="cw-stack cw-screen"
        style="justify-content: space-between; gap: 48px"
    >
        <div>
            <h1 class="cw-display" style="white-space: pre-line">
                {{ t('welcomeHeadline') }}
            </h1>
            <p class="cw-prose" style="margin-top: 20px; max-width: 34ch">
                {{ t('welcomeBody') }}
            </p>
        </div>

        <div class="cw-stack" style="gap: 10px">
            <div
                style="
                    display: flex;
                    flex-wrap: wrap;
                    gap: 14px;
                    padding: 12px 0 20px;
                    border-top: 1px solid var(--cw-line);
                "
            >
                <span
                    v-for="chain in walletChains()"
                    :key="chain.id"
                    class="cw-label"
                    style="color: var(--cw-faint)"
                    >{{ chain.label }}</span
                >
            </div>
            <button
                type="button"
                class="cw-btn cw-btn-primary"
                @click="startCreate()"
            >
                {{ t('createWallet') }}
            </button>
            <button
                type="button"
                class="cw-btn cw-btn-secondary"
                @click="startImport()"
            >
                {{ t('importWallet') }}
            </button>

            <!--
                What is actually different about creating a wallet in here: the
                storage it lands in belongs to Telegram, and Telegram empties it
                without asking. Said before the phrase exists rather than after.

                One child, because `.cw-note` is a flex row whose first item is
                the marker dot — two children lay out as two columns.
            -->
            <div v-if="telegram" class="cw-note" style="margin-top: 4px">
                <span>{{ t('tgStorageWarning') }}</span>
            </div>
            <p
                class="cw-label"
                style="
                    margin: 8px 0 0;
                    text-align: center;
                    color: var(--cw-faint);
                "
            >
                {{ t('welcomeFinePrint') }}
            </p>
        </div>
    </div>

    <!-- Risk notice -->
    <div v-else-if="step === 'risk'" class="cw-stack cw-screen">
        <button type="button" class="cw-back" @click="step = 'welcome'">
            ← {{ t('back') }}
        </button>
        <h2 class="cw-title" style="margin-top: 24px">{{ t('riskTitle') }}</h2>
        <p class="cw-prose" style="margin: 8px 0 28px">{{ t('riskBody') }}</p>

        <ol
            class="cw-stack"
            style="
                gap: 1px;
                margin: 0;
                padding: 0;
                list-style: none;
                border: 1px solid var(--cw-line);
                background: var(--cw-line);
            "
        >
            <li
                v-for="(risk, index) in [t('risk1'), t('risk2'), t('risk3')]"
                :key="index"
                style="
                    display: flex;
                    gap: 14px;
                    padding: 16px;
                    background: #0b0d10;
                "
            >
                <span
                    style="
                        font: 500 11px/1.5 var(--cw-mono);
                        color: var(--cw-meta);
                    "
                    >{{ String(index + 1).padStart(2, '0') }}</span
                >
                <span
                    style="
                        font: 400 13px/1.55 var(--cw-sans);
                        color: var(--cw-body);
                    "
                    >{{ risk }}</span
                >
            </li>
        </ol>

        <label
            style="
                display: flex;
                gap: 12px;
                align-items: flex-start;
                margin-top: 24px;
                padding: 14px 4px;
                min-height: 44px;
                cursor: pointer;
            "
        >
            <input
                v-model="acknowledged"
                type="checkbox"
                style="
                    width: 18px;
                    height: 18px;
                    flex: none;
                    margin: 1px 0 0;
                    accent-color: var(--cw-accent);
                "
            />
            <span style="font: 400 13px/1.5 var(--cw-sans); color: #b6bec6">{{
                t('riskAck')
            }}</span>
        </label>

        <div class="cw-fill" style="min-height: 20px"></div>
        <button
            type="button"
            class="cw-btn cw-btn-primary"
            :disabled="!acknowledged"
            @click="goSeed"
        >
            {{ t('generateSeed') }}
        </button>
    </div>

    <!-- Seed reveal -->
    <div v-else-if="step === 'seed'" class="cw-stack cw-screen">
        <div class="cw-row">
            <button type="button" class="cw-back" @click="step = 'risk'">
                ← {{ t('back') }}
            </button>
            <span class="cw-label">{{
                t('stepOf', { step: 1, total: 2 })
            }}</span>
        </div>

        <h2 class="cw-title" style="margin-top: 16px">{{ t('seedTitle') }}</h2>
        <p class="cw-prose" style="margin: 8px 0 16px">
            {{ t('seedBody', { count: words }) }}
        </p>

        <div class="cw-seg" style="margin-bottom: 16px">
            <button
                v-for="option in [12, 24] as const"
                :key="option"
                type="button"
                class="cw-seg-item"
                :aria-pressed="words === option"
                @click="setWords(option)"
            >
                {{ option === 12 ? t('words12') : t('words24') }}
            </button>
        </div>

        <div
            style="
                position: relative;
                padding: 16px;
                border: 1px solid #1b2126;
                background: var(--cw-surface);
            "
        >
            <ol
                style="
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 1px;
                    margin: 0;
                    padding: 0;
                    list-style: none;
                    background: var(--cw-line);
                    transition:
                        filter 0.18s,
                        opacity 0.18s;
                "
                :style="{
                    filter: revealed ? 'blur(0)' : 'blur(7px)',
                    opacity: revealed ? 1 : 0.55,
                }"
            >
                <li
                    v-for="(word, index) in seedWords"
                    :key="index"
                    style="
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        padding: 11px 12px;
                        background: var(--cw-surface);
                    "
                >
                    <span
                        style="
                            width: 18px;
                            font: 400 10px/1 var(--cw-mono);
                            color: var(--cw-faint);
                        "
                        >{{ String(index + 1).padStart(2, '0') }}</span
                    >
                    <span
                        style="
                            font: 500 13px/1 var(--cw-mono);
                            color: var(--cw-text);
                        "
                        >{{ word }}</span
                    >
                </li>
            </ol>

            <div
                v-if="!revealed"
                class="cw-stack"
                style="
                    position: absolute;
                    inset: 0;
                    align-items: center;
                    justify-content: center;
                    gap: 6px;
                    background: rgba(7, 8, 10, 0.55);
                    user-select: none;
                    -webkit-user-select: none;
                "
            >
                <span class="cw-label" style="color: var(--cw-muted)">{{
                    t('seedHidden')
                }}</span>
                <span
                    style="
                        font: 400 11px/1 var(--cw-mono);
                        color: var(--cw-faint);
                    "
                    >{{ t('seedHiddenHint') }}</span
                >
            </div>
        </div>

        <button
            type="button"
            class="cw-ghost"
            style="
                position: relative;
                overflow: hidden;
                margin-top: 12px;
                height: 48px;
                width: 100%;
                touch-action: none;
            "
            :aria-pressed="latched"
            @pointerdown.prevent="pressReveal"
            @pointerup="releaseReveal"
            @pointerleave="releaseReveal"
            @pointercancel="releaseReveal"
            @keydown="onRevealKey($event, true)"
            @keyup="onRevealKey($event, false)"
            @blur="releaseReveal"
        >
            <span
                aria-hidden="true"
                :style="{
                    position: 'absolute',
                    inset: 'auto auto 0 0',
                    height: '2px',
                    width: `${holdProgress * 100}%`,
                    background: 'var(--cw-accent)',
                }"
            />
            <span style="position: relative">{{
                latched ? t('hidePhrase') : t('holdToReveal')
            }}</span>
        </button>

        <div style="display: flex; gap: 10px; margin-top: 10px">
            <button
                type="button"
                class="cw-ghost"
                style="flex: 1"
                @click="clipboard.copy(phrase, 'phrase')"
            >
                {{
                    clipboard.copied.value === 'phrase'
                        ? t('copiedLabel')
                        : t('copyPhrase')
                }}
            </button>
            <span
                class="cw-ghost"
                style="flex: 1; cursor: default; color: var(--cw-faint)"
                >{{ t('clipboardClears') }}</span
            >
        </div>

        <p class="cw-note cw-note-warn" style="margin-top: 18px">
            <span>{{ t('seedWarn') }}</span>
        </p>

        <div class="cw-fill" style="min-height: 20px"></div>
        <button
            type="button"
            class="cw-btn cw-btn-primary"
            style="margin-top: 20px"
            @click="step = 'confirm'"
        >
            {{ t('wroteItDown') }}
        </button>
        <!--
          The way past the ritual, offered here rather than hidden: a flow that
          will not continue without it teaches people to screenshot twelve
          words to get through the form, which is worse than every outcome it
          was defending against.
        -->
        <button
            type="button"
            class="cw-back"
            style="margin-top: 12px; align-self: center"
            @click="skipBackup"
        >
            {{ t('skipBackup') }}
        </button>
    </div>

    <!-- Backup confirmation -->
    <div v-else-if="step === 'confirm'" class="cw-stack cw-screen">
        <div class="cw-row">
            <button type="button" class="cw-back" @click="step = 'seed'">
                ← {{ t('back') }}
            </button>
            <span class="cw-label">{{
                t('stepOf', { step: 2, total: 2 })
            }}</span>
        </div>

        <h2 class="cw-title" style="margin-top: 16px">
            {{ t('confirmBackupTitle') }}
        </h2>
        <p class="cw-prose" style="margin: 8px 0 24px">
            {{
                t('confirmBackupBody', {
                    positions: targets
                        .map((target) => String(target + 1).padStart(2, '0'))
                        .join(', '),
                })
            }}
        </p>

        <div class="cw-stack" style="gap: 8px">
            <button
                v-for="(target, index) in targets"
                :key="target"
                type="button"
                style="
                    display: flex;
                    height: 52px;
                    align-items: center;
                    gap: 14px;
                    padding: 0 16px;
                    background: var(--cw-surface);
                    cursor: pointer;
                "
                :style="{
                    border: `1px solid ${
                        slots[index] === null
                            ? 'var(--cw-border-soft)'
                            : slots[index] === seedWords[target]
                              ? 'var(--cw-accent)'
                              : 'var(--cw-bad)'
                    }`,
                }"
                @click="clearSlot(index)"
            >
                <span
                    style="
                        width: 24px;
                        font: 400 11px/1 var(--cw-mono);
                        color: var(--cw-dim);
                    "
                    >{{ String(target + 1).padStart(2, '0') }}</span
                >
                <span
                    style="font: 500 14px/1 var(--cw-mono)"
                    :style="{
                        color: slots[index]
                            ? 'var(--cw-text)'
                            : 'var(--cw-faint)',
                    }"
                    >{{ slots[index] ?? t('slotEmpty') }}</span
                >
            </button>
        </div>

        <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 24px">
            <button
                v-for="word in chips"
                :key="word"
                type="button"
                :disabled="slots.includes(word)"
                style="
                    min-height: 44px;
                    padding: 0 16px;
                    border: 1px solid var(--cw-border-soft);
                    border-radius: 3px;
                    font: 500 13px/1 var(--cw-mono);
                    cursor: pointer;
                "
                :style="
                    slots.includes(word)
                        ? {
                              background: 'var(--cw-raised)',
                              color: 'var(--cw-fainter)',
                              cursor: 'default',
                          }
                        : {
                              background: 'var(--cw-surface)',
                              color: 'var(--cw-body)',
                          }
                "
                @click="pickChip(word)"
            >
                {{ word }}
            </button>
        </div>

        <div class="cw-fill" style="min-height: 20px"></div>
        <p v-if="wrongOrder" class="cw-note cw-note-bad">
            <span>{{ t('confirmWrong') }}</span>
        </p>
        <button
            type="button"
            class="cw-btn cw-btn-primary"
            style="margin-top: 12px"
            :disabled="!backupOk"
            @click="confirmBackup"
        >
            {{ t('confirmBackup') }}
        </button>
        <button
            type="button"
            class="cw-back"
            style="margin-top: 12px; align-self: center"
            @click="skipBackup"
        >
            {{ t('skipBackup') }}
        </button>
    </div>

    <!-- Import -->
    <div v-else-if="step === 'import'" class="cw-stack cw-screen">
        <button type="button" class="cw-back" @click="leaveImport">
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
                style="font: 400 11px/1.4 var(--cw-mono)"
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

        <div class="cw-card" style="margin-top: 24px">
            <div class="cw-label" style="margin-bottom: 14px">
                {{ t('willDerive') }}
            </div>
            <div class="cw-stack" style="gap: 10px">
                <div
                    v-for="chain in walletChains()"
                    :key="chain.id"
                    class="cw-row"
                >
                    <span class="cw-data">{{ chain.label }}</span>
                    <span
                        style="
                            font: 400 11px/1 var(--cw-mono);
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
            <button
                type="button"
                class="cw-back"
                @click="step = importing ? 'import' : 'confirm'"
            >
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
                style="font: 400 11px/1 var(--cw-mono)"
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

        <!--
          Said once, here, where the vault is about to exist: the two things
          that were skipped are the two things that get a wallet back, and this
          is the last screen where both are still one tap away.
        -->
        <p
            v-if="!backedUp && !importing"
            class="cw-note cw-note-warn"
            style="margin-top: 18px"
        >
            <span>{{ t('skippedBackupNote') }}</span>
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
