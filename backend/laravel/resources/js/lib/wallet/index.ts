import { defaultAccountRecords } from '@/lib/wallet/accounts';
import type {
    WalletAccountKind,
    WalletAccountRecord,
} from '@/lib/wallet/accounts';
import { walletChain, walletChains } from '@/lib/wallet/chains';
import type {
    WalletCapabilities,
    WalletChain,
    WalletChainFamily,
    WalletChainId,
    WalletMark,
} from '@/lib/wallet/chains';
import { seedSource } from '@/lib/wallet/keys';
import { seedFromMnemonic } from '@/lib/wallet/vault';

/**
 * The unified multichain wallet: one seed phrase, one derivation tree, one
 * address per supported chain.
 *
 * Everything a caller gets from here is public — addresses, paths, labels.
 * The seed exists only inside `deriveAccounts` and inside a single `send`
 * call; it is never returned, stored in module state, or logged.
 */

export type WalletAccount = {
    chain: WalletChainId;
    label: string;
    symbol: string;
    decimals: number;
    /** Which key this address belongs to — every `evm` account shares one. */
    family: WalletChainFamily;
    mark: WalletMark;
    /** Added by the user: a real account read through an unvetted endpoint. */
    custom: boolean;
    endpoint?: string;
    address: string;
    path: string;
    curve: 'secp256k1' | 'ed25519';
    capabilities: WalletCapabilities;
    note?: string;
    explorerUrl: string | null;
    /**
     * Where the key behind this address came from. A `key` or `watch` account
     * is not covered by the seed backup, and every screen that spends from one
     * has to keep saying so.
     */
    kind: WalletAccountKind;
};

const describe = (
    chain: WalletChain,
    address: string,
    path: string,
    kind: WalletAccountKind,
    capabilities: WalletCapabilities,
): WalletAccount => ({
    chain: chain.id,
    label: chain.label,
    symbol: chain.symbol,
    decimals: chain.decimals,
    family: chain.family,
    mark: chain.mark,
    custom: chain.custom ?? false,
    endpoint: chain.endpoint,
    address,
    path,
    curve: chain.curve,
    capabilities,
    note: chain.note,
    explorerUrl: chain.explorerAddressUrl(address),
    kind,
});

/**
 * The addresses one vault account holds.
 *
 * A seed account spans every registered chain at once — that is what a single
 * phrase means. An imported key or a watched address is one chain only, because
 * a key belongs to one curve and one address format, so the portfolio behind
 * such an account is honestly a single card rather than a grid with four
 * networks it cannot reach.
 *
 * The registry is read at call time rather than captured, because a network the
 * user adds has to produce an account without the wallet being reopened — and
 * because that account must come from the seed, not from anything stored
 * alongside the network's settings.
 */
export const deriveAccounts = (
    phrase: string,
    record: WalletAccountRecord = defaultAccountRecords()[0],
): WalletAccount[] => {
    if (record.kind === 'seed' || record.kind === 'phrase') {
        // An imported phrase is its own root: it walks the same paths, but the
        // vault's backup restores none of it, which is why the kind travels
        // out of here on every account it produces.
        const source = seedSource(
            seedFromMnemonic(record.kind === 'phrase' ? record.phrase : phrase),
            record.index,
        );

        /**
         * One derivation per key, not per network.
         *
         * Two chains of the same family walking the same path derive the same
         * address by definition — that is what "every EVM network shows one
         * address" means, and the path carries the coin type that makes the
         * Bitcoin family differ. Without this the catalogue turns one unlock
         * into 120 identical BIP-32 walks (~500ms), and every network switch
         * pays it again.
         */
        const derived = new Map<string, string>();

        return walletChains().flatMap((chain) => {
            const path = chain.path(record.index);
            const key = `${chain.family}:${path}`;

            // A chain that cannot answer for this account number is skipped
            // rather than rendered broken: Monero numbers subaddresses and
            // takes every index, but a custom fork could refuse one.
            try {
                const address = derived.get(key) ?? chain.derive(source);
                derived.set(key, address);

                return [
                    describe(
                        chain,
                        address,
                        path,
                        record.kind,
                        chain.capabilities,
                    ),
                ];
            } catch {
                return [];
            }
        });
    }

    let chain;

    try {
        chain = walletChain(record.chain);
    } catch {
        // The network this account was imported on has since been removed. The
        // account is still in the vault and can still be switched away from or
        // forgotten — it just has nothing to render, which is better than
        // taking the whole unlock down with it.
        return [];
    }

    return [
        describe(
            chain,
            record.address,
            record.kind === 'key' ? 'imported key' : 'watched address',
            record.kind,
            // A watched address is a public string and nothing else. Reading it
            // works exactly as it does for any account; signing never can, and
            // the capability has to say so here rather than let a send screen
            // build a transaction that dies at the last step.
            record.kind === 'watch'
                ? { ...chain.capabilities, send: false }
                : chain.capabilities,
        ),
    ];
};

/** Address for a single chain, without deriving the rest. */
export const deriveAddress = (
    phrase: string,
    chain: WalletChainId,
    index = 0,
): string =>
    walletChain(chain).derive(seedSource(seedFromMnemonic(phrase), index));

export {
    PRIMARY_ACCOUNT_ID,
    accountCanSpend,
    accountChain,
    accountDisplayName,
    accountInSeedBackup,
    accountKindLabel,
    accountName,
    defaultAccountRecords,
    importedAccountId,
    nextSeedIndex,
    phraseAccountId,
    seedAccountId,
} from '@/lib/wallet/accounts';
export type {
    KeyAccountRecord,
    PhraseAccountRecord,
    SeedAccountRecord,
    WalletAccountKind,
    WalletAccountRecord,
    WatchAccountRecord,
} from '@/lib/wallet/accounts';
export { evmChatKey, keySource, seedSource } from '@/lib/wallet/keys';
export type { WalletKeySource } from '@/lib/wallet/keys';
export {
    EVM_CONTRACT_SEND_GAS_CAP,
    WALLET_CHAINS,
    WALLET_FAMILY_GROUPS,
    WALLET_FEE_TIERS,
    formatUnits,
    nativeSendGas,
    parseUnits,
    setCatalogueWalletChains,
    setCustomWalletChains,
    walletChain,
    walletChains,
} from '@/lib/wallet/chains';
export type {
    WalletBuiltinChainId,
    WalletCapabilities,
    WalletChain,
    WalletChainFamily,
    WalletChainId,
    WalletFeeQuote,
    WalletFeeTier,
    WalletMark,
    WalletMarkShape,
    WalletTx,
    WalletTxStatus,
} from '@/lib/wallet/chains';
export {
    FORK_PRESETS,
    customNetworkId,
    customNetworkTag,
    customWalletChain,
    evmPresets,
    readCustomNetworks,
    validateCustomNetwork,
    writeCustomNetworks,
} from '@/lib/wallet/customChains';
export type {
    CustomEvmNetwork,
    CustomNetwork,
    CustomNetworkProblem,
    CustomUtxoNetwork,
} from '@/lib/wallet/customChains';
export {
    NETWORK_CATALOGUE,
    catalogueCapabilities,
    catalogueMark,
    catalogueNetwork,
    catalogueWalletChain,
    catalogueWalletChains,
    readEnabledNetworks,
    searchCatalogue,
    writeEnabledNetworks,
} from '@/lib/wallet/catalogue';
export type { CatalogueNetwork } from '@/lib/wallet/catalogue';
export type { UtxoAddressType } from '@/lib/wallet/utxo';
export {
    ARENA_ABI,
    arenaCommitment,
    arenaHasOpponent,
    arenaRecentGameIds,
    commitArenaMove,
    createArenaGame,
    createArenaSecret,
    joinArenaGame,
    readArenaGame,
    readRecentArenaGames,
    revealArenaMove,
    settleArenaGame,
} from '@/lib/wallet/arena';
export {
    arenaAction,
    arenaNeedsAction,
    arenaRole,
} from '@/lib/wallet/arenaState';
export type { ArenaAction, ArenaRole } from '@/lib/wallet/arenaState';
export type {
    ArenaGame,
    ArenaMove,
    ArenaResult,
    ArenaState,
} from '@/lib/wallet/arena';
export {
    ERC20_TRANSFER_GAS_CAP,
    blockscoutTokens,
    erc20Balance,
    erc20TotalSupply,
    mergeTokens,
    readErc20,
    sameToken,
    sendErc20,
} from '@/lib/wallet/erc20';
export type { WalletTokenBalance } from '@/lib/wallet/erc20';
export {
    LAIN_CHAT_CONTEXT,
    LAIN_CHAT_MEMORY,
    clearLainChat,
    forgetLainChats,
    readLainChat,
    writeLainChat,
} from '@/lib/wallet/lainChat';
export type { LainTurn } from '@/lib/wallet/lainChat';
export {
    MAX_MESSAGE_BYTES,
    chatFingerprint,
    chatKeyStatement,
    chatMessageId,
    chatPrivateKey,
    chatPublicKey,
    conversationId,
    conversationKey,
    isChatPublicKey,
    openMessage,
    sealMessage,
    verifyChatKey,
} from '@/lib/wallet/chatCrypto';
export type {
    ChatEnvelope,
    ChatKeyRecord,
    ChatMeta,
} from '@/lib/wallet/chatCrypto';
export {
    chatKeyVerifiedAt,
    clearChat,
    fetchChatEnvelopes,
    forgetWalletChats,
    lookupChatKey,
    markChatKeyVerified,
    markChatRead,
    pinChatKey,
    proveChatAddress,
    publishChatKey,
    readChatState,
    requestChatNonce,
    sendChatEnvelope,
    storeChatRows,
    unreadChatCount,
} from '@/lib/wallet/chat';
export type { ChatRow } from '@/lib/wallet/chat';
export {
    APPROVE_GAS,
    SWAP_GAS_CAP,
    applySlippage,
    executeSwap,
    forgetPoolEdges,
    hasSwap,
    poolEdges,
    priceImpactPct,
    quoteSwap,
    swapChainFor,
    swapChains,
    swapPaths,
    swapTxUrl,
} from '@/lib/wallet/swap';
export type { SwapAsset, SwapQuote, SwapReceipt } from '@/lib/wallet/swap';
export {
    WRAP_GAS_CAP,
    executeWrap,
    quoteWrap,
    wrapDirection,
} from '@/lib/wallet/wrap';
export type { WrapDirection, WrapQuote } from '@/lib/wallet/wrap';
export {
    readManualTokens,
    withToken,
    withoutToken,
    writeManualTokens,
} from '@/lib/wallet/tokenList';
export type { ManualToken } from '@/lib/wallet/tokenList';
export {
    createMnemonic,
    forgetVault,
    hasVault,
    isValidMnemonic,
    normalizeMnemonic,
    openVault,
    readVault,
    saveVault,
    seedFromMnemonic,
    unsealVault,
} from '@/lib/wallet/vault';
export type {
    ArenaSecretRecord,
    OpenedVault,
    VaultContents,
} from '@/lib/wallet/vault';
