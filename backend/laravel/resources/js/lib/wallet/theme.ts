/**
 * Palettes: the wallet's colours as a choice rather than as a constant.
 *
 * The wallet already had two palettes and one switch between them — light and
 * dark — and `wallet.css` says why that worked at all: *the structure* is what
 * reads (hairline, mono, one accent, colour spent only on state), and the
 * structure survives a swap. Every colour in that file is a token for exactly
 * this reason, and this module is the rest of that argument: if a second
 * palette can be a token swap, so can a sixth, and so can one somebody writes
 * themselves.
 *
 * Three decisions carry the design.
 *
 * **A palette is three colours, not sixty.** `wallet.css` declares around
 * forty colour tokens per theme and the relationships between them are the
 * design: a card is a fixed perceptual step above the field it sits on, a
 * hairline is a fixed fraction of the way from the card toward the ink, quiet
 * ink sits at 0.80 of that same axis. Those fractions were measured off the two
 * hand-tuned themes and are the constants below, so a palette only has to name
 * the three colours the fractions are anchored to — the ground, the ink and the
 * accent — and everything else is derived. Asking a person to pick forty
 * colours is not a feature; it is a way of shipping forty chances to make the
 * wallet unreadable.
 *
 * **The arithmetic is OKLab and not sRGB.** A step of "one eighth lighter" in
 * sRGB is a different-sized step at every lightness and drags the hue with it;
 * in OKLab the L axis is perceptually even, which is what makes one table of
 * offsets work for a near-black ground and a paper-white one. Mixing two
 * colours in sRGB is also how greys go muddy, and the whole ink ramp is a mix.
 *
 * **What is derived is what a palette owns.** Grounds, the ink ramp, structure,
 * the accent family, the atmosphere and the veils are derived and emitted.
 * Network hues and the three state colours are *not*: a network hue is a brand
 * (Solana is violet because Solana is violet, not because this palette is) and
 * `--cw-ok`/`--cw-pending`/`--cw-bad` are a vocabulary — they mean waiting,
 * done and failed, and a palette that repainted them would be a palette that
 * renames them. Both come from the base theme in `wallet.css`, picked by the
 * palette's own polarity, which is why a derived palette keeps its grounds at
 * roughly the lightness of the base's: those inherited colours were tuned
 * against them and are measured against them in `WalletPaletteTest.mjs`.
 *
 * Nothing here ships an amber or a green palette, and that is deliberate: those
 * two hues are what state is written in, and an amber accent beside an amber
 * "waiting" is a wallet that says two things with one colour. The custom
 * palette will happily make you one — it is your device — and the editor
 * reports the two contrast ratios that decide whether it can be read.
 */

/** The three colours a palette is written as. */
export type PaletteSeed = {
    /** The outermost ground: the canvas everything else is stacked on. */
    ground: string;
    /** The loudest text. The whole quiet ramp is derived towards it. */
    ink: string;
    /** One accent, used as ink and as a ground for the primary button. */
    accent: string;
};

/** Which end of the ramp a palette lives at, once its ground is measured. */
export type PalettePolarity = 'dark' | 'light';

export type WalletPalette = {
    id: string;
    /** A key in `walletMessages`, never a literal — these are user-facing. */
    label: string;
    /**
     * The two faces. `null` means the stylesheet's own: `wired` *is* the base
     * theme in `wallet.css`, and re-deriving it here would be a second, drifting
     * copy of the palette the file already defines.
     */
    faces: { dark: PaletteSeed; light: PaletteSeed } | null;
};

/**
 * The shipped palettes.
 *
 * Every one of them keeps its accent out of the amber/green/red family for the
 * reason above, and every one names both faces, because the light/dark
 * preference stays live underneath the palette: choosing `abyss` is choosing a
 * set of colours, not choosing to be dark.
 */
export const WALLET_PALETTES: readonly WalletPalette[] = [
    { id: 'wired', label: 'paletteWired', faces: null },
    {
        id: 'abyss',
        label: 'paletteAbyss',
        faces: {
            dark: { ground: '#04070f', ink: '#ecf1fd', accent: '#5a9dff' },
            light: { ground: '#e3e9f2', ink: '#111723', accent: '#1a5ccc' },
        },
    },
    {
        id: 'ultraviolet',
        label: 'paletteUltraviolet',
        faces: {
            dark: { ground: '#06040c', ink: '#f2edff', accent: '#a98cff' },
            light: { ground: '#eae6f4', ink: '#161122', accent: '#6b39cc' },
        },
    },
    {
        id: 'orchid',
        label: 'paletteOrchid',
        faces: {
            dark: { ground: '#0a050a', ink: '#fdebf8', accent: '#ff6bcf' },
            light: { ground: '#f2e7ef', ink: '#1c1018', accent: '#b01490' },
        },
    },
    {
        id: 'noir',
        label: 'paletteNoir',
        faces: {
            /*
             * No accent hue at all: the accent is ink, and every colour left on
             * screen means something — a network or a state. It is the only
             * palette here that can be read as a statement about the others.
             */
            dark: { ground: '#060606', ink: '#f2f2f2', accent: '#e6e6e6' },
            light: { ground: '#e9e9e9', ink: '#131313', accent: '#242424' },
        },
    },
];

/** The id of the palette a wallet that has chosen nothing is painted in. */
export const DEFAULT_PALETTE = 'wired';

/** The custom palette's id, which is not in the list above: it has no seed. */
export const CUSTOM_PALETTE = 'custom';

/**
 * A palette somebody wrote, plus the escape hatch under it.
 *
 * One face and not two. A custom palette is a set of colours a person picked
 * while looking at them, and asking them to pick a second set for "the other
 * theme" produces one face nobody ever saw; so the light/dark preference stops
 * applying while these colours are on, the polarity is read off the ground
 * rather than off the preference, and the settings screen says so instead of
 * leaving a control that silently does nothing.
 */
export type CustomTheme = PaletteSeed & {
    /** Raw CSS, applied last, over whatever palette is selected. */
    css: string;
};

/**
 * What an unwritten custom palette starts from, used only when the live
 * stylesheet cannot be read (no document, a palette the browser has not applied
 * yet). The editor prefills from the *running* palette wherever it can, so this
 * is a fallback and never the offer: a stale copy of three hex values here is
 * harmless, and the same three values in a token block would not be.
 */
export const CUSTOM_FALLBACK: CustomTheme = {
    ground: '#05070a',
    ink: '#f0f4f8',
    accent: '#2fe9e0',
    css: '',
};

const PALETTE_KEY = 'cyberia.wallet.palette';
const CUSTOM_KEY = 'cyberia.wallet.palette.custom';

/* ----------------------------------------------------------------- colour -- */

type Oklab = [number, number, number];

const clamp = (value: number, low = 0, high = 1): number =>
    Math.min(high, Math.max(low, value));

/** `#abc`, `#aabbcc` and `rgb(1 2 3)` in; three 0..1 channels out, or null. */
export const parseColour = (input: string): [number, number, number] | null => {
    const text = input.trim().toLowerCase();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);

    if (hex) {
        const digits =
            hex[1].length === 3
                ? [...hex[1]].map((digit) => digit + digit).join('')
                : hex[1];

        return [0, 2, 4].map(
            (at) => parseInt(digits.slice(at, at + 2), 16) / 255,
        ) as [number, number, number];
    }

    // `getComputedStyle` hands back whatever the stylesheet wrote, and a token
    // may well have been authored as `rgb()`.
    const rgb = /^rgba?\(([^)]+)\)$/.exec(text);

    if (!rgb) {
        return null;
    }

    const parts = rgb[1]
        .split(/[\s,/]+/)
        .filter((part) => part !== '')
        .slice(0, 3)
        .map((part) =>
            part.endsWith('%')
                ? Number.parseFloat(part) / 100
                : Number.parseFloat(part) / 255,
        );

    return parts.length === 3 && parts.every((part) => Number.isFinite(part))
        ? (parts as [number, number, number])
        : null;
};

export const toHex = (rgb: [number, number, number]): string =>
    `#${rgb
        .map((channel) =>
            Math.round(clamp(channel) * 255)
                .toString(16)
                .padStart(2, '0'),
        )
        .join('')}`;

const toLinear = (channel: number): number =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const toGamma = (channel: number): number =>
    channel <= 0.0031308
        ? channel * 12.92
        : 1.055 * channel ** (1 / 2.4) - 0.055;

const toOklab = (rgb: [number, number, number]): Oklab => {
    const [r, g, b] = rgb.map(toLinear);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

    return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
};

const fromOklab = ([L, a, b]: Oklab): [number, number, number] => {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;

    /*
     * Out-of-gamut answers are clamped per channel rather than desaturated
     * towards the gamut edge. Everything derived here is a small step from a
     * colour that was already inside sRGB, so the correction is a rounding
     * error; a full gamut mapping would be a lot of arithmetic to move a ground
     * by a value nobody can see.
     */
    return [
        clamp(toGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
        clamp(toGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
        clamp(toGamma(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
    ];
};

/** WCAG relative luminance, which is not OKLab's L and is not interchangeable. */
export const luminance = (colour: string): number => {
    const rgb = parseColour(colour) ?? [0, 0, 0];
    const [r, g, b] = rgb.map(toLinear);

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** The ratio WCAG is written in: 1 for two identical colours, 21 at most. */
export const contrastRatio = (a: string, b: string): number => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);

    return (high + 0.05) / (low + 0.05);
};

/** Keep the hue and chroma, move the perceptual lightness. */
const shiftL = (colour: Oklab, delta: number): Oklab => [
    clamp(colour[0] + delta),
    colour[1],
    colour[2],
];

/** Straight line in OKLab: `at` 0 is `from`, 1 is `to`, past 1 overshoots. */
const mix = (from: Oklab, to: Oklab, at: number): Oklab => [
    from[0] + (to[0] - from[0]) * at,
    from[1] + (to[1] - from[1]) * at,
    from[2] + (to[2] - from[2]) * at,
];

const rgba = (colour: string, alpha: number): string => {
    const rgb = parseColour(colour) ?? [0, 0, 0];
    const [r, g, b] = rgb.map((channel) => Math.round(clamp(channel) * 255));

    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/* -------------------------------------------------------------- the ladder -- */

/**
 * Every constant below was measured off the two hand-tuned themes in
 * `wallet.css` (both of them, and averaged where they agreed) rather than
 * chosen. They are ΔL in OKLab, or a fraction of the way along an axis.
 */

/** Grounds, as a perceptual step up from the canvas. Cards are never darker. */
const GROUNDS: Record<string, number> = {
    app: 0.03,
    'input-bg': 0.04,
    panel: 0.044,
    surface: 0.058,
    sunken: 0.062,
};

/**
 * The three grounds that sit *above* the card, as a step from the surface
 * towards the ink. Towards the ink and not simply upwards: on the dark theme
 * that means lighter and on the light theme it means the recessed grey a white
 * card is lifted out of, which is what both hand-tuned themes actually do.
 */
const RAISED: Record<string, number> = {
    raised: 0.038,
    elevated: 0.044,
    well: 0.05,
};

/**
 * Structure, as a fraction of the axis from the card to the ink. The two themes
 * agreed here to within two hundredths, which is why this table is not split.
 */
const STRUCTURE: Record<string, number> = {
    hairline: 0.126,
    line: 0.112,
    'line-strong': 0.162,
    'border-soft': 0.2,
    border: 0.27,
    'border-hover': 0.476,
};

/**
 * The ink ramp, as a fraction of the axis from the canvas to the ink — and the
 * one table that had to be split in two. The two hand-tuned themes place their
 * quiet ink at genuinely different points on that axis (0.80 dark, 0.70 light)
 * because the two directions are not symmetrical: lightening a near-black
 * ground buys contrast quickly, darkening a near-white one does not, and both
 * ramps were pushed until they cleared the same floors. Averaging them would
 * produce one ramp that fails on both sides.
 *
 * `fainter` is the exception in both: it is not text, it draws disabled
 * controls and rules, and it is the only entry here allowed to be quiet.
 */
const INK: Record<PalettePolarity, Record<string, number>> = {
    dark: {
        fainter: 0.575,
        faint: 0.796,
        dim: 0.815,
        muted: 0.834,
        body: 0.963,
        text: 1,
        bright: 1.033,
    },
    light: {
        fainter: 0.387,
        faint: 0.704,
        dim: 0.729,
        muted: 0.757,
        body: 0.849,
        text: 1,
        bright: 1.113,
    },
};

/** The atmosphere: grid, raster and the accent's two washes. */
const ATMOSPHERE: Record<PalettePolarity, Record<string, number>> = {
    dark: { grid: 0.028, raster: 0.062, scan: 0.035, tint: 0.05 },
    light: { grid: 0.036, raster: 0.1, scan: 0.06, tint: 0.08 },
};

export type DerivedPalette = {
    polarity: PalettePolarity;
    /** Token name without the `--cw-` prefix → CSS value. */
    tokens: Record<string, string>;
    /**
     * The two ratios that decide whether a palette can be read at all, so the
     * editor can print them instead of leaving somebody to find out.
     */
    ratios: {
        /** Body text on the card it is written on. */
        text: number;
        /** Quiet ink — labels, hints — on that same card. */
        quiet: number;
        /** A primary button's own label on the button. */
        button: number;
    };
};

/**
 * Three colours in, a whole palette out.
 *
 * The polarity is read off the ground and never asked for: a palette whose
 * ground is darker than its ink is a dark palette, whatever it is called, and
 * every table that has two versions is picked with that answer.
 */
export const derivePalette = (seed: PaletteSeed): DerivedPalette => {
    const ground = toOklab(parseColour(seed.ground) ?? [0, 0, 0]);
    const ink = toOklab(parseColour(seed.ink) ?? [1, 1, 1]);
    const accent = toOklab(parseColour(seed.accent) ?? [1, 1, 1]);
    const polarity: PalettePolarity = ground[0] < ink[0] ? 'dark' : 'light';
    const hex = (colour: Oklab): string => toHex(fromOklab(colour));

    const tokens: Record<string, string> = { canvas: hex(ground) };

    for (const [name, step] of Object.entries(GROUNDS)) {
        tokens[name] = hex(shiftL(ground, step));
    }

    const surface = shiftL(ground, GROUNDS.surface);
    // Which way "towards the ink" points, from the card. On a light palette the
    // ink is below the card and these three grounds recede rather than rise.
    const towards = ink[0] < surface[0] ? -1 : 1;

    for (const [name, step] of Object.entries(RAISED)) {
        tokens[name] = hex(shiftL(surface, step * towards));
    }

    for (const [name, fraction] of Object.entries(STRUCTURE)) {
        tokens[name] = hex(mix(surface, ink, fraction));
    }

    for (const [name, fraction] of Object.entries(INK[polarity])) {
        tokens[name] = hex(mix(ground, ink, fraction));
    }

    /*
     * The accent's own ink is picked by measurement rather than by rule: a
     * primary button paints the accent and writes this on top of it, so the
     * only question that matters is which of the two ends of the ramp the
     * accent can actually carry. Both candidates keep a trace of the accent's
     * own chroma — the hand-tuned themes do, and a neutral white on a teal
     * button reads as a different design.
     */
    const dark = hex([0.2, accent[1] * 0.3, accent[2] * 0.3]);
    const light = hex([0.98, accent[1] * 0.12, accent[2] * 0.12]);
    const accentHex = hex(accent);

    tokens.accent = accentHex;
    tokens['accent-hover'] = hex(shiftL(accent, 0.05));
    tokens['accent-ink'] =
        contrastRatio(accentHex, dark) >= contrastRatio(accentHex, light)
            ? dark
            : light;

    const air = ATMOSPHERE[polarity];
    const paper = polarity === 'dark' ? '#ffffff' : '#000000';

    tokens.grid = rgba(paper, air.grid);
    tokens['raster-ink'] = rgba(paper, air.raster);
    tokens['scan-ink'] = rgba(accentHex, air.scan);
    tokens['accent-tint'] = rgba(accentHex, air.tint);

    /*
     * A veil is what a sheet lays over the screen it interrupts, and it is dark
     * in both hand-tuned themes: a light veil over a light screen hides
     * nothing, it just washes it out. So this one is the palette's own ground
     * pushed down to near-black, which keeps its hue.
     */
    const shade = hex([0.12, ground[1], ground[2]]);

    tokens.veil = rgba(shade, 0.72);
    tokens['veil-strong'] = rgba(shade, 0.82);

    return {
        polarity,
        tokens,
        ratios: {
            text: contrastRatio(tokens.body, tokens.surface),
            quiet: contrastRatio(tokens.muted, tokens.surface),
            button: contrastRatio(tokens.accent, tokens['accent-ink']),
        },
    };
};

/* ------------------------------------------------------------------- CSS -- */

const declarations = (palette: DerivedPalette, indent: string): string =>
    [
        ...Object.entries(palette.tokens).map(
            ([name, value]) => `${indent}--cw-${name}: ${value};`,
        ),
        // What repaints the scrollbars and the native controls the wallet does
        // not draw itself. It follows the ground, not the preference.
        `${indent}color-scheme: ${palette.polarity};`,
    ].join('\n');

/**
 * What a person may not put in the CSS box, and why it is this list.
 *
 * Nothing here is about protecting the wallet from its owner — it is their
 * device and their stylesheet, and a broken layout is a mistake they can see
 * and undo. It is about the one thing a stylesheet can do that is neither
 * visible nor undoable: fetch. A single `url()` turns every open of this wallet
 * into a request to somebody else's server, which is a beacon saying *this
 * wallet is open right now*, and a rule pasted from a forum is exactly how that
 * arrives. The wallet's own proxy screen promises that keys stay on the device
 * and names every request that leaves it; a stylesheet that could add one
 * silently would make that promise untrue.
 */
const REFUSED = [
    '@import',
    'url(',
    'image-set(',
    'expression(',
    '-moz-binding',
    'behavior:',
    '</style',
];

/** The cap is generous; it exists so a paste accident cannot become the page. */
export const CSS_LIMIT = 6000;

export type CssVerdict = {
    /** What may be applied — empty when anything was refused. */
    css: string;
    /** What was refused, verbatim, so the note can name it. */
    refused: string[];
};

/**
 * The CSS box, checked rather than trusted.
 *
 * A refusal is all-or-nothing on purpose. Applying the half of somebody's
 * stylesheet that passed would leave them looking at a wallet that is neither
 * what they wrote nor what it was, with no way to tell which rule went missing.
 */
export const reviewCss = (input: string): CssVerdict => {
    const css = input.trim();

    if (css === '') {
        return { css: '', refused: [] };
    }

    const lower = css.toLowerCase();
    const refused = REFUSED.filter((pattern) => lower.includes(pattern));

    if (css.length > CSS_LIMIT) {
        refused.push('length');
    }

    /*
     * Braces are counted because this block is emitted inside a wrapper: an
     * unclosed rule does not fail on its own, it swallows the wrapper's closing
     * brace and takes whatever follows with it. Counting is not parsing and
     * cannot catch every malformed stylesheet — the browser drops what it
     * cannot read, which is the right answer for the rest.
     */
    const open = (css.match(/{/g) ?? []).length;
    const close = (css.match(/}/g) ?? []).length;

    if (open !== close) {
        refused.push('braces');
    }

    return refused.length > 0 ? { css: '', refused } : { css, refused: [] };
};

/**
 * Every palette as one stylesheet, installed once and never rebuilt per screen.
 *
 * All of them and not only the active one, because the settings screen draws
 * each palette as a swatch of its own colours — a `.cw` inside the page
 * carrying `data-cw-palette`, painted by these very blocks — and a preview that
 * had to be built a second way is a preview that can disagree with the thing it
 * previews. `wired` is absent: it is the base theme in `wallet.css`, so a root
 * that names it is a root with nothing overriding it.
 */
export const paletteCss = (custom: CustomTheme | null): string => {
    const blocks: string[] = [];

    for (const palette of WALLET_PALETTES) {
        if (!palette.faces) {
            continue;
        }

        for (const scheme of ['dark', 'light'] as const) {
            const derived = derivePalette(palette.faces[scheme]);

            blocks.push(
                `.cw[data-cw-theme='${scheme}'][data-cw-palette='${palette.id}'] {\n` +
                    `${declarations(derived, '    ')}\n}`,
            );
        }
    }

    if (custom) {
        /*
         * Doubled class, and it is load-bearing arithmetic rather than a typo:
         * this block has to outrank `.cw[data-cw-theme='light']` in the
         * stylesheet — which it does not by document order, since a bundled
         * stylesheet and an injected one land in whatever order the build
         * chooses — and it has to hold whichever preference is set, because a
         * custom palette has one face.
         */
        blocks.push(
            `.cw.cw[data-cw-palette='${CUSTOM_PALETTE}'] {\n` +
                `${declarations(derivePalette(custom), '    ')}\n}`,
        );
    }

    const verdict = reviewCss(custom?.css ?? '');

    if (verdict.css !== '') {
        /*
         * Last, loudest, and deliberately not applied to the swatches: they are
         * previews of the palettes as shipped, and a rule that repainted them
         * would leave the picker showing the same six cards.
         *
         * The wrapper is the whole of the scoping. Bare declarations inside it
         * land on the wallet's root, where the tokens live; a nested rule needs
         * `&`, which is also what keeps it inside the wallet instead of loose on
         * the page.
         */
        blocks.push(
            `.cw.cw.cw[data-cw-palette]:not(.cw-swatch) {\n${verdict.css}\n}`,
        );
    }

    return blocks.join('\n\n');
};

/* --------------------------------------------------------------- storage -- */

const isPaletteId = (value: unknown): boolean =>
    value === CUSTOM_PALETTE ||
    WALLET_PALETTES.some((palette) => palette.id === value);

export const readPalette = (): string => {
    try {
        const value = window.localStorage.getItem(PALETTE_KEY);

        return isPaletteId(value) ? (value as string) : DEFAULT_PALETTE;
    } catch {
        // Private mode, or site data switched off. The default is still a
        // palette, and this tab is still painted.
        return DEFAULT_PALETTE;
    }
};

export const writePalette = (id: string): void => {
    try {
        window.localStorage.setItem(PALETTE_KEY, id);
    } catch {
        // The choice holds for this tab, which is the whole of what a
        // preference on a device can promise anyway.
    }
};

const isSeed = (value: unknown): value is CustomTheme => {
    if (typeof value !== 'object' || value === null) {
        return false;
    }

    const record = value as Record<string, unknown>;

    return (['ground', 'ink', 'accent'] as const).every(
        (key) =>
            typeof record[key] === 'string' &&
            parseColour(record[key] as string) !== null,
    );
};

export const readCustomTheme = (): CustomTheme | null => {
    try {
        const raw = window.localStorage.getItem(CUSTOM_KEY);

        if (raw === null) {
            return null;
        }

        const parsed: unknown = JSON.parse(raw);

        if (!isSeed(parsed)) {
            return null;
        }

        const css = (parsed as { css?: unknown }).css;

        return {
            ground: parsed.ground,
            ink: parsed.ink,
            accent: parsed.accent,
            css: typeof css === 'string' ? css : '',
        };
    } catch {
        return null;
    }
};

export const writeCustomTheme = (theme: CustomTheme): void => {
    try {
        window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(theme));
    } catch {
        // As above: unsaveable is not unusable.
    }
};

/**
 * The three colours the wallet is painted in *right now*, read off the live
 * root rather than out of a table here.
 *
 * This is what the editor opens on, and it is why picking "my own colours"
 * never starts from a blank screen or from somebody else's teal: whatever
 * palette and whichever face you were looking at is the palette you start
 * editing. It reads the stylesheet because the stylesheet is the source — the
 * base theme lives there and nowhere in this module.
 */
export const readLivePalette = (): CustomTheme => {
    if (typeof document === 'undefined') {
        return CUSTOM_FALLBACK;
    }

    const root = document.querySelector('.cw');

    if (!root) {
        return CUSTOM_FALLBACK;
    }

    const style = getComputedStyle(root);
    const token = (name: string, fallback: string): string => {
        const value = style.getPropertyValue(`--cw-${name}`).trim();
        const rgb = parseColour(value);

        return rgb === null ? fallback : toHex(rgb);
    };

    return {
        ground: token('canvas', CUSTOM_FALLBACK.ground),
        ink: token('text', CUSTOM_FALLBACK.ink),
        accent: token('accent', CUSTOM_FALLBACK.accent),
        css: '',
    };
};
