import { evmChainRpcMap } from '@/lib/evmChains';
import type { EthereumProvider } from '@/types/global';

/**
 * Multi-wallet disambiguation.
 *
 * When several EIP-1193 wallets are installed (MetaMask + Phantom + Rabby …),
 * they all inject into `window.ethereum`, and the last one to load wins. That
 * is why clicking "Connect MetaMask" can pop up Phantom instead.
 *
 * EIP-6963 fixes this: each wallet announces itself with a stable `rdns`
 * identifier on an event. We listen for those announcements and pick the
 * provider the user actually asked for. Legacy fallbacks (`providers[]` array
 * and vendor flags) cover wallets that predate EIP-6963.
 *
 * On top of the injected wallets, WalletConnect (QR / mobile deep link) is
 * offered as one more provider entry when VITE_WALLETCONNECT_PROJECT_ID is
 * configured, which covers MetaMask Mobile, Trust, Rainbow, Ledger Live,
 * OKX, SafePal and every other WalletConnect-v2 wallet.
 */

type Eip6963ProviderInfo = {
    uuid: string;
    name: string;
    icon: string;
    rdns: string;
};

type Eip6963ProviderDetail = {
    info: Eip6963ProviderInfo;
    provider: EthereumProvider;
};

export type EvmWalletProvider = {
    id: string;
    name: string;
    icon?: string;
    rdns?: string;
    /** Missing only for the WalletConnect entry until its lazy SDK init. */
    provider?: EthereumProvider;
    source: 'eip6963' | 'legacy' | 'walletconnect';
};

const RDNS = {
    metamask: 'io.metamask',
    phantom: 'app.phantom',
} as const;

export const WALLETCONNECT_WALLET_ID = 'walletconnect';

const WALLETCONNECT_ICON =
    'data:image/svg+xml,' +
    encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">' +
            '<rect width="40" height="40" rx="8" fill="#3B99FC"/>' +
            '<path fill="#fff" d="M12.2 16.5c4.3-4.2 11.3-4.2 15.6 0l.5.5c.2.2.2.5 0 .8l-1.8 1.7c-.1.1-.3.1-.4 0l-.7-.7c-3-2.9-7.9-2.9-10.9 0l-.7.7c-.1.1-.3.1-.4 0l-1.8-1.7c-.2-.2-.2-.6 0-.8l.6-.5zm19.3 3.6 1.6 1.5c.2.2.2.6 0 .8l-7.1 7c-.2.2-.6.2-.8 0l-5.1-4.9c0-.1-.1-.1-.2 0l-5 4.9c-.2.2-.6.2-.8 0l-7.2-7c-.2-.2-.2-.6 0-.8l1.6-1.5c.2-.2.6-.2.8 0l5.1 4.9c0 .1.1.1.2 0l5-4.9c.2-.2.6-.2.8 0l5.1 4.9c0 .1.1.1.2 0l5-4.9c.2-.2.6-.2.8 0z"/>' +
            '</svg>',
    );

const walletConnectProjectId = (): string | undefined => {
    const value = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || '5f52c65c603e72246272d8cb3984b7cc';

    return typeof value === 'string' && value !== '' ? value : undefined;
};

export const isWalletConnectConfigured = (): boolean =>
    walletConnectProjectId() !== undefined;

/**
 * A previous WalletConnect pairing persists in localStorage under wc@2 keys;
 * its presence is the cue that a silent (no-QR-modal) reconnect can work.
 */
export const hasWalletConnectSession = (): boolean => {
    if (typeof window === 'undefined' || !isWalletConnectConfigured()) {
        return false;
    }

    try {
        for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);

            if (key?.startsWith('wc@2:client') && key.includes('session')) {
                return window.localStorage.getItem(key) !== '[]';
            }
        }
    } catch {
        // Storage blocked (private mode) — treat as no session.
    }

    return false;
};

let walletConnectProvider: EthereumProvider | null = null;
let walletConnectInit: Promise<EthereumProvider> | null = null;

/**
 * Lazily initialise the WalletConnect provider (the SDK is heavy, so it is
 * only imported when the user actually picks WalletConnect or a previous
 * session exists). Ethereum mainnet is the required chain so that every
 * wallet can pair; Cyberia and the other popular chains ride along as
 * optional chains.
 */
export const initWalletConnectProvider = (): Promise<EthereumProvider> => {
    const projectId = walletConnectProjectId();

    if (!projectId) {
        return Promise.reject(new Error('WalletConnect is not configured'));
    }

    walletConnectInit ??= import('@walletconnect/ethereum-provider').then(
        async ({ EthereumProvider: WcEthereumProvider }) => {
            const rpcMap = evmChainRpcMap();
            const provider = await WcEthereumProvider.init({
                projectId,
                chains: [1],
                optionalChains: Object.keys(rpcMap).map(Number) as [
                    number,
                    ...number[],
                ],
                rpcMap,
                showQrModal: true,
                metadata: {
                    name: 'Cyberia',
                    description: 'Cyberia — bridge, DEX and ecosystem apps',
                    url: window.location.origin,
                    icons: [window.location.origin + '/favicon.ico'],
                },
            });

            walletConnectProvider = provider as unknown as EthereumProvider;

            return walletConnectProvider;
        },
    );

    walletConnectInit.catch(() => {
        walletConnectInit = null;
    });

    return walletConnectInit;
};

const walletConnectEntry = (): EvmWalletProvider => ({
    id: WALLETCONNECT_WALLET_ID,
    name: 'WalletConnect',
    icon: WALLETCONNECT_ICON,
    provider: walletConnectProvider ?? undefined,
    source: 'walletconnect',
});

const discovered = new Map<string, Eip6963ProviderDetail>();
let selectedProvider: EvmWalletProvider | null = null;

if (typeof window !== 'undefined') {
    window.addEventListener('eip6963:announceProvider', (event) => {
        const detail = (event as CustomEvent<Eip6963ProviderDetail>).detail;

        if (detail?.info?.uuid && detail.provider) {
            discovered.set(detail.info.uuid, detail);
        }
    });
    // Ask any already-loaded wallets to (re)announce themselves.
    window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export const requestEvmWalletProviders = (): void => {
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('eip6963:requestProvider'));
    }
};

/** Pull MetaMask out of the legacy `window.ethereum.providers` array. */
const fromLegacyArray = (
    predicate: (p: EthereumProvider) => boolean,
): EthereumProvider | null => {
    const eth = window.ethereum;
    const list = eth?.providers;

    if (Array.isArray(list)) {
        return list.find(predicate) ?? null;
    }

    return eth && predicate(eth) ? eth : null;
};

const providerFingerprint = (provider: EthereumProvider): string => {
    const flags = [
        provider.isMetaMask ? 'metamask' : '',
        provider.isPhantom ? 'phantom' : '',
        provider.isCoinbaseWallet ? 'coinbase' : '',
        provider.isTrust || provider.isTrustWallet ? 'trust' : '',
        provider.isRabby ? 'rabby' : '',
        provider.isOkxWallet || provider.isOKExWallet ? 'okx' : '',
        provider.isBraveWallet ? 'brave' : '',
        provider.isBinance ? 'binance' : '',
    ].filter(Boolean);

    return flags.join(':') || 'injected';
};

const legacyName = (provider: EthereumProvider): string => {
    if (provider.isMetaMask && !provider.isPhantom) {
        return 'MetaMask';
    }

    if (provider.isCoinbaseWallet) {
        return 'Coinbase Wallet';
    }

    if (provider.isTrust || provider.isTrustWallet) {
        return 'Trust Wallet';
    }

    if (provider.isRabby) {
        return 'Rabby';
    }

    if (provider.isOkxWallet || provider.isOKExWallet) {
        return 'OKX Wallet';
    }

    if (provider.isBraveWallet) {
        return 'Brave Wallet';
    }

    if (provider.isBinance) {
        return 'Binance Wallet';
    }

    if (provider.isPhantom) {
        return 'Phantom EVM';
    }

    return 'Injected wallet';
};

const pushUnique = (
    list: EvmWalletProvider[],
    item: EvmWalletProvider,
): void => {
    if (list.some((existing) => existing.provider === item.provider)) {
        return;
    }

    list.push(item);
};

export const getEvmWalletProviders = (): EvmWalletProvider[] => {
    if (typeof window === 'undefined') {
        return [];
    }

    requestEvmWalletProviders();

    const providers: EvmWalletProvider[] = [];

    for (const detail of discovered.values()) {
        pushUnique(providers, {
            id: `eip6963:${detail.info.uuid}`,
            name: detail.info.name,
            icon: detail.info.icon,
            rdns: detail.info.rdns,
            provider: detail.provider,
            source: 'eip6963',
        });
    }

    const legacy = window.ethereum?.providers ?? [];

    for (const provider of legacy) {
        pushUnique(providers, {
            id: `legacy:${providerFingerprint(provider)}`,
            name: legacyName(provider),
            provider,
            source: 'legacy',
        });
    }

    if (window.ethereum) {
        pushUnique(providers, {
            id: `legacy:${providerFingerprint(window.ethereum)}`,
            name: legacyName(window.ethereum),
            provider: window.ethereum,
            source: 'legacy',
        });
    }

    providers.sort((a, b) => a.name.localeCompare(b.name));

    // WalletConnect goes last: injected wallets first, QR/mobile as fallback.
    if (isWalletConnectConfigured()) {
        providers.push(walletConnectEntry());
    }

    return providers;
};

export const getEvmWalletProvider = (id: string): EvmWalletProvider | null => {
    return getEvmWalletProviders().find((wallet) => wallet.id === id) ?? null;
};

/**
 * Resolve a picker entry to a live EIP-1193 provider, initialising the
 * WalletConnect SDK on demand. Returns the entry with `provider` guaranteed.
 */
export const resolveEvmWalletProvider = async (
    wallet: EvmWalletProvider,
): Promise<EvmWalletProvider & { provider: EthereumProvider }> => {
    if (wallet.provider) {
        return wallet as EvmWalletProvider & { provider: EthereumProvider };
    }

    if (wallet.source === 'walletconnect') {
        const provider = await initWalletConnectProvider();

        return { ...wallet, provider };
    }

    throw new Error(`${wallet.name} is not available`);
};

export const selectEvmWalletProvider = (
    wallet: EvmWalletProvider | null,
): void => {
    selectedProvider = wallet;
};

export const getSelectedEvmProvider = (): EthereumProvider | null =>
    selectedProvider?.provider ?? getEvmProvider();

export const getSelectedEvmWalletProvider = (): EvmWalletProvider | null =>
    selectedProvider;

/**
 * Resolve the genuine MetaMask provider, or null if MetaMask is not installed.
 * Triggers a fresh EIP-6963 announcement on every call so late-injecting wallets
 * are picked up.
 */
export const getMetaMaskProvider = (): EthereumProvider | null => {
    if (typeof window === 'undefined') {
        return null;
    }

    window.dispatchEvent(new Event('eip6963:requestProvider'));

    const announced = [...discovered.values()].find(
        (detail) => detail.info.rdns === RDNS.metamask,
    );

    if (announced) {
        return announced.provider;
    }

    // Legacy: a real MetaMask sets isMetaMask and is not Phantom in disguise.
    return fromLegacyArray((p) => !!p.isMetaMask && !p.isPhantom);
};

export const isMetaMaskInstalled = (): boolean =>
    getMetaMaskProvider() !== null;

/**
 * Best-effort EVM provider for read-only / generic use when no specific wallet
 * was requested: prefer MetaMask, then any announced provider, then the raw
 * injected object.
 */
export const getEvmProvider = (): EthereumProvider | null => {
    return (
        getMetaMaskProvider() ??
        getEvmWalletProviders().find((wallet) => wallet.provider)?.provider ??
        window.ethereum ??
        null
    );
};
