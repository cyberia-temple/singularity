<script setup lang="ts">
import { formatEther } from 'ethers';
import { computed, onMounted, ref, watch } from 'vue';
import HoldButton from '@/components/wallet/HoldButton.vue';
import QrCode from '@/components/wallet/QrCode.vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import { useSecureClipboard } from '@/composables/useSecureClipboard';
import {
    VPN_GAS_CAP,
    VPN_NODES,
    VPN_PASS_ADDRESS,
    VPN_PLANS,
    VpnLinkRefused,
    daysLeft,
    extendedUntil,
    readVpnPass,
    requestVpnLink,
} from '@/lib/wallet/vpn';
import type { VpnLink, VpnLinkError, VpnPass } from '@/lib/wallet/vpn';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Cyberia VPN as something this wallet sells: days of access for CYBER, and
 * the link a node gives the address that paid.
 *
 * It sits on the proxy screen because it is the answer that screen used to
 * lack: a browser tab cannot choose a transport, but a VPN client can, and
 * this is where the key to one comes from. The link is a credential — whoever
 * holds it rides on this pass — so it is fetched on a press, never on sight,
 * and lives only in this component.
 */

const props = defineProps<{ wallet: MultiWallet }>();

const { locale, t } = useLocale(walletMessages);

const clipboard = useSecureClipboard();

const CHAIN = 'cyberia';

const account = computed(
    () =>
        props.wallet.accounts.value.find((entry) => entry.chain === CHAIN) ??
        null,
);

const canSign = computed(() => account.value?.capabilities.send ?? false);

const balance = computed(
    () => props.wallet.balances.value[CHAIN]?.value ?? null,
);

const pass = ref<VpnPass | null>(null);
const unreadable = ref(false);
const days = ref<number>(VPN_PLANS[1]);
const node = ref(VPN_NODES[0] ?? null);
const phase = ref<'idle' | 'paying' | 'paid' | 'linking'>('idle');
const failure = ref<VpnLinkError | 'failed' | null>(null);
const link = ref<VpnLink | null>(null);

const now = (): number => Math.floor(Date.now() / 1000);

const read = async (): Promise<void> => {
    unreadable.value = false;

    if (!VPN_PASS_ADDRESS || !account.value) {
        pass.value = null;

        return;
    }

    try {
        pass.value = await readVpnPass(account.value.address);
    } catch {
        unreadable.value = true;
    }
};

onMounted(() => void read());

/** A different account is a different pass, and its link is somebody else's. */
watch(
    () => account.value?.address,
    () => {
        link.value = null;
        failure.value = null;
        phase.value = 'idle';
        void read();
    },
);

const active = computed(
    () => pass.value !== null && pass.value.expiresAt > now(),
);

const formatDate = (seconds: number): string =>
    new Date(seconds * 1000).toLocaleDateString(locale.value, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
    });

const cyber = (wei: bigint): string => {
    const [whole, fraction = ''] = formatEther(wei).split('.');
    const kept = fraction.slice(0, 4).replace(/0+$/, '');

    return kept ? `${whole}.${kept}` : whole;
};

const total = computed(() =>
    pass.value ? pass.value.pricePerDay * BigInt(days.value) : null,
);

/**
 * Enough for the plan and for gas at the cap — the cap rather than an
 * estimate, because the cap is what the wallet will let this cost.
 */
const affordable = computed(() => {
    if (total.value === null || balance.value === null) {
        return false;
    }

    return balance.value >= total.value + VPN_GAS_CAP * 2_000_000_000n;
});

const ready = computed(
    () =>
        canSign.value &&
        pass.value !== null &&
        !pass.value.paused &&
        node.value !== null &&
        affordable.value &&
        phase.value === 'idle',
);

const buy = async (): Promise<void> => {
    if (!pass.value || !ready.value) {
        return;
    }

    phase.value = 'paying';
    failure.value = null;

    try {
        await props.wallet.vpnBuy(days.value, pass.value.pricePerDay);
        phase.value = 'paid';
        await read();
        void props.wallet.refreshBalances();
    } catch {
        failure.value = 'failed';
        phase.value = 'idle';
    }
};

const fetchLink = async (): Promise<void> => {
    if (!node.value || !account.value || !canSign.value) {
        return;
    }

    phase.value = 'linking';
    failure.value = null;

    try {
        link.value = await requestVpnLink(
            node.value,
            account.value.address,
            (message) => props.wallet.signMessage(CHAIN, message),
        );
    } catch (error) {
        failure.value =
            error instanceof VpnLinkRefused ? error.reason : 'failed';
    } finally {
        phase.value = 'idle';
    }
};
</script>

<template>
    <div class="cw-label" style="margin-top: 26px">{{ t('vpnTitle') }}</div>

    <div class="cw-card" style="margin-top: 10px">
        <p class="cw-prose">{{ t('vpnBody') }}</p>

        <p v-if="!VPN_PASS_ADDRESS" class="cw-note" style="margin-top: 14px">
            <span>{{ t('vpnNotDeployed') }}</span>
        </p>

        <p v-else-if="unreadable" class="cw-note" style="margin-top: 14px">
            <span>{{ t('vpnUnreadable') }}</span>
        </p>

        <template v-else-if="pass">
            <!-- Where this address stands, before anything is offered. -->
            <div
                class="cw-data"
                style="margin-top: 14px"
                :style="{
                    color: active ? 'var(--cw-accent)' : 'var(--cw-muted)',
                }"
            >
                {{
                    active
                        ? t('vpnActiveUntil', {
                              date: formatDate(pass.expiresAt),
                              days: daysLeft(pass.expiresAt, now()),
                          })
                        : t('vpnInactive')
                }}
            </div>

            <p
                v-if="VPN_NODES.length === 0"
                class="cw-note"
                style="margin-top: 14px"
            >
                <span>{{ t('vpnNoNodes') }}</span>
            </p>

            <template v-else>
                <div
                    v-if="VPN_NODES.length > 1"
                    class="cw-seg"
                    style="margin-top: 14px"
                >
                    <button
                        v-for="entry in VPN_NODES"
                        :key="entry.id"
                        type="button"
                        class="cw-seg-item"
                        :class="{ 'cw-seg-bar': entry.id === node?.id }"
                        :aria-pressed="entry.id === node?.id"
                        @click="
                            node = entry;
                            link = null;
                        "
                    >
                        {{ entry.label }}
                    </button>
                </div>

                <!-- The link: only for a running pass, only on a press. -->
                <template v-if="active">
                    <div v-if="link" style="margin-top: 16px">
                        <QrCode :value="link.link" :label="t('vpnTitle')" />
                        <p class="cw-prose" style="margin-top: 12px">
                            {{ t('vpnLinkReady') }}
                        </p>
                        <button
                            type="button"
                            class="cw-btn cw-btn-secondary"
                            style="margin-top: 12px"
                            @click="clipboard.copy(link.link)"
                        >
                            {{
                                clipboard.copied.value === link.link
                                    ? t('copiedLabel')
                                    : t('vpnCopy')
                            }}
                        </button>
                    </div>
                    <template v-else>
                        <p class="cw-prose" style="margin-top: 14px">
                            {{ t('vpnSignNote') }}
                        </p>
                        <button
                            type="button"
                            class="cw-btn cw-btn-primary"
                            style="margin-top: 12px"
                            :disabled="!canSign || phase !== 'idle'"
                            @click="fetchLink()"
                        >
                            {{ t('vpnGetLink') }}
                        </button>
                    </template>
                </template>

                <!-- Buying: days are added to what is left, never reset. -->
                <div class="cw-seg" style="margin-top: 18px">
                    <button
                        v-for="plan in VPN_PLANS"
                        :key="plan"
                        type="button"
                        class="cw-seg-item"
                        :class="{ 'cw-seg-bar': plan === days }"
                        :aria-pressed="plan === days"
                        @click="days = plan"
                    >
                        {{ t('vpnPlanDays', { days: plan }) }}
                    </button>
                </div>

                <div class="cw-data" style="margin-top: 12px">
                    {{
                        t('vpnTotal', {
                            amount: cyber(total ?? 0n),
                            date: formatDate(
                                extendedUntil(pass.expiresAt, days, now()),
                            ),
                        })
                    }}
                </div>
                <p class="cw-prose" style="margin-top: 8px">
                    {{
                        t('vpnPriceNote', {
                            price: cyber(pass.pricePerDay),
                            fee: pass.feeBps / 100,
                        })
                    }}
                </p>

                <p v-if="pass.paused" class="cw-note" style="margin-top: 12px">
                    <span>{{ t('vpnPaused') }}</span>
                </p>
                <p
                    v-else-if="!canSign"
                    class="cw-note"
                    style="margin-top: 12px"
                >
                    <span>{{ t('vpnWatchOnly') }}</span>
                </p>
                <p
                    v-else-if="!affordable && balance !== null"
                    class="cw-note"
                    style="margin-top: 12px"
                >
                    <span>{{ t('vpnNotEnough') }}</span>
                </p>

                <div style="margin-top: 14px">
                    <HoldButton
                        :label="t('holdToSign')"
                        :disabled="!ready"
                        @complete="buy()"
                    />
                </div>

                <p
                    v-if="phase === 'paid'"
                    class="cw-prose"
                    style="margin-top: 10px; color: var(--cw-accent)"
                >
                    {{ t('vpnBought') }}
                </p>
            </template>
        </template>

        <p v-if="failure" class="cw-note cw-note-warn" style="margin-top: 12px">
            <span>{{ t(`vpnError_${failure}`) }}</span>
        </p>
    </div>
</template>
