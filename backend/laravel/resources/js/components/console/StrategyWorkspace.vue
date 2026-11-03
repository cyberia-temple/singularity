<script setup lang="ts">
import { router, useForm, usePage } from '@inertiajs/vue3';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { consoleMessages } from '@/lib/consoleMessages';
import strategy from '@/routes/crm/strategy';

const page = usePage();
const { t } = useLocale(consoleMessages);
const frame = ref<HTMLIFrameElement | null>(null);
const ready = ref(false);
const dirty = ref(false);
const saving = ref(false);
const imageInput = ref<HTMLInputElement | null>(null);
const shell = ref<HTMLElement | null>(null);
const visible = ref(true);
const pinned = ref(false);
const floating = ref({ left: 110, top: 72, width: 980, height: 720 });
const resizing = ref(false);
const saveForm = useForm({ html: '' });
const onStrategy = computed(() => page.url.split('?')[0] === '/crm/strategy');
const shouldRender = computed(() => pinned.value || onStrategy.value);
const viewportGap = 8;
const minimumWidth = 320;
const minimumHeight = 240;

const shellStyle = computed(() =>
    pinned.value
        ? {
              left: `${floating.value.left}px`,
              top: `${floating.value.top}px`,
              width: `${floating.value.width}px`,
              height: `${floating.value.height}px`,
          }
        : {},
);

function editorDocument(): Document | null {
    return frame.value?.contentDocument ?? null;
}

function onFrameLoad() {
    const doc = editorDocument();

    if (!doc) {
return;
}

    doc.designMode = 'on';
    doc.body.spellcheck = true;
    doc.addEventListener('input', markDirty);
    ready.value = true;
}

function markDirty() {
    dirty.value = true;
}

function run(command: string, value?: string) {
    const doc = editorDocument();

    if (!doc) {
return;
}

    frame.value?.contentWindow?.focus();
    doc.execCommand(command, false, value);
    markDirty();
}

function createLink() {
    const url = window.prompt(t('strategy.linkPrompt'), 'https://');

    if (url) {
run('createLink', url);
}
}

function insertImage(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];

    if (!file || !file.type.startsWith('image/')) {
return;
}

    const reader = new FileReader();
    reader.onload = () => {
        if (typeof reader.result === 'string') {
run('insertImage', reader.result);
}

        if (imageInput.value) {
imageInput.value.value = '';
}
    };
    reader.readAsDataURL(file);
}

function save() {
    const doc = editorDocument();

    if (!doc || saving.value) {
return;
}

    saveForm.html = `<!doctype html>\n${doc.documentElement.outerHTML}`;
    saving.value = true;
    saveForm.put(strategy.update.url(), {
        preserveScroll: true,
        onSuccess: () => {
            dirty.value = false;
            saveForm.html = '';
        },
        onFinish: () => {
            saving.value = false;
        },
    });
}

function reset() {
    if (!window.confirm(t('strategy.resetConfirm'))) {
return;
}

    router.delete(strategy.reset.url(), {
        preserveScroll: true,
        onSuccess: () => {
            dirty.value = false;
            ready.value = false;

            if (frame.value) {
frame.value.src = strategy.document.url();
}
        },
    });
}

function protectUnsaved(event: BeforeUnloadEvent) {
    if (dirty.value) {
        event.preventDefault();
    }
}

function togglePin() {
    pinned.value = !pinned.value;
    visible.value = true;

    if (pinned.value) {
        constrainWindow();
    }

    window.localStorage.setItem('crm-strategy-pinned', String(pinned.value));
}

function closeWindow() {
    visible.value = false;
}

function startDrag(event: PointerEvent) {
    if (!pinned.value || (event.target as HTMLElement).closest('button')) {
return;
}

    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const origin = {
        x: event.clientX,
        y: event.clientY,
        left: floating.value.left,
        top: floating.value.top,
    };

    const move = (next: PointerEvent) => {
        floating.value.left = Math.max(
            viewportGap,
            Math.min(
                window.innerWidth - floating.value.width - viewportGap,
                origin.left + next.clientX - origin.x,
            ),
        );
        floating.value.top = Math.max(
            viewportGap,
            Math.min(
                window.innerHeight - floating.value.height - viewportGap,
                origin.top + next.clientY - origin.y,
            ),
        );
    };
    const stop = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
        persistWindow();
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
}

function startResize(event: PointerEvent, direction: string) {
    if (!pinned.value) {
return;
}

    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    resizing.value = true;

    const origin = { ...floating.value, x: event.clientX, y: event.clientY };
    const move = (next: PointerEvent) => {
        const dx = next.clientX - origin.x;
        const dy = next.clientY - origin.y;
        const effectiveMinimumWidth = Math.min(
            minimumWidth,
            window.innerWidth - viewportGap * 2,
        );
        const effectiveMinimumHeight = Math.min(
            minimumHeight,
            window.innerHeight - viewportGap * 2,
        );
        const originalRight = origin.left + origin.width;
        const originalBottom = origin.top + origin.height;
        let { left, top } = origin;
        let right = originalRight;
        let bottom = originalBottom;

        if (direction.includes('e')) {
            right = Math.min(
                window.innerWidth - viewportGap,
                Math.max(
                    origin.left + effectiveMinimumWidth,
                    originalRight + dx,
                ),
            );
        }

        if (direction.includes('s')) {
            bottom = Math.min(
                window.innerHeight - viewportGap,
                Math.max(
                    origin.top + effectiveMinimumHeight,
                    originalBottom + dy,
                ),
            );
        }

        if (direction.includes('w')) {
            left = Math.max(
                viewportGap,
                Math.min(
                    originalRight - effectiveMinimumWidth,
                    origin.left + dx,
                ),
            );
        }

        if (direction.includes('n')) {
            top = Math.max(
                viewportGap,
                Math.min(
                    originalBottom - effectiveMinimumHeight,
                    origin.top + dy,
                ),
            );
        }

        floating.value = {
            left,
            top,
            width: right - left,
            height: bottom - top,
        };
    };
    const stop = () => {
        resizing.value = false;
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', stop);
        handle.removeEventListener('pointercancel', stop);
        persistWindow();
    };

    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
}

function persistWindow() {
    if (pinned.value && shell.value) {
        floating.value.width = shell.value.offsetWidth;
        floating.value.height = shell.value.offsetHeight;
    }

    window.localStorage.setItem(
        'crm-strategy-window',
        JSON.stringify(floating.value),
    );
}

function constrainWindow() {
    const availableWidth = Math.max(1, window.innerWidth - viewportGap * 2);
    const availableHeight = Math.max(1, window.innerHeight - viewportGap * 2);

    floating.value.width = Math.min(floating.value.width, availableWidth);
    floating.value.height = Math.min(floating.value.height, availableHeight);
    floating.value.left = Math.max(
        viewportGap,
        Math.min(
            floating.value.left,
            window.innerWidth - floating.value.width - viewportGap,
        ),
    );
    floating.value.top = Math.max(
        viewportGap,
        Math.min(
            floating.value.top,
            window.innerHeight - floating.value.height - viewportGap,
        ),
    );
}

onMounted(() => {
    window.addEventListener('beforeunload', protectUnsaved);
    window.addEventListener('resize', constrainWindow);

    pinned.value =
        window.localStorage.getItem('crm-strategy-pinned') === 'true';

    try {
        const saved = JSON.parse(
            window.localStorage.getItem('crm-strategy-window') ?? 'null',
        ) as Partial<typeof floating.value> | null;

        if (saved) {
floating.value = { ...floating.value, ...saved };
}
    } catch {
        window.localStorage.removeItem('crm-strategy-window');
    }

    constrainWindow();
});
watch(onStrategy, (active) => {
    if (active) {
visible.value = true;
}
});
onBeforeUnmount(() => {
    editorDocument()?.removeEventListener('input', markDirty);
    window.removeEventListener('beforeunload', protectUnsaved);
    window.removeEventListener('resize', constrainWindow);
});
</script>

<template>
    <Teleport
        v-if="shouldRender"
        :to="pinned ? '.mostik' : '#strategy-dock'"
        defer
    >
        <button
            v-if="!visible"
            type="button"
            class="strategy-reopen"
            @click="visible = true"
        >
            {{ t('strategy.open') }}
        </button>

        <section
            v-show="visible"
            ref="shell"
            class="strategy-shell"
            :class="{ 'strategy-shell--pinned': pinned }"
            :style="shellStyle"
        >
            <span
                v-if="resizing"
                class="strategy-resize-shield"
                aria-hidden="true"
            />
            <span
                v-for="direction in [
                    'n',
                    'ne',
                    'e',
                    'se',
                    's',
                    'sw',
                    'w',
                    'nw',
                ]"
                v-show="pinned"
                :key="direction"
                class="strategy-resize"
                :class="`strategy-resize--${direction}`"
                aria-hidden="true"
                @pointerdown="startResize($event, direction)"
            />
            <div class="strategy-shell__corners" aria-hidden="true" />
            <div class="strategy-windowbar" @pointerdown="startDrag">
                <span class="strategy-windowbar__mark" />
                <span class="mk-m">{{ t('strategy.window') }}</span>
                <button
                    type="button"
                    class="strategy-pin"
                    :class="{ 'strategy-pin--on': pinned }"
                    :title="pinned ? t('strategy.unpin') : t('strategy.pin')"
                    :aria-pressed="pinned"
                    @click="togglePin"
                >
                    ◇
                </button>
                <button
                    type="button"
                    class="strategy-close"
                    :title="t('strategy.close')"
                    :aria-label="t('strategy.close')"
                    @click="closeWindow"
                >
                    ×
                </button>
            </div>
            <div
                class="strategy-toolbar"
                role="toolbar"
                :aria-label="t('strategy.toolbar')"
            >
                <div class="strategy-toolbar__group">
                    <button
                        type="button"
                        title="Bold"
                        @mousedown.prevent="run('bold')"
                    >
                        <b>B</b>
                    </button>
                    <button
                        type="button"
                        title="Italic"
                        @mousedown.prevent="run('italic')"
                    >
                        <i>I</i>
                    </button>
                    <button
                        type="button"
                        title="Underline"
                        @mousedown.prevent="run('underline')"
                    >
                        <u>U</u>
                    </button>
                    <button
                        type="button"
                        title="Strike"
                        @mousedown.prevent="run('strikeThrough')"
                    >
                        <s>S</s>
                    </button>
                </div>

                <div class="strategy-toolbar__group">
                    <select
                        :aria-label="t('strategy.block')"
                        @change="
                            run(
                                'formatBlock',
                                ($event.target as HTMLSelectElement).value,
                            )
                        "
                    >
                        <option value="p">Text</option>
                        <option value="h1">H1</option>
                        <option value="h2">H2</option>
                        <option value="h3">H3</option>
                        <option value="blockquote">Quote</option>
                    </select>
                    <select
                        :aria-label="t('strategy.font')"
                        @change="
                            run(
                                'fontName',
                                ($event.target as HTMLSelectElement).value,
                            )
                        "
                    >
                        <option value="Arial">Arial</option>
                        <option value="Georgia">Georgia</option>
                        <option value="Courier New">Mono</option>
                        <option value="Impact">Impact</option>
                    </select>
                    <select
                        :aria-label="t('strategy.size')"
                        @change="
                            run(
                                'fontSize',
                                ($event.target as HTMLSelectElement).value,
                            )
                        "
                    >
                        <option v-for="size in 7" :key="size" :value="size">
                            {{ size }}
                        </option>
                    </select>
                </div>

                <div class="strategy-toolbar__group strategy-toolbar__colors">
                    <label :title="t('strategy.color')"
                        ><span>A</span
                        ><input
                            type="color"
                            value="#00e5d1"
                            @input="
                                run(
                                    'foreColor',
                                    ($event.target as HTMLInputElement).value,
                                )
                            "
                    /></label>
                    <label :title="t('strategy.highlight')"
                        ><span>▰</span
                        ><input
                            type="color"
                            value="#fff06a"
                            @input="
                                run(
                                    'hiliteColor',
                                    ($event.target as HTMLInputElement).value,
                                )
                            "
                    /></label>
                </div>

                <div class="strategy-toolbar__group">
                    <button
                        type="button"
                        title="Align left"
                        @mousedown.prevent="run('justifyLeft')"
                    >
                        ≡
                    </button>
                    <button
                        type="button"
                        title="Center"
                        @mousedown.prevent="run('justifyCenter')"
                    >
                        ≣
                    </button>
                    <button
                        type="button"
                        title="Bullets"
                        @mousedown.prevent="run('insertUnorderedList')"
                    >
                        •≡
                    </button>
                    <button
                        type="button"
                        title="Numbers"
                        @mousedown.prevent="run('insertOrderedList')"
                    >
                        1≡
                    </button>
                    <button
                        type="button"
                        :title="t('strategy.link')"
                        @mousedown.prevent="createLink"
                    >
                        ↗
                    </button>
                    <button
                        type="button"
                        :title="t('strategy.image')"
                        @mousedown.prevent="imageInput?.click()"
                    >
                        ▧
                    </button>
                    <input
                        ref="imageInput"
                        hidden
                        type="file"
                        accept="image/*"
                        @change="insertImage"
                    />
                </div>

                <div class="strategy-toolbar__group">
                    <button
                        type="button"
                        title="Undo"
                        @mousedown.prevent="run('undo')"
                    >
                        ↶
                    </button>
                    <button
                        type="button"
                        title="Redo"
                        @mousedown.prevent="run('redo')"
                    >
                        ↷
                    </button>
                    <button
                        type="button"
                        :title="t('strategy.clear')"
                        @mousedown.prevent="run('removeFormat')"
                    >
                        Tx
                    </button>
                </div>

                <div class="strategy-toolbar__actions">
                    <button
                        type="button"
                        class="mk-btn mk-ghost"
                        @click="reset"
                    >
                        {{ t('strategy.reset') }}
                    </button>
                    <button
                        type="button"
                        class="mk-btn mk-act"
                        :disabled="!ready || saving"
                        @click="save"
                    >
                        {{ t('strategy.save') }}
                    </button>
                </div>
            </div>

            <div class="strategy-frame-wrap">
                <div v-if="!ready" class="strategy-loading mk-m">
                    {{ t('strategy.loading') }}
                </div>
                <iframe
                    ref="frame"
                    :src="strategy.document.url()"
                    :title="t('strategy.document')"
                    sandbox="allow-same-origin"
                    class="strategy-frame"
                    @load="onFrameLoad"
                />
            </div>
            <p
                v-if="Object.keys(saveForm.errors).length"
                class="strategy-error"
            >
                {{ Object.values(saveForm.errors).join(' · ') }}
            </p>
        </section>
    </Teleport>
</template>

<style scoped>
.strategy-reopen {
    position: fixed;
    z-index: 99;
    right: 18px;
    bottom: 18px;
    height: 30px;
    padding: 0 12px;
    border: 1px solid rgba(var(--mk-accent-rgb), 0.45);
    background: rgba(6, 12, 15, 0.94);
    box-shadow: 0 0 18px rgba(var(--mk-accent-rgb), 0.12);
    color: var(--mk-accent);
    font: 10px var(--mk-mono);
    letter-spacing: 0.09em;
    text-transform: uppercase;
    cursor: pointer;
}
.strategy-reopen:hover {
    box-shadow: 0 0 24px rgba(var(--mk-accent-rgb), 0.3);
}
.strategy-windowbar {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 0 7px 0 10px;
    border-bottom: 1px solid rgba(var(--mk-accent-rgb), 0.16);
    background: rgba(4, 9, 12, 0.98);
    color: var(--mk-faint);
    font-size: 9px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    user-select: none;
}
.strategy-shell--pinned .strategy-windowbar {
    cursor: move;
    touch-action: none;
}
.strategy-windowbar__mark {
    width: 24px;
    height: 1px;
    background: var(--mk-accent);
    box-shadow: 0 0 8px var(--mk-accent);
}
.strategy-pin,
.strategy-close {
    display: grid;
    width: 22px;
    height: 22px;
    padding: 0;
    place-items: center;
    border: 1px solid transparent;
    background: transparent;
    color: var(--mk-faint);
    cursor: pointer;
}
.strategy-pin {
    margin-left: auto;
    font-size: 16px;
    transform: rotate(45deg);
}
.strategy-pin:hover,
.strategy-pin:focus-visible,
.strategy-pin--on {
    border-color: rgba(var(--mk-accent-rgb), 0.35);
    color: var(--mk-accent);
    text-shadow: 0 0 8px var(--mk-accent);
    outline: none;
}
.strategy-pin--on {
    background: rgba(var(--mk-accent-rgb), 0.08);
}
.strategy-close {
    font-size: 15px;
    line-height: 1;
}
.strategy-close:hover,
.strategy-close:focus-visible {
    border-color: rgba(255, 77, 77, 0.4);
    background: rgba(255, 77, 77, 0.08);
    box-shadow: 0 0 12px rgba(255, 77, 77, 0.22);
    color: var(--mk-critical);
    text-shadow: 0 0 7px var(--mk-critical);
    outline: none;
}
.strategy-error {
    margin: 0;
    padding: 8px 10px;
    border-top: 1px solid rgba(255, 77, 77, 0.25);
    color: var(--mk-critical);
    font-size: 11px;
}
.strategy-shell {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    flex-direction: column;
    min-height: 0;
    padding: 1px;
    border: 1px solid rgba(var(--mk-accent-rgb), 0.3);
    background: linear-gradient(
        135deg,
        rgba(var(--mk-accent-rgb), 0.09),
        transparent 18%,
        transparent 82%,
        rgba(255, 43, 214, 0.08)
    );
    box-shadow:
        0 0 34px rgba(var(--mk-accent-rgb), 0.06),
        inset 0 0 28px rgba(0, 0, 0, 0.35);
}
.strategy-shell::before {
    position: absolute;
    z-index: 2;
    top: -1px;
    left: 22px;
    width: 110px;
    height: 2px;
    background: var(--mk-accent);
    box-shadow: 0 0 12px var(--mk-accent);
    content: '';
}
.strategy-shell__corners::before,
.strategy-shell__corners::after {
    position: absolute;
    z-index: 2;
    width: 14px;
    height: 14px;
    content: '';
}
.strategy-shell__corners::before {
    right: -2px;
    top: -2px;
    border-top: 2px solid var(--mk-money);
    border-right: 2px solid var(--mk-money);
}
.strategy-shell__corners::after {
    bottom: -2px;
    left: -2px;
    border-bottom: 2px solid var(--mk-accent);
    border-left: 2px solid var(--mk-accent);
}
.strategy-toolbar {
    position: relative;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 7px;
    min-height: 48px;
    padding: 7px 9px;
    border-bottom: 1px solid rgba(var(--mk-accent-rgb), 0.2);
    background: rgba(6, 12, 15, 0.96);
    flex-wrap: wrap;
}
.strategy-toolbar__group {
    display: flex;
    align-items: center;
    border: 1px solid rgba(var(--mk-ink-rgb), 0.11);
}
.strategy-toolbar button,
.strategy-toolbar select,
.strategy-toolbar label {
    height: 28px;
    border: 0;
    border-right: 1px solid rgba(var(--mk-ink-rgb), 0.1);
    background: rgba(var(--mk-ink-rgb), 0.025);
    color: var(--mk-dim);
    font: 11px var(--mk-mono);
    cursor: pointer;
}
.strategy-toolbar button {
    min-width: 29px;
    padding: 0 7px;
}
.strategy-toolbar button:hover,
.strategy-toolbar button:focus-visible,
.strategy-toolbar select:hover {
    color: var(--mk-accent);
    background: rgba(var(--mk-accent-rgb), 0.09);
    outline: none;
}
.strategy-toolbar select {
    max-width: 86px;
    padding: 0 7px;
}
.strategy-toolbar__colors label {
    position: relative;
    display: grid;
    width: 34px;
    place-items: center;
}
.strategy-toolbar__colors input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
}
.strategy-toolbar__actions {
    display: flex;
    gap: 7px;
    margin-left: auto;
}
.strategy-toolbar__actions .mk-btn {
    height: 28px;
}
.strategy-frame-wrap {
    position: relative;
    flex: 1;
    width: 100%;
    height: auto;
    min-height: 0;
    background: var(--mk-panel);
}
.strategy-frame {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    background: #fff;
}
.strategy-loading {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: var(--mk-panel);
    color: var(--mk-faint);
    font-size: 11px;
    letter-spacing: 0.1em;
    text-transform: uppercase;
}
@media (max-width: 760px) {
    .strategy-toolbar__actions {
        width: 100%;
        margin-left: 0;
    }
    .strategy-toolbar__actions .mk-btn:last-child {
        margin-left: auto;
    }
}
.strategy-shell--pinned {
    position: fixed;
    z-index: 1000;
    min-width: min(320px, calc(100vw - 16px));
    min-height: min(240px, calc(100vh - 16px));
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    overflow: hidden;
    background: var(--mk-bg);
    box-shadow:
        0 22px 80px rgba(0, 0, 0, 0.72),
        0 0 38px rgba(var(--mk-accent-rgb), 0.15);
}
.strategy-shell--pinned .strategy-toolbar,
.strategy-shell--pinned .strategy-error {
    flex: 0 0 auto;
}
.strategy-resize-shield {
    position: absolute;
    z-index: 80;
    inset: 0;
    cursor: inherit;
}
.strategy-resize {
    position: absolute;
    z-index: 90;
    touch-action: none;
}
.strategy-resize--n,
.strategy-resize--s {
    right: 10px;
    left: 10px;
    height: 10px;
    cursor: ns-resize;
}
.strategy-resize--n {
    top: -5px;
}
.strategy-resize--s {
    bottom: -5px;
}
.strategy-resize--e,
.strategy-resize--w {
    top: 10px;
    bottom: 10px;
    width: 10px;
    cursor: ew-resize;
}
.strategy-resize--e {
    right: -5px;
}
.strategy-resize--w {
    left: -5px;
}
.strategy-resize--ne,
.strategy-resize--nw,
.strategy-resize--se,
.strategy-resize--sw {
    width: 16px;
    height: 16px;
}
.strategy-resize--ne {
    top: -5px;
    right: -5px;
    cursor: nesw-resize;
}
.strategy-resize--nw {
    top: -5px;
    left: -5px;
    cursor: nwse-resize;
}
.strategy-resize--se {
    right: -5px;
    bottom: -5px;
    cursor: nwse-resize;
}
.strategy-resize--sw {
    bottom: -5px;
    left: -5px;
    cursor: nesw-resize;
}
</style>
