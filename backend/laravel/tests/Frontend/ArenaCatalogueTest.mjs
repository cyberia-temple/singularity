import assert from 'node:assert/strict';
import test from 'node:test';
import {
    ARENA_CATALOGUE,
    arenaCatalogueGame,
} from '../../resources/js/lib/arenaCatalogue.ts';

test('every Arena product has stable launcher metadata', () => {
    assert.ok(ARENA_CATALOGUE.length > 0);
    assert.equal(
        new Set(ARENA_CATALOGUE.map((game) => game.id)).size,
        ARENA_CATALOGUE.length,
    );

    for (const game of ARENA_CATALOGUE) {
        assert.match(game.cover, /^\/images\/arena\//);
        assert.equal(game.players, 2);
        assert.ok(game.durationMinutes[0] <= game.durationMinutes[1]);
    }
});

test('the RPS launcher is explicit and unknown games stay unknown', () => {
    assert.equal(arenaCatalogueGame('rps')?.contract, 'RockPaperScissors');
    assert.equal(arenaCatalogueGame('missing'), null);
});
