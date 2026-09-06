import type { ArenaGame } from '@/lib/wallet/arena';

export type ArenaRole = 'playerOne' | 'playerTwo' | 'spectator';
export type ArenaAction =
    | 'join'
    | 'commit'
    | 'reveal'
    | 'resolve'
    | 'settleTimeout'
    | 'claim'
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

export const arenaAction = (
    game: ArenaGame,
    address: string,
    nowSeconds = Date.now() / 1000,
): ArenaAction => {
    if (game.payout > 0n) return 'claim';
    if (game.state >= 4) return 'complete';
    if (nowSeconds > game.deadline) return 'settleTimeout';

    const role = arenaRole(game, address);
    if (game.state === 1) return role === 'spectator' ? 'join' : 'wait';
    if (role === 'spectator') return 'wait';

    const isOne = role === 'playerOne';
    if (game.state === 2) {
        return (isOne ? game.playerOneCommitted : game.playerTwoCommitted)
            ? 'wait'
            : 'commit';
    }
    if (game.state === 3) {
        const mine = isOne ? game.playerOneMove : game.playerTwoMove;
        if (mine === 0) return 'reveal';
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
        (game) => arenaRole(game, address) !== 'spectator' && game.state < 4,
    ),
    open: games.filter(
        (game) => game.state === 1 && arenaRole(game, address) === 'spectator',
    ),
    complete: games.filter(
        (game) => arenaRole(game, address) !== 'spectator' && game.state >= 4,
    ),
});
