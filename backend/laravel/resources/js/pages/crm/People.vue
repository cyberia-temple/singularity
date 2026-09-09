<script setup lang="ts">
import { Head, Link, router, useForm } from '@inertiajs/vue3';
import { computed, nextTick, ref, watch } from 'vue';
import type { ContactWay } from '@/components/console/ContactWays.vue';
import Rule from '@/components/console/Rule.vue';
import Spark from '@/components/console/Spark.vue';
import { useConsoleLive } from '@/composables/useConsolePulse';
import { useLocale } from '@/composables/useLocale';
import {
    age,
    dateTime,
    num,
    plural,
    secondsSince,
    toneColor,
} from '@/lib/console';
import { consoleMessages } from '@/lib/consoleMessages';
import { show as showPerson } from '@/routes/crm';
import { show as showTask } from '@/routes/crm/tasks';

/**
 * "Лиды" — contacts read as what happened to them.
 *
 * Segments carry the questions worth re-asking: a filter is a question typed
 * out by hand every time, a segment is that question saved with its rule
 * visible, and the rule is on the row so an empty segment can be told from a
 * broken definition. The middle of each row is the person's freshest signal
 * rather than their database columns, because that is what decides whether
 * anybody writes to them today.
 *
 * The narrow strip above the table is not that question coming back. It
 * answers a different task — **finding one person you know exists** — which
 * segments are the wrong shape for: type, status, a search box that reads
 * `@handle` and a profile URL the way they are pasted, and an order. The
 * order is the load-bearing one. Every row here is stamped by the half-hourly
 * balance refresh, so "newest first" means "in sync order", and a lead
 * entered by hand yesterday sinks under every whale re-read this morning —
 * which is exactly how somebody ends up on the books and unfindable.
 */
type Signal = {
    key: string;
    at: string | null;
    params: Record<string, string | number>;
    tone: string;
};

type Row = {
    id: number;
    name: string;
    handle: string | null;
    type: string;
    status: string;
    bought_usd: string | null;
    sold_usd: string | null;
    usd: number | null;
    /* When the record was written down; shown when the list is sorted by it. */
    added: string | null;
    signal: Signal;
    next: {
        kind: string;
        last_at: string | null;
        direction: string | null;
        task: {
            id: number;
            title: string;
            due_at: string | null;
            assignee: string | null;
        } | null;
    };
    spark: number[];
    /* Where a message to this person would go, or null when nowhere does. */
    write: string | null;
    write_ways: ContactWay[];
    action: string;
};

const props = defineProps<{
    segment: string;
    segments: { key: string; count: number; tone: string }[];
    rows: Row[];
    total: number;
    shown: number;
    limit: number;
    more: boolean;
    search: string | null;
    /* The narrowing inside the segment, and the order it is read in. */
    type: string | null;
    status: string | null;
    sort: string;
    options: { types: string[]; statuses: string[]; sorts: string[] };
    /* The last recorded import: how old this screen is. */
    sync: {
        at: string;
        trigger: string;
        added: number;
        sold: number;
        running: boolean;
        partial: boolean;
    } | null;
}>();

const { locale, t, tag } = useLocale(consoleMessages);

const query = ref(props.search ?? '');
const tradeAmounts = ref<Record<number, string>>(
    Object.fromEntries(
        props.rows.map((row) => [
            row.id,
            row.status === 'sold'
                ? (row.sold_usd ?? '')
                : (row.bought_usd ?? row.sold_usd ?? ''),
        ]),
    ),
);
const savingTrade = ref<number | null>(null);

function recordTrade(row: Row, kind: 'bought' | 'sold') {
    const amount = tradeAmounts.value[row.id]?.trim() ?? '';
    const numericAmount = Number(amount);

    if (
        savingTrade.value !== null ||
        amount === '' ||
        !Number.isFinite(numericAmount) ||
        numericAmount <= 0
    ) {
        return;
    }

    savingTrade.value = row.id;
    router.put(
        `/crm/${row.id}`,
        {
            status: kind === 'bought' ? 'customer' : 'sold',
            [kind === 'bought' ? 'bought_usd' : 'sold_usd']: amount,
        },
        {
            preserveScroll: true,
            preserveState: true,
            onFinish: () => {
                savingTrade.value = null;
            },
        },
    );
}

watch(
    () => props.rows,
    (rows) => {
        for (const row of rows) {
            if (tradeAmounts.value[row.id] === undefined) {
                tradeAmounts.value[row.id] =
                    row.status === 'sold'
                        ? (row.sold_usd ?? '')
                        : (row.bought_usd ?? row.sold_usd ?? '');
            }
        }
    },
);

/*
 * The lens two operators fill in together.
 *
 * A person written down on one desk — or a balance the half-hourly sync just
 * refreshed — appears here without a reload, and the segment counts move with
 * it. The search box and the composer are local state and survive the
 * re-read: this replaces the row, never what somebody is typing.
 */
useConsoleLive(['people', 'messages', 'tasks'], () =>
    router.reload({
        only: ['segments', 'rows', 'total', 'shown', 'more', 'sync', 'console'],
    }),
);

/*
 * Putting somebody on the books.
 *
 * The panel stays open after each save and the page comes back to the lens
 * rather than to the new dossier, because people are found in handfuls —
 * fifteen accounts in one afternoon — and a form that closes itself after
 * every one of them is fourteen extra decisions. The first field takes the
 * focus back so the next person is typed, not clicked at.
 */
const adding = ref(false);
const nameField = ref<HTMLInputElement | null>(null);
const linkField = ref<HTMLInputElement | null>(null);
const addTab = ref<'details' | 'link'>('details');

const draft = useForm({
    name: '',
    telegram: '',
    x_handle: '',
    email: '',
    evm_address: '',
    solana_address: '',
    tags: '',
    type: 'lead',
    status: 'new',
    contact_link_url: '',
    contact_link_label: '',
});

/*
 * Every field is optional in the column and in the rules, which together
 * would happily store a row that names nobody. A record with nothing to
 * identify it cannot be searched, written to or recognised later, so the
 * one thing asked for is any one of the ways of naming a person.
 */
const named = computed(() =>
    [
        draft.name,
        draft.telegram,
        draft.x_handle,
        draft.email,
        draft.evm_address,
        draft.solana_address,
        draft.contact_link_url,
    ].some((value) => value.trim() !== ''),
);

function openAdd() {
    adding.value = !adding.value;

    if (adding.value) {
        void nextTick(() => nameField.value?.focus());
    }
}

function pickAddTab(tab: 'details' | 'link') {
    addTab.value = tab;
    void nextTick(() =>
        tab === 'details' ? nameField.value?.focus() : linkField.value?.focus(),
    );
}

function create() {
    if (!named.value || draft.processing) {
        return;
    }

    draft
        .transform((data) => ({
            ...data,
            tags: data.tags
                .split(',')
                .map((tag) => tag.trim())
                .filter((tag) => tag !== ''),
        }))
        .post('/crm/people', {
            preserveScroll: true,
            preserveState: true,
            onSuccess: () => {
                const type = draft.type;
                const status = draft.status;

                draft.reset();
                // The next fifteen are usually the same kind of person.
                draft.type = type;
                draft.status = status;

                void nextTick(() => nameField.value?.focus());
            },
        });
}

/*
 * Loading what the ecosystem knows and this base does not.
 *
 * It runs in the request, not on a queue — this host is not guaranteed a
 * worker — so it can take a while, and a button that looks untouched for
 * thirty seconds gets pressed four more times. The state is on the button,
 * and the date beside it is what the press is for.
 */
const syncing = ref(false);

function loadNew() {
    if (syncing.value) {
        return;
    }

    syncing.value = true;
    router.post(
        '/crm/sync',
        {},
        {
            preserveScroll: true,
            preserveState: true,
            onFinish: () => {
                syncing.value = false;
            },
        },
    );
}

/**
 * How old the base is, in a sentence.
 *
 * A run that read nothing off the chain still has a date, and printing that
 * date on its own would say the base is fresh when a quarter of it was not
 * looked at — so `partial` is said out loud, and in amber.
 */
const freshness = computed(() => {
    if (props.sync === null) {
        return { text: t('people.syncNever'), tone: 'flat', brought: null };
    }

    const seconds = secondsSince(props.sync.at);
    const value = age(seconds);
    const ago =
        value === null
            ? ''
            : `${value.value} ${plural(locale.value, value.count, t(value.unit))}`;

    return {
        text: props.sync.running
            ? t('people.syncRunning', { ago })
            : t('people.syncAt', { ago }),
        tone: props.sync.partial
            ? 'warning'
            : (seconds ?? 0) > 60 * 60 * 36
              ? 'warning'
              : 'flat',
        brought:
            props.sync.added || props.sync.sold
                ? t('people.syncBrought', {
                      added: props.sync.added,
                      sold: props.sync.sold,
                  })
                : null,
    };
});

const silenceDays = 30;

function rule(key: string): string {
    return t(`rule.${key}`, { days: silenceDays });
}

/*
 * Everything that narrows the list lives in the address.
 *
 * A segment is the saved question; type, status, the search box and the order
 * are what an operator does inside it while looking for one person. Keeping
 * them in the URL means the answer can be bookmarked and pasted to the other
 * desk — and means the back button undoes a filter, which is what everybody
 * tries first.
 */
function go(
    segment: string = props.segment,
    changes: Record<string, string | undefined> = {},
) {
    router.get(
        '/crm/people',
        {
            segment,
            q: query.value || undefined,
            type: props.type ?? undefined,
            status: props.status ?? undefined,
            sort: props.sort === 'signal' ? undefined : props.sort,
            ...changes,
        },
        { preserveState: true, preserveScroll: true },
    );
}

/** A select that puts itself into the address. `''` is "no filter". */
function pick(key: 'type' | 'status' | 'sort', value: string) {
    go(props.segment, { [key]: value === '' ? undefined : value });
}

/** Whether anything is narrowing the list beyond the segment itself. */
const narrowed = computed(
    () =>
        props.type !== null ||
        props.status !== null ||
        (props.search ?? '') !== '' ||
        props.sort !== 'signal',
);

function clearFilters() {
    query.value = '';
    router.get(
        '/crm/people',
        { segment: props.segment },
        { preserveState: true, preserveScroll: true },
    );
}

/**
 * A signal, with its value words translated too.
 *
 * The server sends `source: "whale_bot"` because that is what the column
 * holds; a sentence that reads "appeared, from whale_bot" is a sentence
 * written by a database, so the value passes through the dictionary on its
 * way into the phrase.
 */
function signalText(signal: Signal): string {
    const params = { ...signal.params };

    if (typeof params.source === 'string') {
        params.source = t(`crm.source.${params.source}`);
    }

    if (typeof params.was === 'string') {
        params.was = t(params.was, signal.params);
    }

    return t(signal.key, params);
}

function more40() {
    go(props.segment, { rows: String(props.limit + 40) });
}

function open(row: Row) {
    router.visit(showPerson.url(row.id));
}

function ago(iso: string | null): string {
    const seconds = secondsSince(iso);
    const value = age(seconds);

    return value === null
        ? ''
        : t('signal.ago', {
              ago: `${value.value} ${plural(locale.value, value.count, t(value.unit))}`,
          });
}

const currentSegment = computed(
    () =>
        props.segments.find((segment) => segment.key === props.segment) ?? null,
);
</script>

<template>
    <Head title="Пульт · Лиды" />

    <div
        style="
            display: flex;
            gap: 24px;
            margin: -22px -24px;
            min-height: 0;
            flex: 1;
        "
    >
        <!-- Saved questions, with their rules. -->
        <aside
            style="
                width: 258px;
                flex: 0 0 258px;
                border-right: 1px solid var(--mk-hair);
                padding: 22px 18px;
                overflow-y: auto;
            "
            class="mk-wide"
        >
            <Rule :label="t('people.segments')" />
            <div
                style="
                    margin-top: 12px;
                    display: flex;
                    flex-direction: column;
                    gap: 1px;
                "
            >
                <button
                    v-for="segment in segments"
                    :key="segment.key"
                    type="button"
                    :title="rule(segment.key)"
                    style="
                        display: flex;
                        align-items: center;
                        gap: 10px;
                        height: 34px;
                        padding: 0 11px;
                        font-size: 13px;
                        background: none;
                        border: 0;
                        cursor: pointer;
                        font-family: inherit;
                        text-align: left;
                    "
                    :style="
                        segment.key === props.segment
                            ? {
                                  background: 'var(--mk-accent-soft)',
                                  color: 'var(--mk-text)',
                                  boxShadow: 'inset 2px 0 0 var(--mk-accent)',
                              }
                            : { color: 'var(--mk-dim)' }
                    "
                    @click="go(segment.key)"
                >
                    <span
                        class="mk-dot"
                        :style="{ background: toneColor(segment.tone) }"
                    />
                    {{ t(`segment.${segment.key}`) }}
                    <span
                        class="mk-m mk-t3"
                        style="margin-left: auto; font-size: 11px"
                        >{{ num(segment.count) }}</span
                    >
                </button>
            </div>
            <p
                class="mk-t3"
                style="margin: 16px 11px 0; font-size: 11px; line-height: 1.55"
            >
                {{ t('people.segmentNote') }}
            </p>
        </aside>

        <div
            style="
                flex: 1;
                min-width: 0;
                padding: 22px 24px 22px 0;
                display: flex;
                flex-direction: column;
                gap: 16px;
                overflow-y: auto;
            "
        >
            <div
                style="
                    display: flex;
                    align-items: baseline;
                    gap: 12px;
                    flex-wrap: wrap;
                "
            >
                <h1 class="mk-h1">{{ t(`segment.${segment}`) }}</h1>
                <span class="mk-m mk-t3" style="font-size: 12px">
                    {{ num(currentSegment?.count ?? total) }} ·
                    {{ rule(segment) }}
                </span>
                <!-- The controls, and under them the one fact they are
                     answerable for: how old everything below this line is. -->
                <div
                    style="
                        margin-left: auto;
                        display: flex;
                        flex-direction: column;
                        align-items: flex-end;
                        gap: 7px;
                    "
                >
                    <div style="display: flex; gap: 8px">
                        <input
                            v-model="query"
                            class="mk-input"
                            :placeholder="t('people.search')"
                            @keyup.enter="go(segment)"
                        />
                        <button
                            type="button"
                            class="mk-btn mk-ghost"
                            :disabled="syncing"
                            :title="t('people.syncNote')"
                            @click="loadNew"
                        >
                            {{
                                syncing ? t('people.syncing') : t('people.sync')
                            }}
                        </button>
                        <a href="/crm/export" class="mk-btn">{{
                            t('people.export')
                        }}</a>
                        <button
                            type="button"
                            class="mk-btn"
                            :class="adding ? 'mk-ghost' : 'mk-act'"
                            @click="openAdd"
                        >
                            {{
                                adding ? t('people.addClose') : t('people.add')
                            }}
                        </button>
                    </div>

                    <span
                        class="mk-m"
                        style="font-size: 11px; text-align: right"
                        :style="{
                            color:
                                freshness.tone === 'warning'
                                    ? 'var(--mk-warning)'
                                    : 'var(--mk-faint)',
                        }"
                        :title="sync ? dateTime(sync.at, tag) : ''"
                    >
                        {{ freshness.text
                        }}<template v-if="freshness.brought">
                            · {{ freshness.brought }}</template
                        ><template v-if="sync?.partial">
                            · {{ t('people.syncPartial') }}</template
                        >
                    </span>
                </div>
            </div>

            <!-- Narrowing inside the segment. A segment is the saved
                 question; this is the ordinary one an operator asks while
                 hunting for a person they know exists — and the order, which
                 is what "I added them yesterday" needs, since everything on
                 this screen is stamped by the sync rather than by anybody. -->
            <div
                style="
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    flex-wrap: wrap;
                "
            >
                <span class="mk-k">{{ t('people.filters') }}</span>

                <select
                    class="mk-input"
                    style="width: auto"
                    :value="type ?? ''"
                    @change="
                        pick('type', ($event.target as HTMLSelectElement).value)
                    "
                >
                    <option value="">{{ t('people.anyType') }}</option>
                    <option
                        v-for="value in options.types"
                        :key="value"
                        :value="value"
                    >
                        {{ t(`crm.type.${value}`) }}
                    </option>
                </select>

                <select
                    class="mk-input"
                    style="width: auto"
                    :value="status ?? ''"
                    @change="
                        pick(
                            'status',
                            ($event.target as HTMLSelectElement).value,
                        )
                    "
                >
                    <option value="">{{ t('people.anyStatus') }}</option>
                    <option
                        v-for="value in options.statuses"
                        :key="value"
                        :value="value"
                    >
                        {{ t(`crm.status.${value}`) }}
                    </option>
                </select>

                <span class="mk-k">{{ t('people.sort') }}</span>

                <select
                    class="mk-input"
                    style="width: auto"
                    :value="sort"
                    @change="
                        pick('sort', ($event.target as HTMLSelectElement).value)
                    "
                >
                    <option
                        v-for="value in options.sorts"
                        :key="value"
                        :value="value"
                    >
                        {{ t(`sort.${value}`) }}
                    </option>
                </select>

                <button
                    v-if="narrowed"
                    type="button"
                    class="mk-btn mk-ghost"
                    @click="clearFilters"
                >
                    {{ t('people.clear') }}
                </button>
            </div>

            <!-- The way somebody gets onto the books by hand. Sync writes the
                 people the chain and the bot already know about; this is for
                 the ones found by looking, who exist nowhere in our data until
                 they are typed. -->
            <form
                v-if="adding"
                class="mk-panel"
                style="padding: 14px 16px"
                @submit.prevent="create"
            >
                <Rule :label="t('people.addTitle')" />
                <p
                    class="mk-t3"
                    style="margin: 9px 0 0; font-size: 11.5px; line-height: 1.5"
                >
                    {{ t('people.addNote') }}
                </p>

                <div
                    role="tablist"
                    :aria-label="t('people.addTitle')"
                    style="margin-top: 12px; display: flex; gap: 6px"
                >
                    <button
                        type="button"
                        role="tab"
                        class="mk-pick"
                        :class="{ 'mk-on': addTab === 'details' }"
                        :aria-selected="addTab === 'details'"
                        @click="pickAddTab('details')"
                    >
                        {{ t('people.addDetails') }}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        class="mk-pick"
                        :class="{ 'mk-on': addTab === 'link' }"
                        :aria-selected="addTab === 'link'"
                        @click="pickAddTab('link')"
                    >
                        {{ t('people.addLinkTab') }}
                    </button>
                </div>

                <div
                    v-if="addTab === 'details'"
                    style="
                        margin-top: 12px;
                        display: grid;
                        grid-template-columns: repeat(
                            auto-fit,
                            minmax(196px, 1fr)
                        );
                        gap: 8px;
                    "
                >
                    <input
                        ref="nameField"
                        v-model="draft.name"
                        class="mk-input"
                        :placeholder="t('person.namePlaceholder')"
                    />
                    <input
                        v-model="draft.telegram"
                        class="mk-input"
                        :placeholder="`${t('person.telegram')} · ${t('person.handlePlaceholder')}`"
                    />
                    <input
                        v-model="draft.x_handle"
                        class="mk-input"
                        :placeholder="`X · ${t('person.handlePlaceholder')}`"
                    />
                    <input
                        v-model="draft.email"
                        class="mk-input"
                        :placeholder="t('person.email')"
                    />
                    <input
                        v-model="draft.evm_address"
                        class="mk-input"
                        placeholder="EVM · 0x…"
                    />
                    <input
                        v-model="draft.solana_address"
                        class="mk-input"
                        placeholder="Solana"
                    />
                    <input
                        v-model="draft.tags"
                        class="mk-input"
                        :placeholder="`${t('person.tags')} · ${t('person.tagsPlaceholder')}`"
                    />
                </div>

                <div
                    v-else
                    style="
                        margin-top: 12px;
                        display: grid;
                        grid-template-columns: repeat(
                            auto-fit,
                            minmax(196px, 1fr)
                        );
                        gap: 8px;
                    "
                >
                    <input
                        ref="linkField"
                        v-model="draft.contact_link_url"
                        class="mk-input"
                        inputmode="url"
                        autocomplete="url"
                        :placeholder="t('people.linkUrl')"
                    />
                    <input
                        v-model="draft.contact_link_label"
                        class="mk-input"
                        :placeholder="t('people.linkLabel')"
                    />
                </div>

                <div
                    style="
                        margin-top: 12px;
                        display: flex;
                        align-items: center;
                        gap: 16px;
                        flex-wrap: wrap;
                    "
                >
                    <div style="display: flex; align-items: center; gap: 6px">
                        <span class="mk-k">{{ t('person.editType') }}</span>
                        <button
                            v-for="value in options.types"
                            :key="value"
                            type="button"
                            class="mk-pick"
                            :class="{ 'mk-on': draft.type === value }"
                            @click="draft.type = value"
                        >
                            {{ t(`crm.type.${value}`) }}
                        </button>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px">
                        <span class="mk-k">{{ t('person.editStatus') }}</span>
                        <button
                            v-for="value in options.statuses"
                            :key="value"
                            type="button"
                            class="mk-pick"
                            :class="{ 'mk-on': draft.status === value }"
                            @click="draft.status = value"
                        >
                            {{ t(`crm.status.${value}`) }}
                        </button>
                    </div>
                    <button
                        type="submit"
                        class="mk-btn mk-act"
                        style="margin-left: auto"
                        :disabled="!named || draft.processing"
                    >
                        {{ t('people.add') }}
                    </button>
                </div>

                <!-- What the server refused, in red. The one thing this form
                     refuses on its own — a record naming nobody — is not an
                     error until somebody tries to save one, and an untouched
                     form that opens red is a form that shouts first. -->
                <p
                    v-if="Object.keys(draft.errors).length"
                    style="
                        margin: 10px 0 0;
                        font-size: 11.5px;
                        line-height: 1.5;
                        color: var(--mk-critical);
                    "
                >
                    {{ Object.values(draft.errors).join(' · ') }}
                </p>
                <p
                    v-else-if="!named"
                    class="mk-t3"
                    style="
                        margin: 10px 0 0;
                        font-size: 11.5px;
                        line-height: 1.5;
                    "
                >
                    {{ t('people.addNothing') }}
                </p>
            </form>

            <Rule :label="t('people.happening')" :note="t('people.sortNote')" />

            <div v-if="rows.length" style="flex: 1; min-height: 0">
                <!-- The row opens the dossier; the button is the one action
                     that is not "read more about them". A row that is itself a
                     link cannot contain another one, so the click is handled
                     rather than nested. -->
                <div
                    v-for="row in rows"
                    :key="row.id"
                    class="mk-hair"
                    style="
                        display: flex;
                        align-items: center;
                        gap: 18px;
                        padding: 13px 4px 13px 0;
                        cursor: pointer;
                    "
                    @click="open(row)"
                >
                    <span
                        class="mk-dot"
                        :style="{ background: toneColor(row.signal.tone) }"
                    />
                    <div style="width: 190px; flex: 0 0 190px; min-width: 0">
                        <div
                            class="mk-clip"
                            style="font-size: 13.5px; font-weight: 600"
                        >
                            {{ row.name }}
                        </div>
                        <div
                            class="mk-m mk-t3 mk-clip"
                            style="margin-top: 2px; font-size: 11px"
                        >
                            {{ row.handle ?? t(`crm.type.${row.type}`) }}
                        </div>
                    </div>
                    <div style="flex: 1; min-width: 0">
                        <div
                            class="mk-clip"
                            style="font-size: 13px; color: var(--mk-body)"
                        >
                            {{ t(`people.next.${row.next.kind}`) }}
                            <template v-if="row.next.task">
                                · {{ row.next.task.title }}</template
                            >
                        </div>
                        <div
                            class="mk-t3"
                            style="margin-top: 2px; font-size: 11.5px"
                        >
                            <template v-if="row.next.task">
                                {{
                                    row.next.task.due_at
                                        ? dateTime(row.next.task.due_at, tag)
                                        : t('people.noDate')
                                }}
                                ·
                                {{
                                    row.next.task.assignee ??
                                    t('people.noOwner')
                                }}
                            </template>
                            <template v-else-if="row.next.last_at">
                                {{
                                    t(
                                        row.next.direction === 'in'
                                            ? 'people.lastIn'
                                            : 'people.lastOut',
                                    )
                                }}
                                · {{ ago(row.next.last_at) }}
                            </template>
                            <template v-else
                                >{{ signalText(row.signal) }} ·
                                {{ ago(row.signal.at) }}</template
                            >
                            <!-- Reading by when somebody was written down: say
                                 the date being sorted on, or the order looks
                                 arbitrary against a column of signals. -->
                            <template v-if="sort === 'added' && row.added">
                                ·
                                {{
                                    t('people.addedAgo', {
                                        ago: ago(row.added) || '—',
                                    })
                                }}
                            </template>
                        </div>
                    </div>
                    <div class="mk-wide" style="width: 132px; flex: 0 0 132px">
                        <Spark :values="row.spark" :tone="row.signal.tone" />
                    </div>
                    <div class="lead-trade" @click.stop>
                        <div class="lead-trade__amount">
                            <span>$</span>
                            <input
                                v-model="tradeAmounts[row.id]"
                                type="number"
                                min="0"
                                step="0.01"
                                inputmode="decimal"
                                :aria-label="t('people.tradeAmount')"
                                placeholder="0"
                            />
                        </div>
                        <button
                            type="button"
                            class="lead-trade__button lead-trade__button--bought"
                            :class="{
                                'lead-trade__button--active':
                                    row.status === 'customer' &&
                                    row.bought_usd !== null,
                            }"
                            :disabled="
                                savingTrade !== null ||
                                Number(tradeAmounts[row.id]) <= 0
                            "
                            @click="recordTrade(row, 'bought')"
                        >
                            {{ t('people.bought') }}
                        </button>
                        <button
                            type="button"
                            class="lead-trade__button lead-trade__button--sold"
                            :class="{
                                'lead-trade__button--active':
                                    row.status === 'sold' &&
                                    row.sold_usd !== null,
                            }"
                            :disabled="
                                savingTrade !== null ||
                                Number(tradeAmounts[row.id]) <= 0
                            "
                            @click="recordTrade(row, 'sold')"
                        >
                            {{ t('people.sold') }}
                        </button>
                    </div>
                    <Link
                        class="mk-btn"
                        :href="
                            row.next.task &&
                            ['overdue', 'planned'].includes(row.next.kind)
                                ? showTask.url(row.next.task.id)
                                : showPerson.url(row.id, {
                                      query: { pane: 'thread' },
                                  }) + '#conversation'
                        "
                        @click.stop
                        >{{
                            t(
                                row.next.task &&
                                    ['overdue', 'planned'].includes(
                                        row.next.kind,
                                    )
                                    ? 'people.doTask'
                                    : 'people.workLead',
                            )
                        }}</Link
                    >
                </div>
            </div>
            <p v-else class="mk-t3" style="font-size: 13px">
                {{ t('people.empty') }}
            </p>

            <div style="display: flex; align-items: center; gap: 12px">
                <span class="mk-m mk-t3" style="font-size: 11px">
                    {{ t('people.shown', { shown, total }) }} ·
                    {{ t('people.rest') }}
                </span>
                <button
                    v-if="more"
                    type="button"
                    class="mk-btn mk-ghost"
                    style="margin-left: auto"
                    @click="more40"
                >
                    {{ t('people.more') }}
                </button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.lead-trade {
    display: grid;
    grid-template-columns: 72px 54px 58px;
    gap: 4px;
    flex: 0 0 192px;
}

.lead-trade__amount {
    display: flex;
    align-items: center;
    height: 28px;
    padding: 0 6px;
    border: 1px solid rgba(232, 236, 236, 0.16);
    color: var(--mk-dim);
    background: rgba(232, 236, 236, 0.035);
    font-family: var(--mk-mono);
    font-size: 11px;
}

.lead-trade__amount:focus-within {
    border-color: color-mix(in srgb, var(--mk-accent) 55%, transparent);
}

.lead-trade__amount input {
    width: 100%;
    min-width: 0;
    border: 0;
    outline: 0;
    color: var(--mk-body);
    background: transparent;
    font: inherit;
}

.lead-trade__amount input::-webkit-inner-spin-button {
    appearance: none;
}

.lead-trade__button {
    height: 28px;
    padding: 0 7px;
    border: 1px solid currentColor;
    background: transparent;
    font-family: var(--mk-mono);
    font-size: 10px;
    font-weight: 700;
    cursor: pointer;
}

.lead-trade__button--bought {
    color: var(--mk-ok);
}

.lead-trade__button--sold {
    color: var(--mk-critical);
}

.lead-trade__button:hover:not(:disabled),
.lead-trade__button:focus-visible,
.lead-trade__button--active {
    background: rgba(232, 236, 236, 0.08);
    outline: none;
}

.lead-trade__button:disabled {
    cursor: default;
    opacity: 0.34;
}
</style>
