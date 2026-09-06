import { computed, ref } from 'vue';
import { nftChain } from '@/lib/nftChains';
import {
    PRIMARY_ACCOUNT_ID,
    arenaCommitment,
    commitArenaMove,
    catalogueWalletChains,
    chatPublicKey,
    conversationKey,
    customWalletChain,
    deriveAccounts,
    deriveAddress,
    createArenaGame,
    createArenaSecret,
    evmChatKey,
    forgetLainChats,
    forgetVault,
    forgetWalletChats,
    openMessage,
    sealMessage,
    hasVault,
    importedAccountId,
    isValidMnemonic,
    keySource,
    nextSeedIndex,
    normalizeMnemonic,
    openVault,
    parseUnits,
    mergeTokens,
    phraseAccountId,
    readCustomNetworks,
    readEnabledNetworks,
    joinArenaGame,
    readManualTokens,
    sameToken,
    saveVault,
    revealArenaMove,
    seedAccountId,
    seedFromMnemonic,
    seedSource,
    setCatalogueWalletChains,
    setCustomWalletChains,
    settleArenaGame,
    unsealVault,
    validateCustomNetwork,
    walletChain,
    walletChains,
    withToken,
    withoutToken,
    writeCustomNetworks,
    writeEnabledNetworks,
    writeManualTokens,
} from '@/lib/wallet';
import type {
    ChatEnvelope,
    ChatMeta,
    CustomNetwork,
    CustomNetworkProblem,
    ManualToken,
    OpenedVault,
    VaultContents,
    WalletAccount,
    WalletAccountRecord,
    WalletChainId,
    WalletFeeQuote,
    WalletFeeTier,
    WalletKeySource,
    WalletTokenBalance,
    WalletTx,
} from '@/lib/wallet';
import type { ArenaMove, ArenaSecretRecord } from '@/lib/wallet';
import { lockOnEvm } from '@/lib/wallet/bridge';
import type { BridgeLock } from '@/lib/wallet/bridge';
import { executeCrossSwap } from '@/lib/wallet/crosschain';
import type {
    CrossQuote,
    CrossReceipt,
    CrossStep,
} from '@/lib/wallet/crosschain';
import {
    claim as claimReward,
    stake as stakeLp,
    unstake as unstakeLp,
} from '@/lib/wallet/earn';
import type { EarnReceipt } from '@/lib/wallet/earn';
import { mintNft as submitMint } from '@/lib/wallet/nft';
import type { MintQuote } from '@/lib/wallet/nft';
import { executeSwap } from '@/lib/wallet/swap';
import type { SwapQuote, SwapReceipt } from '@/lib/wallet/swap';
import { executeWrap } from '@/lib/wallet/wrap';
import type { WrapQuote } from '@/lib/wallet/wrap';

/**
 * Session state of the unified multichain wallet.
 *
 * The unsealed vault lives in a plain module variable, deliberately not in a
 * ref: reactive state ends up in Vue devtools and in every component that
 * touches it, and this object holds both the phrase and any imported private
 * key. Nothing here returns either except `reveal()`, which asks for the
 * password again, and nothing here ever logs. Locking drops the whole object,
 * so a locked tab holds no key material at all.
 *
 * What is reactive is only ever the public half: which accounts exist, which
 * one is active, and the addresses that one derives.
 */

export type WalletBalance = {
    value: bigint | null;
    loading: boolean;
    error: string | null;
};

export type WalletHistory = {
    items: WalletTx[];
    loading: boolean;
    error: string | null;
};

export type WalletTokens = {
    items: WalletTokenBalance[];
    loading: boolean;
    error: string | null;
};

let vault: OpenedVault | null = null;

/**
 * Derived AES keys for open conversations, kept out of reactive state for the
 * same reason the vault is: these decrypt messages. They are non-extractable
 * WebCrypto keys, they never touch storage, and `clearReads` empties the map
 * whenever the account changes or the wallet locks.
 */
const conversationKeys = new Map<string, CryptoKey>();

const customNetworks = ref<CustomNetwork[]>([]);

/**
 * Catalogue networks this device has switched on, by id.
 *
 * Module state for the same reason the custom list is: the chain registry is a
 * process-wide fact, and an adapter looked up inside `send()` has to see the
 * same set the portfolio drew.
 */
const enabledNetworks = ref<WalletChainId[]>([]);
let enabledLoaded = false;
const accounts = ref<WalletAccount[]>([]);
const accountRecords = ref<WalletAccountRecord[]>([]);
const activeAccountId = ref<string>(PRIMARY_ACCOUNT_ID);
const exists = ref(false);
const unlocked = ref(false);
const balances = ref<Record<string, WalletBalance>>({});
const history = ref<Record<string, WalletHistory>>({});
const tokens = ref<Record<string, WalletTokens>>({});
const manualTokens = ref<ManualToken[]>([]);
const fees = ref<Record<string, WalletFeeQuote[]>>({});
const busy = ref(false);

/** Minutes of inactivity after which the vault seals itself. 0 disables it. */
const autoLockMinutes = ref(15);
const lastActivity = ref(Date.now());
let autoLockTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Per-chain RPC overrides. Every chain adapter already carries a public
 * default, so this is only for the endpoints the server prefers we use.
 */
export type WalletRpcEndpoints = Partial<Record<WalletChainId, string>>;

/**
 * Fee quotes are keyed by what is being moved, not only by where.
 *
 * A token transfer is a contract call and costs several times what moving the
 * coin does, so one quote per chain would price a USDC transfer as if it were
 * a CYBER one — and the sentence above the signature would be wrong.
 */
const feeKey = (
    chain: WalletChainId,
    token: string | null,
    toContract = false,
): string =>
    token
        ? `${chain}:${token.toLowerCase()}`
        : // Paying a contract in the coin runs the contract's code on this
          // transaction's gas, so it is its own quote and not the coin's.
          toContract
          ? `${chain}@contract`
          : chain;

/** The session object the wallet page hands to its screens. */
export type MultiWallet = ReturnType<typeof useMultiWallet>;

export const useMultiWallet = (rpc: WalletRpcEndpoints = {}) => {
    const refreshExists = (): void => {
        exists.value = typeof window !== 'undefined' && hasVault();
    };

    refreshExists();

    /**
     * The account the app is acting as, or the primary one when whatever was
     * stored no longer exists — a vault always has somewhere to fall back to.
     */
    const activeRecord = (): WalletAccountRecord | null => {
        if (!vault) {
            return null;
        }

        return (
            vault.accounts.find((record) => record.id === vault?.activeId) ??
            vault.accounts[0]
        );
    };

    const load = (): void => {
        const record = activeRecord();

        accountRecords.value = vault ? vault.accounts : [];
        activeAccountId.value = record?.id ?? PRIMARY_ACCOUNT_ID;
        accounts.value =
            vault && record ? deriveAccounts(vault.phrase, record) : [];
        unlocked.value = vault !== null;
    };

    /** Everything read from a chain, which belongs to one account only. */
    const clearReads = (): void => {
        balances.value = {};
        history.value = {};
        tokens.value = {};
        fees.value = {};
        // Conversation keys belong to one account as much as a balance does,
        // and they are live key material — locking or switching drops them.
        conversationKeys.clear();
    };

    /**
     * Write the vault back and re-derive from it.
     *
     * Re-sealing uses the key that opening the vault produced, so none of the
     * account actions has to ask for the password again — and none of them
     * keeps it around in order to avoid asking.
     */
    const commit = async (next: Partial<VaultContents>): Promise<void> => {
        if (!vault) {
            throw new Error('Wallet is locked');
        }

        const merged: VaultContents = {
            phrase: vault.phrase,
            accounts: next.accounts ?? vault.accounts,
            activeId: next.activeId ?? vault.activeId,
            arenaSecrets: next.arenaSecrets ?? vault.arenaSecrets,
        };

        await vault.reseal(merged);
        vault = { ...merged, reseal: vault.reseal };
        load();
    };

    /**
     * The signer behind the active account on one chain.
     *
     * Every path that spends or signs goes through here, so the three account
     * kinds are distinguished once: a seed account walks the phrase at its own
     * index, an imported key is itself, and a watched address has no key and
     * is refused before a transaction is ever built.
     */
    const sourceFor = (chainId: WalletChainId): WalletKeySource => {
        const record = activeRecord();

        if (!vault || !record) {
            throw new Error('Wallet is locked');
        }

        if (record.kind === 'watch') {
            throw new Error('This account is watch-only and cannot sign');
        }

        if (record.kind === 'key') {
            if (record.chain !== chainId) {
                throw new Error(
                    `This account exists only on ${walletChain(record.chain).label}`,
                );
            }

            return keySource(record.secret);
        }

        return seedSource(
            seedFromMnemonic(
                record.kind === 'phrase' ? record.phrase : vault.phrase,
            ),
            record.index,
        );
    };

    /**
     * Publish the stored networks to the chain registry and re-derive.
     *
     * The adapters are rebuilt from the records rather than kept alongside
     * them, so a network is only ever as trustworthy as what the user typed —
     * there is no cached adapter that could outlive a removal.
     */
    const syncCustomNetworks = (networks: CustomNetwork[]): void => {
        customNetworks.value = networks;
        setCustomWalletChains(networks.map(customWalletChain));
        load();
    };

    /**
     * Publish the switched-on catalogue networks to the registry and re-derive.
     *
     * Rebuilt from ids rather than kept as adapters, exactly like the custom
     * list: switching a network off has to leave nothing behind that could
     * still answer a balance read.
     */
    const syncEnabledNetworks = (ids: WalletChainId[]): void => {
        enabledNetworks.value = ids;
        setCatalogueWalletChains(catalogueWalletChains(ids));
        load();
    };

    if (customNetworks.value.length === 0) {
        syncCustomNetworks(readCustomNetworks());
    }

    // Read once per page rather than "when empty": an empty list is the normal
    // state of a wallet that switched every catalogue network back off, and
    // re-reading storage on every call would undo that on the next render.
    if (!enabledLoaded) {
        enabledLoaded = true;
        syncEnabledNetworks(readEnabledNetworks());
    }

    if (manualTokens.value.length === 0) {
        manualTokens.value = readManualTokens();
    }

    /**
     * Derive an account on a network the user describes. Returns what is wrong
     * with it, or null once it has been added — the seed is not touched, only
     * re-walked at a path this vault already covers.
     */
    const addNetwork = (draft: CustomNetwork): CustomNetworkProblem | null => {
        const problem = validateCustomNetwork(draft, walletChains());

        if (problem !== null) {
            return problem;
        }

        const next = [...customNetworks.value, draft];
        writeCustomNetworks(next);
        syncCustomNetworks(next);

        return null;
    };

    /**
     * Switch a shipped network on, so it becomes a card in the portfolio.
     *
     * Nothing is derived that was not derivable a second ago — the address is
     * the same one every EVM network in this wallet shows. What changes is that
     * one more balance is read on every refresh, which is the whole reason this
     * is a choice and not a default.
     */
    const enableNetwork = (id: WalletChainId): void => {
        if (enabledNetworks.value.includes(id)) {
            return;
        }

        const next = [...enabledNetworks.value, id];
        writeEnabledNetworks(next);
        syncEnabledNetworks(next);
    };

    /** Switch a shipped network off. Removes a card, never an account. */
    const disableNetwork = (id: WalletChainId): void => {
        const next = enabledNetworks.value.filter(
            (candidate) => candidate !== id,
        );
        writeEnabledNetworks(next);
        syncEnabledNetworks(next);
    };

    /**
     * Forget a network's settings. The account behind it stays derivable from
     * the seed forever — this removes an endpoint, never coins.
     */
    const removeNetwork = (id: WalletChainId): void => {
        const next = customNetworks.value.filter(
            (network) => network.id !== id,
        );
        writeCustomNetworks(next);
        syncCustomNetworks(next);
    };

    const rpcFor = (chain: WalletChainId): string | undefined => rpc[chain];

    /**
     * Restart the idle countdown. The page calls this on real interaction, so
     * a wallet left open on a shared screen seals itself while one that is
     * being used stays open.
     */
    const touch = (): void => {
        lastActivity.value = Date.now();
    };

    /**
     * Seal a phrase into this device's vault and open it. Both onboarding
     * paths end here: a phrase this device generated and one the user typed
     * in are the same thing by the time they are stored.
     */
    const adopt = async (
        candidate: string,
        password: string,
    ): Promise<void> => {
        busy.value = true;

        try {
            vault = await saveVault(candidate, password);
            touch();
            refreshExists();
            clearReads();
            load();
        } finally {
            busy.value = false;
        }
    };

    const unlock = async (password: string): Promise<void> => {
        busy.value = true;

        try {
            vault = await unsealVault(password);
            touch();
            clearReads();
            load();
        } finally {
            busy.value = false;
        }
    };

    const lock = (): void => {
        vault = null;
        accounts.value = [];
        accountRecords.value = [];
        activeAccountId.value = PRIMARY_ACCOUNT_ID;
        clearReads();
        unlocked.value = false;
    };

    /** Change the idle limit and restart the countdown against it. */
    const setAutoLock = (minutes: number): void => {
        autoLockMinutes.value = minutes;
        touch();
    };

    const startAutoLock = (): void => {
        if (autoLockTimer !== null || typeof window === 'undefined') {
            return;
        }

        autoLockTimer = setInterval(() => {
            const limit = autoLockMinutes.value * 60_000;

            if (
                unlocked.value &&
                limit > 0 &&
                Date.now() - lastActivity.value >= limit
            ) {
                lock();
            }
        }, 10_000);
    };

    startAutoLock();

    /** The backup phrase, behind a fresh password check. */
    const reveal = (password: string): Promise<string> => openVault(password);

    /**
     * Act as another account. Everything read from a chain belongs to the
     * account it was read for, so it is dropped rather than shown against the
     * new one for the moment before a refresh lands.
     */
    const switchAccount = async (id: string): Promise<void> => {
        if (id === activeAccountId.value) {
            return;
        }

        clearReads();
        await commit({ activeId: id });
    };

    /**
     * Walk the phrase one account further along.
     *
     * The number is the next free BIP-44 account, not the length of the list:
     * that is the number which restores this same account in any other wallet,
     * which is the only reason to follow the standard at all.
     */
    const deriveAccount = async (
        label: string | null = null,
    ): Promise<void> => {
        if (!vault) {
            throw new Error('Wallet is locked');
        }

        const index = nextSeedIndex(vault.accounts);
        const record: WalletAccountRecord = {
            id: seedAccountId(index),
            kind: 'seed',
            index,
            label,
        };

        clearReads();
        await commit({
            accounts: [...vault.accounts, record],
            activeId: record.id,
        });
    };

    /**
     * Take an account from outside the seed tree. Returns null once it is on
     * the list, or why it could not be read — a mistyped key is the common
     * case, and it has to fail before anything is sealed.
     */
    const importAccount = async (draft: {
        kind: 'phrase' | 'key' | 'watch';
        /** Which chain the secret belongs to. Ignored for a whole phrase. */
        chain: WalletChainId;
        /**
         * The phrase for `phrase`, the private key for `key`, the public
         * address for `watch`.
         */
        secret: string;
        label: string | null;
    }): Promise<string | null> => {
        if (!vault) {
            throw new Error('Wallet is locked');
        }

        if (draft.kind === 'phrase') {
            const candidate = draft.secret.trim();

            if (!isValidMnemonic(candidate)) {
                return 'That is not a valid BIP-39 seed phrase';
            }

            const normalized = normalizeMnemonic(candidate);

            if (normalized === vault.phrase) {
                return 'That is this vault’s own phrase — its accounts are already here';
            }

            // Identified by what it derives rather than by the words, so the
            // same phrase pasted twice is caught without the id being a
            // function of the secret.
            const id = phraseAccountId(deriveAddress(normalized, 'cyberia'));

            if (vault.accounts.some((record) => record.id === id)) {
                return 'That phrase is already in this vault';
            }

            clearReads();
            await commit({
                accounts: [
                    ...vault.accounts,
                    {
                        id,
                        kind: 'phrase',
                        phrase: normalized,
                        index: 0,
                        label: draft.label,
                    },
                ],
                activeId: id,
            });

            return null;
        }

        const chain = walletChain(draft.chain);
        const secret = draft.secret.trim();
        let address: string;

        if (draft.kind === 'watch') {
            if (!chain.isValidAddress(secret)) {
                return `That is not a valid ${chain.label} address`;
            }

            address = secret;
        } else {
            if (!chain.importKey) {
                return `${chain.label} keys cannot be imported here`;
            }

            try {
                address = chain.importKey(secret);
            } catch (failure) {
                return failure instanceof Error
                    ? failure.message
                    : `That is not a valid ${chain.label} key`;
            }
        }

        const id = importedAccountId(draft.kind, draft.chain, address);

        if (vault.accounts.some((record) => record.id === id)) {
            return 'That account is already in this vault';
        }

        const record: WalletAccountRecord =
            draft.kind === 'key'
                ? {
                      id,
                      kind: 'key',
                      chain: draft.chain,
                      secret,
                      address,
                      label: draft.label,
                  }
                : {
                      id,
                      kind: 'watch',
                      chain: draft.chain,
                      address,
                      label: draft.label,
                  };

        clearReads();
        await commit({
            accounts: [...vault.accounts, record],
            activeId: id,
        });

        return null;
    };

    const renameAccount = async (id: string, label: string): Promise<void> => {
        if (!vault) {
            throw new Error('Wallet is locked');
        }

        await commit({
            accounts: vault.accounts.map((record) =>
                record.id === id
                    ? { ...record, label: label.trim() || null }
                    : record,
            ),
        });
    };

    /**
     * Forget an account. The primary one cannot go: it *is* the phrase, and a
     * vault without it would be a vault whose backup restores nothing.
     *
     * For a seed account this forgets a row and nothing else — the same phrase
     * derives it again at the same index. For an imported key it forgets the
     * only copy this device had, which is why the screen asking for it says so.
     */
    const removeAccount = async (id: string): Promise<void> => {
        if (!vault || id === PRIMARY_ACCOUNT_ID) {
            return;
        }

        const accountsLeft = vault.accounts.filter(
            (record) => record.id !== id,
        );

        clearReads();
        await commit({
            accounts: accountsLeft,
            activeId:
                vault.activeId === id ? PRIMARY_ACCOUNT_ID : vault.activeId,
        });
    };

    const forget = (): void => {
        forgetVault();
        // The network list goes with the keys. It is a record of what this
        // person held, and "delete local vault" has to mean the device keeps
        // nothing about them — the accounts themselves come back from the seed.
        writeCustomNetworks([]);
        syncCustomNetworks([]);
        // Which of the shipped networks were switched on is the same kind of
        // record — it says which chains this person uses — and it comes back
        // from the catalogue in one tap.
        writeEnabledNetworks([]);
        syncEnabledNetworks([]);
        writeManualTokens([]);
        manualTokens.value = [];
        // What was said to Lain from these accounts is as much a record of this
        // person as the network list is, and it lives only here.
        forgetLainChats();
        // And what was said to other wallets. The relay drops its copy on its
        // own schedule, but the only readable one was always this device's.
        forgetWalletChats();
        lock();
        refreshExists();
    };

    const refreshBalances = async (): Promise<void> => {
        await Promise.all(
            accounts.value
                .filter((account) => account.capabilities.balance)
                .map(async (account) => {
                    const chain = walletChain(account.chain);

                    balances.value = {
                        ...balances.value,
                        [account.chain]: {
                            value: balances.value[account.chain]?.value ?? null,
                            loading: true,
                            error: null,
                        },
                    };

                    try {
                        const value = await chain.fetchBalance!(
                            account.address,
                            rpcFor(account.chain),
                        );

                        balances.value = {
                            ...balances.value,
                            [account.chain]: {
                                value,
                                loading: false,
                                error: null,
                            },
                        };
                    } catch (error) {
                        balances.value = {
                            ...balances.value,
                            [account.chain]: {
                                value: null,
                                loading: false,
                                error:
                                    error instanceof Error
                                        ? error.message
                                        : 'Balance unavailable',
                            },
                        };
                    }
                }),
        );
    };

    /** Recent transfers for one chain, from its own indexer or RPC. */
    const refreshHistory = async (chainId: WalletChainId): Promise<void> => {
        const chain = walletChain(chainId);
        const account = accounts.value.find(
            (candidate) => candidate.chain === chainId,
        );

        if (!chain.fetchHistory || !account) {
            return;
        }

        history.value = {
            ...history.value,
            [chainId]: {
                items: history.value[chainId]?.items ?? [],
                loading: true,
                error: null,
            },
        };

        try {
            const items = await chain.fetchHistory(
                account.address,
                rpcFor(chainId),
            );

            history.value = {
                ...history.value,
                [chainId]: { items, loading: false, error: null },
            };
        } catch (error) {
            history.value = {
                ...history.value,
                [chainId]: {
                    items: [],
                    loading: false,
                    error:
                        error instanceof Error
                            ? error.message
                            : 'History unavailable',
                },
            };
        }
    };

    /**
     * ERC20-style assets on one chain: whatever its index reports plus every
     * contract the user added by hand.
     *
     * The two sources are kept apart on purpose. An indexed token at zero is
     * noise the explorer happens to remember; a hand-added one at zero was an
     * explicit act and stays on the list until it is explicitly removed.
     */
    const refreshTokens = async (chainId: WalletChainId): Promise<void> => {
        const chain = walletChain(chainId);
        const account = accounts.value.find(
            (candidate) => candidate.chain === chainId,
        );

        if (!account || (!chain.fetchTokens && !chain.readToken)) {
            return;
        }

        const mine = manualTokens.value.filter(
            (entry) => entry.chain === chainId,
        );

        if (!chain.fetchTokens && mine.length === 0) {
            return;
        }

        tokens.value = {
            ...tokens.value,
            [chainId]: {
                items: tokens.value[chainId]?.items ?? [],
                loading: true,
                error: null,
            },
        };

        // A token the user asked for is read individually; one that fails to
        // read is dropped from this pass rather than taking the list with it,
        // because a dead contract must not hide the assets that do answer.
        const manual = await Promise.all(
            mine.map(async (entry) => {
                try {
                    return await chain.readToken?.(
                        entry.address,
                        account.address,
                        rpcFor(chainId),
                    );
                } catch {
                    return undefined;
                }
            }),
        );

        try {
            const indexed = chain.fetchTokens
                ? await chain.fetchTokens(account.address, rpcFor(chainId))
                : [];

            tokens.value = {
                ...tokens.value,
                [chainId]: {
                    items: mergeTokens(
                        indexed,
                        manual.filter(
                            (token): token is WalletTokenBalance =>
                                token !== undefined,
                        ),
                    ),
                    loading: false,
                    error: null,
                },
            };
        } catch (error) {
            tokens.value = {
                ...tokens.value,
                [chainId]: {
                    items: manual.filter(
                        (token): token is WalletTokenBalance =>
                            token !== undefined,
                    ),
                    loading: false,
                    error:
                        error instanceof Error
                            ? error.message
                            : 'Tokens unavailable',
                },
            };
        }
    };

    /**
     * Track a token by contract address. Returns null once it is on the list,
     * or why the contract could not be read — a wrong address is the common
     * case here, and it has to fail before anything is stored.
     */
    const addToken = async (
        chainId: WalletChainId,
        contract: string,
    ): Promise<string | null> => {
        const chain = walletChain(chainId);
        const account = accounts.value.find(
            (candidate) => candidate.chain === chainId,
        );

        if (!chain.readToken || !account) {
            return 'This network cannot hold tokens';
        }

        try {
            // Read it before storing it: a contract that cannot answer
            // symbol() and decimals() is not a token this wallet can render.
            await chain.readToken(contract, account.address, rpcFor(chainId));
        } catch {
            return 'That address did not answer as a token contract';
        }

        const next = withToken(manualTokens.value, chainId, contract);
        manualTokens.value = next;
        writeManualTokens(next);
        await refreshTokens(chainId);

        return null;
    };

    /** Stop tracking a token. The balance stays on chain, only the row goes. */
    const removeToken = async (
        chainId: WalletChainId,
        contract: string,
    ): Promise<void> => {
        const next = withoutToken(manualTokens.value, chainId, contract);
        manualTokens.value = next;
        writeManualTokens(next);
        tokens.value = {
            ...tokens.value,
            [chainId]: {
                items: (tokens.value[chainId]?.items ?? []).filter(
                    (token) => !sameToken(token.address, contract),
                ),
                loading: false,
                error: tokens.value[chainId]?.error ?? null,
            },
        };
        await refreshTokens(chainId);
    };

    /**
     * Live fee tiers for one chain. A failure leaves the previous quote in
     * place and is reported by the absence of a fresh one — the send screen
     * refuses to build a transaction it cannot price.
     */
    const refreshFees = async (
        chainId: WalletChainId,
        token: string | null = null,
        toContract = false,
    ): Promise<void> => {
        const chain = walletChain(chainId);
        const account = accounts.value.find(
            (candidate) => candidate.chain === chainId,
        );

        if (!chain.fetchFees || !account) {
            return;
        }

        try {
            fees.value = {
                ...fees.value,
                [feeKey(chainId, token, toContract)]: await chain.fetchFees({
                    address: account.address,
                    rpcUrl: rpcFor(chainId),
                    token,
                    toContract,
                }),
            };
        } catch {
            fees.value = {
                ...fees.value,
                [feeKey(chainId, token, toContract)]: [],
            };
        }
    };

    /**
     * Whether an address has code behind it.
     *
     * Asked by the send screen about a recipient, because paying a contract
     * costs several times what paying a plain address does and the quote has
     * to say so before the sentence above the signature is read. Chains that
     * cannot answer say "no", which is the shape of every non-EVM chain here.
     */
    const recipientIsContract = async (
        chainId: WalletChainId,
        address: string,
    ): Promise<boolean> => {
        const chain = walletChain(chainId);

        return chain.hasCode ? chain.hasCode(address, rpcFor(chainId)) : false;
    };

    /**
     * Read one token without adding it to the tracked list — what this
     * account holds of it, and how the contract counts.
     */
    const readToken = async (
        chainId: WalletChainId,
        contract: string,
    ): Promise<WalletTokenBalance | null> => {
        const chain = walletChain(chainId);
        const account = accounts.value.find(
            (candidate) => candidate.chain === chainId,
        );

        if (!chain.readToken || !account) {
            return null;
        }

        return chain.readToken(contract, account.address, rpcFor(chainId));
    };

    /** Everything in existence of a token, for shares rather than amounts. */
    const readTokenSupply = async (
        chainId: WalletChainId,
        contract: string,
    ): Promise<bigint | null> => {
        const chain = walletChain(chainId);

        return chain.readTokenSupply
            ? chain.readTokenSupply(contract, rpcFor(chainId))
            : null;
    };

    /**
     * Sign a plain-text challenge with one chain's key.
     *
     * Spends nothing and approves nothing: it is how the browser proves to a
     * server that it holds the key behind an address. The caller must have
     * shown the user what they are signing.
     */
    const signMessage = async (
        chainId: WalletChainId,
        message: string,
    ): Promise<string> => {
        const chain = walletChain(chainId);

        if (!chain.signMessage) {
            throw new Error(`${chain.label} cannot sign messages`);
        }

        return chain.signMessage(sourceFor(chainId), message);
    };

    /**
     * Mint one NFT into the network's shared collection.
     *
     * The only write in this wallet that is not a payment, and it goes through
     * the same door as one: the key is derived inside `sourceFor`, used, and
     * dropped. `quote` is the gas limit and price the user was shown and held
     * a button to agree to — the mint is signed for those numbers or not at
     * all.
     */
    const mintNft = async (
        chainId: WalletChainId,
        uri: string,
        quote: MintQuote,
    ): Promise<string> => {
        const chain = walletChain(chainId);
        const target = chain.chainId ? nftChain(chain.chainId) : null;

        if (!target?.collection) {
            throw new Error(`${chain.label} has no collection to mint into`);
        }

        return submitMint(
            sourceFor(chainId),
            uri,
            target,
            quote,
            rpcFor(chainId),
        );
    };

    /* ---------------------------------------------------------------- dex --- */

    /**
     * What the network charges per unit of gas right now.
     *
     * Screens that build something other than a transfer — a swap, a wrap —
     * price it against this, so the number under a hold button is the same one
     * a send would have used, floors and all.
     */
    const gasPrice = async (
        chainId: WalletChainId,
        tier: WalletFeeTier = 'normal',
    ): Promise<bigint> => {
        const chain = walletChain(chainId);

        if (!chain.gasPrice) {
            throw new Error(`${chain.label} does not price gas`);
        }

        return chain.gasPrice(tier, rpcFor(chainId));
    };

    /**
     * Trade one asset for another on the network's own exchange.
     *
     * `quote` is the route, the floor and the gas the user read and held a
     * button for — nothing is re-quoted between the hold and the signature.
     * The output goes to this wallet's own address on that chain: a swap that
     * could pay out somewhere else is a transfer wearing a swap's clothes.
     */
    const swap = async (
        chainId: WalletChainId,
        quote: SwapQuote,
        onApproved?: (hash: string) => void,
    ): Promise<SwapReceipt> => {
        const account = accounts.value.find(
            (candidate) => candidate.chain === chainId,
        );

        if (!account) {
            throw new Error('This account has no address on that network');
        }

        const source = sourceFor(chainId);

        busy.value = true;

        try {
            return await executeSwap(source, {
                quote,
                recipient: account.address,
                rpcUrl: rpcFor(chainId),
                onApproved,
            });
        } finally {
            busy.value = false;
        }
    };

    /**
     * A swap that leaves the chain.
     *
     * The same shape as `swap()` and deliberately a separate action: this one
     * signs a route somebody else quoted, on a contract this wallet did not
     * write, and there is no cancel between the deposit and the delivery. The
     * origin leg is the only part signed here — everything after it belongs to
     * the router, which is why the receipt carries a request id rather than
     * promising an outcome.
     */
    const crossSwap = async (
        chainId: WalletChainId,
        quote: CrossQuote,
        onStep?: (step: CrossStep, hash: string) => void,
    ): Promise<CrossReceipt> => {
        const source = sourceFor(chainId);

        busy.value = true;

        try {
            return await executeCrossSwap(source, {
                quote,
                chain: chainId,
                rpcUrl: rpcFor(chainId),
                onStep,
            });
        } finally {
            busy.value = false;
        }
    };

    /**
     * Farming: put an LP position to work, take it back, or take the reward.
     *
     * Three calls rather than one, because they are three different agreements
     * — one of them costs an allowance, one moves a stake and one moves only
     * what the stake has already earned. The gas price arrives with the
     * request, so what is signed is the number the screen quoted rather than
     * whatever the pool happened to be charging a moment later.
     */
    const farm = {
        stake: async (
            chainId: WalletChainId,
            request: {
                chainId: number;
                pid: number;
                stakingToken: string;
                amount: bigint;
                allowance: bigint;
                gasPrice: bigint;
            },
            onApproved?: (hash: string) => void,
        ): Promise<EarnReceipt> => {
            const source = sourceFor(chainId);

            busy.value = true;

            try {
                return await stakeLp(source, {
                    ...request,
                    rpcUrl: rpcFor(chainId),
                    onApproved,
                });
            } finally {
                busy.value = false;
            }
        },
        unstake: async (
            chainId: WalletChainId,
            request: {
                chainId: number;
                pid: number;
                amount: bigint;
                gasPrice: bigint;
            },
        ): Promise<EarnReceipt> => {
            const source = sourceFor(chainId);

            busy.value = true;

            try {
                return await unstakeLp(source, {
                    ...request,
                    rpcUrl: rpcFor(chainId),
                });
            } finally {
                busy.value = false;
            }
        },
        claim: async (
            chainId: WalletChainId,
            request: { chainId: number; pid: number; gasPrice: bigint },
        ): Promise<EarnReceipt> => {
            const source = sourceFor(chainId);

            busy.value = true;

            try {
                return await claimReward(source, {
                    ...request,
                    rpcUrl: rpcFor(chainId),
                });
            } finally {
                busy.value = false;
            }
        },
    };

    /**
     * The source leg of a bridge transfer: one ordinary transfer to the
     * bridge's deposit address on this chain.
     *
     * Nothing about it is special, which is the point — the wallet signs a
     * send with a known recipient and the relayer does the rest. Kept here
     * rather than in the screen for the one reason every signing path is:
     * the key source never leaves this closure.
     */
    const bridgeDeposit = async (
        chainId: WalletChainId,
        request: {
            chainId: number;
            rpcUrl: string;
            deposit: string;
            contract: string | null;
            amount: bigint;
            gasPrice: bigint;
            gasLimit: bigint;
        },
    ): Promise<BridgeLock> => {
        const source = sourceFor(chainId);

        busy.value = true;

        try {
            return await lockOnEvm(source, request);
        } finally {
            busy.value = false;
        }
    };

    /** Turn the network's coin into its ERC20 wrapper, or back again. */
    const wrap = async (
        chainId: WalletChainId,
        quote: WrapQuote,
    ): Promise<string> => {
        const source = sourceFor(chainId);

        busy.value = true;

        try {
            return await executeWrap(source, {
                quote,
                rpcUrl: rpcFor(chainId),
            });
        } finally {
            busy.value = false;
        }
    };

    /* ---------------------------------------------------------------- chat --- */

    /**
     * The EVM account this wallet chats as.
     *
     * Chat is addressed by EVM address, and one key produces the same address
     * on every EVM network — so which network it is read on does not change
     * who you are. Cyberia is preferred because that is this wallet's home
     * chain; an account imported as a bare key on another EVM network still
     * chats, from the one network it exists on.
     */
    const chatAccount = (): WalletAccount | null =>
        accounts.value.find(
            (account) =>
                account.chain === 'cyberia' && account.family === 'evm',
        ) ??
        accounts.value.find((account) => account.family === 'evm') ??
        null;

    /**
     * Who this wallet is in a conversation.
     *
     * The public half only. The messaging private key is derived on demand
     * inside this closure, used, and dropped — it is never returned, never
     * stored and never put in reactive state, exactly like the seed.
     *
     * Null means this account cannot chat: a watched address has no key to
     * encrypt with, which is the same answer it gives to spending.
     */
    const chatIdentity = (): {
        address: string;
        publicKey: string;
        chain: WalletChainId;
    } | null => {
        const account = chatAccount();
        const record = activeRecord();

        if (!vault || !account || record?.kind === 'watch') {
            return null;
        }

        return {
            address: account.address.toLowerCase(),
            publicKey: chatPublicKey(evmChatKey(sourceFor(account.chain))),
            chain: account.chain,
        };
    };

    /** The other end of a message, whichever direction it went. */
    const chatPeer = (meta: ChatMeta): string => {
        const self = chatAccount()?.address.toLowerCase() ?? '';

        return meta.from.toLowerCase() === self
            ? meta.to.toLowerCase()
            : meta.from.toLowerCase();
    };

    /**
     * The key one conversation is encrypted under, derived once per peer.
     *
     * Cached because every message in a thread needs it and an ECDH per
     * message would make a long thread visibly slow; keyed by the peer's
     * *public key* as well as their address, so a peer who rotates keys gets a
     * new entry rather than a stale one.
     */
    const conversationKeyFor = async (
        peerPublicKey: string,
        peer: string,
    ): Promise<CryptoKey> => {
        const account = chatAccount();

        if (!account) {
            throw new Error('This wallet has no EVM account to chat from');
        }

        const self = account.address.toLowerCase();
        const cacheKey = `${self}:${peer.toLowerCase()}:${peerPublicKey.toLowerCase()}`;
        const cached = conversationKeys.get(cacheKey);

        if (cached) {
            return cached;
        }

        const key = await conversationKey(
            evmChatKey(sourceFor(account.chain)),
            peerPublicKey,
            self,
            peer,
        );

        conversationKeys.set(cacheKey, key);

        return key;
    };

    /** Seal one message for a peer whose published key has been verified. */
    const chatSeal = async (
        peerPublicKey: string,
        meta: ChatMeta,
        text: string,
    ): Promise<ChatEnvelope> =>
        sealMessage(
            await conversationKeyFor(peerPublicKey, chatPeer(meta)),
            meta,
            text,
        );

    /**
     * Open one message, or throw.
     *
     * A throw means the envelope, the key or the metadata around it is not
     * what it claims — the caller marks that message unreadable rather than
     * guessing at what it said.
     */
    const chatOpen = async (
        peerPublicKey: string,
        meta: ChatMeta,
        envelope: ChatEnvelope,
    ): Promise<string> =>
        openMessage(
            await conversationKeyFor(peerPublicKey, chatPeer(meta)),
            meta,
            envelope,
        );

    /**
     * Broadcast a payment. The caller is expected to have shown the user a
     * confirmation step first — this is the point of no return.
     */
    const send = async (
        chainId: WalletChainId,
        to: string,
        amount: string,
        tier: WalletFeeTier = 'normal',
        token: WalletTokenBalance | null = null,
    ): Promise<string> => {
        const chain = walletChain(chainId);

        if (!chain.send) {
            throw new Error(`${chain.label} payments are not supported here`);
        }

        if (!chain.isValidAddress(to.trim())) {
            throw new Error(`Not a valid ${chain.label} address`);
        }

        // Built before the busy flag, so a watch-only account fails here
        // rather than after the screen has committed to sending something.
        const source = sourceFor(chainId);

        busy.value = true;

        try {
            return await chain.send(source, {
                to: to.trim(),
                // A token counts in its own units, not the chain's: sending
                // 5 USDC on a six-decimal contract is 5_000_000, and using the
                // chain's eighteen would move a millionth of what was typed.
                amount: parseUnits(amount, token?.decimals ?? chain.decimals),
                tier,
                rpcUrl: rpcFor(chainId),
                token: token?.address ?? null,
            });
        } finally {
            busy.value = false;
        }
    };

    /* ------------------------------------------------------------- arena --- */

    const arenaSecretKey = (
        contract: string,
        gameId: bigint,
        player: string,
    ): string => `${contract.toLowerCase()}:${gameId}:${player.toLowerCase()}`;

    const arenaSecret = (
        contract: string,
        gameId: bigint,
        player: string,
    ): ArenaSecretRecord | null => {
        if (!vault) {
            return null;
        }

        const key = arenaSecretKey(contract, gameId, player);

        return (
            vault.arenaSecrets.find(
                (candidate) =>
                    arenaSecretKey(
                        candidate.contract,
                        BigInt(candidate.gameId),
                        candidate.player,
                    ) === key,
            ) ?? null
        );
    };

    const arenaCreate = async (
        contract: string,
        stake: bigint,
    ): Promise<{ hash: string; gameId?: bigint }> => {
        busy.value = true;

        try {
            return await createArenaGame(
                sourceFor('cyberia'),
                contract,
                stake,
                rpcFor('cyberia'),
            );
        } finally {
            busy.value = false;
        }
    };

    const arenaJoin = async (
        contract: string,
        gameId: bigint,
        stake: bigint,
    ): Promise<string> => {
        busy.value = true;

        try {
            return (
                await joinArenaGame(
                    sourceFor('cyberia'),
                    contract,
                    gameId,
                    stake,
                    rpcFor('cyberia'),
                )
            ).hash;
        } finally {
            busy.value = false;
        }
    };

    /** Seal the reveal material before broadcasting the commitment. */
    const arenaCommit = async (
        contract: string,
        gameId: bigint,
        player: string,
        move: ArenaMove,
    ): Promise<string> => {
        if (!vault) {
            throw new Error('Wallet is locked');
        }

        const existing = arenaSecret(contract, gameId, player);
        if (existing && existing.move !== move) {
            throw new Error('A different move is already sealed for this game');
        }

        const record: ArenaSecretRecord = existing ?? {
            contract,
            gameId: gameId.toString(),
            player,
            move,
            secret: createArenaSecret(),
            createdAt: new Date().toISOString(),
        };
        if (!existing) {
            await commit({ arenaSecrets: [...vault.arenaSecrets, record] });
        }

        busy.value = true;

        try {
            return (
                await commitArenaMove(
                    sourceFor('cyberia'),
                    contract,
                    gameId,
                    arenaCommitment(
                        contract,
                        gameId,
                        player,
                        move,
                        record.secret,
                    ),
                    rpcFor('cyberia'),
                )
            ).hash;
        } finally {
            busy.value = false;
        }
    };

    const arenaReveal = async (
        contract: string,
        gameId: bigint,
        player: string,
    ): Promise<string> => {
        const saved = arenaSecret(contract, gameId, player);

        if (!saved) {
            throw new Error('This vault has no reveal secret for that game');
        }

        busy.value = true;

        try {
            const result = await revealArenaMove(
                sourceFor('cyberia'),
                contract,
                gameId,
                saved.move,
                saved.secret,
                rpcFor('cyberia'),
            );

            if (!vault) {
                throw new Error('Wallet locked before the reveal was saved');
            }

            await commit({
                arenaSecrets: vault.arenaSecrets.filter(
                    (candidate) =>
                        arenaSecretKey(
                            candidate.contract,
                            BigInt(candidate.gameId),
                            candidate.player,
                        ) !== arenaSecretKey(contract, gameId, player),
                ),
            });

            return result.hash;
        } finally {
            busy.value = false;
        }
    };

    const arenaSettle = async (
        contract: string,
        gameId: bigint,
        method: 'resolveGame' | 'cancelExpiredGame' | 'claimPayout',
    ): Promise<string> => {
        busy.value = true;

        try {
            return (
                await settleArenaGame(
                    sourceFor('cyberia'),
                    contract,
                    gameId,
                    method,
                    rpcFor('cyberia'),
                )
            ).hash;
        } finally {
            busy.value = false;
        }
    };

    return {
        chains: computed(() => walletChains()),
        customNetworks: computed(() => customNetworks.value),
        addNetwork,
        removeNetwork,
        /** Ids of the shipped networks this device has switched on. */
        enabledNetworks: computed(() => enabledNetworks.value),
        enableNetwork,
        disableNetwork,
        tokens: computed(() => tokens.value),
        manualTokens: computed(() => manualTokens.value),
        /** The quote for one asset — the native coin when `token` is null. */
        feesFor: (
            chainId: WalletChainId,
            token: string | null = null,
            toContract = false,
        ) => fees.value[feeKey(chainId, token, toContract)] ?? [],
        recipientIsContract,
        refreshTokens,
        addToken,
        removeToken,
        readToken,
        readTokenSupply,
        signMessage,
        mintNft,
        gasPrice,
        swap,
        crossSwap,
        farm,
        bridgeDeposit,
        wrap,
        /** Encrypted chat: the public identity, and sealing under it. */
        chatIdentity,
        chatSeal,
        chatOpen,
        accounts: computed(() => accounts.value),
        /** The vault-level accounts: seed-derived, imported and watched. */
        accountRecords: computed(() => accountRecords.value),
        activeAccountId: computed(() => activeAccountId.value),
        activeAccount: computed(
            () =>
                accountRecords.value.find(
                    (record) => record.id === activeAccountId.value,
                ) ?? null,
        ),
        switchAccount,
        deriveAccount,
        importAccount,
        renameAccount,
        removeAccount,
        balances: computed(() => balances.value),
        history: computed(() => history.value),
        fees: computed(() => fees.value),
        exists: computed(() => exists.value),
        unlocked: computed(() => unlocked.value),
        busy: computed(() => busy.value),
        autoLockMinutes: computed(() => autoLockMinutes.value),
        setAutoLock,
        isValidMnemonic,
        adopt,
        unlock,
        lock,
        touch,
        reveal,
        forget,
        refreshBalances,
        refreshHistory,
        refreshFees,
        send,
        arenaSecret,
        arenaCreate,
        arenaJoin,
        arenaCommit,
        arenaReveal,
        arenaSettle,
    };
};
