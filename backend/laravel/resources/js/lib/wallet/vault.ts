import { Mnemonic, getBytes, randomBytes } from 'ethers';
import {
    PRIMARY_ACCOUNT_ID,
    defaultAccountRecords,
} from '@/lib/wallet/accounts';
import type { WalletAccountRecord } from '@/lib/wallet/accounts';

/**
 * On-device storage for everything this device knows about the wallet.
 *
 * The wallet is non-custodial in the strict sense: the phrase is generated in
 * the browser and kept in this device's localStorage. It is never sent to
 * Laravel, never put in an Inertia prop, never written to a log, and never
 * rendered except in the deliberate backup flow. Losing the phrase and the
 * password means losing the funds — that is the trade for custody.
 *
 * **Two kinds of vault, and the difference is not hidden anywhere.** A
 * password-protected vault is AES-256-GCM under a PBKDF2-SHA-256 key and is
 * what this file was written for. An *unprotected* vault holds the same
 * document in the clear, because a password was declined — that is a real
 * choice a person is allowed to make, and the only dishonest way to build it
 * would be to encrypt under a key stored beside the ciphertext and let the UI
 * go on saying "encrypted". So the record says `protection: 'none'`, carries
 * no `kdf`, no salt and no ciphertext, and every screen that mentions the
 * vault says which of the two this device has.
 *
 * The account list is sealed alongside the phrase rather than kept beside it.
 * An imported account carries a live private key, so it has no business in
 * plaintext storage; and even a watch-only row is a statement about which
 * addresses this person cares about, which is exactly the kind of thing a
 * locked vault should not still be saying out loud.
 *
 * For the sealed kind: AES-256-GCM over a PBKDF2-SHA-256 key; the tag makes a
 * wrong password fail loudly instead of yielding garbage that would derive
 * plausible addresses.
 */

const STORAGE_KEY = 'cyberia.wallet.vault.v1';

const PBKDF2_ITERATIONS = 310_000;

/** A vault sealed with a password. Absent `protection` means this kind. */
export type SealedVaultRecord = {
    /** 1 sealed a bare phrase; 2 seals the JSON document below. */
    version: 1 | 2;
    protection?: 'password';
    kdf: 'PBKDF2-SHA-256';
    iterations: number;
    salt: string;
    iv: string;
    ciphertext: string;
    createdAt: string;
};

/**
 * A vault with no password, holding the same document in the clear.
 *
 * There is no ciphertext field to mistake for one, and nothing here is
 * obfuscated: obfuscation would only make the record harder for its owner to
 * read while costing an attacker who already has the device nothing at all.
 */
export type OpenVaultRecord = {
    version: 2;
    protection: 'none';
    contents: VaultContents;
    createdAt: string;
};

export type VaultRecord = SealedVaultRecord | OpenVaultRecord;

export type VaultProtection = 'password' | 'none';

/** Everything the vault holds, once it is open. */
export type VaultContents = {
    phrase: string;
    accounts: WalletAccountRecord[];
    /** Which account the app is currently acting as. */
    activeId: string;
    /** Unrevealed Arena moves; protected according to this vault's storage mode. */
    arenaSecrets: ArenaSecretRecord[];
    /**
     * Whether the phrase has been written down somewhere off this device.
     *
     * Absent means yes: every vault made before the backup check could be
     * skipped had passed it. Only a vault whose owner declined the check
     * carries `false`, and it is what the Security screen warns about until
     * the phrase has actually been copied out.
     */
    backedUp?: boolean;
};

export type ArenaSecretRecord = {
    contract: string;
    gameId: string;
    player: string;
    move: 1 | 2 | 3;
    secret: string;
    createdAt: string;
};

/**
 * An unsealed vault, plus the means to write it back.
 *
 * `reseal` closes over the AES key that opening it produced, so adding an
 * account does not ask for the password a second time. The key is
 * non-extractable and dies with the tab; nothing here keeps the password.
 */
export type OpenedVault = VaultContents & {
    reseal: (next: VaultContents) => Promise<void>;
};

export type VaultStorage = {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
};

const memoryStorage = (): VaultStorage => {
    const store = new Map<string, string>();

    return {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => void store.set(key, value),
        removeItem: (key) => void store.delete(key),
    };
};

const fallbackStorage = memoryStorage();

/** localStorage in the browser; an in-memory stand-in during SSR and tests. */
export const defaultStorage = (): VaultStorage =>
    typeof localStorage !== 'undefined' ? localStorage : fallbackStorage;

const toBase64 = (bytes: Uint8Array): string =>
    btoa(String.fromCharCode(...bytes));

const fromBase64 = (value: string): Uint8Array<ArrayBuffer> =>
    Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

const deriveKey = async (
    password: string,
    salt: Uint8Array<ArrayBuffer>,
    iterations: number,
): Promise<CryptoKey> => {
    const material = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveKey'],
    );

    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
};

/** A fresh 12- or 24-word BIP-39 phrase from the platform CSPRNG. */
export const createMnemonic = (words: 12 | 24 = 12): string =>
    Mnemonic.fromEntropy(randomBytes(words === 24 ? 32 : 16)).phrase;

export const normalizeMnemonic = (phrase: string): string =>
    phrase.trim().toLowerCase().split(/\s+/).join(' ');

export const isValidMnemonic = (phrase: string): boolean =>
    Mnemonic.isValidMnemonic(normalizeMnemonic(phrase));

/**
 * BIP-39 seed for a phrase — the single root every chain adapter derives
 * from. No BIP-39 passphrase (25th word): one secret to back up, and the
 * vault password already protects the phrase on this device.
 */
export const seedFromMnemonic = (phrase: string): Uint8Array =>
    getBytes(Mnemonic.fromPhrase(normalizeMnemonic(phrase)).computeSeed());

export const hasVault = (storage: VaultStorage = defaultStorage()): boolean =>
    storage.getItem(STORAGE_KEY) !== null;

/**
 * Which kind of vault this device has, or null when it has none.
 *
 * Read from the record rather than remembered: a screen that asks "is there a
 * password on this" must be answering from what is actually stored, not from
 * what the app believed when it started.
 */
export const vaultProtection = (
    storage: VaultStorage = defaultStorage(),
): VaultProtection | null => {
    const record = readVault(storage);

    if (!record) {
        return null;
    }

    return record.protection === 'none' ? 'none' : 'password';
};

export const readVault = (
    storage: VaultStorage = defaultStorage(),
): VaultRecord | null => {
    const raw = storage.getItem(STORAGE_KEY);

    if (!raw) {
        return null;
    }

    try {
        return JSON.parse(raw) as VaultRecord;
    } catch {
        return null;
    }
};

/**
 * Seal one document under a key that is already derived.
 *
 * A fresh IV every time, because AES-GCM reusing one under the same key is the
 * single mistake that breaks it — and this runs on every account change, not
 * only at setup.
 */
const seal = async (
    contents: VaultContents,
    key: CryptoKey,
    salt: Uint8Array,
    iterations: number,
    storage: VaultStorage,
): Promise<VaultRecord> => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            key,
            new TextEncoder().encode(JSON.stringify(contents)),
        ),
    );

    const record: VaultRecord = {
        version: 2,
        kdf: 'PBKDF2-SHA-256',
        iterations,
        salt: toBase64(salt),
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
        createdAt: new Date().toISOString(),
    };

    storage.setItem(STORAGE_KEY, JSON.stringify(record));

    return record;
};

/** Write the document with no password over it, and say so in the record. */
const write = (contents: VaultContents, storage: VaultStorage): void => {
    const record: OpenVaultRecord = {
        version: 2,
        protection: 'none',
        contents,
        createdAt: new Date().toISOString(),
    };

    storage.setItem(STORAGE_KEY, JSON.stringify(record));
};

/** The document a brand-new vault starts with, whichever kind it is. */
const freshContents = (phrase: string, backedUp: boolean): VaultContents => ({
    phrase,
    accounts: defaultAccountRecords(),
    activeId: PRIMARY_ACCOUNT_ID,
    backedUp,
    arenaSecrets: [],
});

const validPhrase = (phrase: string): string => {
    const normalized = normalizeMnemonic(phrase);

    if (!Mnemonic.isValidMnemonic(normalized)) {
        throw new Error('Not a valid BIP-39 seed phrase');
    }

    return normalized;
};

/**
 * Create this device's vault around a phrase, and hand back the means to keep
 * writing to it. Both onboarding paths land here — a phrase this device
 * generated and one the user typed in are the same thing by now.
 *
 * `backedUp` is the last argument rather than the third so that every existing
 * caller keeps working, and it defaults to `true` because that is what a vault
 * made before the check could be skipped always was.
 */
export const saveVault = async (
    phrase: string,
    password: string,
    storage: VaultStorage = defaultStorage(),
    backedUp = true,
): Promise<OpenedVault> => {
    const normalized = validPhrase(phrase);

    if (password.length < 8) {
        throw new Error('Wallet password must be at least 8 characters');
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
    const contents = freshContents(normalized, backedUp);

    await seal(contents, key, salt, PBKDF2_ITERATIONS, storage);

    return {
        ...contents,
        reseal: (next) =>
            seal(next, key, salt, PBKDF2_ITERATIONS, storage).then(() => {}),
    };
};

/**
 * Create a vault with no password on it.
 *
 * Deliberately a separate function from `saveVault` rather than a `null`
 * password it would accept: storing a seed phrase in the clear is a decision,
 * and a decision must not be reachable by an argument that arrived undefined.
 *
 * Nothing about the phrase changes — the same words, the same accounts, the
 * same derivation. What changes is who can read it: anybody with this browser
 * profile, and any script that gets to run on this origin.
 */
export const saveOpenVault = async (
    phrase: string,
    storage: VaultStorage = defaultStorage(),
    backedUp = true,
): Promise<OpenedVault> => {
    const contents = freshContents(validPhrase(phrase), backedUp);

    write(contents, storage);

    return {
        ...contents,
        reseal: async (next) => write(next, storage),
    };
};

/**
 * Put a password on a vault that had none, keeping everything inside it.
 *
 * The accounts travel across unchanged, which is the whole point: somebody who
 * skipped the password at the start and imported three keys since must not
 * have to choose between protecting them and keeping them.
 */
export const protectVault = async (
    contents: VaultContents,
    password: string,
    storage: VaultStorage = defaultStorage(),
): Promise<OpenedVault> => {
    if (password.length < 8) {
        throw new Error('Wallet password must be at least 8 characters');
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);

    await seal(contents, key, salt, PBKDF2_ITERATIONS, storage);

    return {
        ...contents,
        reseal: (next) =>
            seal(next, key, salt, PBKDF2_ITERATIONS, storage).then(() => {}),
    };
};

/**
 * The decrypted plaintext as a document, whichever era wrote it.
 *
 * The shape is decided by what parses rather than by the record's version
 * field: a BIP-39 phrase never parses as a JSON object, so this cannot
 * misread one for the other even if a version were ever written wrongly.
 */
const readContents = (plaintext: string): VaultContents => {
    const legacy: VaultContents = {
        phrase: plaintext,
        accounts: defaultAccountRecords(),
        activeId: PRIMARY_ACCOUNT_ID,
        arenaSecrets: [],
    };

    let parsed: unknown;

    try {
        parsed = JSON.parse(plaintext);
    } catch {
        return legacy;
    }

    if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof (parsed as VaultContents).phrase !== 'string'
    ) {
        return legacy;
    }

    const contents = parsed as VaultContents;
    const accounts = Array.isArray(contents.accounts)
        ? contents.accounts
        : defaultAccountRecords();

    return {
        phrase: contents.phrase,
        // The primary account is not optional: it is the phrase itself, and a
        // vault that somehow lost the row still derives every address from it.
        accounts: accounts.some((account) => account.id === PRIMARY_ACCOUNT_ID)
            ? accounts
            : [...defaultAccountRecords(), ...accounts],
        activeId: contents.activeId || PRIMARY_ACCOUNT_ID,
        arenaSecrets: Array.isArray(contents.arenaSecrets)
            ? contents.arenaSecrets
            : [],
        // Absent means backed up: the field only started being written once
        // the check could be declined, and everything older had passed it.
        backedUp: contents.backedUp !== false,
    };
};

/**
 * Open a vault that has no password on it.
 *
 * Synchronous on purpose. There is no key to derive, and the page decides
 * whether to show the lock screen from whether the vault is open — an `await`
 * here would flash a password prompt at somebody who does not have one.
 */
export const openUnprotectedVault = (
    storage: VaultStorage = defaultStorage(),
): OpenedVault => {
    const record = readVault(storage);

    if (!record) {
        throw new Error('No wallet on this device');
    }

    if (record.protection !== 'none') {
        throw new Error('This wallet is protected by a password');
    }

    return {
        ...readContents(JSON.stringify(record.contents)),
        reseal: async (next) => write(next, storage),
    };
};

/**
 * Decrypt the whole vault. Throws on a wrong password (GCM tag mismatch).
 *
 * A version-1 record holds a bare phrase and predates accounts; it is read as
 * a vault with the one account it always had, and is rewritten in the new
 * shape the next time anything is resealed. Nothing is migrated eagerly — an
 * old vault that is only ever unlocked and read stays exactly as it is.
 */
export const unsealVault = async (
    password: string,
    storage: VaultStorage = defaultStorage(),
): Promise<OpenedVault> => {
    const record = readVault(storage);

    if (!record) {
        throw new Error('No wallet on this device');
    }

    // Asking for a password where there is none is a caller's mistake, not a
    // wrong password: saying so keeps it from being reported as one.
    if (record.protection === 'none') {
        throw new Error('This wallet has no password');
    }

    const salt = fromBase64(record.salt);
    const key = await deriveKey(password, salt, record.iterations);

    let plaintext: ArrayBuffer;

    try {
        plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: fromBase64(record.iv) },
            key,
            fromBase64(record.ciphertext),
        );
    } catch {
        throw new Error('Wrong wallet password');
    }

    return {
        ...readContents(new TextDecoder().decode(plaintext)),
        reseal: (next) =>
            seal(next, key, salt, record.iterations, storage).then(() => {}),
    };
};

/** Decrypt the stored phrase alone — what the backup screen asks for. */
export const openVault = async (
    password: string,
    storage: VaultStorage = defaultStorage(),
): Promise<string> => (await unsealVault(password, storage)).phrase;

/**
 * Delete the encrypted phrase from this device. The wallet itself survives
 * only in whatever backup the user made — that is the point of the warning
 * the UI puts in front of this.
 */
export const forgetVault = (storage: VaultStorage = defaultStorage()): void =>
    storage.removeItem(STORAGE_KEY);
