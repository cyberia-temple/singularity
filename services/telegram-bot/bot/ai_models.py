"""The model pool behind the assistant, and a way for a user to pick from it.

`openrouter/free` is not a model. It is a *router* over whatever free models
are up right now — the pool changes week to week, the answer changes request to
request, and "which model am I talking to" has no fixed answer. That is fine as
a default and useless as the only option: a reasoning model that spends its
budget on thought returns an empty reply, a 20B model is faster than a 400B one
for a two-line question, and the person asking is the only one who knows which
trade-off they want.

So the pool is read from the provider's own catalogue (`GET {base}/models`,
which every OpenAI-compatible provider serves) rather than pinned in code — a
list written down here would be wrong within a month. Free is a *price*, not a
name: an entry counts as free when the catalogue prices both its prompt and its
completion at zero. A provider that publishes no prices at all (Cyberia's own
gateway is holder-gated, not billed per token) is offered whole, because
"nothing here is priced" is not the same statement as "nothing here is free".

A choice is per user and survives a restart (`bot_kv`, key `ai_model:<id>`),
because it is a preference and not a session. `auto` is always offered and is
always what an unset user gets.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass
from typing import Any

import httpx
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import ContextTypes

from bot.config import (
    AI_API_KEY,
    AI_API_URL,
    AI_MODEL,
    AI_MODELS_CACHE_SECONDS,
    AI_MODELS_PAGE_SIZE,
    AI_MODELS_URL,
    AI_PROXY_URL,
    AI_TIMEOUT_SECONDS,
)
from bot.db import _kv_get, _kv_set

logger = logging.getLogger(__name__)

# Callback data is capped at 64 bytes by Telegram and a model id can be long,
# so a button carries a digest of the id and never the id itself.
CALLBACK_PREFIX = "aim"
AUTO = "auto"
_KV_PREFIX = "ai_model:"


@dataclass(frozen=True)
class ModelChoice:
    """One selectable model, as the provider's catalogue describes it."""

    id: str
    label: str
    context: int | None
    free: bool


@dataclass(frozen=True)
class Catalogue:
    """What the provider offers, and whether it publishes prices at all."""

    models: tuple[ModelChoice, ...]
    priced: bool

    def selectable(self) -> list[ModelChoice]:
        """What /model offers: the free half of a priced catalogue, or all of
        an unpriced one. An empty result means the provider answered but has
        nothing free — a fact worth stating rather than an empty list.

        The configured default is left out on purpose: it is the 🎲 button, and
        a router listed twice invites picking "auto" and thinking it is a
        model.
        """
        pool = list(self.models) if not self.priced else [m for m in self.models if m.free]
        return [m for m in pool if m.id != AI_MODEL]


def catalogue_url(api_url: str, override: str = "") -> str:
    """Where the model list lives, derived from the completions endpoint.

    Every OpenAI-compatible provider serves `{base}/models` next to
    `{base}/chat/completions`, so one configured URL answers both questions.
    """
    if override:
        return override
    url = (api_url or "").strip()
    if not url:
        return ""
    for suffix in ("/chat/completions", "/completions", "/responses"):
        if url.endswith(suffix):
            return url[: -len(suffix)] + "/models"
    return url.rstrip("/") + "/models"


def model_token(model_id: str) -> str:
    """Stable short handle for a model id, small enough for callback data."""
    return hashlib.sha256(model_id.encode("utf-8")).hexdigest()[:12]


def _price(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _label_for(entry: dict[str, Any], model_id: str) -> str:
    name = str(entry.get("name") or "").strip() or model_id
    # "DeepSeek: R1 (free)" already says free; the list says it once at the top.
    for tail in (" (free)", " (Free)"):
        if name.endswith(tail):
            name = name[: -len(tail)]
    return name.strip() or model_id


def parse_catalogue(payload: Any) -> Catalogue:
    """Read an OpenAI-compatible `/models` body into selectable choices."""
    rows = []
    if isinstance(payload, dict):
        data = payload.get("data")
        if isinstance(data, list):
            rows = data
    elif isinstance(payload, list):
        rows = payload

    models: list[ModelChoice] = []
    priced = False
    seen: set[str] = set()
    for entry in rows:
        if not isinstance(entry, dict):
            continue
        model_id = str(entry.get("id") or "").strip()
        if not model_id or model_id in seen:
            continue
        # The free pool is not only chat models: a music model and an image
        # model are priced at zero too, and neither can answer a question. A
        # model qualifies when text is the whole of what it emits.
        architecture = entry.get("architecture")
        if isinstance(architecture, dict):
            outputs = architecture.get("output_modalities")
            if isinstance(outputs, list) and outputs and set(outputs) != {"text"}:
                continue
        seen.add(model_id)
        pricing = entry.get("pricing")
        free = False
        if isinstance(pricing, dict):
            prompt = _price(pricing.get("prompt"))
            completion = _price(pricing.get("completion"))
            if prompt is not None and completion is not None:
                priced = True
                free = prompt == 0.0 and completion == 0.0
        context = entry.get("context_length")
        top = entry.get("top_provider")
        if not context and isinstance(top, dict):
            context = top.get("context_length")
        try:
            context_len = int(context) if context else None
        except (TypeError, ValueError):
            context_len = None
        models.append(
            ModelChoice(
                id=model_id,
                label=_label_for(entry, model_id),
                context=context_len,
                free=free,
            )
        )
    models.sort(key=lambda m: m.label.lower())
    return Catalogue(models=tuple(models), priced=priced)


def format_context(tokens: int | None) -> str:
    """164000 → "164k". Context is the one number that changes what you can ask."""
    if not tokens or tokens <= 0:
        return ""
    if tokens >= 1_000_000:
        value = tokens / 1_000_000
        return f"{value:.1f}".rstrip("0").rstrip(".") + "M"
    if tokens >= 1_000:
        return f"{tokens // 1000}k"
    return str(tokens)


def page_slice(items: list[ModelChoice], page: int, size: int) -> tuple[list[ModelChoice], int, int]:
    """One page of the list, clamped: `page` out of range lands on a real page
    rather than on an empty keyboard."""
    size = max(1, size)
    pages = max(1, (len(items) + size - 1) // size)
    page = max(0, min(page, pages - 1))
    return items[page * size : (page + 1) * size], page, pages


# --------------------------------------------------------------- the choice

def selected_model(user_id: int) -> str | None:
    """The model this user pinned, or None for the router."""
    try:
        value = (_kv_get(f"{_KV_PREFIX}{user_id}") or "").strip()
    except Exception as exc:  # a broken read must not cost the answer
        logger.warning(f"model preference unreadable for {user_id}: {exc}")
        return None
    return value or None


def set_selected_model(user_id: int, model_id: str | None) -> None:
    _kv_set(f"{_KV_PREFIX}{user_id}", (model_id or "").strip())


def model_for(user_id: int | None) -> str:
    """What to actually send as `model`."""
    chosen = selected_model(user_id) if user_id is not None else None
    return chosen or AI_MODEL


def served_note(requested: str, served: str) -> str:
    """One line naming who actually answered, when that is not who was asked.

    On the router this is the only place the pool becomes visible: the id we
    send is `openrouter/free` and a different model answers every time. When
    the two agree there is nothing to say, and the answer stays clean.
    """
    served = (served or "").strip()
    if not served or served.lower() == (requested or "").strip().lower():
        return ""
    return f"\n\n— ответила {served}"


# ------------------------------------------------------------- the catalogue

_cache: dict[str, Any] = {"at": 0.0, "catalogue": None, "error": ""}
_cache_lock = asyncio.Lock()


async def fetch_catalogue(force: bool = False) -> tuple[Catalogue | None, str]:
    """The provider's catalogue, cached. Returns (catalogue, error message)."""
    url = catalogue_url(AI_API_URL, AI_MODELS_URL)
    if not url:
        return None, "не задан AI_API_URL"

    async with _cache_lock:
        fresh = time.monotonic() - float(_cache["at"]) < AI_MODELS_CACHE_SECONDS
        if not force and fresh and _cache["catalogue"] is not None:
            return _cache["catalogue"], ""

        headers = {"Accept": "application/json"}
        if AI_API_KEY:
            headers["Authorization"] = f"Bearer {AI_API_KEY}"
        try:
            client_args: dict[str, Any] = {"timeout": AI_TIMEOUT_SECONDS}
            if AI_PROXY_URL:
                client_args["proxy"] = AI_PROXY_URL
            async with httpx.AsyncClient(**client_args) as client:
                response = await client.get(url, headers=headers)
            response.raise_for_status()
            catalogue = parse_catalogue(response.json())
        except (httpx.HTTPError, ValueError, TypeError) as exc:
            logger.warning(f"model catalogue unreadable at {url}: {exc}")
            # A stale list beats no list: the pool moves slowly enough that
            # yesterday's answer is still a better menu than an error.
            if _cache["catalogue"] is not None:
                return _cache["catalogue"], "список моделей сейчас не читается — показываю прошлый"
            return None, "провайдер не отдал список моделей"

        _cache["at"] = time.monotonic()
        _cache["catalogue"] = catalogue
        return catalogue, ""


# ------------------------------------------------------------------- the UI

def _button_label(choice: ModelChoice, current: str | None) -> str:
    context = format_context(choice.context)
    mark = "✅ " if current == choice.id else ""
    label = choice.label if len(choice.label) <= 38 else choice.label[:37] + "…"
    return f"{mark}{label}" + (f" · {context}" if context else "")


def build_keyboard(
    items: list[ModelChoice], page: int, pages: int, current: str | None
) -> InlineKeyboardMarkup:
    rows = [
        [
            InlineKeyboardButton(
                _button_label(choice, current),
                callback_data=f"{CALLBACK_PREFIX}|s|{model_token(choice.id)}",
            )
        ]
        for choice in items
    ]
    if pages > 1:
        rows.append(
            [
                InlineKeyboardButton("◀", callback_data=f"{CALLBACK_PREFIX}|p|{page - 1}"),
                InlineKeyboardButton(f"{page + 1}/{pages}", callback_data=f"{CALLBACK_PREFIX}|p|{page}"),
                InlineKeyboardButton("▶", callback_data=f"{CALLBACK_PREFIX}|p|{page + 1}"),
            ]
        )
    auto_mark = "✅ " if not current else ""
    rows.append(
        [InlineKeyboardButton(f"{auto_mark}🎲 авто (весь пул)", callback_data=f"{CALLBACK_PREFIX}|a")]
    )
    return InlineKeyboardMarkup(rows)


def pool_text(
    catalogue: Catalogue,
    current: str | None,
    warning: str = "",
    served: str | None = None,
) -> str:
    """The message above the keyboard: what you are talking to, and what the
    pool actually is."""
    selectable = catalogue.selectable()
    if current:
        match = next((m for m in selectable if m.id == current), None)
        now = f"{match.label} (`{current}`)" if match else f"`{current}`"
        line = f"Сейчас отвечает: {now}"
    else:
        line = (
            f"Сейчас отвечает: 🎲 авто — `{AI_MODEL}`.\n"
            "Это не одна модель, а роутер: на каждый вопрос отвечает та из "
            "бесплатных, что сейчас поднята."
        )
    if served and not current:
        line += f"\nПоследний ответ дала: `{served}`"

    if catalogue.priced:
        what = f"Бесплатных моделей в пуле сейчас: {len(selectable)}."
    else:
        what = f"Провайдер не публикует цены — доступно моделей: {len(selectable)}."

    tail = "Выбери модель кнопкой — выбор запомнится. `/model auto` вернёт роутер."
    return "\n\n".join(part for part in (line, what, warning, tail) if part)


async def model_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """/model — show the pool and let the user pin one of it."""
    message = update.effective_message
    user = update.effective_user
    if message is None or user is None:
        return

    argument = " ".join(context.args or []).strip()
    catalogue, warning = await fetch_catalogue()
    if catalogue is None:
        await message.reply_text(
            f"Не могу прочитать список моделей: {warning}.\n"
            f"Сейчас отвечает: {model_for(user.id)}"
        )
        return
    selectable = catalogue.selectable()

    if argument:
        if argument.lower() in {AUTO, "авто", "reset", "сброс"}:
            set_selected_model(user.id, None)
            await message.reply_text(
                f"Готово: отвечает 🎲 авто — `{AI_MODEL}` (весь бесплатный пул).",
                parse_mode="Markdown",
            )
            return
        needle = argument.lower()
        exact = next((m for m in selectable if m.id.lower() == needle), None)
        matches = [m for m in selectable if needle in m.id.lower() or needle in m.label.lower()]
        picked = exact or (matches[0] if len(matches) == 1 else None)
        if picked is None:
            if not matches:
                await message.reply_text(
                    f"Такой модели в бесплатном пуле нет: {argument}. Открой /model без аргументов."
                )
            else:
                names = "\n".join(f"• `{m.id}`" for m in matches[:10])
                await message.reply_text(
                    f"Под «{argument}» подходит несколько:\n{names}",
                    parse_mode="Markdown",
                )
            return
        set_selected_model(user.id, picked.id)
        await message.reply_text(
            f"Готово: отвечает {picked.label} — `{picked.id}`.", parse_mode="Markdown"
        )
        return

    if not selectable:
        await message.reply_text(
            "Провайдер сейчас не отдаёт ни одной бесплатной модели.\n"
            f"Сейчас отвечает: `{model_for(user.id)}`",
            parse_mode="Markdown",
        )
        return

    current = selected_model(user.id)
    items, page, pages = page_slice(selectable, 0, AI_MODELS_PAGE_SIZE)
    await message.reply_text(
        pool_text(catalogue, current, warning, context.user_data.get("ai_served")),
        reply_markup=build_keyboard(items, page, pages, current),
        parse_mode="Markdown",
        disable_web_page_preview=True,
    )


async def model_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """Paging and picking from the /model keyboard."""
    query = update.callback_query
    user = update.effective_user
    if query is None or user is None:
        return
    data = (query.data or "").split("|")
    if not data or data[0] != CALLBACK_PREFIX:
        return

    catalogue, warning = await fetch_catalogue()
    if catalogue is None:
        await query.answer("список моделей сейчас не читается", show_alert=True)
        return
    selectable = catalogue.selectable()
    action = data[1] if len(data) > 1 else ""

    if action == "a":
        set_selected_model(user.id, None)
        await query.answer("авто: весь бесплатный пул")
    elif action == "s" and len(data) > 2:
        token = data[2]
        picked = next((m for m in selectable if model_token(m.id) == token), None)
        if picked is None:
            # The pool moved under the keyboard — say so instead of pinning
            # whatever now sits at that position.
            await query.answer("список обновился, открой /model заново", show_alert=True)
            return
        set_selected_model(user.id, picked.id)
        await query.answer(f"выбрано: {picked.label}")
    elif action == "p" and len(data) > 2:
        await query.answer()
    else:
        await query.answer()
        return

    try:
        page = int(data[2]) if action == "p" and len(data) > 2 else 0
    except ValueError:
        page = 0
    if action != "p":
        current_id = selected_model(user.id)
        index = next((i for i, m in enumerate(selectable) if m.id == current_id), 0)
        page = index // max(1, AI_MODELS_PAGE_SIZE)

    current = selected_model(user.id)
    items, page, pages = page_slice(selectable, page, AI_MODELS_PAGE_SIZE)
    try:
        await query.edit_message_text(
            pool_text(catalogue, current, warning, context.user_data.get("ai_served")),
            reply_markup=build_keyboard(items, page, pages, current),
            parse_mode="Markdown",
            disable_web_page_preview=True,
        )
    except Exception as exc:  # editing into identical text is an error, not a problem
        logger.debug(f"model keyboard not edited: {exc}")
