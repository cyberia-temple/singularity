import {
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    createAssociatedTokenAccountIdempotentInstruction,
    createTransferCheckedInstruction,
    getAssociatedTokenAddressSync,
    unpackMint,
} from '@solana/spl-token';
import type { Connection, TransactionInstruction } from '@solana/web3.js';
import { PublicKey } from '@solana/web3.js';
import type { WalletTokenBalance } from '@/lib/wallet/erc20';

/**
 * Tokens on Solana: the half of the account this wallet could not see.
 *
 * Everything else here treats a network's tokens as a first-class part of it —
 * the portfolio card rolls them up, the network screen lists them, the swap
 * screen sells them. Solana had none of that, not because SPL is hard but
 * because token discovery in this wallet was written against Blockscout, and
 * Solana has no Blockscout. So an account could hold six figures of a token
 * and the wallet drew a zero-balance SOL card, and the routed swap screen —
 * which offers you what you hold as the thing to sell — could only ever offer
 * SOL. You could buy a token here and then never sell it.
 *
 * Two things make this different from the EVM path, and both are load-bearing.
 *
 * **There are two token programs, not one.** SPL Token and Token-2022 are
 * separate programs with separate accounts, and a wallet that enumerates only
 * the original one is blind to everything minted under the newer standard —
 * which, on the launchpads people actually use, is most of it. CYBER.sol is a
 * Token-2022 mint, so asking the classic program alone would have missed the
 * one token this was built for. Both are asked, always.
 *
 * **A transfer needs the mint's own program, and it is read, not remembered.**
 * `transferChecked` is issued *by* whichever program owns the mint, and the
 * associated account is derived with that same program in the seeds — get it
 * wrong and the instruction addresses an account that does not exist. The
 * program is therefore looked up on the mint at send time rather than carried
 * along from whatever listed the token, because the thing being signed must
 * depend on the chain's answer and not on a cached row.
 */

/** The two programs a token account can live under. Order is not significant. */
export const SPL_PROGRAMS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] as const;

/**
 * Space an associated token account occupies, for the rent a transfer may owe.
 *
 * 165 is the classic account; a Token-2022 one carries at least the
 * `immutableOwner` extension and measures 170. The larger of the two is used
 * on purpose — this number only ever appears inside a fee *quote*, where being
 * wrong low means promising a fee that cannot complete the transfer.
 */
export const SPL_ACCOUNT_SPACE = 170;

export type SplHolding = {
    mint: string;
    balance: bigint;
    decimals: number;
    /** The program that owns the mint, base58. */
    program: string;
};

/* --------------------------------------------------------------- reading -- */

/**
 * Every token account an address owns, under either program.
 *
 * Zero balances are dropped, matching what an indexed EVM token does: a token
 * account at zero is a rent deposit the owner forgot to close, not a holding.
 * A hand-added token is a different case and is not this function's business.
 */
export const readSplHoldings = async (
    connection: Connection,
    owner: string,
): Promise<SplHolding[]> => {
    const key = new PublicKey(owner);

    const answers = await Promise.all(
        SPL_PROGRAMS.map(async (programId) => {
            const { value } = await connection.getParsedTokenAccountsByOwner(
                key,
                { programId },
            );

            return value.map((entry) => {
                const info = (
                    entry.account.data.parsed as {
                        info?: {
                            mint?: string;
                            tokenAmount?: {
                                amount?: string;
                                decimals?: number;
                            };
                        };
                    }
                )?.info;

                return {
                    mint: String(info?.mint ?? ''),
                    balance: BigInt(info?.tokenAmount?.amount ?? '0'),
                    decimals: Number(info?.tokenAmount?.decimals ?? 0),
                    program: programId.toBase58(),
                } satisfies SplHolding;
            });
        }),
    );

    return answers.flat().filter((row) => row.mint !== '' && row.balance > 0n);
};

/**
 * The holdings that are money, with the one-of-ones taken out.
 *
 * On Solana an NFT is not a different kind of object: it is an ordinary mint
 * with no decimals and a supply of one, sitting in an ordinary token account
 * next to the USDC. So the moment this wallet learned to enumerate token
 * accounts it also learned to enumerate everything anybody was ever airdropped
 * — as rows with no symbol, no price and no market, in the list somebody opens
 * to see what they hold.
 *
 * The test is exact rather than a heuristic, because the cost of a heuristic
 * here is hiding somebody's money. A mint is a collectible when its supply is
 * one *and* it is indivisible; a fungible token that happens to be scarce has
 * decimals, and a zero-decimal token with a supply of four thousand is not
 * touched. Only mints that could possibly qualify are asked about, so an
 * account holding nothing but fungible tokens costs no extra call at all, and
 * a lookup that fails leaves every row in place — an unreadable mint must not
 * be able to delete a balance from the screen.
 */
export const withoutCollectibles = async (
    connection: Connection,
    holdings: readonly SplHolding[],
): Promise<SplHolding[]> => {
    const candidates = holdings.filter((holding) => holding.decimals === 0);

    if (candidates.length === 0) {
        return [...holdings];
    }

    try {
        const infos = await connection.getMultipleAccountsInfo(
            candidates.map((holding) => new PublicKey(holding.mint)),
        );

        const oneOfOne = new Set<string>();

        candidates.forEach((holding, index) => {
            const info = infos[index];

            if (info === null) {
                return;
            }

            const mint = unpackMint(
                new PublicKey(holding.mint),
                info,
                info.owner,
            );

            if (mint.decimals === 0 && mint.supply === 1n) {
                oneOfOne.add(holding.mint);
            }
        });

        return holdings.filter((holding) => !oneOfOne.has(holding.mint));
    } catch {
        return [...holdings];
    }
};

/**
 * The program that owns a mint.
 *
 * Read rather than assumed, and read from the mint account's `owner` field —
 * which is what "which token program is this" means on Solana. A mint address
 * that is not a mint (an ordinary wallet, a pool, a typo) answers with some
 * other program and is refused here rather than at signing time.
 */
export const splMintProgram = async (
    connection: Connection,
    mint: string,
): Promise<PublicKey> => {
    const account = await connection.getAccountInfo(new PublicKey(mint));

    if (account === null) {
        throw new Error('No such mint on Solana');
    }

    const owner = account.owner.toBase58();

    if (!SPL_PROGRAMS.some((program) => program.toBase58() === owner)) {
        throw new Error('That address is not a token mint');
    }

    return account.owner;
};

/**
 * One token as this address holds it, whether or not it holds any.
 *
 * The balance is read from the associated account and a missing account is
 * zero rather than an error: "you do not hold this" is an answer, and it is
 * the answer somebody adding a token by hand before buying it expects.
 */
export const readSplToken = async (
    connection: Connection,
    mint: string,
    owner: string,
): Promise<SplHolding> => {
    const program = await splMintProgram(connection, mint);
    const mintKey = new PublicKey(mint);
    const account = getAssociatedTokenAddressSync(
        mintKey,
        new PublicKey(owner),
        true,
        program,
    );

    const [supply, balance] = await Promise.all([
        connection.getTokenSupply(mintKey),
        connection
            .getTokenAccountBalance(account)
            .then((result) => BigInt(result.value.amount))
            .catch(() => 0n),
    ]);

    return {
        mint,
        balance,
        decimals: supply.value.decimals,
        program: program.toBase58(),
    };
};

/**
 * A mint with nothing else known about it, written the way a person reads one.
 *
 * Solana keeps a token's name and symbol in a metadata account beside the
 * mint, not in the mint — so an address with no market anywhere has no symbol
 * this wallet can honestly print. Rather than invent one, the mint itself is
 * shown, shortened: it is what the user pasted, and they will recognise it.
 */
export const shortMint = (mint: string): string =>
    mint.length > 12 ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : mint;

/** A holding as the rest of the wallet reads tokens. */
export const asTokenBalance = (
    holding: SplHolding,
    named?: { symbol?: string; name?: string },
): WalletTokenBalance => ({
    address: holding.mint,
    symbol: named?.symbol?.trim() || shortMint(holding.mint),
    name: named?.name?.trim() || shortMint(holding.mint),
    decimals: holding.decimals,
    balance: holding.balance,
});

/* --------------------------------------------------------------- sending -- */

/**
 * The instructions that move a token, in the order they must run.
 *
 * `transferChecked` and not `transfer`, because the amount travels with the
 * decimals it was counted in and the program refuses the pair if they
 * disagree — which turns "the wallet had the wrong decimals" from a transfer
 * of the wrong size into a transaction that does not land. The recipient's
 * account is created idempotently and by the sender: a Solana address that has
 * never held this token has nowhere to receive it, and a transfer to a missing
 * account fails rather than waiting.
 */
export const splTransferInstructions = ({
    mint,
    program,
    from,
    to,
    amount,
    decimals,
}: {
    mint: PublicKey;
    program: PublicKey;
    from: PublicKey;
    to: PublicKey;
    amount: bigint;
    decimals: number;
}): TransactionInstruction[] => {
    const source = getAssociatedTokenAddressSync(mint, from, true, program);
    const destination = getAssociatedTokenAddressSync(mint, to, true, program);

    return [
        createAssociatedTokenAccountIdempotentInstruction(
            from,
            destination,
            to,
            mint,
            program,
            ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        createTransferCheckedInstruction(
            source,
            mint,
            destination,
            from,
            amount,
            decimals,
            [],
            program,
        ),
    ];
};
