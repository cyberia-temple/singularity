import assert from 'node:assert/strict';
import test from 'node:test';
import {
    arenaErrorCode,
    arenaTransactionUrl,
} from '../../resources/js/lib/wallet/arenaPresentation.ts';

test('Arena builds explorer links only from public web URLs and real hashes', () => {
    const hash = `0x${'ab'.repeat(32)}`;
    assert.equal(
        arenaTransactionUrl('https://explorer.cyberia.church', hash),
        `https://explorer.cyberia.church/tx/${hash}`,
    );
    assert.equal(arenaTransactionUrl('javascript:alert(1)', hash), null);
    assert.equal(
        arenaTransactionUrl('https://explorer.cyberia.church', '0x1234'),
        null,
    );
});

test('Arena errors become stable user-facing categories', () => {
    assert.equal(arenaErrorCode(new Error('user rejected action')), 'rejected');
    assert.equal(
        arenaErrorCode(new Error('insufficient funds')),
        'insufficientFunds',
    );
    assert.equal(arenaErrorCode(new Error('RPC network error')), 'rpc');
    assert.equal(arenaErrorCode(new Error('something new')), 'unknown');
});
