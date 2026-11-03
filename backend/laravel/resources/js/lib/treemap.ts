/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk): rectangles whose
 * areas are proportional to their values and whose sides stay as close to
 * square as the row allows, so a small tile is still a tile and not a sliver.
 */
export type Rect = { x: number; y: number; w: number; h: number };

export type Placed<T> = Rect & { item: T };

const worst = (sum: number, min: number, max: number, side: number): number => {
    const s2 = sum * sum;
    const side2 = side * side;

    return Math.max((side2 * max) / s2, s2 / (side2 * min));
};

export const squarify = <T>(
    items: T[],
    value: (item: T) => number,
    rect: Rect,
): Placed<T>[] => {
    const data = items
        .map((item) => ({ item, v: value(item) }))
        .filter((d) => Number.isFinite(d.v) && d.v > 0)
        .sort((a, b) => b.v - a.v);
    const total = data.reduce((sum, d) => sum + d.v, 0);

    if (total <= 0 || rect.w <= 0 || rect.h <= 0) {
        return [];
    }

    const scale = (rect.w * rect.h) / total;
    const areas = data.map((d) => ({ item: d.item, a: d.v * scale }));
    const out: Placed<T>[] = [];
    let { x, y, w, h } = rect;
    let i = 0;

    while (i < areas.length) {
        const side = Math.min(w, h);
        let sum = areas[i].a;
        let min = sum;
        let max = sum;
        let ratio = worst(sum, min, max, side);
        let j = i + 1;

        while (j < areas.length) {
            const a = areas[j].a;
            const next = worst(
                sum + a,
                Math.min(min, a),
                Math.max(max, a),
                side,
            );

            if (next > ratio) {
                break;
            }

            sum += a;
            min = Math.min(min, a);
            max = Math.max(max, a);
            ratio = next;
            j++;
        }

        if (w >= h) {
            const width = sum / h;
            let cy = y;

            for (const r of areas.slice(i, j)) {
                const height = r.a / width;
                out.push({ x, y: cy, w: width, h: height, item: r.item });
                cy += height;
            }

            x += width;
            w -= width;
        } else {
            const height = sum / w;
            let cx = x;

            for (const r of areas.slice(i, j)) {
                const width = r.a / height;
                out.push({ x: cx, y, w: width, h: height, item: r.item });
                cx += width;
            }

            y += height;
            h -= height;
        }

        i = j;
    }

    return out;
};

const NEUTRAL = [52, 63, 74];
const UP = [24, 150, 98];
const DOWN = [176, 52, 58];

/**
 * A tile's colour for a percent change: grey at zero, full green or red at
 * ±`full`%. An unmeasured change (null) is a darker grey, never a 0%.
 */
export const changeColor = (change: number | null, full = 3): string => {
    if (change === null || !Number.isFinite(change)) {
        return 'rgb(38, 42, 50)';
    }

    const t = Math.min(Math.abs(change) / full, 1);
    const target = change >= 0 ? UP : DOWN;
    const mix = NEUTRAL.map((c, k) => Math.round(c + (target[k] - c) * t));

    return `rgb(${mix.join(', ')})`;
};
