import assert from 'node:assert/strict';
import test from 'node:test';

import {
    STREAK_DAYS,
    levelPct,
    nextStreakBonus,
    questDestination,
    streakStrip,
    untilReset,
} from '@/lib/wallet/daily';

/**
 * The daily board hands somebody a number and tells them they earned it. These
 * are the four places that number is decided in the browser rather than on the
 * server, so they are the four that are pinned.
 */

const BONUSES = { 3: 25, 7: 75, 14: 200, 30: 500 };

test('the strip is a window on the run, not a calendar', () => {
    const fresh = streakStrip(0, false, BONUSES);

    assert.equal(fresh.length, STREAK_DAYS);
    assert.deepEqual(
        fresh.map((cell) => cell.day),
        [1, 2, 3, 4, 5, 6, 7],
    );
    // Nothing kept yet, and today is the day the button would fill.
    assert.equal(fresh[0].state, 'today');
    assert.equal(fresh[1].state, 'ahead');
});

test('a long run scrolls rather than filling seven identical boxes', () => {
    const long = streakStrip(23, true, BONUSES);

    assert.deepEqual(
        long.map((cell) => cell.day),
        [17, 18, 19, 20, 21, 22, 23],
    );
    assert.equal(long.at(-1).state, 'today');
    assert.ok(long.slice(0, -1).every((cell) => cell.state === 'kept'));
});

test('today is the day the press decides, and moves once it is kept', () => {
    // Day 3 done: today *is* day 3, and it is already behind the button.
    const kept = streakStrip(3, true, BONUSES);
    assert.equal(kept.find((cell) => cell.state === 'today').day, 3);
    assert.equal(kept.filter((cell) => cell.state === 'kept').length, 2);

    // Day 3 done yesterday, nothing yet today: the press is day 4.
    const owed = streakStrip(3, false, BONUSES);
    assert.equal(owed.find((cell) => cell.state === 'today').day, 4);
    assert.equal(owed.filter((cell) => cell.state === 'kept').length, 3);
});

test('a cell carries the milestone that day actually pays', () => {
    const strip = streakStrip(0, false, BONUSES);

    assert.equal(strip.find((cell) => cell.day === 7).bonus, 75);
    assert.equal(strip.find((cell) => cell.day === 5).bonus, 0);
});

test('the next milestone is the first one still ahead of the run', () => {
    assert.deepEqual(nextStreakBonus(0, BONUSES), { day: 3, xp: 25 });
    assert.deepEqual(nextStreakBonus(3, BONUSES), { day: 7, xp: 75 });
    // Standing exactly on one has already been paid for it.
    assert.deepEqual(nextStreakBonus(7, BONUSES), { day: 14, xp: 200 });
    assert.equal(nextStreakBonus(30, BONUSES), null);
});

test('a quest goes where its action is done, by action and not by name', () => {
    assert.deepEqual(questDestination(['swap']), {
        kind: 'overlay',
        overlay: 'swap',
    });
    assert.deepEqual(questDestination(['bridge']), {
        kind: 'section',
        section: 'bridge',
    });
    assert.deepEqual(questDestination(['liquidity']), {
        kind: 'link',
        href: '/liquidity',
    });

    // "Do one thing on-chain" lists several; the first with a home wins, and
    // the wallet's own swap screen is deliberately that one.
    assert.deepEqual(
        questDestination([
            'swap',
            'bridge',
            'staking',
            'lending',
            'liquidity',
            'convert',
        ]),
        { kind: 'overlay', overlay: 'swap' },
    );
});

test('a quest with nowhere to go says so instead of linking nowhere', () => {
    assert.equal(questDestination(['visit']), null);
    assert.equal(questDestination(['streak_day']), null);
    assert.equal(questDestination([]), null);
});

test('the reset counts down in whole hours and minutes, never past zero', () => {
    const at = Date.parse('2026-09-08T18:47:00Z');

    assert.deepEqual(untilReset('2026-09-09T00:00:00Z', at), {
        hours: 5,
        minutes: 13,
    });
    // A board left open past its own reset counts to zero rather than up.
    assert.deepEqual(untilReset('2026-09-08T00:00:00Z', at), {
        hours: 0,
        minutes: 0,
    });
    assert.deepEqual(untilReset('not a date', at), { hours: 0, minutes: 0 });
});

test('the level bar cannot leave its own track', () => {
    assert.equal(
        levelPct({
            xp: 150,
            level: 2,
            title: 'Dial-Up',
            levelFloorXp: 100,
            nextLevelXp: 300,
            progressPct: 25,
            currentStreak: 1,
            longestStreak: 1,
            lastActiveOn: null,
            activeToday: true,
            rank: 4,
            spendable: 150,
        }),
        25,
    );

    // The last level has no ceiling to divide by, and a full bar is the truth
    // there rather than a division by zero.
    assert.equal(
        levelPct({
            xp: 99_999,
            level: 50,
            title: 'Present Day',
            levelFloorXp: 122_500,
            nextLevelXp: null,
            progressPct: 100,
            currentStreak: 9,
            longestStreak: 9,
            lastActiveOn: null,
            activeToday: true,
            rank: 1,
            spendable: 0,
        }),
        100,
    );
});
