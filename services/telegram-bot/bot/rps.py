"""Chat-local duels funded by accrued, unclaimed chat-token rewards.

All escrow transitions are durable SQLite transactions. Telegram messages are
views only: a failed edit or repeated callback can never settle a stake twice.
"""
import asyncio
import logging
import re
import time
from contextlib import contextmanager

from sqlalchemy import text
from telegram import InlineKeyboardButton, InlineKeyboardMarkup
from telegram.error import TelegramError

from bot.db import engine

logger = logging.getLogger(__name__)
MOVES = {"r": "🪨 Камень", "s": "✂️ Ножницы", "p": "📄 Бумага"}
TTL = 600
UNIT = 10**18  # TelegramChatToken uses ERC20's fixed 18 decimals.


def ensure_schema():
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS rps_games (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id INTEGER NOT NULL, message_id INTEGER,
                creator INTEGER NOT NULL, opponent INTEGER,
                creator_name TEXT, opponent_name TEXT,
                stake TEXT NOT NULL, symbol TEXT NOT NULL,
                creator_move TEXT, opponent_move TEXT,
                status TEXT NOT NULL DEFAULT 'open', winner INTEGER,
                expires_at INTEGER NOT NULL
            )
        """))
        conn.execute(text("CREATE INDEX IF NOT EXISTS rps_expiry ON rps_games(status, expires_at)"))


@contextmanager
def transaction():
    with engine.connect() as conn:
        conn.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            yield conn
            conn.commit()
        except BaseException:
            conn.rollback()
            raise


def amount(raw):
    whole, fraction = divmod(int(raw), UNIT)
    return str(whole) + ("." + str(fraction).zfill(18).rstrip("0") if fraction else "")


def parse_stake(value):
    if not re.fullmatch(r"[0-9]{1,60}(?:[.,][0-9]{1,18})?", value):
        raise ValueError("Ставка — положительное число, не более 18 знаков после запятой.")
    whole, _, fraction = value.replace(",", ".").partition(".")
    raw = int(whole) * UNIT + int(fraction.ljust(18, "0"))
    if not 0 < raw <= (2**256 - 1) // 2:
        raise ValueError("Ставка слишком большая или равна нулю.")
    return raw


def credit(conn, chat, user, delta):
    args = {"c": chat, "u": user}
    row = conn.execute(text("SELECT amount FROM pending_rewards WHERE chat_id=:c AND user_id=:u"), args).first()
    balance = int(row[0]) if row else 0
    if balance + delta < 0:
        raise ValueError(f"Недостаточно токенов на внутреннем балансе: {amount(balance)}. "
                         "Проверьте /balance; новые награды начисляются за участие в чате.")
    conn.execute(text("""
        INSERT INTO pending_rewards(chat_id,user_id,amount,updated_at)
        VALUES(:c,:u,:a,datetime('now'))
        ON CONFLICT(chat_id,user_id) DO UPDATE SET amount=excluded.amount,updated_at=excluded.updated_at
    """), {**args, "a": str(balance + delta)})


def refund(conn, game, status):
    for user in (game["creator"], game["opponent"]):
        if user is not None:
            credit(conn, game["chat_id"], user, int(game["stake"]))
    conn.execute(text("UPDATE rps_games SET status=:s WHERE id=:id"), {"s": status, "id": game["id"]})


def expire(conn, now):
    rows = conn.execute(text("SELECT * FROM rps_games WHERE status='open' AND expires_at<=:n"), {"n": now}).mappings().all()
    for game in rows:
        refund(conn, game, "expired")
    return [game["id"] for game in rows]


def create(chat, user, stake, now=None, display_name=None):
    now = int(time.time()) if now is None else now
    with transaction() as conn:
        # Expire only in the background/callback path so its message updates
        # cannot be lost when another command creates a game.
        token = conn.execute(text("SELECT symbol FROM chat_tokens WHERE chat_id=:c AND token_address IS NOT NULL"), {"c": chat}).first()
        if not token:
            raise ValueError("У этого чата ещё нет токена. Администратор может создать его: /create_token.")
        if conn.execute(text("SELECT 1 FROM rps_games WHERE chat_id=:c AND status='open' AND (creator=:u OR opponent=:u)"), {"c": chat, "u": user}).first():
            raise ValueError("Сначала завершите текущую игру или отмените свой вызов кнопкой под ним.")
        credit(conn, chat, user, -stake)
        conn.execute(text("""INSERT INTO chat_members(chat_id,user_id) VALUES(:c,:u)
            ON CONFLICT(chat_id,user_id) DO UPDATE SET last_seen=datetime('now')"""), {"c": chat, "u": user})
        return conn.execute(text("""INSERT INTO rps_games(chat_id,creator,creator_name,stake,symbol,expires_at)
            VALUES(:c,:u,:name,:a,:s,:e) RETURNING id"""),
            {"c": chat, "u": user, "name": display_name, "a": str(stake), "s": token[0], "e": now + TTL}).scalar_one()


def play(game_id, chat, user, move, now=None, display_name=None):
    now = int(time.time()) if now is None else now
    with transaction() as conn:
        game = conn.execute(text("SELECT * FROM rps_games WHERE id=:id AND chat_id=:c"), {"id": game_id, "c": chat}).mappings().first()
        if not game:
            raise ValueError("Игра не найдена в этом чате.")
        if game["status"] != "open":
            return "Игра уже завершена."
        if game["expires_at"] <= now:
            refund(conn, game, "expired")
            return "Время вышло. Ставки возвращены."
        if move == "cancel":
            if user != game["creator"] or game["opponent"] is not None:
                raise ValueError("Отменить вызов может его автор, пока соперник не вступил.")
            refund(conn, game, "cancelled")
            return "Вызов отменён. Ставка возвращена."
        if move not in MOVES:
            raise ValueError("Неизвестный ход.")
        game = dict(game)
        if user == game["creator"]:
            field = "creator_move"
        elif user == game["opponent"]:
            field = "opponent_move"
        elif game["opponent"] is None:
            if conn.execute(text("SELECT 1 FROM rps_games WHERE chat_id=:c AND status='open' AND (creator=:u OR opponent=:u)"), {"c": chat, "u": user}).first():
                raise ValueError("Сначала завершите свою текущую игру.")
            credit(conn, chat, user, -int(game["stake"]))
            conn.execute(text("""INSERT INTO chat_members(chat_id,user_id) VALUES(:c,:u)
                ON CONFLICT(chat_id,user_id) DO UPDATE SET last_seen=datetime('now')"""), {"c": chat, "u": user})
            game["opponent"] = user
            conn.execute(text("UPDATE rps_games SET opponent=:u,opponent_name=:name WHERE id=:id"), {"u": user, "name": display_name, "id": game_id})
            field = "opponent_move"
        else:
            raise ValueError("В этой дуэли уже два игрока. Создайте свою: /rps 10.")
        if game[field] is not None:
            return "Ваш ход уже принят и скрыт до конца игры."
        game[field] = move
        conn.execute(text(f"UPDATE rps_games SET {field}=:m WHERE id=:id"), {"m": move, "id": game_id})
        first, second = game["creator_move"], game["opponent_move"]
        if first and second:
            if first == second:
                refund(conn, game, "draw")
            else:
                winner = game["creator"] if (first, second) in {("r", "s"), ("s", "p"), ("p", "r")} else game["opponent"]
                credit(conn, chat, winner, int(game["stake"]) * 2)
                conn.execute(text("UPDATE rps_games SET status='won',winner=:u WHERE id=:id"), {"u": winner, "id": game_id})
        return "Ход принят."


def view(game_id):
    with engine.connect() as conn:
        game = conn.execute(text("SELECT * FROM rps_games WHERE id=:id"), {"id": game_id}).mappings().one()
    first = game["creator_name"] or str(game["creator"])
    second = game["opponent_name"] or (str(game["opponent"]) if game["opponent"] else "любой участник чата")
    winner = first if game["winner"] == game["creator"] else second
    label = f"Камень–ножницы–бумага #{game_id}\nСтавка каждого: {amount(game['stake'])} {game['symbol']}\n"
    label += f"Игрок 1: {first}\nИгрок 2: {second}\n"
    markup = None
    if game["status"] == "open":
        label += ("\nВыберите ход. Для соперника нажатие — согласие на ставку. "
                  "Ходы скрыты до выбора обоих. На всю игру 10 минут; затем возврат обеих ставок.\n"
                  "Ставки берутся из накопленных наград /balance, кошелёк не нужен.\n"
                  f"Ход первого: {'принят' if game['creator_move'] else 'ожидается'}. "
                  f"Ход второго: {'принят' if game['opponent_move'] else 'ожидается'}.")
        markup = InlineKeyboardMarkup([
            [InlineKeyboardButton(title, callback_data=f"rps:{game_id}:{key}") for key, title in MOVES.items()],
            [InlineKeyboardButton("Отменить вызов", callback_data=f"rps:{game_id}:cancel")],
        ])
    elif game["status"] in ("won", "draw"):
        label += f"\n{MOVES[game['creator_move']]} — {MOVES[game['opponent_move']]}\n"
        label += (f"Победитель: {winner}. Зачислено {amount(int(game['stake']) * 2)} {game['symbol']}.\nБаланс: /balance. Вывод: /claim."
                  if game["status"] == "won" else "Ничья. Обе ставки возвращены.")
    else:
        label += "\nВремя вышло. Ставки возвращены." if game["status"] == "expired" else "\nВызов отменён. Ставка возвращена."
    return game, label, markup


async def refresh(bot, game_id):
    game, label, markup = view(game_id)
    if game["message_id"]:
        try:
            await bot.edit_message_text(chat_id=game["chat_id"], message_id=game["message_id"], text=label, reply_markup=markup)
        except TelegramError:
            logger.warning("rps: could not refresh game %s", game_id)


async def rps_command(update, context):
    chat, user, msg = update.effective_chat, update.effective_user, update.effective_message
    if not chat or chat.type not in ("group", "supergroup"):
        await msg.reply_text("Начните игру в чате: /rps 10. Игра использует токен этого чата.")
        return
    if not user or user.is_bot or msg.sender_chat:
        await msg.reply_text("Для игры отправьте команду от своего аккаунта, а не от имени канала.")
        return
    if len(context.args) != 1:
        await msg.reply_text("/rps 10 — вызов любому участнику чата на 10 токенов. "
                             "Ставки из накопленных наград /balance; кошелёк не нужен. "
                             "Победитель получает обе ставки, ничья или 10 минут без результата — возврат.")
        return
    try:
        game_id = create(chat.id, user.id, parse_stake(context.args[0]), display_name=getattr(user, "name", str(user.id)))
    except ValueError as exc:
        await msg.reply_text(str(exc))
        return
    _, label, markup = view(game_id)
    try:
        sent = await msg.reply_text(label, reply_markup=markup)
    except TelegramError:
        # Even an ambiguous send failure leaves harmless, non-spendable buttons.
        play(game_id, chat.id, user.id, "cancel")
        raise
    with engine.begin() as conn:
        conn.execute(text("UPDATE rps_games SET message_id=:m WHERE id=:id"), {"m": sent.message_id, "id": game_id})


async def rps_callback(update, context):
    query = update.callback_query
    chat = update.effective_chat
    if not chat or chat.type not in ("group", "supergroup") or query.from_user.is_bot:
        await query.answer("Игра доступна участникам чата.", show_alert=True)
        return
    match = re.fullmatch(r"rps:([0-9]+):(r|s|p|cancel)", query.data or "")
    if not match:
        await query.answer("Неизвестная кнопка.")
        return
    game_id, move = int(match[1]), match[2]
    try:
        member = await context.bot.get_chat_member(chat.id, query.from_user.id)
    except TelegramError:
        await query.answer("Не удалось проверить участие в чате. Попробуйте ещё раз.", show_alert=True)
        return
    if member.status not in ("creator", "administrator", "member") and not (
        member.status == "restricted" and member.is_member
    ):
        await query.answer("Играть могут только участники этого чата.", show_alert=True)
        return
    try:
        result = play(game_id, chat.id, query.from_user.id, move, display_name=query.from_user.name)
    except ValueError as exc:
        await query.answer(str(exc)[:200], show_alert=True)
        return
    await query.answer(result)
    await refresh(context.bot, game_id)


async def expiry_loop(application):
    while True:
        try:
            with transaction() as conn:
                expired = expire(conn, int(time.time()))
            for game_id in expired:
                await refresh(application.bot, game_id)
        except Exception:
            logger.exception("rps: expiry sweep failed")
        await asyncio.sleep(15)
