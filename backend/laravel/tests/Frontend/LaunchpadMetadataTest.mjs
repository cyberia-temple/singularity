import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { compileScript, parse } from '@vue/compiler-sfc';
import * as ethers from 'ethers';
import ts from 'typescript';
import * as vue from 'vue';
import * as launchpadChains from '@/lib/launchpadChains';
import {
    launchpadWebsiteError,
    uploadLaunchpadMetadata,
} from '@/lib/launchpadMetadata';

// Run the actual form handlers with background reads disabled. Reaching the
// wallet is an observable failure when the metadata already cannot be saved.
function launchpadForm() {
    const path = new URL(
        '../../resources/js/pages/Launchpad.vue',
        import.meta.url,
    );
    const { descriptor } = parse(readFileSync(path, 'utf8'));
    const script = compileScript(descriptor, { id: 'launchpad-metadata-test' });
    const code = ts.transpileModule(script.content, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText;
    let walletCalls = 0;
    const exports = {};
    runInNewContext(code, {
        exports,
        URL,
        FormData,
        require(name) {
            if (name === 'vue') {
return { ...vue, onMounted() {}, watch() {} };
}

            if (name === 'ethers') {
return { ...ethers, JsonRpcProvider: class {} };
}

            if (name === '@/lib/launchpadChains') {
return launchpadChains;
}

            if (name === '@/lib/launchpadMetadata') {
return { launchpadWebsiteError, uploadLaunchpadMetadata };
}

            if (name === '@/composables/useWallet') {
return {
                    useWallet: () => ({
                        isConnected: vue.ref(true),
                        address: vue.ref('0xcreator'),
                    }),
                };
}

            if (name === '@/lib/evmChains') {
return {
                    ensureEvmNetwork: async () => {
                        walletCalls++;

                        throw new Error('Wallet reached');
                    },
                };
}

            if (
                name === '@inertiajs/vue3' ||
                name === 'lucide-vue-next' ||
                name.startsWith('@/components/') ||
                name === '@/lib/dexFormat' ||
                name === '@/lib/wallet/launchpad'
            ) {
return {};
}

            throw new Error(`Unexpected import: ${name}`);
        },
    });

    return {
        state: exports.default.setup({}, { expose() {} }),
        walletCalls: () => walletCalls,
    };
}

test('invalid Website blocks launch before any transaction or signature', async () => {
    const panel = launchpadForm();
    panel.state.name.value = 'VPN';
    panel.state.symbol.value = 'VPN';
    assert.equal(panel.state.canLaunch.value, true);
    panel.state.websiteUrl.value = 'file:///home/creator/cvpn.html';
    assert.equal(panel.state.canLaunch.value, false);
    await panel.state.handleLaunch();
    assert.equal(panel.walletCalls(), 0);
    assert.match(panel.state.error.value, /leave Website empty.*HTML page/);
    assert.equal(panel.state.busy.value, false);
});

test('invalid Website blocks editing before the metadata signature', async () => {
    const panel = launchpadForm();
    panel.state.editWebsiteUrl.value = 'file:///home/creator/cvpn.html';
    await panel.state.saveEditor({ token: '0xtoken', chainId: 49406 });
    assert.equal(panel.walletCalls(), 0);
    assert.match(panel.state.editError.value, /leave Website empty.*HTML page/);
    assert.equal(panel.state.editBusy.value, false);
});

test('a new subdomain requires an HTML page before signing', async () => {
    const panel = launchpadForm();
    panel.state.editSiteSubdomain.value = 'vpn';
    await panel.state.saveEditor({
        token: '0xtoken',
        chainId: 49406,
        siteUrl: null,
    });
    assert.equal(panel.walletCalls(), 0);
    assert.match(panel.state.editError.value, /Select the HTML page/);
});

test('an existing site can be edited without uploading its HTML again', async () => {
    const panel = launchpadForm();
    panel.state.editSiteSubdomain.value = 'vpn';
    await panel.state.saveEditor({
        token: '0xtoken',
        chainId: 49406,
        siteUrl: 'https://vpn.cyberia.church/',
    });
    assert.equal(panel.walletCalls(), 1);
    assert.equal(panel.state.editError.value, 'Wallet reached');
});

test('a website is optional when publishing an HTML page', () => {
    for (const value of [
        '',
        '   ',
        'http://cyberia.church',
        ' https://cyberia.church/vpn ',
    ]) {
        assert.equal(launchpadWebsiteError(value), null);
    }
});

test('local files and invalid links explain how to upload the page', () => {
    for (const value of [
        'file:///home/CH4rnel_exe/Projects/CyberiaVPN/docs/launchpad/cvpn.html',
        '/home/creator/cvpn.html',
        'C:\\Projects\\cvpn.html',
        'javascript:alert(1)',
        'ftp://example.com/cvpn.html',
        'https://',
        'not a URL',
    ]) {
        assert.match(launchpadWebsiteError(value), /http:\/\/ or https:\/\//);
        assert.match(
            launchpadWebsiteError(value),
            /leave Website empty.*HTML page/,
        );
    }
});

test('uploads selected HTML and a blank website as multipart data', async (t) => {
    const form = new FormData();
    form.append('website', '');
    form.append(
        'html',
        new File(['<h1>VPN</h1>'], 'cvpn.html', { type: 'text/html' }),
    );
    form.append('site_subdomain', 'vpn');
    let sent = false;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        sent = true;
        assert.equal(url, '/api/launchpad/tokens');
        assert.equal(options.method, 'POST');
        assert.equal(options.headers.Accept, 'application/json');
        assert.equal(options.headers['Content-Type'], undefined);
        assert.equal(options.body, form);
        assert.equal(options.body.get('website'), '');
        assert.equal(options.body.get('html').name, 'cvpn.html');
        assert.equal(await options.body.get('html').text(), '<h1>VPN</h1>');

        return new Response('{}');
    });

    await uploadLaunchpadMetadata(form);
    assert.equal(sent, true);
});

for (const [label, reply, message] of [
    [
        'field validation',
        {
            message: 'The given data was invalid.',
            errors: { website: ['Choose the file under HTML page.'] },
        },
        'Choose the file under HTML page.',
    ],
    [
        'signature validation',
        { message: 'Only the token creator can edit this metadata.' },
        'Only the token creator can edit this metadata.',
    ],
    ['empty response', {}, 'Metadata upload failed (HTTP 422).'],
]) {
    test(`shows readable ${label} instead of raw JSON`, async (t) => {
        t.mock.method(
            globalThis,
            'fetch',
            async () => new Response(JSON.stringify(reply), { status: 422 }),
        );
        await assert.rejects(uploadLaunchpadMetadata(new FormData()), {
            message,
        });
    });
}

test('a proxy HTML error uses a readable fallback', async (t) => {
    t.mock.method(
        globalThis,
        'fetch',
        async () => new Response('<html>Bad gateway</html>', { status: 502 }),
    );
    await assert.rejects(uploadLaunchpadMetadata(new FormData()), {
        message: 'Metadata upload failed (HTTP 502).',
    });
});
