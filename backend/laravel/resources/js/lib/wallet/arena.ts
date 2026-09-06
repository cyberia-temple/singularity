import {
    AbiCoder,
    Contract,
    Interface,
    JsonRpcProvider,
    getAddress,
    hexlify,
    keccak256,
    randomBytes,
} from 'ethers';
import { CYBERIA_CHAIN_ID, cyberiaReadRpcUrl } from '@/lib/evmChains';
import { evmSigner } from '@/lib/wallet/keys';
import type { WalletKeySource } from '@/lib/wallet/keys';

/**
 * The deliberately small client surface of the first Arena contract.
 *
 * Laravel never signs and never becomes game state: reads go straight to the
 * Cyberia RPC and every write is signed by the active browser-side vault key.
 */
export const ARENA_ABI = [
    'event GameCreated(uint256 indexed gameId, address indexed playerOne, uint256 stake, uint256 deadline)',
    'function createGame() payable returns (uint256 gameId)',
    'function joinGame(uint256 gameId) payable',
    'function commitMove(uint256 gameId, bytes32 commitment)',
    'function revealMove(uint256 gameId, uint8 move, bytes32 secret)',
    'function resolveGame(uint256 gameId)',
    'function cancelExpiredGame(uint256 gameId)',
    'function claimPayout(uint256 gameId)',
    'function pendingPayout(uint256 gameId, address player) view returns (uint256)',
    'function nextGameId() view returns (uint256)',
    'function getGame(uint256 gameId) view returns ((address playerOne,address playerTwo,uint96 stake,uint64 deadline,uint8 state,uint8 result,address winner,bytes32 playerOneCommitment,bytes32 playerTwoCommitment,uint8 playerOneMove,uint8 playerTwoMove))',
] as const;

export type ArenaMove = 1 | 2 | 3;
export type ArenaState = 1 | 2 | 3 | 4 | 5;
export type ArenaResult = 0 | 1 | 2 | 3;

export type ArenaGame = {
    id: bigint;
    playerOne: string;
    playerTwo: string;
    stake: bigint;
    deadline: number;
    state: ArenaState;
    result: ArenaResult;
    winner: string;
    playerOneCommitted: boolean;
    playerTwoCommitted: boolean;
    playerOneMove: number;
    playerTwoMove: number;
    payout: bigint;
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ZERO_HASH = `0x${'0'.repeat(64)}`;

const provider = (rpcUrl?: string): JsonRpcProvider =>
    new JsonRpcProvider(rpcUrl || cyberiaReadRpcUrl(), CYBERIA_CHAIN_ID, {
        staticNetwork: true,
    });

const checkedContract = (address: string): string => getAddress(address);

export const arenaRecentGameIds = (
    nextGameId: bigint,
    limit = 50,
): bigint[] => {
    const last = nextGameId - 1n;
    if (last < 1n || limit < 1) return [];
    const first = last > BigInt(limit) ? last - BigInt(limit) + 1n : 1n;
    const ids: bigint[] = [];
    for (let id = last; id >= first; id -= 1n) ids.push(id);
    return ids;
};

export const createArenaSecret = (): string => hexlify(randomBytes(32));

export const mapArenaConcurrently = async <Input, Output>(
    values: readonly Input[],
    task: (value: Input) => Promise<Output>,
    concurrency = 4,
): Promise<Output[]> => {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
        throw new Error('Arena read concurrency must be a positive integer');
    }
    const output = new Array<Output>(values.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
        while (cursor < values.length) {
            const index = cursor++;
            output[index] = await task(values[index]);
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(concurrency, values.length) }, worker),
    );
    return output;
};

/** Byte-identical mirror of RockPaperScissors.hashMove(). */
export const arenaCommitment = (
    contract: string,
    gameId: bigint,
    player: string,
    move: ArenaMove,
    secret: string,
): string =>
    keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ['address', 'uint256', 'uint256', 'address', 'uint8', 'bytes32'],
            [
                checkedContract(contract),
                CYBERIA_CHAIN_ID,
                gameId,
                player,
                move,
                secret,
            ],
        ),
    );

export const readArenaGame = async (
    contractAddress: string,
    gameId: bigint,
    playerAddress: string,
    rpcUrl?: string,
): Promise<ArenaGame> => {
    const contract = new Contract(
        checkedContract(contractAddress),
        ARENA_ABI,
        provider(rpcUrl),
    );
    return readArenaGameFromContract(contract, gameId, playerAddress);
};

const readArenaGameFromContract = async (
    contract: Contract,
    gameId: bigint,
    playerAddress: string,
): Promise<ArenaGame> => {
    const row = await contract.getGame(gameId);
    const payout = (await contract.pendingPayout(
        gameId,
        playerAddress,
    )) as bigint;

    return {
        id: gameId,
        playerOne: row.playerOne as string,
        playerTwo: row.playerTwo as string,
        stake: row.stake as bigint,
        deadline: Number(row.deadline),
        state: Number(row.state) as ArenaState,
        result: Number(row.result) as ArenaResult,
        winner: row.winner as string,
        playerOneCommitted: row.playerOneCommitment !== ZERO_HASH,
        playerTwoCommitted: row.playerTwoCommitment !== ZERO_HASH,
        playerOneMove: Number(row.playerOneMove),
        playerTwoMove: Number(row.playerTwoMove),
        payout,
    };
};

export const readRecentArenaGames = async (
    contractAddress: string,
    playerAddress: string,
    rpcUrl?: string,
    limit = 50,
): Promise<ArenaGame[]> => {
    const address = checkedContract(contractAddress);
    const rpc = provider(rpcUrl);
    const contract = new Contract(address, ARENA_ABI, rpc);
    const nextGameId = (await contract.nextGameId()) as bigint;

    return mapArenaConcurrently(arenaRecentGameIds(nextGameId, limit), (id) =>
        readArenaGameFromContract(contract, id, playerAddress),
    );
};

type ArenaWriteResult = { hash: string; gameId?: bigint };

const write = async (
    source: WalletKeySource,
    contractAddress: string,
    method: string,
    args: readonly unknown[],
    value = 0n,
    rpcUrl?: string,
): Promise<ArenaWriteResult> => {
    const signer = evmSigner(source).connect(provider(rpcUrl));
    const contract = new Contract(
        checkedContract(contractAddress),
        ARENA_ABI,
        signer,
    );
    const transaction = await contract[method](...args, { value });
    const receipt = await transaction.wait();

    if (!receipt || receipt.status !== 1) {
        throw new Error('Arena transaction was not confirmed');
    }

    let gameId: bigint | undefined;
    if (method === 'createGame') {
        const parser = new Interface(ARENA_ABI);
        for (const log of receipt.logs) {
            try {
                const event = parser.parseLog(log);
                if (event?.name === 'GameCreated') {
                    gameId = event.args.gameId as bigint;
                    break;
                }
            } catch {
                // Other contracts may have emitted in the same transaction.
            }
        }
    }

    return { hash: transaction.hash as string, gameId };
};

export const createArenaGame = (
    source: WalletKeySource,
    contract: string,
    stake: bigint,
    rpcUrl?: string,
): Promise<ArenaWriteResult> =>
    write(source, contract, 'createGame', [], stake, rpcUrl);

export const joinArenaGame = (
    source: WalletKeySource,
    contract: string,
    gameId: bigint,
    stake: bigint,
    rpcUrl?: string,
): Promise<ArenaWriteResult> =>
    write(source, contract, 'joinGame', [gameId], stake, rpcUrl);

export const commitArenaMove = (
    source: WalletKeySource,
    contract: string,
    gameId: bigint,
    commitment: string,
    rpcUrl?: string,
): Promise<ArenaWriteResult> =>
    write(source, contract, 'commitMove', [gameId, commitment], 0n, rpcUrl);

export const revealArenaMove = (
    source: WalletKeySource,
    contract: string,
    gameId: bigint,
    move: ArenaMove,
    secret: string,
    rpcUrl?: string,
): Promise<ArenaWriteResult> =>
    write(source, contract, 'revealMove', [gameId, move, secret], 0n, rpcUrl);

export const settleArenaGame = (
    source: WalletKeySource,
    contract: string,
    gameId: bigint,
    method: 'resolveGame' | 'cancelExpiredGame' | 'claimPayout',
    rpcUrl?: string,
): Promise<ArenaWriteResult> =>
    write(source, contract, method, [gameId], 0n, rpcUrl);

export const arenaHasOpponent = (game: ArenaGame): boolean =>
    game.playerTwo !== ZERO_ADDRESS;
