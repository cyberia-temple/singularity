import assert from 'node:assert/strict';
import test from 'node:test';
import {
    arenaRecentGameIds,
    mapArenaConcurrently,
} from '../../resources/js/lib/wallet/arena.ts';

test('recent Arena ids are newest first and never include the next id', () => {
    assert.deepEqual(arenaRecentGameIds(6n), [5n, 4n, 3n, 2n, 1n]);
    assert.deepEqual(arenaRecentGameIds(1n), []);
});

test('Arena discovery has a hard bounded window', () => {
    assert.deepEqual(arenaRecentGameIds(100n, 3), [99n, 98n, 97n]);
    assert.deepEqual(arenaRecentGameIds(10n, 0), []);
});

test('Arena discovery preserves order while bounding concurrent RPC work', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapArenaConcurrently(
        [1, 2, 3, 4, 5],
        async (value) => {
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 2));
            active--;
            return value * 2;
        },
        2,
    );

    assert.deepEqual(result, [2, 4, 6, 8, 10]);
    assert.equal(peak, 2);
    await assert.rejects(() => mapArenaConcurrently([1], async () => 1, 0));
});
