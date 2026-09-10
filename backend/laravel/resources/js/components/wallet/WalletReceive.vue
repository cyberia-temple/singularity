<script setup lang="ts">
import { computed } from 'vue';
import NetworkMark from '@/components/wallet/NetworkMark.vue';
import QrCode from '@/components/wallet/QrCode.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useSecureClipboard } from '@/composables/useSecureClipboard';
import { walletChain } from '@/lib/wallet';
import type { WalletChainId } from '@/lib/wallet';
import { addressGroups } from '@/lib/wallet/format';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Receive: pick a network, get its address as a QR and as text, and read the
 * warning that belongs to that network. The warning is per-chain and never
 * generic, because "wrong network" is the one mistake this screen exists to
 * prevent and it has a different shape on each of the three.
 */

const props = defineProps<{
    wallet: MultiWallet;
    chain: WalletChainId;
    moneroPayoutAddress: string | null;
    payoutSaved: boolean;
    /** Whether a Cyberia account is signed in — the payout binding needs one. */
    authenticated: boolean;
}>();

const emit = defineEmits<{
    back: [];
    pick: [chain: WalletChainId];
    usePayout: [address: string];
    addNetwork: [];
}>();

const { t } = useLocale(walletMessages);
const clipboard = useSecureClipboard();

/**
 * The wrong-network warning, per key family rather than per chain.
 *
 * For EVM the honest statement is not "assets from another chain are lost" —
 * this wallet holds the same key on all of them, so those assets are simply on
 * a different network and still spendable there. Saying otherwise would teach
 * a panic the wallet's own design makes unnecessary. For the Bitcoin family the
 * risk is the opposite shape: the address formats really are interchangeable
 * between forks, and the coins really do not come back.
 */
const warning = computed(() => {
    const chain = walletChain(props.chain);

    if (chain.family === 'evm') {
        return t('warnEvm', {
            chain: chain.label,
            chainId: chain.chainId ?? '',
        });
    }

    if (chain.family === 'utxo') {
        return t('warnUtxo', { chain: chain.label });
    }

    return chain.family === 'solana' ? t('warnSolana') : t('warnMonero');
});

/** A user-added network carries a second warning: nobody vetted its endpoint. */
const unverified = computed(() => walletChain(props.chain).custom === true);

const account = computed(() =>
    props.wallet.accounts.value.find(
        (candidate) => candidate.chain === props.chain,
    ),
);

const payoutOffered = computed(
    () =>
        props.authenticated &&
        !props.payoutSaved &&
        props.moneroPayoutAddress !== account.value?.address,
);
</script>

<template>
    <div v-if="account" class="cw-stack">
        <div class="cw-row" style="margin-bottom: 20px">
            <button type="button" class="cw-back" @click="emit('back')">
                ← {{ t('back') }}
            </button>
            <span style="font: 500 12px/1 var(--cw-sans)">{{
                t('receive')
            }}</span>
            <span style="width: 44px"></span>
        </div>

        <div class="cw-seg" style="margin-bottom: 20px">
            <button
                v-for="candidate in wallet.accounts.value"
                :key="candidate.chain"
                type="button"
                class="cw-seg-item"
                :aria-pressed="candidate.chain === chain"
                @click="emit('pick', candidate.chain)"
            >
                {{ candidate.label }}
                <span
                    class="cw-seg-bar"
                    :style="{
                        background:
                            candidate.chain === chain
                                ? candidate.mark.hue
                                : 'transparent',
                    }"
                />
            </button>
            <button
                type="button"
                class="cw-seg-item"
                style="flex: 0 0 56px; color: var(--cw-muted)"
                :aria-label="t('addNetwork')"
                @click="emit('addNetwork')"
            >
                +
                <span class="cw-seg-bar" />
            </button>
        </div>

        <div style="align-self: center">
            <QrCode
                :value="account.address"
                :label="t('qrLabel', { chain: account.label })"
            />
        </div>
        <div
            class="cw-label"
            style="margin-top: 12px; text-align: center; color: var(--cw-faint)"
        >
            {{ t('qrCaption', { chain: account.label }) }}
        </div>

        <div class="cw-card" style="margin-top: 20px">
            <div class="cw-label" style="margin-bottom: 8px">
                {{ t('addressLabel') }}
            </div>
            <!--
              In fours, like a card number. This is the screen where somebody
              reads an address back to a person on a phone or checks it against
              what they have already pasted somewhere else, and one unbroken
              42-character run wrapping mid-string is the shape that loses
              them. `title` keeps the whole thing available to a mouse, and the
              copy button below is what actually moves it.
            -->
            <p class="cw-addr" style="margin: 0" :title="account.address">
                <span
                    v-for="(group, at) in addressGroups(account.address)"
                    :key="at"
                    >{{ group }}</span
                >
            </p>
            <div style="display: flex; gap: 8px; margin-top: 14px">
                <button
                    type="button"
                    class="cw-ghost"
                    style="flex: 1"
                    :style="
                        clipboard.copied.value === account.address
                            ? {
                                  borderColor: 'var(--cw-accent)',
                                  color: 'var(--cw-accent)',
                              }
                            : {}
                    "
                    @click="clipboard.copy(account.address)"
                >
                    {{
                        clipboard.copied.value === account.address
                            ? t('copiedClears')
                            : t('copyAddress')
                    }}
                </button>
                <NetworkMark
                    :chain="chain"
                    :size="44"
                    style="border-radius: 3px"
                />
            </div>
        </div>

        <p class="cw-note cw-note-warn" style="margin-top: 16px">
            <span>{{ warning }}</span>
        </p>

        <p v-if="unverified" class="cw-note" style="margin-top: 10px">
            <span>{{ t('warnCustom') }}</span>
        </p>

        <!-- Monero doubles as the bridge's payout address, so offer it here. -->
        <div v-if="chain === 'monero'" class="cw-card" style="margin-top: 16px">
            <div
                style="font: 400 14px/1.3 var(--cw-sans); color: var(--cw-text)"
            >
                {{ t('useForPayouts') }}
            </div>
            <p class="cw-prose" style="margin: 6px 0 0; font-size: 12px">
                {{ t('useForPayoutsHint') }}
            </p>
            <!--
              Binding a payout address is the one thing here that belongs to a
              Cyberia account. Without one the wallet still works completely —
              only this row asks for a sign-in, and says so.
            -->
            <a
                v-if="!authenticated"
                href="/login"
                class="cw-ghost"
                style="margin-top: 12px; text-decoration: none"
            >
                {{ t('signInForPayouts') }}
            </a>
            <button
                v-else-if="payoutOffered"
                type="button"
                class="cw-ghost"
                style="margin-top: 12px"
                @click="emit('usePayout', account.address)"
            >
                {{ t('useForPayouts') }}
            </button>
            <p
                v-else
                style="
                    margin: 12px 0 0;
                    font: 400 11px/1 var(--cw-mono);
                    color: var(--cw-accent);
                "
            >
                {{ t('useForPayoutsDone') }}
            </p>
        </div>
    </div>
</template>
