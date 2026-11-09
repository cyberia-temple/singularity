<script setup lang="ts">
import { ZeroAddress } from 'ethers';
import { ExternalLink } from 'lucide-vue-next';
import { computed, reactive, ref, toRaw, watch } from 'vue';
import GasSponsor from '@/components/wallet/GasSponsor.vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { launchpadChain } from '@/lib/launchpadChains';
import { formatUnits, walletChains } from '@/lib/wallet';
import {
    awaitDomainTx,
    zoneExists,
    zoneFromToken,
    zoneTokenNaming,
} from '@/lib/wallet/domains';
import { shortAddress } from '@/lib/wallet/format';
import {
    KIT_CREDIT,
    KIT_DAO,
    KIT_FARM,
    LAUNCH_NAME_MAX,
    LAUNCH_SYMBOL_MAX,
    LaunchRefused,
    MAX_CREATOR_FEE_PCT,
    STUDIO_MAX_ALLOCATIONS,
    awaitLaunch,
    feeSplit,
    formTotalSupply,
    formVenue,
    hasAbout,
    launchProblem,
    launchTerms,
    launchTxUrl,
    launchVenue,
    launchpadChains,
    quoteLaunch,
    readKit,
    readMinLiquidity,
    submitAbout,
    venueHasFee,
    watchLaunch,
} from '@/lib/wallet/launchpad';
import type {
    LaunchAbout,
    LaunchForm,
    LaunchKit,
    LaunchQuote,
} from '@/lib/wallet/launchpad';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Launching a token from the wallet.
 *
 * The same contract `/launchpad` sends to, signed by the key in this vault
 * rather than by an extension. One transaction deploys the token and pairs
 * its entire supply with the coin sent along, and that coin does not come
 * back — which is the whole promise of a fair launch and the one sentence the
 * confirm screen cannot leave out. Nothing is kept by the creator: whoever
 * launches buys in like everybody else.
 *
 * Three stages and nothing blurred between them. Compose prices nothing.
 * Confirm has *run* the launch as a call from this account, so a revert is
 * read here with the contract's own reason rather than after a hold that paid
 * for it. Done waits for the receipt, reads the new token out of it, and only
 * then attaches the description and links — by signing a message, not a
 * transaction, because the first signature for a token is what makes its
 * page editable by its creator and nobody else.
 *
 * On Cyberia 2.0 the launch also opens the token's kit — lending, a farm, a
 * DAO — in the contract itself, so the done screen reads what was opened
 * from the chain instead of asking the server for a DAO.
 *
 * Cyberia 2.0 also lets the creator describe the token (Token settings): a
 * minter who may mint more, part of the supply minted straight to addresses,
 * the parts of the kit to open. A token that asks for any of that is made by
 * the TokenStudio instead of the launchpad — the same locked pool, fee split
 * and kit — and the form says so; one that asks for none is a plain launch.
 */

const props = defineProps<{
    wallet: MultiWallet;
    /** EVM chain id of the launchpad to launch on; Cyberia when absent. */
    evmChainId?: number | null;
}>();

const emit = defineEmits<{
    back: [];
    launched: [];
    swap: [contract: string];
    domains: [];
    dao: [];
}>();

const { t } = useLocale(walletMessages);

type Stage = 'compose' | 'confirm' | 'mining' | 'done';

const stage = ref<Stage>('compose');
const busy = ref(false);
const failure = ref<string | null>(null);

const target = computed(
    () =>
        (props.evmChainId ? launchpadChain(props.evmChainId) : undefined) ??
        launchpadChains()[0] ??
        null,
);
const form = reactive<LaunchForm>({
    name: '',
    symbol: '',
    supply: '1000000',
    liquidity: target.value?.defaultLiquidity ?? '10',
    creatorFeePct: '1',
    holdersSharePct: '0',
    mintable: false,
    minter: '',
    maxSupply: '',
    allocations: [],
    kit: { credit: true, farm: true, dao: true },
});

/** Where this form's token is made: the studio once it asks for its settings. */
const venue = computed(() =>
    target.value ? formVenue(target.value, form) : null,
);
/** The pool charges a fee its creator picks: v3 and Cyberia 2.0. */
const charges = computed(() => venueHasFee(venue.value));
/** Cyberia 2.0 — a testnet, whose coin comes from the faucet. */
const isKit = computed(
    () => target.value !== null && launchVenue(target.value) === 'kit',
);
/** The token's own settings can be described here: Cyberia 2.0 with a studio. */
const canSetUp = computed(
    () => isKit.value && Boolean(target.value?.tokenStudio),
);
const isStudio = computed(() => venue.value === 'studio');
const setupOpen = ref(false);

const about = reactive<LaunchAbout>({
    description: '',
    x: '',
    telegram: '',
    website: '',
    image: null,
});

const minLiquidity = ref<bigint | null>(null);
const quote = ref<LaunchQuote | null>(null);
const hash = ref<string | null>(null);
const token = ref<string | null>(null);
/** Mined, but the receipt did not name the token, or the wait timed out. */
const unread = ref(false);
const aboutState = ref<'none' | 'saving' | 'saved' | 'failed'>('none');
/**
 * The DAO the launch opened. Every launch gets one without anybody asking —
 * this screen only asks the server to look now and says when it has.
 */
const dao = ref<{ id: number; name: string } | null>(null);
const daoState = ref<'none' | 'opening' | 'opened' | 'later'>('none');
const aboutError = ref<string | null>(null);
/** What a Cyberia 2.0 launch opened, read back from the chain. */
const kit = ref<LaunchKit | null>(null);
const txUrl = computed(() =>
    hash.value && quote.value
        ? launchTxUrl(quote.value.chainId, hash.value)
        : null,
);

const chainId = computed(() => {
    const evmChainId = target.value?.chain.chainId;

    return (
        walletChains().find((chain) => chain.chainId === evmChainId)?.id ?? null
    );
});

const account = computed(() =>
    chainId.value === null
        ? null
        : (props.wallet.accounts.value.find(
              (entry) => entry.chain === chainId.value,
          ) ?? null),
);

const canSign = computed(() => account.value?.capabilities.send ?? false);

const myAddress = computed(() => account.value?.address ?? '');

/** Turning minting on starts with this account as the minter. */
const setMintable = (on: boolean): void => {
    form.mintable = on;

    if (on && !(form.minter ?? '').trim()) {
        form.minter = myAddress.value;
    }
};

/** The first address added is this account's own: the common case. */
const addAllocation = (): void => {
    const rows = form.allocations ?? [];

    if (rows.length >= STUDIO_MAX_ALLOCATIONS) {
        return;
    }

    form.allocations = [
        ...rows,
        { to: rows.length === 0 ? myAddress.value : '', amount: '' },
    ];
};

const removeAllocation = (index: number): void => {
    form.allocations = (form.allocations ?? []).filter((_, i) => i !== index);
};

const kitNames = (flags: number): string[] =>
    [
        flags & KIT_CREDIT ? t('launchKitCredit') : null,
        flags & KIT_FARM ? t('launchKitFarm') : null,
        flags & KIT_DAO ? t('launchKitDao') : null,
    ].filter((name): name is string => name !== null);

/** One line for the closed settings: what the token will be. */
const setupSummary = computed(() => {
    const kit = form.kit ?? { credit: true, farm: true, dao: true };
    const rows = (form.allocations ?? []).length;
    const parts = [
        form.mintable ? t('launchSetupMintable') : t('launchSetupFixed'),
        rows > 0
            ? t('launchSetupToAddresses', { count: rows })
            : t('launchSetupAllPool'),
        kitNames(
            (kit.credit ? KIT_CREDIT : 0) |
                (kit.farm ? KIT_FARM : 0) |
                (kit.dao ? KIT_DAO : 0),
        ).join(', ') || t('launchSetupNoKit'),
    ];

    return parts.join(' · ');
});

/** Everything the token starts with: the pool's part and the addresses'. */
const totalSupply = computed(() =>
    isStudio.value ? formTotalSupply(form) : null,
);

/**
 * The domain zone this launch opens, when its name and ticker spell one:
 * `.moon` + `DOTMOON` is the zone `moon` in CyberiaDomains. Only on Cyberia,
 * where the domains contract and its launchpads are.
 */
const zone = computed(() =>
    chainId.value === 'cyberia'
        ? zoneFromToken(form.name.trim(), form.symbol.trim())
        : null,
);

/** A name that looks like a zone but whose ticker does not match it. */
const zoneHint = computed(() => {
    const name = form.name.trim();

    if (zone.value || !name.startsWith('.') || name.length < 2) {
        return null;
    }

    return zoneTokenNaming(name.slice(1).toLowerCase()).symbol;
});

/** Somebody already opened it — this launch would be an ordinary token. */
const zoneTaken = ref(false);
const zoneState = ref<'none' | 'opening' | 'opened' | 'failed'>('none');
const zoneError = ref<string | null>(null);

const openZoneFor = async (launched: string): Promise<void> => {
    zoneState.value = 'opening';
    zoneError.value = null;

    try {
        const opened = await props.wallet.domains.openZone(launched);

        zoneState.value = (await awaitDomainTx(opened)) ? 'opened' : 'failed';
    } catch (error) {
        zoneState.value = 'failed';
        zoneError.value =
            error instanceof Error ? error.message : String(error);
    }
};

const symbol = computed(() => target.value?.chain.nativeCurrency.symbol ?? '');

const problem = computed(() =>
    venue.value === null
        ? null
        : launchProblem(form, venue.value, minLiquidity.value),
);

const split = computed(() => {
    const terms = launchTerms(form.creatorFeePct, form.holdersSharePct);

    return terms ? feeSplit(terms.creatorFee, terms.holdersShareBps) : null;
});

const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

const problemText = computed(() => {
    switch (problem.value) {
        case 'name':
            return t('launchNewErrName', { max: LAUNCH_NAME_MAX });
        case 'symbol':
            return t('launchNewErrSymbol', { max: LAUNCH_SYMBOL_MAX });
        case 'supply':
            return t('launchNewErrSupply');
        case 'liquidity':
            return t('launchNewErrLiquidity');
        case 'liquidityMin':
            return t('launchNewErrMin', {
                amount: formatUnits(minLiquidity.value ?? 0n, 18, 4),
                symbol: symbol.value,
            });
        case 'fee':
            return t('launchNewErrFee', { max: MAX_CREATOR_FEE_PCT });
        case 'share':
            return t('launchNewErrShare');
        case 'allocation':
            return t('launchNewErrAllocation', { max: STUDIO_MAX_ALLOCATIONS });
        case 'minter':
            return t('launchNewErrMinter');
        case 'cap':
            return t('launchNewErrCap');
        default:
            return null;
    }
});

const gasBalance = computed(() =>
    chainId.value === null
        ? null
        : (props.wallet.balances.value[chainId.value]?.value ?? null),
);

const amount = (value: bigint, precision = 4): string =>
    formatUnits(value, 18, precision);

/** Gas arrived from the station; re-read the balance that was short. */
const onFunded = (): void => {
    void props.wallet.refreshBalances();
};

const pickImage = (event: Event): void => {
    const file = (event.target as HTMLInputElement).files?.[0] ?? null;

    // The server takes an image of 2 MB at most; saying so here costs
    // nothing, saying so after the launch costs a retry.
    about.image = file && file.size <= 2 * 1024 * 1024 ? file : null;
    aboutError.value =
        file && about.image === null ? t('launchNewImageTooLarge') : null;
};

const refusalText = (error: unknown): string => {
    if (error instanceof LaunchRefused) {
        if (error.code === 'funds') {
            const short = t('launchNewErrFunds', { symbol: symbol.value });

            return isKit.value
                ? `${short} ${t('launchNewFundsFaucet')}`
                : short;
        }

        if (error.code === 'gas') {
            return t('launchNewErrGas');
        }

        return t('launchNewErrReverted', { reason: error.message });
    }

    return error instanceof Error ? error.message : String(error);
};

/** Price the launch and run it as a call. Nothing is signed here. */
const prepare = async (): Promise<void> => {
    if (!target.value || !account.value || chainId.value === null) {
        return;
    }

    busy.value = true;
    failure.value = null;

    try {
        zoneTaken.value = zone.value ? await zoneExists(zone.value) : false;
        quote.value = await quoteLaunch({
            target: target.value,
            form,
            account: account.value.address,
            gasPrice: await props.wallet.gasPrice(chainId.value),
        });
        stage.value = 'confirm';
    } catch (error) {
        failure.value = refusalText(error);
    } finally {
        busy.value = false;
    }
};

const saveAbout = async (): Promise<void> => {
    if (!token.value || !quote.value || chainId.value === null) {
        return;
    }

    const on = chainId.value;

    aboutState.value = 'saving';
    aboutError.value = null;

    try {
        await submitAbout({
            token: token.value,
            chainId: quote.value.chainId,
            name: quote.value.name,
            symbol: quote.value.symbol,
            // The raw object: a File behind a reactive proxy is not a Blob
            // to FormData, and the upload would fail on its type.
            about: toRaw(about),
            sign: (message) => props.wallet.signMessage(on, message),
        });
        aboutState.value = 'saved';
    } catch (error) {
        aboutState.value = 'failed';
        aboutError.value =
            error instanceof Error ? error.message : String(error);
    }
};

const launch = async (): Promise<void> => {
    if (chainId.value === null || quote.value === null) {
        return;
    }

    busy.value = true;
    failure.value = null;

    try {
        hash.value = await props.wallet.launchToken(chainId.value, quote.value);
    } catch (error) {
        failure.value = refusalText(error);
        busy.value = false;

        return;
    }

    // From here a token may exist, so nothing below sends the user back to a
    // screen that would offer to launch it a second time.
    stage.value = 'mining';

    try {
        const outcome = await awaitLaunch(quote.value, hash.value);

        if (outcome.status === 'failed') {
            failure.value = t('launchNewReverted');
            stage.value = 'confirm';
            hash.value = null;

            return;
        }

        if (outcome.status === 'launched') {
            token.value = outcome.token;
        } else {
            unread.value = true;
        }
    } catch {
        // A wait that timed out says nothing about the launch.
        unread.value = true;
    } finally {
        busy.value = false;
    }

    stage.value = 'done';
    emit('launched');
    void props.wallet.refreshBalances();

    if (token.value && isKit.value) {
        // The contract opened the DAO itself; the server's watch is Cyberia's.
        void readKit(
            quote.value.chainId,
            token.value,
            quote.value.launchpad,
        ).then((opened) => {
            kit.value = opened;
        });
    } else if (token.value) {
        daoState.value = 'opening';
        void watchLaunch(token.value).then((opened) => {
            dao.value = opened;
            daoState.value = opened ? 'opened' : 'later';
        });
    }

    // The zone is the second half of the same act the hold agreed to, so it
    // is signed straight away — anyone could open it, and the creator should
    // not have to come back to be first.
    if (token.value && zone.value && !zoneTaken.value) {
        await openZoneFor(token.value);
    }

    if (token.value && hasAbout(about)) {
        await saveAbout();
    }
};

/** The floor of whichever contract the form's token would be made by. */
watch(
    venue,
    async (next) => {
        if (target.value && next) {
            const read = await readMinLiquidity(target.value, next);

            if (next === venue.value) {
                minLiquidity.value = read;
            }
        }
    },
    { immediate: true },
);
</script>

<template>
    <div class="cw-stack">
        <button
            v-if="stage !== 'mining'"
            type="button"
            class="cw-back"
            :disabled="busy"
            @click="emit('back')"
        >
            ← {{ t('launchpad') }}
        </button>

        <!-- ---------------------------------------------------- mining --- -->
        <template v-if="stage === 'mining'">
            <h2 class="cw-title" style="margin: 22px 0 8px">
                {{ t('launchNewMiningTitle') }}
            </h2>
            <p class="cw-prose">{{ t('launchNewMiningBody') }}</p>
            <a
                v-if="txUrl"
                class="cw-btn cw-btn-secondary"
                style="margin-top: 16px; text-decoration: none"
                :href="txUrl"
                target="_blank"
                rel="noopener noreferrer"
            >
                {{ t('launchExplorer') }}
                <ExternalLink :size="14" aria-hidden="true" />
            </a>
        </template>

        <!-- ------------------------------------------------------ done --- -->
        <template v-else-if="stage === 'done'">
            <h2 class="cw-title" style="margin: 22px 0 8px">
                {{ unread ? t('launchNewSentTitle') : t('launchNewDoneTitle') }}
            </h2>
            <p class="cw-prose">
                {{ unread ? t('launchNewUnreadBody') : t('launchNewDoneBody') }}
            </p>

            <div
                v-if="quote"
                class="cw-card"
                style="margin-top: 16px; padding: 14px 16px"
            >
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchNewToken') }}</span>
                    <span class="cw-kv-val"
                        >{{ quote.name }} · {{ quote.symbol }}</span
                    >
                </div>
                <div v-if="token" class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchContract') }}</span>
                    <span
                        class="cw-kv-val"
                        style="overflow-wrap: anywhere; text-align: right"
                        >{{ token }}</span
                    >
                </div>
            </div>

            <p
                v-if="zoneState === 'opening'"
                class="cw-label"
                style="margin-top: 14px; color: var(--cw-faint)"
            >
                {{ t('launchZoneOpening', { zone: zone ?? '' }) }}
            </p>
            <p
                v-else-if="zoneState === 'opened'"
                class="cw-note"
                style="margin-top: 14px"
            >
                <span style="flex: 1">{{
                    t('launchZoneOpened', { zone: zone ?? '' })
                }}</span>
                <button type="button" class="cw-back" @click="emit('domains')">
                    {{ t('domainsTitle') }} →
                </button>
            </p>
            <p
                v-else-if="zoneState === 'failed'"
                class="cw-note cw-note-bad"
                style="margin-top: 14px"
            >
                <span style="flex: 1">{{
                    t('launchZoneFailed', {
                        zone: zone ?? '',
                        reason: zoneError ?? '',
                    })
                }}</span>
                <button
                    v-if="token"
                    type="button"
                    class="cw-back"
                    @click="openZoneFor(token)"
                >
                    {{ t('retry') }}
                </button>
            </p>

            <div
                v-if="kit"
                class="cw-card"
                style="margin-top: 14px; padding: 14px 16px"
            >
                <div class="cw-label" style="margin-bottom: 6px">
                    {{ t('launchKitTitle') }}
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchKitCredit') }}</span>
                    <span class="cw-kv-val">{{
                        kit.credit ? t('launchKitOpen') : '—'
                    }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchKitFarm') }}</span>
                    <span class="cw-kv-val">{{
                        kit.farm ? t('launchKitOpen') : '—'
                    }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchKitDao') }}</span>
                    <span class="cw-kv-val">{{
                        kit.dao ? t('launchKitOpen') : '—'
                    }}</span>
                </div>
                <div v-if="kit.zone" class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchKitZone') }}</span>
                    <span class="cw-kv-val">{{ t('launchKitOpen') }}</span>
                </div>
            </div>
            <p v-if="token && isKit" class="cw-note" style="margin-top: 14px">
                <span>{{ t('launchKitNoSwap') }}</span>
            </p>

            <p
                v-if="daoState === 'opening'"
                class="cw-label"
                style="margin-top: 14px; color: var(--cw-faint)"
            >
                {{ t('launchDaoOpening') }}
            </p>
            <p
                v-else-if="daoState === 'opened' && dao"
                class="cw-note"
                style="margin-top: 14px"
            >
                <span style="flex: 1">{{
                    t('launchDaoOpened', { dao: dao.name })
                }}</span>
                <button type="button" class="cw-back" @click="emit('dao')">
                    {{ t('dao') }} →
                </button>
            </p>
            <p
                v-else-if="daoState === 'later'"
                class="cw-label"
                style="margin-top: 14px; color: var(--cw-faint)"
            >
                {{ t('launchDaoLater') }}
            </p>

            <p
                v-if="aboutState === 'saving'"
                class="cw-label"
                style="margin-top: 14px; color: var(--cw-faint)"
            >
                {{ t('launchNewAboutSaving') }}
            </p>
            <p
                v-else-if="aboutState === 'saved'"
                class="cw-note"
                style="margin-top: 14px"
            >
                <span>{{ t('launchNewAboutSaved') }}</span>
            </p>
            <p
                v-else-if="aboutState === 'failed'"
                class="cw-note cw-note-bad"
                style="margin-top: 14px"
            >
                <span style="flex: 1">{{
                    t('launchNewAboutFailed', { reason: aboutError ?? '' })
                }}</span>
                <button type="button" class="cw-back" @click="saveAbout">
                    {{ t('retry') }}
                </button>
            </p>

            <button
                v-if="token && !isKit"
                type="button"
                class="cw-btn cw-btn-primary"
                style="margin-top: 18px"
                @click="emit('swap', token)"
            >
                {{ t('launchBuy') }}
            </button>
            <a
                v-if="txUrl"
                class="cw-btn cw-btn-secondary"
                style="margin-top: 10px; text-decoration: none"
                :href="txUrl"
                target="_blank"
                rel="noopener noreferrer"
            >
                {{ t('launchExplorer') }}
                <ExternalLink :size="14" aria-hidden="true" />
            </a>
            <button
                type="button"
                class="cw-ghost"
                style="margin-top: 10px"
                @click="emit('back')"
            >
                {{ t('launchNewBackToList') }}
            </button>
        </template>

        <!-- --------------------------------------------------- confirm --- -->
        <template v-else-if="stage === 'confirm' && quote">
            <h2 class="cw-title" style="margin: 22px 0 8px">
                {{ t('launchNewConfirmTitle') }}
            </h2>

            <div class="cw-card" style="margin-top: 8px; padding: 14px 16px">
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchNewToken') }}</span>
                    <span class="cw-kv-val"
                        >{{ quote.name }} · {{ quote.symbol }}</span
                    >
                </div>
                <template v-if="quote.venue === 'studio'">
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{
                            t('launchPoolSupply')
                        }}</span>
                        <span class="cw-kv-val">{{
                            amount(quote.supply, 0)
                        }}</span>
                    </div>
                    <div
                        v-for="(row, index) in quote.allocations"
                        :key="index"
                        class="cw-kv"
                    >
                        <span class="cw-kv-key">{{
                            t('launchAllocConfirm', {
                                address: shortAddress(row.to),
                            })
                        }}</span>
                        <span class="cw-kv-val">{{
                            amount(row.amount, 0)
                        }}</span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{
                            t('launchTotalSupply')
                        }}</span>
                        <span class="cw-kv-val">{{
                            amount(
                                quote.allocations.reduce(
                                    (sum, row) => sum + row.amount,
                                    quote.supply,
                                ),
                                0,
                            )
                        }}</span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{
                            t('launchConfirmMinter')
                        }}</span>
                        <span class="cw-kv-val">{{
                            quote.minter === ZeroAddress
                                ? t('launchMintFixed')
                                : shortAddress(quote.minter)
                        }}</span>
                    </div>
                    <div v-if="quote.minter !== ZeroAddress" class="cw-kv">
                        <span class="cw-kv-key">{{
                            t('launchConfirmCap')
                        }}</span>
                        <span class="cw-kv-val">{{
                            quote.maxSupply === 0n
                                ? t('launchConfirmCapNone')
                                : amount(quote.maxSupply, 0)
                        }}</span>
                    </div>
                </template>
                <div v-else class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchSupply') }}</span>
                    <span class="cw-kv-val">{{ amount(quote.supply, 0) }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchNewPaired') }}</span>
                    <span class="cw-kv-val"
                        >{{ amount(quote.liquidity) }} {{ symbol }}</span
                    >
                </div>
                <div v-if="zone" class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchZone') }}</span>
                    <span class="cw-kv-val">.{{ zone }}</span>
                </div>
                <div v-if="venueHasFee(quote.venue) && split" class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchNewTradeFee') }}</span>
                    <span class="cw-kv-val">{{ split.poolFeePct }}%</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('mintFee') }}</span>
                    <span class="cw-kv-val"
                        >{{ formatUnits(quote.fee, 18, 6) }} {{ symbol }}</span
                    >
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchNewNetwork') }}</span>
                    <span class="cw-kv-val">{{ target?.chain.name }}</span>
                </div>
            </div>

            <p
                v-if="zone && zoneTaken"
                class="cw-note cw-note-warn"
                style="margin-top: 14px"
            >
                <span>{{ t('launchZoneTaken', { zone }) }}</span>
            </p>
            <p v-else-if="zone" class="cw-prose" style="margin-top: 14px">
                {{ t('launchZoneConfirm', { zone }) }}
            </p>

            <p class="cw-note cw-note-warn" style="margin-top: 14px">
                <span>{{
                    t(
                        quote.venue === 'v2'
                            ? 'launchNewPermanentV2'
                            : 'launchNewPermanentV3',
                        {
                            amount: amount(quote.liquidity),
                            symbol,
                        },
                    )
                }}</span>
            </p>

            <p
                v-if="quote.venue === 'studio' && quote.minter !== ZeroAddress"
                class="cw-note cw-note-warn"
                style="margin-top: 12px"
            >
                <span>{{ t('launchMintRisk') }}</span>
            </p>

            <p
                v-if="quote.venue === 'kit' || quote.venue === 'studio'"
                class="cw-prose"
                style="margin-top: 12px"
            >
                {{
                    kitNames(quote.kit).length > 0
                        ? t('launchConfirmKit', {
                              parts: kitNames(quote.kit).join(', '),
                          })
                        : t('launchConfirmNoKit')
                }}
            </p>
            <p
                v-if="quote.venue === 'studio'"
                class="cw-data"
                style="margin-top: 8px"
            >
                {{ t('launchStudioNote') }}
            </p>

            <p v-if="hasAbout(about)" class="cw-note" style="margin-top: 12px">
                <span>{{ t('launchNewAboutAfter') }}</span>
            </p>

            <GasSponsor
                v-if="chainId !== null"
                :chain="chainId"
                :address="account?.address"
                :fee="quote.fee"
                :gas-balance="gasBalance"
                :symbol="symbol"
                :decimals="18"
                @funded="onFunded"
            />

            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 12px"
            >
                <span>{{ failure }}</span>
            </p>

            <div style="margin-top: 18px">
                <HoldButton
                    :label="t('launchNewHold')"
                    :disabled="busy || !canSign"
                    @complete="launch"
                />
            </div>

            <button
                type="button"
                class="cw-ghost"
                style="margin-top: 10px"
                :disabled="busy"
                @click="stage = 'compose'"
            >
                {{ t('cancel') }}
            </button>
        </template>

        <!-- --------------------------------------------------- compose --- -->
        <template v-else>
            <h2 class="cw-title" style="margin: 22px 0 8px">
                {{ t('launchNewTitle') }}
            </h2>
            <p class="cw-prose">
                {{
                    t(
                        isKit
                            ? 'launchNewBodyKit'
                            : charges
                              ? 'launchNewBodyV3'
                              : 'launchNewBodyV2',
                    )
                }}
            </p>
            <p v-if="canSetUp" class="cw-data" style="margin-top: 8px">
                {{ t('launchNewBodyKitSetup') }}
            </p>
            <p v-if="isKit" class="cw-note" style="margin-top: 12px">
                <span style="flex: 1">{{ t('launchpadTestnet') }}</span>
                <a class="cw-back" href="/fuji">{{ t('launchpadFaucet') }} →</a>
            </p>

            <p
                v-if="venue === null"
                class="cw-note cw-note-warn"
                style="margin-top: 16px"
            >
                <span>{{ t('launchNewNoLaunchpad') }}</span>
            </p>
            <p
                v-else-if="!account"
                class="cw-note cw-note-warn"
                style="margin-top: 16px"
            >
                <span>{{ t('launchNewNoAccount') }}</span>
            </p>
            <p
                v-else-if="!canSign"
                class="cw-note cw-note-warn"
                style="margin-top: 16px"
            >
                <span>{{ t('launchNewWatchOnly') }}</span>
            </p>

            <label class="cw-label" style="display: block; margin: 18px 0 6px">
                {{ t('launchNewName') }}
            </label>
            <input
                v-model="form.name"
                class="cw-input"
                type="text"
                :maxlength="LAUNCH_NAME_MAX"
                placeholder="Lain Coin"
            />

            <label class="cw-label" style="display: block; margin: 14px 0 6px">
                {{ t('launchNewSymbol') }}
            </label>
            <input
                v-model="form.symbol"
                class="cw-input"
                type="text"
                spellcheck="false"
                autocapitalize="characters"
                :maxlength="
                    form.name.trim().startsWith('.') ? 64 : LAUNCH_SYMBOL_MAX
                "
                placeholder="LAIN"
            />
            <!--
              A token named `.moon` with the ticker DOTMOON opens the domain
              zone .moon — said while it is being typed, because the rule is
              exact and a ticker one letter off is an ordinary token.
            -->
            <p v-if="zone" class="cw-note" style="margin-top: 8px">
                <span>{{ t('launchZoneWill', { zone }) }}</span>
            </p>
            <p v-else-if="zoneHint" class="cw-data" style="margin-top: 6px">
                {{ t('launchZoneHint', { symbol: zoneHint }) }}
            </p>

            <label class="cw-label" style="display: block; margin: 14px 0 6px">
                {{ isStudio ? t('launchPoolSupply') : t('launchSupply') }}
            </label>
            <input
                v-model="form.supply"
                class="cw-input"
                type="text"
                inputmode="decimal"
            />
            <p v-if="!isStudio" class="cw-data" style="margin-top: 6px">
                {{ t('launchNewSupplyNote') }}
            </p>
            <p
                v-else-if="totalSupply !== null"
                class="cw-data"
                style="margin-top: 6px"
            >
                {{ t('launchTotalSupply') }}: {{ amount(totalSupply, 0) }}
            </p>

            <label class="cw-label" style="display: block; margin: 14px 0 6px">
                {{ t('launchNewPaired') }} · {{ symbol }}
            </label>
            <input
                v-model="form.liquidity"
                class="cw-input"
                type="text"
                inputmode="decimal"
            />
            <p class="cw-data" style="margin-top: 6px">
                {{
                    minLiquidity === null
                        ? t('launchNewPairedNote')
                        : t('launchNewPairedMin', {
                              amount: amount(minLiquidity),
                              symbol,
                          })
                }}
            </p>

            <template v-if="charges">
                <label
                    class="cw-label"
                    style="display: block; margin: 18px 0 6px"
                >
                    {{ t('launchNewCreatorFee', { max: MAX_CREATOR_FEE_PCT }) }}
                </label>
                <input
                    v-model="form.creatorFeePct"
                    class="cw-input"
                    type="text"
                    inputmode="decimal"
                />

                <label
                    class="cw-label"
                    style="display: block; margin: 14px 0 6px"
                >
                    {{ t('launchNewHoldersShare') }}
                </label>
                <input
                    v-model="form.holdersSharePct"
                    class="cw-input"
                    type="text"
                    inputmode="decimal"
                />

                <div
                    v-if="split"
                    class="cw-card"
                    style="margin-top: 12px; padding: 12px 16px"
                >
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{
                            t('launchNewTradeFee')
                        }}</span>
                        <span class="cw-kv-val">{{ split.poolFeePct }}%</span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{ t('launchNewToYou') }}</span>
                        <span class="cw-kv-val">{{
                            pct(split.creatorBps)
                        }}</span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{
                            t('launchNewToHolders')
                        }}</span>
                        <span class="cw-kv-val">{{
                            pct(split.holdersBps)
                        }}</span>
                    </div>
                    <div class="cw-kv">
                        <span class="cw-kv-key">{{
                            t('launchNewToProtocol')
                        }}</span>
                        <span class="cw-kv-val">{{
                            pct(split.treasuryBps)
                        }}</span>
                    </div>
                </div>
                <p class="cw-data" style="margin-top: 6px">
                    {{ t('launchNewSplitNote') }}
                </p>
            </template>

            <!--
              Cyberia 2.0: the token's own rules. Closed by default, and the
              summary line says what the defaults make — a fixed token, all of
              it in the pool, with the whole kit — so nobody has to open it.
            -->
            <details
                v-if="canSetUp"
                class="cw-card"
                style="margin-top: 18px; padding: 12px 16px"
                :open="setupOpen"
                @toggle="setupOpen = ($event.target as HTMLDetailsElement).open"
            >
                <summary
                    style="
                        display: flex;
                        flex-wrap: wrap;
                        gap: 4px 12px;
                        align-items: baseline;
                        justify-content: space-between;
                        cursor: pointer;
                    "
                >
                    <span class="cw-label" style="color: var(--cw-text)">{{
                        t('launchSetupTitle')
                    }}</span>
                    <span class="cw-data" style="font-size: 12px">{{
                        setupSummary
                    }}</span>
                </summary>

                <h3 class="cw-label" style="margin: 16px 0 8px">
                    {{ t('launchMintTitle') }}
                </h3>
                <div
                    class="cw-seg"
                    role="group"
                    :aria-label="t('launchMintTitle')"
                >
                    <button
                        type="button"
                        class="cw-seg-item"
                        :aria-pressed="!form.mintable"
                        @click="setMintable(false)"
                    >
                        {{ t('launchMintFixed') }}
                    </button>
                    <button
                        type="button"
                        class="cw-seg-item"
                        :aria-pressed="form.mintable === true"
                        @click="setMintable(true)"
                    >
                        {{ t('launchMintMore') }}
                    </button>
                </div>
                <p class="cw-data" style="margin-top: 6px">
                    {{
                        form.mintable
                            ? t('launchMintMoreNote')
                            : t('launchMintFixedNote')
                    }}
                </p>
                <template v-if="form.mintable">
                    <label
                        class="cw-label"
                        style="display: block; margin: 12px 0 6px"
                    >
                        {{ t('launchMinter') }}
                    </label>
                    <div style="display: flex; gap: 8px">
                        <input
                            v-model="form.minter"
                            class="cw-input"
                            type="text"
                            spellcheck="false"
                            autocomplete="off"
                            placeholder="0x…"
                            style="flex: 1; min-width: 0"
                        />
                        <button
                            v-if="myAddress && form.minter !== myAddress"
                            type="button"
                            class="cw-chip"
                            @click="form.minter = myAddress"
                        >
                            {{ t('launchMinterMe') }}
                        </button>
                    </div>
                    <label
                        class="cw-label"
                        style="display: block; margin: 12px 0 6px"
                    >
                        {{ t('launchMaxSupply') }}
                    </label>
                    <input
                        v-model="form.maxSupply"
                        class="cw-input"
                        type="text"
                        inputmode="decimal"
                        :placeholder="t('launchConfirmCapNone')"
                    />
                    <p class="cw-data" style="margin-top: 6px">
                        {{ t('launchMaxSupplyNote') }}
                    </p>
                </template>

                <h3 class="cw-label" style="margin: 20px 0 4px">
                    {{ t('launchAllocTitle') }}
                </h3>
                <p class="cw-data">{{ t('launchAllocNote') }}</p>
                <div
                    v-for="(row, index) in form.allocations ?? []"
                    :key="index"
                    style="
                        display: grid;
                        grid-template-columns: minmax(0, 1fr) 34%;
                        gap: 8px;
                        margin-top: 10px;
                    "
                >
                    <input
                        v-model="row.to"
                        class="cw-input"
                        type="text"
                        spellcheck="false"
                        autocomplete="off"
                        placeholder="0x…"
                        :aria-label="t('tokenMintTo')"
                    />
                    <input
                        v-model="row.amount"
                        class="cw-input"
                        type="text"
                        inputmode="decimal"
                        :placeholder="t('launchAllocAmount')"
                        :aria-label="t('launchAllocAmount')"
                    />
                    <button
                        type="button"
                        class="cw-ghost"
                        style="
                            grid-column: 1 / -1;
                            justify-self: end;
                            margin: 0;
                        "
                        @click="removeAllocation(index)"
                    >
                        {{ t('launchAllocRemove') }}
                    </button>
                </div>
                <button
                    v-if="
                        (form.allocations ?? []).length < STUDIO_MAX_ALLOCATIONS
                    "
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="height: 40px; margin-top: 10px"
                    @click="addAllocation"
                >
                    {{ t('launchAllocAdd') }}
                </button>

                <h3 class="cw-label" style="margin: 20px 0 4px">
                    {{ t('launchKitPick') }}
                </h3>
                <label
                    v-for="part in ['credit', 'farm', 'dao'] as const"
                    :key="part"
                    class="cw-row"
                    style="
                        align-items: flex-start;
                        gap: 12px;
                        margin-top: 10px;
                        cursor: pointer;
                    "
                >
                    <span style="flex: 1; min-width: 0">
                        <span style="display: block">{{
                            t(
                                part === 'credit'
                                    ? 'launchKitCredit'
                                    : part === 'farm'
                                      ? 'launchKitFarm'
                                      : 'launchKitDao',
                            )
                        }}</span>
                        <span class="cw-data" style="display: block">{{
                            t(
                                part === 'credit'
                                    ? 'launchKitCreditNote'
                                    : part === 'farm'
                                      ? 'launchKitFarmNote'
                                      : 'launchKitDaoNote',
                            )
                        }}</span>
                    </span>
                    <input
                        v-if="form.kit"
                        v-model="form.kit[part]"
                        type="checkbox"
                        style="
                            width: 20px;
                            height: 20px;
                            margin-top: 2px;
                            accent-color: var(--cw-accent);
                        "
                    />
                </label>
                <p class="cw-data" style="margin-top: 12px">
                    {{ t('launchKitZoneNote') }}
                </p>
                <p v-if="isStudio" class="cw-note" style="margin-top: 12px">
                    <span>{{ t('launchStudioNote') }}</span>
                </p>
            </details>

            <h3 class="cw-label" style="margin: 24px 0 4px">
                {{ t('launchNewAbout') }}
            </h3>
            <p class="cw-data">{{ t('launchNewAboutNote') }}</p>

            <label class="cw-label" style="display: block; margin: 12px 0 6px">
                {{ t('mintDescription') }}
            </label>
            <textarea
                v-model="about.description"
                class="cw-textarea"
                rows="3"
                maxlength="2000"
            ></textarea>

            <label class="cw-label" style="display: block; margin: 14px 0 6px">
                {{ t('launchNewLogo') }}
            </label>
            <input
                class="cw-input"
                type="file"
                accept="image/*"
                @change="pickImage"
            />
            <p v-if="aboutError" class="cw-data" style="margin-top: 6px">
                {{ aboutError }}
            </p>

            <label class="cw-label" style="display: block; margin: 14px 0 6px">
                X
            </label>
            <input
                v-model="about.x"
                class="cw-input"
                type="text"
                spellcheck="false"
                placeholder="@handle"
            />

            <label class="cw-label" style="display: block; margin: 14px 0 6px">
                Telegram
            </label>
            <input
                v-model="about.telegram"
                class="cw-input"
                type="text"
                spellcheck="false"
                placeholder="@group"
            />

            <label class="cw-label" style="display: block; margin: 14px 0 6px">
                {{ t('launchNewWebsite') }}
            </label>
            <input
                v-model="about.website"
                class="cw-input"
                type="url"
                spellcheck="false"
                placeholder="https://"
            />

            <p
                v-if="failure"
                class="cw-note cw-note-bad"
                style="margin-top: 16px"
            >
                <span>{{ failure }}</span>
            </p>
            <p
                v-else-if="problemText && (form.name || form.symbol)"
                class="cw-data"
                style="margin-top: 16px"
            >
                {{ problemText }}
            </p>

            <button
                type="button"
                class="cw-btn cw-btn-primary"
                style="height: 48px; margin-top: 20px"
                :disabled="busy || problem !== null || !canSign"
                @click="prepare"
            >
                {{ busy ? t('launchNewChecking') : t('launchNewContinue') }}
            </button>

            <p class="cw-note cw-note-warn" style="margin-top: 14px">
                <span>{{ t('launchRisk') }}</span>
            </p>
        </template>
    </div>
</template>
