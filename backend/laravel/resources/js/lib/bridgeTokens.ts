export type BridgeTokenSymbol =
    | 'CYBER.sol'
    | 'SOL'
    | 'USDC'
    | 'USDT'
    | 'USDG'
    | 'HATCHER'
    | 'ORBV'
    | 'YTN'
    | 'BTC'
    | 'LTC'
    | 'XMR'
    | 'KRSQ'
    | 'GOAL'
    | 'BNB'
    | 'ETH'
    // Config-driven tokens added in config/bridge.php arrive via server props.
    | (string & {});

export type BridgeTokenInfo = {
    symbol: BridgeTokenSymbol;
    /** Token contract address on Cyberia EVM (chainId 49406). */
    evmAddress: `0x${string}`;
    /** Token mint address on Solana. */
    solanaMint: string;
    /** Decimals used by the EVM ERC20. */
    evmDecimals: number;
    /** Decimals used by the Solana SPL token. */
    solanaDecimals: number;
    /**
     * Bridge mechanic.
     * - 'native': goes through CyberBridge contract (wrapped CYBER.sol — bridge contract is the wCYBER.sol owner).
     * - 'direct': plain ERC20.transfer to/from relayer hot wallet (real inventory; no mint authority).
     * - 'mint':   relayer EOA owns the wrapper contract and calls mint()/burnFrom() directly (USDC, USDT).
     */
    model: 'native' | 'direct' | 'mint';
    /** Whether the EVM-side token is on the SPL Token-2022 program (Token Extensions). */
    solanaTokenProgram: 'token' | 'token-2022';
};

export const BRIDGE_TOKENS: Record<string, BridgeTokenInfo> = {
    // CYBER.sol is a wrapped token — mint()/burn() on the EVM side live on the
    // WrappedCyberSol contract and are gated to the CyberBridge owner. The
    // relayer EOA cannot just ERC20.transfer because it holds no inventory.
    // So we go through the bridge contract (releaseCyberSol / redeemCyberSol).
    'CYBER.sol': {
        symbol: 'CYBER.sol',
        evmAddress: '0x7DcDa19Cf984ca708E5fA228AC148e7d82D508BA',
        solanaMint: 'E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump',
        evmDecimals: 18,
        solanaDecimals: 6,
        model: 'native',
        solanaTokenProgram: 'token-2022',
    },
    // SOL — native SOL bridged into a Cyberia wrapper (9-dec, matching
    // lamports; relayer-owned mint/burn). The Solana side is the native coin
    // (no mint) — deposits are plain system transfers to the hot wallet.
    SOL: {
        symbol: 'SOL',
        evmAddress: '0x53450B1d205f1e41d10B653FBBDEa74160dafFf4',
        solanaMint: '',
        evmDecimals: 9,
        solanaDecimals: 9,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
    // USDC/USDT on Cyberia are owner-mintable wrappers (Ownable + mint/burnFrom).
    // The relayer EOA is the owner, so we mint/burn directly without intermediation.
    USDC: {
        symbol: 'USDC',
        evmAddress: '0xdc25597B19799010047F17e9591EFE08EFd40077',
        solanaMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        evmDecimals: 6,
        solanaDecimals: 6,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
    USDG: {
        symbol: 'USDG',
        evmAddress: '0xDaDa615b767120cC0767067f075Ac799957508Da',
        solanaMint: '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH',
        evmDecimals: 6,
        solanaDecimals: 6,
        model: 'mint',
        solanaTokenProgram: 'token-2022',
    },
    USDT: {
        symbol: 'USDT',
        evmAddress: '0x94845aF24a3E431593A2b941b2b31836dE45185D',
        solanaMint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        evmDecimals: 6,
        solanaDecimals: 6,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
    // HATCHER — Solana-native token bridged to Cyberia (mint model: relayer EOA
    // owns the EVM wrapper, mint()s on bridge-IN / burnFrom()s on bridge-OUT).
    // The canonical SPL mint is Token-2022 / 6 decimals; the EVM wrapper uses 9
    // decimals (the bridge scales each side independently, like CYBER.sol 18/6).
    HATCHER: {
        symbol: 'HATCHER',
        evmAddress: '0x621021F18b6404123f98b1395c418868418ACF36',
        solanaMint: 'Cntmo5DJNQkB2vYyS4mUx2UoTW4mPrHgWefz8miZpump',
        evmDecimals: 9,
        solanaDecimals: 6,
        model: 'mint',
        solanaTokenProgram: 'token-2022',
    },
    // ORBV (Orbserv) — Solana-native pump.fun token bridged to Cyberia, same
    // mint model as HATCHER. Both the SPL mint (Token-2022) and the Cyberia
    // wrapper are 6 decimals.
    ORBV: {
        symbol: 'ORBV',
        evmAddress: '0x19E92D8475522FF6c8f3660372B9dc6674d85cC8',
        solanaMint: 'HQJwmK24WN3e87aQzNHnUVK4SaNgYfrR3tDkGgWTpump',
        evmDecimals: 6,
        solanaDecimals: 6,
        model: 'mint',
        solanaTokenProgram: 'token-2022',
    },
    YTN: {
        symbol: 'YTN',
        evmAddress: '0x3a5820Be90c3fB9c5F3Fb47a4859544193B0f8C6',
        solanaMint: '',
        evmDecimals: 18,
        solanaDecimals: 8,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
    BTC: {
        symbol: 'BTC',
        evmAddress: '0x9332081f308BC978fe259237850fA253131b46Fa',
        solanaMint: '',
        evmDecimals: 8,
        solanaDecimals: 8,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
    LTC: {
        symbol: 'LTC',
        evmAddress: '0x001AFD19C9d890b0cf0fcd6D654f9BFe4f264F14',
        solanaMint: '',
        evmDecimals: 8,
        solanaDecimals: 8,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
    XMR: {
        symbol: 'XMR',
        evmAddress: '0xe2E8D51C18d6e0FDDbb9Ff4BF63235D688dd00Ae',
        solanaMint: '',
        evmDecimals: 12,
        solanaDecimals: 12,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
    // TON jettons bridged into existing Cyberia wrappers (KRSQ/GOAL are 9-dec
    // jettons; the Cyberia ERC20s are 18-dec — the backend scales each side).
    KRSQ: {
        symbol: 'KRSQ',
        evmAddress: '0x4945419ccEEF0Dc70B054700DE2750A056B03eE3',
        solanaMint: '',
        evmDecimals: 18,
        solanaDecimals: 9,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
    GOAL: {
        symbol: 'GOAL',
        evmAddress: '0xEb91EC10462a249b9922D6D62FB2BE73Bd084ADe',
        solanaMint: '',
        evmDecimals: 18,
        solanaDecimals: 9,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
    // BNB — native BNB Chain coin bridged into a Cyberia wrapper (address from
    // server config BRIDGE_BNB_WRAPPER_ADDRESS; placeholder overridden at
    // runtime via bridgeConfig).
    BNB: {
        symbol: 'BNB',
        evmAddress: '0x0000000000000000000000000000000000000000',
        solanaMint: '',
        evmDecimals: 18,
        solanaDecimals: 18,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
    // TON — native Toncoin bridged into a Cyberia wrapper (18-dec ERC20; the
    // TON side is 9-dec and the backend scales each side). Deposits are signed
    // via TON Connect (Tonkeeper); the solana fields are unused.
    TON: {
        symbol: 'TON',
        evmAddress: '0x92aBF73698383176Aa2894F1f7263807C3a4e6e6',
        solanaMint: '',
        evmDecimals: 18,
        solanaDecimals: 9,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
    // ETH — one unified wrapper (canonical Cyberia ETH, 0xFDa2…1986); native
    // ETH on every source chain (Base, …) maps to it. The Base side is the
    // native coin; server config carries the per-chain identity.
    ETH: {
        symbol: 'ETH',
        evmAddress: '0xFDa2F6EEB11f1aCc7ccAb559133E8F07d9F81986',
        solanaMint: '',
        evmDecimals: 18,
        solanaDecimals: 18,
        model: 'mint',
        solanaTokenProgram: 'token',
    },
};

/**
 * CYBER.sol per 1 native CYBER for the optional sol_to_evm auto-conversion.
 * Mirrors CyberSolBurnSwap.RATE on Cyberia; the server sends the live value
 * via the `bridgeConvert` page prop, this is only the fallback default.
 */
export const CYBERSOL_TO_NATIVE_RATE = 1000;

export const SUPPORTED_TOKEN_SYMBOLS: BridgeTokenSymbol[] = [
    'CYBER.sol',
    'SOL',
    'USDC',
    'USDT',
    'USDG',
    'HATCHER',
    'ORBV',
    'YTN',
    'BTC',
    'LTC',
    'XMR',
];

export const tokenBySymbol = (symbol: string): BridgeTokenInfo | null => {
    if (BRIDGE_TOKENS[symbol]) {
        return BRIDGE_TOKENS[symbol];
    }

    return BRIDGE_TOKENS[symbol.toUpperCase()] ?? null;
};
