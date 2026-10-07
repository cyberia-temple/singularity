<script setup lang="ts">
import {
    CreditCard,
    Download,
    Fuel,
    Landmark,
    Settings,
} from 'lucide-vue-next';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
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
    torrent: [];
    dao: [];
    preferences: [];
}>();

const { t } = useLocale(walletMessages);
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 18px">{{ t('navMore') }}</h2>

        <div class="cw-stack" style="gap: 0">
            <button type="button" class="cw-line-row" @click="emit('buy')">
                <CreditCard :size="20" :stroke-width="1.5" aria-hidden="true" />
                <span style="flex: 1">{{ t('tileBuy') }}</span>
                <span class="cw-label" style="color: var(--cw-faint)">WIP</span>
            </button>
            <button type="button" class="cw-line-row" @click="emit('gas')">
                <Fuel :size="20" :stroke-width="1.5" aria-hidden="true" />
                <span style="flex: 1">{{ t('gasStation') }}</span>
            </button>
            <button type="button" class="cw-line-row" @click="emit('torrent')">
                <Download :size="20" :stroke-width="1.5" aria-hidden="true" />
                <span style="flex: 1">{{ t('torrentTitle') }}</span>
            </button>
            <button type="button" class="cw-line-row" @click="emit('dao')">
                <Landmark :size="20" :stroke-width="1.5" aria-hidden="true" />
                <span style="flex: 1">{{ t('dao') }}</span>
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
