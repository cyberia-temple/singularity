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

export const ARENA_LEGACY_CONTRACT =
    '0xd21edE559b49A6f6cDF57060456474D100D53e45';

/** Existing invitations without a contract keep referring to the original deployment. */
export const arenaContractForLink = (
    configured: string,
    gameId: bigint | null,
    requested: string | null,
): string | null => {
    if (requested === null) {
        return gameId === null ? configured : ARENA_LEGACY_CONTRACT;
    }

    return (
        [configured, ARENA_LEGACY_CONTRACT].find(
            (address) => address.toLowerCase() === requested.toLowerCase(),
        ) ?? null
    );
};

export const arenaMatchPath = (gameId: bigint, contract?: string): string => {
    if (gameId < 1n) {
        throw new Error('Arena game id must be positive');
    }

    if (contract !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(contract)) {
        throw new Error('Invalid Arena contract address');
    }

    return `/wallet?screen=arena&game=${gameId}${contract ? `&contract=${contract}` : ''}`;
};

export const arenaShareUrl = (
    origin: string,
    gameId: bigint,
    contract?: string,
): string => new URL(arenaMatchPath(gameId, contract), origin).toString();
