import assert from 'node:assert/strict';
import test from 'node:test';
import { readArenaRulesFromContract } from '../../resources/js/lib/wallet/arena.ts';

const treasury = '0x1111111111111111111111111111111111111111';
test('the deployed legacy address needs no unsupported selector probe', async () => {
    const rules = await readArenaRulesFromContract({
        target: '0xd21edE559b49A6f6cDF57060456474D100D53e45',
        phaseDuration: async () => 300n,
    });
    assert.equal(rules.version, 1);
});
test('rules are read from the contract, including the treasury', async () => {
    const rules = await readArenaRulesFromContract({
        rulesVersion: async () => 2n,
        phaseDuration: async () => 600n,
        treasury: async () => treasury,
    });
    assert.deepEqual(rules, { version: 2, phaseDuration: 600, treasury });
});
test('only an empty EVM revert selects the legacy rules, never a failed RPC', async () => {
    const legacy = {
        rulesVersion: async () => {
            throw { code: 'CALL_EXCEPTION', data: '0x' };
        },
        phaseDuration: async () => 300n,
    };
    assert.equal((await readArenaRulesFromContract(legacy)).version, 1);
    for (const error of [
        { code: 'NETWORK_ERROR' },
        { code: 'CALL_EXCEPTION', data: null },
    ]) {
        await assert.rejects(
            readArenaRulesFromContract({
                ...legacy,
                rulesVersion: async () => {
                    throw error;
                },
            }),
        );
    }
});
test('unsupported rules and a wrong asynchronous timeout fail closed', async () => {
    await assert.rejects(
        readArenaRulesFromContract({ rulesVersion: async () => 3n }),
    );
    await assert.rejects(
        readArenaRulesFromContract({
            rulesVersion: async () => 2n,
            phaseDuration: async () => 300n,
        }),
    );
});
