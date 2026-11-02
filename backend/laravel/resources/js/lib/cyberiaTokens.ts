/**
 * Curated registry of well-known Cyberia ERC20s (mirrors
 * crypto/hardhat/deployments/cyberia-tokens.json plus DEX-native assets).
 * Token pickers seed from this list so real assets (e.g. BNB) show up even
 * before anyone opens a pool for them, while junk/test pairs from the
 * on-chain factory stay hidden.
 */

export type KnownToken = { address: string; symbol: string };

export const WCYBER_ADDRESS = '0x78272aAd03E4b9d7A9134e874BA6d419B534F6c9';
export const CYBER_SOL_ADDRESS = '0x7DcDa19Cf984ca708E5fA228AC148e7d82D508BA';
export const USDC_ADDRESS = '0xdc25597B19799010047F17e9591EFE08EFd40077';
export const USDT_ADDRESS = '0x94845aF24a3E431593A2b941b2b31836dE45185D';

export const KNOWN_TOKENS: KnownToken[] = [
    { address: WCYBER_ADDRESS, symbol: 'WCYBER' },
    { address: CYBER_SOL_ADDRESS, symbol: 'CYBER.sol' },
    { address: '0x992Fca0a89DD95afb17751f6CC233Adb9B089df5', symbol: 'ASH' },
    { address: '0x05cd1AFd5b2DF3CCA6cEAb80CbC21168ec981E8B', symbol: 'LAIN' },
    { address: '0xD8c1f812ADd03ccdE8D3c7F86FeAD181980CD7Ec', symbol: 'MINE' },
    { address: USDC_ADDRESS, symbol: 'USDC' },
    { address: USDT_ADDRESS, symbol: 'USDT' },
    { address: '0x9332081f308BC978fe259237850fA253131b46Fa', symbol: 'BTC' },
    { address: '0xFDa2F6EEB11f1aCc7ccAb559133E8F07d9F81986', symbol: 'ETH' },
    { address: '0xF7655664D5D4b0681fdD4529438A1b667bCDc7E5', symbol: 'BNB' },
    { address: '0x001AFD19C9d890b0cf0fcd6D654f9BFe4f264F14', symbol: 'LTC' },
    { address: '0x53450B1d205f1e41d10B653FBBDEa74160dafFf4', symbol: 'SOL' },
    { address: '0x60617237bC60f73c0393c7a6d7352e16DF20472a', symbol: 'TRX' },
    { address: '0xe2E8D51C18d6e0FDDbb9Ff4BF63235D688dd00Ae', symbol: 'XMR' },
    { address: '0x3cE7d8E486E16baD2Fb1487Fe1da4dC33237d923', symbol: 'RUB' },
    { address: '0x38297140d60B48f746aD83D851b852Fd23eF9871', symbol: 'GOLD' },
    {
        address: '0xAd9dfef9D671aFCF29Dbdd7Df360E7cA8D5ac40b',
        symbol: 'SILVER',
    },
    { address: '0x6D056e56f5D90ed5680f0335D80E112799a735C8', symbol: 'TRUR' },
    { address: '0xE2A45069C3e7897CAB592bEd389764e6eCf3b8a5', symbol: 'TGLD' },
    { address: '0x3352254390526624a140B06E7D2dDA8BA85a9E89', symbol: 'TMOS' },
    { address: '0x46A6f512885De25AaefBf5A5F842ba378700Fe22', symbol: 'TOFZ' },
    {
        address: '0x956baFF79b174e8A0f0A9a1350fE5F96ea68ca6e',
        symbol: 'HERMES',
    },
    {
        address: '0xD90e5d4284c763ecC8cDF7dC355d1Cd8a9D7899b',
        symbol: 'CLAUDE',
    },
    {
        address: '0x004045740a94BB6Be4401F23410CD7eFb215c63C',
        symbol: 'CHATGPT',
    },
    {
        address: '0xe09fe2F1c993aa9cf0fF8119e9dC561E34a0020F',
        symbol: 'OPENCLAW',
    },
    {
        address: '0x4945419ccEEF0Dc70B054700DE2750A056B03eE3',
        symbol: 'KRSQ',
    },
    { address: '0x3a5820Be90c3fB9c5F3Fb47a4859544193B0f8C6', symbol: 'YTN' },
    { address: '0xEb91EC10462a249b9922D6D62FB2BE73Bd084ADe', symbol: 'GOAL' },
    {
        address: '0x621021F18b6404123f98b1395c418868418ACF36',
        symbol: 'HATCHER',
    },
    {
        address: '0x03EB2fb8473C0370c8F6463efEE5f5Cf4EC011c7',
        symbol: 'JupUSD',
    },
];

const KNOWN_ADDRESSES = new Set(
    KNOWN_TOKENS.map((t) => t.address.toLowerCase()),
);

export const isKnownToken = (address: string): boolean =>
    KNOWN_ADDRESSES.has(address.toLowerCase());

/** TEST, TEST2, … and other throwaway deploys. */
export const isJunkSymbol = (symbol: string): boolean =>
    /^TEST\d*$/i.test(symbol.trim());

export type DexPoolRow = {
    pair_address: string;
    token0: string;
    token1: string;
    symbol0: string;
    symbol1: string;
    reserve0: number;
    reserve1: number;
    tvl_usd: number | null;
};

/**
 * Drop factory pairs nobody should trade against: TEST* deploys, dust pools
 * (a few wei of liquidity left behind), and unpriceable pairs between two
 * tokens we've never heard of (auto-generated chat-token pools).
 */
export const isJunkPool = (pool: DexPoolRow): boolean => {
    if (isJunkSymbol(pool.symbol0) || isJunkSymbol(pool.symbol1)) {
        return true;
    }

    if (pool.tvl_usd !== null && pool.tvl_usd < 0.01) {
        return true;
    }

    if (
        pool.tvl_usd === null &&
        !isKnownToken(pool.token0) &&
        !isKnownToken(pool.token1)
    ) {
        return true;
    }

    return false;
};

export const filterJunkPools = (pools: DexPoolRow[]): DexPoolRow[] =>
    pools.filter((p) => !isJunkPool(p));
