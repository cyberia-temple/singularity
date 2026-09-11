import assert from 'node:assert/strict';
import test from 'node:test';
import {
    arenaMatchPath,
    arenaContractForLink,
    ARENA_LEGACY_CONTRACT,
    arenaShareUrl,
    parseArenaGameId,
} from '../../resources/js/lib/wallet/arenaLinks.ts';

test('Arena deep links accept only canonical positive integer ids', () => {
    assert.equal(parseArenaGameId('42'), 42n);

    for (const value of [null, '', '0', '-1', '1.5', '1x', ' 1']) {
        assert.equal(parseArenaGameId(value), null);
    }
});

test('versioned links preserve old matches and refuse arbitrary signing targets', () => {
    const current = '0x1111111111111111111111111111111111111111';
    assert.equal(
        arenaContractForLink(current, 1n, null),
        ARENA_LEGACY_CONTRACT,
    );
    assert.equal(arenaContractForLink(current, null, null), current);
    assert.equal(arenaContractForLink(current, 1n, current), current);
    assert.equal(
        arenaContractForLink(
            current,
            1n,
            '0x2222222222222222222222222222222222222222',
        ),
        null,
    );
    assert.match(arenaMatchPath(1n, current), /&contract=0x1111/);
    assert.throws(() => arenaMatchPath(1n, 'javascript:bad'));
});

test('Arena invitations stay on the wallet game surface', () => {
    assert.equal(arenaMatchPath(7n), '/wallet?screen=arena&game=7');
    assert.equal(
        arenaShareUrl('https://cyberia.church', 7n),
        'https://cyberia.church/wallet?screen=arena&game=7',
    );
    assert.throws(() => arenaMatchPath(0n));
});
