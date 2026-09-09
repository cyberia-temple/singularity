import type { ArenaGame } from '@/lib/wallet/arena';

export type ArenaRole = 'playerOne' | 'playerTwo' | 'spectator';
export type ArenaAction =
    | 'join'
    | 'commit'
    | 'reveal'
    | 'resolve'
    | 'settleTimeout'
    | 'claim'
    | 'ready'
    | 'wait'
    | 'complete';

const sameAddress = (left: string, right: string): boolean =>
    left.toLowerCase() === right.toLowerCase();

export const arenaRole = (game: ArenaGame, address: string): ArenaRole =>
    sameAddress(game.playerOne, address)
        ? 'playerOne'
        : sameAddress(game.playerTwo, address)
          ? 'playerTwo'
          : 'spectator';

export const arenaComplete = (game: ArenaGame): boolean =>
    game.state === 4 || game.state === 5;
export const arenaPhaseExpired = (
    game: ArenaGame,
    nowSeconds: number,
): boolean =>
    !arenaComplete(game) &&
    game.deadline > 0 &&
    Math.floor(nowSeconds) > game.deadline;
export const arenaCanCancel = (game: ArenaGame, address: string): boolean =>
    game.rules?.version === 2 &&
    (game.state === 1 || game.state === 6) &&
    arenaRole(game, address) !== 'spectator';
export const arenaReadyUntil = (game: ArenaGame, address: string): number => {
    const role = arenaRole(game, address);

    return role === 'playerOne'
        ? game.playerOneReadyUntil
        : role === 'playerTwo'
          ? game.playerTwoReadyUntil
          : 0;
};

export const arenaAction = (
    game: ArenaGame,
    address: string,
    nowSeconds = Date.now() / 1000,
): ArenaAction => {
    if (game.payout > 0n) {
        return 'claim';
    }

    if (arenaComplete(game)) {
        return 'complete';
    }

    if (arenaPhaseExpired(game, nowSeconds)) {
        return 'settleTimeout';
    }

    const role = arenaRole(game, address);

    if (game.state === 1) {
        return role === 'spectator' ? 'join' : 'wait';
    }

    if (role === 'spectator') {
        return 'wait';
    }

    if (game.state === 6) {
        return arenaReadyUntil(game, address) >= Math.floor(nowSeconds)
            ? 'wait'
            : 'ready';
    }

    const isOne = role === 'playerOne';

    if (game.state === 2) {
        return (isOne ? game.playerOneCommitted : game.playerTwoCommitted)
            ? 'wait'
            : 'commit';
    }

    if (game.state === 3) {
        const mine = isOne ? game.playerOneMove : game.playerTwoMove;

        if (mine === 0) {
            return 'reveal';
        }

        return game.playerOneMove !== 0 && game.playerTwoMove !== 0
            ? 'resolve'
            : 'wait';
    }

    return 'wait';
};

export const arenaNeedsAction = (action: ArenaAction): boolean =>
    !['wait', 'complete'].includes(action);

export type ArenaGameLists = {
    attention: ArenaGame[];
    mine: ArenaGame[];
    open: ArenaGame[];
    complete: ArenaGame[];
};

export const arenaGameLists = (
    games: readonly ArenaGame[],
    address: string,
    nowSeconds = Date.now() / 1000,
): ArenaGameLists => ({
    attention: games.filter(
        (game) =>
            arenaRole(game, address) !== 'spectator' &&
            arenaNeedsAction(arenaAction(game, address, nowSeconds)),
    ),
    mine: games.filter(
        (game) =>
            arenaRole(game, address) !== 'spectator' && !arenaComplete(game),
    ),
    open: games.filter(
        (game) => game.state === 1 && arenaRole(game, address) === 'spectator',
    ),
    complete: games.filter(
        (game) =>
            arenaRole(game, address) !== 'spectator' && arenaComplete(game),
    ),
});
