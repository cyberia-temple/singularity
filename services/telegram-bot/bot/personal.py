"""Personal notifications: what happened to *your* wallet, in a private message.

The announcers post what happens on Cyberia to the public chats; nobody there
is told that it was their money. This module writes to the owner instead:

- a bridge delivered — to the recipient, and to the sender if it's someone else;
- coins or a priced token arrived on Cyberia;
- a token they hold moved 10 % or more since the last time anyone was told.

An owner is a Telegram account in `tg_wallets` — linked with `/set_wallet`, or
in one tap from the wallet: it signs its address to Laravel, gets a one-time
`start=link_…` deep link (`tg_wallet_links`), and opening it here links the
account. Every message carries the off switch reminders use; switched off means
nothing personal is sent.

Only value is reported. A token with no price is skipped — airdropped dust and
bait named after real coins are the usual reason a token has none — and so are
mints, which is how the bot's own hourly rewards arrive.
"""
import asyncio
import logging
import time
from datetime import datetime, timezone

from sqlalchemy import text
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo
from telegram.error import TelegramError
from telegram.ext import Application
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware

from bot.announcers import _direction_label
from bot.chain import (
    _address_topic_hex, _decode_topic_address, _event_topic, _get_token_meta,
    _get_token_usd_price, _hex_no_prefix,
)
from bot.config import EVENT_WATCH_POLL_SECONDS, RPC_URL, WALLET_MINI_APP_URL, WCYBER_ADDRESS
from bot.db import _kv_get, _kv_set, engine
from bot.language import T, lang_for, say, tr
from bot.reminders import OFF_CALLBACK, is_opted_in
from bot.utils import _fmt_amount, _fmt_usd, _format_decimal_amount, _short_addr
from bot.watchers import _cyber_usd

logger = logging.getLogger(__name__)

TRANSFER_TOPIC = _event_topic("Transfer(address,address,uint256)")
ZERO_ADDRESS = "0x" + "0" * 40
MIN_NOTIFY_USD = 0.01
# Native coin moves are found by reading whole blocks; the cap keeps one tick
# cheap after a restart, and the cursor catches up over the next ones.
MAX_BLOCKS_PER_TICK = 200

# A price move worth a message, and how often one token may cause one.
PRICE_MOVE = 0.10
PRICE_QUIET_SECONDS = 3 * 3600
MIN_HOLDING_USD = 1.0
BALANCE_OF_ABI = [{
    "name": "balanceOf", "type": "function", "stateMutability": "view",
    "inputs": [{"name": "owner", "type": "address"}],
    "outputs": [{"name": "", "type": "uint256"}],
}]

BRIDGE_CURSOR = "personal_bridge_id"
BLOCK_CURSOR = "personal_block"

LINKED_TEXT = T(
    "Готово: кошелёк {addr} связан с этим Telegram.\n\n"
    "Буду писать сюда, когда на него что-то придёт, когда мост доставит перевод, "
    "и раз в день — если серия заданий под угрозой. Выключить — /remind off.",
    "Done: wallet {addr} is linked to this Telegram.\n\n"
    "I'll write here when something arrives in it, when the bridge delivers a transfer, "
    "and once a day if your quest streak is at risk. Turn it off: /remind off.",
)

LINK_EXPIRED_TEXT = T(
    "Ссылка устарела или уже использована. Откройте кошелёк и нажмите "
    "«Уведомления в Telegram» ещё раз.",
    "This link has expired or was already used. Open the wallet and press "
    "«Notifications in Telegram» again.",
)


def ensure_personal_schema() -> None:
    """The table Laravel's migration creates too, whichever side starts first."""
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS tg_wallet_links (
                token      TEXT PRIMARY KEY,
                address    TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                used_at    TEXT,
                created_at TEXT
            )
        """))
        # The price each token was last reported at (or first seen at): a move
        # is measured from here, and the mark resets when one is reported.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS tg_price_marks (
                address   TEXT PRIMARY KEY,
                price_usd REAL NOT NULL,
                marked_at REAL NOT NULL
            )
        """))


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def consume_link(token: str, tg_user_id: int) -> str | None:
    """The address a one-time link names, or None if it's unknown, used or old.

    Marked used in the same transaction it's read in, so a link opened twice
    links once.
    """
    now = _now()
    with engine.begin() as conn:
        row = conn.execute(
            text("""
                SELECT address FROM tg_wallet_links
                WHERE token = :t AND used_at IS NULL AND expires_at >= :now
            """),
            {"t": token, "now": now},
        ).fetchone()
        if row is None:
            return None
        conn.execute(
            text("UPDATE tg_wallet_links SET used_at = :now WHERE token = :t"),
            {"t": token, "now": now},
        )
    logger.info(f"personal: linked tg user {tg_user_id} by one-time link")
    return row[0]


def wallet_markup(lang: str = "ru") -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(tr(lang, "Открыть кошелёк", "Open wallet"), web_app=WebAppInfo(url=WALLET_MINI_APP_URL))],
        [InlineKeyboardButton(tr(lang, "Выключить уведомления", "Turn notifications off"), callback_data=OFF_CALLBACK)],
    ])


def linked_owners() -> dict[str, list[int]]:
    """Lowercased address → the Telegram accounts linked to it."""
    owners: dict[str, list[int]] = {}
    with engine.connect() as conn:
        for user_id, address in conn.execute(text("SELECT user_id, address FROM tg_wallets")):
            if address:
                owners.setdefault(address.lower(), []).append(int(user_id))
    return owners


async def notify(bot, tg_user_id: int, body: str) -> bool:
    if not is_opted_in(tg_user_id):
        return False
    # A private chat: the language its owner chose there, else as written.
    lang = lang_for(tg_user_id, fallback="ru")
    try:
        await bot.send_message(
            chat_id=tg_user_id, text=say(lang, body),
            reply_markup=wallet_markup(lang), disable_web_page_preview=True,
        )
    except TelegramError as exc:
        # Never started the bot, blocked it, left Telegram: not retried.
        logger.info(f"personal: not delivered to {tg_user_id}: {type(exc).__name__}")
        return False
    return True


# ------------------------------------------------------------------ bridge --

def bridge_messages(rows, owners: dict[str, list[int]]) -> list[tuple[int, str]]:
    """(tg user, text) for completed bridge requests that touch a linked wallet."""
    out: list[tuple[int, str]] = []
    for _id, direction, token, sender, recipient, amount in rows:
        what = f"{_format_decimal_amount(amount)} {token}"
        route = _direction_label(direction)
        to_owner = owners.get((recipient or "").lower(), [])
        for tg in to_owner:
            out.append((tg, T(f"Мост доставил {what} ({route}) на {_short_addr(recipient)}.",
                              f"The bridge delivered {what} ({route}) to {_short_addr(recipient)}.")))
        for tg in owners.get((sender or "").lower(), []):
            if tg not in to_owner:
                out.append((tg, T(f"Ваш перевод через мост дошёл: {what} ({route}) на {_short_addr(recipient)}.",
                                  f"Your bridge transfer arrived: {what} ({route}) to {_short_addr(recipient)}.")))
    return out


def bridge_tick() -> list[tuple[int, str]]:
    last = _kv_get(BRIDGE_CURSOR)
    with engine.connect() as conn:
        if last is None:
            # History isn't news: start after whatever is already done.
            top = conn.execute(text(
                "SELECT COALESCE(MAX(id), 0) FROM bridge_requests WHERE status = 'completed'"
            )).scalar() or 0
            _kv_set(BRIDGE_CURSOR, str(top))
            return []
        rows = conn.execute(
            text("""
                SELECT id, direction, token, sender_address, recipient_address, amount
                FROM bridge_requests
                WHERE status = 'completed' AND id > :last
                ORDER BY id ASC LIMIT 100
            """),
            {"last": int(last)},
        ).fetchall()
    if not rows:
        return []
    _kv_set(BRIDGE_CURSOR, str(rows[-1][0]))
    owners = linked_owners()
    return bridge_messages(rows, owners) if owners else []


# --------------------------------------------------------------- transfers --

def _arrived(amount: str, symbol: str, usd: float | None, sender: str) -> str:
    worth = f" (≈ {_fmt_usd(usd)})" if usd is not None else ""
    return T(f"Пришло {amount} {symbol}{worth} от {_short_addr(sender)}.",
             f"Received {amount} {symbol}{worth} from {_short_addr(sender)}.")


def token_messages(w3: Web3, logs, owners: dict[str, list[int]]) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for log in logs:
        topics = log["topics"]
        if len(topics) < 3:
            continue
        sender = _decode_topic_address(topics[1])
        recipient = _decode_topic_address(topics[2]).lower()
        if sender.lower() == ZERO_ADDRESS or sender.lower() == recipient or recipient not in owners:
            continue
        data = _hex_no_prefix(log["data"])
        if not data:
            continue
        value = int(data[:64], 16)
        token = log["address"]
        price = _get_token_usd_price(w3, token)
        if price is None or value == 0:
            continue
        symbol, decimals = _get_token_meta(w3, token)
        amount = value / 10**decimals
        usd = amount * price
        if usd < MIN_NOTIFY_USD:
            continue
        for tg in owners[recipient]:
            out.append((tg, _arrived(_fmt_amount(amount), symbol, usd, sender)))
    return out


def native_messages(w3: Web3, blocks, owners: dict[str, list[int]]) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for block in blocks:
        for tx in block["transactions"]:
            recipient = (tx.get("to") or "").lower()
            if recipient not in owners or not tx.get("value"):
                continue
            sender = tx.get("from") or ""
            if sender.lower() == recipient:
                continue
            usd = _cyber_usd(w3, int(tx["value"]))
            if usd is not None and usd < MIN_NOTIFY_USD:
                continue
            for tg in owners[recipient]:
                out.append((tg, _arrived(_fmt_amount(int(tx["value"]) / 10**18), "CYBER", usd, sender)))
    return out


def transfer_tick(w3: Web3) -> list[tuple[int, str]]:
    head = w3.eth.block_number
    last = _kv_get(BLOCK_CURSOR)
    if last is None:
        _kv_set(BLOCK_CURSOR, str(head))
        return []
    start = int(last) + 1
    end = min(head, start + MAX_BLOCKS_PER_TICK - 1)
    if end < start:
        return []

    owners = linked_owners()
    out: list[tuple[int, str]] = []
    if owners:
        logs = w3.eth.get_logs({
            "fromBlock": start, "toBlock": end,
            "topics": [TRANSFER_TOPIC, None, [_address_topic_hex(a) for a in owners]],
        })
        out += token_messages(w3, logs, owners)
        blocks = [w3.eth.get_block(n, full_transactions=True) for n in range(start, end + 1)]
        out += native_messages(w3, blocks, owners)
    _kv_set(BLOCK_CURSOR, str(end))
    return out


# ------------------------------------------------------------------ prices --

def price_moves(prices, marks, now: float) -> tuple[list[tuple[str, str, float, float]], dict]:
    """Tokens that moved PRICE_MOVE or more from their mark, and the new marks.

    `prices` is (address, symbol, price) from the market snapshot; `marks` is
    address → (price, marked_at). A token seen for the first time is marked,
    not reported; a token reported within PRICE_QUIET_SECONDS waits, so a
    price bouncing around a threshold doesn't write every five minutes.
    """
    moved: list[tuple[str, str, float, float]] = []
    updates: dict[str, tuple[float, float]] = {}
    for address, symbol, price in prices:
        if price is None or price <= 0:
            continue
        mark = marks.get(address)
        if mark is None:
            updates[address] = (price, now)
            continue
        before, marked_at = mark
        if abs(price / before - 1) >= PRICE_MOVE and now - marked_at >= PRICE_QUIET_SECONDS:
            moved.append((address, symbol, before, price))
            updates[address] = (price, now)
    return moved, updates


def _move_text(symbol: str, before: float, after: float, amount: float) -> str:
    change = (after / before - 1) * 100
    prices = f"{abs(change):.0f}%: {_fmt_usd(before)} → {_fmt_usd(after)}."
    holding = f"{_fmt_amount(amount)} {symbol} ≈ {_fmt_usd(amount * after)}."
    return T(
        f"{symbol} {'вырос' if change > 0 else 'упал'} на {prices}\nУ вас {holding}",
        f"{symbol} {'rose' if change > 0 else 'fell'} {prices}\nYou hold {holding}",
    )


def _held(w3: Web3, token: str, owner: str) -> int:
    contract = w3.eth.contract(address=Web3.to_checksum_address(token), abi=BALANCE_OF_ABI)
    held = contract.functions.balanceOf(Web3.to_checksum_address(owner)).call()
    # CYBER is mostly held as the native coin; WCYBER's price is its price.
    if WCYBER_ADDRESS and token.lower() == WCYBER_ADDRESS.lower():
        held += w3.eth.get_balance(Web3.to_checksum_address(owner))
    return held


def price_tick(w3: Web3, now: float) -> list[tuple[int, str]]:
    with engine.connect() as conn:
        prices = conn.execute(text(
            "SELECT address, symbol, price_usd FROM token_prices WHERE price_usd IS NOT NULL"
        )).fetchall()
        marks = {
            row[0]: (row[1], row[2])
            for row in conn.execute(text("SELECT address, price_usd, marked_at FROM tg_price_marks"))
        }
    moved, updates = price_moves(prices, marks, now)
    if updates:
        with engine.begin() as conn:
            for address, (price, at) in updates.items():
                conn.execute(
                    text("""
                        INSERT INTO tg_price_marks (address, price_usd, marked_at) VALUES (:a, :p, :t)
                        ON CONFLICT(address) DO UPDATE SET price_usd = :p, marked_at = :t
                    """),
                    {"a": address, "p": price, "t": at},
                )
    if not moved:
        return []

    owners = linked_owners()
    out: list[tuple[int, str]] = []
    for address, symbol, before, after in moved:
        _sym, decimals = _get_token_meta(w3, address)
        name = "CYBER" if WCYBER_ADDRESS and address.lower() == WCYBER_ADDRESS.lower() else symbol
        for owner, tgs in owners.items():
            try:
                amount = _held(w3, address, owner) / 10**decimals
            except Exception as exc:
                logger.debug(f"personal prices: balance {address} of {owner}: {exc}")
                continue
            if amount * after < MIN_HOLDING_USD:
                continue
            for tg in tgs:
                out.append((tg, _move_text(name, before, after, amount)))
    return out


def cyberia_web3() -> Web3:
    """Cyberia is proof-of-authority: its blocks carry a long extraData that
    web3 refuses to decode without this middleware — and reading whole blocks
    is how native coin arriving is found."""
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
    return w3


async def personal_loop(application: Application) -> None:
    w3 = cyberia_web3()
    while True:
        ticks = (
            ("bridge", bridge_tick),
            ("transfers", lambda: transfer_tick(w3)),
            ("prices", lambda: price_tick(w3, time.time())),
        )
        for name, tick in ticks:
            try:
                messages = await asyncio.to_thread(tick)
            except Exception as exc:  # pragma: no cover - keep the loop alive
                logger.warning(f"personal {name}: {exc}")
                continue
            for tg_user_id, body in messages:
                await notify(application.bot, tg_user_id, body)
        await asyncio.sleep(EVENT_WATCH_POLL_SECONDS)
