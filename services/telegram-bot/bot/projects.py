"""Project identity and buy-alert preferences owned by one Telegram group."""
import asyncio
import html
import json
import math
import re
import uuid
from urllib.parse import urlsplit

from sqlalchemy import text
from telegram.error import TelegramError

from bot import config, db
from bot.language import T, lang_of, say, tr

PREFIX = "chat_project:"
SETUP_HINT = (
    "A group administrator can configure this chat with:\n"
    "/buybot setup solana <mint> <symbol> [name]\n"
    "/buybot setup lain\n"
    "/buybot setup cyber\n"
    "Solana alerts require a PumpSwap pool quoted in SOL."
)
SETUP_HINT_RU = (
    "Администратор группы может настроить этот чат:\n"
    "/buybot setup solana <mint> <символ> [название]\n"
    "/buybot setup lain\n"
    "/buybot setup cyber\n"
    "Для уведомлений Solana нужен пул PumpSwap в паре с SOL."
)


def setup_hint(lang="en"):
    return tr(lang, SETUP_HINT_RU, SETUP_HINT)


def _no_token():
    return T("Для этого чата не настроен токен.\n" + SETUP_HINT_RU, "No token is configured for this chat.\n" + SETUP_HINT)
FIELDS = {
    "name", "symbol", "x", "website", "telegram", "channel", "roadmap",
    "photo", "trade", "chart", "min_usd", "emoji", "emoji_usd",
}
URL_FIELDS = {"x", "website", "telegram", "channel", "roadmap", "photo", "trade", "chart"}


def saved(chat_id: int) -> dict | None:
    raw = db._kv_get(PREFIX + str(chat_id))
    return json.loads(raw) if raw else None


def save(chat_id: int, project: dict) -> None:
    project = dict(project, revision=uuid.uuid4().hex)
    with db.engine.begin() as conn:
        conn.execute(text(
            "INSERT INTO bot_kv (key, value) VALUES (:key, :value) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
        ), {"key": PREFIX + str(chat_id), "value": json.dumps(project)})
        # Explicit configuration replaces any legacy LAIN subscription.
        if project["chain"] != "robinhood" or not project.get("enabled"):
            conn.execute(text(
                "UPDATE bot_kv SET value = 'off' WHERE key = :key"
            ), {"key": "lain_buybot_chat:" + str(chat_id)})


def solana_project(mint: str, symbol: str, name: str) -> dict:
    return {
        "chain": "solana", "address": mint, "symbol": symbol, "name": name,
        "x": "", "website": "", "telegram": "", "channel": "", "roadmap": "",
        "photo": "", "trade": "",
        "chart": f"https://dexscreener.com/solana/{mint}",
        "min_usd": 5.0, "emoji": "🎲", "emoji_usd": 5.0,
        "enabled": False,
    }


def cyber_project() -> dict:
    project = solana_project(config.CYBER_SOL_MINT, config.PUMPFUN_TOKEN_SYMBOL,
                             config.PUMPFUN_TOKEN_LABEL)
    project.update({
        "x": config.PROJECT_X_URL, "website": config.PROJECT_WEBSITE_URL,
        "telegram": config.TELEGRAM_CHAT_URL, "channel": config.TELEGRAM_CHANNEL_URL,
        "roadmap": config.PUMPFUN_ROADMAP_URL, "photo": config.PUMPFUN_PHOTO_URL,
        "trade": config.PUMPFUN_TRADE_URL, "chart": config.PUMPFUN_CHART_URL,
        "min_usd": config.PUMPFUN_MIN_BUY_USD, "emoji": config.PUMPFUN_BUY_EMOJI,
        "emoji_usd": config.PUMPFUN_EMOJI_USD, "cyber": True,
    })
    return project


def lain_project() -> dict:
    from bot import buybot
    return {
        "chain": "robinhood", "address": buybot.TOKEN, "symbol": "LAIN", "name": "LAIN",
        "x": config.LAIN_BUYBOT_X_URL, "website": "https://lain-os.com",
        "telegram": "", "channel": "", "roadmap": config.LAIN_BUYBOT_ROADMAP_URL,
        "photo": config.LAIN_BUYBOT_PHOTO_URL, "trade": config.LAIN_BUYBOT_PONS_URL,
        "chart": f"{buybot.EXPLORER}/token/{buybot.TOKEN}", "enabled": False,
    }


def matches_destination(chat, destination) -> bool:
    identity = {str(chat.id)}
    username = getattr(chat, "username", None)
    if username:
        identity.add("@" + username.lower())
    return bool(destination) and str(destination).lower() in identity


def is_cyber_chat(chat) -> bool:
    destinations = (
        config.CHAT_ID, config.BRIDGE_ANNOUNCE_CHAT, config.SWAP_ANNOUNCE_CHAT,
        config.LIQUIDITY_ANNOUNCE_CHAT, config.LENDING_ANNOUNCE_CHAT,
        config.CYBERSOL_SWAP_ANNOUNCE_CHAT, config.STAKING_ANNOUNCE_CHAT,
        config.PUMPFUN_ANNOUNCE_CHAT, config.DIGEST_ANNOUNCE_CHAT, config.WHALE_CHAT_ID,
    )
    return any(matches_destination(chat, value) for value in destinations)


def for_chat(chat) -> dict | None:
    if chat is None:
        return None
    project = saved(chat.id)
    if project is not None:
        return project
    lain_state = db._kv_get("lain_buybot_chat:" + str(chat.id))
    if lain_state in {"on", "off"}:
        return dict(lain_project(), enabled=lain_state == "on")
    if is_cyber_chat(chat):
        return dict(cyber_project(), enabled=matches_destination(chat, config.PUMPFUN_ANNOUNCE_CHAT))
    return None


def ca_reply(project: dict | None, lang: str = "en") -> str:
    if not project:
        return html.escape(_no_token()(lang))
    label = html.escape(project["symbol"])
    address = html.escape(project["address"])
    lines = [tr(lang, f"📜 Адрес контракта {label}:", f"📜 {label} contract address:")]
    if project.get("cyber"):
        if config.CYBER_CA_SOLANA:
            lines.append(f"Solana ({label}): <code>{html.escape(config.CYBER_CA_SOLANA)}</code>")
        if config.CYBER_CA_EVM:
            lines += [f"Cyberia EVM: <code>{html.escape(config.CYBER_CA_EVM)}</code>",
                      f"{config.EXPLORER_URL}/address/{html.escape(config.CYBER_CA_EVM)}"]
    else:
        network = "Solana" if project["chain"] == "solana" else "Robinhood Chain"
        explorer = "https://solscan.io/token" if project["chain"] == "solana" else "https://robin.etherscan.io/token"
        lines += [f"{network}: <code>{address}</code>", f"{explorer}/{address}"]
    return "\n".join(lines)


def x_reply(project: dict | None, lang: str = "en") -> str:
    if not project:
        return tr(lang, "Для этого чата не настроен проект.\n", "No project is configured for this chat.\n") + setup_hint(lang)
    lines = [f"{label}: {project[field]}" for label, field in (
        ("𝕏 (Twitter)", "x"), (tr(lang, "Канал", "Channel"), "channel"), (tr(lang, "Чат", "Chat"), "telegram")
    ) if project.get(field)]
    return "\n".join(lines) or tr(lang, "Ссылки на соцсети для этого чата не настроены.",
                                   "Social links are not configured for this chat.")


def _valid_mint(value: str) -> bool:
    alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    if not 32 <= len(value) <= 44 or any(char not in alphabet for char in value):
        return False
    number = 0
    for char in value:
        number = number * 58 + alphabet.index(char)
    return (number.bit_length() + 7) // 8 + len(value) - len(value.lstrip("1")) == 32


def _setting(project: dict, field: str, value: str) -> dict:
    if field not in FIELDS:
        settings = ", ".join(sorted(FIELDS))
        raise ValueError(T("Доступные настройки: " + settings, "Available settings: " + settings))
    if project["chain"] != "solana" and field in {"min_usd", "emoji", "emoji_usd", "symbol", "name"}:
        raise ValueError(T("Уведомления LAIN берут проверенные данные пула и минимум в ETH.",
                           "LAIN alerts use the verified pool identity and ETH minimum."))
    if field in URL_FIELDS:
        if value.lower() == "off":
            value = ""
        else:
            parsed = urlsplit(value)
            if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                    or re.search(r"[\s\x00-\x1f\x7f]", value) or len(value) > 256):
                raise ValueError(T("Нужна ссылка HTTPS или off, чтобы убрать её.",
                                   "Use an HTTPS URL, or off to remove the link."))
    elif field in {"min_usd", "emoji_usd"}:
        try:
            value = float(value)
        except ValueError:
            raise ValueError(T("Нужно конечное неотрицательное число.", "Use a finite nonnegative number.")) from None
        if not math.isfinite(value) or value < 0 or (field == "emoji_usd" and value == 0):
            raise ValueError(T("Нужно конечное неотрицательное число; emoji_usd — больше нуля.",
                               "Use a finite nonnegative number; emoji_usd must be positive."))
    else:
        limit = {"symbol": 16, "name": 64, "emoji": 8}[field]
        if not value or len(value) > limit or any(ord(char) < 32 for char in value):
            raise ValueError(T(f"{field}: от 1 до {limit} символов без переносов строк.",
                               f"{field} must contain 1–{limit} characters without line breaks."))
    return dict(project, **{field: value})


async def command(update, context):
    from bot import buybot, pumpfun
    chat, user, message = update.effective_chat, update.effective_user, update.effective_message
    if not chat or not user or not message:
        return
    lang = lang_of(update)
    if chat.type not in ("group", "supergroup"):
        await message.reply_text(tr(lang, "Уведомления о покупках настраиваются в той группе, к которой они относятся.\n",
                                    "Configure buy alerts inside the group they belong to.\n") + setup_hint(lang))
        return
    try:
        member = await context.bot.get_chat_member(chat.id, user.id)
    except TelegramError:
        await message.reply_text(tr(lang, "Не удалось проверить права администратора. Попробуйте ещё раз.",
                                    "Could not verify administrator permissions. Please try again."))
        return
    if member.status not in ("creator", "administrator"):
        await message.reply_text(tr(lang, "Настройки buybot меняют только администраторы группы.",
                                    "Only group administrators can change buybot settings."))
        return
    args = context.args
    action = args[0].lower() if args else "status"
    project = for_chat(chat)
    try:
        if action == "setup":
            preset = args[1].lower() if len(args) > 1 else ""
            if preset in {"lain", "cyber"} and len(args) == 2:
                project = lain_project() if preset == "lain" else cyber_project()
            elif preset == "solana" and len(args) >= 4 and _valid_mint(args[2]):
                project = solana_project(args[2], args[3], " ".join(args[4:]) or args[3])
                project = _setting(_setting(project, "symbol", project["symbol"]), "name", project["name"])
            else:
                raise ValueError(T(SETUP_HINT_RU, SETUP_HINT))
            save(chat.id, project)
            await message.reply_text(tr(
                lang,
                f"{project['symbol']} настроен для этой группы. Уведомления выключены.\n"
                "Ссылки: /buybot set x https://x.com/your_project\n"
                "Включить уведомления о новых покупках: /buybot on.",
                f"{project['symbol']} is configured for this group. Alerts are disabled.\n"
                "Set links with /buybot set x https://x.com/your_project\n"
                "Enable new-purchase alerts with /buybot on.",
            ))
            return
        if not project:
            raise ValueError(_no_token())
        if action == "set":
            if len(args) < 3:
                settings = ", ".join(sorted(FIELDS))
                raise ValueError(T("/buybot set <поле> <значение|off>\nНастройки: " + settings,
                                   "/buybot set <field> <value|off>\nSettings: " + settings))
            project = _setting(project, args[1].lower(), " ".join(args[2:]))
            save(chat.id, project)
            await message.reply_text(tr(lang, f"{args[1].lower()} обновлено для этой группы.",
                                        f"Updated {args[1].lower()} for this group."))
            return
        if action not in {"on", "off", "status", "reset", "preview"}:
            raise ValueError("/buybot setup · set · on · off · status · reset · preview")
        if project["chain"] == "robinhood":
            await buybot.command(update, context)
            if action in {"on", "off", "reset"}:
                save(chat.id, dict(project, enabled=db._kv_get(buybot.CHAT_PREFIX + str(chat.id)) == "on"))
            return
        if action == "preview":
            market = await asyncio.to_thread(pumpfun.market_snapshot, project["address"])
            if not market or not market.get("pool"):
                raise ValueError(T("Для этого токена пока нет пула PumpSwap в паре с SOL.",
                                   "No SOL-quoted PumpSwap pool is available for this token yet."))
            rows = await asyncio.to_thread(pumpfun._signatures, market["pool"], 20)
            for row in rows:
                tx = await asyncio.to_thread(pumpfun._get_transaction, row["signature"])
                buy = pumpfun.parse_buy(tx, market["pool"], project["address"]) if tx else None
                if buy:
                    await pumpfun.send_buy(context.bot, chat.id, buy,
                                           buy["sol_amount"] * market["sol_usd"], None,
                                           preview=True, project=project)
                    return
            raise ValueError(T("В последних 20 транзакциях пула не нашлось подтверждённой покупки.",
                               "No verified purchase was found in the latest 20 pool transactions."))
        if action == "reset" or (action == "on" and not project.get("enabled")):
            market = await asyncio.to_thread(pumpfun.market_snapshot, project["address"])
            if not market or not market.get("pool"):
                raise ValueError(T("Нет пула PumpSwap в паре с SOL. Настройки не изменены.",
                                   "No SOL-quoted PumpSwap pool is available. Settings were not changed."))
            cursor = await asyncio.to_thread(pumpfun.head_cursor, market["pool"])
            project = dict(project, enabled=True, epoch=uuid.uuid4().hex,
                           pool=market["pool"])
            db._set_block_cursor(pumpfun.project_cursor_key(chat.id, project), *cursor)
            save(chat.id, project)
        elif action == "off":
            project = dict(project, enabled=False)
            save(chat.id, project)
        details = ""
        if action == "status":
            details = "\n" + "\n".join(
                f"{field}: {project.get(field) or 'off'}"
                for field in sorted(FIELDS - {"symbol", "min_usd"})
            )
        enabled = project.get("enabled")
        await message.reply_text(tr(
            lang,
            f"{project['symbol']} buybot в этой группе: {'включён' if enabled else 'выключен'}.\n"
            f"Solana · {project['address']}\nМинимум: ${project['min_usd']:g}\n"
            "/buybot setup · set · on · off · status · reset · preview\n"
            "После включения объявляются только новые покупки.",
            f"{project['symbol']} buybot: {'enabled' if enabled else 'disabled'} in this group.\n"
            f"Solana · {project['address']}\nMinimum: ${project['min_usd']:g}\n"
            "/buybot setup · set · on · off · status · reset · preview\n"
            "Only new purchases are announced after enabling alerts.",
        ) + details)
    except ValueError as error:
        await message.reply_text(say(lang, error))
    except Exception:
        await message.reply_text(tr(lang, "Сеть или рыночные данные недоступны. Попробуйте позже.",
                                    "The chain or market feed is unavailable. Please try again later."))
