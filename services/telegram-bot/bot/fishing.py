"""🎣 Fishing in the chat: cast, wait for the bite, strike — and the fish is an NFT.

`/fish` puts a float on the water. A few seconds later it bites and a «Подсечь»
button appears; press it within HOOK_WINDOW and the fish is yours, miss it and
it gets away. A fish (never the trash) becomes a CyberiaNFT: its own pixel
picture (`bot.fish_art`) and metadata are pinned to IPFS, the bot key mints it
and sends it to the wallet the angler linked with /set_wallet. Without a wallet
the catch waits in the bag (/fish_bag) and goes out as soon as one is linked —
play first, wallet later.

Nothing is staked, so nothing can be lost, and that is why the catch is drawn
by the bot's own `secrets` RNG rather than by a Telegram dice the way 🎰 is:
there is no balance whose fairness hangs on it. What *is* scarce is the chain,
so every fish is followed by FISHING_COOLDOWN_SECONDS of rest per account,
across every chat; a miss or a boot costs only MISS_COOLDOWN, because they mint
nothing.

The game lives in durable rows and the Telegram messages are views of them: a
cast is `waiting → biting → caught | escaped`, settled inside SQLite's
`BEGIN IMMEDIATE`, so the strike and the escape timer racing each other can
only ever produce one outcome. A cast whose task died with a restart is swept
to `lost` and costs nothing.

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
from bot.stakes import transaction

logger = logging.getLogger(__name__)

BITE_AFTER = (3.0, 12.0)   # seconds the float sits before it bites
HOOK_WINDOW = 7.0          # seconds to press «Подсечь» once it does
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
    "boot": "🥾 старый ботинок",
    "floppy": "💾 дискета 3,5″",
    "cable": "🔌 спутанный патч-корд",
    "can": "🥫 ржавая банка",
}


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
        conn.execute(text("CREATE INDEX IF NOT EXISTS fishing_catches_by_user ON fishing_catches(user_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS fishing_catches_by_chat ON fishing_catches(chat_id)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS fishing_catches_nft ON fishing_catches(nft_status)"))


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


def weight(grams):
    grams = int(grams)
    if grams < 1000:
        return f"{grams} г"
    return f"{grams / 1000:.2f}".rstrip("0").rstrip(".").replace(".", ",") + " кг"


def stars(rarity):
    count = RARITIES[rarity]["stars"]
    return "★" * count + "☆" * (5 - count)


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
    return {
        "name": f"{fish['en']} · {kg} kg",
        "description": (
            f"A {rarity['en']} {fish['en'].lower()} of {kg} kg, caught with the Cyberia Telegram bot "
            f"on {caught:%Y-%m-%d}. Catch #{catch['id']}."
        ),
        "image": image_uri,
        "attributes": [
            {"trait_type": "Species", "value": fish["en"]},
            {"trait_type": "Rarity", "value": rarity["en"]},
            {"trait_type": "Weight (g)", "value": int(catch["grams"]), "display_type": "number"},
            {"trait_type": "Trophy", "value": "yes" if catch["trophy"] else "no"},
            {"trait_type": "Caught", "value": f"{caught:%Y-%m-%d %H:%M} UTC"},
            {"trait_type": "Collection", "value": "Cyberia Fishing"},
        ],
    }


# --- a cast ------------------------------------------------------------------
def _cast(conn, cast_id):
    return conn.execute(text("SELECT * FROM fishing_casts WHERE id=:id"), {"id": cast_id}).mappings().first()


def get_cast(cast_id):
    with engine.connect() as conn:
        row = _cast(conn, cast_id)
    return dict(row) if row else None


def cast(chat, user, display_name=None, now=None, rng=None):
    """Put a float on the water. Returns (cast id, seconds until the bite).

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
                raise ValueError("Удочка уже в воде — следите за поплавком.")
            conn.execute(text("UPDATE fishing_casts SET status='lost', ready_at=:n WHERE id=:id"),
                         {"n": now, "id": last["id"]})
        elif last and last["ready_at"] and now < last["ready_at"]:
            raise ValueError(f"Рыба отдыхает. Следующий заброс через {_wait(last['ready_at'] - now)}.")
        delay = rng.uniform(*BITE_AFTER)
        return conn.execute(text("""
            INSERT INTO fishing_casts(chat_id,user_id,user_name,status,created_at,bite_at)
            VALUES(:c,:u,:name,'waiting',:t,:b) RETURNING id
        """), {"c": chat, "u": user, "name": display_name, "t": now, "b": now + delay}).scalar_one(), delay


def _wait(seconds):
    seconds = max(1, int(seconds))
    if seconds < 60:
        return f"{seconds} с"
    minutes = -(-seconds // 60)
    return f"{minutes} мин"


def attach(cast_id, message_id, command_message_id=None):
    with engine.begin() as conn:
        conn.execute(text("UPDATE fishing_casts SET message_id=:m, command_message_id=:o WHERE id=:id"),
                     {"m": message_id, "o": command_message_id, "id": cast_id})


def bite(cast_id, now=None):
    """The float goes under. True if this cast was still waiting for it."""
    now = time.time() if now is None else now
    with transaction() as conn:
        return conn.execute(text(
            "UPDATE fishing_casts SET status='biting', bit_at=:n WHERE id=:id AND status='waiting'"
        ), {"n": now, "id": cast_id}).rowcount == 1


def escape(cast_id, now=None):
    """The fish gets away if nobody struck in time. True if it did just now."""
    now = time.time() if now is None else now
    with transaction() as conn:
        return conn.execute(text("""
            UPDATE fishing_casts SET status='escaped', ready_at=:r
            WHERE id=:id AND status='biting' AND :n - bit_at >= :w
        """), {"r": int(now) + MISS_COOLDOWN, "n": now, "w": HOOK_WINDOW, "id": cast_id}).rowcount == 1


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
    """Press «Подсечь». Returns (cast, catch); catch is None when it was too late.

    Refusals are ValueErrors with the text to show the presser. The check and
    the catch are one transaction, so the escape timer cannot also fire.
    """
    now = time.time() if now is None else now
    with transaction() as conn:
        row = _cast(conn, cast_id)
        if not row:
            raise ValueError("Этот заброс не найден.")
        if row["user_id"] != user:
            raise ValueError(f"Это удочка {row['user_name'] or 'другого рыбака'}. Своя — /fish")
        if row["status"] == "waiting" and now >= row["bite_at"]:
            # The bite message reached the angler before its own task wrote it down.
            row = dict(row, status="biting", bit_at=now)
        if row["status"] == "waiting":
            raise ValueError("Ещё не клюёт — ждите.")
        if row["status"] != "biting":
            raise ValueError("Этот заброс уже закончился. Новый — /fish")
        if now - row["bit_at"] > HOOK_WINDOW:
            conn.execute(text("UPDATE fishing_casts SET status='escaped', ready_at=:r WHERE id=:id"),
                         {"r": int(now) + MISS_COOLDOWN, "id": cast_id})
            return dict(row, status="escaped"), None

        hooked = roll(rng)
        is_fish = hooked["rarity"] != "trash"
        catch_id = conn.execute(text("""
            INSERT INTO fishing_catches(cast_id,chat_id,user_id,user_name,species,rarity,grams,trophy,seed,
                                        caught_at,nft_status)
            VALUES(:cast,:c,:u,:name,:s,:r,:g,:t,:seed,:at,:nft) RETURNING id
        """), {"cast": cast_id, "c": row["chat_id"], "u": user, "name": row["user_name"],
               "s": hooked["species"], "r": hooked["rarity"], "g": hooked["grams"], "t": hooked["trophy"],
               "seed": hooked["seed"], "at": int(now), "nft": "pending" if is_fish else "none"}).scalar_one()
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
def _short(address):
    return f"{address[:6]}…{address[-4:]}" if address else ""


def _bot_hint(bot_username):
    return f"в личке @{bot_username}" if bot_username else "в личке бота"


def nft_line(catch, wallet=None, bot_username=None, minting=None):
    minting = (FISHING_MINT and bool(DEPLOYER_PK)) if minting is None else minting
    status = catch["nft_status"]
    if status == "delivered":
        return f"🖼 NFT #{catch['token_id']} — в кошельке {_short(catch['recipient'])}"
    if status == "failed":
        return "NFT не получился — улов сохранён в /fish_bag, разберёмся."
    if not minting:
        return "Улов сохранён в /fish_bag — NFT отправим, когда включим чеканку."
    if status in ("minting", "minted", "sending") or wallet:
        return f"🖼 Чеканим NFT в кошелёк {_short(catch.get('recipient') or wallet)}…"
    return f"🖼 Станет NFT, как только привяжете кошелёк: /set_wallet 0x… {_bot_hint(bot_username)}."


def caption(catch, wallet=None, bot_username=None, minting=None):
    fish, rarity = SPECIES[catch["species"]], RARITIES[catch["rarity"]]
    lines = [
        f"🎣 Улов — {catch['user_name'] or 'рыбак'}",
        f"{fish['name']}, {weight(catch['grams'])}" + (" · 🏆 трофей" if catch["trophy"] else ""),
        f"{stars(catch['rarity'])} {rarity['label']}",
        "",
        nft_line(catch, wallet, bot_username, minting),
    ]
    if COOLDOWN:
        lines.append(f"Следующий заброс — через {_wait(COOLDOWN)}.")
    return "\n".join(lines)


def nft_markup(catch):
    if catch["nft_status"] != "delivered" or catch["token_id"] is None:
        return None
    url = f"{EXPLORER_URL}/token/{CYBERIA_NFT_ADDRESS}/instance/{catch['token_id']}"
    return InlineKeyboardMarkup([[InlineKeyboardButton("Открыть NFT", url=url)]])


def waiting_text(name):
    return f"🎣 {name} закидывает удочку…\n〰️〰️〰️🔴〰️〰️〰️\nЖдите поклёвку и жмите «Подсечь»."


def biting_text(name):
    return f"🎣 Клюёт у {name}!\n〰️〰️🫧🔴🫧〰️〰️\nПодсекайте — {HOOK_WINDOW:g} секунд!"


def escaped_text(name):
    return f"🎣 Сорвалась у {name} — не успели подсечь.\nЕщё раз: /fish"


def trash_text(catch):
    return (f"🎣 На крючке у {catch['user_name'] or 'рыбака'} — {TRASH[catch['species']]}.\n"
            f"Не рыба и не NFT, выбросили обратно. Ещё раз: /fish (через {_wait(MISS_COOLDOWN)})")


def hook_markup(cast_id):
    return InlineKeyboardMarkup([[InlineKeyboardButton("🪝 Подсечь", callback_data=f"fish:{cast_id}")]])


def _ranked(rows):
    return sorted(rows, key=lambda row: (-RANK[row["rarity"]], -int(row["grams"]), row["id"]))


def bag(user, name=None):
    """An angler's catches across every chat, best first."""
    with engine.connect() as conn:
        rows = [dict(row) for row in conn.execute(text(
            "SELECT * FROM fishing_catches WHERE user_id=:u AND rarity!='trash'"
        ), {"u": user}).mappings()]
        wallet = _wallet(conn, user)
    if not rows:
        return "🪣 В садке пусто. Закидывайте удочку: /fish"
    trophies = sum(1 for row in rows if row["trophy"])
    minted = sum(1 for row in rows if row["nft_status"] == "delivered")
    lines = [f"🪣 Садок {name or ''}".rstrip() + f": {len(rows)} рыб · трофеев {trophies} · NFT {minted}", ""]
    for index, row in enumerate(_ranked(rows)[:10], 1):
        fish = SPECIES[row["species"]]
        tag = f"NFT #{row['token_id']}" if row["nft_status"] == "delivered" else (
            "ждёт кошелька" if row["nft_status"] == "pending" and not wallet else "чеканится")
        trophy = " 🏆" if row["trophy"] else ""
        lines.append(f"{index}. {stars(row['rarity'])} {fish['name']}, {weight(row['grams'])}{trophy} — {tag}")
    waiting = sum(1 for row in rows if row["nft_status"] == "pending")
    if waiting and not wallet:
        lines += ["", f"{waiting} ждут кошелька: /set_wallet 0x… в личке бота — и они станут NFT."]
    return "\n".join(lines)


def top(chat):
    """The chat's best catches."""
    with engine.connect() as conn:
        rows = [dict(row) for row in conn.execute(text(
            "SELECT * FROM fishing_catches WHERE chat_id=:c AND rarity!='trash'"
        ), {"c": chat}).mappings()]
    if not rows:
        return "🏆 Здесь ещё никто ничего не поймал. Первым будет тот, кто напишет /fish"
    lines = ["🏆 Рекорды чата", ""]
    for index, row in enumerate(_ranked(rows)[:10], 1):
        fish = SPECIES[row["species"]]
        trophy = " 🏆" if row["trophy"] else ""
        lines.append(f"{index}. {stars(row['rarity'])} {fish['name']}, {weight(row['grams'])}{trophy} — "
                     f"{row['user_name'] or 'рыбак'}")
    return "\n".join(lines)


def odds():
    lines = []
    for rarity, info in RARITIES.items():
        share = info["odds"] / TOTAL_ODDS * 100
        names = (", ".join(fish["name"] for fish in SPECIES.values() if fish["rarity"] == rarity)
                 if rarity != "trash" else "ботинки, банки, дискеты")
        lines.append(f"{stars(rarity) if rarity != 'trash' else '🥾'} {info['label']} — {share:g}%: {names}")
    return "\n".join(lines)


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


async def _float(bot, cast_id, chat_id, message_id, name, delay):
    """The float sits, then bites, then — if nobody struck — the fish leaves.

    Detached from the handler: this bot's dispatcher is sequential, and a
    handler that slept through a bite would stall every other one.
    """
    await asyncio.sleep(delay)
    row = get_cast(cast_id)
    if not row or row["status"] != "waiting":
        return
    try:
        await bot.edit_message_text(chat_id=chat_id, message_id=message_id, text=biting_text(name),
                                    reply_markup=hook_markup(cast_id))
    except TelegramError:
        lose(cast_id)
        return
    # The window opens when the button is on screen, not when the task woke.
    bite(cast_id)
    await asyncio.sleep(HOOK_WINDOW + 0.5)
    if escape(cast_id):
        try:
            await bot.edit_message_text(chat_id=chat_id, message_id=message_id, text=escaped_text(name))
        except TelegramError:
            pass


async def fish_command(update, context):
    chat, user, msg = update.effective_chat, update.effective_user, update.effective_message
    if not chat or not msg:
        return
    if getattr(msg, "sender_chat", None) or not user or user.is_bot:
        await msg.reply_text("Рыбачить можно только от своего аккаунта, а не от имени канала.")
        return
    if context.args and context.args[0].lower() in ("help", "odds", "шансы", "?"):
        await msg.reply_text("🎣 Рыбалка\n\n" + odds() + "\n\nКаждая рыба — NFT в вашем кошельке. "
                             "/fish — заброс, /fish_bag — садок, /fish_top — рекорды чата.")
        return
    name = _name(user)
    try:
        cast_id, delay = cast(chat.id, user.id, display_name=name)
    except ValueError as exc:
        await msg.reply_text(str(exc))
        return
    try:
        sent = await msg.reply_text(waiting_text(name))
    except TelegramError:
        lose(cast_id)
        raise
    attach(cast_id, sent.message_id, msg.message_id)
    _detach(context, _float(context.bot, cast_id, chat.id, sent.message_id, name, delay))


async def fish_callback(update, context):
    query = update.callback_query
    match = re.fullmatch(r"fish:([0-9]+)", query.data or "")
    if not match:
        await query.answer()
        return
    try:
        row, catch = strike(int(match[1]), query.from_user.id)
    except ValueError as exc:
        await query.answer(str(exc)[:200], show_alert=True)
        return
    bot = context.bot
    if catch is None:
        await query.answer("Поздно — сорвалась!")
        await _edit(bot, row, escaped_text(row["user_name"]))
        return
    await query.answer("Есть! Тянем…")
    if catch["rarity"] == "trash":
        await _edit(bot, row, trash_text(catch))
        return
    await land(bot, row, catch)


async def _edit(bot, row, body, markup=None):
    try:
        await bot.edit_message_text(chat_id=row["chat_id"], message_id=row["message_id"], text=body,
                                    reply_markup=markup)
    except TelegramError:
        logger.info("fishing: could not edit cast %s", row["id"])


async def land(bot, row, catch):
    """Show the fish: its picture, replying to the /fish that caught it, in
    place of the float message. Text only if the chat refuses photos."""
    wallet = wallet_of(catch["user_id"])
    body = caption(catch, wallet, getattr(bot, "username", None))
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
        await _edit(bot, row, "🎣 Улов — ниже.")


async def fish_bag_command(update, context):
    user, msg = update.effective_user, update.effective_message
    if not user or not msg:
        return
    await msg.reply_text(bag(user.id, _name(user)))


async def fish_top_command(update, context):
    chat, msg = update.effective_chat, update.effective_message
    if not chat or not msg:
        return
    if chat.type == "private":
        await msg.reply_text("Рекорды — у каждого чата свои: /fish_top в группе. Ваш улов — /fish_bag")
        return
    await msg.reply_text(top(chat.id))


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
                    await _edit(application.bot, row, "🎣 Леска оборвалась — закидывайте снова: /fish")
            if FISHING_MINT and DEPLOYER_PK:
                chain = chain or Chain()
                delivered, busy = await asyncio.to_thread(advance, chain)
                for catch_id in delivered:
                    await _announce_delivery(application.bot, catch_id)
        except Exception:
            logger.exception("fishing: loop step failed")
        await asyncio.sleep(MINT_BUSY if busy else MINT_IDLE)
