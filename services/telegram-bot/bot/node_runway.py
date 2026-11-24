"""How many days the Cyberia L1 validators have left.

An Avalanche L1 validator pays the P-Chain by the second out of its own AVAX
balance and stops validating when that balance reaches zero; with a single
validator, the chain stops with it. Nothing on the chain warns anyone — the
Fuji L1 halted that way on 2026-11-01 — so once a day this posts, for each L1
in NODE_RUNWAY_L1S, how long its validators last at the P-Chain's current fee.
Anyone with AVAX can top a validator up; the post links to where.

Reads public P-Chain APIs only. It cannot sign, spend or top up.
"""
import asyncio
import html
import json
import logging
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal

from telegram.error import TelegramError

from bot.config import (
    NODE_RUNWAY_CHAT, NODE_RUNWAY_HOUR_UTC, NODE_RUNWAY_L1S, NODE_RUNWAY_TOPUP_URL,
)
from bot.db import _kv_get, _kv_set

logger = logging.getLogger(__name__)

P_CHAIN = {
    "mainnet": "https://api.avax.network/ext/bc/P",
    "fuji": "https://api.avax-test.network/ext/bc/P",
}
NAVAX = Decimal(10**9)
DAY = 86400
# Under a week left, the line is flagged: a top-up has to be bought, moved to
# the P-Chain and sent, which is not always done the same day.
WARN_DAYS = 7
POSTED_KEY = "node_runway:posted"
TICK_SECONDS = 600


def parse_l1s(raw: str) -> list[dict]:
    """NODE_RUNWAY_L1S — "network:subnetID:name" entries separated by commas."""
    l1s = []
    for entry in (raw or "").split(","):
        parts = [part.strip() for part in entry.split(":", 2)]
        if len(parts) != 3 or parts[0] not in P_CHAIN or not parts[1] or not parts[2]:
            if entry.strip():
                logger.warning("node_runway: skipping %r, expected network:subnetID:name", entry)
            continue
        l1s.append({"network": parts[0], "subnet": parts[1], "name": parts[2]})
    return l1s


def _p_chain(network: str, method: str, params: dict) -> dict:
    """One blocking P-Chain call. Call through asyncio.to_thread."""
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    request = urllib.request.Request(
        P_CHAIN[network], data=body, headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        answer = json.loads(response.read().decode())
    if answer.get("error"):
        raise RuntimeError(f"{method}: {answer['error'].get('message')}")
    return answer["result"]


def read_runway(l1: dict) -> dict | None:
    """The L1's validators with their balances and the fee they pay, or None
    while the subnet is not an L1 yet (it has no L1 validators to pay)."""
    validators = _p_chain(
        l1["network"], "platform.getCurrentValidators", {"subnetID": l1["subnet"]}
    ).get("validators") or []
    # Only L1 validators carry a validationID and a balance; a subnet that was
    # never converted lists none of them.
    paying = [v for v in validators if v.get("validationID") and "balance" in v]
    if not paying:
        return None
    price = int(_p_chain(l1["network"], "platform.getValidatorFeeState", {})["price"])
    return {
        **l1,
        "price": price,
        "balances": sorted(int(v["balance"]) for v in paying),
    }


def days_left(balance_navax: int, price_navax_per_second: int) -> Decimal:
    if price_navax_per_second <= 0:
        raise ValueError("the P-Chain fee is not positive")
    return Decimal(balance_navax) / price_navax_per_second / DAY


def _days(days: Decimal) -> str:
    return f"{days:.1f}" if days < 10 else f"{days:.0f}"


def _avax(navax: int | Decimal) -> str:
    return f"{Decimal(navax) / NAVAX:.3f}"


def format_post(runways: list[dict], topup_url: str = NODE_RUNWAY_TOPUP_URL) -> str:
    """The daily post, in HTML. One block per L1, its soonest-stopping validator first."""
    blocks = ["🔋 <b>Cyberia validators: days left</b>"]
    for runway in runways:
        name = html.escape(runway["name"])
        lowest = runway["balances"][0]
        per_day = runway["price"] * DAY
        count = len(runway["balances"])
        if lowest <= 0:
            blocks.append(f"🛑 {name}: <b>stopped</b> — a validator's balance is empty")
            continue
        days = days_left(lowest, runway["price"])
        mark = "⚠️ " if days < WARN_DAYS else ""
        who = "" if count == 1 else f" (the first of {count} validators)"
        blocks.append(
            f"{mark}{name}: <b>{_days(days)} days</b>{who}\n"
            f"{_avax(lowest)} AVAX on the P-Chain, {_avax(per_day)} AVAX a day"
        )
    if topup_url:
        blocks.append(
            f'Anyone can top up a validator with AVAX: <a href="{html.escape(topup_url)}">L1 validator balance</a>'
        )
    return "\n\n".join(blocks)


async def tick(bot, now: datetime | None = None) -> bool:
    """Post today's runway once the hour comes. True when a post went out."""
    now = now or datetime.now(timezone.utc)
    today = now.strftime("%Y-%m-%d")
    if now.hour < NODE_RUNWAY_HOUR_UTC or _kv_get(POSTED_KEY) == today:
        return False
    runways = []
    for l1 in parse_l1s(NODE_RUNWAY_L1S):
        # An unreadable P-Chain defers the whole post to the next tick: a post
        # that silently leaves a chain out reads as "that one is fine".
        runway = await asyncio.to_thread(read_runway, l1)
        if runway:
            runways.append(runway)
    if runways:
        await bot.send_message(
            NODE_RUNWAY_CHAT, format_post(runways),
            parse_mode="HTML", disable_web_page_preview=True,
        )
    _kv_set(POSTED_KEY, today)
    return bool(runways)


async def loop(application) -> None:
    if not NODE_RUNWAY_CHAT or not parse_l1s(NODE_RUNWAY_L1S):
        logger.info("Node runway disabled: NODE_RUNWAY_CHAT or NODE_RUNWAY_L1S empty")
        return
    logger.info(
        "Node runway started: chat=%s at %02d:00 UTC for %s",
        NODE_RUNWAY_CHAT, NODE_RUNWAY_HOUR_UTC,
        ", ".join(l1["name"] for l1 in parse_l1s(NODE_RUNWAY_L1S)),
    )
    while True:
        try:
            await tick(application.bot)
        except (OSError, RuntimeError, ValueError, KeyError, TelegramError) as e:
            logger.error("node_runway: %s", e)
        await asyncio.sleep(TICK_SECONDS)
