<script setup lang="ts">
import { Head, Link, router, useForm, usePoll } from '@inertiajs/vue3';
import { computed, ref } from 'vue';
import InputError from '@/components/InputError.vue';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/composables/useLocale';
import { arenaMessages } from '@/lib/arenaMessages';
import { PARTNER_CAMPAIGNS } from '@/lib/growthCampaigns';
import { login } from '@/routes';
import { archive, evidence, follow, unfollow } from '@/routes/arena';
import { store, destroy, report } from '@/routes/arena/comments';

type Actor = 'lain' | 'challenger';
type Balance = { cash: string; asset: string };
type Standing = { balance: Balance; equity: string; execution?: string };
type Decision = {
    action: 'hold' | 'buy' | 'sell';
    bps: number;
    reason: string;
    model: string;
};
type Round = {
    sequence: number;
    decisionAt: string;
    filledAt: string;
    recordHash: string;
    evidence: {
        price_micros: string;
        decisions: Record<Actor, Decision>;
        automation?: {
            record: { attempts: Record<Actor, { status: string }> };
        };
    };
    result: {
        actors: Record<Actor, Standing>;
        benchmark: Standing;
        cash_equity: string;
    };
};
type Comment = {
    id: number;
    parentId: number | null;
    body: string | null;
    author: string;
    createdAt: string;
    canRemove: boolean;
    reports: number | null;
};
const props = defineProps<{
    season: {
        title: string;
        startsAt: string | null;
        endsAt: string | null;
        rulesHash: string;
    } | null;
    rules: {
        mode: string;
        automation?: {
            models: Record<Actor, string>;
            pricing_policy?: string;
            max_calls: number;
        };
        fee_bps: number;
        slippage_bps: number;
        gas_micros: string;
        initial_cash_micros: string;
        days?: number;
        market?: string;
        units?: { cash: string; asset: string; lot: number };
        partner?: {
            slug: string;
            title: string;
            name: string;
            website: string;
            x?: string;
            telegram?: string;
            chart?: string;
        };
    };
    automation: {
        enabled: boolean;
        lastTickAt: string | null;
        error: string | null;
        reservedCents: number;
        reservedCalls: number;
        cycles: {
            slot: number;
            status: string;
            error: string | null;
            fillDueAt: string;
            commitHash: string | null;
            decisions: Record<Actor, Decision> | null;
            attempts: Partial<Record<Actor, string>>;
        }[];
    } | null;
    rounds: Round[];
    archivedSeasons: { slug: string; title: string }[];
    comments: {
        data: Comment[];
        prev_page_url: string | null;
        next_page_url: string | null;
    } | null;
    following: boolean;
    saves: number;
    signedIn: boolean;
}>();
const { t, tag, nextTag, toggleLocale } = useLocale(arenaMessages);
const form = useForm({ body: '', parent_id: null as number | null });
const pending = ref(false);
const copyStatus = ref('');
const reported = ref<number[]>([]);
usePoll(30000, {
    only: ['season', 'rounds', 'comments', 'following', 'saves', 'automation'],
});
const pendingCycle = computed(() =>
    props.automation?.cycles.find((cycle) =>
        ['collecting', 'awaiting_fill'].includes(cycle.status),
    ),
);
const automationQuiet = computed(
    () =>
        props.automation?.enabled &&
        props.season?.startsAt &&
        new Date(props.season.startsAt).getTime() <= Date.now() &&
        (!props.automation.lastTickAt ||
            Date.now() - new Date(props.automation.lastTickAt).getTime() >
                180000),
);
const units = computed(
    () => props.rules.units ?? { cash: 'USDC', asset: 'WETH', lot: 1 },
);
const partner = computed(() => props.rules.partner ?? null);
const campaign = computed(() =>
    partner.value
        ? (
              PARTNER_CAMPAIGNS as Record<
                  string,
                  { logo: string; symbol: string }
              >
          )[partner.value.slug]
        : undefined,
);
const lotLabel = computed(() =>
    units.value.lot === 1
        ? units.value.asset
        : `${units.value.lot >= 1000000 ? `${units.value.lot / 1000000}M` : units.value.lot} ${units.value.asset}`,
);
const marketWords = computed(() => ({
    asset: units.value.asset,
    cash: units.value.cash,
    market: props.rules.market ?? 'WETH / USDC',
    days: props.rules.days ?? 14,
    source: t(units.value.asset === 'HATCHER' ? 'sourceHatcher' : 'sourceBase'),
}));
function assetAmount(value: string | undefined): string {
    return value === undefined
        ? '—'
        : money(
              String(BigInt(value) * BigInt(units.value.lot)),
              18,
              units.value.lot === 1 ? 6 : 2,
          );
}
const latest = computed(() => props.rounds.at(-1));
const recent = computed(() => [...props.rounds].reverse().slice(0, 8));
const actors: Actor[] = ['lain', 'challenger'];
const status = computed(() => {
    if (!props.season?.startsAt) {
        return t('draft');
    }

    const now = Date.now();

    if (new Date(props.season.startsAt).getTime() > now) {
        return t('scheduled', { date: date(props.season.startsAt) });
    }

    return t(
        props.season.endsAt && new Date(props.season.endsAt).getTime() < now
            ? 'finished'
            : 'running',
    );
});
function money(value: string | undefined, decimals = 6, precision = 2): string {
    if (value === undefined) {
        return '—';
    }

    const raw = BigInt(value);
    const scale = 10n ** BigInt(decimals);
    const whole = (raw / scale).toLocaleString(tag.value);
    const fraction = (((raw % scale) * 10n ** BigInt(precision)) / scale)
        .toString()
        .padStart(precision, '0');

    return precision === 0
        ? whole
        : `${whole}${tag.value === 'ru-RU' ? ',' : '.'}${fraction}`;
}
function date(value: string): string {
    return new Intl.DateTimeFormat(tag.value, {
        dateStyle: 'medium',
        timeStyle: 'short',
    }).format(new Date(value));
}
function post(): void {
    form.submit(store(), {
        preserveScroll: true,
        onSuccess: () => form.reset(),
    });
}
function toggleFollow(): void {
    pending.value = true;
    router.visit(props.following ? unfollow() : follow(), {
        preserveScroll: true,
        onFinish: () => {
            pending.value = false;
        },
    });
}
function removeComment(id: number): void {
    if (window.confirm(t('removeConfirm'))) {
        router.visit(destroy(id), { preserveScroll: true });
    }
}
function reportComment(id: number): void {
    router.visit(report(id), {
        preserveScroll: true,
        onSuccess: () => {
            reported.value.push(id);
        },
    });
}
async function invite(): Promise<void> {
    try {
        await navigator.clipboard.writeText(
            t('invitation', {
                url: window.location.origin + window.location.pathname,
            }),
        );
        copyStatus.value = t('copied');
    } catch {
        copyStatus.value = t('copyFailed');
    }
}
</script>

<template>
    <Head :title="partner?.title ?? t('title')" />
    <div class="mx-auto max-w-5xl space-y-10 px-4 py-8 sm:py-12">
        <header class="space-y-5">
            <div class="flex flex-wrap items-center justify-between gap-3">
                <p
                    class="font-mono text-xs tracking-widest text-primary uppercase"
                >
                    {{
                        partner
                            ? t('partnerEyebrow', { partner: partner.name })
                            : t('eyebrow')
                    }}
                </p>
                <Button
                    variant="outline"
                    size="sm"
                    :aria-label="t('language')"
                    @click="toggleLocale"
                    >{{ nextTag }}</Button
                >
            </div>
            <h1 class="text-3xl font-semibold tracking-tight sm:text-5xl">
                {{ partner?.title ?? t('title') }}
            </h1>
            <p class="max-w-2xl text-lg text-muted-foreground">
                {{
                    partner
                        ? t('partnerIntro', { symbol: units.asset })
                        : t('intro')
                }}
            </p>
            <div
                v-if="partner"
                class="flex flex-wrap items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4"
            >
                <img
                    v-if="campaign"
                    :src="campaign.logo"
                    :alt="partner.name"
                    class="size-10 rounded-full"
                />
                <a
                    :href="partner.website"
                    target="_blank"
                    rel="noopener"
                    class="font-medium underline underline-offset-4"
                    >{{ t('partnerAbout', { partner: partner.name }) }}</a
                >
                <a
                    v-if="partner.chart"
                    :href="partner.chart"
                    target="_blank"
                    rel="noopener"
                    class="text-sm underline underline-offset-4"
                    >{{ t('partnerChart', { symbol: units.asset }) }}</a
                >
                <Link
                    :href="`/partners/${partner.slug}`"
                    class="text-sm underline underline-offset-4"
                    >{{ t('partnerPage', { symbol: units.asset }) }}</Link
                >
                <a
                    v-if="partner.x"
                    :href="partner.x"
                    target="_blank"
                    rel="noopener"
                    class="text-sm text-muted-foreground underline underline-offset-4"
                    >X</a
                >
                <a
                    v-if="partner.telegram"
                    :href="partner.telegram"
                    target="_blank"
                    rel="noopener"
                    class="text-sm text-muted-foreground underline underline-offset-4"
                    >Telegram</a
                >
            </div>
            <div class="flex flex-wrap items-center gap-3 text-sm">
                <span
                    class="rounded-full border border-primary/30 bg-primary/10 px-3 py-1 text-primary"
                    >{{ status }}</span
                >
                <span class="text-muted-foreground">{{
                    t('saves', { count: saves })
                }}</span>
            </div>
            <p class="max-w-3xl text-sm text-muted-foreground">
                {{ t('statusNote') }}
            </p>
            <div class="flex flex-wrap items-center gap-3">
                <Button
                    v-if="signedIn && season"
                    :variant="following ? 'outline' : 'default'"
                    :disabled="pending"
                    @click="toggleFollow"
                    >{{
                        t(
                            pending
                                ? 'working'
                                : following
                                  ? 'unfollow'
                                  : 'follow',
                        )
                    }}</Button
                >
                <Button v-else-if="!signedIn" as-child
                    ><Link :href="login().url">{{ t('login') }}</Link></Button
                >
                <Button variant="outline" @click="invite">{{
                    t('invite')
                }}</Button>
                <a
                    href="#arena-rules"
                    class="text-sm underline underline-offset-4"
                    >{{ t('rules') }}</a
                >
            </div>
            <p v-if="copyStatus" role="status" class="text-sm text-primary">
                {{ copyStatus }}
            </p>
            <p class="text-xs text-muted-foreground">
                {{ t(following ? 'followNote' : 'readFree') }}
            </p>
        </header>

        <section
            v-if="automation"
            class="space-y-3 rounded-xl border border-border p-5"
            :aria-label="t('automatic')"
        >
            <h2 class="font-semibold">{{ t('automatic') }}</h2>
            <p class="text-sm text-muted-foreground">{{ t('isolatedNote') }}</p>
            <p class="text-sm" role="status">
                {{
                    t(
                        !automation.enabled
                            ? 'automationOff'
                            : automationQuiet
                              ? 'automationQuiet'
                              : 'automationOn',
                    )
                }}
                <span v-if="automation.lastTickAt">
                    ·
                    {{
                        t('lastTick', { date: date(automation.lastTickAt) })
                    }}</span
                >
            </p>
            <p v-if="automation.error" class="text-sm text-amber-500">
                {{ t(`error_${automation.error}`) }}
            </p>
            <p class="text-xs text-muted-foreground">
                {{
                    t(
                        rules.automation?.pricing_policy === 'free-only'
                            ? 'freeCalls'
                            : 'reservations',
                        {
                            amount: money(String(automation.reservedCents), 2),
                            calls: automation.reservedCalls,
                            limit: rules.automation?.max_calls ?? 112,
                        },
                    )
                }}
            </p>
            <div
                v-if="pendingCycle"
                class="space-y-2 border-t border-border pt-3"
            >
                <p class="text-sm">
                    {{ t(`cycle_${pendingCycle.status}`) }} ·
                    {{ t('fillDue', { date: date(pendingCycle.fillDueAt) }) }}
                </p>
                <template
                    v-if="
                        pendingCycle.status === 'awaiting_fill' &&
                        pendingCycle.decisions
                    "
                >
                    <p
                        v-for="actor in actors"
                        :key="actor"
                        class="text-sm whitespace-pre-wrap"
                    >
                        {{ actor === 'lain' ? 'Lain' : 'Challenger' }} ·
                        {{ t(pendingCycle.decisions[actor].action) }} ·
                        {{ pendingCycle.decisions[actor].reason }}
                    </p>
                    <p
                        class="font-mono text-xs break-all text-muted-foreground"
                    >
                        {{ pendingCycle.commitHash }}
                    </p>
                </template>
            </div>
            <details
                v-if="
                    automation.cycles.some(
                        (cycle) => cycle.status === 'skipped',
                    )
                "
                class="text-xs text-muted-foreground"
            >
                <summary class="cursor-pointer">
                    {{ t('skippedSlots') }}
                </summary>
                <p
                    v-for="cycle in automation.cycles.filter(
                        (cycle) => cycle.status === 'skipped',
                    )"
                    :key="cycle.slot"
                    class="mt-2"
                >
                    #{{ cycle.slot + 1 }} · {{ t(`error_${cycle.error}`) }}
                </p>
            </details>
        </section>

        <section
            class="grid gap-4 md:grid-cols-2"
            :aria-label="t('commonOwner')"
        >
            <article
                v-for="actor in actors"
                :key="actor"
                class="space-y-5 rounded-xl border border-border bg-card p-5 sm:p-6"
            >
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <h2 class="text-2xl font-semibold">
                        {{ actor === 'lain' ? 'Lain' : 'Challenger' }}
                    </h2>
                    <span class="font-mono text-xs text-muted-foreground">{{
                        latest
                            ? latest.evidence.decisions[actor].model
                            : (rules.automation?.models[actor] ??
                              t('notConnected'))
                    }}</span>
                </div>
                <p class="text-sm text-muted-foreground">
                    {{
                        t(actor === 'lain' ? 'methodLain' : 'methodChallenger')
                    }}
                </p>
                <div>
                    <p class="text-xs text-muted-foreground">
                        {{ t('equity') }}
                    </p>
                    <p class="mt-1 font-mono text-3xl">
                        {{ money(latest?.result.actors[actor].equity) }}
                        <span class="text-sm text-muted-foreground">{{
                            units.cash
                        }}</span>
                    </p>
                </div>
                <dl
                    class="grid grid-cols-2 gap-3 border-t border-border pt-4 text-sm"
                >
                    <div>
                        <dt class="text-muted-foreground">{{ t('cash') }}</dt>
                        <dd class="mt-1 font-mono">
                            {{
                                money(latest?.result.actors[actor].balance.cash)
                            }}
                        </dd>
                    </div>
                    <div>
                        <dt class="text-muted-foreground">
                            {{ t('asset', marketWords) }}
                        </dt>
                        <dd class="mt-1 font-mono">
                            {{
                                assetAmount(
                                    latest?.result.actors[actor].balance.asset,
                                )
                            }}
                        </dd>
                    </div>
                </dl>
                <p class="text-xs text-muted-foreground">
                    {{ t('initial') }}: {{ money(rules.initial_cash_micros) }}
                    {{ units.cash }}
                </p>
            </article>
        </section>
        <div
            v-if="latest"
            class="flex flex-wrap gap-x-8 gap-y-3 border-y border-border py-4 text-sm"
        >
            <p>
                {{ t('benchmark') }}:
                <strong class="font-mono"
                    >{{ money(latest.result.benchmark.equity) }}
                    {{ units.cash }}</strong
                >
            </p>
            <p>
                {{ t('cashBenchmark') }}:
                <strong class="font-mono"
                    >{{ money(latest.result.cash_equity) }}
                    {{ units.cash }}</strong
                >
            </p>
        </div>

        <section class="space-y-4" aria-labelledby="arena-journal">
            <h2 id="arena-journal" class="text-xl font-semibold">
                {{ t('latest') }}
            </h2>
            <p
                v-if="!rounds.length"
                class="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground"
            >
                {{ t('emptyRounds') }}
            </p>
            <article
                v-for="round in recent"
                :key="round.sequence"
                class="space-y-4 rounded-xl border border-border p-5"
            >
                <div class="flex flex-wrap justify-between gap-2">
                    <h3 class="font-semibold">
                        {{ t('round', { number: round.sequence }) }}
                    </h3>
                    <time
                        class="text-xs text-muted-foreground"
                        :datetime="round.filledAt"
                        >{{ t('filled', { date: date(round.filledAt) }) }}</time
                    >
                </div>
                <div class="grid gap-4 md:grid-cols-2">
                    <div v-for="actor in actors" :key="actor" class="space-y-2">
                        <p class="text-sm font-medium">
                            {{ actor === 'lain' ? 'Lain' : 'Challenger' }} ·
                            {{ t(round.evidence.decisions[actor].action)
                            }}<span v-if="round.evidence.decisions[actor].bps">
                                {{
                                    round.evidence.decisions[actor].bps / 100
                                }}%</span
                            >
                        </p>
                        <p
                            class="text-sm whitespace-pre-wrap text-muted-foreground"
                        >
                            {{ round.evidence.decisions[actor].reason }}
                        </p>
                        <p
                            v-if="
                                round.evidence.automation?.record.attempts[
                                    actor
                                ].status === 'failed'
                            "
                            class="text-xs text-amber-500"
                        >
                            {{ t('modelFailed') }}
                        </p>
                        <p
                            v-if="
                                round.result.actors[actor].execution ===
                                'rejected'
                            "
                            class="text-xs text-amber-500"
                        >
                            {{ t('orderRejected') }}
                        </p>
                    </div>
                </div>
                <p class="text-xs text-muted-foreground">
                    {{ t('price') }}: {{ money(round.evidence.price_micros) }}
                    {{ units.cash }} /
                    {{ lotLabel }}
                </p>
                <details class="text-xs text-muted-foreground">
                    <summary class="cursor-pointer">
                        {{ t('recordHash') }}
                    </summary>
                    <code class="mt-2 block break-all">{{
                        round.recordHash
                    }}</code>
                </details>
            </article>
        </section>

        <section
            id="arena-rules"
            class="space-y-4 rounded-xl border border-border bg-muted/20 p-5 sm:p-6"
        >
            <h2 class="text-xl font-semibold">{{ t('rules') }}</h2>
            <ul class="list-disc space-y-2 pl-5 text-sm text-muted-foreground">
                <li>{{ t('rule1', marketWords) }}</li>
                <li>
                    {{
                        t('rule2', {
                            ...marketWords,
                            amount: money(rules.initial_cash_micros, 6, 0),
                        })
                    }}
                </li>
                <li>{{ t('rule3') }}</li>
                <li>
                    {{
                        t('rule4', {
                            fee: rules.fee_bps / 100,
                            slippage: rules.slippage_bps / 100,
                            gas: money(rules.gas_micros, 6, 3),
                            cash: units.cash,
                        })
                    }}
                </li>
                <li>{{ t('rule5', marketWords) }}</li>
            </ul>
            <p class="text-xs leading-relaxed text-muted-foreground">
                {{
                    t(
                        rules.mode === 'automatic-paper'
                            ? 'automaticEvidenceNote'
                            : 'evidenceNote',
                        marketWords,
                    )
                }}
            </p>
            <a
                v-if="season"
                :href="evidence.url()"
                class="inline-block text-sm text-primary underline underline-offset-4"
                >{{ t('evidence') }}</a
            >
            <div
                v-if="archivedSeasons.length"
                class="space-y-2 text-xs text-muted-foreground"
            >
                <p>{{ t('archivedSeasons') }}</p>
                <a
                    v-for="archived in archivedSeasons"
                    :key="archived.slug"
                    :href="archive(archived.slug).url"
                    class="block underline underline-offset-4"
                    >{{ archived.title }} · {{ archived.slug }}</a
                >
            </div>
        </section>

        <section class="space-y-5" aria-labelledby="arena-discussion">
            <div>
                <h2 id="arena-discussion" class="text-xl font-semibold">
                    {{ t('discussion') }}
                </h2>
                <p class="mt-2 text-sm text-muted-foreground">
                    {{ t('discussionHint') }}
                </p>
            </div>
            <form
                v-if="signedIn && season"
                class="space-y-3"
                @submit.prevent="post"
            >
                <div
                    v-if="form.parent_id"
                    class="flex flex-wrap items-center gap-3 text-xs"
                >
                    <span>{{ t('replying', { number: form.parent_id }) }}</span
                    ><button
                        type="button"
                        class="underline"
                        @click="form.parent_id = null"
                    >
                        {{ t('cancelReply') }}
                    </button>
                </div>
                <label for="arena-comment" class="text-sm font-medium">{{
                    t('body')
                }}</label>
                <textarea
                    id="arena-comment"
                    v-model="form.body"
                    required
                    maxlength="2000"
                    :placeholder="t('placeholder')"
                    class="block min-h-28 w-full rounded-lg border border-input bg-background p-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
                ></textarea>
                <InputError
                    :message="form.errors.body ?? form.errors.parent_id"
                />
                <Button
                    type="submit"
                    :disabled="form.processing || !form.body.trim()"
                    >{{ t(form.processing ? 'posting' : 'post') }}</Button
                >
            </form>
            <Link
                v-else-if="!signedIn"
                :href="login().url"
                class="inline-block text-sm text-primary underline underline-offset-4"
                >{{ t('login') }}</Link
            >
            <p
                v-if="!comments?.data.length"
                class="text-sm text-muted-foreground"
            >
                {{ t('emptyComments') }}
            </p>
            <article
                v-for="comment in comments?.data ?? []"
                :id="`comment-${comment.id}`"
                :key="comment.id"
                class="space-y-3 border-t border-border py-4"
            >
                <div
                    class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs"
                >
                    <strong class="text-sm">{{ comment.author }}</strong
                    ><a
                        :href="`#comment-${comment.id}`"
                        class="text-muted-foreground"
                        >#{{ comment.id }}</a
                    ><time
                        :datetime="comment.createdAt"
                        class="text-muted-foreground"
                        >{{ date(comment.createdAt) }}</time
                    ><span v-if="comment.parentId" class="text-muted-foreground"
                        >↳ #{{ comment.parentId }}</span
                    >
                </div>
                <p
                    class="text-sm break-words whitespace-pre-wrap"
                    :class="{ 'text-muted-foreground': comment.body === null }"
                >
                    {{ comment.body ?? t('removed') }}
                </p>
                <div
                    v-if="signedIn && comment.body"
                    class="flex flex-wrap gap-4 text-xs text-muted-foreground"
                >
                    <button
                        v-if="!comment.parentId"
                        type="button"
                        class="underline underline-offset-2"
                        @click="form.parent_id = comment.id"
                    >
                        {{ t('reply') }}
                    </button>
                    <button
                        v-if="comment.canRemove"
                        type="button"
                        class="underline underline-offset-2"
                        @click="removeComment(comment.id)"
                    >
                        {{ t('remove') }}
                    </button>
                    <button
                        type="button"
                        :disabled="reported.includes(comment.id)"
                        class="underline underline-offset-2"
                        @click="reportComment(comment.id)"
                    >
                        {{
                            t(
                                reported.includes(comment.id)
                                    ? 'reported'
                                    : 'report',
                            )
                        }}
                    </button>
                    <span v-if="comment.reports">{{
                        t('reports', { count: comment.reports })
                    }}</span>
                </div>
            </article>
            <nav
                v-if="comments?.prev_page_url || comments?.next_page_url"
                class="flex gap-5 text-sm"
            >
                <Link
                    v-if="comments.prev_page_url"
                    :href="comments.prev_page_url"
                    >{{ t('prev') }}</Link
                ><Link
                    v-if="comments.next_page_url"
                    :href="comments.next_page_url"
                    >{{ t('next') }}</Link
                >
            </nav>
        </section>
    </div>
</template>
