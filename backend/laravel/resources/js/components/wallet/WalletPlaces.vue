<script setup lang="ts">
import {
    ArrowLeftRight,
    Bot,
    BrainCircuit,
    CalendarCheck,
    CandlestickChart,
    Coins,
    Compass,
    Droplets,
    Globe,
    HardDrive,
    Images,
    Landmark,
    LineChart,
    Magnet,
    MoreHorizontal,
    Percent,
    PieChart,
    Rocket,
    Route,
    Swords,
} from 'lucide-vue-next';
import { computed } from 'vue';
import type { Component } from 'vue';
import { useLocale } from '@/composables/useLocale';
import { arcadeMessages } from '@/lib/arcadeMessages';
import { visibleInStore } from '@/lib/storeEdition';
import { tradingArenaMessages } from '@/lib/tradingArenaMessages';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The grid of places a balance leads to — under the balance in full mode, and
 * on the More screen in simple mode, where it is how everything the simple
 * wallet does not list is still one tap away.
 */
export type WalletPlace =
    | 'tokens'
    | 'markets'
    | 'stocks'
    | 'bridge'
    | 'crosschain'
    | 'earn'
    | 'liquidity'
    | 'launchpad'
    | 'browse'
    | 'domains'
    | 'daily'
    | 'analytics'
    | 'tracker'
    | 'ipfs'
    | 'dao'
    | 'nft'
    | 'lain'
    | 'arena'
    | 'agents'
    | 'more';

const props = defineProps<{
    places: WalletPlace[];
}>();

/** A store build of the mobile app leaves some places out (`lib/storeEdition.ts`). */
const shown = computed(() => visibleInStore(props.places));

const emit = defineEmits<{
    place: [place: WalletPlace];
}>();

const { t } = useLocale(walletMessages);
const { t: arcadeT } = useLocale(arcadeMessages);
const { t: agentsT } = useLocale(tradingArenaMessages);

const PLACES: Record<WalletPlace, { icon: Component; label: () => string }> = {
    tokens: { icon: Coins, label: () => t('tokens') },
    markets: { icon: LineChart, label: () => t('markets') },
    stocks: { icon: CandlestickChart, label: () => t('stocks') },
    bridge: { icon: Route, label: () => t('bridgeTitle') },
    crosschain: { icon: ArrowLeftRight, label: () => t('tileCross') },
    earn: { icon: Percent, label: () => t('earnTitle') },
    liquidity: { icon: Droplets, label: () => t('tilePools') },
    launchpad: { icon: Rocket, label: () => t('tabLaunch') },
    browse: { icon: Compass, label: () => t('browseTitle') },
    domains: { icon: Globe, label: () => t('domainsTitle') },
    daily: { icon: CalendarCheck, label: () => t('tileDaily') },
    analytics: { icon: PieChart, label: () => t('navAnalytics') },
    tracker: { icon: Magnet, label: () => t('trackerTitle') },
    ipfs: { icon: HardDrive, label: () => t('ipfsTitle') },
    dao: { icon: Landmark, label: () => t('dao') },
    nft: { icon: Images, label: () => t('nftTitle') },
    lain: { icon: Bot, label: () => t('navLain') },
    arena: { icon: Swords, label: () => arcadeT('nav') },
    agents: { icon: BrainCircuit, label: () => agentsT('nav') },
    more: { icon: MoreHorizontal, label: () => t('navMore') },
};
</script>

<template>
    <div class="cw-quick">
        <button
            v-for="place in shown"
            :key="place"
            type="button"
            class="cw-quick-item"
            @click="emit('place', place)"
        >
            <component
                :is="PLACES[place].icon"
                :size="20"
                :stroke-width="1.5"
                aria-hidden="true"
            />
            <span>{{ PLACES[place].label() }}</span>
        </button>
    </div>
</template>
