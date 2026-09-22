<script setup lang="ts">
import { ExternalLink } from 'lucide-vue-next';
import { computed, onMounted, reactive, ref, toRaw } from 'vue';
import GasSponsor from '@/components/wallet/GasSponsor.vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { formatUnits, walletChains } from '@/lib/wallet';
import {
    LAUNCH_NAME_MAX,
    LAUNCH_SYMBOL_MAX,
    LaunchRefused,
    MAX_CREATOR_FEE_PCT,
    awaitLaunch,
    feeSplit,
    hasAbout,
    launchProblem,
    launchTerms,
    launchTxUrl,
    launchVenue,
    launchpadChains,
    quoteLaunch,
    readMinLiquidity,
    submitAbout,
} from '@/lib/wallet/launchpad';
import type {
    LaunchAbout,
    LaunchForm,
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
 */

const props = defineProps<{ wallet: MultiWallet }>();

const emit = defineEmits<{
    back: [];
    launched: [];
    swap: [contract: string];
}>();

const { t } = useLocale(walletMessages);

type Stage = 'compose' | 'confirm' | 'mining' | 'done';

const stage = ref<Stage>('compose');
const busy = ref(false);
const failure = ref<string | null>(null);

const target = computed(() => launchpadChains()[0] ?? null);
const venue = computed(() => (target.value ? launchVenue(target.value) : null));

const form = reactive<LaunchForm>({
    name: '',
    symbol: '',
    supply: '1000000',
    liquidity: target.value?.defaultLiquidity ?? '10',
    creatorFeePct: '1',
    holdersSharePct: '0',
});

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
const aboutError = ref<string | null>(null);

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
            return t('launchNewErrFunds', { symbol: symbol.value });
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

    if (token.value && hasAbout(about)) {
        await saveAbout();
    }
};

onMounted(async () => {
    if (target.value) {
        minLiquidity.value = await readMinLiquidity(target.value);
    }
});
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
                v-if="hash && quote"
                class="cw-btn cw-btn-secondary"
                style="margin-top: 16px; text-decoration: none"
                :href="launchTxUrl(quote.chainId, hash)"
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
                v-if="token"
                type="button"
                class="cw-btn cw-btn-primary"
                style="margin-top: 18px"
                @click="emit('swap', token)"
            >
                {{ t('launchBuy') }}
            </button>
            <a
                v-if="hash && quote"
                class="cw-btn cw-btn-secondary"
                style="margin-top: 10px; text-decoration: none"
                :href="launchTxUrl(quote.chainId, hash)"
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
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchSupply') }}</span>
                    <span class="cw-kv-val">{{ amount(quote.supply, 0) }}</span>
                </div>
                <div class="cw-kv">
                    <span class="cw-kv-key">{{ t('launchNewPaired') }}</span>
                    <span class="cw-kv-val"
                        >{{ amount(quote.liquidity) }} {{ symbol }}</span
                    >
                </div>
                <div v-if="quote.venue === 'v3' && split" class="cw-kv">
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

            <p class="cw-note cw-note-warn" style="margin-top: 14px">
                <span>{{
                    t(
                        quote.venue === 'v3'
                            ? 'launchNewPermanentV3'
                            : 'launchNewPermanentV2',
                        {
                            amount: amount(quote.liquidity),
                            symbol,
                        },
                    )
                }}</span>
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
                {{ t(venue === 'v3' ? 'launchNewBodyV3' : 'launchNewBodyV2') }}
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
                :maxlength="LAUNCH_SYMBOL_MAX"
                placeholder="LAIN"
            />

            <label class="cw-label" style="display: block; margin: 14px 0 6px">
                {{ t('launchSupply') }}
            </label>
            <input
                v-model="form.supply"
                class="cw-input"
                type="text"
                inputmode="decimal"
            />
            <p class="cw-data" style="margin-top: 6px">
                {{ t('launchNewSupplyNote') }}
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

            <template v-if="venue === 'v3'">
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
