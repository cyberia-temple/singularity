import assert from 'node:assert/strict';
import test from 'node:test';
import {
    arenaSecondsRemaining,
    formatArenaCountdown,
} from '../../resources/js/lib/wallet/arenaTime.ts';

test('Arena deadlines count down without becoming negative', () => {
    assert.equal(arenaSecondsRemaining(105, 100), 5);
    assert.equal(arenaSecondsRemaining(100, 101), 0);
});

test('Arena countdowns stay compact from seconds through hours', () => {
    assert.equal(formatArenaCountdown(5), '0:05');
    assert.equal(formatArenaCountdown(65), '1:05');
    assert.equal(formatArenaCountdown(3661), '1:01:01');
    assert.equal(formatArenaCountdown(-1), '0:00');
});
