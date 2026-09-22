<script setup lang="ts">
import { computed, ref } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import {
    FORK_PRESETS,
    customNetworkId,
    customNetworkTag,
    evmPresets,
} from '@/lib/wallet';
import type {
    CustomNetwork,
    CustomNetworkProblem,
    UtxoAddressType,
    WalletChainId,
} from '@/lib/wallet';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Adding a network is a derivation, not an enrolment.
 *
 * An EVM chain is the same key at a different chain id; a Bitcoin fork is the
 * same key at a different SLIP-44 coin type. So this screen never asks for the
 * seed phrase again and never could — it only asks which path to walk and which
 * endpoint to read through, and shows the path it will use before committing.
 *
 * The endpoint is the part nobody can vouch for, which is why the warning is on
 * the screen rather than in a tooltip and why the resulting network is drawn
 * dashed everywhere it appears afterwards.
 */

const props = defineProps<{ wallet: MultiWallet }>();

const emit = defineEmits<{ back: []; added: [chain: WalletChainId] }>();

const { t } = useLocale(walletMessages);

const kind = ref<'evm' | 'utxo'>('evm');
const problem = ref<CustomNetworkProblem | null>(null);

const name = ref('');
const symbol = ref('');
const explorer = ref('');

const chainId = ref('');
const rpcUrl = ref('');

const coinType = ref('');
const addressType = ref<UtxoAddressType>('bech32');
const hrp = ref('');
const p2pkhVersion = ref('0');
const p2shVersion = ref('5');
const api = ref('');

const preset = ref('');

/** Chain ids already derived here, so quick-fill never offers a duplicate. */
const takenChainIds = computed(() =>
    props.wallet.chains.value
        .map((chain) => chain.chainId)
        .filter((id): id is number => typeof id === 'number'),
);

const ADDRESS_TYPES: {
    key: UtxoAddressType;
    label: () => string;
    note: () => string;
    purpose: number;
}[] = [
    {
        key: 'bech32',
        label: () => t('addrBech32'),
        note: () => t('addrBech32Note'),
        purpose: 84,
    },
    {
        key: 'p2sh',
        label: () => t('addrP2sh'),
        note: () => t('addrP2shNote'),
        purpose: 49,
    },
    {
        key: 'legacy',
        label: () => t('addrLegacy'),
        note: () => t('addrLegacyNote'),
        purpose: 44,
    },
];

/** The path the new account will actually be derived at, shown before adding. */
const path = computed(() => {
    if (kind.value === 'evm') {
        return "m/44'/60'/0'/0/0";
    }

    const purpose =
        ADDRESS_TYPES.find((entry) => entry.key === addressType.value)
            ?.purpose ?? 84;

    return `m/${purpose}'/${coinType.value || 'coin'}'/0'/0/0`;
});

const draft = computed<CustomNetwork>(() =>
    kind.value === 'evm'
        ? {
              kind: 'evm',
              id: customNetworkId('evm', symbol.value, Number(chainId.value)),
              name: name.value.trim(),
              symbol: symbol.value.trim(),
              chainId: Number(chainId.value),
              rpcUrl: rpcUrl.value.trim(),
              explorer: explorer.value.trim() || null,
          }
        : {
              kind: 'utxo',
              id: customNetworkId('utxo', symbol.value, Number(coinType.value)),
              name: name.value.trim(),
              symbol: symbol.value.trim(),
              coinType: Number(coinType.value),
              addressType: addressType.value,
              hrp: addressType.value === 'bech32' ? hrp.value.trim() : null,
              p2pkhVersion: Number(p2pkhVersion.value),
              p2shVersion: Number(p2shVersion.value),
              api: api.value.trim(),
              explorer: explorer.value.trim() || null,
          },
);

/** Preview of the tile the network will carry once it exists. */
const previewMark = computed(() => ({
    tag: customNetworkTag(name.value, symbol.value),
    hue: 'var(--cw-net-custom)',
    shape: (kind.value === 'evm' ? 'square' : 'rounded') as
        | 'square'
        | 'rounded',
    unverified: true,
}));

const ERRORS: Record<CustomNetworkProblem, string> = {
    name: 'errName',
    symbol: 'errSymbol',
    chainId: 'errChainId',
    rpc: 'errRpc',
    coinType: 'errCoinType',
    api: 'errApi',
    explorer: 'errExplorer',
    prefix: 'errPrefix',
    duplicate: 'errDuplicate',
};

const switchKind = (next: 'evm' | 'utxo'): void => {
    kind.value = next;
    preset.value = '';
    problem.value = null;
};

const fillEvm = (entry: ReturnType<typeof evmPresets>[number]): void => {
    preset.value = entry.label;
    name.value = entry.values.name;
    symbol.value = entry.values.symbol;
    chainId.value = String(entry.values.chainId);
    rpcUrl.value = entry.values.rpcUrl;
    explorer.value = entry.values.explorer ?? '';
    problem.value = null;
};

const fillFork = (entry: (typeof FORK_PRESETS)[number]): void => {
    preset.value = entry.label;
    name.value = entry.values.name;
    symbol.value = entry.values.symbol;
    coinType.value = String(entry.values.coinType);
    addressType.value = entry.values.addressType;
    hrp.value = entry.values.hrp ?? '';
    p2pkhVersion.value = String(entry.values.p2pkhVersion);
    p2shVersion.value = String(entry.values.p2shVersion);
    explorer.value = entry.values.explorer ?? '';
    problem.value = null;
};

const submit = (): void => {
    const failure = props.wallet.addNetwork(draft.value);

    problem.value = failure;

    if (failure === null) {
        emit('added', draft.value.id);
    }
};

const versionModel = computed({
    get: () =>
        addressType.value === 'legacy' ? p2pkhVersion.value : p2shVersion.value,
    set: (value: string) => {
        if (addressType.value === 'legacy') {
            p2pkhVersion.value = value;
        } else {
            p2shVersion.value = value;
        }
    },
});

const digits = (value: string): string => value.replace(/[^0-9]/g, '');
</script>

<template>
    <div class="cw-stack">
        <div class="cw-row" style="margin-bottom: 18px">
            <button type="button" class="cw-back" @click="emit('back')">
                ← {{ t('back') }}
            </button>
            <span style="font: 500 14px/1 var(--cw-sans)">{{
                t('addNetwork')
            }}</span>
            <span style="width: 44px"></span>
        </div>

        <p class="cw-prose" style="margin-bottom: 18px">
            {{ t('addNetworkBody') }}
        </p>

        <!-- Two account models, two forms: an EVM chain and a UTXO fork do not
             ask the same questions and pretending otherwise would hide one. -->
        <div style="display: flex; gap: 8px; margin-bottom: 20px">
            <button
                v-for="entry in [
                    {
                        id: 'evm' as const,
                        label: t('addKindEvm'),
                        hint: t('addKindEvmHint'),
                    },
                    {
                        id: 'utxo' as const,
                        label: t('addKindUtxo'),
                        hint: t('addKindUtxoHint'),
                    },
                ]"
                :key="entry.id"
                type="button"
                class="cw-card"
                style="
                    flex: 1;
                    min-height: 56px;
                    padding: 10px 12px;
                    text-align: left;
                    cursor: pointer;
                "
                :style="
                    kind === entry.id
                        ? {
                              borderColor: 'var(--cw-accent)',
                              background: 'var(--cw-raised)',
                          }
                        : {}
                "
                :aria-pressed="kind === entry.id"
                @click="switchKind(entry.id)"
            >
                <span
                    style="
                        display: block;
                        font: 500 13px/1 var(--cw-mono);
                        letter-spacing: 0.07em;
                        text-transform: uppercase;
                    "
                    :style="{
                        color:
                            kind === entry.id
                                ? 'var(--cw-text)'
                                : 'var(--cw-dim)',
                    }"
                    >{{ entry.label }}</span
                >
                <span
                    style="
                        display: block;
                        margin-top: 4px;
                        font: 500 12px/1 var(--cw-mono);
                        color: var(--cw-faint);
                    "
                    >{{ entry.hint }}</span
                >
            </button>
        </div>

        <!-- EVM -->
        <div v-if="kind === 'evm'" class="cw-stack" style="gap: 14px">
            <div v-if="evmPresets(takenChainIds).length > 0">
                <div class="cw-label" style="margin-bottom: 8px">
                    {{ t('quickFill') }}
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 8px">
                    <button
                        v-for="entry in evmPresets(takenChainIds)"
                        :key="entry.values.chainId"
                        type="button"
                        class="cw-ghost"
                        :style="
                            preset === entry.label
                                ? {
                                      borderColor: 'var(--cw-accent)',
                                      color: 'var(--cw-accent)',
                                  }
                                : {}
                        "
                        @click="fillEvm(entry)"
                    >
                        {{ entry.label }}
                    </button>
                </div>
            </div>

            <label class="cw-stack">
                <span class="cw-label" style="margin-bottom: 8px">{{
                    t('networkNameLabel')
                }}</span>
                <input
                    v-model="name"
                    type="text"
                    class="cw-input"
                    autocomplete="off"
                    placeholder="Polygon"
                />
            </label>

            <div style="display: flex; gap: 10px">
                <label class="cw-stack" style="flex: 1">
                    <span class="cw-label" style="margin-bottom: 8px">{{
                        t('chainIdLabel')
                    }}</span>
                    <input
                        :value="chainId"
                        type="text"
                        inputmode="numeric"
                        class="cw-input"
                        placeholder="137"
                        @input="
                            chainId = digits(
                                ($event.target as HTMLInputElement).value,
                            )
                        "
                    />
                </label>
                <label class="cw-stack" style="flex: 1">
                    <span class="cw-label" style="margin-bottom: 8px">{{
                        t('symbolLabel')
                    }}</span>
                    <input
                        :value="symbol"
                        type="text"
                        class="cw-input"
                        autocomplete="off"
                        placeholder="POL"
                        @input="
                            symbol = (
                                $event.target as HTMLInputElement
                            ).value.toUpperCase()
                        "
                    />
                </label>
            </div>

            <label class="cw-stack">
                <span class="cw-label" style="margin-bottom: 8px">{{
                    t('rpcLabel')
                }}</span>
                <input
                    v-model="rpcUrl"
                    type="url"
                    class="cw-input"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="https://rpc.example.network"
                />
            </label>
        </div>

        <!-- Bitcoin fork -->
        <div v-else class="cw-stack" style="gap: 14px">
            <div>
                <div class="cw-label" style="margin-bottom: 8px">
                    {{ t('knownForks') }}
                </div>
                <div style="display: flex; flex-wrap: wrap; gap: 8px">
                    <button
                        v-for="entry in FORK_PRESETS"
                        :key="entry.label"
                        type="button"
                        class="cw-ghost"
                        :style="
                            preset === entry.label
                                ? {
                                      borderColor: 'var(--cw-accent)',
                                      color: 'var(--cw-accent)',
                                  }
                                : {}
                        "
                        @click="fillFork(entry)"
                    >
                        {{ entry.label }} · {{ entry.values.symbol }}
                    </button>
                </div>
            </div>

            <div style="display: flex; gap: 10px">
                <label class="cw-stack" style="flex: 2">
                    <span class="cw-label" style="margin-bottom: 8px">{{
                        t('coinNameLabel')
                    }}</span>
                    <input
                        v-model="name"
                        type="text"
                        class="cw-input"
                        autocomplete="off"
                        placeholder="Bitcoin Gold"
                    />
                </label>
                <label class="cw-stack" style="flex: 1">
                    <span class="cw-label" style="margin-bottom: 8px">{{
                        t('tickerLabel')
                    }}</span>
                    <input
                        :value="symbol"
                        type="text"
                        class="cw-input"
                        autocomplete="off"
                        placeholder="BTG"
                        @input="
                            symbol = (
                                $event.target as HTMLInputElement
                            ).value.toUpperCase()
                        "
                    />
                </label>
            </div>

            <label class="cw-stack">
                <span class="cw-label" style="margin-bottom: 8px">{{
                    t('slip44Label')
                }}</span>
                <input
                    :value="coinType"
                    type="text"
                    inputmode="numeric"
                    class="cw-input"
                    placeholder="156"
                    @input="
                        coinType = digits(
                            ($event.target as HTMLInputElement).value,
                        )
                    "
                />
            </label>

            <div>
                <div class="cw-label" style="margin-bottom: 8px">
                    {{ t('addressTypeLabel') }}
                </div>
                <div style="display: flex; gap: 8px">
                    <button
                        v-for="entry in ADDRESS_TYPES"
                        :key="entry.key"
                        type="button"
                        class="cw-card"
                        style="
                            flex: 1;
                            min-height: 62px;
                            padding: 10px;
                            text-align: left;
                            cursor: pointer;
                        "
                        :style="
                            addressType === entry.key
                                ? {
                                      borderColor: 'var(--cw-accent)',
                                      background: 'rgba(47, 233, 224, 0.06)',
                                  }
                                : {}
                        "
                        :aria-pressed="addressType === entry.key"
                        @click="addressType = entry.key"
                    >
                        <span
                            style="
                                display: block;
                                font: 500 12px/1.2 var(--cw-mono);
                                letter-spacing: 0.06em;
                                text-transform: uppercase;
                            "
                            :style="{
                                color:
                                    addressType === entry.key
                                        ? 'var(--cw-accent)'
                                        : 'var(--cw-muted)',
                            }"
                            >{{ entry.label() }}</span
                        >
                        <span
                            style="
                                display: block;
                                margin-top: 5px;
                                font: 500 12px/1.3 var(--cw-mono);
                                color: var(--cw-faint);
                            "
                            >{{ entry.note() }}</span
                        >
                    </button>
                </div>
            </div>

            <!--
              The mock left this field out and faked the address instead. There
              is no address without it: the prefix is what decides whether a
              derived key becomes a bc1…, an ltc1… or a 1…, and getting it wrong
              produces a plausible address on a chain that never sees the coins.
            -->
            <label class="cw-stack">
                <span class="cw-label" style="margin-bottom: 8px">{{
                    addressType === 'bech32'
                        ? t('prefixHrpLabel')
                        : t('prefixVersionLabel')
                }}</span>
                <input
                    v-if="addressType === 'bech32'"
                    :value="hrp"
                    type="text"
                    class="cw-input"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="btg"
                    @input="
                        hrp = (
                            $event.target as HTMLInputElement
                        ).value.toLowerCase()
                    "
                />
                <input
                    v-else
                    :value="versionModel"
                    type="text"
                    inputmode="numeric"
                    class="cw-input"
                    placeholder="30"
                    @input="
                        versionModel = digits(
                            ($event.target as HTMLInputElement).value,
                        )
                    "
                />
                <span
                    class="cw-prose"
                    style="margin-top: 8px; font-size: 13px"
                    >{{ t('prefixHint') }}</span
                >
            </label>

            <label class="cw-stack">
                <span class="cw-label" style="margin-bottom: 8px">{{
                    t('apiLabel')
                }}</span>
                <input
                    v-model="api"
                    type="url"
                    class="cw-input"
                    autocomplete="off"
                    spellcheck="false"
                    placeholder="https://explorer.example/api"
                />
                <span
                    class="cw-prose"
                    style="margin-top: 8px; font-size: 13px"
                    >{{ t('apiHint') }}</span
                >
            </label>
        </div>

        <label class="cw-stack" style="margin-top: 14px">
            <span class="cw-label" style="margin-bottom: 8px">{{
                t('explorerLabel')
            }}</span>
            <input
                v-model="explorer"
                type="url"
                class="cw-input"
                autocomplete="off"
                spellcheck="false"
                placeholder="https://explorer.example"
            />
        </label>

        <div class="cw-card" style="margin-top: 20px; padding: 14px 16px">
            <div
                class="cw-label"
                style="margin-bottom: 9px; color: var(--cw-meta)"
            >
                {{ t('derivationPath') }}
            </div>
            <div style="display: flex; align-items: center; gap: 12px">
                <NetworkMark
                    chain=""
                    :mark="previewMark"
                    :size="32"
                    style="flex: none"
                />
                <span
                    style="
                        font: 400 14px/1.6 var(--cw-mono);
                        color: var(--cw-body);
                        word-break: break-all;
                    "
                    >{{ path }}</span
                >
            </div>
            <p class="cw-prose" style="margin-top: 8px; font-size: 13px">
                {{ t('derivationPathBody') }}
            </p>
        </div>

        <p class="cw-note cw-note-warn" style="margin-top: 14px">
            <span>{{ t('addNetworkWarn') }}</span>
        </p>

        <p v-if="problem" class="cw-note cw-note-bad" style="margin-top: 12px">
            <span>{{ t(ERRORS[problem]) }}</span>
        </p>

        <div class="cw-fill" style="min-height: 18px"></div>

        <button
            type="button"
            class="cw-btn cw-btn-primary"
            style="margin-top: 18px"
            @click="submit"
        >
            {{ kind === 'evm' ? t('addEvmAction') : t('addForkAction') }}
        </button>
    </div>
</template>
