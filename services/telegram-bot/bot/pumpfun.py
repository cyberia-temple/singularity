"""pump.fun buy bot: spot CYBER.sol buys on the pump.fun pool, format the post.

CYBER.sol has graduated off the pump.fun bonding curve, so a live "buy on
pump.fun" settles on the PumpSwap AMM pool the coin's pump.fun page trades
against. Nothing here decodes pump.fun (or Jupiter, or any router) instruction
layouts. A buy is read off the transaction's *balance deltas* for the two token
accounts the pool owns: the coin side leaving the pool while the SOL side comes
in. That is why a buy routed through an aggregator or an arbitrage bot is
reported exactly like one made on pump.fun itself, and why a liquidity deposit —
both sides moving in — is never mistaken for one.

SOL/USD and (unless pinned) the pool address come from the DexScreener pair
feed. A price that cannot be read is None, never 0: the caller holds its cursor
and retries rather than announcing a buy it cannot size.

Market cap is *not* taken from that feed. DexScreener quotes the last trade's
average fill, which for a buy always sits below the price that same trade ended
at, while the pump.fun page the post links to quotes the pool's reserves. So
the cap is computed here from the reserves the announced buy left behind — see
market_cap_after().
"""
import html
import json
import logging
import time
import urllib.request

from bot.config import (
    SOLSCAN_URL, CYBER_SOL_MINT,
    DEXSCREENER_API_URL,
    PUMPFUN_RPC_TIMEOUT, PUMPFUN_SIG_LIMIT, PUMPFUN_MAX_PAGES,
    PUMPFUN_MARKET_TTL_SECONDS, PUMPFUN_SUPPLY_TTL_SECONDS,
    PUMPFUN_TOKEN_LABEL, PUMPFUN_TOKEN_SYMBOL, PUMPFUN_TOKEN_URL,
    PUMPFUN_BUY_EMOJI, PUMPFUN_EMOJI_USD, PUMPFUN_EMOJI_MAX,
    PUMPFUN_MIN_POSITION_PCT, PUMPFUN_CHART_URL, PUMPFUN_TRADE_URL,
)
from bot.solana import solana_rpc
from bot.utils import _short_addr

logger = logging.getLogger(__name__)

# Every PumpSwap pool quotes in wrapped SOL, held in a token account the pool
# itself owns — the same account whose delta gives the SOL side of a trade.
WSOL_MINT = "So11111111111111111111111111111111111111112"
SOL_DECIMALS = 9

# Last good market snapshot. Kept across ticks so a DexScreener blip prices the
# next buy off a slightly stale quote instead of dropping it.
_market_cache: dict | None = None
_market_fetched_at: float = 0.0

# mint -> (supply, monotonic time it was read). A supply only moves when
# somebody burns, so this is read rarely and the last answer outlives a blip.
_supply_cache: dict[str, tuple[float, float]] = {}


# DexScreener answers 403 to urllib's default agent, so the bot names itself.
_MARKET_UA = "Mozilla/5.0 (compatible; CyberiaBot/1.0; +https://cyberia.church)"


def _http_json(url: str, timeout: float = 15.0):
    req = urllib.request.Request(
        url, headers={"Accept": "application/json", "User-Agent": _MARKET_UA}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _rpc(method: str, params: list):
    """One blocking Solana JSON-RPC call, across the endpoint chain in
    bot.solana. Call through asyncio.to_thread."""
    return solana_rpc(method, params, PUMPFUN_RPC_TIMEOUT)


def _as_float(value) -> float | None:
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out and out not in (float("inf"), float("-inf")) else None


# --- market feed --------------------------------------------------------------
def market_snapshot(mint: str = CYBER_SOL_MINT) -> dict | None:
    """{pool, sol_usd, price_usd, market_cap} for the deepest SOL-quoted pair,
    or the last good snapshot when the feed is unreadable, or None if we have
    never read one. Cached for PUMPFUN_MARKET_TTL_SECONDS. Blocking.

    `market_cap` is the feed's own figure and is only a fallback: it lags a
    buy by that buy's own price impact. market_cap_after() is the number the
    post prints."""
    global _market_cache, _market_fetched_at

    now = time.monotonic()
    if _market_cache and now - _market_fetched_at < PUMPFUN_MARKET_TTL_SECONDS:
        return _market_cache

    try:
        data = _http_json(f"{DEXSCREENER_API_URL}/latest/dex/tokens/{mint}")
    except Exception as e:
        logger.warning(f"pumpfun: market feed unreadable ({e}); keeping last snapshot")
        return _market_cache

    best_liq, best = -1.0, None
    for pair in (data.get("pairs") or []):
        if (pair.get("chainId") or "") != "solana":
            continue
        if ((pair.get("baseToken") or {}).get("address") or "") != mint:
            continue
        if ((pair.get("quoteToken") or {}).get("address") or "") != WSOL_MINT:
            continue
        liq = _as_float((pair.get("liquidity") or {}).get("usd")) or 0.0
        if liq > best_liq:
            best_liq, best = liq, pair

    if best is None:
        logger.warning(f"pumpfun: no SOL-quoted pair for {mint} in the market feed")
        return _market_cache

    # SOL/USD is the pair's own two quotes divided out — the same trade priced
    # in USD and in SOL — so the buy is sized against the venue it happened on.
    price_usd = _as_float(best.get("priceUsd"))
    price_native = _as_float(best.get("priceNative"))
    if not price_usd or not price_native:
        logger.warning("pumpfun: market feed carries no usable price; keeping last snapshot")
        return _market_cache

    _market_cache = {
        "pool": best.get("pairAddress"),
        "sol_usd": price_usd / price_native,
        "price_usd": price_usd,
        "market_cap": _as_float(best.get("marketCap")),
    }
    _market_fetched_at = now
    return _market_cache


# --- chain scan ---------------------------------------------------------------
def _cursor_of(row: dict) -> tuple[int, int]:
    """(slot, index-in-block) — the pair that totally orders the pool's txs."""
    return int(row.get("slot") or 0), int(row.get("transactionIndex") or 0)


def _signatures(pool: str, limit: int, before: str | None = None) -> list[dict]:
    opts: dict = {"limit": limit, "commitment": "confirmed"}
    if before:
        opts["before"] = before
    return _rpc("getSignaturesForAddress", [pool, opts]) or []


# The newest transaction format the parser is asked to read. Wallets started
# signing version 1 in October 2026, and a request capped below it is refused
# outright (-32015) — and since collect_buys() holds its cursor on a fetch it
# could not make, one such buy wedged every buy behind it until this was raised.
# The parser reads only balances, which every version reports the same way.
MAX_TX_VERSION = 1


def _get_transaction(signature: str) -> dict | None:
    return _rpc("getTransaction", [signature, {
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": MAX_TX_VERSION,
        "commitment": "confirmed",
    }])


def head_cursor(pool: str) -> tuple[int, int]:
    """Cursor at the pool's newest transaction — the bootstrap position, so a
    fresh install starts with the next buy instead of replaying history."""
    rows = _signatures(pool, 1)
    return _cursor_of(rows[0]) if rows else (0, 0)


def _token_balances(entries) -> dict[int, dict]:
    out: dict[int, dict] = {}
    for entry in entries or []:
        amount = (entry.get("uiTokenAmount") or {}).get("amount")
        out[int(entry["accountIndex"])] = {
            "owner": entry.get("owner"),
            "mint": entry.get("mint"),
            "amount": int(amount or 0),
            "decimals": int((entry.get("uiTokenAmount") or {}).get("decimals") or 0),
        }
    return out


def parse_buy(tx: dict, pool: str, mint: str) -> dict | None:
    """A buy from `pool`, or None when the transaction is anything else.

    Pure: takes a jsonParsed getTransaction result and reads only its balances.
    """
    meta = (tx or {}).get("meta") or {}
    if meta.get("err") is not None:
        return None

    message = ((tx or {}).get("transaction") or {}).get("message") or {}
    keys = [
        key.get("pubkey") if isinstance(key, dict) else key
        for key in (message.get("accountKeys") or [])
    ]
    pre = _token_balances(meta.get("preTokenBalances"))
    post = _token_balances(meta.get("postTokenBalances"))

    coin_delta = 0
    sol_delta = 0
    coin_after = 0
    sol_after = 0
    decimals = None
    for index in set(pre) | set(post):
        account = post.get(index) or pre[index]
        if account["owner"] != pool:
            continue
        held = post.get(index, {}).get("amount", 0)
        moved = held - pre.get(index, {}).get("amount", 0)
        if account["mint"] == mint:
            coin_delta += moved
            coin_after += held
            decimals = account["decimals"]
        elif account["mint"] == WSOL_MINT:
            sol_delta += moved
            sol_after += held

    # Coin out of the pool and SOL into it. A sell reverses both; a liquidity
    # deposit or withdrawal moves both the same way.
    if coin_delta >= 0 or sol_delta <= 0 or decimals is None:
        return None

    # The buyer is whoever the coin actually landed with, which stays right when
    # an aggregator signs for someone else. An in-and-out arbitrage nets to no
    # gain — then the fee payer is the closest thing to a trader we have.
    buyer, gained = None, 0
    for index in set(pre) | set(post):
        account = post.get(index) or pre[index]
        if account["mint"] != mint or account["owner"] == pool:
            continue
        moved = post.get(index, {}).get("amount", 0) - pre.get(index, {}).get("amount", 0)
        if moved > gained:
            buyer, gained = account["owner"], moved
    if buyer is None:
        buyer = keys[0] if keys else None

    # The whole bag either side of the trade, across every account the buyer
    # holds this coin in — how much a position that already existed grew by.
    held_before = held_after = 0
    for index in set(pre) | set(post):
        account = post.get(index) or pre[index]
        if account["mint"] != mint or account["owner"] != buyer:
            continue
        held_before += pre.get(index, {}).get("amount", 0)
        held_after += post.get(index, {}).get("amount", 0)
    grew = held_after - held_before

    signatures = ((tx or {}).get("transaction") or {}).get("signatures") or []
    return {
        "signature": signatures[0] if signatures else None,
        "buyer": buyer,
        "token_amount": -coin_delta / 10 ** decimals,
        "token_decimals": decimals,
        "sol_amount": sol_delta / 10 ** SOL_DECIMALS,
        # The pool as this trade left it, which is the price the coin is
        # quoted at from here on. See market_cap_after().
        "pool_coin": coin_after / 10 ** decimals,
        "pool_sol": sol_after / 10 ** SOL_DECIMALS,
        # Nothing of this coin before the trade, and it did land with them.
        "new_holder": gained > 0 and held_before == 0,
        # Growth of an existing bag, in percent. None when there was nothing to
        # grow (a new holder) or nothing stayed (an arbitrage passing through).
        "position_pct": grew / held_before * 100 if held_before > 0 and grew > 0 else None,
        "slot": int((tx or {}).get("slot") or 0),
        "tx_index": 0,
        "block_time": (tx or {}).get("blockTime"),
    }


def collect_buys(pool: str, mint: str, after: tuple[int, int]) -> tuple[list[dict], tuple[int, int]]:
    """Buys newer than `after`, oldest first, plus the cursor they were read up
    to. A transaction we cannot fetch stops the scan there, so it is retried on
    the next tick instead of being skipped. Blocking."""
    rows: list[dict] = []
    before = None
    for _ in range(PUMPFUN_MAX_PAGES):
        page = _signatures(pool, PUMPFUN_SIG_LIMIT, before)
        if not page:
            break
        rows.extend(page)
        if _cursor_of(page[-1]) <= after or len(page) < PUMPFUN_SIG_LIMIT:
            break
        before = page[-1].get("signature")

    fresh = sorted((row for row in rows if _cursor_of(row) > after), key=_cursor_of)

    buys: list[dict] = []
    scanned = after
    for row in fresh:
        cursor = _cursor_of(row)
        if row.get("err") is None:
            try:
                tx = _get_transaction(row["signature"])
            except Exception as e:
                logger.warning(f"pumpfun: getTransaction {row.get('signature')} failed: {e}")
                break
            buy = parse_buy(tx, pool, mint) if tx else None
            if buy:
                buy["slot"], buy["tx_index"] = cursor
                buys.append(buy)
        scanned = cursor
    return buys, scanned


def token_supply(mint: str = CYBER_SOL_MINT) -> float | None:
    """The mint's supply, from the chain. Cached for PUMPFUN_SUPPLY_TTL_SECONDS
    and the last good answer is kept through an RPC blip — a supply moves only
    when somebody burns, so a stale one is off by a burn and a missing one
    costs the post its market cap entirely. Blocking."""
    cached = _supply_cache.get(mint)
    now = time.monotonic()
    if cached and now - cached[1] < PUMPFUN_SUPPLY_TTL_SECONDS:
        return cached[0]

    try:
        value = (_rpc("getTokenSupply", [mint]) or {}).get("value") or {}
        supply = int(value["amount"]) / 10 ** int(value.get("decimals") or 0)
    except Exception as e:
        logger.warning(f"pumpfun: supply of {mint} unreadable ({e}); keeping last answer")
        return cached[0] if cached else None

    if supply <= 0:
        logger.warning(f"pumpfun: supply of {mint} read as {supply}; keeping last answer")
        return cached[0] if cached else None

    _supply_cache[mint] = (supply, now)
    return supply


def market_cap_after(buy: dict, sol_usd: float | None, supply: float | None) -> float | None:
    """The coin's market cap at the price this buy left the pool at, or None
    when any of the three numbers is missing.

    The pump.fun page a post links to prices the coin off the pool's reserves —
    spot, now — while DexScreener's `marketCap` is the last trade's *average
    fill*, which for a buy always sits below the price that trade ended at.
    Announcing a buy is precisely the moment the two disagree most: a 6.94 SOL
    buy into an 88 SOL pool ended at $43.1k on the page while the feed still
    said $39.9k, and the bigger the buy the wider that gap. Reading the
    reserves the trade itself left behind costs no extra call — they are in the
    balances the buy was parsed out of — and it makes each buy in a batch carry
    its own cap instead of all of them sharing one cached figure.
    """
    coin = _as_float(buy.get("pool_coin"))
    sol = _as_float(buy.get("pool_sol"))
    usd = _as_float(sol_usd)
    units = _as_float(supply)
    if not coin or not sol or not usd or not units:
        return None
    return sol / coin * units * usd


# --- post ---------------------------------------------------------------------
def _fmt_grouped(value: float, places: int) -> str:
    """Thousands separated by spaces, as the buy-bot format writes them."""
    return f"{value:,.{places}f}".replace(",", " ")


def _fmt_usd(value: float) -> str:
    return f"${_fmt_grouped(value, 2)}"


def _emoji_row(usd: float | None) -> str:
    """One emoji per PUMPFUN_EMOJI_USD of the buy: the row's length is the size."""
    steps = 1 if not usd or PUMPFUN_EMOJI_USD <= 0 else round(usd / PUMPFUN_EMOJI_USD)
    return PUMPFUN_BUY_EMOJI * max(1, min(int(steps), PUMPFUN_EMOJI_MAX))


def _position_line(buy: dict) -> str | None:
    """What this buy did to the buyer's bag: opened it, or grew it by so much.
    Nothing at all when they walked away with none of it."""
    if buy.get("new_holder"):
        return "⬆️ New Holder!"
    pct = buy.get("position_pct")
    if pct is None or pct < PUMPFUN_MIN_POSITION_PCT:
        return None
    return f"⬆️ Position: {_fmt_grouped(pct, 0)}% Up!"


def _footer() -> str:
    links = []
    if PUMPFUN_CHART_URL:
        links.append(f'📈 <a href="{html.escape(PUMPFUN_CHART_URL, quote=True)}">Chart</a>')
    if PUMPFUN_TRADE_URL:
        links.append(f'🛒 <a href="{html.escape(PUMPFUN_TRADE_URL, quote=True)}">Buy</a>')
    return "   ".join(links)


def format_buy(buy: dict, usd: float | None, market_cap: float | None) -> str:
    """The chat post, in Telegram HTML.

    Three blocks separated by blank lines — what happened, the trade itself,
    where to go next — because Telegram sets every line at the same weight and
    a seven-line wall of emoji reads as one paragraph without them.
    """
    buyer = buy.get("buyer") or ""
    signature = buy.get("signature") or ""

    who = (
        f'<a href="{SOLSCAN_URL}/address/{buyer}">{_short_addr(buyer)}</a>'
        if buyer else "?"
    )
    txn = f'<a href="{SOLSCAN_URL}/tx/{signature}">Txn</a>' if signature else "Txn"

    sol_line = f"🔀 {buy['sol_amount']:.4f} SOL"
    if usd is not None:
        sol_line += f" ({_fmt_usd(usd)})"

    lines = [
        f'<a href="{html.escape(PUMPFUN_TOKEN_URL, quote=True)}">'
        f"{html.escape(PUMPFUN_TOKEN_LABEL)}</a> Buy!",
        _emoji_row(usd),
        "",
        sol_line,
        f"🔀 {_fmt_grouped(buy['token_amount'], 1)} {html.escape(PUMPFUN_TOKEN_SYMBOL)}",
        f"👤 {who} | {txn}",
    ]
    position = _position_line(buy)
    if position:
        lines.append(position)
    if market_cap:
        lines.append(f"💸 Market Cap ${_fmt_grouped(market_cap, 0)}")
    footer = _footer()
    if footer:
        lines += ["", footer]
    return "\n".join(lines)
