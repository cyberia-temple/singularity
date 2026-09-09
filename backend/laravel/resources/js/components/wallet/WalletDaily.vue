<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { formatUnits, walletChain } from '@/lib/wallet/chains';
import {
    checkInToday,
    levelPct,
    loadDailyBoard,
    nextStreakBonus,
    questDestination,
    signInWithWallet,
    streakStrip,
    untilReset,
} from '@/lib/wallet/daily';
import type {
    DailyBoard,
    DailyQuest,
    QuestDestination,
} from '@/lib/wallet/daily';
import {
    SPONSORED_CHAIN,
    gasSponsorStatus,
    stationState,
} from '@/lib/wallet/gas';
import type { SponsorStatus } from '@/lib/wallet/gas';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Daily: what today pays.
 *
 * The screen exists because everything the wallet does already earns
 * experience on this project and none of it was visible from inside the wallet
 * — the ledger, the streak and the quest board lived on `/profile`, which is a
 * page a wallet user has no reason to open.
 *
 * Two identities meet here and the screen never blurs them. The **account** is
 * what experience belongs to: it is the person the site knows, and the board,
 * the streak and the quests are all its facts. The **address** is what the
 * wallet holds, and the faucet below is its fact — the gas station drips to an
 * address and asks nobody who they are. So a wallet with no session is not
 * shown an empty scoreboard: it is shown the catalogue, told plainly that
 * progress belongs to an account, and offered the one press that proves this
 * address is one — with its own key, which is the only credential it has.
 *
 * Nothing here is a second ledger. A swap made from this wallet pays the same
 * XP row the profile page reads, or it pays nothing.
 */

const props = defineProps<{ wallet: MultiWallet }>();

const emit = defineEmits<{
    back: [];
    /** Go do the thing a quest wants: a wallet screen or the swap overlay. */
    go: [destination: QuestDestination];
    gas: [];
}>();

const { locale, t } = useLocale(walletMessages);

const CHAIN = 'cyberia' as const;

const board = ref<DailyBoard | null>(null);
const loading = ref(true);
const failure = ref<string | null>(null);
const checking = ref(false);
const granted = ref<number | null>(null);
const signingIn = ref(false);
const station = ref<SponsorStatus | null>(null);

/** Ticks the reset countdown without re-reading the board. */
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | null = null;

const account = computed(
    () =>
        props.wallet.accounts.value.find(
            (candidate) => candidate.chain === CHAIN,
        ) ?? null,
);

const chain = computed(() => walletChain(SPONSORED_CHAIN));

const read = async (): Promise<void> => {
    loading.value = true;
    failure.value = null;

    try {
        board.value = await loadDailyBoard();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        loading.value = false;
    }
};

/**
 * The faucet's own state, asked with this address so the card can say whether
 * *this* wallet may claim rather than only that a station exists.
 */
const readStation = async (): Promise<void> => {
    station.value = await gasSponsorStatus(account.value?.address);
};

onMounted(() => {
    void read();
    void readStation();
    clock = setInterval(() => (now.value = Date.now()), 30_000);
});

onBeforeUnmount(() => {
    if (clock !== null) {
        clearInterval(clock);
    }
});

/* ------------------------------------------------------------ standing --- */

const standing = computed(() => board.value?.standing ?? null);

const levelTag = computed(() =>
    standing.value === null
        ? t('dailyNoLevel')
        : t('dailyLevelTag', { level: standing.value.level }),
);

const xpLabel = computed(() => {
    const value = standing.value;

    if (value === null) {
        return '—';
    }

    return value.nextLevelXp === null
        ? t('dailyXpMax', { xp: value.xp.toLocaleString(locale.value) })
        : t('dailyXpOf', {
              xp: value.xp.toLocaleString(locale.value),
              next: value.nextLevelXp.toLocaleString(locale.value),
          });
});

const barPct = computed(() =>
    standing.value === null ? 0 : levelPct(standing.value),
);

/** The next thing experience buys, and which of the two things is missing. */
const perkNote = computed(() => {
    const unlock = board.value?.nextUnlock ?? null;

    if (unlock === null) {
        return null;
    }

    const title = unlock.title[locale.value] ?? unlock.title.en;

    if (standing.value === null) {
        return t('dailyPerkAnon', {
            title,
            cost: unlock.cost.toLocaleString(locale.value),
        });
    }

    if (unlock.state === 'ready') {
        return t('dailyPerkReady', { title });
    }

    if (unlock.state === 'level') {
        return t('dailyPerkLevel', { title, level: unlock.level });
    }

    return t('dailyPerkXp', {
        title,
        left: Math.max(
            0,
            unlock.cost - standing.value.spendable,
        ).toLocaleString(locale.value),
    });
});

/* -------------------------------------------------------------- streak --- */

const strip = computed(() =>
    streakStrip(
        standing.value?.currentStreak ?? 0,
        standing.value?.activeToday ?? false,
        board.value?.streakBonuses ?? {},
    ),
);

const streakLabel = computed(() =>
    standing.value === null
        ? t('dailyStreakNone')
        : t('dailyStreakDays', { days: standing.value.currentStreak }),
);

const streakNote = computed(() => {
    if (standing.value === null) {
        return t('dailyStreakAnonNote');
    }

    const next = nextStreakBonus(
        standing.value.currentStreak,
        board.value?.streakBonuses ?? {},
    );

    return next === null
        ? t('dailyStreakNoMore')
        : t('dailyStreakNext', { day: next.day, xp: next.xp });
});

const checkedIn = computed(() => standing.value?.activeToday === true);

/** Only ever read by the button that exists for somebody who is signed in. */
const checkLabel = computed(() => {
    if (checking.value) {
        return t('dailyCheckingIn');
    }

    return checkedIn.value ? t('dailyCheckedIn') : t('dailyCheckIn');
});

const checkIn = async (): Promise<void> => {
    if (checking.value || checkedIn.value) {
        return;
    }

    checking.value = true;
    failure.value = null;

    try {
        const next = await checkInToday();
        board.value = next;
        granted.value = next.granted ?? 0;
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        checking.value = false;
    }
};

/**
 * Prove this address is an account, with the key already in this browser.
 *
 * The wallet signs the site's own login challenge — the same one the "connect
 * a wallet" button on the site signs — and the session that comes back is what
 * carries experience. It is the only moment the wallet tells this server whose
 * it is, so it happens on a press and under a sentence that says so.
 */
const signIn = async (): Promise<void> => {
    const address = account.value?.address;

    if (!address || signingIn.value) {
        return;
    }

    signingIn.value = true;
    failure.value = null;

    try {
        await signInWithWallet(address, (message) =>
            props.wallet.signMessage(CHAIN, message),
        );

        await read();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        signingIn.value = false;
    }
};

/* -------------------------------------------------------------- quests --- */

const resetIn = computed(() => {
    if (board.value === null) {
        return '—';
    }

    const { hours, minutes } = untilReset(board.value.resetsAt, now.value);

    return t('dailyResetIn', { hours, minutes });
});

/*
 * The two periods are two lists and never one.
 *
 * They reset on different clocks — one at UTC midnight, one at the turn of the
 * ISO week — so a single header counting down to the daily reset would be
 * telling half the rows a time that is not theirs.
 *
 * Within a list: unfinished first, then by what it pays. A board whose
 * completed rows sit at the top answers "what have I done"; the question here
 * is "what is left".
 */
const questsIn = (period: 'daily' | 'weekly'): DailyQuest[] =>
    (board.value?.quests ?? [])
        .filter((quest) => quest.period === period)
        .sort((a, b) => {
            if (a.completed !== b.completed) {
                return a.completed ? 1 : -1;
            }

            return b.xp - a.xp;
        });

/** The two lists with the header each one's own clock deserves. */
const questGroups = computed(() =>
    [
        {
            key: 'daily',
            header: `${t('dailyQuests')} · ${resetIn.value}`,
            rows: questsIn('daily'),
        },
        {
            key: 'weekly',
            header: t('dailyWeekly'),
            rows: questsIn('weekly'),
        },
    ].filter((group) => group.rows.length > 0),
);

const questTitle = (quest: DailyQuest): string =>
    quest.title[locale.value] ?? quest.title.en;

const questBody = (quest: DailyQuest): string =>
    quest.description[locale.value] ?? quest.description.en;

const questPct = (quest: DailyQuest): number => {
    if (quest.progress === null || quest.target <= 0) {
        return 0;
    }

    return Math.min(100, (quest.progress / quest.target) * 100);
};

/* -------------------------------------------------------------- faucet --- */

const faucetState = computed(() => stationState(station.value));

const drip = computed(() => {
    const amount = station.value?.drip;

    if (!amount) {
        return null;
    }

    try {
        return formatUnits(BigInt(amount), chain.value.decimals, 4);
    } catch {
        return null;
    }
});

/** Whole hours the station makes an address wait between drips. */
const cooldownHours = computed(() => {
    const seconds = station.value?.cooldown ?? null;

    return seconds === null ? null : Math.round(seconds / 3_600);
});
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <div
            style="
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: 12px;
                margin: 22px 0 6px;
            "
        >
            <h2 class="cw-title" style="margin: 0">{{ t('dailyTitle') }}</h2>
            <span
                style="
                    font: 500 10px/1 var(--cw-mono);
                    letter-spacing: 0.16em;
                    color: var(--cw-accent);
                    flex: none;
                "
                >{{ levelTag }}</span
            >
        </div>
        <div class="cw-label" style="color: var(--cw-dim)">
            {{ t('dailyEyebrow') }}
        </div>

        <p v-if="failure" class="cw-note cw-note-bad" style="margin-top: 16px">
            <span>{{ failure }}</span>
            <button type="button" class="cw-back" @click="read()">
                {{ t('retry') }}
            </button>
        </p>

        <p v-if="loading" class="cw-note" style="margin-top: 16px">
            <span>{{ t('dailyLoading') }}</span>
        </p>

        <template v-else-if="board">
            <!-- ---------------------------------------------- standing --- -->
            <div class="cw-card" style="margin-top: 16px; padding: 15px">
                <div class="cw-row" style="align-items: baseline">
                    <span style="font: 500 15px/1.2 var(--cw-sans)">{{
                        standing?.title ?? t('dailyNoAccount')
                    }}</span>
                    <span
                        style="
                            font: 400 10px/1 var(--cw-mono);
                            color: var(--cw-muted);
                            flex: none;
                        "
                        >{{ xpLabel }}</span
                    >
                </div>

                <div v-if="standing" class="cw-bar" style="margin: 11px 0">
                    <div class="cw-bar-fill" :style="{ width: `${barPct}%` }" />
                </div>

                <p
                    v-if="perkNote && standing"
                    style="
                        margin: 0;
                        font: 400 11px/1.65 var(--cw-sans);
                        color: var(--cw-muted);
                        text-wrap: pretty;
                    "
                >
                    {{ perkNote }}
                </p>

                <!--
                  The account is the subject of every number above, so a wallet
                  with no session is told that rather than shown zeroes. The
                  press below is the site's own wallet login, performed with the
                  key this browser is already holding.
                -->
                <template v-if="!board.signedIn">
                    <p
                        style="
                            margin: 11px 0 0;
                            font: 400 11px/1.65 var(--cw-sans);
                            color: var(--cw-muted);
                            text-wrap: pretty;
                        "
                    >
                        {{ t('dailyAnonBody') }}
                    </p>
                    <p
                        v-if="perkNote"
                        style="
                            margin: 10px 0 0;
                            font: 400 11px/1.65 var(--cw-sans);
                            color: var(--cw-faint);
                            text-wrap: pretty;
                        "
                    >
                        {{ perkNote }}
                    </p>
                    <button
                        type="button"
                        class="cw-btn cw-btn-secondary"
                        style="margin-top: 12px"
                        :disabled="signingIn || !account"
                        @click="signIn()"
                    >
                        {{ signingIn ? t('dailySigningIn') : t('dailySignIn') }}
                    </button>
                </template>

                <div
                    v-else-if="standing?.rank"
                    class="cw-row"
                    style="
                        margin-top: 12px;
                        padding-top: 12px;
                        border-top: 1px solid var(--cw-line);
                    "
                >
                    <span class="cw-label" style="color: var(--cw-dim)">{{
                        t('dailyRank')
                    }}</span>
                    <span style="font: 500 12px/1 var(--cw-mono); flex: none"
                        >#{{ standing.rank }}</span
                    >
                </div>
            </div>

            <!-- ------------------------------------------------ streak --- -->
            <div class="cw-card" style="margin-top: 10px; padding: 15px">
                <div class="cw-row">
                    <span class="cw-label" style="color: var(--cw-dim)">{{
                        t('dailyStreakLabel')
                    }}</span>
                    <span
                        style="
                            font: 500 10px/1 var(--cw-mono);
                            letter-spacing: 0.12em;
                            color: var(--cw-pending);
                            flex: none;
                        "
                        >{{ streakLabel }}</span
                    >
                </div>

                <div class="cw-days">
                    <div
                        v-for="cell in strip"
                        :key="cell.day"
                        class="cw-day"
                        :class="`cw-day-${cell.state}`"
                    >
                        <span class="cw-day-n">{{ cell.day }}</span>
                        <span class="cw-day-mark">{{
                            cell.bonus > 0 ? `+${cell.bonus}` : '·'
                        }}</span>
                    </div>
                </div>

                <!--
                  Only for somebody the check-in can be about. Signed out, the
                  card above already offers the one press that changes that,
                  and a second copy of it here would be the same button twice
                  under two different labels.
                -->
                <button
                    v-if="board.signedIn"
                    type="button"
                    class="cw-btn"
                    :class="checkedIn ? 'cw-btn-secondary' : 'cw-btn-primary'"
                    :disabled="checking || checkedIn"
                    @click="checkIn()"
                >
                    {{ checkLabel }}
                </button>

                <p
                    v-if="granted !== null"
                    class="cw-note"
                    style="margin-top: 10px"
                >
                    <span>{{
                        granted > 0
                            ? t('dailyGranted', { xp: granted })
                            : t('dailyGrantedNone')
                    }}</span>
                </p>

                <p
                    style="
                        margin: 10px 0 0;
                        font: 400 10px/1.65 var(--cw-mono);
                        color: var(--cw-faint);
                        text-wrap: pretty;
                    "
                >
                    {{ streakNote }}
                </p>
            </div>

            <!-- ------------------------------------------------ faucet --- -->
            <!--
              The one card on this screen whose subject is the address rather
              than the account: the station drips to whoever asks and cares
              about what they hold, not who they are. It is here because an
              empty wallet cannot do a single quest below without gas.
            -->
            <div
                v-if="faucetState !== 'off'"
                class="cw-card cw-card-offer"
                style="margin-top: 10px; padding: 15px"
            >
                <div class="cw-label" style="color: var(--cw-accent)">
                    {{ t('dailyFaucetLabel') }}
                </div>
                <p
                    style="
                        margin: 9px 0 12px;
                        font: 400 12px/1.7 var(--cw-sans);
                        color: var(--cw-body);
                        text-wrap: pretty;
                    "
                >
                    {{
                        drip && cooldownHours !== null
                            ? t('dailyFaucetBody', {
                                  amount: drip,
                                  symbol: chain.symbol,
                                  hours: cooldownHours,
                              })
                            : t('dailyFaucetUnknown')
                    }}
                </p>
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    @click="emit('gas')"
                >
                    {{ t('dailyFaucetOpen') }}
                </button>
            </div>

            <!-- ------------------------------------------------ quests --- -->
            <template v-for="group in questGroups" :key="group.key">
                <div
                    class="cw-label"
                    style="margin: 22px 0 9px; color: var(--cw-dim)"
                >
                    {{ group.header }}
                </div>

                <div style="display: flex; flex-direction: column; gap: 7px">
                    <div
                        v-for="quest in group.rows"
                        :key="quest.key"
                        class="cw-card"
                        style="padding: 13px 14px"
                        :style="
                            quest.completed
                                ? { borderColor: 'var(--cw-ok)' }
                                : undefined
                        "
                    >
                        <div class="cw-row" style="align-items: baseline">
                            <span
                                style="
                                    font: 500 11px/1.3 var(--cw-mono);
                                    letter-spacing: 0.12em;
                                "
                                :style="{
                                    color: quest.completed
                                        ? 'var(--cw-ok)'
                                        : 'var(--cw-text)',
                                }"
                                >{{ questTitle(quest) }}</span
                            >
                            <span
                                style="
                                    font: 400 10px/1 var(--cw-mono);
                                    color: var(--cw-accent);
                                    flex: none;
                                "
                                >+{{ quest.xp }} XP</span
                            >
                        </div>

                        <p
                            style="
                                margin: 7px 0 10px;
                                font: 400 11px/1.55 var(--cw-sans);
                                color: var(--cw-muted);
                                text-wrap: pretty;
                            "
                        >
                            {{ questBody(quest) }}
                        </p>

                        <div
                            style="
                                display: flex;
                                align-items: center;
                                gap: 10px;
                            "
                        >
                            <div class="cw-bar" style="flex: 1; height: 4px">
                                <div
                                    class="cw-bar-fill"
                                    :style="{
                                        width: `${questPct(quest)}%`,
                                        background: quest.completed
                                            ? 'var(--cw-ok)'
                                            : 'var(--cw-accent)',
                                    }"
                                />
                            </div>
                            <span
                                style="
                                    font: 400 9px/1 var(--cw-mono);
                                    color: var(--cw-dim);
                                    flex: none;
                                "
                                >{{
                                    quest.progress === null
                                        ? `— / ${quest.target}`
                                        : `${quest.progress} / ${quest.target}`
                                }}</span
                            >
                            <button
                                v-if="
                                    !quest.completed &&
                                    questDestination(quest.actions)
                                "
                                type="button"
                                class="cw-ghost"
                                style="flex: none; min-height: 32px"
                                @click="
                                    emit('go', questDestination(quest.actions))
                                "
                            >
                                {{ t('dailyGo') }}
                            </button>
                        </div>
                    </div>
                </div>
            </template>

            <!-- ------------------------------------------------- board --- -->
            <div
                v-if="board.board.length > 0"
                class="cw-label"
                style="margin: 22px 0 9px; color: var(--cw-dim)"
            >
                {{ t('dailyBoard') }}
            </div>

            <div
                v-if="board.board.length > 0"
                class="cw-card"
                style="padding: 0"
            >
                <div
                    v-for="row in board.board"
                    :key="row.position"
                    class="cw-board-row"
                    :class="{
                        'cw-board-you':
                            board.account?.address &&
                            row.wallet_address?.toLowerCase() ===
                                board.account.address.toLowerCase(),
                    }"
                >
                    <span class="cw-board-n">{{ row.position }}</span>
                    <span class="cw-board-who">{{ row.name }}</span>
                    <span class="cw-board-lvl">{{
                        t('dailyLevelTag', { level: row.level })
                    }}</span>
                    <span class="cw-board-xp"
                        >{{ row.xp.toLocaleString(locale) }} XP</span
                    >
                </div>
            </div>

            <p class="cw-note" style="margin-top: 16px">
                <span>{{ t('dailyLedgerNote') }}</span>
            </p>
        </template>
    </div>
</template>
