<script setup lang="ts">
import { Moon, Sun, SunMoon } from 'lucide-vue-next';
import { computed, ref, watch } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useWalletTheme } from '@/composables/useWalletTheme';
import {
    accountDisplayName,
    accountKindLabel,
    formatUnits,
    walletChain,
} from '@/lib/wallet';
import type { WalletChainId } from '@/lib/wallet';
import { formatUsd, formatUsdPrice, usdValue } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The bar above every screen: which account, which network, at what price.
 *
 * Both of those are questions the whole rest of the page is an answer to, so
 * they are answered where the answer can also be changed — not on a settings
 * screen two taps away. Until this existed the only way to change either was to
 * leave the screen you were on: accounts through a list, networks by opening a
 * card in the portfolio.
 *
 * The panels expand *in the flow* rather than floating over it. A menu that
 * overlays would be clipped by the shell's own `overflow: hidden`, and on a
 * phone an overlay is the one shape that cannot be dismissed by scrolling.
 *
 * The network half is hidden where the screen is not about one network: above
 * the feed or the DAO it would be answering a question nobody asked.
 */

const props = defineProps<{
    wallet: MultiWallet;
    chain: WalletChainId;
    prices: Record<string, number | null>;
    /** Whether the screen underneath belongs to a single network. */
    showNetwork: boolean;
}>();

const emit = defineEmits<{
    pick: [chain: WalletChainId];
    accounts: [];
    addNetwork: [];
    refresh: [];
}>();

const { locale, t } = useLocale(walletMessages);

/*
 * Light or dark, answered on the bar that already answers which account and
 * which network. It is chrome and not a setting: a wallet whose theme lives two
 * taps into Security is a wallet nobody discovers has one.
 *
 * The icon names the state the wallet is *in*, not the one the button goes to —
 * a control that shows its own destination reads as a description of the
 * current screen and gets pressed to stay put. The title says both.
 */
const { theme, cycleTheme } = useWalletTheme();

const themeIcon = computed(() => {
    if (theme.value === 'system') {
        return SunMoon;
    }

    return theme.value === 'dark' ? Moon : Sun;
});

const themeLabel = computed(() => {
    if (theme.value === 'system') {
        return t('themeSystem');
    }

    return theme.value === 'dark' ? t('themeDark') : t('themeLight');
});

const open = ref<'account' | 'network' | null>(null);

const toggle = (panel: 'account' | 'network'): void => {
    open.value = open.value === panel ? null : panel;
};

// Whatever the user just chose, the panel has said its piece. Leaving it open
// over a screen that has already changed underneath reads as a control that
// did nothing.
watch(
    () => [props.chain, props.wallet.activeAccountId.value] as const,
    () => {
        open.value = null;
    },
);

// A network that stops being relevant takes its open panel with it.
watch(
    () => props.showNetwork,
    (shown) => {
        if (!shown && open.value === 'network') {
            open.value = null;
        }
    },
);

const activeRecord = computed(() => props.wallet.activeAccount.value);

const accountLabel = computed(() =>
    activeRecord.value
        ? accountDisplayName(activeRecord.value, t)
        : t('accountPrimaryName'),
);

const accountKind = computed(() =>
    activeRecord.value ? accountKindLabel(activeRecord.value, t) : '',
);

const accountRows = computed(() =>
    props.wallet.accountRecords.value.map((record) => ({
        record,
        name: accountDisplayName(record, t),
        kind: accountKindLabel(record, t),
        active: record.id === props.wallet.activeAccountId.value,
    })),
);

/** The active account's networks, each with what it holds. */
const networkRows = computed(() =>
    props.wallet.accounts.value.map((account) => {
        const balance = props.wallet.balances.value[account.chain];

        return {
            account,
            active: account.chain === props.chain,
            amount:
                balance?.value === undefined || balance?.value === null
                    ? null
                    : formatUnits(balance.value, account.decimals, 4),
            usd: usdValue(
                balance?.value ?? null,
                account.decimals,
                props.prices[account.chain] ?? null,
            ),
        };
    }),
);

const activeAccount = computed(
    () =>
        props.wallet.accounts.value.find(
            (account) => account.chain === props.chain,
        ) ?? null,
);

/**
 * The rate for the network in the bar. It is here rather than only inside the
 * network screen because it is the number the balances above and below are
 * quoted at, and a wallet that shows a value without ever showing its price is
 * a wallet that looks like it has no price.
 */
const price = computed(() => props.prices[props.chain] ?? null);

const chainTag = computed(() => {
    try {
        return walletChain(props.chain).mark.tag;
    } catch {
        return '';
    }
});

const pick = (next: WalletChainId): void => {
    emit('pick', next);
    open.value = null;
};

const use = async (id: string): Promise<void> => {
    open.value = null;

    if (id === props.wallet.activeAccountId.value) {
        return;
    }

    try {
        await props.wallet.switchAccount(id);
    } catch {
        // The vault auto-locked between drawing this row and tapping it. The
        // lock screen is already up; there is nothing to report on a bar that
        // has just been replaced.
    }
};
</script>

<template>
    <div class="cw-context">
        <div class="cw-context-bar">
            <button
                type="button"
                class="cw-chip"
                :class="{ 'cw-chip-on': open === 'account' }"
                :aria-expanded="open === 'account'"
                @click="toggle('account')"
            >
                <span class="cw-chip-mark">
                    <span
                        style="
                            width: 5px;
                            height: 5px;
                            background: var(--cw-accent);
                        "
                    />
                </span>
                <span style="min-width: 0">
                    <span class="cw-chip-name">{{ accountLabel }}</span>
                    <span class="cw-chip-sub">{{ accountKind }}</span>
                </span>
                <span class="cw-chip-chev">{{
                    open === 'account' ? '▴' : '▾'
                }}</span>
            </button>

            <button
                v-if="showNetwork"
                type="button"
                class="cw-chip cw-chip-tight"
                :class="{ 'cw-chip-on': open === 'network' }"
                :aria-expanded="open === 'network'"
                @click="toggle('network')"
            >
                <NetworkMark :chain="chain" dot :size="7" />
                <span class="cw-chip-net">{{
                    activeAccount?.symbol ?? chainTag
                }}</span>
                <span class="cw-chip-chev">{{
                    open === 'network' ? '▴' : '▾'
                }}</span>
            </button>

            <span
                v-if="showNetwork && price !== null"
                class="cw-context-rate"
                :title="t('priceSource')"
            >
                1 {{ activeAccount?.symbol }} =
                {{ formatUsdPrice(price, locale) }}
            </span>

            <span class="cw-fill"></span>

            <!--
              Only where re-reading the chains changes something on screen.
              Above the feed or the DAO this button would spend a round of RPC
              calls to redraw nothing.
            -->
            <button
                v-if="showNetwork"
                type="button"
                class="cw-back"
                style="letter-spacing: 0.12em"
                @click="emit('refresh')"
            >
                {{ t('refresh') }}
            </button>

            <button
                type="button"
                class="cw-context-theme"
                :title="themeLabel"
                :aria-label="themeLabel"
                @click="cycleTheme()"
            >
                <component :is="themeIcon" :size="15" aria-hidden="true" />
            </button>
        </div>

        <!-- Accounts -->
        <div v-if="open === 'account'" class="cw-panel">
            <div class="cw-row" style="margin-bottom: 9px">
                <span class="cw-label"
                    >{{ t('accounts') }} · {{ accountRows.length }}</span
                >
                <button
                    type="button"
                    class="cw-panel-close"
                    @click="open = null"
                >
                    ✕
                </button>
            </div>

            <div class="cw-panel-list">
                <button
                    v-for="row in accountRows"
                    :key="row.record.id"
                    type="button"
                    class="cw-pick"
                    :class="{ 'cw-pick-on': row.active }"
                    :aria-current="row.active ? 'true' : undefined"
                    @click="use(row.record.id)"
                >
                    <span class="cw-pick-mark">{{
                        row.active ? '●' : '○'
                    }}</span>
                    <span style="flex: 1; min-width: 0">
                        <span class="cw-chip-name">{{ row.name }}</span>
                        <span class="cw-chip-sub">{{ row.kind }}</span>
                    </span>
                    <span v-if="row.active" class="cw-label">{{
                        t('accountActive')
                    }}</span>
                </button>
            </div>

            <button
                type="button"
                class="cw-ghost"
                style="width: 100%; margin-top: 8px"
                @click="
                    open = null;
                    emit('accounts');
                "
            >
                {{ t('accounts') }}
            </button>
        </div>

        <!-- Networks -->
        <div v-else-if="open === 'network'" class="cw-panel">
            <div class="cw-row" style="margin-bottom: 9px">
                <span class="cw-label"
                    >{{ t('networks') }} · {{ networkRows.length }}</span
                >
                <button
                    type="button"
                    class="cw-panel-close"
                    @click="open = null"
                >
                    ✕
                </button>
            </div>

            <div class="cw-panel-list">
                <button
                    v-for="row in networkRows"
                    :key="row.account.chain"
                    type="button"
                    class="cw-pick"
                    :class="{ 'cw-pick-on': row.active }"
                    :aria-current="row.active ? 'true' : undefined"
                    @click="pick(row.account.chain)"
                >
                    <NetworkMark :chain="row.account.chain" :size="24" />
                    <span style="flex: 1; min-width: 0">
                        <span class="cw-chip-name">{{
                            row.account.label
                        }}</span>
                        <span class="cw-chip-sub"
                            >{{ row.amount ?? '—' }}
                            {{ row.account.symbol }}</span
                        >
                    </span>
                    <span class="cw-pick-usd">{{
                        formatUsd(row.usd, locale)
                    }}</span>
                </button>
            </div>

            <button
                type="button"
                class="cw-ghost cw-ghost-dashed"
                style="width: 100%; margin-top: 8px"
                @click="
                    open = null;
                    emit('addNetwork');
                "
            >
                + {{ t('addNetwork') }}
            </button>
        </div>
    </div>
</template>
