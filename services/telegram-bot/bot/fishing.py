"""🎣 Fishing in the chat: places, bait, a bucket that fills, and loot that becomes NFTs.

`/fish` puts a line in the water at the angler's spot. A few seconds later
something bites and a button appears; press it within the rod's window and it
is yours. What comes up — fish, junk, treasure or a key, see
`bot.fishing_world` — goes into the bucket, drawn where and when it was caught
(`bot.fish_art`). A full bucket stops the line until it is sorted: each catch
is minted as a CyberiaNFT to the wallet linked with /set_wallet (then it can be
sold on the NFT market), or sold to the buyer on the shore for shells. Shells
buy rods, buckets, bait and energy drinks.

Everyone starts at the village pond with bare hands. Better spots need better
rods; the two high-level ones also need a key — the coastal chart, the Wired
keycard — held in the bucket or as an NFT in the linked wallet, and the Wired
takes only glitch bait. A key bought on the market opens the spot for its new
owner, which is the point of selling one.

After a landing the angler rests FISHING_COOLDOWN_SECONDS, across every chat;
a miss rests MISS_COOLDOWN. An ⚡ energy drink poured into the water wakes the
fish for the whole chat: everyone resting may cast there again at once.

Nothing is staked, so the catch is drawn by the bot's own `secrets` RNG. The
game lives in durable rows and the Telegram messages are views of them: a cast
is `waiting → biting → caught | escaped`, settled inside SQLite's `BEGIN
IMMEDIATE`, so the strike and the escape timer racing each other produce one
outcome. A cast remembers its spot, rod, bait and language. A cast whose task
died with a restart is swept to `lost` and costs nothing (its bait is gone).

The NFT side is a queue (`advance`) that moves a catch through `pending →
minting → minted → sending → delivered`. Each transaction's hash is written
down *before* it is broadcast, and only a receipt — or its absence for
DROPPED_AFTER — moves the row on, so a crash or a timed-out broadcast is
retried from what the chain says, not guessed at.
"""
import asyncio
import logging
import re
import secrets
import time
from datetime import datetime, timezone

from sqlalchemy import text
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, InputMediaPhoto
from telegram.error import TelegramError

from bot import fish_art
from bot import fishing_world as world
from bot.config import (
    CHAIN_ID, CYBERIA_NFT_ABI, CYBERIA_NFT_ADDRESS, DEPLOYER_PK, EXPLORER_URL,
    FISHING_COOLDOWN_SECONDS, FISHING_MINT, MINTED_TOPIC, NFT_MARKET_URL, RPC_URL,
)
from bot.db import _kv_get, _kv_set, engine
from bot.fishing_world import (  # noqa: F401 — the catalogue, re-exported for callers
    BAITS, BUCKETS, BUCKET_LADDER, ENERGY, GEAR, ITEMS, LADDER, RANK, RARITIES, SPECIES, SPOTS,
    SPOT_ORDER, START_SPOT, STARTER, STARTER_BUCKET, holds, kind_of, phase,
)
from bot.language import T, lang_of, say, tr
from bot.stakes import transaction

logger = logging.getLogger(__name__)

BITE_AFTER = (3.0, 12.0)   # seconds the line sits before it bites
MISS_COOLDOWN = 20         # after something that got away
STUCK = 120                # a cast nobody is watching any more
MINT_IDLE = 20             # queue poll with nothing in flight
MINT_BUSY = 5              # … and with a transaction on the wire
DROPPED_AFTER = 900        # no receipt for this long: the tx never landed
MAX_ATTEMPTS = 5
KEY_SEEN = 300             # how long a key found in a wallet is believed
KEY_MISSED = 60            # … and a key not found

COOLDOWN = FISHING_COOLDOWN_SECONDS
IN_TRANSIT = ("pending", "minting", "minted", "sending")
OWNER_OF_ABI = [{"inputs": [{"name": "tokenId", "type": "uint256"}], "name": "ownerOf",
                 "outputs": [{"name": "", "type": "address"}], "stateMutability": "view", "type": "function"}]


class Resting(ValueError):
    """Refused because the angler rests; carries the seconds left."""


class BucketFull(ValueError):
    """Refused because the bucket has no room."""


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
        _add_columns(conn, "fishing_casts", {"gear": "TEXT", "lang": "TEXT", "spot": "TEXT", "bait": "TEXT",
                                              "media": "INTEGER NOT NULL DEFAULT 0"})
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
        _add_columns(conn, "fishing_catches", {"gear": "TEXT", "lang": "TEXT", "kind": "TEXT", "spot": "TEXT",
                                                "phase": "TEXT", "bait": "TEXT"})
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
        _add_columns(conn, "fishing_anglers", {
            "spot": f"TEXT NOT NULL DEFAULT '{START_SPOT}'", "bucket": f"TEXT NOT NULL DEFAULT '{STARTER_BUCKET}'",
            "bait": "TEXT NOT NULL DEFAULT 'auto'", "energy": "INTEGER NOT NULL DEFAULT 0"})
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS fishing_baits (
                user_id INTEGER NOT NULL, bait TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, bait)
            )
        """))
        # The last ⚡ poured into a chat's water: rests begun before it are over.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS fishing_boosts (
                chat_id INTEGER PRIMARY KEY, at REAL NOT NULL, user_id INTEGER, user_name TEXT
            )
        """))


# --- the catch -----------------------------------------------------------------
def shells_for(catch):
    """What the buyer on the shore pays for this catch."""
    return world.price(catch)


def gear_of(row):
    """The rod a cast or catch was made with. Rows from before rods existed
    were made with one that held anything."""
    return GEAR.get((row or {}).get("gear") or "", GEAR["wired"])


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
    """A catch's name; things that are not fish carry their emoji."""
    thing = world.item(species)
    name = tr(lang, thing["ru"], thing["en"])
    return f"{thing['emoji']} {name}" if thing.get("emoji") else name


def gear_name(gear_key, lang):
    gear = GEAR[gear_key]
    return tr(lang, gear["ru"], gear["en"])


def spot_name(spot_key, lang):
    spot = SPOTS[spot_key]
    return f"{spot['emoji']} " + tr(lang, spot["ru"], spot["en"])


def phase_name(when, lang):
    info = world.PHASE_INFO[when]
    return f"{info['emoji']} " + tr(lang, info["ru"], info["en"])


def bait_name(bait_key, lang):
    bait = BAITS[bait_key]
    return f"{bait['emoji']} " + tr(lang, bait["ru"], bait["en"])


def picture(catch):
    """The catch's PNG. Rows from before places existed keep their old frame."""
    thing = world.item(catch["species"])
    rarity = RARITIES[catch["rarity"]]
    look, fill = thing.get("look"), 1.0
    if look:
        low, high = thing["kg"]
        size = max(0.0, min(1.0, (int(catch["grams"]) / 1000 - low) / (high - low))) ** 0.5
        fill = 0.86 + 0.14 * size
    if catch.get("spot") in SPOTS:
        return fish_art.render_loot(catch["spot"], catch.get("phase") or "day", catch["species"], rarity["colour"],
                                    rarity["stars"], int(catch["seed"]), look=look, fill=fill)
    return fish_art.render(look, rarity["colour"], rarity["stars"], int(catch["seed"]), fill)


def metadata(catch, image_uri):
    """ERC-721 metadata in the shape the marketplace renders. No angler or chat
    name: the token is public forever, its owner is already on chain."""
    thing, rarity = world.item(catch["species"]), RARITIES[catch["rarity"]]
    kind = kind_of(catch)
    caught = datetime.fromtimestamp(int(catch["caught_at"]), timezone.utc)
    spot = SPOTS.get(catch.get("spot") or "")
    where = f" at the {spot['en']}" if spot else ""
    when = f" at {world.PHASE_INFO[catch['phase']]['en']}" if catch.get("phase") in world.PHASE_INFO else ""
    attributes = [{"trait_type": "Kind", "value": world.KINDS[kind]["trait"]}]
    if kind == "fish":
        kg = f"{int(catch['grams']) / 1000:.2f}".rstrip("0").rstrip(".")
        name = f"{thing['en']} · {kg} kg"
        description = f"A {rarity['en']} {thing['en'].lower()} of {kg} kg, caught{where}{when}"
        attributes += [
            {"trait_type": "Species", "value": thing["en"]},
            {"trait_type": "Rarity", "value": rarity["en"]},
            {"trait_type": "Weight (g)", "value": int(catch["grams"]), "display_type": "number"},
            {"trait_type": "Trophy", "value": "yes" if catch["trophy"] else "no"},
        ]
    else:
        name = thing["en"]
        description = f"{thing['en']}, {rarity['en']} {world.KINDS[kind]['en']}, fished out{where}{when}"
        attributes += [{"trait_type": "Item", "value": thing["en"]}, {"trait_type": "Rarity", "value": rarity["en"]}]
    description += f" with the Cyberia Telegram bot on {caught:%Y-%m-%d}. Catch #{catch['id']}."
    if thing.get("opens"):
        opened = SPOTS[thing["opens"]]["en"]
        description += f" Whoever holds it may fish at the {opened}."
        attributes.append({"trait_type": "Opens", "value": opened})
    if spot:
        attributes.append({"trait_type": "Spot", "value": spot["en"]})
    if catch.get("phase") in world.PHASE_INFO:
        attributes.append({"trait_type": "Time of day", "value": world.PHASE_INFO[catch["phase"]]["en"]})
    attributes.append({"trait_type": "Caught", "value": f"{caught:%Y-%m-%d %H:%M} UTC"})
    if catch.get("gear") in GEAR:
        attributes.append({"trait_type": "Tackle", "value": GEAR[catch["gear"]]["en"].capitalize()})
    if catch.get("bait") in BAITS:
        attributes.append({"trait_type": "Bait", "value": BAITS[catch["bait"]]["en"].capitalize()})
    attributes.append({"trait_type": "Collection", "value": "Cyberia Fishing"})
    return {"name": name, "description": description, "image": image_uri, "attributes": attributes}


# --- the angler ------------------------------------------------------------------
def _angler(conn, user):
    row = conn.execute(text("SELECT * FROM fishing_anglers WHERE user_id=:u"), {"u": user}).mappings().first()
    row = dict(row) if row else {}
    return {
        "shells": int(row.get("shells") or 0),
        "gear": row.get("gear") if row.get("gear") in GEAR else STARTER,
        "spot": row.get("spot") if row.get("spot") in SPOTS else START_SPOT,
        "bucket": row.get("bucket") if row.get("bucket") in BUCKETS else STARTER_BUCKET,
        "bait": row.get("bait") if row.get("bait") in BAITS else "auto",
        "energy": int(row.get("energy") or 0),
    }


def _save(conn, user, now=None, **fields):
    conn.execute(text("INSERT OR IGNORE INTO fishing_anglers(user_id) VALUES(:u)"), {"u": user})
    fields["updated_at"] = int(time.time()) if now is None else int(now)
    sets = ", ".join(f"{name}=:{name}" for name in fields)
    conn.execute(text(f"UPDATE fishing_anglers SET {sets} WHERE user_id=:u"), {**fields, "u": user})


def angler(user):
    """{shells, gear, spot, bucket, bait, energy} — a newcomer's defaults included."""
    with engine.connect() as conn:
        return _angler(conn, user)


def _stock(conn, user):
    return {bait: int(count) for bait, count in conn.execute(
        text("SELECT bait, count FROM fishing_baits WHERE user_id=:u AND count>0"), {"u": user})}


def bait_stock(user):
    with engine.connect() as conn:
        return _stock(conn, user)


def _bucket_rows(conn, user):
    return [dict(row) for row in conn.execute(text(
        "SELECT * FROM fishing_catches WHERE user_id=:u AND nft_status='bucket' ORDER BY id"
    ), {"u": user}).mappings()]


def bucket(user):
    """The catches in the angler's bucket, oldest first."""
    with engine.connect() as conn:
        return _bucket_rows(conn, user)


def affordable_upgrade(state):
    """The next rod up, if the angler already has the shells for it."""
    upgrade = world.next_in(LADDER, state["gear"])
    return upgrade if upgrade and state["shells"] >= GEAR[upgrade]["price"] else None


def buy(user, what, key=None, now=None):
    """Buy with shells: a rod, a bucket, a pack of bait or an energy drink.
    Returns the angler afterwards; refusals are ValueErrors carrying a T."""
    with transaction() as conn:
        state = _angler(conn, user)
        if what == "rod":
            if key not in GEAR or key == STARTER:
                raise ValueError(T("Такой удочки нет.", "There is no such rod."))
            if LADDER.index(state["gear"]) >= LADDER.index(key):
                raise ValueError(T("У вас уже есть удочка не хуже.", "You already have a rod at least this good."))
            cost, change = GEAR[key]["price"], {"gear": key}
        elif what == "bucket":
            if key not in BUCKETS or key == STARTER_BUCKET:
                raise ValueError(T("Такой ёмкости нет.", "There is no such container."))
            if BUCKET_LADDER.index(state["bucket"]) >= BUCKET_LADDER.index(key):
                raise ValueError(T("У вас уже есть ёмкость не меньше.", "You already have one at least this big."))
            cost, change = BUCKETS[key]["price"], {"bucket": key}
        elif what == "bait":
            if key not in BAITS:
                raise ValueError(T("Такой наживки нет.", "There is no such bait."))
            cost, change = BAITS[key]["price"], {}
        elif what == "energy":
            cost, change = ENERGY["price"], {"energy": state["energy"] + 1}
        else:
            raise ValueError(T("Такого товара нет.", "There is no such thing for sale."))
        if state["shells"] < cost:
            raise ValueError(T(
                f"Не хватает ракушек: нужно {cost} 🐚, у вас {state['shells']}. Продайте улов скупщику: /fish_bucket",
                f"Not enough shells: {cost} 🐚 needed, you have {state['shells']}. Sell some catch: /fish_bucket",
            ))
        _save(conn, user, now, shells=state["shells"] - cost, **change)
        if what == "bait":
            conn.execute(text("""
                INSERT INTO fishing_baits(user_id, bait, count) VALUES(:u, :b, :n)
                ON CONFLICT(user_id, bait) DO UPDATE SET count=fishing_baits.count + excluded.count
            """), {"u": user, "b": key, "n": BAITS[key]["pack"]})
        return _angler(conn, user)


def choose_bait(user, bait):
    """Which bait goes on the hook from now on; 'auto' lets the spot decide."""
    if bait != "auto" and bait not in BAITS:
        raise ValueError(T("Такой наживки нет.", "There is no such bait."))
    with transaction() as conn:
        _save(conn, user, bait=bait)
        return _angler(conn, user)


# --- keys and places ----------------------------------------------------------------
_key_memory = {}


def _owner_of(token_id):
    from web3 import Web3

    w3 = Web3(Web3.HTTPProvider(RPC_URL, request_kwargs={"timeout": 10}))
    nft = w3.eth.contract(address=Web3.to_checksum_address(CYBERIA_NFT_ADDRESS), abi=OWNER_OF_ABI)
    return nft.functions.ownerOf(int(token_id)).call()


def holds_key(user, key, now=None, owner_of=None):
    """Does this angler hold the key — caught and not yet minted or sold, on
    its way to their wallet, or as an NFT in the wallet they linked (whoever
    caught it: a key bought on the market counts). Blocking: it may ask the chain."""
    now = time.time() if now is None else now
    with engine.connect() as conn:
        if conn.execute(text(
            "SELECT 1 FROM fishing_catches WHERE user_id=:u AND species=:k AND nft_status IN "
            "('bucket','pending','minting','minted','sending') LIMIT 1"
        ), {"u": user, "k": key}).first():
            return True
        wallet = _wallet(conn, user)
        tokens = conn.execute(text(
            "SELECT token_id FROM fishing_catches WHERE species=:k AND nft_status='delivered' AND token_id IS NOT NULL "
            "ORDER BY id DESC LIMIT 50"
        ), {"k": key}).scalars().all()
    if not wallet or not tokens:
        return False
    remembered = _key_memory.get((user, key, wallet.lower()))
    if remembered and remembered[0] > now:
        return remembered[1]
    owner_of = owner_of or _owner_of
    found = False
    for token in tokens:
        try:
            if str(owner_of(token)).lower() == wallet.lower():
                found = True
                break
        except Exception as exc:  # a token the node can't answer for is not a key in hand
            logger.info("fishing: ownerOf(%s) failed: %s", token, exc)
    _key_memory[(user, key, wallet.lower())] = (now + (KEY_SEEN if found else KEY_MISSED), found)
    return found


def keys_held(user, owner_of=None):
    """{key item: held?} for every key that opens a spot."""
    return {spot["key"]: holds_key(user, spot["key"], owner_of=owner_of) for spot in SPOTS.values() if spot["key"]}


def blockers(spot_key, state, stock, keys):
    """What stands between this angler and the spot, as T texts; empty = open."""
    spot, missing = SPOTS[spot_key], []
    if LADDER.index(state["gear"]) < LADDER.index(spot["rod"]):
        rod = GEAR[spot["rod"]]
        missing.append(T(f"{rod['emoji']} {rod['ru']}", f"{rod['emoji']} {rod['en']}"))
    if spot["key"] and not keys.get(spot["key"]):
        key = ITEMS[spot["key"]]
        missing.append(T(f"{key['emoji']} {key['ru']}", f"{key['emoji']} {key['en']}"))
    if spot["bait"] and stock.get(spot["bait"], 0) <= 0:
        bait = BAITS[spot["bait"]]
        missing.append(T(f"{bait['emoji']} {bait['ru']}", f"{bait['emoji']} {bait['en']}"))
    return missing


def travel(user, spot_key, keys):
    """Move the angler to a spot they are ready for. `keys` is keys_held()."""
    if spot_key not in SPOTS:
        raise ValueError(T("Такого места нет.", "There is no such place."))
    with transaction() as conn:
        state, stock = _angler(conn, user), _stock(conn, user)
        missing = blockers(spot_key, state, stock, keys)
        if missing:
            raise ValueError(T("Туда пока не попасть. Нужно: " + ", ".join(m.ru for m in missing) + ".",
                               "You can't get there yet. You need: " + ", ".join(m.en for m in missing) + "."))
        _save(conn, user, spot=spot_key)
        return _angler(conn, user)


# --- a cast ----------------------------------------------------------------------
def _cast(conn, cast_id):
    return conn.execute(text("SELECT * FROM fishing_casts WHERE id=:id"), {"id": cast_id}).mappings().first()


def get_cast(cast_id):
    with engine.connect() as conn:
        row = _cast(conn, cast_id)
    return dict(row) if row else None


def _wait(seconds, lang="ru"):
    seconds = max(1, int(seconds))
    if seconds < 60:
        return f"{seconds} " + tr(lang, "с", "s")
    return f"{-(-seconds // 60)} " + tr(lang, "мин", "min")


def _boost(conn, chat):
    row = conn.execute(text("SELECT * FROM fishing_boosts WHERE chat_id=:c"), {"c": chat}).mappings().first()
    return dict(row) if row else None


def cast(chat, user, display_name=None, now=None, rng=None, lang="ru", keys=None):
    """Put a line in the water at the angler's spot. Returns (cast id, seconds
    until the bite). `keys` is keys_held() when the spot needs one.

    Refuses while this account's line is already in the water anywhere, during
    its rest (unless ⚡ was poured into this chat since it began), with a full
    bucket, and at a spot the angler is no longer ready for. The bait goes on
    the hook — and is spent — here.
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
            boost = _boost(conn, chat)
            if not (boost and boost["at"] >= (last["bit_at"] or last["created_at"])):
                left = last["ready_at"] - now
                raise Resting(T(f"Рыба отдыхает. Следующий заброс через {_wait(left, 'ru')}.",
                                f"The fish are resting. Next cast in {_wait(left, 'en')}."), left)
        state, stock = _angler(conn, user), _stock(conn, user)
        room = BUCKETS[state["bucket"]]["size"]
        if len(_bucket_rows(conn, user)) >= room:
            raise BucketFull(T(f"Ведро полное ({room}/{room}). Выпустите улов в NFT или продайте скупщику: /fish_bucket",
                               f"The bucket is full ({room}/{room}). Mint the catch or sell it: /fish_bucket"))
        missing = blockers(state["spot"], state, stock, keys or {})
        if missing:
            spot = SPOTS[state["spot"]]
            raise ValueError(T(
                f"На {spot['ru']} сейчас не попасть — нужно: " + ", ".join(m.ru for m in missing)
                + ". Другие места: /fish_spots",
                f"You can't fish at the {spot['en']} now — you need: " + ", ".join(m.en for m in missing)
                + ". Other places: /fish_spots"))
        bait = None if state["gear"] == STARTER else world.pick_bait(
            state["spot"], stock, None if state["bait"] == "auto" else state["bait"])
        if bait:
            conn.execute(text("UPDATE fishing_baits SET count=count-1 WHERE user_id=:u AND bait=:b"),
                         {"u": user, "b": bait})
        delay = rng.uniform(*BITE_AFTER)
        return conn.execute(text("""
            INSERT INTO fishing_casts(chat_id,user_id,user_name,status,created_at,bite_at,gear,lang,spot,bait)
            VALUES(:c,:u,:name,'waiting',:t,:b,:g,:l,:s,:bait) RETURNING id
        """), {"c": chat, "u": user, "name": display_name, "t": now, "b": now + delay,
               "g": state["gear"], "l": lang, "s": state["spot"], "bait": bait}).scalar_one(), delay


def attach(cast_id, message_id, command_message_id=None, media=False):
    with engine.begin() as conn:
        conn.execute(text("UPDATE fishing_casts SET message_id=:m, command_message_id=:o, media=:media WHERE id=:id"),
                     {"m": message_id, "o": command_message_id, "media": int(bool(media)), "id": cast_id})


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
    """A cast whose message could not be shown: no catch, no rest."""
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
    too late, or too heavy for the rod (then the cast carries `got_away`).

    Refusals are ValueErrors carrying a T for the presser. The check and the
    catch are one transaction, so the escape timer cannot also fire. A landed
    catch goes into the bucket; a can of ⚡ goes into the pocket.
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

        spot, when = row["spot"] or START_SPOT, phase(now)
        hooked = world.roll(spot, when, row["bait"], bare=row["gear"] == STARTER, rng=rng)
        if RANK[hooked["rarity"]] > RANK[gear_of(row)["holds"]]:
            conn.execute(text("UPDATE fishing_casts SET status='escaped', ready_at=:r WHERE id=:id"),
                         {"r": int(now) + MISS_COOLDOWN, "id": cast_id})
            return dict(row, status="escaped", got_away=hooked), None

        energy = hooked["kind"] == "energy"
        catch_id = conn.execute(text("""
            INSERT INTO fishing_catches(cast_id,chat_id,user_id,user_name,species,rarity,grams,trophy,seed,
                                        caught_at,nft_status,gear,lang,kind,spot,phase,bait)
            VALUES(:cast,:c,:u,:name,:s,:r,:g,:t,:seed,:at,:nft,:gear,:lang,:kind,:spot,:phase,:bait) RETURNING id
        """), {"cast": cast_id, "c": row["chat_id"], "u": user, "name": row["user_name"],
               "s": hooked["species"], "r": hooked["rarity"], "g": hooked["grams"], "t": hooked["trophy"],
               "seed": hooked["seed"], "at": int(now), "nft": "pocket" if energy else "bucket",
               "gear": row["gear"], "lang": row["lang"], "kind": hooked["kind"], "spot": spot, "phase": when,
               "bait": row["bait"]}).scalar_one()
        if energy:
            _save(conn, user, now, energy=_angler(conn, user)["energy"] + 1)
        else:
            conn.execute(text("INSERT OR IGNORE INTO fishing_anglers(user_id) VALUES(:u)"), {"u": user})
        conn.execute(text("UPDATE fishing_casts SET status='caught', ready_at=:r WHERE id=:id"),
                     {"r": int(now) + COOLDOWN, "id": cast_id})
        catch = conn.execute(text("SELECT * FROM fishing_catches WHERE id=:id"), {"id": catch_id}).mappings().first()
        return dict(row, status="caught"), dict(catch)


def pour(chat, user, display_name=None, now=None):
    """⚡ into the water: rests begun before now are over for everyone casting
    in this chat. Uses a can from the pocket, or buys one on the spot.
    Returns the angler afterwards."""
    now = time.time() if now is None else now
    with transaction() as conn:
        state = _angler(conn, user)
        if state["energy"] > 0:
            _save(conn, user, now, energy=state["energy"] - 1)
        elif state["shells"] >= ENERGY["price"]:
            _save(conn, user, now, shells=state["shells"] - ENERGY["price"])
        else:
            raise ValueError(T(
                f"Нет энергетика, а на новый нужно {ENERGY['price']} 🐚 (у вас {state['shells']}). "
                "Продайте улов: /fish_bucket",
                f"No energy drink, and a new one costs {ENERGY['price']} 🐚 (you have {state['shells']}). "
                "Sell some catch: /fish_bucket"))
        conn.execute(text("""
            INSERT INTO fishing_boosts(chat_id, at, user_id, user_name) VALUES(:c, :t, :u, :n)
            ON CONFLICT(chat_id) DO UPDATE SET at=excluded.at, user_id=excluded.user_id, user_name=excluded.user_name
        """), {"c": chat, "t": now, "u": user, "n": display_name})
        return _angler(conn, user)


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


# --- emptying the bucket --------------------------------------------------------
def _owned_bucket(conn, user, catch_ids):
    rows = _bucket_rows(conn, user)
    if catch_ids is None:
        return rows
    wanted = {int(catch_id) for catch_id in catch_ids}
    return [row for row in rows if row["id"] in wanted]


def sell(user, catch_ids=None, now=None):
    """Sell catches from the bucket to the buyer on the shore (None: all of
    them). Returns (shells paid, catches sold)."""
    with transaction() as conn:
        rows = _owned_bucket(conn, user, catch_ids)
        if not rows:
            raise ValueError(T("Этого в ведре уже нет.", "That is no longer in the bucket."))
        paid = sum(shells_for(row) for row in rows)
        for row in rows:
            conn.execute(text("UPDATE fishing_catches SET nft_status='sold' WHERE id=:id AND nft_status='bucket'"),
                         {"id": row["id"]})
        _save(conn, user, now, shells=_angler(conn, user)["shells"] + paid)
        return paid, rows


def mint(user, catch_ids=None):
    """Send catches from the bucket to be minted into the linked wallet (None:
    all of them). Returns the catches queued."""
    with transaction() as conn:
        if not _wallet(conn, user):
            raise ValueError(T("Сначала привяжите кошелёк: /set_wallet 0x… в личке бота.",
                               "Link a wallet first: /set_wallet 0x… in a DM to the bot."))
        rows = _owned_bucket(conn, user, catch_ids)
        if not rows:
            raise ValueError(T("Этого в ведре уже нет.", "That is no longer in the bucket."))
        for row in rows:
            conn.execute(text("UPDATE fishing_catches SET nft_status='pending' WHERE id=:id AND nft_status='bucket'"),
                         {"id": row["id"]})
        return rows


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


def _bare(gear_key):
    return (gear_key or STARTER) == STARTER


def place_line(spot_key, when, lang):
    return f"📍 {spot_name(spot_key, lang)} · {phase_name(when, lang)}"


def loot_line(row, lang):
    """★★☆☆☆ Щука, 4,8 кг 🏆 / ★★★☆☆ 🍾 Бутылка с запиской"""
    line = f"{stars(row['rarity'])} {fish_name(row['species'], lang)}"
    if kind_of(row) == "fish" and int(row.get("grams") or 0):
        line += f", {weight(row['grams'], lang)}"
    return line + (" 🏆" if row.get("trophy") else "")


def nft_line(catch, wallet=None, bot_username=None, minting=None, lang="ru"):
    minting = (FISHING_MINT and bool(DEPLOYER_PK)) if minting is None else minting
    status = catch["nft_status"]
    if status == "delivered":
        short = _short(catch["recipient"])
        return tr(lang, f"🖼 NFT #{catch['token_id']} — в кошельке {short}", f"🖼 NFT #{catch['token_id']} — in wallet {short}")
    if status == "sold":
        return tr(lang, f"🐚 Продано скупщику за {shells_for(catch)} 🐚.", f"🐚 Sold to the buyer for {shells_for(catch)} 🐚.")
    if status == "bucket":
        return tr(lang, f"🪣 В ведре. Выпустить NFT или продать скупщику за {shells_for(catch)} 🐚?",
                  f"🪣 In the bucket. Mint it as an NFT, or sell it for {shells_for(catch)} 🐚?")
    if status == "failed":
        return tr(lang, "NFT не получился — улов сохранён, разберёмся.",
                  "The NFT didn't work out — the catch is kept, we'll look into it.")
    if not minting:
        return tr(lang, "NFT отправим, когда включим чеканку.", "The NFT goes out once minting is switched on.")
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


def caption(catch, wallet=None, bot_username=None, minting=None, lang=None, hint=None, room=None):
    """The card under a catch's picture, for whatever has become of it."""
    lang = lang or _lang(catch)
    gear = gear_of(catch)
    name = _angler_name(catch, lang)
    kind = kind_of(catch)
    lines = [
        f"{gear['emoji']} " + tr(lang, f"Улов — {name}", f"Catch — {name}"),
        loot_line(catch, lang) + (tr(lang, " трофей", " trophy") if catch.get("trophy") else ""),
        kind_line(kind, catch["rarity"], lang),
    ]
    if catch.get("spot") in SPOTS:
        lines.append(place_line(catch["spot"], catch.get("phase") or "day", lang))
    opens = world.item(catch["species"]).get("opens")
    if opens and catch["nft_status"] != "sold":
        lines.append(tr(lang, f"🗝 Ключ: пока он у вас — в ведре или NFT в кошельке, — открыт {spot_name(opens, 'ru')}.",
                        f"🗝 A key: while you hold it — in the bucket or as an NFT in your wallet — "
                        f"the {spot_name(opens, 'en')} is open to you."))
    lines += ["", nft_line(catch, wallet, bot_username, minting, lang)]
    if room:
        lines.append(tr(lang, f"🪣 Ведро: {room[0]}/{room[1]} — /fish_bucket", f"🪣 Bucket: {room[0]}/{room[1]} — /fish_bucket"))
    if hint:
        lines.append(hint)
    return "\n".join(lines)


def kind_line(kind, rarity, lang):
    """«редкая рыба», but «хлам, редкость: обычная» — the labels agree with рыба only."""
    label, noun = rarity_label(rarity, lang), world.KINDS[kind]
    if lang == "ru":
        return f"{label} рыба" if kind == "fish" else f"{noun['ru'].capitalize()}, редкость: {label}"
    return f"{label} {noun['en']}"


def market_url(token_id):
    return f"{NFT_MARKET_URL}?token={token_id}"


def nft_markup(catch, lang=None):
    if catch["nft_status"] != "delivered" or catch["token_id"] is None:
        return None
    lang = lang or _lang(catch)
    explorer = f"{EXPLORER_URL}/token/{CYBERIA_NFT_ADDRESS}/instance/{catch['token_id']}"
    return InlineKeyboardMarkup([[
        InlineKeyboardButton(tr(lang, "🏷 Продать на маркете", "🏷 Sell on the market"), url=market_url(catch["token_id"])),
        InlineKeyboardButton(tr(lang, "Открыть NFT", "Open NFT"), url=explorer),
    ]])


def catch_markup(catch, lang=None):
    """Under a fresh catch: mint it or sell it, right there."""
    if catch["nft_status"] != "bucket":
        return nft_markup(catch, lang)
    lang = lang or _lang(catch)
    return InlineKeyboardMarkup([[
        InlineKeyboardButton(tr(lang, "🖼 В NFT", "🖼 Mint NFT"), callback_data=f"fishb:m:{catch['id']}"),
        InlineKeyboardButton(tr(lang, f"🐚 Продать за {shells_for(catch)}", f"🐚 Sell for {shells_for(catch)}"),
                             callback_data=f"fishb:s:{catch['id']}"),
    ]])


def bait_line(cast_row, left, lang):
    if _bare(cast_row.get("gear")):
        return None
    if cast_row.get("bait"):
        return tr(lang, f"🪝 Наживка: {bait_name(cast_row['bait'], lang)} (осталось {left})",
                  f"🪝 Bait: {bait_name(cast_row['bait'], lang)} ({left} left)")
    return tr(lang, "🪝 Пустой крючок — без наживки тянется хлам. Наживки: /fish_shop",
              "🪝 An empty hook — without bait it drags up junk. Bait: /fish_shop")


def waiting_text(name, gear_key=STARTER, lang="ru", place=None, bait=None):
    if _bare(gear_key):
        lines = [tr(lang, f"✋ {name} заходит в воду по колено и ждёт рыбу…",
                    f"✋ {name} wades in knee-deep and waits for a fish…")]
        hint = tr(lang, "Как подплывёт — хватайте!", "Grab it when it swims up!")
    else:
        gear = GEAR[gear_key]
        lines = [tr(lang, f"{gear['emoji']} {name} закидывает {gear['ru_acc']}…",
                    f"{gear['emoji']} {name} casts the {gear['en']}…")]
        hint = tr(lang, "Ждите поклёвку и жмите «Подсечь».", "Wait for the bite, then press «Strike».")
    return "\n".join(line for line in (*lines, place, bait, hint) if line)


def biting_text(name, gear_key=STARTER, lang="ru", place=None):
    gear = GEAR[gear_key or STARTER]
    window = f"{gear['window']:g}"
    if _bare(gear_key):
        head = tr(lang, f"✋ Рыба у самых ног, {name}!\n〰️〰️🫧🐟🫧〰️〰️\nХватайте — {window} секунд!",
                  f"✋ A fish right at your feet, {name}!\n〰️〰️🫧🐟🫧〰️〰️\nGrab it — {window} seconds!")
    else:
        head = tr(lang, f"{gear['emoji']} {name}, клюёт!\n〰️〰️🫧🔴🫧〰️〰️\nПодсекайте — {window} секунд!",
                  f"{gear['emoji']} It's biting, {name}!\n〰️〰️🫧🔴🫧〰️〰️\nStrike — {window} seconds!")
    return "\n".join(line for line in (head, place) if line)


def escaped_text(name, gear_key=STARTER, lang="ru"):
    if _bare(gear_key):
        return tr(lang, f"✋ {name}: рыба выскользнула — не успели схватить.\nЕщё раз: /fish",
                  f"✋ It slipped away from {name} — too slow.\nAgain: /fish")
    return tr(lang, f"🎣 {name}: сорвалась — не успели подсечь.\nЕщё раз: /fish",
              f"🎣 It got away from {name} — the strike came too late.\nAgain: /fish")


def too_big_text(name, gear_key, hooked, lang="ru"):
    """Loot the rod cannot hold: what it was, and where the rod is."""
    gear = GEAR[gear_key or STARTER]
    thing = f"{fish_name(hooked['species'], lang)} {stars(hooked['rarity'])}"
    weak = tr(lang, gear["weak_ru"], gear["weak_en"])
    if hooked.get("kind", "fish") == "fish":
        head = tr(lang, f"💥 {name}: сорвался крупный улов — {thing}!", f"💥 {name} lost a big one — {thing}!")
    else:
        head = tr(lang, f"💥 {name}: что-то тяжёлое зацепилось и ушло на дно — {thing}!",
                  f"💥 {name}: something heavy caught on and sank back — {thing}!")
    return f"{head}\n{weak}. " + tr(lang, "Снасть покрепче — /fish_shop", "Better tackle: /fish_shop")


def energy_text(catch, state, lang=None):
    lang = lang or _lang(catch)
    name = _angler_name(catch, lang)
    return tr(lang,
              f"⚡ {name} достаёт из воды нераспечатанный энергетик! В кармане: ⚡ {state['energy']}.\n"
              "Вылить его в воду — /fish ⚡: рыба проснётся, и отдых закончится у всего чата.",
              f"⚡ {name} fishes out an unopened energy drink! In the pocket: ⚡ {state['energy']}.\n"
              "Pour it into the water — /fish ⚡: the fish wake up and everyone in the chat stops resting.")


def lost_text(row):
    lang = _lang(row)
    if _bare(row.get("gear")):
        return tr(lang, "✋ Рыба уплыла — заходите снова: /fish", "✋ The fish swam off — try again: /fish")
    return tr(lang, "🎣 Леска оборвалась — закидывайте снова: /fish", "🎣 The line snapped — cast again: /fish")


def hook_markup(cast_id, gear_key=STARTER, lang="ru"):
    label = tr(lang, "✋ Хватать!", "✋ Grab!") if _bare(gear_key) else tr(lang, "🪝 Подсечь", "🪝 Strike")
    return InlineKeyboardMarkup([[InlineKeyboardButton(label, callback_data=f"fish:{cast_id}")]])


def resting_markup(lang, state):
    have = state["energy"]
    label = (tr(lang, f"⚡ Вылить энергетик (есть {have})", f"⚡ Pour an energy drink ({have} left)") if have
             else tr(lang, f"⚡ Энергетик за {ENERGY['price']} 🐚 — в воду", f"⚡ Energy drink, {ENERGY['price']} 🐚 — pour it"))
    return InlineKeyboardMarkup([[InlineKeyboardButton(label, callback_data="fishpour")]])


def poured_text(name, lang):
    return tr(lang,
              f"⚡ {name} выливает энергетик в воду — рыба проснулась!\nВсе, кто отдыхал, могут закидывать снова: /fish",
              f"⚡ {name} pours an energy drink into the water — the fish are wide awake!\n"
              "Everyone who was resting may cast again: /fish")


def _ranked(rows):
    return sorted(rows, key=lambda row: (-RANK[row["rarity"]], -int(row["grams"]), row["id"]))


def bucket_view(user, name, lang, rows=None):
    """The bucket with a button pair per catch and two for everything."""
    state = angler(user)
    rows = bucket(user) if rows is None else rows
    room = BUCKETS[state["bucket"]]
    head = tr(lang, f"{room['emoji']} {room['ru'].capitalize()} {name}: {len(rows)}/{room['size']}",
              f"{room['emoji']} {name}'s {room['en']}: {len(rows)}/{room['size']}")
    if not rows:
        return "\n".join([head, "", tr(lang, "Пусто. Закидывайте: /fish", "Empty. Go fishing: /fish")]), None
    lines, buttons = [head, ""], []
    shown = rows[:8]
    for index, row in enumerate(shown, 1):
        lines.append(f"{index}. {loot_line(row, lang)} — {shells_for(row)} 🐚")
        buttons.append([
            InlineKeyboardButton(f"🖼 {index}", callback_data=f"fishb:m:{row['id']}"),
            InlineKeyboardButton(f"🐚 {index}: +{shells_for(row)}", callback_data=f"fishb:s:{row['id']}"),
        ])
    if len(rows) > len(shown):
        lines.append(tr(lang, f"…и ещё {len(rows) - len(shown)}", f"…and {len(rows) - len(shown)} more"))
    total = sum(shells_for(row) for row in rows)
    lines += ["", tr(lang,
                     f"🖼 — выпустить NFT в кошелёк (бесплатно), потом его можно продать на маркете.\n"
                     f"🐚 — продать скупщику. Всё ведро: {total} 🐚.",
                     f"🖼 — mint an NFT to your wallet (free), then sell it on the market if you like.\n"
                     f"🐚 — sell to the buyer. The whole bucket: {total} 🐚.")]
    buttons.append([
        InlineKeyboardButton(tr(lang, "🖼 Всё в NFT", "🖼 Mint all"), callback_data=f"fishb:M:{user}"),
        InlineKeyboardButton(tr(lang, f"🐚 Продать всё +{total}", f"🐚 Sell all +{total}"), callback_data=f"fishb:S:{user}"),
    ])
    return "\n".join(lines), InlineKeyboardMarkup(buttons)


def tackle_line(state, lang):
    gear = GEAR[state["gear"]]
    return tr(lang, f"{gear['emoji']} Снасть: {gear['ru']} · 🐚 {state['shells']}",
              f"{gear['emoji']} Tackle: {gear['en']} · 🐚 {state['shells']}")


def bag(user, name=None, lang="ru"):
    """The angler: shells, tackle, bucket, bait, place, keys and best catches."""
    with engine.connect() as conn:
        rows = [dict(row) for row in conn.execute(text(
            "SELECT * FROM fishing_catches WHERE user_id=:u AND rarity!='trash' AND nft_status!='pocket'"
        ), {"u": user}).mappings()]
        wallet = _wallet(conn, user)
        state, stock = _angler(conn, user), _stock(conn, user)
    room = BUCKETS[state["bucket"]]
    in_bucket = sum(1 for row in rows if row["nft_status"] == "bucket")
    minted = sum(1 for row in rows if row["nft_status"] == "delivered")
    gear = GEAR[state["gear"]]
    baits = ", ".join(f"{BAITS[key]['emoji']} {count}" for key, count in stock.items()) or tr(lang, "нет", "none")
    choice = tr(lang, "авто", "auto") if state["bait"] == "auto" else bait_name(state["bait"], lang)
    lines = [
        f"🎒 {name}" if name else "🎒",
        tr(lang, f"🐚 {state['shells']} · ⚡ {state['energy']}", f"🐚 {state['shells']} · ⚡ {state['energy']}"),
        tr(lang, f"{gear['emoji']} Удочка: {gear['ru']}", f"{gear['emoji']} Rod: {gear['en']}"),
        tr(lang, f"{room['emoji']} {room['ru'].capitalize()}: {in_bucket}/{room['size']}",
           f"{room['emoji']} {room['en'].capitalize()}: {in_bucket}/{room['size']}"),
        tr(lang, f"🪝 Наживки: {baits} · насаживать: {choice}", f"🪝 Bait: {baits} · on the hook: {choice}"),
        place_line(state["spot"], phase(time.time()), lang),
        tr(lang, f"🖼 NFT: {minted}", f"🖼 NFTs: {minted}"),
    ]
    hint = upgrade_hint(state, lang)
    if hint:
        lines.append(hint)
    fish = _ranked([row for row in rows if kind_of(row) == "fish"])[:5]
    finds = _ranked([row for row in rows if kind_of(row) != "fish"])[:5]
    for title, picked in ((tr(lang, "Лучшая рыба:", "Best fish:"), fish), (tr(lang, "Лучшие находки:", "Best finds:"), finds)):
        if picked:
            lines += ["", title]
            for index, row in enumerate(picked, 1):
                if row["nft_status"] == "delivered":
                    tag = f"NFT #{row['token_id']}"
                elif row["nft_status"] == "bucket":
                    tag = tr(lang, "в ведре", "in the bucket")
                elif row["nft_status"] == "sold":
                    tag = tr(lang, "продано", "sold")
                elif row["nft_status"] == "pending" and not wallet:
                    tag = tr(lang, "ждёт кошелька", "waiting for a wallet")
                else:
                    tag = tr(lang, "чеканится", "minting")
                lines.append(f"{index}. {loot_line(row, lang)} — {tag}")
    if not rows:
        lines += ["", tr(lang, "Пока ничего не поймано. Первая рыба ждёт: /fish", "Nothing caught yet. Your first fish awaits: /fish")]
    return "\n".join(lines)


def bait_markup(user, lang):
    """Which bait goes on the hook: auto, or one the angler has."""
    state, stock = angler(user), bait_stock(user)
    options = [("auto", tr(lang, "🎯 авто", "🎯 auto"))] + [
        (key, f"{BAITS[key]['emoji']} {count}") for key, count in stock.items()]
    if len(options) < 2:
        return None
    row = [InlineKeyboardButton(("✓ " if state["bait"] == key else "") + label, callback_data=f"fishbait:{key}:{user}")
           for key, label in options]
    return InlineKeyboardMarkup([row[i:i + 4] for i in range(0, len(row), 4)])


def top(chat, lang="ru"):
    """The chat's best fish."""
    with engine.connect() as conn:
        rows = [dict(row) for row in conn.execute(text(
            "SELECT * FROM fishing_catches WHERE chat_id=:c AND rarity!='trash' AND nft_status!='pocket'"
        ), {"c": chat}).mappings()]
    rows = [row for row in rows if kind_of(row) == "fish"]
    if not rows:
        return tr(lang, "🏆 Здесь ещё никто ничего не поймал. Первым будет тот, кто напишет /fish",
                  "🏆 Nobody has caught anything here yet. The first will be whoever sends /fish")
    lines = [tr(lang, "🏆 Рекорды чата", "🏆 This chat's records"), ""]
    for index, row in enumerate(_ranked(rows)[:10], 1):
        lines.append(f"{index}. {loot_line(row, lang)} — {_angler_name(row, lang)}")
    return "\n".join(lines)


def odds(spot_key, when, bait=None, bare=False, gear_key=None, lang="ru"):
    """What bites here now, with this bait, most likely first."""
    lines = []
    for key, share in sorted(world.chances(spot_key, when, bait, bare).items(), key=lambda item: -item[1]):
        thing = ITEMS[key]
        percent = f"{share * 100:.1f}".rstrip("0").rstrip(".")
        percent = tr(lang, percent.replace(".", ","), percent)
        lock = "" if not gear_key or holds(gear_key, thing["rarity"]) else f" 🔒{GEAR[world.first_gear_for(thing['rarity'])]['emoji']}"
        lines.append(f"{stars(thing['rarity'])} {fish_name(key, lang)} — {percent}%{lock}")
    return "\n".join(lines)


def help_text(user, lang):
    state, stock = angler(user), bait_stock(user)
    when = phase(time.time())
    bare = state["gear"] == STARTER
    bait = None if bare else world.pick_bait(state["spot"], stock, None if state["bait"] == "auto" else state["bait"])
    hook = tr(lang, "голые руки", "bare hands") if bare else (bait_name(bait, lang) if bait else tr(lang, "пустой крючок", "empty hook"))
    left = world.phase_left(time.time())
    return "\n".join([
        tr(lang, "🎣 Рыбалка", "🎣 Fishing"),
        place_line(state["spot"], when, lang) + tr(lang, f" (ещё {_wait(left, 'ru')})", f" ({_wait(left, 'en')} more)")
        + f" · 🪝 {hook}",
        "",
        odds(state["spot"], when, bait, bare, state["gear"], lang),
        "",
        tr(lang,
           "🔒 — удочка такое не удержит. Ночью выходят сом и судак, на рассвете и закате клюёт лучше.\n"
           "Улов падает в ведро: выпускайте NFT (их можно продать на маркете) или продавайте скупщику за 🐚. "
           "За ракушки — удочки, вёдра, наживки и ⚡ энергетики (/fish_shop). "
           "Места ловли и ключи к ним — /fish_spots.",
           "🔒 — your rod won't hold it. Catfish and zander come out at night; dawn and dusk bite better.\n"
           "The catch goes into the bucket: mint NFTs (sellable on the market) or sell to the buyer for 🐚. "
           "Shells buy rods, buckets, bait and ⚡ energy drinks (/fish_shop). "
           "Places and their keys: /fish_spots."),
    ])


def _reach(gear, lang):
    """The rarest catch a rod holds: «★★☆☆☆ (необычная)» / «★★☆☆☆ uncommon»."""
    label = rarity_label(gear["holds"], lang)
    return f"{stars(gear['holds'])} " + tr(lang, f"({label})", label)


def shop(user, name, lang="ru"):
    """The tackle shop as the angler sees it: what they have, what they can buy."""
    state, stock = angler(user), bait_stock(user)
    mine, room = LADDER.index(state["gear"]), BUCKET_LADDER.index(state["bucket"])
    lines = [tr(lang, "🛒 Лавка рыбака", "🛒 The tackle shop"),
             f"{name}: 🐚 {state['shells']} · ⚡ {state['energy']}", "", tr(lang, "Удочки:", "Rods:")]
    buttons, row = [], []
    for index, key in enumerate(LADDER):
        gear = GEAR[key]
        title = tr(lang, gear["ru"], gear["en"])
        price = tr(lang, "даром", "free") if key == STARTER else f"{gear['price']} 🐚"
        mark = " ✓" if index == mine else ""
        lines.append(f"{gear['emoji']} {title[0].upper() + title[1:]} — {price} · "
                     + tr(lang, "до ", "up to ") + _reach(gear, lang) + mark)
        if index > mine:
            buttons.append([InlineKeyboardButton(tr(lang, f"Купить {gear['emoji']} за {gear['price']} 🐚",
                                                    f"Buy {gear['emoji']} for {gear['price']} 🐚"),
                                                 callback_data=f"fishshop:rod:{key}")])
    lines += ["", tr(lang, "Ёмкости для улова:", "Catch containers:")]
    for index, key in enumerate(BUCKET_LADDER):
        box = BUCKETS[key]
        title = tr(lang, box["ru"], box["en"])
        price = tr(lang, "даром", "free") if not box["price"] else f"{box['price']} 🐚"
        mark = " ✓" if index == room else ""
        slots = tr(lang, _ru_plural(box["size"], "место", "места", "мест"), "slots")
        lines.append(f"{box['emoji']} {title.capitalize()} — {box['size']} {slots} — {price}{mark}")
        if index > room:
            row.append(InlineKeyboardButton(f"{box['emoji']} {box['price']} 🐚", callback_data=f"fishshop:bucket:{key}"))
    if row:
        buttons.append(row)
    lines += ["", tr(lang, "Наживки (за пачку):", "Bait (per pack):")]
    row = []
    for key, bait in BAITS.items():
        liked = ", ".join(fish_name(item, lang) for item in sorted(bait.get("likes", ())))
        what = liked or tr(lang, "хлам, сокровища и ключи", "junk, treasure and keys")
        have = stock.get(key, 0)
        lines.append(f"{bait['emoji']} {tr(lang, bait['ru'], bait['en']).capitalize()} ×{bait['pack']} — {bait['price']} 🐚"
                     + (tr(lang, f" (есть {have})", f" (have {have})") if have else "") + f": {what}")
        row.append(InlineKeyboardButton(f"{bait['emoji']} ×{bait['pack']} · {bait['price']} 🐚", callback_data=f"fishshop:bait:{key}"))
    buttons += [row[i:i + 3] for i in range(0, len(row), 3)]
    lines += ["", tr(lang,
                     f"⚡ Энергетик — {ENERGY['price']} 🐚: вылитый в воду, будит рыбу — отдых кончается у всего чата.",
                     f"⚡ Energy drink — {ENERGY['price']} 🐚: poured into the water it wakes the fish — "
                     "everyone in the chat stops resting.")]
    buttons.append([InlineKeyboardButton(tr(lang, f"⚡ Энергетик за {ENERGY['price']} 🐚", f"⚡ Energy drink, {ENERGY['price']} 🐚"),
                                         callback_data="fishshop:energy:1")])
    lines += ["", tr(lang, "Ракушки — у скупщика за улов: /fish_bucket", "Shells come from selling catch: /fish_bucket")]
    return "\n".join(lines), InlineKeyboardMarkup(buttons)


def bought_text(name, what, key, state, lang):
    if what == "rod":
        gear = GEAR[key]
        return tr(lang, f"🛒 {name} теперь рыбачит: {gear['emoji']} {gear['ru']}. Держит улов до {_reach(gear, lang)}.",
                  f"🛒 {name} now fishes with a {gear['en']} {gear['emoji']}: holds catches up to {_reach(gear, lang)}.")
    if what == "bucket":
        box = BUCKETS[key]
        return tr(lang, f"🛒 {name}: теперь {box['emoji']} {box['ru']} на {box['size']} "
                        f"{_ru_plural(box['size'], 'место', 'места', 'мест')}.",
                  f"🛒 {name} now carries a {box['en']} {box['emoji']} with {box['size']} slots.")
    return None


def spots_view(user, keys, lang):
    """Every place, what it takes, and a button for each one open to the angler."""
    state, stock = angler(user), bait_stock(user)
    now = time.time()
    when = phase(now)
    nxt = world.PHASES[(next(i for i, (name, _end) in enumerate(world.PHASES) if name == when) + 1) % len(world.PHASES)][0]
    lines = [tr(lang, "🗺 Места ловли", "🗺 Fishing places"),
             tr(lang, f"Сейчас {phase_name(when, lang)}, {world.PHASE_INFO[nxt]['ru']} через {_wait(world.phase_left(now), 'ru')}.",
                f"It is {phase_name(when, lang)} — {world.PHASE_INFO[nxt]['en']} in {_wait(world.phase_left(now), 'en')}."),
             ""]
    buttons = []
    for key in SPOT_ORDER:
        spot = SPOTS[key]
        needs = []
        rod = GEAR[spot["rod"]]
        if spot["rod"] != STARTER:
            ok = LADDER.index(state["gear"]) >= LADDER.index(spot["rod"])
            needs.append(f"{rod['emoji']} {tr(lang, rod['ru'], rod['en'])} {'✅' if ok else '🔒'}")
        if spot["key"]:
            item = ITEMS[spot["key"]]
            needs.append(f"{item['emoji']} {tr(lang, item['ru'], item['en'])} {'✅' if keys.get(spot['key']) else '🔒'}")
        if spot["bait"]:
            bait = BAITS[spot["bait"]]
            needs.append(f"{bait['emoji']} {tr(lang, bait['ru'], bait['en'])} {'✅' if stock.get(spot['bait']) else '🔒'}")
        open_ = not blockers(key, state, stock, keys)
        here = key == state["spot"]
        status = tr(lang, " — вы здесь", " — you are here") if here else ""
        lines.append(f"{spot_name(key, lang)}{status}")
        lines.append("   " + (" + ".join(needs) if needs else tr(lang, "открыто всем", "open to everyone")))
        if open_ and not here:
            buttons.append([InlineKeyboardButton(tr(lang, f"➡️ {spot_name(key, 'ru')}", f"➡️ {spot_name(key, 'en')}"),
                                                 callback_data=f"fishspot:{key}")])
    lines += ["", tr(lang,
                     "Ключи ловятся на рыбалке и продаются на NFT-маркете: открывает тот, кто держит ключ "
                     "— в ведре или NFT в привязанном кошельке.",
                     "Keys are fished up and traded on the NFT market: a place opens for whoever holds its key "
                     "— in the bucket or as an NFT in the linked wallet.")]
    return "\n".join(lines), (InlineKeyboardMarkup(buttons) if buttons else None)


def arrival_text(spot_key, lang):
    spot = SPOTS[spot_key]
    when = phase(time.time())
    best = sorted(world.chances(spot_key, when).items(), key=lambda item: -RANK[ITEMS[item[0]]["rarity"]])[:5]
    return "\n".join([
        tr(lang, f"Вы пришли: {spot_name(spot_key, 'ru')}", f"You arrive at the {spot_name(spot_key, 'en')}"),
        phase_name(when, lang),
        "",
        tr(lang, spot["about_ru"], spot["about_en"]),
        "",
        tr(lang, "Самое ценное здесь: ", "The best things here: ") + ", ".join(fish_name(key, lang) for key, _share in best),
        tr(lang, "Наживки, что здесь любят: ", "Bait that works here: ")
        + ", ".join(bait_name(bait, lang) for bait in spot["baits"]),
        tr(lang, "Закидывайте: /fish · шансы: /fish odds", "Cast: /fish · odds: /fish odds"),
    ])


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


SCENE_CACHE = "fishing:scene:v1:"


async def _send_place(message, spot_key, when, body, markup=None):
    """The spot's picture at this hour, uploaded once and reused by file id."""
    cache_key = f"{SCENE_CACHE}{spot_key}:{when}"
    cached = _kv_get(cache_key)
    photo = cached or await asyncio.to_thread(fish_art.render_place, spot_key, when, SPOTS[spot_key]["colour"])
    sent = await message.reply_photo(photo=photo, caption=body, reply_markup=markup)
    if not cached and getattr(sent, "photo", None):
        _kv_set(cache_key, sent.photo[-1].file_id)
    return sent


async def _edit(bot, row, body, markup=None):
    """Edit a cast's message, whether it is the place's picture or plain text."""
    try:
        if row.get("media"):
            await bot.edit_message_caption(chat_id=row["chat_id"], message_id=row["message_id"], caption=body,
                                           reply_markup=markup)
        else:
            await bot.edit_message_text(chat_id=row["chat_id"], message_id=row["message_id"], text=body,
                                        reply_markup=markup)
    except TelegramError:
        logger.info("fishing: could not edit cast %s", row["id"])


async def _float(bot, cast_id, delay):
    """The line sits, then bites, then — if nobody struck — the fish leaves.

    Detached from the handler: this bot's dispatcher is sequential, and a
    handler that slept through a bite would stall every other one.
    """
    await asyncio.sleep(delay)
    row = get_cast(cast_id)
    if not row or row["status"] != "waiting":
        return
    lang, gear_key = _lang(row), row["gear"] or STARTER
    name = _angler_name(row, lang)
    place = place_line(row["spot"] or START_SPOT, phase(time.time()), lang)
    try:
        body, markup = biting_text(name, gear_key, lang, place), hook_markup(cast_id, gear_key, lang)
        if row["media"]:
            await bot.edit_message_caption(chat_id=row["chat_id"], message_id=row["message_id"], caption=body,
                                           reply_markup=markup)
        else:
            await bot.edit_message_text(chat_id=row["chat_id"], message_id=row["message_id"], text=body,
                                        reply_markup=markup)
    except TelegramError:
        lose(cast_id)
        return
    # The window opens when the button is on screen, not when the task woke.
    bite(cast_id)
    await asyncio.sleep(GEAR[gear_key]["window"] + 0.5)
    if escape(cast_id):
        await _edit(bot, row, escaped_text(name, gear_key, lang))


async def _keys_for(user, spot_key=None):
    """keys_held() off the event loop — it may ask the chain."""
    if spot_key and not SPOTS[spot_key]["key"]:
        return {}
    return await asyncio.to_thread(keys_held, user)


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
        await msg.reply_text(help_text(user.id, lang))
        return
    routes = {("shop", "магазин", "лавка", "снасти"): fish_shop_command,
              ("spots", "места", "map", "карта"): fish_spots_command,
              ("bucket", "ведро"): fish_bucket_command,
              ("bag", "рюкзак", "me", "я"): fish_bag_command,
              ("⚡", "energy", "энергетик", "drink", "pour"): fish_pour_command}
    for words, handler in routes.items():
        if word in words:
            await handler(update, context)
            return
    name = _name(user)
    state = angler(user.id)
    keys = await _keys_for(user.id, state["spot"])
    try:
        cast_id, delay = cast(chat.id, user.id, display_name=name, lang=lang, keys=keys)
    except Resting as exc:
        await msg.reply_text(say(lang, exc), reply_markup=resting_markup(lang, state))
        return
    except BucketFull as exc:
        await msg.reply_text(say(lang, exc), reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton(tr(lang, "🪣 Открыть ведро", "🪣 Open the bucket"), callback_data=f"fishb:v:{user.id}")]]))
        return
    except ValueError as exc:
        await msg.reply_text(say(lang, exc))
        return
    row = get_cast(cast_id)
    spot_key, when = row["spot"], phase(time.time())
    left = bait_stock(user.id).get(row["bait"], 0) if row["bait"] else 0
    body = waiting_text(name, row["gear"], lang, place_line(spot_key, when, lang), bait_line(row, left, lang))
    try:
        try:
            sent, media = await _send_place(msg, spot_key, when, body), True
        except TelegramError as exc:
            logger.info("fishing: place picture refused in %s: %s", chat.id, exc)
            sent, media = await msg.reply_text(body), False
    except TelegramError:
        lose(cast_id)
        raise
    attach(cast_id, sent.message_id, msg.message_id, media)
    _detach(context, _float(context.bot, cast_id, delay))


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
        await query.answer(tr(lang, "Сорвалось — слишком тяжело!", "Lost it — too heavy!"))
        await _edit(bot, row, too_big_text(name, gear_key, row["got_away"], lang))
        return
    if catch is None:
        await query.answer(tr(lang, "Поздно — ушла!", "Too late — it got away!"))
        await _edit(bot, row, escaped_text(name, gear_key, lang))
        return
    await query.answer(tr(lang, "Есть! Тянем…", "Got it! Reeling in…"))
    await land(bot, row, catch)


async def land(bot, row, catch):
    """Show the catch where the line was: the place's picture becomes the
    catch's picture, with its card and the mint/sell buttons."""
    state = angler(catch["user_id"])
    lang = _lang(catch)
    if catch["nft_status"] == "pocket":
        body, markup = energy_text(catch, state, lang), None
    else:
        room = (len(bucket(catch["user_id"])), BUCKETS[state["bucket"]]["size"])
        body = caption(catch, wallet_of(catch["user_id"]), getattr(bot, "username", None),
                       hint=upgrade_hint(state, lang), room=room)
        markup = catch_markup(catch)
    try:
        image = await asyncio.to_thread(picture, catch)
        if row.get("media"):
            await bot.edit_message_media(chat_id=row["chat_id"], message_id=row["message_id"],
                                         media=InputMediaPhoto(media=image, caption=body), reply_markup=markup)
            set_photo(catch["id"], row["message_id"])
            return
        sent = await bot.send_photo(
            chat_id=row["chat_id"], photo=image, caption=body, reply_markup=markup,
            reply_to_message_id=row["command_message_id"], allow_sending_without_reply=True,
        )
    except TelegramError as exc:
        logger.info("fishing: photo refused for catch %s: %s", catch["id"], exc)
        await _edit(bot, row, body, markup)
        return
    set_photo(catch["id"], sent.message_id)
    try:
        await bot.delete_message(chat_id=row["chat_id"], message_id=row["message_id"])
    except TelegramError:
        await _edit(bot, row, tr(lang, "🎣 Улов — ниже.", "🎣 The catch is below."))


async def _refresh_card(bot, catch_id):
    """Rewrite a catch's card after it was minted, sold or delivered. Quiet: an edit."""
    catch = get_catch(catch_id)
    if not catch or not catch["photo_message_id"]:
        return
    try:
        await bot.edit_message_caption(chat_id=catch["chat_id"], message_id=catch["photo_message_id"],
                                       caption=caption(catch, wallet_of(catch["user_id"]), getattr(bot, "username", None)),
                                       reply_markup=catch_markup(catch))
    except TelegramError as exc:
        logger.info("fishing: could not update the card of catch %s: %s", catch_id, exc)


async def fish_bucket_callback(update, context):
    """fishb:m|s:<catch> on a card or in the bucket; fishb:M|S|v:<owner> for all of it."""
    query = update.callback_query
    match = re.fullmatch(r"fishb:([msMSv]):([0-9]+)", query.data or "")
    lang = lang_of(update)
    if not match:
        await query.answer()
        return
    action, number, presser = match[1], int(match[2]), query.from_user.id
    if action in "MSv" and number != presser:
        await query.answer(tr(lang, "Это чужое ведро. Своё — /fish_bucket", "That's someone else's bucket. Yours: /fish_bucket"),
                           show_alert=True)
        return
    if action in "ms":
        catch = get_catch(number)
        if not catch or catch["user_id"] != presser:
            await query.answer(tr(lang, "Это чужой улов.", "That's someone else's catch."), show_alert=True)
            return
    ids = [number] if action in "ms" else None
    try:
        if action in "mM":
            done = mint(presser, ids)
            await query.answer(tr(lang, f"🖼 В чеканку: {len(done)}", f"🖼 Minting: {len(done)}"))
        elif action in "sS":
            paid, done = sell(presser, ids)
            await query.answer(tr(lang, f"🐚 +{paid} от скупщика", f"🐚 +{paid} from the buyer"))
        else:
            done = []
            await query.answer()
    except ValueError as exc:
        await query.answer(say(lang, exc)[:200], show_alert=True)
        return
    for row in done:
        await _refresh_card(context.bot, row["id"])
    if action in "MSv" or (query.message and query.message.text):
        # The bucket message itself (cards are photos and were refreshed above).
        body, markup = bucket_view(presser, _name(query.from_user), lang)
        try:
            await query.edit_message_text(body, reply_markup=markup)
        except TelegramError:
            pass


async def fish_bucket_command(update, context):
    user, msg = update.effective_user, update.effective_message
    if not user or not msg:
        return
    body, markup = bucket_view(user.id, _name(user), lang_of(update))
    await msg.reply_text(body, reply_markup=markup)


async def fish_bag_command(update, context):
    user, msg = update.effective_user, update.effective_message
    if not user or not msg:
        return
    lang = lang_of(update)
    await msg.reply_text(bag(user.id, _name(user), lang), reply_markup=bait_markup(user.id, lang))


async def fish_bait_callback(update, context):
    query = update.callback_query
    match = re.fullmatch(r"fishbait:([a-z]+):([0-9]+)", query.data or "")
    lang = lang_of(update)
    if not match:
        await query.answer()
        return
    if int(match[2]) != query.from_user.id:
        await query.answer(tr(lang, "Это чужой рюкзак. Свой — /fish_bag", "That's someone else's bag. Yours: /fish_bag"),
                           show_alert=True)
        return
    try:
        choose_bait(query.from_user.id, match[1])
    except ValueError as exc:
        await query.answer(say(lang, exc)[:200], show_alert=True)
        return
    await query.answer(tr(lang, "Насажено", "On the hook"))
    try:
        await query.edit_message_text(bag(query.from_user.id, _name(query.from_user), lang),
                                      reply_markup=bait_markup(query.from_user.id, lang))
    except TelegramError:
        pass


async def fish_shop_command(update, context):
    user, msg = update.effective_user, update.effective_message
    if not user or not msg:
        return
    body, markup = shop(user.id, _name(user), lang_of(update))
    await msg.reply_text(body, reply_markup=markup)


async def fish_shop_callback(update, context):
    query = update.callback_query
    data = query.data or ""
    lang = lang_of(update)
    match = re.fullmatch(r"fishshop:(rod|bucket|bait|energy):([a-z0-9]+)", data)
    legacy = re.fullmatch(r"fishshop:([a-z]+)", data)   # cards posted before there was more than rods
    if match:
        what, key = match[1], match[2]
    elif legacy:
        what, key = "rod", legacy[1]
    else:
        await query.answer()
        return
    buyer = query.from_user
    try:
        state = buy(buyer.id, what, key)
    except ValueError as exc:
        await query.answer(say(lang, exc)[:200], show_alert=True)
        return
    name = _name(buyer)
    if what == "bait":
        await query.answer(tr(lang, f"+{BAITS[key]['pack']} {BAITS[key]['emoji']} · 🐚 {state['shells']}",
                              f"+{BAITS[key]['pack']} {BAITS[key]['emoji']} · 🐚 {state['shells']}"))
    elif what == "energy":
        await query.answer(tr(lang, f"⚡ В кармане: {state['energy']}. Вылить — /fish ⚡",
                              f"⚡ In the pocket: {state['energy']}. Pour it: /fish ⚡"))
    else:
        await query.answer(tr(lang, "Куплено!", "Bought!"))
    body, markup = shop(buyer.id, name, lang)
    try:
        await query.edit_message_text(body, reply_markup=markup)
    except TelegramError:
        pass
    announcement = bought_text(name, what, key, state, lang)
    chat = update.effective_chat
    if announcement and chat is not None:
        try:
            await context.bot.send_message(chat_id=chat.id, text=announcement)
        except TelegramError as exc:
            logger.info("fishing: could not announce a purchase in %s: %s", chat.id, exc)


async def fish_spots_command(update, context):
    user, msg = update.effective_user, update.effective_message
    if not user or not msg:
        return
    keys = await _keys_for(user.id)
    body, markup = spots_view(user.id, keys, lang_of(update))
    await msg.reply_text(body, reply_markup=markup)


async def fish_spot_callback(update, context):
    query = update.callback_query
    match = re.fullmatch(r"fishspot:([a-z_]+)", query.data or "")
    lang = lang_of(update)
    if not match or match[1] not in SPOTS:
        await query.answer()
        return
    traveller = query.from_user
    keys = await _keys_for(traveller.id, match[1])
    try:
        travel(traveller.id, match[1], keys)
    except ValueError as exc:
        await query.answer(say(lang, exc)[:200], show_alert=True)
        return
    await query.answer(spot_name(match[1], lang))
    message = query.message
    if message is not None:
        body = f"{_name(traveller)}: " + arrival_text(match[1], lang)
        try:
            await _send_place(message, match[1], phase(time.time()), body)
        except TelegramError:
            try:
                await message.reply_text(body)
            except TelegramError:
                pass


async def fish_pour_command(update, context):
    chat, user, msg = update.effective_chat, update.effective_user, update.effective_message
    if not chat or not user or not msg:
        return
    lang = lang_of(update)
    try:
        pour(chat.id, user.id, _name(user))
    except ValueError as exc:
        await msg.reply_text(say(lang, exc))
        return
    await msg.reply_text(poured_text(_name(user), lang))


async def fish_pour_callback(update, context):
    query = update.callback_query
    chat, lang = update.effective_chat, lang_of(update)
    if chat is None:
        await query.answer()
        return
    try:
        pour(chat.id, query.from_user.id, _name(query.from_user))
    except ValueError as exc:
        await query.answer(say(lang, exc)[:200], show_alert=True)
        return
    await query.answer("⚡")
    try:
        await context.bot.send_message(chat_id=chat.id, text=poured_text(_name(query.from_user), lang))
    except TelegramError as exc:
        logger.info("fishing: could not announce a pour in %s: %s", chat.id, exc)


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
                    await _refresh_card(application.bot, catch_id)
        except Exception:
            logger.exception("fishing: loop step failed")
        await asyncio.sleep(MINT_BUSY if busy else MINT_IDLE)
