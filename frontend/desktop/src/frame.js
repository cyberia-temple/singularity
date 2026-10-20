'use strict';

/**
 * Rules for the shell's borderless window.
 *
 * There is no drawn title bar and no attached application menu. Everything
 * that has to be decided before the site exists lives here — whether to use
 * the compatibility native frame and which keys replace the missing menu — so
 * it remains testable under plain Node like the navigation rules.
 *
 * `--native-frame` (or `CYBERIA_NATIVE_FRAME=1`) hands the window back to the
 * desktop: a window manager that decorates windows its own way, or a session
 * where a client-side frame cannot be resized, is a real machine and not a
 * hypothetical, and the shell must stay usable on it.
 */

/** Values that mean "yes" for `CYBERIA_NATIVE_FRAME`. */
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

/** How far the page may be zoomed from the menu, in Chromium zoom levels. */
const ZOOM_RANGE = { min: -3, max: 5, step: 0.5 };

/**
 * Every command the missing menu can run, and how it is spelled in a key stroke.
 *
 * This table is the accelerator list. With a frameless window there is no
 * native menu bar to answer Ctrl+R. macOS keeps its real application menu and
 * answers these itself, so the shell never installs this handler there.
 *
 * A stroke is matched on the key *or* on the physical position (`code`), the
 * way Chromium matches its own: on a Cyrillic layout Ctrl+R arrives as Ctrl+к,
 * and a shortcut that stops working when the layout is switched is not a
 * shortcut.
 */
const KEY_COMMANDS = [
    { command: 'reload', key: 'f5', code: 'F5' },
    { command: 'fullscreen', key: 'f11', code: 'F11' },
    { command: 'devtools', key: 'f12', code: 'F12' },
    { command: 'force-reload', key: 'f5', code: 'F5', control: true },
    { command: 'back', key: 'arrowleft', code: 'ArrowLeft', alt: true },
    { command: 'forward', key: 'arrowright', code: 'ArrowRight', alt: true },
    { command: 'reload', key: 'r', code: 'KeyR', control: true },
    { command: 'force-reload', key: 'r', code: 'KeyR', control: true, shift: true },
    { command: 'devtools', key: 'i', code: 'KeyI', control: true, shift: true },
    { command: 'wallet', key: 'h', code: 'KeyH', control: true, shift: true },
    { command: 'site', key: 's', code: 'KeyS', control: true, shift: true },
    { command: 'zoom-in', key: '=', code: 'Equal', control: true },
    { command: 'zoom-in', key: '+', code: 'NumpadAdd', control: true },
    { command: 'zoom-in', key: '=', code: 'Equal', control: true, shift: true },
    { command: 'zoom-out', key: '-', code: 'Minus', control: true },
    { command: 'zoom-reset', key: '0', code: 'Digit0', control: true },
    { command: 'quit', key: 'q', code: 'KeyQ', control: true },
];

/** Whether this run removes every window decoration. */
function usesFramelessWindow(env, argv) {
    if (Array.isArray(argv) && argv.includes('--native-frame')) {
        return false;
    }

    const value = typeof env.CYBERIA_NATIVE_FRAME === 'string'
        ? env.CYBERIA_NATIVE_FRAME.trim().toLowerCase()
        : '';

    return !TRUE_VALUES.has(value);
}

/**
 * The corners the wallet draws for a window in this state.
 *
 * A frameless window is transparent and the wallet rounds itself like the card
 * it is on the site. A maximised or full-screen window meets the screen edges,
 * where a rounded corner would show slivers of desktop, so it goes square — as
 * does a window the desktop frames itself.
 */
function windowEdge({ frameless, maximized, fullScreen }) {
    return frameless && !maximized && !fullScreen ? 'round' : 'square';
}

/** The smallest window the wallet still lays out in. */
const MIN_WINDOW = { width: 380, height: 520 };

/** The window sides a resize grip may name, as compass points. */
const RESIZE_EDGES = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);

/**
 * The window's bounds while a grip is dragged.
 *
 * A transparent window loses the resize border Chromium draws around a
 * frameless one, so the page carries its own grips and the shell moves the
 * window. `start` is the bounds when the drag began and `dx`/`dy` how far the
 * pointer has travelled since; the side opposite the grip stays put, also when
 * the window has reached its minimum size.
 */
function resizedBounds(start, edge, dx, dy, min = MIN_WINDOW) {
    if (!RESIZE_EDGES.has(edge)) {
        return start;
    }

    let { x, y, width, height } = start;

    if (edge.includes('e')) {
        width = Math.max(min.width, start.width + dx);
    }

    if (edge.includes('w')) {
        width = Math.max(min.width, start.width - dx);
        x = start.x + start.width - width;
    }

    if (edge.includes('s')) {
        height = Math.max(min.height, start.height + dy);
    }

    if (edge.includes('n')) {
        height = Math.max(min.height, start.height - dy);
        y = start.y + start.height - height;
    }

    return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** The command a key stroke asks for, or `null` if it asks for nothing. */
function commandForInput(input) {
    if (!input || input.type !== 'keyDown' || typeof input.key !== 'string') {
        return null;
    }

    // A Windows/Linux stroke only; anything with the Command key belongs to the
    // native menu bar on the platform that has one.
    if (input.meta) {
        return null;
    }

    const key = input.key.toLowerCase();
    const code = typeof input.code === 'string' ? input.code : '';
    const stroke = {
        control: Boolean(input.control),
        alt: Boolean(input.alt),
        shift: Boolean(input.shift),
    };

    const match = KEY_COMMANDS.find(
        (entry) =>
            (entry.key === key || entry.code === code)
            && Boolean(entry.control) === stroke.control
            && Boolean(entry.alt) === stroke.alt
            && Boolean(entry.shift) === stroke.shift,
    );

    return match ? match.command : null;
}

/** The next zoom level for a zoom command, kept inside a readable range. */
function zoomLevel(current, command) {
    const level = Number.isFinite(current) ? current : 0;

    if (command === 'zoom-reset') {
        return 0;
    }

    const moved = command === 'zoom-in' ? level + ZOOM_RANGE.step : level - ZOOM_RANGE.step;

    return Math.min(ZOOM_RANGE.max, Math.max(ZOOM_RANGE.min, moved));
}

module.exports = {
    MIN_WINDOW,
    ZOOM_RANGE,
    commandForInput,
    resizedBounds,
    usesFramelessWindow,
    windowEdge,
    zoomLevel,
};
