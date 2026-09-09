<script setup lang="ts">
import { ArrowRight, ArrowUpDown, PenLine, Wallet } from 'lucide-vue-next';

import { computed, ref, watch } from 'vue';

import TokenIcon from '@/components/TokenIcon.vue';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
} from '@/components/ui/select';
import { bridgeRoutesList } from '@/lib/addressValidation';
import type { BridgeDirection, BridgeRoute } from '@/lib/addressValidation';
import { tokensForRoute } from '@/lib/bridgeConfig';
import type { BridgeTokenSymbol } from '@/lib/bridgeTokens';

const emit = defineEmits<{
    (e: 'select', direction: BridgeDirection, token: BridgeTokenSymbol): void;
}>();

const props = withDefaults(
    defineProps<{
        availableDirections?: string[];
    }>(),
    {
        availableDirections: () => [],
    },
);

// Chain logos live in public/token-icons/. Chains without a file fall back to a
// lettered gradient avatar (TokenIcon), so this only needs the ones we ship.
const CHAIN_LOGOS: Record<string, string> = {
    solana: '/token-icons/sol.svg',
    cyberia: '/token-icons/cyberia.png',
    yenten: '/token-icons/yenten.png',
    base: '/token-icons/eth.svg',
    bnb: '/token-icons/bnb.svg',
    ton: '/token-icons/ton.svg',
    bitcoin: '/token-icons/btc.svg',
    litecoin: '/token-icons/ltc.svg',
    monero: '/token-icons/monero.svg',
    robinhood: '/token-icons/robinhood.svg',
};

const chainLogo = (chain: string): string | null => CHAIN_LOGOS[chain] ?? null;

// Server config (initBridgeConfig) is authoritative; the static table is the
// pre-init fallback. availableDirections filters to operational routes.
const routes = computed<BridgeRoute[]>(() => {
    const configured = bridgeRoutesList();

    return props.availableDirections.length === 0
        ? configured
        : configured.filter((route) =>
              props.availableDirections.includes(route.direction),
          );
});

const chainLabel = computed<Record<string, string>>(() => {
    const labels: Record<string, string> = {};

    for (const route of routes.value) {
        labels[route.source] = route.sourceLabel;
        labels[route.destination] = route.destinationLabel;
    }

    return labels;
});

const labelFor = (chain: string): string => chainLabel.value[chain] ?? chain;

const uniq = (values: string[]): string[] => [...new Set(values)];

const sourceChains = computed(() =>
    uniq(routes.value.map((route) => route.source)),
);

const from = ref<string>('');
const to = ref<string>('');

const destinationChains = computed(() =>
    uniq(
        routes.value
            .filter((route) => route.source === from.value)
            .map((route) => route.destination),
    ),
);

// A chain is "pending" in a picker when every route through it in that role
// is non-operational: it stays listed (coming-soon tease) but is greyed out
// and cannot be picked. Declared BEFORE the immediate watchers below — they
// call these synchronously during setup, and a later `const` would be a
// silent ReferenceError inside the watcher (Vue swallows it), leaving the
// defaults unset.
const allPending = (candidates: BridgeRoute[]): boolean =>
    candidates.length > 0 &&
    candidates.every((route) => route.operational === false);

const sourcePending = (chain: string): boolean =>
    allPending(routes.value.filter((route) => route.source === chain));

const destinationPending = (chain: string): boolean =>
    allPending(
        routes.value.filter(
            (route) =>
                route.source === from.value && route.destination === chain,
        ),
    );

// Badge text comes from the server's unavailableReason so a corridor teased
// as "Coming soon" reads differently from one mid operator setup.
const pendingLabel = (candidates: BridgeRoute[]): string =>
    candidates.some((route) => route.unavailableReason === 'Coming soon')
        ? 'coming soon'
        : 'setup pending';

const sourcePendingLabel = (chain: string): string =>
    pendingLabel(routes.value.filter((route) => route.source === chain));

const destinationPendingLabel = (chain: string): string =>
    pendingLabel(
        routes.value.filter(
            (route) =>
                route.source === from.value && route.destination === chain,
        ),
    );

watch(
    routes,
    (list) => {
        if (list.length === 0) {
            return;
        }

        // Default to an operational source — pending chains are visible in
        // the picker but disabled, so they must never be auto-selected.
        if (
            !list.some((route) => route.source === from.value) ||
            sourcePending(from.value)
        ) {
            const firstOpen = list.find((route) => route.operational !== false);
            from.value = (firstOpen ?? list[0]).source;
        }
    },
    { immediate: true },
);

watch(
    [from, destinationChains],
    () => {
        if (
            !destinationChains.value.includes(to.value) ||
            destinationPending(to.value)
        ) {
            // Cyberia is the home chain — when it's a valid destination it is
            // always the default.
            const open = destinationChains.value.filter(
                (chain) => !destinationPending(chain),
            );
            to.value =
                (open.includes('cyberia') ? 'cyberia' : open[0]) ??
                destinationChains.value[0] ??
                '';
        }
    },
    { immediate: true },
);

const selectedRoute = computed(
    () =>
        routes.value.find(
            (route) =>
                route.source === from.value && route.destination === to.value,
        ) ?? null,
);

const selectedRouteOperational = computed(
    () => selectedRoute.value?.operational !== false,
);

/**
 * Corridors whose deposit is bound to an address the bridge hands out, rather
 * than to a transaction hash the user copies. Worth saying at this step
 * because it changes what the person is about to be asked for — and on Monero
 * there is no hash to ask for at all, since nobody outside the receiving
 * wallet can look one up.
 */
const oneTimeDepositSource = computed(() =>
    ['yenten', 'monero'].includes(selectedRoute.value?.source ?? ''),
);

// Tokens available on the chosen route — the picker keeps a valid selection as
// the route changes, so the choice made here carries straight into the flow.
const availableTokens = computed<string[]>(() =>
    selectedRoute.value ? tokensForRoute(selectedRoute.value.direction) : [],
);

const token = ref<string>('');

watch(
    availableTokens,
    (list) => {
        if (list.length > 0 && !list.includes(token.value)) {
            token.value = list[0];
        }
    },
    { immediate: true },
);

const canFlip = computed(() =>
    routes.value.some(
        (route) =>
            route.source === to.value &&
            route.destination === from.value &&
            route.operational !== false,
    ),
);

const flip = () => {
    if (!canFlip.value) {
        return;
    }

    [from.value, to.value] = [to.value, from.value];
};

const proceed = () => {
    if (selectedRoute.value && token.value) {
        emit(
            'select',
            selectedRoute.value.direction,
            token.value as BridgeTokenSymbol,
        );
    }
};
</script>

<template>
    <div class="flex w-full flex-col gap-4">
        <div>
            <h2 class="text-lg font-semibold text-foreground">
                Where do you want to bridge?
            </h2>
            <p class="mt-1 text-sm text-muted-foreground">
                Pick the source and destination chains and the token to bridge.
            </p>
        </div>

        <!-- From -->
        <div class="rounded-xl border border-border bg-card p-4">
            <p
                class="mb-2 text-xs font-semibold tracking-widest text-muted-foreground uppercase"
            >
                From
            </p>
            <Select v-model="from">
                <SelectTrigger
                    class="h-auto w-full border-0 bg-transparent p-0 shadow-none hover:opacity-80 focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent"
                >
                    <span class="flex items-center gap-2.5">
                        <TokenIcon
                            :symbol="labelFor(from)"
                            :logo="chainLogo(from)"
                            :size="24"
                        />
                        <span class="text-base font-semibold text-foreground">
                            {{ labelFor(from) }}
                        </span>
                    </span>
                </SelectTrigger>
                <SelectContent>
                    <SelectItem
                        v-for="chain in sourceChains"
                        :key="chain"
                        :value="chain"
                        :disabled="sourcePending(chain)"
                    >
                        <span class="flex items-center gap-2.5">
                            <TokenIcon
                                :symbol="labelFor(chain)"
                                :logo="chainLogo(chain)"
                                :size="22"
                            />
                            {{ labelFor(chain) }}
                            <span
                                v-if="sourcePending(chain)"
                                class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
                            >
                                {{ sourcePendingLabel(chain) }}
                            </span>
                        </span>
                    </SelectItem>
                </SelectContent>
            </Select>
        </div>

        <!-- Swap -->
        <div class="-my-6 flex justify-center">
            <button
                type="button"
                class="z-10 rounded-full border border-border bg-background p-2 transition-transform hover:rotate-180 disabled:cursor-not-allowed disabled:opacity-40"
                :disabled="!canFlip"
                title="Swap direction"
                @click="flip"
            >
                <ArrowUpDown class="h-4 w-4 text-muted-foreground" />
            </button>
        </div>

        <!-- To -->
        <div class="rounded-xl border border-border bg-card p-4">
            <p
                class="mb-2 text-xs font-semibold tracking-widest text-muted-foreground uppercase"
            >
                To
            </p>
            <Select v-model="to">
                <SelectTrigger
                    class="h-auto w-full border-0 bg-transparent p-0 shadow-none hover:opacity-80 focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent"
                >
                    <span class="flex items-center gap-2.5">
                        <TokenIcon
                            :symbol="labelFor(to)"
                            :logo="chainLogo(to)"
                            :size="24"
                        />
                        <span class="text-base font-semibold text-foreground">
                            {{ labelFor(to) }}
                        </span>
                    </span>
                </SelectTrigger>
                <SelectContent>
                    <SelectItem
                        v-for="chain in destinationChains"
                        :key="chain"
                        :value="chain"
                        :disabled="destinationPending(chain)"
                    >
                        <span class="flex items-center gap-2.5">
                            <TokenIcon
                                :symbol="labelFor(chain)"
                                :logo="chainLogo(chain)"
                                :size="22"
                            />
                            {{ labelFor(chain) }}
                            <span
                                v-if="destinationPending(chain)"
                                class="rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase"
                            >
                                {{ destinationPendingLabel(chain) }}
                            </span>
                        </span>
                    </SelectItem>
                </SelectContent>
            </Select>
        </div>

        <!-- Token -->
        <div
            v-if="availableTokens.length > 0"
            class="rounded-xl border border-border bg-card p-4"
        >
            <p
                class="mb-2 text-xs font-semibold tracking-widest text-muted-foreground uppercase"
            >
                Token
            </p>
            <Select v-model="token">
                <SelectTrigger
                    class="h-auto w-full border-0 bg-transparent p-0 shadow-none hover:opacity-80 focus-visible:ring-0 dark:bg-transparent dark:hover:bg-transparent"
                >
                    <span class="flex items-center gap-2.5">
                        <TokenIcon :symbol="token" :size="24" />
                        <span class="text-base font-semibold text-foreground">
                            {{ token }}
                        </span>
                    </span>
                </SelectTrigger>
                <SelectContent>
                    <SelectItem
                        v-for="symbol in availableTokens"
                        :key="symbol"
                        :value="symbol"
                    >
                        <span class="flex items-center gap-2.5">
                            <TokenIcon :symbol="symbol" :size="22" />
                            {{ symbol }}
                        </span>
                    </SelectItem>
                </SelectContent>
            </Select>
        </div>

        <!-- Route hint -->
        <p
            v-if="selectedRoute"
            class="flex items-start gap-2 text-xs text-muted-foreground"
        >
            <PenLine
                v-if="selectedRoute.sourceWallet === 'manual'"
                class="mt-0.5 h-3.5 w-3.5 shrink-0"
            />
            <Wallet v-else class="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
                {{
                    !selectedRouteOperational
                        ? selectedRoute.unavailableReason === 'Coming soon'
                            ? `${selectedRoute.sourceLabel} → ${selectedRoute.destinationLabel} is coming soon — this corridor is not open yet.`
                            : `${selectedRoute.sourceLabel} → ${selectedRoute.destinationLabel} is visible, but operator setup is not complete yet.`
                        : oneTimeDepositSource
                          ? `The bridge gives you an address of your own on ${selectedRoute.sourceLabel}. Send any amount to it from your own wallet — whatever arrives is what gets bridged, and there is no transaction hash to copy.`
                          : selectedRoute.sourceWallet === 'manual'
                            ? selectedRoute.autoProcess
                                ? `Send from any ${selectedRoute.sourceLabel} wallet to the bridge address, then paste the transaction hash — verification and delivery are automatic.`
                                : `Send from any ${selectedRoute.sourceLabel} wallet to the bridge address, then paste the transaction hash — an operator verifies and settles the request.`
                            : `Sign with your ${selectedRoute.sourceLabel} wallet, receive on ${selectedRoute.destinationLabel}.`
                }}
            </span>
        </p>

        <button
            type="button"
            class="group flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 font-medium text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="!selectedRoute || !selectedRouteOperational"
            @click="proceed"
        >
            <span v-if="!selectedRouteOperational">
                {{ selectedRoute?.unavailableReason ?? 'Unavailable' }}
            </span>
            <span v-else>Continue</span>
            <ArrowRight
                class="h-4 w-4 transition-transform group-hover:translate-x-1"
            />
        </button>
    </div>
</template>
