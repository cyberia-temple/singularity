import { Mnemonic, getBytes, randomBytes } from 'ethers';
import {
    PRIMARY_ACCOUNT_ID,
    defaultAccountRecords,
} from '@/lib/wallet/accounts';
import type { WalletAccountRecord } from '@/lib/wallet/accounts';

/**
 * Encrypted-at-rest storage for everything this device knows about the wallet.
 *
 * The wallet is non-custodial in the strict sense: the phrase is generated in
 * the browser, sealed with a key derived from the user's password, and kept in
 * this device's localStorage. It is never sent to Laravel, never put in an
 * Inertia prop, never written to a log, and never rendered except in the
 * deliberate backup flow the user has to confirm. Losing the phrase and the
 * password means losing the funds — that is the trade for custody.
 *
 * The account list is sealed alongside the phrase rather than kept beside it.
 * An imported account carries a live private key, so it has no business in
 * plaintext storage; and even a watch-only row is a statement about which
 * addresses this person cares about, which is exactly the kind of thing a
 * locked vault should not still be saying out loud.
 *
 * AES-256-GCM over a PBKDF2-SHA-256 key; the tag makes a wrong password fail
 * loudly instead of yielding garbage that would derive plausible addresses.
 */

const STORAGE_KEY = 'cyberia.wallet.vault.v1';

const PBKDF2_ITERATIONS = 310_000;

export type VaultRecord = {
    /** 1 sealed a bare phrase; 2 seals the JSON document below. */
    version: 1 | 2;
    kdf: 'PBKDF2-SHA-256';
    iterations: number;
    salt: string;
    iv: string;
    ciphertext: string;
    createdAt: string;
};

/** Everything behind the password, once it has been unsealed. */
export type VaultContents = {
    phrase: string;
    accounts: WalletAccountRecord[];
    /** Which account the app is currently acting as. */
    activeId: string;
    /** Unrevealed Arena moves; encrypted under the same local vault key. */
    arenaSecrets: ArenaSecretRecord[];
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

/**
 * Create this device's vault around a phrase, and hand back the means to keep
 * writing to it. Both onboarding paths land here — a phrase this device
 * generated and one the user typed in are the same thing by now.
 */
export const saveVault = async (
    phrase: string,
    password: string,
    storage: VaultStorage = defaultStorage(),
): Promise<OpenedVault> => {
    const normalized = normalizeMnemonic(phrase);

    if (!Mnemonic.isValidMnemonic(normalized)) {
        throw new Error('Not a valid BIP-39 seed phrase');
    }

    if (password.length < 8) {
        throw new Error('Wallet password must be at least 8 characters');
    }

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);

    const contents: VaultContents = {
        phrase: normalized,
        accounts: defaultAccountRecords(),
        activeId: PRIMARY_ACCOUNT_ID,
        arenaSecrets: [],
    };

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
