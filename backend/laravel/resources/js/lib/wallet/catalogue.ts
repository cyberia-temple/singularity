import { evmChain } from '@/lib/wallet/chains';
import type {
    WalletChain,
    WalletChainId,
    WalletMark,
} from '@/lib/wallet/chains';

/**
 * The network catalogue: every chain this wallet ships knowing how to read,
 * beyond the handful it opens with.
 *
 * The seed already covers all of them — an EVM network is the same key at a
 * different chain id — so nothing here is about keys. What a catalogue entry
 * actually is, is an *endpoint plus a promise*: an RPC that answers a browser,
 * and, where one exists, a keyless index that can list tokens and history. Both
 * were verified against the live network before the entry was written down:
 * the RPC has to return this chain's own id to a request carrying a browser
 * `Origin` (a node that answers curl and refuses a page is a network the wallet
 * would show as permanently unreachable), and the index has to answer the same
 * `tokenlist` call the shipped chains use. That is why this file is generated
 * from probes and not typed out of a chain list.
 *
 * **Off by default, and that is the design.** A portfolio is the answer to
 * "what do I have", and 120 cards reading 120 balances every refresh answers a
 * different question badly. So the catalogue is a list you choose from: each
 * network the user switches on becomes an ordinary wallet chain, indistinguish-
 * able on screen from Cyberia or Base, and every one left off costs nothing.
 * What is stored is the choice, never an account — the accounts come back from
 * the seed on every unlock.
 *
 * These are not `custom` chains. A user-added network is drawn dashed because
 * nobody vetted what it points at; these point at endpoints this project
 * checked, and claiming otherwise in either direction would be a lie about the
 * only thing that separates them.
 */

export type CatalogueNetwork = {
    /** Stable slug, and the network's id inside the wallet. */
    id: WalletChainId;
    chainId: number;
    label: string;
    symbol: string;
    /** Two letters for the tile, unique across the whole catalogue. */
    tag: string;
    /**
     * Native decimals. Every network in this list runs an 18-decimal coin, so
     * the field exists for the first one that will not — a wallet that assumed
     * 18 would render such a balance off by orders of magnitude.
     */
    decimals?: number;
    rpc: string;
    /** EIP-3091 explorer root, or null when the chain has no usable one. */
    explorer: string | null;
    /**
     * Keyless Blockscout API root, for the chains that have one.
     *
     * Its absence is not "this address holds no tokens" — it is "nobody here
     * can enumerate them", which is what the wallet says instead of drawing an
     * empty list. Roughly a third of the catalogue has one.
     */
    blockscout?: string;
};

/**
 * Hues for catalogue networks.
 *
 * Eight rather than 120: a per-chain colour would be invented information, and
 * the mark carries its meaning in two letters that *are* unique. The hue is
 * picked by chain id so it never moves, and the palette stays clear of the
 * amber/green/red that transaction status owns — see `wallet.css`.
 */
const CATALOGUE_HUES = 8;

const hueFor = (chainId: number): string =>
    `var(--cw-net-cat-${(chainId % CATALOGUE_HUES) + 1})`;

/**
 * The tile a catalogue network is drawn as, here rather than in the screen
 * that draws it: the network list has to render marks for chains that are not
 * in the registry yet — that is what "switched off" means — and the mark it
 * shows before the switch must be the one it keeps after.
 */
export const catalogueMark = (network: CatalogueNetwork): WalletMark => ({
    tag: network.tag,
    hue: hueFor(network.chainId),
    shape: 'square',
});

/** Every network the wallet ships knowing, alphabetical by name. */
export const NETWORK_CATALOGUE: readonly CatalogueNetwork[] = [
    {
        id: 'zerog',
        chainId: 16661,
        label: '0G',
        symbol: '0G',
        tag: '0G',
        rpc: 'https://evmrpc.0g.ai',
        explorer: 'https://chainscan.0g.ai',
    },
    {
        id: 'abstract',
        chainId: 2741,
        label: 'Abstract',
        symbol: 'ETH',
        tag: 'AB',
        rpc: 'https://api.mainnet.abs.xyz',
        explorer: 'https://abscan.org',
    },
    {
        id: 'apechain',
        chainId: 33139,
        label: 'ApeChain',
        symbol: 'APE',
        tag: 'AP',
        rpc: 'https://rpc.apechain.com',
        explorer: 'https://apescan.io',
    },
    {
        id: 'arbitrum-nova',
        chainId: 42170,
        label: 'Arbitrum Nova',
        symbol: 'ETH',
        tag: 'AN',
        rpc: 'https://arbitrum-nova-rpc.publicnode.com',
        explorer: 'https://nova-explorer.arbitrum.io',
    },
    {
        id: 'arbitrum-one',
        chainId: 42161,
        label: 'Arbitrum One',
        symbol: 'ETH',
        tag: 'AO',
        rpc: 'https://arbitrum-one-rpc.publicnode.com',
        explorer: 'https://arbiscan.io',
    },
    {
        id: 'astar',
        chainId: 592,
        label: 'Astar',
        symbol: 'ASTR',
        tag: 'AS',
        rpc: 'https://evm.astar.network',
        explorer: 'https://astar.blockscout.com',
        blockscout: 'https://astar.blockscout.com/api',
    },
    {
        id: 'aurora',
        chainId: 1313161554,
        label: 'Aurora',
        symbol: 'ETH',
        tag: 'AU',
        rpc: 'https://mainnet.aurora.dev',
        explorer: 'https://explorer.aurora.dev',
        blockscout: 'https://explorer.aurora.dev/api',
    },
    {
        id: 'avalanche',
        chainId: 43114,
        label: 'Avalanche',
        symbol: 'AVAX',
        tag: 'AV',
        rpc: 'https://avalanche-c-chain-rpc.publicnode.com',
        explorer: 'https://snowscan.xyz',
    },
    {
        id: 'b3',
        chainId: 8333,
        label: 'B3',
        symbol: 'ETH',
        tag: 'B3',
        rpc: 'https://mainnet-rpc.b3.fun',
        explorer: 'https://explorer.b3.fun',
    },
    {
        id: 'beam',
        chainId: 4337,
        label: 'Beam',
        symbol: 'BEAM',
        tag: 'BE',
        rpc: 'https://build.onbeam.com/rpc',
        explorer: 'https://subnets.avax.network/beam',
    },
    {
        id: 'berachain',
        chainId: 80094,
        label: 'Berachain',
        symbol: 'BERA',
        tag: 'BR',
        rpc: 'https://berachain-rpc.publicnode.com',
        explorer: 'https://berascan.com',
    },
    {
        id: 'bitgert',
        chainId: 32520,
        label: 'Bitgert',
        symbol: 'Brise',
        tag: 'BI',
        rpc: 'https://rpc-bitgert.icecreamswap.com',
        explorer: 'https://brisescan.com',
        blockscout: 'https://brisescan.com/api',
    },
    {
        id: 'bitkub',
        chainId: 96,
        label: 'Bitkub Chain',
        symbol: 'KUB',
        tag: 'BC',
        rpc: 'https://rpc.bitkubchain.io',
        explorer: 'https://kubscan.com',
        blockscout: 'https://kubscan.com/api',
    },
    {
        id: 'bitlayer',
        chainId: 200901,
        label: 'Bitlayer',
        symbol: 'BTC',
        tag: 'BL',
        rpc: 'https://rpc.bitlayer.org',
        explorer: 'https://www.btrscan.com',
    },
    {
        id: 'bittorrent',
        chainId: 199,
        label: 'BitTorrent Chain',
        symbol: 'BTT',
        tag: 'BO',
        rpc: 'https://rpc.bt.io',
        explorer: 'https://bttcscan.com',
    },
    {
        id: 'blast',
        chainId: 81457,
        label: 'Blast',
        symbol: 'ETH',
        tag: 'BS',
        rpc: 'https://blast-rpc.publicnode.com',
        explorer: 'https://blastscan.io',
    },
    {
        id: 'bob',
        chainId: 60808,
        label: 'BOB',
        symbol: 'ETH',
        tag: 'BB',
        rpc: 'https://rpc.gobob.xyz',
        explorer: 'https://explorer.gobob.xyz',
    },
    {
        id: 'boba',
        chainId: 288,
        label: 'Boba',
        symbol: 'ETH',
        tag: 'OB',
        rpc: 'https://mainnet.boba.network',
        explorer: 'https://bobascan.com',
    },
    {
        id: 'bouncebit',
        chainId: 6001,
        label: 'BounceBit',
        symbol: 'BB',
        tag: 'BU',
        rpc: 'https://fullnode-mainnet.bouncebitapi.com',
        explorer: 'https://bbscan.io',
        blockscout: 'https://bbscan.io/api',
    },
    {
        id: 'bsquared',
        chainId: 223,
        label: 'BSquared',
        symbol: 'BTC',
        tag: 'BQ',
        rpc: 'https://mainnet.b2-rpc.com',
        explorer: 'https://explorer.bsquared.network',
    },
    {
        id: 'canto',
        chainId: 7700,
        label: 'Canto',
        symbol: 'CANTO',
        tag: 'CA',
        rpc: 'https://canto.gravitychain.io',
        explorer: 'https://tuber.build',
    },
    {
        id: 'celo',
        chainId: 42220,
        label: 'Celo',
        symbol: 'CELO',
        tag: 'CE',
        rpc: 'https://forno.celo.org',
        explorer: 'https://celo.blockscout.com',
        blockscout: 'https://celo.blockscout.com/api',
    },
    {
        id: 'chiliz',
        chainId: 88888,
        label: 'Chiliz',
        symbol: 'CHZ',
        tag: 'CH',
        rpc: 'https://chiliz.publicnode.com',
        explorer: 'https://chiliscan.com',
    },
    {
        id: 'conflux-espace',
        chainId: 1030,
        label: 'Conflux eSpace',
        symbol: 'CFX',
        tag: 'CO',
        rpc: 'https://evm.confluxrpc.com',
        explorer: 'https://evm.confluxscan.net',
    },
    {
        id: 'core',
        chainId: 1116,
        label: 'Core',
        symbol: 'CORE',
        tag: 'CR',
        rpc: 'https://rpc.coredao.org',
        explorer: 'https://scan.coredao.org',
    },
    {
        id: 'cronos',
        chainId: 25,
        label: 'Cronos',
        symbol: 'CRO',
        tag: 'CN',
        rpc: 'https://cronos-evm-rpc.publicnode.com',
        explorer: 'https://explorer.cronos.org',
    },
    {
        id: 'cronos-zkevm',
        chainId: 388,
        label: 'Cronos zkEVM',
        symbol: 'zkCRO',
        tag: 'CZ',
        rpc: 'https://mainnet.zkevm.cronos.org',
        explorer: 'https://explorer.zkevm.cronos.org',
    },
    {
        id: 'cyber',
        chainId: 7560,
        label: 'Cyber',
        symbol: 'ETH',
        tag: 'CB',
        rpc: 'https://cyber.alt.technology',
        explorer: 'https://cyberscan.co',
        blockscout: 'https://cyberscan.co/api',
    },
    {
        id: 'degen',
        chainId: 666666666,
        label: 'Degen',
        symbol: 'DEGEN',
        tag: 'DE',
        rpc: 'https://rpc.degen.tips',
        explorer: 'https://explorer.degen.tips',
        blockscout: 'https://explorer.degen.tips/api',
    },
    {
        id: 'derive',
        chainId: 957,
        label: 'Derive',
        symbol: 'ETH',
        tag: 'DR',
        rpc: 'https://rpc.lyra.finance',
        explorer: 'https://explorer.lyra.finance',
    },
    {
        id: 'energy-web',
        chainId: 246,
        label: 'Energy Web',
        symbol: 'EWT',
        tag: 'EW',
        rpc: 'https://rpc.energyweb.org',
        explorer: 'https://explorer.energyweb.org',
        blockscout: 'https://explorer.energyweb.org/api',
    },
    {
        id: 'ethereum',
        chainId: 1,
        label: 'Ethereum',
        symbol: 'ETH',
        tag: 'ET',
        rpc: 'https://ethereum-rpc.publicnode.com',
        explorer: 'https://eth.blockscout.com',
        blockscout: 'https://eth.blockscout.com/api',
    },
    {
        id: 'ethereum-classic',
        chainId: 61,
        label: 'Ethereum Classic',
        symbol: 'ETC',
        tag: 'EC',
        rpc: 'https://etc.rivet.link',
        explorer: 'https://etc.blockscout.com',
        blockscout: 'https://etc.blockscout.com/api',
    },
    {
        id: 'etherlink',
        chainId: 42793,
        label: 'Etherlink',
        symbol: 'XTZ',
        tag: 'EH',
        rpc: 'https://node.mainnet.etherlink.com',
        explorer: 'https://explorer.etherlink.com',
        blockscout: 'https://explorer.etherlink.com/api',
    },
    {
        id: 'fantom',
        chainId: 250,
        label: 'Fantom',
        symbol: 'FTM',
        tag: 'FA',
        rpc: 'https://fantom.drpc.org',
        explorer: 'https://ftmscan.com',
    },
    {
        id: 'filecoin',
        chainId: 314,
        label: 'Filecoin',
        symbol: 'FIL',
        tag: 'FI',
        rpc: 'https://api.node.glif.io',
        explorer: 'https://filecoin.blockscout.com',
        blockscout: 'https://filecoin.blockscout.com/api',
    },
    {
        id: 'flare',
        chainId: 14,
        label: 'Flare',
        symbol: 'FLR',
        tag: 'FL',
        rpc: 'https://flare-api.flare.network/ext/C/rpc',
        explorer: 'https://flare-explorer.flare.network',
        blockscout: 'https://flare-explorer.flare.network/api',
    },
    {
        id: 'flow-evm',
        chainId: 747,
        label: 'Flow EVM',
        symbol: 'FLOW',
        tag: 'FE',
        rpc: 'https://mainnet.evm.nodes.onflow.org',
        explorer: 'https://evm.flowscan.io',
    },
    {
        id: 'fraxtal',
        chainId: 252,
        label: 'Fraxtal',
        symbol: 'FRAX',
        tag: 'FR',
        rpc: 'https://fraxtal-rpc.publicnode.com',
        explorer: 'https://fraxscan.com',
    },
    {
        id: 'fuse',
        chainId: 122,
        label: 'Fuse',
        symbol: 'FUSE',
        tag: 'FU',
        rpc: 'https://rpc.fuse.io',
        explorer: 'https://explorer.fuse.io',
        blockscout: 'https://explorer.fuse.io/api',
    },
    {
        id: 'gnosis',
        chainId: 100,
        label: 'Gnosis',
        symbol: 'XDAI',
        tag: 'GN',
        rpc: 'https://gnosis-rpc.publicnode.com',
        explorer: 'https://gnosisscan.io',
        blockscout: 'https://gnosisscan.io/api',
    },
    {
        id: 'gochain',
        chainId: 60,
        label: 'GoChain',
        symbol: 'GO',
        tag: 'GO',
        rpc: 'https://rpc.gochain.io',
        explorer: 'https://explorer.gochain.io',
    },
    {
        id: 'gravity',
        chainId: 1625,
        label: 'Gravity',
        symbol: 'G',
        tag: 'GR',
        rpc: 'https://rpc.gravity.xyz',
        explorer: 'https://explorer.gravity.xyz',
    },
    {
        id: 'haqq',
        chainId: 11235,
        label: 'HAQQ',
        symbol: 'ISLM',
        tag: 'HA',
        rpc: 'https://haqq-evm-rpc.publicnode.com',
        explorer: 'https://explorer.haqq.network',
    },
    {
        id: 'harmony',
        chainId: 1666600000,
        label: 'Harmony',
        symbol: 'ONE',
        tag: 'HR',
        rpc: 'https://api.harmony.one',
        explorer: 'https://explorer.harmony.one',
        blockscout: 'https://explorer.harmony.one/api',
    },
    {
        id: 'hashkey',
        chainId: 177,
        label: 'HashKey Chain',
        symbol: 'HSK',
        tag: 'HC',
        rpc: 'https://mainnet.hsk.xyz',
        explorer: 'https://hsk.blockscout.com',
        blockscout: 'https://hsk.blockscout.com/api',
    },
    {
        id: 'hedera',
        chainId: 295,
        label: 'Hedera',
        symbol: 'HBAR',
        tag: 'HE',
        rpc: 'https://mainnet.hashio.io/api',
        explorer: 'https://explorer.arkhia.io',
    },
    {
        id: 'hemi',
        chainId: 43111,
        label: 'Hemi',
        symbol: 'ETH',
        tag: 'HM',
        rpc: 'https://rpc.hemi.network/rpc',
        explorer: 'https://explorer.hemi.xyz',
        blockscout: 'https://explorer.hemi.xyz/api',
    },
    {
        id: 'hyperevm',
        chainId: 999,
        label: 'HyperEVM',
        symbol: 'HYPE',
        tag: 'HY',
        rpc: 'https://rpc.hyperliquid.xyz/evm',
        explorer: 'https://hyperevmscan.io',
    },
    {
        id: 'immutable-zkevm',
        chainId: 13371,
        label: 'Immutable zkEVM',
        symbol: 'IMX',
        tag: 'IZ',
        rpc: 'https://rpc.immutable.com',
        explorer: 'https://explorer.immutable.com',
        blockscout: 'https://explorer.immutable.com/api',
    },
    {
        id: 'ink',
        chainId: 57073,
        label: 'Ink',
        symbol: 'ETH',
        tag: 'IN',
        rpc: 'https://rpc-qnd.inkonchain.com',
        explorer: 'https://explorer.inkonchain.com',
        blockscout: 'https://explorer.inkonchain.com/api',
    },
    {
        id: 'iota-evm',
        chainId: 8822,
        label: 'IOTA EVM',
        symbol: 'IOTA',
        tag: 'IE',
        rpc: 'https://json-rpc.evm.iotaledger.net',
        explorer: 'https://explorer.evm.iota.org',
        blockscout: 'https://explorer.evm.iota.org/api',
    },
    {
        id: 'iotex',
        chainId: 4689,
        label: 'IoTeX',
        symbol: 'IOTX',
        tag: 'IO',
        rpc: 'https://babel-api.mainnet.iotex.io',
        explorer: 'https://iotexscan.io',
    },
    {
        id: 'kaia',
        chainId: 8217,
        label: 'Kaia',
        symbol: 'KAIA',
        tag: 'KA',
        rpc: 'https://public-en.node.kaia.io',
        explorer: 'https://kaiascope.com',
    },
    {
        id: 'karak',
        chainId: 2410,
        label: 'Karak',
        symbol: 'ETH',
        tag: 'KR',
        rpc: 'https://rpc.karak.network',
        explorer: 'https://explorer.karak.network',
        blockscout: 'https://explorer.karak.network/api',
    },
    {
        id: 'katana',
        chainId: 747474,
        label: 'Katana',
        symbol: 'ETH',
        tag: 'KT',
        rpc: 'https://rpc.katana.network',
        explorer: 'https://katanascan.com',
    },
    {
        id: 'kava',
        chainId: 2222,
        label: 'Kava',
        symbol: 'KAVA',
        tag: 'KV',
        rpc: 'https://kava-evm-rpc.publicnode.com',
        explorer: 'https://kavascan.com',
    },
    {
        id: 'kcc',
        chainId: 321,
        label: 'KCC',
        symbol: 'KCS',
        tag: 'KC',
        rpc: 'https://rpc-mainnet.kcc.network',
        explorer: 'https://explorer.kcc.io/en',
    },
    {
        id: 'lens',
        chainId: 232,
        label: 'Lens',
        symbol: 'GHO',
        tag: 'LE',
        rpc: 'https://rpc.lens.xyz',
        explorer: 'https://explorer.lens.xyz',
        blockscout: 'https://explorer.lens.xyz/api',
    },
    {
        id: 'lightlink',
        chainId: 1890,
        label: 'LightLink',
        symbol: 'ETH',
        tag: 'LI',
        rpc: 'https://replicator.phoenix.lightlink.io/rpc/v1',
        explorer: 'https://phoenix.lightlink.io',
        blockscout: 'https://phoenix.lightlink.io/api',
    },
    {
        id: 'linea',
        chainId: 59144,
        label: 'Linea',
        symbol: 'ETH',
        tag: 'LN',
        rpc: 'https://linea-rpc.publicnode.com',
        explorer: 'https://lineascan.build',
    },
    {
        id: 'lisk',
        chainId: 1135,
        label: 'Lisk',
        symbol: 'ETH',
        tag: 'LS',
        rpc: 'https://rpc.api.lisk.com',
        explorer: 'https://blockscout.lisk.com',
        blockscout: 'https://blockscout.lisk.com/api',
    },
    {
        id: 'manta-pacific',
        chainId: 169,
        label: 'Manta Pacific',
        symbol: 'ETH',
        tag: 'MP',
        rpc: 'https://pacific-rpc.manta.network/http',
        explorer: 'https://pacific-explorer.manta.network',
        blockscout: 'https://pacific-explorer.manta.network/api',
    },
    {
        id: 'mantle',
        chainId: 5000,
        label: 'Mantle',
        symbol: 'MNT',
        tag: 'MA',
        rpc: 'https://mantle-rpc.publicnode.com',
        explorer: 'https://mantlescan.xyz',
    },
    {
        id: 'merlin',
        chainId: 4200,
        label: 'Merlin',
        symbol: 'BTC',
        tag: 'ME',
        rpc: 'https://rpc.merlinchain.io',
        explorer: 'https://scan.merlinchain.io',
        blockscout: 'https://scan.merlinchain.io/api',
    },
    {
        id: 'meter',
        chainId: 82,
        label: 'Meter',
        symbol: 'MTR',
        tag: 'MT',
        rpc: 'https://rpc.meter.io',
        explorer: 'https://scan.meter.io',
    },
    {
        id: 'metis',
        chainId: 1088,
        label: 'Metis',
        symbol: 'METIS',
        tag: 'MI',
        rpc: 'https://metis-rpc.publicnode.com',
        explorer: 'https://andromeda-explorer.metis.io',
    },
    {
        id: 'mode',
        chainId: 34443,
        label: 'Mode',
        symbol: 'ETH',
        tag: 'MO',
        rpc: 'https://mainnet.mode.network',
        explorer: 'https://explorer.mode.network',
        blockscout: 'https://explorer.mode.network/api',
    },
    {
        id: 'monad',
        chainId: 143,
        label: 'Monad',
        symbol: 'MON',
        tag: 'MN',
        rpc: 'https://rpc.monad.xyz',
        explorer: 'https://monadscan.com',
    },
    {
        id: 'moonbeam',
        chainId: 1284,
        label: 'Moonbeam',
        symbol: 'GLMR',
        tag: 'MB',
        rpc: 'https://moonbeam.drpc.org',
        explorer: 'https://moonbeam.moonscan.io',
    },
    {
        id: 'moonriver',
        chainId: 1285,
        label: 'Moonriver',
        symbol: 'MOVR',
        tag: 'MR',
        rpc: 'https://moonriver.unitedbloc.com',
        explorer: 'https://moonriver.moonscan.io',
    },
    {
        id: 'morph',
        chainId: 2818,
        label: 'Morph',
        symbol: 'ETH',
        tag: 'MH',
        rpc: 'https://rpc.morphl2.io',
        explorer: 'https://explorer.morphl2.io',
    },
    {
        id: 'neon-evm',
        chainId: 245022934,
        label: 'Neon EVM',
        symbol: 'NEON',
        tag: 'NE',
        rpc: 'https://neon-proxy-mainnet.solana.p2p.org',
        explorer: 'https://neon.blockscout.com',
        blockscout: 'https://neon.blockscout.com/api',
    },
    {
        id: 'nibiru',
        chainId: 6900,
        label: 'Nibiru',
        symbol: 'NIBI',
        tag: 'NI',
        rpc: 'https://evm-rpc.nibiru.fi',
        explorer: 'https://nibiscan.io',
    },
    {
        id: 'oasis-emerald',
        chainId: 42262,
        label: 'Oasis Emerald',
        symbol: 'ROSE',
        tag: 'OE',
        rpc: 'https://emerald.oasis.io',
        explorer: 'https://explorer.oasis.io/mainnet/emerald',
    },
    {
        id: 'oasis-sapphire',
        chainId: 23294,
        label: 'Oasis Sapphire',
        symbol: 'ROSE',
        tag: 'OS',
        rpc: 'https://sapphire.oasis.io',
        explorer: 'https://explorer.oasis.io/mainnet/sapphire',
    },
    {
        id: 'oasys',
        chainId: 248,
        label: 'Oasys',
        symbol: 'OAS',
        tag: 'OA',
        rpc: 'https://rpc.mainnet.oasys.games',
        explorer: 'https://explorer.oasys.games',
    },
    {
        id: 'okx-chain',
        chainId: 66,
        label: 'OKX Chain',
        symbol: 'OKT',
        tag: 'OC',
        rpc: 'https://exchainrpc.okex.org',
        explorer: null,
    },
    {
        id: 'opbnb',
        chainId: 204,
        label: 'opBNB',
        symbol: 'BNB',
        tag: 'OP',
        rpc: 'https://opbnb-rpc.publicnode.com',
        explorer: 'https://mainnet.opbnbscan.com',
    },
    {
        id: 'optimism',
        chainId: 10,
        label: 'Optimism',
        symbol: 'ETH',
        tag: 'OT',
        rpc: 'https://optimism-rpc.publicnode.com',
        explorer: 'https://optimism.blockscout.com',
        blockscout: 'https://optimism.blockscout.com/api',
    },
    {
        id: 'orderly',
        chainId: 291,
        label: 'Orderly',
        symbol: 'ETH',
        tag: 'OR',
        rpc: 'https://rpc.orderly.network',
        explorer: 'https://explorer.orderly.network',
    },
    {
        id: 'plasma',
        chainId: 9745,
        label: 'Plasma',
        symbol: 'XPL',
        tag: 'PL',
        rpc: 'https://rpc.plasma.to',
        explorer: 'https://plasmascan.to',
    },
    {
        id: 'plume',
        chainId: 98866,
        label: 'Plume',
        symbol: 'PLUME',
        tag: 'PU',
        rpc: 'https://rpc.plume.org',
        explorer: 'https://explorer.plume.org',
    },
    {
        id: 'polygon',
        chainId: 137,
        label: 'Polygon',
        symbol: 'POL',
        tag: 'PO',
        rpc: 'https://polygon-bor-rpc.publicnode.com',
        explorer: 'https://polygonscan.com',
    },
    {
        id: 'polygon-zkevm',
        chainId: 1101,
        label: 'Polygon zkEVM',
        symbol: 'ETH',
        tag: 'PZ',
        rpc: 'https://zkevm-rpc.com',
        explorer: 'https://zkevm.polygonscan.com',
    },
    {
        id: 'pulsechain',
        chainId: 369,
        label: 'PulseChain',
        symbol: 'PLS',
        tag: 'PS',
        rpc: 'https://pulsechain-rpc.publicnode.com',
        explorer: 'https://scan.pulsechain.com',
    },
    {
        id: 'ronin',
        chainId: 2020,
        label: 'Ronin',
        symbol: 'RON',
        tag: 'RO',
        rpc: 'https://api.roninchain.com/rpc',
        explorer: 'https://app.roninchain.com',
    },
    {
        id: 'rootstock',
        chainId: 30,
        label: 'Rootstock',
        symbol: 'RBTC',
        tag: 'RT',
        rpc: 'https://public-node.rsk.co',
        explorer: 'https://rootstock.blockscout.com',
        blockscout: 'https://rootstock.blockscout.com/api',
    },
    {
        id: 'scroll',
        chainId: 534352,
        label: 'Scroll',
        symbol: 'ETH',
        tag: 'SC',
        rpc: 'https://scroll-rpc.publicnode.com',
        explorer: 'https://scrollscan.com',
        blockscout: 'https://scrollscan.com/api',
    },
    {
        id: 'sei',
        chainId: 1329,
        label: 'Sei',
        symbol: 'SEI',
        tag: 'SE',
        rpc: 'https://evm-rpc.sei-apis.com',
        explorer: 'https://seiscan.io',
    },
    {
        id: 'shape',
        chainId: 360,
        label: 'Shape',
        symbol: 'ETH',
        tag: 'SH',
        rpc: 'https://mainnet.shape.network',
        explorer: 'https://shapescan.xyz',
        blockscout: 'https://shapescan.xyz/api',
    },
    {
        id: 'shiden',
        chainId: 336,
        label: 'Shiden',
        symbol: 'SDN',
        tag: 'SI',
        rpc: 'https://rpc.shiden.astar.network',
        explorer: 'https://blockscout.com/shiden',
    },
    {
        id: 'shimmer',
        chainId: 148,
        label: 'Shimmer EVM',
        symbol: 'SMR',
        tag: 'SM',
        rpc: 'https://json-rpc.evm.shimmer.network',
        explorer: 'https://explorer.evm.shimmer.network',
    },
    {
        id: 'smartbch',
        chainId: 10000,
        label: 'smartBCH',
        symbol: 'BCH',
        tag: 'SA',
        rpc: 'https://smartbch.greyh.at',
        explorer: 'https://www.smartscan.cash',
    },
    {
        id: 'soneium',
        chainId: 1868,
        label: 'Soneium',
        symbol: 'ETH',
        tag: 'SN',
        rpc: 'https://rpc.soneium.org',
        explorer: 'https://soneium.blockscout.com',
        blockscout: 'https://soneium.blockscout.com/api',
    },
    {
        id: 'songbird',
        chainId: 19,
        label: 'Songbird',
        symbol: 'SGB',
        tag: 'SG',
        rpc: 'https://songbird-api.flare.network/ext/C/rpc',
        explorer: 'https://songbird-explorer.flare.network',
        blockscout: 'https://songbird-explorer.flare.network/api',
    },
    {
        id: 'sonic',
        chainId: 146,
        label: 'Sonic',
        symbol: 'S',
        tag: 'ON',
        rpc: 'https://sonic-rpc.publicnode.com',
        explorer: 'https://sonicscan.org',
    },
    {
        id: 'sophon',
        chainId: 50104,
        label: 'Sophon',
        symbol: 'SOPH',
        tag: 'SP',
        rpc: 'https://rpc.sophon.xyz',
        explorer: 'https://explorer.sophon.xyz',
    },
    {
        id: 'story',
        chainId: 1514,
        label: 'Story',
        symbol: 'IP',
        tag: 'ST',
        rpc: 'https://mainnet.storyrpc.io',
        explorer: 'https://www.storyscan.io',
        blockscout: 'https://www.storyscan.io/api',
    },
    {
        id: 'superposition',
        chainId: 55244,
        label: 'Superposition',
        symbol: 'ETH',
        tag: 'SU',
        rpc: 'https://rpc.superposition.so',
        explorer: 'https://explorer.superposition.so',
    },
    {
        id: 'superseed',
        chainId: 5330,
        label: 'Superseed',
        symbol: 'ETH',
        tag: 'SR',
        rpc: 'https://mainnet.superseed.xyz',
        explorer: 'https://explorer.superseed.xyz',
    },
    {
        id: 'syscoin',
        chainId: 57,
        label: 'Syscoin',
        symbol: 'SYS',
        tag: 'SY',
        rpc: 'https://syscoin-evm.publicnode.com',
        explorer: 'https://explorer.syscoin.org',
        blockscout: 'https://explorer.syscoin.org/api',
    },
    {
        id: 'taiko',
        chainId: 167000,
        label: 'Taiko',
        symbol: 'ETH',
        tag: 'TA',
        rpc: 'https://taiko-rpc.publicnode.com',
        explorer: 'https://taikoscan.io',
    },
    {
        id: 'telos',
        chainId: 40,
        label: 'Telos',
        symbol: 'TLOS',
        tag: 'TE',
        rpc: 'https://rpc.telos.net',
        explorer: 'https://teloscan.io',
        blockscout: 'https://teloscan.io/api',
    },
    {
        id: 'thundercore',
        chainId: 108,
        label: 'ThunderCore',
        symbol: 'TT',
        tag: 'TH',
        rpc: 'https://mainnet-rpc.thundercore.com',
        explorer: 'https://explorer-mainnet.thundercore.com',
        blockscout: 'https://explorer-mainnet.thundercore.com/api',
    },
    {
        id: 'unichain',
        chainId: 130,
        label: 'Unichain',
        symbol: 'ETH',
        tag: 'UN',
        rpc: 'https://unichain-rpc.publicnode.com',
        explorer: 'https://unichain.blockscout.com',
        blockscout: 'https://unichain.blockscout.com/api',
    },
    {
        id: 'velas',
        chainId: 106,
        label: 'Velas',
        symbol: 'VLX',
        tag: 'VE',
        rpc: 'https://evmexplorer.velas.com/rpc',
        explorer: 'https://evmexplorer.velas.com',
        blockscout: 'https://evmexplorer.velas.com/api',
    },
    {
        id: 'viction',
        chainId: 88,
        label: 'Viction',
        symbol: 'VIC',
        tag: 'VI',
        rpc: 'https://rpc.viction.xyz',
        explorer: 'https://vicscan.xyz',
    },
    {
        id: 'wanchain',
        chainId: 888,
        label: 'Wanchain',
        symbol: 'WAN',
        tag: 'WA',
        rpc: 'https://gwan-ssl.wandevs.org:56891',
        explorer: 'https://wanscan.org',
    },
    {
        id: 'wemix',
        chainId: 1111,
        label: 'WEMIX',
        symbol: 'WEMIX',
        tag: 'WE',
        rpc: 'https://api.wemix.com',
        explorer: 'https://explorer.wemix.com',
    },
    {
        id: 'world-chain',
        chainId: 480,
        label: 'World Chain',
        symbol: 'ETH',
        tag: 'WC',
        rpc: 'https://480.rpc.thirdweb.com',
        explorer: 'https://worldchain-mainnet.explorer.alchemy.com',
        blockscout: 'https://worldchain-mainnet.explorer.alchemy.com/api',
    },
    {
        id: 'x-layer',
        chainId: 196,
        label: 'X Layer',
        symbol: 'OKB',
        tag: 'XL',
        rpc: 'https://rpc.xlayer.tech',
        explorer: null,
    },
    {
        id: 'xai',
        chainId: 660279,
        label: 'Xai',
        symbol: 'XAI',
        tag: 'XA',
        rpc: 'https://xai-chain.net/rpc',
        explorer: 'https://explorer.xai-chain.net',
        blockscout: 'https://explorer.xai-chain.net/api',
    },
    {
        id: 'xdc',
        chainId: 50,
        label: 'XDC Network',
        symbol: 'XDC',
        tag: 'XN',
        rpc: 'https://rpc.xinfin.network',
        explorer: 'https://xdcscan.com',
    },
    {
        id: 'zetachain',
        chainId: 7000,
        label: 'ZetaChain',
        symbol: 'ZETA',
        tag: 'ZE',
        rpc: 'https://zeta-chain.drpc.org',
        explorer: 'https://zetascan.com',
        blockscout: 'https://zetascan.com/api',
    },
    {
        id: 'zilliqa',
        chainId: 32769,
        label: 'Zilliqa',
        symbol: 'ZIL',
        tag: 'ZI',
        rpc: 'https://api.zilliqa.com',
        explorer: 'https://zilliqa.blockscout.com',
        blockscout: 'https://zilliqa.blockscout.com/api',
    },
    {
        id: 'zircuit',
        chainId: 48900,
        label: 'Zircuit',
        symbol: 'ETH',
        tag: 'ZR',
        rpc: 'https://mainnet.zircuit.com',
        explorer: 'https://explorer.zircuit.com',
    },
    {
        id: 'zklink-nova',
        chainId: 810180,
        label: 'zkLink Nova',
        symbol: 'ETH',
        tag: 'ZN',
        rpc: 'https://rpc.zklink.io',
        explorer: 'https://explorer.zklink.io',
    },
    {
        id: 'zksync-era',
        chainId: 324,
        label: 'zkSync Era',
        symbol: 'ETH',
        tag: 'ZK',
        rpc: 'https://mainnet.era.zksync.io',
        explorer: 'https://zksync.blockscout.com',
        blockscout: 'https://zksync.blockscout.com/api',
    },
    {
        id: 'zora',
        chainId: 7777777,
        label: 'Zora',
        symbol: 'ETH',
        tag: 'ZO',
        rpc: 'https://rpc.zora.energy',
        explorer: 'https://explorer.zora.energy',
    },
];

const STORAGE_KEY = 'cyberia.wallet.networks.v2';

/** What the key was called while only catalogue networks had a switch. */
const LEGACY_KEY = 'cyberia.wallet.catalogue.v1';

/** Catalogue entries by id, for the lookups the wallet does on every unlock. */
const BY_ID = new Map(
    NETWORK_CATALOGUE.map((network) => [network.id, network] as const),
);

export const catalogueNetwork = (id: WalletChainId): CatalogueNetwork | null =>
    BY_ID.get(id) ?? null;

/**
 * What this device has decided about each network, and only that.
 *
 * Deviations rather than a list of what is on, because every network now has a
 * default and the two kinds of default are the only thing separating a shipped
 * network from a catalogue one: some arrive on, most arrive off, and a stored
 * list of "what is on" would have quietly frozen that distinction into the
 * saved state. A network absent from this map is at its default, which is also
 * what makes a shipped list that grows later reach existing wallets.
 */
export type NetworkChoices = Record<string, boolean>;

export const readNetworkChoices = (): NetworkChoices => {
    if (typeof window === 'undefined') {
        return {};
    }

    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);

        if (raw) {
            const parsed: unknown = JSON.parse(raw);

            if (
                parsed &&
                typeof parsed === 'object' &&
                !Array.isArray(parsed)
            ) {
                return Object.fromEntries(
                    Object.entries(parsed as Record<string, unknown>).filter(
                        (entry): entry is [string, boolean] =>
                            typeof entry[1] === 'boolean',
                    ),
                );
            }
        }

        /*
         * The old key held the catalogue ids that were switched on, which is
         * exactly a set of deviations from a default of off — so it migrates
         * without asking anybody anything, and the wallet opens on the same
         * networks it closed on.
         */
        const legacy: unknown = JSON.parse(
            window.localStorage.getItem(LEGACY_KEY) ?? '[]',
        );

        return Array.isArray(legacy)
            ? Object.fromEntries(
                  legacy
                      .filter(
                          (id): id is string =>
                              typeof id === 'string' && BY_ID.has(id),
                      )
                      .map((id) => [id, true] as const),
              )
            : {};
    } catch {
        // A corrupt list is a settings problem, never a funds problem: the
        // accounts are in the seed, and switching a network back on restores
        // the card exactly as it was.
        return {};
    }
};

export const writeNetworkChoices = (choices: NetworkChoices): void => {
    if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(choices));
    }
};

/**
 * A catalogue entry as a wallet chain.
 *
 * Deliberately the *same* factory every other EVM network is made with, and
 * that is the point: a network switched on here reads its balance, lists its
 * tokens, quotes its fees and signs its transfers through exactly the code
 * path Cyberia and Base do. The only thing that varies is what the entry
 * declares — a chain with no keyless index says so instead of showing an empty
 * token list, and one with no explorer says so instead of linking nowhere.
 */
export const catalogueWalletChain = (network: CatalogueNetwork): WalletChain =>
    evmChain({
        id: network.id,
        chainId: network.chainId,
        label: network.label,
        mark: catalogueMark(network),
        params: {
            symbol: network.symbol,
            decimals: network.decimals ?? 18,
            rpcUrl: network.rpc,
            explorer: network.explorer,
        },
        blockscoutApi: network.blockscout,
        historyNote: network.blockscout ? undefined : 'historyNoIndexer',
    });

/** The adapters for a stored list of ids, in catalogue order. */
export const catalogueWalletChains = (
    ids: readonly WalletChainId[],
): WalletChain[] =>
    NETWORK_CATALOGUE.filter((network) => ids.includes(network.id)).map(
        catalogueWalletChain,
    );

/**
 * The catalogue, filtered by what somebody typed.
 *
 * Chain id is searchable alongside name and symbol because that is how half of
 * these networks are actually identified — a user arriving from a dapp that
 * said "switch to 42161" has a number and not a name. Pure, and pinned by
 * `tests/Frontend/WalletCatalogueTest.mjs`.
 */
export const searchCatalogue = (
    query: string,
    networks: readonly CatalogueNetwork[] = NETWORK_CATALOGUE,
): CatalogueNetwork[] => {
    const term = query.trim().toLowerCase();

    if (term === '') {
        return [...networks];
    }

    return networks.filter(
        (network) =>
            network.label.toLowerCase().includes(term) ||
            network.symbol.toLowerCase().includes(term) ||
            network.id.toLowerCase().includes(term) ||
            String(network.chainId) === term ||
            String(network.chainId).startsWith(term),
    );
};

/**
 * What one catalogue row can honestly promise, as a set of message keys.
 *
 * Balances and sending are true of every EVM network by construction — the key
 * is the same and the RPC was verified. Tokens and history are true only where
 * a keyless index exists, and the row says which it is rather than letting the
 * user find out on the network screen.
 */
export const catalogueCapabilities = (
    network: CatalogueNetwork,
): { indexed: boolean; explorer: boolean } => ({
    indexed: network.blockscout !== undefined,
    explorer: network.explorer !== null,
});
