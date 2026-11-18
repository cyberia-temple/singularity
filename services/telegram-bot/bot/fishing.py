"""🎣 Fishing in the chat: cast, wait for the bite, strike — and the fish is an NFT.

`/fish` puts a line in the water. A few seconds later something bites and a
button appears; press it within the tackle's window and the fish is yours, miss
it and it gets away. A fish (never the trash) becomes a CyberiaNFT: its own
pixel picture (`bot.fish_art`) and metadata are pinned to IPFS, the bot key
mints it and sends it to the wallet the angler linked with /set_wallet. Without
a wallet the catch waits in the bag (/fish_bag) and goes out as soon as one is
linked — play first, wallet later.

Everyone starts with bare hands, which hold only common fish: anything bigger
that bites slips away, and the message says what it was. Every landing pays
shells (🐚) — the trash too, sold for scrap — and shells buy tackle in
/fish_shop, from a hazel rod up to the Wired rod that holds a legendary. Each
rod holds one rarity more and gives a little longer to strike. Tackle and
shells belong to the account, across every chat, like the rest.

Nothing is staked, so nothing can be lost, and that is why the catch is drawn
by the bot's own `secrets` RNG rather than by a Telegram dice the way 🎰 is:
there is no balance whose fairness hangs on it. What *is* scarce is the chain,
so every fish is followed by FISHING_COOLDOWN_SECONDS of rest per account,
across every chat; a miss or a boot costs only MISS_COOLDOWN, because they mint
nothing.

The game lives in durable rows and the Telegram messages are views of them: a
cast is `waiting → biting → caught | escaped`, settled inside SQLite's
`BEGIN IMMEDIATE`, so the strike and the escape timer racing each other can
only ever produce one outcome. A cast remembers the tackle and the language it
was made with, so a rod bought mid-cast or a chat switching language cannot
change a cast already in the water. A cast whose task died with a restart is
swept to `lost` and costs nothing.

The NFT side is a queue (`advance`) that moves one catch at a time through
`pending → minting → minted → sending → delivered`. Each transaction's hash is
written down *before* it is broadcast, and only a receipt — or its absence for
DROPPED_AFTER — moves the row on, so a crash or a timed-out broadcast is
retried from what the chain says, not guessed at. A node that answers with an
error (nonce too low on the shared key, say) rejected the transaction outright
and is retried at once.
"""
import asyncio
import logging
import re
import secrets
import time
from datetime import datetime, timezone

from sqlalchemy import text
from telegram import InlineKeyboardButton, InlineKeyboardMarkup
from telegram.error import TelegramError

from bot import fish_art
from bot.config import (
    CHAIN_ID, CYBERIA_NFT_ABI, CYBERIA_NFT_ADDRESS, DEPLOYER_PK, EXPLORER_URL,
    FISHING_COOLDOWN_SECONDS, FISHING_MINT, MINTED_TOPIC, RPC_URL,
)
from bot.db import engine
from bot.language import T, lang_of, say, tr
from bot.stakes import transaction

logger = logging.getLogger(__name__)

BITE_AFTER = (3.0, 12.0)   # seconds the line sits before it bites
MISS_COOLDOWN = 20         # after a fish that got away, or a boot
STUCK = 120                # a cast nobody is watching any more
MINT_IDLE = 20             # queue poll with nothing in flight
MINT_BUSY = 5              # … and with a transaction on the wire
DROPPED_AFTER = 900        # no receipt for this long: the tx never landed
MAX_ATTEMPTS = 5

COOLDOWN = FISHING_COOLDOWN_SECONDS

# How often each rarity comes up, per thousand strikes. A fish's odds within
# its rarity are even.
RARITIES = {
    "trash":     {"label": "мусор",       "en": "trash",     "odds": 270, "colour": "#7d8590", "stars": 0},
    "common":    {"label": "обычная",     "en": "common",    "odds": 400, "colour": "#a7b4c2", "stars": 1},
    "uncommon":  {"label": "необычная",   "en": "uncommon",  "odds": 210, "colour": "#5cc46a", "stars": 2},
    "rare":      {"label": "редкая",      "en": "rare",      "odds": 85,  "colour": "#3d8bff", "stars": 3},
    "epic":      {"label": "эпическая",   "en": "epic",      "odds": 28,  "colour": "#b45cff", "stars": 4},
    "legendary": {"label": "легендарная", "en": "legendary", "odds": 7,   "colour": "#ffc83d", "stars": 5},
}
RANK = {rarity: index for index, rarity in enumerate(RARITIES)}
TOTAL_ODDS = sum(info["odds"] for info in RARITIES.values())

# Shells a landing pays, by rarity; a trophy pays double. The trash is sold for
# scrap, so a run of boots still gets a beginner out of the water with a rod.
SHELLS = {"trash": 3, "common": 4, "uncommon": 8, "rare": 20, "epic": 50, "legendary": 120}

# The tackle ladder, weakest first. `holds` is the rarest fish it lands;
# `window` the seconds it gives to strike. Prices are in shells.
GEAR = {
    "hands": {"emoji": "✋", "price": 0, "holds": "common", "window": 5.0,
              "ru": "голые руки", "en": "bare hands",
              "weak_ru": "Голыми руками такую не удержать", "weak_en": "Bare hands can't hold a fish like that"},
    "hazel": {"emoji": "🌿", "price": 10, "holds": "uncommon", "window": 7.0,
              "ru": "удочка из орешника", "ru_acc": "удочку из орешника", "en": "hazel rod",
              "weak_ru": "Удочка из орешника такую не выдержит", "weak_en": "A hazel rod won't hold a fish like that"},
    "bamboo": {"emoji": "🎋", "price": 60, "holds": "rare", "window": 7.0,
               "ru": "бамбуковая удочка", "ru_acc": "бамбуковую удочку", "en": "bamboo rod",
               "weak_ru": "Бамбуковая удочка такую не выдержит", "weak_en": "A bamboo rod won't hold a fish like that"},
    "carbon": {"emoji": "🎣", "price": 200, "holds": "epic", "window": 8.0,
               "ru": "карбоновый спиннинг", "ru_acc": "карбоновый спиннинг", "en": "carbon spinning rod",
               "weak_ru": "Карбоновый спиннинг такую не выдержит", "weak_en": "A carbon rod won't hold a fish like that"},
    "wired": {"emoji": "📡", "price": 500, "holds": "legendary", "window": 9.0,
              "ru": "спиннинг из Wired", "ru_acc": "спиннинг из Wired", "en": "Wired rod",
              "weak_ru": "", "weak_en": ""},
}
LADDER = list(GEAR)
STARTER = "hands"

SPECIES = {
    "roach": {"name": "Плотва", "en": "Roach", "rarity": "common", "kg": (0.1, 0.6), "look": {
        "body": "#b9c6cf", "belly": "#eef3f4", "fin": "#d9534f", "length": 30, "height": 14, "pattern": "scales"}},
    "perch": {"name": "Окунь", "en": "Perch", "rarity": "common", "kg": (0.2, 1.5), "look": {
        "body": "#8fae3a", "belly": "#e8dca2", "fin": "#f07b2a", "length": 30, "height": 16,
        "pattern": "stripes", "spiky": True, "dorsal_h": 0.95}},
    "crucian": {"name": "Карась", "en": "Crucian carp", "rarity": "common", "kg": (0.2, 1.2), "look": {
        "body": "#c9a24a", "belly": "#f0dea6", "fin": "#a8763a", "length": 28, "height": 19,
        "pattern": "scales", "fork": False}},
    "bream": {"name": "Лещ", "en": "Bream", "rarity": "uncommon", "kg": (1.0, 4.5), "look": {
        "body": "#a88a52", "belly": "#dccb9c", "fin": "#6b5a3a", "length": 30, "height": 23,
        "dorsal_len": 0.4, "dorsal_h": 0.5}},
    "zander": {"name": "Судак", "en": "Zander", "rarity": "uncommon", "kg": (1.0, 7.0), "look": {
        "body": "#8a9a8c", "belly": "#d8dfd4", "fin": "#7c8a7e", "length": 40, "height": 13,
        "pattern": "stripes", "spiky": True}},
    "pike": {"name": "Щука", "en": "Pike", "rarity": "uncommon", "kg": (2.0, 10.0), "look": {
        "body": "#5f8a4a", "belly": "#dae2b2", "fin": "#a0703a", "length": 46, "height": 11,
        "pattern": "spots", "dorsal": 0.35, "dorsal_len": 0.35, "dorsal_h": 0.9, "tail": 8}},
    "trout": {"name": "Радужная форель", "en": "Rainbow trout", "rarity": "rare", "kg": (1.0, 6.0), "look": {
        "body": "#7f9ea8", "belly": "#f2f2ec", "fin": "#9fb3b8", "accent": "#ff6f9a", "length": 36, "height": 14,
        "pattern": "lateral"}},
    "catfish": {"name": "Сом", "en": "Catfish", "rarity": "rare", "kg": (5.0, 45.0), "look": {
        "body": "#4a4f55", "belly": "#a9ab9f", "fin": "#3a3e44", "length": 48, "height": 14,
        "whiskers": True, "dorsal": -0.2, "dorsal_len": 0.2, "dorsal_h": 0.45, "fork": False, "tail": 7}},
    "sturgeon": {"name": "Осётр", "en": "Sturgeon", "rarity": "epic", "kg": (8.0, 60.0), "look": {
        "body": "#5d7385", "belly": "#cbd4d8", "fin": "#4b5d6c", "length": 50, "height": 12,
        "pattern": "scutes", "snout": True, "dorsal": 0.4, "dorsal_len": 0.25, "dorsal_h": 0.6}},
    "neon_eel": {"name": "Неоновый угорь", "en": "Neon eel", "rarity": "epic", "kg": (0.8, 3.0), "look": {
        "body": "#13c9bb", "belly": "#ff4fd8", "fin": "#7a5cff", "accent": "#9ffcf2", "length": 52, "height": 10,
        "pattern": "glow", "dorsal": -0.4, "dorsal_len": 1.1, "dorsal_h": 0.35, "fork": False, "tail": 5}},
    "goldfish": {"name": "Золотая рыбка", "en": "Goldfish", "rarity": "legendary", "kg": (0.1, 0.5), "look": {
        "body": "#ffb21e", "belly": "#ffe08a", "fin": "#ff7a1a", "length": 26, "height": 17,
        "pattern": "scales", "fancy": True, "tail": 13, "dorsal_h": 0.9}},
    "wired_carp": {"name": "Карп из Wired", "en": "Wired carp", "rarity": "legendary", "kg": (3.0, 15.0), "look": {
        "body": "#e04fd0", "belly": "#16e0d0", "fin": "#f4f4ff", "length": 36, "height": 20,
        "pattern": "glitch"}},
}

TRASH = {
    "boot": {"ru": "🥾 старый ботинок", "en": "🥾 an old boot"},
    "floppy": {"ru": "💾 дискета 3,5″", "en": "💾 a 3.5″ floppy disk"},
    "cable": {"ru": "🔌 спутанный патч-корд", "en": "🔌 a tangled patch cord"},
    "can": {"ru": "🥫 ржавая банка", "en": "🥫 a rusty can"},
}


def _columns(conn, table):
    return {row[1] for row in conn.execute(text(f"PRAGMA table_info({table})"))}


def _add_columns(conn, table, columns):
    """The tables were live before these columns existed: add what is missing."""
    have = _columns(conn, table)
    for name, declaration in columns.items():
        if name not in have:
            conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}"))


def ensure_schema():
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS fishing_casts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, user_name TEXT,
                command_message_id INTEGER, message_id INTEGER,
                status TEXT NOT NULL DEFAULT 'waiting',
                created_at INTEGER NOT NULL, bite_at REAL NOT NULL, bit_at REAL,
                ready_at INTEGER
            )
        """))
        _add_columns(conn, "fishing_casts", {"gear": "TEXT", "lang": "TEXT"})
        conn.execute(text("CREATE INDEX IF NOT EXISTS fishing_casts_by_user ON fishing_casts(user_id, id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS fishing_casts_open ON fishing_casts(status, created_at)"))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS fishing_catches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                cast_id INTEGER NOT NULL UNIQUE,
                chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, user_name TEXT,
                species TEXT NOT NULL, rarity TEXT NOT NULL,
                grams INTEGER NOT NULL DEFAULT 0, trophy INTEGER NOT NULL DEFAULT 0,
                seed INTEGER NOT NULL DEFAULT 0, caught_at INTEGER NOT NULL,
                photo_message_id INTEGER,
                nft_status TEXT NOT NULL,
                token_uri TEXT, token_id INTEGER, recipient TEXT,
                mint_tx TEXT, transfer_tx TEXT, sent_at INTEGER,
                attempts INTEGER NOT NULL DEFAULT 0, error TEXT
            )
        """))
        _add_columns(conn, "fishing_catches", {"gear": "TEXT", "lang": "TEXT"})
        conn.execute(text("CREATE INDEX IF NOT EXISTS fishing_catches_by_user ON fishing_catches(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS fishing_catches_by_chat ON fishing_catches(chat_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS fishing_catches_nft ON fishing_catches(nft_status)"))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS fishing_anglers (
                user_id INTEGER PRIMARY KEY,
                shells INTEGER NOT NULL DEFAULT 0,
                gear TEXT NOT NULL DEFAULT 'hands',
                updated_at INTEGER
            )
        """))
        # Anglers who landed something before shells existed are paid for it
        # once, as if shells had always been there; everyone starts by hand.
        # A row is made by every landing since, so this never pays twice.
        pay = " ".join(f"WHEN '{rarity}' THEN {count}" for rarity, count in SHELLS.items())
        conn.execute(text(f"""
            INSERT OR IGNORE INTO fishing_anglers(user_id, shells, gear, updated_at)
            SELECT user_id, SUM((CASE rarity {pay} ELSE 0 END) * (CASE WHEN trophy=1 THEN 2 ELSE 1 END)),
                   '{STARTER}', CAST(strftime('%s','now') AS INTEGER)
            FROM fishing_catches GROUP BY user_id
        """))


# --- the catch ---------------------------------------------------------------
def roll(rng=None):
    """What is on the hook: rarity by RARITIES odds, then an even pick within
    it, then a weight that runs small more often than big."""
    rng = rng or secrets.SystemRandom()
    pick = rng.randrange(TOTAL_ODDS)
    for rarity, info in RARITIES.items():
        if pick < info["odds"]:
            break
        pick -= info["odds"]
    if rarity == "trash":
        return {"species": rng.choice(sorted(TRASH)), "rarity": "trash", "grams": 0, "trophy": 0, "seed": 0}
    species = rng.choice(sorted(key for key, fish in SPECIES.items() if fish["rarity"] == rarity))
    low, high = SPECIES[species]["kg"]
    size = rng.random()
    return {
        "species": species,
        "rarity": rarity,
        "grams": round((low + (high - low) * size ** 2) * 1000),
        "trophy": int(size >= 0.9),
        "seed": rng.getrandbits(31),
    }


def shells_for(catch):
    return SHELLS[catch["rarity"]] * (2 if catch["trophy"] else 1)


def gear_of(row):
    """The tackle a cast or catch was made with. Rows from before tackle
    existed were made with a rod that held anything."""
    return GEAR.get((row or {}).get("gear") or "", GEAR["wired"])


def holds(gear_key, rarity):
    return RANK[rarity] <= RANK[GEAR[gear_key]["holds"]]


def first_gear_for(rarity):
    return next(key for key in LADDER if holds(key, rarity))


def next_gear(gear_key):
    index = LADDER.index(gear_key)
    return LADDER[index + 1] if index + 1 < len(LADDER) else None


def weight(grams, lang="ru"):
    grams = int(grams)
    if grams < 1000:
        return f"{grams} " + tr(lang, "г", "g")
    kg = f"{grams / 1000:.2f}".rstrip("0").rstrip(".")
    return tr(lang, kg.replace(".", ",") + " кг", kg + " kg")


def stars(rarity):
    count = RARITIES[rarity]["stars"]
    return "★" * count + "☆" * (5 - count)


def rarity_label(rarity, lang):
    info = RARITIES[rarity]
    return tr(lang, info["label"], info["en"])


def fish_name(species, lang):
    if species in TRASH:
        return TRASH[species][lang if lang in ("ru", "en") else "ru"]
    fish = SPECIES[species]
    return tr(lang, fish["name"], fish["en"])


def gear_name(gear_key, lang):
    gear = GEAR[gear_key]
    return tr(lang, gear["ru"], gear["en"])


def picture(catch):
    """The catch's PNG. Bigger fish of a species fill more of the frame."""
    fish = SPECIES[catch["species"]]
    low, high = fish["kg"]
    size = max(0.0, min(1.0, (int(catch["grams"]) / 1000 - low) / (high - low))) ** 0.5
    rarity = RARITIES[catch["rarity"]]
    return fish_art.render(fish["look"], rarity["colour"], rarity["stars"], int(catch["seed"]), 0.86 + 0.14 * size)


def metadata(catch, image_uri):
    """ERC-721 metadata in the shape the marketplace renders. No angler or chat
    name: the token is public forever, its owner is already on chain."""
    fish, rarity = SPECIES[catch["species"]], RARITIES[catch["rarity"]]
    kg = f"{int(catch['grams']) / 1000:.2f}".rstrip("0").rstrip(".")
    caught = datetime.fromtimestamp(int(catch["caught_at"]), timezone.utc)
    attributes = [
        {"trait_type": "Species", "value": fish["en"]},
        {"trait_type": "Rarity", "value": rarity["en"]},
        {"trait_type": "Weight (g)", "value": int(catch["grams"]), "display_type": "number"},
        {"trait_type": "Trophy", "value": "yes" if catch["trophy"] else "no"},
        {"trait_type": "Caught", "value": f"{caught:%Y-%m-%d %H:%M} UTC"},
    ]
    if catch.get("gear") in GEAR:
        attributes.append({"trait_type": "Tackle", "value": GEAR[catch["gear"]]["en"].capitalize()})
    attributes.append({"trait_type": "Collection", "value": "Cyberia Fishing"})
    return {
        "name": f"{fish['en']} · {kg} kg",
        "description": (
            f"A {rarity['en']} {fish['en'].lower()} of {kg} kg, caught with the Cyberia Telegram bot "
            f"on {caught:%Y-%m-%d}. Catch #{catch['id']}."
        ),
        "image": image_uri,
        "attributes": attributes,
    }


# --- the angler --------------------------------------------------------------
def _angler(conn, user):
    row = conn.execute(text("SELECT shells, gear FROM fishing_anglers WHERE user_id=:u"),
                       {"u": user}).mappings().first()
    if not row or row["gear"] not in GEAR:
        return {"shells": int(row["shells"]) if row else 0, "gear": STARTER}
    return {"shells": int(row["shells"]), "gear": row["gear"]}


def angler(user):
    """{shells, gear} — a newcomer has none and bare hands."""
    with engine.connect() as conn:
        return _angler(conn, user)


def affordable_upgrade(state):
    """The next rod up, if the angler already has the shells for it."""
    upgrade = next_gear(state["gear"])
    return upgrade if upgrade and state["shells"] >= GEAR[upgrade]["price"] else None


def buy(user, gear_key, now=None):
    """Buy tackle with shells. Returns the angler afterwards; refusals are
    ValueErrors carrying a T."""
    now = int(time.time()) if now is None else int(now)
    if gear_key not in GEAR or gear_key == STARTER:
        raise ValueError(T("Такой снасти нет.", "There is no such tackle."))
    gear = GEAR[gear_key]
    with transaction() as conn:
        state = _angler(conn, user)
        if LADDER.index(state["gear"]) >= LADDER.index(gear_key):
            raise ValueError(T("У вас уже есть снасть не хуже.", "You already have tackle at least this good."))
        if state["shells"] < gear["price"]:
            raise ValueError(T(
                f"Не хватает ракушек: нужно {gear['price']} 🐚, у вас {state['shells']}. Ловите ещё: /fish",
                f"Not enough shells: {gear['price']} 🐚 needed, you have {state['shells']}. Keep fishing: /fish",
            ))
        conn.execute(text("""
            INSERT INTO fishing_anglers(user_id, shells, gear, updated_at) VALUES(:u, :s, :g, :t)
            ON CONFLICT(user_id) DO UPDATE SET shells=excluded.shells, gear=excluded.gear, updated_at=excluded.updated_at
        """), {"u": user, "s": state["shells"] - gear["price"], "g": gear_key, "t": now})
        return {"shells": state["shells"] - gear["price"], "gear": gear_key}


# --- a cast ------------------------------------------------------------------
def _cast(conn, cast_id):
    return conn.execute(text("SELECT * FROM fishing_casts WHERE id=:id"), {"id": cast_id}).mappings().first()


def get_cast(cast_id):
    with engine.connect() as conn:
        row = _cast(conn, cast_id)
    return dict(row) if row else None


def cast(chat, user, display_name=None, now=None, rng=None, lang="ru"):
    """Put a line in the water. Returns (cast id, seconds until the bite).

    Refuses while this account's line is already in the water anywhere, and
    during its rest after the last cast.
    """
    now = int(time.time()) if now is None else int(now)
    rng = rng or secrets.SystemRandom()
    with transaction() as conn:
        last = conn.execute(text(
            "SELECT * FROM fishing_casts WHERE user_id=:u ORDER BY id DESC LIMIT 1"
        ), {"u": user}).mappings().first()
        if last and last["status"] in ("waiting", "biting"):
            if now - last["created_at"] < STUCK:
                raise ValueError(T("Вы уже рыбачите — следите за водой.", "You're already fishing — watch the water."))
            conn.execute(text("UPDATE fishing_casts SET status='lost', ready_at=:n WHERE id=:id"),
                         {"n": now, "id": last["id"]})
        elif last and last["ready_at"] and now < last["ready_at"]:
            left = last["ready_at"] - now
            raise ValueError(T(f"Рыба отдыхает. Следующий заброс через {_wait(left, 'ru')}.",
                               f"The fish are resting. Next cast in {_wait(left, 'en')}."))
        gear = _angler(conn, user)["gear"]
        delay = rng.uniform(*BITE_AFTER)
        return conn.execute(text("""
            INSERT INTO fishing_casts(chat_id,user_id,user_name,status,created_at,bite_at,gear,lang)
            VALUES(:c,:u,:name,'waiting',:t,:b,:g,:l) RETURNING id
        """), {"c": chat, "u": user, "name": display_name, "t": now, "b": now + delay,
               "g": gear, "l": lang}).scalar_one(), delay


def _wait(seconds, lang="ru"):
    seconds = max(1, int(seconds))
    if seconds < 60:
        return f"{seconds} " + tr(lang, "с", "s")
    minutes = -(-seconds // 60)
    return f"{minutes} " + tr(lang, "мин", "min")


def attach(cast_id, message_id, command_message_id=None):
    with engine.begin() as conn:
        conn.execute(text("UPDATE fishing_casts SET message_id=:m, command_message_id=:o WHERE id=:id"),
                     {"m": message_id, "o": command_message_id, "id": cast_id})


def bite(cast_id, now=None):
    """The line goes taut. True if this cast was still waiting for it."""
    now = time.time() if now is None else now
    with transaction() as conn:
        return conn.execute(text(
            "UPDATE fishing_casts SET status='biting', bit_at=:n WHERE id=:id AND status='waiting'"
        ), {"n": now, "id": cast_id}).rowcount == 1


def escape(cast_id, now=None):
    """The fish gets away if nobody struck in time. True if it did just now."""
    now = time.time() if now is None else now
    with transaction() as conn:
        row = _cast(conn, cast_id)
        if not row or row["status"] != "biting" or now - row["bit_at"] < gear_of(row)["window"]:
            return False
        conn.execute(text("UPDATE fishing_casts SET status='escaped', ready_at=:r WHERE id=:id"),
                     {"r": int(now) + MISS_COOLDOWN, "id": cast_id})
        return True


def lose(cast_id, now=None):
    """A cast whose message could not be shown: no fish, no rest."""
    now = int(time.time()) if now is None else int(now)
    with transaction() as conn:
        conn.execute(text("""UPDATE fishing_casts SET status='lost', ready_at=:n
            WHERE id=:id AND status IN ('waiting','biting')"""), {"n": now, "id": cast_id})


def _wallet(conn, user):
    return conn.execute(text("SELECT address FROM tg_wallets WHERE user_id=:u"), {"u": user}).scalar_one_or_none()


def wallet_of(user):
    with engine.connect() as conn:
        return _wallet(conn, user)


def strike(cast_id, user, now=None, rng=None):
    """Press the button. Returns (cast, catch); catch is None when it got away —
    too late, or too big for the tackle (then the cast carries `got_away`).

    Refusals are ValueErrors carrying a T for the presser. The check and the
    catch are one transaction, so the escape timer cannot also fire.
    """
    now = time.time() if now is None else now
    with transaction() as conn:
        row = _cast(conn, cast_id)
        if not row:
            raise ValueError(T("Этот заброс не найден.", "This cast is gone."))
        if row["user_id"] != user:
            owner = row["user_name"]
            raise ValueError(T(f"Это заброс {owner or 'другого рыбака'}. Свой — /fish",
                               f"That's {owner}'s cast. Yours: /fish" if owner else "That's another angler's cast. Yours: /fish"))
        if row["status"] == "waiting" and now >= row["bite_at"]:
            # The bite message reached the angler before its own task wrote it down.
            row = dict(row, status="biting", bit_at=now)
        if row["status"] == "waiting":
            raise ValueError(T("Ещё не клюёт — ждите.", "Nothing's biting yet — wait."))
        if row["status"] != "biting":
            raise ValueError(T("Этот заброс уже закончился. Новый — /fish", "This cast is over. A new one: /fish"))
        if now - row["bit_at"] > gear_of(row)["window"]:
            conn.execute(text("UPDATE fishing_casts SET status='escaped', ready_at=:r WHERE id=:id"),
                         {"r": int(now) + MISS_COOLDOWN, "id": cast_id})
            return dict(row, status="escaped"), None

        hooked = roll(rng)
        if RANK[hooked["rarity"]] > RANK[gear_of(row)["holds"]]:
            conn.execute(text("UPDATE fishing_casts SET status='escaped', ready_at=:r WHERE id=:id"),
                         {"r": int(now) + MISS_COOLDOWN, "id": cast_id})
            return dict(row, status="escaped", got_away=hooked), None

        is_fish = hooked["rarity"] != "trash"
        catch_id = conn.execute(text("""
            INSERT INTO fishing_catches(cast_id,chat_id,user_id,user_name,species,rarity,grams,trophy,seed,
                                        caught_at,nft_status,gear,lang)
            VALUES(:cast,:c,:u,:name,:s,:r,:g,:t,:seed,:at,:nft,:gear,:lang) RETURNING id
        """), {"cast": cast_id, "c": row["chat_id"], "u": user, "name": row["user_name"],
               "s": hooked["species"], "r": hooked["rarity"], "g": hooked["grams"], "t": hooked["trophy"],
               "seed": hooked["seed"], "at": int(now), "nft": "pending" if is_fish else "none",
               "gear": row["gear"], "lang": row["lang"]}).scalar_one()
        conn.execute(text("""
            INSERT INTO fishing_anglers(user_id, shells, gear, updated_at) VALUES(:u, :s, :g, :t)
            ON CONFLICT(user_id) DO UPDATE SET shells=fishing_anglers.shells + excluded.shells,
                updated_at=excluded.updated_at
        """), {"u": user, "s": shells_for(hooked), "g": STARTER, "t": int(now)})
        conn.execute(text("UPDATE fishing_casts SET status='caught', ready_at=:r WHERE id=:id"),
                     {"r": int(now) + (COOLDOWN if is_fish else MISS_COOLDOWN), "id": cast_id})
        catch = conn.execute(text("SELECT * FROM fishing_catches WHERE id=:id"), {"id": catch_id}).mappings().first()
        return dict(row, status="caught"), dict(catch)


def sweep(now=None):
    """Casts nobody is watching any more (the bot restarted mid-cast). They
    end as `lost`, with no rest owed."""
    now = int(time.time()) if now is None else int(now)
    with transaction() as conn:
        rows = conn.execute(text(
            "SELECT * FROM fishing_casts WHERE status IN ('waiting','biting') AND created_at<=:n"
        ), {"n": now - STUCK}).mappings().all()
        conn.execute(text(
            "UPDATE fishing_casts SET status='lost', ready_at=:n WHERE status IN ('waiting','biting') AND created_at<=:old"
        ), {"n": now, "old": now - STUCK})
    return [dict(row) for row in rows]


def set_photo(catch_id, message_id):
    with engine.begin() as conn:
        conn.execute(text("UPDATE fishing_catches SET photo_message_id=:m WHERE id=:id"),
                     {"m": message_id, "id": catch_id})


def get_catch(catch_id):
    with engine.connect() as conn:
        row = conn.execute(text("SELECT * FROM fishing_catches WHERE id=:id"), {"id": catch_id}).mappings().first()
    return dict(row) if row else None


# --- the NFT queue -----------------------------------------------------------
class Chain:
    """The bot key's side of CyberiaNFT: sign, broadcast, read receipts. Blocking."""

    def __init__(self):
        from web3 import Web3

        self.w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 30}))
        self.account = self.w3.eth.account.from_key(DEPLOYER_PK)
        self.nft = self.w3.eth.contract(address=Web3.to_checksum_address(CYBERIA_NFT_ADDRESS), abi=CYBERIA_NFT_ABI)

    def sign_mint(self, uri):
        return self._sign(self.nft.functions.mint(uri), 500_000)

    def sign_transfer(self, token_id, to):
        from web3 import Web3

        return self._sign(self.nft.functions.safeTransferFrom(
            self.account.address, Web3.to_checksum_address(to), int(token_id)), 150_000)

    def _sign(self, call, fallback_gas):
        from bot.chain import next_nonce

        try:
            gas = call.estimate_gas({"from": self.account.address})
        except Exception as exc:
            logger.warning("fishing: estimate_gas failed, using %s: %s", fallback_gas, exc)
            gas = fallback_gas
        tx = call.build_transaction({
            "from": self.account.address,
            "nonce": next_nonce(self.w3, self.account.address),
            "gas": int(gas * 1.25) + 50_000,
            "gasPrice": self.w3.eth.gas_price,
            "chainId": CHAIN_ID,
        })
        signed = self.account.sign_transaction(tx)
        return _hex(signed.hash), signed.raw_transaction

    def broadcast(self, raw):
        self.w3.eth.send_raw_transaction(raw)

    def outcome(self, tx_hash):
        """None while the chain has no receipt, else (succeeded, minted token id)."""
        from web3.exceptions import TransactionNotFound

        try:
            receipt = self.w3.eth.get_transaction_receipt(tx_hash)
        except TransactionNotFound:
            return None
        if receipt["status"] != 1:
            return False, None
        for log in receipt["logs"]:
            topics = log.get("topics") or []
            if (str(log.get("address", "")).lower() == self.nft.address.lower() and len(topics) > 1
                    and _hex(topics[0]) == _hex(MINTED_TOPIC)):
                return True, int.from_bytes(bytes(topics[1]), "big")
        return True, None


def _hex(value):
    value = value if isinstance(value, str) else value.hex()
    return "0x" + value.lower().removeprefix("0x")


def rejected(exc):
    """The node answered with an error: the transaction was never accepted.
    Anything else (a timeout, a dropped connection) may have reached it."""
    from web3.exceptions import Web3RPCError

    return isinstance(exc, (Web3RPCError, ValueError))


def pin(catch):
    """Pin the picture and the metadata; returns the token URI. Blocking."""
    from bot.nft import _pin_bytes_to_ipfs, _pin_json_to_ipfs

    image = _pin_bytes_to_ipfs(picture(catch), f"fish_{catch['id']}.png", "image/png")
    return _pin_json_to_ipfs(metadata(catch, image))


def _move(catch_id, expected, **fields):
    """Set fields on a catch only if it is still in `expected` state."""
    assignments = ", ".join(f"{name}=:{name}" for name in fields)
    with transaction() as conn:
        return conn.execute(text(
            f"UPDATE fishing_catches SET {assignments} WHERE id=:id AND nft_status=:expected"
        ), {**fields, "id": catch_id, "expected": expected}).rowcount == 1


def _retry(catch, back_to, error):
    attempts = int(catch["attempts"]) + 1
    status = back_to if attempts < MAX_ATTEMPTS else "failed"
    if status == "failed":
        logger.error("fishing: catch %s gave up after %s attempts: %s", catch["id"], attempts, error)
    else:
        logger.warning("fishing: catch %s back to %s (%s/%s): %s", catch["id"], back_to, attempts, MAX_ATTEMPTS, error)
    _move(catch["id"], catch["nft_status"], nft_status=status, attempts=attempts, error=str(error)[:500])


def _queue(*statuses):
    """Catches in these states whose angler has a wallet linked, oldest first."""
    marks = ",".join(f":s{index}" for index in range(len(statuses)))
    with engine.connect() as conn:
        rows = conn.execute(text(f"""
            SELECT f.*, w.address AS wallet FROM fishing_catches f
            JOIN tg_wallets w ON w.user_id = f.user_id
            WHERE f.nft_status IN ({marks}) ORDER BY f.id
        """), {f"s{index}": status for index, status in enumerate(statuses)}).mappings().all()
    return [dict(row) for row in rows]


def _in_flight():
    with engine.connect() as conn:
        rows = conn.execute(text(
            "SELECT * FROM fishing_catches WHERE nft_status IN ('minting','sending') ORDER BY id"
        )).mappings().all()
    return [dict(row) for row in rows]


def advance(chain, pin=pin, now=None):
    """Move the NFT queue one step. Returns (catches delivered just now, more to do).

    Receipts first, then at most one new mint and one new transfer, so a single
    pass never has more than two transactions of its own on the wire.
    """
    now = int(time.time()) if now is None else int(now)
    delivered = []

    for catch in _in_flight():
        minting = catch["nft_status"] == "minting"
        try:
            result = chain.outcome(catch["mint_tx"] if minting else catch["transfer_tx"])
        except Exception as exc:
            logger.warning("fishing: receipt for catch %s unavailable: %s", catch["id"], exc)
            continue
        if result is None:
            if now - int(catch["sent_at"] or 0) > DROPPED_AFTER:
                _retry(catch, "pending" if minting else "minted", "no receipt: dropped")
            continue
        succeeded, token_id = result
        if minting and succeeded and token_id is not None:
            _move(catch["id"], "minting", nft_status="minted", token_id=token_id, error=None)
            logger.info("fishing: catch %s minted as #%s (%s)", catch["id"], token_id, catch["mint_tx"])
        elif minting and succeeded:
            # Mined but no Minted event: which token it made cannot be known, so no retry.
            _move(catch["id"], "minting", nft_status="failed", error="mint without a Minted event")
        elif minting:
            _retry(catch, "pending", "mint reverted")
        elif succeeded:
            _move(catch["id"], "sending", nft_status="delivered", error=None)
            logger.info("fishing: catch %s (#%s) delivered to %s", catch["id"], catch["token_id"], catch["recipient"])
            delivered.append(catch["id"])
        else:
            _retry(catch, "minted", "transfer reverted")

    for catch in _queue("pending")[:1]:
        try:
            uri = catch["token_uri"] or pin(catch)
            _move(catch["id"], "pending", token_uri=uri)
            tx_hash, raw = chain.sign_mint(uri)
        except Exception as exc:
            _retry(catch, "pending", exc)
            continue
        _send(chain, catch, "pending", "minting", raw, mint_tx=tx_hash, sent_at=now)

    for catch in _queue("minted")[:1]:
        try:
            tx_hash, raw = chain.sign_transfer(catch["token_id"], catch["wallet"])
        except Exception as exc:
            _retry(catch, "minted", exc)
            continue
        _send(chain, catch, "minted", "sending", raw, transfer_tx=tx_hash, recipient=catch["wallet"], sent_at=now)

    return delivered, bool(_in_flight() or _queue("pending", "minted"))


def _send(chain, catch, before, after, raw, **fields):
    """Write the hash down, then broadcast. A rejection goes straight back to
    `before`; anything ambiguous waits for the receipt (or DROPPED_AFTER)."""
    if not _move(catch["id"], before, nft_status=after, **fields):
        return
    try:
        chain.broadcast(raw)
    except Exception as exc:
        if rejected(exc):
            _retry(dict(catch, nft_status=after), before, exc)
        else:
            logger.warning("fishing: broadcast for catch %s unclear, waiting for its receipt: %s", catch["id"], exc)


# --- messages ----------------------------------------------------------------
def _lang(row):
    """Rows from before the language choice were all Russian."""
    return (row or {}).get("lang") or "ru"


def _ru_plural(count, one, few, many):
    count = abs(int(count)) % 100
    if 11 <= count <= 19:
        return many
    count %= 10
    return one if count == 1 else few if 2 <= count <= 4 else many


def _short(address):
    return f"{address[:6]}…{address[-4:]}" if address else ""


def _bot_hint(bot_username, lang):
    if bot_username:
        return tr(lang, f"в личке @{bot_username}", f"in a DM to @{bot_username}")
    return tr(lang, "в личке бота", "in a DM to the bot")


def _angler_name(row, lang):
    return row.get("user_name") or tr(lang, "рыбак", "angler")


def nft_line(catch, wallet=None, bot_username=None, minting=None, lang="ru"):
    minting = (FISHING_MINT and bool(DEPLOYER_PK)) if minting is None else minting
    status = catch["nft_status"]
    if status == "delivered":
        short = _short(catch["recipient"])
        return tr(lang, f"🖼 NFT #{catch['token_id']} — в кошельке {short}", f"🖼 NFT #{catch['token_id']} — in wallet {short}")
    if status == "failed":
        return tr(lang, "NFT не получился — улов сохранён в /fish_bag, разберёмся.",
                  "The NFT didn't work out — the catch is kept in /fish_bag, we'll look into it.")
    if not minting:
        return tr(lang, "Улов сохранён в /fish_bag — NFT отправим, когда включим чеканку.",
                  "Kept in /fish_bag — the NFT goes out once minting is switched on.")
    if status in ("minting", "minted", "sending") or wallet:
        short = _short(catch.get("recipient") or wallet)
        return tr(lang, f"🖼 Чеканим NFT в кошелёк {short}…", f"🖼 Minting the NFT to {short}…")
    hint = _bot_hint(bot_username, lang)
    return tr(lang, f"🖼 Станет NFT, как только привяжете кошелёк: /set_wallet 0x… {hint}.",
              f"🖼 Becomes an NFT as soon as you link a wallet: /set_wallet 0x… {hint}.")


def upgrade_hint(state, lang):
    upgrade = affordable_upgrade(state)
    if not upgrade:
        return None
    gear = GEAR[upgrade]
    return tr(lang, f"🛒 Ракушек хватает на {gear['ru_acc']} {gear['emoji']}: /fish_shop",
              f"🛒 You have the shells for a {gear['en']} {gear['emoji']}: /fish_shop")


def caption(catch, wallet=None, bot_username=None, minting=None, lang=None, hint=None):
    lang = lang or _lang(catch)
    gear = gear_of(catch)
    name = _angler_name(catch, lang)
    trophy = tr(lang, " · 🏆 трофей", " · 🏆 trophy") if catch["trophy"] else ""
    lines = [
        f"{gear['emoji']} " + tr(lang, f"Улов — {name}", f"Catch — {name}"),
        f"{fish_name(catch['species'], lang)}, {weight(catch['grams'], lang)}{trophy}",
        f"{stars(catch['rarity'])} {rarity_label(catch['rarity'], lang)} · +{shells_for(catch)} 🐚",
        "",
        nft_line(catch, wallet, bot_username, minting, lang),
    ]
    if COOLDOWN:
        lines.append(tr(lang, f"Следующий заброс — через {_wait(COOLDOWN, lang)}.",
                        f"Next cast in {_wait(COOLDOWN, lang)}."))
    if hint:
        lines.append(hint)
    return "\n".join(lines)


def nft_markup(catch, lang=None):
    if catch["nft_status"] != "delivered" or catch["token_id"] is None:
        return None
    url = f"{EXPLORER_URL}/token/{CYBERIA_NFT_ADDRESS}/instance/{catch['token_id']}"
    label = tr(lang or _lang(catch), "Открыть NFT", "Open NFT")
    return InlineKeyboardMarkup([[InlineKeyboardButton(label, url=url)]])


def _bare(gear_key):
    return gear_key == STARTER


def waiting_text(name, gear_key=STARTER, lang="ru"):
    if _bare(gear_key):
        return tr(lang,
                  f"✋ {name} заходит в воду по колено и ждёт рыбу…\n〰️〰️〰️🦵〰️〰️〰️\nКак подплывёт — хватайте!",
                  f"✋ {name} wades in knee-deep and waits for a fish…\n〰️〰️〰️🦵〰️〰️〰️\nGrab it when it swims up!")
    gear = GEAR[gear_key]
    return tr(lang,
              f"{gear['emoji']} {name} закидывает {gear['ru_acc']}…\n〰️〰️〰️🔴〰️〰️〰️\nЖдите поклёвку и жмите «Подсечь».",
              f"{gear['emoji']} {name} casts the {gear['en']}…\n〰️〰️〰️🔴〰️〰️〰️\nWait for the bite, then press «Strike».")


def biting_text(name, gear_key=STARTER, lang="ru"):
    gear = GEAR[gear_key]
    window = f"{gear['window']:g}"
    if _bare(gear_key):
        return tr(lang, f"✋ Рыба у самых ног, {name}!\n〰️〰️🫧🐟🫧〰️〰️\nХватайте — {window} секунд!",
                  f"✋ A fish right at your feet, {name}!\n〰️〰️🫧🐟🫧〰️〰️\nGrab it — {window} seconds!")
    return tr(lang, f"{gear['emoji']} {name}, клюёт!\n〰️〰️🫧🔴🫧〰️〰️\nПодсекайте — {window} секунд!",
              f"{gear['emoji']} It's biting, {name}!\n〰️〰️🫧🔴🫧〰️〰️\nStrike — {window} seconds!")


def escaped_text(name, gear_key=STARTER, lang="ru"):
    if _bare(gear_key):
        return tr(lang, f"✋ {name}: рыба выскользнула — не успели схватить.\nЕщё раз: /fish",
                  f"✋ It slipped away from {name} — too slow.\nAgain: /fish")
    return tr(lang, f"🎣 {name}: сорвалась — не успели подсечь.\nЕщё раз: /fish",
              f"🎣 It got away from {name} — the strike came too late.\nAgain: /fish")


def too_big_text(name, gear_key, hooked, lang="ru"):
    """A fish the tackle cannot hold: what it was, and where the rod is."""
    gear = GEAR[gear_key]
    fish = SPECIES[hooked["species"]]
    star = stars(hooked["rarity"])
    weak = tr(lang, gear["weak_ru"], gear["weak_en"])
    return tr(lang,
              f"💥 {name}: сорвался крупный улов — {fish['name']} {star}!\n{weak}. Снасть покрепче — /fish_shop",
              f"💥 {name} lost a big one — a {fish['en'].lower()} {star}!\n{weak}. Better tackle: /fish_shop")


def trash_text(catch, hint=None, lang=None):
    lang = lang or _lang(catch)
    name = _angler_name(catch, lang)
    junk = fish_name(catch["species"], lang)
    earned = shells_for(catch)
    wait = _wait(MISS_COOLDOWN, lang)
    if _bare(catch.get("gear")):
        head = tr(lang, f"✋ {name} достаёт из воды: {junk}.", f"✋ {name} pulls out {junk}.")
    else:
        head = tr(lang, f"🎣 {name} вытаскивает: {junk}.", f"🎣 {name} reels in {junk}.")
    lines = [head, tr(lang, f"Не рыба и не NFT — сдали в утиль: +{earned} 🐚.",
                      f"Not a fish and not an NFT — sold for scrap: +{earned} 🐚."),
             tr(lang, f"Ещё раз: /fish (через {wait})", f"Again: /fish (in {wait})")]
    if hint:
        lines.append(hint)
    return "\n".join(lines)


def lost_text(row):
    lang = _lang(row)
    if _bare(row.get("gear")):
        return tr(lang, "✋ Рыба уплыла — заходите снова: /fish", "✋ The fish swam off — try again: /fish")
    return tr(lang, "🎣 Леска оборвалась — закидывайте снова: /fish", "🎣 The line snapped — cast again: /fish")


def hook_markup(cast_id, gear_key=STARTER, lang="ru"):
    label = tr(lang, "✋ Хватать!", "✋ Grab!") if _bare(gear_key) else tr(lang, "🪝 Подсечь", "🪝 Strike")
    return InlineKeyboardMarkup([[InlineKeyboardButton(label, callback_data=f"fish:{cast_id}")]])


def _ranked(rows):
    return sorted(rows, key=lambda row: (-RANK[row["rarity"]], -int(row["grams"]), row["id"]))


def tackle_line(state, lang):
    gear = GEAR[state["gear"]]
    return tr(lang, f"{gear['emoji']} Снасть: {gear['ru']} · 🐚 {state['shells']}",
              f"{gear['emoji']} Tackle: {gear['en']} · 🐚 {state['shells']}")


def bag(user, name=None, lang="ru"):
    """An angler's catches across every chat, best first, and their tackle."""
    with engine.connect() as conn:
        rows = [dict(row) for row in conn.execute(text(
            "SELECT * FROM fishing_catches WHERE user_id=:u AND rarity!='trash'"
        ), {"u": user}).mappings()]
        wallet = _wallet(conn, user)
        state = _angler(conn, user)
    tackle = [tackle_line(state, lang)] + [line for line in [upgrade_hint(state, lang)] if line]
    if not rows:
        return "\n".join([tr(lang, "🪣 В садке пусто. Первая рыба ждёт: /fish", "🪣 The bag is empty. Your first fish awaits: /fish"),
                          "", *tackle])
    count = len(rows)
    trophies = sum(1 for row in rows if row["trophy"])
    minted = sum(1 for row in rows if row["nft_status"] == "delivered")
    whose_ru = f"Садок {name}" if name else "Садок"
    whose_en = f"{name}'s bag" if name else "Bag"
    head = tr(lang,
              f"🪣 {whose_ru}: {count} {_ru_plural(count, 'рыба', 'рыбы', 'рыб')} · трофеев {trophies} · NFT {minted}",
              f"🪣 {whose_en}: {count} fish · {trophies} {'trophy' if trophies == 1 else 'trophies'} · "
              f"{minted} {'NFT' if minted == 1 else 'NFTs'}")
    lines = [head, *tackle, ""]
    for index, row in enumerate(_ranked(rows)[:10], 1):
        if row["nft_status"] == "delivered":
            tag = f"NFT #{row['token_id']}"
        elif row["nft_status"] == "pending" and not wallet:
            tag = tr(lang, "ждёт кошелька", "waiting for a wallet")
        else:
            tag = tr(lang, "чеканится", "minting")
        trophy = " 🏆" if row["trophy"] else ""
        lines.append(f"{index}. {stars(row['rarity'])} {fish_name(row['species'], lang)}, "
                     f"{weight(row['grams'], lang)}{trophy} — {tag}")
    waiting = sum(1 for row in rows if row["nft_status"] == "pending")
    if waiting and not wallet:
        lines += ["", tr(lang, f"Ждут кошелька: {waiting}. /set_wallet 0x… в личке бота — и они станут NFT.",
                         f"{waiting} waiting for a wallet: /set_wallet 0x… in a DM to the bot and they become NFTs.")]
    return "\n".join(lines)


def top(chat, lang="ru"):
    """The chat's best catches."""
    with engine.connect() as conn:
        rows = [dict(row) for row in conn.execute(text(
            "SELECT * FROM fishing_catches WHERE chat_id=:c AND rarity!='trash'"
        ), {"c": chat}).mappings()]
    if not rows:
        return tr(lang, "🏆 Здесь ещё никто ничего не поймал. Первым будет тот, кто напишет /fish",
                  "🏆 Nobody has caught anything here yet. The first will be whoever sends /fish")
    lines = [tr(lang, "🏆 Рекорды чата", "🏆 This chat's records"), ""]
    for index, row in enumerate(_ranked(rows)[:10], 1):
        trophy = " 🏆" if row["trophy"] else ""
        lines.append(f"{index}. {stars(row['rarity'])} {fish_name(row['species'], lang)}, "
                     f"{weight(row['grams'], lang)}{trophy} — {_angler_name(row, lang)}")
    return "\n".join(lines)


def odds(lang="ru"):
    lines = []
    for rarity, info in RARITIES.items():
        share = info["odds"] / TOTAL_ODDS * 100
        if rarity == "trash":
            names = tr(lang, "ботинки, банки, дискеты", "boots, cans, floppies")
        else:
            names = ", ".join(fish_name(key, lang) for key, fish in SPECIES.items() if fish["rarity"] == rarity)
        needs = GEAR[first_gear_for(rarity)]["emoji"]
        mark = stars(rarity) if rarity != "trash" else "🥾"
        percent = tr(lang, f"{share:g}".replace(".", ","), f"{share:g}")
        lines.append(f"{mark} {rarity_label(rarity, lang)} — {percent}% · {needs}: {names}")
    return "\n".join(lines)


def help_text(lang):
    return "\n".join([
        tr(lang, "🎣 Рыбалка", "🎣 Fishing"), "", odds(lang), "",
        tr(lang,
           "Начинаете с голыми руками ✋ — они держат только обычную рыбу, крупная выскальзывает. "
           "Каждый улов приносит 🐚 ракушки, а на них в /fish_shop покупаются удочки покрепче: "
           "значок у шанса — с какой снасти такая рыба уже не уйдёт.",
           "You start with bare hands ✋ — they hold only common fish, bigger ones slip away. "
           "Every catch earns 🐚 shells, and /fish_shop sells stronger rods for them: "
           "the icon by each chance is the tackle from which that fish no longer gets away."),
        "",
        tr(lang, "Каждая рыба — NFT в вашем кошельке. /fish — заброс, /fish_bag — садок, "
                 "/fish_shop — снасти, /fish_top — рекорды чата.",
           "Every fish is an NFT in your wallet. /fish to cast, /fish_bag for your bag, "
           "/fish_shop for tackle, /fish_top for this chat's records."),
    ])


def shop(user, name, lang="ru"):
    """The tackle shop as the angler sees it, with a button per rod above theirs."""
    state = angler(user)
    mine = LADDER.index(state["gear"])
    current = GEAR[state["gear"]]
    lines = [tr(lang, "🛒 Снасти", "🛒 Tackle shop"),
             f"{name}: {current['emoji']} {gear_name(state['gear'], lang)} · 🐚 {state['shells']}", ""]
    buttons = []
    for index, key in enumerate(LADDER):
        gear = GEAR[key]
        reach = _reach(gear, lang)
        if key == STARTER:
            price = tr(lang, "даром", "free")
            what = tr(lang, f"только {reach}", f"{reach} only")
        else:
            price = f"{gear['price']} 🐚"
            what = tr(lang, f"до {reach}", f"up to {reach}")
        mark = " ✓" if index == mine else (" ·" if index < mine else "")
        title = tr(lang, gear["ru"], gear["en"])
        lines.append(f"{gear['emoji']} {title[0].upper() + title[1:]} — {price} · {what}{mark}")
        if index > mine:
            label = tr(lang, f"Купить {gear['emoji']} за {gear['price']} 🐚", f"Buy {gear['emoji']} for {gear['price']} 🐚")
            buttons.append([InlineKeyboardButton(label, callback_data=f"fishshop:{key}")])
    lines += ["", tr(lang,
                     f"Ракушки дают за каждый улов: мусор — {SHELLS['trash']} 🐚, рыба — от {SHELLS['common']} 🐚, "
                     "трофей — вдвое. Удочка покрепче держит рыбу крупнее и даёт дольше подсечь.",
                     f"Every catch pays shells: trash {SHELLS['trash']} 🐚, a fish from {SHELLS['common']} 🐚, "
                     "a trophy double. A stronger rod holds bigger fish and gives longer to strike.")]
    return "\n".join(lines), (InlineKeyboardMarkup(buttons) if buttons else None)


def _reach(gear, lang):
    """The rarest fish a rod holds: «★★☆☆☆ (необычная)» / «★★☆☆☆ uncommon»."""
    label = rarity_label(gear["holds"], lang)
    return f"{stars(gear['holds'])} " + tr(lang, f"({label})", label)


def bought_text(name, state, lang):
    gear = GEAR[state["gear"]]
    reach = _reach(gear, lang)
    return tr(lang,
              f"🛒 {name} теперь рыбачит: {gear['emoji']} {gear['ru']}. Держит рыбу до {reach}. Осталось 🐚 {state['shells']}.",
              f"🛒 {name} now fishes with a {gear['en']} {gear['emoji']}: holds fish up to {reach}. 🐚 {state['shells']} left.")


# --- handlers ----------------------------------------------------------------
def _name(user):
    """Full name, not @username: a top-10 list of @handles pings ten people."""
    return getattr(user, "full_name", None) or getattr(user, "first_name", None) or str(user.id)


def _detach(context, coro):
    application = getattr(context, "application", None)
    if application is not None:
        application.create_task(coro)
    else:
        asyncio.ensure_future(coro)


async def _float(bot, cast_id, chat_id, message_id, name, delay, gear_key=STARTER, lang="ru"):
    """The line sits, then bites, then — if nobody struck — the fish leaves.

    Detached from the handler: this bot's dispatcher is sequential, and a
    handler that slept through a bite would stall every other one.
    """
    await asyncio.sleep(delay)
    row = get_cast(cast_id)
    if not row or row["status"] != "waiting":
        return
    try:
        await bot.edit_message_text(chat_id=chat_id, message_id=message_id, text=biting_text(name, gear_key, lang),
                                    reply_markup=hook_markup(cast_id, gear_key, lang))
    except TelegramError:
        lose(cast_id)
        return
    # The window opens when the button is on screen, not when the task woke.
    bite(cast_id)
    await asyncio.sleep(GEAR[gear_key]["window"] + 0.5)
    if escape(cast_id):
        try:
            await bot.edit_message_text(chat_id=chat_id, message_id=message_id,
                                        text=escaped_text(name, gear_key, lang))
        except TelegramError:
            pass


async def fish_command(update, context):
    chat, user, msg = update.effective_chat, update.effective_user, update.effective_message
    if not chat or not msg:
        return
    lang = lang_of(update)
    if getattr(msg, "sender_chat", None) or not user or user.is_bot:
        await msg.reply_text(tr(lang, "Рыбачить можно только от своего аккаунта, а не от имени канала.",
                                "You can only fish from your own account, not as a channel."))
        return
    word = context.args[0].lower() if context.args else ""
    if word in ("help", "odds", "шансы", "помощь", "?"):
        await msg.reply_text(help_text(lang))
        return
    if word in ("shop", "магазин", "снасти"):
        await fish_shop_command(update, context)
        return
    name = _name(user)
    try:
        cast_id, delay = cast(chat.id, user.id, display_name=name, lang=lang)
    except ValueError as exc:
        await msg.reply_text(say(lang, exc))
        return
    gear_key = get_cast(cast_id)["gear"]
    try:
        sent = await msg.reply_text(waiting_text(name, gear_key, lang))
    except TelegramError:
        lose(cast_id)
        raise
    attach(cast_id, sent.message_id, msg.message_id)
    _detach(context, _float(context.bot, cast_id, chat.id, sent.message_id, name, delay, gear_key, lang))


async def fish_callback(update, context):
    query = update.callback_query
    match = re.fullmatch(r"fish:([0-9]+)", query.data or "")
    if not match:
        await query.answer()
        return
    try:
        row, catch = strike(int(match[1]), query.from_user.id)
    except ValueError as exc:
        await query.answer(say(lang_of(update), exc)[:200], show_alert=True)
        return
    bot = context.bot
    lang, gear_key = _lang(row), row.get("gear") or STARTER
    name = _angler_name(row, lang)
    if catch is None and row.get("got_away"):
        await query.answer(tr(lang, "Сорвалась — слишком крупная!", "Lost it — too big!"))
        await _edit(bot, row, too_big_text(name, gear_key, row["got_away"], lang))
        return
    if catch is None:
        await query.answer(tr(lang, "Поздно — ушла!", "Too late — it got away!"))
        await _edit(bot, row, escaped_text(name, gear_key, lang))
        return
    await query.answer(tr(lang, "Есть! Тянем…", "Got it! Reeling in…"))
    hint = upgrade_hint(angler(catch["user_id"]), lang)
    if catch["rarity"] == "trash":
        await _edit(bot, row, trash_text(catch, hint))
        return
    await land(bot, row, catch, hint)


async def _edit(bot, row, body, markup=None):
    try:
        await bot.edit_message_text(chat_id=row["chat_id"], message_id=row["message_id"], text=body,
                                    reply_markup=markup)
    except TelegramError:
        logger.info("fishing: could not edit cast %s", row["id"])


async def land(bot, row, catch, hint=None):
    """Show the fish: its picture, replying to the /fish that caught it, in
    place of the line's message. Text only if the chat refuses photos."""
    wallet = wallet_of(catch["user_id"])
    body = caption(catch, wallet, getattr(bot, "username", None), hint=hint)
    try:
        image = await asyncio.to_thread(picture, catch)
        sent = await bot.send_photo(
            chat_id=row["chat_id"], photo=image, caption=body,
            reply_to_message_id=row["command_message_id"], allow_sending_without_reply=True,
        )
    except TelegramError as exc:
        logger.info("fishing: photo refused for catch %s: %s", catch["id"], exc)
        await _edit(bot, row, body)
        return
    set_photo(catch["id"], sent.message_id)
    try:
        await bot.delete_message(chat_id=row["chat_id"], message_id=row["message_id"])
    except TelegramError:
        await _edit(bot, row, tr(_lang(catch), "🎣 Улов — ниже.", "🎣 The catch is below."))


async def fish_bag_command(update, context):
    user, msg = update.effective_user, update.effective_message
    if not user or not msg:
        return
    await msg.reply_text(bag(user.id, _name(user), lang_of(update)))


async def fish_shop_command(update, context):
    user, msg = update.effective_user, update.effective_message
    if not user or not msg:
        return
    body, markup = shop(user.id, _name(user), lang_of(update))
    await msg.reply_text(body, reply_markup=markup)


async def fish_shop_callback(update, context):
    query = update.callback_query
    match = re.fullmatch(r"fishshop:([a-z]+)", query.data or "")
    lang = lang_of(update)
    if not match:
        await query.answer()
        return
    buyer = query.from_user
    try:
        state = buy(buyer.id, match[1])
    except ValueError as exc:
        await query.answer(say(lang, exc)[:200], show_alert=True)
        return
    name = _name(buyer)
    await query.answer(tr(lang, "Куплено!", "Bought!"))
    body, markup = shop(buyer.id, name, lang)
    try:
        await query.edit_message_text(body, reply_markup=markup)
    except TelegramError:
        pass
    chat = update.effective_chat
    if chat is not None:
        try:
            await context.bot.send_message(chat_id=chat.id, text=bought_text(name, state, lang))
        except TelegramError as exc:
            logger.info("fishing: could not announce a purchase in %s: %s", chat.id, exc)


async def fish_top_command(update, context):
    chat, msg = update.effective_chat, update.effective_message
    if not chat or not msg:
        return
    lang = lang_of(update)
    if chat.type == "private":
        await msg.reply_text(tr(lang, "Рекорды — у каждого чата свои: /fish_top в группе. Ваш улов — /fish_bag",
                                "Records are per chat: /fish_top in a group. Your own catch: /fish_bag"))
        return
    await msg.reply_text(top(chat.id, lang))


async def _announce_delivery(bot, catch_id):
    """Turn the catch's caption into its NFT card. Quiet: an edit, no new message."""
    catch = get_catch(catch_id)
    if not catch or not catch["photo_message_id"]:
        return
    try:
        await bot.edit_message_caption(chat_id=catch["chat_id"], message_id=catch["photo_message_id"],
                                       caption=caption(catch, bot_username=getattr(bot, "username", None)),
                                       reply_markup=nft_markup(catch))
    except TelegramError as exc:
        logger.info("fishing: could not update the card of catch %s: %s", catch_id, exc)


async def loop(application):
    """Sweep forgotten casts and walk the NFT queue, forever."""
    chain = None
    while True:
        busy = False
        try:
            for row in sweep():
                if row["message_id"]:
                    await _edit(application.bot, row, lost_text(row))
            if FISHING_MINT and DEPLOYER_PK:
                chain = chain or Chain()
                delivered, busy = await asyncio.to_thread(advance, chain)
                for catch_id in delivered:
                    await _announce_delivery(application.bot, catch_id)
        except Exception:
            logger.exception("fishing: loop step failed")
        await asyncio.sleep(MINT_BUSY if busy else MINT_IDLE)
