import assert from 'node:assert/strict';
import test from 'node:test';

import { consoleMessages } from '@/lib/consoleMessages';
import { arenaMessages } from '@/lib/arenaMessages';
import { downloadMessages } from '@/lib/downloadMessages';
import { progressMessages } from '@/lib/progressMessages';
import { trackerMessages } from '@/lib/trackerMessages';
import { walletMessages } from '@/lib/walletMessages';

/**
 * A missing key is invisible at runtime: `t()` falls through to English and the
 * screen keeps working, in the wrong language, for as long as nobody notices.
 * These tests are the only thing that notices.
 *
 * Placeholders get the same treatment. `{amount}` dropped from a translated
 * sentence does not throw — it silently stops naming the number, which on a
 * signing screen is the difference between a warning and a decoration.
 */

const DICTS = {
    arenaMessages,
    walletMessages,
    downloadMessages,
    progressMessages,
    trackerMessages,
    // Operator-facing and therefore en/ru only, but the failure mode is the
    // same one: a Russian console with an English cell in the middle of it.
    consoleMessages,
};

const placeholders = (message) =>
    [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test('English is complete in every dictionary', () => {
    for (const [name, dict] of Object.entries(DICTS)) {
        assert.ok(
            dict.en && Object.keys(dict.en).length > 0,
            `${name} has no English`,
        );
    }
});

test('every translation carries exactly the English key set', () => {
    for (const [name, dict] of Object.entries(DICTS)) {
        const english = Object.keys(dict.en).sort();

        for (const locale of Object.keys(dict)) {
            if (locale === 'en') {
                continue;
            }

            const translated = Object.keys(dict[locale]).sort();

            assert.deepEqual(
                translated.filter((key) => !english.includes(key)),
                [],
                `${name}.${locale} has keys English does not`,
            );

            assert.deepEqual(
                english.filter((key) => !translated.includes(key)),
                [],
                `${name}.${locale} is missing keys`,
            );
        }
    }
});

test('every translation keeps the placeholders of its English original', () => {
    for (const [name, dict] of Object.entries(DICTS)) {
        for (const locale of Object.keys(dict)) {
            if (locale === 'en') {
                continue;
            }

            for (const [key, message] of Object.entries(dict[locale])) {
                assert.deepEqual(
                    placeholders(message),
                    placeholders(dict.en[key] ?? ''),
                    `${name}.${locale}.${key} does not name the same values`,
                );
            }
        }
    }
});
