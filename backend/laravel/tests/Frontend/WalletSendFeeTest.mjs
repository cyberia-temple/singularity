import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileTemplate, parse } from '@vue/compiler-sfc';

const source = readFileSync(new URL('../../resources/js/components/wallet/WalletSend.vue', import.meta.url), 'utf8');

test('Cyberia uses the base fee for display and signing without a tier picker', () => {
    assert.match(source, /ref<WalletFeeTier>\(props\.chain === 'cyberia' \? 'slow' : 'normal'\)/);
    assert.match(source, /tier\.value = props\.chain === 'cyberia' \? 'slow' : 'normal'/);
    assert.match(source, /wallet\.send\(\s*props\.chain,\s*to\.value\.trim\(\),\s*amount\.value,\s*tier\.value/s);
    assert.match(source, /v-else-if="props\.chain === 'cyberia'"[\s\S]*?formatUnits\(fee, account\.decimals, 8\)[\s\S]*?<div v-else style="display: flex; gap: 8px">/);
    const { descriptor, errors } = parse(source);
    assert.equal(errors.length, 0);
    assert.equal(compileTemplate({ source: descriptor.template.content, filename: 'WalletSend.vue', id: 'send' }).errors.length, 0);
});
