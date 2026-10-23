/**
 * The wallet's invite screen: the client half.
 *
 * Talks to `/api/wallet/referrals`, a *web* route for the daily board's reason
 * — a referral links two accounts, so it carries the session. See
 * ReferralService for the rules; the one that shapes everything is that an
 * inviter only ever gets a share of a fee a friend actually paid.
 *
 * A shared link (`/r/CODE`) lands on `/wallet?section=invite&invite=CODE`. The
 * code is kept in this browser until there is an account to attach it to,
 * because the person following a link usually has no account yet — that is
 * the point of being invited. The pure half is pinned in
 * `tests/Frontend/WalletReferralTest.mjs`.
 */

import { sessionCall } from '@/lib/wallet/session';

export type ReferralProgram = {
    enabled: boolean;
    /** False when this host takes no fee, so nothing can be earned yet. */
    collecting: boolean;
    shareBps: number;
    feeBps: number;
    sources: string[];
    attachWindowDays: number;
    payout: {
        cadence: 'weekly';
        asset: string;
        minimumUsd: number;
    };
};

export type ReferralRewardRow = {
    id: number;
    rewardUsd: number;
    feeUsd: number;
    source: string;
    at: string | null;
    state: 'accrued' | 'scheduled' | 'paid';
};

export type ReferralAccount = {
    code: string | null;
    link: string | null;
    invited: number;
    /** Invited friends who have earned this account anything yet. */
    earning: number;
    earnedUsd: number;
    paidUsd: number;
    pendingUsd: number;
    invitedBy: boolean;
    /** Whether this account may still accept an invite. */
    canAccept: boolean;
    recent: ReferralRewardRow[];
};

export type ReferralBoard = {
    program: ReferralProgram;
    signedIn: boolean;
    /** Null when nobody is signed in — never a row of zeroes. */
    account: ReferralAccount | null;
};

export type InviteRefusal =
    | 'signed_out'
    | 'disabled'
    | 'unknown_code'
    | 'own_code'
    | 'already_invited'
    | 'too_old'
    | 'circular';

export const loadReferrals = (): Promise<ReferralBoard> =>
    sessionCall<ReferralBoard>('/api/wallet/referrals');

/**
 * Accept an invite for the signed-in account.
 *
 * A refusal arrives with the server's reason key on the error (`sessionCall`
 * keeps it), so the screen can say it in the reader's language — see
 * `inviteReasonOf`.
 */
export const acceptInvite = (code: string): Promise<ReferralBoard> =>
    sessionCall<ReferralBoard>('/api/wallet/referrals/attach', {
        method: 'POST',
        body: JSON.stringify({ code }),
    });

/* ---------------------------------------------------------------- pure --- */

const CODE = /^[2-9A-HJ-NP-Z]{6,16}$/;

/** A code as typed or linked, normalised; null for anything that is not one. */
export const normaliseCode = (
    raw: string | null | undefined,
): string | null => {
    const code = (raw ?? '').trim().toUpperCase();

    return CODE.test(code) ? code : null;
};

/** `2500` → `25%`; a fractional share keeps its fraction. */
export const sharePct = (bps: number): string => {
    const pct = bps / 100;

    return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0+$/, '')}%`;
};

/**
 * Dollars as an inviter should read them.
 *
 * Shares of a 0.75% fee are small, and a cent rounded to `$0.00` reads as
 * "you earned nothing", which is false. Under a cent shows four places.
 */
export const formatUsd = (amount: number, locale = 'en'): string => {
    const digits = amount > 0 && amount < 0.01 ? 4 : 2;

    return `$${amount.toLocaleString(locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    })}`;
};

/** The refusal key a failed accept carried, or null when it carried none. */
export const inviteReasonOf = (error: unknown): InviteRefusal | null => {
    const status = (error as { status?: number } | null)?.status;

    if (status === 401) {
        return 'signed_out';
    }

    const known: InviteRefusal[] = [
        'disabled',
        'unknown_code',
        'own_code',
        'already_invited',
        'too_old',
        'circular',
    ];
    const reason = (error as { reason?: string } | null)?.reason;

    return known.find((candidate) => candidate === reason) ?? null;
};

/* ------------------------------------------------------- pending invite --- */

const PENDING_KEY = 'cyberia.wallet.invite';

/** Keep a linked code until this browser has an account to give it to. */
export const rememberInvite = (raw: string | null): string | null => {
    const code = normaliseCode(raw);

    if (code === null) {
        return null;
    }

    try {
        window.localStorage.setItem(PENDING_KEY, code);
    } catch {
        // Private mode: the code still works for this visit through the screen.
    }

    return code;
};

export const pendingInvite = (): string | null => {
    try {
        return normaliseCode(window.localStorage.getItem(PENDING_KEY));
    } catch {
        return null;
    }
};

export const forgetInvite = (): void => {
    try {
        window.localStorage.removeItem(PENDING_KEY);
    } catch {
        // Nothing stored, nothing to forget.
    }
};
