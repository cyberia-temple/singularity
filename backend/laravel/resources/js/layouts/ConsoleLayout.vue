<script setup lang="ts">
import { Link, useHttp, usePage } from '@inertiajs/vue3';
import { computed, ref } from 'vue';
import StrategyWorkspace from '@/components/console/StrategyWorkspace.vue';
import { useConsolePulse } from '@/composables/useConsolePulse';
import { useLocale } from '@/composables/useLocale';
import {
    age,
    grouped,
    num,
    plural,
    toneColor,
    usd,
} from '@/lib/console';
import { consoleMessages } from '@/lib/consoleMessages';
import crm from '@/routes/crm';
import profile from '@/routes/crm/profile';

/**
 * "Пульт" — the shell every lens is drawn inside.
 *
 * A control room rather than a page: it owns the viewport, keeps the alarm
 * strip and the rail fixed, and scrolls only the lens. The header is shared
 * because the console has one state — the banner, the group counters and the
 * rail's badge are three renderings of one cached queue, and a header
 * assembled per page would be five headers that disagree by a sweep.
 *
 * On a phone the counters go away and the alarm stays: the only reason this
 * is open on a phone is that something is on fire.
 */
type Group = {
    group: string;
    total: number;
    healthy: number;
    tone: string;
    counts: Record<string, number>;
};

type Banner = {
    severity: string;
    title: string;
    params: Record<string, string | number>;
    duration_seconds: number | null;
};

type Console = {
    groups: Group[];
    background: {
        funded_active: number;
        installs_30d: number;
        bridge_30d_usd: number;
    };
    sweep: { at: string | null };
    banner: Banner | null;
    counts: { attention: number; tasks: number; chat: number };
};

const page = usePage();
type Operator = { display_name: string; avatar: string | null; theme: string };
const operatorProfile = computed(
    () => page.props.crmOperator as Operator | null,
);
const theme = ref(operatorProfile.value?.theme ?? 'cyberia');
const themeForm = useHttp<{ theme: string }, { theme: string }>({
    theme: theme.value,
});
async function toggleTheme() {
    const previous = theme.value;
    theme.value = theme.value === 'cyberia' ? 'yotsuba' : 'cyberia';
    themeForm.theme = theme.value;

    try {
        await themeForm.submit(profile.theme());
    } catch {
        theme.value = previous;
    }
}
const { locale, t, toggleLocale, nextTag } = useLocale(consoleMessages);

/*
 * The console's heartbeat, held by the shell rather than by a lens.
 *
 * The shell outlives every page inside it, so the timer survives navigation
 * and five lenses never become five pollers. Its badges are the ones that
 * must be right on a screen nobody is navigating: the rail is what an
 * operator glances at while doing something else.
 */
const pulse = useConsolePulse();

const console_ = computed(() => page.props.console as Console | null);
const current = computed(() => page.url.split('?')[0]);

const LENSES = [
    {
        key: 'now',
        href: '/crm',
        label: 'nav.now',
        badge: 'attention',
        phone: true,
    },
    {
        key: 'people',
        href: '/crm/people',
        label: 'nav.people',
        badge: null,
        phone: true,
    },
    {
        key: 'tasks',
        href: '/crm/tasks',
        label: 'nav.tasks',
        badge: 'tasks',
        phone: true,
    },
    // The room sits with the work (queue, people, tasks) rather than with
    // the state (numbers, machines): it is where the work gets decided.
    {
        key: 'chat',
        href: '/crm/chat',
        label: 'nav.chat',
        badge: 'chat',
        phone: true,
    },
    // Not on the phone. At three in the morning people answer each other;
    // nobody reads retention cohorts, so the room takes this slot there.
    {
        key: 'numbers',
        href: '/crm/numbers',
        label: 'nav.numbers',
        badge: null,
        phone: false,
    },
    {
        key: 'machines',
        href: '/crm/machines',
        label: 'nav.machines',
        badge: null,
        phone: true,
    },
    {
        key: 'keys',
        href: '/crm/api-keys',
        label: 'nav.keys',
        badge: null,
        phone: false,
    },
    // Saying something to somebody. A desk lens: writing to everyone at once
    // is not a thing to do one-handed on a phone.
    {
        key: 'push',
        href: '/crm/push',
        label: 'nav.push',
        badge: null,
        phone: false,
    },
    // Why, after the numbers said what: recordings, heat maps, rage and dead
    // clicks. A desk lens — nobody watches a replay on a phone.
    {
        key: 'replays',
        href: '/crm/replays',
        label: 'nav.replays',
        badge: null,
        phone: false,
    },
    // Traffic, sources, funnels, retention: the page counter's dashboard on
    // this host. A door out of the console rather than a lens of it.
    {
        key: 'stats',
        href: crm.stats().url,
        label: 'nav.stats',
        badge: null,
        phone: false,
    },
    {
        key: 'strategy',
        href: '/crm/strategy',
        label: 'nav.strategy',
        badge: null,
        phone: false,
    },
    // The design the console was built from. A desk lens: nobody opens a
    // mockup on a phone at three in the morning, and the phone bar is for
    // what is on fire.
    {
        key: 'mockup',
        href: '/crm/mockup',
        label: 'nav.mockup',
        badge: null,
        phone: false,
    },
] as const;

const PHONE_LENSES = LENSES.filter((lens) => lens.phone);

/**
 * Which lens is lit. `/crm/{id}` is a person's dossier and `/crm/installs/…`
 * came from the numbers, so both light the lens they belong to rather than
 * lighting nothing.
 */
function active(key: string): boolean {
    const url = current.value;

    if (key === 'now') {
        return url === '/crm';
    }

    if (key === 'people') {
        return url.startsWith('/crm/people') || /^\/crm\/\d+$/.test(url);
    }

    if (key === 'numbers') {
        return (
            url.startsWith('/crm/numbers') || url.startsWith('/crm/installs')
        );
    }

    if (key === 'keys') {
        return url.startsWith('/crm/api-keys');
    }

    return url.startsWith(`/crm/${key}`);
}

/**
 * What a badge says right now.
 *
 * The heartbeat wins over the rendered page: the props were true when this
 * lens was last read, and a rail that still shows the count from four
 * minutes ago is the reason somebody presses F5. A count the heartbeat has
 * not answered yet falls back to the page's own.
 */
function badgeCount(badge: string | null): number {
    if (!badge || !console_.value) {
        return 0;
    }

    const key = badge as 'attention' | 'tasks' | 'chat';

    return pulse.counts.value[key] ?? console_.value.counts[key];
}

const bannerAge = computed(() => age(console_.value?.banner?.duration_seconds));
const bannerUnit = computed(() =>
    bannerAge.value
        ? plural(locale.value, bannerAge.value.count, t(bannerAge.value.unit))
        : '',
);
const bannerColor = computed(() =>
    toneColor(console_.value?.banner?.severity ?? 'calm'),
);

const operator = computed(
    () =>
        operatorProfile.value?.display_name ??
        (page.props.auth as { user?: { name?: string } } | undefined)?.user
            ?.name ??
        '—',
);

const initials = computed(() =>
    operator.value
        .split(/\s+/)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join(''),
);
</script>

<template>
    <div class="mostik" :data-console-theme="theme">
        <header class="mk-top">
            <!-- The alarm. Quiet is a state with its own look, not an absence
                 of the banner: an empty strip is indistinguishable from a
                 strip that failed to render. -->
            <div
                class="mk-banner"
                :style="
                    console_?.banner
                        ? {
                              background: `color-mix(in srgb, ${bannerColor} 10%, transparent)`,
                              borderLeftColor: bannerColor,
                          }
                        : { borderLeftColor: 'rgba(141,154,157,.4)' }
                "
            >
                <span
                    class="mk-dot"
                    :style="{
                        background: console_?.banner
                            ? bannerColor
                            : 'var(--mk-calm)',
                    }"
                />
                <template v-if="console_?.banner">
                    <span
                        v-if="bannerAge"
                        class="mk-m"
                        :style="{
                            fontSize: '13px',
                            fontWeight: 600,
                            color: bannerColor,
                        }"
                    >
                        {{ bannerAge.value }} {{ bannerUnit.toUpperCase() }}
                    </span>
                    <span
                        style="
                            font-size: 12px;
                            font-weight: 700;
                            letter-spacing: 0.06em;
                            text-transform: uppercase;
                        "
                        :style="{ color: bannerColor }"
                    >
                        {{
                            t(
                                console_.banner.title,
                                grouped(console_.banner.params),
                            )
                        }}
                    </span>
                </template>
                <span
                    v-else
                    class="mk-t2"
                    style="
                        font-size: 12px;
                        font-weight: 700;
                        letter-spacing: 0.06em;
                        text-transform: uppercase;
                    "
                >
                    {{ t('top.allGood') }}
                </span>
            </div>

            <div
                v-for="group in console_?.groups ?? []"
                :key="group.group"
                class="mk-top-cell"
            >
                <span class="mk-k">{{ t(`group.${group.group}`) }}</span>
                <span
                    class="mk-m"
                    style="font-size: 12px; font-weight: 600"
                    :style="{ color: toneColor(group.tone) }"
                >
                    {{ group.healthy }}/{{ group.total }}
                </span>
            </div>

            <div style="flex: 1" />

            <div class="mk-top-cell">
                <span class="mk-k">{{ t('top.fundedActive') }}</span>
                <span class="mk-m" style="font-size: 12px; font-weight: 600">{{
                    num(console_?.background.funded_active ?? null)
                }}</span>
            </div>
            <div class="mk-top-cell">
                <span class="mk-k">{{ t('top.installs') }}</span>
                <span class="mk-m" style="font-size: 12px; font-weight: 600">{{
                    num(console_?.background.installs_30d ?? null)
                }}</span>
            </div>
            <div class="mk-top-cell">
                <span class="mk-k">{{ t('top.bridge') }}</span>
                <span class="mk-m" style="font-size: 12px; font-weight: 600">{{
                    usd(console_?.background.bridge_30d_usd ?? null)
                }}</span>
            </div>
            <div class="mk-account-controls">
                <!-- A console that quietly stopped updating looks exactly
                     like a quiet night, so it says which one it is. -->
                <span
                    v-if="pulse.stale.value"
                    class="mk-m"
                    style="font-size: 11px"
                    :style="{ color: toneColor('warning') }"
                >
                    {{ t('top.stale') }}
                </span>
                <button
                    type="button"
                    class="mk-theme-toggle"
                    :class="{ 'mk-on': theme === 'cyberia' }"
                    :aria-pressed="theme === 'cyberia'"
                    :disabled="themeForm.processing"
                    :title="t('profile.theme')"
                    @click="toggleTheme"
                >
                    <svg
                        width="19"
                        height="19"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                    >
                        <path
                            d="M20.8 13.1A9 9 0 0 1 10.9 3.2 9 9 0 1 0 20.8 13.1Z"
                        />
                    </svg>
                </button>
                <Link
                    :href="profile.show()"
                    class="mk-profile-link"
                    :title="operator"
                    ><img
                        v-if="operatorProfile?.avatar"
                        :src="operatorProfile.avatar"
                        alt=""
                    /><span v-else>{{ initials }}</span></Link
                >
            </div>
        </header>

        <div class="mk-body">
            <nav class="mk-rail">
                <div
                    style="
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        height: 34px;
                        margin-bottom: 14px;
                    "
                >
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="var(--mk-accent)"
                        stroke-width="1.7"
                        stroke-linecap="round"
                    >
                        <path d="M12 3v18M3 12h18" />
                        <circle cx="12" cy="12" r="4.5" />
                    </svg>
                </div>

                <Link
                    v-for="lens in LENSES"
                    :key="lens.key"
                    :href="lens.href"
                    class="mk-rail-item"
                    :class="{ 'mk-on': active(lens.key) }"
                >
                    <svg
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                    >
                        <path
                            v-if="lens.key === 'now'"
                            d="M2.5 12h4l3-7.5 4.5 15 3-7.5h5.5"
                        />
                        <template v-else-if="lens.key === 'people'">
                            <circle cx="9" cy="8" r="3.2" />
                            <path d="M3 19.5a6 6 0 0 1 12 0" />
                            <circle cx="17" cy="8.5" r="2.6" />
                            <path d="M16.5 14.2a5.4 5.4 0 0 1 4.6 5" />
                        </template>
                        <template v-else-if="lens.key === 'tasks'">
                            <rect
                                x="3.5"
                                y="4.5"
                                width="16"
                                height="16"
                                rx="2"
                            />
                            <path d="M8 12.2l2.6 2.6L16 9.5" />
                        </template>
                        <path
                            v-else-if="lens.key === 'numbers'"
                            d="M5 19.5V12M10.5 19.5V5M16 19.5v-5.5M21 19.5V9"
                        />
                        <template v-else-if="lens.key === 'machines'">
                            <rect
                                x="3.5"
                                y="4.5"
                                width="17"
                                height="6"
                                rx="1.5"
                            />
                            <rect
                                x="3.5"
                                y="13.5"
                                width="17"
                                height="6"
                                rx="1.5"
                            />
                            <path d="M7 7.5h.01M7 16.5h.01" />
                        </template>
                        <template v-else-if="lens.key === 'chat'">
                            <path d="M3.5 4.5h17v11h-9.8L6 19.5V15.5H3.5z" />
                            <path d="M7.5 8.5h9M7.5 11.5h5.5" />
                        </template>
                        <template v-else-if="lens.key === 'keys'">
                            <circle cx="8" cy="12" r="3.5" />
                            <path d="M11.5 12H21M17 12v3M20 12v2" />
                        </template>
                        <template v-else-if="lens.key === 'stats'">
                            <path d="M11 3.6a8.4 8.4 0 1 0 9.4 9.4H11z" />
                            <path d="M14 3.5a7 7 0 0 1 6.5 6.5H14z" />
                        </template>
                        <template v-else-if="lens.key === 'strategy'">
                            <path d="M5 3.5h11l3 3v14H5z" />
                            <path d="M8.5 9h7M8.5 12.5h7M8.5 16h4.5" />
                            <path d="M16 3.5v3h3" />
                        </template>
                        <template v-else>
                            <rect
                                x="3.5"
                                y="4.5"
                                width="17"
                                height="15"
                                rx="1.5"
                            />
                            <path d="M3.5 9h17M9 9v10.5" />
                        </template>
                    </svg>
                    <span>{{ t(lens.label) }}</span>
                    <span
                        v-if="badgeCount(lens.badge) > 0"
                        class="mk-badge"
                        :style="
                            lens.badge === 'tasks'
                                ? { background: 'var(--mk-warning)' }
                                : {}
                        "
                    >
                        {{ badgeCount(lens.badge) }}
                    </span>
                </Link>

                <div
                    style="
                        margin-top: auto;
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        gap: 10px;
                        padding-top: 12px;
                    "
                >
                    <button
                        type="button"
                        class="mk-m mk-t3"
                        style="
                            font-size: 10px;
                            background: none;
                            border: 0;
                            cursor: pointer;
                        "
                        @click="toggleLocale"
                    >
                        {{ nextTag }}
                    </button>
                    <div
                        :title="operator"
                        style="
                            width: 26px;
                            height: 26px;
                            border: 1px solid var(--mk-hair-strong);
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            font-size: 10px;
                            font-weight: 700;
                            color: var(--mk-dim);
                        "
                    >
                        {{ initials }}
                    </div>
                </div>
            </nav>

            <main class="mk-main">
                <slot />
            </main>
        </div>

        <!-- The phone. Five lenses fit; the dossiers are reached from them. -->
        <nav class="mk-bottom">
            <Link
                v-for="lens in PHONE_LENSES"
                :key="lens.key"
                :href="lens.href"
                class="mk-bottom-item"
                :class="{ 'mk-on': active(lens.key) }"
            >
                <span>{{ t(lens.label) }}</span>
                <span
                    v-if="badgeCount(lens.badge) > 0"
                    class="mk-m"
                    style="font-size: 10px"
                    >{{ badgeCount(lens.badge) }}</span
                >
            </Link>
        </nav>

        <!-- One persistent editor instance: docked on /strategy, teleported
             above every other lens while pinned. Navigation never destroys
             the iframe or an unsaved selection. -->
        <StrategyWorkspace />
    </div>
</template>

<style src="../../css/console.css"></style>
