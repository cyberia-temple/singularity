import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeColor, squarify } from '../../resources/js/lib/treemap.ts';

test('areas are proportional and fill the rectangle', () => {
    const rect = { x: 0, y: 0, w: 600, h: 400 };
    const placed = squarify([6, 6, 4, 3, 2, 2, 1], (v) => v, rect);
    const area = placed.reduce((sum, p) => sum + p.w * p.h, 0);

    assert.equal(placed.length, 7);
    assert.ok(Math.abs(area - 600 * 400) < 1e-6);
    assert.ok(Math.abs(placed[0].w * placed[0].h - (6 / 24) * 240000) < 1e-6);

    for (const p of placed) {
        assert.ok(p.x >= -1e-9 && p.y >= -1e-9);
        assert.ok(p.x + p.w <= 600 + 1e-6 && p.y + p.h <= 400 + 1e-6);
    }
});

test('zero, negative and missing values are left out', () => {
    assert.equal(
        squarify([0, -1, Number.NaN, 5], (v) => v, { x: 0, y: 0, w: 10, h: 10 })
            .length,
        1,
    );
    assert.deepEqual(
        squarify([], (v) => v, { x: 0, y: 0, w: 10, h: 10 }),
        [],
    );
});

test('an unmeasured change is not drawn as zero', () => {
    assert.notEqual(changeColor(null), changeColor(0));
    assert.equal(changeColor(10), changeColor(3));
    assert.notEqual(changeColor(1), changeColor(-1));
});
