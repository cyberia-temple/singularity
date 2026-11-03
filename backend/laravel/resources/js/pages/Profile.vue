<script setup lang="ts">
import { Head, Link, router, useForm, usePage } from '@inertiajs/vue3';
import { useTimeAgo } from '@vueuse/core';
import {
    ArrowRightLeft,
    AtSign,
    Camera,
    Check,
    Compass,
    Copy,
    Droplets,
    HandCoins,
    Repeat2,
    Settings,
    Trophy,
    Wallet,
    Waypoints,
} from 'lucide-vue-next';
import { computed, ref } from 'vue';
import ProgressPanel from '@/components/progress/ProgressPanel.vue';
import PostCard from '@/components/social/PostCard.vue';
import PostComposer from '@/components/social/PostComposer.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import SimplePagination from '@/components/web3/SimplePagination.vue';
import WalletAvatar from '@/components/web3/WalletAvatar.vue';
import { useSolanaWallet } from '@/composables/useSolanaWallet';
import { useWallet } from '@/composables/useWallet';
import { useWalletAuth } from '@/composables/useWalletAuth';
import { moneroAddressKind, moneroKindLabel } from '@/lib/monero';
import { bridge } from '@/routes';
import {
    avatar as avatarRoute,
    edit as profileEdit,
    nickname as nicknameRoute,
} from '@/routes/profile';
import { check as achievementsCheck } from '@/routes/profile/achievements';
import type { Auth } from '@/types/auth';
import type { Paginated } from '@/types/pagination';
import type { Progress } from '@/types/progress';
import type { Post } from '@/types/social';

type DepositChain = {
    key: string;
    label: string;
    type: string;
    addressType: string;
    address: string | null;
    /** CEX-style address issued to this user alone (BTC/LTC/YTN/XMR). */
    personal: boolean;
    oneTime: boolean;
    /** Addresses issued to accounts merged into this one, most recent first. */
    history: string[];
};

type Achievement = {
    id: number;
    key: string;
    title: string;
    description: string;
    icon: string;
    earned: boolean;
};

const props = defineProps<{
    depositChains: DepositChain[];
    /** CyberiaProfile contract address; null while not deployed/configured. */
    profileContract: string | null;
    /** Current on-chain nickname of the linked EVM wallet. */
    nickname: string | null;
    achievements: Achievement[];
    posts: Paginated<Post>;
    /** Level, streak and the live quest board (GamificationService). */
    progress: Progress;
}>();

const page = usePage<{ auth: Auth }>();
const user = computed(() => page.props.auth.user);
const avatarInput = ref<HTMLInputElement | null>(null);
const avatarForm = useForm<{ avatar: File | null }>({ avatar: null });

function uploadAvatar(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;

    if (!file) {
        return;
    }

    avatarForm.avatar = file;
    avatarForm.post(avatarRoute().url, {
        forceFormData: true,
        preserveScroll: true,
        onSuccess: () => avatarForm.reset(),
    });
}

const ACHIEVEMENT_ICONS: Record<string, unknown> = {
    swap: ArrowRightLeft,
    bridge: Waypoints,
    liquidity: Droplets,
    convert: Repeat2,
    lend: HandCoins,
    nickname: AtSign,
    pioneer: Compass,
};

const nicknameForm = useForm({ nickname: props.nickname ?? '' });

function saveNickname() {
    nicknameForm.patch(nicknameRoute().url, { preserveScroll: true });
}

const checkForm = useForm({});

function checkAchievements() {
    checkForm.post(achievementsCheck().url, { preserveScroll: true });
}

const achievementsFlash = computed(() => {
    const status = (page.props as { flash?: { status?: string } }).flash
        ?.status;

    if (status === 'achievements-none') {
        return 'No new achievements yet — keep exploring Cyberia.';
    }

    if (status?.startsWith('achievements-awarded:')) {
        return `Unlocked ${status.split(':')[1]} new achievement(s) on-chain!`;
    }

    return null;
});

const earnedCount = computed(
    () => props.achievements.filter((a) => a.earned).length,
);

const joinedAgo = useTimeAgo(computed(() => user.value.created_at ?? ''));

const displayName = computed(
    () =>
        user.value.name ||
        (user.value.wallet_address
            ? user.value.wallet_address.slice(0, 6) +
              '…' +
              user.value.wallet_address.slice(-4)
            : `User #${user.value.id}`),
);

const wallets = computed(() =>
    [
        { key: 'evm', label: 'EVM', address: user.value.wallet_address },
        {
            key: 'solana',
            label: 'Solana',
            address: user.value.solana_wallet_address,
        },
    ].filter((wallet) => !!wallet.address),
);

// Link a self-custodial wallet to this account so on-chain nicknames,
// achievements and reads bind to it. The user is already authenticated
// (email/X), so this attaches rather than logs in.
const evmWallet = useWallet();
const solanaWallet = useSolanaWallet();
const walletAuth = useWalletAuth();

const linking = ref<'evm' | 'solana' | null>(null);
const linkError = ref<string | null>(null);
const linkNotice = ref<string | null>(null);

async function connectEvm() {
    if (linking.value) {
        return;
    }

    linking.value = 'evm';
    linkError.value = null;
    linkNotice.value = null;

    try {
        const address = await evmWallet.connect();

        if (!address) {
            return;
        }

        const { nonce } = await walletAuth.generateNonce(address);
        const signature = await evmWallet.signMessage(
            `Sign this message to link your wallet. Nonce: ${nonce}`,
        );

        if (!signature) {
            return;
        }

        const result = await walletAuth.attachEvmWallet(address, signature);

        if (result.merged) {
            linkNotice.value =
                'This wallet belonged to another account — we merged its history into this one.';
        }

        router.reload();
    } catch (e) {
        linkError.value =
            e instanceof Error ? e.message : 'Failed to link EVM wallet.';
    } finally {
        linking.value = null;
    }
}

async function connectSolana() {
    if (linking.value) {
        return;
    }

    linking.value = 'solana';
    linkError.value = null;
    linkNotice.value = null;

    try {
        const address = await solanaWallet.connect();

        if (!address) {
            return;
        }

        const { nonce } = await walletAuth.generateSolanaNonce(address);
        const signature = await solanaWallet.signMessage(
            `Sign this message to link your wallet. Nonce: ${nonce}`,
        );

        if (!signature) {
            return;
        }

        const result = await walletAuth.attachSolanaWallet(address, signature);

        if (result.merged) {
            linkNotice.value =
                'This wallet belonged to another account — we merged its history into this one.';
        }

        router.reload();
    } catch (e) {
        linkError.value =
            e instanceof Error ? e.message : 'Failed to link Solana wallet.';
    } finally {
        linking.value = null;
    }
}

// Monero wallet. Not a connect flow: Monero has no browser extension and no
// in-browser message signing, so the user types a native address and we keep
// it as a payout destination only — it never authenticates and is never
// treated as the EVM XMR wrapper, which is a different asset on Cyberia.
const moneroInput = ref(user.value.monero_wallet_address ?? '');
const moneroSaving = ref(false);
const moneroError = ref<string | null>(null);

const moneroKind = computed(() =>
    moneroInput.value.trim() ? moneroAddressKind(moneroInput.value) : null,
);

const moneroInputInvalid = computed(
    () => moneroInput.value.trim().length > 0 && moneroKind.value === null,
);

const moneroUnchanged = computed(
    () => moneroInput.value.trim() === (user.value.monero_wallet_address ?? ''),
);

async function saveMonero() {
    if (moneroSaving.value || !moneroKind.value) {
        return;
    }

    moneroSaving.value = true;
    moneroError.value = null;

    try {
        await walletAuth.attachMoneroWallet(moneroInput.value.trim());
        router.reload();
    } catch (e) {
        moneroError.value =
            e instanceof Error ? e.message : 'Failed to save Monero wallet.';
    } finally {
        moneroSaving.value = false;
    }
}

async function removeMonero() {
    if (moneroSaving.value) {
        return;
    }

    moneroSaving.value = true;
    moneroError.value = null;

    try {
        await walletAuth.detachMoneroWallet();
        moneroInput.value = '';
        router.reload();
    } catch (e) {
        moneroError.value =
            e instanceof Error ? e.message : 'Failed to remove Monero wallet.';
    } finally {
        moneroSaving.value = false;
    }
}

const copiedKey = ref<string | null>(null);

async function copy(key: string, value: string | null | undefined) {
    if (!value) {
        return;
    }

    await navigator.clipboard.writeText(value);
    copiedKey.value = key;
    setTimeout(() => {
        if (copiedKey.value === key) {
            copiedKey.value = null;
        }
    }, 1500);
}
</script>

<template>
    <Head title="Profile" />

    <!-- Deposit addresses and the person's own wallets: never in a recording. -->
    <div class="mx-auto max-w-4xl px-4 py-8" data-replay-mask>
        <!-- Profile hero -->
        <header
            class="mb-6 flex flex-col items-start gap-4 rounded-lg border border-border/70 bg-card p-6 sm:flex-row sm:items-center"
        >
            <div class="flex shrink-0 flex-col items-center gap-2">
                <WalletAvatar
                    :seed="user.wallet_address"
                    :name="user.name"
                    :src="user.avatar"
                    size="lg"
                />
                <input
                    ref="avatarInput"
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp"
                    class="sr-only"
                    @change="uploadAvatar"
                />
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    :disabled="avatarForm.processing"
                    @click="avatarInput?.click()"
                >
                    <Camera class="h-3.5 w-3.5" />
                    {{ avatarForm.processing ? 'Uploading…' : 'Avatar' }}
                </Button>
                <p
                    v-if="avatarForm.errors.avatar"
                    class="max-w-36 text-center text-xs text-destructive"
                >
                    {{ avatarForm.errors.avatar }}
                </p>
            </div>
            <div class="min-w-0 flex-1">
                <h1 class="text-2xl font-extrabold tracking-tight">
                    {{ displayName }}
                </h1>
                <div class="mt-1 flex flex-wrap items-center gap-2">
                    <template v-for="wallet in wallets" :key="wallet.key">
                        <Badge
                            variant="secondary"
                            class="max-w-full font-mono text-xs"
                        >
                            <span class="truncate">{{ wallet.address }}</span>
                        </Badge>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            :aria-label="`Copy ${wallet.label} wallet address`"
                            @click="
                                copy(`wallet-${wallet.key}`, wallet.address)
                            "
                        >
                            <Check
                                v-if="copiedKey === `wallet-${wallet.key}`"
                                class="h-3.5 w-3.5 text-brand-cyan"
                            />
                            <Copy v-else class="h-3.5 w-3.5" />
                        </Button>
                    </template>
                    <Button
                        v-if="!user.wallet_address"
                        variant="outline"
                        size="sm"
                        :disabled="linking === 'evm'"
                        @click="connectEvm"
                    >
                        <Wallet class="h-3.5 w-3.5" />
                        {{ linking === 'evm' ? 'Connecting…' : 'Connect EVM' }}
                    </Button>
                    <Button
                        v-if="!user.solana_wallet_address"
                        variant="outline"
                        size="sm"
                        :disabled="linking === 'solana'"
                        @click="connectSolana"
                    >
                        <Wallet class="h-3.5 w-3.5" />
                        {{
                            linking === 'solana'
                                ? 'Connecting…'
                                : 'Connect Solana'
                        }}
                    </Button>
                    <span
                        v-if="user.twitter_username || user.twitter_id"
                        class="text-xs text-muted-foreground"
                    >
                        X: @{{ user.twitter_username ?? user.twitter_id }}
                    </span>
                    <span
                        v-if="user.github_username || user.github_id"
                        class="text-xs text-muted-foreground"
                    >
                        GitHub: @{{ user.github_username ?? user.github_id }}
                    </span>
                    <span
                        v-if="user.telegram_username || user.telegram_id"
                        class="text-xs text-muted-foreground"
                    >
                        Telegram: @{{
                            user.telegram_username ?? user.telegram_id
                        }}
                    </span>
                    <span
                        v-if="user.created_at"
                        class="text-xs text-muted-foreground"
                    >
                        joined {{ joinedAgo }}
                    </span>
                </div>
                <p v-if="linkError" class="mt-2 text-xs text-destructive">
                    {{ linkError }}
                </p>
                <p v-if="linkNotice" class="mt-2 text-xs text-muted-foreground">
                    {{ linkNotice }}
                </p>
            </div>
            <div class="flex shrink-0 gap-2">
                <Button variant="outline" size="sm" as-child>
                    <Link :href="user.profile_url">Public profile</Link>
                </Button>
                <Button variant="outline" size="sm" as-child>
                    <Link :href="profileEdit()">
                        <Settings class="h-3.5 w-3.5" />
                        Settings
                    </Link>
                </Button>
            </div>
        </header>

        <!-- Off-chain progression: level, streak, quest board. Sits above the
             on-chain identity block because it changes every day, while badges
             and nicknames are claimed once. -->
        <div class="mb-6">
            <ProgressPanel :progress="props.progress" />
        </div>

        <section class="mb-6 space-y-3">
            <div class="flex items-center justify-between gap-3">
                <h2
                    class="text-sm font-semibold tracking-widest text-muted-foreground uppercase"
                >
                    Your wall
                </h2>
                <Link
                    :href="user.profile_url"
                    class="text-xs text-brand-cyan hover:underline"
                >
                    Open public profile
                </Link>
            </div>
            <PostComposer />
            <PostCard
                v-for="post in props.posts.data"
                :key="post.id"
                :post="post"
            />
            <p
                v-if="props.posts.data.length === 0"
                class="rounded-lg border border-dashed py-10 text-center text-sm text-muted-foreground"
            >
                Your wall is empty. Write the first post.
            </p>
            <SimplePagination :paginator="props.posts" />
        </section>

        <!-- On-chain identity: nickname + achievements (CyberiaProfile) -->
        <section v-if="props.profileContract" class="mb-6 space-y-3">
            <h2
                class="text-sm font-semibold tracking-widest text-muted-foreground uppercase"
            >
                On-chain identity
            </h2>

            <!-- Nickname -->
            <div
                class="flex flex-col gap-3 rounded-lg border border-border/70 bg-card p-4"
            >
                <div class="flex items-center gap-2">
                    <AtSign class="h-4 w-4 text-brand-cyan" />
                    <span class="text-sm font-semibold">Nickname</span>
                    <Badge
                        variant="outline"
                        class="text-[10px] tracking-widest uppercase"
                    >
                        on-chain
                    </Badge>
                </div>
                <p class="text-xs text-muted-foreground">
                    Globally unique, stored in the CyberiaProfile contract on
                    Cyberia. Lowercase letters, digits and underscores, 3–20
                    characters. The relayer pays the gas.
                </p>
                <form
                    class="flex flex-col gap-2 sm:flex-row sm:items-center"
                    @submit.prevent="saveNickname"
                >
                    <Input
                        v-model="nicknameForm.nickname"
                        type="text"
                        placeholder="your_nickname"
                        maxlength="20"
                        class="font-mono sm:max-w-64"
                        :disabled="!user.wallet_address"
                    />
                    <Button
                        type="submit"
                        size="sm"
                        :disabled="
                            nicknameForm.processing ||
                            !user.wallet_address ||
                            !nicknameForm.nickname ||
                            nicknameForm.nickname === (props.nickname ?? '')
                        "
                    >
                        {{ nicknameForm.processing ? 'Minting…' : 'Save' }}
                    </Button>
                    <span
                        v-if="props.nickname"
                        class="text-xs text-muted-foreground"
                    >
                        current: @{{ props.nickname }}
                    </span>
                </form>
                <p
                    v-if="nicknameForm.errors.nickname"
                    class="text-xs text-destructive"
                >
                    {{ nicknameForm.errors.nickname }}
                </p>
                <div
                    v-if="!user.wallet_address"
                    class="flex flex-wrap items-center gap-2"
                >
                    <Button
                        variant="outline"
                        size="sm"
                        :disabled="linking === 'evm'"
                        @click="connectEvm"
                    >
                        <Wallet class="h-3.5 w-3.5" />
                        {{
                            linking === 'evm'
                                ? 'Connecting…'
                                : 'Connect EVM wallet'
                        }}
                    </Button>
                    <span class="text-xs text-muted-foreground">
                        Nicknames live on-chain — connect a wallet to claim one.
                    </span>
                </div>
            </div>

            <!-- Achievements -->
            <div
                class="flex flex-col gap-3 rounded-lg border border-border/70 bg-card p-4"
            >
                <div class="flex flex-wrap items-center gap-2">
                    <Trophy class="h-4 w-4 text-brand-cyan" />
                    <span class="text-sm font-semibold">Achievements</span>
                    <Badge
                        variant="outline"
                        class="text-[10px] tracking-widest uppercase"
                    >
                        {{ earnedCount }}/{{ props.achievements.length }}
                    </Badge>
                    <div class="ml-auto flex items-center gap-2">
                        <span
                            v-if="achievementsFlash"
                            class="text-xs text-muted-foreground"
                        >
                            {{ achievementsFlash }}
                        </span>
                        <Button
                            variant="outline"
                            size="sm"
                            :disabled="
                                checkForm.processing || !user.wallet_address
                            "
                            @click="checkAchievements"
                        >
                            {{
                                checkForm.processing
                                    ? 'Checking…'
                                    : 'Check for new'
                            }}
                        </Button>
                    </div>
                </div>
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <div
                        v-for="achievement in props.achievements"
                        :key="achievement.id"
                        class="flex items-start gap-3 rounded-lg border p-3"
                        :class="
                            achievement.earned
                                ? 'border-brand-cyan/50 bg-brand-cyan/5'
                                : 'border-border/70 opacity-50'
                        "
                    >
                        <component
                            :is="ACHIEVEMENT_ICONS[achievement.icon] ?? Trophy"
                            class="mt-0.5 h-5 w-5 shrink-0"
                            :class="
                                achievement.earned
                                    ? 'text-brand-cyan'
                                    : 'text-muted-foreground'
                            "
                        />
                        <div class="min-w-0">
                            <p class="text-sm font-semibold">
                                {{ achievement.title }}
                            </p>
                            <p class="text-xs text-muted-foreground">
                                {{ achievement.description }}
                            </p>
                        </div>
                    </div>
                </div>
                <p class="text-xs text-muted-foreground">
                    Badges are minted to your wallet in the CyberiaProfile
                    contract — verifiable by anyone on the Cyberia explorer.
                </p>
            </div>
        </section>

        <!-- Monero wallet: a native XMR address, kept apart from the EVM and
             Solana wallets above because it cannot sign and never logs in. -->
        <section class="mb-6 space-y-3">
            <h2
                class="text-sm font-semibold tracking-widest text-muted-foreground uppercase"
            >
                Monero wallet
            </h2>
            <div
                class="flex flex-col gap-3 rounded-lg border border-border/70 bg-card p-4"
            >
                <div class="flex flex-wrap items-center gap-2">
                    <Wallet class="h-4 w-4 text-brand-cyan" />
                    <span class="text-sm font-semibold"
                        >Native XMR address</span
                    >
                    <Badge
                        v-if="moneroKind"
                        variant="outline"
                        class="text-[10px] tracking-widest uppercase"
                    >
                        {{ moneroKindLabel(moneroKind) }}
                    </Badge>
                </div>
                <p class="text-xs text-muted-foreground">
                    Monero is its own chain, not a token on Cyberia: paste a
                    native address (4… standard or integrated, 8… subaddress).
                    It is used to pre-fill your bridge payouts. There is no
                    “connect” step — Monero wallets cannot sign a message in a
                    browser, so this address is stored for payouts only and
                    never signs you in.
                </p>
                <form
                    class="flex flex-col gap-2 sm:flex-row sm:items-center"
                    @submit.prevent="saveMonero"
                >
                    <Input
                        v-model="moneroInput"
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        placeholder="4… or 8…"
                        maxlength="106"
                        class="font-mono text-xs sm:flex-1"
                        :aria-invalid="moneroInputInvalid"
                    />
                    <Button
                        type="submit"
                        size="sm"
                        :disabled="
                            moneroSaving || !moneroKind || moneroUnchanged
                        "
                    >
                        {{ moneroSaving ? 'Saving…' : 'Save' }}
                    </Button>
                    <Button
                        v-if="user.monero_wallet_address"
                        type="button"
                        variant="outline"
                        size="sm"
                        :disabled="moneroSaving"
                        @click="removeMonero"
                    >
                        Remove
                    </Button>
                </form>
                <p v-if="moneroInputInvalid" class="text-xs text-destructive">
                    Not a valid Monero address — the built-in checksum does not
                    match, so check for a typo.
                </p>
                <p v-else-if="moneroError" class="text-xs text-destructive">
                    {{ moneroError }}
                </p>
            </div>
        </section>

        <!-- Deposit addresses -->
        <section class="space-y-3">
            <h2
                class="text-sm font-semibold tracking-widest text-muted-foreground uppercase"
            >
                Deposit addresses
            </h2>
            <p class="text-sm text-muted-foreground">
                Addresses marked
                <Badge
                    variant="outline"
                    class="mx-0.5 align-middle text-[10px] tracking-widest text-brand-cyan uppercase"
                    >personal</Badge
                >
                are issued to you alone, like on an exchange — anything sent
                there is credited to your account. Networks without one yet will
                get a unique per-user address soon; until then, deposit through
                the
                <Link
                    :href="bridge()"
                    class="text-foreground underline underline-offset-4"
                    >Bridge</Link
                >
                page so your transfer is matched to a request.
            </p>
            <div
                v-for="chain in props.depositChains"
                :key="chain.key"
                class="flex flex-col gap-2 rounded-lg border border-border/70 bg-card p-4 sm:flex-row sm:items-center"
            >
                <div class="flex w-44 shrink-0 flex-wrap items-center gap-2">
                    <span class="text-sm font-semibold">{{ chain.label }}</span>
                    <Badge
                        variant="outline"
                        class="text-[10px] tracking-widest uppercase"
                    >
                        {{ chain.addressType }}
                    </Badge>
                    <Badge
                        v-if="chain.personal"
                        variant="outline"
                        class="text-[10px] tracking-widest text-brand-cyan uppercase"
                    >
                        personal
                    </Badge>
                </div>
                <div class="flex min-w-0 flex-1 items-center gap-2">
                    <template v-if="chain.address">
                        <code
                            class="min-w-0 font-mono text-xs break-all text-foreground/90"
                        >
                            {{ chain.address }}
                        </code>
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            class="shrink-0"
                            :aria-label="`Copy ${chain.label} deposit address`"
                            @click="copy(`chain-${chain.key}`, chain.address)"
                        >
                            <Check
                                v-if="copiedKey === `chain-${chain.key}`"
                                class="h-3.5 w-3.5 text-brand-cyan"
                            />
                            <Copy v-else class="h-3.5 w-3.5" />
                        </Button>
                    </template>
                    <p
                        v-else-if="chain.oneTime"
                        class="text-xs text-muted-foreground"
                    >
                        One-time address — a unique deposit address is issued
                        for each request on the
                        <Link
                            :href="bridge()"
                            class="text-foreground underline underline-offset-4"
                            >Bridge</Link
                        >
                        page.
                    </p>
                    <p v-else class="text-xs text-muted-foreground">
                        A unique deposit address for your account is coming
                        soon. For now, deposit via the
                        <Link
                            :href="bridge()"
                            class="text-foreground underline underline-offset-4"
                            >Bridge</Link
                        >
                        page.
                    </p>
                </div>
                <p
                    v-if="chain.key === 'monero' && chain.address"
                    class="w-full text-xs text-muted-foreground sm:pl-44"
                >
                    Integrated address: it is the bridge wallet plus a payment
                    id that belongs to you, so a deposit from any Monero wallet
                    is credited to your account. Paste it whole — the payment id
                    lives inside it, there is nothing extra to fill in.
                </p>
                <p
                    v-if="chain.history.length"
                    class="w-full text-xs text-muted-foreground sm:pl-44"
                >
                    Also used previously (merged account):
                    <code
                        v-for="address in chain.history"
                        :key="address"
                        class="mr-1 font-mono break-all"
                        >{{ address }}</code
                    >
                </p>
            </div>
        </section>
    </div>
</template>
