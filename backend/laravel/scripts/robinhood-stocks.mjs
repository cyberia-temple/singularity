#!/usr/bin/env node
/**
 * Regenerates `resources/js/lib/robinhoodStocks.ts` and the icons beside it.
 *
 * Everything in that file comes from Robinhood's own asset registry — the one
 * place that can say which contract is the real NVDA. It matters more here than
 * it looks: a search for "NVDA" on chain 4663 through a router's catalogue
 * comes back with nine tokens, eight of which are somebody's copy of the name.
 * A ticker is not an identifier on a chain anyone can deploy to, so the address
 * has to come from the issuer and be written down, not looked up at runtime.
 *
 * Three things are checked before a row is written:
 *
 *   - the asset is `ASSET_STATUS_ACTIVE` and deployed on Robinhood Chain;
 *   - the contract answers `symbol()` and `decimals()` with what the registry
 *     claims — a mismatch means the registry and the chain disagree, and this
 *     script says so instead of shipping the guess;
 *   - the logo resolves. It is fetched by **ISIN** rather than by ticker, for
 *     the same reason the address is: an ISIN identifies the security, a ticker
 *     identifies it only if you already know the exchange. Icons are vendored
 *     into `public/token-icons/stocks/` rather than hot-linked, because a
 *     wallet page fetching 53 images from a third party tells that third party
 *     what somebody holds.
 *
 * Robinhood's own `logoUrl` is deliberately unused: it answers every address
 * with the same lime feather.
 *
 *   node scripts/robinhood-stocks.mjs            # rewrite registry + icons
 *   node scripts/robinhood-stocks.mjs --check    # verify, write nothing
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, getAddress } from 'ethers';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const ASSETS_URL = 'https://api.robinhood.com/rhj/assets';
const LOGO_URL = (isin) => `https://assets.parqet.com/logos/isin/${isin}`;
const RPC = 'https://rpc.mainnet.chain.robinhood.com';
const CHAIN_ID = 4663;

const REGISTRY = resolve(root, 'resources/js/lib/robinhoodStocks.ts');
const PHP_REGISTRY = resolve(root, 'config/robinhood.php');
const ICONS = resolve(root, 'public/token-icons/stocks');

/**
 * What this project lists, in the order it lists it.
 *
 * Robinhood tokenises about two hundred securities; this is the shortlist the
 * screens are built around, and the order is the order they are drawn in — the
 * names people come looking for first, then the funds, which are a different
 * kind of thing and are labelled as one.
 */
const EQUITIES = [
    'NVDA', 'SPCX', 'GOOGL', 'TSLA', 'GME', 'AAPL', 'SNDK', 'AMD', 'AMZN',
    'MSFT', 'META', 'CRCL', 'COIN', 'MU', 'PLTR', 'TTWO', 'RIVN', 'COST',
    'DJT', 'MSTR', 'RDDT', 'HIMS', 'BB', 'LLY', 'WYFI', 'TSM', 'RBLX', 'SKHY',
    'DELL', 'SNAP', 'LULU', 'FIG', 'MRNA', 'PFE', 'MRVL', 'JNJ', 'AMC', 'BABA',
    'IBM', 'NFLX', 'BULL', 'NU', 'SHOP', 'BE', 'F', 'UPS',
];

const FUNDS = ['SPY', 'QQQ', 'GLD', 'SGOV', 'INDA', 'SLV', 'USO'];

const ERC20 = new Interface([
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
]);

const check = process.argv.includes('--check');

/**
 * Two names the registry gives in full because a registry has to, and a row on
 * a phone cannot: "Space Exploration Technologies Corp. Class A Common Stock"
 * is 57 characters of label for six characters of company. Only a shortening of
 * the issuer's own name belongs here — never a different one.
 */
const SHORT_NAMES = {
    SPCX: 'SpaceX',
    SKHY: 'SK hynix',
};

/** "NVIDIA • Robinhood Token" is the token's name; "NVIDIA" is the company's. */
const companyName = (symbol, tokenName) =>
    SHORT_NAMES[symbol] ?? tokenName.split('\u2022')[0].trim();

/**
 * Robinhood's edge refuses node's own `fetch` with a 403 no matter what headers
 * it carries, and answers curl with anything or nothing in its user agent — the
 * difference is the TLS handshake, not the request. So this script asks through
 * curl. Laravel's client is libcurl too, which is why the server side of this
 * integration has no such trouble.
 */
const curl = (url, binary = false) => {
    const result = spawnSync(
        'curl',
        ['-sS', '--fail', '--max-time', '30', '-H', 'accept: */*', url],
        { maxBuffer: 64 * 1024 * 1024, encoding: binary ? 'buffer' : 'utf8' },
    );

    if (result.status !== 0) {
        return null;
    }

    return result.stdout;
};

/** One `eth_call`, through curl for the reason above. Encoding and decoding are
 *  ethers' — they touch no network. */
const ethCall = (to, method) => {
    const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{ to, data: ERC20.encodeFunctionData(method) }, 'latest'],
    });

    const result = spawnSync(
        'curl',
        [
            '-sS', '--fail', '--max-time', '30',
            '-X', 'POST', RPC,
            '-H', 'content-type: application/json',
            '-d', body,
        ],
        { encoding: 'utf8' },
    );

    if (result.status !== 0) {
        return null;
    }

    const answer = JSON.parse(result.stdout);

    if (typeof answer.result !== 'string') {
        return null;
    }

    return ERC20.decodeFunctionResult(method, answer.result)[0];
};

const fetchJson = (url) => {
    const body = curl(url);

    if (body === null) {
        throw new Error(`${url} could not be read`);
    }

    return JSON.parse(body);
};

const main = async () => {
    const { assets } = fetchJson(ASSETS_URL);
    const bySymbol = new Map(assets.map((asset) => [asset.tokenSymbol, asset]));

    const wanted = [
        ...EQUITIES.map((symbol) => [symbol, 'equity']),
        ...FUNDS.map((symbol) => [symbol, 'fund']),
    ];

    const rows = [];
    const problems = [];

    for (const [symbol, kind] of wanted) {
        const asset = bySymbol.get(symbol);

        if (!asset) {
            problems.push(`${symbol}: not in Robinhood's registry`);
            continue;
        }

        if (asset.status !== 'ASSET_STATUS_ACTIVE') {
            problems.push(`${symbol}: ${asset.status}`);
            continue;
        }

        const deployment = (asset.deployments ?? []).find(
            (entry) => entry.chainId === CHAIN_ID,
        );

        if (!deployment) {
            problems.push(`${symbol}: no deployment on chain ${CHAIN_ID}`);
            continue;
        }

        const address = getAddress(deployment.contractAddress);
        const onChainSymbol = ethCall(address, 'symbol');
        const decimals = ethCall(address, 'decimals');

        if (onChainSymbol === null || decimals === null) {
            problems.push(`${symbol}: ${address} did not answer`);
            continue;
        }

        if (onChainSymbol !== symbol) {
            problems.push(
                `${symbol}: the contract at ${address} calls itself ${onChainSymbol}`,
            );
            continue;
        }

        const isin = String(asset.isin ?? '');

        if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) {
            problems.push(`${symbol}: no usable ISIN (${isin || 'empty'})`);
            continue;
        }

        const image = curl(LOGO_URL(isin), true);

        if (image === null || image.length < 200) {
            problems.push(`${symbol}: no logo for ${isin}`);
            continue;
        }

        /*
         * The extension is read off the bytes, never assumed.
         *
         * Most of these come back as SVG and eight of them do not — the source
         * answers the same URL with a PNG for a handful of issuers. Writing
         * those as `.svg` made the web server label a PNG `image/svg+xml`,
         * which every browser refuses to draw: eight silent broken icons that
         * looked exactly like eight missing ones.
         */
        const extension = image
            .subarray(0, 8)
            .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
            ? 'png'
            : 'svg';

        const file = `${symbol}.${extension}`;

        if (!check) {
            mkdirSync(ICONS, { recursive: true });
            writeFileSync(resolve(ICONS, file), image);

            // An issuer that changes format leaves the old file behind, and
            // the old file is the one whose name the registry no longer says.
            rmSync(resolve(ICONS, `${symbol}.${extension === 'png' ? 'svg' : 'png'}`), {
                force: true,
            });
        }

        rows.push({
            symbol,
            name: companyName(symbol, asset.tokenName),
            address,
            decimals: Number(decimals),
            kind,
            isin,
            icon: `/token-icons/stocks/${file}`,
        });

        process.stdout.write(
            `${symbol.padEnd(6)} ${address} ${String(decimals).padStart(2)}d  ${String(image.length).padStart(6)}b ${extension}  ${asset.currentMultiplier}\n`,
        );
    }

    if (problems.length > 0) {
        process.stderr.write(`\n${problems.length} problem(s):\n`);
        problems.forEach((line) => process.stderr.write(`  ${line}\n`));
    }

    if (check) {
        process.stdout.write(`\n${rows.length} of ${wanted.length} verified.\n`);
        process.exit(problems.length > 0 ? 1 : 0);
    }

    writeFileSync(REGISTRY, render(rows));
    // The repo's own formatting is the only one that survives `lint:check`.
    spawnSync('npx', ['prettier', '--write', REGISTRY], { stdio: 'ignore' });

    // The same list, for the half of this that runs in PHP. Two files rather
    // than one shared JSON because each side reads its own language's registry
    // idiomatically; they are written in the same run and pinned to each other
    // by `tests/Feature/RobinhoodStocksTest.php`, so they cannot drift.
    writeFileSync(PHP_REGISTRY, renderPhp(rows));
    spawnSync('vendor/bin/pint', ['--quiet', PHP_REGISTRY], { cwd: root });

    process.stdout.write(
        `\nWrote ${rows.length} rows to ${REGISTRY}, ${PHP_REGISTRY} and icons to ${ICONS}\n`,
    );
};

const render = (rows) => {
    const generated = new Date().toISOString().slice(0, 10);
    const body = rows
        .map(
            (row) => `    {
        symbol: '${row.symbol}',
        name: '${row.name.replace(/'/g, "\\'")}',
        address: '${row.address}',
        decimals: ${row.decimals},
        kind: '${row.kind}',
        isin: '${row.isin}',
        icon: '${row.icon}',
    },`,
        )
        .join('\n');

    return HEADER.replace('__GENERATED__', generated).replace('__ROWS__', body);
};

const renderPhp = (rows) => {
    const generated = new Date().toISOString().slice(0, 10);
    const body = rows
        .map(
            (row) => `        [
            'symbol' => '${row.symbol}',
            'name' => '${row.name.replace(/'/g, "\\'")}',
            'address' => '${row.address}',
            'decimals' => ${row.decimals},
            'kind' => '${row.kind}',
            'isin' => '${row.isin}',
            'icon' => '${row.icon}',
        ],`,
        )
        .join('\n');

    return PHP_HEADER.replace('__GENERATED__', generated).replace(
        '__ROWS__',
        body,
    );
};

const PHP_HEADER = `<?php

/*
 * Robinhood's tokenised stocks, and how this host reads their prices.
 *
 * The \`stocks\` list is **generated** — \`node scripts/robinhood-stocks.mjs\`
 * rewrites it together with \`resources/js/lib/robinhoodStocks.ts\`, from
 * Robinhood's own asset registry, checking every contract against the chain
 * first. Last run: __GENERATED__.
 *
 * The settings above the list are part of the same template, so editing one of
 * them here is editing it in the generator too — a knob added only to this file
 * disappears on the next run.
 *
 * Prices are read here rather than in the browser for the ordinary reason: the
 * endpoint is rate-limited per caller, and one cached read serves every visitor
 * instead of each of them spending the budget separately.
 */

return [
    /*
     * Robinhood Chain. The stock tokens exist nowhere else — a token with one
     * of these tickers on any other chain is not one of these.
     */
    'chain_id' => 4663,

    /* The read-only REST root the quotes come from. */
    'api' => env('ROBINHOOD_API_URL', 'https://api.robinhood.com/rhj'),

    /*
     * How long a quote is served for.
     *
     * Robinhood caches its own answer for fifteen seconds, so asking more often
     * than that buys nothing but rate limit. Thirty is one refresh behind the
     * source at worst, and a market price half a minute old is still a price —
     * unlike a five-minute one, which is why these are not folded into the
     * portfolio's own cache.
     */
    'quote_ttl' => (int) env('ROBINHOOD_QUOTE_TTL', 30),

    /* Asset metadata moves on corporate actions, which are a daily event. */
    'asset_ttl' => (int) env('ROBINHOOD_ASSET_TTL', 3600),

    /*
     * An outbound proxy for these two calls, when this host needs one.
     *
     * Robinhood answers some networks with a flat \`403\` — a broker refusing an
     * address, not a rate limit — and there is nothing to retry into. The
     * effect is a wallet where every stock renders a dash, which is at least
     * honest, but the fix is an egress the issuer will talk to rather than a
     * different endpoint. Unset means direct, which is right wherever it works.
     *
     * Note that the environment's own \`HTTPS_PROXY\` does **not** reach this
     * code under \`php artisan serve\`: that command hands its worker a fixed
     * list of variables and a proxy is not on it. Hence a setting rather than a
     * convention.
     */
    'proxy' => env('ROBINHOOD_PROXY'),

    'stocks' => [
__ROWS__
    ],
];
`;

const HEADER = `/**
 * Robinhood's tokenised stocks, as this project lists them.
 *
 * **Generated — do not hand-edit.** \`node scripts/robinhood-stocks.mjs\`
 * rewrites this file and the icons in \`public/token-icons/stocks/\` from
 * Robinhood's own asset registry, verifying every contract against the chain
 * before it writes a row. Last run: __GENERATED__.
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
     * a PNG served as \`image/svg+xml\` draws nothing at all. The generator
     * reads the format off the bytes and writes the answer down here.
     */
    icon: string;
};

export const ROBINHOOD_STOCKS: readonly StockToken[] = [
__ROWS__
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
    chainId === ROBINHOOD_STOCK_CHAIN_ID && stockByAddress(address) !== undefined;

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
`;

await main();

