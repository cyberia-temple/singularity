export const arenaTransactionUrl = (
    explorerUrl: string,
    transactionHash: string,
): string | null => {
    if (!/^0x[a-fA-F0-9]{64}$/.test(transactionHash)) {
        return null;
    }

    try {
        const explorer = new URL(explorerUrl);

        if (!['https:', 'http:'].includes(explorer.protocol)) {
            return null;
        }

        return new URL(`/tx/${transactionHash}`, explorer).toString();
    } catch {
        return null;
    }
};

export type ArenaErrorCode =
    | 'rejected'
    | 'insufficientFunds'
    | 'wrongPhase'
    | 'rpc'
    | 'unknown';

export const arenaErrorCode = (error: unknown): ArenaErrorCode => {
    const value = String(
        error instanceof Error ? error.message : error,
    ).toLowerCase();

    if (value.includes('user rejected') || value.includes('action_rejected')) {
        return 'rejected';
    }

    if (value.includes('insufficient funds')) {
        return 'insufficientFunds';
    }

    if (value.includes('invalidphase') || value.includes('deadline')) {
        return 'wrongPhase';
    }

    if (
        value.includes('network') ||
        value.includes('rpc') ||
        value.includes('failed to fetch')
    ) {
        return 'rpc';
    }

    return 'unknown';
};
