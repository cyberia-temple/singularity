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
import colorsys
import math
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


def _bubbles(canvas, rng, mouth, top=6, bottom=24):
    """A trail from the mouth and a few strays."""
    mx, my = mouth
    trail = [(mx - 2, my - 4, 1), (mx - 1, my - 9, 1), (mx - 3, my - 14, 2)]
    trail = [(x, y, r) for x, y, r in trail if y > top]
    strays = [(rng.randint(8, 56), rng.randint(top, bottom), rng.randint(1, 2)) for _ in range(3)]
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
def _fish(canvas, look, rng, fill, centre=(30, 31)):
    body, belly, fin = _rgb(look["body"]), _rgb(look["belly"]), _rgb(look["fin"])
    accent = _rgb(look.get("accent", look["fin"]))
    a = look.get("length", 32) / 2 * fill
    b = look.get("height", 15) / 2 * fill
    cx, cy = centre
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


# =============================================================================
# Places: the spot above the water, its sky at the hour, and what lies below.
#
# A place picture is three bands: sky with the shore against it (rows 0–19),
# the water line, and the water down to the bottom. The hour sets the sky, the
# sun or the moon and stars, how much light reaches the water and whether the
# windows are lit. A catch is drawn into the place it was caught at the hour it
# was caught, so the NFT shows a night catfish at night.
# =============================================================================
HORIZON = 19
SURFACE = 20
BED = 56

SKIES = {
    "dawn": ((52, 60, 120), (245, 170, 120)),
    "day": ((84, 150, 225), (196, 228, 250)),
    "dusk": ((60, 36, 96), (236, 112, 76)),
    "night": ((6, 8, 26), (24, 30, 66)),
}
NEON_SKIES = {
    "dawn": ((70, 30, 90), (255, 120, 170)),
    "day": ((110, 60, 170), (255, 160, 215)),
    "dusk": ((40, 10, 60), (255, 80, 140)),
    "night": ((10, 0, 25), (50, 10, 70)),
}
WATERS = {
    "pond": ((60, 104, 74), (14, 30, 20)),
    "river": ((40, 112, 142), (8, 30, 46)),
    "lake": ((26, 74, 86), (4, 18, 26)),
    "sea": ((22, 84, 156), (2, 14, 44)),
    "wired": ((70, 34, 120), (8, 4, 30)),
}
LIGHT = {"dawn": 0.8, "day": 1.0, "dusk": 0.72, "night": 0.42}
SHADOW = {"dawn": 0.45, "day": 0.0, "dusk": 0.55, "night": 0.85}
NIGHT_TINT = {"dawn": 0.12, "day": 0.0, "dusk": 0.15, "night": 0.3}
WINDOW = (255, 210, 110)
PINK, CYAN = (255, 79, 216), (22, 224, 208)


def _scaled(colour, factor):
    return tuple(max(0, min(255, round(c * factor))) for c in colour)


def _blend(canvas, x, y, colour, t):
    if 0 <= x < SIZE and 0 <= y < SIZE:
        canvas.put(x, y, _mix(canvas.get(x, y), colour, t))


def _sil(colour, sky, phase):
    """Something on the shore: its own colour by day, a shadow against the sky
    the darker it gets."""
    return _mix(colour, _shade(sky, 0.7), SHADOW[phase])


def _disc(canvas, cx, cy, r, colour):
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            if dx * dx + dy * dy <= r * r + r:
                canvas.put(cx + dx, cy + dy, colour)


def _sky(canvas, spot, phase):
    top, low = (NEON_SKIES if spot == "wired" else SKIES)[phase]
    rows = [_mix(top, low, y / (SURFACE - 1)) for y in range(SURFACE)]
    for y, colour in enumerate(rows):
        for x in range(SIZE):
            canvas.put(x, y, colour)
    if phase == "night":
        stars = random.Random(f"stars:{spot}")
        for _ in range(28):
            x, y = stars.randint(0, SIZE - 1), stars.randint(0, HORIZON - 6)
            canvas.put(x, y, (225, 230, 255) if stars.random() < 0.3 else (130, 140, 190))
        moon = (255, 206, 240) if spot == "wired" else (238, 236, 214)
        _disc(canvas, 47, 7, 3, moon)
        for dy in range(-3, 4):          # the bite that makes it a crescent
            for dx in range(-3, 4):
                if dx * dx + dy * dy <= 10:
                    x, y = 49 + dx, 6 + dy
                    if 0 <= y < SURFACE and (x - 47) ** 2 + (y - 7) ** 2 <= 12:
                        canvas.put(x, y, rows[y])
        sun = (47, 7)
    else:
        sun, colour = {"day": ((48, 6), (255, 232, 120)), "dawn": ((12, 14), (255, 182, 92)),
                       "dusk": ((52, 14), (255, 118, 70))}[phase]
        for dy in range(-6, 7):
            for dx in range(-6, 7):
                d = dx * dx + dy * dy
                if d <= 16:
                    canvas.put(sun[0] + dx, sun[1] + dy, colour)
                elif d <= 36:
                    _blend(canvas, sun[0] + dx, sun[1] + dy, colour, 0.3)
    return low, sun[0]


def _pond_shore(canvas, phase, low, rng):
    grass = _sil((86, 140, 64), low, phase)
    for y in range(16, SURFACE):
        for x in range(SIZE):
            canvas.put(x, y, grass if (x + y) % 5 else _shade(grass, 0.12))
    lit = phase != "day"
    for x0, w, h, roof in ((5, 11, 7, (150, 60, 46)), (42, 9, 6, (118, 72, 50))):
        wall, top = _sil((214, 196, 160), low, phase), _sil(roof, low, phase)
        base = 17
        for y in range(base - h, base):
            for x in range(x0, x0 + w):
                canvas.put(x, y, wall)
        for i in range(w // 2 + 2):
            for x in range(x0 - 1 + i, x0 + w + 1 - i):
                canvas.put(x, base - h - 1 - i, top)
        glass = WINDOW if lit else _sil((120, 160, 200), low, phase)
        for wx in (x0 + 2, x0 + w - 4):
            for dx in (0, 1):
                for dy in (0, 1):
                    canvas.put(wx + dx, base - h + 2 + dy, glass)
        for y in range(base - 3, base):
            canvas.put(x0 + w // 2, y, _shade(wall, 0.5))
    trunk, crown = _sil((96, 64, 40), low, phase), _sil((62, 122, 52), low, phase)
    for y in range(9, 17):
        canvas.put(27, y, trunk)
        canvas.put(28, y, trunk)
    _disc(canvas, 27, 7, 5, crown)
    _disc(canvas, 31, 9, 3, crown)
    wood = _sil((176, 150, 110), low, phase)
    for x in range(18, 39):
        canvas.put(x, 14, wood)
        if x % 3 == 0:
            for y in range(13, 17):
                canvas.put(x, y, wood)


def _river_shore(canvas, phase, low, rng):
    far, near = _sil((120, 160, 150), low, phase), _sil((72, 140, 72), low, phase)
    for x in range(SIZE):
        for y in range(int(10 + 3 * math.sin(x / 7.0 + 1)), SURFACE):
            canvas.put(x, y, far)
        for y in range(int(14 + 3 * math.sin(x / 9.0 + 4)), SURFACE):
            canvas.put(x, y, near)
    wood = _sil((126, 88, 56), low, phase)
    for x in range(28, SIZE):
        arch = 12 + int(3 * ((x - 46) / 18.0) ** 2)
        canvas.put(x, arch, wood)
        canvas.put(x, arch - 1, _light(wood, 0.15))
        if x % 4 == 0:
            canvas.put(x, arch - 2, wood)
            canvas.put(x, arch - 3, wood)
    for post in (31, 46, 61):
        for y in range(12 + int(3 * ((post - 46) / 18.0) ** 2), SURFACE + 3):
            canvas.put(post, y, _shade(wood, 0.2))


def _lake_shore(canvas, phase, low, rng):
    trees = random.Random("pines")
    ground = _sil((30, 56, 40), low, phase)
    for y in range(17, SURFACE):
        for x in range(SIZE):
            canvas.put(x, y, ground)
    for cx in range(-2, SIZE + 4, 5):
        height = trees.randint(8, 15)
        tone = _sil((32, 78, 50) if trees.random() < 0.5 else (24, 64, 42), low, phase)
        for step in range(height):
            y = SURFACE - 2 - height + step
            half = step // 2
            for x in range(cx - half, cx + half + 1):
                canvas.put(x, y, tone)
    if phase in ("dawn", "dusk"):
        for y in range(14, SURFACE + 2):
            for x in range(SIZE):
                if (x // 6 + y) % 3:
                    _blend(canvas, x, y, (236, 232, 240), 0.22)
    if phase in ("dusk", "night"):
        flies = random.Random("fireflies")
        for _ in range(8):
            canvas.put(flies.randint(2, SIZE - 3), flies.randint(9, HORIZON), (244, 236, 120))


def _sea_shore(canvas, phase, low, rng):
    far = _sil(_mix(WATERS["sea"][0], low, 0.4), low, phase)
    for y in range(15, SURFACE):
        for x in range(SIZE):
            canvas.put(x, y, far if (x * 3 + y) % 11 else _light(far, 0.12))
    white, red = _sil((240, 240, 236), low, phase), _sil((206, 52, 46), low, phase)
    for y in range(4, 16):
        for x in range(51, 56):
            canvas.put(x, y, red if (y // 2) % 2 else white)
    lamp = WINDOW if phase != "day" else _sil((250, 236, 170), low, phase)
    for y in range(1, 4):
        for x in range(50, 57):
            canvas.put(x, y, lamp if 51 <= x <= 55 and y > 1 else _sil((60, 60, 66), low, phase))
    if phase in ("dusk", "night"):
        for x in range(26, 50):
            spread = (50 - x) // 8
            for y in range(2 - spread, 3 + spread):
                _blend(canvas, x, y, WINDOW, 0.28)
    wood = _sil((110, 80, 54), low, phase)
    for x in range(0, 24):
        canvas.put(x, 15, wood)
        canvas.put(x, 16, _shade(wood, 0.2))
    for post in (2, 8, 14, 20):
        for y in range(15, SURFACE + 6):
            canvas.put(post, y, _shade(wood, 0.3))
    if phase == "day":
        for gx, gy in ((22, 6), (29, 9)):
            for dx in (-2, -1, 1, 2):
                canvas.put(gx + dx, gy - (1 if abs(dx) == 2 else 0), (70, 74, 84))


def _wired_shore(canvas, phase, low, rng):
    city = random.Random("city")
    body = _scaled((34, 14, 54), 0.6 if phase == "night" else 1.0)
    glow = 1.0 if phase in ("night", "dusk") else 0.45
    tallest = []
    x = 0
    while x < SIZE:
        width, height = city.randint(4, 8), city.randint(6, 17)
        tallest.append((height, x + width // 2))
        for y in range(SURFACE - height, SURFACE):
            for dx in range(width):
                canvas.put(x + dx, y, body)
        for y in range(SURFACE - height + 1, SURFACE - 1, 2):
            for dx in range(1, width - 1, 2):
                if city.random() < 0.55:
                    canvas.put(x + dx, y, _mix(body, PINK if city.random() < 0.5 else CYAN, glow))
        x += width
    for height, ax in sorted(tallest)[-2:]:
        for y in range(SURFACE - height - 4, SURFACE - height):
            canvas.put(ax, y, body)
        canvas.put(ax, SURFACE - height - 5, (255, 60, 60))
    for x in range(SIZE):
        canvas.put(x, 5 + int(((x - 32) / 32.0) ** 2 * 3), _shade(body, 0.3))
    for y in (city.randint(2, 8), city.randint(10, 15)):
        row = canvas.px[y][:]
        for x in range(SIZE):
            canvas.put(x, y, _mix(row[(x - 2) % SIZE], PINK, 0.25))


SHORES = {"pond": _pond_shore, "river": _river_shore, "lake": _lake_shore,
          "sea": _sea_shore, "wired": _wired_shore}


def _water_line(canvas, spot, phase, low, sun_x, rng):
    top = _scaled(WATERS[spot][0], LIGHT[phase])
    for x in range(SIZE):
        canvas.put(x, SURFACE, _mix(low, top, 0.35))
        canvas.put(x, SURFACE + 1, _mix(low, top, 0.7))
    for _ in range(9):
        x = rng.randint(0, SIZE - 3)
        canvas.put(x, SURFACE, _light(low, 0.35))
        canvas.put(x + 1, SURFACE, _light(low, 0.35))
    for dx in range(-2, 3):           # the sun or the moon on the water
        _blend(canvas, sun_x + dx, SURFACE, (255, 244, 210), 0.5)
        _blend(canvas, sun_x + dx // 2, SURFACE + 1, (255, 244, 210), 0.3)


def _depths(canvas, spot, phase, rng):
    top, bottom = (_scaled(colour, LIGHT[phase]) for colour in WATERS[spot])
    span = SIZE - SURFACE - 3
    for y in range(SURFACE + 2, SIZE):
        colour = _mix(top, bottom, (y - SURFACE - 2) / span)
        for x in range(SIZE):
            canvas.put(x, y, colour)
    if phase != "night":
        strength = 0.08 if phase == "day" else 0.04
        for offset in (rng.randint(4, 16), rng.randint(30, 44)):
            for y in range(SURFACE + 2, SURFACE + 30):
                for width in range(3):
                    x = offset + width + (y - SURFACE) // 3
                    if 0 <= x < SIZE:
                        canvas.put(x, y, _light(canvas.get(x, y), strength * (1 - (y - SURFACE) / 30)))


BEDS = {
    "pond": ((70, 54, 34), (42, 32, 22)),
    "river": ((104, 96, 80), (62, 58, 50)),
    "lake": ((42, 38, 30), (22, 20, 16)),
    "sea": ((178, 154, 106), (128, 108, 72)),
    "wired": ((12, 58, 42), (6, 30, 22)),
}


def _bottom(canvas, spot, phase, rng):
    light, dark = (_scaled(colour, 0.55 + 0.45 * LIGHT[phase]) for colour in BEDS[spot])
    for y in range(BED, SIZE):
        for x in range(SIZE):
            ripple = (x + y * 3 + rng.randint(0, 2)) % 7 == 0
            canvas.put(x, y, dark if ripple else _mix(light, dark, (y - BED) / (SIZE - BED)))
    lit = 0.5 + 0.5 * LIGHT[phase]
    if spot == "river":
        for _ in range(14):
            x, y = rng.randint(4, SIZE - 6), rng.randint(BED, SIZE - 5)
            stone = _scaled((150, 148, 138) if rng.random() < 0.5 else (118, 116, 108), lit)
            for dx in range(rng.randint(2, 3)):
                canvas.put(x + dx, y, stone)
            canvas.put(x, y - 1, _light(stone, 0.2))
    elif spot == "sea":
        star = _scaled((236, 120, 56), lit)
        for dx, dy in ((0, 0), (1, 0), (-1, 0), (0, -1), (2, 1), (-2, 1), (1, 2), (-1, 2)):
            canvas.put(14 + dx, BED + 2 + dy, star)
        shell = _scaled((236, 220, 200), lit)
        for dx in range(-2, 3):
            canvas.put(50 + dx, BED + 2, shell)
            if abs(dx) < 2:
                canvas.put(50 + dx, BED + 1, shell)
    elif spot == "wired":
        trace, pad = _scaled((40, 170, 100), lit), _scaled((214, 176, 64), lit)
        for y in (BED + 1, BED + 4):
            for x in range(SIZE):
                if (x // 7 + y) % 3:
                    canvas.put(x, y, trace)
        for x in range(5, SIZE, 9):
            canvas.put(x, BED + 1, pad)
            canvas.put(x + 3, BED + 4, pad)


def _growth(canvas, spot, phase, rng):
    """Weed, reeds, kelp and, in the Wired, the signal itself."""
    lit = 0.45 + 0.55 * LIGHT[phase]
    if spot in ("pond", "river", "lake", "sea"):
        green = {"pond": (52, 120, 60), "river": (40, 112, 70), "lake": (28, 86, 52), "sea": (96, 98, 40)}[spot]
        for root in (rng.randint(5, 14), rng.randint(48, 58)):
            height = rng.randint(10, 22)
            for step in range(height):
                x = root + (1 if (step // 3) % 2 else 0)
                canvas.put(x, BED - step, _scaled(green if step % 4 else _light(green, 0.2), lit))
    if spot == "pond":
        reed, head = _scaled((70, 110, 50), lit + 0.1), _scaled((110, 72, 44), lit + 0.1)
        for x in (2, 4, 5, 58, 60, 61):
            top = 11 + (x % 3)
            for y in range(top, SURFACE + 6):
                canvas.put(x, y, reed)
            canvas.put(x, top - 1, head)
            canvas.put(x, top - 2, head)
        pad = _scaled((64, 140, 64), lit + 0.15)
        for cx in (18, 45):
            for dx in range(-3, 4):
                canvas.put(cx + dx, SURFACE, pad)
            for dx in range(-2, 3):
                canvas.put(cx + dx, SURFACE - 1, pad)
        canvas.put(45, SURFACE - 2, (246, 170, 200))
    elif spot == "river":
        for _ in range(7):
            x, y = rng.randint(2, SIZE - 10), rng.randint(SURFACE + 4, BED - 10)
            for dx in range(rng.randint(4, 8)):
                _blend(canvas, x + dx, y, (220, 240, 250), 0.18)
    elif spot == "wired":
        for x in range(rng.randint(2, 6), SIZE, 9):
            for y in range(SURFACE + 3 + x % 3, BED, 3):
                _blend(canvas, x, y, CYAN if (x + y) % 2 else PINK, 0.35)


def _place(spot, phase, seed=0):
    rng = random.Random(f"{spot}:{phase}:{seed}")
    canvas = Canvas()
    low, sun_x = _sky(canvas, spot, phase)
    SHORES.get(spot, _pond_shore)(canvas, phase, low, rng)
    _depths(canvas, spot, phase, rng)
    _water_line(canvas, spot, phase, low, sun_x, rng)
    _bottom(canvas, spot, phase, rng)
    _growth(canvas, spot, phase, rng)
    return canvas


# --- things that are not fish ----------------------------------------------------
def _paint(canvas, shape, outline):
    for (x, y), colour in shape.items():
        canvas.put(x, y, colour)
    for (x, y) in list(shape):
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if (nx, ny) not in shape:
                canvas.put(nx, ny, outline)


def _box(shape, x0, y0, x1, y1, colour):
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            shape[(x, y)] = colour


def _oval(shape, cx, cy, rx, ry, colour):
    for y in range(int(cy - ry) - 1, int(cy + ry) + 2):
        for x in range(int(cx - rx) - 1, int(cx + rx) + 2):
            if ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0:
                shape[(x, y)] = colour(x, y) if callable(colour) else colour


def _round(shape, cx, cy, r, colour):
    """A disc whose colour may depend on distance and angle from the centre."""
    for y in range(cy - r - 1, cy + r + 2):
        for x in range(cx - r - 1, cx + r + 2):
            d = math.hypot(x - cx, y - cy)
            if d <= r + 0.3:
                shape[(x, y)] = colour(d, math.atan2(y - cy, x - cx), x, y) if callable(colour) else colour


def _item_boot(canvas, rng):
    leather, dark, sole, lace = (104, 68, 42), (78, 50, 32), (44, 32, 24), (214, 200, 170)
    s = {}
    _box(s, 25, 24, 34, 44, leather)
    _oval(s, 34, 46, 12, 5, leather)
    for y in range(24, 46):
        s[(25, y)] = dark
        s[(26, y)] = dark
    _box(s, 21, 49, 47, 51, sole)
    _box(s, 24, 23, 35, 24, dark)
    for y in range(27, 42, 3):
        s[(33, y)] = lace
        s[(34, y)] = lace
        s[(32, y + 1)] = lace
    _box(s, 28, 35, 30, 37, (132, 90, 58))
    for x in range(36, 46, 2):
        s[(x, 43)] = _light(leather, 0.18)
    _paint(canvas, s, _shade(leather, 0.65))


def _item_can(canvas, rng, metal=(176, 178, 184), label=(178, 58, 48), band=(236, 226, 206), rusty=True):
    s = {}
    for y in range(27, 52):
        for x in range(23, 42):
            t = (x - 23) / 18
            base = label if 33 <= y <= 44 else metal
            if 37 <= y <= 39:
                base = band
            colour = _light(base, 0.25) if 0.18 < t < 0.34 else (_shade(base, 0.3) if t > 0.8 else base)
            if y in (28, 50) and x % 2:
                colour = _shade(colour, 0.25)
            s[(x, y)] = colour
    _oval(s, 32.5, 26.5, 9.5, 1.6, _light(metal, 0.2))
    if rusty:
        for _ in range(14):
            s[(rng.randint(23, 41), rng.randint(27, 51))] = (150, 84, 40)
    _paint(canvas, s, _shade(metal, 0.6))
    return s


def _item_energy(canvas, rng):
    s = _item_can(canvas, rng, metal=(40, 44, 70), label=(30, 30, 46), band=(30, 30, 46), rusty=False)
    bolt = [(34, 30), (33, 31), (32, 32), (31, 33), (30, 34), (29, 35), (30, 35), (31, 35), (32, 35),
            (33, 35), (32, 36), (31, 37), (30, 38), (29, 39), (28, 40), (27, 41)]
    for x, y in bolt:
        canvas.put(x, y, (255, 228, 60))
        canvas.put(x + 1, y, (255, 246, 160))
    for x in range(24, 41):
        canvas.put(x, 46, CYAN)
    return s


def _item_floppy(canvas, rng):
    blue, dark, metal, label, ink = (40, 72, 168), (24, 42, 110), (178, 182, 194), (236, 236, 228), (90, 110, 170)
    s = {}
    _box(s, 20, 27, 44, 51, blue)
    for point in ((44, 27), (44, 28), (43, 27)):
        s.pop(point, None)
    _box(s, 26, 27, 38, 35, metal)
    _box(s, 33, 28, 35, 33, dark)
    for y in range(27, 36):
        s[(26, y)] = _light(metal, 0.3)
    _box(s, 23, 39, 41, 50, label)
    for y in (42, 45, 48):
        _box(s, 25, y, 39, y, ink)
    s[(21, 49)] = dark
    s[(21, 50)] = dark
    _paint(canvas, s, (16, 24, 60))


def _curve(points, steps=12):
    """Catmull–Rom through the points: a cable that bends instead of kinking."""
    out = []
    padded = [points[0]] + points + [points[-1]]
    for i in range(1, len(padded) - 2):
        p0, p1, p2, p3 = padded[i - 1:i + 3]
        for step in range(steps):
            t = step / steps
            out.append(tuple(0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t
                                    + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t * t
                                    + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t ** 3) for k in (0, 1)))
    return out + [points[-1]]


def _item_cable(canvas, rng):
    wire, shine = (232, 200, 64), (252, 234, 150)
    s = {}
    for x, y in _curve([(15, 46), (20, 32), (28, 47), (35, 30), (43, 46), (48, 34)]):
        for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            s[(int(x) + dx, int(y) + dy)] = wire
        s[(int(x), int(y))] = shine
    plug, pin = (204, 226, 234), (220, 176, 60)
    for x0, y0 in ((11, 45), (47, 29)):
        _box(s, x0, y0, x0 + 5, y0 + 5, plug)
        for x in range(x0 + 1, x0 + 5):
            s[(x, y0 + 1)] = pin
    _paint(canvas, s, (110, 86, 24))


def _item_phone(canvas, rng):
    body, screen, key = (62, 64, 74), (128, 176, 116), (170, 172, 180)
    s = {}
    _box(s, 26, 25, 38, 52, body)
    for point in ((26, 25), (38, 25), (26, 52), (38, 52)):
        s.pop(point)
    _box(s, 35, 21, 36, 24, body)
    _box(s, 28, 28, 36, 35, screen)
    _box(s, 28, 30, 36, 30, _light(screen, 0.2))
    for row in range(4):
        for col in range(3):
            x, y = 28 + col * 3, 39 + row * 3
            s[(x, y)] = key
            s[(x + 1, y)] = key
    _box(s, 30, 26, 34, 26, (30, 30, 36))
    s[(27, 26)] = _light(body, 0.5)
    _paint(canvas, s, (24, 24, 30))


def _item_lifebuoy(canvas, rng):
    red, white = (222, 60, 52), (244, 240, 232)

    def colour(d, angle, x, y):
        if d < 6:
            return None
        base = red if int((angle + math.pi) / (math.pi / 4)) % 2 else white
        return _light(base, 0.25) if (y < 34 and x < 32) else (_shade(base, 0.2) if y > 45 else base)

    s = {}
    _round(s, 32, 39, 13, colour)
    s = {point: c for point, c in s.items() if c is not None}
    _paint(canvas, s, (110, 30, 30))


def _item_coin(canvas, rng):
    gold, rim, deep, shine = (232, 184, 64), (184, 134, 40), (150, 104, 30), (255, 238, 166)

    def colour(d, angle, x, y):
        if d > 9.3:
            return rim
        if 6 <= d <= 8 and -2.6 < angle < -1.4:
            return shine
        return gold

    s = {}
    _round(s, 32, 39, 11, colour)
    for point in [(x, y) for x in range(31, 34) for y in range(38, 41)]:
        s.pop(point)
    for x, y in ((32, 34), (32, 44), (27, 39), (37, 39)):
        _box(s, x - 1, y - 1, x, y, deep)
    _paint(canvas, s, (110, 76, 20))


def _item_bottle(canvas, rng):
    glass, paper, cork, tie = (70, 150, 96), (234, 218, 172), (150, 104, 60), (200, 60, 50)
    s = {}
    _oval(s, 26, 39.5, 11.5, 6.5, glass)
    _box(s, 36, 36, 40, 43, glass)
    _box(s, 40, 37, 47, 42, glass)
    _box(s, 47, 37, 50, 42, cork)
    _box(s, 19, 37, 33, 42, paper)
    for y in range(37, 43):
        s[(19, y)] = _shade(paper, 0.2)
        s[(33, y)] = _shade(paper, 0.2)
        s[(26, y)] = tie
    for x in range(17, 36):
        s[(x, 34)] = _light(glass, 0.35)
    for x in range(18, 34):
        s[(x, 45)] = _shade(glass, 0.3)
    _paint(canvas, s, (24, 64, 40))


def _item_ring(canvas, rng):
    gold, gem = (236, 190, 70), (80, 200, 255)
    s = {}
    for y in range(36, 52):
        for x in range(20, 45):
            v = ((x - 32) / 10) ** 2 + ((y - 44) / 6) ** 2
            if 0.55 <= v <= 1.0:
                s[(x, y)] = _shade(gold, 0.25) if y > 44 else gold
    _box(s, 29, 34, 35, 37, _shade(gold, 0.15))
    for dy in range(-4, 5):
        for dx in range(-4, 5):
            if abs(dx) + abs(dy) <= 4:
                s[(32 + dx, 30 + dy)] = _light(gem, 0.45) if dx + dy < -1 else gem
    _paint(canvas, s, (110, 80, 24))
    for x, y in ((39, 26), (40, 25), (41, 26), (40, 27)):
        canvas.put(x, y, (255, 255, 255))


def _item_compass(canvas, rng):
    brass, face, red, tick = (196, 154, 72), (238, 228, 198), (214, 52, 44), (96, 74, 42)
    s = {}
    _round(s, 32, 40, 12, lambda d, a, x, y: face if d < 9 else (_light(brass, 0.2) if y < 36 else brass))
    for k in range(8):
        angle = k * math.pi / 4
        s[(round(32 + 8 * math.cos(angle)), round(40 + 8 * math.sin(angle)))] = tick
    for step in range(1, 8):
        s[(32 + step * 2 // 3, 40 - step)] = red
        s[(33 + step * 2 // 3, 40 - step)] = red
        s[(32 - step * 2 // 3, 40 + step)] = (180, 180, 186)
        s[(31 - step * 2 // 3, 40 + step)] = (180, 180, 186)
    s[(32, 40)] = tick
    _round(s, 32, 26, 2, brass)
    s.pop((32, 26), None)
    _paint(canvas, s, (98, 70, 26))


def _item_pearl(canvas, rng):
    shell, ridge, inner = (178, 142, 152), (138, 104, 116), (238, 224, 242)
    s = {}
    for y in range(42, 52):                      # the lower valve, a bowl
        for x in range(16, 49):
            if ((x - 32) / 16) ** 2 + ((y - 42) / 9) ** 2 <= 1:
                s[(x, y)] = inner if y < 44 else (ridge if x % 4 == 0 else shell)
    for y in range(22, 32):                      # the upper valve, thrown open
        for x in range(18, 47):
            if ((x - 32) / 14) ** 2 + ((y - 32) / 9) ** 2 <= 1:
                s[(x, y)] = inner if y > 29 else (ridge if (x + y) % 4 == 0 else shell)
    _box(s, 16, 30, 18, 43, ridge)              # the hinge
    _round(s, 32, 38, 5, lambda d, a, x, y: (255, 222, 240) if (x < 31 and y < 37) else (248, 246, 252))
    _paint(canvas, s, (86, 60, 74))


def _item_chart(canvas, rng):
    parchment, sea, land, path = (228, 204, 152), (86, 140, 190), (150, 170, 110), (200, 50, 40)
    s = {}
    _box(s, 17, 27, 47, 50, parchment)
    for y in range(27, 51):
        coast = 25 + int(4 * math.sin(y * 0.45))
        for x in range(19, 46):
            if x < coast:
                s[(x, y)] = sea
            elif x < coast + 3 and (x + y) % 3:
                s[(x, y)] = land
    for x0 in (15, 47):
        _box(s, x0, 26, x0 + 2, 51, _shade(parchment, 0.18))
        for y in range(26, 52):
            s[(x0 + 1, y)] = _light(parchment, 0.15)
    for i, (x, y) in enumerate(_curve([(27, 47), (31, 41), (37, 40), (41, 33)], 8)):
        if i % 3 != 2:
            s[(int(x), int(y))] = path
    for d in range(-2, 3):
        s[(41 + d, 32 + d)] = path
        s[(41 + d, 32 - d)] = path
    for _ in range(18):
        s[(rng.randint(18, 46), rng.choice((27, 28, 49, 50)))] = _shade(parchment, 0.25)
    _paint(canvas, s, (120, 92, 52))


def _item_keycard(canvas, rng):
    card, chip = (214, 240, 246), (222, 180, 70)
    s = {}
    _box(s, 17, 30, 47, 49, card)
    for point in ((17, 30), (47, 30), (17, 49), (47, 49)):
        s.pop(point)
    _box(s, 18, 31, 46, 33, CYAN)
    _box(s, 21, 37, 27, 42, chip)
    _box(s, 21, 39, 27, 39, _shade(chip, 0.3))
    _box(s, 24, 37, 24, 42, _shade(chip, 0.3))
    for i, x in enumerate(range(31, 43)):
        s[(x, 38 + (i % 4 if i % 8 < 4 else 3 - i % 4))] = PINK
    for x in range(18, 47):
        s[(x, 48)] = _shade(card, 0.2)
    for point in ((43, 36), (44, 36), (43, 37), (44, 37)):
        s.pop(point)
    _paint(canvas, s, (60, 90, 104))


def _item_chip(canvas, rng):
    die, trace, pin, core = (34, 32, 44), (64, 60, 84), (214, 176, 64), PINK
    s = {}
    _box(s, 23, 30, 41, 48, die)
    for i in range(24, 41, 3):
        _box(s, 20, i, 22, i, pin)
        _box(s, 42, i, 44, i, pin)
        _box(s, i, 27, i, 29, pin)
        _box(s, i, 49, i, 51, pin)
    for x in range(24, 41):
        if x % 4 == 1:
            s[(x, 33)] = trace
            s[(x, 45)] = trace
    _box(s, 28, 35, 36, 43, core)
    _box(s, 31, 38, 33, 40, (255, 196, 240))
    _paint(canvas, s, (14, 12, 20))
    for dx, dy in ((-6, 0), (6, 0), (0, -6), (0, 6)):
        _blend(canvas, 32 + dx, 39 + dy, PINK, 0.4)


def _item_cd(canvas, rng):
    silver = (200, 205, 215)

    def colour(d, angle, x, y):
        if d < 2.2:
            return None
        if d < 4:
            return (222, 228, 238)
        if 6 <= d <= 10 and 2.2 < angle < 2.9:
            return _light(PINK, 0.2)
        if d > 5:
            hue = (angle / (2 * math.pi) + 0.5 + d / 40) % 1.0
            sheen = tuple(round(c * 255) for c in colorsys.hsv_to_rgb(hue, 0.45, 1.0))
            return _mix(silver, sheen, 0.35)
        return silver

    s = {}
    _round(s, 32, 39, 12, colour)
    s = {point: c for point, c in s.items() if c is not None}
    _paint(canvas, s, (90, 94, 110))


ITEM_ART = {
    "boot": _item_boot, "can": _item_can, "floppy": _item_floppy, "cable": _item_cable,
    "phone": _item_phone, "lifebuoy": _item_lifebuoy, "coin": _item_coin, "bottle": _item_bottle,
    "ring": _item_ring, "compass": _item_compass, "pearl": _item_pearl, "chart": _item_chart,
    "keycard": _item_keycard, "chip": _item_chip, "cd": _item_cd, "energy": _item_energy,
}


def render_place(spot, phase, accent="#a7b4c2"):
    """PNG bytes of a spot at an hour, with rings on the water where the line goes in."""
    canvas = _place(spot, phase)
    for dx in range(-5, 6):
        _blend(canvas, 32 + dx, SURFACE, (255, 255, 255), 0.55 if abs(dx) in (4, 5) else 0.0)
    for dx in (-2, -1, 1, 2):
        _blend(canvas, 32 + dx, SURFACE + 1, (255, 255, 255), 0.4)
    _frame(canvas, _rgb(accent), 0)
    return canvas.png()


def render_loot(spot, phase, key, rarity_colour, stars, seed, look=None, fill=1.0):
    """PNG bytes of a catch where and when it was caught: a fish from its look,
    anything else from its own drawing. The same arguments, the same bytes."""
    canvas = _place(spot, phase, seed)
    before = [row[:] for row in canvas.px]
    rng = random.Random(seed)
    if look:
        mouth = _fish(canvas, look, rng, fill * 0.9, centre=(31, 39))
        _bubbles(canvas, rng, mouth, top=SURFACE + 3, bottom=BED - 6)
    else:
        ITEM_ART.get(key, _item_can)(canvas, rng)
        _bubbles(canvas, rng, (36, 26), top=SURFACE + 3, bottom=BED - 6)
    tint = NIGHT_TINT[phase]
    if tint:
        for y in range(SIZE):
            for x in range(SIZE):
                if canvas.px[y][x] != before[y][x]:
                    canvas.put(x, y, _mix(canvas.px[y][x], (10, 16, 40), tint))
    _frame(canvas, _rgb(rarity_colour), stars)
    return canvas.png()
