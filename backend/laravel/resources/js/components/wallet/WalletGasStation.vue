<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AddressField from '@/components/wallet/AddressField.vue';
import StatusPill from '@/components/wallet/StatusPill.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useSecureClipboard } from '@/composables/useSecureClipboard';
import { formatUnits, walletChain } from '@/lib/wallet';
import { formatUsd, usdValue } from '@/lib/wallet/format';
import {
    SPONSORED_CHAIN,
    dailyShare,
    dripsLeft,
    gasSponsorStatus,
    requestGas,
    sponsorReasonKey,
    stationState,
} from '@/lib/wallet/gas';
import type { SponsorReason, SponsorStatus } from '@/lib/wallet/gas';
import { walletMessages } from '@/lib/walletMessages';

/**
 * The gas station, in full.
 *
 * Everywhere else in this wallet the station appears the moment it is needed
 * and says one thing — "the fee here can be paid for you". That is the right
 * shape for someone mid-transaction and the wrong one for the two questions
 * left over: what is this thing, and why did it say no to me. Both are
 * answered here, where nobody is waiting to sign.
 *
 * What is on screen is what exists. The contract's own bounds — the drip, the
 * cooldown, the balance ceiling, the day's allowance — are read from it rather
 * than restated from config, because they are what actually holds against a
 * stolen sponsor key, and a page quoting a number the chain no longer agrees
 * with would be describing a different station.
 *
 * There is deliberately no fee-source picker, no paymaster and no auto top-up.
 * Cyberia has one mechanism: an address is handed coin and then signs its own
 * transaction, unchanged. Drawing alternatives that do not exist would promise
 * a wallet that cannot be built without touching every signing path here.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** Chain id → USD, for saying what the tank and the fees are worth. */
    prices: Record<string, number | null>;
}>();

const emit = defineEmits<{ back: [] }>();

const { locale, t } = useLocale(walletMessages);

const clipboard = useSecureClipboard();

const chain = walletChain(SPONSORED_CHAIN);

const account = computed(
    () =>
        props.wallet.accounts.value.find(
            (entry) => entry.chain === SPONSORED_CHAIN,
        ) ?? null,
);

const balance = computed(
    () => props.wallet.balances.value[SPONSORED_CHAIN]?.value ?? null,
);

const price = computed(() => props.prices[SPONSORED_CHAIN] ?? null);

const status = ref<SponsorStatus | null>(null);
const loading = ref(true);

type Phase = 'idle' | 'asking' | 'sent';

const phase = ref<Phase>('idle');
/** A refusal from the claim itself, which outranks the one from the status. */
const refusal = ref<SponsorReason | null>(null);

/** Seconds this address still has to wait, ticked down locally. */
const cooldown = ref(0);
let ticker: ReturnType<typeof setInterval> | null = null;

const read = async (): Promise<void> => {
    loading.value = true;
    status.value = await gasSponsorStatus(account.value?.address);
    cooldown.value = status.value.address?.cooldownRemaining ?? 0;
    loading.value = false;
};

/**
 * Unlike the inline offer, this screen asks on sight: someone who opened it
 * came to find out where they stand, and an empty page with a button that
 * says "check" would be one tap of theatre.
 */
onMounted(() => {
    void read();

    // What a transfer costs is quoted for the same reason the station exists:
    // the drip is only meaningful next to the fee it is meant to cover.
    void props.wallet.refreshFees(SPONSORED_CHAIN);

    ticker = setInterval(() => {
        if (cooldown.value > 0) {
            cooldown.value -= 1;

            // Nothing changes on the second the wait ends unless the station
            // is asked again — so it is.
            if (cooldown.value === 0) {
                void read();
            }
        }
    }, 1000);
});

onBeforeUnmount(() => {
    if (ticker !== null) {
        clearInterval(ticker);
    }
});

/** Switching accounts switches the subject: the old answer was about someone else. */
watch(
    () => account.value?.address,
    () => {
        phase.value = 'idle';
        refusal.value = null;
        void read();
    },
);

const state = computed(() => stationState(status.value));

const STATE_TONE = {
    live: 'confirmed',
    paused: 'pending',
    empty: 'failed',
    off: 'failed',
    unreadable: 'pending',
} as const;

const drips = computed(() => dripsLeft(status.value));
const share = computed(() => dailyShare(status.value));

const amount = (value: string | null | undefined, precision = 4): string =>
    value === null || value === undefined
        ? '—'
        : formatUnits(BigInt(value), chain.decimals, precision);

const tankUsd = computed(() =>
    status.value?.tank
        ? usdValue(BigInt(status.value.tank), chain.decimals, price.value)
        : null,
);

const hours = computed(() => Math.max(1, Math.round(cooldown.value / 3600)));

/**
 * The wait, in the largest unit that still says something true. Under an hour
 * a countdown is the answer; above it, minutes are noise a person cannot use.
 */
const waitLabel = computed(() => {
    if (cooldown.value <= 0) {
        return '';
    }

    if (cooldown.value < 3600) {
        const minutes = Math.floor(cooldown.value / 60);
        const seconds = cooldown.value % 60;

        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }

    return t('gasHours', { hours: hours.value });
});

const eligibility = computed(() => status.value?.address ?? null);

const eligible = computed(
    () =>
        state.value === 'live' &&
        refusal.value === null &&
        eligibility.value?.ok === true,
);

/** Why the station said no, as a sentence — or null when it said yes. */
const reason = computed(() => {
    if (loading.value || eligible.value || phase.value === 'sent') {
        return null;
    }

    const code = refusal.value ?? eligibility.value?.reason ?? null;

    if (code === null) {
        return null;
    }

    return t(sponsorReasonKey(code), {
        symbol: chain.symbol,
        hours: hours.value,
    });
});

/**
 * What this address was let in on. Grounds are only ever shown for a yes: on a
 * refusal they would be a second, quieter answer to a question that already
 * has one.
 */
const grounds = computed(() => {
    const key = eligibility.value?.grounds;

    if (!eligible.value || !key) {
        return null;
    }

    return t(`gasGrounds${key.charAt(0).toUpperCase()}${key.slice(1)}`);
});

const claim = async (): Promise<void> => {
    if (!account.value || phase.value === 'asking') {
        return;
    }

    phase.value = 'asking';
    refusal.value = null;

    const outcome = await requestGas(account.value.address);

    if (!outcome.ok) {
        refusal.value = outcome.reason;
        phase.value = 'idle';
        await read();

        return;
    }

    phase.value = 'sent';
    await props.wallet.refreshBalances();
    await read();
};

/** What one plain transfer costs right now, at each tier the chain quotes. */
const tiers = computed(() =>
    props.wallet.feesFor(SPONSORED_CHAIN).map((quote) => ({
        ...quote,
        label: t(
            `fee${quote.tier.charAt(0).toUpperCase()}${quote.tier.slice(1)}`,
        ),
        cost: formatUnits(quote.fee, chain.decimals, 6),
        usd: usdValue(quote.fee, chain.decimals, price.value),
        /** How many transfers of this size one drip pays for. */
        covers:
            status.value?.drip && quote.fee > 0n
                ? Number(BigInt(status.value.drip) / quote.fee)
                : null,
    })),
);
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">
            {{ t('gasStation') }}
        </h2>
        <p class="cw-prose">{{ t('gasStationBody') }}</p>

        <!-- The station itself: what it holds, and what it is allowed to spend. -->
        <div class="cw-card" style="margin-top: 22px; padding: 18px">
            <div class="cw-row">
                <span class="cw-label">{{ t('gasTank') }}</span>
                <StatusPill
                    :status="STATE_TONE[state]"
                    :label="
                        t(
                            `gasState${state.charAt(0).toUpperCase()}${state.slice(1)}`,
                        )
                    "
                />
            </div>

            <div
                style="
                    display: flex;
                    align-items: baseline;
                    gap: 10px;
                    margin-top: 14px;
                    flex-wrap: wrap;
                "
            >
                <span class="cw-total">{{ amount(status?.tank) }}</span>
                <span class="cw-label" style="color: var(--cw-muted)">{{
                    chain.symbol
                }}</span>
                <span
                    v-if="tankUsd !== null"
                    class="cw-label"
                    style="color: var(--cw-faint)"
                    >{{ formatUsd(tankUsd, locale) }}</span
                >
            </div>

            <div
                v-if="drips !== null"
                style="
                    margin-top: 8px;
                    font: 500 13px/1.5 var(--cw-mono);
                    color: var(--cw-dim);
                "
            >
                {{ t('gasDripsLeft', { count: drips }) }}
            </div>

            <!--
              The day's allowance is the only bound here with a denominator, so
              it is the only one drawn as a gauge. A tank has no capacity to
              measure against and a bar would have to invent one.
            -->
            <template v-if="share !== null">
                <div class="cw-bar" style="margin-top: 16px">
                    <div
                        class="cw-bar-fill"
                        :style="{
                            width: `${Math.max(2, share * 100)}%`,
                            background:
                                share < 0.15
                                    ? 'var(--cw-pending)'
                                    : 'var(--cw-accent)',
                        }"
                    />
                </div>
                <div class="cw-row" style="margin-top: 8px">
                    <span class="cw-label" style="color: var(--cw-faint)">{{
                        t('gasToday')
                    }}</span>
                    <span
                        style="
                            font: 500 13px/1 var(--cw-mono);
                            color: var(--cw-muted);
                        "
                        >{{
                            t('gasTodayLeft', {
                                left: amount(status?.remainingToday, 2),
                                cap: amount(status?.dailyCap, 2),
                                symbol: chain.symbol,
                            })
                        }}</span
                    >
                </div>
            </template>
        </div>

        <div style="margin-top: 18px; border: 1px solid var(--cw-line)">
            <div class="cw-kv">
                <span class="cw-kv-key">{{ t('gasDrip') }}</span>
                <span class="cw-kv-val"
                    >{{ amount(status?.drip, 6) }} {{ chain.symbol }}</span
                >
            </div>
            <div class="cw-kv">
                <span class="cw-kv-key">{{ t('gasCooldown') }}</span>
                <span class="cw-kv-val">{{
                    status?.cooldown
                        ? t('gasHours', {
                              hours: Math.round(status.cooldown / 3600),
                          })
                        : '—'
                }}</span>
            </div>
            <div class="cw-kv">
                <span class="cw-kv-key">{{ t('gasCeiling') }}</span>
                <span class="cw-kv-val"
                    >{{ amount(status?.ceiling, 6) }} {{ chain.symbol }}</span
                >
            </div>
            <div class="cw-kv">
                <span class="cw-kv-key">{{ t('gasServed') }}</span>
                <span class="cw-kv-val">{{ status?.served ?? '—' }}</span>
            </div>
        </div>

        <p class="cw-prose" style="margin-top: 12px">
            {{ t('gasBoundsNote') }}
        </p>

        <!-- Where this one address stands, which is the other half of the screen. -->
        <div class="cw-label" style="margin-top: 26px">
            {{ t('gasYourAccount') }}
        </div>

        <div class="cw-card" style="margin-top: 10px; padding: 16px">
            <AddressField
                v-if="account"
                :address="account.address"
                :label="t('yourAddress')"
                :copied="clipboard.copied.value === account.address"
                :copy-label="t('copyAddress')"
                :copied-label="t('copiedClears')"
                :expand-label="t('expandAddress')"
                @copy="clipboard.copy(account.address)"
            />

            <div class="cw-row" style="margin-top: 16px">
                <span class="cw-label" style="color: var(--cw-faint)">{{
                    t('gasYourBalance')
                }}</span>
                <span class="cw-num"
                    >{{
                        balance === null
                            ? '—'
                            : formatUnits(balance, chain.decimals, 6)
                    }}
                    {{ chain.symbol }}</span
                >
            </div>

            <div
                v-if="grounds"
                style="
                    margin-top: 14px;
                    font: 500 13px/1.5 var(--cw-mono);
                    color: var(--cw-dim);
                "
            >
                {{ grounds }}
            </div>

            <p
                v-if="phase === 'sent'"
                class="cw-note"
                style="margin-top: 14px; color: var(--cw-ok)"
            >
                <span>{{ t('sponsorSent', { symbol: chain.symbol }) }}</span>
            </p>

            <p v-else-if="reason" class="cw-note" style="margin-top: 14px">
                <span>
                    {{ reason }}
                    <span
                        v-if="cooldown > 0"
                        style="
                            display: block;
                            margin-top: 6px;
                            font: 500 14px/1 var(--cw-mono);
                            color: var(--cw-muted);
                        "
                        >{{ waitLabel }}</span
                    >
                </span>
            </p>

            <button
                v-if="eligible && phase !== 'sent'"
                type="button"
                class="cw-btn cw-btn-primary"
                style="margin-top: 16px"
                :disabled="phase === 'asking'"
                @click="claim"
            >
                {{ phase === 'asking' ? t('sponsorAsking') : t('gasClaim') }}
            </button>
        </div>

        <!-- What the drip is for, priced against what it is meant to cover. -->
        <template v-if="tiers.length > 0">
            <div class="cw-label" style="margin-top: 26px">
                {{ t('gasTransferCost') }}
            </div>
            <div style="margin-top: 10px; border: 1px solid var(--cw-line)">
                <div v-for="tier in tiers" :key="tier.tier" class="cw-kv">
                    <span>
                        <span class="cw-kv-key" style="display: block">{{
                            tier.label
                        }}</span>
                        <span
                            v-if="tier.covers !== null"
                            style="
                                display: block;
                                margin-top: 4px;
                                font: 500 12px/1.4 var(--cw-mono);
                                color: var(--cw-faint);
                            "
                            >{{
                                t('gasDripCovers', { count: tier.covers })
                            }}</span
                        >
                    </span>
                    <!--
                      The coin, and not the dollar. A transfer here costs
                      0.000222 CYBER, which is $0.0000000087 — a figure with
                      eight leading zeros printed three times, saying "free" in
                      the least readable way available. What one drip covers is
                      the number that answers the question, and it is on the
                      other side of the row.
                    -->
                    <span class="cw-kv-val">
                        {{ tier.cost }} {{ chain.symbol }}
                    </span>
                </div>
            </div>
        </template>

        <div v-if="status?.station" style="margin-top: 26px">
            <AddressField
                :address="status.station"
                :label="t('gasContract')"
                :copied="clipboard.copied.value === status.station"
                :copy-label="t('copyAddress')"
                :copied-label="t('copiedClears')"
                :expand-label="t('expandAddress')"
                @copy="clipboard.copy(status.station)"
            />
        </div>

        <!--
          Why asking costs no signature is an argument about this design, and
          it is written where design arguments go — `GasSponsorService` and the
          architecture notes. What is left here is the one line that changes
          what somebody does: this station serves one chain.
        -->
        <p class="cw-prose" style="margin-top: 22px">
            {{ t('gasCyberiaOnly') }}
        </p>
    </div>
</template>
