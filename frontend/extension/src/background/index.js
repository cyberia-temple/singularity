/**
 * The service worker: the only place a key is ever used.
 *
 * Three kinds of message arrive here and they are not treated alike.
 *
 *  - A **page** speaks through a port opened by its content script. Its origin
 *    comes from `sender.origin`, never from the message, and everything it
 *    asks for is either a public question about a public chain or a request
 *    that stops at a human.
 *  - The **popup** speaks over `runtime.sendMessage`. It is an extension page,
 *    so it is allowed to ask about accounts and grants — but it still cannot
 *    read the phrase: nothing in the protocol returns one.
 *  - The **clock** speaks through an alarm, and locks the vault.
 *
 * The phrase is decrypted for the duration of one signature and dropped. What
 * an unlocked session actually holds is the AES key, in session memory, which
 * is what makes unlocking cheap without keeping a plaintext seed around.
 */
import {
    CHAINS,
    DEFAULT_CHAIN_ID,
    PRICES_URL,
    chainById,
    chainIdHex,
    parseChainId,
} from '../shared/chains.js';
import { PASSTHROUGH_METHODS, POPUP, PROVIDER_PORT, keepsWalletAwake, rpcError } from '../shared/protocol.js';
import {
    accountsFor,
    grantOrigin,
    grantedOrigins,
    normaliseOrigin,
    revokeOrigin,
} from '../shared/origins.js';
import { describeMessage, describeTransaction } from '../shared/tx.js';
import { DEFAULTS, clearSession, readLocal, readSession, writeLocal, writeSession } from './storage.js';
import { createVault, exportKey, importKey, openVault, openWithKey, sealWith } from './vault.js';
import {
    addressFor,
    checksum,
    isValidPhrase,
    newPhrase,
    normalisePhrase,
    pathFor,
    signMessage,
    signTransaction,
    signTypedData,
} from './keyring.js';
import { balanceOf, feesFor, gasFor, nonceOf, quotes, rpc, sendRaw, tokenMeta, tokensOf } from './rpc.js';
import { applyRelay, permissionsFor, relayScope } from './relay.js';
import { syncInjection } from './injection.js';
import * as requests from './requests.js';
import { classify, lookupUrl, omniboxTarget, suggestion } from './lookup.js';

const SESSION_KEY = 'vaultKey';
const LOCK_ALARM = 'cyberia-lock';

/** Ports held by pages, so events can be pushed to the ones still listening. */
const ports = new Map();

/* --------------------------------------------------------------- session --- */

const armAutoLock = async () => {
    const { autoLockMinutes } = await readLocal(['autoLockMinutes']);

    await chrome.alarms.clear(LOCK_ALARM);
    await chrome.alarms.create(LOCK_ALARM, { delayInMinutes: Math.max(1, autoLockMinutes) });
};

const lock = async () => {
    await clearSession(SESSION_KEY);
    await chrome.alarms.clear(LOCK_ALARM);
    await requests.rejectAll('disconnected');
    await broadcast({ type: 'lock' });
};

/**
 * The open vault, or null when locked.
 *
 * Decrypting on every call is deliberate: the plaintext document exists for
 * the length of one operation and is garbage after it, so a service worker
 * inspected mid-idle holds a key and no phrase.
 */
const session = async () => {
    const encoded = await readSession(SESSION_KEY);
    const { vault } = await readLocal(['vault']);

    if (!encoded || !vault) {
        return null;
    }

    const key = await importKey(encoded);

    let document;

    try {
        document = await openWithKey(vault, key);
    } catch {
        // The stored key no longer opens the stored vault: a vault replaced in
        // another window. Locking is the only honest answer.
        await lock();
        return null;
    }

    return {
        document,
        save: async (next) => {
            await writeLocal({ vault: await sealWith(next, key, vault) });
        },
    };
};

const addresses = (document) =>
    (document?.accounts ?? []).map((account) => checksum(addressFor(document.phrase, account.index)));

const activeAddress = (document) => {
    const list = addresses(document);
    const at = document?.activeIndex ?? 0;

    return list[at] ?? list[0] ?? null;
};

/* ----------------------------------------------------------------- state --- */

const currentChainId = async () => {
    const { chainId } = await readLocal(['chainId']);

    return chainById(chainId)?.id ?? DEFAULT_CHAIN_ID;
};

/**
 * The endpoints the wallet reads, as match patterns.
 *
 * Chromium grants `host_permissions` at install; Gecko treats them as opt-in
 * under MV3, so on Firefox the wallet can be installed and unable to read a
 * single balance until the user says yes. Rather than let that look like a
 * broken RPC, the popup asks for it by name.
 */
const networkOrigins = () => [
    ...new Set(
        [...CHAINS.map((chain) => chain.rpc), ...CHAINS.map((chain) => chain.tokens), PRICES_URL]
            .filter(Boolean)
            .map((endpoint) => `${new URL(endpoint).origin}/*`),
    ),
];

/** What the popup renders itself from. No phrase, no key, no private data. */
const popupState = async () => {
    const stored = await readLocal();
    const open = await session();
    const chainId = chainById(stored.chainId)?.id ?? DEFAULT_CHAIN_ID;
    const accounts = open ? addresses(open.document) : [];

    return {
        ready: Boolean(stored.vault),
        locked: !open,
        accounts: accounts.map((address, index) => ({
            address,
            index: open.document.accounts[index].index,
            name: open.document.accounts[index].name,
            path: pathFor(open.document.accounts[index].index),
            active: index === (open.document.activeIndex ?? 0),
        })),
        activeAddress: open ? activeAddress(open.document) : null,
        chainId,
        chains: CHAINS.map(({ id, name, symbol, tag, color, explorer }) => ({
            id,
            name,
            symbol,
            tag,
            color,
            explorer,
        })),
        grants: Object.entries(stored.grants).map(([origin, grant]) => ({
            origin,
            accounts: grant.accounts,
            grantedAt: grant.grantedAt,
        })),
        relay: stored.relay,
        // What a relay can reach on this engine — the popup describes the
        // switch it is actually offering, not the one the other browser has.
        relayScope: relayScope(),
        networkGranted: await chrome.permissions.contains({ origins: networkOrigins() }),
        networkOrigins: networkOrigins(),
        autoLockMinutes: stored.autoLockMinutes,
        requests: requests.list(),
        version: chrome.runtime.getManifest().version,
    };
};

/* -------------------------------------------------------------- provider --- */

const broadcast = async (event) => {
    for (const [, held] of ports) {
        try {
            held.port.postMessage({ kind: 'event', event });
        } catch {
            // The tab went away between one message and the next.
        }
    }
};

const broadcastTo = (origin, event) => {
    for (const [, held] of ports) {
        if (held.origin === origin) {
            try {
                held.port.postMessage({ kind: 'event', event });
            } catch {
                /* gone */
            }
        }
    }
};

const grantedAccounts = async (origin) => {
    const { grants } = await readLocal(['grants']);
    const open = await session();

    // A locked wallet has no accounts to report. That is not the same as being
    // disconnected, and `eth_accounts` returning [] is exactly how a dapp is
    // told to wait rather than to prompt.
    return open ? accountsFor(grants, origin, addresses(open.document)) : [];
};

const requireAccount = async (origin, from) => {
    const allowed = await grantedAccounts(origin);

    if (allowed.length === 0) {
        // Same code as before, so no dapp's handling changes — but a locked
        // wallet used to be reported as a site that was never connected, and
        // the person at the dapp went looking for a Connect button that would
        // not help. The message now says what to do.
        throw (await session())
            ? rpcError('unauthorized')
            : rpcError('unauthorized', 'Cyberia Wallet is locked. Open it and unlock to review this request.');
    }

    if (!from) {
        return allowed[0];
    }

    const match = allowed.find((address) => address.toLowerCase() === String(from).toLowerCase());

    if (!match) {
        throw rpcError('unauthorized', 'That account is not connected to this site');
    }

    return match;
};

/** Fill in everything a signature covers, so nothing is left to the node. */
const buildTransaction = async (chainId, from, request) => {
    const to = request.to ? checksum(request.to) : null;
    const data = request.data ?? '0x';
    const value = request.value ? BigInt(request.value) : 0n;

    const draft = {
        from,
        ...(to ? { to } : {}),
        ...(value > 0n ? { value: `0x${value.toString(16)}` } : {}),
        ...(data !== '0x' ? { data } : {}),
    };

    const gasLimit = BigInt(request.gas ?? request.gasLimit ?? (await gasFor(chainId, draft)));
    const nonce = Number(BigInt(request.nonce ?? (await nonceOf(chainId, from))));
    const fees = await feesFor(chainId);

    return {
        from,
        to,
        data,
        value,
        nonce,
        gasLimit,
        chainId,
        ...(fees.type === 2
            ? {
                  type: 2,
                  maxFeePerGas: BigInt(fees.maxFeePerGas),
                  maxPriorityFeePerGas: BigInt(fees.maxPriorityFeePerGas),
              }
            : { type: 0, gasPrice: BigInt(fees.gasPrice) }),
    };
};

const feeCeiling = (transaction) =>
    transaction.gasLimit * (transaction.type === 2 ? transaction.maxFeePerGas : transaction.gasPrice);

/** The transaction, described for the screen that asks about it. */
const previewOf = async (transaction, chain) => {
    const call = {
        to: transaction.to,
        data: transaction.data,
        value: `0x${transaction.value.toString(16)}`,
    };
    // A first pass finds out whether a token contract is involved; only then
    // is it asked for its symbol and decimals.
    const first = describeTransaction(call, chain);
    const token = first.tokenContract ? await tokenMeta(chain.id, first.tokenContract) : null;

    return {
        ...(token ? describeTransaction(call, chain, token) : first),
        chainId: chain.id,
        chainName: chain.name,
        symbol: chain.symbol,
        from: transaction.from,
        fee: `0x${feeCeiling(transaction).toString(16)}`,
        nonce: transaction.nonce,
    };
};

const signAndSend = async (chainId, index, transaction) => {
    const open = await session();

    if (!open) {
        throw rpcError('disconnected');
    }

    const raw = await signTransaction(open.document.phrase, index, transaction);

    return sendRaw(chainId, raw);
};

const indexOfAddress = (document, address) => {
    const at = addresses(document).findIndex(
        (candidate) => candidate.toLowerCase() === address.toLowerCase(),
    );

    return at < 0 ? null : document.accounts[at].index;
};

/**
 * One request from a page.
 *
 * The shape of this function is the security model: read-only questions go
 * straight to the chain, anything touching a key goes through `requests.ask`,
 * and anything else is refused by name rather than guessed at.
 */
const handleProviderRequest = async (origin, { method, params = [] }) => {
    const chainId = await currentChainId();
    const chain = chainById(chainId);

    switch (method) {
        case 'eth_chainId':
            return chainIdHex(chainId);

        case 'net_version':
            return String(chainId);

        case 'eth_accounts':
            return grantedAccounts(origin);

        case 'wallet_getPermissions': {
            const accounts = await grantedAccounts(origin);

            return accounts.length === 0
                ? []
                : [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: accounts }] }];
        }

        case 'eth_requestAccounts':
        case 'wallet_requestPermissions': {
            const existing = await grantedAccounts(origin);

            if (existing.length > 0) {
                return method === 'eth_requestAccounts'
                    ? existing
                    : [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: existing }] }];
            }

            const { vault } = await readLocal(['vault']);

            if (!vault) {
                await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
                throw rpcError('unauthorized', 'This browser has no Cyberia Wallet vault yet');
            }

            const approved = await requests.ask({ type: 'connect', origin, payload: {} });

            return method === 'eth_requestAccounts'
                ? approved
                : [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: approved }] }];
        }

        case 'wallet_revokePermissions': {
            const { grants } = await readLocal(['grants']);
            await writeLocal({ grants: revokeOrigin(grants, origin) });
            await syncInjection(revokeOrigin(grants, origin));
            broadcastTo(origin, { type: 'accountsChanged', accounts: [] });

            return null;
        }

        case 'wallet_switchEthereumChain': {
            const wanted = parseChainId(params?.[0]?.chainId);

            if (!wanted || !chainById(wanted)) {
                throw rpcError('unrecognizedChain');
            }

            await writeLocal({ chainId: wanted });
            await broadcast({ type: 'chainChanged', chainId: chainIdHex(wanted) });

            return null;
        }

        case 'wallet_addEthereumChain':
            // The registry here is fixed and mirrors the site's. Adding a
            // chain from a page would mean a page choosing which RPC endpoint
            // sees your addresses, which is not a decision to hand over.
            throw rpcError(
                'unsupportedMethod',
                'Networks are managed in the wallet, not by the page',
            );

        case 'eth_sign':
            // Signs 32 arbitrary bytes that can be a transaction hash. There
            // is no preview that makes that safe, so it is not offered.
            throw rpcError('unsupportedMethod', 'eth_sign is not supported — use personal_sign');

        case 'personal_sign': {
            const [payload, address] = params;
            const account = await requireAccount(origin, address);
            const text = describeMessage(payload);

            const approved = await requests.ask({
                type: 'signMessage',
                origin,
                payload: { address: account, text, raw: payload },
            });

            return approved;
        }

        case 'eth_signTypedData':
        case 'eth_signTypedData_v3':
        case 'eth_signTypedData_v4': {
            const [address, payload] = params;
            const account = await requireAccount(origin, address);
            const typed = typeof payload === 'string' ? JSON.parse(payload) : payload;

            return requests.ask({
                type: 'signTypedData',
                origin,
                payload: {
                    address: account,
                    domain: typed?.domain ?? {},
                    primaryType: typed?.primaryType ?? '',
                    typed,
                },
            });
        }

        case 'eth_sendTransaction': {
            const request = params?.[0] ?? {};
            const account = await requireAccount(origin, request.from);
            const transaction = await buildTransaction(chainId, account, request);

            return requests.ask({
                type: 'sendTransaction',
                origin,
                payload: {
                    address: account,
                    preview: await previewOf(transaction, chain),
                    transaction: serialiseTransaction(transaction),
                },
            });
        }

        default:
            if (PASSTHROUGH_METHODS.has(method)) {
                return rpc(chainId, method, params);
            }

            throw rpcError('unsupportedMethod', `${method} is not supported by Cyberia Wallet`);
    }
};

/** BigInt does not survive `postMessage`; the queue holds strings. */
const serialiseTransaction = (transaction) =>
    Object.fromEntries(
        Object.entries(transaction).map(([key, value]) => [
            key,
            typeof value === 'bigint' ? `0x${value.toString(16)}` : value,
        ]),
    );

const deserialiseTransaction = (transaction) => ({
    ...transaction,
    value: BigInt(transaction.value ?? '0x0'),
    gasLimit: BigInt(transaction.gasLimit),
    nonce: Number(transaction.nonce),
    ...(transaction.type === 2
        ? {
              maxFeePerGas: BigInt(transaction.maxFeePerGas),
              maxPriorityFeePerGas: BigInt(transaction.maxPriorityFeePerGas),
          }
        : { gasPrice: BigInt(transaction.gasPrice) }),
});

/* ----------------------------------------------------------------- ports --- */

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PROVIDER_PORT) {
        return;
    }

    const origin = normaliseOrigin(port.sender?.origin ?? port.sender?.url ?? '');

    if (!origin) {
        port.disconnect();
        return;
    }

    const id = `${port.sender?.tab?.id ?? 'x'}:${port.sender?.frameId ?? 0}:${Date.now()}`;
    ports.set(id, { port, origin });

    port.onDisconnect.addListener(() => {
        ports.delete(id);
    });

    port.onMessage.addListener(async (message) => {
        if (message?.kind !== 'request') {
            return;
        }

        if (keepsWalletAwake(message.payload?.method)) {
            await armAutoLock();
        }

        try {
            const result = await handleProviderRequest(origin, message.payload ?? {});
            port.postMessage({ kind: 'response', id: message.id, result });
        } catch (error) {
            port.postMessage({
                kind: 'response',
                id: message.id,
                error:
                    error && typeof error.code === 'number'
                        ? { code: error.code, message: error.message }
                        : rpcError('internal', String(error?.message ?? error)),
            });
        }
    });
});

/* ----------------------------------------------------------------- popup --- */

const approveRequest = async (id, choice) => {
    const request = requests.list().find((entry) => entry.id === id);

    if (!request) {
        return { ok: false, error: 'That request is no longer waiting' };
    }

    if (!choice.approved) {
        await requests.settle(id, { approved: false });

        return { ok: true };
    }

    const open = await session();

    if (!open) {
        return { ok: false, error: 'The vault is locked' };
    }

    const chainId = await currentChainId();

    try {
        if (request.type === 'connect') {
            const chosen = (choice.accounts ?? []).map(checksum);
            const known = addresses(open.document);
            const accounts = chosen.filter((address) => known.includes(address));

            if (accounts.length === 0) {
                return { ok: false, error: 'Pick at least one account' };
            }

            const { grants } = await readLocal(['grants']);
            const next = grantOrigin(grants, request.origin, accounts);
            await writeLocal({ grants: next });
            await syncInjection(next);
            broadcastTo(request.origin, { type: 'accountsChanged', accounts });
            broadcastTo(request.origin, { type: 'connect', chainId: chainIdHex(chainId) });
            await requests.settle(id, { approved: true, value: accounts });

            return { ok: true };
        }

        const index = indexOfAddress(open.document, request.payload.address);

        if (index === null) {
            return { ok: false, error: 'That account is not in this vault' };
        }

        if (request.type === 'signMessage') {
            const signature = await signMessage(open.document.phrase, index, request.payload.text);
            await requests.settle(id, { approved: true, value: signature });

            return { ok: true };
        }

        if (request.type === 'signTypedData') {
            const { typed } = request.payload;
            const signature = await signTypedData(open.document.phrase, index, {
                domain: typed.domain,
                types: typed.types,
                message: typed.message,
            });
            await requests.settle(id, { approved: true, value: signature });

            return { ok: true };
        }

        if (request.type === 'sendTransaction') {
            const hash = await signAndSend(
                chainId,
                index,
                deserialiseTransaction(request.payload.transaction),
            );
            await requests.settle(id, { approved: true, value: hash });

            return { ok: true, hash };
        }

        return { ok: false, error: `Unknown request type ${request.type}` };
    } catch (error) {
        // The page keeps waiting: a failed broadcast is not a rejection, and
        // the person is the one who decides whether to try again.
        return { ok: false, error: String(error?.message ?? error) };
    }
};

/** Balances, tokens and quotes for the popup — read fresh, never cached to disk. */
const portfolio = async () => {
    const open = await session();

    if (!open) {
        return { locked: true };
    }

    const address = activeAddress(open.document);
    const chainId = await currentChainId();
    const chain = chainById(chainId);

    const [balance, tokens, prices] = await Promise.allSettled([
        balanceOf(chainId, address),
        tokensOf(chainId, address),
        quotes(),
    ]);

    const quote = prices.status === 'fulfilled' ? prices.value : null;
    const native = quote?.prices?.[chain.priceKey] ?? null;
    const tokenPrices = quote?.tokens?.[chain.priceKey] ?? {};

    return {
        locked: false,
        address,
        chainId,
        balance: balance.status === 'fulfilled' ? balance.value : null,
        balanceError: balance.status === 'rejected' ? String(balance.reason?.message ?? balance.reason) : null,
        nativePrice: typeof native === 'number' ? native : null,
        tokens:
            tokens.status === 'fulfilled'
                ? tokens.value.map((token) => ({
                      ...token,
                      price: tokenPrices[token.contract] ?? null,
                  }))
                : [],
        tokensNote:
            chain.tokens === null
                ? 'This chain has no keyless token index the browser can read.'
                : tokens.status === 'rejected'
                  ? 'The token index could not be reached.'
                  : null,
    };
};

const popupHandlers = {
    [POPUP.state]: () => popupState(),

    [POPUP.newPhrase]: () => ({ phrase: newPhrase() }),

    [POPUP.create]: async ({ phrase, password, name }) => {
        if (!isValidPhrase(phrase)) {
            return { ok: false, error: 'That is not a valid BIP-39 phrase' };
        }

        if (String(password ?? '').length < 8) {
            return { ok: false, error: 'The password needs at least 8 characters' };
        }

        const document = {
            phrase: normalisePhrase(phrase),
            accounts: [{ index: 0, name: name || 'Main account' }],
            activeIndex: 0,
        };

        const { record, key } = await createVault(document, password);
        await writeLocal({ vault: record, grants: {}, chainId: DEFAULT_CHAIN_ID });
        await writeSession(SESSION_KEY, await exportKey(key));
        await syncInjection({});
        await armAutoLock();

        return { ok: true };
    },

    [POPUP.unlock]: async ({ password }) => {
        const { vault } = await readLocal(['vault']);

        try {
            const opened = await openVault(vault, password);
            await writeSession(SESSION_KEY, await exportKey(opened.key));
            await armAutoLock();

            return { ok: true };
        } catch {
            return { ok: false, error: 'Wrong password' };
        }
    },

    [POPUP.lock]: async () => {
        await lock();

        return { ok: true };
    },

    [POPUP.selectAccount]: async ({ index }) => {
        const open = await session();

        if (!open) {
            return { ok: false, error: 'The vault is locked' };
        }

        const at = open.document.accounts.findIndex((account) => account.index === index);

        if (at < 0) {
            return { ok: false, error: 'No such account' };
        }

        await open.save({ ...open.document, activeIndex: at });

        return { ok: true };
    },

    [POPUP.addAccount]: async ({ name }) => {
        const open = await session();

        if (!open) {
            return { ok: false, error: 'The vault is locked' };
        }

        const next = Math.max(...open.document.accounts.map((account) => account.index)) + 1;
        const accounts = [
            ...open.document.accounts,
            { index: next, name: name || `Account ${next + 1}` },
        ];

        await open.save({ ...open.document, accounts, activeIndex: accounts.length - 1 });

        return { ok: true };
    },

    [POPUP.selectChain]: async ({ chainId }) => {
        const chain = chainById(chainId);

        if (!chain) {
            return { ok: false, error: 'No such chain' };
        }

        await writeLocal({ chainId: chain.id });
        await broadcast({ type: 'chainChanged', chainId: chainIdHex(chain.id) });

        return { ok: true };
    },

    [POPUP.resolveRequest]: ({ id, approved, accounts }) =>
        approveRequest(id, { approved, accounts }),

    /**
     * Connecting the site in the active tab, from the popup.
     *
     * The provider is injected only where a grant exists, and a grant used to
     * come only from `eth_requestAccounts` — which a page can send only through
     * the provider. On a fresh install nothing could therefore ever connect.
     * This is the way in: the popup has already asked the browser for the
     * site's host permission inside the user's click, and this grants the
     * active account to that origin and registers the provider there.
     */
    [POPUP.connectOrigin]: async ({ origin }) => {
        const open = await session();

        if (!open) {
            return { ok: false, error: 'The vault is locked' };
        }

        if (!normaliseOrigin(origin)) {
            return { ok: false, error: 'Only a web page can be connected' };
        }

        const { grants } = await readLocal(['grants']);
        const next = grantOrigin(grants, origin, [activeAddress(open.document)]);

        await writeLocal({ grants: next });
        await syncInjection(next);

        return { ok: true };
    },

    [POPUP.revokeOrigin]: async ({ origin }) => {
        const { grants } = await readLocal(['grants']);
        const next = revokeOrigin(grants, origin);

        await writeLocal({ grants: next });
        await syncInjection(next);
        await requests.rejectOrigin(origin);
        broadcastTo(origin, { type: 'accountsChanged', accounts: [] });

        return { ok: true, origins: grantedOrigins(next) };
    },

    [POPUP.setRelay]: async ({ relay }) => {
        const merged = { ...DEFAULTS.relay, ...relay };
        await writeLocal({ relay: merged });

        const result = await applyRelay(merged);

        return { ok: result.applied, ...result, needed: permissionsFor(merged) };
    },

    [POPUP.rotateCircuit]: async () => {
        const { relay } = await readLocal(['relay']);
        const merged = { ...relay, circuit: (relay.circuit ?? 0) + 1 };

        await writeLocal({ relay: merged });

        // Tor builds a new circuit for a new stream; dropping the current
        // connections is all an extension can honestly do to ask for one.
        const result = await applyRelay(merged);

        return { ok: result.applied, circuit: merged.circuit };
    },

    [POPUP.setAutoLock]: async ({ minutes }) => {
        const value = Math.min(240, Math.max(1, Number(minutes) || 15));
        await writeLocal({ autoLockMinutes: value });
        await armAutoLock();

        return { ok: true, minutes: value };
    },

    [POPUP.quote]: () => portfolio(),

    [POPUP.send]: async ({ to, amount, chainId }) => {
        const open = await session();

        if (!open) {
            return { ok: false, error: 'The vault is locked' };
        }

        const chain = chainById(chainId ?? (await currentChainId()));
        const from = activeAddress(open.document);
        const index = open.document.accounts[open.document.activeIndex ?? 0].index;

        try {
            const transaction = await buildTransaction(chain.id, from, {
                to,
                value: `0x${BigInt(amount).toString(16)}`,
            });
            const hash = await signAndSend(chain.id, index, transaction);

            return { ok: true, hash, explorer: `${chain.explorer}/tx/${hash}` };
        } catch (error) {
            return { ok: false, error: String(error?.message ?? error) };
        }
    },

    [POPUP.forget]: async () => {
        await requests.rejectAll('disconnected');
        await chrome.storage.local.clear();
        await chrome.storage.session.clear();
        await syncInjection({});
        await chrome.alarms.clear(LOCK_ALARM);

        return { ok: true };
    },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const handler = popupHandlers[message?.type];

    if (!handler) {
        return false;
    }

    // Only the extension's own pages may ask these; a content script that
    // learned the message names still has no id to send them from.
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(''))) {
        sendResponse({ ok: false, error: 'not allowed' });

        return false;
    }

    armAutoLock()
        .then(() => handler(message.payload ?? {}))
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));

    return true;
});

/* ---------------------------------------------------------------- wiring --- */

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === LOCK_ALARM) {
        await lock();
    }
});

chrome.runtime.onInstalled.addListener(async (details) => {
    const { vault, grants, relay } = await readLocal(['vault', 'grants', 'relay']);

    // The menu and, on Chromium, the side panel: both are rebuilt on every
    // install and update because the browser forgets nothing else about them.
    createMenus();

    await syncInjection(grants);
    await requests.refreshBadge();
    await applyRelay(relay);

    if (!vault && details.reason === 'install') {
        await chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    }
});

chrome.runtime.onStartup.addListener(async () => {
    const { grants, relay } = await readLocal(['grants', 'relay']);

    await syncInjection(grants);
    await applyRelay(relay);
});

/* -------------------------------------------- selection, omnibox, panel --- */

/**
 * Right-click a selected address, hash, block or .cyber name on any page and
 * open it on the Cyberia explorer; `cy <text>` in the address bar does the same.
 * Nothing is read from the page beyond the selection the browser hands over.
 */
function createMenus() {
    chrome.contextMenus?.removeAll(() => {
        chrome.contextMenus.create({
            id: 'cyberia-lookup',
            title: 'Open "%s" on Cyberia',
            contexts: ['selection'],
        });
        if (chrome.sidePanel) {
            chrome.contextMenus.create({
                id: 'cyberia-panel',
                title: 'Open Cyberia Wallet in the side panel',
                contexts: ['action'],
            });
        }
    });
}

chrome.contextMenus?.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'cyberia-lookup' && info.selectionText) {
        void chrome.tabs.create({ url: lookupUrl(classify(info.selectionText)), index: (tab?.index ?? 0) + 1 });
    }
    if (info.menuItemId === 'cyberia-panel' && tab?.windowId !== undefined) {
        void chrome.sidePanel?.open({ windowId: tab.windowId }).catch(() => undefined);
    }
});

chrome.omnibox?.setDefaultSuggestion({ description: 'Cyberia: an address, a transaction hash, a block or a .cyber name' });
chrome.omnibox?.onInputChanged.addListener((text, suggest) => {
    if (text.trim()) {
        suggest([suggestion(text)]);
    }
});
chrome.omnibox?.onInputEntered.addListener((text, disposition) => {
    const url = omniboxTarget(text);
    if (disposition === 'currentTab') {
        void chrome.tabs.update({ url });
    } else {
        void chrome.tabs.create({ url, active: disposition !== 'newBackgroundTab' });
    }
});
