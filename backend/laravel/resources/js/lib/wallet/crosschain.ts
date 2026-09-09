import type {
    AddressLookupTableAccount} from '@solana/web3.js';
import {
    Connection,
    PublicKey,
    TransactionInstruction,
    TransactionMessage,
    VersionedTransaction,
} from '@solana/web3.js';
import { JsonRpcProvider, isAddress } from 'ethers';
import { confirmSignature, solanaRpcUrl } from '@/lib/solanaRpc';
import { walletChain } from '@/lib/wallet/chains';
import type { WalletChain, WalletChainId } from '@/lib/wallet/chains';
import { evmSigner, solanaKeypair } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';
import { isValidUtxoAddress } from '@/lib/wallet/utxo';

/**
 * Cross-chain swaps: the wallet's way out of one chain and into another.
 *
 * The swap screen next door trades on Cyberia's own pools, which is the only
 * honest thing a single chain can offer. "I hold USDC on Base and want SOL" is
 * a different question and this chain has no answer to it — answering it means
 * holding inventory on both sides of every pair anyone might name. So a router
 * is asked, and what this module does is turn its answer into something a
 * wallet can sign and a person can read.
 *
 * Three properties hold everywhere below, and each one is a decision:
 *
 *  - **The route is quoted through Laravel, never from here.** Cyberia's fee is
 *    a field in the quote request, and a browser that composed that request
 *    could delete it. See `App\Services\CrosschainRouter`.
 *  - **The origin leg is EVM and only EVM.** It is the transaction this wallet
 *    signs, and a Solana or Bitcoin deposit would arrive as a payload nothing
 *    in the browser knows how to sign — finding that out after the hold button
 *    is not a failure mode worth shipping.
 *  - **The destination is an address this wallet can check.** EVM, Solana and
 *    Bitcoin are checkable here; the rest of the router's chains are listed
 *    with that as their reason, because a cross-chain swap has no cancel and a
 *    typo into an unvalidated string is final.
 */

/* -------------------------------------------------------------- catalogue -- */

export type CrossVm = 'evm' | 'svm' | 'bvm' | 'tvm' | 'tonvm' | string;

export type CrossChainRow = {
    id: number;
    name: string;
    symbol: string;
    decimals: number;
    vm: CrossVm;
    explorer: string;
    /** `All` or `Limited` — whether every token on it can cross. */
    tokens: string;
    deposits: boolean;
};

export type CrossToken = {
    chainId: number;
    address: string;
    symbol: string;
    name: string;
    decimals: number;
    /** The router's own flag, passed through. Unverified is marked, not hidden. */
    verified: boolean;
    logo: string;
};

export type CrosschainConfig = {
    enabled: boolean;
    fee: {
        /** Where Cyberia's cut lands, or null when this host collects none. */
        address: string | null;
        bps: number;
    };
    chains: CrossChainRow[];
};

/** The router's name for "the coin this chain runs on". */
export const CROSS_NATIVE = '0x0000000000000000000000000000000000000000';

/* ------------------------------------------------------------------ quote -- */

export type CrossAmount = {
    chainId: number;
    address: string;
    symbol: string;
    decimals: number;
    amount: bigint;
    /** What is guaranteed to arrive; the difference is slippage. */
    minimum: bigint;
    /** USD as the router priced it, or null when it priced nothing. */
    usd: number | null;
};

/**
 * One transaction the wallet is asked to sign.
 *
 * Two shapes, because the chains genuinely differ. An EVM leg is a single call
 * — where to, what calldata, how much value. A Solana leg is the instructions
 * a v0 transaction is compiled from plus the lookup tables they reference: the
 * router hands over the parts and whoever holds the key does the assembling,
 * which is also the only arrangement under which the signer can see what it is
 * signing.
 */
export type CrossEvmTx = {
    vm: 'evm';
    chainId: number;
    to: string;
    data: string;
    value: bigint;
    gas: bigint | null;
    maxFeePerGas: bigint | null;
    maxPriorityFeePerGas: bigint | null;
};

export type CrossSvmInstruction = {
    programId: string;
    keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
    /** Base64, exactly as the router encoded it. */
    data: string;
};

export type CrossSvmTx = {
    vm: 'svm';
    instructions: CrossSvmInstruction[];
    lookupTables: string[];
};

export type CrossTx = CrossEvmTx | CrossSvmTx;

export type CrossStep = {
    /** `approve` or `deposit` — the two a wallet is ever asked for. */
    id: string;
    description: string;
    items: CrossTx[];
};

export type CrossQuote = {
    requestId: string;
    steps: CrossStep[];
    in: CrossAmount;
    out: CrossAmount;
    fees: {
        app: CrossAmount | null;
        relayer: CrossAmount | null;
        gas: CrossAmount | null;
    };
    /** Whether this host asked for a fee at all. */
    feeRequested: boolean;
    /** Whether the router actually put one in the route. */
    feeApplied: boolean;
    impactPercent: string;
    /** Seconds the router thinks delivery takes. */
    timeEstimate: number;
    slippageBps: number;
};

/**
 * Anything this wallet cannot sign, before an amount is typed.
 *
 * Named rather than boolean, because every one of these is a sentence the
 * screen has to be able to say — a corridor that is simply missing from a list
 * teaches the user nothing about why.
 */
export type CrossSourceProblem =
    | 'notRouted'
    | 'notEvm'
    | 'noDeposits'
    | 'notInWallet';

export type CrossDestinationProblem = 'notRouted' | 'unverifiable';

/* -------------------------------------------------------------- eligibility -- */

/**
 * Chains this wallet can check an address on.
 *
 * The list is short on purpose and is not about what the router can deliver
 * to: it is about what this wallet can *refuse*. A cross-chain swap cannot be
 * recalled, so an address it cannot check is an address it does not send to.
 */
const SOLANA_CHAIN_ID = 792703809;
const BITCOIN_CHAIN_ID = 8253038;

/** The router's name for "the coin Solana runs on" — the system program. */
export const SOLANA_NATIVE = '11111111111111111111111111111111';

/**
 * The router's id for a wallet network.
 *
 * An EVM network answers with its own chain id and needs no table. The others
 * do: a chain with no EVM chain id still has to be named somehow, and the
 * router invented ids for them. Only the two the wallet can reach are listed —
 * an id here is a claim that this wallet has an account on that chain, not that
 * the router serves it.
 */
const ROUTER_IDS: Partial<Record<WalletChainId, number>> = {
    solana: SOLANA_CHAIN_ID,
    bitcoin: BITCOIN_CHAIN_ID,
};

export const routerChainId = (id: WalletChainId): number | null => {
    const named = ROUTER_IDS[id];

    if (named !== undefined) {
        return named;
    }

    try {
        return walletChain(id).chainId ?? null;
    } catch {
        return null;
    }
};

/**
 * How the router spells this network's own coin. Two different zero-ish
 * constants, and using the EVM one on Solana asks for a token that does not
 * exist rather than for SOL.
 */
export const routerNativeCurrency = (id: WalletChainId): string => {
    try {
        return walletChain(id).family === 'solana'
            ? SOLANA_NATIVE
            : CROSS_NATIVE;
    } catch {
        return CROSS_NATIVE;
    }
};

export const crossDestinationValidator = (
    chain: CrossChainRow,
): ((address: string) => boolean) | null => {
    if (chain.vm === 'evm') {
        return (address) => isAddress(address);
    }

    if (chain.id === SOLANA_CHAIN_ID) {
        return (address) => {
            try {
                return new PublicKey(address).toBytes().length === 32;
            } catch {
                return false;
            }
        };
    }

    if (chain.id === BITCOIN_CHAIN_ID) {
        // Mainnet Bitcoin's own parameters: bech32 and both base58 versions,
        // so a legacy or P2SH destination is accepted as readily as a segwit
        // one. The wallet cannot spend from those, but this is somebody else's
        // address to receive at, and refusing it would be inventing a rule.
        return (address) =>
            isValidUtxoAddress(
                {
                    coinType: 0,
                    hrp: 'bc',
                    p2pkhVersion: 0x00,
                    p2shVersion: 0x05,
                    addressType: 'bech32',
                    api: '',
                    explorer: null,
                },
                address,
            );
    }

    return null;
};

/** Why this chain cannot be the source of a swap, or null when it can. */
export const crossSourceProblem = (
    chain: CrossChainRow | null,
    walletChainIds: readonly WalletChainId[],
    walletChainOf: (chainId: number) => WalletChainId | null,
): CrossSourceProblem | null => {
    if (chain === null) {
        return 'notRouted';
    }

    if (chain.vm !== 'evm') {
        return 'notEvm';
    }

    if (!chain.deposits) {
        return 'noDeposits';
    }

    const id = walletChainOf(chain.id);

    // The origin leg needs an endpoint to broadcast through and a balance the
    // user has already seen. Both come from the network being switched on in
    // this wallet, which is why the network list and this screen are the same
    // decision looked at twice.
    return id !== null && walletChainIds.includes(id) ? null : 'notInWallet';
};

export const crossDestinationProblem = (
    chain: CrossChainRow | null,
): CrossDestinationProblem | null => {
    if (chain === null) {
        return 'notRouted';
    }

    return crossDestinationValidator(chain) === null ? 'unverifiable' : null;
};

/**
 * What Cyberia's fee actually came to, as a share of the input.
 *
 * Computed from the two amounts in the answered quote rather than from the
 * configured basis points, because the router is free to cap, round or decline
 * it — and the only number a screen may show is the one the route will take.
 * Returns null when there is no fee in the quote at all.
 */
export const crossFeeShareBps = (quote: CrossQuote): number | null => {
    const fee = quote.fees.app;

    if (fee === null || fee.amount === 0n || quote.in.amount === 0n) {
        return null;
    }

    // Same-decimals comparison holds because the fee is taken out of the input
    // token; a router that ever charged in something else would show up here
    // as a nonsense share rather than as a silently wrong one.
    if (fee.decimals !== quote.in.decimals) {
        return null;
    }

    return Number((fee.amount * 10_000n) / quote.in.amount);
};

/* --------------------------------------------------------------- transport -- */

const parseAmount = (value: unknown): CrossAmount | null => {
    if (value === null || typeof value !== 'object') {
        return null;
    }

    const row = value as Record<string, unknown>;
    const usd = Number(row.usd);

    return {
        chainId: Number(row.chainId ?? 0),
        address: String(row.address ?? ''),
        symbol: String(row.symbol ?? ''),
        decimals: Number(row.decimals ?? 18),
        amount: BigInt(String(row.amount ?? '0')),
        minimum: BigInt(String(row.minimum ?? row.amount ?? '0')),
        // A price the router did not have is null and never 0 — the screens
        // render "—" for one and a claim about value for the other.
        usd: Number.isFinite(usd) && String(row.usd ?? '') !== '' ? usd : null,
    };
};

const optionalBigInt = (value: unknown): bigint | null =>
    value === null || value === undefined ? null : BigInt(String(value));

/** The wire form of a quote, as bigints. */
export const parseCrossQuote = (payload: unknown): CrossQuote => {
    const raw = payload as Record<string, unknown>;
    const inflow = parseAmount(raw.in);
    const outflow = parseAmount(raw.out);

    if (inflow === null || outflow === null) {
        throw new Error('The router answered without an amount.');
    }

    const fees = (raw.fees ?? {}) as Record<string, unknown>;

    return {
        requestId: String(raw.requestId ?? ''),
        steps: ((raw.steps ?? []) as Record<string, unknown>[]).map((step) => ({
            id: String(step.id ?? 'step'),
            description: String(step.description ?? ''),
            items: ((step.items ?? []) as Record<string, unknown>[]).map(
                (item): CrossTx =>
                    item.vm === 'svm'
                        ? {
                              vm: 'svm',
                              instructions: (
                                  (item.instructions ?? []) as Record<
                                      string,
                                      unknown
                                  >[]
                              ).map((instruction) => ({
                                  programId: String(
                                      instruction.programId ?? '',
                                  ),
                                  keys: (
                                      (instruction.keys ?? []) as Record<
                                          string,
                                          unknown
                                      >[]
                                  ).map((key) => ({
                                      pubkey: String(key.pubkey ?? ''),
                                      isSigner: key.isSigner === true,
                                      isWritable: key.isWritable === true,
                                  })),
                                  data: String(instruction.data ?? ''),
                              })),
                              lookupTables: (
                                  (item.lookupTables ?? []) as unknown[]
                              ).map((address) => String(address)),
                          }
                        : {
                              vm: 'evm',
                              chainId: Number(item.chainId ?? 0),
                              to: String(item.to ?? ''),
                              data: String(item.data ?? '0x'),
                              value: BigInt(String(item.value ?? '0')),
                              gas: optionalBigInt(item.gas),
                              maxFeePerGas: optionalBigInt(item.maxFeePerGas),
                              maxPriorityFeePerGas: optionalBigInt(
                                  item.maxPriorityFeePerGas,
                              ),
                          },
            ),
        })),
        in: inflow,
        out: outflow,
        fees: {
            app: parseAmount(fees.app),
            relayer: parseAmount(fees.relayer),
            gas: parseAmount(fees.gas),
        },
        feeRequested: raw.feeRequested === true,
        feeApplied: raw.feeApplied === true,
        impactPercent: String(raw.impactPercent ?? ''),
        timeEstimate: Number(raw.timeEstimate ?? 0),
        slippageBps: Number(raw.slippageBps ?? 0),
    };
};

const json = async (response: Response): Promise<Record<string, unknown>> => {
    const body = (await response.json().catch(() => ({}))) as Record<
        string,
        unknown
    >;

    if (!response.ok) {
        // The router's own sentence where there is one: "no route", "amount
        // too small" and "chain paused" are all answers a user can act on.
        throw new Error(
            typeof body.error === 'string' && body.error !== ''
                ? body.error
                : `The routing service answered ${response.status}.`,
        );
    }

    return body;
};

export const fetchCrosschainConfig = async (): Promise<CrosschainConfig> => {
    const body = await json(
        await fetch('/api/wallet/crosschain', {
            headers: { Accept: 'application/json' },
        }),
    );

    return {
        enabled: body.enabled === true,
        fee: {
            address:
                typeof (body.fee as Record<string, unknown>)?.address ===
                'string'
                    ? String((body.fee as Record<string, unknown>).address)
                    : null,
            bps: Number((body.fee as Record<string, unknown>)?.bps ?? 0),
        },
        chains: ((body.chains ?? []) as Record<string, unknown>[]).map(
            (chain) => ({
                id: Number(chain.id ?? 0),
                name: String(chain.name ?? ''),
                symbol: String(chain.symbol ?? ''),
                decimals: Number(chain.decimals ?? 18),
                vm: String(chain.vm ?? 'evm'),
                explorer: String(chain.explorer ?? ''),
                tokens: String(chain.tokens ?? 'All'),
                deposits: chain.deposits !== false,
            }),
        ),
    };
};

export const fetchCrossTokens = async (
    chainId: number,
    query = '',
): Promise<CrossToken[]> => {
    const params = new URLSearchParams({ chain: String(chainId) });

    if (query.trim() !== '') {
        params.set('q', query.trim());
    }

    const body = await json(
        await fetch(`/api/wallet/crosschain/tokens?${params}`, {
            headers: { Accept: 'application/json' },
        }),
    );

    return ((body.tokens ?? []) as Record<string, unknown>[]).map((token) => ({
        chainId: Number(token.chainId ?? chainId),
        address: String(token.address ?? ''),
        symbol: String(token.symbol ?? ''),
        name: String(token.name ?? ''),
        decimals: Number(token.decimals ?? 18),
        verified: token.verified === true,
        logo: String(token.logo ?? ''),
    }));
};

export const quoteCrossSwap = async (request: {
    originChainId: number;
    destinationChainId: number;
    originCurrency: string;
    destinationCurrency: string;
    user: string;
    recipient: string;
    amount: bigint;
    slippageBps?: number;
}): Promise<CrossQuote> => {
    const body = await json(
        await fetch('/api/wallet/crosschain/quote', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
            },
            body: JSON.stringify({
                ...request,
                amount: request.amount.toString(),
            }),
        }),
    );

    return parseCrossQuote(body.quote);
};

export type CrossStatus = {
    /** The router's own vocabulary — `unknown` is an answer, not a failure. */
    status: string;
    details: string;
    transactions: { side: 'in' | 'out'; hash: string }[];
};

export const crossSwapStatus = async (
    requestId: string,
): Promise<CrossStatus> => {
    const body = await json(
        await fetch(
            `/api/wallet/crosschain/status?id=${encodeURIComponent(requestId)}`,
            { headers: { Accept: 'application/json' } },
        ),
    );

    return {
        status: String(body.status ?? 'unknown'),
        details: String(body.details ?? ''),
        transactions: ((body.transactions ?? []) as Record<string, unknown>[])
            .map((row) => ({
                side: row.side === 'out' ? ('out' as const) : ('in' as const),
                hash: String(row.hash ?? ''),
            }))
            .filter((row) => row.hash !== ''),
    };
};

/* --------------------------------------------------------------- executing -- */

/**
 * Ceiling for one step of a route.
 *
 * The router quotes its own gas per step and that is what gets signed; this is
 * for the step that arrives without one. A deposit into a router contract is a
 * real contract call and costs several times a transfer, so the cap is
 * generous — what it rules out is signing an unbounded limit for a call whose
 * price nobody stated.
 */
export const CROSS_STEP_GAS_CAP = 2_000_000n;

export type CrossReceipt = {
    requestId: string;
    /** Every hash this wallet broadcast, in the order it signed them. */
    hashes: string[];
};

/**
 * Sign the route the user agreed to, step by step.
 *
 * The steps arrive already ordered — an allowance, when the token needs one,
 * then the deposit — and each is waited on before the next is signed, because
 * a deposit broadcast before its allowance is mined simply reverts and burns
 * the fee. Nothing is re-quoted between them: the amounts, the minimum and the
 * fee are the ones that were on screen.
 *
 * `onStep` is called with each hash as it is broadcast rather than after the
 * whole route, so the screen can show a transaction the user can look up while
 * the next one is still being signed.
 */
/**
 * Sign one Solana leg.
 *
 * The router hands over instructions rather than a finished transaction, so the
 * transaction is compiled here — which is the only version of this that lets
 * the signer see what it signs. A v0 message and not a legacy one, because the
 * route references address lookup tables and a legacy transaction has no way to
 * carry them; the tables are fetched from the chain by address, because their
 * *contents* are what the instructions' account indexes resolve against and
 * taking them on the router's word would be signing a blindfolded account list.
 */
const executeSvmStep = async (
    source: WalletKeySource,
    item: CrossSvmTx,
    rpcUrl: string | undefined,
    /** Called the moment the signature exists, before the wait for it. */
    onSent: (signature: string) => void,
): Promise<void> => {
    const keypair = solanaKeypair(source);
    const connection = new Connection(rpcUrl || solanaRpcUrl(), 'confirmed');

    const lookupTables = (
        await Promise.all(
            item.lookupTables.map(async (address) => {
                const table = await connection.getAddressLookupTable(
                    new PublicKey(address),
                );

                return table.value;
            }),
        )
    ).filter((table): table is AddressLookupTableAccount => table !== null);

    if (lookupTables.length !== item.lookupTables.length) {
        // A table the cluster will not return is an account list this wallet
        // cannot resolve. Compiling anyway would sign whatever the remaining
        // indexes happen to point at.
        throw new Error('A lookup table this route needs could not be read.');
    }

    const instructions = item.instructions.map(
        (instruction) =>
            new TransactionInstruction({
                programId: new PublicKey(instruction.programId),
                keys: instruction.keys.map((key) => ({
                    pubkey: new PublicKey(key.pubkey),
                    isSigner: key.isSigner,
                    isWritable: key.isWritable,
                })),
                data: Buffer.from(instruction.data, 'base64'),
            }),
    );

    const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
    }).compileToV0Message(lookupTables);

    const transaction = new VersionedTransaction(message);

    transaction.sign([keypair]);

    const signature = await connection.sendRawTransaction(
        transaction.serialize(),
    );

    onSent(signature);

    // Waited on here, beside the blockhash it was built against, so an expiry
    // is reported as an expiry rather than as a swap that vanished.
    await confirmSignature(connection, signature, { lastValidBlockHeight });
};

export const executeCrossSwap = async (
    source: WalletKeySource,
    request: {
        quote: CrossQuote;
        /** The wallet's own network for the origin leg — its endpoint is used. */
        chain: WalletChainId;
        rpcUrl?: string;
        onStep?: (step: CrossStep, hash: string) => void;
    },
): Promise<CrossReceipt> => {
    const chain: WalletChain = walletChain(request.chain);
    const hashes: string[] = [];

    /*
     * Solana first, and entirely separately: it needs no EVM provider, no chain
     * id and no gas ceiling, and building one to throw it away would put an
     * endpoint requirement on a chain that does not have one.
     */
    if (chain.family === 'solana') {
        for (const step of request.quote.steps) {
            for (const item of step.items) {
                if (item.vm !== 'svm') {
                    throw new Error(
                        'The route asked for a transaction on another network.',
                    );
                }

                await executeSvmStep(
                    source,
                    item,
                    request.rpcUrl,
                    (signature) => {
                        hashes.push(signature);
                        request.onStep?.(step, signature);
                    },
                );
            }
        }

        return { requestId: request.quote.requestId, hashes };
    }

    const endpoint = request.rpcUrl || chain.endpoint;

    if (!endpoint || chain.chainId === undefined) {
        throw new Error(`${chain.label} has no endpoint to broadcast through`);
    }

    const provider = new JsonRpcProvider(endpoint, {
        chainId: chain.chainId,
        name: String(chain.id),
    });
    const signer = evmSigner(source).connect(provider);

    for (const step of request.quote.steps) {
        for (const item of step.items) {
            if (item.vm !== 'evm' || item.chainId !== chain.chainId) {
                // Every step of a route this wallet signs is on the origin
                // chain; anything else is the router's own leg and is not ours
                // to broadcast. Refusing is the only safe reading.
                throw new Error(
                    'The route asked for a transaction on another network.',
                );
            }

            const gasLimit =
                item.gas ??
                (await signer.estimateGas({
                    to: item.to,
                    data: item.data,
                    value: item.value,
                }));

            if (gasLimit > CROSS_STEP_GAS_CAP) {
                throw new Error(
                    'This route needs more gas than the wallet will sign for.',
                );
            }

            const tx = await signer.sendTransaction({
                to: item.to,
                data: item.data,
                value: item.value,
                gasLimit,
                ...(item.maxFeePerGas !== null
                    ? {
                          maxFeePerGas: item.maxFeePerGas,
                          maxPriorityFeePerGas:
                              item.maxPriorityFeePerGas ?? undefined,
                      }
                    : {}),
            });

            hashes.push(tx.hash);
            request.onStep?.(step, tx.hash);

            // An allowance that is not yet mined is an allowance the deposit
            // does not have.
            await tx.wait();
        }
    }

    return { requestId: request.quote.requestId, hashes };
};
