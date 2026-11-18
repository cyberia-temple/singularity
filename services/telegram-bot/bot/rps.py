"""Chat-local duels funded by accrued, unclaimed chat-token rewards.

All escrow transitions are durable SQLite transactions. Telegram messages are
views only: a failed edit or repeated callback can never settle a stake twice.
The money itself lives in `bot.stakes`, shared with the other chat-token game.
"""
import asyncio
import logging
import re
import time

from sqlalchemy import text
from telegram import InlineKeyboardButton, InlineKeyboardMarkup
from telegram.error import TelegramError

from bot.db import engine
from bot.language import T, lang_of, say, tr
from bot.stakes import UNIT, amount, chat_token, credit, parse_stake, seen, transaction  # noqa: F401

logger = logging.getLogger(__name__)
MOVES = {"r": "🪨 Камень", "s": "✂️ Ножницы", "p": "📄 Бумага"}
MOVES_EN = {"r": "🪨 Rock", "s": "✂️ Scissors", "p": "📄 Paper"}
TTL = 600


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
        # The language the duel was opened in, so the timer's edits keep it.
        if "lang" not in {row[1] for row in conn.execute(text("PRAGMA table_info(rps_games)"))}:
            conn.execute(text("ALTER TABLE rps_games ADD COLUMN lang TEXT"))


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


def create(chat, user, stake, now=None, display_name=None, lang=None):
    now = int(time.time()) if now is None else now
    with transaction() as conn:
        # Expire only in the background/callback path so its message updates
        # cannot be lost when another command creates a game.
        symbol = chat_token(conn, chat)
        if conn.execute(text("SELECT 1 FROM rps_games WHERE chat_id=:c AND status='open' AND (creator=:u OR opponent=:u)"), {"c": chat, "u": user}).first():
            raise ValueError(T("Сначала завершите текущую игру или отмените свой вызов кнопкой под ним.",
                               "Finish your current game first, or cancel your challenge with the button under it."))
        credit(conn, chat, user, -stake)
        seen(conn, chat, user)
        return conn.execute(text("""INSERT INTO rps_games(chat_id,creator,creator_name,stake,symbol,expires_at,lang)
            VALUES(:c,:u,:name,:a,:s,:e,:l) RETURNING id"""),
            {"c": chat, "u": user, "name": display_name, "a": str(stake), "s": symbol, "e": now + TTL,
             "l": lang}).scalar_one()


def play(game_id, chat, user, move, now=None, display_name=None):
    now = int(time.time()) if now is None else now
    with transaction() as conn:
        game = conn.execute(text("SELECT * FROM rps_games WHERE id=:id AND chat_id=:c"), {"id": game_id, "c": chat}).mappings().first()
        if not game:
            raise ValueError(T("Игра не найдена в этом чате.", "No such game in this chat."))
        if game["status"] != "open":
            return T("Игра уже завершена.", "This game is already over.")
        if game["expires_at"] <= now:
            refund(conn, game, "expired")
            return T("Время вышло. Ставки возвращены.", "Time is up. The stakes are returned.")
        if move == "cancel":
            if user != game["creator"] or game["opponent"] is not None:
                raise ValueError(T("Отменить вызов может его автор, пока соперник не вступил.",
                                   "Only the challenger can cancel, and only before an opponent joins."))
            refund(conn, game, "cancelled")
            return T("Вызов отменён. Ставка возвращена.", "Challenge cancelled. The stake is returned.")
        if move not in MOVES:
            raise ValueError(T("Неизвестный ход.", "Unknown move."))
        game = dict(game)
        if user == game["creator"]:
            field = "creator_move"
        elif user == game["opponent"]:
            field = "opponent_move"
        elif game["opponent"] is None:
            if conn.execute(text("SELECT 1 FROM rps_games WHERE chat_id=:c AND status='open' AND (creator=:u OR opponent=:u)"), {"c": chat, "u": user}).first():
                raise ValueError(T("Сначала завершите свою текущую игру.", "Finish your current game first."))
            credit(conn, chat, user, -int(game["stake"]))
            seen(conn, chat, user)
            game["opponent"] = user
            conn.execute(text("UPDATE rps_games SET opponent=:u,opponent_name=:name WHERE id=:id"), {"u": user, "name": display_name, "id": game_id})
            field = "opponent_move"
        else:
            raise ValueError(T("В этой дуэли уже два игрока. Создайте свою: /rps 10.",
                               "This duel already has two players. Start your own: /rps 10."))
        if game[field] is not None:
            return T("Ваш ход уже принят и скрыт до конца игры.", "Your move is already in, hidden until the end.")
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
        return T("Ход принят.", "Move accepted.")


def view(game_id):
    with engine.connect() as conn:
        game = conn.execute(text("SELECT * FROM rps_games WHERE id=:id"), {"id": game_id}).mappings().one()
    lang = game.get("lang") or "ru"
    moves = MOVES if lang == "ru" else MOVES_EN
    first = game["creator_name"] or str(game["creator"])
    second = game["opponent_name"] or (str(game["opponent"]) if game["opponent"] else tr(lang, "любой участник чата", "anyone in the chat"))
    winner = first if game["winner"] == game["creator"] else second
    stake = f"{amount(game['stake'])} {game['symbol']}"
    label = tr(lang, f"Камень–ножницы–бумага #{game_id}\nСтавка каждого: {stake}\nИгрок 1: {first}\nИгрок 2: {second}\n",
               f"Rock–paper–scissors #{game_id}\nEach stakes: {stake}\nPlayer 1: {first}\nPlayer 2: {second}\n")
    markup = None
    if game["status"] == "open":
        def state(move):
            return tr(lang, "принят" if move else "ожидается", "in" if move else "waiting")

        label += tr(lang,
                    "\nВыберите ход. Для соперника нажатие — согласие на ставку. "
                    "Ходы скрыты до выбора обоих. На всю игру 10 минут; затем возврат обеих ставок.\n"
                    "Ставки берутся из накопленных наград /balance, кошелёк не нужен.\n"
                    f"Ход первого: {state(game['creator_move'])}. Ход второго: {state(game['opponent_move'])}.",
                    "\nPick a move. For the opponent, pressing one accepts the stake. "
                    "Moves stay hidden until both have chosen. The game has 10 minutes; then both stakes go back.\n"
                    "Stakes come from the rewards accrued in /balance, no wallet needed.\n"
                    f"First move: {state(game['creator_move'])}. Second move: {state(game['opponent_move'])}.")
        markup = InlineKeyboardMarkup([
            [InlineKeyboardButton(title, callback_data=f"rps:{game_id}:{key}") for key, title in moves.items()],
            [InlineKeyboardButton(tr(lang, "Отменить вызов", "Cancel challenge"), callback_data=f"rps:{game_id}:cancel")],
        ])
    elif game["status"] in ("won", "draw"):
        label += f"\n{moves[game['creator_move']]} — {moves[game['opponent_move']]}\n"
        prize = f"{amount(int(game['stake']) * 2)} {game['symbol']}"
        label += (tr(lang, f"Победитель: {winner}. Зачислено {prize}.\nБаланс: /balance. Вывод: /claim.",
                     f"Winner: {winner}. Credited {prize}.\nBalance: /balance. Withdraw: /claim.")
                  if game["status"] == "won" else tr(lang, "Ничья. Обе ставки возвращены.", "A draw. Both stakes are returned."))
    else:
        label += (tr(lang, "\nВремя вышло. Ставки возвращены.", "\nTime is up. The stakes are returned.")
                  if game["status"] == "expired"
                  else tr(lang, "\nВызов отменён. Ставка возвращена.", "\nChallenge cancelled. The stake is returned."))
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
    lang = lang_of(update)
    if not chat or chat.type not in ("group", "supergroup"):
        await msg.reply_text(tr(lang, "Начните игру в чате: /rps 10. Игра использует токен этого чата.",
                                "Start a game in a group chat: /rps 10. It plays for that chat's token."))
        return
    if not user or user.is_bot or msg.sender_chat:
        await msg.reply_text(tr(lang, "Для игры отправьте команду от своего аккаунта, а не от имени канала.",
                                "Send the command from your own account to play, not as a channel."))
        return
    if len(context.args) != 1:
        await msg.reply_text(tr(lang,
                                "/rps 10 — вызов любому участнику чата на 10 токенов. "
                                "Ставки из накопленных наград /balance; кошелёк не нужен. "
                                "Победитель получает обе ставки, ничья или 10 минут без результата — возврат.",
                                "/rps 10 — challenge anyone in the chat for 10 tokens. "
                                "Stakes come from the rewards accrued in /balance; no wallet needed. "
                                "The winner takes both stakes; a draw or 10 minutes without a result refunds them."))
        return
    try:
        game_id = create(chat.id, user.id, parse_stake(context.args[0]),
                         display_name=getattr(user, "name", str(user.id)), lang=lang)
    except ValueError as exc:
        await msg.reply_text(say(lang, exc))
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
    lang = lang_of(update)
    if not chat or chat.type not in ("group", "supergroup") or query.from_user.is_bot:
        await query.answer(tr(lang, "Игра доступна участникам чата.", "The game is for members of the chat."), show_alert=True)
        return
    match = re.fullmatch(r"rps:([0-9]+):(r|s|p|cancel)", query.data or "")
    if not match:
        await query.answer(tr(lang, "Неизвестная кнопка.", "Unknown button."))
        return
    game_id, move = int(match[1]), match[2]
    try:
        member = await context.bot.get_chat_member(chat.id, query.from_user.id)
    except TelegramError:
        await query.answer(tr(lang, "Не удалось проверить участие в чате. Попробуйте ещё раз.",
                              "Could not check your chat membership. Try again."), show_alert=True)
        return
    if member.status not in ("creator", "administrator", "member") and not (
        member.status == "restricted" and member.is_member
    ):
        await query.answer(tr(lang, "Играть могут только участники этого чата.", "Only members of this chat can play."),
                           show_alert=True)
        return
    try:
        result = play(game_id, chat.id, query.from_user.id, move, display_name=query.from_user.name)
    except ValueError as exc:
        await query.answer(say(lang, exc)[:200], show_alert=True)
        return
    await query.answer(say(lang, result))
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
