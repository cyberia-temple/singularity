<script setup lang="ts">
import { Head, Link, router } from '@inertiajs/vue3';
import { ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { dateTime, num } from '@/lib/console';
import { consoleMessages } from '@/lib/consoleMessages';
import { length } from '@/lib/replay';

type Row = {
    id: string;
    site: string;
    device: string;
    browser: string | null;
    os: string | null;
    entry_path: string;
    last_path: string;
    pages: number;
    clicks: number;
    rage_clicks: number;
    dead_clicks: number;
    errors: number;
    duration_ms: number;
    installation: string | null;
    installation_known: boolean;
    user_id: number | null;
    updated_at: string | null;
};

type Filters = {
    site?: string;
    device?: string;
    flag?: string;
    path?: string;
};

const props = defineProps<{
    filters: Filters;
    tiles: {
        sessions: number;
        median_ms: number | null;
        rage: number | null;
        dead: number | null;
        errors: number | null;
    };
    sites: { site: string; sessions: number }[];
    problems: {
        site: string;
        path: string;
        clicks: number;
        rage: number;
        dead: number;
        sessions: number;
    }[];
    faults: {
        site: string;
        message: string;
        times: number;
        sessions: number;
        example: string;
        last_at: string;
    }[];
    sessions: {
        data: Row[];
        prev_page_url: string | null;
        next_page_url: string | null;
    };
}>();

const { t, tag } = useLocale(consoleMessages);
const path = ref(props.filters.path ?? '');

const share = (value: number | null): string =>
    value === null ? '—' : `${Math.round(value * 100)}%`;

function filter(change: Filters): void {
    const next = { ...props.filters, ...change };
    const query = Object.fromEntries(
        Object.entries(next).filter(([, value]) => value),
    );

    router.get('/crm/replays', query, {
        preserveState: true,
        preserveScroll: true,
    });
}

const heatmapHref = (site: string, page: string): string =>
    `/crm/replays/heatmap?${new URLSearchParams({ site, path: page })}`;
</script>

<template>
    <Head title="Пульт · Записи" />

    <div
        style="display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap"
    >
        <h1 class="mk-h1">{{ t('replays.title') }}</h1>
        <span class="mk-m mk-t3" style="font-size: 12px">
            {{ t('replays.subtitle') }}
        </span>
        <Link
            class="mk-btn"
            href="/crm/replays/heatmap"
            style="margin-left: auto"
        >
            {{ t('replays.heatmap') }}
        </Link>
    </div>

    <div class="mk-tile-row" style="margin-top: 18px">
        <div class="mk-tile">
            <div class="mk-k">{{ t('replays.sessions') }}</div>
            <div class="mk-num" style="margin-top: 8px; font-size: 25px">
                {{ num(props.tiles.sessions) }}
            </div>
        </div>
        <div class="mk-tile">
            <div class="mk-k">{{ t('replays.median') }}</div>
            <div class="mk-num" style="margin-top: 8px; font-size: 25px">
                {{
                    props.tiles.median_ms === null
                        ? '—'
                        : length(props.tiles.median_ms)
                }}
            </div>
        </div>
        <div class="mk-tile">
            <div class="mk-k">{{ t('replays.withRage') }}</div>
            <div class="mk-num" style="margin-top: 8px; font-size: 25px">
                {{ share(props.tiles.rage) }}
            </div>
        </div>
        <div class="mk-tile">
            <div class="mk-k">{{ t('replays.withDead') }}</div>
            <div class="mk-num" style="margin-top: 8px; font-size: 25px">
                {{ share(props.tiles.dead) }}
            </div>
        </div>
        <div class="mk-tile">
            <div class="mk-k">{{ t('replays.withErrors') }}</div>
            <div class="mk-num" style="margin-top: 8px; font-size: 25px">
                {{ share(props.tiles.errors) }}
            </div>
        </div>
    </div>

    <!--
      The places that hurt come before the list. Nobody finds what is broken by
      watching recordings in date order; they find it by going where people
      clicked in anger, or clicked on something that did nothing.
    -->
    <h2 class="mk-k" style="margin-top: 26px">
        {{ t('replays.hurts') }}
        <span
            class="mk-m mk-t3"
            style="text-transform: none; letter-spacing: 0"
        >
            · {{ t('replays.hurts.hint') }}
        </span>
    </h2>
    <div
        class="mk-panel mk-scroll-x"
        style="margin-top: 10px; padding: 12px 16px"
    >
        <table class="mk-table" style="min-width: 720px">
            <thead>
                <tr>
                    <th style="padding-left: 0">{{ t('replays.col.page') }}</th>
                    <th style="text-align: right">
                        {{ t('replays.col.rage') }}
                    </th>
                    <th style="text-align: right">
                        {{ t('replays.col.dead') }}
                    </th>
                    <th style="text-align: right">
                        {{ t('replays.col.clicks') }}
                    </th>
                    <th style="text-align: right">{{ t('replays.list') }}</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <tr v-if="props.problems.length === 0">
                    <td colspan="6" class="mk-t3" style="padding-left: 0">
                        {{ t('replays.empty.hurts') }}
                    </td>
                </tr>
                <tr
                    v-for="row in props.problems"
                    :key="`${row.site}${row.path}`"
                >
                    <td class="mk-m" style="padding-left: 0">
                        <span class="mk-t3">{{ row.site }}</span
                        >{{ row.path }}
                    </td>
                    <td
                        class="mk-num"
                        style="text-align: right"
                        :style="{
                            color: row.rage ? 'var(--mk-warning)' : undefined,
                        }"
                    >
                        {{ num(row.rage) }}
                    </td>
                    <td class="mk-num" style="text-align: right">
                        {{ num(row.dead) }}
                    </td>
                    <td class="mk-num" style="text-align: right">
                        {{ num(row.clicks) }}
                    </td>
                    <td class="mk-num" style="text-align: right">
                        {{ num(row.sessions) }}
                    </td>
                    <td style="text-align: right; white-space: nowrap">
                        <Link
                            class="mk-link"
                            :href="heatmapHref(row.site, row.path)"
                        >
                            {{ t('replays.heatmap') }}
                        </Link>
                        ·
                        <button
                            type="button"
                            class="mk-link"
                            style="
                                background: none;
                                border: 0;
                                padding: 0;
                                cursor: pointer;
                                font: inherit;
                            "
                            @click="
                                filter({
                                    site: row.site,
                                    path: row.path,
                                    flag: row.rage ? 'rage' : 'dead',
                                })
                            "
                        >
                            {{ t('replays.list') }}
                        </button>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>

    <h2 class="mk-k" style="margin-top: 26px">{{ t('replays.faults') }}</h2>
    <div
        class="mk-panel mk-scroll-x"
        style="margin-top: 10px; padding: 12px 16px"
    >
        <table class="mk-table" style="min-width: 720px">
            <thead>
                <tr>
                    <th style="padding-left: 0">
                        {{ t('replays.col.message') }}
                    </th>
                    <th>{{ t('replays.col.site') }}</th>
                    <th style="text-align: right">{{ t('replays.list') }}</th>
                    <th style="text-align: right">
                        {{ t('replays.col.times') }}
                    </th>
                    <th style="text-align: right">
                        {{ t('replays.col.when') }}
                    </th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <tr v-if="props.faults.length === 0">
                    <td colspan="6" class="mk-t3" style="padding-left: 0">
                        {{ t('replays.empty.faults') }}
                    </td>
                </tr>
                <tr
                    v-for="row in props.faults"
                    :key="`${row.site}${row.message}`"
                >
                    <td
                        class="mk-m"
                        style="padding-left: 0; color: var(--mk-critical)"
                    >
                        {{ row.message }}
                    </td>
                    <td class="mk-m mk-t3">{{ row.site }}</td>
                    <td class="mk-num" style="text-align: right">
                        {{ num(row.sessions) }}
                    </td>
                    <td class="mk-num" style="text-align: right">
                        {{ num(row.times) }}
                    </td>
                    <td
                        class="mk-m"
                        style="text-align: right; white-space: nowrap"
                    >
                        {{ dateTime(row.last_at, tag) }}
                    </td>
                    <td style="text-align: right">
                        <Link
                            class="mk-link"
                            :href="`/crm/replays/${row.example}`"
                        >
                            {{ t('replays.example') }}
                        </Link>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>

    <h2 class="mk-k" style="margin-top: 26px">{{ t('replays.list') }}</h2>
    <div
        style="
            margin-top: 10px;
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            align-items: center;
        "
    >
        <button
            type="button"
            class="mk-pick"
            :class="{ 'mk-on': !props.filters.site }"
            @click="filter({ site: undefined })"
        >
            {{ t('replays.all') }}
        </button>
        <button
            v-for="row in props.sites"
            :key="row.site"
            type="button"
            class="mk-pick"
            :class="{ 'mk-on': props.filters.site === row.site }"
            @click="filter({ site: row.site })"
        >
            {{ row.site }} · {{ num(row.sessions) }}
        </button>
        <span style="width: 12px"></span>
        <button
            v-for="device in ['phone', 'tablet', 'desktop']"
            :key="device"
            type="button"
            class="mk-pick"
            :class="{ 'mk-on': props.filters.device === device }"
            @click="
                filter({
                    device:
                        props.filters.device === device ? undefined : device,
                })
            "
        >
            {{ device }}
        </button>
        <span style="width: 12px"></span>
        <button
            v-for="flag in ['rage', 'dead', 'errors']"
            :key="flag"
            type="button"
            class="mk-pick"
            :class="{ 'mk-on': props.filters.flag === flag }"
            @click="
                filter({ flag: props.filters.flag === flag ? undefined : flag })
            "
        >
            {{ t(`replays.flag.${flag}`) }}
        </button>
        <input
            v-model="path"
            class="mk-input"
            style="margin-left: auto; min-width: 220px"
            :placeholder="t('replays.path')"
            @keydown.enter="filter({ path: path.trim() || undefined })"
        />
    </div>

    <div
        class="mk-panel mk-scroll-x"
        style="margin-top: 10px; padding: 12px 16px"
    >
        <table class="mk-table" style="min-width: 1100px">
            <thead>
                <tr>
                    <th style="padding-left: 0">{{ t('replays.col.when') }}</th>
                    <th>{{ t('replays.col.path') }}</th>
                    <th>{{ t('replays.col.device') }}</th>
                    <th style="text-align: right">
                        {{ t('replays.col.length') }}
                    </th>
                    <th style="text-align: right">
                        {{ t('replays.col.clicks') }}
                    </th>
                    <th style="text-align: right">
                        {{ t('replays.col.rage') }}
                    </th>
                    <th style="text-align: right">
                        {{ t('replays.col.dead') }}
                    </th>
                    <th style="text-align: right">
                        {{ t('replays.col.errors') }}
                    </th>
                    <th>{{ t('replays.col.who') }}</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                <tr v-if="props.sessions.data.length === 0">
                    <td colspan="10" class="mk-t3" style="padding-left: 0">
                        {{ t('replays.empty') }}
                    </td>
                </tr>
                <tr v-for="row in props.sessions.data" :key="row.id">
                    <td
                        class="mk-m"
                        style="padding-left: 0; white-space: nowrap"
                    >
                        {{ dateTime(row.updated_at, tag) }}
                    </td>
                    <td class="mk-m" style="max-width: 360px">
                        <div class="mk-clip">
                            <span class="mk-t3">{{ row.site }}</span
                            >{{ row.entry_path }}
                            <template v-if="row.last_path !== row.entry_path">
                                → {{ row.last_path }}
                            </template>
                        </div>
                        <div class="mk-t3" style="font-size: 11px">
                            {{ num(row.pages) }}
                            {{ t('replays.pages').toLowerCase() }}
                        </div>
                    </td>
                    <td class="mk-m mk-t3" style="white-space: nowrap">
                        {{ row.device }} · {{ row.browser ?? '?' }} ·
                        {{ row.os ?? '?' }}
                    </td>
                    <td class="mk-num" style="text-align: right">
                        {{ length(row.duration_ms) }}
                    </td>
                    <td class="mk-num" style="text-align: right">
                        {{ num(row.clicks) }}
                    </td>
                    <td
                        class="mk-num"
                        style="text-align: right"
                        :style="{
                            color: row.rage_clicks
                                ? 'var(--mk-warning)'
                                : undefined,
                        }"
                    >
                        {{ num(row.rage_clicks) }}
                    </td>
                    <td class="mk-num" style="text-align: right">
                        {{ num(row.dead_clicks) }}
                    </td>
                    <td
                        class="mk-num"
                        style="text-align: right"
                        :style="{
                            color: row.errors
                                ? 'var(--mk-critical)'
                                : undefined,
                        }"
                    >
                        {{ num(row.errors) }}
                    </td>
                    <td class="mk-m" style="white-space: nowrap">
                        <Link
                            v-if="row.installation_known"
                            class="mk-link"
                            :href="`/crm/installs/${row.installation}`"
                        >
                            {{ t('replays.install') }}
                        </Link>
                        <span v-else-if="row.user_id" class="mk-t3"
                            >#{{ row.user_id }}</span
                        >
                        <span v-else class="mk-t3">{{
                            t('replays.anonymous')
                        }}</span>
                    </td>
                    <td style="text-align: right">
                        <Link class="mk-btn" :href="`/crm/replays/${row.id}`">
                            ▶ {{ t('replays.watch') }}
                        </Link>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>

    <div
        style="
            margin-top: 12px;
            display: flex;
            gap: 8px;
            justify-content: flex-end;
        "
    >
        <Link
            v-if="props.sessions.prev_page_url"
            class="mk-btn"
            :href="props.sessions.prev_page_url"
            preserve-scroll
        >
            ← {{ t('replays.newer') }}
        </Link>
        <Link
            v-if="props.sessions.next_page_url"
            class="mk-btn"
            :href="props.sessions.next_page_url"
            preserve-scroll
        >
            {{ t('replays.older') }} →
        </Link>
    </div>
</template>
