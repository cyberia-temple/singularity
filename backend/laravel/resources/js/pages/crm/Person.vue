<script setup lang="ts">
import { Head, Link, router, useForm, usePage } from '@inertiajs/vue3';
import { computed, nextTick, ref, useTemplateRef, watch } from 'vue';
import ContactWays from '@/components/console/ContactWays.vue';
import type { ContactWay } from '@/components/console/ContactWays.vue';
import CopyValue from '@/components/console/CopyValue.vue';
import Linked from '@/components/console/Linked.vue';
import Rule from '@/components/console/Rule.vue';
import { useConsoleLive } from '@/composables/useConsolePulse';
import { useLocale } from '@/composables/useLocale';
import {
    dateTime,
    num,
    shortDate,
    shortTime,
    toneColor,
    usd,
} from '@/lib/console';
import { consoleMessages } from '@/lib/consoleMessages';
import contactLinks from '@/routes/crm/contact-links';
import { store as recordMessage } from '@/routes/crm/messages';

/**
 * One person's dossier.
 *
 * The four panels that each held a slice of the record are one stream now:
 * visits, transfers, our messages and notes in the order they happened, which
 * is the only order in which a story reads. What is deliberately absent is a
 * balance curve — this app keeps no balance history, so the small chart is
 * transfers per week, which is a thing that is actually recorded.
 *
 * The stream is read two ways, and the difference is not cosmetic. As a
 * **feed** it answers "what happened to this person", newest first, filtered
 * to the touches or to the money. As a **thread** it answers "where does this
 * conversation stand", oldest first, with our lines and theirs told apart —
 * and that second reading is why the correspondence is a table of its own
 * rather than notes with a convention: only a direction makes "we wrote four
 * days ago and they have not answered" a fact the console can state.
 */
type Timeline = {
    group: string;
    kind: string;
    id: number;
    at: string | null;
    title: string;
    params: Record<string, string | number>;
    body: string | null;
    amount: { value: string; token: string; outbound: boolean } | null;
};

type Message = {
    id: number;
    direction: string;
    channel: string;
    body: string;
    at: string | null;
    /** The operator who typed it in — never the person who said it. */
    author: string | null;
    /** Who said it, when an import knew a name we do not. */
    said_by: string | null;
};

const props = defineProps<{
    contact: {
        id: number;
        name: string;
        telegram: string | null;
        x_handle: string | null;
        /* Built by the server: a stored handle is not always an address. */
        telegram_url: string | null;
        x_url: string | null;
        write_ways: ContactWay[];
        contact_links: {
            id: number;
            label: string;
            kind: string;
            url: string;
        }[];
        email: string | null;
        evm_address: string | null;
        solana_address: string | null;
        type: string;
        status: string;
        bought_usd: string | null;
        sold_usd: string | null;
        source: string;
        tags: string[];
        created_at: string | null;
        last_synced_at: string | null;
    };
    money: {
        cyber: number;
        cyber_usd: number | null;
        cyber_sol: number;
        cyber_sol_usd: number | null;
        price: number | null;
    };
    activity: number[];
    summary: {
        tone: string;
        key: string;
        params: Record<string, string | number>;
    };
    tasks: {
        id: number;
        title: string;
        status: string;
        priority: string;
        due_at: string | null;
        overdue: boolean;
        assignee: string | null;
    }[];
    timeline: Timeline[];
    /*
     * Which slice of the stream is on screen and how much of it is left
     * underneath. The counts are counts of the record and never of the slice
     * — a footer that counts what it already holds always says nothing more
     * is there.
     */
    events: {
        view: string;
        limit: number;
        shown: number;
        total: number;
        more: number;
        since: string | null;
        counts: { all: number; touch: number; money: number };
    };
    /*
     * The correspondence: what was said to this person and what they said
     * back. Typed in by an operator today, imported from Telegram and Discord
     * later — the row is the same either way.
     */
    conversation: {
        rows: Message[];
        total: number;
        last: { at: string | null; direction: string; channel: string } | null;
        /** Median minutes to an answer; null when nothing was ever answered. */
        replies_in: number | null;
        /** Whole days our last line has stood unanswered, null if it did not. */
        waiting_days: number | null;
        options: { channels: string[]; directions: string[] };
    };
    /*
     * The same human, filed more than once.
     *
     * `same` are records joined by evidence that stands on its own — a key
     * attached to an account, an address that signed a deposit under it.
     * `links` includes the guesses too, each with what justified it, so a
     * surprising join can be argued with instead of merely believed.
     */
    identity: {
        nodes: string[];
        same: {
            id: number;
            name: string;
            source: string;
            evm_address: string | null;
            solana_address: string | null;
            user_id: number | null;
        }[];
        links: {
            id: number;
            left: string;
            right: string;
            source: string;
            confidence: string;
            evidence: string | null;
            created_at: string | null;
        }[];
    };
    options: {
        types: string[];
        statuses: string[];
        taskPriorities: string[];
        taskStatuses: string[];
        views: string[];
        assignees: { id: number; name: string }[];
    };
}>();

const { t, tag } = useLocale(consoleMessages);

const note = useForm({ body: '' });
const contactLink = useForm({ url: '', label: '' });

function addContactLink() {
    contactLink.post(contactLinks.store.url(props.contact.id), {
        preserveScroll: true,
        onSuccess: () => contactLink.reset(),
    });
}

function removeContactLink(id: number) {
    router.delete(contactLinks.destroy.url([props.contact.id, id]), {
        preserveScroll: true,
    });
}

/*
 * Correcting the record.
 *
 * Half of a dossier is what happened — visits, transfers, notes — and none of
 * that is editable, because it is a log. The other half is what somebody told
 * us: a name, a handle, which pile this person belongs in. That half is
 * always slightly wrong (a handle changes, a lead becomes a customer), and a
 * console that can only read it makes the operator keep the correction in
 * their head. So exactly the told half opens for editing, in place, and the
 * log underneath stays a log.
 */
const editing = ref(false);

/*
 * A dossier is read while somebody else is writing in it: a note added, a
 * task closed, the sync landing a new balance. So it re-reads itself — except
 * while the told half is open for editing, because replacing the record
 * under a form that is about to overwrite it is how two operators undo each
 * other's corrections.
 */
useConsoleLive(
    ['people', 'notes', 'tasks', 'messages'],
    () =>
        router.reload({
            only: [
                'contact',
                'money',
                'activity',
                'summary',
                'tasks',
                'timeline',
                'events',
                'conversation',
                'identity',
                'console',
            ],
        }),
    { active: () => !editing.value },
);

const edit = useForm({
    name: '',
    telegram: '',
    x_handle: '',
    email: '',
    evm_address: '',
    solana_address: '',
    tags: '',
    type: props.contact.type,
    status: props.contact.status,
    bought_usd: props.contact.bought_usd ?? '',
    sold_usd: props.contact.sold_usd ?? '',
});

/* The told half of the record, in the order the read view lists it. */
type EditField =
    | 'name'
    | 'evm_address'
    | 'solana_address'
    | 'telegram'
    | 'x_handle'
    | 'email'
    | 'tags';

const editFields = computed<{ key: EditField; label: string; hint: string }[]>(
    () => [
        {
            key: 'name',
            label: t('person.name'),
            hint: t('person.namePlaceholder'),
        },
        { key: 'evm_address', label: t('person.evm'), hint: '0x…' },
        { key: 'solana_address', label: t('person.solana'), hint: '' },
        {
            key: 'telegram',
            label: t('person.telegram'),
            hint: t('person.handlePlaceholder'),
        },
        { key: 'x_handle', label: 'X', hint: t('person.handlePlaceholder') },
        { key: 'email', label: t('person.email'), hint: '' },
        {
            key: 'tags',
            label: t('person.tags'),
            hint: t('person.tagsPlaceholder'),
        },
    ],
);

function startEditing() {
    // Read from the record every time it is opened: another operator may have
    // changed it since this page was rendered.
    edit.defaults({
        name: props.contact.name,
        telegram: props.contact.telegram ?? '',
        x_handle: props.contact.x_handle ?? '',
        email: props.contact.email ?? '',
        evm_address: props.contact.evm_address ?? '',
        solana_address: props.contact.solana_address ?? '',
        tags: props.contact.tags.join(', '),
        type: props.contact.type,
        status: props.contact.status,
        bought_usd: props.contact.bought_usd ?? '',
        sold_usd: props.contact.sold_usd ?? '',
    });
    edit.reset();
    edit.clearErrors();
    editing.value = true;
}

function saveEdit() {
    if (edit.processing) {
        return;
    }

    edit.transform((data) => ({
        ...data,
        tags: data.tags
            .split(',')
            .map((value) => value.trim())
            .filter((value) => value !== ''),
    })).put(`/crm/${props.contact.id}`, {
        preserveScroll: true,
        onSuccess: () => {
            editing.value = false;
        },
    });
}

/** Linking by hand: an account id, an EVM address, a Solana address. */
const identityForm = useForm({ target: '' });

const suggestions = computed(() =>
    props.identity.links.filter((link) => link.confidence !== 'strong'),
);

const confirmed = computed(() =>
    props.identity.links.filter((link) => link.confidence === 'strong'),
);

/** `evm:0x89bb…` reads better than the forty characters it stands for. */
function nodeLabel(node: string): string {
    const [kind, ...rest] = node.split(':');
    const value = rest.join(':');

    return `${kind} ${value.length > 18 ? short(value) : value}`;
}

function linkIdentity() {
    identityForm.post(`/crm/${props.contact.id}/identity`, {
        preserveScroll: true,
        onSuccess: () => identityForm.reset(),
    });
}

function confirmLink(id: number) {
    router.post(
        `/crm/identity-links/${id}/confirm`,
        {},
        { preserveScroll: true },
    );
}

function withdrawLink(id: number) {
    router.delete(`/crm/identity-links/${id}`, { preserveScroll: true });
}

/*
 * What next: only what is still owed.
 *
 * A closed promise is not "what next" — it is what happened, and the stream
 * carries it. Leaving done tasks in this panel put a finished job under an
 * amber rail, which is the colour this console spends on work running out of
 * time.
 */
const openTasks = computed(() =>
    props.tasks.filter(
        (task) => task.status !== 'done' && task.status !== 'cancelled',
    ),
);

const overdue = computed(
    () => openTasks.value.filter((task) => task.overdue).length,
);

/*
 * Promising something, from the screen where the promise is made.
 *
 * The button existed in the design and in the dictionary and led nowhere: a
 * task about this person had to be typed on the board and pointed back here
 * with `#name`. It takes the board's own one-line grammar, minus the part
 * that names the person — that is the page you are standing on.
 */
const taskOpen = ref(false);
const taskInput = useTemplateRef<HTMLInputElement>('taskInput');

const task = useForm({
    title: '',
    priority: 'normal',
    assigned_to_user_id: null as number | null,
    due_at: '',
});

function openTask() {
    taskOpen.value = true;
    void nextTick(() => taskInput.value?.focus());
}

function createTask() {
    if (!task.title.trim() || task.processing) {
        return;
    }

    task.transform((data) => ({
        ...data,
        due_at: data.due_at === '' ? null : data.due_at,
    })).post(`/crm/${props.contact.id}/tasks`, {
        preserveScroll: true,
        onSuccess: () => {
            task.reset();
            taskOpen.value = false;
        },
    });
}

function closeTask(id: number) {
    router.put(
        `/crm/tasks/${id}`,
        { status: 'done' },
        { preserveScroll: true },
    );
}

/*
 * The stream, and the two ways it is read.
 *
 * `feed` is the record; `thread` is the conversation. The switch is not a
 * filter on the same rows — the orders are opposite and the questions are
 * different — so it is a switch and not a fourth segment beside the filters.
 */
const pane = ref<'feed' | 'thread'>(
    new URL(usePage().url, 'https://console.local').searchParams.get('pane') ===
        'thread'
        ? 'thread'
        : 'feed',
);

const thread = useTemplateRef<HTMLDivElement>('thread');

/** A conversation opens at its end, which is the only part being read. */
function scrollThread() {
    void nextTick(() => {
        if (thread.value) {
            thread.value.scrollTop = thread.value.scrollHeight;
        }
    });
}

watch(pane, (value) => value === 'thread' && scrollThread());
watch(() => props.conversation.rows.length, scrollThread);

/*
 * Which slice, and how much of it — both in the address, so a dossier opened
 * on the money is a link worth pasting and the back button undoes a filter
 * instead of leaving the page.
 */
function reread(query: Record<string, string | number>) {
    router.get(`/crm/${props.contact.id}`, query, {
        preserveScroll: true,
        preserveState: true,
        only: ['timeline', 'events'],
    });
}

function setView(view: string) {
    reread({ events: view, rows: 60 });
}

function showMore() {
    reread({ events: props.events.view, rows: props.events.limit + 60 });
}

const viewLabels: Record<string, string> = {
    all: 'person.viewAll',
    touch: 'person.viewTouch',
    money: 'person.viewMoney',
};

/*
 * The correspondence composer.
 *
 * Direction first, because it is the only field that changes what the line
 * means. `sent_at` is optional and empty by default: most lines are written
 * down right after they were said, and a required timestamp on every one of
 * them is a field nobody fills correctly. It is sent as a full ISO string
 * with this desk's offset — a bare `Y-m-d H:i` is read by the server in the
 * app's timezone, which is three hours from here.
 */
const page = usePage();
const planFollowUp = ref(false);
const message = useForm({
    body: '',
    direction: 'out',
    channel: props.conversation.last?.channel ?? 'telegram',
    sent_at: '',
    follow_up: {
        title: '',
        due_at: '',
        assigned_to_user_id:
            page.props.auth.user?.id ?? (null as number | null),
    },
});

function sendMessage() {
    if (!message.body.trim() || message.processing) {
        return;
    }

    message
        .transform((data) => ({
            ...data,
            follow_up: planFollowUp.value
                ? {
                      ...data.follow_up,
                      due_at: data.follow_up.due_at
                          ? new Date(data.follow_up.due_at).toISOString()
                          : '',
                  }
                : null,
            sent_at:
                data.sent_at === ''
                    ? null
                    : new Date(data.sent_at).toISOString(),
        }))
        .post(recordMessage.url(props.contact.id), {
            preserveScroll: true,
            onSuccess: () => {
                message.reset('body', 'sent_at', 'follow_up');
                planFollowUp.value = false;
                scrollThread();
            },
        });
}

function dropMessage(id: number) {
    router.delete(`/crm/messages/${id}`, { preserveScroll: true });
}

/** Enter sends, shift+enter is a new line — the room's own convention. */
function messageKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

/** The day a line was said, printed once above the first line of that day. */
function dayOf(iso: string | null): string {
    return iso ? iso.slice(0, 10) : '';
}

function startsDay(index: number): boolean {
    const rows = props.conversation.rows;

    return index === 0 || dayOf(rows[index - 1].at) !== dayOf(rows[index].at);
}

/** How long they usually take, said in the largest unit that is still true. */
const repliesIn = computed(() => {
    const minutes = props.conversation.replies_in;

    if (minutes === null) {
        return t('person.repliesUnknown');
    }

    if (minutes < 90) {
        return t('person.repliesMinutes', { count: Math.max(1, minutes) });
    }

    if (minutes < 60 * 36) {
        return t('person.repliesHours', { count: Math.round(minutes / 60) });
    }

    return t('person.repliesDays', { count: Math.round(minutes / 1440) });
});

/** The last line, and whose it was — the fact a dossier is opened for. */
const lastContact = computed(() => {
    const last = props.conversation.last;

    if (last === null) {
        return t('person.contactNever');
    }

    return `${shortDate(last.at, tag.value)}, ${
        last.direction === 'out'
            ? t('person.contactOurs')
            : t('person.contactTheirs')
    }`;
});

const summaryText = computed(() => {
    const params = { ...props.summary.params };

    if (typeof params.source === 'string') {
        params.source = t(`crm.source.${params.source}`);
    }

    return t(props.summary.key, params);
});

const hasActivity = computed(() => props.activity.some((value) => value > 0));

const bars = computed(() => {
    const max = Math.max(1, ...props.activity);

    return props.activity.map((value) => ({
        value,
        height: Math.max(2, Math.round((value / max) * 40)),
    }));
});

function short(address: string | null): string {
    if (!address) {
        return t('person.none');
    }

    return address.length > 14
        ? `${address.slice(0, 6)}…${address.slice(-4)}`
        : address;
}

function eventText(row: Timeline): string {
    const params = { ...row.params };

    if (typeof params.source === 'string') {
        params.source = t(`crm.source.${params.source}`);
    }

    if (typeof params.channel === 'string') {
        params.channel = t(`person.channel.${params.channel}`);
    }

    return t(row.title, params);
}

function saveNote() {
    note.post(`/crm/${props.contact.id}/notes`, {
        preserveScroll: true,
        onSuccess: () => note.reset(),
    });
}

function remove() {
    router.delete(`/crm/${props.contact.id}`);
}
</script>

<template>
    <Head :title="`Пульт · ${contact.name}`" />

    <div style="display: flex; align-items: center; gap: 14px; flex-wrap: wrap">
        <Link href="/crm/people" class="mk-btn mk-ghost" style="padding: 0 8px"
            >← {{ t('person.back') }}</Link
        >
        <h1 class="mk-h1">{{ contact.name }}</h1>
        <span class="mk-m mk-t3" style="font-size: 12px">
            {{
                contact.telegram ??
                (contact.x_handle
                    ? `@${contact.x_handle}`
                    : short(contact.evm_address))
            }}
            ·
            {{ t('person.since') }} {{ shortDate(contact.created_at, tag) }} ·
            {{ t('person.source').toLowerCase() }}
            {{ t('crm.source.' + contact.source) }}
        </span>
        <span
            class="mk-tag"
            :style="
                contact.type === 'whale'
                    ? {
                          borderColor: 'rgba(255,43,214,.4)',
                          color: 'var(--mk-money)',
                      }
                    : {}
            "
            >{{ t(`crm.type.${contact.type}`) }}</span
        >
        <span class="mk-tag">{{ t(`crm.status.${contact.status}`) }}</span>
        <div style="margin-left: auto; display: flex; gap: 8px">
            <ContactWays
                v-if="contact.write_ways.length"
                :ways="contact.write_ways"
                :label="t('person.write')"
            />
            <button type="button" class="mk-btn" @click="openTask">
                {{ t('person.addTask') }}
            </button>
            <button type="button" class="mk-btn mk-ghost" @click="remove">
                {{ t('person.delete') }}
            </button>
        </div>
    </div>

    <!-- A promise, made where it is made. One line with the board's own
         grammar (`@who !when`), and the person is this page. -->
    <form
        v-if="taskOpen"
        style="
            display: flex;
            align-items: center;
            gap: 12px;
            flex-wrap: wrap;
            padding: 0 14px;
            min-height: 48px;
            border: 1px solid rgba(0, 229, 209, 0.25);
            background: rgba(0, 229, 209, 0.04);
        "
        @submit.prevent="createTask"
    >
        <input
            ref="taskInput"
            v-model="task.title"
            class="mk-m"
            style="
                flex: 1;
                min-width: 220px;
                background: none;
                border: 0;
                outline: none;
                color: var(--mk-body);
                font-size: 13.5px;
            "
            :placeholder="t('person.taskPlaceholder')"
            @keydown.esc="taskOpen = false"
        />

        <span
            v-for="value in options.taskPriorities"
            :key="value"
            class="mk-pick"
            :class="{ 'mk-on': task.priority === value }"
            role="button"
            tabindex="0"
            @click="task.priority = value"
            @keydown.enter.prevent="task.priority = value"
            >{{ t(`priority.${value}`) }}</span
        >

        <select
            v-model="task.assigned_to_user_id"
            class="mk-input"
            style="max-width: 150px"
        >
            <option :value="null">{{ t('tasks.nobody') }}</option>
            <option
                v-for="operator in options.assignees"
                :key="operator.id"
                :value="operator.id"
            >
                {{ operator.name }}
            </option>
        </select>

        <input
            v-model="task.due_at"
            type="date"
            class="mk-input"
            style="max-width: 150px"
            :title="t('tasks.field.due')"
        />

        <span
            v-if="Object.keys(task.errors).length"
            style="font-size: 11.5px; color: var(--mk-critical)"
            >{{ Object.values(task.errors).join(' · ') }}</span
        >

        <button
            type="submit"
            class="mk-btn mk-act"
            :disabled="task.processing || !task.title.trim()"
        >
            {{ t('person.taskSave') }}
        </button>
        <button type="button" class="mk-btn mk-ghost" @click="taskOpen = false">
            {{ t('person.editCancel') }}
        </button>
    </form>

    <!-- The one sentence: only what is on the record, in the order that
         decides what to do next. -->
    <div
        style="padding: 14px 18px; border-left: 2px solid"
        :style="{
            borderLeftColor: toneColor(summary.tone),
            background: `color-mix(in srgb, ${toneColor(summary.tone)} 5%, transparent)`,
        }"
    >
        <p
            style="
                margin: 0;
                font-size: 13.5px;
                line-height: 1.6;
                color: var(--mk-body);
            "
        >
            {{ summaryText }}
        </p>
    </div>

    <div
        style="
            flex: 1;
            min-height: 0;
            display: grid;
            grid-template-columns: 322px minmax(0, 1fr);
            gap: 24px;
        "
    >
        <div style="display: flex; flex-direction: column; gap: 18px">
            <div>
                <Rule :label="t('person.money')" />
                <div class="mk-tile-row" style="margin-top: 12px">
                    <div class="mk-tile" style="padding: 12px 14px">
                        <p class="mk-k" style="margin: 0">CYBER</p>
                        <p
                            class="mk-num"
                            style="margin: 6px 0 0; font-size: 19px"
                        >
                            {{ num(money.cyber) }}
                        </p>
                        <p
                            class="mk-t3"
                            style="margin: 2px 0 0; font-size: 11px"
                        >
                            {{ usd(money.cyber_usd) }}
                        </p>
                    </div>
                    <div class="mk-tile" style="padding: 12px 14px">
                        <p class="mk-k" style="margin: 0">CYBER.sol</p>
                        <p
                            class="mk-num"
                            style="margin: 6px 0 0; font-size: 19px"
                        >
                            {{ num(money.cyber_sol) }}
                        </p>
                        <p
                            class="mk-t3"
                            style="margin: 2px 0 0; font-size: 11px"
                        >
                            {{ usd(money.cyber_sol_usd) }}
                        </p>
                    </div>
                </div>

                <div
                    class="mk-panel"
                    style="margin-top: 12px; padding: 12px 14px"
                >
                    <div style="display: flex; align-items: baseline">
                        <p class="mk-k" style="margin: 0">
                            {{ t('person.activity') }}
                        </p>
                    </div>
                    <div
                        v-if="hasActivity"
                        style="
                            margin-top: 10px;
                            display: flex;
                            align-items: flex-end;
                            gap: 3px;
                            height: 40px;
                        "
                    >
                        <div
                            v-for="(bar, index) in bars"
                            :key="index"
                            :style="{
                                flex: 1,
                                height: `${bar.height}px`,
                                background:
                                    bar.value > 0
                                        ? 'var(--mk-money)'
                                        : 'var(--mk-flat)',
                                opacity: bar.value > 0 ? 0.8 : 1,
                            }"
                        />
                    </div>
                    <p class="mk-t3" style="margin: 8px 0 0; font-size: 11px">
                        {{
                            hasActivity
                                ? t('person.activityNote')
                                : t('person.noActivity')
                        }}
                    </p>
                </div>
            </div>

            <div>
                <Rule :label="t('person.who')">
                    <button
                        v-if="!editing"
                        type="button"
                        class="mk-btn mk-ghost"
                        style="height: 22px; padding: 0 6px"
                        @click="startEditing"
                    >
                        {{ t('person.edit') }}
                    </button>
                </Rule>

                <!-- Reading. Every value that is going somewhere else — an
                     explorer, a message, a support ticket — carries its own
                     copy button, because what is drawn here is shortened and
                     shortened is exactly what cannot be pasted. -->
                <div v-if="!editing" style="margin-top: 10px">
                    <div
                        v-for="row in [
                            {
                                label: t('person.evm'),
                                value: contact.evm_address,
                                display: short(contact.evm_address),
                                href: null,
                            },
                            {
                                label: t('person.solana'),
                                value: contact.solana_address,
                                display: short(contact.solana_address),
                                href: null,
                            },
                            {
                                label: t('person.telegram'),
                                value: contact.telegram,
                                display: contact.telegram ?? t('person.none'),
                                href: contact.telegram_url,
                            },
                            {
                                label: t('person.x'),
                                value: contact.x_handle
                                    ? `@${contact.x_handle}`
                                    : null,
                                display: contact.x_handle
                                    ? `@${contact.x_handle}`
                                    : t('person.none'),
                                href: contact.x_url,
                            },
                            {
                                label: t('person.email'),
                                value: contact.email,
                                display: contact.email ?? t('person.none'),
                                href: contact.email
                                    ? `mailto:${contact.email}`
                                    : null,
                            },
                            {
                                label: t('person.tags'),
                                value: null,
                                display: contact.tags.length
                                    ? contact.tags.join(' · ')
                                    : t('unit.none'),
                                href: null,
                            },
                            {
                                label: t('person.lastContact'),
                                value: null,
                                display: lastContact,
                                href: null,
                            },
                            {
                                label: t('person.replies'),
                                value: null,
                                display: repliesIn,
                                href: null,
                            },
                            {
                                label: t('person.lastSync'),
                                value: null,
                                display: contact.last_synced_at
                                    ? dateTime(contact.last_synced_at, tag)
                                    : t('unit.none'),
                                href: null,
                            },
                        ]"
                        :key="row.label"
                        class="mk-hair"
                        style="
                            display: flex;
                            align-items: center;
                            gap: 12px;
                            padding: 8px 0;
                        "
                    >
                        <span
                            class="mk-t3"
                            style="
                                flex: 0 0 auto;
                                font-size: 12px;
                                white-space: nowrap;
                            "
                            >{{ row.label }}</span
                        >
                        <span
                            style="
                                flex: 1;
                                min-width: 0;
                                display: flex;
                                justify-content: flex-end;
                            "
                        >
                            <CopyValue
                                :value="row.value"
                                :display="row.display"
                                :href="row.href"
                            />
                        </span>
                    </div>

                    <div style="margin-top: 12px">
                        <p class="mk-k" style="margin: 0 0 7px">
                            {{ t('person.contactWays') }}
                        </p>
                        <div
                            v-for="way in contact.contact_links"
                            :key="way.id"
                            class="mk-hair"
                            style="
                                display: flex;
                                align-items: center;
                                gap: 8px;
                                padding: 7px 0;
                            "
                        >
                            <a
                                :href="way.url"
                                target="_blank"
                                rel="noreferrer"
                                class="mk-clip"
                                style="
                                    flex: 1;
                                    min-width: 0;
                                    color: var(--mk-cyan);
                                    font-size: 12px;
                                "
                                :title="way.url"
                                >{{ way.label }}</a
                            >
                            <button
                                type="button"
                                class="mk-btn mk-ghost"
                                style="height: 22px; padding: 0 6px"
                                :aria-label="t('person.contactLinkDelete')"
                                @click="removeContactLink(way.id)"
                            >
                                ×
                            </button>
                        </div>
                        <form
                            style="
                                margin-top: 8px;
                                display: grid;
                                grid-template-columns: minmax(0, 1fr) 90px auto;
                                gap: 6px;
                            "
                            @submit.prevent="addContactLink"
                        >
                            <input
                                v-model="contactLink.url"
                                class="mk-input"
                                inputmode="url"
                                :placeholder="t('people.linkUrl')"
                            />
                            <input
                                v-model="contactLink.label"
                                class="mk-input"
                                :placeholder="t('people.linkLabel')"
                            />
                            <button
                                type="submit"
                                class="mk-btn"
                                :disabled="
                                    contactLink.processing ||
                                    !contactLink.url.trim()
                                "
                            >
                                +
                            </button>
                        </form>
                        <p
                            v-if="Object.keys(contactLink.errors).length"
                            style="
                                margin: 6px 0 0;
                                color: var(--mk-critical);
                                font-size: 11px;
                            "
                        >
                            {{ Object.values(contactLink.errors).join(' · ') }}
                        </p>
                    </div>
                </div>

                <!-- Correcting. The same fields, in the same order, in the
                     same place — an edit screen somewhere else would be a
                     second version of this panel to keep in step with it. -->
                <form
                    v-else
                    style="
                        margin-top: 10px;
                        display: flex;
                        flex-direction: column;
                        gap: 7px;
                    "
                    @submit.prevent="saveEdit"
                >
                    <!-- Labelled rows rather than a stack of placeholders: a
                         filled field has no placeholder left, and six
                         identical boxes holding six handles is a puzzle. The
                         labels sit where the read view puts them, so the panel
                         does not move when it opens. -->
                    <label
                        v-for="field in editFields"
                        :key="field.key"
                        style="display: flex; align-items: center; gap: 10px"
                    >
                        <span
                            class="mk-t3"
                            style="
                                width: 62px;
                                flex: 0 0 62px;
                                font-size: 11.5px;
                            "
                            >{{ field.label }}</span
                        >
                        <input
                            v-model="edit[field.key]"
                            class="mk-input"
                            style="flex: 1; min-width: 0"
                            :placeholder="field.hint"
                        />
                    </label>

                    <div
                        style="
                            display: flex;
                            align-items: center;
                            gap: 12px;
                            flex-wrap: wrap;
                        "
                    >
                        <label
                            style="display: flex; align-items: center; gap: 6px"
                        >
                            <span class="mk-k"
                                >{{ t('people.bought') }}, $</span
                            >
                            <input
                                v-model="edit.bought_usd"
                                class="mk-input"
                                type="number"
                                min="0"
                                step="0.01"
                                inputmode="decimal"
                                style="width: 110px"
                            />
                        </label>
                        <label
                            style="display: flex; align-items: center; gap: 6px"
                        >
                            <span class="mk-k">{{ t('people.sold') }}, $</span>
                            <input
                                v-model="edit.sold_usd"
                                class="mk-input"
                                type="number"
                                min="0"
                                step="0.01"
                                inputmode="decimal"
                                style="width: 110px"
                            />
                        </label>
                    </div>

                    <div
                        style="
                            margin-top: 3px;
                            display: flex;
                            align-items: center;
                            gap: 6px;
                            flex-wrap: wrap;
                        "
                    >
                        <span class="mk-k">{{ t('person.editType') }}</span>
                        <button
                            v-for="value in options.types"
                            :key="value"
                            type="button"
                            class="mk-pick"
                            :class="{ 'mk-on': edit.type === value }"
                            @click="edit.type = value"
                        >
                            {{ t(`crm.type.${value}`) }}
                        </button>
                    </div>
                    <div
                        style="
                            display: flex;
                            align-items: center;
                            gap: 6px;
                            flex-wrap: wrap;
                        "
                    >
                        <span class="mk-k">{{ t('person.editStatus') }}</span>
                        <button
                            v-for="value in options.statuses"
                            :key="value"
                            type="button"
                            class="mk-pick"
                            :class="{ 'mk-on': edit.status === value }"
                            @click="edit.status = value"
                        >
                            {{ t(`crm.status.${value}`) }}
                        </button>
                    </div>

                    <p
                        v-if="Object.keys(edit.errors).length"
                        style="
                            margin: 4px 0 0;
                            font-size: 11.5px;
                            line-height: 1.5;
                            color: var(--mk-critical);
                        "
                    >
                        {{ Object.values(edit.errors).join(' · ') }}
                    </p>

                    <div style="margin-top: 4px; display: flex; gap: 8px">
                        <button
                            type="submit"
                            class="mk-btn mk-act"
                            :disabled="edit.processing"
                        >
                            {{ t('person.editSave') }}
                        </button>
                        <button
                            type="button"
                            class="mk-btn mk-ghost"
                            @click="editing = false"
                        >
                            {{ t('person.editCancel') }}
                        </button>
                    </div>

                    <p
                        class="mk-t3"
                        style="
                            margin: 2px 0 0;
                            font-size: 11px;
                            line-height: 1.5;
                        "
                    >
                        {{ t('person.editNote') }}
                    </p>
                </form>
            </div>

            <!-- The same human, filed more than once. Records stay separate;
                 what is asserted here is only that they are one person, and
                 every assertion says what justified it. -->
            <div style="margin-top: 22px">
                <Rule :label="t('person.identity')" />

                <p
                    v-if="!identity.same.length && !suggestions.length"
                    class="mk-t3"
                    style="margin: 10px 0 0; font-size: 11.5px"
                >
                    {{ t('person.identityNone') }}
                </p>

                <Link
                    v-for="other in identity.same"
                    :key="other.id"
                    :href="`/crm/${other.id}`"
                    class="mk-hair"
                    style="
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        padding: 8px 0;
                        text-decoration: none;
                    "
                >
                    <span
                        class="mk-tag"
                        style="
                            color: var(--mk-cyan);
                            border-color: var(--mk-cyan);
                        "
                        >{{ t('person.identitySame') }}</span
                    >
                    <span
                        class="mk-clip"
                        style="font-size: 12px; color: var(--mk-body)"
                        >{{ other.name }}</span
                    >
                    <span
                        class="mk-m mk-t3"
                        style="margin-left: auto; font-size: 11px"
                        >{{ other.source }}</span
                    >
                </Link>

                <!-- Guesses. A bridge pays out to whatever address it was
                     given, and people pay their friends — so these wait for
                     somebody to look rather than joining on their own. -->
                <div
                    v-for="link in suggestions"
                    :key="link.id"
                    class="mk-hair"
                    style="
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        padding: 8px 0;
                    "
                >
                    <span class="mk-tag">{{ t('person.identityMaybe') }}</span>
                    <span
                        class="mk-m mk-clip"
                        style="font-size: 11.5px; color: var(--mk-body)"
                        >{{ nodeLabel(link.left) }} ↔
                        {{ nodeLabel(link.right) }}</span
                    >
                    <span style="margin-left: auto; display: flex; gap: 6px">
                        <button
                            type="button"
                            class="mk-btn mk-ghost"
                            style="padding: 0 8px"
                            @click="confirmLink(link.id)"
                        >
                            {{ t('person.identityConfirm') }}
                        </button>
                        <button
                            type="button"
                            class="mk-btn mk-ghost"
                            style="padding: 0 8px"
                            @click="withdrawLink(link.id)"
                        >
                            {{ t('person.identityDrop') }}
                        </button>
                    </span>
                </div>

                <!-- Why, for each link that is holding. -->
                <details v-if="confirmed.length" style="margin-top: 10px">
                    <summary
                        class="mk-t3"
                        style="cursor: pointer; font-size: 11px"
                    >
                        {{
                            t('person.identityWhy', { count: confirmed.length })
                        }}
                    </summary>
                    <div
                        v-for="link in confirmed"
                        :key="link.id"
                        class="mk-hair"
                        style="
                            display: flex;
                            align-items: center;
                            gap: 8px;
                            padding: 6px 0;
                        "
                    >
                        <span class="mk-m mk-clip mk-t3" style="font-size: 11px"
                            >{{ nodeLabel(link.left) }} ↔
                            {{ nodeLabel(link.right) }}</span
                        >
                        <span
                            class="mk-m mk-t3"
                            style="margin-left: auto; font-size: 10.5px"
                            >{{ link.evidence ?? link.source }}</span
                        >
                        <button
                            type="button"
                            class="mk-btn mk-ghost"
                            style="padding: 0 6px"
                            @click="withdrawLink(link.id)"
                        >
                            {{ t('person.identityDrop') }}
                        </button>
                    </div>
                </details>

                <form
                    style="display: flex; gap: 6px; margin-top: 12px"
                    @submit.prevent="linkIdentity"
                >
                    <input
                        v-model="identityForm.target"
                        class="mk-input mk-m"
                        style="flex: 1; min-width: 0; font-size: 11.5px"
                        :placeholder="t('person.identityPlaceholder')"
                    />
                    <button
                        type="submit"
                        class="mk-btn mk-ghost"
                        style="padding: 0 10px"
                        :disabled="
                            identityForm.processing || !identityForm.target
                        "
                    >
                        {{ t('person.identityAdd') }}
                    </button>
                </form>
                <p
                    v-if="identityForm.errors.target"
                    class="mk-t3"
                    style="
                        margin: 6px 0 0;
                        font-size: 11px;
                        color: var(--mk-red);
                    "
                >
                    {{ identityForm.errors.target }}
                </p>
            </div>

            <div>
                <Rule
                    :label="t('person.next')"
                    :note="
                        overdue > 0
                            ? t('person.overdueCount', { count: overdue })
                            : null
                    "
                >
                    <button
                        type="button"
                        class="mk-btn mk-ghost"
                        style="height: 22px; padding: 0 6px"
                        @click="openTask"
                    >
                        {{ t('person.addTask') }}
                    </button>
                </Rule>
                <div
                    style="
                        margin-top: 10px;
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                    "
                >
                    <div
                        v-for="item in openTasks"
                        :key="item.id"
                        class="mk-panel"
                        style="
                            display: flex;
                            align-items: center;
                            gap: 11px;
                            padding: 11px 13px 11px 0;
                        "
                    >
                        <span
                            style="
                                width: 2px;
                                flex: 0 0 2px;
                                align-self: stretch;
                            "
                            :style="{
                                background: item.overdue
                                    ? 'var(--mk-critical)'
                                    : 'var(--mk-warning)',
                            }"
                        />
                        <div style="flex: 1; min-width: 0">
                            <p
                                style="
                                    margin: 0;
                                    font-size: 12.5px;
                                    font-weight: 500;
                                "
                            >
                                <Linked :text="item.title" />
                            </p>
                            <p
                                class="mk-m"
                                style="margin: 5px 0 0; font-size: 11px"
                                :style="{
                                    color: item.overdue
                                        ? 'var(--mk-critical)'
                                        : 'var(--mk-faint)',
                                }"
                            >
                                {{ item.assignee ?? t('tasks.nobody') }} ·
                                {{
                                    item.due_at
                                        ? shortDate(item.due_at, tag)
                                        : t('tasks.noDue')
                                }}
                            </p>
                        </div>
                        <!-- One action, and it is the one that empties the
                             panel: a promise kept. -->
                        <button
                            type="button"
                            class="mk-btn mk-ghost"
                            style="padding: 0 8px"
                            :title="t('person.taskDone')"
                            @click="closeTask(item.id)"
                        >
                            ✓
                        </button>
                    </div>
                    <p
                        v-if="!openTasks.length"
                        class="mk-t3"
                        style="font-size: 12px"
                    >
                        {{ t('person.noTasks') }}
                    </p>
                </div>
            </div>
        </div>

        <div
            id="conversation"
            style="display: flex; flex-direction: column; min-width: 0"
        >
            <Rule
                :label="
                    pane === 'feed'
                        ? t('person.everything')
                        : t('person.conversation')
                "
                :note="
                    pane === 'feed'
                        ? t('person.everythingNote')
                        : t('person.conversationNote')
                "
            >
                <span style="display: flex; gap: 6px">
                    <button
                        type="button"
                        class="mk-pick"
                        :class="{ 'mk-on': pane === 'feed' }"
                        @click="pane = 'feed'"
                    >
                        {{ t('person.paneFeed') }}
                    </button>
                    <button
                        type="button"
                        class="mk-pick"
                        :class="{ 'mk-on': pane === 'thread' }"
                        @click="pane = 'thread'"
                    >
                        {{ t('person.paneThread') }}
                        <template v-if="conversation.total">
                            · {{ conversation.total }}</template
                        >
                    </button>
                </span>
            </Rule>

            <!-- The record. -->
            <template v-if="pane === 'feed'">
                <form
                    style="margin-top: 12px; display: flex; gap: 8px"
                    @submit.prevent="saveNote"
                >
                    <input
                        v-model="note.body"
                        class="mk-input"
                        style="flex: 1"
                        :placeholder="t('person.addNote')"
                    />
                    <button
                        type="submit"
                        class="mk-btn mk-act"
                        :disabled="note.processing || !note.body"
                    >
                        {{ t('person.saveNote') }}
                    </button>
                </form>

                <div style="margin-top: 12px">
                    <div
                        v-for="(row, index) in timeline"
                        :key="`${row.kind}-${row.id}-${index}`"
                        class="mk-hair"
                        style="
                            display: flex;
                            align-items: flex-start;
                            gap: 14px;
                            padding: 12px 2px;
                        "
                    >
                        <span
                            class="mk-m mk-t3"
                            style="
                                width: 108px;
                                flex: 0 0 108px;
                                font-size: 11.5px;
                                padding-top: 2px;
                            "
                            >{{ dateTime(row.at, tag) }}</span
                        >
                        <span
                            style="
                                width: 26px;
                                flex: 0 0 26px;
                                height: 26px;
                                border: 1px solid var(--mk-hair-strong);
                                display: flex;
                                align-items: center;
                                justify-content: center;
                            "
                            :style="{
                                color:
                                    row.kind === 'bridge'
                                        ? 'var(--mk-warning)'
                                        : row.kind === 'note'
                                          ? 'var(--mk-accent)'
                                          : row.kind === 'said'
                                            ? 'var(--mk-accent)'
                                            : row.kind === 'heard'
                                              ? 'var(--mk-money)'
                                              : 'var(--mk-faint)',
                            }"
                        >
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="1.6"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            >
                                <path
                                    v-if="row.kind === 'bridge'"
                                    d="M3 18V9M21 18V9M3 13c5-4.5 13-4.5 18 0"
                                />
                                <template v-else-if="row.kind === 'note'">
                                    <path d="M5 4h14v16H5z" />
                                    <path d="M8 9h8M8 13h5" />
                                </template>
                                <!-- Said and heard are the same envelope
                                     pointing opposite ways: the direction is
                                     the whole difference between them. -->
                                <template v-else-if="row.kind === 'said'">
                                    <path d="M4 12h13M13 7l5 5-5 5M20 4v16" />
                                </template>
                                <template v-else-if="row.kind === 'heard'">
                                    <path d="M20 12H7M11 7l-5 5 5 5M4 4v16" />
                                </template>
                                <template v-else-if="row.kind === 'task'">
                                    <rect
                                        x="4"
                                        y="4"
                                        width="16"
                                        height="16"
                                        rx="2"
                                    />
                                    <path d="M8 12l3 3 5-6" />
                                </template>
                                <template v-else>
                                    <circle cx="12" cy="12" r="8" />
                                    <path d="M12 8v4l3 2" />
                                </template>
                            </svg>
                        </span>
                        <div style="flex: 1; min-width: 0">
                            <div style="font-size: 13px; font-weight: 500">
                                {{ eventText(row) }}
                            </div>
                            <div
                                v-if="row.body"
                                class="mk-t3"
                                style="
                                    margin-top: 3px;
                                    font-size: 11.5px;
                                    white-space: pre-wrap;
                                    overflow-wrap: anywhere;
                                "
                            >
                                <Linked :text="row.body" />
                            </div>
                        </div>
                        <span
                            v-if="row.amount"
                            class="mk-num"
                            style="font-size: 13px"
                            :style="{
                                color: row.amount.outbound
                                    ? 'var(--mk-warning)'
                                    : 'var(--mk-dim)',
                            }"
                        >
                            {{ row.amount.outbound ? '−' : '+'
                            }}{{ row.amount.value }}
                            {{ row.amount.token }}
                        </span>
                    </div>
                    <p
                        v-if="!timeline.length"
                        class="mk-t3"
                        style="font-size: 12px"
                    >
                        {{
                            events.view === 'all'
                                ? t('person.noHistory')
                                : t('person.noHistoryHere')
                        }}
                    </p>
                </div>

                <!-- What is left underneath, and the two other readings of the
                     same stream. The counts are of the record, so a filter
                     that would show nothing says so before it is pressed. -->
                <div
                    style="
                        margin-top: 12px;
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        flex-wrap: wrap;
                    "
                >
                    <span class="mk-m mk-t3" style="font-size: 11px">
                        <template v-if="events.more > 0">
                            {{
                                t('person.moreEvents', {
                                    count: events.more,
                                    since: shortDate(events.since, tag),
                                })
                            }}
                        </template>
                        <template v-else>
                            {{ t('person.allEvents', { count: events.total }) }}
                        </template>
                    </span>
                    <button
                        v-if="events.more > 0"
                        type="button"
                        class="mk-btn mk-ghost"
                        @click="showMore"
                    >
                        {{ t('people.more') }}
                    </button>

                    <span style="margin-left: auto; display: flex; gap: 6px">
                        <button
                            v-for="view in options.views"
                            :key="view"
                            type="button"
                            class="mk-pick"
                            :class="{ 'mk-on': events.view === view }"
                            @click="setView(view)"
                        >
                            {{ t(viewLabels[view] ?? view) }}
                            <template v-if="view !== 'all'">
                                ·
                                {{ events.counts[view as 'touch' | 'money'] }}
                            </template>
                        </button>
                    </span>
                </div>
            </template>

            <!-- The conversation. Oldest first, ours and theirs told apart,
                 and typed in after the fact — this console holds nobody's
                 Telegram session, so it records and never sends. -->
            <template v-else>
                <div ref="thread" class="mk-thread" style="margin-top: 12px">
                    <p
                        v-if="!conversation.rows.length"
                        class="mk-t3"
                        style="font-size: 12px"
                    >
                        {{ t('person.noConversation') }}
                    </p>

                    <template
                        v-for="(line, index) in conversation.rows"
                        :key="line.id"
                    >
                        <div
                            v-if="startsDay(index)"
                            class="mk-k"
                            style="margin: 14px 0 4px"
                        >
                            {{ shortDate(line.at, tag) }}
                        </div>

                        <div
                            class="mk-line"
                            :class="{ 'mk-ours': line.direction === 'out' }"
                        >
                            <span class="mk-line-rail" />
                            <div class="mk-line-body">
                                <div class="mk-line-head">
                                    <span
                                        :style="{
                                            color:
                                                line.direction === 'out'
                                                    ? 'var(--mk-accent)'
                                                    : 'var(--mk-money)',
                                        }"
                                        >{{
                                            line.direction === 'out'
                                                ? t('person.lineOurs')
                                                : (line.said_by ?? contact.name)
                                        }}</span
                                    >
                                    <span>{{
                                        t(`person.channel.${line.channel}`)
                                    }}</span>
                                    <span>{{ shortTime(line.at, tag) }}</span>
                                    <span
                                        v-if="line.author"
                                        class="mk-wide"
                                        style="color: var(--mk-fainter)"
                                        >{{
                                            t('person.wroteDown', {
                                                name: line.author,
                                            })
                                        }}</span
                                    >
                                    <button
                                        type="button"
                                        class="mk-btn mk-ghost mk-line-drop"
                                        style="
                                            margin-left: auto;
                                            height: 20px;
                                            padding: 0 6px;
                                        "
                                        @click="dropMessage(line.id)"
                                    >
                                        {{ t('person.lineDrop') }}
                                    </button>
                                </div>
                                <p><Linked :text="line.body" /></p>
                            </div>
                        </div>
                    </template>
                </div>

                <form class="mk-composer" @submit.prevent="sendMessage">
                    <div
                        style="
                            flex: 1;
                            min-width: 0;
                            display: flex;
                            flex-direction: column;
                            gap: 9px;
                        "
                    >
                        <div
                            style="
                                display: flex;
                                align-items: center;
                                gap: 6px;
                                flex-wrap: wrap;
                            "
                        >
                            <!-- Direction first: it is the only field that
                                 changes what the line means. -->
                            <button
                                v-for="value in conversation.options.directions"
                                :key="value"
                                type="button"
                                class="mk-pick"
                                :class="{
                                    'mk-on': message.direction === value,
                                }"
                                @click="message.direction = value"
                            >
                                {{
                                    value === 'out'
                                        ? t('person.lineOurs')
                                        : t('person.lineTheirs')
                                }}
                            </button>

                            <select
                                v-model="message.channel"
                                class="mk-input"
                                style="max-width: 130px; margin-left: 6px"
                            >
                                <option
                                    v-for="value in conversation.options
                                        .channels"
                                    :key="value"
                                    :value="value"
                                >
                                    {{ t(`person.channel.${value}`) }}
                                </option>
                            </select>

                            <!-- When it was said. Empty means now, which is
                                 what it is when a line is written down as it
                                 happens. -->
                            <input
                                v-model="message.sent_at"
                                type="datetime-local"
                                class="mk-input"
                                style="max-width: 200px"
                                :title="t('person.lineWhen')"
                            />
                        </div>

                        <textarea
                            v-model="message.body"
                            rows="2"
                            :placeholder="t('person.linePlaceholder')"
                            style="
                                min-height: 42px;
                                max-height: 160px;
                                padding: 0;
                                border: 0;
                                outline: none;
                                resize: vertical;
                                background: transparent;
                                color: var(--mk-text);
                                font-family: var(--mk-mono);
                                font-size: 13.5px;
                                line-height: 1.5;
                            "
                            @keydown="messageKeydown"
                        />

                        <label class="mk-t3" style="font-size: 12px">
                            <input v-model="planFollowUp" type="checkbox" />
                            {{ t('people.planWithMessage') }}
                        </label>
                        <div v-if="planFollowUp" class="lead-follow-up">
                            <label
                                >{{ t('people.followTitle') }}
                                <input
                                    v-model="message.follow_up.title"
                                    class="mk-input"
                                    required
                                    maxlength="255"
                                />
                            </label>
                            <label
                                >{{ t('people.followWhen') }}
                                <input
                                    v-model="message.follow_up.due_at"
                                    type="datetime-local"
                                    class="mk-input"
                                    required
                                />
                            </label>
                            <label
                                >{{ t('people.followWho') }}
                                <select
                                    v-model="
                                        message.follow_up.assigned_to_user_id
                                    "
                                    class="mk-input"
                                    required
                                >
                                    <option
                                        v-for="operator in options.assignees"
                                        :key="operator.id"
                                        :value="operator.id"
                                    >
                                        {{ operator.name }}
                                    </option>
                                </select>
                            </label>
                        </div>
                        <p
                            v-if="Object.keys(message.errors).length"
                            style="
                                margin: 0;
                                font-size: 11.5px;
                                color: var(--mk-critical);
                            "
                        >
                            {{ Object.values(message.errors).join(' · ') }}
                        </p>
                    </div>

                    <button
                        type="submit"
                        class="mk-btn mk-act"
                        :disabled="message.processing || !message.body.trim()"
                    >
                        {{
                            t(
                                planFollowUp
                                    ? 'people.saveAndPlan'
                                    : 'person.lineSave',
                            )
                        }}
                    </button>
                </form>

                <p class="mk-t3" style="margin: 8px 0 0; font-size: 11px">
                    {{ t('person.conversationHint') }}
                </p>
            </template>
        </div>
    </div>
</template>

<style scoped>
.lead-follow-up {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
}
.lead-follow-up label {
    display: flex;
    flex: 1 1 180px;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
}
</style>
