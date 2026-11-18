"""Telegram command and message handlers (no background loops)."""
import re
import asyncio
import secrets
import logging
from datetime import datetime, timedelta, timezone

from web3 import Web3
from sqlalchemy import text

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
from telegram.ext import ContextTypes
from telegram.error import TelegramError

from bot.config import (
    TOKEN_ADDRESS, FACTORY_ABI, TOKEN_CREATED_TOPIC,
    RPC_URL, CHAIN_ID, EXPLORER_URL,
    TELEGRAM_TOKEN_FACTORY, DEPLOYER_PK,
    PROJECT_X_URL, PROJECT_WEBSITE_URL, TELEGRAM_CHANNEL_URL, TELEGRAM_CHAT_URL,
    WHALE_CHAT_ID, WHALE_MIN_CYBER_SOL, WHALE_VERIFY_URL, WHALE_LINK_TTL_MINUTES,
    SWAP_URL, NFT_MARKET_URL, PIXEL_BATTLE_URL, APP_DOWNLOAD_URL,
    WALLET_MINI_APP_URL, ARENA_MINI_APP_URL,
    CYBER_SOL_DECIMALS,
    AI_ENABLED,
    AI_MODEL_CHOICE,
    MUSIC_ENABLED,
    FISHING_ENABLED,
)
from bot.db import engine
from bot import projects
from bot.language import T, lang_for, lang_of, tr
from bot.utils import (
    is_valid_eth_address, parse_interval, format_interval, slugify_symbol,
    _format_window, _format_token_amount, _short_addr,
)
from bot.announcers import _build_digest_text, _cyber_price_line, _SQLITE_TS
from bot.chain import next_nonce

logger = logging.getLogger(__name__)


def _main_menu_kb(chat=None, lang="en") -> InlineKeyboardMarkup:
    """Inline keyboard of ecosystem links shown under /start and /help.

    URL buttons only — no callbacks — so it cannot interfere with any command
    flow. Blank URLs are skipped (Telegram rejects empty url buttons).
    """
    pairs = [
        (tr(lang, "📱 Кошелёк", "📱 Wallet app"), APP_DOWNLOAD_URL),
        ("🎨 Pixel Battle", PIXEL_BATTLE_URL),
        (tr(lang, "🖼 NFT-маркет", "🖼 NFT Market"), NFT_MARKET_URL),
        (tr(lang, "💱 Обмен", "💱 Swap"), SWAP_URL),
        (tr(lang, "🌐 Сайт", "🌐 Website"), PROJECT_WEBSITE_URL),
        ("𝕏 Twitter", PROJECT_X_URL),
        (tr(lang, "📣 Канал", "📣 Channel"), TELEGRAM_CHANNEL_URL),
    ]
    if chat is not None:
        project = projects.for_chat(chat)
        pairs = [("📱 Cyberia Wallet", APP_DOWNLOAD_URL)]
        if project:
            pairs += [(label, project.get(field)) for label, field in (
                (tr(lang, "🌐 Сайт", "🌐 Website"), "website"), ("𝕏 Twitter", "x"),
                (tr(lang, "📣 Канал", "📣 Channel"), "channel"), (tr(lang, "Чат", "Chat"), "telegram"),
                (tr(lang, "Торговать", "Trade"), "trade"),
            )]
    buttons = [InlineKeyboardButton(label, url=url) for label, url in pairs if url]
    rows = [buttons[i:i + 2] for i in range(0, len(buttons), 2)]
    return InlineKeyboardMarkup(rows)


async def is_chat_admin(update: Update, context: ContextTypes.DEFAULT_TYPE) -> bool:
    chat = update.effective_chat
    user = update.effective_user
    if chat is None or user is None:
        return False
    # private chats: owner by definition
    if chat.type == "private":
        return True
    try:
        member = await context.bot.get_chat_member(chat.id, user.id)
        return member.status in ("creator", "administrator")
    except TelegramError as e:
        logger.warning(f"get_chat_member failed for chat {chat.id} user {user.id}: {e}")
        return False


async def is_chat_owner(update: Update, context: ContextTypes.DEFAULT_TYPE) -> bool:
    chat = update.effective_chat
    user = update.effective_user
    if chat is None or user is None:
        return False
    try:
        member = await context.bot.get_chat_member(chat.id, user.id)
        return member.status == "creator"
    except TelegramError as e:
        logger.warning(f"get_chat_member failed for chat {chat.id} user {user.id}: {e}")
        return False


def get_chat_token(chat_id: int):
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT chat_id, name, symbol, token_address, rewards_interval, reward_amount "
                 "FROM chat_tokens WHERE chat_id = :c"),
            {"c": chat_id},
        ).fetchone()
    return row


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    lang = lang_of(update)
    # Group links hand off to a private chat: only there can Telegram show a
    # web_app button. The payload selects a token and never authorizes a trade.
    if context.args and context.args[0].startswith("swap_"):
        match = re.fullmatch(r"swap_(0x[0-9a-fA-F]{40})", context.args[0])
        if not match or len(context.args) != 1:
            await update.message.reply_text(tr(lang, "Некорректная ссылка обмена. Запросите /balance заново.",
                                               "This swap link is broken. Ask for /balance again."))
        elif not _is_private(update):
            await update.message.reply_text(tr(lang, "Откройте кнопку Swap из /balance в личном чате бота.",
                                               "Open the Swap button from /balance in a private chat with the bot."))
        else:
            await update.message.reply_text(
                tr(lang,
                   "Обмен выбранного токена внутри Telegram Mini App.\n"
                   "Нажмите кнопку ниже — откроется кошелёк с выбранным токеном.\n"
                   f"Контракт: {match[1]}",
                   "Swap the chosen token inside the Telegram Mini App.\n"
                   "Press the button below — the wallet opens with that token selected.\n"
                   f"Contract: {match[1]}"),
                reply_markup=swap_markup(True, [(tr(lang, "токен", "token"), match[1])], lang=lang),
            )
        return

    # The wallet's "Notifications in Telegram": a one-time link that names the
    # address the wallet signed for. Opening it here proves the Telegram side.
    if context.args and context.args[0].startswith("link_") and _is_private(update) and update.effective_user:
        from bot.personal import LINK_EXPIRED_TEXT, LINKED_TEXT, consume_link, wallet_markup

        address = consume_link(context.args[0][len("link_"):], update.effective_user.id)
        if address is None:
            await update.message.reply_text(LINK_EXPIRED_TEXT(lang))
            return
        await _process_set_wallet(update, context, Web3.to_checksum_address(address))
        await update.message.reply_text(
            LINKED_TEXT(lang).format(addr=_short_addr(address)), reply_markup=wallet_markup(lang)
        )
        return

    # The wallet's Daily screen links here to switch reminders on.
    if context.args and context.args[0] == "remind" and _is_private(update) and update.effective_user:
        from bot.reminders import OPTED_IN_TEXT, set_optin

        set_optin(update.effective_user.id, True)
        await update.message.reply_text(OPTED_IN_TEXT(lang))
        return

    user = update.effective_user

    has_wallet = False
    if user is not None:
        try:
            with engine.connect() as conn:
                row = conn.execute(
                    text("SELECT 1 FROM tg_wallets WHERE user_id = :u"),
                    {"u": user.id},
                ).fetchone()
            has_wallet = row is not None
        except Exception as e:
            logger.debug(f"start: wallet lookup failed: {e}")

    if lang == "ru":
        lines = [
            "Привет! Каждый час я присылаю вам 1 токен TG в сети Cyberia (49406).",
            "",
            "Команды:",
            "/help — все команды",
            "/language — 🌐 язык бота в этом чате",
            "/wallet — ваш привязанный кошелёк и ссылка на эксплорер",
            "/rps <ставка> — камень–ножницы–бумага на накопленные токены этого чата",
            "/slots <ставка> — 🎰 слот-автомат чата на накопленные токены",
            *(["/fish — 🎣 рыбалка: места, наживки, ведро; весь улов можно выпустить NFT"] if FISHING_ENABLED else []),
            "/balance — TG, все токены чатов и начисления",
            "/token — токен наград этого чата (только в группе)",
            "/unset_wallet — отвязать кошелёк (начисления сохранятся)",
            "/cancel — отменить ввод",
            "/github <username> <адрес> — привязать GitHub для аирдропа токена GITHUB",
            "/whale — проверить CYBER.sol и войти в чат китов",
            "/create_token [название] [интервал] — (админы) создать токен наград чата",
            "/claim — забрать накопленные награды токенами чата",
            "/set_rewards_interval <интервал> — (админы) изменить интервал выплат",
            "/reward_now — (админы) внеочередная выплата прямо сейчас",
            "Ответьте «спасибо» на чьё-то сообщение — человек получит токен этого чата",
        ]
        if AI_ENABLED:
            lines.append("/ask <вопрос> — спросить ИИ-помощника Cyberia")
            if AI_MODEL_CHOICE:
                lines.append("/model — выбрать бесплатную модель, которая вам отвечает")
        lines.append("/website — сайт проекта")
        if not has_wallet:
            lines += [
                "",
                "Вы ещё не привязали кошелёк — привяжите, чтобы получать награды:",
                "/set_wallet [адрес] — привязать кошелёк (адрес спросит, если не указан)",
                "Пример: /set_wallet 0x1234567890abcdef1234567890abcdef12345678",
            ]
        await update.message.reply_text("\n".join(lines), reply_markup=_main_menu_kb(update.effective_chat, lang))
        return

    lines = [
        "Hi! I send you 1 TG token every hour on Cyberia (49406).",
        "",
        "Commands:",
        "/help - show available commands",
        "/language - 🌐 the bot's language in this chat",
        "/wallet - show your linked wallet and explorer link",
        "/rps <stake> - play rock-paper-scissors with this chat’s accrued tokens",
        "/slots <stake> - pull the chat’s 🎰 slot machine with accrued tokens",
        *(["/fish - 🎣 fishing: places, bait, a bucket; any catch can become an NFT"] if FISHING_ENABLED else []),
        "/balance - show TG, all chat tokens, and pending rewards",
        "/token - show this chat's reward token (group only)",
        "/unset_wallet - unlink your wallet (pending rewards are kept)",
        "/cancel - cancel an interactive prompt",
        "/github <username> <address> - link GitHub for GITHUB token airdrop",
        "/whale - verify CYBER.sol holdings to join the whales chat",
        "/create_token [name] [interval] - (admins) create a chat reward token",
        "/claim - collect the chat-token rewards you have accrued",
        "/set_rewards_interval <interval> - (admins) change payout interval",
        "/reward_now - (admins) trigger an extra payout right now",
        "Reply \"thank you\" or \"thanks\" to someone's message to reward them with this chat's token",
    ]
    if AI_ENABLED:
        lines.append("/ask <question> - ask the Cyberia AI assistant")
        if AI_MODEL_CHOICE:
            lines.append("/model - choose which free model answers you")
    lines.append("/website - project website")

    # Only nudge wallet-less users to register, and keep it at the very end.
    if not has_wallet:
        lines += [
            "",
            "You haven't linked a wallet yet — link one to receive rewards:",
            "/set_wallet [address] - link your wallet (asks for address if omitted)",
            "Example: /set_wallet 0x1234567890abcdef1234567890abcdef12345678",
        ]

    await update.message.reply_text("\n".join(lines), reply_markup=_main_menu_kb(update.effective_chat, lang))


HELP_RU = (
    "Команды:\n"
    "/start — начать получать TG\n"
    "/language — 🌐 язык бота в этом чате (админы выбирают для всей группы)\n"
    "/set_wallet [адрес] — привязать кошелёк (адрес спросит, если не указан)\n"
    "/unset_wallet — отвязать кошелёк (начисления сохранятся)\n"
    "/wallet — ваш привязанный кошелёк и ссылка на эксплорер\n"
    "/rps <ставка> — камень–ножницы–бумага на накопленные токены этого чата\n"
    "/slots <ставка> — 🎰 слот-автомат чата на накопленные токены\n"
    "/slots_bank [сумма] — касса автомата (админы пополняют)\n"
    "{fishing}"
    "/balance — TG, все токены чатов и начисления\n"
    "/token — токен наград этого чата (только в группе)\n"
    "/cancel — отменить ввод\n"
    "/create_token [название] [интервал] — (админы) создать токен наград чата\n"
    "   (недостающее спросит; отмена — /cancel)\n"
    "   например: /create_token MyChatToken 1h\n"
    "/claim — забрать накопленные награды токенами чата\n"
    "/set_rewards_interval <интервал> — (админы) изменить интервал выплат\n"
    "/reward_now — (админы) внеочередная выплата прямо сейчас\n"
    "Ответьте «спасибо» на чьё-то сообщение — человек получит токен этого чата\n"
    "/github <username> <адрес> — привязать GitHub для аирдропа токена GITHUB\n"
    "/whale — проверить CYBER.sol и войти в чат китов\n"
    "/x — ссылки на X (Twitter) и Telegram (ещё отвечаю на «x»)\n"
    "/ca — адрес контракта токена этого чата (ещё отвечаю на «ca»)\n"
    "/buybot — (админы) проект чата и уведомления о покупках\n"
    "/stats [окно] — статистика проекта чата (сводка Cyberia: /stats 6h)\n"
    "{music}{ai}"
    "/set_channel_wallet <@канал> <0x..> — (админы канала) кошелёк для NFT из постов\n"
    "/app — скачать кошелёк Cyberia\n"
    "/website — сайт проекта\n\n"
    "{ai_hint}"
    "В группах можно общаться и без кошелька — награды копятся и будут "
    "начислены разом, когда вы сделаете /set_wallet."
)
HELP_RU_FISHING = (
    "/fish — 🎣 рыбалка: рыба, хлам и сокровища — всё можно выпустить NFT и продать на маркете\n"
    "/fish_bucket — ведро · /fish_spots — места · /fish_shop — лавка · /fish_bag — рюкзак · "
    "/fish_top — рекорды · /fish odds — что клюёт · /fish ⚡ — энергетик всему чату\n"
)
HELP_RU_MUSIC = (
    "/track <исполнитель — название> — найти песню и прислать её (ссылка на трек "
    "Яндекс Музыки или VK тоже работает, в любом сообщении)\n"
    "/music [on|off] — музыка здесь; (админы) отвечать на строки «Исполнитель — Название»\n"
)
HELP_RU_AI_HINT = (
    "В личке ИИ-помощнику можно просто написать вопрос. В группах — упомяните "
    "бота или ответьте на его сообщение.\n\n"
)


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    lang = lang_of(update)
    if lang == "ru":
        await update.message.reply_text(
            HELP_RU.format(
                fishing=HELP_RU_FISHING if FISHING_ENABLED else "",
                music=HELP_RU_MUSIC if MUSIC_ENABLED else "",
                ai=("/ask <вопрос> — спросить ИИ-помощника Cyberia\n" if AI_ENABLED else "")
                + ("/model — выбрать бесплатную модель, которая вам отвечает (по умолчанию — "
                   "роутер по всем бесплатным)\n" if AI_ENABLED and AI_MODEL_CHOICE else ""),
                ai_hint=HELP_RU_AI_HINT if AI_ENABLED else "",
            ),
            reply_markup=_main_menu_kb(update.effective_chat, lang),
        )
        return
    music_lines = (
        "/track <artist — title> - find a song and post it (a Yandex Music or VK "
        "track link works too, in any message)\n"
        "/music [on|off] - music here; (admins) answer bare \"Artist — Title\" lines\n"
        if MUSIC_ENABLED
        else ""
    )
    ai_lines = (
        "/ask <question> - ask the Cyberia AI assistant\n" if AI_ENABLED else ""
    ) + (
        "/model - choose which free model answers you (the default is a router "
        "over the whole free pool)\n"
        if AI_ENABLED and AI_MODEL_CHOICE
        else ""
    )
    ai_hint = (
        "In private chat you can also send the AI assistant a question as plain "
        "text. In groups, mention the bot or reply to its message.\n\n"
        if AI_ENABLED
        else ""
    )
    await update.message.reply_text(
        "Commands:\n"
        "/start - start receiving TG\n"
        "/language - 🌐 the bot's language in this chat (admins choose for a group)\n"
        "/set_wallet [address] - link your wallet (asks for address if omitted)\n"
        "/unset_wallet - unlink your wallet (pending rewards are kept)\n"
        "/wallet - show your linked wallet and explorer link\n"
        "/rps <stake> - play rock-paper-scissors with this chat’s accrued tokens\n"
        "/slots <stake> - pull the chat’s 🎰 slot machine with accrued tokens\n"
        "/slots_bank [amount] - show the machine’s till (admins top it up)\n"
        + (
            "/fish - 🎣 cast a line; fish, junk and treasure can all be minted and sold on the market\n"
            "/fish_bucket - bucket · /fish_spots - places · /fish_shop - shop · /fish_bag - gear · "
            "/fish_top - records · /fish odds - what bites · /fish ⚡ - energy drink for the chat\n"
            if FISHING_ENABLED
            else ""
        ) +
        "/balance - show TG, all chat tokens, and pending rewards\n"
        "/token - show this chat's reward token (group only)\n"
        "/cancel - cancel an interactive prompt\n"
        "/create_token [name] [interval] - (admins) create a chat reward token\n"
        "   (prompts for missing arguments; use /cancel to abort)\n"
        "   e.g. /create_token MyChatToken 1h\n"
        "/claim - collect the chat-token rewards you have accrued\n"
    "/set_rewards_interval <interval> - (admins) change payout interval\n"
        "/reward_now - (admins) trigger an extra payout right now\n"
        "Reply \"thank you\" or \"thanks\" to someone's message to reward them with this chat's token\n"
        "/github <username> <address> - link GitHub for GITHUB token airdrop\n"
        "/whale - verify CYBER.sol holdings to join the whales chat\n"
        "/x - X (Twitter) and Telegram links (also replies to \"x\")\n"
        "/ca - this chat's token contract address (also replies to \"ca\")\n"
        "/buybot - (admins) configure this chat's project and buy alerts\n"
        "/stats [window] - this chat's project stats (Cyberia digest: /stats 6h)\n"
        + music_lines + ai_lines +
        "/set_channel_wallet <@channel> <0x..> - (channel admins) wallet that receives post NFTs\n"
        "/app - download the Cyberia wallet app\n"
        "/website - project website\n\n"
        + ai_hint +
        "You can chat in groups without a wallet -- rewards will be saved as "
        "pending and minted in one go when you /set_wallet.",
        reply_markup=_main_menu_kb(update.effective_chat, lang),
    )


async def website_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    lang = lang_of(update)
    project = projects.for_chat(update.effective_chat)
    await update.message.reply_text(
        project.get("website") or tr(lang, "Сайт для этого чата не настроен.", "Website is not configured for this chat.")
        if project else tr(lang, "Для этого чата не настроен проект.\n", "No project is configured for this chat.\n")
        + projects.setup_hint(lang)
    )


def mini_app_markup(is_private: bool, lang: str = "en") -> InlineKeyboardMarkup:
    """The button that opens the wallet inside Telegram.

    A `web_app` button is only allowed in private chats — Telegram rejects the
    message otherwise — so in a group the same wallet is offered as an ordinary
    link, which opens in the browser instead of in the frame. Both lead to the
    same page; only the chrome around it differs.
    """
    label = tr(lang, "👛 Открыть кошелёк", "👛 Open wallet")
    if is_private:
        return InlineKeyboardMarkup(
            [[InlineKeyboardButton(label, web_app=WebAppInfo(url=WALLET_MINI_APP_URL))]]
        )

    return InlineKeyboardMarkup(
        [[InlineKeyboardButton(label, url=WALLET_MINI_APP_URL)]]
    )


def swap_markup(is_private: bool, tokens, bot_username: str = "cyberia_network_bot",
                lang: str = "en") -> InlineKeyboardMarkup | None:
    """One [Swap] button per chat token, opening the wallet on that token.

    The bot has no private key and must never have one, so it cannot trade on
    anybody's behalf. What it can do is hand the person to the wallet with the
    token already chosen — the mini app *is* the wallet, with the vault in its
    own storage, and it reads `?swap=<contract>` on the way in.

    `web_app` is legal only in a private chat. Group buttons therefore use
    Telegram bot deep links; /start turns their validated payload into a
    private web_app button, retaining the chosen token. This works without a
    Main Mini App configured in BotFather.

    Telegram allows at most 100 buttons and a row of them stops being readable
    long before that, so this caps at a handful.
    """
    rows = []

    for symbol, token_address in list(tokens)[:6]:
        url = f"{WALLET_MINI_APP_URL}?swap={token_address}"
        rows.append([
            InlineKeyboardButton(
                tr(lang, f"🔄 Обменять {symbol}", f"🔄 Swap {symbol}"),
                web_app=WebAppInfo(url=url) if is_private else None,
                url=None if is_private else f"https://t.me/{bot_username}?start=swap_{token_address}",
            )
        ])

    return InlineKeyboardMarkup(rows) if rows else None


def _is_private(update: Update) -> bool:
    chat = update.effective_chat
    return chat is not None and chat.type == "private"


async def open_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Open the wallet as a Mini App, without leaving Telegram.

    The keys are made and kept by the page itself, in this device's storage;
    the bot hands out a URL and learns nothing about what happens inside it.
    That is worth saying here, because a wallet opened from a chat is exactly
    where someone will assume the chat can see it.
    """
    lang = lang_of(update)
    await update.message.reply_text(
        tr(lang,
           "Cyberia Wallet — одна сид-фраза для всех сетей.\n\n"
           "Кошелёк открывается внутри Telegram, но ключи создаются и шифруются "
           "на вашем устройстве. Ни Telegram, ни этот бот не получают вашу "
           "сид-фразу или пароль.\n\n"
           "Здесь можно создать кошелёк или импортировать уже существующий. "
           "В любом случае запишите сид-фразу: кошелёк хранится в памяти самого "
           "Telegram, и очистка кэша Telegram стирает его — вернёт его только фраза.",
           "Cyberia Wallet — one recovery phrase, every chain.\n\n"
           "It opens inside Telegram, but the keys are created and encrypted on "
           "your device. Telegram never receives your recovery phrase or your "
           "password, and neither does this bot.\n\n"
           "You can create a wallet here or import one you already have. Write "
           "the recovery phrase down either way: the wallet lives in Telegram's "
           "own storage, and clearing Telegram's cache clears it — the phrase is "
           "what brings it back."),
        reply_markup=mini_app_markup(_is_private(update), lang),
    )


async def arena_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Open the same non-custodial Arena screen used by every Cyberia shell."""
    lang = lang_of(update)
    button = InlineKeyboardButton(
        tr(lang, "⚔️ На арену", "⚔️ Enter Arena"),
        web_app=WebAppInfo(url=ARENA_MINI_APP_URL) if _is_private(update) else None,
        url=None if _is_private(update) else ARENA_MINI_APP_URL,
    )
    await update.message.reply_text(
        tr(lang,
           "Cyberia Arena — ход, его раскрытие и расчёт происходят в сети Cyberia. "
           "Бот только открывает игру и никогда не видит секрет вашего хода или ключи.",
           "Cyberia Arena — commit, reveal and settlement happen on Cyberia. "
           "The bot only opens the game and never sees your move secret or keys."),
        reply_markup=InlineKeyboardMarkup([[button]]),
    )


async def app_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Where to get the wallet app.

    The per-platform links are permanent redirects on the site, so this answer
    never goes stale between releases — which is the whole point of not sending
    the APK as a file.
    """
    base = APP_DOWNLOAD_URL.rstrip("/")
    lang = lang_of(update)
    await update.message.reply_text(
        tr(lang,
           "Cyberia Wallet — одна сид-фраза для всех сетей.\n\n"
           f"Все платформы: {base}\n"
           f"Android APK: {base}/android\n"
           f"Windows: {base}/windows\n"
           f"macOS: {base}/macos\n"
           f"Linux: {base}/linux\n"
           f"Расширение для браузера: {base}/extension\n\n"
           "На iPhone откройте сайт в Safari и добавьте его на экран «Домой». "
           "Приложение — это сайт в окне, ключи остаются на вашем устройстве.",
           "Cyberia Wallet — one recovery phrase, every chain.\n\n"
           f"All platforms: {base}\n"
           f"Android APK: {base}/android\n"
           f"Windows: {base}/windows\n"
           f"macOS: {base}/macos\n"
           f"Linux: {base}/linux\n"
           f"Browser extension: {base}/extension\n\n"
           "On iPhone open the site in Safari and add it to the home screen. "
           "The app is the site in a window — your keys stay on your device."),
        # The same wallet without installing anything, for whoever is reading
        # this on a phone in a chat.
        reply_markup=mini_app_markup(_is_private(update), lang),
    )


def _build_x_reply(chat, lang="en") -> str:
    return projects.x_reply(projects.for_chat(chat), lang)


def _build_ca_reply(chat, lang="en") -> str:
    return projects.ca_reply(projects.for_chat(chat), lang)


async def x_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/x — reply with the project's X (Twitter) and Telegram links."""
    await update.message.reply_text(_build_x_reply(update.effective_chat, lang_of(update)))


async def ca_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/ca — reply with this group's configured token contract address."""
    await update.message.reply_text(
        _build_ca_reply(update.effective_chat, lang_of(update)), parse_mode="HTML", disable_web_page_preview=True
    )


# Bare-text triggers -> reply builder. Synonyms map to the same answer so that
# "ca", "contract" or "address" all surface the contract address.
# trigger -> (reply builder, parse_mode). HTML escapes project-controlled text
# while retaining tap-to-copy contract addresses.
_QUICK_REPLIES = {
    "x": (_build_x_reply, None),
    "twitter": (_build_x_reply, None),
    "ca": (_build_ca_reply, "HTML"),
    "contract": (_build_ca_reply, "HTML"),
    "address": (_build_ca_reply, "HTML"),
}

# Matches a message that is *only* a trigger word, optionally wrapped in
# whitespace/punctuation (e.g. "ca?", " X ", "Contract."). Keeps the handler
# from firing on ordinary chat that merely contains the word.
_QUICK_REPLY_RE = re.compile(
    r"^[\s]*(" + "|".join(_QUICK_REPLIES) + r")[\s?!.,]*$",
    re.IGNORECASE,
)

_THANK_YOU_RE = re.compile(
    r"(?<!\w)(?:thank\s+you|thanks|спасибо)(?!\w)",
    re.IGNORECASE,
)


def _normalize_trigger(text_value: str) -> str:
    return text_value.strip().strip("?!.,").strip().lower()


def _is_thank_you_text(text_value: str | None) -> bool:
    """True when a message contains a supported thank-you trigger."""
    if not text_value:
        return False
    return _THANK_YOU_RE.search(text_value) is not None


async def quick_reply_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Answer bare 'x'/'ca'-style messages with links and contract addresses.

    Registered in its own handler group so it runs independently of the
    wallet/token follow-up handlers, and gated by `_QUICK_REPLY_RE` so casual
    chat is never hijacked.
    """
    msg = update.effective_message
    if msg is None or not msg.text:
        return
    entry = _QUICK_REPLIES.get(_normalize_trigger(msg.text))
    if entry is None:
        return
    builder, parse_mode = entry
    await update.message.reply_text(
        builder(update.effective_chat, lang_of(update)), parse_mode=parse_mode, disable_web_page_preview=True
    )


async def github_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    lang = lang_of(update)
    args = context.args
    if not args or len(args) < 2:
        await update.message.reply_text(tr(
            lang,
            "Как: /github <имя_на_github> <адрес_кошелька>\n"
            "Пример: /github octocat 0x1234...abcd\n\n"
            "Поставьте звезду https://github.com/cyberia-temple/singularity и "
            "подпишитесь на https://github.com/cyberia-temple — за это начисляются токены GITHUB!",
            "Usage: /github <github_username> <wallet_address>\n"
            "Example: /github octocat 0x1234...abcd\n\n"
            "Star https://github.com/cyberia-temple/singularity and "
            "follow https://github.com/cyberia-temple to earn GITHUB tokens!",
        ))
        return

    github_username = args[0].strip().lstrip("@").lower()
    address = args[1].strip()

    if not is_valid_eth_address(address):
        await update.message.reply_text(tr(lang, "Неверный адрес кошелька. Нужен 0x...", "Invalid wallet address. Expected 0x..."))
        return

    try:
        with engine.connect() as conn:
            conn.execute(
                text("""
                    INSERT INTO github_wallets (github_username, wallet_address)
                    VALUES (:user, :wallet)
                    ON CONFLICT(github_username) DO UPDATE SET wallet_address = :wallet
                """),
                {"user": github_username, "wallet": address},
            )
            conn.commit()

        await update.message.reply_text(tr(
            lang,
            f"GitHub @{github_username} привязан к {address[:6]}...{address[-4:]}\n\n"
            "Теперь поставьте звезду репозиторию и подпишитесь на организацию, чтобы получить токены GITHUB!",
            f"Linked GitHub @{github_username} -> {address[:6]}...{address[-4:]}\n\n"
            "Now star the repo and follow the org to receive GITHUB tokens!",
        ))
    except Exception as e:
        logger.error(f"Error in github command: {e}")
        await update.message.reply_text(tr(lang, "Не удалось сохранить. Попробуйте ещё раз.", "Error saving. Try again."))


TOKEN_NAME_LENGTH = T("Название токена — от 1 до 48 символов.", "Token name must be 1..48 characters.")
ASK_TOKEN_NAME = T(
    "Ответьте на это сообщение названием токена (1–48 символов) или /cancel для отмены.",
    "Reply to this message with the token name (1-48 characters), or /cancel to abort.",
)
ASK_TOKEN_INTERVAL = T(
    "Ответьте на это сообщение интервалом наград (например 30s, 15m, 1h, 2d, 1w) или /cancel для отмены.",
    "Reply to this message with the rewards interval (e.g. 30s, 15m, 1h, 2d, 1w), or /cancel to abort.",
)


async def _process_create_token(
    update: Update, context: ContextTypes.DEFAULT_TYPE,
    name: str, interval_raw: str,
) -> None:
    """Shared implementation for /create_token and the follow-up prompts.

    Validates name & interval, persists, deploys on-chain, and stores the
    resulting token address.
    """
    chat = update.effective_chat
    user = update.effective_user
    if chat is None or user is None:
        return
    lang = lang_of(update)

    if not name or len(name) > 48:
        await update.message.reply_text(TOKEN_NAME_LENGTH(lang))
        return

    try:
        rewards_interval = parse_interval(interval_raw)
    except ValueError as e:
        await update.message.reply_text(tr(
            lang, f"Неверный интервал: {e}\nПримеры: 30s, 15m, 1h, 2d, 1w",
            f"Bad interval: {e}\nExamples: 30s, 15m, 1h, 2d, 1w",
        ))
        return

    if not TELEGRAM_TOKEN_FACTORY or not DEPLOYER_PK:
        await update.message.reply_text(tr(
            lang,
            "Создание токенов на этом боте не настроено "
            "(нет TELEGRAM_TOKEN_FACTORY / DEPLOYER_PK). Напишите оператору.",
            "Token creation is not configured on this bot "
            "(TELEGRAM_TOKEN_FACTORY / DEPLOYER_PK missing). Please contact the operator.",
        ))
        return

    symbol = slugify_symbol(name, chat.id)

    with engine.begin() as conn:
        conn.execute(
            text("""
                INSERT INTO chat_tokens
                    (chat_id, name, symbol, rewards_interval, created_by)
                VALUES
                    (:chat_id, :name, :symbol, :interval, :user_id)
                ON CONFLICT(chat_id) DO UPDATE SET
                    name = excluded.name,
                    symbol = excluded.symbol,
                    token_address = NULL,
                    rewards_interval = excluded.rewards_interval,
                    created_by = excluded.created_by,
                    created_at = datetime('now'),
                    last_payout_at = NULL
            """),
            {
                "chat_id": chat.id,
                "name": name,
                "symbol": symbol,
                "interval": rewards_interval,
                "user_id": user.id,
            },
        )

    status_msg = await update.message.reply_text(tr(
        lang, f"Выпускаю токен {name} ({symbol})… это займёт несколько секунд.",
        f"Deploying token {name} ({symbol})... this may take a few seconds.",
    ))

    token_address = None
    try:
        from web3 import Web3

        w3 = Web3(Web3.HTTPProvider(RPC_URL))
        acct = w3.eth.account.from_key(DEPLOYER_PK)
        factory = w3.eth.contract(
            address=Web3.to_checksum_address(TELEGRAM_TOKEN_FACTORY),
            abi=FACTORY_ABI,
        )

        nonce = next_nonce(w3, acct.address)
        try:
            estimated = factory.functions.createToken(
                name, symbol, acct.address
            ).estimate_gas({"from": acct.address})
        except Exception as est_err:
            logger.warning(f"estimate_gas failed, falling back to 5_000_000: {est_err}")
            estimated = 5_000_000
        gas_limit = int(estimated * 1.25) + 50_000
        tx = factory.functions.createToken(
            name, symbol, acct.address
        ).build_transaction({
            "from": acct.address,
            "nonce": nonce,
            "gas": gas_limit,
            "gasPrice": w3.eth.gas_price,
            "chainId": CHAIN_ID,
        })
        signed = acct.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)

        if receipt.status != 1:
            raise RuntimeError(f"tx reverted: {tx_hash.hex()}")

        for log in receipt.logs:
            topics = log.get("topics") or []
            if not topics:
                continue
            if log.get("address", "").lower() != factory.address.lower():
                continue
            if topics[0].hex().lower() != TOKEN_CREATED_TOPIC.lower():
                continue
            event = factory.events.TokenCreated().process_log(log)
            token_address = event["args"]["token"]
            break

        if not token_address:
            raise RuntimeError("TokenCreated event did not include token address")
        token_address = Web3.to_checksum_address(token_address)
    except Exception as e:
        logger.error(f"On-chain createToken failed for chat {chat.id}: {e}")
        with engine.begin() as conn:
            conn.execute(
                text("DELETE FROM chat_tokens WHERE chat_id = :c AND token_address IS NULL"),
                {"c": chat.id},
            )
        await status_msg.edit_text(tr(lang, f"Выпуск в сети не удался: {e}", f"On-chain deployment failed: {e}"))
        return

    with engine.begin() as conn:
        conn.execute(
            text("UPDATE chat_tokens SET token_address = :addr WHERE chat_id = :c"),
            {"addr": token_address, "c": chat.id},
        )

    await status_msg.edit_text(tr(
        lang,
        "Новый токен создан.\n"
        f"Название: {name}\n"
        f"Символ: {symbol}\n"
        f"Адрес: {token_address}\n"
        f"Интервал наград: {format_interval(rewards_interval)}",
        "New token created.\n"
        f"Name: {name}\n"
        f"Symbol: {symbol}\n"
        f"Address: {token_address}\n"
        f"Rewards interval: {format_interval(rewards_interval)}",
    ))


async def create_token_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """
    /create_token <name> <rewards_interval>
    Creates a per-chat ERC20Votes reward token via the on-chain factory and
    wires it to this chat. Only the chat owner can run it; must be used from the
    target group/supergroup.

    If arguments are omitted the bot prompts for them interactively.
    """
    chat = update.effective_chat
    user = update.effective_user
    if chat is None or user is None:
        return
    lang = lang_of(update)

    if chat.type not in ("group", "supergroup"):
        await update.message.reply_text(tr(
            lang, "Эта команда работает только в группе.", "This command must be used inside a group chat."
        ))
        return

    if not await is_chat_owner(update, context):
        await update.message.reply_text(tr(lang, "Создать токен может только владелец чата.",
                                           "Only the chat owner can create a token."))
        logger.warning(
            "Unauthorized create_token attempt by non-owner user_id=%s username=%s chat_id=%s",
            user.id,
            user.username,
            chat.id,
        )
        return

    args = context.args or []

    if not args:
        context.user_data["awaiting_token_name"] = True
        context.user_data["awaiting_token_chat_id"] = chat.id
        bot_msg = await update.message.reply_text(ASK_TOKEN_NAME(lang))
        context.user_data["awaiting_token_bot_msg_id"] = bot_msg.message_id
        return

    if len(args) == 1:
        name = args[0].strip()
        if not name or len(name) > 48:
            await update.message.reply_text(TOKEN_NAME_LENGTH(lang))
            return
        context.user_data["token_name"] = name
        context.user_data["awaiting_token_interval"] = True
        context.user_data["awaiting_token_chat_id"] = chat.id
        bot_msg = await update.message.reply_text(ASK_TOKEN_INTERVAL(lang))
        context.user_data["awaiting_token_bot_msg_id"] = bot_msg.message_id
        return

    # 2+ args: last token is always the interval
    name = " ".join(args[:-1]).strip()
    interval_raw = args[-1]
    await _process_create_token(update, context, name, interval_raw)


USE_IN_TOKEN_GROUP = T("Используйте эту команду в группе, которой принадлежит токен.",
                       "Use this command in the group chat that owns the token.")
NO_CHAT_TOKEN = T("У этого чата ещё нет токена. Сначала /create_token.",
                  "This chat has no token yet. Use /create_token first.")


async def set_rewards_interval_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/set_rewards_interval <interval> — admin-only, changes how often rewards are paid."""
    chat = update.effective_chat
    lang = lang_of(update)
    if chat is None or chat.type not in ("group", "supergroup"):
        await update.message.reply_text(USE_IN_TOKEN_GROUP(lang))
        return
    if not await is_chat_admin(update, context):
        await update.message.reply_text(tr(lang, "Интервал наград меняют только администраторы чата.",
                                           "Only chat admins can change the rewards interval."))
        return

    args = context.args or []
    if not args:
        await update.message.reply_text(tr(
            lang, "Как: /set_rewards_interval <интервал>\nПримеры: 30s, 15m, 1h, 2d, 1w",
            "Usage: /set_rewards_interval <interval>\nExamples: 30s, 15m, 1h, 2d, 1w",
        ))
        return

    try:
        rewards_interval = parse_interval(args[0])
    except ValueError as e:
        await update.message.reply_text(tr(lang, f"Неверный интервал: {e}", f"Bad interval: {e}"))
        return

    chat_token = get_chat_token(chat.id)
    if chat_token is None:
        await update.message.reply_text(NO_CHAT_TOKEN(lang))
        return

    try:
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE chat_tokens SET rewards_interval = :i WHERE chat_id = :c"),
                {"i": rewards_interval, "c": chat.id},
            )
    except Exception as e:
        logger.error(f"set_rewards_interval db error: {e}")
        await update.message.reply_text(tr(lang, "Внутренняя ошибка. Попробуйте ещё раз.", "Internal error. Try again."))
        return

    await update.message.reply_text(tr(
        lang, f"Интервал наград обновлён: {format_interval(rewards_interval)}.",
        f"Rewards interval updated: {format_interval(rewards_interval)}.",
    ))


def _get_chat_payout_recipients(chat_id: int):
    """Return [(user_id, address), ...] for users that have BOTH been seen in
    this chat (`chat_members`) AND linked a wallet globally (`tg_wallets`).

    `chat_members` is maintained by the bot via message tracking and
    left/kicked event handlers, so it reflects current membership for users
    the bot has ever seen. `tg_wallets` is global, so a user only needs to
    /set_wallet once anywhere to receive rewards from every chat they
    participate in.
    """
    with engine.connect() as conn:
        return conn.execute(
            text("""
                SELECT cm.user_id, w.address
                FROM chat_members cm
                JOIN tg_wallets w ON w.user_id = cm.user_id
                WHERE cm.chat_id = :c
            """),
            {"c": chat_id},
        ).fetchall()


def _record_chat_member(chat_id: int, user_id: int):
    with engine.begin() as conn:
        conn.execute(
            text("""
                INSERT INTO chat_members (chat_id, user_id, first_seen, last_seen)
                VALUES (:c, :u, datetime('now'), datetime('now'))
                ON CONFLICT(chat_id, user_id) DO UPDATE SET last_seen = datetime('now')
            """),
            {"c": chat_id, "u": user_id},
        )


def _forget_chat_member(chat_id: int, user_id: int):
    with engine.begin() as conn:
        conn.execute(
            text("DELETE FROM chat_members WHERE chat_id = :c AND user_id = :u"),
            {"c": chat_id, "u": user_id},
        )


def _credit_pending_reward(chat_id: int, user_id: int, amount: int) -> None:
    """Accumulate a uint256 reward as text so SQLite integer limits do not bite."""
    if amount <= 0:
        return
    with engine.begin() as conn:
        conn.exec_driver_sql("BEGIN IMMEDIATE")
        row = conn.execute(
            text("SELECT amount FROM pending_rewards WHERE chat_id = :c AND user_id = :u"),
            {"c": chat_id, "u": user_id},
        ).fetchone()
        current = int(row[0]) if row and row[0] else 0
        new_amount = str(current + amount)
        conn.execute(
            text("""
                INSERT INTO pending_rewards (chat_id, user_id, amount, updated_at)
                VALUES (:c, :u, :a, datetime('now'))
                ON CONFLICT(chat_id, user_id) DO UPDATE SET
                    amount = excluded.amount,
                    updated_at = datetime('now')
            """),
            {"c": chat_id, "u": user_id, "a": new_amount},
        )


def _wallet_for_user(user_id: int) -> str | None:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT address FROM tg_wallets WHERE user_id = :u"),
            {"u": user_id},
        ).fetchone()
    return row[0] if row else None


def _mint_chat_reward(token_address: str, recipient: str, amount: int) -> str:
    if not DEPLOYER_PK:
        raise RuntimeError("DEPLOYER_PK is not configured")

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    acct = w3.eth.account.from_key(DEPLOYER_PK)
    contract = w3.eth.contract(
        address=Web3.to_checksum_address(token_address),
        abi=CHAT_TOKEN_MINT_ABI,
    )
    to = Web3.to_checksum_address(recipient)
    nonce = next_nonce(w3, acct.address)
    mint_fn = contract.functions.mint(to, amount)
    try:
        estimated_gas = mint_fn.estimate_gas({"from": acct.address})
    except Exception as e:
        logger.warning("thank_you_reward: estimate_gas failed, using fallback: %s", e)
        estimated_gas = 150_000
    tx = mint_fn.build_transaction({
        "from": acct.address,
        "nonce": nonce,
        "gas": int(estimated_gas * 1.25) + 25_000,
        "gasPrice": w3.eth.gas_price,
        "chainId": CHAIN_ID,
    })
    signed = acct.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    if receipt.status != 1:
        raise RuntimeError(f"mint reverted: {tx_hash.hex()}")
    return tx_hash.hex()


async def thank_you_reward_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Mint this chat's token to the author of the message being thanked."""
    chat = update.effective_chat
    message = update.effective_message
    sender = update.effective_user
    if (
        chat is None
        or chat.type not in ("group", "supergroup")
        or message is None
        or sender is None
        or sender.is_bot
        or not _is_thank_you_text(message.text)
    ):
        return

    replied = message.reply_to_message
    recipient_user = getattr(replied, "from_user", None) if replied is not None else None
    if (
        recipient_user is None
        or recipient_user.is_bot
        or recipient_user.id == sender.id
    ):
        return

    chat_token = get_chat_token(chat.id)
    if chat_token is None:
        return
    _chat_id_col, _name, symbol, token_address, _interval, reward_amount = chat_token
    if not token_address:
        return

    try:
        amount = int(reward_amount)
    except (TypeError, ValueError):
        logger.error(
            "thank_you_reward: bad reward_amount chat=%s symbol=%s value=%r",
            chat.id, symbol, reward_amount,
        )
        return
    if amount <= 0:
        return

    for user_id in (sender.id, recipient_user.id):
        try:
            _record_chat_member(chat.id, user_id)
        except Exception as e:
            logger.debug("thank_you_reward member tracking failed: %s", e)

    context.user_data["ai_skip_message_id"] = message.message_id
    lang = lang_of(update)

    recipient_wallet = _wallet_for_user(recipient_user.id)
    human_amount = amount / 10**18
    recipient_name = (
        recipient_user.full_name
        or recipient_user.username
        or str(recipient_user.id)
    )

    if not recipient_wallet:
        try:
            _credit_pending_reward(chat.id, recipient_user.id, amount)
            await message.reply_text(tr(
                lang,
                f"🙏 +{human_amount:g} {symbol} отложено для {recipient_name}. "
                "Получить можно, привязав кошелёк: /set_wallet.",
                f"🙏 +{human_amount:g} {symbol} queued for {recipient_name}. "
                "They can claim it with /set_wallet.",
            ))
        except Exception as e:
            logger.error(
                "thank_you_reward: pending credit failed chat=%s recipient=%s: %s",
                chat.id, recipient_user.id, e,
            )
        return

    try:
        tx_hash = await asyncio.to_thread(
            _mint_chat_reward, token_address, recipient_wallet, amount
        )
        logger.info(
            "thank_you_reward: minted %s %s chat=%s from_user=%s to_user=%s wallet=%s tx=%s",
            amount, symbol, chat.id, sender.id, recipient_user.id, recipient_wallet, tx_hash,
        )
        await message.reply_text(
            tr(lang, f"🙏 +{human_amount:g} {symbol} для {recipient_name}\n",
               f"🙏 +{human_amount:g} {symbol} to {recipient_name}\n")
            + f"{EXPLORER_URL}/tx/{tx_hash}",
            disable_web_page_preview=True,
        )
    except Exception as e:
        logger.error(
            "thank_you_reward: mint failed chat=%s recipient=%s wallet=%s: %s",
            chat.id, recipient_user.id, recipient_wallet, e,
        )
        await message.reply_text(tr(
            lang, f"Сейчас не получилось начислить {symbol}. Оператору стоит заглянуть в логи бота.",
            f"Could not mint {symbol} right now. The operator should check bot logs.",
        ))


TOKEN_PENDING = T("Токен ещё выпускается. Попробуйте позже.", "Token deployment is still pending. Try again later.")


async def reward_now_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/reward_now — admin-only, trigger an immediate payout without touching the timer."""
    chat = update.effective_chat
    user = update.effective_user
    lang = lang_of(update)
    if chat is None or chat.type not in ("group", "supergroup"):
        await update.message.reply_text(USE_IN_TOKEN_GROUP(lang))
        return
    if not await is_chat_admin(update, context):
        await update.message.reply_text(tr(lang, "Запустить выплату могут только администраторы чата.",
                                           "Only chat admins can trigger a payout."))
        return

    chat_token = get_chat_token(chat.id)
    if chat_token is None:
        await update.message.reply_text(NO_CHAT_TOKEN(lang))
        return

    _chat_id_col, name, symbol, token_address, _interval, reward_amount = chat_token
    if not token_address:
        await update.message.reply_text(TOKEN_PENDING(lang))
        return

    if not DEPLOYER_PK:
        await update.message.reply_text(tr(
            lang, "Выплаты на этом боте не настроены (нет DEPLOYER_PK).",
            "Payouts are not configured on this bot (DEPLOYER_PK missing).",
        ))
        return

    if user is not None and not user.is_bot:
        try:
            _record_chat_member(chat.id, user.id)
        except Exception as e:
            logger.debug(f"reward_now member tracking failed: {e}")

    recipients = _get_chat_payout_recipients(chat.id)
    if not recipients:
        await update.message.reply_text(tr(
            lang,
            "Некому платить: никто из нынешних участников чата ещё не привязал кошелёк через /set_wallet.",
            "No eligible recipients: no current member of this chat has registered "
            "a wallet via /set_wallet yet.",
        ))
        return

    amount_human = int(reward_amount) / 10**18
    status_msg = await update.message.reply_text(tr(
        lang, f"Начисляю {amount_human} {symbol} на кошельки: {len(recipients)}…",
        f"Minting {amount_human} {symbol} to {len(recipients)} wallet(s)...",
    ))

    try:
        from web3 import Web3

        w3 = Web3(Web3.HTTPProvider(RPC_URL))
        acct = w3.eth.account.from_key(DEPLOYER_PK)
        token_abi = [{
            "inputs": [
                {"name": "to", "type": "address"},
                {"name": "amount", "type": "uint256"},
            ],
            "name": "mint",
            "outputs": [],
            "stateMutability": "nonpayable",
            "type": "function",
        }]
        contract = w3.eth.contract(
            address=Web3.to_checksum_address(token_address), abi=token_abi
        )
        amount = int(reward_amount)
        nonce = next_nonce(w3, acct.address)

        succeeded = 0
        failed = 0
        for user_id, address in recipients:
            try:
                to = Web3.to_checksum_address(address)
                tx = contract.functions.mint(to, amount).build_transaction({
                    "from": acct.address,
                    "nonce": nonce,
                    "gas": 150_000,
                    "gasPrice": w3.eth.gas_price,
                    "chainId": CHAIN_ID,
                })
                signed = acct.sign_transaction(tx)
                tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
                w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
                logger.info(
                    f"reward_now chat={chat.id} user={user_id} -> {address} tx={tx_hash.hex()}"
                )
                nonce += 1
                succeeded += 1
            except Exception as e:
                logger.error(f"reward_now mint failed for {address}: {e}")
                # A failed send did not consume a nonce, so carrying on from the next one
                # opens a gap the chain can never close and every later signature lands
                # further out of reach — that is how one failure became 512 on
                # 2026-09-14. Ask the chain again instead of guessing.
                nonce = next_nonce(w3, acct.address)
                failed += 1
    except Exception as e:
        logger.error(f"reward_now fatal: {e}")
        await status_msg.edit_text(tr(lang, f"Выплата не удалась: {e}", f"Payout failed: {e}"))
        return

    # Intentionally do NOT update last_payout_at: this is an extra payout.
    await status_msg.edit_text(tr(
        lang, f"Выплата готова: успешно {succeeded}, с ошибкой {failed}. Обычное расписание не изменилось.",
        f"Payout done: {succeeded} ok, {failed} failed. "
        "Regular schedule is unchanged.",
    ))


CHAT_TOKEN_MINT_ABI = [{
    "inputs": [
        {"name": "to", "type": "address"},
        {"name": "amount", "type": "uint256"},
    ],
    "name": "mint",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function",
}]


def _claim_pending_rewards(user_id: int, address: str):
    """Mint everything in pending_rewards for this user, one tx per chat token.

    Returns (claimed, failed, total_amount_by_symbol_dict).
    Rows are deleted only on successful mint to keep retries safe.
    """
    if not DEPLOYER_PK:
        logger.warning("claim_pending: DEPLOYER_PK not set, skipping")
        return 0, 0, {}

    with engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT p.chat_id, p.amount, t.symbol, t.token_address
                FROM pending_rewards p
                JOIN chat_tokens t ON t.chat_id = p.chat_id
                WHERE p.user_id = :u
                  AND p.amount NOT IN ('', '0')
                  AND t.token_address IS NOT NULL
            """),
            {"u": user_id},
        ).fetchall()

    if not rows:
        return 0, 0, {}

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    acct = w3.eth.account.from_key(DEPLOYER_PK)
    to = Web3.to_checksum_address(address)
    nonce = next_nonce(w3, acct.address)

    claimed = 0
    failed = 0
    totals: dict = {}

    for chat_id, amount_str, symbol, token_address in rows:
        try:
            amount = int(amount_str)
            if amount <= 0:
                continue
            contract = w3.eth.contract(
                address=Web3.to_checksum_address(token_address),
                abi=CHAT_TOKEN_MINT_ABI,
            )
            tx = contract.functions.mint(to, amount).build_transaction({
                "from": acct.address,
                "nonce": nonce,
                "gas": 200_000,
                "gasPrice": w3.eth.gas_price,
                "chainId": CHAIN_ID,
            })
            signed = acct.sign_transaction(tx)
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
            # Up to three minutes per row, which is why every caller of this
            # function hands it to a thread: the dispatcher is sequential, so
            # waiting here on the event loop stops the bot answering anybody.
            receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
            nonce += 1
            if receipt.status != 1:
                failed += 1
                logger.error(
                    "claim_pending: tx reverted user=%s chat=%s symbol=%s tx=%s",
                    user_id, chat_id, symbol, tx_hash.hex(),
                )
                continue

            with engine.begin() as conn:
                conn.execute(
                    text("DELETE FROM pending_rewards WHERE chat_id = :c AND user_id = :u"),
                    {"c": chat_id, "u": user_id},
                )
            claimed += 1
            totals[symbol] = totals.get(symbol, 0) + amount
            logger.info(
                "claim_pending: minted %s %s to %s user=%s chat=%s tx=%s",
                amount, symbol, address, user_id, chat_id, tx_hash.hex(),
            )
        except Exception as e:
            failed += 1
            logger.error(
                "claim_pending: mint failed user=%s chat=%s symbol=%s: %s",
                user_id, chat_id, symbol, e,
            )
            # A failed send did not consume a nonce, so carrying on from the next one
            # opens a gap the chain can never close and every later signature lands
            # further out of reach — that is how one failure became 512 on
            # 2026-09-14. Ask the chain again instead of guessing.
            nonce = next_nonce(w3, acct.address)

    return claimed, failed, totals


async def _process_set_wallet(update: Update, context: ContextTypes.DEFAULT_TYPE, address: str):
    """Shared implementation for /set_wallet <addr> and the follow-up message
    captured after a bare /set_wallet. Validates, persists, claims pending."""
    user_id = update.effective_user.id
    lang = lang_of(update)

    if not is_valid_eth_address(address):
        # Re-arm the prompt so the user can simply retry without re-invoking
        # /set_wallet. They can /cancel to bail out.
        context.user_data["awaiting_wallet"] = True
        await update.message.reply_text(tr(
            lang,
            "Неверный формат адреса. Нужен 0x и 40 шестнадцатеричных символов.\n"
            "Пришлите правильный адрес или /cancel для отмены.",
            "Invalid address format. Expected 0x followed by 40 hex characters.\n"
            "Send a valid address, or /cancel to abort.",
        ))
        return

    try:
        with engine.begin() as conn:
            conn.execute(
                text("""
                    INSERT INTO tg_wallets (user_id, address)
                    VALUES (:user_id, :address)
                    ON CONFLICT(user_id) DO UPDATE SET address = :address
                """),
                {"user_id": user_id, "address": address},
            )
    except Exception as e:
        logger.error(f"Error in set_wallet: {e}")
        await update.message.reply_text(tr(lang, "Не удалось сохранить адрес. Попробуйте ещё раз.",
                                           "Error saving address. Try again."))
        return

    # Check whether anything is owed before we promise a mint.
    with engine.connect() as conn:
        pending_count = conn.execute(
            text("""
                SELECT COUNT(*)
                FROM pending_rewards p
                JOIN chat_tokens t ON t.chat_id = p.chat_id
                WHERE p.user_id = :u
                  AND p.amount NOT IN ('', '0')
                  AND t.token_address IS NOT NULL
            """),
            {"u": user_id},
        ).scalar() or 0

    saved = tr(lang, f"Кошелёк сохранён: {address}", f"Wallet saved: {address}")
    if pending_count == 0:
        await update.message.reply_text(saved + "\n" + tr(
            lang,
            "Вы будете получать награды всех токенов чатов, где вы участвуете, "
            "и 1 TG каждый час из общего аирдропа.",
            "You will receive rewards from every chat token in groups you participate in, "
            "and 1 TG every hour from the global airdrop.",
        ))
        return

    status_msg = await update.message.reply_text(saved + "\n" + tr(
        lang, f"Забираю отложенные награды из чатов: {pending_count}…",
        f"Claiming pending rewards from {pending_count} chat(s)...",
    ))
    try:
        claimed, failed, totals = await asyncio.to_thread(_claim_pending_rewards, user_id, address)
    except Exception as e:
        logger.error(f"set_wallet claim failed: {e}")
        await status_msg.edit_text(saved + "\n" + tr(
            lang,
            "Не получилось забрать отложенные награды автоматически. Они в сохранности "
            "в базе, попробуем позже.",
            "Could not claim pending rewards automatically. They are safe in the database "
            "and will be retried later.",
        ))
        return

    if not totals:
        await status_msg.edit_text(saved + "\n" + tr(
            lang, f"Попытка была, но ничего не прошло (ошибок: {failed}). Попробуем позже.",
            f"Claim attempted but nothing succeeded ({failed} failed). Will retry later.",
        ))
        return

    lines = [saved, tr(lang, "Отложенные награды получены:", "Claimed pending rewards:")]
    for symbol, total in totals.items():
        human = total / 10**18
        lines.append(f"  {human:g} {symbol}")
    if failed:
        lines.append(tr(lang, f"(чатов с ошибкой: {failed}, попробуем позже)",
                        f"({failed} chat(s) failed and will retry later)"))
    await status_msg.edit_text("\n".join(lines))


async def set_wallet_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """`/set_wallet <address>` -- bind a wallet and claim pending rewards.

    If invoked without an argument, the bot asks the user to send the address
    in the next message. The follow-up handler (`pending_input_handler`)
    picks it up using `context.user_data["awaiting_wallet"]`.
    """
    args = context.args or []
    chat = update.effective_chat
    lang = lang_of(update)
    if not args:
        # Interactive follow-up only makes sense in DMs -- in groups the bot
        # would otherwise hijack the next casual message the user sends.
        if chat is not None and chat.type == "private":
            context.user_data["awaiting_wallet"] = True
            await update.message.reply_text(tr(
                lang, "Пришлите адрес кошелька одним сообщением (начинается с 0x) или /cancel для отмены.",
                "Send your wallet address now (a single message starting with 0x), "
                "or /cancel to abort.",
            ))
        else:
            await update.message.reply_text(tr(
                lang, "Как: /set_wallet <адрес>\nПример: /set_wallet 0x1234...",
                "Usage: /set_wallet <address>\nExample: /set_wallet 0x1234...",
            ))
        return
    context.user_data.pop("awaiting_wallet", None)
    await _process_set_wallet(update, context, args[0].strip())


async def cancel_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Cancel any pending interactive flow (/set_wallet or /create_token)."""
    cancelled = bool(context.user_data.pop("awaiting_wallet", None))
    for key in ("awaiting_token_name", "awaiting_token_interval", "token_name", "awaiting_token_chat_id", "awaiting_token_bot_msg_id"):
        if context.user_data.pop(key, None) is not None:
            cancelled = True
    lang = lang_of(update)
    await update.message.reply_text(tr(lang, "Отменено.", "Cancelled.") if cancelled
                                    else tr(lang, "Нечего отменять.", "Nothing to cancel."))


async def pending_input_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Catch the next text message from a user who issued bare /set_wallet.

    Only fires when `awaiting_wallet` is set in the user's `user_data` and the
    message text looks like a single address-shaped token. Anything else is
    ignored so we don't accidentally hijack normal chat messages.
    """
    if not context.user_data.get("awaiting_wallet"):
        return
    msg = update.effective_message
    if msg is None or not msg.text:
        return
    text_value = msg.text.strip()
    # Bare addresses only -- skip if user typed a command in the meantime.
    if text_value.startswith("/"):
        return
    # If the user sent multiple tokens, take the first.
    candidate = text_value.split()[0]
    # Message handlers in later groups also see this update. Mark it so the AI
    # assistant does not answer the wallet address after this flow clears its
    # awaiting state.
    context.user_data["ai_skip_message_id"] = msg.message_id
    context.user_data.pop("awaiting_wallet", None)
    await _process_set_wallet(update, context, candidate)


async def pending_create_token_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Catch the next text message from a user who issued bare /create_token.

    Fires when `awaiting_token_name` or `awaiting_token_interval` is set in
    the user's `user_data`.  Only processes messages that reply to the bot's
    last prompt, so the handler works in both privacy mode and when the bot is
    an admin, without hijacking casual group chat.
    """
    awaiting_name = context.user_data.get("awaiting_token_name")
    awaiting_interval = context.user_data.get("awaiting_token_interval")
    if not awaiting_name and not awaiting_interval:
        return

    chat = update.effective_chat
    if chat is None or chat.id != context.user_data.get("awaiting_token_chat_id"):
        return

    msg = update.effective_message
    if msg is None or not msg.text:
        return

    text_value = msg.text.strip()
    if text_value.startswith("/"):
        return

    # Must be a reply to the bot's prompt message (handles privacy mode).
    expected_bot_msg_id = context.user_data.get("awaiting_token_bot_msg_id")
    if not msg.reply_to_message or msg.reply_to_message.message_id != expected_bot_msg_id:
        return

    # This reply belongs to the token wizard, not to the AI assistant. The
    # final wizard step clears all awaiting flags before later handler groups
    # run, so use the concrete update id as the hand-off marker.
    context.user_data["ai_skip_message_id"] = msg.message_id

    # Use the first line as the value so multi-line pastes don't confuse us.
    value = text_value.splitlines()[0].strip()
    lang = lang_of(update)

    if awaiting_name:
        context.user_data.pop("awaiting_token_name", None)
        context.user_data.pop("awaiting_token_bot_msg_id", None)
        name = value
        if not name or len(name) > 48:
            context.user_data["awaiting_token_name"] = True
            retry = await update.message.reply_text(tr(
                lang,
                "Название токена — от 1 до 48 символов. Ответьте на это сообщение названием или /cancel для отмены.",
                "Token name must be 1..48 characters. Reply to this message with the name, or /cancel to abort.",
            ))
            context.user_data["awaiting_token_bot_msg_id"] = retry.message_id
            return
        context.user_data["token_name"] = name
        context.user_data["awaiting_token_interval"] = True
        bot_msg = await update.message.reply_text(ASK_TOKEN_INTERVAL(lang))
        context.user_data["awaiting_token_bot_msg_id"] = bot_msg.message_id
        return

    if awaiting_interval:
        context.user_data.pop("awaiting_token_interval", None)
        context.user_data.pop("awaiting_token_bot_msg_id", None)
        name = context.user_data.pop("token_name", None)
        if not name:
            context.user_data.pop("awaiting_token_chat_id", None)
            await update.message.reply_text(tr(
                lang, "Что-то пошло не так — название токена потерялось. Попробуйте /create_token ещё раз.",
                "Something went wrong — the token name was lost. Try /create_token again.",
            ))
            return
        context.user_data.pop("awaiting_token_chat_id", None)
        interval_raw = value
        await _process_create_token(update, context, name, interval_raw)


async def unset_wallet_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Remove the linked wallet without dropping accrued pending rewards.

    The user can /set_wallet again later (possibly with a different address)
    and the pending balance will be minted to the new wallet.
    """
    user_id = update.effective_user.id
    lang = lang_of(update)
    try:
        with engine.begin() as conn:
            result = conn.execute(
                text("DELETE FROM tg_wallets WHERE user_id = :u"),
                {"u": user_id},
            )
    except Exception as e:
        logger.error(f"Error in unset_wallet: {e}")
        await update.message.reply_text(tr(lang, "Не удалось отвязать кошелёк. Попробуйте ещё раз.",
                                           "Error removing wallet. Try again."))
        return

    if result.rowcount == 0:
        await update.message.reply_text(tr(lang, "Кошелёк и не был привязан.", "No wallet was linked."))
        return

    await update.message.reply_text(tr(
        lang,
        "Кошелёк отвязан. Отложенные награды сохранятся и будут начислены "
        "на следующий кошелёк, который вы привяжете через /set_wallet.",
        "Wallet removed. Any pending rewards stay credited and will be minted "
        "to the next wallet you link with /set_wallet.",
    ))


BALANCE_OF_ABI = [{
    "inputs": [{"name": "account", "type": "address"}],
    "name": "balanceOf",
    "outputs": [{"name": "", "type": "uint256"}],
    "stateMutability": "view",
    "type": "function",
}]


def _pending_for(user_id: int):
    """Rows this user could claim right now: (symbol, amount as int)."""
    with engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT t.symbol, p.amount
                FROM pending_rewards p
                JOIN chat_tokens t ON t.chat_id = p.chat_id
                WHERE p.user_id = :u
                  AND p.amount NOT IN ('', '0')
                  AND t.token_address IS NOT NULL
            """),
            {"u": user_id},
        ).fetchall()
    out = []
    for symbol, amount in rows:
        try:
            value = int(amount)
        except (TypeError, ValueError):
            continue
        if value > 0:
            out.append((symbol, value))
    return out


async def claim_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """`/claim` -- mint everything this user has accrued, on request.

    Rewards accrue off-chain on every tick and reach the chain only here. That
    ordering is the point: it stops the payout job writing hundreds of
    transactions nobody asked for, and it makes collecting a reward an action
    the person took, which is the only version of this that anybody values.

    Answering in the group would publish somebody's wallet and spam the room,
    so this always replies privately and leaves a pointer behind when it was
    called in a chat.
    """
    user = update.effective_user
    chat = update.effective_chat
    if user is None:
        return

    # Same proof-of-presence rule /balance uses: without admin rights the bot
    # never sees silent members, so asking is how you get on the list.
    if chat is not None and chat.type in ("group", "supergroup"):
        try:
            _record_chat_member(chat.id, user.id)
        except Exception as e:
            logger.debug(f"claim member tracking failed: {e}")

    pending = _pending_for(user.id)
    lang = lang_of(update)
    # The result goes to the person's private chat, in that chat's language.
    dm_lang = lang_for(user.id, user)

    if not pending:
        await update.effective_message.reply_text(tr(
            lang,
            "Пока забирать нечего. Участвуйте в чате, у которого есть токен, — "
            "награды будут копиться, а /claim переведёт их в сеть.",
            "Nothing to claim yet. Take part in a chat that has a token and "
            "rewards will accrue -- then /claim brings them on-chain.",
        ))
        return

    owed = ", ".join(
        f"{_format_token_amount(amount, 18)} {symbol}" for symbol, amount in pending
    )

    address = _wallet_for_user(user.id)

    if not address:
        await update.effective_message.reply_text(tr(
            lang,
            f"Вас ждёт: {owed}.\n\n"
            "Привяжите кошелёк, чтобы получить: /set_wallet <адрес>\n"
            f"Нет кошелька? Создайте за пару секунд: {WALLET_MINI_APP_URL}",
            f"You have {owed} waiting.\n\n"
            "Set a wallet to receive it: /set_wallet <address>\n"
            f"No wallet yet? Create one in seconds: {WALLET_MINI_APP_URL}",
        ))
        return

    if chat is not None and chat.type in ("group", "supergroup"):
        await update.effective_message.reply_text(tr(
            lang, f"Забираю {owed} — результат пришлю в личку.",
            f"Claiming {owed} -- sending you the result privately.",
        ))

    not_through = tr(dm_lang, "Не получилось. Ваш баланс в сохранности — попробуйте /claim чуть позже.",
                     "The claim did not go through. Your balance is safe -- try /claim again shortly.")
    try:
        claimed, failed, totals = await asyncio.to_thread(_claim_pending_rewards, user.id, address)
    except Exception as e:
        logger.error("claim_command: failed user=%s: %s", user.id, e)
        await context.bot.send_message(chat_id=user.id, text=not_through)
        return

    if claimed == 0:
        await context.bot.send_message(chat_id=user.id, text=not_through)
        return

    minted = ", ".join(
        f"{_format_token_amount(amount, 18)} {symbol}" for symbol, amount in totals.items()
    )
    tail = tr(dm_lang, f"\nНе отправилось токенов: {failed}, они ещё ждут.",
              f"\n{failed} token(s) could not be sent and are still waiting.") if failed else ""

    # The claim is only half of what somebody wanted; the other half is doing
    # something with it. The button is offered here because this is the one
    # moment we know for certain the balance is on-chain.
    claimed_tokens = [
        (symbol, addr)
        for symbol, addr in _token_addresses(totals.keys())
    ]

    await context.bot.send_message(
        chat_id=user.id,
        text=tr(dm_lang, f"Получено {minted} на {address}.{tail}", f"Claimed {minted} to {address}.{tail}"),
        # Always private: this message is a direct message by construction.
        reply_markup=swap_markup(True, claimed_tokens, lang=dm_lang),
    )


def _token_addresses(symbols):
    """(symbol, address) for chat tokens, in the order asked for."""
    wanted = list(symbols)

    if not wanted:
        return []

    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT symbol, token_address FROM chat_tokens WHERE token_address IS NOT NULL"),
        ).fetchall()

    by_symbol = {symbol: address for symbol, address in rows}

    return [(s, by_symbol[s]) for s in wanted if s in by_symbol]


async def balance_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show: linked wallet, global TG balance, every chat-token balance the user
    is eligible for, and any pending (claimable on /set_wallet) amounts."""
    user_id = update.effective_user.id
    lang = lang_of(update)

    # Without admin rights the bot doesn't receive chat_member updates, so
    # silent observers never end up in chat_members. Treat /balance in a group
    # as proof-of-presence: record the caller so they (and the chat owner who
    # almost certainly also runs /balance) actually start accruing rewards.
    chat = update.effective_chat
    if chat is not None and chat.type in ("group", "supergroup"):
        try:
            _record_chat_member(chat.id, user_id)
        except Exception as e:
            logger.debug(f"balance member tracking failed: {e}")

    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT address FROM tg_wallets WHERE user_id = :u"),
            {"u": user_id},
        ).fetchone()
        # Chat tokens this user is a member of (regardless of wallet status).
        chat_tokens = conn.execute(
            text("""
                SELECT t.chat_id, t.name, t.symbol, t.token_address
                FROM chat_members cm
                JOIN chat_tokens t ON t.chat_id = cm.chat_id
                WHERE cm.user_id = :u
                  AND t.token_address IS NOT NULL
            """),
            {"u": user_id},
        ).fetchall()
        pending = conn.execute(
            text("""
                SELECT t.symbol, p.amount
                FROM pending_rewards p
                JOIN chat_tokens t ON t.chat_id = p.chat_id
                WHERE p.user_id = :u
                  AND p.amount NOT IN ('', '0')
            """),
            {"u": user_id},
        ).fetchall()

    address = row[0] if row else None
    lines = []
    swappable: list[tuple[str, str]] = []

    if address:
        lines.append(tr(lang, f"Кошелёк: {address}", f"Wallet: {address}"))
    else:
        lines.append(tr(lang, "Кошелёк: не привязан — /set_wallet <адрес>, затем /claim.",
                        "Wallet: not set -- use /set_wallet <address>, then /claim."))

    if address:
        try:
            w3 = Web3(Web3.HTTPProvider(RPC_URL))
            checksum = Web3.to_checksum_address(address)
        except Exception as e:
            logger.exception(f"balance: web3/checksum init failed: {e}")
            w3 = None
            checksum = None

        # Global TG token is optional: if TG_TOKEN_ADDRESS isn't configured we
        # just skip this line instead of poisoning the whole message.
        if w3 is not None and checksum is not None and TOKEN_ADDRESS:
            try:
                # TOKEN_ABI only declares mint/symbol; balanceOf lives in
                # BALANCE_OF_ABI, which is the only thing we need here.
                tg_contract = w3.eth.contract(
                    address=Web3.to_checksum_address(TOKEN_ADDRESS), abi=BALANCE_OF_ABI
                )
                tg_balance = tg_contract.functions.balanceOf(checksum).call() / 10**18
                lines.append(tr(lang, f"TG (общий): {tg_balance:g}", f"TG (global): {tg_balance:g}"))
            except Exception as e:
                logger.exception(
                    f"balance: TG global read failed for {address} at {TOKEN_ADDRESS}: {e}"
                )
                lines.append(tr(lang, "TG (общий): (ошибка чтения)", "TG (global): (read error)"))

        if w3 is not None and checksum is not None and chat_tokens:
            lines.append("")
            lines.append(tr(lang, "Балансы токенов чатов:", "Chat token balances:"))
            for _cid, _name, symbol, token_address in chat_tokens:
                try:
                    c = w3.eth.contract(
                        address=Web3.to_checksum_address(token_address),
                        abi=BALANCE_OF_ABI,
                    )
                    bal = c.functions.balanceOf(checksum).call() / 10**18
                    lines.append(f"  {symbol}: {bal:g}")
                    # A [Swap] button under a zero balance is a button that
                    # opens a screen with nothing to trade, so it is offered
                    # for what the person actually holds and nothing else.
                    if bal > 0:
                        swappable.append((symbol, token_address))
                except Exception as e:
                    logger.exception(
                        f"balance: chat-token read failed for {symbol} ({token_address}): {e}"
                    )
                    lines.append(f"  {symbol}: " + tr(lang, "(ошибка чтения)", "(read error)"))

    if pending:
        lines.append("")
        lines.append(tr(lang, "Ждёт вас (/claim — забрать):", "Waiting for you (/claim to collect):"))
        for symbol, amount_str in pending:
            human = int(amount_str) / 10**18
            lines.append(f"  {human:g} {symbol}")
    elif not address:
        # Help wallet-less users understand why pending may be zero. Show every
        # chat-with-token they are a member of, so they know what to expect.
        lines.append("")
        if chat_tokens:
            lines.append(tr(lang, "Вам положены токены этих чатов (награды будут копиться здесь):",
                            "You are eligible for these chat tokens (rewards will accrue here):"))
            for _cid, _name, symbol, _addr in chat_tokens:
                lines.append(f"  {symbol}")
            lines.append(tr(
                lang,
                "Сейчас отложенного нет. Новые награды начисляются на каждой "
                "выплате чата — загляните после следующего интервала.",
                "Pending is empty right now. New rewards are credited on each "
                "payout tick of the chat, so check back after the next interval.",
            ))
        else:
            lines.append(tr(
                lang,
                "Отложенных наград пока нет. Напишите хотя бы одно сообщение в чате "
                "с токеном наград и дождитесь его следующей выплаты.",
                "No pending rewards yet. Write at least one message in a chat "
                "that has a reward token, then wait for its next payout tick.",
            ))

    await update.message.reply_text(
        "\n".join(lines),
        reply_markup=swap_markup(_is_private(update), swappable, context.bot.username, lang=lang),
    )


async def wallet_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show the user's linked wallet address and a link to it on the explorer."""
    user_id = update.effective_user.id
    lang = lang_of(update)
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT address FROM tg_wallets WHERE user_id = :u"),
            {"u": user_id},
        ).fetchone()
    if not row:
        await update.message.reply_text(tr(
            lang, "Кошелёк ещё не привязан. Привязать: /set_wallet <адрес>.",
            "No wallet linked yet. Use /set_wallet <address> to link one.",
        ))
        return
    address = row[0]
    await update.message.reply_text(
        tr(lang, f"Кошелёк: {address}", f"Wallet: {address}") + f"\n{EXPLORER_URL}/address/{address}"
    )


ADMIN_USERNAME = "rtutin"


# Base58 (Bitcoin/Solana alphabet — no 0, O, I, l). Solana pubkeys are 32-44
# base58 chars; EVM addresses are checked first so the 0x prefix never reaches
# this pattern.
_SOL_ADDR_RE = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{32,44}$")


def _classify_whois_arg(arg: str) -> str:
    """Map a /whois argument to 'user_id', 'evm', 'solana', or 'unknown'."""
    if arg.isdigit():
        return "user_id"
    if is_valid_eth_address(arg):
        return "evm"
    if _SOL_ADDR_RE.match(arg):
        return "solana"
    return "unknown"


def _github_for_address(conn, address_lower: str) -> list[str]:
    """GitHub usernames linked to an EVM address (empty if the table is absent)."""
    try:
        rows = conn.execute(
            text("SELECT github_username FROM github_wallets WHERE LOWER(wallet_address) = :a"),
            {"a": address_lower},
        ).fetchall()
        return [r[0] for r in rows]
    except Exception as e:
        logger.debug(f"whois: github_wallets lookup failed: {e}")
        return []


def _whois_collect(user_id: int) -> dict:
    """Gather everything the DB knows about one Telegram user_id (blocking)."""
    with engine.connect() as conn:
        evm = conn.execute(
            text("SELECT address, created_at FROM tg_wallets WHERE user_id = :u"),
            {"u": user_id},
        ).fetchall()

        github: list[str] = []
        for addr, _created in evm:
            github.extend(_github_for_address(conn, addr.lower()))

        sol = conn.execute(
            text("""
                SELECT solana_address, balance_raw, is_whale, invited,
                       verified_at, last_checked_at
                FROM tg_sol_wallets WHERE tg_user_id = :u
            """),
            {"u": user_id},
        ).fetchone()

        chats = conn.execute(
            text("""
                SELECT cm.chat_id, t.name, t.symbol, cm.first_seen, cm.last_seen
                FROM chat_members cm
                LEFT JOIN chat_tokens t ON t.chat_id = cm.chat_id
                WHERE cm.user_id = :u
                ORDER BY cm.last_seen DESC
            """),
            {"u": user_id},
        ).fetchall()

        pending = conn.execute(
            text("""
                SELECT t.symbol, p.amount
                FROM pending_rewards p
                JOIN chat_tokens t ON t.chat_id = p.chat_id
                WHERE p.user_id = :u
                  AND p.amount NOT IN ('', '0')
            """),
            {"u": user_id},
        ).fetchall()

    return {"evm": evm, "github": github, "sol": sol, "chats": chats, "pending": pending}


async def _whois_user_section(context: ContextTypes.DEFAULT_TYPE, user_id: int) -> list[str]:
    """Render a full profile block for one Telegram user_id."""
    data = await asyncio.to_thread(_whois_collect, user_id)
    lines = [f"Telegram user_id: {user_id}"]

    try:
        tg_user = await context.bot.get_chat(user_id)
        uname = f"@{tg_user.username}" if tg_user.username else "(no username)"
        full_name = " ".join(
            p for p in (tg_user.first_name, tg_user.last_name) if p
        ) or "(no name)"
        lines.append(f"Name: {full_name} {uname}")
    except TelegramError as e:
        lines.append(f"Name: (lookup failed: {e})")

    if data["github"]:
        # dict.fromkeys dedupes while keeping order across multiple wallets.
        lines.append("GitHub: " + ", ".join(f"@{g}" for g in dict.fromkeys(data["github"])))

    if data["evm"]:
        for addr, created_at in data["evm"]:
            lines.append(f"EVM wallet: {addr}")
            lines.append(f"  linked {created_at} · {EXPLORER_URL}/address/{addr}")
    else:
        lines.append("EVM wallet: none linked")

    sol = data["sol"]
    if sol:
        sol_addr, balance_raw, is_whale, invited, verified_at, last_checked_at = sol
        try:
            human = int(balance_raw) / 10**CYBER_SOL_DECIMALS
        except (TypeError, ValueError):
            human = 0.0
        flags = []
        if is_whale:
            flags.append("🐳 whale")
        if invited:
            flags.append("invited")
        flag_str = (" [" + ", ".join(flags) + "]") if flags else ""
        lines.append(f"Solana wallet: {sol_addr}{flag_str}")
        lines.append(
            f"  CYBER.sol {human:,.2f} · verified {verified_at or '?'}"
            f" · checked {last_checked_at or '?'}"
        )
    else:
        lines.append("Solana wallet: none linked")

    chats = data["chats"]
    if chats:
        lines.append(f"Chats ({len(chats)}):")
        for chat_id, name, symbol, first_seen, last_seen in chats:
            label = f"{name} ({symbol})" if name else "(no token)"
            lines.append(f"  {chat_id} {label} — seen {first_seen}..{last_seen}")
    else:
        lines.append("Chats: none tracked")

    if data["pending"]:
        lines.append("Pending rewards:")
        for symbol, amount_str in data["pending"]:
            human = int(amount_str) / 10**18
            lines.append(f"  {human:g} {symbol}")

    return lines


async def whois_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/whois <telegram_id | evm_address | solana_address> — admin-only.

    Resolves any of the three identifiers to the Telegram user(s) behind it and
    dumps everything linked: profile name, EVM/Solana wallets (+ CYBER.sol
    balance & whale status), GitHub link, chat memberships, and pending rewards.
    Restricted to @rtutin."""
    user = update.effective_user
    if user is None or (user.username or "").lower() != ADMIN_USERNAME:
        logger.warning(
            "Unauthorized /whois attempt by user_id=%s username=%s",
            user.id if user else None,
            user.username if user else None,
        )
        return

    args = context.args or []
    if not args:
        await update.message.reply_text(
            "Usage: /whois <telegram_id | evm_address | solana_address>"
        )
        return

    query = args[0].strip()
    kind = _classify_whois_arg(query)
    if kind == "unknown":
        await update.message.reply_text(
            "Unrecognized input. Pass a Telegram user_id (digits), an EVM "
            "address (0x + 40 hex), or a Solana address (base58)."
        )
        return

    orphan_github: list[str] = []
    with engine.connect() as conn:
        if kind == "user_id":
            user_ids = [int(query)]
        elif kind == "evm":
            rows = conn.execute(
                text("SELECT user_id FROM tg_wallets WHERE LOWER(address) = :a"),
                {"a": query.lower()},
            ).fetchall()
            user_ids = [r[0] for r in rows]
            if not user_ids:
                # The address may carry a GitHub link with no Telegram wallet.
                orphan_github = _github_for_address(conn, query.lower())
        else:  # solana
            rows = conn.execute(
                text("SELECT tg_user_id FROM tg_sol_wallets WHERE solana_address = :a"),
                {"a": query},
            ).fetchall()
            user_ids = [r[0] for r in rows]

    if not user_ids and not orphan_github:
        await update.message.reply_text(f"Nothing linked to {query}.")
        return

    lines = [f"Query: {query}  ({kind})"]

    if orphan_github:
        lines.append("")
        lines.append(f"EVM {query} — no Telegram link.")
        lines.append("GitHub: " + ", ".join(f"@{g}" for g in dict.fromkeys(orphan_github)))

    seen: set[int] = set()
    for uid in user_ids:
        if uid in seen:
            continue
        seen.add(uid)
        lines.append("")
        lines.extend(await _whois_user_section(context, uid))

    await update.message.reply_text("\n".join(lines), disable_web_page_preview=True)


async def token_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Show this chat's reward token details and an explorer link."""
    chat = update.effective_chat
    if chat is None:
        return
    lang = lang_of(update)
    if chat.type not in ("group", "supergroup"):
        await update.message.reply_text(tr(
            lang, "Используйте эту команду в группе, чей токен хотите посмотреть.",
            "Use this command inside the group chat whose token you want to inspect.",
        ))
        return
    # Same reasoning as in /balance: running /token in the group is concrete
    # proof the caller belongs here, so use it to backfill chat_members when
    # the bot lacks admin rights to receive chat_member updates.
    user = update.effective_user
    if user is not None and not user.is_bot:
        try:
            _record_chat_member(chat.id, user.id)
        except Exception as e:
            logger.debug(f"token member tracking failed: {e}")

    chat_token = get_chat_token(chat.id)
    if chat_token is None:
        await update.message.reply_text(tr(
            lang,
            "У этого чата нет токена наград. Владелец чата может создать его: "
            "/create_token <название> <интервал>.",
            "This chat has no reward token. The chat owner can create one with "
            "/create_token <name> <interval>.",
        ))
        return
    _cid, name, symbol, token_address, interval, _reward = chat_token
    if not token_address:
        await update.message.reply_text(tr(
            lang, f"Токен {name} ({symbol}) ещё выпускается. Попробуйте чуть позже.",
            f"Token {name} ({symbol}) is still being deployed. Try again shortly.",
        ))
        return
    await update.message.reply_text(tr(
        lang,
        f"Название: {name}\n"
        f"Символ: {symbol}\n"
        f"Адрес: {token_address}\n"
        f"Интервал наград: {format_interval(interval)}\n",
        f"Name: {name}\n"
        f"Symbol: {symbol}\n"
        f"Address: {token_address}\n"
        f"Rewards interval: {format_interval(interval)}\n",
    ) + f"{EXPLORER_URL}/address/{token_address}")


async def track_chat_member(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Record (chat_id, user_id) for any message in a group, and remove the
    row when a service message reports the user left or was kicked. Used by
    the payout pipeline to know who currently belongs to a chat that has its
    own reward token."""
    chat = update.effective_chat
    message = update.effective_message
    if chat is None or chat.type not in ("group", "supergroup"):
        return

    # Membership departures arrive as service messages on the same update.
    if message is not None:
        left = getattr(message, "left_chat_member", None)
        if left is not None and not left.is_bot:
            try:
                _forget_chat_member(chat.id, left.id)
                logger.info(
                    "chat_members: removed user_id=%s from chat_id=%s (left/kicked via service msg)",
                    left.id, chat.id,
                )
            except Exception as e:
                logger.debug(f"forget_chat_member (left) failed: {e}")

        new_members = getattr(message, "new_chat_members", None) or []
        for member in new_members:
            if member.is_bot:
                continue
            try:
                _record_chat_member(chat.id, member.id)
            except Exception as e:
                logger.debug(f"record_chat_member (new) failed: {e}")

    # Anyone whose message reached us is, by definition, currently in the chat.
    user = update.effective_user
    if user is None or user.is_bot:
        return
    try:
        _record_chat_member(chat.id, user.id)
    except Exception as e:
        logger.debug(f"track_chat_member failed: {e}")


async def on_chat_member_update(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Handle `chat_member` updates -- fires for *every* membership status
    transition in groups where the bot is admin, including silent leaves and
    bans that never produce a visible service message. Required for the
    payout filter to stay accurate when users quietly leave."""
    cmu = update.chat_member
    if cmu is None:
        return
    chat = cmu.chat
    if chat.type not in ("group", "supergroup"):
        return
    user = cmu.new_chat_member.user
    if user.is_bot:
        return

    new_status = cmu.new_chat_member.status
    # Statuses that mean "currently in the chat".
    present = {"creator", "administrator", "member", "restricted"}
    try:
        if new_status in present:
            _record_chat_member(chat.id, user.id)
        else:
            # left, kicked, etc.
            _forget_chat_member(chat.id, user.id)
            logger.info(
                "chat_members: removed user_id=%s from chat_id=%s (status=%s via chat_member update)",
                user.id, chat.id, new_status,
            )
    except Exception as e:
        logger.debug(f"on_chat_member_update failed: {e}")
async def stats_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/stats [window] — on-demand activity digest, default last 24h.
    Examples: /stats, /stats 6h, /stats 3d. Read-only: never moves the
    periodic digest's window or its price comparison base."""
    lang = lang_of(update)
    project = projects.for_chat(update.effective_chat)
    if not project:
        await update.message.reply_text(tr(lang, "Для этого чата не настроен проект.\n",
                                           "No project is configured for this chat.\n") + projects.setup_hint(lang))
        return
    if not project.get("cyber"):
        if project["chain"] != "solana":
            await update.message.reply_text(tr(lang, "Статистика активности для сети этого проекта недоступна.",
                                               "Activity statistics are not available for this project's network."))
            return
        from bot import pumpfun
        market = await asyncio.to_thread(pumpfun.market_snapshot, project["address"])
        if not market:
            await update.message.reply_text(tr(lang, "Рыночные данные по токену этого чата недоступны.",
                                               "Market data is unavailable for this chat's token."))
            return
        lines = [f"{project['symbol']} · Solana · " + tr(lang, "последний доступный срез рынка",
                                                         "latest available market snapshot")]
        for label, field in ((tr(lang, "Цена", "Price"), "price_usd"), ("FDV", "fdv"),
                             (tr(lang, "Ликвидность", "Liquidity"), "liquidity"),
                             (tr(lang, "Объём за 24ч", "24h volume"), "volume_24h")):
            value = market.get(field)
            lines.append(f"{label}: ${value:,.10g}" if value is not None
                         else f"{label}: " + tr(lang, "нет данных", "unavailable"))
        if market.get("read_at"):
            lines.append(tr(lang, "Прочитано: ", "Read at: ")
                         + datetime.fromtimestamp(market["read_at"], timezone.utc).isoformat())
        await update.message.reply_text("\n".join(lines))
        return
    args = context.args or []
    seconds = 24 * 3600
    if args:
        try:
            seconds = parse_interval(args[0])
        except ValueError as e:
            await update.message.reply_text(tr(
                lang, f"Неверное окно: {e}\nПримеры: /stats 6h, /stats 3d",
                f"Bad window: {e}\nExamples: /stats 6h, /stats 3d",
            ))
            return

    since = (datetime.now(timezone.utc) - timedelta(seconds=seconds)).strftime(_SQLITE_TS)
    window_label = _format_window(seconds)
    digest = await asyncio.to_thread(_build_digest_text, since, window_label)
    if digest is None:
        await update.message.reply_text(tr(
            lang, f"За последние {window_label} отслеживаемой активности в сети не было.",
            f"No tracked on-chain activity in the last {window_label}.",
        ))
        return
    price_line = await asyncio.to_thread(_cyber_price_line)
    if price_line:
        digest += "\n\n" + price_line
    await update.message.reply_text(
        digest, parse_mode="HTML", disable_web_page_preview=True
    )
async def whale_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/whale — DM only. Hand out a one-time link to prove CYBER.sol holdings via
    Phantom and (if above the threshold) get invited to the whales chat."""
    chat = update.effective_chat
    user = update.effective_user
    if user is None:
        return
    lang = lang_of(update)
    if chat is not None and chat.type != "private":
        await update.message.reply_text(tr(
            lang,
            f"Чтобы попасть в чат, нужно держать {WHALE_MIN_CYBER_SOL:,} CYBER.sol.\n"
            "Напишите мне /whale в личку, чтобы проверить баланс CYBER.sol.",
            f"To access the chat you must hold {WHALE_MIN_CYBER_SOL:,} CYBER.sol.\n"
            "DM me /whale in private to verify your CYBER.sol balance.",
        ))
        return
    if not WHALE_CHAT_ID:
        await update.message.reply_text(tr(lang, "Проверка китов на этом боте пока не настроена.",
                                           "Whale verification isn't configured on this bot yet."))
        return

    token = secrets.token_urlsafe(24)
    expires_at = (datetime.now(timezone.utc) + timedelta(minutes=WHALE_LINK_TTL_MINUTES)).strftime("%Y-%m-%d %H:%M:%S")
    try:
        with engine.begin() as conn:
            conn.execute(
                text("""
                    INSERT INTO tg_link_tokens (token, tg_user_id, expires_at, used)
                    VALUES (:t, :u, :e, 0)
                """),
                {"t": token, "u": user.id, "e": expires_at},
            )
    except Exception as e:
        logger.error(f"whale: token insert failed for {user.id}: {e}")
        await update.message.reply_text(tr(lang, "Внутренняя ошибка. Попробуйте ещё раз.", "Internal error. Try again."))
        return

    url = f"{WHALE_VERIFY_URL}?t={token}"
    await update.message.reply_text(
        tr(lang,
           f"Чтобы войти в чат китов, нужно держать не меньше {WHALE_MIN_CYBER_SOL:,} CYBER.sol.\n\n"
           f"Подключите Phantom и подпишите — ссылка действует {WHALE_LINK_TTL_MINUTES} мин:\n{url}\n\n"
           "На телефоне страница предложит «Открыть в Phantom» — соглашайтесь. Ни браузер "
           "Telegram, ни Chrome/Safari не содержат кошелька, поэтому подпись работает "
           "только во встроенном браузере Phantom.\n\n"
           "После проверки я пришлю в личку одноразовое приглашение.",
           f"To join the whales chat you must hold at least {WHALE_MIN_CYBER_SOL:,} CYBER.sol.\n\n"
           f"Connect Phantom and sign — valid {WHALE_LINK_TTL_MINUTES} min:\n{url}\n\n"
           "On a phone the page will offer \"Open in Phantom\" — take it. Neither "
           "Telegram's browser nor Chrome/Safari has a wallet inside it, so signing "
           "only works in Phantom's own browser.\n\n"
           "Once verified I'll DM you a one-time invite."),
        reply_markup=InlineKeyboardMarkup([
            [InlineKeyboardButton(tr(lang, "🐳 Проверить CYBER.sol", "🐳 Verify CYBER.sol"), url=url)],
        ]),
        disable_web_page_preview=True,
    )
async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    logger.error(f"Update {update} caused error {context.error}")
