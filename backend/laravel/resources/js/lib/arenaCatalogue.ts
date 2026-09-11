export type ArenaCatalogueGame = {
    id: 'rps';
    version: string;
    cover: string;
    players: 2;
    durationMinutes: readonly [number, number];
    status: 'playable';
    contract: 'RockPaperScissors';
};

/** Static product metadata; live matches and balances always come from chain. */
export const ARENA_CATALOGUE: readonly ArenaCatalogueGame[] = [
    {
        id: 'rps',
        version: '0.1.0',
        cover: '/images/arena/rps-cover.png',
        players: 2,
        durationMinutes: [2, 5],
        status: 'playable',
        contract: 'RockPaperScissors',
    },
];

export const arenaCatalogueGame = (id: string): ArenaCatalogueGame | null =>
    ARENA_CATALOGUE.find((game) => game.id === id) ?? null;
