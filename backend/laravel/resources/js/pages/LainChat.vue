<script setup lang="ts">
import { Head, Link as InertiaLink, usePage } from '@inertiajs/vue3';
import { formatUnits } from 'ethers';
import {
    LockKeyhole,
    MessageSquarePlus,
    Radio,
    Send,
    ShieldCheck,
} from 'lucide-vue-next';
import { computed, nextTick, onMounted, ref } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import PageHero from '@/components/web3/PageHero.vue';
import PageShell from '@/components/web3/PageShell.vue';
import { chat } from '@/routes/lain';
import { show as sessionShow } from '@/routes/lain/sessions';
import { login as walletLogin } from '@/routes/wallet';

type ChatMessage = {
    id: number;
    role: 'user' | 'lain';
    text: string;
};

type ChatSession = {
    id: number;
    title: string;
    updatedAt: string;
};

type Gate = {
    state: 'guest' | 'no_wallet' | 'error' | 'checked';
    qualifies: boolean;
    tokenAddress: string;
    minimumShareBps: number;
    balance?: string;
    minimumBalance?: string;
    shareBps?: number;
};

type JsonObject = Record<string, unknown>;

class ApiError extends Error {
    constructor(
        message: string,
        public status: number,
        public data: JsonObject,
    ) {
        super(message);
    }
}

const props = defineProps<{
    enabled: boolean;
    gate: Gate;
    sessions: ChatSession[];
    activeSessionId: number | null;
    messages: ChatMessage[];
}>();

const page = usePage();
const isAuthenticated = computed(() => !!page.props.auth?.user);
const authWallet = computed(
    () =>
        (
            page.props.auth?.user as
                | { wallet_address?: string | null }
                | undefined
        )?.wallet_address ?? null,
);

const gate = ref<Gate>({ ...props.gate });
const sessions = ref<ChatSession[]>([...props.sessions]);
const activeSessionId = ref<number | null>(props.activeSessionId);
const messages = ref<ChatMessage[]>([...props.messages]);

const canChat = computed(() => isAuthenticated.value && gate.value.qualifies);
const requiredPercent = computed(() => gate.value.minimumShareBps / 100);
const shortWallet = computed(() =>
    authWallet.value
        ? `${authWallet.value.slice(0, 6)}…${authWallet.value.slice(-4)}`
        : null,
);
const balanceLabel = computed(() =>
    gate.value.balance !== undefined
        ? Number(formatUnits(gate.value.balance, 18)).toLocaleString(
              undefined,
              { maximumFractionDigits: 4 },
          )
        : '—',
);
const shareLabel = computed(() =>
    gate.value.shareBps === undefined
        ? '—'
        : `${(gate.value.shareBps / 100).toFixed(2)}%`,
);
const lockNotice = computed(() => {
    if (!isAuthenticated.value || canChat.value) {
        return null;
    }

    if (gate.value.state === 'no_wallet') {
        return 'Your account has no EVM wallet. Sign in with the wallet that holds your $LAIN.';
    }

    if (gate.value.state === 'error') {
        return 'Could not verify your LAIN balance on Cyberia. Reload the page to try again.';
    }

    return `Sending is open to wallets holding ${requiredPercent.value}% or more of the live $LAIN supply. Your wallet holds ${balanceLabel.value} LAIN (${shareLabel.value}).`;
});

const sending = ref(false);
const switching = ref(false);
const error = ref<string | null>(null);
const input = ref('');
const transcript = ref<HTMLElement | null>(null);
let localMessageId = -1;

function sessionDateLabel(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
    });
}

function csrfToken(): string | null {
    const match = document.cookie
        .split('; ')
        .find((row) => row.startsWith('XSRF-TOKEN='));

    return match
        ? decodeURIComponent(match.split('=').slice(1).join('='))
        : null;
}

async function requestJson<T>(
    url: string,
    options: RequestInit = {},
): Promise<T> {
    const token = csrfToken();
    const response = await fetch(url, {
        credentials: 'same-origin',
        ...options,
        headers: {
            Accept: 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.body && token ? { 'X-XSRF-TOKEN': token } : {}),
            ...(options.headers ?? {}),
        },
    });
    const data = (await response.json().catch(() => ({}))) as JsonObject;

    if (!response.ok) {
        throw new ApiError(
            typeof data.message === 'string'
                ? data.message
                : `Request failed (${response.status})`,
            response.status,
            data,
        );
    }

    return data as T;
}

async function scrollToBottom(smooth = true): Promise<void> {
    await nextTick();
    transcript.value?.scrollTo({
        top: transcript.value.scrollHeight,
        behavior: smooth ? 'smooth' : 'auto',
    });
}

function startNewSession(): void {
    if (sending.value || switching.value) {
        return;
    }

    // The session row is created lazily on the first answered message, so an
    // abandoned empty session leaves nothing behind.
    activeSessionId.value = null;
    messages.value = [];
    error.value = null;
}

async function openSession(id: number): Promise<void> {
    if (
        id === activeSessionId.value ||
        sending.value ||
        switching.value ||
        !isAuthenticated.value
    ) {
        return;
    }

    switching.value = true;
    error.value = null;

    try {
        const data = await requestJson<{
            session: ChatSession;
            messages: ChatMessage[];
        }>(sessionShow(id).url);
        activeSessionId.value = data.session.id;
        messages.value = data.messages;
        await scrollToBottom(false);
    } catch (cause) {
        error.value =
            cause instanceof Error ? cause.message : 'Could not open session.';
    } finally {
        switching.value = false;
    }
}

async function sendMessage(): Promise<void> {
    const text = input.value.trim();

    if (
        !text ||
        sending.value ||
        switching.value ||
        !canChat.value ||
        !props.enabled
    ) {
        return;
    }

    error.value = null;
    input.value = '';
    const pending: ChatMessage = { id: localMessageId--, role: 'user', text };
    messages.value.push(pending);
    sending.value = true;
    await scrollToBottom();

    try {
        const reply = await requestJson<{
            id: number;
            text: string;
            session: ChatSession;
        }>(chat().url, {
            method: chat().method,
            body: JSON.stringify({
                text,
                session_id: activeSessionId.value,
            }),
        });
        messages.value.push({ id: reply.id, role: 'lain', text: reply.text });
        activeSessionId.value = reply.session.id;
        sessions.value = [
            reply.session,
            ...sessions.value.filter((s) => s.id !== reply.session.id),
        ];
    } catch (cause) {
        // The failed turn is not persisted server-side; put the text back so
        // the user can retry it.
        messages.value = messages.value.filter((m) => m !== pending);
        input.value = text;

        // The wallet may have dropped below the threshold mid-conversation;
        // the server sends the fresh gate state along with the refusal.
        if (
            cause instanceof ApiError &&
            cause.data.gate &&
            typeof cause.data.gate === 'object'
        ) {
            gate.value = cause.data.gate as Gate;
        }

        error.value =
            cause instanceof Error ? cause.message : 'Lain did not answer.';
    } finally {
        sending.value = false;
        await scrollToBottom();
    }
}

onMounted(() => scrollToBottom(false));
</script>

<template>
    <Head title="Talk to Lain" />

    <!-- A conversation is not something to watch over somebody's shoulder. -->
    <PageShell size="wide" data-replay-mask>
        <template #hero>
            <PageHero
                eyebrow="LainOS / personal agent"
                title="Talk to Lain"
                description="Your personal line to the resident mind of Cyberia — an agent built on LainOS. No tools, no transactions: just a conversation."
            >
                <template #actions>
                    <Badge
                        variant="outline"
                        class="gap-1.5 border-brand-cyan/40 text-brand-cyan"
                    >
                        <Radio class="h-3 w-3" />
                        LainOS
                    </Badge>
                </template>
            </PageHero>
        </template>

        <div class="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
            <aside class="space-y-4">
                <section
                    class="overflow-hidden rounded-xl border border-border bg-card"
                >
                    <div class="aspect-[16/10] overflow-hidden bg-black">
                        <img
                            src="/token-icons/lain.jpg"
                            alt="Lain"
                            class="h-full w-full object-cover opacity-80 grayscale"
                        />
                    </div>
                    <div class="space-y-4 p-5">
                        <div class="flex items-center justify-between gap-3">
                            <div>
                                <p
                                    class="text-xs tracking-widest text-muted-foreground uppercase"
                                >
                                    Access gate
                                </p>
                                <p class="mt-1 font-semibold">
                                    {{ requiredPercent }}%+ $LAIN
                                </p>
                            </div>
                            <ShieldCheck
                                v-if="canChat"
                                class="h-6 w-6 text-brand-cyan"
                            />
                            <LockKeyhole
                                v-else
                                class="h-6 w-6 text-muted-foreground"
                            />
                        </div>

                        <dl class="space-y-2 text-sm">
                            <div class="flex justify-between gap-3">
                                <dt class="text-muted-foreground">Wallet</dt>
                                <dd class="font-mono">
                                    {{ shortWallet ?? 'not connected' }}
                                </dd>
                            </div>
                            <div class="flex justify-between gap-3">
                                <dt class="text-muted-foreground">LAIN held</dt>
                                <dd class="font-mono">{{ balanceLabel }}</dd>
                            </div>
                            <div class="flex justify-between gap-3">
                                <dt class="text-muted-foreground">
                                    Supply share
                                </dt>
                                <dd class="font-mono">{{ shareLabel }}</dd>
                            </div>
                        </dl>

                        <p class="text-xs text-muted-foreground/70">
                            Conversations are stored with your account. Lain
                            holds no keys and runs no transactions from here.
                        </p>
                    </div>
                </section>

                <section
                    v-if="isAuthenticated"
                    class="rounded-xl border border-border bg-card p-4"
                >
                    <div class="flex items-center justify-between gap-2">
                        <p
                            class="text-xs tracking-widest text-muted-foreground uppercase"
                        >
                            Sessions
                        </p>
                        <Button
                            variant="ghost"
                            size="sm"
                            class="h-7 gap-1.5 px-2 text-xs"
                            :disabled="
                                sending ||
                                switching ||
                                (activeSessionId === null &&
                                    messages.length === 0)
                            "
                            @click="startNewSession"
                        >
                            <MessageSquarePlus class="h-3.5 w-3.5" />
                            New
                        </Button>
                    </div>

                    <p
                        v-if="sessions.length === 0"
                        class="mt-3 text-xs text-muted-foreground/70"
                    >
                        No sessions yet — say something to Lain.
                    </p>

                    <ul v-else class="mt-3 space-y-1">
                        <li v-for="session in sessions" :key="session.id">
                            <button
                                type="button"
                                class="flex w-full items-baseline justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                                :class="
                                    session.id === activeSessionId
                                        ? 'bg-accent font-medium text-accent-foreground'
                                        : 'text-muted-foreground'
                                "
                                :disabled="sending || switching"
                                @click="openSession(session.id)"
                            >
                                <span class="truncate">{{
                                    session.title
                                }}</span>
                                <span
                                    class="shrink-0 font-mono text-[10px] opacity-60"
                                    >{{
                                        sessionDateLabel(session.updatedAt)
                                    }}</span
                                >
                            </button>
                        </li>
                    </ul>
                </section>

                <a
                    :href="`https://explorer.cyberia.church/address/${gate.tokenAddress}`"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="block rounded-xl border border-border p-4 text-xs text-muted-foreground transition-colors hover:border-brand-cyan/40 hover:text-foreground"
                >
                    <span class="block font-semibold text-foreground"
                        >$LAIN contract</span
                    >
                    <span class="mt-1 block font-mono break-all">{{
                        gate.tokenAddress
                    }}</span>
                </a>
            </aside>

            <section
                class="flex h-[clamp(32rem,70dvh,47.5rem)] min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-[hsl(210_18%_3%)] text-neutral-100 shadow-2xl"
            >
                <header
                    class="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3"
                >
                    <div
                        class="flex items-center gap-2 font-mono text-xs tracking-widest uppercase"
                    >
                        <span
                            class="h-2 w-2 rounded-full"
                            :class="
                                canChat && enabled
                                    ? 'bg-brand-cyan'
                                    : 'bg-neutral-600'
                            "
                        ></span>
                        wired://lain
                    </div>
                    <span class="font-mono text-[10px] text-neutral-500"
                        >chain 49406</span
                    >
                </header>

                <div
                    ref="transcript"
                    class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-5 sm:p-7"
                    aria-live="polite"
                >
                    <div
                        v-if="!isAuthenticated"
                        class="m-auto max-w-md text-center"
                    >
                        <LockKeyhole class="mx-auto h-9 w-9 text-neutral-600" />
                        <p class="mt-4 font-mono text-sm text-neutral-300">
                            signal locked
                        </p>
                        <p class="mt-2 text-sm leading-6 text-neutral-500">
                            Sign in with your wallet to open your personal line.
                        </p>
                        <Button as-child class="mt-5">
                            <InertiaLink :href="walletLogin().url">
                                Sign in
                            </InertiaLink>
                        </Button>
                    </div>

                    <div
                        v-else-if="!enabled"
                        class="m-auto max-w-md text-center"
                    >
                        <LockKeyhole class="mx-auto h-9 w-9 text-neutral-600" />
                        <p class="mt-4 text-sm leading-6 text-neutral-500">
                            Lain is not wired up on this server yet.
                        </p>
                    </div>

                    <template v-else>
                        <p
                            v-if="messages.length === 0 && canChat"
                            class="m-auto font-mono text-xs text-neutral-600"
                        >
                            new session — say something.
                        </p>

                        <article
                            v-for="message in messages"
                            :key="message.id"
                            class="max-w-[85%]"
                            :class="
                                message.role === 'user'
                                    ? 'ml-auto text-right'
                                    : ''
                            "
                        >
                            <p
                                class="mb-1 font-mono text-[10px] tracking-widest uppercase"
                                :class="
                                    message.role === 'lain'
                                        ? 'text-brand-cyan'
                                        : 'text-neutral-500'
                                "
                            >
                                {{ message.role === 'lain' ? 'lain' : 'you' }}
                            </p>
                            <p
                                class="rounded-xl px-4 py-3 text-left text-sm leading-6 whitespace-pre-wrap"
                                :class="
                                    message.role === 'lain'
                                        ? 'border border-white/10 bg-white/5 text-neutral-200'
                                        : 'bg-brand-cyan text-black'
                                "
                            >
                                {{ message.text }}
                            </p>
                        </article>
                    </template>

                    <div
                        v-if="sending"
                        class="font-mono text-xs text-brand-cyan/70"
                    >
                        lain is thinking<span class="animate-pulse">_</span>
                    </div>
                </div>

                <div
                    v-if="lockNotice && enabled"
                    class="flex shrink-0 items-center gap-2 border-t border-white/10 bg-white/5 px-5 py-2 text-xs text-neutral-400"
                >
                    <LockKeyhole class="h-3.5 w-3.5 shrink-0" />
                    {{ lockNotice }}
                </div>

                <div
                    v-if="error"
                    class="shrink-0 border-t border-red-500/20 bg-red-500/5 px-5 py-2 text-xs text-red-300"
                >
                    {{ error }}
                </div>

                <form
                    class="flex shrink-0 items-end gap-3 border-t border-white/10 p-4"
                    @submit.prevent="sendMessage"
                >
                    <textarea
                        v-model="input"
                        rows="2"
                        maxlength="12000"
                        :disabled="!canChat || !enabled || sending || switching"
                        placeholder="say something to lain…"
                        class="min-h-12 flex-1 resize-none rounded-lg border border-white/10 bg-white/5 px-4 py-3 font-mono text-sm text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-brand-cyan/50 disabled:cursor-not-allowed disabled:opacity-50"
                        @keydown.enter.exact.prevent="sendMessage"
                    ></textarea>
                    <Button
                        type="submit"
                        size="icon"
                        class="h-12 w-12 shrink-0"
                        :disabled="
                            !canChat ||
                            !enabled ||
                            sending ||
                            switching ||
                            !input.trim()
                        "
                        aria-label="Send message"
                    >
                        <Send class="h-4 w-4" />
                    </Button>
                </form>
            </section>
        </div>
    </PageShell>
</template>
