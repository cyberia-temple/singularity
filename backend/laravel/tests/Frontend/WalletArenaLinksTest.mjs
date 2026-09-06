import assert from 'node:assert/strict';
import test from 'node:test';
import {
    arenaMatchPath,
    arenaShareUrl,
    parseArenaGameId,
} from '../../resources/js/lib/wallet/arenaLinks.ts';

test('Arena deep links accept only canonical positive integer ids', () => {
    assert.equal(parseArenaGameId('42'), 42n);

    for (const value of [null, '', '0', '-1', '1.5', '1x', ' 1']) {
        assert.equal(parseArenaGameId(value), null);
    }
});

test('Arena invitations stay on the wallet game surface', () => {
    assert.equal(arenaMatchPath(7n), '/wallet?screen=arena&game=7');
    assert.equal(
        arenaShareUrl('https://cyberia.church', 7n),
        'https://cyberia.church/wallet?screen=arena&game=7',
    );
    assert.throws(() => arenaMatchPath(0n));
});
