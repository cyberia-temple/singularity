import assert from 'node:assert/strict';
import test from 'node:test';
import {
    arenaAction,
    arenaGameLists,
    arenaNeedsAction,
    arenaRole,
} from '../../resources/js/lib/wallet/arenaState.ts';

const one = '0x1111111111111111111111111111111111111111';
const two = '0x2222222222222222222222222222222222222222';
const outsider = '0x3333333333333333333333333333333333333333';
const game = (changes = {}) => ({
    id: 1n,
    playerOne: one,
    playerTwo: two,
    stake: 1n,
    deadline: 200,
    state: 2,
    result: 0,
    winner: outsider,
    playerOneCommitted: false,
    playerTwoCommitted: false,
    playerOneMove: 0,
    playerTwoMove: 0,
    payout: 0n,
    ...changes,
});

test('Arena roles compare EVM addresses without checksum casing', () => {
    assert.equal(arenaRole(game(), one.toUpperCase()), 'playerOne');
    assert.equal(arenaRole(game(), outsider), 'spectator');
});

test('the action queue names only what this address can do now', () => {
    assert.equal(arenaAction(game(), one, 100), 'commit');
    assert.equal(
        arenaAction(game({ playerOneCommitted: true }), one, 100),
        'wait',
    );
    assert.equal(arenaAction(game({ state: 3 }), two, 100), 'reveal');
    assert.equal(
        arenaAction(
            game({ state: 3, playerOneMove: 1, playerTwoMove: 2 }),
            one,
            100,
        ),
        'resolve',
    );
    assert.equal(arenaAction(game(), outsider, 201), 'settleTimeout');
    assert.equal(
        arenaAction(game({ state: 4, payout: 2n }), one, 300),
        'claim',
    );
});

test('waiting and completed games stay out of attention', () => {
    assert.equal(arenaNeedsAction('wait'), false);
    assert.equal(arenaNeedsAction('complete'), false);
    assert.equal(arenaNeedsAction('reveal'), true);
});

test('matches are partitioned into actionable, personal, open and completed lists', () => {
    const lists = arenaGameLists(
        [
            game({ id: 1n }),
            game({ id: 2n, playerOneCommitted: true }),
            game({
                id: 3n,
                playerOne: outsider,
                playerTwo: '0x0000000000000000000000000000000000000000',
                state: 1,
            }),
            game({ id: 4n, state: 4 }),
        ],
        one,
        100,
    );

    assert.deepEqual(
        lists.attention.map(({ id }) => id),
        [1n],
    );
    assert.deepEqual(
        lists.mine.map(({ id }) => id),
        [1n, 2n],
    );
    assert.deepEqual(
        lists.open.map(({ id }) => id),
        [3n],
    );
    assert.deepEqual(
        lists.complete.map(({ id }) => id),
        [4n],
    );
});
