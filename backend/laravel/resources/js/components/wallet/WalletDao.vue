<script setup lang="ts">
import { useForm } from '@inertiajs/vue3';
import { computed, onMounted, ref, watch } from 'vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { relativeTime } from '@/lib/wallet/format';
import { signInWithWallet } from '@/lib/wallet/session';
import {
    castVote,
    createProposal,
    fetchComments,
    fetchDao,
    fetchMyVote,
    fetchProposal,
    postComment,
    tally,
} from '@/lib/wallet/social';
import type {
    DaoSummary,
    MyVote,
    ProposalComment,
    ProposalSummary,
} from '@/lib/wallet/social';
import { walletMessages } from '@/lib/walletMessages';
import { store as daoStore } from '@/routes/dao';

/**
 * Governance, from the wallet: read a proposal and vote on it, here.
 *
 * This screen used to show the tally and then send people to the site to cast
 * the vote — on a phone, a page that wants a browser wallet the phone does not
 * have. A vote is recorded against an account, and the wallet becomes one the
 * same way the feed composer does: the first press signs the site's login
 * challenge with the active key, and the vote follows as that session. Nothing
 * goes on chain and nothing costs gas; the weight is the address's snapshot.
 *
 * The bar is drawn from power, not from voter count. Two small votes for and
 * one large one against is a proposal that is losing, and a bar built from
 * headcount would draw the opposite.
 */

const props = defineProps<{ wallet: MultiWallet }>();
const creating = ref(false);
const signing = ref(false);
const createError = ref<string | null>(null);
const form = useForm({ name: '', address: '' });
const signer = computed(() =>
    props.wallet.accounts.value.find(
        (account) =>
            account.chain === 'cyberia' &&
            props.wallet.activeAccount.value?.kind !== 'watch',
    ),
);
const createDao = async (): Promise<void> => {
    if (!signer.value || signing.value || form.processing) {
        return;
    }

    signing.value = true;
    createError.value = null;
    const accountId = props.wallet.activeAccountId.value;

    try {
        await signInWithWallet(signer.value.address, (message) => {
            if (accountId !== props.wallet.activeAccountId.value) {
                throw new Error(t('daoAccountChanged'));
            }

            return props.wallet.signMessage('cyberia', message);
        });

        if (accountId !== props.wallet.activeAccountId.value) {
            return;
        }

        form.post(daoStore.url(), {
            preserveScroll: true,
            onSuccess: () => {
                creating.value = false;
                form.reset();
                void load();
            },
        });
    } catch (error) {
        createError.value =
            error instanceof Error ? error.message : String(error);
    } finally {
        signing.value = false;
    }
};
watch(
    () => props.wallet.activeAccountId.value,
    () => {
        creating.value = false;
        form.reset();
        form.clearErrors();
        createError.value = null;
    },
    { flush: 'sync' },
);

const { locale, t } = useLocale(walletMessages);

const daos = ref<DaoSummary[]>([]);
const proposals = ref<ProposalSummary[]>([]);
const detail = ref<ProposalSummary | null>(null);
const loading = ref(true);
const failure = ref(false);

const myVote = ref<MyVote | null>(null);
const pending = ref<boolean | null>(null);
const voteError = ref<string | null>(null);

const canVote = computed(
    () =>
        signer.value !== undefined &&
        props.wallet.activeAccount.value?.kind !== 'watch',
);

/** Voting power is a decimal(*,18); four places are plenty to read it by. */
const powerLabel = (power: string): string => {
    const value = Number(power);

    return Number.isFinite(value)
        ? value.toLocaleString(locale.value, { maximumFractionDigits: 4 })
        : power;
};

const readMyVote = async (id: number): Promise<void> => {
    const address = signer.value?.address ?? null;
    const answer = await fetchMyVote(id);

    // A session belonging to another key says nothing about this one.
    myVote.value =
        address !== null &&
        answer.address !== null &&
        answer.address.toLowerCase() === address.toLowerCase() &&
        detail.value?.id === id
            ? answer.vote
            : null;
};

/**
 * Run a write as the active key's session, signing in first when this browser
 * has none for it. The first attempt goes straight to the write because most
 * presses after the first already have a session; a refusal that means "not
 * you" (401, an expired 419, or a session as somebody else, 409) signs the
 * login challenge and tries exactly once more.
 */
const asSigner = async <T,>(
    address: string,
    accountId: string | null,
    write: () => Promise<T>,
): Promise<T> => {
    try {
        return await write();
    } catch (error) {
        const status = (error as { status?: number }).status;

        if (status !== 401 && status !== 409 && status !== 419) {
            throw error;
        }

        await signInWithWallet(address, (message) => {
            if (accountId !== props.wallet.activeAccountId.value) {
                throw new Error(t('daoAccountChanged'));
            }

            return props.wallet.signMessage('cyberia', message);
        });

        return write();
    }
};

/**
 * Writing a proposal, from the phone it will be voted on.
 *
 * The deadline is a choice of durations rather than a date picker: a vote
 * needs an end (one without would be open forever), and "a week" is what
 * somebody means far more often than a calendar day typed on a phone.
 */
const DURATIONS = [1, 3, 7, 14] as const;
const proposing = ref(false);
const publishing = ref(false);
const proposeError = ref<string | null>(null);
const draft = ref({
    daoId: null as number | null,
    title: '',
    description: '',
    days: 7 as (typeof DURATIONS)[number],
});

const startProposal = (): void => {
    proposing.value = !proposing.value;
    creating.value = false;
    proposeError.value = null;

    if (draft.value.daoId === null && daos.value.length > 0) {
        draft.value.daoId = daos.value[0].id;
    }
};

const publishProposal = async (): Promise<void> => {
    const address = signer.value?.address;
    const daoId = draft.value.daoId;
    const title = draft.value.title.trim();

    if (
        !address ||
        !canVote.value ||
        daoId === null ||
        title === '' ||
        publishing.value
    ) {
        return;
    }

    publishing.value = true;
    proposeError.value = null;
    const accountId = props.wallet.activeAccountId.value;
    const endsAt = new Date(
        Date.now() + draft.value.days * 86_400_000,
    ).toISOString();

    try {
        const id = await asSigner(address, accountId, () =>
            createProposal({
                address,
                daoId,
                title,
                description: draft.value.description.trim(),
                endsAt,
            }),
        );

        if (accountId !== props.wallet.activeAccountId.value) {
            return;
        }

        proposing.value = false;
        draft.value = { ...draft.value, title: '', description: '' };
        await load();
        const created = proposals.value.find((entry) => entry.id === id);
        await open(
            created ?? ({ id, title, status: 'open' } as ProposalSummary),
        );
    } catch (error) {
        proposeError.value =
            error instanceof Error ? error.message : String(error);
    } finally {
        publishing.value = false;
    }
};

/** Cast the vote (or change it) as the active key; see `asSigner`. */
const vote = async (support: boolean): Promise<void> => {
    const proposal = detail.value;
    const address = signer.value?.address;

    if (!proposal || !address || !canVote.value || pending.value !== null) {
        return;
    }

    pending.value = support;
    voteError.value = null;
    const accountId = props.wallet.activeAccountId.value;

    try {
        const cast: MyVote = await asSigner(address, accountId, () =>
            castVote(proposal.id, address, support),
        );

        if (
            accountId !== props.wallet.activeAccountId.value ||
            detail.value?.id !== proposal.id
        ) {
            return;
        }

        myVote.value = cast;

        try {
            const fresh = await fetchProposal(proposal.id);

            if (detail.value?.id === fresh.id) {
                detail.value = fresh;
            }

            proposals.value = proposals.value.map((entry) =>
                entry.id === fresh.id ? { ...entry, ...fresh } : entry,
            );
        } catch {
            // The vote is recorded; only the redrawn tally is missing, and
            // the next visit reads it.
        }
    } catch (error) {
        voteError.value =
            error instanceof Error ? error.message : String(error);
    } finally {
        pending.value = null;
    }
};

/**
 * The discussion, here rather than a link out: a comment needs an author, and
 * the wallet becomes one exactly as it does for a vote. Commenting stays open
 * after voting closes, as it does on the site. One level of replies, like the
 * site's thread.
 */
const comments = ref<ProposalComment[]>([]);
const commentsState = ref<'loading' | 'ready' | 'failed'>('loading');
const commentDraft = ref('');
const replyTo = ref<ProposalComment | null>(null);
const commenting = ref(false);
const commentError = ref<string | null>(null);

const readComments = async (id: number): Promise<void> => {
    commentsState.value = 'loading';

    try {
        const thread = await fetchComments(id);

        if (detail.value?.id === id) {
            comments.value = thread;
            commentsState.value = 'ready';
        }
    } catch {
        if (detail.value?.id === id) {
            commentsState.value = 'failed';
        }
    }
};

const sendComment = async (): Promise<void> => {
    const proposal = detail.value;
    const address = signer.value?.address;
    const body = commentDraft.value.trim();

    if (
        !proposal ||
        !address ||
        !canVote.value ||
        body === '' ||
        commenting.value
    ) {
        return;
    }

    commenting.value = true;
    commentError.value = null;
    const accountId = props.wallet.activeAccountId.value;
    const parentId = replyTo.value?.id ?? null;

    try {
        await asSigner(address, accountId, () =>
            postComment(proposal.id, address, body, parentId),
        );

        if (
            accountId !== props.wallet.activeAccountId.value ||
            detail.value?.id !== proposal.id
        ) {
            return;
        }

        commentDraft.value = '';
        replyTo.value = null;
        detail.value = { ...detail.value, comments: detail.value.comments + 1 };
        proposals.value = proposals.value.map((entry) =>
            entry.id === proposal.id
                ? { ...entry, comments: entry.comments + 1 }
                : entry,
        );
        await readComments(proposal.id);
    } catch (error) {
        commentError.value =
            error instanceof Error ? error.message : String(error);
    } finally {
        commenting.value = false;
    }
};

watch(
    () => props.wallet.activeAccountId.value,
    () => {
        myVote.value = null;
        voteError.value = null;
        proposeError.value = null;
        commentError.value = null;

        if (detail.value) {
            void readMyVote(detail.value.id);
        }
    },
);

const openProposals = computed(
    () => proposals.value.filter((entry) => entry.status === 'open').length,
);

const seconds = (iso: string | null): number | null =>
    iso === null ? null : Math.round(Date.parse(iso) / 1000);

const load = async (): Promise<void> => {
    loading.value = true;
    failure.value = false;

    try {
        const body = await fetchDao();
        daos.value = body.daos;
        proposals.value = body.proposals;
    } catch {
        failure.value = true;
    } finally {
        loading.value = false;
    }
};

/** The list already holds the summary; this fetches the body underneath it. */
const open = async (proposal: ProposalSummary): Promise<void> => {
    detail.value = proposal;
    myVote.value = null;
    voteError.value = null;
    comments.value = [];
    commentDraft.value = '';
    replyTo.value = null;
    commentError.value = null;
    void readMyVote(proposal.id);
    void readComments(proposal.id);

    try {
        detail.value = await fetchProposal(proposal.id);
    } catch {
        // The summary is still on screen and still true — only the full text
        // is missing, which the detail renders as its absence.
    }
};

/**
 * `?proposal=` — what a notification about a proposal lands on. It opens that
 * proposal rather than the list it is somewhere in, and then deletes itself,
 * so going back to the list and refreshing does not reopen it.
 */
const takeProposalRequest = (): void => {
    if (typeof window === 'undefined') {
        return;
    }

    const url = new URL(window.location.href);
    const id = Number(url.searchParams.get('proposal'));

    if (!Number.isInteger(id) || id <= 0) {
        return;
    }

    url.searchParams.delete('proposal');
    window.history.replaceState(window.history.state, '', url);

    const known = proposals.value.find((entry) => entry.id === id);
    void open(
        known ??
            ({
                id,
                title: '',
                summary: '',
                status: 'open',
                comments: 0,
                votes: 0,
                powerFor: '0',
                powerAgainst: '0',
            } as ProposalSummary),
    );
};

onMounted(async () => {
    await load();
    takeProposalRequest();
});
</script>

<template>
    <div class="cw-stack">
        <template v-if="detail">
            <button type="button" class="cw-back" @click="detail = null">
                ← {{ t('daoProposals') }}
            </button>

            <div
                style="
                    display: flex;
                    align-items: center;
                    gap: 10px;
                    margin: 22px 0 10px;
                "
            >
                <span
                    class="cw-label"
                    :style="{
                        color:
                            detail.status === 'open'
                                ? 'var(--cw-ok)'
                                : 'var(--cw-muted)',
                    }"
                    >{{
                        detail.status === 'open'
                            ? t('daoStatusOpen')
                            : t('daoStatusClosed')
                    }}</span
                >
                <span class="cw-fill"></span>
                <span class="cw-label" style="color: var(--cw-faint)">{{
                    detail.endsAt
                        ? relativeTime(seconds(detail.endsAt), locale)
                        : t('daoNoDeadline')
                }}</span>
            </div>

            <h2 class="cw-title" style="margin: 0 0 10px">
                {{ detail.title }}
            </h2>
            <div class="cw-label" style="color: var(--cw-faint)">
                {{ detail.dao?.name ?? '—' }} ·
                {{ detail.author?.name ?? t('feedSomeone') }}
            </div>

            <!--
              Server-rendered from the proposal's markdown through the same
              sanitiser the site uses, so this is not a second escaping story.
            -->
            <div
                v-if="detail.descriptionHtml"
                class="cw-prose"
                style="margin-top: 18px"
                v-html="detail.descriptionHtml"
            ></div>
            <p v-else class="cw-prose" style="margin-top: 18px">
                {{ detail.summary }}
            </p>

            <div class="cw-card" style="margin-top: 22px">
                <div
                    class="cw-bar"
                    style="display: flex; height: 8px; margin-bottom: 14px"
                >
                    <span
                        :style="{
                            width: `${tally(detail.powerFor, detail.powerAgainst).for}%`,
                            background: 'var(--cw-ok)',
                        }"
                    />
                    <span
                        :style="{
                            width: `${tally(detail.powerFor, detail.powerAgainst).against}%`,
                            background: 'var(--cw-bad)',
                        }"
                    />
                </div>
                <div class="cw-row">
                    <span
                        style="
                            font: 500 13px/1 var(--cw-mono);
                            color: var(--cw-ok);
                        "
                        >{{
                            t('daoFor', {
                                percent: tally(
                                    detail.powerFor,
                                    detail.powerAgainst,
                                ).for.toFixed(1),
                            })
                        }}</span
                    >
                    <span
                        style="
                            font: 500 13px/1 var(--cw-mono);
                            color: var(--cw-bad-soft);
                        "
                        >{{
                            t('daoAgainst', {
                                percent: tally(
                                    detail.powerFor,
                                    detail.powerAgainst,
                                ).against.toFixed(1),
                            })
                        }}</span
                    >
                </div>
                <div class="cw-label" style="margin-top: 10px">
                    {{
                        t('daoCast', {
                            votes: detail.votes,
                            comments: detail.comments,
                        })
                    }}
                </div>
            </div>

            <!--
              The vote itself. Two buttons and the one already pressed is the
              filled one, so changing your mind is the same gesture as voting.
            -->
            <template v-if="detail.status === 'open'">
                <div class="cw-label" style="margin: 22px 0 10px">
                    {{ t('daoYourVote') }}
                </div>
                <div style="display: flex; gap: 10px">
                    <button
                        type="button"
                        class="cw-btn"
                        :class="
                            myVote?.support === true
                                ? 'cw-btn-primary'
                                : 'cw-btn-secondary'
                        "
                        style="flex: 1"
                        :disabled="!canVote || pending !== null"
                        :aria-pressed="myVote?.support === true"
                        @click="vote(true)"
                    >
                        {{
                            pending === true ? t('daoVoting') : t('daoVoteFor')
                        }}
                    </button>
                    <button
                        type="button"
                        class="cw-btn"
                        :class="
                            myVote?.support === false
                                ? 'cw-btn-primary'
                                : 'cw-btn-secondary'
                        "
                        style="flex: 1"
                        :disabled="!canVote || pending !== null"
                        :aria-pressed="myVote?.support === false"
                        @click="vote(false)"
                    >
                        {{
                            pending === false
                                ? t('daoVoting')
                                : t('daoVoteAgainst')
                        }}
                    </button>
                </div>

                <p v-if="myVote" class="cw-note" style="margin-top: 12px">
                    <span>{{
                        t(myVote.support ? 'daoVotedFor' : 'daoVotedAgainst', {
                            power: powerLabel(myVote.power),
                        })
                    }}</span>
                </p>
                <p
                    v-else-if="!canVote"
                    class="cw-note cw-note-warn"
                    style="margin-top: 12px"
                >
                    <span>{{ t('daoVoteWatchOnly') }}</span>
                </p>
                <p v-else class="cw-prose" style="margin-top: 12px">
                    {{ t('daoVoteHint') }}
                </p>

                <p
                    v-if="voteError"
                    class="cw-note cw-note-bad"
                    style="margin-top: 12px"
                >
                    <span>{{ voteError }}</span>
                </p>
            </template>

            <p v-else class="cw-note" style="margin-top: 14px">
                <span>{{
                    myVote
                        ? t(
                              myVote.support
                                  ? 'daoClosedVotedFor'
                                  : 'daoClosedVotedAgainst',
                          )
                        : t('daoVoteClosed')
                }}</span>
            </p>

            <div class="cw-label" style="margin: 26px 0 10px">
                {{ t('daoComments', { comments: detail.comments }) }}
            </div>

            <p v-if="commentsState === 'failed'" class="cw-note cw-note-bad">
                <span style="flex: 1">{{ t('daoCommentsUnreadable') }}</span>
                <button
                    type="button"
                    class="cw-back"
                    @click="readComments(detail.id)"
                >
                    {{ t('retry') }}
                </button>
            </p>
            <p
                v-else-if="commentsState === 'loading' && comments.length === 0"
                class="cw-label"
                style="color: var(--cw-faint)"
            >
                {{ t('daoCommentsLoading') }}
            </p>
            <p v-else-if="comments.length === 0" class="cw-prose">
                {{ t('daoCommentsEmpty') }}
            </p>

            <div v-else class="cw-stack" style="gap: 10px">
                <div
                    v-for="comment in comments"
                    :key="comment.id"
                    class="cw-card"
                >
                    <div class="cw-row" style="margin-bottom: 8px">
                        <span class="cw-label" style="color: var(--cw-muted)">{{
                            comment.who?.name ?? t('feedSomeone')
                        }}</span>
                        <span class="cw-label" style="color: var(--cw-faint)">{{
                            relativeTime(seconds(comment.at), locale)
                        }}</span>
                    </div>
                    <!-- The site's own sanitised markdown, as the proposal body. -->
                    <div
                        class="cw-prose"
                        style="font-size: 14px"
                        v-html="comment.bodyHtml"
                    ></div>
                    <div
                        v-if="comment.replies && comment.replies.length > 0"
                        class="cw-stack"
                        style="
                            gap: 10px;
                            margin-top: 12px;
                            padding-left: 12px;
                            border-left: 1px solid var(--cw-hairline);
                        "
                    >
                        <div v-for="reply in comment.replies" :key="reply.id">
                            <div class="cw-row" style="margin-bottom: 6px">
                                <span
                                    class="cw-label"
                                    style="color: var(--cw-muted)"
                                    >{{
                                        reply.who?.name ?? t('feedSomeone')
                                    }}</span
                                >
                                <span
                                    class="cw-label"
                                    style="color: var(--cw-faint)"
                                    >{{
                                        relativeTime(seconds(reply.at), locale)
                                    }}</span
                                >
                            </div>
                            <div
                                class="cw-prose"
                                style="font-size: 14px"
                                v-html="reply.bodyHtml"
                            ></div>
                        </div>
                    </div>
                    <button
                        v-if="canVote"
                        type="button"
                        class="cw-back"
                        style="margin-top: 10px"
                        @click="replyTo = comment"
                    >
                        {{ t('daoCommentReply') }}
                    </button>
                </div>
            </div>

            <form
                class="cw-stack"
                style="gap: 10px; margin-top: 14px"
                @submit.prevent="sendComment"
            >
                <div v-if="replyTo" class="cw-row">
                    <span class="cw-label" style="color: var(--cw-muted)">{{
                        t('daoCommentReplyingTo', {
                            name: replyTo.who?.name ?? t('feedSomeone'),
                        })
                    }}</span>
                    <button
                        type="button"
                        class="cw-back"
                        @click="replyTo = null"
                    >
                        {{ t('cancel') }}
                    </button>
                </div>
                <textarea
                    v-model="commentDraft"
                    class="cw-input"
                    rows="3"
                    maxlength="5000"
                    :placeholder="t('daoCommentPlaceholder')"
                    :aria-label="t('daoCommentPlaceholder')"
                    :disabled="!canVote"
                    style="min-height: 84px; resize: vertical"
                ></textarea>
                <p v-if="!canVote" class="cw-note cw-note-warn">
                    <span>{{ t('daoCommentWatchOnly') }}</span>
                </p>
                <p v-if="commentError" class="cw-note cw-note-bad">
                    <span>{{ commentError }}</span>
                </p>
                <button
                    type="submit"
                    class="cw-btn cw-btn-primary"
                    :disabled="
                        !canVote || commenting || commentDraft.trim() === ''
                    "
                >
                    {{
                        commenting
                            ? t('daoCommentSending')
                            : t('daoCommentSend')
                    }}
                </button>
            </form>
        </template>

        <template v-else>
            <div
                style="
                    display: flex;
                    align-items: baseline;
                    justify-content: space-between;
                    gap: 12px;
                "
            >
                <h2 class="cw-title" style="margin: 0">{{ t('dao') }}</h2>
                <span class="cw-label" style="color: var(--cw-faint)">{{
                    t('daoOpenCount', { count: openProposals })
                }}</span>
            </div>
            <p class="cw-prose" style="margin-top: 8px">{{ t('daoBody') }}</p>
            <div style="display: flex; gap: 10px; margin-top: 16px">
                <button
                    type="button"
                    class="cw-btn cw-btn-primary"
                    style="flex: 1"
                    :aria-expanded="proposing"
                    @click="startProposal"
                >
                    {{ t('daoPropose') }}
                </button>
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="flex: 1"
                    :aria-expanded="creating"
                    @click="
                        creating = !creating;
                        proposing = false;
                    "
                >
                    {{ t('daoCreate') }}
                </button>
            </div>

            <form
                v-if="proposing"
                class="cw-card cw-stack"
                style="gap: 12px; margin-top: 12px"
                @submit.prevent="publishProposal"
            >
                <p v-if="daos.length === 0" class="cw-prose">
                    {{ t('daoProposeNoDao') }}
                </p>
                <template v-else>
                    <label
                        >{{ t('daoProposeIn') }}
                        <select v-model="draft.daoId" class="cw-input" required>
                            <option
                                v-for="entry in daos"
                                :key="entry.id"
                                :value="entry.id"
                            >
                                {{ entry.name }}
                            </option>
                        </select>
                    </label>
                    <label
                        >{{ t('daoProposeTitle') }}
                        <input
                            v-model="draft.title"
                            class="cw-input"
                            maxlength="255"
                            required
                        />
                    </label>
                    <label
                        >{{ t('daoProposeBody') }}
                        <textarea
                            v-model="draft.description"
                            class="cw-input"
                            rows="5"
                            maxlength="10000"
                            style="min-height: 120px; resize: vertical"
                        ></textarea>
                    </label>
                    <div>
                        <div class="cw-label" style="margin-bottom: 8px">
                            {{ t('daoProposeEnds') }}
                        </div>
                        <div style="display: flex; gap: 8px">
                            <button
                                v-for="days in DURATIONS"
                                :key="days"
                                type="button"
                                class="cw-btn"
                                :class="
                                    draft.days === days
                                        ? 'cw-btn-primary'
                                        : 'cw-btn-secondary'
                                "
                                style="flex: 1; padding-inline: 0"
                                :aria-pressed="draft.days === days"
                                @click="draft.days = days"
                            >
                                {{ t('daoProposeDays', { days }) }}
                            </button>
                        </div>
                    </div>
                    <p v-if="!canVote" class="cw-note cw-note-warn">
                        <span>{{ t('daoVoteWatchOnly') }}</span>
                    </p>
                    <p v-else class="cw-prose">{{ t('daoProposeHint') }}</p>
                    <p v-if="proposeError" class="cw-note cw-note-bad">
                        <span>{{ proposeError }}</span>
                    </p>
                    <button
                        type="submit"
                        class="cw-btn cw-btn-primary"
                        :disabled="
                            !canVote ||
                            publishing ||
                            draft.title.trim() === '' ||
                            draft.daoId === null
                        "
                    >
                        {{
                            publishing
                                ? t('daoProposePublishing')
                                : t('daoProposePublish')
                        }}
                    </button>
                </template>
            </form>
            <form
                v-if="creating"
                class="cw-card cw-stack"
                style="gap: 12px; margin-top: 12px"
                @submit.prevent="createDao"
            >
                <label
                    >{{ t('daoName')
                    }}<input v-model="form.name" class="cw-input" required
                /></label>
                <p v-if="form.errors.name" class="cw-note cw-note-bad">
                    {{ form.errors.name }}
                </p>
                <label
                    >{{ t('daoTokenAddress')
                    }}<input v-model="form.address" class="cw-input" required
                /></label>
                <p v-if="form.errors.address" class="cw-note cw-note-bad">
                    {{ form.errors.address }}
                </p>
                <p class="cw-prose">{{ t('daoCreateHint') }}</p>
                <p v-if="createError" class="cw-note cw-note-bad">
                    {{ createError }}
                </p>
                <button
                    type="submit"
                    class="cw-btn cw-btn-primary"
                    :disabled="!signer || signing || form.processing"
                >
                    {{
                        signing || form.processing
                            ? t('daoLoading')
                            : t('daoSignAndCreate')
                    }}
                </button>
            </form>

            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 18px"
            >
                <span style="flex: 1">{{ t('daoUnreadable') }}</span>
                <button type="button" class="cw-back" @click="load">
                    {{ t('retry') }}
                </button>
            </p>

            <p
                v-else-if="loading"
                class="cw-label"
                style="margin-top: 18px; color: var(--cw-faint)"
            >
                {{ t('daoLoading') }}
            </p>

            <template v-else>
                <div
                    v-if="daos.length > 0"
                    style="
                        display: flex;
                        flex-wrap: wrap;
                        gap: 6px;
                        margin-top: 18px;
                    "
                >
                    <span
                        v-for="entry in daos"
                        :key="entry.id"
                        class="cw-label"
                        style="
                            border: 1px solid var(--cw-hairline);
                            padding: 7px 9px;
                            color: var(--cw-muted);
                        "
                        >{{ entry.name }} · {{ entry.proposals }}</span
                    >
                </div>

                <p
                    v-if="proposals.length === 0"
                    class="cw-prose"
                    style="margin-top: 18px"
                >
                    {{ t('daoEmpty') }}
                </p>

                <div
                    v-else
                    class="cw-stack"
                    style="gap: 10px; margin-top: 18px"
                >
                    <button
                        v-for="proposal in proposals"
                        :key="proposal.id"
                        type="button"
                        class="cw-card cw-card-button"
                        @click="open(proposal)"
                    >
                        <div
                            style="
                                display: flex;
                                align-items: center;
                                gap: 10px;
                                margin-bottom: 10px;
                            "
                        >
                            <span
                                class="cw-label"
                                :style="{
                                    color:
                                        proposal.status === 'open'
                                            ? 'var(--cw-ok)'
                                            : 'var(--cw-muted)',
                                }"
                                >{{
                                    proposal.status === 'open'
                                        ? t('daoStatusOpen')
                                        : t('daoStatusClosed')
                                }}</span
                            >
                            <span class="cw-fill"></span>
                            <span
                                class="cw-label"
                                style="color: var(--cw-faint)"
                                >{{ proposal.dao?.name ?? '—' }}</span
                            >
                        </div>
                        <div
                            style="
                                font: 500 16px/1.3 var(--cw-sans);
                                color: var(--cw-text);
                            "
                        >
                            {{ proposal.title }}
                        </div>
                        <p
                            class="cw-prose"
                            style="margin: 8px 0 14px; font-size: 14px"
                        >
                            {{ proposal.summary }}
                        </p>
                        <span class="cw-bar" style="display: flex; height: 6px">
                            <span
                                :style="{
                                    width: `${tally(proposal.powerFor, proposal.powerAgainst).for}%`,
                                    background: 'var(--cw-ok)',
                                }"
                            />
                            <span
                                :style="{
                                    width: `${tally(proposal.powerFor, proposal.powerAgainst).against}%`,
                                    background: 'var(--cw-bad)',
                                }"
                            />
                        </span>
                        <div class="cw-row" style="margin-top: 9px">
                            <span class="cw-label">{{
                                tally(proposal.powerFor, proposal.powerAgainst)
                                    .cast === 0
                                    ? t('daoNoVotes')
                                    : t('daoCastShort', {
                                          votes: proposal.votes,
                                      })
                            }}</span>
                            <span
                                class="cw-label"
                                style="color: var(--cw-faint)"
                                >{{
                                    proposal.endsAt
                                        ? relativeTime(
                                              seconds(proposal.endsAt),
                                              locale,
                                          )
                                        : t('daoNoDeadline')
                                }}</span
                            >
                        </div>
                    </button>
                </div>
            </template>
        </template>
    </div>
</template>
