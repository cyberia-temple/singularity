<script setup lang="ts">
import { ArrowDownLeft, ArrowUpRight } from 'lucide-vue-next';
import StatusPill from '@/components/wallet/StatusPill.vue';
import { walletChain } from '@/lib/wallet';
import type { WalletChainId, WalletTx, WalletTxStatus } from '@/lib/wallet';
import { relativeTime, shortAddress, signedAmount } from '@/lib/wallet/format';

/**
 * Transfers, one row each. Every row states direction, counterparty, amount
 * and how the transaction ended — a failed transfer is a row here, not an
 * omission, because a payment that silently vanished from the list is the one
 * people go looking for.
 *
 * Each entry carries its own chain so a mixed feed and a single-network
 * history are the same component: decimals and explorer come from the entry,
 * never from the surrounding screen.
 */

defineProps<{
    entries: { chain: WalletChainId; tx: WalletTx }[];
    locale: string;
    /** Localised status captions, keyed by transaction status. */
    statusLabels: Record<WalletTxStatus, string>;
    sentTo: string;
    receivedFrom: string;
}>();
</script>

<template>
    <ul style="margin: 0; padding: 0; list-style: none">
        <li
            v-for="{ chain, tx } in entries"
            :key="tx.hash"
            style="
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 13px 0;
                border-bottom: 1px solid #101418;
            "
        >
            <span
                style="
                    display: flex;
                    width: 26px;
                    height: 26px;
                    flex: none;
                    align-items: center;
                    justify-content: center;
                    border: 1px solid var(--cw-border-soft);
                    color: var(--cw-muted);
                "
            >
                <component
                    :is="tx.direction === 'out' ? ArrowUpRight : ArrowDownLeft"
                    :size="13"
                    aria-hidden="true"
                />
            </span>

            <span style="flex: 1; min-width: 0">
                <component
                    :is="
                        walletChain(chain).explorerTxUrl(tx.hash) ? 'a' : 'span'
                    "
                    :href="
                        walletChain(chain).explorerTxUrl(tx.hash) ?? undefined
                    "
                    target="_blank"
                    rel="noopener noreferrer"
                    style="
                        display: block;
                        font: 400 15px/1.3 var(--cw-sans);
                        color: var(--cw-body);
                        text-decoration: none;
                    "
                >
                    {{ tx.direction === 'out' ? sentTo : receivedFrom }}
                    {{ tx.counterparty ? shortAddress(tx.counterparty) : '' }}
                </component>
                <span
                    style="
                        display: block;
                        margin-top: 2px;
                        font: 500 12px/1.4 var(--cw-mono);
                        color: var(--cw-dim);
                    "
                >
                    {{
                        [
                            walletChain(chain).label,
                            relativeTime(tx.timestamp, locale),
                            tx.meta,
                        ]
                            .filter(Boolean)
                            .join(' · ')
                    }}
                </span>
            </span>

            <span style="text-align: right">
                <span
                    style="
                        display: block;
                        font: 500 14px/1.3 var(--cw-mono);
                        font-variant-numeric: tabular-nums;
                    "
                    :style="{
                        color:
                            tx.direction === 'in'
                                ? 'var(--cw-ok)'
                                : 'var(--cw-text)',
                    }"
                >
                    {{ signedAmount(tx.amount, walletChain(chain).decimals) }}
                    {{ walletChain(chain).symbol }}
                </span>
                <span
                    style="
                        display: flex;
                        justify-content: flex-end;
                        margin-top: 3px;
                    "
                >
                    <StatusPill
                        bare
                        :status="tx.status"
                        :label="statusLabels[tx.status]"
                    />
                </span>
            </span>
        </li>
    </ul>
</template>
