<script setup lang="ts">
import {
    ArrowRightLeft,
    CreditCard,
    Download,
    Fuel,
    Handshake,
    Landmark,
    Settings,
    Swords,
} from 'lucide-vue-next';
import WalletPlaces from '@/components/wallet/WalletPlaces.vue';
import type { WalletPlace } from '@/components/wallet/WalletPlaces.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useWalletMode } from '@/composables/useWalletMode';
import { arcadeMessages } from '@/lib/arcadeMessages';
import { hiddenInStore } from '@/lib/storeEdition';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Everything the portfolio does not carry on its face.
 *
 * Nothing here was deleted from the wallet — it was moved one level down. The
 * portfolio's grid holds the fourteen places people actually open; this list
 * is the rest: what does not work end to end yet (buying with a card, marked
 * WIP until a provider is configured), what has no fuel (the gas station),
 * what only works in one build (torrents need the desktop shell), and what has
 * a tab of its own already (the DAO).
 *
 * In simple mode this is also where the places grid lives, so every screen
 * the simple wallet does not list is one tap from the tab bar.
 *
 * The fine print at the bottom is where the price sources went. They were
 * printed under the total on every visit, to everyone, saying nothing about
 * that wallet; they belong on the screen somebody reads when they want to know
 * where a number came from.
 */

defineProps<{
    wallet: MultiWallet;
}>();

const emit = defineEmits<{
    back: [];
    buy: [];
    gas: [];
    otc: [];
    wrap: [];
    torrent: [];
    dao: [];
    preferences: [];
    place: [place: WalletPlace];
}>();

const { t } = useLocale(walletMessages);
const { t: arcadeT } = useLocale(arcadeMessages);

const { simple } = useWalletMode();
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 18px">{{ t('navMore') }}</h2>

        <WalletPlaces
            v-if="simple"
            :places="[
                'tokens',
                'bridge',
                'earn',
                'markets',
                'stocks',
                'crosschain',
                'liquidity',
                'launchpad',
                'dao',
                'nft',
                'lain',
                'browse',
                'domains',
                'analytics',
                'tracker',
                'ipfs',
                'agents',
                'arena',
            ]"
            style="margin-top: 0"
            @place="emit('place', $event)"
        />

        <div class="cw-stack" style="gap: 0">
            <button type="button" class="cw-line-row" @click="emit('wrap')">
                <ArrowRightLeft
                    :size="20"
                    :stroke-width="1.5"
                    aria-hidden="true"
                />
                <span style="flex: 1">{{ t('wrapTitle') }}</span>
                <span class="cw-label">CYBER ↔ WCYBER</span>
            </button>
            <button type="button" class="cw-line-row" @click="emit('buy')">
                <CreditCard :size="20" :stroke-width="1.5" aria-hidden="true" />
                <span style="flex: 1">{{ t('tileBuy') }}</span>
                <span class="cw-label" style="color: var(--cw-faint)">WIP</span>
            </button>
            <button type="button" class="cw-line-row" @click="emit('otc')">
                <Handshake :size="20" :stroke-width="1.5" aria-hidden="true" />
                <span style="flex: 1">{{ t('otcTitle') }}</span>
                <span class="cw-label">P2P</span>
            </button>
            <button type="button" class="cw-line-row" @click="emit('gas')">
                <Fuel :size="20" :stroke-width="1.5" aria-hidden="true" />
                <span style="flex: 1">{{ t('gasStation') }}</span>
            </button>
            <button
                v-if="!hiddenInStore('torrent')"
                type="button"
                class="cw-line-row"
                @click="emit('torrent')"
            >
                <Download :size="20" :stroke-width="1.5" aria-hidden="true" />
                <span style="flex: 1">{{ t('torrentTitle') }}</span>
            </button>
            <button type="button" class="cw-line-row" @click="emit('dao')">
                <Landmark :size="20" :stroke-width="1.5" aria-hidden="true" />
                <span style="flex: 1">{{ t('dao') }}</span>
            </button>
            <button
                v-if="!simple && !hiddenInStore('arena')"
                type="button"
                class="cw-line-row"
                @click="emit('place', 'arena')"
            >
                <Swords :size="20" :stroke-width="1.5" aria-hidden="true" />
                <span style="flex: 1">{{ arcadeT('nav') }}</span>
            </button>
        </div>

        <div class="cw-stack" style="gap: 0; margin-top: 26px">
            <button
                type="button"
                class="cw-line-row"
                @click="emit('preferences')"
            >
                <Settings :size="20" :stroke-width="1.5" aria-hidden="true" />
                <span style="flex: 1">{{ t('navPreferences') }}</span>
            </button>
        </div>

        <p
            class="cw-label"
            style="
                margin-top: 30px;
                color: var(--cw-faint);
                text-transform: none;
                letter-spacing: 0;
            "
        >
            {{ t('priceSource') }}
        </p>
    </div>
</template>
