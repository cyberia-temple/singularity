<?php

/*
|--------------------------------------------------------------------------
| Referrals
|--------------------------------------------------------------------------
|
| Somebody who brings a friend gets a share of the fee Cyberia collected from
| that friend's swaps. A share of a fee, never a bounty: the programme can only
| ever hand out part of money that already arrived, so it costs nothing on a
| day nobody swaps, and inviting yourself from a second wallet always loses
| money — you pay the whole fee to get a quarter of it back.
|
| The only fee it reads today is the cross-chain router's (`crosschain.php`):
| it is the one fee this site takes that a third party records per swap and
| per sender, which is what makes an earning checkable rather than claimed.
| No fee address there means no earnings here, and the screen says so.
|
*/

return [

    'enabled' => (bool) env('REFERRALS_ENABLED', true),

    /** Basis points of the collected fee that go to the inviter. 2500 = 25%. */
    'share_bps' => (int) env('REFERRALS_SHARE_BPS', 2500),

    /**
     * The ceiling, whatever the environment says. Above half the fee the
     * project would be paying people to route volume through it, which is the
     * one thing the team has agreed never to do.
     */
    'max_share_bps' => 5000,

    /**
     * How new an account has to be to accept an invite. A referral is a claim
     * that somebody *arrived* because of you; an account that has been here for
     * months did not, and letting anyone attach it would turn the code into a
     * way of farming people who were already using the wallet.
     */
    'attach_window_days' => (int) env('REFERRALS_ATTACH_WINDOW_DAYS', 30),

    'payout' => [
        /** Below this an inviter's balance waits for the next week. */
        'minimum_usd' => (float) env('REFERRALS_PAYOUT_MINIMUM_USD', 1.0),

        /** What is sent, as the screen should name it. */
        'asset' => (string) env('REFERRALS_PAYOUT_ASSET', 'USDC'),
    ],

    /** Router requests read per page, and pages per friend per sync. */
    'sync' => [
        'page_size' => 100,
        'max_pages' => 5,
    ],
];
