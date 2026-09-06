export const parseArenaGameId = (value: string | null): bigint | null => {
    if (value === null || !/^[1-9]\d*$/.test(value)) {
        return null;
    }

    try {
        return BigInt(value);
    } catch {
        return null;
    }
};

export const arenaMatchPath = (gameId: bigint): string => {
    if (gameId < 1n) {
        throw new Error('Arena game id must be positive');
    }

    return `/wallet?screen=arena&game=${gameId}`;
};

export const arenaShareUrl = (origin: string, gameId: bigint): string =>
    new URL(arenaMatchPath(gameId), origin).toString();
