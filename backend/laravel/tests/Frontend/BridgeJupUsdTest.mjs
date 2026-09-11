import assert from 'node:assert/strict';
import test from 'node:test';
import { tokenBySymbol } from '@/lib/bridgeTokens';
import { computeFee, isFeeBearing } from '@/lib/bridgeFee';

test('JupUSD signing uses the canonical SPL mint and existing Cyberia wrapper', () => {
    const token = tokenBySymbol('JupUSD');
    assert.equal(
        token.solanaMint,
        'JuprjznTrTSp2UFa3ZBUFgwdAmtZCq4MQCwysN55USD',
    );
    assert.equal(
        token.evmAddress,
        '0x03EB2fb8473C0370c8F6463efEE5f5Cf4EC011c7',
    );
    assert.equal(token.solanaTokenProgram, 'token');
    assert.equal(token.solanaDecimals, 6);
    assert.equal(token.evmDecimals, 6);
    assert.equal(token.model, 'mint');
});

test('JupUSD fee display matches server stablecoin fees', () => {
    const prices = { cyberSolUsd: null };
    assert.equal(isFeeBearing('JupUSD'), true);
    assert.deepEqual(computeFee('JupUSD', '5', prices), {
        feeUsd: 0.1,
        feeToken: 0.1,
        tokenPriceUsd: 1,
    });
    assert.equal(
        computeFee('JupUSD', '1000', prices, { flatUsd: 0.1, rateBps: 100 })
            .feeToken,
        10,
    );
});
