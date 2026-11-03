import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';

// Exercise the component's actual setup with a virtual clock and a tiny Vue
// renderer; no DOM, real secrets, browser storage or network is involved.
function mountSecurity(reveal = async () => 'test backup') {
    const path = new URL(
        '../../resources/js/components/wallet/WalletSecurity.vue',
        import.meta.url,
    );
    const { descriptor } = parse(readFileSync(path, 'utf8'));
    const script = compileScript(descriptor, { id: 'wallet-security-test' });
    const code = ts.transpileModule(script.content, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText;
    const timers = new Map();
    let timerId = 0;
    const exports = {};
    const clipboard = { copy() {}, copied: vue.ref(null) };
    runInNewContext(code, {
        exports,
        require(name) {
            if (name === 'vue') {
return vue;
}

            if (name.includes('NetworkMark')) {
return { default: {} };
}

            if (name.includes('useLocale')) {
return { useLocale: () => ({ t: (key) => key }) };
}

            if (name.includes('useSecureClipboard')) {
return {
                    useSecureClipboard: () => clipboard,
                    clipboardAutoClear: vue.ref(false),
                };
}

            if (name.includes('analytics')) {
return {
                    analytics: {
                        enabled: () => false,
                        blockedByBrowser: () => false,
                    },
                };
}

            if (name.includes('walletMessages')) {
return { walletMessages: {} };
}

            if (name.includes('sessionReplay')) {
return { setReplayEnabled() {} };
}

            throw new Error(`Unexpected import: ${name}`);
        },
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, delay });

            return id;
        },
        clearTimeout(id) {
            timers.delete(id);
        },
    });
    const records = [
        { id: 'primary', kind: 'seed' },
        { id: 'imported', kind: 'phrase' },
        { id: 'watched', kind: 'watch' },
    ];
    const wallet = {
        accountRecords: vue.ref(records),
        activeAccountId: vue.ref('primary'),
        protection: vue.ref('none'),
        accounts: vue.ref([]),
        reveal,
        markBackedUp: async () => {},
    };
    wallet.activeAccount = vue.computed(() =>
        records.find((record) => record.id === wallet.activeAccountId.value),
    );
    const renderer = vue.createRenderer({
        createComment: () => ({}),
        insert() {},
        remove() {},
        parentNode: () => null,
        nextSibling: () => null,
    });
    const component = { ...exports.default, render: () => null };
    const app = renderer.createApp(component, { wallet });
    const instance = app.mount({});

    return {
        state: instance.$.setupState,
        wallet,
        app,
        timers,
        fire() {
            const entry = timers.entries().next().value;
            assert.ok(entry);
            const [id, timer] = entry;
            assert.equal(timer.delay, 800);
            timers.delete(id);
            timer.callback();
        },
    };
}

test('a short press reveals nothing; a full hold reveals the backup', async () => {
    let calls = 0;
    const panel = mountSecurity(async () => {
        calls++;

        return 'test backup';
    });

    try {
        assert.equal(panel.state.phrase, null);
        panel.state.startHold();
        assert.equal(calls, 0);
        panel.state.cancelHold();
        assert.equal(panel.timers.size, 0);
        assert.equal(calls, 0);
        panel.state.startHold();
        panel.fire();
        await new Promise(setImmediate);
        await vue.nextTick();
        assert.equal(calls, 1);
        assert.equal(panel.state.phrase, 'test backup');
        panel.wallet.activeAccountId.value = 'imported';
        assert.equal(panel.state.phrase, null);
        panel.wallet.activeAccountId.value = 'watched';
        assert.equal(panel.state.hasPhrase, false);
    } finally {
        panel.app.unmount();
    }
});

test('switching or leaving cancels a hold and drops a pending reveal', async () => {
    let resolve;
    const panel = mountSecurity(
        () =>
            new Promise((done) => {
                resolve = done;
            }),
    );

    try {
        panel.state.startHold();
        panel.wallet.activeAccountId.value = 'imported';
        assert.equal(panel.timers.size, 0);
        panel.state.startHold();
        panel.fire();
        panel.wallet.activeAccountId.value = 'primary';
        resolve('old account backup');
        await new Promise(setImmediate);
        await vue.nextTick();
        assert.equal(panel.state.phrase, null);
        panel.state.startHold();
    } finally {
        panel.app.unmount();
    }

    assert.equal(panel.timers.size, 0);
});

test('a protected vault still requires its password before a hold', () => {
    const panel = mountSecurity();

    try {
        panel.wallet.protection.value = 'password';
        panel.state.startHold();
        assert.equal(panel.timers.size, 0);
        panel.state.password = 'test password';
        panel.state.startHold();
        assert.equal(panel.timers.size, 1);
    } finally {
        panel.app.unmount();
    }
});
