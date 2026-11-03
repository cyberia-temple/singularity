import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';
import { knownChain, walletChains } from '@/lib/wallet';
import { accountBackupPhrase, accountDisplayName } from '@/lib/wallet/accounts';
import { encodeBase58 } from '@/lib/wallet/base58check';

test('backup follows the selected account and never substitutes the vault phrase', () => {
    const seed = { id: 'seed-0', kind: 'seed', index: 0, label: null };
    const imported = {
        id: 'imported',
        kind: 'phrase',
        phrase: 'imported backup',
        index: 0,
        label: null,
    };
    assert.equal(accountBackupPhrase('vault backup', seed), 'vault backup');
    assert.equal(
        accountBackupPhrase('vault backup', imported),
        'imported backup',
    );
    assert.equal(
        accountBackupPhrase('vault backup', { ...seed, index: 1 }),
        'vault backup',
    );

    for (const kind of ['key', 'watch']) {
        assert.throws(
            () =>
                accountBackupPhrase('vault backup', {
                    id: kind,
                    kind,
                    label: null,
                }),
            /no seed phrase/,
        );
    }

    assert.throws(
        () => accountBackupPhrase('vault backup', null),
        /no seed phrase/,
    );
});

test('a Solana key can be brought in while Solana is still switched off', () => {
    // A new wallet has only the core chains on — Cyberia and Cyberia 2.0 —
    // which is what the import screen used to offer, and a Phantom key pasted
    // onto Cyberia was refused as EVM.
    assert.deepEqual(
        walletChains().map((chain) => chain.id),
        ['cyberia', 'cyberia_fuji'],
    );

    const keypair = Keypair.generate();
    const solana = knownChain('solana');

    assert.equal(
        solana?.importKey?.(encodeBase58(keypair.secretKey)),
        keypair.publicKey.toBase58(),
    );
    assert.throws(() =>
        knownChain('cyberia').importKey(encodeBase58(keypair.secretKey)),
    );
    assert.equal(knownChain('no-such-network'), null);

    // Switched off again later, the account still has a name instead of taking
    // the accounts screen down with an unknown-chain throw.
    assert.equal(
        accountDisplayName(
            {
                id: 'key-solana',
                kind: 'key',
                chain: 'solana',
                secret: '',
                address: keypair.publicKey.toBase58(),
                label: null,
            },
            (key, params) => `${key}:${params?.chain}`,
        ),
        'accountKeyName:Solana',
    );
});
