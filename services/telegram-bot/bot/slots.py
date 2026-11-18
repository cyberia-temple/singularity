"""A slot machine in the chat, paid out of a bank the chat actually holds.

The reels are **Telegram's**. The bot sends the native 🎰 dice and reads the
value the server picked; it cannot choose it, re-roll it or see it early, which
is the whole reason this is a dice and not a `random.randint` — in a game that
moves balances, "trust the bot's RNG" is not an answer anyone should accept.

Nothing here mints. A losing stake goes into the chat's bank and a win comes
back out of it, so the tokens in play are only ever ones somebody accrued: the
sum of every `pending_rewards` row plus the bank is constant across any sequence
of spins. That makes the bank the thing the design is really about, and it is
run the way the bridge runs destination inventory — **a bet is refused before
the reels turn if the bank could not pay its jackpot**, never after. Each spin
holds its own worst case (`stake × MAX`) until it settles, so two spins in the
same second cannot both be promised the same money, and the largest bet the
machine will take is published rather than discovered by losing.

The bank is funded by hand (`/slots_bank`) and is not withdrawable: giving it
back would need per-depositor shares, which is a liquidity pool and not a slot
machine. What it does instead is grow — the paytable returns 93.75% of turnover,
and that figure is computed from the table below rather than typed next to it.
"""
import asyncio
import logging
import time

from sqlalchemy import text
from telegram import Dice
from telegram.error import TelegramError

from bot.db import engine
from bot.language import T, lang_of, say, tr
from bot.stakes import UNIT, amount, chat_token, credit, parse_stake, seen, transaction  # noqa: F401

logger = logging.getLogger(__name__)

# Telegram packs the three reels into one value: `value - 1` in base 4, least
# significant digit leftmost. 0 is BAR and 3 is the seven, so 1 is BAR BAR BAR
# and 64 is 7️⃣7️⃣7️⃣ — the two jackpots at the two ends of the range.
FACES = {0: "BAR", 1: "🍇", 2: "🍋", 3: "7️⃣"}
OUTCOMES = Dice.MAX_VALUE_SLOT_MACHINE  # 64, all equally likely.

# What each combination pays, as a multiplier on the whole bet: ×28 hands back
# the stake and 27 more, ×1 is the stake and nothing else. Keyed by (shape,
# symbol); anything absent pays nothing.
#
# Two sevens is **nine** outcomes and not three — the odd reel can be any of
# three positions holding any of three other symbols — which is why rtp() is
# computed from this table instead of being worked out by hand beside it: the
# first draft of these numbers read as 93.75% and paid 112.5%.
WINS = {
    ("three", 3): 28,   # 7️⃣ 7️⃣ 7️⃣      1/64
    ("three", 0): 13,   # BAR BAR BAR    1/64
    ("three", 2): 6,    # 🍋 🍋 🍋       1/64
    ("three", 1): 4,    # 🍇 🍇 🍇       1/64
    ("pair", 3): 1,     # две семёрки    9/64 — ставка назад
}
MAX_MULTIPLIER = max(WINS.values())

# One spin at a time per player, and not faster than this: the machine posts two
# messages per pull, so an unthrottled loop is a flood with a stake attached.
COOLDOWN = 5
# A spin whose dice never came back. Refunded rather than guessed at — the value
# lives on Telegram's side and a crash in that one-second window must not pay.
STUCK = 60
# Telegram's 🎰 animation runs about two seconds; the result is in the API
# response immediately. Announcing it at once spoils the pull for everyone
# watching, so the *message* waits and the settled bank does not.
REVEAL = 2.4


def ensure_schema():
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS slots_bank (
                chat_id INTEGER PRIMARY KEY,
                symbol TEXT NOT NULL,
                balance TEXT NOT NULL DEFAULT '0',
                reserved TEXT NOT NULL DEFAULT '0'
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS slots_spins (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, user_name TEXT,
                stake TEXT NOT NULL, symbol TEXT NOT NULL, held TEXT NOT NULL,
                value INTEGER, payout TEXT,
                status TEXT NOT NULL DEFAULT 'spinning',
                created_at INTEGER NOT NULL
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS slots_open ON slots_spins(status, created_at)"))
        conn.execute(text("CREATE INDEX IF NOT EXISTS slots_by_player ON slots_spins(chat_id, user_id, created_at)"))


# --- the machine ---------------------------------------------------------------
def reels(value):
    """The three symbols behind a 🎰 dice value, left to right."""
    if not isinstance(value, int) or isinstance(value, bool) or not Dice.MIN_VALUE <= value <= OUTCOMES:
        raise ValueError(f"Не похоже на результат 🎰: {value!r}.")
    step = value - 1
    return tuple((step >> shift) & 3 for shift in (0, 2, 4))


def shape(value):
    """(вид, символ) — ('three'|'pair'|'none', face). The machine has no left
    or right: only how many reels agree and which symbol they agree on."""
    picks = reels(value)
    face = max(picks, key=picks.count)
    count = picks.count(face)
    return ("three" if count == 3 else "pair" if count == 2 else "none"), face


def multiplier(value):
    """What this spin pays per unit staked. 0 for the 37.5% that pay nothing."""
    return WINS.get(shape(value), 0)


def payout(stake, value):
    return int(stake) * multiplier(value)


def rtp():
    """Return to player, read off WINS rather than written beside it — a number
    the paytable can contradict is a number the paytable will contradict."""
    return sum(multiplier(value) for value in range(1, OUTCOMES + 1)) / OUTCOMES


def combo(value, lang="ru"):
    """The line as it reads in the chat: the symbols, then what they are."""
    kind, face = shape(value)
    line = " ".join(FACES[pick] for pick in reels(value))
    times = multiplier(value)
    if not times:
        return f"{line} — " + tr(lang, "мимо", "no luck")
    if kind == "three":
        what = tr(lang, "ДЖЕКПОТ", "JACKPOT") if face == 3 else tr(lang, "три в ряд", "three in a row")
        return f"{line} — {what} ×{times}"
    if times == 1:
        return f"{line} — " + tr(lang, "пара семёрок, ставка назад", "two sevens, stake back")
    return f"{line} — " + tr(lang, f"пара семёрок ×{times}", f"two sevens ×{times}")


def paytable(lang="ru"):
    """The table as printed, richest first, one line per paying combination."""
    rows = []
    for (kind, face), times in sorted(WINS.items(), key=lambda item: -item[1]):
        symbol = FACES[face]
        prize = tr(lang, "ставка назад", "stake back") if times == 1 else f"×{times}"
        rows.append(f"{' '.join([symbol] * 3)} — {prize}" if kind == "three"
                    else f"{symbol} {symbol} + " + tr(lang, "любой", "any") + f" — {prize}")
    return "\n".join(rows)


# --- the bank -------------------------------------------------------------------
def _bank(conn, chat, symbol=None):
    row = conn.execute(text("SELECT * FROM slots_bank WHERE chat_id=:c"), {"c": chat}).mappings().first()
    if row:
        return int(row["balance"]), int(row["reserved"]), row["symbol"]
    return 0, 0, symbol


def _write_bank(conn, chat, symbol, balance, reserved):
    if balance < reserved or reserved < 0:
        # Unreachable by design; a wrong sign here is somebody being paid twice.
        raise ValueError("Касса автомата разошлась сама с собой; спин отменён.")
    conn.execute(text("""
        INSERT INTO slots_bank(chat_id,symbol,balance,reserved) VALUES(:c,:s,:b,:r)
        ON CONFLICT(chat_id) DO UPDATE SET symbol=excluded.symbol,balance=excluded.balance,reserved=excluded.reserved
    """), {"c": chat, "s": symbol, "b": str(balance), "r": str(reserved)})


def largest_stake(free):
    """The biggest bet whose jackpot the free bank still covers.

    A win of ×MAX costs the bank the payout less the stake it just took, so the
    bet is affordable exactly while `free >= stake × (MAX - 1)`.
    """
    return max(0, int(free) // (MAX_MULTIPLIER - 1))


def bank(chat):
    """(balance, reserved, symbol, largest allowed stake) for the chat."""
    with engine.connect() as conn:
        balance, reserved, symbol = _bank(conn, chat)
    return balance, reserved, symbol, largest_stake(balance - reserved)


def fund(chat, user, stake):
    """Move tokens from a player's accrued balance into the chat's bank."""
    with transaction() as conn:
        symbol = chat_token(conn, chat)
        credit(conn, chat, user, -stake)
        seen(conn, chat, user)
        balance, reserved, _ = _bank(conn, chat, symbol)
        _write_bank(conn, chat, symbol, balance + stake, reserved)
        return balance + stake


# --- a pull ---------------------------------------------------------------------
def reserve(chat, user, stake, now=None, display_name=None):
    """Take the bet and hold the bank's worst case, before the reels turn.

    Everything that can refuse a spin happens here, because after the dice is
    sent there is no honest way to say no: a jackpot the bank cannot pay is a
    broken promise, and a promise is what the animation already made.
    """
    now = int(time.time()) if now is None else now
    with transaction() as conn:
        symbol = chat_token(conn, chat)
        last = conn.execute(text(
            "SELECT status, created_at FROM slots_spins WHERE chat_id=:c AND user_id=:u "
            "ORDER BY id DESC LIMIT 1"
        ), {"c": chat, "u": user}).mappings().first()
        if last and last["status"] == "spinning" and now - last["created_at"] < STUCK:
            raise ValueError(T("Барабаны ещё крутятся.", "The reels are still spinning."))
        if last and now - last["created_at"] < COOLDOWN:
            raise ValueError(T(f"Не так быстро — {COOLDOWN} секунд между спинами.",
                               f"Not so fast — {COOLDOWN} seconds between spins."))

        balance, reserved, _ = _bank(conn, chat, symbol)
        allowed = largest_stake(balance - reserved)
        if stake > allowed:
            raise ValueError(T(
                f"Касса не потянет джекпот с такой ставки. Сейчас максимум "
                f"{amount(allowed)} {symbol} (в кассе {amount(balance - reserved)}). "
                "Пополнить: /slots_bank.",
                f"The till couldn't pay a jackpot on that stake. The most it takes now is "
                f"{amount(allowed)} {symbol} (the till holds {amount(balance - reserved)}). "
                "Top it up: /slots_bank.",
            ) if allowed else T(
                "Касса автомата пуста, играть не на что. Пополнить: /slots_bank <сумма>.",
                "The machine's till is empty, nothing to play for. Top it up: /slots_bank <amount>.",
            ))

        credit(conn, chat, user, -stake)
        seen(conn, chat, user)
        held = stake * MAX_MULTIPLIER
        _write_bank(conn, chat, symbol, balance + stake, reserved + held)
        return conn.execute(text("""INSERT INTO slots_spins(chat_id,user_id,user_name,stake,symbol,held,created_at)
            VALUES(:c,:u,:name,:a,:s,:h,:t) RETURNING id"""),
            {"c": chat, "u": user, "name": display_name, "a": str(stake),
             "s": symbol, "h": str(held), "t": now}).scalar_one()


def settle(spin_id, value):
    """Write down what Telegram rolled and pay it out of the bank."""
    reels(value)  # Refuse anything that is not a 🎰 result before it is stored.
    with transaction() as conn:
        spin = conn.execute(text("SELECT * FROM slots_spins WHERE id=:id"), {"id": spin_id}).mappings().first()
        if not spin:
            raise ValueError(T("Спин не найден.", "No such spin."))
        if spin["status"] != "spinning":
            return dict(spin)  # Already settled or already refunded; never both.

        won = payout(spin["stake"], value)
        balance, reserved, symbol = _bank(conn, spin["chat_id"], spin["symbol"])
        _write_bank(conn, spin["chat_id"], symbol, balance - won, reserved - int(spin["held"]))
        if won:
            credit(conn, spin["chat_id"], spin["user_id"], won)
        conn.execute(text("UPDATE slots_spins SET value=:v,payout=:p,status='settled' WHERE id=:id"),
                     {"v": value, "p": str(won), "id": spin_id})
        return dict(spin, value=value, payout=str(won), status="settled")


def give_back(conn, spin):
    """Undo a pull that never produced a result: stake back, hold released."""
    balance, reserved, symbol = _bank(conn, spin["chat_id"], spin["symbol"])
    _write_bank(conn, spin["chat_id"], symbol, balance - int(spin["stake"]), reserved - int(spin["held"]))
    credit(conn, spin["chat_id"], spin["user_id"], int(spin["stake"]))
    conn.execute(text("UPDATE slots_spins SET status='refunded' WHERE id=:id"), {"id": spin["id"]})


def abandon(spin_id):
    with transaction() as conn:
        spin = conn.execute(text("SELECT * FROM slots_spins WHERE id=:id AND status='spinning'"),
                            {"id": spin_id}).mappings().first()
        if spin:
            give_back(conn, spin)


def sweep(conn, now):
    """Spins whose dice never came back. Refund is the only safe direction: the
    value is Telegram's and we do not have it, so paying would be inventing it."""
    rows = conn.execute(text(
        "SELECT * FROM slots_spins WHERE status='spinning' AND created_at<=:n"
    ), {"n": now - STUCK}).mappings().all()
    for spin in rows:
        give_back(conn, spin)
    return [spin["id"] for spin in rows]


# --- messages -------------------------------------------------------------------
def machine(chat, user=None, lang="ru"):
    """The machine standing there: what it pays, what is in the till, what you
    may bet. This is also every refusal's explanation, so it is one text."""
    balance, reserved, symbol, allowed = bank(chat)
    symbol = symbol or tr(lang, "токен чата", "chat token")
    till = f"{amount(balance - reserved)} {symbol}"
    lines = [
        tr(lang, "🎰 Слоты", "🎰 Slots"),
        tr(lang, f"Касса чата: {till}", f"The chat's till: {till}"),
        tr(lang, f"Максимальная ставка: {amount(allowed)} {symbol}", f"Largest stake: {amount(allowed)} {symbol}")
        if allowed else tr(lang, "Касса пуста — автомат закрыт. Пополнить: /slots_bank <сумма>",
                           "The till is empty — the machine is closed. Top it up: /slots_bank <amount>"),
        "",
        paytable(lang),
        "",
        tr(lang, f"Возврат {rtp() * 100:.2f}% — остальное остаётся в кассе чата.",
           f"Returns {rtp() * 100:.2f}% — the rest stays in the chat's till."),
        tr(lang, "Крутит Telegram: бот отправляет 🎰 и записывает выпавшее, выбрать или "
                 "переиграть результат он не может.",
           "Telegram spins the reels: the bot sends 🎰 and writes down what came up; it cannot "
           "choose or replay the result."),
        tr(lang, "Ставка из накопленных наград /balance, кошелёк не нужен.",
           "Stakes come from the rewards accrued in /balance, no wallet needed."),
        tr(lang, "Играть: /slots <ставка>", "Play: /slots <stake>"),
    ]
    if user is not None:
        with engine.connect() as conn:
            row = conn.execute(text("SELECT amount FROM pending_rewards WHERE chat_id=:c AND user_id=:u"),
                               {"c": chat, "u": user}).scalar_one_or_none()
        mine = f"{amount(row or 0)} {symbol}"
        lines.insert(2, tr(lang, f"Ваш баланс: {mine}", f"Your balance: {mine}"))
    return "\n".join(lines)


def result(spin, lang="ru"):
    """One spin, as the chat reads it afterwards."""
    who = spin["user_name"] or str(spin["user_id"])
    won, symbol = int(spin["payout"] or 0), spin["symbol"]
    stake = f"{amount(spin['stake'])} {symbol}"
    lines = [
        tr(lang, f"🎰 {who} — ставка {stake}", f"🎰 {who} — stake {stake}"),
        combo(spin["value"], lang),
    ]
    if won > int(spin["stake"]):
        lines.append(tr(lang, f"Выигрыш: {amount(won)} {symbol} → /balance", f"Won: {amount(won)} {symbol} → /balance"))
    elif won:
        lines.append(tr(lang, "Ставка возвращена.", "Stake returned."))
    else:
        lines.append(tr(lang, "Ставка ушла в кассу чата.", "The stake went into the chat's till."))
    balance, reserved, _, _ = bank(spin["chat_id"])
    till = f"{amount(balance - reserved)} {symbol}"
    lines.append(tr(lang, f"Касса: {till}", f"Till: {till}"))
    return "\n".join(lines)


def _detach(context, coro):
    application = getattr(context, "application", None)
    if application is not None:
        application.create_task(coro)
    else:
        asyncio.ensure_future(coro)


async def _announce(bot, chat_id, spin, reply_to, delay=REVEAL, lang="ru"):
    """Post the outcome once the reels have stopped for everyone watching.

    The bank is already settled when this runs, so a lost task costs a missing
    message and never a payout — the balance is in /balance either way. It is
    detached because this bot's dispatcher is sequential by design (see README)
    and sleeping inside the handler would stall every other one.
    """
    await asyncio.sleep(delay)
    try:
        await bot.send_message(chat_id=chat_id, text=result(spin, lang), reply_to_message_id=reply_to)
    except TelegramError:
        logger.warning("slots: could not post the result of spin %s", spin["id"])


# --- handlers -------------------------------------------------------------------
async def _anonymous_owner(update, context):
    """Return the owner behind an anonymous message from this chat, if knowable.

    Telegram deliberately omits the sender's user ID from an anonymous admin
    message.  It is therefore safe to attribute it to the owner only when the
    owner is the *only* anonymous administrator.  A linked channel, or a chat
    with another anonymous admin, is indistinguishable from the owner and must
    not be allowed to spend the owner's accrued balance.
    """
    chat, msg = update.effective_chat, update.effective_message
    sender = getattr(msg, "sender_chat", None)
    if not chat or not sender or getattr(sender, "id", None) != chat.id:
        return None
    try:
        administrators = await context.bot.get_chat_administrators(chat.id)
    except TelegramError:
        return None
    anonymous = [member for member in administrators if getattr(member, "is_anonymous", False)]
    owners = [member for member in anonymous if getattr(member, "status", None) == "creator"]
    return owners[0].user if len(anonymous) == len(owners) == 1 else None


async def slots_command(update, context):
    chat, user, msg = update.effective_chat, update.effective_user, update.effective_message
    lang = lang_of(update)
    if not chat or chat.type not in ("group", "supergroup"):
        await msg.reply_text(tr(lang, "Автомат стоит в чате: /slots 10 — он играет на токен этого чата.",
                                "The machine stands in a group chat: /slots 10 — it plays for that chat's token."))
        return
    if msg.sender_chat:
        user = await _anonymous_owner(update, context)
        if user is None:
            await msg.reply_text(tr(
                lang,
                "Обычные участники играют от своих аккаунтов как обычно. Анонимно от имени чата "
                "может играть только его владелец, когда он единственный анонимный администратор.",
                "Members play from their own accounts as usual. Anonymously, as the chat, only "
                "its owner can play, and only while they are the one anonymous admin.",
            ))
            return
    if not user or user.is_bot:
        await msg.reply_text(tr(lang, "Для игры отправьте команду от своего аккаунта, а не от имени канала.",
                                "Send the command from your own account to play, not as a channel."))
        return
    if not context.args:
        await msg.reply_text(machine(chat.id, user.id, lang))
        return

    try:
        spin_id = reserve(chat.id, user.id, parse_stake(context.args[0]),
                          display_name=getattr(user, "name", str(user.id)))
    except ValueError as exc:
        await msg.reply_text(say(lang, exc))
        return

    try:
        rolled = await context.bot.send_dice(chat_id=chat.id, emoji=Dice.SLOT_MACHINE,
                                             reply_to_message_id=msg.message_id)
    except TelegramError:
        abandon(spin_id)
        raise
    spin = settle(spin_id, rolled.dice.value)
    _detach(context, _announce(context.bot, chat.id, spin, rolled.message_id, lang=lang))


async def slots_bank_command(update, context):
    """Show the till, or (admins) push your own accrued tokens into it."""
    chat, user, msg = update.effective_chat, update.effective_user, update.effective_message
    lang = lang_of(update)
    if not chat or chat.type not in ("group", "supergroup"):
        await msg.reply_text(tr(lang, "У автомата своя касса в каждом чате: /slots_bank в группе.",
                                "The machine has its own till in every chat: /slots_bank in a group."))
        return
    if not context.args:
        balance, reserved, symbol, allowed = bank(chat.id)
        symbol = symbol or tr(lang, "токен чата", "chat token")
        till = f"{amount(balance - reserved)} {symbol}"
        held = amount(reserved)
        await msg.reply_text(tr(
            lang,
            f"🎰 Касса чата: {till}"
            + (f" (ещё {held} держат незавершённые спины)" if reserved else "")
            + f"\nМаксимальная ставка: {amount(allowed)} {symbol}\n"
            "Пополнить: /slots_bank <сумма> — из накопленных наград, только админы чата.\n"
            "Касса не выводится обратно: это касса автомата, а не вклад.",
            f"🎰 The chat's till: {till}"
            + (f" ({held} more held by unfinished spins)" if reserved else "")
            + f"\nLargest stake: {amount(allowed)} {symbol}\n"
            "Top up: /slots_bank <amount> — from accrued rewards, chat admins only.\n"
            "The till is never paid back out: it is the machine's till, not a deposit.",
        ))
        return
    if not user or user.is_bot or msg.sender_chat:
        await msg.reply_text(tr(lang, "Пополнить кассу можно только от своего аккаунта.",
                                "Top up the till from your own account only."))
        return
    try:
        member = await context.bot.get_chat_member(chat.id, user.id)
    except TelegramError:
        await msg.reply_text(tr(lang, "Не удалось проверить права в чате. Попробуйте ещё раз.",
                                "Could not check your rights in the chat. Try again."))
        return
    if member.status not in ("creator", "administrator"):
        await msg.reply_text(tr(lang, "Пополнять кассу могут администраторы чата.", "Only chat admins can top up the till."))
        return
    try:
        total = fund(chat.id, user.id, parse_stake(context.args[0]))
    except ValueError as exc:
        await msg.reply_text(say(lang, exc))
        return
    _, reserved, symbol, allowed = bank(chat.id)
    await msg.reply_text(tr(
        lang, f"🎰 Касса пополнена: {amount(total - reserved)} {symbol}.\nМаксимальная ставка: {amount(allowed)} {symbol}.",
        f"🎰 Till topped up: {amount(total - reserved)} {symbol}.\nLargest stake: {amount(allowed)} {symbol}.",
    ))


async def sweep_loop(application):
    while True:
        try:
            with transaction() as conn:
                stuck = sweep(conn, int(time.time()))
            if stuck:
                logger.warning("slots: refunded %d spin(s) whose dice never returned", len(stuck))
        except Exception:
            logger.exception("slots: sweep failed")
        await asyncio.sleep(15)
