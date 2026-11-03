#!/usr/bin/env node
/**
 * The Cyberia app icon, drawn from one geometry: the black die of the brand
 * (backend/laravel/public/cyber.png) as flat vector shapes that stay sharp at
 * 48 dp — three shaded faces, cyan edges, and one glyph per face (the eye on
 * top, the hexagram on the left, <Ø> on the right).
 *
 * Writes:
 *   android/app/src/main/res/drawable/ic_launcher_background.xml   adaptive background (vector)
 *   android/app/src/main/res/drawable-v24/ic_launcher_foreground.xml adaptive foreground (vector)
 *   android/app/src/main/res/drawable/ic_launcher_monochrome.xml   Android 13+ themed icon
 *   android/app/src/main/res/mipmap-anydpi-v26/ic_launcher{,_round}.xml
 *   android/app/src/main/res/mipmap-<density>/ic_launcher{,_round}.png  legacy launchers
 *   resources/icon*.png, the iOS 1024 icon, the Play listing icon, and the
 *   extension's and the desktop app's icons, when Playwright is available.
 *
 * The die sits inside the adaptive icon's 66 dp safe circle on a 108 dp
 * canvas, so no launcher mask (circle, squircle, teardrop) crops it — the old
 * icon shrank the layers by another 16.7% and left a transparent ring.
 *
 * Run: node scripts/icon.mjs   (PNG rendering needs `npx playwright` / a Chromium)
 */
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const res = join(root, 'android/app/src/main/res');

const CYAN = '#00E5D1';
const BG_IN = '#123236';
const BG_OUT = '#05090A';
const FACE = { top: '#253536', left: '#131D1E', right: '#0A1112' };

// The die on the 108 x 108 adaptive canvas. Its farthest corner is 32.2 from
// the centre, inside the 33 safe radius.
const P = {
    back: [54, 22], right: [82, 38], front: [54, 54], left: [26, 38],
    bottomRight: [82, 70], bottom: [54, 86], bottomLeft: [26, 70],
};

// Each face as an affine map from local (u, v) in [0, 1]^2 to the canvas.
const faces = {
    top: (u, v) => [P.left[0] + u * 28 + v * 28, P.left[1] - u * 16 + v * 16],
    left: (u, v) => [P.left[0] + u * 28, P.left[1] + u * 16 + v * 32],
    right: (u, v) => [P.front[0] + u * 28, P.front[1] - u * 16 + v * 32],
};

const fmt = (n) => Number(n.toFixed(2));
const poly = (points, close = false) =>
    'M' + points.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' L') + (close ? ' Z' : '');
const onFace = (face, points) => points.map(([u, v]) => faces[face](u, v));
const arc = (cx, cy, rx, ry, from, to, steps = 28) =>
    Array.from({ length: steps + 1 }, (_, i) => {
        const a = from + ((to - from) * i) / steps;
        return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
    });

// Outlines of the faces and the three inner edges.
const facePaths = {
    top: poly([P.back, P.right, P.front, P.left], true),
    left: poly([P.left, P.front, P.bottom, P.bottomLeft], true),
    right: poly([P.front, P.right, P.bottomRight, P.bottom], true),
};
const edges = [
    poly([P.back, P.right, P.bottomRight, P.bottom, P.bottomLeft, P.left], true),
    poly([P.left, P.front, P.right]),
    poly([P.front, P.bottom]),
];

// Glyphs, as strokes (and one fill) in canvas coordinates.
const eye = [
    // An almond along the face's left-right diagonal: upper and lower lids.
    poly(onFace('top', lid(1))),
    poly(onFace('top', lid(-1))),
];
function lid(side) {
    // From the left corner end (0.22, 0.22) to (0.78, 0.78), bulging across the diagonal.
    return Array.from({ length: 21 }, (_, i) => {
        const t = i / 20;
        const d = 0.22 + 0.56 * t;
        const bulge = 0.17 * Math.sin(Math.PI * t) * side;
        return [d + bulge, d - bulge];
    });
}
const pupil = poly(onFace('top', arc(0.5, 0.5, 0.085, 0.085, 0, Math.PI * 2, 24)), true);
const hexagram = [0, 1].map((k) =>
    poly(onFace('left', [0, 1, 2].map((i) => {
        const a = -Math.PI / 2 + k * Math.PI + (i * 2 * Math.PI) / 3;
        return [0.5 + 0.3 * Math.cos(a), 0.5 + 0.3 * Math.sin(a)];
    })), true),
);
const zero = [
    poly(onFace('right', arc(0.5, 0.5, 0.17, 0.21, 0, Math.PI * 2, 36)), true),
    poly(onFace('right', [[0.36, 0.78], [0.64, 0.22]])),
    poly(onFace('right', [[0.2, 0.38], [0.09, 0.5], [0.2, 0.62]])),
    poly(onFace('right', [[0.8, 0.38], [0.91, 0.5], [0.8, 0.62]])),
];
const glyphStrokes = [...eye, ...hexagram, ...zero];

// ---------------------------------------------------------------- SVG (PNGs)

function svg({ background = true, foreground = true, mono = false, shape = 'none', size = 108, glow = true }) {
    // Below 40 px the side glyphs are mush: the die and its eye carry the mark alone.
    const glyphs = size < 40 ? eye : glyphStrokes;
    const clip = shape === 'circle'
        ? '<clipPath id="m"><circle cx="54" cy="54" r="54"/></clipPath>'
        : shape === 'rounded'
            ? '<clipPath id="m"><rect width="108" height="108" rx="24"/></clipPath>'
            : '';
    const ink = mono ? '#FFFFFF' : CYAN;
    const parts = [];
    if (background) {
        parts.push('<rect width="108" height="108" fill="url(#bg)"/>');
    }
    if (foreground) {
        if (!mono) {
            parts.push(`<path d="${facePaths.top}" fill="${FACE.top}"/>`);
            parts.push(`<path d="${facePaths.left}" fill="${FACE.left}"/>`);
            parts.push(`<path d="${facePaths.right}" fill="${FACE.right}"/>`);
        }
        const lines = [...edges, ...glyphs].map((d) => `<path d="${d}"/>`).join('');
        const stroke = (width, extra = '') =>
            `<g fill="none" stroke="${ink}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"${extra}>${lines}</g>`;
        if (glow && !mono) parts.push(stroke(4.2, ' opacity="0.55" filter="url(#glow)"'));
        parts.push(stroke(mono ? 2.6 : 2.1));
        parts.push(`<path d="${pupil}" fill="${ink}"/>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 108 108">
<defs>
<radialGradient id="bg" cx="50%" cy="46%" r="70%"><stop offset="0" stop-color="${BG_IN}"/><stop offset="1" stop-color="${BG_OUT}"/></radialGradient>
<filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.6"/></filter>
${clip}
</defs>
<g${clip ? ' clip-path="url(#m)"' : ''}>${parts.join('\n')}</g>
</svg>`;
}

// ------------------------------------------------------- Android vector XML

const vectorHeader = (extra = '') =>
    `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by frontend/mobile/scripts/icon.mjs — edit the script, not this file. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"${extra}
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">`;

const strokePath = (d, color, width, alpha = 1) =>
    `    <path android:pathData="${d}" android:strokeColor="${color}" android:strokeWidth="${width}"` +
    `${alpha < 1 ? ` android:strokeAlpha="${alpha}"` : ''} android:strokeLineCap="round" android:strokeLineJoin="round" android:fillColor="#00000000"/>`;

const foregroundXml = [
    vectorHeader(),
    `    <path android:pathData="${facePaths.top}" android:fillColor="${FACE.top}"/>`,
    `    <path android:pathData="${facePaths.left}" android:fillColor="${FACE.left}"/>`,
    `    <path android:pathData="${facePaths.right}" android:fillColor="${FACE.right}"/>`,
    // A soft wide stroke under the edges stands in for the glow a vector cannot blur.
    ...edges.map((d) => strokePath(d, CYAN, 4.4, 0.22)),
    ...[...edges, ...glyphStrokes].map((d) => strokePath(d, CYAN, 2.1)),
    `    <path android:pathData="${pupil}" android:fillColor="${CYAN}"/>`,
    '</vector>',
    '',
].join('\n');

const monochromeXml = [
    vectorHeader(),
    ...[...edges, ...glyphStrokes].map((d) => strokePath(d, '#FFFFFFFF', 2.6)),
    `    <path android:pathData="${pupil}" android:fillColor="#FFFFFFFF"/>`,
    '</vector>',
    '',
].join('\n');

const backgroundXml = [
    vectorHeader('\n    xmlns:aapt="http://schemas.android.com/aapt"'),
    '    <path android:pathData="M0,0h108v108h-108z">',
    '        <aapt:attr name="android:fillColor">',
    `            <gradient android:type="radial" android:centerX="54" android:centerY="50" android:gradientRadius="76" android:startColor="${BG_IN}" android:endColor="${BG_OUT}"/>`,
    '        </aapt:attr>',
    '    </path>',
    '</vector>',
    '',
].join('\n');

const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by frontend/mobile/scripts/icon.mjs. Layers fill the whole 108 dp canvas: the
     die already sits inside the 66 dp safe zone, so no inset is applied on top. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`;

function write(path, body) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    console.log('wrote', path.replace(root + '/', ''));
}

write(join(res, 'drawable-v24/ic_launcher_foreground.xml'), foregroundXml);
write(join(res, 'drawable/ic_launcher_monochrome.xml'), monochromeXml);
write(join(res, 'drawable/ic_launcher_background.xml'), backgroundXml);
write(join(res, 'mipmap-anydpi-v26/ic_launcher.xml'), adaptiveXml);
write(join(res, 'mipmap-anydpi-v26/ic_launcher_round.xml'), adaptiveXml);
write(join(res, 'values/ic_launcher_background.xml'), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BG_OUT}</color>\n    <color name="notification_accent">${CYAN}</color>\n</resources>\n`);
write(join(root, 'resources/icon.svg'), svg({ shape: 'none' }));

// The old raster layers are replaced by the vectors above.
for (const density of ['ldpi', 'mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const file of ['ic_launcher_foreground.png', 'ic_launcher_background.png']) {
        const path = join(res, `mipmap-${density}`, file);
        if (existsSync(path)) rmSync(path);
    }
}

// ------------------------------------------------------------ PNG rendering

let chromium;
try {
    chromium = createRequire(import.meta.url)('playwright').chromium;
} catch {
    console.log('playwright not found: vectors written, PNGs left as they are.');
    process.exit(0);
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function png(path, options, size) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:transparent">${svg({ ...options, size })}</body></html>`);
    const shot = await page.locator('svg').screenshot({ omitBackground: true });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, shot);
    console.log('rendered', path.replace(root + '/', ''), `${size}px`);
}

const densities = { ldpi: 36, mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [density, size] of Object.entries(densities)) {
    if (!existsSync(join(res, `mipmap-${density}`))) continue;
    await png(join(res, `mipmap-${density}/ic_launcher.png`), { shape: 'rounded' }, size);
    await png(join(res, `mipmap-${density}/ic_launcher_round.png`), { shape: 'circle' }, size);
}
await png(join(root, 'resources/icon.png'), { shape: 'none' }, 1024);
await png(join(root, 'resources/icon-foreground.png'), { background: false }, 1024);
await png(join(root, 'resources/icon-background.png'), { foreground: false }, 1024);
await png(join(root, 'fastlane/metadata/android/en-US/images/icon.png'), { shape: 'none' }, 512);
const iosIcon = join(root, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png');
if (existsSync(iosIcon)) await png(iosIcon, { shape: 'none', glow: true }, 1024);
const extension = join(root, '../extension/icons');
if (existsSync(extension)) {
    for (const size of [16, 32, 48, 128]) await png(join(extension, `icon-${size}.png`), { shape: 'rounded', glow: size >= 48 }, size);
}
// The site's own installable app (PWA) and its favicon: the same die.
const pwa = join(root, '../../backend/laravel/public/pwa');
if (existsSync(pwa)) {
    await png(join(pwa, 'icon-192.png'), { shape: 'rounded' }, 192);
    await png(join(pwa, 'icon-512.png'), { shape: 'rounded' }, 512);
    // Maskable: full bleed, the die already inside the safe zone.
    await png(join(pwa, 'icon-maskable-512.png'), { shape: 'none' }, 512);
    await png(join(pwa, '../apple-touch-icon.png'), { shape: 'none' }, 180);
    // A favicon is drawn at 16-32 px: the die and its eye only.
    writeFileSync(join(pwa, '../favicon.svg'), svg({ shape: 'rounded', glow: false, size: 32 }).replace(/ width="32" height="32"/, ''));
}
const desktop = join(root, '../desktop/build/icon.png');
if (existsSync(desktop)) await png(desktop, { shape: 'rounded' }, 1024);
await browser.close();
