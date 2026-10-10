import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(
    new URL('../../public/sw.js', import.meta.url),
    'utf8',
);
const origin = 'https://cyberia.church';
const run = async (target, existing) => {
    const listeners = {},
        calls = [];
    const client = existing && {
        url: `${origin}${existing}`,
        focus: async () => calls.push('focus'),
        navigate: async (url) => {
            calls.push(['navigate', url]);
            return client;
        },
    };
    vm.runInNewContext(source, {
        URL,
        self: {
            location: { origin },
            addEventListener: (name, handler) => {
                listeners[name] = handler;
            },
            clients: {
                matchAll: async () => (client ? [client] : []),
                openWindow: async (url) => calls.push(['open', url]),
            },
        },
    });
    let completion;
    listeners.notificationclick({
        notification: { close() {}, data: { url: target } },
        waitUntil(promise) {
            completion = promise;
        },
    });
    await completion;
    return calls;
};

test('notification opens the requested wallet section in the existing window', async () => {
    assert.deepEqual(
        await run('/wallet?section=daily', '/wallet?section=portfolio'),
        [['navigate', `${origin}/wallet?section=daily`], 'focus'],
    );
});
test('an exact destination is focused without a reload', async () => {
    assert.deepEqual(
        await run('/wallet?section=daily', '/wallet?section=daily'),
        ['focus'],
    );
});
test('a notification fragment is preserved when the window changes', async () => {
    assert.deepEqual(await run('/feed#post-7', '/feed#post-2'), [
        ['navigate', `${origin}/feed#post-7`],
        'focus',
    ]);
});
test('without a suitable window the full destination opens', async () => {
    assert.deepEqual(await run('/wallet?section=daily', '/feed'), [
        ['open', `${origin}/wallet?section=daily`],
    ]);
});
test('an external or malformed target falls back to the site home', async () => {
    for (const target of [
        'https://other.example/wallet',
        'javascript:alert(1)',
        'https://[invalid',
    ]) {
        assert.deepEqual(await run(target, null), [['open', `${origin}/`]]);
    }
});
