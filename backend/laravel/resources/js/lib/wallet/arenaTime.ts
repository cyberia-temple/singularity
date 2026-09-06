export const arenaSecondsRemaining = (
    deadline: number,
    nowSeconds = Date.now() / 1000,
): number => Math.max(0, Math.ceil(deadline - nowSeconds));

export const formatArenaCountdown = (seconds: number): string => {
    const safe = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const remainder = safe % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
        : `${minutes}:${String(remainder).padStart(2, '0')}`;
};
