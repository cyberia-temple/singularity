import assert from 'node:assert/strict';
import test from 'node:test';

import { classify, lookupUrl, omniboxTarget, suggestion } from '../src/background/lookup.js';
import { manifestFor } from '../manifest.mjs';
import { readFileSync } from 'node:fs';

/**
 * The right-click lookup and the `cy` keyword: a selection becomes one link on
 * Cyberia, and nothing else — an omnibox entry is never a way to open some
 * other site with the extension's name on it.
 */

test('a selection is read as what it looks like', () => {
    assert.equal(classify(' 0x2b79A071a75dd40f1aca68146d7978204eFD156A ').kind, 'address');
    assert.equal(classify(`0x${'ab'.repeat(32)}`).kind, 'tx');
    assert.equal(classify('#123456').value, '123456');
    assert.equal(classify('lain.cyber').kind, 'domain');
    assert.equal(classify('lain.com').kind, 'search');
});

test('every lookup opens on Cyberia', () => {
    assert.equal(lookupUrl(classify(`0x${'AB'.repeat(32)}`)), `https://explorer.cyberia.church/tx/0x${'ab'.repeat(32)}`);
    assert.equal(lookupUrl(classify('lain.cyber')), 'https://cyberia.church/wallet?section=domains&name=lain.cyber');
    assert.equal(lookupUrl(classify('<script>')), 'https://explorer.cyberia.church/search-results?q=%3Cscript%3E');
    assert.equal(omniboxTarget('https://evil.example/x'), 'https://explorer.cyberia.church/search-results?q=https%3A%2F%2Fevil.example%2Fx');
    assert.equal(omniboxTarget('https://explorer.cyberia.church/tx/0x1'), 'https://explorer.cyberia.church/tx/0x1');
    assert.match(suggestion('<b>').description, /&#60;b&#62;/);
});

test("the side panel is Chromium's and the sidebar Firefox's", () => {
    const base = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url)));
    assert.equal(base.side_panel.default_path, 'popup.html?panel=1');
    assert.ok(base.permissions.includes('sidePanel'));
    assert.equal(base.omnibox.keyword, 'cy');

    const gecko = manifestFor(base, 'firefox', '1.5.0');
    assert.equal(gecko.side_panel, undefined);
    assert.ok(!gecko.permissions.includes('sidePanel'));
    assert.equal(gecko.sidebar_action.default_panel, 'popup.html?panel=1');
});
