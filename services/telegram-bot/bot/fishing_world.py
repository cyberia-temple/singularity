"""The fishing world: spots, what lives in them, tackle, bait, buckets and the clock.

Pure data and pure functions — no database, no Telegram — so the odds can be
read, tested and changed in one place. `bot.fishing` keeps the state and
`bot.fish_art` draws what is described here.

Everything that comes out of the water is loot, and all of it can become an
NFT: fish, junk and treasure alike, the way Minecraft fishing is half about the
enchanted book. Some of the junk matters more than any fish — the two keys open
the two high-level spots, and a key works for whoever holds it, so it is worth
selling on the market.

The world keeps its own time: a game day is CYCLE seconds, so everyone sees a
dawn and a night in one evening's play. Some fish bite at night, everything
bites better at dawn and dusk, and the pictures follow the sky.
"""
import secrets

RARITIES = {
    # "trash" survives only on rows from before junk had rarities.
    "trash":     {"label": "мусор",       "en": "trash",     "colour": "#7d8590", "stars": 0},
    "common":    {"label": "обычная",     "en": "common",    "colour": "#a7b4c2", "stars": 1},
    "uncommon":  {"label": "необычная",   "en": "uncommon",  "colour": "#5cc46a", "stars": 2},
    "rare":      {"label": "редкая",      "en": "rare",      "colour": "#3d8bff", "stars": 3},
    "epic":      {"label": "эпическая",   "en": "epic",      "colour": "#b45cff", "stars": 4},
    "legendary": {"label": "легендарная", "en": "legendary", "colour": "#ffc83d", "stars": 5},
}
RANK = {rarity: index for index, rarity in enumerate(RARITIES)}

KINDS = {
    "fish": {"ru": "рыба", "en": "fish", "trait": "Fish"},
    "junk": {"ru": "хлам", "en": "junk", "trait": "Junk"},
    "treasure": {"ru": "сокровище", "en": "treasure", "trait": "Treasure"},
    "key": {"ru": "ключ", "en": "key", "trait": "Key"},
    "energy": {"ru": "энергетик", "en": "energy drink", "trait": "Energy"},
}

# What the buyer on the shore pays, in shells, by rarity; a trophy fish pays
# double and treasure half as much again.
PRICE = {"trash": 1, "common": 2, "uncommon": 5, "rare": 12, "epic": 30, "legendary": 80}
KIND_PRICE = {"fish": 1.0, "junk": 1.0, "treasure": 1.5, "key": 1.0, "energy": 1.0}

# --- the clock -----------------------------------------------------------------
CYCLE = 2 * 3600
# (phase, where it ends as a share of the day). Night is long: night fishing.
PHASES = (("dawn", 0.10), ("day", 0.55), ("dusk", 0.65), ("night", 1.0))
PHASE_INFO = {
    "dawn": {"emoji": "🌅", "ru": "рассвет", "en": "dawn"},
    "day": {"emoji": "☀️", "ru": "день", "en": "day"},
    "dusk": {"emoji": "🌇", "ru": "закат", "en": "dusk"},
    "night": {"emoji": "🌙", "ru": "ночь", "en": "night"},
}
TWILIGHT_FISH = 1.5   # dawn and dusk: every fish bites better


def phase(now):
    share = (float(now) % CYCLE) / CYCLE
    return next(name for name, end in PHASES if share < end)


def phase_left(now):
    """Seconds until the sky turns to the next phase."""
    share = (float(now) % CYCLE) / CYCLE
    end = next(end for _name, end in PHASES if share < end)
    return max(1, round((end - share) * CYCLE))


# --- loot ----------------------------------------------------------------------
def _fish(ru, en, rarity, kg, look, **extra):
    return {"kind": "fish", "ru": ru, "en": en, "rarity": rarity, "kg": kg, "look": look, **extra}


def _thing(kind, emoji, ru, en, rarity, **extra):
    return {"kind": kind, "emoji": emoji, "ru": ru, "en": en, "rarity": rarity, **extra}


ITEMS = {
    # Fish. `night`/`day` multiply the odds in that phase.
    "roach": _fish("Плотва", "Roach", "common", (0.1, 0.6), {
        "body": "#b9c6cf", "belly": "#eef3f4", "fin": "#d9534f", "length": 30, "height": 14, "pattern": "scales"}),
    "perch": _fish("Окунь", "Perch", "common", (0.2, 1.5), {
        "body": "#8fae3a", "belly": "#e8dca2", "fin": "#f07b2a", "length": 30, "height": 16,
        "pattern": "stripes", "spiky": True, "dorsal_h": 0.95}),
    "crucian": _fish("Карась", "Crucian carp", "common", (0.2, 1.2), {
        "body": "#c9a24a", "belly": "#f0dea6", "fin": "#a8763a", "length": 28, "height": 19,
        "pattern": "scales", "fork": False}),
    "herring": _fish("Сельдь", "Herring", "common", (0.1, 0.5), {
        "body": "#7f97a8", "belly": "#e9eef2", "fin": "#9aa9b5", "length": 32, "height": 11, "pattern": "scales"}),
    "bream": _fish("Лещ", "Bream", "uncommon", (1.0, 4.5), {
        "body": "#a88a52", "belly": "#dccb9c", "fin": "#6b5a3a", "length": 30, "height": 23,
        "dorsal_len": 0.4, "dorsal_h": 0.5}),
    "zander": _fish("Судак", "Zander", "uncommon", (1.0, 7.0), {
        "body": "#8a9a8c", "belly": "#d8dfd4", "fin": "#7c8a7e", "length": 40, "height": 13,
        "pattern": "stripes", "spiky": True}, night=2.0),
    "pike": _fish("Щука", "Pike", "uncommon", (2.0, 10.0), {
        "body": "#5f8a4a", "belly": "#dae2b2", "fin": "#a0703a", "length": 46, "height": 11,
        "pattern": "spots", "dorsal": 0.35, "dorsal_len": 0.35, "dorsal_h": 0.9, "tail": 8}),
    "mackerel": _fish("Скумбрия", "Mackerel", "uncommon", (0.3, 1.6), {
        "body": "#2f7d74", "belly": "#e8efe9", "fin": "#3e6e66", "length": 34, "height": 12,
        "pattern": "stripes"}),
    "trout": _fish("Радужная форель", "Rainbow trout", "rare", (1.0, 6.0), {
        "body": "#7f9ea8", "belly": "#f2f2ec", "fin": "#9fb3b8", "accent": "#ff6f9a", "length": 36, "height": 14,
        "pattern": "lateral"}, night=0.3, day=1.5),
    "catfish": _fish("Сом", "Catfish", "rare", (5.0, 45.0), {
        "body": "#4a4f55", "belly": "#a9ab9f", "fin": "#3a3e44", "length": 48, "height": 14,
        "whiskers": True, "dorsal": -0.2, "dorsal_len": 0.2, "dorsal_h": 0.45, "fork": False, "tail": 7}, night=3.0),
    "flounder": _fish("Камбала", "Flounder", "rare", (0.5, 4.0), {
        "body": "#8a7356", "belly": "#cbb894", "fin": "#7a6448", "length": 30, "height": 22,
        "pattern": "spots", "dorsal": -0.6, "dorsal_len": 1.15, "dorsal_h": 0.28, "fork": False, "tail": 5}),
    "sturgeon": _fish("Осётр", "Sturgeon", "epic", (8.0, 60.0), {
        "body": "#5d7385", "belly": "#cbd4d8", "fin": "#4b5d6c", "length": 50, "height": 12,
        "pattern": "scutes", "snout": True, "dorsal": 0.4, "dorsal_len": 0.25, "dorsal_h": 0.6}),
    "neon_eel": _fish("Неоновый угорь", "Neon eel", "epic", (0.8, 3.0), {
        "body": "#13c9bb", "belly": "#ff4fd8", "fin": "#7a5cff", "accent": "#9ffcf2", "length": 52, "height": 10,
        "pattern": "glow", "dorsal": -0.4, "dorsal_len": 1.1, "dorsal_h": 0.35, "fork": False, "tail": 5}, night=2.0),
    "goldfish": _fish("Золотая рыбка", "Goldfish", "legendary", (0.1, 0.5), {
        "body": "#ffb21e", "belly": "#ffe08a", "fin": "#ff7a1a", "length": 26, "height": 17,
        "pattern": "scales", "fancy": True, "tail": 13, "dorsal_h": 0.9}),
    "wired_carp": _fish("Карп из Wired", "Wired carp", "legendary", (3.0, 15.0), {
        "body": "#e04fd0", "belly": "#16e0d0", "fin": "#f4f4ff", "length": 36, "height": 20,
        "pattern": "glitch"}),

    # Junk: worth little at the buyer's, and plenty to a collector.
    "boot": _thing("junk", "🥾", "Старый ботинок", "Old boot", "common"),
    "can": _thing("junk", "🥫", "Ржавая банка", "Rusty can", "common"),
    "floppy": _thing("junk", "💾", "Дискета 3,5″", "3.5″ floppy disk", "uncommon"),
    "cable": _thing("junk", "🔌", "Спутанный патч-корд", "Tangled patch cord", "uncommon"),
    "lifebuoy": _thing("junk", "🛟", "Спасательный круг", "Lifebuoy", "uncommon"),
    "phone": _thing("junk", "📱", "Утопленный телефон", "Drowned phone", "rare"),

    # Treasure.
    "coin": _thing("treasure", "🪙", "Старая монета", "Old coin", "uncommon"),
    "bottle": _thing("treasure", "🍾", "Бутылка с запиской", "Message in a bottle", "rare"),
    "ring": _thing("treasure", "💍", "Золотое кольцо", "Gold ring", "rare"),
    "compass": _thing("treasure", "🧭", "Латунный компас", "Brass compass", "epic"),
    "pearl": _thing("treasure", "🦪", "Жемчужина в раковине", "Pearl in its shell", "epic"),
    "chip": _thing("treasure", "🧠", "Нейрочип", "Neurochip", "legendary", night=1.5),
    "cd": _thing("treasure", "💿", "Диск Lain", "Lain's disc", "legendary"),

    # Keys: holding one — in the bucket or as an NFT in the linked wallet —
    # opens a spot. Bought on the market, it opens it for the buyer.
    "chart": _thing("key", "🗺", "Карта побережья", "Coastal chart", "epic", opens="sea"),
    "keycard": _thing("key", "🪪", "Ключ-карта Wired", "Wired keycard", "legendary", opens="wired"),

    # Not loot for the bucket: a full can goes straight into your pocket.
    "energy": _thing("energy", "⚡", "Энергетик", "Energy drink", "uncommon"),
}
SPECIES = {key: item for key, item in ITEMS.items() if item["kind"] == "fish"}

# Rods, weakest first: `holds` is the rarest loot it lands, `window` the
# seconds it gives to strike. Prices in shells.
GEAR = {
    "hands": {"emoji": "✋", "price": 0, "holds": "common", "window": 5.0,
              "ru": "голые руки", "en": "bare hands",
              "weak_ru": "Голыми руками такое не удержать", "weak_en": "Bare hands can't hold that"},
    "hazel": {"emoji": "🌿", "price": 10, "holds": "uncommon", "window": 7.0,
              "ru": "удочка из орешника", "ru_acc": "удочку из орешника", "en": "hazel rod",
              "weak_ru": "Удочка из орешника такое не выдержит", "weak_en": "A hazel rod won't hold that"},
    "bamboo": {"emoji": "🎋", "price": 60, "holds": "rare", "window": 7.0,
               "ru": "бамбуковая удочка", "ru_acc": "бамбуковую удочку", "en": "bamboo rod",
               "weak_ru": "Бамбуковая удочка такое не выдержит", "weak_en": "A bamboo rod won't hold that"},
    "carbon": {"emoji": "🎣", "price": 200, "holds": "epic", "window": 8.0,
               "ru": "карбоновый спиннинг", "ru_acc": "карбоновый спиннинг", "en": "carbon spinning rod",
               "weak_ru": "Карбоновый спиннинг такое не выдержит", "weak_en": "A carbon rod won't hold that"},
    "wired": {"emoji": "📡", "price": 500, "holds": "legendary", "window": 9.0,
              "ru": "спиннинг из Wired", "ru_acc": "спиннинг из Wired", "en": "Wired rod",
              "weak_ru": "", "weak_en": ""},
}
LADDER = list(GEAR)
STARTER = "hands"

# Where the catch waits until it is minted or sold. A full one stops the line.
BUCKETS = {
    "pail": {"emoji": "🪣", "ru": "ведро", "en": "pail", "size": 6, "price": 0},
    "keepnet": {"emoji": "🥅", "ru": "садок", "en": "keep net", "size": 12, "price": 25},
    "coolbox": {"emoji": "🧊", "ru": "термобокс", "en": "cool box", "size": 24, "price": 100},
    "hold": {"emoji": "⚓", "ru": "трюм", "en": "ship's hold", "size": 48, "price": 300},
}
BUCKET_LADDER = list(BUCKETS)
STARTER_BUCKET = "pail"

# Bait: one goes on the hook per cast with a rod. What a bait likes bites
# BAIT_LIKE times more often; a rod with an empty hook drags up junk.
BAITS = {
    "worm": {"emoji": "🪱", "ru": "червяк", "en": "worm", "pack": 10, "price": 5,
             "likes": {"roach", "perch", "crucian", "bream", "trout", "zander"}},
    "dough": {"emoji": "🍞", "ru": "тесто", "en": "dough", "pack": 10, "price": 5,
              "likes": {"crucian", "bream", "roach", "goldfish"}},
    "live": {"emoji": "🐟", "ru": "живец", "en": "live bait", "pack": 5, "price": 12,
             "likes": {"pike", "zander", "catfish", "perch", "sturgeon"}},
    "shrimp": {"emoji": "🦐", "ru": "креветка", "en": "shrimp", "pack": 5, "price": 15,
               "likes": {"herring", "mackerel", "flounder", "sturgeon"}},
    "magnet": {"emoji": "🧲", "ru": "магнит", "en": "magnet", "pack": 5, "price": 15,
               "kinds": {"junk", "treasure", "key"}},
    "glitch": {"emoji": "💾", "ru": "глитч-наживка", "en": "glitch bait", "pack": 3, "price": 30,
               "likes": {"neon_eel", "wired_carp", "chip", "cd"}},
}
BAIT_LIKE = 3.0
EMPTY_HOOK_JUNK = 3.0

# ⚡ Poured into the water, it wakes the fish for everyone in that chat: every
# angler resting there may cast again at once.
ENERGY = {"emoji": "⚡", "ru": "энергетик", "en": "energy drink", "price": 12}

SPOTS = {
    "pond": {
        "emoji": "🏡", "ru": "Деревенский пруд", "en": "Village pond", "colour": "#7fae5a",
        "rod": "hands", "key": None, "bait": None, "baits": ("dough", "worm", "magnet"),
        "about_ru": "Тихая вода за огородами. Сюда приходят с голыми руками — и, говорят, тут живёт золотая рыбка.",
        "about_en": "Still water behind the gardens. People come here with bare hands — and they say a goldfish lives here.",
        "loot": {"roach": 200, "crucian": 200, "perch": 150, "bream": 60, "goldfish": 3,
                 "boot": 120, "can": 120, "coin": 45, "bottle": 20},
    },
    "river": {
        "emoji": "🌊", "ru": "Быстрая река", "en": "Fast river", "colour": "#4aa3d8",
        "rod": "hazel", "key": None, "bait": None, "baits": ("worm", "live", "magnet"),
        "about_ru": "Течение под старым мостом. Хищник выходит ночью, форель — днём.",
        "about_en": "The current under the old bridge. Predators come out at night, trout by day.",
        "loot": {"roach": 140, "perch": 110, "bream": 100, "zander": 80, "pike": 80, "trout": 50,
                 "boot": 50, "floppy": 70, "cable": 50, "phone": 30, "coin": 40, "ring": 20, "bottle": 20,
                 "energy": 15},
    },
    "lake": {
        "emoji": "🌲", "ru": "Лесное озеро", "en": "Forest lake", "colour": "#3f8f6a",
        "rod": "bamboo", "key": None, "bait": None, "baits": ("live", "worm", "dough", "magnet"),
        "about_ru": "Чёрная вода среди сосен. Ночью из ям поднимается сом, а на дне лежит карта побережья.",
        "about_en": "Black water among the pines. At night the catfish rises from the pits, and the coastal chart lies on the bottom.",
        "loot": {"perch": 100, "crucian": 80, "bream": 80, "pike": 120, "catfish": 70, "trout": 40,
                 "can": 50, "phone": 40, "ring": 40, "compass": 20, "chart": 12, "energy": 15},
    },
    "sea": {
        "emoji": "⚓", "ru": "Морской пирс", "en": "Sea pier", "colour": "#2f6fd1",
        "rod": "carbon", "key": "chart", "bait": None, "baits": ("shrimp", "live", "magnet"),
        "about_ru": "Без карты побережья пирс не найти. Осётр, жемчуг — и ключ-карта, которую кто-то уронил с маяка.",
        "about_en": "Without the coastal chart you won't find the pier. Sturgeon, pearls — and a keycard someone dropped from the lighthouse.",
        "loot": {"herring": 180, "mackerel": 140, "flounder": 80, "sturgeon": 45,
                 "lifebuoy": 80, "can": 50, "cable": 40, "coin": 60, "pearl": 35, "compass": 35, "keycard": 8,
                 "energy": 15},
    },
    "wired": {
        "emoji": "📡", "ru": "Канал Wired", "en": "The Wired canal", "colour": "#e04fd0",
        "rod": "wired", "key": "keycard", "bait": "glitch", "baits": ("glitch",),
        "about_ru": "Вода, по которой течёт сигнал. Пускают с ключ-картой, ловят только на глитч-наживку.",
        "about_en": "Water the signal flows through. The keycard lets you in; only glitch bait gets a bite.",
        "loot": {"neon_eel": 130, "wired_carp": 35, "goldfish": 15, "cable": 120, "floppy": 120, "phone": 80,
                 "chip": 35, "cd": 25},
    },
}
SPOT_ORDER = list(SPOTS)
START_SPOT = "pond"


# --- reading the catalogue -------------------------------------------------------
def item(key):
    return ITEMS.get(key) or {"kind": "junk", "emoji": "❔", "ru": key, "en": key, "rarity": "trash"}


def kind_of(row):
    """A catch row's kind; rows from before kinds were all fish or trash."""
    if row.get("kind"):
        return row["kind"]
    return "junk" if row.get("rarity") == "trash" else item(row["species"])["kind"]


def holds(gear_key, rarity):
    return RANK[rarity] <= RANK[GEAR[gear_key]["holds"]]


def first_gear_for(rarity):
    return next(key for key in LADDER if holds(key, rarity))


def next_in(ladder, key):
    index = ladder.index(key)
    return ladder[index + 1] if index + 1 < len(ladder) else None


def price(row):
    """What the buyer pays for a catch, in shells."""
    kind = kind_of(row)
    base = PRICE[row["rarity"]] * KIND_PRICE.get(kind, 1.0)
    return max(1, round(base)) * (2 if row.get("trophy") else 1)


def weights(spot_key, when, bait=None, bare=False):
    """{item: weight} at this spot in this phase with this bait."""
    out = {}
    spot = SPOTS[spot_key]
    liked = BAITS[bait] if bait else None
    for key, weight in spot["loot"].items():
        thing = ITEMS[key]
        weight = float(weight)
        if when == "night":
            weight *= thing.get("night", 1.0)
        elif when == "day":
            weight *= thing.get("day", 1.0)
        elif thing["kind"] == "fish":
            weight *= TWILIGHT_FISH
        if liked and (key in liked.get("likes", ()) or thing["kind"] in liked.get("kinds", ())):
            weight *= BAIT_LIKE
        if not bare and not bait and thing["kind"] == "junk":
            weight *= EMPTY_HOOK_JUNK
        if weight > 0:
            out[key] = weight
    return out


def chances(spot_key, when, bait=None, bare=False):
    """{item: share of all bites}, for the odds table."""
    table = weights(spot_key, when, bait, bare)
    total = sum(table.values())
    return {key: weight / total for key, weight in table.items()}


def roll(spot_key, when, bait=None, bare=False, rng=None):
    """What is on the hook: an item by the weights, then for a fish a weight
    that runs small more often than big."""
    rng = rng or secrets.SystemRandom()
    table = weights(spot_key, when, bait, bare)
    pick = rng.random() * sum(table.values())
    for key, weight in table.items():
        if pick < weight:
            break
        pick -= weight
    thing = ITEMS[key]
    caught = {"species": key, "kind": thing["kind"], "rarity": thing["rarity"],
              "grams": 0, "trophy": 0, "seed": rng.getrandbits(31)}
    if thing["kind"] == "fish":
        low, high = thing["kg"]
        size = rng.random()
        caught.update(grams=round((low + (high - low) * size ** 2) * 1000), trophy=int(size >= 0.9))
    return caught


def pick_bait(spot_key, stock, preferred=None):
    """The bait that goes on the hook: the spot's required one, else the
    angler's choice if they have it, else the first the spot likes that they
    have. None is an empty hook."""
    spot = SPOTS[spot_key]
    if spot["bait"]:
        return spot["bait"] if stock.get(spot["bait"], 0) > 0 else None
    if preferred and stock.get(preferred, 0) > 0:
        return preferred
    return next((bait for bait in spot["baits"] if stock.get(bait, 0) > 0), None)
