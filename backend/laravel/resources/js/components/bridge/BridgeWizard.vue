<script setup lang="ts">
import { usePage } from '@inertiajs/vue3';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useBridge } from '@/composables/useBridge';
import { useBridgeAnalytics } from '@/composables/useBridgeAnalytics';
import { useBridgeFlow } from '@/composables/useBridgeFlow';
import { useSolanaWallet } from '@/composables/useSolanaWallet';
import { useTonWallet } from '@/composables/useTonWallet';
import { useWallet } from '@/composables/useWallet';
import { bridgeRoute, isManualBridgeRoute } from '@/lib/addressValidation';
import type { BridgeDirection } from '@/lib/addressValidation';
import { LOADING_CAPACITY } from '@/lib/bridgeCapacity';
import {
    bridgeChainInfo,
    bridgeDepositAddress,
    tokenOnChain,
    tokensForRoute,
} from '@/lib/bridgeConfig';
import type { BridgeFeeConfig } from '@/lib/bridgeFee';
import { BRIDGE_TOKENS } from '@/lib/bridgeTokens';
import type { BridgeTokenSymbol } from '@/lib/bridgeTokens';
import { sendTonDeposit, TON_GAS_RESERVE } from '@/lib/tonBridge';
import { track } from '@/lib/track';
import StepConfigure from './StepConfigure.vue';
import StepDirection from './StepDirection.vue';
import StepReview from './StepReview.vue';
import StepSigning from './StepSigning.vue';
import StepTracking from './StepTracking.vue';

export type ActiveBridgeRequest = {
    id: number;
    direction: string;
    token?: string;
    source_chain: string;
    source_tx_hash: string | null;
    sender_address: string | null;
    recipient_address: string;
    deposit_address: string | null;
    amount: string;
    status: string;
    destination_tx_hash: string | null;
    created_at: string;
    completed_at: string | null;
    expires_at: string | null;
};

const props = withDefaults(
    defineProps<{
        relayerEvmAddress?: string | null;
        availableDirections?: string[];
        activeRequests?: ActiveBridgeRequest[];
        yentenDepositAddress?: string | null;
        cyberSolUsd?: number | null;
        feeConfig?: BridgeFeeConfig;
        gasDropConfig?: { enabled: boolean; amount: string };
        convertConfig?: { enabled: boolean; rate: number };
    }>(),
    {
        relayerEvmAddress: null,
        availableDirections: () => [],
        activeRequests: () => [],
        yentenDepositAddress: null,
        cyberSolUsd: null,
        feeConfig: () => ({ flatUsd: 0.1, rateBps: 0 }),
        gasDropConfig: () => ({ enabled: true, amount: '0.01' }),
        convertConfig: () => ({ enabled: true, rate: 1000 }),
    },
);

const gasDropPlanned = ref(false);

// The capacity claim this transfer signs against, handed to /bridge/submit so
// the hold becomes the obligation rather than a second claim on the same
// reserve. Null on manual-source routes, which have nothing to sign.
const reservationReference = ref<string | null>(null);

const checkEvmRecipientNeedsGas = async (
    recipient: string,
): Promise<boolean> => {
    if (!props.gasDropConfig.enabled) {
        return false;
    }

    try {
        const response = await fetch('/api/rpc/cyberia', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'eth_getBalance',
                params: [recipient, 'latest'],
            }),
        });
        const json = await response.json();
        const hex = json.result;

        if (typeof hex !== 'string' || !hex.startsWith('0x')) {
            return false;
        }

        return BigInt(hex) === 0n;
    } catch {
        return false;
    }
};

// Native SOL kept back from "Max" so the deposit transaction fee is payable.
const SOL_FEE_RESERVE = 0.001;

const flow = useBridgeFlow();
const bridge = useBridge();
const evmWallet = useWallet();
const solanaWallet = useSolanaWallet();
const tonWallet = useTonWallet();
const analytics = useBridgeAnalytics();

onMounted(() => {
    analytics.track('page_view');
    // Restore a previously approved TON Connect session (no modal).
    void tonWallet.restore();
});

const sourceWalletConnected = computed(() => {
    if (!flow.context.direction) {
        return false;
    }

    switch (bridgeRoute(flow.context.direction).sourceWallet) {
        case 'manual':
            return true;
        case 'solana':
            return solanaWallet.isConnected.value;
        case 'ton':
            return tonWallet.isConnected.value;
        default:
            return evmWallet.isConnected.value;
    }
});

const sourceWalletAddress = computed(() => {
    if (!flow.context.direction) {
        return null;
    }

    switch (bridgeRoute(flow.context.direction).sourceWallet) {
        case 'solana':
            return solanaWallet.address.value;
        case 'ton':
            return tonWallet.address.value;
        default:
            return evmWallet.address.value;
    }
});

const sourceWalletConnecting = computed(() => {
    if (!flow.context.direction) {
        return false;
    }

    switch (bridgeRoute(flow.context.direction).sourceWallet) {
        case 'solana':
            return solanaWallet.isConnecting.value;
        case 'ton':
            return tonWallet.isConnecting.value;
        default:
            return evmWallet.isConnecting.value;
    }
});

const sourceBalance = computed(() => {
    if (!flow.context.direction) {
        return null;
    }

    const source = bridgeRoute(flow.context.direction).source;
    const sourceToken = tokenOnChain(flow.context.token, source);

    if (bridgeChainInfo(source)?.type === 'evm' && sourceToken?.native) {
        return bridge.getEvmNativeBalance(source);
    }

    if (source === 'ton') {
        return bridge.getTokenBalance(flow.context.token, 'ton');
    }

    if (source === 'solana') {
        return flow.context.token === 'CYBER.sol'
            ? bridge.solanaCyberBalance.value
            : bridge.getTokenBalance(flow.context.token, 'solana');
    }

    // ERC20 on any EVM source — Cyberia or an external chain (SPY on
    // Robinhood, USDT on BSC, USDC on Base): fetched via that chain's RPC.
    if (bridgeChainInfo(source)?.type === 'evm') {
        return flow.context.token === 'CYBER.sol'
            ? bridge.cyberSolBalance.value
            : bridge.getTokenBalance(flow.context.token, 'evm');
    }

    // Manual-chain balances (Yenten/BTC/…) aren't available through the
    // connected wallets.
    return null;
});

const sourceMaxAmount = computed(() => {
    if (!flow.context.direction) {
        return null;
    }

    const source = bridgeRoute(flow.context.direction).source;
    const sourceToken = tokenOnChain(flow.context.token, source);

    if (bridgeChainInfo(source)?.type === 'evm' && sourceToken?.native) {
        return bridge.getEvmNativeMaxAmount(source);
    }

    // Native TON: keep back a small reserve for wallet message fees.
    if (source === 'ton' && sourceToken?.native) {
        const balance = parseFloat(sourceBalance.value ?? '');

        return Number.isFinite(balance)
            ? Math.max(0, balance - TON_GAS_RESERVE).toString()
            : null;
    }

    // Native SOL: keep back a small reserve for the transaction fee.
    if (source === 'solana' && sourceToken?.native) {
        const balance = parseFloat(sourceBalance.value ?? '');

        return Number.isFinite(balance)
            ? Math.max(0, balance - SOL_FEE_RESERVE).toString()
            : null;
    }

    return sourceBalance.value;
});

// What the relayer can deliver to the destination chain now, as a state
// rather than a number: `unavailable` (a read that failed) blocks exactly like
// `exceeded`, and is never mistaken for "no ceiling".
const destinationCapacity = computed(() =>
    flow.context.direction
        ? bridge.getDestinationCapacity(
              flow.context.direction,
              flow.context.token,
          )
        : LOADING_CAPACITY,
);

const destinationLabel = computed(() =>
    flow.context.direction
        ? (bridgeChainInfo(bridgeRoute(flow.context.direction).destination)
              ?.label ?? null)
        : null,
);

const refreshDestinationCapacity = () => {
    if (flow.context.direction && flow.context.token) {
        bridge.fetchDestinationCapacity(
            flow.context.direction,
            flow.context.token,
        );
    }
};

const refreshSourceBalance = () => {
    if (!flow.context.direction) {
        return;
    }

    const token = flow.context.token;

    const source = bridgeRoute(flow.context.direction).source;
    const sourceToken = tokenOnChain(token, source);

    if (
        bridgeChainInfo(source)?.type === 'evm' &&
        sourceToken?.native &&
        evmWallet.address.value
    ) {
        bridge.fetchEvmNativeBalance(source, evmWallet.address.value);
    } else if (source === 'ton' && tonWallet.rawAddress.value) {
        bridge.fetchTokenBalanceTon(token, tonWallet.rawAddress.value);
    } else if (source === 'solana' && solanaWallet.address.value) {
        if (token === 'CYBER.sol') {
            bridge.fetchSolanaCyberBalance(solanaWallet.address.value);
        } else {
            bridge.fetchTokenBalanceSolana(token, solanaWallet.address.value);
        }
    } else if (
        bridgeChainInfo(source)?.type === 'evm' &&
        evmWallet.address.value
    ) {
        // ERC20 on any EVM source chain (Cyberia, Robinhood, BSC, Base…) —
        // native coins were handled by the first branch.
        if (token === 'CYBER.sol' && source === 'cyberia') {
            bridge.fetchCyberSolBalance(evmWallet.address.value);
        } else {
            bridge.fetchTokenBalanceEvm(token, evmWallet.address.value, source);
        }
    }
};

watch(sourceWalletConnected, (connected) => {
    if (!connected || !flow.context.direction) {
        return;
    }

    const sourceWallet = bridgeRoute(flow.context.direction).sourceWallet;

    if (sourceWallet === 'solana' && solanaWallet.address.value) {
        flow.context.sourceAddress = solanaWallet.address.value;
    } else if (sourceWallet === 'ton' && tonWallet.address.value) {
        flow.context.sourceAddress = tonWallet.address.value;
    } else if (sourceWallet === 'evm' && evmWallet.address.value) {
        flow.context.sourceAddress = evmWallet.address.value;
    }

    if (flow.context.sourceAddress) {
        reportConnection(flow.context.sourceAddress);
    }

    refreshSourceBalance();
});

/**
 * The step that was invisible.
 *
 * Of 513 recorded bridge sessions, 123 chose a direction and 42 reached the
 * destination field: two thirds of everyone who engaged with this wizard at
 * all disappeared inside the configure step, and no event distinguished
 * "opened the form and never typed a number" from "typed one and thought
 * better of it". `amount_entered` has been declared in `BridgeEventType`ate
 * since this wizard was written and emitted by nobody.
 *
 * Fired once per direction, at the moment the amount first becomes a positive
 * number — not on every keystroke, which would say how fast somebody types
 * rather than whether they committed to a figure.
 */
const amountReported = ref<string | null>(null);

watch(
    () => flow.context.amount,
    (amount) => {
        const direction = flow.context.direction;

        if (!direction || !(parseFloat(amount) > 0)) {
            return;
        }

        if (amountReported.value === direction) {
            return;
        }

        amountReported.value = direction;
        analytics.track('amount_entered', { direction, amount });
    },
);

/**
 * A wallet that was already connected when the wizard opened.
 *
 * The connect events fired only from the button's own handler, so a visitor
 * arriving with Phantom or MetaMask already authorised — which is most repeat
 * visitors — recorded no connection at all: 39 sessions submitted a lock
 * transaction while 11 had recorded connecting a wallet. The funnel then
 * showed people signing transactions from wallets they had apparently never
 * connected.
 */
const connectionReported = ref(false);

const reportConnection = (address: string) => {
    if (connectionReported.value || !flow.context.direction) {
        return;
    }

    connectionReported.value = true;

    const sourceWallet = bridgeRoute(flow.context.direction).sourceWallet;

    analytics.track(
        sourceWallet === 'solana'
            ? 'solana_wallet_connected'
            : sourceWallet === 'ton'
              ? 'ton_wallet_connected'
              : 'evm_wallet_connected',
        { source_address: address },
    );
};

watch(
    () => flow.context.token,
    (token) => {
        // Conversion only exists for CYBER.sol — drop the flag on token switch.
        if (token !== 'CYBER.sol') {
            flow.context.convertToNative = false;
        }

        refreshSourceBalance();
        refreshDestinationCapacity();
    },
);

// The bridge is public, so there may be no user at all here.
const page = usePage<{
    auth?: { user?: { monero_wallet_address?: string | null } | null };
}>();

const savedMoneroAddress = computed(
    () => page.props.auth?.user?.monero_wallet_address ?? null,
);

const sourceDepositAddress = computed(() => {
    if (
        !flow.context.direction ||
        !isManualBridgeRoute(flow.context.direction)
    ) {
        return null;
    }

    const source = bridgeRoute(flow.context.direction).source;

    return (
        bridgeDepositAddress(source) ??
        (source === 'yenten' ? props.yentenDepositAddress : null)
    );
});

const handleDirection = (
    direction: BridgeDirection,
    token: BridgeTokenSymbol,
) => {
    flow.chooseDirection(direction);
    flow.context.token = token;
    analytics.track('direction_selected', { direction });

    const available = tokensForRoute(direction);

    if (available.length > 0 && !available.includes(flow.context.token)) {
        flow.context.token = available[0] as BridgeTokenSymbol;
    }

    const sourceWallet = bridgeRoute(direction).sourceWallet;

    if (sourceWallet === 'solana' && solanaWallet.address.value) {
        flow.context.sourceAddress = solanaWallet.address.value;
    } else if (sourceWallet === 'ton' && tonWallet.address.value) {
        flow.context.sourceAddress = tonWallet.address.value;
    } else if (sourceWallet === 'evm' && evmWallet.address.value) {
        flow.context.sourceAddress = evmWallet.address.value;
    }

    if (flow.context.sourceAddress) {
        reportConnection(flow.context.sourceAddress);
    }

    refreshSourceBalance();
    refreshDestinationCapacity();
};

const handleConnectSource = async () => {
    if (!flow.context.direction) {
        return;
    }

    const sourceWallet = bridgeRoute(flow.context.direction).sourceWallet;

    const addr =
        sourceWallet === 'solana'
            ? await solanaWallet.connect()
            : sourceWallet === 'ton'
              ? await tonWallet.connect()
              : await evmWallet.connect();

    if (addr) {
        reportConnection(addr);
    }
};

const handleConfigureNext = async () => {
    analytics.track('destination_entered', {
        direction: flow.context.direction!,
        destination_address: flow.context.destinationAddress,
        amount: flow.context.amount,
    });

    gasDropPlanned.value =
        bridgeRoute(flow.context.direction!).destination === 'cyberia'
            ? await checkEvmRecipientNeedsGas(flow.context.destinationAddress)
            : false;

    flow.proceedToReview();
};

const handleConfirm = async () => {
    if (!flow.context.direction) {
        return;
    }

    const selectedRoute = bridgeRoute(flow.context.direction);

    track('bridge_started', {
        metadata: {
            action_type: flow.context.direction,
            network: `${selectedRoute.sourceLabel} -> ${selectedRoute.destinationLabel}`,
            token: flow.context.token,
        },
    });

    const manualSource = isManualBridgeRoute(flow.context.direction);

    if (!manualSource) {
        // Hold the destination liquidity BEFORE the wallet opens.
        //
        // This is the step that makes the whole thing safe, and it has to be
        // here rather than at submit: by the time submit is reached the user's
        // transfer is already on chain and nothing can refuse it. Bridge
        // request #68 passed a capacity check, was reviewed, was signed — and
        // by the time the relayer looked again the reserve was gone.
        const reserved = await bridge.reserveDestinationCapacity({
            direction: flow.context.direction,
            token: flow.context.token,
            amount: flow.context.amount,
            senderAddress: flow.context.sourceAddress || null,
            recipientAddress: flow.context.destinationAddress,
        });

        if (!reserved.ok) {
            analytics.track('bridge_submit_failed', {
                direction: flow.context.direction,
                error_message: `reservation ${reserved.reason}: ${reserved.message}`,
            });
            flow.markFailed(reserved.message);
            refreshDestinationCapacity();

            return;
        }

        reservationReference.value = reserved.reference;

        flow.beginSigning();
        analytics.track('lock_tx_submitted', {
            direction: flow.context.direction,
            amount: flow.context.amount,
            metadata: { token: flow.context.token },
        });

        const tokenInfo = BRIDGE_TOKENS[flow.context.token];
        const sourceChainKey = bridgeRoute(flow.context.direction).source;
        const sourceChainType = bridgeChainInfo(sourceChainKey)?.type;

        try {
            let result: { txHash: string; nonce: number } | null;

            if (sourceChainType === 'ton') {
                // TON Connect (Tonkeeper): sign the deposit in the wallet,
                // then resolve the message hash to the indexed transaction.
                const depositAddress = bridgeDepositAddress('ton');
                const tonEntry = tokenOnChain(flow.context.token, 'ton');

                if (!depositAddress || !tonEntry) {
                    throw new Error(
                        'The TON bridge hot wallet is not configured on the server.',
                    );
                }

                if (!tonWallet.rawAddress.value) {
                    throw new Error('TON wallet not connected');
                }

                result = await sendTonDeposit({
                    tokenEntry: tonEntry,
                    amount: flow.context.amount,
                    depositAddress,
                    senderRawAddress: tonWallet.rawAddress.value,
                });
            } else if (tokenInfo?.model === 'native') {
                // CYBER — through CyberBridge contract
                result =
                    flow.context.direction === 'evm_to_sol'
                        ? await bridge.redeemCyberSolOnEvm(
                              flow.context.amount,
                              flow.context.destinationAddress,
                          )
                        : await bridge.lockNativeOnSolana(
                              flow.context.amount,
                              flow.context.destinationAddress,
                          );
            } else if (
                bridgeChainInfo(bridgeRoute(flow.context.direction).source)
                    ?.type === 'evm'
            ) {
                const sourceChain = bridgeRoute(flow.context.direction).source;
                const relayer =
                    bridgeDepositAddress(sourceChain) ??
                    props.relayerEvmAddress;

                if (!relayer) {
                    throw new Error(
                        'Bridge relayer address not configured on the server. Run `php artisan bridge:show-relayer` and add the printed BRIDGE_RELAYER_ADDRESS to .env.',
                    );
                }

                const sourceToken = tokenOnChain(
                    flow.context.token,
                    sourceChain,
                );

                result = sourceToken?.native
                    ? await bridge.nativeTransferToRelayer(
                          sourceChain,
                          flow.context.amount,
                          relayer,
                      )
                    : await bridge.erc20TransferToRelayer(
                          flow.context.token,
                          flow.context.amount,
                          relayer,
                          sourceChain,
                      );
            } else {
                const solanaEntry = tokenOnChain(flow.context.token, 'solana');

                result = solanaEntry?.native
                    ? await bridge.nativeSolTransferToHotWallet(
                          flow.context.amount,
                      )
                    : await bridge.splTransferToHotWallet(
                          flow.context.token,
                          flow.context.amount,
                      );
            }

            if (!result) {
                throw new Error('Transaction cancelled');
            }

            flow.context.sourceTxHash = result.txHash;
            flow.context.sourceNonce = result.nonce;

            analytics.track('lock_tx_confirmed', {
                direction: flow.context.direction,
                amount: flow.context.amount,
                source_address: flow.context.sourceAddress,
                destination_address: flow.context.destinationAddress,
                metadata: { tx_hash: result.txHash, nonce: result.nonce },
            });
        } catch (err) {
            const message =
                err instanceof Error ? err.message : 'Signing failed';

            analytics.track('lock_tx_rejected', {
                direction: flow.context.direction,
                amount: flow.context.amount,
                error_message: message,
            });
            flow.markFailed(message);

            return;
        }
    }

    flow.beginSubmitting();
    analytics.track('bridge_submitted', {
        direction: flow.context.direction,
        amount: flow.context.amount,
        source_address: flow.context.sourceAddress,
        destination_address: flow.context.destinationAddress,
    });

    try {
        const csrfToken = document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1];
        const response = await fetch('/bridge/submit', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-XSRF-TOKEN': csrfToken ? decodeURIComponent(csrfToken) : '',
            },
            credentials: 'same-origin',
            body: JSON.stringify({
                direction: flow.context.direction,
                token: flow.context.token,
                source_tx_hash: flow.context.sourceTxHash,
                source_nonce: flow.context.sourceNonce,
                sender_address: flow.context.sourceAddress,
                recipient_address: flow.context.destinationAddress,
                amount: flow.context.amount,
                convert_to_native: flow.context.convertToNative,
                reservation: reservationReference.value,
                session_id: analytics.sessionId,
            }),
        });

        const data = await response.json();

        if (!response.ok) {
            const message =
                data.message ?? `Submit failed (HTTP ${response.status})`;

            analytics.track('bridge_submit_failed', {
                direction: flow.context.direction,
                error_message: message,
            });
            flow.markFailed(message);

            return;
        }

        const br = data.bridge_request;

        flow.beginTracking(br.id);
        analytics.track('tracking_started', {
            direction: flow.context.direction,
            bridge_request_id: br.id,
        });

        if (br.status === 'completed') {
            markBridgeSucceeded(br.destination_tx_hash ?? null);
        } else if (br.status === 'failed') {
            flow.markFailed(br.error_message ?? 'Bridge failed');
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Submit failed';

        analytics.track('bridge_submit_failed', {
            direction: flow.context.direction,
            error_message: message,
        });
        flow.markFailed(message);
    }
};

// --- Yenten one-time-address flow (prepare → claim) ---------------------
const preparing = ref(false);

const postJson = async (url: string, body: Record<string, unknown>) => {
    const csrfToken = document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1];
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-XSRF-TOKEN': csrfToken ? decodeURIComponent(csrfToken) : '',
        },
        credentials: 'same-origin',
        body: JSON.stringify(body),
    });

    return { response, data: await response.json() };
};

const handlePrepare = async () => {
    if (!flow.context.direction || preparing.value) {
        return;
    }

    preparing.value = true;

    try {
        const { response, data } = await postJson('/bridge/prepare', {
            direction: flow.context.direction,
            token: flow.context.token,
            recipient_address: flow.context.destinationAddress,
            session_id: analytics.sessionId,
        });

        if (!response.ok) {
            flow.markFailed(
                data.message ??
                    `Could not reserve a deposit address (HTTP ${response.status})`,
            );

            return;
        }

        const br = data.bridge_request;
        flow.context.bridgeRequestId = br.id;
        flow.context.depositAddress = br.deposit_address;
        flow.context.depositExpiresAt = br.expires_at ?? null;
        depositConfirmations.value = br.confirmations ?? null;
        watchDeposit();
    } catch (err) {
        flow.markFailed(err instanceof Error ? err.message : 'Prepare failed');
    } finally {
        preparing.value = false;
    }
};

const handleClaim = async () => {
    if (!flow.context.bridgeRequestId) {
        return;
    }

    claimError.value = null;

    try {
        const { response, data } = await postJson('/bridge/claim', {
            id: flow.context.bridgeRequestId,
            session_id: analytics.sessionId,
        });

        if (!response.ok) {
            // Retryable (no deposit yet / unconfirmed): keep the deposit panel.
            claimError.value =
                data.message ?? `Check failed (HTTP ${response.status})`;

            // The deposit window closed on an empty address — release the
            // dead address so the user can start a fresh transfer.
            if (data.expired) {
                flow.context.bridgeRequestId = null;
                flow.context.depositAddress = null;
                flow.context.depositExpiresAt = null;
            }

            return;
        }

        const br = data.bridge_request;
        stopWatchingDeposit();
        flow.beginTracking(br.id);
        analytics.track('tracking_started', {
            direction: flow.context.direction!,
            bridge_request_id: br.id,
        });

        if (br.status === 'completed') {
            markBridgeSucceeded(br.destination_tx_hash ?? null);
        } else if (br.status === 'failed') {
            flow.markFailed(br.error_message ?? 'Bridge failed');
        }
    } catch (err) {
        claimError.value = err instanceof Error ? err.message : 'Claim failed';
    }
};

const claimError = ref<string | null>(null);
/** Confirmations the source chain wants, as the corridor answered it. */
const depositConfirmations = ref<number | null>(null);
const depositTimer = ref<number | null>(null);

const stopWatchingDeposit = (): void => {
    if (depositTimer.value !== null) {
        window.clearTimeout(depositTimer.value);
        depositTimer.value = null;
    }
};

/**
 * Watch a deposit that has nowhere to announce itself.
 *
 * Coins landing on an address raise no event a browser can hear, and on Monero
 * they cannot even be looked up from here — only the bridge's own wallet sees
 * them. The server sweeps every couple of minutes whether or not anybody is
 * here; this asks the cheap question (what is this request's status) while the
 * page is open, so somebody who IS watching sees it move rather than sitting
 * on a screen that never changes. The "check now" button still exists for the
 * impatient, and it is the one that actually goes and reads the chain.
 */
const watchDeposit = (): void => {
    stopWatchingDeposit();

    depositTimer.value = window.setTimeout(async () => {
        const id = flow.context.bridgeRequestId;

        if (!id || !flow.context.depositAddress) {
            return;
        }

        try {
            const res = await fetch(`/api/bridge/${id}/status`, {
                headers: { Accept: 'application/json' },
                credentials: 'same-origin',
            });

            if (res.ok) {
                const data = await res.json();

                if (data.status === 'expired') {
                    claimError.value =
                        'The deposit window closed — start a new transfer.';
                    flow.context.bridgeRequestId = null;
                    flow.context.depositAddress = null;
                    flow.context.depositExpiresAt = null;

                    return;
                }

                if (data.status && data.status !== 'awaiting_deposit') {
                    // The sweep credited it. From here the tracking step owns
                    // the polling, and it knows about payouts and burns.
                    flow.beginTracking(id);

                    return;
                }
            }
        } catch {
            // Offline or a hiccup: keep waiting rather than declaring anything.
        }

        watchDeposit();
    }, 15000);
};

onBeforeUnmount(stopWatchingDeposit);

const markBridgeSucceeded = (destinationTxHash: string | null): void => {
    if (flow.context.direction) {
        const selectedRoute = bridgeRoute(flow.context.direction);

        track('bridge_completed', {
            metadata: {
                action_type: flow.context.direction,
                network: `${selectedRoute.sourceLabel} -> ${selectedRoute.destinationLabel}`,
                token: flow.context.token,
            },
        });
    }

    flow.markSucceeded(destinationTxHash);
};

const handleReset = () => {
    stopWatchingDeposit();
    flow.reset();
    claimError.value = null;
    depositConfirmations.value = null;
};

const formatActiveRequestTime = (iso: string | null): string => {
    if (!iso) {
        return '';
    }

    const date = new Date(iso);

    return Number.isNaN(date.getTime())
        ? ''
        : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const activeRequestAction = (request: ActiveBridgeRequest): string => {
    if (request.status === 'awaiting_deposit' && request.deposit_address) {
        return 'Continue deposit';
    }

    return 'Track';
};

const activeRequestRouteLabel = (request: ActiveBridgeRequest): string => {
    const route = bridgeRoute(request.direction as BridgeDirection);

    return `${route.sourceLabel} -> ${route.destinationLabel}`;
};

const resumeActiveRequest = (request: ActiveBridgeRequest): void => {
    const direction = request.direction as BridgeDirection;

    flow.chooseDirection(direction);
    flow.context.token = (request.token ?? 'YTN') as BridgeTokenSymbol;
    flow.context.destinationAddress = request.recipient_address;
    flow.context.sourceAddress = request.sender_address ?? '';
    flow.context.sourceTxHash = request.source_tx_hash ?? '';
    flow.context.amount = parseFloat(request.amount) > 0 ? request.amount : '';
    flow.context.bridgeRequestId = request.id;
    flow.context.depositAddress = request.deposit_address;
    flow.context.depositExpiresAt = request.expires_at;
    flow.context.destinationTxHash = request.destination_tx_hash;
    flow.context.error = null;
    claimError.value = null;

    if (request.status !== 'awaiting_deposit') {
        flow.beginTracking(request.id);

        return;
    }

    watchDeposit();
};
</script>

<template>
    <div class="w-full">
        <div v-if="flow.step.value === 'idle'" class="flex flex-col gap-4">
            <div
                v-if="props.activeRequests.length > 0"
                class="rounded-xl border border-border p-4"
            >
                <h2 class="text-sm font-semibold text-foreground">
                    Active bridge requests
                </h2>
                <div class="mt-3 flex flex-col gap-2">
                    <div
                        v-for="request in props.activeRequests"
                        :key="request.id"
                        class="rounded-lg bg-muted/50 px-3 py-2"
                    >
                        <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                                <p class="text-xs font-medium text-foreground">
                                    {{ activeRequestRouteLabel(request) }}
                                    · {{ request.token ?? 'YTN' }}
                                </p>
                                <p
                                    v-if="request.deposit_address"
                                    class="mt-1 truncate font-mono text-[10px] text-muted-foreground"
                                >
                                    {{ request.deposit_address }}
                                </p>
                                <p
                                    class="mt-1 text-[10px] text-muted-foreground"
                                >
                                    {{ request.status
                                    }}<template v-if="request.expires_at">
                                        · active until
                                        {{
                                            formatActiveRequestTime(
                                                request.expires_at,
                                            )
                                        }}</template
                                    >
                                </p>
                            </div>
                            <button
                                type="button"
                                class="shrink-0 rounded border border-border px-2 py-1 text-[10px] font-medium text-foreground hover:border-foreground/40"
                                @click="resumeActiveRequest(request)"
                            >
                                {{ activeRequestAction(request) }}
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <StepDirection
                :available-directions="props.availableDirections"
                @select="handleDirection"
            />
        </div>

        <StepConfigure
            v-else-if="
                flow.step.value === 'configuring' && flow.context.direction
            "
            :direction="flow.context.direction"
            v-model:token="flow.context.token"
            v-model:amount="flow.context.amount"
            v-model:source-tx-hash="flow.context.sourceTxHash"
            v-model:source-address="flow.context.sourceAddress"
            v-model:destination-address="flow.context.destinationAddress"
            v-model:convert-to-native="flow.context.convertToNative"
            :convert-enabled="props.convertConfig.enabled"
            :convert-rate="props.convertConfig.rate"
            :source-wallet-connected="sourceWalletConnected"
            :source-wallet-address="sourceWalletAddress"
            :source-wallet-connecting="sourceWalletConnecting"
            :source-balance="sourceBalance"
            :source-max-amount="sourceMaxAmount"
            :destination-capacity="destinationCapacity"
            :destination-label="destinationLabel"
            :source-deposit-address="sourceDepositAddress"
            :prepared-deposit-address="flow.context.depositAddress"
            :deposit-confirmations="depositConfirmations"
            :deposit-expires-at="flow.context.depositExpiresAt"
            :preparing="preparing"
            :recent="flow.recentForDirection.value"
            :saved-monero-address="savedMoneroAddress"
            @connect-source="handleConnectSource"
            @prepare="handlePrepare"
            @claim="handleClaim"
            @next="handleConfigureNext"
            @back="handleReset"
        />

        <p
            v-if="claimError && flow.step.value === 'configuring'"
            class="mt-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-xs text-yellow-700 dark:text-yellow-400"
        >
            {{ claimError }}
        </p>

        <StepReview
            v-else-if="
                flow.step.value === 'reviewing' && flow.context.direction
            "
            :direction="flow.context.direction"
            :token="flow.context.token"
            :amount="flow.context.amount"
            :source-address="flow.context.sourceAddress"
            :destination-address="flow.context.destinationAddress"
            :cyber-sol-usd="props.cyberSolUsd"
            :fee-config="props.feeConfig"
            :gas-drop-planned="gasDropPlanned"
            :gas-drop-amount="props.gasDropConfig.amount"
            :convert-to-native="flow.context.convertToNative"
            :convert-rate="props.convertConfig.rate"
            v-model:confirmed="flow.context.confirmed"
            @confirm="handleConfirm"
            @back="flow.backToConfigure"
        />

        <StepSigning
            v-else-if="
                (flow.step.value === 'signing' ||
                    flow.step.value === 'submitting') &&
                flow.context.direction
            "
            :direction="flow.context.direction"
            :phase="flow.step.value === 'signing' ? 'signing' : 'submitting'"
        />

        <StepTracking
            v-else-if="
                (flow.step.value === 'tracking' ||
                    flow.step.value === 'succeeded' ||
                    flow.step.value === 'failed') &&
                flow.context.direction &&
                flow.context.bridgeRequestId
            "
            :direction="flow.context.direction"
            :token="flow.context.token"
            :bridge-request-id="flow.context.bridgeRequestId"
            :source-tx-hash="flow.context.sourceTxHash"
            :destination-address="flow.context.destinationAddress"
            @succeeded="markBridgeSucceeded"
            @failed="flow.markFailed"
            @reset="handleReset"
        />

        <div
            v-else-if="flow.step.value === 'failed'"
            class="flex flex-col items-center gap-3 py-8 text-center"
        >
            <p
                class="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600 dark:text-red-400"
            >
                {{ flow.context.error || 'Bridge failed' }}
            </p>
            <button
                type="button"
                class="rounded-lg border border-[#19140035] px-4 py-2 text-sm text-[#1b1b18] hover:border-[#1915014a] dark:border-[#3E3E3A] dark:text-[#EDEDEC] dark:hover:border-[#62605b]"
                @click="handleReset"
            >
                Try again
            </button>
        </div>
    </div>
</template>
