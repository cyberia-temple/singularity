<script setup lang="ts">
import { MessageSquare } from 'lucide-vue-next';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { growComposer } from '@/lib/wallet/composer';
import { relativeTime, shortAddress } from '@/lib/wallet/format';
import { signInWithWallet } from '@/lib/wallet/session';
import { fetchFeed, publishPost } from '@/lib/wallet/social';
import type { FeedItem } from '@/lib/wallet/social';
import { walletMessages } from '@/lib/walletMessages';

/**
 * What is happening across Cyberia, as one column you can write into.
 *
 * Two sources, because that is what exists: posts people wrote and activity the
 * DAO recorded, merged server-side so this screen does not page two lists
 * against each other.
 *
 * It used to be read-only, with a note at the bottom explaining that a wallet
 * has no account to post from. That was true of the plumbing and false about
 * the wallet: it holds a key, and a key is exactly what an author is. So the
 * composer signs the site's login challenge once — the same press the daily
 * board already offers — and after that this is an ordinary post. Custody does
 * not move; the seed stays in this browser and what the server gets is an
 * address that proved it can sign.
 *
 * Replying is still elsewhere: a post opens on the site, and the person who
 * wrote it can be written to *directly* — the wallet's own encrypted chat is
 * addressed by exactly the address this feed already shows.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** Whether this browser already carries a session. */
    authenticated: boolean;
}>();

const emit = defineEmits<{
    profile: [address: string];
    message: [address: string];
    /** A session was just created, so the page can re-read who it is. */
    signedIn: [];
}>();

const { locale, t } = useLocale(walletMessages);

/** The chain whose key signs the challenge: one address, every EVM network. */
const SIGNING_CHAIN = 'cyberia';

type Tab = 'all' | 'posts' | 'dao';

const TABS: Tab[] = ['all', 'posts', 'dao'];

const tab = ref<Tab>('all');
const items = ref<FeedItem[]>([]);
const loading = ref(true);
const failure = ref(false);

const draft = ref('');
const composer = ref<HTMLTextAreaElement | null>(null);
const posting = ref(false);
const signingIn = ref(false);
const problem = ref<string | null>(null);

watch(draft, () => void nextTick(() => growComposer(composer.value)));

/**
 * The address that would sign, and would be the author.
 *
 * A watch-only account cannot sign anything, so the composer says so rather
 * than offering a press that can only fail.
 */
const signer = computed(
    () =>
        props.wallet.accounts.value.find(
            (account) => account.chain === SIGNING_CHAIN,
        )?.address ?? null,
);

const canSign = computed(
    () =>
        signer.value !== null &&
        props.wallet.activeAccount.value?.kind !== 'watch',
);

/**
 * The activity keys the DAO records, said in the reader's language. An
 * unknown key falls back to itself rather than to nothing — a new activity
 * type should read oddly, not vanish.
 */
const ACTIVITY: Record<string, string> = {
    'proposal.created': 'feedProposalCreated',
    'proposal.closed': 'feedProposalClosed',
    'vote.cast': 'feedVoteCast',
    'comment.posted': 'feedCommentPosted',
};

const describe = (item: FeedItem): string =>
    item.type ? (ACTIVITY[item.type] ? t(ACTIVITY[item.type]) : item.type) : '';

const load = async (): Promise<void> => {
    loading.value = true;
    failure.value = false;

    try {
        items.value = await fetchFeed(tab.value);
    } catch {
        failure.value = true;
        items.value = [];
    } finally {
        loading.value = false;
    }
};

const signIn = async (): Promise<void> => {
    const address = signer.value;

    if (address === null || signingIn.value) {
        return;
    }

    signingIn.value = true;
    problem.value = null;

    try {
        await signInWithWallet(address, (message) =>
            props.wallet.signMessage(SIGNING_CHAIN, message),
        );
        emit('signedIn');
    } catch (error) {
        problem.value = error instanceof Error ? error.message : String(error);
    } finally {
        signingIn.value = false;
    }
};

/**
 * Post, and put the row on top rather than re-reading the list.
 *
 * The server answers with the row it wrote, in the shape this screen already
 * draws — so what appears is what exists, not an optimistic copy that could
 * differ from it.
 */
const publish = async (): Promise<void> => {
    const body = draft.value.trim();

    if (body === '' || posting.value) {
        return;
    }

    posting.value = true;
    problem.value = null;

    try {
        const post = await publishPost(body);

        draft.value = '';
        await nextTick(() => growComposer(composer.value));

        if (tab.value !== 'dao') {
            items.value = [post, ...items.value];
        }
    } catch (error) {
        problem.value = error instanceof Error ? error.message : String(error);
    } finally {
        posting.value = false;
    }
};

watch(tab, load);
onMounted(load);
</script>

<template>
    <div class="cw-stack">
        <h2 class="cw-title" style="margin: 0">{{ t('feed') }}</h2>

        <!--
          The composer, which is the whole difference between a feed and a
          noticeboard. Signed in, it is a box and a button; not signed in, it is
          the one press that makes an author out of a key, under the sentence
          saying what that press does.
        -->
        <div class="cw-card" style="margin-top: 16px; padding: 14px">
            <template v-if="authenticated">
                <textarea
                    ref="composer"
                    v-model="draft"
                    class="cw-textarea"
                    rows="2"
                    style="min-height: 64px"
                    :maxlength="2000"
                    :placeholder="t('feedComposePlaceholder')"
                    :aria-label="t('feedComposePlaceholder')"
                ></textarea>
                <div class="cw-row" style="margin-top: 10px">
                    <span class="cw-label" style="color: var(--cw-faint)">{{
                        t('feedComposeReach')
                    }}</span>
                    <button
                        type="button"
                        class="cw-btn cw-btn-primary"
                        style="width: auto; min-width: 120px; height: 40px"
                        :disabled="draft.trim() === '' || posting"
                        @click="publish"
                    >
                        {{ posting ? t('feedPosting') : t('feedPost') }}
                    </button>
                </div>
            </template>

            <template v-else>
                <p class="cw-prose" style="margin: 0">
                    {{ canSign ? t('feedSignInBody') : t('feedWatchOnly') }}
                </p>
                <button
                    v-if="canSign"
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="margin-top: 12px; height: 44px"
                    :disabled="signingIn"
                    @click="signIn"
                >
                    {{ signingIn ? t('feedSigningIn') : t('feedSignIn') }}
                </button>
            </template>

            <p
                v-if="problem"
                class="cw-note cw-note-bad"
                style="margin-top: 12px"
            >
                <span>{{ problem }}</span>
            </p>
        </div>

        <div class="cw-seg" style="margin-top: 18px">
            <button
                v-for="entry in TABS"
                :key="entry"
                type="button"
                class="cw-seg-item"
                :aria-pressed="tab === entry"
                @click="tab = entry"
            >
                {{
                    t(
                        entry === 'all'
                            ? 'feedTabAll'
                            : entry === 'posts'
                              ? 'feedTabPosts'
                              : 'feedTabDao',
                    )
                }}
            </button>
        </div>

        <p v-if="failure" class="cw-note cw-note-bad" style="margin-top: 18px">
            <span style="flex: 1">{{ t('feedUnreadable') }}</span>
            <button type="button" class="cw-back" @click="load">
                {{ t('retry') }}
            </button>
        </p>

        <p
            v-else-if="loading"
            class="cw-label"
            style="margin-top: 18px; color: var(--cw-faint)"
        >
            {{ t('feedLoading') }}
        </p>

        <p
            v-else-if="items.length === 0"
            class="cw-prose"
            style="margin-top: 18px"
        >
            {{ t('feedEmpty') }}
        </p>

        <div v-else class="cw-stack" style="gap: 12px; margin-top: 18px">
            <article
                v-for="item in items"
                :key="item.id"
                class="cw-card"
                style="padding: 16px"
            >
                <div
                    style="
                        display: flex;
                        align-items: center;
                        gap: 11px;
                        margin-bottom: 12px;
                    "
                >
                    <span
                        style="
                            display: flex;
                            width: 30px;
                            height: 30px;
                            flex: none;
                            align-items: center;
                            justify-content: center;
                            border: 1px solid var(--cw-border-soft);
                            font: 500 12px/1 var(--cw-mono);
                            color: var(--cw-muted);
                        "
                        >{{
                            (item.who?.name ?? '??').slice(0, 2).toUpperCase()
                        }}</span
                    >
                    <div style="flex: 1; min-width: 0">
                        <div
                            style="
                                font: 500 15px/1.2 var(--cw-sans);
                                color: var(--cw-text);
                            "
                        >
                            {{ item.who?.name ?? t('feedSomeone') }}
                        </div>
                        <div
                            class="cw-data"
                            style="
                                margin-top: 3px;
                                font-size: 12px;
                                color: var(--cw-muted);
                            "
                        >
                            <!--
                              An address is the only identity the wallet shares
                              with the feed, so it is also the only handle worth
                              offering as a link to a profile.
                            -->
                            <button
                                v-if="item.who?.address"
                                type="button"
                                class="cw-back"
                                style="
                                    display: inline;
                                    padding: 0;
                                    min-height: 0;
                                    font-size: 12px;
                                "
                                @click="emit('profile', item.who.address)"
                            >
                                {{ shortAddress(item.who.address) }}
                            </button>
                            <span v-else>—</span>
                            ·
                            {{
                                relativeTime(
                                    item.at
                                        ? Math.round(Date.parse(item.at) / 1000)
                                        : null,
                                    locale,
                                )
                            }}
                        </div>
                    </div>
                    <!--
                      Writing to the person rather than about them. The chat is
                      end-to-end encrypted and addressed by exactly the address
                      printed above, so this is one tap and no lookup — it is
                      offered only for a post, since DAO activity is a record
                      rather than somebody talking.
                    -->
                    <button
                        v-if="item.kind === 'post' && item.who?.address"
                        type="button"
                        class="cw-icon-btn cw-icon-btn-bare"
                        :title="t('feedMessage')"
                        :aria-label="t('feedMessage')"
                        @click="emit('message', item.who.address)"
                    >
                        <MessageSquare :size="15" aria-hidden="true" />
                    </button>
                </div>

                <p
                    v-if="item.kind === 'dao'"
                    style="
                        margin: 0;
                        font: 400 15px/1.6 var(--cw-sans);
                        color: var(--cw-body);
                    "
                >
                    <span style="color: var(--cw-accent)">{{
                        describe(item)
                    }}</span>
                    <template v-if="item.text"> — {{ item.text }}</template>
                </p>
                <p
                    v-else
                    style="
                        margin: 0;
                        white-space: pre-wrap;
                        font: 400 15px/1.6 var(--cw-sans);
                        color: var(--cw-body);
                    "
                >
                    {{ item.text }}
                </p>

                <div
                    v-if="item.meta"
                    style="
                        display: flex;
                        align-items: center;
                        gap: 12px;
                        margin-top: 14px;
                        padding-top: 12px;
                        border-top: 1px solid var(--cw-line);
                    "
                >
                    <span class="cw-label">{{ item.meta }}</span>
                </div>
            </article>
        </div>
    </div>
</template>
