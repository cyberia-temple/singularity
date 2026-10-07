import {
    Contract,
    JsonRpcProvider,
    getAddress,
    keccak256,
    toUtf8Bytes,
} from 'ethers';
import type { Signer } from 'ethers';
import { CYBERIA_CHAIN, cyberiaReadRpcUrl } from '@/lib/evmChains';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';
import { explorerFailure } from '@/lib/wallet/readError';

/**
 * Domains: names that are NFTs, in zones that tokens open.
 *
 * `CyberiaDomains` holds both halves. A domain (`lain.moon`) is an ERC-721 —
 * whoever holds it writes its records, and selling the token sells the name.
 * A zone (`moon`) is a launchpad token named `.moon` with the ticker
 * `DOTMOON`: the contract reads the name and ticker off the token, checks a
 * Cyberia launchpad listed it, and opens the zone for anyone who asks. A name
 * in `.cyber` costs CYBER; a name in a token's zone costs that token, and the
 * payment is burned, because a launchpad keeps no record of who launched what
 * and so a zone has no owner who could be paid.
 *
 * `services/cyberia-dns` turns the records into DNS, and its JSON view is
 * what the wallet's browser reads (`DNS_API`). Reads that decide something
 * the user signs — whether a name is free, what it costs — come from the
 * chain here, never from that server.
 */

/** deployments/cyberia-domains.json */
export const DOMAINS_ADDRESS =
    ((import.meta.env ?? {}) as Record<string, string | undefined>)
        .VITE_CYBERIA_DOMAINS ?? '0xA827D058a5738EaC28DB1d658D3e8cFb82CBb66B';

export const DOMAINS_CHAIN_ID = CYBERIA_CHAIN.chainId;
export const ROOT_ZONE = 'cyber';

/** The DNS server's JSON view: `/api/resolve?name=` and `/api/zones`. */
export const DNS_API =
    ((import.meta.env ?? {}) as Record<string, string | undefined>)
        .VITE_CYBERIA_DNS_URL ?? 'https://dns.cyberia.church';

const DOMAINS_ABI = [
    'function zones() view returns (string[] labels, address[] tokens, bool[] blocked)',
    'function zone(string zone_) view returns (bool exists, address token, bool blocked, uint256 fee, uint64 createdAt)',
    'function zoneOfToken(address token) view returns (string)',
    'function zoneFromToken(string name_, string symbol_) pure returns (string)',
    'function launched(address token) view returns (bool)',
    'function available(string label, string zone_) view returns (bool)',
    'function tokenIdOf(string label, string zone_) pure returns (uint256)',
    'function domain(uint256 tokenId) view returns (string label, string zone_, uint64 registeredAt)',
    'function ownerOf(uint256 tokenId) view returns (address)',
    'function records(string label, string zone_) view returns (string[] keys, string[] values)',
    'function register(string label, string zone_) payable returns (uint256)',
    'function setRecords(string label, string zone_, string[] keys, string[] values)',
    'function createZone(address token) returns (string)',
];

const ERC20_ABI = [
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
];

/* --------------------------------------------------------------- rules --- */

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** A DNS label: lowercase `[a-z0-9-]`, 1–63, no hyphen at either end. */
export const validLabel = (label: string): boolean => LABEL.test(label);

/**
 * The zone a token's name and ticker spell, or null — `CyberiaDomains.
 * zoneFromToken` restated: `.moon` + `DOTMOON` → `moon`, case folded on both.
 */
export const zoneFromToken = (name: string, symbol: string): string | null => {
    if (!name.startsWith('.') || symbol.length !== name.length + 2) {
        return null;
    }

    // ASCII only, as the contract folds: `toLowerCase` would fold `İ` too.
    const fold = (text: string): string =>
        text.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const zone = fold(name.slice(1));

    if (!validLabel(zone) || fold(symbol) !== `dot${zone}`) {
        return null;
    }

    return zone;
};

/** What to name a token so that launching it opens `zone`. */
export const zoneTokenNaming = (
    zone: string,
): { name: string; symbol: string } => ({
    name: `.${zone}`,
    symbol: `DOT${zone.toUpperCase()}`,
});

/** `uint256(keccak256(abi.encodePacked(label, ".", zone)))`. */
export const domainTokenId = (label: string, zone: string): bigint =>
    BigInt(keccak256(toUtf8Bytes(`${label}.${zone}`)));

/** `lain.moon` → { label, zone }, or null when it is not a domain in `zones`. */
export const splitDomain = (
    name: string,
    zones: readonly string[],
): { label: string; zone: string; sub: string } | null => {
    const host = name.trim().toLowerCase().replace(/\.$/, '');
    const parts = host.split('.');

    if (parts.length < 2) {
        return null;
    }

    const zone = parts[parts.length - 1];

    if (!zones.includes(zone)) {
        return null;
    }

    const label = parts[parts.length - 2];

    if (!validLabel(label) || parts.slice(0, -2).some((p) => !validLabel(p))) {
        return null;
    }

    return { label, zone, sub: parts.slice(0, -2).join('.') };
};

/* --------------------------------------------------------- address bar --- */

export type BrowserTarget =
    | { kind: 'domain'; name: string; path: string }
    | { kind: 'url'; url: string }
    | { kind: 'invalid' };

const IPFS_READ_GATEWAY = 'https://ipfs.io';

/**
 * What somebody typed into the wallet's address bar.
 *
 * A host whose last label is a served zone is a domain, whatever scheme it
 * came with — `http://lain.moon/a`, `lain.moon` and `lain.moon/a` are the same
 * place. `ipfs://` goes through a public gateway. Anything else with a dot is
 * a web address and gets `https://` when it came without a scheme; plain
 * `http://` is kept, because refusing it would be this screen's opinion — the
 * page decides whether it can frame it.
 */
export const parseAddress = (
    input: string,
    zones: readonly string[],
): BrowserTarget => {
    const text = input.trim();

    if (text === '') {
        return { kind: 'invalid' };
    }

    const ipfs = text.match(/^ipfs:\/\/([A-Za-z0-9]+)(\/.*)?$/);

    if (ipfs) {
        return {
            kind: 'url',
            url: `${IPFS_READ_GATEWAY}/ipfs/${ipfs[1]}${ipfs[2] ?? '/'}`,
        };
    }

    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
        ? text
        : `https://${text}`;

    let url: URL;

    try {
        url = new URL(withScheme);
    } catch {
        return { kind: 'invalid' };
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        return { kind: 'invalid' };
    }

    const host = url.hostname.toLowerCase();

    if (splitDomain(host, zones)) {
        return {
            kind: 'domain',
            name: host,
            path: `${url.pathname}${url.search}${url.hash}`,
        };
    }

    if (!host.includes('.') && host !== 'localhost') {
        return { kind: 'invalid' };
    }

    return { kind: 'url', url: url.toString() };
};

/* ------------------------------------------------------------- records --- */

/** How a domain's visit is answered, as the editor offers it. */
export type SiteKind = 'none' | 'url' | 'ipfs' | 'host' | 'alias';

/** The record keys each kind of site owns — choosing one clears the others. */
const SITE_KEYS = ['url', 'ipfs', 'CNAME', 'A', 'AAAA'] as const;

/** Which kind of site a domain's current records describe. */
export const siteKindOf = (records: Record<string, string>): SiteKind => {
    if (records.url) {
        return 'url';
    }

    if (records.CNAME) {
        return 'alias';
    }

    if (records.ipfs) {
        return 'ipfs';
    }

    if (records.A || records.AAAA) {
        return 'host';
    }

    return 'none';
};

export type SiteForm = {
    kind: SiteKind;
    url: string;
    ipfs: string;
    alias: string;
    ipv4: string;
    ipv6: string;
};

const IPV4 =
    /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST =
    /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/;

/** Why a site form cannot be saved, as a message key, or null when it can. */
export const siteProblem = (form: SiteForm): string | null => {
    if (form.kind === 'url' && !/^https?:\/\/\S+$/i.test(form.url.trim())) {
        return 'domainBadUrl';
    }

    if (form.kind === 'ipfs') {
        const value = form.ipfs.trim().replace(/^ipfs:\/\//, '');

        if (!CID.test(value) && !/^\/(ipfs|ipns)\/\S+$/.test(value)) {
            return 'domainBadCid';
        }
    }

    if (
        form.kind === 'alias' &&
        !HOST.test(form.alias.trim().toLowerCase().replace(/\.$/, ''))
    ) {
        return 'domainBadAlias';
    }

    if (form.kind === 'host') {
        const v4 = form.ipv4.split(/[\s,]+/).filter(Boolean);
        const v6 = form.ipv6.split(/[\s,]+/).filter(Boolean);

        if (v4.length + v6.length === 0 || v4.some((ip) => !IPV4.test(ip))) {
            return 'domainBadIp';
        }

        if (v6.some((ip) => !/^[0-9a-f:.]+$/i.test(ip) || !ip.includes(':'))) {
            return 'domainBadIp';
        }
    }

    return null;
};

/** The site keys a form writes: its own kind's value, every other one cleared. */
export const siteRecords = (form: SiteForm): Record<string, string> => {
    const out: Record<string, string> = Object.fromEntries(
        SITE_KEYS.map((key) => [key, '']),
    );

    if (form.kind === 'url') {
        out.url = form.url.trim();
    } else if (form.kind === 'ipfs') {
        out.ipfs = form.ipfs.trim().replace(/^ipfs:\/\//, '');
    } else if (form.kind === 'alias') {
        out.CNAME = form.alias.trim().toLowerCase().replace(/\.$/, '');
    } else if (form.kind === 'host') {
        out.A = form.ipv4
            .split(/[\s,]+/)
            .filter(Boolean)
            .join(' ');
        out.AAAA = form.ipv6
            .split(/[\s,]+/)
            .filter(Boolean)
            .join(' ');
    }

    return out;
};

/**
 * Only what changed, as the two parallel arrays `setRecords` takes. An empty
 * value deletes a key, and a key that is already what it would be set to is
 * left out — every string written is gas.
 */
export const recordChanges = (
    current: Record<string, string>,
    next: Record<string, string>,
): { keys: string[]; values: string[] } => {
    const keys: string[] = [];
    const values: string[] = [];

    for (const [key, value] of Object.entries(next)) {
        if ((current[key] ?? '') !== value) {
            keys.push(key);
            values.push(value);
        }
    }

    return { keys, values };
};

/* --------------------------------------------------------------- reads --- */

const provider = (rpcUrl?: string): JsonRpcProvider =>
    new JsonRpcProvider(rpcUrl || cyberiaReadRpcUrl(), DOMAINS_CHAIN_ID, {
        staticNetwork: true,
    });

const domains = (runner: JsonRpcProvider | Signer): Contract =>
    new Contract(DOMAINS_ADDRESS, DOMAINS_ABI, runner);

export type ZoneInfo = {
    zone: string;
    /** The token that opened it; null for `.cyber`, which costs CYBER. */
    token: string | null;
    /** What one name costs, in the zone's own unit (wei of CYBER, or token units). */
    fee: bigint;
    symbol: string;
    decimals: number;
};

/** Every open zone, with its price and the unit that price is in. */
export const readZones = async (rpcUrl?: string): Promise<ZoneInfo[]> => {
    const rpc = provider(rpcUrl);
    const contract = domains(rpc);
    const [labels, tokens, blocked] = (await contract.zones()) as [
        string[],
        string[],
        boolean[],
    ];

    const open = labels
        .map((zone, i) => ({ zone, token: tokens[i], blocked: blocked[i] }))
        .filter((entry) => !entry.blocked);

    return Promise.all(
        open.map(async ({ zone, token }) => {
            const [, , , fee] = (await contract.zone(zone)) as [
                boolean,
                string,
                boolean,
                bigint,
            ];

            if (/^0x0{40}$/i.test(token)) {
                return {
                    zone,
                    token: null,
                    fee,
                    symbol: 'CYBER',
                    decimals: 18,
                };
            }

            const erc20 = new Contract(token, ERC20_ABI, rpc);
            const [symbol, decimals] = await Promise.all([
                erc20.symbol() as Promise<string>,
                erc20.decimals() as Promise<bigint>,
            ]);

            return {
                zone,
                token: getAddress(token),
                fee,
                symbol,
                decimals: Number(decimals),
            };
        }),
    );
};

export type DomainState = {
    name: string;
    label: string;
    zone: string;
    tokenId: bigint;
    /** Null when nobody holds it. */
    owner: string | null;
    records: Record<string, string>;
};

/** One name as the chain has it: who holds it and every record it carries. */
export const readDomain = async (
    label: string,
    zone: string,
    rpcUrl?: string,
): Promise<DomainState> => {
    const contract = domains(provider(rpcUrl));
    const tokenId = domainTokenId(label, zone);
    const [owner, [keys, values]] = await Promise.all([
        (contract.ownerOf(tokenId) as Promise<string>).catch(() => null),
        contract.records(label, zone) as Promise<[string[], string[]]>,
    ]);

    return {
        name: `${label}.${zone}`,
        label,
        zone,
        tokenId,
        owner: owner ? getAddress(owner) : null,
        records: Object.fromEntries(keys.map((key, i) => [key, values[i]])),
    };
};

/**
 * The domains an address holds.
 *
 * Which token ids it holds comes from the chain's keyless index (the same
 * Blockscout call the NFT tab makes), and what each id *is* from the contract
 * — an index's copy of on-chain metadata can lag, and the name is the whole
 * point of the row.
 */
export const fetchOwnedDomains = async (
    owner: string,
    explorerUrl = 'https://explorer.cyberia.church',
    rpcUrl?: string,
): Promise<
    { name: string; label: string; zone: string; tokenId: bigint }[]
> => {
    const response = await fetch(
        `${explorerUrl}/api/v2/addresses/${owner}/nft?type=ERC-721`,
        { headers: { Accept: 'application/json' } },
    );

    if (!response.ok) {
        throw explorerFailure(response.status);
    }

    const body = (await response.json()) as {
        items?: {
            id?: string;
            token?: { address_hash?: string; address?: string };
        }[];
    };
    const ids = (body.items ?? [])
        .filter(
            (item) =>
                (
                    item.token?.address_hash ??
                    item.token?.address ??
                    ''
                ).toLowerCase() === DOMAINS_ADDRESS.toLowerCase(),
        )
        .map((item) => BigInt(item.id ?? '0'));

    const contract = domains(provider(rpcUrl));

    const rows = await Promise.all(
        ids.map(async (tokenId) => {
            const [label, zone] = (await contract.domain(tokenId)) as [
                string,
                string,
            ];

            return { name: `${label}.${zone}`, label, zone, tokenId };
        }),
    );

    return rows.sort((a, b) => a.name.localeCompare(b.name));
};

/* ------------------------------------------------------- what to visit --- */

/** `/api/resolve` as the DNS server answers it. */
export type ResolvedName = {
    name: string;
    zone: string | null;
    label?: string | null;
    sub?: string;
    registered?: boolean;
    owner?: string;
    addr?: string;
    records?: Record<'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX', unknown[]>;
    target?:
        | { kind: 'url' | 'cname'; url: string }
        | { kind: 'ipfs'; url: string; path: string }
        | { kind: 'name'; name: string }
        | { kind: 'host'; url: string }
        | { kind: 'none' };
};

export const fetchServedZones = async (): Promise<string[]> => {
    const response = await fetch(`${DNS_API}/api/zones`, {
        headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
        throw new Error(`zones ${response.status}`);
    }

    const body = (await response.json()) as { zones?: { zone: string }[] };

    return (body.zones ?? []).map((entry) => entry.zone);
};

export const resolveName = async (name: string): Promise<ResolvedName> => {
    const response = await fetch(
        `${DNS_API}/api/resolve?name=${encodeURIComponent(name)}`,
        { headers: { Accept: 'application/json' } },
    );

    if (!response.ok) {
        throw new Error(
            response.status === 503
                ? 'chainUnreadable'
                : `resolve ${response.status}`,
        );
    }

    return (await response.json()) as ResolvedName;
};

/* -------------------------------------------------------------- writes --- */

/** Gas this wallet will spend on each act; a quote above it is refused. */
export const DOMAIN_GAS = {
    approve: 90_000n,
    register: 450_000n,
    records: 1_500_000n,
    zone: 400_000n,
} as const;

const MARGIN = [125n, 100n] as const;

export type RegistrationQuote = {
    label: string;
    zone: string;
    token: string | null;
    /** The price, in CYBER wei or zone-token units. */
    fee: bigint;
    symbol: string;
    decimals: number;
    /** True when the zone token must be approved first (exactly `fee`). */
    needsApproval: boolean;
    /** Payer's balance of what the price is paid in. */
    balance: bigint;
    gasPrice: bigint;
    /** Worst-case gas cost in CYBER wei, approval included. */
    gasFee: bigint;
};

const gasPriceOf = async (rpc: JsonRpcProvider): Promise<bigint> => {
    const data = await rpc.getFeeData();
    const price = data.gasPrice ?? data.maxFeePerGas;

    if (price === null || price === undefined) {
        throw new Error('The network did not report a gas price');
    }

    return price;
};

/**
 * What registering `label.zone` will cost, before anything is signed: the
 * price, what it is paid in, whether an approval comes first, and the gas.
 * Throws a message key when the name cannot be had.
 */
export const quoteRegistration = async (
    label: string,
    zone: string,
    from: string,
    rpcUrl?: string,
): Promise<RegistrationQuote> => {
    if (!validLabel(label)) {
        throw new Error('domainBadLabel');
    }

    const rpc = provider(rpcUrl);
    const contract = domains(rpc);
    const [[exists, token, blocked, fee], free, gasPrice] = await Promise.all([
        contract.zone(zone) as Promise<[boolean, string, boolean, bigint]>,
        contract.available(label, zone) as Promise<boolean>,
        gasPriceOf(rpc),
    ]);

    if (!exists || blocked) {
        throw new Error('domainNoZone');
    }

    if (!free) {
        throw new Error('domainTaken');
    }

    if (/^0x0{40}$/i.test(token)) {
        const balance = await rpc.getBalance(from);

        return {
            label,
            zone,
            token: null,
            fee,
            symbol: 'CYBER',
            decimals: 18,
            needsApproval: false,
            balance,
            gasPrice,
            gasFee: DOMAIN_GAS.register * gasPrice,
        };
    }

    const erc20 = new Contract(token, ERC20_ABI, rpc);
    const [symbol, decimals, allowance, balance] = await Promise.all([
        erc20.symbol() as Promise<string>,
        erc20.decimals() as Promise<bigint>,
        erc20.allowance(from, DOMAINS_ADDRESS) as Promise<bigint>,
        erc20.balanceOf(from) as Promise<bigint>,
    ]);
    const needsApproval = fee > 0n && allowance < fee;

    return {
        label,
        zone,
        token: getAddress(token),
        fee,
        symbol,
        decimals: Number(decimals),
        needsApproval,
        balance,
        gasPrice,
        gasFee:
            (DOMAIN_GAS.register + (needsApproval ? DOMAIN_GAS.approve : 0n)) *
            gasPrice,
    };
};

const capped = async (
    estimate: Promise<bigint>,
    cap: bigint,
): Promise<bigint> => {
    try {
        const gas = ((await estimate) * MARGIN[0]) / MARGIN[1];

        if (gas > cap) {
            throw new Error('domainGasCap');
        }

        return gas;
    } catch (error) {
        // A refusal the contract explains is a reason to stop; a node that
        // will not estimate is not — the cap is what the user agreed to.
        if (error instanceof Error && error.message === 'domainGasCap') {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error);

        if (/revert|execution reverted|CALL_EXCEPTION/i.test(message)) {
            throw new Error(message);
        }

        return cap;
    }
};

/**
 * Register a name: approve exactly the fee when the zone token needs it, wait
 * for that, then register. Returns the registration's hash.
 */
export const registerDomain = async (
    source: WalletKeySource,
    quote: RegistrationQuote,
    rpcUrl?: string,
): Promise<string> => {
    const rpc = provider(rpcUrl);
    const signer = evmSigner(source).connect(rpc);
    const contract = domains(signer);

    if (quote.token && quote.needsApproval) {
        const erc20 = new Contract(quote.token, ERC20_ABI, signer);
        const approval = await erc20.approve(DOMAINS_ADDRESS, quote.fee, {
            gasLimit: DOMAIN_GAS.approve,
            gasPrice: quote.gasPrice,
        });
        const receipt = await approval.wait(1, 120_000);

        if (receipt?.status !== 1) {
            throw new Error('domainApproveFailed');
        }
    }

    const value = quote.token ? 0n : quote.fee;
    const gasLimit = await capped(
        contract.register.estimateGas(quote.label, quote.zone, { value }),
        DOMAIN_GAS.register,
    );
    const tx = await contract.register(quote.label, quote.zone, {
        value,
        gasLimit,
        gasPrice: quote.gasPrice,
    });

    return tx.hash as string;
};

export const writeDomainRecords = async (
    source: WalletKeySource,
    label: string,
    zone: string,
    keys: string[],
    values: string[],
    rpcUrl?: string,
): Promise<string> => {
    const rpc = provider(rpcUrl);
    const contract = domains(evmSigner(source).connect(rpc));
    const gasLimit = await capped(
        contract.setRecords.estimateGas(label, zone, keys, values),
        DOMAIN_GAS.records,
    );
    const tx = await contract.setRecords(label, zone, keys, values, {
        gasLimit,
        gasPrice: await gasPriceOf(rpc),
    });

    return tx.hash as string;
};

/** Open the zone a launchpad token spells. Anyone may; nothing is paid. */
export const openZone = async (
    source: WalletKeySource,
    token: string,
    rpcUrl?: string,
): Promise<string> => {
    const rpc = provider(rpcUrl);
    const contract = domains(evmSigner(source).connect(rpc));
    const gasLimit = await capped(
        contract.createZone.estimateGas(token),
        DOMAIN_GAS.zone,
    );
    const tx = await contract.createZone(token, {
        gasLimit,
        gasPrice: await gasPriceOf(rpc),
    });

    return tx.hash as string;
};

/** Which zone, if any, a token already opened (`''` when none). */
export const zoneOfToken = async (
    token: string,
    rpcUrl?: string,
): Promise<string | null> => {
    const zone = (await domains(provider(rpcUrl)).zoneOfToken(token)) as string;

    return zone === '' ? null : zone;
};

/** Wait for a transaction; false when it reverted or never arrived. */
export const awaitDomainTx = async (
    hash: string,
    rpcUrl?: string,
): Promise<boolean> => {
    const receipt = await provider(rpcUrl).waitForTransaction(hash, 1, 180_000);

    return receipt?.status === 1;
};

export const domainTxUrl = (hash: string): string =>
    `https://explorer.cyberia.church/tx/${hash}`;

/** Whether a zone is already open (and so no other token can open it). */
export const zoneExists = async (
    zone: string,
    rpcUrl?: string,
): Promise<boolean> => {
    const [exists] = (await domains(provider(rpcUrl)).zone(zone)) as [boolean];

    return exists;
};
