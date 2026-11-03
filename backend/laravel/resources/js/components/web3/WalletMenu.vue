<script setup lang="ts">
import { router, usePage } from '@inertiajs/vue3';
import {
    Check,
    ChevronDown,
    Contact,
    Download,
    Globe,
    Languages,
    LogOut,
    User,
    Wallet,
} from 'lucide-vue-next';
import { computed, onMounted } from 'vue';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import WalletAvatar from '@/components/web3/WalletAvatar.vue';
import { LOCALE_LABELS, LOCALES, useLocale } from '@/composables/useLocale';
import type { Locale } from '@/composables/useLocale';
import { useSolanaWallet } from '@/composables/useSolanaWallet';
import { useWallet } from '@/composables/useWallet';
import { useWeb3Login } from '@/composables/useWeb3Login';
import { EVM_CHAINS } from '@/lib/evmChains';
import type { EvmChain } from '@/lib/evmChains';
import { mergeWalletChoices } from '@/lib/walletChoices';
import { logout as logoutRoute } from '@/routes';
import { show as profileRoute } from '@/routes/profile';

const page = usePage();

const evmWallet = useWallet();
const solanaWallet = useSolanaWallet();
const web3Login = useWeb3Login();

const isAuthenticated = computed(() => !!page.props.auth?.user);
const authUser = computed(
    () =>
        page.props.auth?.user as
            | {
                  id: number;
                  name?: string;
                  avatar?: string | null;
                  profile_url: string;
                  wallet_address?: string | null;
                  solana_wallet_address?: string | null;
              }
            | undefined,
);

const isAuthenticating = web3Login.isAuthenticating;
const authError = web3Login.error;
const walletChoices = computed(() =>
    mergeWalletChoices(
        evmWallet.walletProviders.value,
        solanaWallet.walletProviders.value,
    ),
);
const installedChoices = computed(() =>
    walletChoices.value.filter((choice) => choice.installed),
);
const suggestedChoices = computed(() =>
    walletChoices.value.filter((choice) => !choice.installed),
);

function openInstall(url?: string) {
    if (url) {
        window.open(url, '_blank', 'noopener');
    }
}

const showNetworkPicker = computed(() => evmWallet.isConnected.value);
const currentChainName = computed(() => {
    const id = evmWallet.chainId.value;

    if (id === null) {
        return 'Network';
    }

    return (
        EVM_CHAINS.find((chain) => chain.chainId === id)?.name ?? `Chain ${id}`
    );
});

// Bound to both @select and @click: reka-ui's select event can get lost for
// items inside a nested SubContent, while a plain DOM click always fires.
// The flag collapses the pair into one switch when both do arrive.
let networkSwitchInFlight = false;

async function switchNetwork(chain: EvmChain) {
    if (networkSwitchInFlight) {
        return;
    }

    networkSwitchInFlight = true;
    authError.value = null;

    try {
        const switched = await evmWallet.switchChain(chain);

        if (!switched && evmWallet.error.value) {
            authError.value = evmWallet.error.value;
        }
    } finally {
        networkSwitchInFlight = false;
    }
}

function refreshWalletChoices() {
    evmWallet.refreshWalletProviders();
    solanaWallet.refreshWalletProviders();
}

const displayAddress = computed(() => {
    const addr =
        authUser.value?.wallet_address ||
        authUser.value?.solana_wallet_address ||
        evmWallet.address.value ||
        solanaWallet.address.value;

    if (!addr) {
        return null;
    }

    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
});

const displayName = computed(
    () => authUser.value?.name || displayAddress.value || 'Profile',
);

// The language switch lives here rather than on any one page: it is a setting
// for the whole site, and `useLocale` keeps a single shared value, so flipping
// it from the header re-renders whichever page is open. The labels come from
// `useLocale` already written in their own language.
const { locale, setLocale } = useLocale();

// The one word this menu says for itself. Everything below it is a language
// name, which is never translated.
const MENU_LABELS: Record<Locale, string> = {
    en: 'Language',
    ru: 'Язык',
    zh: '语言',
};

const connectEvm = (providerId: string) => web3Login.loginWithEvm(providerId);
const connectSolana = (providerId: string) =>
    web3Login.loginWithSolana(providerId);

function signOut() {
    evmWallet.disconnect();
    solanaWallet.disconnect();
    router.post(logoutRoute().url);
}

onMounted(refreshWalletChoices);
</script>

<template>
    <div class="relative">
        <DropdownMenu>
            <DropdownMenuTrigger as-child>
                <Button
                    variant="outline"
                    size="sm"
                    class="gap-2"
                    :aria-label="
                        isAuthenticated ? displayName : 'Connect Wallet'
                    "
                    :disabled="isAuthenticating"
                    @click="refreshWalletChoices"
                >
                    <Spinner v-if="isAuthenticating" class="h-4 w-4" />
                    <WalletAvatar
                        v-else-if="isAuthenticated"
                        :seed="displayAddress"
                        :name="displayName"
                        :src="authUser?.avatar"
                        size="sm"
                    />
                    <Wallet v-else class="h-4 w-4" />
                    <span
                        v-if="isAuthenticated"
                        class="hidden max-w-28 truncate sm:inline"
                        data-replay-mask
                        >{{ displayName }}</span
                    >
                    <span v-else>Connect Wallet</span>
                    <ChevronDown class="h-3 w-3 opacity-60" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-56">
                <template v-if="showNetworkPicker">
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <Globe class="mr-2 h-4 w-4" />
                            {{ currentChainName }}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                            <DropdownMenuItem
                                v-for="chain in EVM_CHAINS"
                                :key="chain.chainId"
                                @select="switchNetwork(chain)"
                                @click="switchNetwork(chain)"
                            >
                                <Check
                                    v-if="
                                        evmWallet.chainId.value ===
                                        chain.chainId
                                    "
                                    class="mr-2 h-4 w-4"
                                />
                                <span v-else class="mr-2 h-4 w-4" />
                                {{ chain.name }}
                                <span
                                    v-if="chain.status === 'wip'"
                                    class="ml-auto text-xs text-muted-foreground"
                                >
                                    WIP
                                </span>
                                <span
                                    v-else-if="chain.status === 'coming_soon'"
                                    class="ml-auto text-xs text-muted-foreground"
                                >
                                    Soon
                                </span>
                            </DropdownMenuItem>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                    <DropdownMenuSeparator />
                </template>
                <template v-if="isAuthenticated">
                    <DropdownMenuItem disabled class="text-xs">
                        <span class="truncate" data-replay-mask>{{
                            displayName
                        }}</span>
                        <span
                            v-if="displayAddress"
                            class="ml-auto font-mono text-[10px] text-muted-foreground"
                            data-replay-mask
                        >
                            {{ displayAddress }}
                        </span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        @select="router.visit(profileRoute().url)"
                    >
                        <User class="mr-2 h-4 w-4" />
                        Private profile
                    </DropdownMenuItem>
                    <DropdownMenuItem
                        v-if="authUser?.profile_url"
                        @select="router.visit(authUser.profile_url)"
                    >
                        <Contact class="mr-2 h-4 w-4" />
                        Public profile
                    </DropdownMenuItem>
                    <DropdownMenuItem @select="signOut">
                        <LogOut class="mr-2 h-4 w-4" />
                        Sign out
                    </DropdownMenuItem>
                </template>
                <template v-else>
                    <template
                        v-for="choice in installedChoices"
                        :key="choice.key"
                    >
                        <DropdownMenuSub v-if="choice.evmId && choice.solanaId">
                            <DropdownMenuSubTrigger>
                                <img
                                    v-if="choice.icon"
                                    :src="choice.icon"
                                    :alt="`${choice.name} icon`"
                                    class="mr-2 h-4 w-4 rounded-sm"
                                />
                                <Wallet v-else class="mr-2 h-4 w-4" />
                                {{ choice.name }}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                <DropdownMenuItem
                                    @select="connectEvm(choice.evmId)"
                                    @click="connectEvm(choice.evmId)"
                                >
                                    EVM · Cyberia
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                    @select="connectSolana(choice.solanaId)"
                                    @click="connectSolana(choice.solanaId)"
                                >
                                    Solana
                                </DropdownMenuItem>
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                        <DropdownMenuItem
                            v-else-if="choice.evmId"
                            @select="connectEvm(choice.evmId)"
                        >
                            <img
                                v-if="choice.icon"
                                :src="choice.icon"
                                :alt="`${choice.name} icon`"
                                class="mr-2 h-4 w-4 rounded-sm"
                            />
                            <Wallet v-else class="mr-2 h-4 w-4" />
                            {{ choice.name }}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            v-else-if="choice.solanaId"
                            @select="connectSolana(choice.solanaId)"
                        >
                            <img
                                v-if="choice.icon"
                                :src="choice.icon"
                                :alt="`${choice.name} icon`"
                                class="mr-2 h-4 w-4 rounded-sm"
                            />
                            <Wallet v-else class="mr-2 h-4 w-4" />
                            {{ choice.name }}
                            <span class="ml-auto text-xs text-muted-foreground">
                                Solana
                            </span>
                        </DropdownMenuItem>
                    </template>
                    <DropdownMenuItem
                        v-if="installedChoices.length === 0"
                        disabled
                    >
                        <Wallet class="mr-2 h-4 w-4" />
                        No wallet detected
                    </DropdownMenuItem>
                    <template v-if="suggestedChoices.length > 0">
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            disabled
                            class="text-xs font-semibold"
                        >
                            Get a wallet
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            v-for="choice in suggestedChoices"
                            :key="choice.key"
                            class="text-muted-foreground"
                            @select="openInstall(choice.installUrl)"
                        >
                            <Wallet class="mr-2 h-4 w-4" />
                            {{ choice.name }}
                            <Download class="ml-auto h-3 w-3 opacity-60" />
                        </DropdownMenuItem>
                    </template>
                </template>

                <!--
                  Outside both branches on purpose: a visitor who has connected
                  nothing is exactly the one most likely to be reading the wrong
                  language.
                -->
                <DropdownMenuSeparator />
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <Languages class="mr-2 h-4 w-4" />
                        {{ MENU_LABELS[locale] }}
                        <span
                            class="ml-auto font-mono text-[10px] text-muted-foreground uppercase"
                        >
                            {{ locale }}
                        </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuItem
                            v-for="option in LOCALES"
                            :key="option"
                            @select="setLocale(option)"
                            @click="setLocale(option)"
                        >
                            <Check
                                v-if="locale === option"
                                class="mr-2 h-4 w-4"
                            />
                            <span v-else class="mr-2 h-4 w-4" />
                            {{ LOCALE_LABELS[option] }}
                        </DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </DropdownMenuContent>
        </DropdownMenu>

        <p
            v-if="authError"
            class="absolute top-full right-0 z-50 mt-1 w-64 rounded-md border bg-popover px-3 py-2 text-xs text-destructive shadow-md"
        >
            {{ authError }}
        </p>
    </div>
</template>
