/**
 * Robinhood's tokenised stocks, as this project lists them.
 *
 * **Generated — do not hand-edit.** `node scripts/robinhood-stocks.mjs`
 * rewrites this file and the icons in `public/token-icons/stocks/` from
 * Robinhood's own asset registry, verifying every contract against the chain
 * before it writes a row. Last run: 2026-09-10.
 *
 * The whole point of the file is the address column. A ticker is not an
 * identifier on a permissionless chain: asking a router's token search for
 * "NVDA" on Robinhood Chain answers with nine contracts, one of which is the
 * security and eight of which are the name. Robinhood's registry is the only
 * thing that can tell them apart, so what it says is written down here rather
 * than looked up at runtime — a list that resolves itself over the network is a
 * list that resolves to something else on the day the network lies.
 *
 * What these tokens are, said plainly because the screens have to say it too: a
 * share held by a broker, with a token on this chain standing for it. The token
 * follows the share through splits and dividends by way of a *multiplier* the
 * issuer updates on chain, which is why nothing here caches a price and why a
 * balance is never presented as a share count without it. It is not equity. It
 * carries no vote, and outside Robinhood's own app the only thing behind it is
 * whoever is willing to trade it in this chain's pools.
 */

export const ROBINHOOD_STOCK_CHAIN_ID = 4663;

/**
 * A company or a fund. The distinction is not decoration: a fund's "name" is
 * its issuer's, several of them share one logo, and none of them has earnings —
 * so the two are listed apart rather than sorted together.
 */
export type StockKind = 'equity' | 'fund';

export type StockToken = {
    /** The ticker, exactly as both the share and the token spell it. */
    symbol: string;
    /** The company or fund, without the "• Robinhood Token" suffix. */
    name: string;
    /** The canonical contract on Robinhood Chain, checksummed. */
    address: string;
    decimals: number;
    kind: StockKind;
    /** The security's ISIN — what the icon is fetched by, and the only
     *  identifier here that means the same thing off this chain. */
    isin: string;
    /**
     * The company's mark, served from this origin.
     *
     * A path rather than a rule, because the extension is not uniform: the
     * source answers with an SVG for most issuers and a PNG for a handful, and
     * a PNG served as `image/svg+xml` draws nothing at all. The generator
     * reads the format off the bytes and writes the answer down here.
     */
    icon: string;
};

export const ROBINHOOD_STOCKS: readonly StockToken[] = [
    {
        symbol: 'NVDA',
        name: 'NVIDIA',
        address: '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC',
        decimals: 18,
        kind: 'equity',
        isin: 'US67066G1040',
        icon: '/token-icons/stocks/NVDA.svg',
    },
    {
        symbol: 'SPCX',
        name: 'SpaceX',
        address: '0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa',
        decimals: 18,
        kind: 'equity',
        isin: 'US84615Q1031',
        icon: '/token-icons/stocks/SPCX.svg',
    },
    {
        symbol: 'GOOGL',
        name: 'Alphabet Class A',
        address: '0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3',
        decimals: 18,
        kind: 'equity',
        isin: 'US02079K3059',
        icon: '/token-icons/stocks/GOOGL.svg',
    },
    {
        symbol: 'TSLA',
        name: 'Tesla',
        address: '0x322F0929c4625eD5bAd873c95208D54E1c003b2d',
        decimals: 18,
        kind: 'equity',
        isin: 'US88160R1014',
        icon: '/token-icons/stocks/TSLA.svg',
    },
    {
        symbol: 'GME',
        name: 'GameStop',
        address: '0x1b0E319c6A659F002271B69dB8A7df2F911c153E',
        decimals: 18,
        kind: 'equity',
        isin: 'US36467W1099',
        icon: '/token-icons/stocks/GME.svg',
    },
    {
        symbol: 'AAPL',
        name: 'Apple',
        address: '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9',
        decimals: 18,
        kind: 'equity',
        isin: 'US0378331005',
        icon: '/token-icons/stocks/AAPL.svg',
    },
    {
        symbol: 'SNDK',
        name: 'Sandisk Corporation',
        address: '0xB90A19fF0Af67f7779afF50A882A9CfF42446400',
        decimals: 18,
        kind: 'equity',
        isin: 'US80004C2008',
        icon: '/token-icons/stocks/SNDK.png',
    },
    {
        symbol: 'AMD',
        name: 'AMD',
        address: '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC',
        decimals: 18,
        kind: 'equity',
        isin: 'US0079031078',
        icon: '/token-icons/stocks/AMD.svg',
    },
    {
        symbol: 'AMZN',
        name: 'Amazon',
        address: '0x12f190a9F9d7D37a250758b26824B97CE941bF54',
        decimals: 18,
        kind: 'equity',
        isin: 'US0231351067',
        icon: '/token-icons/stocks/AMZN.svg',
    },
    {
        symbol: 'MSFT',
        name: 'Microsoft',
        address: '0xe93237C50D904957Cf27E7B1133b510C669c2e74',
        decimals: 18,
        kind: 'equity',
        isin: 'US5949181045',
        icon: '/token-icons/stocks/MSFT.svg',
    },
    {
        symbol: 'META',
        name: 'Meta Platforms',
        address: '0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35',
        decimals: 18,
        kind: 'equity',
        isin: 'US30303M1027',
        icon: '/token-icons/stocks/META.svg',
    },
    {
        symbol: 'CRCL',
        name: 'Circle Internet Group',
        address: '0xdF0992E440dD0be65BD8439b609d6D4366bf1CB5',
        decimals: 18,
        kind: 'equity',
        isin: 'US1725731079',
        icon: '/token-icons/stocks/CRCL.png',
    },
    {
        symbol: 'COIN',
        name: 'Coinbase',
        address: '0x6330D8C3178a418788dF01a47479c0ce7CCF450b',
        decimals: 18,
        kind: 'equity',
        isin: 'US19260Q1076',
        icon: '/token-icons/stocks/COIN.svg',
    },
    {
        symbol: 'MU',
        name: 'Micron Technology',
        address: '0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD',
        decimals: 18,
        kind: 'equity',
        isin: 'US5951121038',
        icon: '/token-icons/stocks/MU.svg',
    },
    {
        symbol: 'PLTR',
        name: 'Palantir Technologies',
        address: '0x894E1EC2D74FFE5AEF8Dc8A9e84686acCB964F2A',
        decimals: 18,
        kind: 'equity',
        isin: 'US69608A1088',
        icon: '/token-icons/stocks/PLTR.svg',
    },
    {
        symbol: 'TTWO',
        name: 'Take-Two Interactive Software',
        address: '0x5e81213613b6B86EaB4c6c50d718d34359459786',
        decimals: 18,
        kind: 'equity',
        isin: 'US8740541094',
        icon: '/token-icons/stocks/TTWO.svg',
    },
    {
        symbol: 'RIVN',
        name: 'Rivian Automotive',
        address: '0xB1BF26c1D20ff267A4f93550d1E0d06ac40a114B',
        decimals: 18,
        kind: 'equity',
        isin: 'US76954A1034',
        icon: '/token-icons/stocks/RIVN.png',
    },
    {
        symbol: 'COST',
        name: 'Costco',
        address: '0x4EA005168D7F09a7A0Ba9D1DEf21a479950E44C2',
        decimals: 18,
        kind: 'equity',
        isin: 'US22160K1051',
        icon: '/token-icons/stocks/COST.svg',
    },
    {
        symbol: 'DJT',
        name: 'Trump Media & Technology Group',
        address: '0x1D11f0496982706C5e14A514D4E79F2e6BdE4516',
        decimals: 18,
        kind: 'equity',
        isin: 'US25400Q1058',
        icon: '/token-icons/stocks/DJT.png',
    },
    {
        symbol: 'MSTR',
        name: 'Strategy Inc.',
        address: '0xec262a75e413fAfD0dF80480274532C79D42da09',
        decimals: 18,
        kind: 'equity',
        isin: 'US5949724083',
        icon: '/token-icons/stocks/MSTR.svg',
    },
    {
        symbol: 'RDDT',
        name: 'Reddit',
        address: '0x05b37Fb53A299a1b874A619e1c4C404D52C36F4C',
        decimals: 18,
        kind: 'equity',
        isin: 'US75734B1008',
        icon: '/token-icons/stocks/RDDT.svg',
    },
    {
        symbol: 'HIMS',
        name: 'Hims & Hers Health',
        address: '0xCceE82fE024c36fA15E1005edE3E9e4787e23D09',
        decimals: 18,
        kind: 'equity',
        isin: 'US4330001060',
        icon: '/token-icons/stocks/HIMS.svg',
    },
    {
        symbol: 'BB',
        name: 'Blackberry',
        address: '0x48E39E56aCdbA37b09020C0b734A613C9a2f100A',
        decimals: 18,
        kind: 'equity',
        isin: 'CA09228F1036',
        icon: '/token-icons/stocks/BB.svg',
    },
    {
        symbol: 'LLY',
        name: 'Eli Lilly',
        address: '0x8005d266423c7ea827372c9c864491e5786600ea',
        decimals: 18,
        kind: 'equity',
        isin: 'US5324571083',
        icon: '/token-icons/stocks/LLY.svg',
    },
    {
        symbol: 'WYFI',
        name: 'WhiteFiber, Inc.',
        address: '0x9e7ABD3C9139D14E4c86DcE0e455AAB7A0C2FB3E',
        decimals: 18,
        kind: 'equity',
        isin: 'KYG961151035',
        icon: '/token-icons/stocks/WYFI.png',
    },
    {
        symbol: 'TSM',
        name: 'Taiwan Semiconductor Manufacturing',
        address: '0x58FfE4a942d3885bAa22D7520691F611EF09e7AA',
        decimals: 18,
        kind: 'equity',
        isin: 'US8740391003',
        icon: '/token-icons/stocks/TSM.svg',
    },
    {
        symbol: 'RBLX',
        name: 'Roblox',
        address: '0xF0C4BF4C582cb3836e98394b1d4e7B7281101bE8',
        decimals: 18,
        kind: 'equity',
        isin: 'US7710491033',
        icon: '/token-icons/stocks/RBLX.svg',
    },
    {
        symbol: 'SKHY',
        name: 'SK hynix',
        address: '0x84CAb63bc87912E71ad199ff14A0bA45de68FeF8',
        decimals: 18,
        kind: 'equity',
        isin: 'US78392B2060',
        icon: '/token-icons/stocks/SKHY.png',
    },
    {
        symbol: 'DELL',
        name: 'Dell',
        address: '0x941AE714EC6D8130c7B75d67160Ca08f1e7d11Dd',
        decimals: 18,
        kind: 'equity',
        isin: 'US24703L2025',
        icon: '/token-icons/stocks/DELL.svg',
    },
    {
        symbol: 'SNAP',
        name: 'Snap',
        address: '0xF6589F11Bc40b669e584073F428B05562F568733',
        decimals: 18,
        kind: 'equity',
        isin: 'US83304A1060',
        icon: '/token-icons/stocks/SNAP.svg',
    },
    {
        symbol: 'LULU',
        name: 'Lululemon',
        address: '0x4e62068525Ab11FE768e29dfD00ef909B9803016',
        decimals: 18,
        kind: 'equity',
        isin: 'US5500211090',
        icon: '/token-icons/stocks/LULU.svg',
    },
    {
        symbol: 'FIG',
        name: 'Figma',
        address: '0x41F4267525a8AFf329540eF24fD83d9044758B33',
        decimals: 18,
        kind: 'equity',
        isin: 'US3168411052',
        icon: '/token-icons/stocks/FIG.svg',
    },
    {
        symbol: 'MRNA',
        name: 'Moderna',
        address: '0x43B07D15cE533bEc5476d70C22a78a1B2B662155',
        decimals: 18,
        kind: 'equity',
        isin: 'US60770K1079',
        icon: '/token-icons/stocks/MRNA.svg',
    },
    {
        symbol: 'PFE',
        name: 'Pfizer',
        address: '0x7066A64c24e4206CD62E83bf198c1E7EB361F51e',
        decimals: 18,
        kind: 'equity',
        isin: 'US7170811035',
        icon: '/token-icons/stocks/PFE.svg',
    },
    {
        symbol: 'MRVL',
        name: 'Marvell Technology',
        address: '0x62fd0668e10D8B72339BE2DCF7643001688ff13B',
        decimals: 18,
        kind: 'equity',
        isin: 'US5738741041',
        icon: '/token-icons/stocks/MRVL.svg',
    },
    {
        symbol: 'JNJ',
        name: 'Johnson & Johnson',
        address: '0x03DfbBE0AC4E7bCDaFd08eD41A400326B77D8c80',
        decimals: 18,
        kind: 'equity',
        isin: 'US4781601046',
        icon: '/token-icons/stocks/JNJ.svg',
    },
    {
        symbol: 'AMC',
        name: 'AMC Entertainment',
        address: '0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B',
        decimals: 18,
        kind: 'equity',
        isin: 'US00165C3025',
        icon: '/token-icons/stocks/AMC.svg',
    },
    {
        symbol: 'BABA',
        name: 'Alibaba',
        address: '0xad25Ac6C84D497db898fa1E8387bf6Af3532a1c4',
        decimals: 18,
        kind: 'equity',
        isin: 'US01609W1027',
        icon: '/token-icons/stocks/BABA.svg',
    },
    {
        symbol: 'IBM',
        name: 'IBM',
        address: '0x980dcf6766FA79f5Cf0c4AAdb3ab477ff15a9619',
        decimals: 18,
        kind: 'equity',
        isin: 'US4592001014',
        icon: '/token-icons/stocks/IBM.svg',
    },
    {
        symbol: 'NFLX',
        name: 'Netflix',
        address: '0xE0444EF8BF4eD74f74FD73686e2ddF4C1c5591E8',
        decimals: 18,
        kind: 'equity',
        isin: 'US64110L1061',
        icon: '/token-icons/stocks/NFLX.svg',
    },
    {
        symbol: 'BULL',
        name: 'Webull',
        address: '0xceF9027c7d6985b85f0BA431125073529A947A68',
        decimals: 18,
        kind: 'equity',
        isin: 'KYG9572D1034',
        icon: '/token-icons/stocks/BULL.png',
    },
    {
        symbol: 'NU',
        name: 'Nu',
        address: '0x408c14038a04f7bD235329E26d2bf569ee20e250',
        decimals: 18,
        kind: 'equity',
        isin: 'KYG6683N1034',
        icon: '/token-icons/stocks/NU.svg',
    },
    {
        symbol: 'SHOP',
        name: 'Shopify',
        address: '0xF53F66751B1Eff985311b693531E3290F600c410',
        decimals: 18,
        kind: 'equity',
        isin: 'CA82509L1076',
        icon: '/token-icons/stocks/SHOP.svg',
    },
    {
        symbol: 'BE',
        name: 'Bloom Energy',
        address: '0x822CC93fFD030293E9842c30BBD678F530701867',
        decimals: 18,
        kind: 'equity',
        isin: 'US0937121079',
        icon: '/token-icons/stocks/BE.svg',
    },
    {
        symbol: 'F',
        name: 'Ford Motor',
        address: '0x25C288E6D899b9BC30160965aD9644c67e73bE0C',
        decimals: 18,
        kind: 'equity',
        isin: 'US3453708600',
        icon: '/token-icons/stocks/F.svg',
    },
    {
        symbol: 'UPS',
        name: 'UPS',
        address: '0xf23250dac154D05Bb671CB0d0eBEf3c635c79CE2',
        decimals: 18,
        kind: 'equity',
        isin: 'US9113121068',
        icon: '/token-icons/stocks/UPS.svg',
    },
    {
        symbol: 'SPY',
        name: 'SPDR S&P 500 ETF Trust',
        address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
        decimals: 18,
        kind: 'fund',
        isin: 'US78462F1030',
        icon: '/token-icons/stocks/SPY.svg',
    },
    {
        symbol: 'QQQ',
        name: 'Invesco QQQ',
        address: '0xD5f3879160bc7c32ebb4dC785F8a4F505888de68',
        decimals: 18,
        kind: 'fund',
        isin: 'US46090E1038',
        icon: '/token-icons/stocks/QQQ.svg',
    },
    {
        symbol: 'GLD',
        name: 'SPDR Gold Trust',
        address: '0xC9a981FEE1F9DEc688bb123ccDeCc63D0deBFC4e',
        decimals: 18,
        kind: 'fund',
        isin: 'US78463V1070',
        icon: '/token-icons/stocks/GLD.svg',
    },
    {
        symbol: 'SGOV',
        name: 'iShares 0-3 Month Treasury Bond',
        address: '0x92FD66527192E3e61d4DDd13322Aa222DE86F9B5',
        decimals: 18,
        kind: 'fund',
        isin: 'US46436E7186',
        icon: '/token-icons/stocks/SGOV.svg',
    },
    {
        symbol: 'INDA',
        name: 'iShares MSCI India ETF',
        address: '0xACEF2e09adb47aD6aBeBAD9fF06689E60615C2B6',
        decimals: 18,
        kind: 'fund',
        isin: 'US46429B5984',
        icon: '/token-icons/stocks/INDA.svg',
    },
    {
        symbol: 'SLV',
        name: 'iShares Silver Trust',
        address: '0x411eFb0E7f985935DAec3D4C3ebaEa0d0AD7D89f',
        decimals: 18,
        kind: 'fund',
        isin: 'US46428Q1094',
        icon: '/token-icons/stocks/SLV.svg',
    },
    {
        symbol: 'USO',
        name: 'United States Oil Fund',
        address: '0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344',
        decimals: 18,
        kind: 'fund',
        isin: 'US91232N2071',
        icon: '/token-icons/stocks/USO.png',
    },
];

const BY_SYMBOL = new Map(ROBINHOOD_STOCKS.map((s) => [s.symbol, s]));
const BY_ADDRESS = new Map(
    ROBINHOOD_STOCKS.map((s) => [s.address.toLowerCase(), s]),
);

export const stockBySymbol = (symbol: string): StockToken | undefined =>
    BY_SYMBOL.get(symbol.toUpperCase());

/**
 * The listed stock at this address, or undefined.
 *
 * The one function that answers "is this the real one". Everything that draws a
 * ticker next to a price goes through it, so a lookalike contract is shown as
 * what it is — a token called NVDA — and never as NVIDIA.
 */
export const stockByAddress = (address: string): StockToken | undefined =>
    BY_ADDRESS.get(address.trim().toLowerCase());

export const isStockToken = (chainId: number, address: string): boolean =>
    chainId === ROBINHOOD_STOCK_CHAIN_ID &&
    stockByAddress(address) !== undefined;

export const stockEquities = (): StockToken[] =>
    ROBINHOOD_STOCKS.filter((s) => s.kind === 'equity');

export const stockFunds = (): StockToken[] =>
    ROBINHOOD_STOCKS.filter((s) => s.kind === 'fund');

/**
 * Where one stock's icon lives, by ticker.
 *
 * Vendored and not hot-linked: fifty-three images fetched from a third party on
 * a wallet screen is fifty-three requests telling that third party which stocks
 * somebody is looking at. Answers null for a ticker this build does not list,
 * rather than a path that would 404.
 */
export const stockIcon = (symbol: string): string | null =>
    stockBySymbol(symbol)?.icon ?? null;

/** Case-insensitive search over ticker, name and ISIN. */
export const searchStocks = (term: string): StockToken[] => {
    const q = term.trim().toLowerCase();

    if (q === '') {
        return [...ROBINHOOD_STOCKS];
    }

    return ROBINHOOD_STOCKS.filter(
        (s) =>
            s.symbol.toLowerCase().includes(q) ||
            s.name.toLowerCase().includes(q) ||
            s.isin.toLowerCase() === q ||
            s.address.toLowerCase() === q,
    );
};
