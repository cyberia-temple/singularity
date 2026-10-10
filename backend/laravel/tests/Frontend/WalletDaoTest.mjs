import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { compileScript, parse } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as vue from 'vue';

function mountDao(
    login = async (_address, sign) => {
        await sign('login challenge');
    },
    social = {},
) {
    const path = new URL(
        '../../resources/js/components/wallet/WalletDao.vue',
        import.meta.url,
    );
    const { descriptor } = parse(readFileSync(path, 'utf8'));
    const script = compileScript(descriptor, { id: 'wallet-dao-test' });
    const code = ts.transpileModule(script.content, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText;
    const calls = [];
    const form = vue.reactive({
        name: 'Test DAO',
        address: '0x1234',
        processing: false,
        reset() {
            this.name = '';
            this.address = '';
        },
        clearErrors() {},
        post(url, options) {
            calls.push({
                url,
                name: this.name,
                address: this.address,
                options,
            });
        },
    });
    const exports = {};
    runInNewContext(code, {
        exports,
        require(name) {
            if (name === 'vue') return vue;
            if (name === '@inertiajs/vue3') return { useForm: () => form };
            if (name === 'lucide-vue-next') return { ExternalLink: {} };
            if (name.includes('useLocale'))
                return {
                    useLocale: () => ({
                        t: (key) => key,
                        locale: vue.ref('en'),
                    }),
                };
            if (name.includes('/session')) return { signInWithWallet: login };
            if (name.includes('/social'))
                return {
                    fetchDao: async () => ({ daos: [], proposals: [] }),
                    fetchProposal: async (id) => ({ id, status: 'open' }),
                    fetchMyVote: async () => ({ address: null, vote: null }),
                    castVote: async () => ({ support: true, power: '1' }),
                    fetchComments: async () => [],
                    postComment: async () => 1,
                    tally: () => ({ for: 0, against: 0, cast: 0 }),
                    ...social,
                };
            if (name.includes('/format')) return {};
            if (name.includes('walletMessages')) return { walletMessages: {} };
            if (name === '@/routes/dao')
                return { store: { url: () => '/dao' } };
            throw new Error(`Unexpected import: ${name}`);
        },
    });
    const signatures = [];
    const wallet = {
        accounts: vue.ref([{ chain: 'cyberia', address: '0xwallet' }]),
        activeAccountId: vue.ref('primary'),
        activeAccount: vue.ref({ kind: 'seed' }),
        signMessage: async (chain, message) => {
            signatures.push({ chain, message });
            return 'signature';
        },
    };
    const renderer = vue.createRenderer({
        createComment: () => ({}),
        insert() {},
        remove() {},
        parentNode: () => null,
        nextSibling: () => null,
    });
    const app = renderer.createApp(
        { ...exports.default, render: () => null },
        { wallet },
    );
    const instance = app.mount({});
    return { state: instance.$.setupState, wallet, calls, signatures, app };
}

test('DAO registration signs the site login challenge before posting the form', async () => {
    const panel = mountDao();
    try {
        await panel.state.createDao();
        assert.deepEqual(panel.signatures, [
            { chain: 'cyberia', message: 'login challenge' },
        ]);
        assert.equal(panel.calls.length, 1);
        assert.equal(panel.calls[0].url, '/dao');
        assert.equal(panel.calls[0].name, 'Test DAO');
        assert.equal(panel.calls[0].address, '0x1234');
    } finally {
        panel.app.unmount();
    }
});

test('watch-only accounts cannot create a DAO', async () => {
    const panel = mountDao();
    try {
        panel.wallet.activeAccount.value = { kind: 'watch' };
        await panel.state.createDao();
        assert.equal(panel.signatures.length, 0);
        assert.equal(panel.calls.length, 0);
    } finally {
        panel.app.unmount();
    }
});

test('a failed login never registers a DAO', async () => {
    const panel = mountDao(async () => {
        throw new Error('Login failed');
    });
    try {
        await panel.state.createDao();
        assert.equal(panel.calls.length, 0);
        assert.match(panel.state.createError, /Login failed/);
        assert.equal(panel.state.signing, false);
    } finally {
        panel.app.unmount();
    }
});

test('switching account during login cannot register the previous account draft', async () => {
    let resume;
    const panel = mountDao(
        () =>
            new Promise((resolve) => {
                resume = resolve;
            }),
    );
    try {
        const pending = panel.state.createDao();
        panel.wallet.activeAccountId.value = 'another';
        resume();
        await pending;
        assert.equal(panel.calls.length, 0);
        assert.equal(panel.state.form.name, '');
    } finally {
        panel.app.unmount();
    }
});

const refused = (status) =>
    Object.assign(new Error(`refused ${status}`), { status });

test('a vote with a session already open is cast without signing anything', async () => {
    const votes = [];
    const panel = mountDao(undefined, {
        castVote: async (id, address, support) => {
            votes.push({ id, address, support });
            return { support, power: '42' };
        },
    });
    try {
        await panel.state.open({ id: 7, status: 'open' });
        await panel.state.vote(false);
        assert.deepEqual(votes, [
            { id: 7, address: '0xwallet', support: false },
        ]);
        assert.equal(panel.signatures.length, 0);
        assert.equal(panel.state.myVote.support, false);
        assert.equal(panel.state.pending, null);
    } finally {
        panel.app.unmount();
    }
});

for (const status of [401, 409, 419]) {
    test(`a ${status} signs in with the active key and votes once more`, async () => {
        let attempts = 0;
        const panel = mountDao(undefined, {
            castVote: async (_id, _address, support) => {
                attempts += 1;
                if (attempts === 1) throw refused(status);
                return { support, power: '1' };
            },
        });
        try {
            await panel.state.open({ id: 3, status: 'open' });
            await panel.state.vote(true);
            assert.equal(attempts, 2);
            assert.deepEqual(panel.signatures, [
                { chain: 'cyberia', message: 'login challenge' },
            ]);
            assert.equal(panel.state.myVote.support, true);
        } finally {
            panel.app.unmount();
        }
    });
}

test('any other refusal is shown and never turns into a login', async () => {
    const panel = mountDao(undefined, {
        castVote: async () => {
            throw refused(422);
        },
    });
    try {
        await panel.state.open({ id: 3, status: 'open' });
        await panel.state.vote(true);
        assert.equal(panel.signatures.length, 0);
        assert.match(panel.state.voteError, /refused 422/);
        assert.equal(panel.state.myVote, null);
    } finally {
        panel.app.unmount();
    }
});

test('a watch-only account cannot vote', async () => {
    let called = false;
    const panel = mountDao(undefined, {
        castVote: async () => {
            called = true;
            return { support: true, power: '1' };
        },
    });
    try {
        panel.wallet.activeAccount.value = { kind: 'watch' };
        await panel.state.open({ id: 3, status: 'open' });
        await panel.state.vote(true);
        assert.equal(called, false);
    } finally {
        panel.app.unmount();
    }
});

test('a vote read from a session for another key is not drawn as this one', async () => {
    const panel = mountDao(undefined, {
        fetchMyVote: async () => ({
            address: '0xsomebodyelse',
            vote: { support: true, power: '9' },
        }),
    });
    try {
        await panel.state.open({ id: 3, status: 'open' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(panel.state.myVote, null);
    } finally {
        panel.app.unmount();
    }
});

test('a proposal is published as the active key, with a deadline, and then opened', async () => {
    const created = [];
    let attempts = 0;
    const panel = mountDao(undefined, {
        fetchDao: async () => ({
            daos: [{ id: 4, name: 'Cyberia', address: null, proposals: 0 }],
            proposals: [],
        }),
        createProposal: async (proposal) => {
            attempts += 1;
            if (attempts === 1) throw refused(401);
            created.push(proposal);
            return 99;
        },
    });
    try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        panel.state.startProposal();
        panel.state.draft.title = '  Ship it  ';
        panel.state.draft.days = 3;
        const before = Date.now();
        await panel.state.publishProposal();
        assert.equal(created.length, 1);
        assert.equal(created[0].address, '0xwallet');
        assert.equal(created[0].daoId, 4);
        assert.equal(created[0].title, 'Ship it');
        const ends = Date.parse(created[0].endsAt) - before;
        assert.ok(
            ends >= 3 * 86_400_000 - 1000 && ends <= 3 * 86_400_000 + 5000,
        );
        assert.equal(panel.signatures.length, 1);
        assert.equal(panel.state.proposing, false);
        assert.equal(panel.state.detail.id, 99);
    } finally {
        panel.app.unmount();
    }
});

test('a watch-only account cannot publish a proposal', async () => {
    let called = false;
    const panel = mountDao(undefined, {
        fetchDao: async () => ({
            daos: [{ id: 4, name: 'Cyberia', address: null, proposals: 0 }],
            proposals: [],
        }),
        createProposal: async () => {
            called = true;
            return 1;
        },
    });
    try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        panel.wallet.activeAccount.value = { kind: 'watch' };
        panel.state.startProposal();
        panel.state.draft.title = 'Nope';
        await panel.state.publishProposal();
        assert.equal(called, false);
    } finally {
        panel.app.unmount();
    }
});
