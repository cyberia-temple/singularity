import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const landing = readFileSync(new URL('../../resources/views/landing/index.html', import.meta.url), 'utf8');
const script = landing.match(/<script>\s*\/\/ A returning wallet owner[\s\S]*?<\/script>/)[0]
    .replace(/^<script>|<\/script>$/g, '');

function destination({ vault = null, referrer = '', storageFails = false } = {}) {
    let target = null;
    runInNewContext(script, {
        URL,
        document: { referrer },
        location: { origin: 'https://cyberia.church', replace: (url) => { target = url; } },
        localStorage: { getItem: (key) => {
            assert.equal(key, 'cyberia.wallet.vault.v1');
            if (storageFails) throw new Error('Storage unavailable');
            return vault;
        } },
    });
    return target;
}

test('returning wallet owners arriving directly or from another site open the wallet', () => {
    assert.equal(destination({ vault: '{}' }), '/wallet');
    assert.equal(destination({ vault: '{}', referrer: 'https://example.com/' }), '/wallet');
});

test('the landing remains accessible without a vault or through a link from the wallet', () => {
    assert.equal(destination(), null);
    assert.equal(destination({ vault: '{}', referrer: 'https://cyberia.church/wallet' }), null);
    assert.equal(destination({ storageFails: true }), null);
});
