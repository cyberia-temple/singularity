"""Pixel art for a caught fish: a 64×64 picture drawn here and written as a PNG.

The bot has no imaging library and does not need one. Every catch gets its own
picture, drawn pixel by pixel from the species' look, the rarity, how big the
fish came out and a seed, then scaled up ×8 with hard edges so it stays crisp
as pixel art. The same inputs always draw the same picture, which is what lets
the photo in the chat and the image pinned for the NFT be the same fish without
storing either: the seed is stored, the picture is derived.

The PNG is written by hand (zlib + struct) because the format for an opaque RGB
image is four chunks and a filter byte per row; anything Telegram, IPFS
gateways and the marketplace render.
"""
import random
import struct
import zlib

SIZE = 64
SCALE = 8

OUTLINE_SHADE = 0.45
EDGE = 3        # the frame, in logical pixels
SAND_TOP = 55   # first row of the seabed


def _rgb(colour):
    colour = colour.lstrip("#")
    return tuple(int(colour[i:i + 2], 16) for i in (0, 2, 4))


def _mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _shade(colour, t):
    """Darker by t (0 keeps it, 1 is black)."""
    return _mix(colour, (0, 0, 0), t)


def _light(colour, t):
    return _mix(colour, (255, 255, 255), t)


class Canvas:
    def __init__(self):
        self.px = [[(0, 0, 0)] * SIZE for _ in range(SIZE)]

    def put(self, x, y, colour):
        if 0 <= x < SIZE and 0 <= y < SIZE:
            self.px[y][x] = colour

    def get(self, x, y):
        return self.px[y][x]

    def png(self, scale=SCALE):
        """The canvas as PNG bytes, every logical pixel a scale×scale block."""
        raw = bytearray()
        for row in self.px:
            line = b"".join(bytes(colour) * scale for colour in row)
            for _ in range(scale):
                raw += b"\x00" + line

        def chunk(tag, data):
            return (struct.pack(">I", len(data)) + tag + data
                    + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

        side = SIZE * scale
        header = struct.pack(">IIBBBBB", side, side, 8, 2, 0, 0, 0)
        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
                + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


# --- the water ---------------------------------------------------------------
def _water(canvas, tint, rng):
    top, bottom = _mix((22, 74, 112), tint, 0.18), _mix((4, 16, 32), tint, 0.10)
    for y in range(SIZE):
        base = _mix(top, bottom, y / (SIZE - 1))
        for x in range(SIZE):
            canvas.put(x, y, base)
    # Light from the surface: two slanted bands, brighter near the top.
    for offset in (rng.randint(4, 16), rng.randint(30, 44)):
        for y in range(0, 40):
            for width in range(3):
                x = offset + width + y // 3
                if 0 <= x < SIZE:
                    canvas.put(x, y, _light(canvas.get(x, y), 0.07 * (1 - y / 40)))
    sand, dark = (58, 48, 34), (36, 30, 22)
    for y in range(SAND_TOP, SIZE):
        for x in range(SIZE):
            ripple = (x + y * 3 + rng.randint(0, 2)) % 7 == 0
            canvas.put(x, y, dark if ripple else _mix(sand, dark, (y - SAND_TOP) / 9))
    # Seaweed: a couple of strands swaying up from the bed.
    for root in (rng.randint(5, 14), rng.randint(48, 58)):
        height, x = rng.randint(10, 20), root
        for step in range(height):
            y = SAND_TOP - step
            x = root + (1 if (step // 3) % 2 else 0)
            canvas.put(x, y, (34, 110, 58) if step % 4 else (52, 140, 74))


def _bubbles(canvas, rng, mouth):
    """A trail from the mouth and a few strays."""
    mx, my = mouth
    trail = [(mx - 2, my - 4, 1), (mx - 1, my - 9, 1), (mx - 3, my - 14, 2)]
    strays = [(rng.randint(8, 56), rng.randint(6, 24), rng.randint(1, 2)) for _ in range(3)]
    for cx, cy, r in trail + strays:
        ring = (150, 210, 235)
        if r == 1:
            for dx, dy in ((0, -1), (-1, 0), (1, 0), (0, 1)):
                canvas.put(cx + dx, cy + dy, ring)
        else:
            for dx in range(-2, 3):
                for dy in range(-2, 3):
                    if 3 <= dx * dx + dy * dy <= 5:
                        canvas.put(cx + dx, cy + dy, ring)
            canvas.put(cx - 1, cy - 1, (230, 250, 255))


# --- the fish ----------------------------------------------------------------
def _fish(canvas, look, rng, fill):
    body, belly, fin = _rgb(look["body"]), _rgb(look["belly"]), _rgb(look["fin"])
    accent = _rgb(look.get("accent", look["fin"]))
    a = look.get("length", 32) / 2 * fill
    b = look.get("height", 15) / 2 * fill
    cx, cy = 30, 31
    tail_len = look.get("tail", 9) * fill
    pattern = look.get("pattern", "plain")

    shape = {}  # (x, y) -> colour, everything that is fish

    def half_height(x):
        """How far the body reaches above (and below) the midline at column x."""
        dx = (x - cx) / a
        if abs(dx) >= 1:
            return 0.0
        height = b * (1 - 0.42 * max(0.0, dx)) * (1 - dx * dx) ** 0.5  # narrower to the tail
        if look.get("snout") and dx < -0.5:
            height *= 1 - 0.45 * (-dx - 0.5) / 0.5                     # the sturgeon's nose
        return height

    def in_body(x, y):
        # The half pixel keeps the midline from running on as a 1px spike to the tip.
        return abs(y - cy) + 0.5 <= half_height(x)

    left, right = int(cx - a) - 1, int(cx + a + tail_len) + 2
    top, bottom = int(cy - b) - 8, int(cy + b) + 6

    # Tail first, so the body covers its root.
    root = cx + a * 0.78
    for x in range(int(root), int(root + tail_len) + 1):
        t = (x - root) / max(tail_len, 1)
        spread = b * (0.25 + 0.85 * t) * (1.35 if look.get("fancy") else 1)
        for y in range(int(cy - spread) - 1, int(cy + spread) + 2):
            dy = abs(y - cy)
            if dy > spread:
                continue
            if look.get("fork", True) and t > 0.55 and dy < max(1.5, spread * (t - 0.4) * 1.3):
                continue  # the notch of a forked tail, at least 3px so no outline fills it
            if look.get("fancy") and t > 0.4 and (x + y) % 5 == 0:
                shape[(x, y)] = _light(fin, 0.25)  # veil streaks
                continue
            shape[(x, y)] = fin if t > 0.15 else _shade(body, 0.1)

    # Dorsal fin: a triangle on the back, further back on the pike.
    start = cx + a * look.get("dorsal", -0.15)
    length = a * look.get("dorsal_len", 0.55)
    fin_height = b * look.get("dorsal_h", 0.75)
    for x in range(int(start), int(start + length) + 1):
        t = (x - start) / max(length, 1)
        peak = fin_height * (1 - abs(t - 0.35) / 0.65)
        back = cy - half_height(x)
        for step in range(int(peak) + 1):
            spike = look.get("spiky") and (x % 3 == 0) and step == int(peak)
            shape[(x, int(back) - step)] = _shade(fin, 0.2) if spike else fin

    # Belly fin.
    for x in range(int(cx - a * 0.15), int(cx + a * 0.15) + 1):
        under = cy + b * 0.9
        for step in range(int(b * 0.45 * (1 - abs(x - cx) / (a * 0.15 + 1))) + 1):
            shape[(x, int(under) + step)] = fin

    # The body, shaded top to bottom, with its pattern.
    spots = {(rng.randint(left, right), rng.randint(top, bottom)) for _ in range(40)}
    stripe_phase = rng.randint(0, 4)
    for y in range(top, bottom + 1):
        for x in range(left, right + 1):
            if not in_body(x, y):
                continue
            dy = (y - cy) / b
            colour = (_shade(body, 0.18) if dy < -0.55 else
                      body if dy < 0.35 else
                      _mix(body, belly, min(1.0, (dy - 0.35) / 0.4)))
            if dy < -0.35 and dy > -0.6 and (x + y) % 2 == 0:
                colour = _light(colour, 0.12)               # sheen on the back
            if pattern in ("scales", "glitch") and dy < 0.4 and (x + 2 * y) % 4 == 0:
                colour = _light(colour, 0.18)
            if pattern == "stripes" and dy < 0.45 and (x + stripe_phase) % 6 in (0, 1):
                colour = _shade(colour, 0.38)
            if pattern in ("spots", "lateral") and dy < 0.5 and (x, y) in spots:
                colour = _shade(colour, 0.45) if pattern == "spots" else _shade(accent, 0.25)
            if pattern == "lateral" and abs(dy) < 0.22:
                colour = _mix(colour, accent, 0.75)
            if pattern == "scutes" and -0.78 < dy < -0.5 and x % 4 == 0:
                colour = _light(body, 0.5)
            if pattern == "glow" and abs(dy) < 0.18:
                colour = _light(accent, 0.3)
            shape[(x, y)] = colour

    # Gill line and eye.
    gill = cx - a * 0.42
    for y in range(int(cy - b * 0.55), int(cy + b * 0.6) + 1):
        x = int(gill + abs(y - cy) * 0.35)
        if (x, y) in shape:
            shape[(x, y)] = _shade(shape[(x, y)], 0.3)
    ex, ey = int(cx - a * 0.66), int(cy - b * 0.28)
    for x, y in ((ex, ey), (ex + 1, ey), (ex, ey + 1), (ex + 1, ey + 1)):
        shape[(x, y)] = (245, 245, 240)
    shape[(ex, ey + 1)] = (12, 12, 16)

    # Paint, then outline everything that borders open water.
    for (x, y), colour in shape.items():
        canvas.put(x, y, colour)
    outline = _shade(body, OUTLINE_SHADE + 0.2)
    for (x, y) in list(shape):
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if (nx, ny) not in shape:
                canvas.put(nx, ny, outline)
    if look.get("whiskers"):
        # Thin barbels trailing from the mouth, drawn over the outline.
        mx, my = int(cx - a), int(cy + b * 0.15)
        for step in range(1, 8):
            canvas.put(mx - step, my + step // 2, _light(body, 0.55))
            canvas.put(mx - step + 2, my + 2 + step // 2 + step // 3, _light(body, 0.55))

    if pattern == "glitch":
        _glitch(canvas, rng, top, bottom, left, right)
    mouth = (int(cx - a) - 1, int(cy + b * 0.1))
    return mouth


def _glitch(canvas, rng, top, bottom, left, right):
    """Rows of the fish slip sideways and split into magenta and cyan."""
    for y in rng.sample(range(max(0, top), min(SIZE, bottom)), 5):
        shift = rng.choice((-3, -2, 2, 3))
        row = canvas.px[y][:]
        for x in range(max(0, left - 4), min(SIZE, right + 4)):
            canvas.put(x, y, row[(x - shift) % SIZE])
    for y in range(max(0, top), min(SIZE, bottom)):
        if rng.random() < 0.25:
            canvas.put(max(0, left - 2), y, (255, 79, 216))
            canvas.put(min(SIZE - 1, right + 2), y, (22, 224, 208))


# --- the frame ---------------------------------------------------------------
def _frame(canvas, colour, stars):
    dark = _shade(colour, 0.55)
    for i in range(SIZE):
        for d in range(EDGE):
            tone = colour if d < EDGE - 1 else dark
            canvas.put(i, d, tone)
            canvas.put(i, SIZE - 1 - d, tone)
            canvas.put(d, i, tone)
            canvas.put(SIZE - 1 - d, i, tone)
    # Rarity as stars on the seabed, one per step, left to right.
    for index in range(stars):
        sx, sy = 6 + index * 6, SIZE - 7
        for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)):
            canvas.put(sx + dx, sy + dy, colour)
        canvas.put(sx, sy, _light(colour, 0.6))
    if stars >= 5:
        for cx, cy in ((7, 7), (SIZE - 8, 7), (SIZE - 8, SIZE - 14)):
            for d in (-2, -1, 1, 2):
                canvas.put(cx + d, cy, _light(colour, 0.4))
                canvas.put(cx, cy + d, _light(colour, 0.4))
            canvas.put(cx, cy, (255, 255, 255))


def render(look, rarity_colour, stars, seed, fill=1.0):
    """PNG bytes of one fish. `fill` (0.85–1.0) is how big it came out for its
    species; the same arguments always return the same bytes."""
    rng = random.Random(seed)
    canvas = Canvas()
    tint = _rgb(rarity_colour)
    _water(canvas, tint, rng)
    mouth = _fish(canvas, look, rng, fill)
    _bubbles(canvas, rng, mouth)
    _frame(canvas, tint, stars)
    return canvas.png()
