<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useLocale } from '@/composables/useLocale';
import type { MultiWallet } from '@/composables/useMultiWallet';
import {
    acceptInvite,
    forgetInvite,
    formatUsd,
    inviteReasonOf,
    loadReferrals,
    pendingInvite,
    sharePct,
} from '@/lib/wallet/referrals';
import type { ReferralBoard, ReferralRewardRow } from '@/lib/wallet/referrals';
import { signInWithWallet } from '@/lib/wallet/session';
import { walletMessages } from '@/lib/walletMessages';

/**
 * Invite friends: a share of the fee Cyberia collected from them.
 *
 * The screen says the one rule everything else follows from before it shows a
 * single number — the inviter gets part of a fee a friend actually paid, never
 * a bounty — because that sentence is also the answer to "can I invite myself"
 * and "is this paying for volume", the two questions anybody sensible asks.
 *
 * Like the daily board, its subject is an account: a referral links two
 * people. Signed out it shows the rules and the one press that proves this
 * address with its own key. A code that arrived through a link waits in this
 * browser and is accepted the moment there is an account to accept it.
 */

const props = defineProps<{ wallet: MultiWallet }>();

const emit = defineEmits<{ back: [] }>();

const { locale, t } = useLocale(walletMessages);

const CHAIN = 'cyberia' as const;

const board = ref<ReferralBoard | null>(null);
const loading = ref(true);
const failure = ref<string | null>(null);
const signingIn = ref(false);
const accepting = ref(false);
const copied = ref(false);
const invite = ref<string | null>(pendingInvite());
const inviteNote = ref<string | null>(null);

const account = computed(
    () =>
        props.wallet.accounts.value.find(
            (candidate) => candidate.chain === CHAIN,
        ) ?? null,
);

const program = computed(() => board.value?.program ?? null);
const mine = computed(() => board.value?.account ?? null);
const share = computed(() => sharePct(program.value?.shareBps ?? 0));

const read = async (): Promise<void> => {
    loading.value = true;
    failure.value = null;

    try {
        board.value = await loadReferrals();
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        loading.value = false;
    }
};

/**
 * Hand a waiting code to the signed-in account.
 *
 * A refusal that will never change (own code, already invited, too old, no
 * such code) forgets the code, so the card does not come back on every visit;
 * a signed-out answer keeps it for after the signature.
 */
const accept = async (): Promise<void> => {
    const code = invite.value;

    if (code === null || accepting.value) {
        return;
    }

    accepting.value = true;
    inviteNote.value = null;

    try {
        board.value = await acceptInvite(code);
        forgetInvite();
        invite.value = null;
        inviteNote.value = t('inviteAccepted');
    } catch (error) {
        const reason = inviteReasonOf(error);

        if (reason !== 'signed_out') {
            forgetInvite();
            invite.value = null;
        }

        inviteNote.value =
            reason === null
                ? error instanceof Error
                    ? error.message
                    : String(error)
                : t(`inviteRefused_${reason}`);
    } finally {
        accepting.value = false;
    }
};

const signIn = async (): Promise<void> => {
    const address = account.value?.address;

    if (!address || signingIn.value) {
        return;
    }

    signingIn.value = true;
    failure.value = null;

    try {
        await signInWithWallet(address, (message) =>
            props.wallet.signMessage(CHAIN, message),
        );

        await read();

        if (invite.value !== null && mine.value?.canAccept) {
            await accept();
        }
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        signingIn.value = false;
    }
};

onMounted(async () => {
    await read();

    // Signed in already and holding a linked code: accept it without asking
    // for a second press — following the link *was* the press.
    if (
        invite.value !== null &&
        mine.value?.canAccept &&
        !mine.value.invitedBy
    ) {
        await accept();
    } else if (invite.value !== null && mine.value && !mine.value.canAccept) {
        forgetInvite();
        invite.value = null;
    }
});

const copyLink = async (): Promise<void> => {
    const link = mine.value?.link;

    if (!link) {
        return;
    }

    try {
        await navigator.clipboard.writeText(link);
        copied.value = true;
        window.setTimeout(() => (copied.value = false), 1500);
    } catch {
        // The link stays on screen to be selected by hand.
    }
};

const canShare = computed(
    () => typeof navigator !== 'undefined' && 'share' in navigator,
);

const shareLink = async (): Promise<void> => {
    const link = mine.value?.link;

    if (!link || !canShare.value) {
        return;
    }

    try {
        await navigator.share({
            title: 'Cyberia',
            text: t('inviteShareText'),
            url: link,
        });
    } catch {
        // Dismissing the share sheet is not an error worth showing.
    }
};

const money = (amount: number): string => formatUsd(amount, locale.value);

const when = (row: ReferralRewardRow): string =>
    row.at === null
        ? ''
        : new Date(row.at).toLocaleDateString(locale.value, {
              month: 'short',
              day: 'numeric',
          });

const stateLabel = (row: ReferralRewardRow): string =>
    t(`inviteState_${row.state}`);
</script>

<template>
    <div class="cw-stack">
        <button type="button" class="cw-back" @click="emit('back')">
            ← {{ t('navPortfolio') }}
        </button>

        <div
            style="
                display: flex;
                align-items: baseline;
                justify-content: space-between;
                gap: 12px;
                margin: 22px 0 6px;
            "
        >
            <h2 class="cw-title" style="margin: 0">{{ t('inviteTitle') }}</h2>
            <span
                v-if="program"
                style="
                    font: 500 12px/1 var(--cw-mono);
                    letter-spacing: 0.07em;
                    color: var(--cw-accent);
                    flex: none;
                "
                >{{ t('inviteTag', { share }) }}</span
            >
        </div>

        <p v-if="failure" class="cw-note cw-note-bad" style="margin-top: 16px">
            <span>{{ failure }}</span>
            <button type="button" class="cw-back" @click="read()">
                {{ t('retry') }}
            </button>
        </p>

        <p v-if="loading" class="cw-note" style="margin-top: 16px">
            <span>{{ t('inviteLoading') }}</span>
        </p>

        <template v-else-if="board && program">
            <!-- --------------------------------------------------- pitch --- -->
            <div class="cw-card" style="margin-top: 16px; padding: 15px">
                <p class="cw-invite-lead">
                    {{ t('inviteLead', { share }) }}
                </p>
                <p class="cw-invite-body">{{ t('inviteBody') }}</p>
            </div>

            <p
                v-if="!program.collecting || !program.enabled"
                class="cw-note"
                style="margin-top: 10px; color: var(--cw-pending)"
            >
                <span>{{
                    program.enabled ? t('inviteNotCollecting') : t('inviteOff')
                }}</span>
            </p>

            <!-- ------------------------------------------- linked invite --- -->
            <div
                v-if="invite && !mine?.invitedBy"
                class="cw-card"
                style="margin-top: 10px; padding: 15px"
            >
                <div class="cw-row">
                    <span class="cw-label" style="color: var(--cw-dim)">{{
                        t('inviteYouWereInvited')
                    }}</span>
                    <span class="cw-invite-code">{{ invite }}</span>
                </div>
                <p class="cw-invite-body" style="margin-top: 8px">
                    {{
                        board.signedIn
                            ? t('inviteAcceptBody')
                            : t('inviteAcceptAnonBody')
                    }}
                </p>
                <button
                    v-if="board.signedIn"
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="margin-top: 12px"
                    :disabled="accepting"
                    @click="accept()"
                >
                    {{ accepting ? t('inviteAccepting') : t('inviteAccept') }}
                </button>
            </div>

            <p v-if="inviteNote" class="cw-note" style="margin-top: 10px">
                <span>{{ inviteNote }}</span>
            </p>

            <!-- ------------------------------------------------- account --- -->
            <div
                v-if="!board.signedIn"
                class="cw-card"
                style="margin-top: 10px; padding: 15px"
            >
                <p class="cw-invite-body" style="margin: 0">
                    {{ t('inviteAnonBody') }}
                </p>
                <button
                    type="button"
                    class="cw-btn cw-btn-secondary"
                    style="margin-top: 12px"
                    :disabled="signingIn || !account"
                    @click="signIn()"
                >
                    {{ signingIn ? t('dailySigningIn') : t('dailySignIn') }}
                </button>
            </div>

            <template v-else-if="mine">
                <div
                    v-if="mine.link"
                    class="cw-card"
                    style="margin-top: 10px; padding: 15px"
                >
                    <span class="cw-label" style="color: var(--cw-dim)">{{
                        t('inviteYourLink')
                    }}</span>
                    <div class="cw-invite-link">{{ mine.link }}</div>
                    <div style="display: flex; gap: 8px; margin-top: 12px">
                        <button
                            type="button"
                            class="cw-btn cw-btn-primary"
                            @click="copyLink()"
                        >
                            {{ copied ? t('inviteCopied') : t('inviteCopy') }}
                        </button>
                        <button
                            v-if="canShare"
                            type="button"
                            class="cw-btn cw-btn-secondary"
                            @click="shareLink()"
                        >
                            {{ t('inviteShare') }}
                        </button>
                    </div>
                </div>

                <div class="cw-invite-stats">
                    <div class="cw-card cw-invite-stat">
                        <span class="cw-label">{{ t('inviteInvited') }}</span>
                        <strong>{{ mine.invited }}</strong>
                    </div>
                    <div class="cw-card cw-invite-stat">
                        <span class="cw-label">{{ t('inviteEarned') }}</span>
                        <strong>{{ money(mine.earnedUsd) }}</strong>
                    </div>
                    <div class="cw-card cw-invite-stat">
                        <span class="cw-label">{{ t('invitePending') }}</span>
                        <strong>{{ money(mine.pendingUsd) }}</strong>
                    </div>
                    <div class="cw-card cw-invite-stat">
                        <span class="cw-label">{{ t('invitePaid') }}</span>
                        <strong>{{ money(mine.paidUsd) }}</strong>
                    </div>
                </div>

                <!-- ------------------------------------------ rewards --- -->
                <span
                    class="cw-label"
                    style="
                        display: block;
                        margin: 18px 0 8px;
                        color: var(--cw-dim);
                    "
                    >{{ t('inviteRewards') }}</span
                >

                <p v-if="mine.recent.length === 0" class="cw-note">
                    <span>{{ t('inviteNoRewards') }}</span>
                </p>

                <div
                    v-for="row in mine.recent"
                    :key="row.id"
                    class="cw-invite-toast"
                >
                    <img
                        src="/favicon.svg"
                        alt=""
                        class="cw-invite-toast-icon"
                    />
                    <div style="min-width: 0; flex: 1">
                        <div class="cw-invite-toast-title">
                            {{ t('inviteRewardTitle') }}
                        </div>
                        <div class="cw-invite-toast-body">
                            {{
                                t('inviteRewardBody', {
                                    amount: money(row.rewardUsd),
                                })
                            }}
                        </div>
                    </div>
                    <div class="cw-invite-toast-meta">
                        <span>{{ when(row) }}</span>
                        <span
                            :style="{
                                color:
                                    row.state === 'paid'
                                        ? 'var(--cw-ok)'
                                        : 'var(--cw-pending)',
                            }"
                            >{{ stateLabel(row) }}</span
                        >
                    </div>
                </div>
            </template>

            <!-- --------------------------------------------------- rules --- -->
            <div class="cw-card" style="margin-top: 18px; padding: 15px">
                <span class="cw-label" style="color: var(--cw-dim)">{{
                    t('inviteRules')
                }}</span>
                <ul class="cw-invite-rules">
                    <li>{{ t('inviteRuleShare', { share }) }}</li>
                    <li>
                        {{
                            t('inviteRuleNew', {
                                days: program.attachWindowDays,
                            })
                        }}
                    </li>
                    <li>{{ t('inviteRuleSelf') }}</li>
                    <li>
                        {{
                            t('inviteRulePayout', {
                                asset: program.payout.asset,
                                minimum: money(program.payout.minimumUsd),
                            })
                        }}
                    </li>
                </ul>
            </div>
        </template>
    </div>
</template>

<style scoped>
.cw-invite-lead {
    margin: 0;
    font: 500 18px/1.35 var(--cw-sans);
    color: var(--cw-text);
    text-wrap: balance;
}

.cw-invite-body {
    margin: 8px 0 0;
    font: 400 13px/1.65 var(--cw-sans);
    color: var(--cw-muted);
    text-wrap: pretty;
}

.cw-invite-code {
    font: 500 13px/1 var(--cw-mono);
    letter-spacing: 0.08em;
    color: var(--cw-accent);
    flex: none;
}

.cw-invite-link {
    margin-top: 8px;
    padding: 10px 12px;
    border: 1px solid var(--cw-border-soft);
    border-radius: 6px;
    background: var(--cw-input-bg);
    font: 500 13px/1.4 var(--cw-mono);
    color: var(--cw-body);
    overflow-wrap: anywhere;
    user-select: all;
}

.cw-invite-stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 10px;
}

.cw-invite-stat {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 13px 15px;
}

.cw-invite-stat strong {
    font: 500 18px/1 var(--cw-mono);
    color: var(--cw-text);
    font-variant-numeric: tabular-nums;
}

/* The reward reads like the notification that announced it. */
.cw-invite-toast {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 8px;
    padding: 12px 14px;
    border: 1px solid var(--cw-border-soft);
    border-radius: 14px;
    background: var(--cw-elevated);
}

.cw-invite-toast-icon {
    width: 36px;
    height: 36px;
    flex: none;
    border-radius: 9px;
    object-fit: cover;
}

.cw-invite-toast-title {
    font: 600 14px/1.3 var(--cw-sans);
    color: var(--cw-text);
}

.cw-invite-toast-body {
    font: 400 13px/1.4 var(--cw-sans);
    color: var(--cw-muted);
}

.cw-invite-toast-meta {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 4px;
    flex: none;
    font: 500 11px/1 var(--cw-mono);
    color: var(--cw-faint);
}

.cw-invite-rules {
    margin: 10px 0 0;
    padding-left: 18px;
    font: 400 13px/1.65 var(--cw-sans);
    color: var(--cw-muted);
}

.cw-invite-rules li + li {
    margin-top: 6px;
}
</style>
