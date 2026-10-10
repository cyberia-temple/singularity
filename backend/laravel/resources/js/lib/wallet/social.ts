/**
 * What the wallet reads about the rest of Cyberia, and the one thing it writes.
 *
 * The reads carry no identity — they are public, and everything they return is
 * something the site already shows on a public page. Nothing here ever sends an
 * address the user did not ask about: the profile lookup is keyed by the
 * address being looked at, and it is the only read that mentions one at all.
 *
 * `publishPost` is the exception and needs a session, because a post needs an
 * author. The wallet gets one by signing the site's login challenge
 * (`lib/wallet/session.ts`); until it has, the composer offers that press and
 * nothing else.
 */

import { sessionCall } from '@/lib/wallet/session';

export type FeedPerson = {
    name: string;
    avatar: string | null;
    address: string | null;
    url: string;
};

/**
 * Something somebody did on chain, as the Telegram bot read it: `action` is
 * the bot's kind (`swap`, `liq_add`, `lend_borrowed`, `bridge`, …) and the two
 * amounts are already formatted. `detail` is what the row's extras say in
 * words — a bridge's route, a domain's name.
 */
export type FeedOnchain = {
    action: string;
    in: string | null;
    out: string | null;
    detail: string | null;
    usd: number | null;
};

/** A token launched on the launchpad, and the DAO the launch opened. */
export type FeedLaunch = {
    address: string;
    name: string | null;
    symbol: string | null;
    image: string | null;
    dao: { id: number; name: string } | null;
};

export type FeedItem = {
    kind: 'post' | 'dao' | 'onchain' | 'launch';
    id: string;
    at: string | null;
    who: FeedPerson | null;
    /** Present on DAO rows: the activity key, said in the wallet's language. */
    type?: string;
    text: string | null;
    meta: string | null;
    onchain?: FeedOnchain;
    launch?: FeedLaunch;
    url: string;
};

export type FeedTab = 'all' | 'posts' | 'dao' | 'onchain';

export type DaoSummary = {
    id: number;
    name: string;
    address: string | null;
    proposals: number;
};

export type ProposalSummary = {
    id: number;
    title: string;
    summary: string;
    status: 'open' | 'closed';
    endsAt: string | null;
    dao: { id: number; name: string } | null;
    author: FeedPerson | null;
    comments: number;
    votes: number;
    /** Decimal strings: voting power is decimal(*,18) and only ever a ratio. */
    powerFor: string;
    powerAgainst: string;
    url: string;
    descriptionHtml?: string;
};

export type WalletAchievement = {
    id: number;
    key: string;
    title: string;
    description: string;
    icon: string;
    earned: boolean;
};

export type WalletProfile = {
    claimed: boolean;
    address: string;
    name?: string;
    onchainNickname?: string | null;
    avatar?: string | null;
    profileUrl?: string;
    joinedAt?: string | null;
    stats?: { proposals: number; votes: number; posts: number };
    achievements: WalletAchievement[];
};

const read = async <T>(path: string): Promise<T> => {
    const response = await fetch(path, {
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error(`Cyberia returned ${response.status}`);
    }

    return (await response.json()) as T;
};

export const fetchFeed = async (tab: FeedTab = 'all'): Promise<FeedItem[]> =>
    (await read<{ items: FeedItem[] }>(`/api/wallet/feed?tab=${tab}`)).items;

/**
 * Write a post, as whoever this browser is signed in as.
 *
 * Answers with the row the feed draws, so the screen can put it on top of the
 * list it already has instead of re-reading a list it just changed. A refusal
 * arrives in the server's own words — "too fast", "not signed in" — because
 * those are the two a person can act on.
 */
export const publishPost = async (body: string): Promise<FeedItem> =>
    (
        await sessionCall<{ post: FeedItem }>('/api/wallet/feed', {
            method: 'POST',
            body: JSON.stringify({ body }),
        })
    ).post;

export const fetchDao = (): Promise<{
    daos: DaoSummary[];
    proposals: ProposalSummary[];
}> => read('/api/wallet/dao');

export const fetchProposal = async (id: number): Promise<ProposalSummary> =>
    (
        await read<{ proposal: ProposalSummary }>(
            `/api/wallet/dao/proposals/${id}`,
        )
    ).proposal;

export const fetchProfile = (address: string): Promise<WalletProfile> =>
    read(`/api/wallet/profile/${address}`);

/**
 * The two sides of a tally as percentages of what was actually cast.
 *
 * Voting power arrives as a decimal string because it is a decimal(*,18); it is
 * only ever drawn as a proportion, so it is safe to take the ratio in floating
 * point here — and a tally with no votes is 0/0 rather than half each.
 */
export const tally = (
    powerFor: string,
    powerAgainst: string,
): { for: number; against: number; cast: number } => {
    const yes = Number(powerFor) || 0;
    const no = Number(powerAgainst) || 0;
    const cast = yes + no;

    return cast === 0
        ? { for: 0, against: 0, cast: 0 }
        : { for: (100 * yes) / cast, against: (100 * no) / cast, cast };
};

export type MyVote = { support: boolean; power: string };

/**
 * This account's vote on a proposal, or null — and null too when the browser
 * carries no session yet, because "not signed in" and "has not voted" draw the
 * same two buttons.
 */
export const fetchMyVote = async (
    id: number,
): Promise<{ address: string | null; vote: MyVote | null }> => {
    try {
        return await sessionCall(`/api/wallet/dao/proposals/${id}/vote`);
    } catch {
        return { address: null, vote: null };
    }
};

/**
 * Cast (or change) a vote as the address this session signed in with.
 *
 * `address` is what the wallet believes it is voting as; the server compares it
 * with the session and answers 409 when they differ, which is the caller's cue
 * to sign in again with the right key rather than vote under another name.
 */
export const castVote = async (
    id: number,
    address: string,
    support: boolean,
): Promise<MyVote> =>
    (
        await sessionCall<{ vote: MyVote }>(
            `/api/wallet/dao/proposals/${id}/vote`,
            {
                method: 'POST',
                body: JSON.stringify({ address, support }),
            },
        )
    ).vote;

/**
 * Put a proposal up, authored by the address this session signed in with. The
 * same 409 as a vote when the session belongs to another key. Answers with the
 * new proposal's id, which the screen then opens.
 */
export const createProposal = async (proposal: {
    address: string;
    daoId: number;
    title: string;
    description: string;
    endsAt: string;
}): Promise<number> =>
    (
        await sessionCall<{ id: number }>('/api/wallet/dao/proposals', {
            method: 'POST',
            body: JSON.stringify({
                address: proposal.address,
                dao_id: proposal.daoId,
                title: proposal.title,
                description: proposal.description,
                ends_at: proposal.endsAt,
            }),
        })
    ).id;

export type ProposalComment = {
    id: number;
    at: string | null;
    who: FeedPerson | null;
    /** Server-rendered through the site's own markdown sanitiser. */
    bodyHtml: string;
    replies?: ProposalComment[];
};

/** A proposal's thread, oldest first, replies under their comment. */
export const fetchComments = async (id: number): Promise<ProposalComment[]> =>
    (
        await read<{ comments: ProposalComment[] }>(
            `/api/wallet/dao/proposals/${id}/comments`,
        )
    ).comments;

/**
 * Comment on a proposal (or reply to a top-level comment) as the address this
 * session signed in with — the same 409 as a vote when it belongs to another
 * key. Answers with the new comment's id.
 */
export const postComment = async (
    id: number,
    address: string,
    body: string,
    parentId: number | null = null,
): Promise<number> =>
    (
        await sessionCall<{ id: number }>(
            `/api/wallet/dao/proposals/${id}/comments`,
            {
                method: 'POST',
                body: JSON.stringify({ address, body, parent_id: parentId }),
            },
        )
    ).id;
