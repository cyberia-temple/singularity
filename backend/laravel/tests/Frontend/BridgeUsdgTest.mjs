import assert from 'node:assert/strict';
import test from 'node:test';
import { BRIDGE_TOKENS, tokenBySymbol } from '@/lib/bridgeTokens';
import { computeFee, isFeeBearing } from '@/lib/bridgeFee';

test('USDG Solana signing uses the canonical Token-2022 mint', () => {
    const token = tokenBySymbol('usdg');
    assert.equal(token, BRIDGE_TOKENS.USDG);
    assert.equal(
        token.solanaMint,
        '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
    );
    assert.equal(token.solanaTokenProgram, 'token-2022');
    assert.equal(token.solanaDecimals, 6);
    assert.equal(token.evmDecimals, 6);
    assert.equal(token.model, 'mint');
});

test('USDG fee display matches the stablecoin flat and percentage fees', () => {
    const prices = { cyberSolUsd: null };
    assert.equal(isFeeBearing('USDG'), true);
    assert.deepEqual(computeFee('USDG', '5', prices), {
        feeUsd: 0.1,
        feeToken: 0.1,
        tokenPriceUsd: 1,
    });
    assert.equal(
        computeFee('USDG', '1000', prices, { flatUsd: 0.1, rateBps: 100 })
            .feeToken,
        10,
    );
});
