"""Which language the bot speaks in a chat: Russian or English.

The bot sits in Russian and English chats alike, so the language belongs to the
chat, not to the code. A chat's admins pick it with /language and from then on
every answer there, and the chat's command menu, is in that language. Until
they do — and in a private chat until its owner does — each person is answered
in the language of their own Telegram app: Russian for ru/be/kk/ky, English for
everything else.

Texts are written in place as pairs, `tr(lang, "по-русски", "in English")`,
rather than as keys into a catalogue: with two languages a pair keeps both
versions in front of whoever edits the sentence. Code below a handler that has
no `lang` raises or returns a `T` instead, and the handler picks the side with
`say(lang, …)`.

Broadcast posts (the chain announcers, buy bots, digests) are not answers to
anyone and keep their one language.
"""
import logging

from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from telegram import BotCommand, BotCommandScopeChat, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.error import TelegramError

from bot import db
from bot.config import AI_ENABLED, AI_MODEL_CHOICE, FISHING_ENABLED, MUSIC_ENABLED

logger = logging.getLogger(__name__)

LANGS = {"ru": "🇷🇺 Русский", "en": "🇬🇧 English"}
DEFAULT = "en"
# Telegram app languages whose people are more at home in Russian than English.
RUSSIAN_READERS = {"ru", "be", "kk", "ky"}
CALLBACK = "lang"


def tr(lang, ru, en):
    return ru if lang == "ru" else en


class T(str):
    """A text in both languages, for code that does not know whose it is.
    As a plain string it is the Russian side, which is what such code spoke
    before there was a choice; `T(...)(lang)` or `say(lang, …)` picks."""

    def __new__(cls, ru, en):
        self = super().__new__(cls, ru)
        self.ru, self.en = str(ru), str(en)
        return self

    def __call__(self, lang):
        return tr(lang, self.ru, self.en)

    def __repr__(self):
        return f"T({self.ru!r}, {self.en!r})"


def say(lang, value):
    """The text to show for a T, an exception carrying one, or anything else."""
    if isinstance(value, BaseException) and value.args:
        value = value.args[0]
    return value(lang) if isinstance(value, T) else str(value)


def guess(language_code):
    code = (language_code or "").split("-")[0].lower()
    return "ru" if code in RUSSIAN_READERS else "en"


def chat_language(chat_id):
    """The language set for this chat, or None when nobody chose one."""
    try:
        with db.engine.connect() as conn:
            return conn.execute(text("SELECT lang FROM chat_languages WHERE chat_id=:c"),
                                {"c": chat_id}).scalar_one_or_none()
    except OperationalError as exc:
        # No table yet (a fresh database before ensure_schema): nobody chose.
        logger.debug("language: lookup for chat %s failed: %s", chat_id, exc)
        return None


def set_chat_language(chat_id, lang, set_by=None):
    """Pin the chat to `lang`; None goes back to each person's own language."""
    with db.engine.begin() as conn:
        if lang is None:
            conn.execute(text("DELETE FROM chat_languages WHERE chat_id=:c"), {"c": chat_id})
            return
        if lang not in LANGS:
            raise ValueError(f"unknown language {lang!r}")
        conn.execute(text("""
            INSERT INTO chat_languages(chat_id, lang, set_by, updated_at)
            VALUES(:c, :l, :u, datetime('now'))
            ON CONFLICT(chat_id) DO UPDATE SET lang=excluded.lang, set_by=excluded.set_by,
                updated_at=excluded.updated_at
        """), {"c": chat_id, "l": lang, "u": set_by})


def chosen_languages():
    """Every chat that chose a language: {chat_id: lang}."""
    try:
        with db.engine.connect() as conn:
            return dict(conn.execute(text("SELECT chat_id, lang FROM chat_languages")).all())
    except OperationalError:
        return {}


def lang_for(chat_id=None, user=None, fallback=DEFAULT):
    """The chat's language if it chose one, else the person's own. Messages
    nobody asked for just now (a notification, a reminder) have no person to
    read it from and use `fallback` — the language they were written in."""
    chosen = chat_language(chat_id) if chat_id is not None else None
    if chosen:
        return chosen
    return guess(getattr(user, "language_code", None)) if user is not None else fallback


def lang_of(update):
    chat = getattr(update, "effective_chat", None)
    return lang_for(getattr(chat, "id", None), getattr(update, "effective_user", None))


# --- the command menu ----------------------------------------------------------
def commands(lang):
    """The ☰ command list, in `lang`."""
    def c(name, ru, en):
        return BotCommand(name, tr(lang, ru, en))

    menu = [
        c("start", "Начать получать TG", "Start receiving TG"),
        c("help", "Список команд", "Show available commands"),
        c("language", "🌐 Язык бота в этом чате", "🌐 The bot's language in this chat"),
        c("set_wallet", "Привязать кошелёк (адрес спросит, если не указан)", "Link wallet (asks for address if omitted)"),
        c("unset_wallet", "Отвязать кошелёк (начисления сохранятся)", "Unlink your wallet (keep pending)"),
        c("wallet", "Ваш привязанный кошелёк", "Show your linked wallet"),
        c("balance", "TG, токены чатов и начисления", "Show TG, chat tokens, and pending rewards"),
        c("rps", "Камень–ножницы–бумага на токены чата", "Rock–paper–scissors for this chat's tokens"),
        c("slots", "🎰 Слоты на токены чата", "🎰 Slots for this chat's tokens"),
        c("slots_bank", "🎰 Касса автомата этого чата", "🎰 This chat's slot machine till"),
    ]
    if FISHING_ENABLED:
        menu += [
            c("fish", "🎣 Рыбалка: весь улов — NFT-лут; /fish ⚡ — энергетик", "🎣 Fishing: every catch is NFT loot; /fish ⚡ pours energy"),
            c("fish_bucket", "🪣 Ведро: улов в NFT или скупщику", "🪣 Bucket: mint the catch or sell it"),
            c("fish_spots", "🗺 Места ловли и ключи к ним", "🗺 Fishing places and their keys"),
            c("fish_shop", "🛒 Удочки, вёдра, наживки, энергетики", "🛒 Rods, buckets, bait, energy drinks"),
            c("fish_bag", "🎒 Рюкзак: снасть, наживки, лучший улов", "🎒 Your gear, bait and best catches"),
            c("fish_top", "🏆 Рекорды чата по рыбалке", "🏆 This chat's fishing records"),
        ]
    menu += [
        c("claim", "Забрать накопленные награды токенами чата", "Collect your accrued chat-token rewards"),
        c("token", "Токен наград этого чата", "Show this chat's reward token"),
        c("cancel", "Отменить ввод", "Cancel an interactive prompt"),
        c("github", "Привязать GitHub для аирдропа GITHUB", "Link GitHub for GITHUB airdrop"),
        c("website", "Сайт проекта", "Open the project website"),
        c("app", "Скачать кошелёк Cyberia", "Download the Cyberia wallet app"),
        c("open", "Открыть кошелёк в Telegram", "Open the wallet inside Telegram"),
        c("arcade", "Ончейн камень–ножницы–бумага на CYBER", "On-chain rock–paper–scissors for CYBER"),
        c("x", "Ссылки на X (Twitter) и Telegram", "Show X (Twitter) and Telegram links"),
        c("ca", "Адрес контракта токена этого чата", "Show this chat's token contract address"),
        c("stats", "Рынок или сводка активности этого чата", "This chat's market data or activity digest"),
        c("buybot", "(админы) Проект чата и уведомления о покупках", "(admins) Project settings and buy alerts"),
        c("ask", "Спросить ИИ-помощника Cyberia", "Ask the Cyberia AI assistant"),
    ]
    if MUSIC_ENABLED:
        menu += [
            c("track", "Найти трек и прислать его: Исполнитель — Название", "Find a song and post it: Artist — Title"),
            c("music", "Музыка в чате; админам: автопоиск on/off", "Music here; admins: auto-search on/off"),
        ]
    if AI_ENABLED and AI_MODEL_CHOICE:
        menu.append(c("model", "Выбрать бесплатную модель ИИ", "Choose which free AI model answers you"))
    menu += [
        c("whale", "Проверить CYBER.sol и войти в чат китов", "Verify CYBER.sol to join the whales chat"),
        c("create_token", "(админы) Создать токен наград чата", "(admins) Create a chat reward token"),
        c("set_rewards_interval", "(админы) Изменить интервал выплат", "(admins) Change rewards interval"),
        c("reward_now", "(админы) Выплатить награды сейчас", "(admins) Pay rewards immediately"),
        c("set_channel_wallet", "(админы канала) Кошелёк для NFT из постов", "(channel admins) Wallet to receive post NFTs"),
    ]
    return menu


async def publish_menus(bot):
    """English for everyone, Russian for Russian Telegram apps, and the chosen
    language in each chat that chose one (a chat's own list outranks both)."""
    await bot.set_my_commands(commands("en"))
    await bot.set_my_commands(commands("ru"), language_code="ru")
    for chat_id, lang in chosen_languages().items():
        await _chat_menu(bot, chat_id, lang)


async def _chat_menu(bot, chat_id, lang):
    scope = BotCommandScopeChat(chat_id)
    try:
        if lang:
            await bot.set_my_commands(commands(lang), scope=scope)
        else:
            await bot.delete_my_commands(scope=scope)
    except TelegramError as exc:
        # A chat the bot has left: its menu does not matter any more.
        logger.info("language: menu for chat %s not set: %s", chat_id, exc)


# --- /language -----------------------------------------------------------------
def panel(lang, chosen, is_group):
    """The /language message and its buttons."""
    if chosen:
        now = tr(lang, f"Сейчас: {LANGS[chosen]} — для всех в этом чате.",
                 f"Now: {LANGS[chosen]} — for everyone in this chat.")
    else:
        now = tr(lang, "Сейчас: авто — каждому на языке его Telegram.",
                 "Now: auto — everyone gets their own Telegram app's language.")
    lines = [tr(lang, "🌐 Язык бота · Bot language", "🌐 Bot language · Язык бота"), "", now]
    if is_group:
        lines.append(tr(lang, "Менять язык чата могут администраторы.", "Chat admins can change it."))

    def button(code, label):
        mark = "✓ " if code == (chosen or "auto") else ""
        return InlineKeyboardButton(mark + label, callback_data=f"{CALLBACK}:{code}")

    markup = InlineKeyboardMarkup([
        [button(code, label) for code, label in LANGS.items()],
        [button("auto", "🌐 Авто · Auto")],
    ])
    return "\n".join(lines), markup


async def _may_choose(update, context):
    chat, msg = update.effective_chat, update.effective_message
    if chat.type == "private":
        return True
    # An anonymous admin speaks as the group itself.
    sender = getattr(msg, "sender_chat", None) if update.callback_query is None else None
    if sender is not None and sender.id == chat.id:
        return True
    from bot.handlers import is_chat_admin

    return await is_chat_admin(update, context)


async def _choose(update, context, code):
    """Apply a choice; returns the language now in force."""
    chat, user = update.effective_chat, update.effective_user
    chosen = None if code == "auto" else code
    set_chat_language(chat.id, chosen, getattr(user, "id", None))
    await _chat_menu(context.bot, chat.id, chosen)
    logger.info("language: chat %s set to %s by %s", chat.id, code, getattr(user, "id", None))
    return lang_of(update)


async def language_command(update, context):
    chat, msg = update.effective_chat, update.effective_message
    if not chat or not msg:
        return
    is_group = chat.type != "private"
    code = (context.args[0].lower() if context.args else "").strip()
    code = {"рус": "ru", "русский": "ru", "russian": "ru", "англ": "en", "english": "en",
            "авто": "auto"}.get(code, code)
    if code:
        lang = lang_of(update)
        if code not in (*LANGS, "auto"):
            await msg.reply_text(tr(lang, "Языки: ru, en или auto. Например: /language en",
                                    "Languages: ru, en or auto. For example: /language ru"))
            return
        if not await _may_choose(update, context):
            await msg.reply_text(tr(lang, "Язык чата меняют администраторы.", "Only chat admins can change the language."))
            return
        lang = await _choose(update, context, code)
    else:
        lang = lang_of(update)
    body, markup = panel(lang, chat_language(chat.id), is_group)
    await msg.reply_text(body, reply_markup=markup)


async def language_callback(update, context):
    query = update.callback_query
    code = (query.data or "").partition(":")[2]
    chat = update.effective_chat
    if code not in (*LANGS, "auto") or chat is None:
        await query.answer()
        return
    if not await _may_choose(update, context):
        await query.answer(tr(lang_of(update), "Язык чата меняют администраторы.",
                              "Only chat admins can change the language."), show_alert=True)
        return
    lang = await _choose(update, context, code)
    await query.answer(tr(lang, "Готово", "Done"))
    body, markup = panel(lang, chat_language(chat.id), chat.type != "private")
    try:
        await query.edit_message_text(body, reply_markup=markup)
    except TelegramError:
        pass
