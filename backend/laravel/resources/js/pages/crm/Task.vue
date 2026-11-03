<script setup lang="ts">
import { Head, Link, router, useForm } from '@inertiajs/vue3';
import { computed, ref, watch } from 'vue';
import Linked from '@/components/console/Linked.vue';
import { useConsoleLive } from '@/composables/useConsolePulse';
import { useLocale } from '@/composables/useLocale';
import { dateTime } from '@/lib/console';
import { consoleMessages } from '@/lib/consoleMessages';
import { show as showContact } from '@/routes/crm';
import tasks from '@/routes/crm/tasks';
import attachments from '@/routes/crm/tasks/attachments';

type TaskComment = {
    id: number;
    body: string;
    author: string;
    is_mine: boolean;
    created_at: string;
};

type Task = {
    id: number;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    due_at: string | null;
    completed_at: string | null;
    created_at: string | null;
    updated_at: string | null;
    assignee: string | null;
    assignee_id: number | null;
    is_mine: boolean;
    creator: string | null;
    external_id: string | null;
    comments: TaskComment[];
    contact: { id: number; name: string } | null;
    attachments: TaskAttachment[];
};
type TaskAttachment = {
    id: number;
    name: string;
    mime: string | null;
    kind: 'image' | 'video' | 'audio' | 'file';
    size: number;
    caption: string | null;
    url: string;
    uploader: string | null;
    created_at: string;
    comments: TaskComment[];
};

const props = defineProps<{
    task: Task;
    options: {
        statuses: string[];
        priorities: string[];
        assignees: { id: number; name: string }[];
    };
}>();

const { t, tag } = useLocale(consoleMessages);

const edit = useForm({
    title: props.task.title,
    description: props.task.description ?? '',
    status: props.task.status,
    priority: props.task.priority,
    due_at: props.task.due_at?.slice(0, 10) ?? '',
    assigned_to_user_id: props.task.assignee_id,
});
const comment = useForm({ body: '' });
const upload = useForm({ files: [] as File[], caption: '' });
const fileInput = ref<HTMLInputElement | null>(null);
const attachmentComments = ref<Record<number, string>>({});

useConsoleLive('tasks', () => router.reload({ only: ['task', 'console'] }), {
    active: () => !edit.isDirty && !comment.body && !comment.processing,
});

const changed = computed(() => edit.isDirty);

watch(
    () => props.task,
    (task) => {
        if (edit.isDirty) {
            return;
        }

        edit.defaults({
            title: task.title,
            description: task.description ?? '',
            status: task.status,
            priority: task.priority,
            due_at: task.due_at?.slice(0, 10) ?? '',
            assigned_to_user_id: task.assignee_id,
        });
        edit.reset();
    },
);

function save() {
    if (!edit.title.trim() || edit.processing) {
        return;
    }

    edit.put(tasks.update.url(props.task.id), {
        preserveScroll: true,
        onSuccess: () => edit.defaults(),
    });
}

function setStatus(status: string) {
    router.put(
        tasks.update.url(props.task.id),
        { status },
        { preserveScroll: true },
    );
}

function claim() {
    router.post(tasks.claim.url(props.task.id), {}, { preserveScroll: true });
}

function submitComment() {
    if (!comment.body.trim() || comment.processing) {
        return;
    }

    comment.post(tasks.comments.store.url(props.task.id), {
        preserveScroll: true,
        onSuccess: () => comment.reset(),
    });
}

function chooseFiles(event: Event) {
    upload.files = Array.from((event.target as HTMLInputElement).files ?? []);
}
function submitFiles() {
    if (!upload.files.length || upload.processing) {
return;
}

    upload.post(attachments.store.url(props.task.id), {
        preserveScroll: true,
        forceFormData: true,
        onSuccess: () => {
            upload.reset();

            if (fileInput.value) {
fileInput.value.value = '';
}
        },
    });
}
function submitAttachmentComment(file: TaskAttachment) {
    const body = attachmentComments.value[file.id]?.trim();

    if (!body) {
return;
}

    router.post(
        attachments.comments.store.url(file.id),
        { body },
        {
            preserveScroll: true,
            onSuccess: () => {
                attachmentComments.value[file.id] = '';
            },
        },
    );
}
function removeAttachment(file: TaskAttachment) {
    if (window.confirm(t('task.files.deleteConfirm', { name: file.name }))) {
router.delete(attachments.destroy.url(file.id), {
            preserveScroll: true,
        });
}
}
function formatSize(bytes: number): string {
    if (bytes < 1024 * 1024) {
return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function remove() {
    if (
        !window.confirm(t('tasks.deleteConfirm', { title: props.task.title }))
    ) {
        return;
    }

    router.delete(tasks.destroy.url(props.task.id));
}

function when(value: string | null): string {
    return dateTime(value, tag.value);
}
</script>

<template>
    <Head :title="`Пульт · ${task.title}`" />

    <div class="task-page">
        <nav class="task-breadcrumb mk-m" aria-label="Breadcrumb">
            <Link :href="tasks.index.url()">← {{ t('task.back') }}</Link>
            <span>/</span>
            <span>{{ t('task.key', { id: task.id }) }}</span>
        </nav>

        <header class="task-header">
            <div class="task-header__title">
                <span class="task-kind" aria-hidden="true">✓</span>
                <div>
                    <p class="mk-k task-key">
                        {{ t('task.key', { id: task.id }) }}
                        <span v-if="task.external_id"
                            >· {{ t('task.machine') }}</span
                        >
                    </p>
                    <h1 class="mk-h1">{{ task.title }}</h1>
                </div>
            </div>
            <div class="task-header__actions">
                <button
                    v-if="task.status === 'open'"
                    type="button"
                    class="mk-btn mk-ghost"
                    @click="setStatus('in_progress')"
                >
                    {{ t('tasks.inProgress.action') }}
                </button>
                <button
                    v-if="task.status !== 'done'"
                    type="button"
                    class="mk-btn mk-act"
                    @click="setStatus('done')"
                >
                    {{ t('tasks.done.action') }}
                </button>
                <button
                    v-else
                    type="button"
                    class="mk-btn mk-ghost"
                    @click="setStatus('open')"
                >
                    {{ t('tasks.reopen') }}
                </button>
                <button
                    type="button"
                    class="mk-btn task-delete"
                    @click="remove"
                >
                    {{ t('task.delete') }}
                </button>
            </div>
        </header>

        <div class="task-workspace">
            <main class="task-main">
                <section class="task-section task-brief">
                    <div class="task-section__heading">
                        <h2>{{ t('tasks.field.description') }}</h2>
                        <span class="mk-t3">{{
                            t('task.editDescription')
                        }}</span>
                    </div>
                    <label class="task-field">
                        <span class="mk-k">{{ t('tasks.field.title') }}</span>
                        <input
                            v-model="edit.title"
                            class="task-control task-title-input"
                        />
                        <span v-if="edit.errors.title" class="task-error">{{
                            edit.errors.title
                        }}</span>
                    </label>
                    <div class="task-files">
                        <div class="task-section__heading">
                            <h2>{{ t('task.files.title') }}</h2>
                            <span class="mk-t3">{{
                                t('task.files.hint')
                            }}</span>
                        </div>
                        <div
                            v-if="task.attachments.length"
                            class="task-file-list"
                        >
                            <article
                                v-for="file in task.attachments"
                                :key="file.id"
                                class="task-file"
                            >
                                <a
                                    :href="file.url"
                                    target="_blank"
                                    rel="noopener"
                                    class="task-file__preview"
                                >
                                    <img
                                        v-if="file.kind === 'image'"
                                        :src="file.url"
                                        :alt="file.name"
                                        loading="lazy"
                                    />
                                    <video
                                        v-else-if="file.kind === 'video'"
                                        :src="file.url"
                                        controls
                                        preload="metadata"
                                        @click.prevent.stop
                                    />
                                    <audio
                                        v-else-if="file.kind === 'audio'"
                                        :src="file.url"
                                        controls
                                        preload="metadata"
                                        @click.prevent.stop
                                    />
                                    <span v-else aria-hidden="true">↓</span>
                                </a>
                                <div class="task-file__body">
                                    <div class="task-file__title">
                                        <a
                                            :href="file.url"
                                            target="_blank"
                                            rel="noopener"
                                            >{{ file.name }}</a
                                        ><span class="mk-m mk-t3">{{
                                            formatSize(file.size)
                                        }}</span
                                        ><button
                                            type="button"
                                            class="task-file__delete"
                                            :aria-label="t('task.files.delete')"
                                            @click="removeAttachment(file)"
                                        >
                                            ×
                                        </button>
                                    </div>
                                    <p
                                        v-if="file.caption"
                                        class="task-file__caption"
                                    >
                                        {{ file.caption }}
                                    </p>
                                    <div
                                        v-if="file.comments.length"
                                        class="task-file__comments"
                                    >
                                        <p
                                            v-for="item in file.comments"
                                            :key="item.id"
                                        >
                                            <strong>{{ item.author }}</strong>
                                            <span class="mk-t3">{{
                                                when(item.created_at)
                                            }}</span
                                            ><br />{{ item.body }}
                                        </p>
                                    </div>
                                    <form
                                        class="task-file__comment"
                                        @submit.prevent="
                                            submitAttachmentComment(file)
                                        "
                                    >
                                        <input
                                            v-model="
                                                attachmentComments[file.id]
                                            "
                                            class="task-control"
                                            :placeholder="
                                                t('task.files.comment')
                                            "
                                            maxlength="4000"
                                        /><button
                                            class="mk-btn"
                                            type="submit"
                                            :disabled="
                                                !attachmentComments[
                                                    file.id
                                                ]?.trim()
                                            "
                                        >
                                            {{ t('task.files.commentSend') }}
                                        </button>
                                    </form>
                                </div>
                            </article>
                        </div>
                        <form class="task-upload" @submit.prevent="submitFiles">
                            <input
                                ref="fileInput"
                                type="file"
                                multiple
                                :aria-label="t('task.files.choose')"
                                @change="chooseFiles"
                            />
                            <input
                                v-model="upload.caption"
                                class="task-control"
                                maxlength="1000"
                                :placeholder="t('task.files.caption')"
                            />
                            <span
                                v-if="
                                    upload.errors.files ||
                                    upload.errors['files.0']
                                "
                                class="task-error"
                                >{{
                                    upload.errors.files ||
                                    upload.errors['files.0']
                                }}</span
                            >
                            <button
                                class="mk-btn mk-act"
                                type="submit"
                                :disabled="
                                    !upload.files.length || upload.processing
                                "
                            >
                                {{
                                    upload.processing
                                        ? t('task.files.uploading')
                                        : t('task.files.upload')
                                }}
                            </button>
                        </form>
                    </div>
                    <label class="task-field">
                        <span class="mk-k">{{
                            t('tasks.field.description')
                        }}</span>
                        <textarea
                            v-model="edit.description"
                            class="task-control task-description"
                            rows="10"
                            :placeholder="t('task.noDescription')"
                        />
                        <span
                            v-if="edit.errors.description"
                            class="task-error"
                            >{{ edit.errors.description }}</span
                        >
                    </label>
                    <button
                        type="button"
                        class="mk-btn mk-act"
                        :disabled="
                            !changed || edit.processing || !edit.title.trim()
                        "
                        @click="save"
                    >
                        {{ t('task.saveChanges') }}
                    </button>
                </section>

                <section class="task-section task-activity">
                    <div class="task-section__heading">
                        <h2>{{ t('task.activity') }}</h2>
                        <span class="mk-t3">{{ t('task.activityNote') }}</span>
                    </div>
                    <div v-if="task.comments.length" class="task-thread">
                        <article
                            v-for="item in task.comments"
                            :key="item.id"
                            class="task-comment"
                        >
                            <div class="task-avatar" aria-hidden="true">
                                {{ item.author.slice(0, 1).toUpperCase() }}
                            </div>
                            <div>
                                <p class="task-comment__meta">
                                    <strong>{{ item.author }}</strong>
                                    <time :datetime="item.created_at">{{
                                        when(item.created_at)
                                    }}</time>
                                </p>
                                <p><Linked :text="item.body" /></p>
                            </div>
                        </article>
                    </div>
                    <p v-else class="mk-t3 task-empty">
                        {{ t('task.noComments') }}
                    </p>
                    <form
                        class="task-comment-form"
                        @submit.prevent="submitComment"
                    >
                        <textarea
                            v-model="comment.body"
                            class="task-control"
                            rows="4"
                            :placeholder="t('tasks.comment.placeholder')"
                        />
                        <span v-if="comment.errors.body" class="task-error">{{
                            comment.errors.body
                        }}</span>
                        <button
                            type="submit"
                            class="mk-btn mk-act"
                            :disabled="
                                comment.processing || !comment.body.trim()
                            "
                        >
                            {{ t('tasks.comment.send') }}
                        </button>
                    </form>
                </section>
            </main>

            <aside class="task-sidebar">
                <section class="mk-panel task-details">
                    <h2 class="mk-k">{{ t('task.details') }}</h2>
                    <label class="task-detail">
                        <span>{{ t('person.editStatus') }}</span>
                        <select
                            v-model="edit.status"
                            class="task-control"
                            @change="save"
                        >
                            <option
                                v-for="status in options.statuses"
                                :key="status"
                                :value="status"
                            >
                                {{ t(`tasks.status.${status}`) }}
                            </option>
                        </select>
                    </label>
                    <label class="task-detail">
                        <span>{{ t('tasks.field.priority') }}</span>
                        <select v-model="edit.priority" class="task-control">
                            <option
                                v-for="priority in options.priorities"
                                :key="priority"
                                :value="priority"
                            >
                                {{ t(`priority.${priority}`) }}
                            </option>
                        </select>
                    </label>
                    <label class="task-detail">
                        <span>{{ t('tasks.field.assignee') }}</span>
                        <select
                            v-model="edit.assigned_to_user_id"
                            class="task-control"
                        >
                            <option :value="null">
                                {{ t('tasks.nobody') }}
                            </option>
                            <option
                                v-for="person in options.assignees"
                                :key="person.id"
                                :value="person.id"
                            >
                                {{ person.name }}
                            </option>
                        </select>
                    </label>
                    <button
                        v-if="task.assignee_id === null"
                        type="button"
                        class="mk-btn mk-ghost task-claim"
                        @click="claim"
                    >
                        {{ t('tasks.claim') }}
                    </button>
                    <label class="task-detail">
                        <span>{{ t('tasks.field.due') }}</span>
                        <input
                            v-model="edit.due_at"
                            type="date"
                            class="task-control"
                        />
                    </label>
                    <div v-if="task.contact" class="task-detail">
                        <span>{{ t('task.contact') }}</span>
                        <Link :href="showContact.url(task.contact.id)"
                            >{{ task.contact.name }} ↗</Link
                        >
                    </div>
                    <div class="task-detail">
                        <span>{{ t('task.creator') }}</span>
                        <strong>{{ task.creator ?? '—' }}</strong>
                    </div>
                    <button
                        type="button"
                        class="mk-btn mk-act task-details__save"
                        :disabled="
                            !changed || edit.processing || !edit.title.trim()
                        "
                        @click="save"
                    >
                        {{ t('tasks.save') }}
                    </button>
                </section>

                <section class="task-dates">
                    <div>
                        <span>{{ t('task.created') }}</span
                        ><time :datetime="task.created_at ?? undefined">{{
                            when(task.created_at)
                        }}</time>
                    </div>
                    <div>
                        <span>{{ t('task.updated') }}</span
                        ><time :datetime="task.updated_at ?? undefined">{{
                            when(task.updated_at)
                        }}</time>
                    </div>
                    <div v-if="task.completed_at">
                        <span>{{ t('task.completed') }}</span
                        ><time :datetime="task.completed_at">{{
                            when(task.completed_at)
                        }}</time>
                    </div>
                </section>
            </aside>
        </div>
    </div>
</template>

<style scoped>
.task-page {
    display: flex;
    flex-direction: column;
    gap: 22px;
    min-height: 100%;
}
.task-breadcrumb {
    display: flex;
    gap: 8px;
    color: var(--mk-faint);
    font-size: 11px;
}
.task-breadcrumb a,
.task-detail a {
    color: var(--mk-accent);
    text-decoration: none;
}
.task-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    padding-bottom: 20px;
    border-bottom: 1px solid rgba(var(--mk-ink-rgb), 0.09);
}
.task-header__title {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    min-width: 0;
}
.task-header__title h1 {
    margin-top: 5px;
    overflow-wrap: anywhere;
}
.task-kind {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    flex: 0 0 30px;
    color: var(--mk-bg);
    background: var(--mk-accent);
    font-weight: 800;
}
.task-key {
    margin: 0;
    color: var(--mk-faint);
}
.task-header__actions {
    display: flex;
    gap: 7px;
    flex-wrap: wrap;
    justify-content: flex-end;
}
.task-delete {
    color: var(--mk-critical);
}
.task-workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 310px;
    gap: 32px;
    align-items: start;
}
.task-main {
    display: flex;
    flex-direction: column;
    gap: 34px;
    min-width: 0;
}
.task-section {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
}
.task-brief {
    max-height: min(72vh, 920px);
    overflow-y: auto;
    padding-right: 8px;
    scrollbar-color: var(--mk-faint) transparent;
}
.task-files {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 14px;
}
.task-file-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
}
.task-file {
    display: grid;
    grid-template-columns: minmax(90px, 180px) minmax(0, 1fr);
    border: 1px solid var(--mk-hair-strong);
    background: var(--mk-panel);
}
.task-file__preview {
    min-height: 100px;
    display: grid;
    place-items: center;
    background: var(--mk-bg);
    overflow: hidden;
    color: var(--mk-accent);
    font-size: 26px;
}
.task-file__preview img,
.task-file__preview video {
    width: 100%;
    height: 100%;
    max-height: 220px;
    object-fit: contain;
}
.task-file__preview audio {
    width: 94%;
}
.task-file__body {
    min-width: 0;
    padding: 12px;
}
.task-file__title {
    display: flex;
    align-items: center;
    gap: 9px;
    overflow-wrap: anywhere;
    font-size: 12px;
}
.task-file__title a {
    color: var(--mk-accent);
}
.task-file__delete {
    margin-left: auto;
    border: 0;
    background: transparent;
    color: var(--mk-critical);
    cursor: pointer;
    font-size: 18px;
}
.task-file__caption {
    white-space: pre-wrap;
    color: var(--mk-body);
    font-size: 12px;
}
.task-file__comments {
    border-top: 1px solid var(--mk-hair);
    margin-top: 10px;
}
.task-file__comments p {
    margin: 0;
    padding: 8px 0;
    border-bottom: 1px solid var(--mk-hair);
    white-space: pre-wrap;
    font-size: 11px;
    line-height: 1.5;
}
.task-file__comment {
    display: flex;
    gap: 6px;
    margin-top: 9px;
}
.task-file__comment .task-control {
    min-width: 0;
}
.task-upload {
    width: 100%;
    display: grid;
    grid-template-columns: minmax(180px, auto) minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 12px;
    border: 1px dashed var(--mk-hair-strong);
}
.task-upload input[type='file'] {
    min-width: 0;
    color: var(--mk-dim);
    font-size: 11px;
}
@media (max-width: 700px) {
    .task-file {
        grid-template-columns: 1fr;
    }
    .task-file__preview {
        max-height: 260px;
    }
    .task-upload {
        grid-template-columns: 1fr;
    }
    .task-file__comment {
        flex-direction: column;
    }
}
.task-section__heading {
    display: flex;
    align-items: baseline;
    gap: 12px;
    width: 100%;
    padding-bottom: 9px;
    border-bottom: 1px solid rgba(var(--mk-ink-rgb), 0.09);
}
.task-section__heading h2 {
    margin: 0;
    color: var(--mk-body);
    font-size: 14px;
}
.task-section__heading span {
    font-size: 11px;
}
.task-field,
.task-comment-form {
    display: flex;
    flex-direction: column;
    gap: 7px;
    width: 100%;
}
.task-control {
    width: 100%;
    border: 1px solid rgba(var(--mk-ink-rgb), 0.16);
    border-radius: 0;
    outline: none;
    padding: 9px 10px;
    color: var(--mk-body);
    background: rgba(var(--mk-ink-rgb), 0.035);
    font: inherit;
}
.task-control:focus {
    border-color: color-mix(in srgb, var(--mk-accent) 60%, transparent);
    background: rgba(var(--mk-accent-rgb), 0.035);
}
.task-title-input {
    font-size: 15px;
    font-weight: 600;
}
.task-description {
    min-height: 210px;
    resize: vertical;
    line-height: 1.65;
}
.task-error {
    color: var(--mk-critical);
    font-size: 11px;
}
.task-thread {
    width: 100%;
}
.task-comment {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    gap: 10px;
    padding: 14px 0;
    border-bottom: 1px solid rgba(var(--mk-ink-rgb), 0.07);
}
.task-comment p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 13px;
    line-height: 1.55;
}
.task-comment__meta {
    display: flex;
    gap: 9px;
    margin: 0 0 5px !important;
    color: var(--mk-faint);
    font-family: var(--mk-mono);
    font-size: 10px !important;
}
.task-comment__meta strong {
    color: var(--mk-dim);
}
.task-avatar {
    display: grid;
    place-items: center;
    width: 30px;
    height: 30px;
    color: var(--mk-accent);
    background: rgba(var(--mk-accent-rgb), 0.09);
    font-family: var(--mk-mono);
    font-size: 11px;
    font-weight: 700;
}
.task-empty {
    margin: 0;
    font-size: 12px;
}
.task-sidebar {
    position: sticky;
    top: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
}
.task-details {
    display: flex;
    flex-direction: column;
    gap: 13px;
    padding: 18px;
}
.task-details h2 {
    margin: 0 0 3px;
    color: var(--mk-body);
}
.task-detail {
    display: grid;
    grid-template-columns: 88px minmax(0, 1fr);
    align-items: center;
    gap: 10px;
    color: var(--mk-faint);
    font-size: 11px;
}
.task-detail strong {
    color: var(--mk-dim);
    font-weight: 500;
}
.task-detail .task-control {
    padding: 7px 8px;
    font-size: 11px;
}
.task-claim {
    margin-left: 98px;
}
.task-details__save {
    margin-top: 4px;
}
.task-dates {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 0 4px;
}
.task-dates div {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 10px;
    color: var(--mk-faint);
    font-size: 10px;
}
.task-dates time {
    color: var(--mk-dim);
    font-family: var(--mk-mono);
}
@media (max-width: 900px) {
    .task-workspace {
        grid-template-columns: 1fr;
    }
    .task-sidebar {
        position: static;
        grid-row: 1;
    }
}
@media (max-width: 620px) {
    .task-header {
        flex-direction: column;
    }
    .task-header__actions {
        justify-content: flex-start;
    }
    .task-detail {
        grid-template-columns: 78px minmax(0, 1fr);
    }
    .task-claim {
        margin-left: 88px;
    }
}
</style>
