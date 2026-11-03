import test from 'node:test';
import assert from 'node:assert/strict';
import { trackExtensionOpen } from '../src/shared/analytics.js';

test('Firefox requires consent and sends only the installation ID', async () => {
    const calls = [];
    let allowed = false;
    globalThis.chrome = {
        runtime: { getBrowserInfo() {} },
        permissions: { getAll: async () => ({ data_collection: allowed ? ['technicalAndInteraction'] : [] }) },
        storage: { local: {
            get: async () => ({ analyticsClientId: '9ef1587a-d01b-4bd3-b876-b317b303debb' }),
            set: async () => {},
        } },
    };
    globalThis.fetch = async (...args) => calls.push(args);

    await trackExtensionOpen();
    assert.equal(calls.length, 0);
    allowed = true;
    await trackExtensionOpen();
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0][1].body), { client_id: '9ef1587a-d01b-4bd3-b876-b317b303debb' });
    assert.equal(calls[0][1].credentials, 'omit');
});
