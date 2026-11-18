"""Daily reminders and "you have a message": the wallet decides, the bot delivers.

Laravel's `gamification:remind` knows whose streak dies tonight and whose
daily quest is one step short; it can't write to Telegram. It leaves each
nudge in `tg_outbox`, and this module sends it with a button that opens the
wallet's Daily screen inside Telegram.

Reminders are on for every Telegram account linked to a wallet; nobody has
to find a setting first. Switching them off happens here — `/remind off`, or
the button under every reminder — and sticks until `/remind` turns them on.
"""
import asyncio
import logging
from datetime import datetime, timezone
from urllib.parse import urlsplit

from sqlalchemy import text
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
from telegram.error import TelegramError
from telegram.ext import Application, ContextTypes

from bot.config import WALLET_MINI_APP_URL
from bot.db import engine
from bot.language import T, lang_for, lang_of, tr

logger = logging.getLogger(__name__)

OFF_CALLBACK = "remind:off"
POLL_SECONDS = 60
BATCH = 30


def ensure_reminder_schema() -> None:
    """The same two tables Laravel's migration creates, whichever side starts first."""
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS tg_reminder_optins (
                tg_user_id INTEGER PRIMARY KEY,
                enabled    INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS tg_outbox (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                tg_user_id INTEGER NOT NULL,
                kind       TEXT NOT NULL,
                text       TEXT NOT NULL,
                url        TEXT,
                created_at TEXT,
                sent_at    TEXT,
                error      TEXT
            )
        """))


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def set_optin(tg_user_id: int, enabled: bool) -> None:
    with engine.begin() as conn:
        conn.execute(
            text("""
                INSERT INTO tg_reminder_optins (tg_user_id, enabled, updated_at)
                VALUES (:u, :e, :t)
                ON CONFLICT(tg_user_id) DO UPDATE SET enabled = :e, updated_at = :t
            """),
            {"u": tg_user_id, "e": 1 if enabled else 0, "t": _now()},
        )


def is_opted_in(tg_user_id: int) -> bool:
    """On unless this account switched reminders off."""
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT enabled FROM tg_reminder_optins WHERE tg_user_id = :u"),
            {"u": tg_user_id},
        ).fetchone()
    return row is None or bool(row[0])


def wallet_url(path: str | None) -> str:
    """The wallet page with the reminder's query (`?section=daily`) on it."""
    query = urlsplit(path or "").query
    return f"{WALLET_MINI_APP_URL}?{query}" if query else WALLET_MINI_APP_URL


# What the button under a nudge says, by the outbox row's `kind`. A reminder
# opens the Daily screen; a "somebody wrote to you" opens the wallet's chat.
OPEN_LABELS = {"chat.message": T("Открыть чат", "Open chat")}
OPEN_DAILY = T("Открыть Daily", "Open Daily")


def reminder_markup(path: str | None, kind: str | None = None, lang: str = "ru") -> InlineKeyboardMarkup:
    label = OPEN_LABELS.get(kind or "", OPEN_DAILY)(lang)
    return InlineKeyboardMarkup([
        [InlineKeyboardButton(label, web_app=WebAppInfo(url=wallet_url(path)))],
        [InlineKeyboardButton(tr(lang, "Выключить напоминания", "Turn reminders off"), callback_data=OFF_CALLBACK)],
    ])


OPTED_IN_TEXT = T(
    "Напоминания включены. Раз в день, не больше: если серия прерывается сегодня "
    "или до выполнения дневного задания остался шаг. Выключить — /remind off.\n\n"
    "Напоминания приходят, если этот Telegram связан с кошельком: /set_wallet.",
    "Reminders are on. Once a day at most: when your streak breaks today "
    "or the daily quest is one step from done. Turn them off: /remind off.\n\n"
    "Reminders arrive when this Telegram is linked to a wallet: /set_wallet.",
)
REMINDERS_ON = T("Напоминания включены.", "Reminders are on.")
REMINDERS_OFF = T("Напоминания выключены.", "Reminders are off.")


async def remind_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """`/remind`, `/remind on`, `/remind off` — private chats only."""
    chat = update.effective_chat
    user = update.effective_user
    lang = lang_of(update)
    if chat is None or user is None or chat.type != "private":
        await update.message.reply_text(tr(lang, "Напоминания настраиваются в личном чате с ботом.",
                                           "Reminders are set up in a private chat with the bot."))
        return

    arg = (context.args[0].lower() if context.args else "on")
    if arg == "off":
        set_optin(user.id, False)
        await update.message.reply_text(REMINDERS_OFF(lang))
        return
    if arg == "status":
        on = is_opted_in(user.id)
        await update.message.reply_text((REMINDERS_ON if on else REMINDERS_OFF)(lang))
        return

    set_optin(user.id, True)
    await update.message.reply_text(OPTED_IN_TEXT(lang))


async def remind_off_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if query is None or query.from_user is None:
        return
    set_optin(query.from_user.id, False)
    await query.answer(tr(lang_of(update), "Уведомления выключены. Включить — /remind.",
                          "Notifications are off. Turn them on: /remind."))


async def deliver_pending(bot) -> int:
    """Send what Laravel left in the outbox; returns how many were sent."""
    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT id, tg_user_id, text, url, kind FROM tg_outbox WHERE sent_at IS NULL ORDER BY id LIMIT :n"),
            {"n": BATCH},
        ).fetchall()

    sent = 0
    for row_id, tg_user_id, body, url, kind in rows:
        error = None
        if not is_opted_in(tg_user_id):
            error = "opted_out"
        else:
            try:
                await bot.send_message(chat_id=tg_user_id, text=body,
                                       reply_markup=reminder_markup(url, kind, lang_for(tg_user_id, fallback="ru")))
                sent += 1
            except TelegramError as exc:
                # Blocked the bot, never started it, deleted account: recorded,
                # not retried — a reminder that bounces is not worth a second try.
                error = type(exc).__name__
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE tg_outbox SET sent_at = :t, error = :e WHERE id = :id"),
                {"t": _now(), "e": error, "id": row_id},
            )
    return sent


async def outbox_loop(application: Application) -> None:
    while True:
        try:
            await deliver_pending(application.bot)
        except Exception as exc:  # pragma: no cover - keep the loop alive
            logger.warning("reminder outbox: %s", exc)
        await asyncio.sleep(POLL_SECONDS)
