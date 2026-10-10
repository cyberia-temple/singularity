"""Background announcer loops and the periodic market snapshot."""
import asyncio
import html
import re
import time
import logging
from datetime import datetime, timedelta, timezone

from web3 import Web3
from sqlalchemy import text

from telegram.ext import Application
from telegram.error import TelegramError

from bot.config import (
    RPC_URL, EXPLORER_URL, SOLSCAN_URL,
    BRIDGE_ANNOUNCE_CHAT, BRIDGE_POLL_SECONDS,
    SWAP_ANNOUNCE_CHAT, SWAP_POLL_SECONDS, SWAP_MAX_BLOCK_RANGE,
    LIQUIDITY_ANNOUNCE_CHAT, LIQUIDITY_POLL_SECONDS, LIQUIDITY_MAX_BLOCK_RANGE,
    LENDING_ANNOUNCE_CHAT, LENDING_POLL_SECONDS, LENDING_MAX_BLOCK_RANGE,
    LENDING_COMPTROLLER,
    CYBERSOL_SWAP_ADDRESS, CYBERSOL_SWAP_ANNOUNCE_CHAT,
    CYBERSOL_SWAP_POLL_SECONDS, CYBERSOL_SWAP_MAX_BLOCK_RANGE,
    STAKING_MASTERCHEF, STAKING_ANNOUNCE_CHAT,
    STAKING_POLL_SECONDS, STAKING_MAX_BLOCK_RANGE,
    MIN_ANNOUNCE_USD, BIG_ANNOUNCE_USD, RITUAL_V2_FACTORY,
    RITUAL_V2_ROUTER, CYBERIA_V3_ROUTER,
    DIGEST_ANNOUNCE_CHAT, DIGEST_INTERVAL_SECONDS, DIGEST_RETENTION_DAYS,
    DIGEST_PRICE_CHANGE_MIN_BPS, DIGEST_PRICE_TOKEN_LIMIT,
    MARKET_SNAPSHOT_SECONDS, CYBER_CA_EVM,
    CYBER_SOL_MINT, CYBER_SOL_DECIMALS, WHALE_MIN_RAW,
    WHALE_CHAT_ID, WHALE_POLL_SECONDS, WHALE_RECHECK_SECONDS, DB_PATH,
    PUMPFUN_ANNOUNCE_CHAT, PUMPFUN_MIN_BUY_USD, PUMPFUN_POLL_SECONDS,
    PUMPFUN_POOL_ADDRESS, PUMPFUN_TOKEN_SYMBOL, PUMPFUN_MAX_AGE_SECONDS,
)
from bot.db import (
    engine, _kv_get, _kv_set, _record_activity,
    _get_block_cursor, _set_block_cursor,
)
from bot.chain import (
    SWAP_EVENT_TOPIC, V3_SWAP_EVENT_TOPIC, PAIR_RESERVES_ABI,
    _event_topic, _router_topic_hex, _address_topic_hex,
    _hex_no_prefix, _decode_topic_address, _decode_swap_data, _decode_data_words,
    _decode_v3_swap_data,
    _get_pair_tokens, _get_token_meta, _get_tx_sender,
    _get_token_usd_price, _swap_usd_volume, _liquidity_usd_volume,
    _get_lending_markets, _get_market_underlying,
)
from bot.solana import solana_rpc
from bot.utils import (
    _short_addr, _format_decimal_amount, _format_token_amount, _fmt_usd,
    _format_window, _fmt_amount, _fmt_price_usd, _plural,
)
from bot import pumpfun

logger = logging.getLogger(__name__)


# Bridge direction keys are '{source}_to_{dest}' over these per-chain
# shorthands (mirrors config/bridge.php routes on the Laravel side). Each side
# maps to (human label, explorer tx-link prefix). Unknown sides render the raw
# direction with no link — never a link to the wrong chain's explorer.
_BRIDGE_CHAINS = {
    "evm": ("Cyberia", f"{EXPLORER_URL}/tx/"),
    "sol": ("Solana", f"{SOLSCAN_URL}/tx/"),
    "ton": ("TON", "https://tonviewer.com/transaction/"),
    "bnb": ("BNB Chain", "https://bscscan.com/tx/"),
    "base": ("Base", "https://basescan.org/tx/"),
    "robinhood": ("Robinhood Chain", "https://robinhoodchain.blockscout.com/tx/"),
    "yenten": ("Yenten", "https://explorer.yentencoin.info/tx/"),
    "btc": ("Bitcoin", "https://mempool.space/tx/"),
    "ltc": ("Litecoin", "https://litecoinspace.org/tx/"),
    "xmr": ("Monero", "https://xmrchain.net/tx/"),
}


def _bridge_sides(direction: str) -> tuple[str, str]:
    source, sep, dest = (direction or "").partition("_to_")
    return (source, dest) if sep else ("", "")


def _bridge_tx_links(direction: str, source_tx: str, dest_tx: str | None) -> tuple[str, str | None]:
    """Return (source_link, dest_link), each on its own side's explorer."""
    source, dest = _bridge_sides(direction)
    src_prefix = _BRIDGE_CHAINS.get(source, ("", None))[1]
    dst_prefix = _BRIDGE_CHAINS.get(dest, ("", None))[1]
    src = f"{src_prefix}{source_tx}" if src_prefix and source_tx else ""
    dst = f"{dst_prefix}{dest_tx}" if dst_prefix and dest_tx else None
    return src, dst


def _direction_label(direction: str) -> str:
    source, dest = _bridge_sides(direction)
    if source in _BRIDGE_CHAINS and dest in _BRIDGE_CHAINS:
        return f"{_BRIDGE_CHAINS[source][0]} → {_BRIDGE_CHAINS[dest][0]}"
    return direction


def _bridge_token_usd_price(symbol: str) -> float | None:
    """Best-effort USD price for a bridged token symbol. Stables are $1;
    CYBER variants are priced via the on-chain walker through CYBER_CA_EVM."""
    sym = (symbol or "").upper()
    if sym in ("USDC", "USDT"):
        return 1.0
    if sym.startswith("CYBER") and CYBER_CA_EVM:
        try:
            return _get_token_usd_price(Web3(Web3.HTTPProvider(RPC_URL)), CYBER_CA_EVM)
        except Exception as e:
            logger.debug(f"bridge price: CYBER lookup failed: {e}")
    return None


async def _announce_bridge_tick(bot) -> None:
    """Find newly-completed bridge_requests and announce them in BRIDGE_ANNOUNCE_CHAT.

    Advances `last_announced_bridge_id` only when send_message succeeds, so a
    transient Telegram failure is retried on the next tick.
    """
    last_id = int(_kv_get("last_announced_bridge_id", "0") or "0")

    with engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT id, direction, token, source_tx_hash, sender_address,
                       recipient_address, amount, destination_tx_hash
                FROM bridge_requests
                WHERE status = 'completed'
                  AND id > :last
                ORDER BY id ASC
                LIMIT 50
            """),
            {"last": last_id},
        ).fetchall()

    for row in rows:
        (req_id, direction, token, source_tx, sender, recipient,
         amount, dest_tx) = row
        src_link, dst_link = _bridge_tx_links(direction, source_tx or "", dest_tx)
        lines = [
            f"🌉 Bridge: {_direction_label(direction)}",
            f"Amount: {_format_decimal_amount(amount)} {token}",
            f"From: {_short_addr(sender)}",
            f"To: {_short_addr(recipient)}",
        ]
        if src_link:
            lines.append(f"Source: {src_link}")
        if dst_link:
            lines.append(f"Destination: {dst_link}")
        try:
            await bot.send_message(
                chat_id=BRIDGE_ANNOUNCE_CHAT,
                text="\n".join(lines),
                disable_web_page_preview=True,
            )
        except TelegramError as e:
            logger.error(f"announce_bridge: send failed for id={req_id}: {e}")
            return
        try:
            amt = float(_format_decimal_amount(amount))
        except ValueError:
            amt = None
        price = _bridge_token_usd_price(token)
        _record_activity(
            "bridge",
            usd=amt * price if (amt is not None and price is not None) else None,
            sym_in=token, amt_in=amt,
            user_addr=sender, tx_hash=source_tx, meta=direction,
        )
        _kv_set("last_announced_bridge_id", str(req_id))
        logger.info(f"announce_bridge: posted bridge id={req_id} ({direction})")


async def bridge_announcer_loop(application: Application) -> None:
    """Background loop that polls bridge_requests every BRIDGE_POLL_SECONDS."""
    # Bootstrap: on a fresh install we skip historical completed bridges so the
    # chat doesn't get spammed with the entire history on first run.
    if _kv_get("last_announced_bridge_id") is None:
        try:
            with engine.connect() as conn:
                max_id = conn.execute(
                    text("SELECT COALESCE(MAX(id), 0) FROM bridge_requests WHERE status = 'completed'"),
                ).scalar() or 0
        except Exception as e:
            logger.warning(f"bridge_announcer: bootstrap query failed: {e}")
            max_id = 0
        _kv_set("last_announced_bridge_id", str(max_id))
        logger.info(f"bridge_announcer: bootstrapped last_announced_bridge_id={max_id}")

    while True:
        try:
            await _announce_bridge_tick(application.bot)
        except Exception as e:
            logger.error(f"bridge_announcer_loop: {e}")
        await asyncio.sleep(BRIDGE_POLL_SECONDS)
def _decode_swap_hop(w3: Web3, log) -> dict | None:
    """Decode one Swap log into a hop dict, or None when the pair is unknown
    or the event has no clear in/out direction."""
    tokens = _get_pair_tokens(w3, log["address"])
    if not tokens:
        return None
    t0, t1 = tokens
    sym0, dec0 = _get_token_meta(w3, t0)
    sym1, dec1 = _get_token_meta(w3, t1)
    a0in, a1in, a0out, a1out = _decode_swap_data(log["data"])

    if a0in > 0 and a1out > 0:
        in_addr, in_sym, in_amt, in_dec = t0, sym0, a0in, dec0
        out_addr, out_sym, out_amt, out_dec = t1, sym1, a1out, dec1
    elif a1in > 0 and a0out > 0:
        in_addr, in_sym, in_amt, in_dec = t1, sym1, a1in, dec1
        out_addr, out_sym, out_amt, out_dec = t0, sym0, a0out, dec0
    else:
        return None

    return {
        "in_addr": in_addr, "in_sym": in_sym, "in_amt": in_amt, "in_dec": in_dec,
        "out_addr": out_addr, "out_sym": out_sym, "out_amt": out_amt, "out_dec": out_dec,
        "to": _decode_topic_address(log["topics"][2]),
        "route": None,
    }
def _decode_v3_swap_hop(w3: Web3, log) -> dict | None:
    """Decode one Cyberia V3 pool Swap log into the same hop dict as V2.

    A V3 pool reports its two amounts signed from its own side: the positive
    one went into the pool (the trader's input), the negative one came out.
    token0/token1 are read exactly as for a V2 pair — the pool has both.
    """
    tokens = _get_pair_tokens(w3, log["address"])
    if not tokens:
        return None
    t0, t1 = tokens
    a0, a1 = _decode_v3_swap_data(log["data"])

    if a0 > 0 and a1 < 0:
        (in_addr, in_amt), (out_addr, out_amt) = (t0, a0), (t1, -a1)
    elif a1 > 0 and a0 < 0:
        (in_addr, in_amt), (out_addr, out_amt) = (t1, a1), (t0, -a0)
    else:
        return None

    in_sym, in_dec = _get_token_meta(w3, in_addr)
    out_sym, out_dec = _get_token_meta(w3, out_addr)
    return {
        "in_addr": in_addr, "in_sym": in_sym, "in_amt": in_amt, "in_dec": in_dec,
        "out_addr": out_addr, "out_sym": out_sym, "out_amt": out_amt, "out_dec": out_dec,
        "to": _decode_topic_address(log["topics"][2]),
        "route": None,
    }


# Both of Cyberia's exchanges, announced by one loop. Each keeps its own
# `block:log_index` cursor; v2's key is the one it has always had, so adding v3
# neither replays nor skips a v2 swap. Only swaps sent through the venue's own
# router are read (`sender` is indexed on both events), which is what keeps a
# pool's internal hops and arbitrary contracts out.
SWAP_VENUES = {
    "v2": {
        "cursor": "last_announced_swap_cursor",
        "topic": SWAP_EVENT_TOPIC,
        "router": RITUAL_V2_ROUTER,
        "decode": _decode_swap_hop,
    },
    "v3": {
        "cursor": "last_announced_v3_swap_cursor",
        "topic": V3_SWAP_EVENT_TOPIC,
        "router": CYBERIA_V3_ROUTER,
        "decode": _decode_v3_swap_hop,
    },
}


async def _announce_swap_tick(bot, venue: str = "v2") -> None:
    """Scan new Swap events from one venue's router and post one msg per
    trade. A routed swap (A → B → C) emits one Swap event per pool with the
    *next pool* (v2) or the router (v3) as the intermediate recipient, so
    consecutive events of the same tx are merged into a single first-in →
    last-out announcement.

    Cursor is stored as `block:log_index` so a mid-tick Telegram failure
    resumes exactly where it stopped without duplicating earlier sends.
    """
    spec = SWAP_VENUES[venue]
    router = spec["router"]
    if not router:
        return
    cursor_key = spec["cursor"]

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    try:
        latest = w3.eth.block_number
    except Exception as e:
        logger.error(f"swap_announcer[{venue}]: block_number failed: {e}")
        return

    cursor = _get_block_cursor(cursor_key)
    if cursor is None:
        # Don't backfill historical swaps on first run.
        _set_block_cursor(cursor_key, latest, 10**9)
        logger.info(f"swap_announcer[{venue}]: bootstrapped cursor to head block={latest}")
        return
    cur_block, cur_idx = cursor

    if cur_block > latest:
        return

    end = min(cur_block + SWAP_MAX_BLOCK_RANGE - 1, latest)

    try:
        logs = w3.eth.get_logs({
            "fromBlock": cur_block,
            "toBlock": end,
            "topics": [spec["topic"], _address_topic_hex(router)],
        })
    except Exception as e:
        logger.error(f"swap_announcer[{venue}]: get_logs {cur_block}..{end}: {e}")
        return

    new_logs = [
        log for log in sorted(logs, key=lambda l: (int(l["blockNumber"]), int(l["logIndex"])))
        if (int(log["blockNumber"]), int(log["logIndex"])) > (cur_block, cur_idx)
    ]
    # Per-event swap posts are gated at the $1 dust floor and require a known
    # USD value: small trades and swaps the price walker can't value are the
    # bulk of the noise, so they go to the digest instead of their own message.
    threshold = MIN_ANNOUNCE_USD

    i = 0
    while i < len(new_logs):
        # Within one block, a tx's logs occupy a contiguous logIndex range, so
        # the Swap events of one routed trade are consecutive here.
        tx_raw = new_logs[i]["transactionHash"]
        group = [new_logs[i]]
        j = i + 1
        while j < len(new_logs) and new_logs[j]["transactionHash"] == tx_raw:
            group.append(new_logs[j])
            j += 1
        i = j

        last_blk = int(group[-1]["blockNumber"])
        last_idx = int(group[-1]["logIndex"])
        tx_hash = "0x" + _hex_no_prefix(tx_raw).lower()

        try:
            hops = [h for h in (spec["decode"](w3, log) for log in group) if h is not None]
        except Exception as e:
            logger.error(f"swap_announcer[{venue}]: decode failed tx={tx_hash}: {e}")
            hops = []
        if not hops:
            _set_block_cursor(cursor_key, last_blk, last_idx)
            cur_block, cur_idx = last_blk, last_idx
            continue

        # Merge a chained route into one announcement: trade in = first hop's
        # input, trade out = last hop's output, trader = last hop's recipient.
        is_route = len(hops) > 1 and all(
            hops[k]["out_addr"].lower() == hops[k + 1]["in_addr"].lower()
            for k in range(len(hops) - 1)
        )
        if is_route:
            first, last = hops[0], hops[-1]
            announcements = [{
                **{k: first[k] for k in ("in_addr", "in_sym", "in_amt", "in_dec")},
                **{k: last[k] for k in ("out_addr", "out_sym", "out_amt", "out_dec")},
                "to": last["to"],
                "route": [first["in_sym"]] + [h["in_sym"] for h in hops[1:]] + [last["out_sym"]],
            }]
        else:
            announcements = hops

        # A swap paid out in the coin lands on the router, which unwraps it and
        # forwards it on — so "the recipient" would name the router as the
        # trader. The transaction's sender is who actually traded.
        for ann in announcements:
            if ann["to"].lower() == router.lower():
                ann["to"] = _get_tx_sender(w3, tx_hash) or ann["to"]

        aborted = False
        for ann in announcements:
            try:
                usd = _swap_usd_volume(
                    w3,
                    ann["in_addr"], ann["in_amt"], ann["in_dec"],
                    ann["out_addr"], ann["out_amt"], ann["out_dec"],
                )
                event_kwargs = dict(
                    kind="swap", usd=usd,
                    sym_in=ann["in_sym"], amt_in=ann["in_amt"] / 10**ann["in_dec"],
                    sym_out=ann["out_sym"], amt_out=ann["out_amt"] / 10**ann["out_dec"],
                    user_addr=ann["to"], tx_hash=tx_hash, block=last_blk,
                )

                # Only swaps worth more than the $1 floor get their own post;
                # smaller trades and swaps we can't price are recorded and
                # surface in the periodic digest instead of firehosing the chat.
                if usd is None or usd < threshold:
                    _record_activity(**event_kwargs)
                    logger.info(
                        f"swap_announcer: digest-only tx={tx_hash} "
                        f"usd={usd} < {threshold}"
                    )
                    continue

                text_lines = [
                    "🔄 Swap on Ritual",
                    f"{_format_token_amount(ann['in_amt'], ann['in_dec'])} {ann['in_sym']} → "
                    f"{_format_token_amount(ann['out_amt'], ann['out_dec'])} {ann['out_sym']}",
                ]
                if ann["route"]:
                    text_lines.append("Route: " + " → ".join(ann["route"]))
                if usd is not None:
                    text_lines.append(f"Value: {_fmt_usd(usd)}")
                text_lines += [
                    f"User: {_short_addr(ann['to'])}",
                    f"Tx: {EXPLORER_URL}/tx/{tx_hash}",
                ]
            except Exception as e:
                logger.error(f"swap_announcer[{venue}]: build failed tx={tx_hash}: {e}")
                continue

            try:
                await bot.send_message(
                    chat_id=SWAP_ANNOUNCE_CHAT,
                    text="\n".join(text_lines),
                    disable_web_page_preview=True,
                )
            except TelegramError as e:
                logger.error(f"swap_announcer[{venue}]: send failed tx={tx_hash}: {e}")
                aborted = True
                break

            # Record only after a successful send so a mid-tick retry can't
            # double-count the same swap in the digest.
            _record_activity(**event_kwargs)
            logger.info(f"swap_announcer[{venue}]: posted swap block={last_blk} tx={tx_hash}")

        if aborted:
            return  # cursor still before this tx; the whole group retries next tick

        _set_block_cursor(cursor_key, last_blk, last_idx)
        cur_block, cur_idx = last_blk, last_idx

    # Empty range, or fully drained — advance past the scanned window so we
    # don't refetch the same blocks indefinitely.
    if end > cur_block:
        _set_block_cursor(cursor_key, end, 10**9)


async def swap_announcer_loop(application: Application) -> None:
    while True:
        for venue in SWAP_VENUES:
            try:
                await _announce_swap_tick(application.bot, venue)
            except Exception as e:
                logger.error(f"swap_announcer_loop[{venue}]: {e}")
        await asyncio.sleep(SWAP_POLL_SECONDS)
# keccak256("Mint(address,uint256,uint256)") / "Burn(address,uint256,uint256,address)".
LP_MINT_TOPIC = _event_topic("Mint(address,uint256,uint256)")
LP_BURN_TOPIC = _event_topic("Burn(address,uint256,uint256,address)")
async def _announce_liquidity_tick(bot) -> None:
    """Scan V2 Mint/Burn events routed through the Ritual router and announce
    each add/remove. Mirrors the swap announcer's cursor handling."""
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    try:
        latest = w3.eth.block_number
    except Exception as e:
        logger.error(f"liquidity_announcer: block_number failed: {e}")
        return

    cursor = _get_block_cursor("last_announced_liq_cursor")
    if cursor is None:
        _set_block_cursor("last_announced_liq_cursor", latest, 10**9)
        logger.info(f"liquidity_announcer: bootstrapped cursor to head block={latest}")
        return
    cur_block, cur_idx = cursor
    if cur_block > latest:
        return
    end = min(cur_block + LIQUIDITY_MAX_BLOCK_RANGE - 1, latest)

    try:
        logs = w3.eth.get_logs({
            "fromBlock": cur_block,
            "toBlock": end,
            "topics": [[LP_MINT_TOPIC, LP_BURN_TOPIC], _router_topic_hex()],
        })
    except Exception as e:
        logger.error(f"liquidity_announcer: get_logs {cur_block}..{end}: {e}")
        return

    for log in sorted(logs, key=lambda l: (int(l["blockNumber"]), int(l["logIndex"]))):
        blk = int(log["blockNumber"])
        idx = int(log["logIndex"])
        if (blk, idx) <= (cur_block, cur_idx):
            continue

        try:
            topic0 = "0x" + _hex_no_prefix(log["topics"][0]).lower()
            is_add = topic0 == LP_MINT_TOPIC.lower()
            tokens = _get_pair_tokens(w3, log["address"])
            if not tokens:
                _set_block_cursor("last_announced_liq_cursor", blk, idx)
                cur_block, cur_idx = blk, idx
                continue
            t0, t1 = tokens
            sym0, dec0 = _get_token_meta(w3, t0)
            sym1, dec1 = _get_token_meta(w3, t1)
            # Both Mint and Burn carry (amount0, amount1) as the first two words.
            words = _decode_data_words(log["data"], 2)
            amount0, amount1 = words[0], words[1]

            usd = _liquidity_usd_volume(
                w3, t0, t1, dec0, dec1, amount0, amount1
            )

            tx_hash = "0x" + _hex_no_prefix(log["transactionHash"]).lower()
            # Burn carries the LP recipient in topics[2]; for Mint we fall back
            # to the tx initiator (the EOA that called the router).
            if not is_add and len(log["topics"]) > 2:
                user = _decode_topic_address(log["topics"][2])
            else:
                user = _get_tx_sender(w3, tx_hash) or "?"

            event_kwargs = dict(
                kind="liq_add" if is_add else "liq_remove", usd=usd,
                sym_in=sym0, amt_in=amount0 / 10**dec0,
                sym_out=sym1, amt_out=amount1 / 10**dec1,
                user_addr=user, tx_hash=tx_hash, block=blk,
            )

            threshold = max(MIN_ANNOUNCE_USD, BIG_ANNOUNCE_USD)
            if usd is not None and usd < threshold:
                _record_activity(**event_kwargs)
                logger.info(
                    f"liquidity_announcer: digest-only block={blk} idx={idx} "
                    f"usd={usd:.4f} < {threshold}"
                )
                _set_block_cursor("last_announced_liq_cursor", blk, idx)
                cur_block, cur_idx = blk, idx
                continue

            verb = "added" if is_add else "removed"
            sign = "+" if is_add else "-"
            text_lines = [
                f"💧 Liquidity {verb} on Ritual",
                f"{sign}{_format_token_amount(amount0, dec0)} {sym0} + "
                f"{sign}{_format_token_amount(amount1, dec1)} {sym1}",
            ]
            if usd is not None:
                text_lines.append(f"Value: {_fmt_usd(usd)}")
            text_lines += [
                f"User: {_short_addr(user)}",
                f"Tx: {EXPLORER_URL}/tx/{tx_hash}",
            ]
        except Exception as e:
            logger.error(f"liquidity_announcer: decode failed block={blk} idx={idx}: {e}")
            _set_block_cursor("last_announced_liq_cursor", blk, idx)
            cur_block, cur_idx = blk, idx
            continue

        try:
            await bot.send_message(
                chat_id=LIQUIDITY_ANNOUNCE_CHAT,
                text="\n".join(text_lines),
                disable_web_page_preview=True,
            )
        except TelegramError as e:
            logger.error(f"liquidity_announcer: send failed block={blk} idx={idx}: {e}")
            return

        _record_activity(**event_kwargs)
        _set_block_cursor("last_announced_liq_cursor", blk, idx)
        cur_block, cur_idx = blk, idx
        logger.info(f"liquidity_announcer: posted {verb} block={blk} idx={idx} tx={tx_hash}")

    if end > cur_block:
        _set_block_cursor("last_announced_liq_cursor", end, 10**9)


async def liquidity_announcer_loop(application: Application) -> None:
    while True:
        try:
            await _announce_liquidity_tick(application.bot)
        except Exception as e:
            logger.error(f"liquidity_announcer_loop: {e}")
        await asyncio.sleep(LIQUIDITY_POLL_SECONDS)
LEND_MINT_TOPIC = _event_topic("Mint(address,uint256,uint256)")
LEND_REDEEM_TOPIC = _event_topic("Redeem(address,uint256,uint256)")
LEND_BORROW_TOPIC = _event_topic("Borrow(address,uint256,uint256,uint256)")
LEND_REPAY_TOPIC = _event_topic("RepayBorrow(address,address,uint256,uint256,uint256)")

_LEND_ACTION = {
    LEND_MINT_TOPIC.lower():   ("supplied", "🏦"),
    LEND_REDEEM_TOPIC.lower(): ("withdrew", "🏦"),
    LEND_BORROW_TOPIC.lower(): ("borrowed", "💸"),
    LEND_REPAY_TOPIC.lower():  ("repaid",   "💵"),
}
async def _announce_lending_tick(bot) -> None:
    """Scan supply/withdraw/borrow/repay events from every lending market and
    announce them. Amounts are in underlying-token units."""
    if not LENDING_COMPTROLLER:
        return

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    try:
        latest = w3.eth.block_number
    except Exception as e:
        logger.error(f"lending_announcer: block_number failed: {e}")
        return

    cursor = _get_block_cursor("last_announced_lend_cursor")
    if cursor is None:
        _set_block_cursor("last_announced_lend_cursor", latest, 10**9)
        logger.info(f"lending_announcer: bootstrapped cursor to head block={latest}")
        return
    cur_block, cur_idx = cursor
    if cur_block > latest:
        return
    end = min(cur_block + LENDING_MAX_BLOCK_RANGE - 1, latest)

    try:
        markets = _get_lending_markets(w3)
    except Exception as e:
        logger.error(f"lending_announcer: getAllMarkets failed: {e}")
        return
    if not markets:
        return

    try:
        logs = w3.eth.get_logs({
            "fromBlock": cur_block,
            "toBlock": end,
            "address": markets,
            "topics": [[LEND_MINT_TOPIC, LEND_REDEEM_TOPIC, LEND_BORROW_TOPIC, LEND_REPAY_TOPIC]],
        })
    except Exception as e:
        logger.error(f"lending_announcer: get_logs {cur_block}..{end}: {e}")
        return

    for log in sorted(logs, key=lambda l: (int(l["blockNumber"]), int(l["logIndex"]))):
        blk = int(log["blockNumber"])
        idx = int(log["logIndex"])
        if (blk, idx) <= (cur_block, cur_idx):
            continue

        try:
            topic0 = "0x" + _hex_no_prefix(log["topics"][0]).lower()
            action = _LEND_ACTION.get(topic0)
            if action is None:
                _set_block_cursor("last_announced_lend_cursor", blk, idx)
                cur_block, cur_idx = blk, idx
                continue
            verb, emoji = action

            underlying = _get_market_underlying(w3, log["address"])
            if underlying is None:
                _set_block_cursor("last_announced_lend_cursor", blk, idx)
                cur_block, cur_idx = blk, idx
                continue
            sym, dec = _get_token_meta(w3, underlying)

            # First data word is always the underlying amount (mint/redeem/borrow/
            # repay all lead with it). The acting user is the first indexed arg,
            # except RepayBorrow where topics[1]=payer and topics[2]=borrower.
            amount = _decode_data_words(log["data"], 1)[0]
            if topic0 == LEND_REPAY_TOPIC.lower() and len(log["topics"]) > 2:
                user = _decode_topic_address(log["topics"][2])
            else:
                user = _decode_topic_address(log["topics"][1])

            price = _get_token_usd_price(w3, underlying)
            usd = (amount / 10**dec) * price if price is not None else None

            tx_hash = "0x" + _hex_no_prefix(log["transactionHash"]).lower()
            event_kwargs = dict(
                kind=f"lend_{verb}", usd=usd,
                sym_in=sym, amt_in=amount / 10**dec,
                user_addr=user, tx_hash=tx_hash, block=blk,
            )

            threshold = max(MIN_ANNOUNCE_USD, BIG_ANNOUNCE_USD)
            if usd is not None and usd < threshold:
                _record_activity(**event_kwargs)
                logger.info(
                    f"lending_announcer: digest-only block={blk} idx={idx} "
                    f"usd={usd:.4f} < {threshold}"
                )
                _set_block_cursor("last_announced_lend_cursor", blk, idx)
                cur_block, cur_idx = blk, idx
                continue

            text_lines = [
                f"{emoji} Lending: {verb} {_format_token_amount(amount, dec)} {sym}",
            ]
            if usd is not None:
                text_lines.append(f"Value: {_fmt_usd(usd)}")
            text_lines += [
                f"User: {_short_addr(user)}",
                f"Tx: {EXPLORER_URL}/tx/{tx_hash}",
            ]
        except Exception as e:
            logger.error(f"lending_announcer: decode failed block={blk} idx={idx}: {e}")
            _set_block_cursor("last_announced_lend_cursor", blk, idx)
            cur_block, cur_idx = blk, idx
            continue

        try:
            await bot.send_message(
                chat_id=LENDING_ANNOUNCE_CHAT,
                text="\n".join(text_lines),
                disable_web_page_preview=True,
            )
        except TelegramError as e:
            logger.error(f"lending_announcer: send failed block={blk} idx={idx}: {e}")
            return

        _record_activity(**event_kwargs)
        _set_block_cursor("last_announced_lend_cursor", blk, idx)
        cur_block, cur_idx = blk, idx
        logger.info(f"lending_announcer: posted {verb} block={blk} idx={idx} tx={tx_hash}")

    if end > cur_block:
        _set_block_cursor("last_announced_lend_cursor", end, 10**9)


async def lending_announcer_loop(application: Application) -> None:
    while True:
        try:
            await _announce_lending_tick(application.bot)
        except Exception as e:
            logger.error(f"lending_announcer_loop: {e}")
        await asyncio.sleep(LENDING_POLL_SECONDS)
# keccak256("Swapped(address,uint256,uint256)") — CyberSolSwap fixed-rate redeem.
CYBERSOL_SWAPPED_TOPIC = _event_topic("Swapped(address,uint256,uint256)")
# The bridged CYBER.sol ERC20 and native CYBER both use 18 decimals (the
# redeemer's 1000:1 wei math relies on it), so both amounts decode at 18.
_CYBERSOL_DECIMALS = 18
async def _announce_cybersol_swap_tick(bot) -> None:
    """Scan CyberSolSwap `Swapped` events and announce each CYBER.sol -> native
    CYBER conversion. Cursor handling mirrors the lending announcer; the input
    side (CYBER.sol == CYBER_CA_EVM) carries the priceable value."""
    if not CYBERSOL_SWAP_ADDRESS:
        return

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    try:
        latest = w3.eth.block_number
    except Exception as e:
        logger.error(f"cybersol_swap_announcer: block_number failed: {e}")
        return

    cursor = _get_block_cursor("last_announced_cybersol_cursor")
    if cursor is None:
        _set_block_cursor("last_announced_cybersol_cursor", latest, 10**9)
        logger.info(f"cybersol_swap_announcer: bootstrapped cursor to head block={latest}")
        return
    cur_block, cur_idx = cursor
    if cur_block > latest:
        return
    end = min(cur_block + CYBERSOL_SWAP_MAX_BLOCK_RANGE - 1, latest)

    try:
        logs = w3.eth.get_logs({
            "fromBlock": cur_block,
            "toBlock": end,
            "address": Web3.to_checksum_address(CYBERSOL_SWAP_ADDRESS),
            "topics": [CYBERSOL_SWAPPED_TOPIC],
        })
    except Exception as e:
        logger.error(f"cybersol_swap_announcer: get_logs {cur_block}..{end}: {e}")
        return

    for log in sorted(logs, key=lambda l: (int(l["blockNumber"]), int(l["logIndex"]))):
        blk = int(log["blockNumber"])
        idx = int(log["logIndex"])
        if (blk, idx) <= (cur_block, cur_idx):
            continue

        try:
            # Swapped data words: amountIn (CYBER.sol), amountOut (native CYBER).
            amount_in, amount_out = _decode_data_words(log["data"], 2)
            user = _decode_topic_address(log["topics"][1])
            tx_hash = "0x" + _hex_no_prefix(log["transactionHash"]).lower()

            price = None
            if CYBER_CA_EVM:
                try:
                    price = _get_token_usd_price(w3, CYBER_CA_EVM)
                except Exception as e:
                    logger.debug(f"cybersol_swap_announcer: price lookup failed: {e}")
            usd = (amount_in / 10**_CYBERSOL_DECIMALS) * price if price is not None else None

            event_kwargs = dict(
                kind="convert", usd=usd,
                sym_in="CYBER.sol", amt_in=amount_in / 10**_CYBERSOL_DECIMALS,
                sym_out="CYBER", amt_out=amount_out / 10**_CYBERSOL_DECIMALS,
                user_addr=user, tx_hash=tx_hash, block=blk,
            )

            # No USD threshold here, unlike swaps/liquidity/lending: the 1000:1
            # redeem of a sub-cent token means every conversion is worth well
            # under a dollar, so a "big event" gate would mute the announcer
            # entirely. Conversions are infrequent bridge-redemption events, not
            # DEX dust, so each one gets its own post (and still feeds the digest).
            text_lines = [
                "🔁 CYBER.sol → CYBER conversion",
                f"{_format_token_amount(amount_in, _CYBERSOL_DECIMALS)} CYBER.sol → "
                f"{_format_token_amount(amount_out, _CYBERSOL_DECIMALS)} CYBER",
            ]
            if usd is not None:
                text_lines.append(f"Value: {_fmt_usd(usd)}")
            text_lines += [
                f"User: {_short_addr(user)}",
                f"Tx: {EXPLORER_URL}/tx/{tx_hash}",
            ]
        except Exception as e:
            logger.error(f"cybersol_swap_announcer: decode failed block={blk} idx={idx}: {e}")
            _set_block_cursor("last_announced_cybersol_cursor", blk, idx)
            cur_block, cur_idx = blk, idx
            continue

        try:
            await bot.send_message(
                chat_id=CYBERSOL_SWAP_ANNOUNCE_CHAT,
                text="\n".join(text_lines),
                disable_web_page_preview=True,
            )
        except TelegramError as e:
            logger.error(f"cybersol_swap_announcer: send failed block={blk} idx={idx}: {e}")
            return

        _record_activity(**event_kwargs)
        _set_block_cursor("last_announced_cybersol_cursor", blk, idx)
        cur_block, cur_idx = blk, idx
        logger.info(f"cybersol_swap_announcer: posted block={blk} idx={idx} tx={tx_hash}")

    if end > cur_block:
        _set_block_cursor("last_announced_cybersol_cursor", end, 10**9)


async def cybersol_swap_announcer_loop(application: Application) -> None:
    while True:
        try:
            await _announce_cybersol_swap_tick(application.bot)
        except Exception as e:
            logger.error(f"cybersol_swap_announcer_loop: {e}")
        await asyncio.sleep(CYBERSOL_SWAP_POLL_SECONDS)
async def _announce_pumpfun_tick(bot) -> None:
    """Post every CYBER.sol buy on the pump.fun pool worth at least
    PUMPFUN_MIN_BUY_USD. The cursor is (slot, index-in-block), advanced only
    past transactions that were read — and, for a posted buy, only once
    Telegram accepted it, so a send failure retries instead of losing the buy.

    Solana RPC and the market feed are blocking urllib calls, so both run off
    the event loop.
    """
    if not PUMPFUN_ANNOUNCE_CHAT:
        return

    market = await asyncio.to_thread(pumpfun.market_snapshot, CYBER_SOL_MINT)
    if not market:
        # No SOL price means no way to size a buy against the threshold. Hold
        # the cursor: the buys are still there on the next tick.
        logger.warning("pumpfun_announcer: no market quote yet, deferring this tick")
        return

    pool = PUMPFUN_POOL_ADDRESS or market.get("pool")
    if not pool:
        logger.warning("pumpfun_announcer: no pool to watch")
        return

    # Both halves of the market cap the posts will print: the price comes from
    # each buy's own pool reserves, the supply from the chain (cached for an
    # hour). Unreadable, and the posts fall back to the feed's figure.
    supply = await asyncio.to_thread(pumpfun.token_supply, CYBER_SOL_MINT)

    cursor = _get_block_cursor("last_announced_pumpfun_cursor")
    if cursor is None:
        slot, index = await asyncio.to_thread(pumpfun.head_cursor, pool)
        _set_block_cursor("last_announced_pumpfun_cursor", slot, index)
        logger.info(
            f"pumpfun_announcer: bootstrapped cursor to pool={pool} head slot={slot}"
        )
        return

    buys, scanned = await asyncio.to_thread(
        pumpfun.collect_buys, pool, CYBER_SOL_MINT, cursor
    )

    for buy in buys:
        usd = buy["sol_amount"] * market["sol_usd"]
        event_kwargs = dict(
            kind="pumpfun_buy", usd=usd,
            sym_in="SOL", amt_in=buy["sol_amount"],
            sym_out=PUMPFUN_TOKEN_SYMBOL, amt_out=buy["token_amount"],
            user_addr=buy["buyer"], tx_hash=buy["signature"], block=buy["slot"],
            meta="new_holder" if buy["new_holder"] else None,
        )

        # Buys under the floor never get their own post; they are recorded and
        # surface in the periodic digest instead of firehosing the chat.
        if usd < PUMPFUN_MIN_BUY_USD:
            _record_activity(**event_kwargs)
            _set_block_cursor("last_announced_pumpfun_cursor", buy["slot"], buy["tx_index"])
            logger.info(
                f"pumpfun_announcer: digest-only tx={buy['signature']} "
                f"usd={usd:.2f} < {PUMPFUN_MIN_BUY_USD:g}"
            )
            continue

        # Same for a buy that is simply old. After an outage the cursor sits
        # hours back, and posting that catch-up as it scrolls by would report
        # yesterday's trades as news.
        age = time.time() - float(buy.get("block_time") or 0)
        if buy.get("block_time") and age > PUMPFUN_MAX_AGE_SECONDS:
            _record_activity(**event_kwargs)
            _set_block_cursor("last_announced_pumpfun_cursor", buy["slot"], buy["tx_index"])
            logger.info(
                f"pumpfun_announcer: digest-only (stale, {age / 60:.0f}m old) "
                f"tx={buy['signature']}"
            )
            continue

        # The cap as this buy left the pool, so the post agrees with the chart
        # it links to; the feed's own figure is a trade behind and only stands
        # in when the reserves or the supply could not be read.
        cap = pumpfun.market_cap_after(buy, market["sol_usd"], supply)
        if cap is None:
            cap = market.get("market_cap")

        try:
            await bot.send_message(
                chat_id=PUMPFUN_ANNOUNCE_CHAT,
                text=pumpfun.format_buy(buy, usd, cap),
                parse_mode="HTML",
                disable_web_page_preview=True,
            )
        except TelegramError as e:
            logger.error(f"pumpfun_announcer: send failed for {buy['signature']}: {e}")
            return  # cursor still before this buy; it retries next tick

        # Record only after a successful send so a retry can't double-count it.
        _record_activity(**event_kwargs)
        _set_block_cursor("last_announced_pumpfun_cursor", buy["slot"], buy["tx_index"])
        logger.info(
            f"pumpfun_announcer: posted {buy['sol_amount']:.4f} SOL "
            f"({_fmt_usd(usd)}) tx={buy['signature']}"
        )

    if scanned > cursor:
        _set_block_cursor("last_announced_pumpfun_cursor", scanned[0], scanned[1])


async def pumpfun_announcer_loop(application: Application) -> None:
    while True:
        try:
            await _announce_pumpfun_tick(application.bot)
        except Exception as e:
            logger.error(f"pumpfun_announcer_loop: {e}")
        await asyncio.sleep(PUMPFUN_POLL_SECONDS)
# MasterChef staking events: Deposit/Withdraw/EmergencyWithdraw all carry
# (address indexed user, uint256 indexed pid) with the amount as the only
# data word.
STAKING_DEPOSIT_TOPIC = _event_topic("Deposit(address,uint256,uint256)")
STAKING_WITHDRAW_TOPIC = _event_topic("Withdraw(address,uint256,uint256)")
STAKING_EMERGENCY_TOPIC = _event_topic("EmergencyWithdraw(address,uint256,uint256)")

# topic0 → (verb, emoji, activity kind). Emergency exits forfeit pending
# rewards, so they get their own verb but count as unstakes in the digest.
_STAKING_ACTION = {
    STAKING_DEPOSIT_TOPIC.lower():   ("staked", "🔒", "stake"),
    STAKING_WITHDRAW_TOPIC.lower():  ("unstaked", "🔓", "unstake"),
    STAKING_EMERGENCY_TOPIC.lower(): ("emergency-unstaked", "🚨", "unstake"),
}

MASTERCHEF_POOL_ABI = [
    {"inputs": [{"name": "", "type": "uint256"}], "name": "poolInfo",
     "outputs": [
         {"name": "lpToken", "type": "address"},
         {"name": "allocPoint", "type": "uint256"},
         {"name": "lastRewardBlock", "type": "uint256"},
         {"name": "accRewardPerShare", "type": "uint256"},
     ],
     "stateMutability": "view", "type": "function"},
]
_TOKEN0_PROBE_ABI = [
    {"inputs": [], "name": "token0",
     "outputs": [{"name": "", "type": "address"}],
     "stateMutability": "view", "type": "function"},
]

# pid → staked token address for solo pools, None for LP-farm pids. A pid's
# lpToken never changes in MasterChef, so entries live for the process.
_staking_pool_cache: dict[int, str | None] = {}


def _get_solo_pool_token(w3: Web3, pid: int) -> str | None:
    """The staked ERC-20 of a solo pool, or None when `pid` is an LP farm.
    Mirrors the /staking page: a single-asset stake token has no token0()."""
    if pid in _staking_pool_cache:
        return _staking_pool_cache[pid]
    chef = w3.eth.contract(
        address=Web3.to_checksum_address(STAKING_MASTERCHEF), abi=MASTERCHEF_POOL_ABI
    )
    lp_token = chef.functions.poolInfo(pid).call()[0]
    probe = w3.eth.contract(
        address=Web3.to_checksum_address(lp_token), abi=_TOKEN0_PROBE_ABI
    )
    try:
        probe.functions.token0().call()
        result = None  # a V2 pair → LP farm, announced by the liquidity loop
    except Exception:
        result = lp_token
    _staking_pool_cache[pid] = result
    return result
async def _announce_staking_tick(bot) -> None:
    """Scan MasterChef Deposit/Withdraw/EmergencyWithdraw events on solo
    (single-asset) pools and announce each stake/unstake. LP-farm pids and
    zero-amount deposits/withdrawals (the harvest idiom) are skipped. Cursor
    handling mirrors the lending announcer."""
    if not STAKING_MASTERCHEF:
        return

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    try:
        latest = w3.eth.block_number
    except Exception as e:
        logger.error(f"staking_announcer: block_number failed: {e}")
        return

    cursor = _get_block_cursor("last_announced_staking_cursor")
    if cursor is None:
        _set_block_cursor("last_announced_staking_cursor", latest, 10**9)
        logger.info(f"staking_announcer: bootstrapped cursor to head block={latest}")
        return
    cur_block, cur_idx = cursor
    if cur_block > latest:
        return
    end = min(cur_block + STAKING_MAX_BLOCK_RANGE - 1, latest)

    try:
        logs = w3.eth.get_logs({
            "fromBlock": cur_block,
            "toBlock": end,
            "address": Web3.to_checksum_address(STAKING_MASTERCHEF),
            "topics": [[STAKING_DEPOSIT_TOPIC, STAKING_WITHDRAW_TOPIC, STAKING_EMERGENCY_TOPIC]],
        })
    except Exception as e:
        logger.error(f"staking_announcer: get_logs {cur_block}..{end}: {e}")
        return

    for log in sorted(logs, key=lambda l: (int(l["blockNumber"]), int(l["logIndex"]))):
        blk = int(log["blockNumber"])
        idx = int(log["logIndex"])
        if (blk, idx) <= (cur_block, cur_idx):
            continue

        try:
            topic0 = "0x" + _hex_no_prefix(log["topics"][0]).lower()
            action = _STAKING_ACTION.get(topic0)
            if action is None:
                _set_block_cursor("last_announced_staking_cursor", blk, idx)
                cur_block, cur_idx = blk, idx
                continue
            verb, emoji, kind = action

            pid = int(_hex_no_prefix(log["topics"][2]), 16)
            token = _get_solo_pool_token(w3, pid)
            amount = _decode_data_words(log["data"], 1)[0]
            # deposit(pid, 0) / withdraw(pid, 0) is how harvests are made —
            # nobody entered or left the pool.
            if token is None or amount == 0:
                _set_block_cursor("last_announced_staking_cursor", blk, idx)
                cur_block, cur_idx = blk, idx
                continue

            sym, dec = _get_token_meta(w3, token)
            user = _decode_topic_address(log["topics"][1])

            price = _get_token_usd_price(w3, token)
            usd = (amount / 10**dec) * price if price is not None else None

            tx_hash = "0x" + _hex_no_prefix(log["transactionHash"]).lower()
            event_kwargs = dict(
                kind=kind, usd=usd,
                sym_in=sym, amt_in=amount / 10**dec,
                user_addr=user, tx_hash=tx_hash, block=blk,
            )

            threshold = max(MIN_ANNOUNCE_USD, BIG_ANNOUNCE_USD)
            if usd is not None and usd < threshold:
                _record_activity(**event_kwargs)
                logger.info(
                    f"staking_announcer: digest-only block={blk} idx={idx} "
                    f"usd={usd:.4f} < {threshold}"
                )
                _set_block_cursor("last_announced_staking_cursor", blk, idx)
                cur_block, cur_idx = blk, idx
                continue

            text_lines = [
                f"{emoji} Staking: {verb} {_format_token_amount(amount, dec)} {sym}",
            ]
            if usd is not None:
                text_lines.append(f"Value: {_fmt_usd(usd)}")
            text_lines += [
                f"User: {_short_addr(user)}",
                f"Tx: {EXPLORER_URL}/tx/{tx_hash}",
            ]
        except Exception as e:
            logger.error(f"staking_announcer: decode failed block={blk} idx={idx}: {e}")
            _set_block_cursor("last_announced_staking_cursor", blk, idx)
            cur_block, cur_idx = blk, idx
            continue

        try:
            await bot.send_message(
                chat_id=STAKING_ANNOUNCE_CHAT,
                text="\n".join(text_lines),
                disable_web_page_preview=True,
            )
        except TelegramError as e:
            logger.error(f"staking_announcer: send failed block={blk} idx={idx}: {e}")
            return

        _record_activity(**event_kwargs)
        _set_block_cursor("last_announced_staking_cursor", blk, idx)
        cur_block, cur_idx = blk, idx
        logger.info(f"staking_announcer: posted {verb} block={blk} idx={idx} tx={tx_hash}")

    if end > cur_block:
        _set_block_cursor("last_announced_staking_cursor", end, 10**9)


async def staking_announcer_loop(application: Application) -> None:
    while True:
        try:
            await _announce_staking_tick(application.bot)
        except Exception as e:
            logger.error(f"staking_announcer_loop: {e}")
        await asyncio.sleep(STAKING_POLL_SECONDS)
_KV_LAST_DIGEST_AT = "last_digest_at"
_KV_PREV_CYBER_PRICE = "digest_prev_cyber_price"
_SQLITE_TS = "%Y-%m-%d %H:%M:%S"
_PRICE_PRIORITY = {
    "CYBER.SOL": 0,
    "WCYBER": 1,
    "USDC": 2,
    "USDT": 3,
}


def _plain(post: str) -> str:
    """The same post with the markup taken out. Telegram rejecting one digest's
    HTML must not mean no digest at all: a send that fails leaves the window
    open, so the next tick would compose the same unsendable text and fail
    again, every minute, forever."""
    return html.unescape(re.sub(r"</?(?:b|pre)>", "", post))


def _esc(value) -> str:
    """Every dynamic string in the digest passes through here. A token symbol
    comes off a pair that anyone may create, so `<b>` is a name someone can
    pick — and the digest is posted as HTML."""
    return html.escape(str(value if value is not None else ""))


def _cyber_price_line(update_prev: bool = False, include_unchanged: bool = True) -> str | None:
    """'📈 CYBER.sol $… (+x% …)' line, or None when CYBER.sol can't be priced.
    `update_prev` stores the fresh price as the next digest's comparison base."""
    if not CYBER_CA_EVM:
        return None
    try:
        w3 = Web3(Web3.HTTPProvider(RPC_URL))
        price = _get_token_usd_price(w3, CYBER_CA_EVM)
    except Exception as e:
        logger.warning(f"digest: CYBER price read failed: {e}")
        return None
    if price is None or price <= 0:
        return None
    line = f"💰 <b>CYBER.sol</b> {_fmt_price_usd(price)}"
    try:
        prev = float(_kv_get(_KV_PREV_CYBER_PRICE) or 0)
    except ValueError:
        prev = 0.0
    if prev > 0:
        change_pct = (price - prev) / prev * 100
        if abs(change_pct) * 100 >= DIGEST_PRICE_CHANGE_MIN_BPS:
            arrow = "📈" if change_pct >= 0 else "📉"
            line = (
                f"{arrow} <b>CYBER.sol</b> {_fmt_price_usd(price)} "
                f"· {change_pct:+.1f}% since last digest"
            )
        elif not include_unchanged:
            line = None
    elif not include_unchanged:
        line = None
    if update_prev:
        _kv_set(_KV_PREV_CYBER_PRICE, f"{price:.12g}")
    return line


def _price_block(pairs: list[tuple[str, float]]) -> list[str]:
    """Prices as an aligned monospace table. Pure.

    A run-on line of eight `SYM $price` pairs wraps at whatever width the
    reader's phone happens to be and stops being a list of prices; in <pre> the
    symbols line up under each other and the eye runs down the column.
    """
    if not pairs:
        return []
    width = max(len(label) for label, _ in pairs)
    table = "\n".join(
        f"{_esc(label.ljust(width))}  {_fmt_price_usd(price)}" for label, price in pairs
    )
    return ["💱 <b>Prices</b>", f"<pre>{table}</pre>"]


def _market_price_block() -> list[str]:
    """The prices the snapshotter currently holds, highest-priority first."""
    if DIGEST_PRICE_TOKEN_LIMIT <= 0:
        return []
    with engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT symbol, price_usd
                FROM token_prices
                WHERE price_usd IS NOT NULL AND price_usd > 0
            """),
        ).fetchall()
    if not rows:
        return []

    def sort_key(row) -> tuple[int, str]:
        sym = str(row[0] or "").upper()
        return (_PRICE_PRIORITY.get(sym, 100), sym)

    pairs: list[tuple[str, float]] = []
    seen: set[str] = set()
    for sym, price in sorted(rows, key=sort_key):
        label = str(sym or "?")
        key = label.upper()
        if key in seen:
            continue
        seen.add(key)
        pairs.append((label, float(price)))
        if len(pairs) >= DIGEST_PRICE_TOKEN_LIMIT:
            break
    return _price_block(pairs)


def _build_digest_text(since: str, window_label: str) -> str | None:
    """Summary of activity_events recorded after `since` (sqlite UTC text).
    Returns None when the window is empty so quiet periods stay silent."""
    with engine.connect() as conn:
        swap_count, swap_vol, traders, unpriced = conn.execute(
            text("""
                SELECT COUNT(*), COALESCE(SUM(usd), 0), COUNT(DISTINCT user_addr),
                       SUM(CASE WHEN usd IS NULL THEN 1 ELSE 0 END)
                FROM activity_events
                WHERE kind = 'swap' AND created_at >= :s
            """),
            {"s": since},
        ).fetchone()
        top_tokens = conn.execute(
            text("""
                SELECT sym, SUM(usd) AS vol FROM (
                    SELECT sym_in AS sym, usd FROM activity_events
                    WHERE kind = 'swap' AND created_at >= :s AND usd IS NOT NULL
                    UNION ALL
                    SELECT sym_out, usd FROM activity_events
                    WHERE kind = 'swap' AND created_at >= :s AND usd IS NOT NULL
                ) GROUP BY sym ORDER BY vol DESC LIMIT 3
            """),
            {"s": since},
        ).fetchall()
        largest = conn.execute(
            text("""
                SELECT sym_in, amt_in, sym_out, amt_out, usd, user_addr
                FROM activity_events
                WHERE kind = 'swap' AND created_at >= :s AND usd IS NOT NULL
                ORDER BY usd DESC LIMIT 1
            """),
            {"s": since},
        ).fetchone()
        liq = {
            kind: (cnt, vol)
            for kind, cnt, vol in conn.execute(
                text("""
                    SELECT kind, COUNT(*), COALESCE(SUM(usd), 0)
                    FROM activity_events
                    WHERE kind IN ('liq_add', 'liq_remove') AND created_at >= :s
                    GROUP BY kind
                """),
                {"s": since},
            ).fetchall()
        }
        bridges = conn.execute(
            text("""
                SELECT meta, sym_in, COUNT(*), COALESCE(SUM(amt_in), 0)
                FROM activity_events
                WHERE kind = 'bridge' AND created_at >= :s
                GROUP BY meta, sym_in
            """),
            {"s": since},
        ).fetchall()
        lending = conn.execute(
            text("""
                SELECT kind, COUNT(*), COALESCE(SUM(usd), 0)
                FROM activity_events
                WHERE kind LIKE 'lend_%' AND created_at >= :s
                GROUP BY kind
            """),
            {"s": since},
        ).fetchall()
        staking = {
            kind: (cnt, vol)
            for kind, cnt, vol in conn.execute(
                text("""
                    SELECT kind, COUNT(*), COALESCE(SUM(usd), 0)
                    FROM activity_events
                    WHERE kind IN ('stake', 'unstake') AND created_at >= :s
                    GROUP BY kind
                """),
                {"s": since},
            ).fetchall()
        }
        conversions = conn.execute(
            text("""
                SELECT COUNT(*), COALESCE(SUM(usd), 0),
                       COALESCE(SUM(amt_in), 0), COALESCE(SUM(amt_out), 0)
                FROM activity_events
                WHERE kind = 'convert' AND created_at >= :s
            """),
            {"s": since},
        ).fetchone()
        sol_buys = conn.execute(
            text("""
                SELECT COUNT(*), COALESCE(SUM(usd), 0), COUNT(DISTINCT user_addr),
                       SUM(CASE WHEN meta = 'new_holder' THEN 1 ELSE 0 END)
                FROM activity_events
                WHERE kind = 'pumpfun_buy' AND created_at >= :s
            """),
            {"s": since},
        ).fetchone()

    total = (
        swap_count
        + sum(c for c, _v in liq.values())
        + sum(row[2] for row in bridges)
        + sum(row[1] for row in lending)
        + sum(c for c, _v in staking.values())
        + (conversions[0] if conversions else 0)
        + (sol_buys[0] if sol_buys else 0)
    )
    if total == 0:
        return None

    # One block per kind of activity, blank line between them: Telegram sets
    # every line at the same weight, so eight stacked lines read as one
    # paragraph. The bold line of a block is its headline number; the bullets
    # under it are the detail, and a block with no detail is one line.
    blocks: list[list[str]] = []

    if swap_count:
        head = f"🔄 <b>{_plural(swap_count, 'swap')}</b> · {_fmt_usd(swap_vol)} · {_plural(traders, 'trader')}"
        if unpriced:
            head += f" · {unpriced} unpriced"
        block = [head]
        if top_tokens:
            block.append("• Top: " + " · ".join(
                f"{_esc(sym)} {_fmt_usd(vol)}" for sym, vol in top_tokens
            ))
        if largest:
            l_sin, l_ain, l_sout, l_aout, l_usd, l_user = largest
            block.append(
                f"• Largest: {_fmt_amount(l_ain)} {_esc(l_sin)} → "
                f"{_fmt_amount(l_aout)} {_esc(l_sout)} "
                f"({_fmt_usd(l_usd)}) by {_esc(_short_addr(l_user))}"
            )
        blocks.append(block)

    if liq:
        add_c, add_v = liq.get("liq_add", (0, 0))
        rem_c, rem_v = liq.get("liq_remove", (0, 0))
        # Only the side that happened: "-$0 removed (0)" is not information.
        sides = []
        if add_c:
            sides.append(f"+{_fmt_usd(add_v)} in ({add_c})")
        if rem_c:
            sides.append(f"-{_fmt_usd(rem_v)} out ({rem_c})")
        if sides:
            blocks.append(["💧 <b>Liquidity</b> " + " · ".join(sides)])

    if bridges:
        block = [f"🌉 <b>{_plural(sum(row[2] for row in bridges), 'bridge')}</b>"]
        for direction, sym, cnt, vol in bridges:
            suffix = f" ({cnt})" if cnt > 1 else ""
            block.append(
                f"• {_fmt_amount(vol)} {_esc(sym)} · "
                f"{_esc(_direction_label(direction or '?'))}{suffix}"
            )
        blocks.append(block)

    if lending:
        block = ["🏦 <b>Lending</b>"]
        for kind, cnt, vol in lending:
            block.append(f"• {_esc(kind.removeprefix('lend_'))} {_fmt_usd(vol)} ({cnt})")
        blocks.append(block)

    if staking:
        stake_c, stake_v = staking.get("stake", (0, 0))
        unstake_c, unstake_v = staking.get("unstake", (0, 0))
        sides = []
        if stake_c:
            sides.append(f"+{_fmt_usd(stake_v)} staked ({stake_c})")
        if unstake_c:
            sides.append(f"-{_fmt_usd(unstake_v)} unstaked ({unstake_c})")
        if sides:
            blocks.append(["🔒 <b>Staking</b> " + " · ".join(sides)])

    if conversions and conversions[0]:
        c_cnt, c_usd, c_in, c_out = conversions
        line = (
            f"🔁 <b>{_plural(c_cnt, 'conversion')}</b> · "
            f"{_fmt_amount(c_in)} CYBER.sol → {_fmt_amount(c_out)} CYBER"
        )
        if c_usd:
            line += f" · {_fmt_usd(c_usd)}"
        blocks.append([line])

    if sol_buys and sol_buys[0]:
        b_cnt, b_usd, b_buyers, b_new = sol_buys
        line = (
            f"🛒 <b>{b_cnt} {_esc(PUMPFUN_TOKEN_SYMBOL)} "
            f"{'buy' if b_cnt == 1 else 'buys'}</b> · {_fmt_usd(b_usd)} · "
            f"{_plural(b_buyers, 'buyer')}"
        )
        if b_new:
            line += f" · {b_new} new"
        blocks.append([line])

    prices = _market_price_block()
    if prices:
        blocks.append(prices)

    lines = [f"📊 <b>Cyberia · last {_esc(window_label)}</b>"]
    for block in blocks:
        lines.append("")
        lines.extend(block)

    return "\n".join(lines)
async def _digest_tick(bot) -> None:
    if DIGEST_INTERVAL_SECONDS <= 0:
        return
    now = datetime.now(timezone.utc)
    last_raw = _kv_get(_KV_LAST_DIGEST_AT)
    if last_raw is None:
        # Fresh install: start the window now instead of summarizing nothing.
        _kv_set(_KV_LAST_DIGEST_AT, now.strftime(_SQLITE_TS))
        return
    try:
        last = datetime.strptime(last_raw, _SQLITE_TS).replace(tzinfo=timezone.utc)
    except ValueError:
        _kv_set(_KV_LAST_DIGEST_AT, now.strftime(_SQLITE_TS))
        return
    elapsed = (now - last).total_seconds()
    if elapsed < DIGEST_INTERVAL_SECONDS:
        return

    since = last.strftime(_SQLITE_TS)
    digest = await asyncio.to_thread(_build_digest_text, since, _format_window(elapsed))
    if digest is None:
        # Quiet window: advance silently so the next digest doesn't double-count,
        # but keep the price base fresh.
        _kv_set(_KV_LAST_DIGEST_AT, now.strftime(_SQLITE_TS))
        await asyncio.to_thread(_cyber_price_line, True)
        logger.info(f"digest: no activity since {since}, skipping post")
        return

    price_line = await asyncio.to_thread(_cyber_price_line, False, False)
    if price_line:
        digest += "\n\n" + price_line

    try:
        await bot.send_message(
            chat_id=DIGEST_ANNOUNCE_CHAT, text=digest,
            parse_mode="HTML", disable_web_page_preview=True,
        )
    except TelegramError as e:
        logger.warning(f"digest: HTML rejected ({e}); sending it as plain text")
        try:
            await bot.send_message(
                chat_id=DIGEST_ANNOUNCE_CHAT, text=_plain(digest),
                disable_web_page_preview=True,
            )
        except TelegramError as plain_error:
            # Window stays open; the next tick retries with a wider range.
            logger.error(f"digest: send failed: {plain_error}")
            return

    _kv_set(_KV_LAST_DIGEST_AT, now.strftime(_SQLITE_TS))
    await asyncio.to_thread(_cyber_price_line, True)
    logger.info(f"digest: posted window since {since}")

    try:
        with engine.begin() as conn:
            conn.execute(
                text("DELETE FROM activity_events WHERE created_at < datetime('now', :cutoff)"),
                {"cutoff": f"-{DIGEST_RETENTION_DAYS} days"},
            )
    except Exception as e:
        logger.warning(f"digest: retention cleanup failed: {e}")


async def digest_loop(application: Application) -> None:
    while True:
        try:
            await _digest_tick(application.bot)
        except Exception as e:
            logger.error(f"digest_loop: {e}")
        await asyncio.sleep(60)
FACTORY_ENUM_ABI = [
    {"inputs": [], "name": "allPairsLength",
     "outputs": [{"name": "", "type": "uint256"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [{"name": "", "type": "uint256"}], "name": "allPairs",
     "outputs": [{"name": "", "type": "address"}],
     "stateMutability": "view", "type": "function"},
]

# (fetched_at, [(pair_addr, token0, token1), ...]). The factory's pair list
# only grows, so a long TTL is fine; reserves are re-read on every snapshot.
_all_pairs_cache: tuple[float, list[tuple[str, str, str]]] | None = None
_ALL_PAIRS_TTL_SECONDS = 600.0


def _get_all_pairs(w3: Web3) -> list[tuple[str, str, str]]:
    """Every pair in the Ritual factory. Cyberia has a few dozen, so straight
    enumeration is cheap, and pair→token reads hit _pair_token_cache."""
    global _all_pairs_cache
    now = time.time()
    if _all_pairs_cache is not None and now - _all_pairs_cache[0] < _ALL_PAIRS_TTL_SECONDS:
        return _all_pairs_cache[1]
    factory = w3.eth.contract(
        address=Web3.to_checksum_address(RITUAL_V2_FACTORY), abi=FACTORY_ENUM_ABI
    )
    count = factory.functions.allPairsLength().call()
    pairs: list[tuple[str, str, str]] = []
    for i in range(count):
        pair_addr = factory.functions.allPairs(i).call()
        tokens = _get_pair_tokens(w3, pair_addr)
        if tokens is not None:
            pairs.append((pair_addr, tokens[0], tokens[1]))
    _all_pairs_cache = (now, pairs)
    return pairs
def _take_market_snapshot(w3: Web3) -> tuple[int, int]:
    """Read every pool's reserves, price every token via the walker, and
    rewrite token_prices + dex_pools in one transaction. Blocking (a long
    chain of RPC reads) — call through asyncio.to_thread. Returns
    (pools_written, tokens_priced)."""
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    pool_rows: list[dict] = []
    token_addrs: set[str] = set()
    for pair_addr, t0, t1 in _get_all_pairs(w3):
        try:
            pair = w3.eth.contract(
                address=Web3.to_checksum_address(pair_addr), abi=PAIR_RESERVES_ABI
            )
            r0, r1, _ts = pair.functions.getReserves().call()
        except Exception as e:
            logger.debug(f"market_snapshot: getReserves {pair_addr} failed: {e}")
            continue
        sym0, dec0 = _get_token_meta(w3, t0)
        sym1, dec1 = _get_token_meta(w3, t1)
        token_addrs.add(t0)
        token_addrs.add(t1)
        pool_rows.append({
            "pair": pair_addr.lower(),
            "t0": t0.lower(), "t1": t1.lower(),
            "s0": sym0, "s1": sym1,
            "r0": r0 / 10**dec0, "r1": r1 / 10**dec1,
            "tvl": None,  # filled below once prices are known
            "ts": now,
        })

    prices: dict[str, float | None] = {}
    price_rows: list[dict] = []
    for addr in token_addrs:
        sym, _dec = _get_token_meta(w3, addr)
        try:
            price = _get_token_usd_price(w3, addr)
        except Exception as e:
            logger.debug(f"market_snapshot: price {addr} failed: {e}")
            price = None
        prices[addr.lower()] = price
        price_rows.append({"a": addr.lower(), "s": sym, "p": price, "ts": now})

    # TVL mirrors _liquidity_usd_volume: both sides of a constant-product pool
    # are equal in value, so a single priced side is simply doubled.
    for row in pool_rows:
        p0 = prices.get(row["t0"])
        p1 = prices.get(row["t1"])
        if p0 is not None and p1 is not None:
            row["tvl"] = row["r0"] * p0 + row["r1"] * p1
        elif p0 is not None:
            row["tvl"] = row["r0"] * p0 * 2
        elif p1 is not None:
            row["tvl"] = row["r1"] * p1 * 2

    with engine.begin() as conn:
        conn.execute(text("DELETE FROM token_prices"))
        if price_rows:
            conn.execute(
                text("""
                    INSERT INTO token_prices (address, symbol, price_usd, updated_at)
                    VALUES (:a, :s, :p, :ts)
                """),
                price_rows,
            )
        conn.execute(text("DELETE FROM dex_pools"))
        if pool_rows:
            conn.execute(
                text("""
                    INSERT INTO dex_pools
                        (pair_address, token0, token1, symbol0, symbol1,
                         reserve0, reserve1, tvl_usd, updated_at)
                    VALUES
                        (:pair, :t0, :t1, :s0, :s1, :r0, :r1, :tvl, :ts)
                """),
                pool_rows,
            )

    priced = sum(1 for p in prices.values() if p is not None)
    return len(pool_rows), priced


async def market_snapshot_loop(application: Application) -> None:
    while True:
        try:
            pools, priced = await asyncio.to_thread(
                _take_market_snapshot, Web3(Web3.HTTPProvider(RPC_URL))
            )
            logger.info(
                f"market_snapshot: {pools} pools, {priced} tokens priced"
            )
        except Exception as e:
            logger.error(f"market_snapshot_loop: {e}")
        await asyncio.sleep(MARKET_SNAPSHOT_SECONDS)
def _read_cyber_sol_raw(address: str) -> int:
    """Sum the owner's CYBER.sol balance (base units) via Solana RPC. Blocking —
    call through asyncio.to_thread from the event loop."""
    result = solana_rpc("getTokenAccountsByOwner", [
        address,
        {"mint": CYBER_SOL_MINT},
        {"encoding": "jsonParsed", "commitment": "confirmed"},
    ])
    total = 0
    for acc in ((result or {}).get("value") or []):
        amount = acc["account"]["data"]["parsed"]["info"]["tokenAmount"]["amount"]
        total += int(amount)
    return total
async def _issue_whale_invites(bot) -> None:
    """DM a single-use invite link to every verified whale not yet invited."""
    with engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT tg_user_id, solana_address, balance_raw
                FROM tg_sol_wallets
                WHERE is_whale = 1 AND invited = 0
            """)
        ).fetchall()

    for tg_user_id, address, balance_raw in rows:
        # Mint a single-use link. A failure here is chat-level (wrong
        # WHALE_CHAT_ID, or the bot is not an admin of the whales chat) and would
        # hit every pending whale, so abort the tick rather than logging the same
        # "Chat not found" once per row.
        try:
            link = await bot.create_chat_invite_link(
                WHALE_CHAT_ID,
                member_limit=1,
                expire_date=int(time.time()) + 3600,
                name=f"whale {tg_user_id}",
            )
        except Exception as e:
            logger.error(
                "whale: cannot create invite link for WHALE_CHAT_ID=%s — verify the id "
                "(supergroups are -100…) and that the bot is an admin there with "
                "'Invite Users via Link': %s",
                WHALE_CHAT_ID, e,
            )
            return

        # DM the link. A failure here is per-user (they never started the bot, or
        # blocked it); skip them and keep going.
        try:
            human = int(balance_raw) / 10 ** CYBER_SOL_DECIMALS
            await bot.send_message(
                tg_user_id,
                f"Verified: {human:,.0f} CYBER.sol on {address[:4]}…{address[-4:]}.\n"
                f"One-time invite to the whales chat:\n{link.invite_link}",
            )
        except Exception as e:
            logger.error(
                "whale: cannot DM invite to user=%s (have they started the bot?): %s",
                tg_user_id, e,
            )
            continue

        with engine.begin() as conn:
            conn.execute(
                text("UPDATE tg_sol_wallets SET invited = 1 WHERE tg_user_id = :u"),
                {"u": tg_user_id},
            )
        logger.info("whale: invited user=%s balance_raw=%s", tg_user_id, balance_raw)


async def _kick_from_whales(bot, tg_user_id: int) -> None:
    """Remove a user from the whales chat (kick, not perma-ban) and reset their
    invite flag so they can rejoin if they top up. Admins are never kicked."""
    try:
        member = await bot.get_chat_member(WHALE_CHAT_ID, tg_user_id)
        status = member.status
    except Exception:
        status = "left"

    if status in ("creator", "administrator"):
        return
    if status not in ("left", "kicked"):
        try:
            await bot.ban_chat_member(WHALE_CHAT_ID, tg_user_id)
            await bot.unban_chat_member(WHALE_CHAT_ID, tg_user_id)
            logger.info("whale: kicked user=%s (below threshold)", tg_user_id)
            try:
                await bot.send_message(
                    tg_user_id,
                    "Your CYBER.sol balance dropped below the whale threshold, so you were "
                    "removed from the whales chat. Top up and run /whale to rejoin.",
                )
            except Exception:
                pass
        except Exception as e:
            logger.error("whale: kick failed user=%s: %s", tg_user_id, e)

    with engine.begin() as conn:
        conn.execute(
            text("UPDATE tg_sol_wallets SET invited = 0 WHERE tg_user_id = :u"),
            {"u": tg_user_id},
        )


async def _recheck_whales(bot) -> None:
    """Re-read on-chain balances for rows staler than WHALE_RECHECK_SECONDS and
    kick anyone who fell below the threshold."""
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=WHALE_RECHECK_SECONDS)).strftime("%Y-%m-%d %H:%M:%S")
    with engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT tg_user_id, solana_address, is_whale
                FROM tg_sol_wallets
                WHERE last_checked_at IS NULL OR last_checked_at < :cutoff
            """),
            {"cutoff": cutoff},
        ).fetchall()

    for tg_user_id, address, was_whale in rows:
        try:
            raw = await asyncio.to_thread(_read_cyber_sol_raw, address)
        except Exception as e:
            logger.warning("whale recheck: balance read failed for %s: %s", address, e)
            continue
        is_whale = 1 if raw >= WHALE_MIN_RAW else 0
        with engine.begin() as conn:
            conn.execute(
                text("""
                    UPDATE tg_sol_wallets
                    SET balance_raw = :b, is_whale = :w, last_checked_at = datetime('now')
                    WHERE tg_user_id = :u
                """),
                {"b": str(raw), "w": is_whale, "u": tg_user_id},
            )
        if was_whale and not is_whale:
            await _kick_from_whales(bot, tg_user_id)


async def whale_loop(application: Application) -> None:
    bot = application.bot
    # One-time self-check so a misconfigured WHALE_CHAT_ID surfaces clearly on
    # startup instead of as a recurring per-user "Chat not found".
    try:
        chat = await bot.get_chat(WHALE_CHAT_ID)
        me = await bot.get_me()
        member = await bot.get_chat_member(WHALE_CHAT_ID, me.id)
        logger.info(
            "Whale chat reachable: %r (id=%s); bot status=%s",
            chat.title, WHALE_CHAT_ID, member.status,
        )
        if member.status not in ("administrator", "creator"):
            logger.warning(
                "whale: bot is not an admin in WHALE_CHAT_ID=%s — it cannot create "
                "invite links; grant it 'Invite Users via Link'",
                WHALE_CHAT_ID,
            )
    except Exception as e:
        logger.error(
            "whale: WHALE_CHAT_ID=%s is unreachable — add the bot to that chat as an "
            "admin and verify the id (supergroups are -100…): %s",
            WHALE_CHAT_ID, e,
        )

    while True:
        try:
            await _issue_whale_invites(application.bot)
            await _recheck_whales(application.bot)
        except Exception as e:
            logger.error(f"whale_loop: {e}")
        await asyncio.sleep(WHALE_POLL_SECONDS)
def run_snapshot_once() -> None:
    """Refresh the analytics market snapshot (token_prices + dex_pools) once and
    exit. Needs only RPC + the shared SQLite DB — no Telegram token, no polling —
    so it can be run by hand or from cron to populate the /analytics page
    independently of the long-running bot."""
    logging.basicConfig(level=logging.INFO)
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    pools, priced = _take_market_snapshot(w3)
    logger.info(f"snapshot-once: {pools} pools, {priced} tokens priced -> {DB_PATH}")
