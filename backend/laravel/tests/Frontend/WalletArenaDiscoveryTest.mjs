import assert from 'node:assert/strict';
import test from 'node:test';
import { arenaRecentGameIds } from '../../resources/js/lib/wallet/arena.ts';

test('recent Arena ids are newest first and never include the next id', () => {
    assert.deepEqual(arenaRecentGameIds(6n), [5n, 4n, 3n, 2n, 1n]);
    assert.deepEqual(arenaRecentGameIds(1n), []);
});

test('Arena discovery has a hard bounded window', () => {
    assert.deepEqual(arenaRecentGameIds(100n, 3), [99n, 98n, 97n]);
    assert.deepEqual(arenaRecentGameIds(10n, 0), []);
});
