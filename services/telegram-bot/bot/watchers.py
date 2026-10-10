"""Record-only watchers: on-chain actions that get no Telegram post of their own
but belong in the wallet's feed and its push.

Every row written to `activity_events` is pushed to everyone by Laravel's
`feed:announce-activity` and shown in the wallet's feed, so "recording" is the
whole job here — swaps, liquidity, lending, staking, conversions and bridges
already have their own announcers in announcers.py; this covers the rest of
what people do on Cyberia's own contracts: mint an NFT, buy one on the market,
register a domain, open a domain zone, open a prediction market, bet on one.

Each watcher is one contract and one event. It keeps its own `block:log_index`
cursor in bot_kv, starts at the chain head on its first run (history is not
news), and moves the cursor only past rows it has written, so an RPC that
blinks mid-range resumes where it stopped. Ticks run in a worker thread: one
slow node call must not freeze the bot's dispatcher.
"""
import asyncio
import logging
from dataclasses import dataclass
from typing import Callable

from web3 import Web3

from bot.config import (
    RPC_URL, DEPLOYER_PK,
    CYBERIA_NFT_ADDRESS, NFT_MARKET_ADDRESS, CYBERIA_DOMAINS_ADDRESS,
    PREDICTION_MARKET_ADDRESS, WCYBER_ADDRESS,
    EVENT_WATCH_POLL_SECONDS, EVENT_WATCH_MAX_BLOCK_RANGE,
)
from bot.db import _record_activity, _get_block_cursor, _set_block_cursor
from bot.chain import (
    _event_topic, _hex_no_prefix, _decode_topic_address, _decode_data_words,
    _decode_abi_string, _get_token_meta, _get_token_usd_price, _get_tx_sender,
)

logger = logging.getLogger(__name__)

# The key the bot itself mints channel posts with: those NFTs are the project's
# own automation echoing a post everybody already saw, not somebody's action.
try:
    _OWN_MINTER = Web3().eth.account.from_key(DEPLOYER_PK).address.lower() if DEPLOYER_PK else None
except Exception:
    _OWN_MINTER = None

LISTING_ABI = [{
    "inputs": [{"name": "", "type": "uint256"}], "name": "listings",
    "outputs": [
        {"name": "nft", "type": "address"},
        {"name": "tokenId", "type": "uint256"},
        {"name": "seller", "type": "address"},
        {"name": "paymentToken", "type": "address"},
        {"name": "price", "type": "uint256"},
        {"name": "active", "type": "bool"},
    ],
    "stateMutability": "view", "type": "function",
}]


@dataclass(frozen=True)
class Watcher:
    kind: str
    address: str
    signature: str
    decode: Callable[[Web3, dict], dict | None]

    @property
    def topic(self) -> str:
        return _event_topic(self.signature)

    @property
    def cursor_key(self) -> str:
        return f"last_watched_{self.kind}_cursor"


def _tx_hash(log) -> str:
    return "0x" + _hex_no_prefix(log["transactionHash"]).lower()


def _topic_int(log, index: int) -> int:
    return int(_hex_no_prefix(log["topics"][index]), 16)


def _cyber_usd(w3: Web3, wei: int) -> float | None:
    """Native CYBER is priced as WCYBER — one for one."""
    price = _get_token_usd_price(w3, WCYBER_ADDRESS) if WCYBER_ADDRESS else None
    return (wei / 10**18) * price if price is not None else None


def _base(kind: str, log, user: str | None) -> dict:
    return dict(kind=kind, user_addr=user, tx_hash=_tx_hash(log), block=int(log["blockNumber"]))


def _decode_nft_mint(w3: Web3, log) -> dict | None:
    # Minted(uint256 indexed tokenId, address indexed creator, string uri)
    creator = _decode_topic_address(log["topics"][2])
    if _OWN_MINTER and creator.lower() == _OWN_MINTER:
        return None
    return {**_base("nft_mint", log, creator), "meta": f"#{_topic_int(log, 1)}"}


def _decode_nft_sale(w3: Web3, log) -> dict | None:
    # Sold(uint256 indexed listingId, address indexed buyer, uint256 price)
    listing_id = _topic_int(log, 1)
    buyer = _decode_topic_address(log["topics"][2])
    price = _decode_data_words(log["data"], 1)[0]
    row = {**_base("nft_sale", log, buyer), "meta": f"listing #{listing_id}"}
    try:
        market = w3.eth.contract(address=Web3.to_checksum_address(log["address"]), abi=LISTING_ABI)
        nft, token_id, _seller, payment, _price, _active = market.functions.listings(listing_id).call()
        sym, dec = _get_token_meta(w3, payment)
        usd_price = _get_token_usd_price(w3, payment)
        row.update(
            sym_in=sym, amt_in=price / 10**dec,
            usd=(price / 10**dec) * usd_price if usd_price is not None else None,
            meta=f"#{token_id}",
        )
    except Exception as e:
        logger.warning(f"watcher nft_sale: listing {listing_id} unreadable: {e}")
    return row


def _decode_domain(w3: Web3, log) -> dict | None:
    # DomainRegistered(uint256 indexed tokenId, string label, string zone,
    #                  address indexed owner, uint256 paid)
    label = _decode_abi_string(log["data"], 0)
    zone = _decode_abi_string(log["data"], 1)
    owner = _decode_topic_address(log["topics"][2])
    name = f"{label}.{zone}" if label and zone else (label or zone)
    return {**_base("domain", log, owner), "meta": name}


def _decode_zone(w3: Web3, log) -> dict | None:
    # ZoneCreated(string zone, address indexed token) — permissionless, so the
    # one who opened it is whoever sent the transaction.
    zone = _decode_abi_string(log["data"], 0)
    tx = _tx_hash(log)
    return {**_base("zone", log, _get_tx_sender(w3, tx)), "meta": f".{zone}" if zone else None}


def _decode_market(w3: Web3, log) -> dict | None:
    # MarketCreated(uint256 indexed id, address indexed creator, string question, uint64 closeTime)
    creator = _decode_topic_address(log["topics"][2])
    question = _decode_abi_string(log["data"], 0)
    return {**_base("predict_market", log, creator), "meta": question}


def _decode_bet(w3: Web3, log) -> dict | None:
    # BetPlaced(uint256 indexed id, address indexed user, bool yes, uint256 amount)
    market_id = _topic_int(log, 1)
    user = _decode_topic_address(log["topics"][2])
    yes, amount = _decode_data_words(log["data"], 2)
    return {
        **_base("predict_bet", log, user),
        "sym_in": "CYBER", "amt_in": amount / 10**18, "usd": _cyber_usd(w3, amount),
        "meta": f"{'YES' if yes else 'NO'} · market #{market_id}",
    }


WATCHERS = [
    w for w in (
        Watcher("nft_mint", CYBERIA_NFT_ADDRESS, "Minted(uint256,address,string)", _decode_nft_mint),
        Watcher("nft_sale", NFT_MARKET_ADDRESS, "Sold(uint256,address,uint256)", _decode_nft_sale),
        Watcher("domain", CYBERIA_DOMAINS_ADDRESS,
                "DomainRegistered(uint256,string,string,address,uint256)", _decode_domain),
        Watcher("zone", CYBERIA_DOMAINS_ADDRESS, "ZoneCreated(string,address)", _decode_zone),
        Watcher("predict_market", PREDICTION_MARKET_ADDRESS,
                "MarketCreated(uint256,address,string,uint64)", _decode_market),
        Watcher("predict_bet", PREDICTION_MARKET_ADDRESS, "BetPlaced(uint256,address,bool,uint256)", _decode_bet),
    )
    if w.address
]


def watch_tick(w3: Web3, watcher: Watcher) -> int:
    """Read one watcher's next block range and record what happened in it.
    Returns how many rows were written."""
    latest = w3.eth.block_number
    cursor = _get_block_cursor(watcher.cursor_key)
    if cursor is None:
        _set_block_cursor(watcher.cursor_key, latest, 10**9)
        logger.info(f"watcher {watcher.kind}: bootstrapped cursor to head block={latest}")
        return 0
    cur_block, cur_idx = cursor
    if cur_block > latest:
        return 0

    end = min(cur_block + EVENT_WATCH_MAX_BLOCK_RANGE - 1, latest)
    logs = w3.eth.get_logs({
        "address": Web3.to_checksum_address(watcher.address),
        "fromBlock": cur_block,
        "toBlock": end,
        "topics": [watcher.topic],
    })

    written = 0
    for log in sorted(logs, key=lambda l: (int(l["blockNumber"]), int(l["logIndex"]))):
        position = (int(log["blockNumber"]), int(log["logIndex"]))
        if position <= (cur_block, cur_idx):
            continue
        try:
            row = watcher.decode(w3, log)
        except Exception as e:
            logger.error(f"watcher {watcher.kind}: decode failed tx={_tx_hash(log)}: {e}")
            row = None
        if row is not None:
            _record_activity(**row)
            written += 1
        _set_block_cursor(watcher.cursor_key, *position)
        cur_block, cur_idx = position

    if end > cur_block:
        _set_block_cursor(watcher.cursor_key, end, 10**9)
    return written


async def event_watcher_loop(application) -> None:
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    while True:
        for watcher in WATCHERS:
            try:
                written = await asyncio.to_thread(watch_tick, w3, watcher)
                if written:
                    logger.info(f"watcher {watcher.kind}: recorded {written}")
            except Exception as e:
                logger.error(f"watcher {watcher.kind}: {e}")
        await asyncio.sleep(EVENT_WATCH_POLL_SECONDS)
