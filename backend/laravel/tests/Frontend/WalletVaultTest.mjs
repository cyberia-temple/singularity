import assert from 'node:assert/strict';
import test from 'node:test';
import {
    PRIMARY_ACCOUNT_ID,
    createMnemonic,
    forgetVault,
    hasVault,
    isValidMnemonic,
    normalizeMnemonic,
    openUnprotectedVault,
    openVault,
    protectVault,
    readVault,
    saveOpenVault,
    saveVault,
    unsealVault,
    vaultProtection,
} from '@/lib/wallet';

/**
 * The vault is the only place the seed phrase is ever at rest. What matters is
 * that it is unreadable without the password and that nothing else about the
 * wallet leaks into storage — everything the app persists is checked here.
 *
 * Since accounts arrived the vault seals a document rather than a bare phrase,
 * so the imported private key of a second account is protected by exactly the
 * same password as the seed. Vaults written before that still exist on real
 * devices, so reading one is pinned here too.
 *
 * A password can also be declined, and that is the other half of what is
 * checked here: an unprotected vault must say so in the record and must not
 * carry a single field that would let a screen go on calling it encrypted.
 */

const storage = () => {
    const store = new Map();

    return {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
        removeItem: (key) => void store.delete(key),
        dump: () =>
            [...store.entries()]
                .map(([key, value]) => `${key}${value}`)
                .join(''),
    };
};

test('a sealed phrase comes back with the right password only', async () => {
    const disk = storage();
    const phrase = createMnemonic();

    assert.equal(hasVault(disk), false);
    await saveVault(phrase, 'correct horse battery', disk);

    assert.equal(hasVault(disk), true);
    assert.equal(await openVault('correct horse battery', disk), phrase);
    await assert.rejects(
        () => openVault('correct horse batteries', disk),
        /Wrong wallet password/,
    );
});

test('nothing readable about the seed reaches storage', async () => {
    const disk = storage();
    const phrase = createMnemonic(24);

    await saveVault(phrase, 'a very long password', disk);

    const dump = disk.dump();

    for (const word of phrase.split(' ')) {
        assert.equal(dump.includes(` ${word} `), false);
    }

    assert.equal(dump.includes(phrase), false);

    const record = readVault(disk);

    assert.equal(record.version, 2);
    assert.equal(record.kdf, 'PBKDF2-SHA-256');
    assert.ok(record.iterations >= 200_000);
    // Salt and IV are unique per save, so two vaults never share a key.
    const other = storage();

    await saveVault(phrase, 'a very long password', other);
    assert.notEqual(readVault(other).salt, record.salt);
    assert.notEqual(readVault(other).ciphertext, record.ciphertext);
});

test('a fresh vault holds exactly one account, and it is the phrase', async () => {
    const disk = storage();
    const phrase = createMnemonic();

    const created = await saveVault(phrase, 'a very long password', disk);

    assert.deepEqual(created.accounts, [
        { id: PRIMARY_ACCOUNT_ID, kind: 'seed', index: 0, label: null },
    ]);
    assert.equal(created.activeId, PRIMARY_ACCOUNT_ID);
});

for (const protectedVault of [true, false]) {
    test(`Arena secrets survive resealing with backup metadata (password: ${protectedVault})`, async () => {
        const disk = storage();
        const phrase = createMnemonic();
        const password = 'arena test password';
        const created = protectedVault
            ? await saveVault(phrase, password, disk, false)
            : await saveOpenVault(phrase, disk, false);
        assert.deepEqual(created.arenaSecrets, []);
        const record = {
            contract: '0x1111111111111111111111111111111111111111',
            player: '0x2222222222222222222222222222222222222222',
            gameId: '7',
            move: 1,
            secret: `0x${'ab'.repeat(32)}`,
            createdAt: '2026-09-10T00:00:00Z',
        };
        await created.reseal({ ...created, arenaSecrets: [record] });
        const reopened = protectedVault
            ? await unsealVault(password, disk)
            : openUnprotectedVault(disk);
        assert.deepEqual(reopened.arenaSecrets, [record]);
        assert.equal(reopened.backedUp, false);
        assert.equal(disk.dump().includes(record.secret), !protectedVault);
        if (!protectedVault) {
            await protectVault(reopened, password, disk);
            assert.deepEqual((await unsealVault(password, disk)).arenaSecrets, [
                record,
            ]);
            assert.equal(disk.dump().includes(record.secret), false);
        }
    });
}

test('an imported key is sealed under the same password as the seed', async () => {
    const disk = storage();
    const phrase = createMnemonic();
    const secret =
        '0x4c0883a69102937d6231471b5dbb6204fe512961708279c1b1a1a1a1a1a1a1a1';

    const created = await saveVault(phrase, 'a very long password', disk);

    await created.reseal({
        phrase,
        activeId: 'key-cyberia-0xabc',
        accounts: [
            ...created.accounts,
            {
                id: 'key-cyberia-0xabc',
                kind: 'key',
                chain: 'cyberia',
                secret,
                address: '0xABC',
                label: 'Airdrop hunter',
            },
        ],
    });

    // The whole point: a live private key must be no more readable at rest
    // than the phrase is.
    assert.equal(disk.dump().includes(secret), false);
    assert.equal(disk.dump().includes('Airdrop hunter'), false);

    const reopened = await unsealVault('a very long password', disk);

    assert.equal(reopened.accounts.length, 2);
    assert.equal(reopened.accounts[1].secret, secret);
    assert.equal(reopened.activeId, 'key-cyberia-0xabc');
    assert.equal(reopened.phrase, phrase);
});

test('resealing keeps the key but never the nonce', async () => {
    const disk = storage();
    const phrase = createMnemonic();

    const created = await saveVault(phrase, 'a very long password', disk);
    const first = readVault(disk);

    await created.reseal({ ...created, activeId: PRIMARY_ACCOUNT_ID });

    const second = readVault(disk);

    // Same password, so the same salt and the same derived key — but reusing
    // an IV under one AES-GCM key is the single mistake that breaks it.
    assert.equal(second.salt, first.salt);
    assert.notEqual(second.iv, first.iv);
    assert.equal(
        (await unsealVault('a very long password', disk)).phrase,
        phrase,
    );
});

/**
 * A vault as the wallet wrote it before accounts existed: the same AES-GCM
 * envelope, but with the bare phrase as its plaintext. Built by hand here
 * rather than checked in as a fixture so it stays honest about the KDF
 * parameters the shipped code actually used.
 */
const legacyVault = async (phrase, password, disk) => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const iterations = 310_000;
    const material = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveKey'],
    );
    const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            new TextEncoder().encode(phrase),
        ),
    );
    const base64 = (bytes) => btoa(String.fromCharCode(...bytes));

    disk.setItem(
        'cyberia.wallet.vault.v1',
        JSON.stringify({
            version: 1,
            kdf: 'PBKDF2-SHA-256',
            iterations,
            salt: base64(salt),
            iv: base64(iv),
            ciphertext: base64(ciphertext),
            createdAt: new Date().toISOString(),
        }),
    );
};

test('a vault written before accounts still opens', async () => {
    const disk = storage();
    const phrase = createMnemonic();

    await legacyVault(phrase, 'a very long password', disk);

    const opened = await unsealVault('a very long password', disk);

    assert.equal(opened.phrase, phrase);
    assert.equal(opened.activeId, PRIMARY_ACCOUNT_ID);
    assert.deepEqual(opened.accounts, [
        { id: PRIMARY_ACCOUNT_ID, kind: 'seed', index: 0, label: null },
    ]);
    // Nothing is migrated eagerly: an old vault that is only read stays as it
    // was, and only becomes a v2 record once something is actually written.
    assert.equal(readVault(disk).version, 1);

    await opened.reseal({ ...opened, accounts: opened.accounts });

    assert.equal(readVault(disk).version, 2);
    assert.equal(await openVault('a very long password', disk), phrase);
});

test('a weak password or a bad phrase is refused before anything is stored', async () => {
    const disk = storage();

    await assert.rejects(
        () => saveVault(createMnemonic(), 'short', disk),
        /at least 8 characters/,
    );
    await assert.rejects(
        () => saveVault('not a real seed phrase at all', 'long enough', disk),
        /valid BIP-39/,
    );
    assert.equal(hasVault(disk), false);
});

test('phrases are normalised the way BIP-39 expects', () => {
    const phrase = createMnemonic();

    assert.equal(normalizeMnemonic(`  ${phrase.toUpperCase()}  `), phrase);
    assert.equal(isValidMnemonic(`  ${phrase.toUpperCase()}\n`), true);
    assert.equal(isValidMnemonic('abandon abandon abandon'), false);
});

test('forgetting a wallet leaves nothing behind', async () => {
    const disk = storage();

    await saveVault(createMnemonic(), 'a very long password', disk);
    forgetVault(disk);

    assert.equal(hasVault(disk), false);
    assert.equal(readVault(disk), null);
    assert.equal(disk.dump(), '');
});

/* --------------------------------------------------- declining a password -- */

test('a vault with no password says so, and claims no encryption at all', async () => {
    const disk = storage();
    const phrase = createMnemonic();

    await saveOpenVault(phrase, disk);

    assert.equal(vaultProtection(disk), 'none');

    const record = readVault(disk);

    assert.equal(record.protection, 'none');
    // Nothing that could be mistaken for a sealed vault: no key derivation, no
    // salt, no IV, and above all no "ciphertext" holding plaintext.
    assert.equal(record.kdf, undefined);
    assert.equal(record.salt, undefined);
    assert.equal(record.iv, undefined);
    assert.equal(record.ciphertext, undefined);
    assert.equal(record.contents.phrase, phrase);
});

test('an unprotected vault opens with no password and refuses one', async () => {
    const disk = storage();
    const phrase = createMnemonic();

    await saveOpenVault(phrase, disk);

    assert.equal(openUnprotectedVault(disk).phrase, phrase);
    // Asking for a password here is a caller's mistake, and saying "wrong
    // password" would send somebody looking for one they never set.
    await assert.rejects(
        () => unsealVault('anything at all', disk),
        /no password/,
    );
});

test('a sealed vault is never opened as an unprotected one', async () => {
    const disk = storage();

    await saveVault(createMnemonic(), 'a very long password', disk);

    assert.equal(vaultProtection(disk), 'password');
    assert.throws(() => openUnprotectedVault(disk), /protected by a password/);
});

test('adding a password later keeps every account and the phrase', async () => {
    const disk = storage();
    const phrase = createMnemonic();

    const open = await saveOpenVault(phrase, disk);
    const accounts = [
        ...open.accounts,
        {
            id: 'imported-1',
            kind: 'key',
            chain: 'cyberia',
            label: 'Cold key',
            index: 0,
            key: '0x'.padEnd(66, '7'),
        },
    ];

    await open.reseal({ ...open, accounts, activeId: 'imported-1' });

    const nowOpen = openUnprotectedVault(disk);

    assert.equal(nowOpen.accounts.length, accounts.length);

    await protectVault(
        {
            phrase: nowOpen.phrase,
            accounts: nowOpen.accounts,
            activeId: nowOpen.activeId,
            backedUp: nowOpen.backedUp,
        },
        'a very long password',
        disk,
    );

    assert.equal(vaultProtection(disk), 'password');
    // The whole point of the upgrade: nobody has to choose between protecting
    // the wallet and keeping what is in it.
    const sealed = await unsealVault('a very long password', disk);

    assert.equal(sealed.phrase, phrase);
    assert.equal(sealed.accounts.length, accounts.length);
    assert.equal(sealed.activeId, 'imported-1');
    // And the imported key is no longer readable in storage.
    assert.equal(disk.dump().includes('imported-1'), false);
    assert.equal(disk.dump().includes(phrase.split(' ')[0]), false);
});

test('a skipped backup is remembered, and an old vault counts as backed up', async () => {
    const skipped = storage();
    const kept = storage();
    const legacy = storage();

    await saveOpenVault(createMnemonic(), skipped, false);
    await saveVault(createMnemonic(), 'a very long password', kept, true);

    assert.equal(openUnprotectedVault(skipped).backedUp, false);
    assert.equal(
        (await unsealVault('a very long password', kept)).backedUp,
        true,
    );

    // A vault written before the flag existed has no field, and everyone who
    // has one passed the check that was mandatory at the time.
    await saveOpenVault(createMnemonic(), legacy);
    const record = JSON.parse(legacy.getItem('cyberia.wallet.vault.v1'));
    delete record.contents.backedUp;
    legacy.setItem('cyberia.wallet.vault.v1', JSON.stringify(record));

    assert.equal(openUnprotectedVault(legacy).backedUp, true);
});
