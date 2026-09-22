<script setup lang="ts">
import {
    ArrowLeft,
    Loader2,
    Lock,
    Plus,
    Send,
    ShieldAlert,
    Trash2,
} from 'lucide-vue-next';
import {
    computed,
    nextTick,
    onBeforeUnmount,
    onMounted,
    ref,
    watch,
} from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import {
    chatFingerprint,
    chatKeyStatement,
    chatMessageId,
    clearChat,
    dropChatPending,
    fetchChatEnvelopes,
    fetchChatPeople,
    lookupChatKey,
    markChatKeyVerified,
    markChatRead,
    pinChatKey,
    proveChatAddress,
    publishChatKey,
    queueChatMessage,
    readChatPending,
    readChatState,
    requestChatNonce,
    sendChatEnvelope,
    storeChatRows,
} from '@/lib/wallet';
import type {
    ChatKeyRecord,
    ChatMeta,
    ChatPerson,
    ChatRow,
    PendingMessage,
} from '@/lib/wallet';
import { growComposer } from '@/lib/wallet/composer';
import { shortAddress } from '@/lib/wallet/format';
import {
    announceWalletEvent,
    playWalletSound,
} from '@/lib/wallet/notifications';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Messages between wallets, addressed by EVM address.
 *
 * Everything readable on this screen was decrypted here, from a key that only
 * this device holds. Cyberia relays the envelopes and cannot open one: the
 * conversation key is an ECDH between the two wallets' messaging keys, and
 * neither half has ever been sent anywhere. See lib/wallet/chatCrypto.ts for
 * the construction and what it does and does not promise.
 *
 * Opening the room costs two signatures, and they do different jobs. The first
 * publishes this account's messaging key — an address is a hash and cannot be
 * encrypted to, so a signed key has to exist in a directory before anyone can
 * write to it. The second proves the address to the relay so it will hand over
 * mail addressed to it. Neither moves funds, and the card says so before the
 * hold begins.
 *
 * The screen states the limit as plainly as the guarantee: the relay sees who
 * is talking to whom and when. Content is sealed; metadata is not.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /**
     * Somebody to open a thread with on arrival — an address handed over by
     * another screen, the feed so far. It goes through the same lookup a typed
     * address does, because an address that has never published a messaging key
     * cannot be written to at all and saying so is the whole point of that
     * lookup.
     */
    openWith?: string | null;
}>();

/**
 * `unread` is a nudge, not a number: the count lives in the cache both sides
 * read, and the page re-reads it rather than being told what it is. Emitted
 * whenever mail arrives or a thread is read, since those are the only two
 * things that move the badge.
 */
const emit = defineEmits<{
    unread: [];
    /** The handed-over address has been dealt with, one way or the other. */
    opened: [];
}>();

const { t, tag } = useLocale(walletMessages);

/** How often an open room asks the relay for new envelopes. */
const POLL_MS = 7_000;

type Decrypted = {
    row: ChatRow;
    peer: string;
    mine: boolean;
    /** Null when the envelope would not open — never a guess at its contents. */
    text: string | null;
};

const rows = ref<ChatRow[]>([]);
const opened = ref<Record<string, Decrypted>>({});
const peerKeys = ref<Record<string, ChatKeyRecord>>({});
const suspectPeers = ref<string[]>([]);

const proven = ref(false);
const opening = ref(false);

/**
 * Whether the whole of what this signature means is on screen. Closed by
 * default and never remembered: it is a thing read once, before agreeing.
 */
const detailed = ref(false);
const sending = ref(false);
const syncing = ref(false);
const error = ref<string | null>(null);

const view = ref<'list' | 'thread' | 'new' | 'verify'>('list');
const peer = ref<string | null>(null);
const draft = ref('');
const lookupAddress = ref('');

/**
 * Who there is to write to.
 *
 * The screen used to be an address field and nothing else, which meant a
 * conversation could only be started by somebody who had already copied forty
 * hex characters out of a feed post. The list is the site's own people —
 * accounts with a wallet attached, whose name and address are on a public
 * profile already — and every row says whether that address has opened chat,
 * because an address with no published key cannot be written to at all and
 * that is worth saying before the composer rather than inside it.
 */
const people = ref<ChatPerson[]>([]);
const peopleLoading = ref(false);
const peopleFailed = ref(false);
const peopleQuery = ref('');

const loadPeople = async (): Promise<void> => {
    peopleLoading.value = true;
    peopleFailed.value = false;

    try {
        people.value = await fetchChatPeople(peopleQuery.value.trim());
    } catch {
        peopleFailed.value = true;
        people.value = [];
    } finally {
        peopleLoading.value = false;
    }
};

/** Whoever this wallet is, it is not somebody to write to from here. */
const others = computed(() =>
    people.value.filter(
        (person) => person.address.toLowerCase() !== address.value,
    ),
);

const writeTo = async (person: ChatPerson): Promise<void> => {
    lookupAddress.value = person.address;
    await startThread();
};
const lookupError = ref<string | null>(null);
const lookingUp = ref(false);
const transcript = ref<HTMLElement | null>(null);

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Who this wallet is here. Null for a watched address: it has no key, so it
 * can neither be written to nor write — the same answer it gives to spending.
 */
const identity = computed(() => props.wallet.chatIdentity());

const address = computed(() => identity.value?.address ?? null);

const fingerprint = computed(() =>
    identity.value ? chatFingerprint(identity.value.publicKey) : '',
);

const stage = computed<'noAccount' | 'closed' | 'open'>(() => {
    if (!identity.value) {
        return 'noAccount';
    }

    return proven.value ? 'open' : 'closed';
});

/* ------------------------------------------------------------ decryption --- */

const other = (row: ChatRow, self: string): string =>
    row.from.toLowerCase() === self
        ? row.to.toLowerCase()
        : row.from.toLowerCase();

/**
 * The peer's published key, verified and pinned.
 *
 * `lookupChatKey` refuses anything the address did not sign, so the relay
 * cannot answer with a key of its own. Pinning catches the case a signature
 * cannot: a key that is validly signed but *different* from the one this
 * device has been talking to, which is what an address changing hands — or an
 * attempt at interception — looks like from here.
 */
const keyFor = async (who: string): Promise<ChatKeyRecord | null> => {
    const known = peerKeys.value[who];

    if (known) {
        return known;
    }

    const record = await lookupChatKey(who);

    if (!record) {
        return null;
    }

    if (address.value && pinChatKey(address.value, who, record) === 'changed') {
        suspectPeers.value = [...new Set([...suspectPeers.value, who])];
    }

    peerKeys.value = { ...peerKeys.value, [who]: record };

    return record;
};

const metaOf = (row: ChatRow): ChatMeta => ({
    id: row.id,
    from: row.from,
    to: row.to,
    sentAt: row.sentAt,
});

/**
 * Decrypt whatever has arrived but not yet been opened.
 *
 * Two kinds of failure, kept apart on purpose. Not being able to *reach* the
 * peer's key is a network problem: the row is left alone and tried again on
 * the next poll, because writing it off would turn a flaky connection into a
 * message permanently marked unreadable. An envelope that will not open under
 * a key we do have is a different claim — it is corrupt, or it is not what its
 * metadata says — and the only honest rendering of that is to say so.
 */
const decrypt = async (): Promise<void> => {
    const self = address.value;

    if (!self) {
        return;
    }

    for (const row of rows.value) {
        if (opened.value[row.id]) {
            continue;
        }

        const who = other(row, self);
        let record: ChatKeyRecord | null = null;

        try {
            record = await keyFor(who);
        } catch {
            continue;
        }

        if (!record) {
            continue;
        }

        let text: string | null = null;

        try {
            text = await props.wallet.chatOpen(record.publicKey, metaOf(row), {
                iv: row.iv,
                body: row.body,
            });
        } catch {
            // The row still belongs in the thread: a message that arrived and
            // could not be opened is information too.
            text = null;
        }

        opened.value = {
            ...opened.value,
            [row.id]: {
                row,
                peer: who,
                mine: row.from.toLowerCase() === self,
                text,
            },
        };
    }
};

/* -------------------------------------------------------------- threads --- */

const messages = computed(() =>
    rows.value
        .map((row) => opened.value[row.id])
        .filter((entry): entry is Decrypted => entry !== undefined),
);

/**
 * How far this device has read each thread.
 *
 * Held here as well as in storage because opening a thread has to clear its
 * badge immediately — a computed over localStorage would keep reporting the
 * count until something else happened to invalidate it.
 */
const readMarks = ref<Record<string, number>>({});

/**
 * One row per correspondent, newest first, with what is unread on it.
 *
 * A conversation with nothing delivered in it is still a conversation: a
 * message written to somebody who has not opened chat yet lives in the queue,
 * and if the list only knew about delivered mail, leaving that thread would be
 * the last anybody saw of it. Those rows come first — they are the ones with
 * something still to happen — and carry no `seq`, because nothing in them has
 * been through the relay.
 */
const threads = computed(() => {
    const byPeer = new Map<
        string,
        {
            peer: string;
            last: Decrypted | null;
            unread: number;
            waiting: number;
        }
    >();

    for (const entry of messages.value) {
        const seen = readMarks.value[entry.peer] ?? 0;
        const existing = byPeer.get(entry.peer);
        const unread =
            (existing?.unread ?? 0) +
            (!entry.mine && entry.row.seq > seen ? 1 : 0);

        byPeer.set(entry.peer, {
            peer: entry.peer,
            last: entry,
            unread,
            waiting: existing?.waiting ?? 0,
        });
    }

    for (const entry of pending.value) {
        const existing = byPeer.get(entry.to);

        byPeer.set(entry.to, {
            peer: entry.to,
            last: existing?.last ?? null,
            unread: existing?.unread ?? 0,
            waiting: (existing?.waiting ?? 0) + 1,
        });
    }

    return [...byPeer.values()].sort((a, b) => {
        if (a.waiting > 0 !== b.waiting > 0) {
            return a.waiting > 0 ? -1 : 1;
        }

        return (b.last?.row.seq ?? 0) - (a.last?.row.seq ?? 0);
    });
});

const thread = computed(() =>
    peer.value === null
        ? []
        : messages.value.filter((entry) => entry.peer === peer.value),
);

const peerFingerprint = computed(() => {
    const record = peer.value ? peerKeys.value[peer.value] : null;

    return record ? chatFingerprint(record.publicKey) : '';
});

/* -------------------------------------------------------------- pending --- */

/**
 * Messages written to addresses that cannot yet receive them.
 *
 * Held here rather than refused, because "this address has not opened chat" is
 * something the *recipient* has not done and the sender can do nothing about —
 * a composer that turns that into an error makes the person copy their own
 * sentence somewhere else and come back later, which is the job this is for.
 */
const pending = ref<PendingMessage[]>([]);

const pendingFor = computed(() =>
    peer.value === null
        ? []
        : pending.value.filter((entry) => entry.to === peer.value),
);

const readPending = (): void => {
    pending.value = identity.value
        ? readChatPending(identity.value.address)
        : [];
};

const peerSuspect = computed(
    () => peer.value !== null && suspectPeers.value.includes(peer.value),
);

/** This correspondent has published no key yet, so their mail is waiting. */
const peerKeyMissing = computed(
    () => peer.value !== null && !peerKeys.value[peer.value],
);

/**
 * A held message, read back for the screen.
 *
 * Opened on demand rather than kept in the open: the queue holds ciphertext,
 * and the only place its text belongs is the thread it is drawn in. A message
 * that cannot be opened is shown as such and never as an empty bubble.
 */
const pendingTexts = ref<Record<string, string>>({});

const pendingText = (entry: PendingMessage): string =>
    pendingTexts.value[entry.id] ?? '…';

const openPending = async (): Promise<void> => {
    const me = identity.value;

    if (!me) {
        return;
    }

    for (const entry of pending.value) {
        if (pendingTexts.value[entry.id] !== undefined) {
            continue;
        }

        let text: string;

        try {
            text = await props.wallet.chatOpen(
                me.publicKey,
                {
                    id: entry.id,
                    from: me.address,
                    to: entry.to,
                    sentAt: entry.sentAt,
                },
                entry.envelope,
            );
        } catch {
            text = t('chatUnreadable');
        }

        pendingTexts.value = { ...pendingTexts.value, [entry.id]: text };
    }
};

watch(pending, () => void openPending(), { deep: true });

const short = (value: string): string =>
    `${value.slice(0, 8)}…${value.slice(-6)}`;

const when = (value: string): string => {
    const at = new Date(value);

    return Number.isNaN(at.getTime())
        ? '—'
        : at.toLocaleString(tag.value, {
              day: '2-digit',
              month: '2-digit',
              hour: '2-digit',
              minute: '2-digit',
          });
};

const scrollDown = async (): Promise<void> => {
    await nextTick();

    if (transcript.value) {
        transcript.value.scrollTop = transcript.value.scrollHeight;
    }
};

/* --------------------------------------------------------------- opening --- */

/**
 * Publish this account's key and prove the address, in one deliberate act.
 *
 * Two signatures, because they answer two different questions and are checked
 * by two different parties: the key statement is verified by every wallet that
 * ever writes here, the challenge only by the relay, and folding them into one
 * message would mean either could be replayed as the other.
 */
const open = async (): Promise<void> => {
    const me = identity.value;

    if (!me) {
        return;
    }

    opening.value = true;
    error.value = null;

    try {
        const issuedAt = new Date().toISOString();

        await publishChatKey({
            address: me.address,
            publicKey: me.publicKey,
            issuedAt,
            signature: await props.wallet.signMessage(
                me.chain,
                chatKeyStatement(me.address, me.publicKey, issuedAt),
            ),
        });

        const challenge = await requestChatNonce(me.address);

        await proveChatAddress(
            me.address,
            await props.wallet.signMessage(me.chain, challenge.message),
        );

        proven.value = true;
        await sync();
    } catch (failure) {
        error.value =
            failure instanceof Error ? failure.message : String(failure);
    } finally {
        opening.value = false;
    }
};

/* ----------------------------------------------------------------- sync --- */

const sync = async (): Promise<void> => {
    const self = address.value;

    if (!self || !proven.value || syncing.value) {
        return;
    }

    syncing.value = true;

    try {
        const state = readChatState(self);
        const batch = await fetchChatEnvelopes(state.cursor);

        if (batch.messages.length > 0) {
            const incoming = batch.messages.filter(
                (message) => message.to.toLowerCase() === self.toLowerCase(),
            ).length;

            rows.value = storeChatRows(self, batch.messages).rows;
            await decrypt();

            if (view.value === 'thread' && peer.value) {
                // Arriving in a thread that is open on screen is arriving
                // read; without this the badge would count messages the user
                // is looking at.
                markThreadRead(peer.value);
                await scrollDown();
            }

            emit('unread');

            if (incoming > 0) {
                announceWalletEvent({
                    title: t('chatTitle'),
                    body: t('notificationChatBody', { count: incoming }),
                    sound: 'message',
                    tag: 'wallet-chat',
                });
            }
        }
    } catch (failure) {
        const status = (failure as Error & { status?: number }).status;

        if (status === 403) {
            // The proof aged out. The room is shut until it is signed again,
            // so show it shut rather than silently re-signing with a key the
            // user has not been asked about.
            proven.value = false;
        } else {
            error.value =
                failure instanceof Error ? failure.message : String(failure);
        }
    } finally {
        syncing.value = false;
    }
};

/* -------------------------------------------------------------- pending --- */

/** Keep a message nobody can be sent yet, and show it in the thread. */
const queue = async (to: string, text: string): Promise<void> => {
    const me = identity.value;

    if (!me) {
        return;
    }

    const meta: ChatMeta = {
        id: chatMessageId(),
        from: me.address,
        to,
        sentAt: new Date().toISOString(),
    };

    // Sealed to this wallet's own messaging key: the device keeps ciphertext
    // for mail it has sent and received, and mail it has not sent yet is mail.
    const envelope = await props.wallet.chatSeal(me.publicKey, meta, text);

    pending.value = queueChatMessage(me.address, {
        id: meta.id,
        to,
        sentAt: meta.sentAt,
        envelope,
    });

    draft.value = '';
    await nextTick(() => growComposer(composer.value));
    await scrollDown();
};

/**
 * Try every held message again.
 *
 * Runs on the same beat as the mailbox poll and whenever a thread opens, so a
 * recipient who published a key five minutes ago gets the message without
 * anybody having to notice. A failure is left queued: the alternative is
 * dropping somebody's sentence because a relay had a bad second.
 */
const flushPending = async (): Promise<void> => {
    const me = identity.value;

    if (!me || pending.value.length === 0 || flushing) {
        return;
    }

    flushing = true;

    try {
        for (const entry of [...pending.value]) {
            const record = await keyFor(entry.to);

            if (!record) {
                continue;
            }

            const meta: ChatMeta = {
                id: entry.id,
                from: me.address,
                to: entry.to,
                sentAt: entry.sentAt,
            };

            let text: string;

            try {
                text = await props.wallet.chatOpen(
                    me.publicKey,
                    meta,
                    entry.envelope,
                );
            } catch {
                // Sealed under a key this account no longer has — it was
                // written by a different account on this device. Keeping it
                // would be keeping something nobody can ever read.
                pending.value = dropChatPending(me.address, entry.id);

                continue;
            }

            const envelope = await props.wallet.chatSeal(
                record.publicKey,
                meta,
                text,
            );
            const stored = await sendChatEnvelope({ ...meta, ...envelope });
            const row = (stored as { message: ChatRow }).message;

            rows.value = storeChatRows(me.address, [row]).rows;
            pending.value = dropChatPending(me.address, entry.id);
            await decrypt();
        }
    } catch {
        // Left queued on purpose; the next beat tries again.
    } finally {
        flushing = false;
    }
};

let flushing = false;

/* ----------------------------------------------------------------- send --- */

const send = async (): Promise<void> => {
    const me = identity.value;
    const to = peer.value;
    const text = draft.value.trim();

    if (!me || !to || text === '' || sending.value) {
        return;
    }

    sending.value = true;
    error.value = null;

    try {
        const record = await keyFor(to);

        if (!record) {
            /*
             * Nothing to encrypt to yet, which is a fact about the recipient
             * and not a reason to lose what somebody wrote. The message is
             * kept — sealed to this wallet's own key, so an unsent message is
             * no more readable on this device than a sent one — and goes out
             * by itself the moment that address opens chat.
             */
            await queue(to, text);

            return;
        }

        const meta: ChatMeta = {
            id: chatMessageId(),
            from: me.address,
            to,
            sentAt: new Date().toISOString(),
        };

        const envelope = await props.wallet.chatSeal(
            record.publicKey,
            meta,
            text,
        );

        const stored = await sendChatEnvelope({ ...meta, ...envelope });
        const row = (stored as { message: ChatRow }).message;

        rows.value = storeChatRows(me.address, [row]).rows;
        draft.value = '';
        await decrypt();
        await scrollDown();
        playWalletSound('message');
    } catch (failure) {
        const status = (failure as Error & { status?: number }).status;

        if (status === 403) {
            proven.value = false;
        }

        error.value =
            failure instanceof Error ? failure.message : String(failure);
    } finally {
        sending.value = false;
    }
};

/** The field itself, so the draft can size it. */
const composer = ref<HTMLTextAreaElement | null>(null);

/** Enter sends; Shift+Enter is a newline, as in every chat ever written. */
const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void send();
    }
};

// A sent message empties the field, and an empty field is one line tall again.
watch(draft, () => void nextTick(() => growComposer(composer.value)));

/* ------------------------------------------------------------ navigation --- */

/** Everything currently loaded from this correspondent counts as read. */
const markThreadRead = (who: string): void => {
    const last = messages.value
        .filter((entry) => entry.peer === who)
        .reduce((max, entry) => Math.max(max, entry.row.seq), 0);

    if (address.value && last > 0) {
        markChatRead(address.value, who, last);
        readMarks.value = { ...readMarks.value, [who]: last };
        emit('unread');
    }
};

const openThread = (who: string): void => {
    peer.value = who;
    view.value = 'thread';
    error.value = null;

    markThreadRead(who);
    readVerifications();

    void keyFor(who);
    void flushPending();
    void scrollDown();
};

/**
 * Start a conversation with an address.
 *
 * The key is looked up, but not as a gate: an address that has never opened
 * chat can be written to anyway, and what is written waits for it. The lookup
 * is what lets the thread say so above the composer instead of the composer
 * failing after somebody has typed.
 */
const startThread = async (): Promise<void> => {
    const wanted = lookupAddress.value.trim().toLowerCase();

    lookupError.value = null;

    if (!/^0x[0-9a-f]{40}$/.test(wanted)) {
        lookupError.value = t('chatInvalidAddress');

        return;
    }

    lookingUp.value = true;

    try {
        // Looked up so the thread knows what to say; a miss opens it anyway.
        await keyFor(wanted);

        lookupAddress.value = '';
        openThread(wanted);
    } catch (failure) {
        lookupError.value =
            failure instanceof Error ? failure.message : String(failure);
    } finally {
        lookingUp.value = false;
    }
};

const back = (): void => {
    // The safety number belongs to one thread, so leaving it goes back to that
    // thread rather than all the way out — the same rule every screen opened
    // from another one follows here.
    if (view.value === 'verify') {
        view.value = 'thread';

        return;
    }

    view.value = 'list';
    peer.value = null;
};

/* ------------------------------------------------------------ verifying --- */

/**
 * Peer address → when its safety number was last compared out of band.
 *
 * Held in a ref rather than read on demand because the thread list draws from
 * it too, and localStorage does not tell Vue when it changes. Reloaded
 * whenever a verification is recorded, and whenever the account switches —
 * another account's checks were not about these keys.
 */
const verifiedPeers = ref<Record<string, string>>({});

const readVerifications = (): void => {
    const state = address.value ? readChatState(address.value) : null;

    verifiedPeers.value = Object.fromEntries(
        Object.entries(state?.peers ?? {})
            .filter(([, pin]) => typeof pin.verifiedAt === 'string')
            .map(([who, pin]) => [who, pin.verifiedAt as string]),
    );
};

const peerVerifiedAt = computed(() =>
    peer.value ? (verifiedPeers.value[peer.value.toLowerCase()] ?? null) : null,
);

const openVerify = (): void => {
    readVerifications();
    view.value = 'verify';
};

/**
 * Both halves of the comparison, in the order they are read aloud: this
 * wallet's own number and the peer's. Shown together on one screen because
 * that is how the check is actually performed — each side reads their own and
 * listens for the other.
 */
const fingerprintGroups = computed(() =>
    (peerFingerprint.value || '').split(' ').filter(Boolean),
);

const confirmVerified = (): void => {
    if (!address.value || !peer.value) {
        return;
    }

    if (markChatKeyVerified(address.value, peer.value)) {
        readVerifications();
        // Whatever made this peer suspect has now been settled by two people
        // reading numbers to each other, which is the only thing that can
        // settle it.
        suspectPeers.value = suspectPeers.value.filter(
            (entry) => entry !== peer.value,
        );
    }
};

/** Forget every conversation this account holds on this device. */
const forget = (): void => {
    if (!address.value) {
        return;
    }

    clearChat(address.value);
    rows.value = [];
    pending.value = [];
    opened.value = {};
    view.value = 'list';
    peer.value = null;
};

/* ---------------------------------------------------------------- wiring --- */

const startPolling = (): void => {
    if (timer === null) {
        timer = setInterval(() => {
            void sync();
            // The same beat carries the other direction: a recipient who has
            // published a key since the message was written gets it now.
            void flushPending();
        }, POLL_MS);
    }
};

const stopPolling = (): void => {
    if (timer !== null) {
        clearInterval(timer);
        timer = null;
    }
};

watch(
    address,
    (self) => {
        // A different account is a different mailbox: its proof, its keys and
        // its conversations all belonged to the account before it.
        proven.value = false;
        opened.value = {};
        peerKeys.value = {};
        suspectPeers.value = [];
        view.value = 'list';
        peer.value = null;
        readPending();

        const state = self ? readChatState(self) : null;
        rows.value = state?.rows ?? [];
        readMarks.value = state?.read ?? {};
        readVerifications();

        // Cached envelopes are ciphertext; the wallet is unlocked, so they can
        // be read back now without another round trip to the relay.
        void decrypt();
    },
    { immediate: true },
);

/**
 * An address handed over by another screen.
 *
 * It goes through the same path a typed one does — a key lookup first, then
 * the thread — so "this person has never opened chat" is reported the same way
 * whether the address was typed or tapped. Watched rather than read once,
 * because the chat may already be mounted when the request arrives.
 */
watch(
    () => props.openWith,
    async (wanted) => {
        if (!wanted) {
            return;
        }

        const address = wanted.toLowerCase();

        emit('opened');
        view.value = 'list';
        lookupError.value = null;
        lookingUp.value = true;

        try {
            // Same as a typed address: the key is looked up for what the
            // thread will say, never for whether it may open.
            await keyFor(address);
            openThread(address);
        } catch (failure) {
            lookupError.value =
                failure instanceof Error ? failure.message : String(failure);
        } finally {
            lookingUp.value = false;
        }
    },
    { immediate: true },
);

onMounted(startPolling);
onBeforeUnmount(stopPolling);
</script>

<template>
    <div class="cw-chat">
        <!--
          Only out of a thread. The list is a destination of its own now, and
          the tab bar underneath it is already the way back to everything else.
        -->
        <button
            v-if="view !== 'list'"
            type="button"
            class="cw-back"
            @click="back()"
        >
            <ArrowLeft :size="12" aria-hidden="true" />
            {{ t('chatTitle') }}
        </button>

        <!-- Thread header: who, and the fingerprint to check them against. -->
        <template v-if="view === 'thread' && peer">
            <h2 class="cw-title" style="margin: 18px 0 4px; font-size: 21px">
                {{ short(peer) }}
            </h2>
            <!--
              The number is a link, not a caption: reading it is an act two
              people perform together, and it needs a screen of its own to say
              what a match proves and what it does not.
            -->
            <button
                type="button"
                class="cw-back"
                style="margin-bottom: 14px"
                @click="openVerify()"
            >
                {{
                    peerVerifiedAt
                        ? t('chatVerifiedShort')
                        : t('chatFingerprintLabel')
                }}
                · {{ peerFingerprint || '—' }}
            </button>
        </template>

        <template v-else-if="view === 'verify' && peer">
            <h2 class="cw-title" style="margin: 18px 0 8px">
                {{ t('chatVerifyTitle') }}
            </h2>
        </template>

        <template v-else>
            <h2 class="cw-title" style="margin: 18px 0 8px">
                {{ t('chatTitle') }}
            </h2>
            <p class="cw-prose" style="max-width: 62ch; margin-bottom: 16px">
                {{ t('chatIntro') }}
            </p>
        </template>

        <p v-if="error" class="cw-note cw-note-bad" style="margin-bottom: 14px">
            <span>{{ error }}</span>
        </p>

        <!--
          A watched address holds no key, so it can neither read nor write.
          Same answer this account gets when it tries to spend.
        -->
        <p v-if="stage === 'noAccount'" class="cw-note cw-note-warn">
            <span>{{ t('chatNoAccount') }}</span>
        </p>

        <!-- Not opened yet, or the proof aged out. -->
        <div v-else-if="stage === 'closed'" class="cw-stack" style="gap: 14px">
            <div class="cw-card" style="padding: 18px">
                <div
                    style="
                        display: flex;
                        align-items: center;
                        gap: 9px;
                        margin-bottom: 8px;
                    "
                >
                    <Lock :size="15" aria-hidden="true" />
                    <span class="cw-data">{{ t('chatOpenTitle') }}</span>
                </div>
                <p class="cw-prose" style="max-width: 62ch">
                    {{ t('chatOpenLead') }}
                </p>
                <div class="cw-kv" style="margin-top: 14px">
                    <span class="cw-kv-key">{{ t('chatYourAddress') }}</span>
                    <span class="cw-kv-val">{{ address }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{
                        t('chatFingerprintLabel')
                    }}</span>
                    <span class="cw-kv-val">{{ fingerprint }}</span>
                </div>
                <div style="margin-top: 16px; max-width: 320px">
                    <HoldButton
                        :label="opening ? t('chatOpening') : t('chatOpen')"
                        :disabled="opening"
                        @complete="open()"
                    />
                </div>

                <!--
                  Ninety words of true and careful text used to stand between
                  this screen and its single action, and the result was that
                  people scrolled it — including the forward-secrecy warning,
                  which is the sentence here that most deserves to be read. So
                  the warning is one line that is always on screen, and the
                  full text is kept whole behind a control instead of being
                  unavoidable and therefore skipped.
                -->
                <button
                    type="button"
                    class="cw-back"
                    style="margin-top: 14px"
                    :aria-expanded="detailed"
                    @click="detailed = !detailed"
                >
                    {{ detailed ? t('hideDetails') : t('showDetails') }}
                </button>

                <template v-if="detailed">
                    <p
                        class="cw-prose"
                        style="max-width: 62ch; margin-top: 6px"
                    >
                        {{ t('chatOpenBody') }}
                    </p>
                    <p
                        class="cw-prose"
                        style="max-width: 62ch; margin-top: 10px"
                    >
                        {{ t('chatMetadataNote') }}
                    </p>
                </template>
            </div>
            <p class="cw-prose" style="max-width: 62ch">
                {{ t('chatMetadataShort') }}
            </p>
        </div>

        <!-- Open: the list of correspondents. -->
        <template v-else-if="view === 'list'">
            <div class="cw-row" style="margin-bottom: 10px">
                <span class="cw-label">{{
                    t('chatThreads', { count: threads.length })
                }}</span>
                <span
                    class="cw-label"
                    style="margin-left: auto; color: var(--cw-faint)"
                >
                    <Loader2
                        v-if="syncing"
                        :size="11"
                        class="cw-spin"
                        aria-hidden="true"
                    />
                    {{ syncing ? t('chatSyncing') : t('chatE2ee') }}
                </span>
            </div>

            <button
                type="button"
                class="cw-dashed"
                style="margin-bottom: 14px"
                @click="
                    view = 'new';
                    loadPeople();
                "
            >
                <Plus :size="13" aria-hidden="true" />
                {{ t('chatNew') }}
            </button>

            <p v-if="threads.length === 0" class="cw-prose">
                {{ t('chatEmpty') }}
            </p>

            <button
                v-for="entry in threads"
                :key="entry.peer"
                type="button"
                class="cw-card cw-card-button"
                style="margin-bottom: 8px; text-align: left"
                @click="openThread(entry.peer)"
            >
                <div class="cw-row" style="gap: 10px">
                    <span class="cw-data">{{ short(entry.peer) }}</span>
                    <!--
                      A checked correspondent is marked in the list, because
                      the question "did we ever compare numbers" is asked
                      before opening a thread as often as inside one.
                    -->
                    <span
                        v-if="verifiedPeers[entry.peer]"
                        class="cw-label"
                        style="color: var(--cw-ok)"
                        :title="t('chatVerifiedShort')"
                        >✓</span
                    >
                    <span
                        v-if="entry.unread > 0"
                        class="cw-badge"
                        style="margin-left: auto"
                        >{{ entry.unread }}</span
                    >
                    <span
                        class="cw-label"
                        :style="
                            entry.unread > 0
                                ? undefined
                                : { marginLeft: 'auto' }
                        "
                        >{{
                            entry.last
                                ? when(entry.last.row.sentAt)
                                : t('chatWaiting')
                        }}</span
                    >
                </div>
                <div
                    class="cw-prose"
                    style="
                        margin-top: 6px;
                        overflow: hidden;
                        text-overflow: ellipsis;
                        white-space: nowrap;
                    "
                >
                    <template v-if="!entry.last">{{
                        t('chatWaitingCount', { count: entry.waiting })
                    }}</template>
                    <template v-else-if="entry.last.text === null">{{
                        t('chatUnreadable')
                    }}</template>
                    <template v-else
                        >{{ entry.last.mine ? `${t('chatYou')}: ` : ''
                        }}{{ entry.last.text }}</template
                    >
                </div>
            </button>

            <button
                v-if="threads.length > 0"
                type="button"
                class="cw-back"
                style="margin-top: 16px"
                @click="forget()"
            >
                <Trash2 :size="12" aria-hidden="true" />
                {{ t('chatForget') }}
            </button>
        </template>

        <!-- Open: starting a new conversation. -->
        <div v-else-if="view === 'new'" class="cw-stack" style="gap: 12px">
            <label class="cw-label" for="cw-chat-to">{{
                t('chatAddressLabel')
            }}</label>
            <input
                id="cw-chat-to"
                v-model="lookupAddress"
                class="cw-input"
                spellcheck="false"
                autocomplete="off"
                placeholder="0x…"
                :aria-invalid="lookupError !== null"
                @keydown.enter.prevent="startThread()"
            />
            <p v-if="lookupError" class="cw-note cw-note-warn">
                <span>{{ lookupError }}</span>
            </p>
            <div style="display: flex; gap: 8px">
                <button
                    type="button"
                    class="cw-btn cw-btn-primary"
                    :disabled="lookingUp"
                    @click="startThread()"
                >
                    {{ lookingUp ? t('chatLookingUp') : t('chatStart') }}
                </button>
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    @click="view = 'list'"
                >
                    {{ t('cancel') }}
                </button>
            </div>

            <!--
              And who there is to write to, which is the half this screen was
              missing: an address field alone can only be used by somebody who
              already has the address. A row that has never opened chat is
              still listed and says so — that is the answer to why it cannot be
              written to, and it is better given here than inside a composer.
            -->
            <div class="cw-row" style="margin-top: 14px">
                <span class="cw-label">{{ t('chatPeople') }}</span>
                <button
                    type="button"
                    class="cw-back"
                    :disabled="peopleLoading"
                    @click="loadPeople()"
                >
                    {{ peopleLoading ? t('chatLookingUp') : t('refresh') }}
                </button>
            </div>

            <input
                v-model="peopleQuery"
                class="cw-input"
                type="search"
                spellcheck="false"
                :placeholder="t('chatPeopleSearch')"
                :aria-label="t('chatPeopleSearch')"
                @keydown.enter.prevent="loadPeople()"
            />

            <p
                v-if="peopleFailed"
                class="cw-label"
                style="color: var(--cw-faint)"
            >
                {{ t('chatPeopleFailed') }}
            </p>
            <p
                v-else-if="!peopleLoading && others.length === 0"
                class="cw-label"
                style="color: var(--cw-faint)"
            >
                {{ t('chatPeopleEmpty') }}
            </p>

            <div class="cw-stack" style="gap: 0">
                <button
                    v-for="person in others"
                    :key="person.address"
                    type="button"
                    class="cw-line-row"
                    :disabled="lookingUp"
                    @click="writeTo(person)"
                >
                    <span style="flex: 1; min-width: 0">
                        <span
                            style="
                                display: block;
                                font: 500 16px/1.2 var(--cw-sans);
                            "
                            >{{ person.name }}</span
                        >
                        <span
                            style="
                                display: block;
                                margin-top: 3px;
                                font: 500 13px/1.4 var(--cw-mono);
                                color: var(--cw-dim);
                            "
                            >{{ shortAddress(person.address)
                            }}<template v-if="!person.hasKey">
                                · {{ t('chatPeopleNoKey') }}</template
                            ></span
                        >
                    </span>
                </button>
            </div>

            <p class="cw-prose" style="max-width: 62ch">
                {{ t('chatNewBody') }}
            </p>
        </div>

        <!--
          Open: the safety number.

          The whole screen exists because pinning cannot do this job on its
          own. Pinning says "this is the key I have always talked to"; only two
          people reading the same twelve groups to each other can say "and it
          belongs to you". What the relay could still do — withhold a key, or
          answer for an address nobody has claimed — is what the comparison
          catches, and it is the only thing that does.
        -->
        <div v-else-if="view === 'verify' && peer" class="cw-stack">
            <p class="cw-prose" style="max-width: 62ch">
                {{ t('chatVerifyBody', { peer: short(peer) }) }}
            </p>

            <div
                v-if="fingerprintGroups.length > 0"
                class="cw-card"
                style="margin-top: 16px; padding: 18px"
            >
                <div class="cw-label" style="margin-bottom: 12px">
                    {{ t('chatVerifyTheirs') }}
                </div>
                <div
                    style="
                        display: grid;
                        grid-template-columns: repeat(3, minmax(0, 1fr));
                        gap: 10px;
                    "
                >
                    <span
                        v-for="(group, index) in fingerprintGroups"
                        :key="index"
                        style="
                            font: 500 16px/1 var(--cw-mono);
                            letter-spacing: 0.06em;
                            color: var(--cw-text);
                        "
                    >
                        {{ group }}
                    </span>
                </div>
            </div>

            <p v-else class="cw-note cw-note-warn" style="margin-top: 16px">
                <span>{{ t('chatVerifyNoKey') }}</span>
            </p>

            <div class="cw-card" style="margin-top: 10px; padding: 18px">
                <div class="cw-label" style="margin-bottom: 12px">
                    {{ t('chatVerifyYours') }}
                </div>
                <span class="cw-data" style="word-break: break-all">{{
                    fingerprint || '—'
                }}</span>
            </div>

            <p
                v-if="peerSuspect"
                class="cw-note cw-note-bad"
                style="margin-top: 16px"
            >
                <ShieldAlert :size="13" aria-hidden="true" />
                <span>{{ t('chatVerifyChanged') }}</span>
            </p>

            <!--
              What this conversation actually is, stated where somebody is
              checking it. A static ECDH is not a ratchet and must never be
              drawn as one: whoever learns a key reads that account's whole
              history, and a screen about trust is the wrong place to be vague.
            -->
            <div style="margin-top: 16px; border: 1px solid var(--cw-line)">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('chatVerifyScheme') }}</span>
                    <span class="cw-kv-val">{{
                        t('chatVerifySchemeVal')
                    }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('chatVerifyKey') }}</span>
                    <span class="cw-kv-val">{{ t('chatVerifyKeyVal') }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('chatVerifySecrecy') }}</span>
                    <span class="cw-kv-val" style="color: var(--cw-pending)">{{
                        t('chatVerifySecrecyVal')
                    }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('chatVerifyState') }}</span>
                    <span
                        class="cw-kv-val"
                        :style="{
                            color: peerVerifiedAt
                                ? 'var(--cw-ok)'
                                : 'var(--cw-muted)',
                        }"
                        >{{
                            peerVerifiedAt
                                ? t('chatVerifiedOn', {
                                      when: when(peerVerifiedAt),
                                  })
                                : t('chatVerifyUnchecked')
                        }}</span
                    >
                </div>
            </div>

            <button
                v-if="fingerprintGroups.length > 0 && !peerVerifiedAt"
                type="button"
                class="cw-btn cw-btn-primary"
                style="margin-top: 18px"
                @click="confirmVerified()"
            >
                {{ t('chatVerifyMark') }}
            </button>

            <p class="cw-prose" style="margin-top: 12px; max-width: 62ch">
                {{ t('chatVerifyLocal') }}
            </p>
        </div>

        <!-- Open: one conversation. -->
        <template v-else>
            <p
                v-if="peerSuspect"
                class="cw-note cw-note-warn"
                style="margin-bottom: 12px"
            >
                <ShieldAlert :size="13" aria-hidden="true" />
                <span>{{ t('chatKeyChanged') }}</span>
            </p>

            <!--
              Written to somebody who cannot receive it yet. Said above the
              transcript rather than as an error after the fact: it is a state
              of the correspondent, and it ends by itself.
            -->
            <p
                v-if="peerKeyMissing"
                class="cw-note"
                style="margin-bottom: 12px"
            >
                <span>{{ t('chatWaitingNote') }}</span>
            </p>

            <div ref="transcript" class="cw-chat-log">
                <p
                    v-if="thread.length === 0 && pendingFor.length === 0"
                    class="cw-prose"
                >
                    {{ t('chatThreadEmpty') }}
                </p>

                <div
                    v-for="entry in thread"
                    :key="entry.row.id"
                    class="cw-turn"
                    :class="entry.mine ? 'cw-turn-you' : 'cw-turn-them'"
                >
                    <div class="cw-label" style="margin-bottom: 5px">
                        {{ entry.mine ? t('chatYou') : short(entry.peer) }} ·
                        {{ when(entry.row.sentAt) }}
                    </div>
                    <div
                        class="cw-turn-text"
                        :style="
                            entry.text === null
                                ? { color: 'var(--cw-pending)' }
                                : undefined
                        "
                    >
                        {{
                            entry.text === null
                                ? t('chatUnreadable')
                                : entry.text
                        }}
                    </div>
                </div>

                <!--
                  Held, not lost. It is drawn in the thread where it was
                  written, marked as waiting, and it becomes an ordinary
                  message the moment it can be sent.
                -->
                <div
                    v-for="entry in pendingFor"
                    :key="entry.id"
                    class="cw-turn cw-turn-you"
                    style="opacity: 0.72"
                >
                    <div class="cw-label" style="margin-bottom: 5px">
                        {{ t('chatYou') }} · {{ t('chatWaiting') }}
                    </div>
                    <div class="cw-turn-text">{{ pendingText(entry) }}</div>
                </div>
            </div>

            <form class="cw-chat-form" @submit.prevent="send()">
                <textarea
                    ref="composer"
                    v-model="draft"
                    class="cw-textarea"
                    rows="1"
                    maxlength="2000"
                    :placeholder="t('chatPlaceholder')"
                    :aria-label="t('chatPlaceholder')"
                    @keydown="onKeydown"
                />
                <!--
                  A square, because the field beside it is the part that has
                  to be wide. The word lives in the label a screen reader
                  reads and in the title a pointer finds.
                -->
                <button
                    type="submit"
                    class="cw-btn cw-btn-primary cw-chat-send"
                    :disabled="sending || draft.trim() === ''"
                    :title="sending ? t('chatSending') : t('chatSend')"
                    :aria-label="sending ? t('chatSending') : t('chatSend')"
                >
                    <Loader2
                        v-if="sending"
                        :size="15"
                        class="cw-spin"
                        aria-hidden="true"
                    />
                    <Send v-else :size="15" aria-hidden="true" />
                </button>
            </form>

            <p
                class="cw-label"
                style="margin-top: 10px; color: var(--cw-faint)"
            >
                {{ t('chatStored') }}
            </p>
        </template>
    </div>
</template>
