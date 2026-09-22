<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { analytics, errorCode } from '@/lib/analytics';
import { aprByPair, formatApr } from '@/lib/dexApr';
import type { AprSnapshot, FarmApr } from '@/lib/dexApr';
import { formatUnits, parseUnits, walletChain } from '@/lib/wallet';
import type { WalletChainId } from '@/lib/wallet';
import {
    STAKE_GAS_CAP,
    canStake,
    canUnstake,
    earnChainFor,
    earnTxUrl,
    hasEarn,
    poolShare,
    readEarnPools,
    readPairComposition,
} from '@/lib/wallet/earn';
import type { EarnPool, EarnSnapshot } from '@/lib/wallet/earn';
import { formatUsd, usdValue } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Earning on a pool position.
 *
 * Two sources, kept apart on the screen exactly as they are in the module
 * underneath it. What a pool *is* — its TVL, its volume, the APR that follows
 * — is one claim about the whole chain and comes from this site's indexer.
 * What you hold in it is read from the chain against your own address. An APR
 * nobody could compute renders as "—" beside a stake that is perfectly
 * readable, because the two have nothing to do with each other.
 *
 * The screen does one thing the pool pages do not: it shows LP that is sitting
 * in the wallet earning nothing. That is the state this whole screen exists
 * for — a position someone added and then never staked — and it is the first
 * row rather than a footnote.
 *
 * Adding liquidity is not done here, but it is no longer somewhere else: it
 * is two assets, a ratio that moves between the quote and the signature, two
 * allowances and a floor on both sides, which is a screen of its own — and it
 * is now a screen in this wallet rather than a link out to the site. A farm
 * that stakes LP while the wallet offered no way of making any was advice
 * nobody here could take.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** Which network the wallet is pointed at, when it has a farm. */
    chain: WalletChainId;
    prices: Record<string, number | null>;
}>();

const emit = defineEmits<{ back: []; liquidity: [] }>();

const { locale, t } = useLocale(walletMessages);

/**
 * The farm this screen is about.
 *
 * The wallet's own chain when that chain has one, and Cyberia otherwise —
 * every farm here settles on a chain the seed already derives, so there is
 * never a network to switch to, only one to point at.
 */
const active = computed<WalletChainId>(() => {
    const chain = walletChain(props.chain);

    return chain.chainId && hasEarn(chain.chainId) ? props.chain : 'cyberia';
});

const chainMeta = computed(() => walletChain(active.value));

const account = computed(
    () =>
        props.wallet.accounts.value.find(
            (entry) => entry.chain === active.value,
        ) ?? null,
);

const snapshot = ref<EarnSnapshot | null>(null);
const apr = ref<AprSnapshot | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);

type View = 'list' | 'pool';

const view = ref<View>('list');
const selected = ref<number | null>(null);

type Act = 'stake' | 'unstake' | 'claim';

const act = ref<Act>('stake');
const amount = ref('');
const busy = ref(false);
const sent = ref<{ hash: string; url: string } | null>(null);
const gasPrice = ref<bigint | null>(null);

/** The composition of the selected pool's LP token, when it is a pair. */
const composition = ref<Awaited<ReturnType<typeof readPairComposition>>>(null);

const load = async (): Promise<void> => {
    const address = account.value?.address;
    const chainId = chainMeta.value.chainId;

    if (!address || !chainId) {
        return;
    }

    loading.value = true;
    error.value = null;

    try {
        snapshot.value = await readEarnPools(chainId, address);
    } catch (failure) {
        error.value =
            failure instanceof Error ? failure.message : String(failure);
        snapshot.value = null;
    } finally {
        loading.value = false;
    }
};

/**
 * The indexer's view of the same pools.
 *
 * Fetched separately and allowed to fail on its own: an APR that could not be
 * computed must never take the positions down with it, since the positions are
 * the half of this screen that is about the user's own money.
 */
const loadApr = async (): Promise<void> => {
    try {
        const response = await fetch('/api/dex/apr', {
            headers: { Accept: 'application/json' },
        });

        apr.value = response.ok
            ? ((await response.json()) as AprSnapshot)
            : null;
    } catch {
        apr.value = null;
    }
};

const loadGasPrice = async (): Promise<void> => {
    try {
        gasPrice.value = await props.wallet.gasPrice(active.value);
    } catch {
        gasPrice.value = null;
    }
};

onMounted(() => {
    void load();
    void loadApr();
    void loadGasPrice();
});

// A different account is a different set of positions; a different network is
// a different farm entirely.
watch([() => props.wallet.activeAccountId.value, active], () => {
    view.value = 'list';
    selected.value = null;
    sent.value = null;
    void load();
    void loadGasPrice();
});

/** Only Cyberia's farm is indexed, so only Cyberia carries an APR. */
const farmApr = computed(() => {
    const rows = apr.value?.farms ?? [];

    return new Map<number, FarmApr>(rows.map((row) => [row.pid, row]));
});

const poolApr = computed(() => aprByPair(apr.value));

const pools = computed(() => snapshot.value?.pools ?? []);

const reward = computed(
    () => snapshot.value?.reward ?? { symbol: '', decimals: 18 },
);

const pool = computed<EarnPool | null>(
    () => pools.value.find((entry) => entry.pid === selected.value) ?? null,
);

const aprFor = (entry: EarnPool): string => {
    const emissions = farmApr.value.get(entry.pid)?.apy ?? null;
    const fees =
        poolApr.value.get(entry.stakingToken.toLowerCase())?.apr ?? null;

    // Emissions and swap fees are two different yields on the same position.
    // Where both are known they add; where only one is, it is shown as itself
    // rather than as a total that quietly omits the other — and where neither
    // is, the answer is "—", never a confident zero. A pool the indexer has
    // never seen pays something; nobody here knows what.
    if (emissions === null && fees === null) {
        return '—';
    }

    return formatApr((emissions ?? 0) + (fees ?? 0));
};

const tvlFor = (entry: EarnPool): string => {
    const farm = farmApr.value.get(entry.pid);

    return farm?.staked_usd === null || farm?.staked_usd === undefined
        ? '—'
        : formatUsd(farm.staked_usd, locale.value);
};

const staking = computed(() =>
    pools.value.filter((entry) => entry.staked > 0n),
);

/** LP held and not staked — the state this screen exists to catch. */
const idle = computed(() => pools.value.filter((entry) => entry.idle > 0n));

const unclaimed = computed(() =>
    pools.value.reduce((sum, entry) => sum + entry.pending, 0n),
);

const suppliedUsd = computed(() => {
    let total = 0;
    let known = false;

    for (const entry of staking.value) {
        const farm = farmApr.value.get(entry.pid);

        if (
            farm?.staked_usd !== null &&
            farm?.staked_usd !== undefined &&
            entry.totalStaked > 0n
        ) {
            known = true;
            // The pool's staked USD, times this account's share of the stake.
            total +=
                farm.staked_usd *
                (Number((entry.staked * 1_000_000n) / entry.totalStaked) /
                    1_000_000);
        }
    }

    return known ? total : null;
});

/* ------------------------------------------------------------- one pool -- */

const openPool = async (entry: EarnPool): Promise<void> => {
    selected.value = entry.pid;
    view.value = 'pool';
    act.value = entry.idle > 0n ? 'stake' : 'unstake';
    amount.value = '';
    sent.value = null;
    composition.value = null;

    if (entry.isPair && chainMeta.value.chainId) {
        composition.value = await readPairComposition(
            chainMeta.value.chainId,
            entry.stakingToken,
        );
    }
};

const back = (): void => {
    if (view.value === 'pool') {
        view.value = 'list';
        selected.value = null;
        sent.value = null;

        return;
    }

    emit('back');
};

/** What this account's stake is a claim on, in the two underlying assets. */
const position = computed(() => {
    const entry = pool.value;
    const parts = composition.value;

    if (!entry || !parts) {
        return null;
    }

    const held = entry.staked + entry.idle;
    const share = poolShare(held, parts.totalSupply, parts.reserves);

    return {
        share: share.share,
        first: `${formatUnits(share.amounts[0], parts.decimals[0], 4)} ${parts.symbols[0]}`,
        second: `${formatUnits(share.amounts[1], parts.decimals[1], 4)} ${parts.symbols[1]}`,
    };
});

const amountUnits = computed(() => {
    const entry = pool.value;

    if (!entry || amount.value.trim() === '') {
        return 0n;
    }

    try {
        return parseUnits(amount.value.trim(), entry.decimals);
    } catch {
        return -1n;
    }
});

/** Why the button is off, in the vocabulary the user can act on. */
const refusal = computed(() => {
    const entry = pool.value;

    if (!entry) {
        return 'empty';
    }

    if (act.value === 'claim') {
        return entry.pending <= 0n ? 'empty' : 'ok';
    }

    if (amountUnits.value < 0n) {
        return 'empty';
    }

    return act.value === 'stake'
        ? canStake(amountUnits.value, entry.idle)
        : canUnstake(amountUnits.value, entry.staked);
});

const ready = computed(
    () => refusal.value === 'ok' && gasPrice.value !== null && !busy.value,
);

/** The worst this transaction can cost, at the gas price it will be signed at. */
const fee = computed(() =>
    gasPrice.value === null ? null : gasPrice.value * STAKE_GAS_CAP,
);

const feeUsd = computed(() =>
    fee.value === null
        ? null
        : usdValue(
              fee.value,
              chainMeta.value.decimals,
              props.prices[active.value] ?? null,
          ),
);

const setMax = (): void => {
    const entry = pool.value;

    if (!entry) {
        return;
    }

    amount.value = formatUnits(
        act.value === 'stake' ? entry.idle : entry.staked,
        entry.decimals,
        18,
    );
};

/** One plain sentence for what is about to be signed. */
const sentence = computed(() => {
    const entry = pool.value;

    if (!entry || gasPrice.value === null) {
        return '';
    }

    const gas = `${formatUnits(fee.value ?? 0n, chainMeta.value.decimals, 6)} ${chainMeta.value.symbol}`;

    if (act.value === 'claim') {
        return t('earnSignClaim', {
            amount: formatUnits(entry.pending, reward.value.decimals, 6),
            symbol: reward.value.symbol,
            pool: entry.label,
            fee: gas,
        });
    }

    return t(act.value === 'stake' ? 'earnSignStake' : 'earnSignUnstake', {
        amount: amount.value.trim(),
        pool: entry.label,
        fee: gas,
    });
});

/**
 * Which pool and which of the three agreements. The pool travels as its `pid`
 * rather than its label — a label is user-facing text that changes, and a pid
 * is what the chef actually calls it.
 */
const traits = () => ({
    chain: active.value,
    pid: pool.value?.pid,
    pool_kind: (pool.value?.isPair ? 'pair' : 'solo') as 'pair' | 'solo',
    transaction_type: (act.value === 'claim'
        ? 'claim'
        : act.value === 'stake'
          ? 'stake'
          : 'unstake') as 'claim' | 'stake' | 'unstake',
    fee_usd: feeUsd.value ?? undefined,
});

/** Which event a completed act produces — three acts, three funnels. */
const COMPLETED = {
    stake: 'staking_completed',
    unstake: 'staking_withdrawn',
    claim: 'reward_claimed',
} as const;

const sign = async (): Promise<void> => {
    const entry = pool.value;
    const chainId = chainMeta.value.chainId;

    if (!entry || !chainId || gasPrice.value === null || !ready.value) {
        return;
    }

    busy.value = true;
    error.value = null;
    sent.value = null;

    const startedAt = Date.now();
    const acting = act.value;

    analytics.track('staking_started', traits());

    try {
        const receipt =
            act.value === 'claim'
                ? await props.wallet.farm.claim(active.value, {
                      chainId,
                      pid: entry.pid,
                      gasPrice: gasPrice.value,
                  })
                : act.value === 'stake'
                  ? await props.wallet.farm.stake(active.value, {
                        chainId,
                        pid: entry.pid,
                        stakingToken: entry.stakingToken,
                        amount: amountUnits.value,
                        allowance: entry.allowance,
                        gasPrice: gasPrice.value,
                    })
                  : await props.wallet.farm.unstake(active.value, {
                        chainId,
                        pid: entry.pid,
                        amount: amountUnits.value,
                        gasPrice: gasPrice.value,
                    });

        sent.value = {
            hash: receipt.hash,
            url: earnTxUrl(earnChainFor(chainId), receipt.hash),
        };
        amount.value = '';

        analytics.track(COMPLETED[acting], {
            ...traits(),
            duration_ms: Date.now() - startedAt,
        });

        // The position on screen belongs to the block before this one.
        await load();
        await props.wallet.refreshBalances();
    } catch (failure) {
        error.value =
            failure instanceof Error ? failure.message : String(failure);

        analytics.track('staking_failed', {
            ...traits(),
            error_code: errorCode(failure),
            duration_ms: Date.now() - startedAt,
        });
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="back()">
            ← {{ view === 'pool' ? t('earnPools') : t('navPortfolio') }}
        </button>

        <!-- The farm as a whole. -->
        <template v-if="view === 'list'">
            <h2 class="cw-title" style="margin: 22px 0 8px">
                {{ t('earnTitle') }}
            </h2>
            <p class="cw-prose">{{ t('earnBody') }}</p>

            <div style="display: flex; gap: 8px; margin-top: 20px">
                <div class="cw-card" style="flex: 1; padding: 14px 16px">
                    <div class="cw-label" style="font-size: 9px">
                        {{ t('earnSupplied') }}
                    </div>
                    <div
                        class="cw-num"
                        style="margin-top: 8px; font-size: 18px"
                        :style="
                            suppliedUsd === null
                                ? { color: 'var(--cw-muted)' }
                                : undefined
                        "
                    >
                        {{
                            suppliedUsd === null
                                ? '—'
                                : formatUsd(suppliedUsd, locale)
                        }}
                    </div>
                    <div
                        class="cw-label"
                        style="margin-top: 6px; color: var(--cw-faint)"
                    >
                        {{ t('earnPositions', { count: staking.length }) }}
                    </div>
                </div>
                <div class="cw-card" style="flex: 1; padding: 14px 16px">
                    <div class="cw-label" style="font-size: 9px">
                        {{ t('earnUnclaimed') }}
                    </div>
                    <div
                        class="cw-num"
                        style="margin-top: 8px; font-size: 18px"
                        :style="
                            unclaimed > 0n
                                ? { color: 'var(--cw-accent)' }
                                : undefined
                        "
                    >
                        {{ formatUnits(unclaimed, reward.decimals, 4) }}
                    </div>
                    <div
                        class="cw-label"
                        style="margin-top: 6px; color: var(--cw-faint)"
                    >
                        {{ reward.symbol || '—' }}
                    </div>
                </div>
            </div>

            <p
                v-if="error"
                class="cw-note cw-note-bad"
                style="margin-top: 16px"
            >
                <span>{{ error }}</span>
            </p>

            <!--
              LP that is in the wallet and not in the farm. It earns swap fees
              and nothing else, which is a state nobody chooses on purpose.
            -->
            <p
                v-if="idle.length > 0"
                class="cw-note cw-note-warn"
                style="margin-top: 16px"
            >
                <span>{{ t('earnIdle', { count: idle.length }) }}</span>
            </p>

            <div class="cw-row" style="margin: 26px 0 10px">
                <span class="cw-label">{{ t('earnPools') }}</span>
                <span style="display: flex; align-items: center; gap: 8px">
                    <NetworkMark :chain="active" dot :size="6" />
                    <span class="cw-label" style="color: var(--cw-faint)">{{
                        chainMeta.label
                    }}</span>
                </span>
            </div>

            <p v-if="loading" class="cw-prose">{{ t('earnLoading') }}</p>

            <p v-else-if="pools.length === 0" class="cw-prose">
                {{ t('earnNoPools') }}
            </p>

            <div v-else class="cw-stack" style="gap: 8px">
                <button
                    v-for="entry in pools"
                    :key="entry.pid"
                    type="button"
                    class="cw-card cw-card-button"
                    @click="openPool(entry)"
                >
                    <div class="cw-row">
                        <span
                            style="
                                font: 500 14px/1.2 var(--cw-sans);
                                color: var(--cw-text);
                            "
                            >{{ entry.label }}</span
                        >
                        <span class="cw-num" style="color: var(--cw-accent)">{{
                            aprFor(entry)
                        }}</span>
                    </div>
                    <div class="cw-row" style="margin-top: 8px">
                        <span class="cw-label" style="color: var(--cw-faint)"
                            >{{ t('earnTvl') }} {{ tvlFor(entry) }}</span
                        >
                        <span
                            class="cw-label"
                            :style="{
                                color:
                                    entry.staked > 0n
                                        ? 'var(--cw-text)'
                                        : entry.idle > 0n
                                          ? 'var(--cw-pending)'
                                          : 'var(--cw-faint)',
                            }"
                        >
                            <template v-if="entry.staked > 0n"
                                >{{ t('earnYours') }}
                                {{
                                    formatUnits(entry.staked, entry.decimals, 4)
                                }}</template
                            >
                            <template v-else-if="entry.idle > 0n">{{
                                t('earnUnstaked')
                            }}</template>
                            <template v-else>—</template>
                        </span>
                    </div>
                </button>
            </div>

            <p
                v-if="(snapshot?.unreadable ?? 0) > 0"
                class="cw-prose"
                style="margin-top: 12px; color: var(--cw-pending)"
            >
                {{ t('earnUnreadable', { count: snapshot?.unreadable ?? 0 }) }}
            </p>

            <p class="cw-prose" style="margin-top: 18px">
                {{ t('earnAprNote') }}
            </p>

            <!--
              The way in for somebody who has no LP at all, which is most
              people arriving here: this list is a menu of pools to stake in,
              and a stake starts with a deposit somewhere else in this wallet.
            -->
            <button
                type="button"
                class="cw-btn cw-btn-secondary"
                style="margin-top: 14px"
                @click="emit('liquidity')"
            >
                {{ t('earnAddLiquidity') }}
            </button>
        </template>

        <!-- One pool: what it is, what you hold, and the three things to do. -->
        <template v-else-if="pool">
            <div class="cw-row" style="margin: 22px 0 4px">
                <h2 class="cw-title">{{ pool.label }}</h2>
                <span class="cw-num" style="color: var(--cw-accent)">{{
                    aprFor(pool)
                }}</span>
            </div>
            <p class="cw-label" style="color: var(--cw-faint)">
                {{ chainMeta.label }} ·
                {{ t('earnShare', { percent: (pool.share * 100).toFixed(1) }) }}
            </p>

            <div style="margin-top: 20px; border: 1px solid var(--cw-line)">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('earnStaked') }}</span>
                    <span class="cw-kv-val"
                        >{{ formatUnits(pool.staked, pool.decimals, 6) }}
                        {{ pool.isPair ? 'LP' : pool.label }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('earnInWallet') }}</span>
                    <span
                        class="cw-kv-val"
                        :style="
                            pool.idle > 0n
                                ? { color: 'var(--cw-pending)' }
                                : undefined
                        "
                        >{{ formatUnits(pool.idle, pool.decimals, 6) }}</span
                    >
                </div>
                <div v-if="position" class="cw-kv">
                    <span class="cw-kv-key">{{ t('earnUnderlying') }}</span>
                    <span class="cw-kv-val"
                        >{{ position.first }} + {{ position.second }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('earnPending') }}</span>
                    <span
                        class="cw-kv-val"
                        :style="
                            pool.pending > 0n
                                ? { color: 'var(--cw-accent)' }
                                : undefined
                        "
                        >{{ formatUnits(pool.pending, reward.decimals, 6) }}
                        {{ reward.symbol }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('earnTvl') }}</span>
                    <span class="cw-kv-val">{{ tvlFor(pool) }}</span>
                </div>
            </div>

            <!-- Three acts, and they are never blurred into one button. -->
            <div class="cw-seg" style="margin-top: 20px">
                <button
                    v-for="option in ['stake', 'unstake', 'claim'] as const"
                    :key="option"
                    type="button"
                    class="cw-seg-item"
                    :class="{ 'cw-seg-bar': act === option }"
                    :aria-pressed="act === option"
                    @click="
                        act = option;
                        amount = '';
                        sent = null;
                    "
                >
                    {{
                        t(
                            `earnAct${option.charAt(0).toUpperCase()}${option.slice(1)}`,
                        )
                    }}
                </button>
            </div>

            <div v-if="act !== 'claim'" style="margin-top: 16px">
                <div class="cw-row" style="margin-bottom: 8px">
                    <span class="cw-label">{{
                        act === 'stake'
                            ? t('earnAmountStake')
                            : t('earnAmountUnstake')
                    }}</span>
                    <button type="button" class="cw-back" @click="setMax()">
                        {{ t('max') }}
                    </button>
                </div>
                <input
                    v-model="amount"
                    class="cw-input"
                    inputmode="decimal"
                    spellcheck="false"
                    placeholder="0.0"
                    :aria-label="
                        act === 'stake'
                            ? t('earnAmountStake')
                            : t('earnAmountUnstake')
                    "
                />
                <p
                    v-if="refusal !== 'ok'"
                    class="cw-label"
                    style="margin-top: 8px; color: var(--cw-pending)"
                >
                    {{
                        t(
                            `earnRefusal${refusal.charAt(0).toUpperCase()}${refusal.slice(1)}`,
                        )
                    }}
                </p>
            </div>

            <p
                v-else-if="pool.pending <= 0n"
                class="cw-prose"
                style="margin-top: 16px"
            >
                {{ t('earnNothingToClaim') }}
            </p>

            <!--
              An allowance the farm does not have yet is a second transaction
              and the user's own coin pays for it, so it is said before the
              hold rather than discovered in the history afterwards.
            -->
            <p
                v-if="
                    act === 'stake' &&
                    refusal === 'ok' &&
                    pool.allowance < amountUnits
                "
                class="cw-note"
                style="margin-top: 14px"
            >
                <span>{{ t('earnApprovalNote', { pool: pool.label }) }}</span>
            </p>

            <div v-if="fee !== null" class="cw-row" style="margin-top: 16px">
                <span class="cw-label">{{ t('networkFee') }}</span>
                <span class="cw-num"
                    >{{ formatUnits(fee, chainMeta.decimals, 6) }}
                    {{ chainMeta.symbol
                    }}<template v-if="feeUsd !== null">
                        · {{ formatUsd(feeUsd, locale) }}</template
                    ></span
                >
            </div>

            <p v-if="sentence" class="cw-prose" style="margin-top: 14px">
                {{ sentence }}
            </p>

            <p
                v-if="error"
                class="cw-note cw-note-bad"
                style="margin-top: 14px"
            >
                <span>{{ error }}</span>
            </p>

            <div v-if="sent" class="cw-note" style="margin-top: 14px">
                <span>
                    {{ t('earnSent') }}
                    <a :href="sent.url" target="_blank" rel="noopener">{{
                        t('viewInExplorer')
                    }}</a>
                </span>
            </div>

            <div style="margin-top: 18px">
                <HoldButton
                    :label="t('holdToSign')"
                    :disabled="!ready"
                    @complete="sign()"
                />
            </div>

            <!--
              What the APR does not net out. On a two-sided pool it is the
              whole risk, and it belongs above the link that would add more.
            -->
            <p
                v-if="pool.isPair"
                class="cw-note cw-note-warn"
                style="margin-top: 20px"
            >
                <span>{{ t('earnImpermanent') }}</span>
            </p>

            <p class="cw-prose" style="margin-top: 14px">
                {{ t('earnAddLiquidityNote') }}
            </p>
            <button
                type="button"
                class="cw-btn cw-btn-secondary"
                style="margin-top: 10px"
                @click="emit('liquidity')"
            >
                {{ t('earnAddLiquidity') }}
            </button>
        </template>
    </div>
</template>
