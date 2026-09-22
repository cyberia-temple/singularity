<script setup lang="ts">
import { computed, ref } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { accountDisplayName, deriveAccounts, walletChain } from '@/lib/wallet';
import type { WalletAccountRecord } from '@/lib/wallet';
import { shortAddress } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Every account this vault holds, and where each one came from.
 *
 * The distinction the screen exists to make is not cosmetic: the backup the
 * user wrote down covers the seed accounts and nothing else. An imported key
 * lives only on this device, a second phrase has its own backup, and a watched
 * address has no key at all. Each of those says so on its own row, because the
 * moment to learn it is not the moment the device is lost.
 *
 * Only the active account's addresses are derived — the others are named by
 * what would derive them, which keeps switching cheap and keeps this list from
 * becoming a second authority on where the money is.
 */

const props = defineProps<{
    wallet: MultiWallet;
}>();

const emit = defineEmits<{
    back: [];
    import: [];
}>();

const { t } = useLocale(walletMessages);

const busy = ref(false);
const renaming = ref<string | null>(null);
const draftName = ref('');
const confirmingRemoval = ref<string | null>(null);

/**
 * Addresses of accounts that are not the active one, derived at most once each.
 *
 * Walking a BIP-39 seed is not free, and this list re-renders on every balance
 * that lands. The cache is keyed by record id, which for an imported phrase is
 * itself derived from the address — so an entry can never outlive its meaning.
 */
const cached = new Map<string, { address: string; chain: string } | null>();

/**
 * The one address that identifies an account in a list.
 *
 * For anything spanning every network that is the EVM address, because it is
 * the string this ecosystem quotes at each other. An imported key or watched
 * address has exactly one, and it is that one.
 */
const identity = (
    record: WalletAccountRecord,
): { address: string; chain: string } | null => {
    if (record.kind === 'key' || record.kind === 'watch') {
        return { address: record.address, chain: record.chain };
    }

    // A seed account that is not active would need the vault phrase, which
    // this component deliberately cannot reach. It shows its path instead.
    if (record.kind !== 'phrase') {
        return null;
    }

    if (!cached.has(record.id)) {
        try {
            const derived = deriveAccounts('', record).find(
                (account) => account.family === 'evm',
            );

            cached.set(
                record.id,
                derived
                    ? { address: derived.address, chain: derived.chain }
                    : null,
            );
        } catch {
            cached.set(record.id, null);
        }
    }

    return cached.get(record.id) ?? null;
};

const rows = computed(() =>
    props.wallet.accountRecords.value.map((record) => {
        const active = record.id === props.wallet.activeAccountId.value;
        // The active account is already derived by the composable; deriving
        // the others here would walk the seed once per row on every render.
        const primary = active
            ? (props.wallet.accounts.value.find(
                  (account) => account.family === 'evm',
              ) ?? props.wallet.accounts.value[0])
            : null;
        const own = identity(record);

        return {
            record,
            active,
            name: accountDisplayName(record, t),
            address: primary?.address ?? own?.address ?? null,
            chain: primary?.chain ?? own?.chain ?? null,
            path:
                record.kind === 'seed' || record.kind === 'phrase'
                    ? walletChain('cyberia').path(record.index)
                    : record.kind === 'key'
                      ? t('accountPathKey')
                      : t('accountPathWatch'),
            /** Everywhere the wallet has to keep saying what a backup covers. */
            warning:
                record.kind === 'key'
                    ? t('accountNotInBackup')
                    : record.kind === 'phrase'
                      ? t('accountOwnPhrase')
                      : record.kind === 'watch'
                        ? t('accountWatchOnly')
                        : null,
            removable: record.kind !== 'seed' || record.index !== 0,
        };
    }),
);

const run = async (action: () => Promise<unknown>): Promise<void> => {
    busy.value = true;

    try {
        await action();
    } finally {
        busy.value = false;
    }
};

const startRename = (record: WalletAccountRecord, name: string): void => {
    renaming.value = record.id;
    draftName.value = record.label ?? name;
};

const commitRename = async (id: string): Promise<void> => {
    const label = draftName.value;
    renaming.value = null;
    await run(() => props.wallet.renameAccount(id, label));
};
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <h2 class="cw-title" style="margin: 22px 0 8px">{{ t('accounts') }}</h2>
        <p class="cw-prose">{{ t('accountsBody') }}</p>

        <div class="cw-stack" style="gap: 8px; margin-top: 20px">
            <div
                v-for="row in rows"
                :key="row.record.id"
                class="cw-card"
                :class="{ 'cw-card-custom': !row.active && row.warning }"
                :style="
                    row.active ? { borderColor: 'var(--cw-accent)' } : undefined
                "
                style="padding: 14px 16px"
            >
                <div style="display: flex; align-items: center; gap: 12px">
                    <NetworkMark
                        v-if="row.chain"
                        :chain="row.chain"
                        dot
                        :size="8"
                    />
                    <div style="flex: 1; min-width: 0">
                        <input
                            v-if="renaming === row.record.id"
                            v-model="draftName"
                            class="cw-input"
                            style="height: 34px; font-size: 15px"
                            :aria-label="t('accountRename')"
                            :placeholder="row.name"
                            @keydown.enter="commitRename(row.record.id)"
                            @blur="commitRename(row.record.id)"
                        />
                        <div
                            v-else
                            style="
                                font: 500 16px/1.2 var(--cw-sans);
                                color: var(--cw-text);
                            "
                        >
                            {{ row.name }}
                        </div>
                        <div
                            class="cw-data"
                            style="
                                margin-top: 4px;
                                color: var(--cw-muted);
                                font-size: 12px;
                            "
                        >
                            {{ row.address ? shortAddress(row.address) : '—' }}
                            · {{ row.path }}
                        </div>
                    </div>
                    <button
                        v-if="!row.active"
                        type="button"
                        class="cw-ghost"
                        :disabled="busy"
                        @click="run(() => wallet.switchAccount(row.record.id))"
                    >
                        {{ t('accountUse') }}
                    </button>
                    <span
                        v-else
                        class="cw-label"
                        style="color: var(--cw-accent)"
                        >{{ t('accountActive') }}</span
                    >
                </div>

                <p
                    v-if="row.warning"
                    style="
                        margin: 11px 0 0;
                        padding-top: 10px;
                        border-top: 1px solid var(--cw-line);
                        font: 500 12px/1.5 var(--cw-mono);
                        letter-spacing: 0.07em;
                        color: var(--cw-pending);
                    "
                >
                    {{ row.warning }}
                </p>

                <div
                    style="
                        display: flex;
                        gap: 8px;
                        margin-top: 12px;
                        padding-top: 10px;
                        border-top: 1px solid var(--cw-line);
                    "
                >
                    <button
                        type="button"
                        class="cw-back"
                        @click="startRename(row.record, row.name)"
                    >
                        {{ t('accountRename') }}
                    </button>
                    <span class="cw-fill"></span>
                    <button
                        v-if="
                            row.removable && confirmingRemoval !== row.record.id
                        "
                        type="button"
                        class="cw-back"
                        style="color: var(--cw-bad-soft)"
                        @click="confirmingRemoval = row.record.id"
                    >
                        {{ t('accountForget') }}
                    </button>
                    <template v-else-if="row.removable">
                        <span
                            class="cw-label"
                            style="color: var(--cw-bad-soft)"
                            >{{
                                row.record.kind === 'key' ||
                                row.record.kind === 'phrase'
                                    ? t('accountForgetSecret')
                                    : t('accountForgetSure')
                            }}</span
                        >
                        <button
                            type="button"
                            class="cw-back"
                            @click="confirmingRemoval = null"
                        >
                            {{ t('cancel') }}
                        </button>
                        <button
                            type="button"
                            class="cw-back"
                            style="color: var(--cw-bad-soft)"
                            :disabled="busy"
                            @click="
                                confirmingRemoval = null;
                                run(() => wallet.removeAccount(row.record.id));
                            "
                        >
                            {{ t('accountForgetConfirm') }}
                        </button>
                    </template>
                </div>
            </div>
        </div>

        <div style="display: flex; gap: 8px; margin-top: 16px">
            <button
                type="button"
                class="cw-dashed"
                style="flex: 1"
                :disabled="busy"
                @click="run(() => wallet.deriveAccount())"
            >
                <span>
                    <span style="display: block; color: var(--cw-text)">{{
                        t('accountDeriveNext')
                    }}</span>
                    <span class="cw-label">{{ t('accountSameSeed') }}</span>
                </span>
            </button>
            <button
                type="button"
                class="cw-dashed"
                style="flex: 1"
                @click="emit('import')"
            >
                <span>
                    <span style="display: block; color: var(--cw-text)">{{
                        t('accountImport')
                    }}</span>
                    <span class="cw-label">{{ t('accountImportHint') }}</span>
                </span>
            </button>
        </div>

        <p class="cw-note" style="margin-top: 22px">
            <span>{{ t('accountsFootnote') }}</span>
        </p>
    </div>
</template>
