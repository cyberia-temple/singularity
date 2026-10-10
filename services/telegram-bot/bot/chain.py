"""EVM chain access: web3 client helpers, ABIs, log decoders, and the on-chain
USD price walker. No database access."""
import logging
import time

from web3 import Web3

from bot.config import (
    RITUAL_V2_FACTORY,
    RITUAL_V2_ROUTER,
    USD_ANCHORS,
    PRICE_RELAY_TOKENS,
    PRICE_MIN_POOL_USD,
    LENDING_COMPTROLLER,
)

logger = logging.getLogger(__name__)


# --- Ritual DEX swap announcer ---------------------------------------------

# keccak256("Swap(address,uint256,uint256,uint256,uint256,address)").
# Normalize to "0x..." since hexbytes' `.hex()` adds the prefix in 1.x but not
# in older releases, and eth_getLogs expects 0x-prefixed topic hex.
_swap_topic_hex = Web3.keccak(
    text="Swap(address,uint256,uint256,uint256,uint256,address)"
).hex()
SWAP_EVENT_TOPIC = "0x" + _swap_topic_hex.removeprefix("0x").removeprefix("0X")

# The PancakeV3 pool's Swap: signed amounts (positive = into the pool), then
# price, liquidity, tick and the two protocol fees this fork adds.
_v3_swap_topic_hex = Web3.keccak(
    text="Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)"
).hex()
V3_SWAP_EVENT_TOPIC = "0x" + _v3_swap_topic_hex.removeprefix("0x").removeprefix("0X")

PAIR_ABI = [
    {"inputs": [], "name": "token0",
     "outputs": [{"name": "", "type": "address"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "token1",
     "outputs": [{"name": "", "type": "address"}],
     "stateMutability": "view", "type": "function"},
]
ERC20_META_ABI = [
    {"inputs": [], "name": "symbol",
     "outputs": [{"name": "", "type": "string"}],
     "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "decimals",
     "outputs": [{"name": "", "type": "uint8"}],
     "stateMutability": "view", "type": "function"},
]

# Long-lived process: caching pair→tokens and token→(symbol,decimals) cuts the
# RPC chatter from "4 calls per swap" to ~zero once the active set is warm.
_pair_token_cache: dict[str, tuple[str, str]] = {}
_token_meta_cache: dict[str, tuple[str, int]] = {}
def next_nonce(w3: Web3, address: str) -> int:
    """The nonce to sign with — from `latest`, deliberately not `pending`.

    This chain's node answers a pending count as `latest` plus the number of
    the account's transactions sitting in its pool, *regardless of the nonces
    those carry*. One transaction that can never execute therefore raises
    every later answer by one, and each new signature lands further out of
    reach: on 2026-09-14 the gap on the shared relayer key reached 512, every
    mint and payout from it stopped landing for forty minutes, and a /claim
    waiting 180s on a receipt that could never arrive froze the whole bot,
    because the dispatcher is sequential.

    `latest` can collide with a transaction broadcast a second earlier, which
    the node rejects outright as `nonce too low`. That is the trade being
    made on purpose: a rejection is one lost transaction and is recoverable,
    a nonce gap is permanent and takes the account with it.
    """
    return w3.eth.get_transaction_count(Web3.to_checksum_address(address), "latest")


def _get_pair_tokens(w3: Web3, pair_addr: str) -> tuple[str, str] | None:
    addr = Web3.to_checksum_address(pair_addr)
    cached = _pair_token_cache.get(addr)
    if cached is not None:
        return cached
    try:
        pair = w3.eth.contract(address=addr, abi=PAIR_ABI)
        t0 = pair.functions.token0().call()
        t1 = pair.functions.token1().call()
    except Exception as e:
        logger.warning(f"swap_announcer: pair {addr} token0/1 failed: {e}")
        return None
    _pair_token_cache[addr] = (t0, t1)
    return t0, t1
def _get_token_meta(w3: Web3, token_addr: str) -> tuple[str, int]:
    addr = Web3.to_checksum_address(token_addr)
    cached = _token_meta_cache.get(addr)
    if cached is not None:
        return cached
    c = w3.eth.contract(address=addr, abi=ERC20_META_ABI)
    try:
        sym = c.functions.symbol().call()
    except Exception:
        sym = addr[:6] + "..." + addr[-4:]
    try:
        dec = int(c.functions.decimals().call())
    except Exception:
        dec = 18
    meta = (sym, dec)
    _token_meta_cache[addr] = meta
    return meta
def _hex_no_prefix(value) -> str:
    if isinstance(value, (bytes, bytearray)):
        return value.hex()
    s = str(value)
    if s.startswith("0x") or s.startswith("0X"):
        return s[2:]
    return s
def _decode_topic_address(topic) -> str:
    h = _hex_no_prefix(topic).lower()
    return Web3.to_checksum_address("0x" + h[-40:])
def _decode_swap_data(data) -> tuple[int, int, int, int]:
    """V2 Swap data: four uint256 words — amount0In, amount1In, amount0Out, amount1Out."""
    h = _hex_no_prefix(data)
    return (
        int(h[0:64], 16),
        int(h[64:128], 16),
        int(h[128:192], 16),
        int(h[192:256], 16),
    )
FACTORY_GET_PAIR_ABI = [{
    "inputs": [
        {"name": "tokenA", "type": "address"},
        {"name": "tokenB", "type": "address"},
    ],
    "name": "getPair",
    "outputs": [{"name": "pair", "type": "address"}],
    "stateMutability": "view", "type": "function",
}]
PAIR_RESERVES_ABI = [{
    "inputs": [], "name": "getReserves",
    "outputs": [
        {"name": "reserve0", "type": "uint112"},
        {"name": "reserve1", "type": "uint112"},
        {"name": "blockTimestampLast", "type": "uint32"},
    ],
    "stateMutability": "view", "type": "function",
}]

# token_addr_lower → (usd_price | None, fetched_at_ts). `None` means "looked
# up but no priceable route" — cached to avoid retrying every block.
_token_usd_price_cache: dict[str, tuple[float | None, float]] = {}
_TOKEN_USD_TTL_SECONDS = 300.0
def _get_token_usd_price(w3: Web3, token_addr: str, _depth: int = 0) -> float | None:
    """USD price of one whole token. Anchors return 1.0; otherwise walks at
    most one hop via a relay token to reach an anchor. Pools whose anchor/relay
    side holds less than PRICE_MIN_POOL_USD are ignored (dust pools have
    meaningless reserve ratios); among the rest the deepest pool wins.
    Cached for 5 min."""
    addr = token_addr.lower()
    if addr in USD_ANCHORS:
        return 1.0
    now = time.time()
    cached = _token_usd_price_cache.get(addr)
    if cached is not None and now - cached[1] < _TOKEN_USD_TTL_SECONDS:
        return cached[0]
    if _depth >= 2:
        return None

    factory = w3.eth.contract(
        address=Web3.to_checksum_address(RITUAL_V2_FACTORY), abi=FACTORY_GET_PAIR_ABI
    )

    def price_via(target_addr: str, target_price_usd: float) -> tuple[float, float] | None:
        """(price, depth_usd) via the token's direct pool with `target`, where
        depth_usd is the USD value of the pool's target-side reserve — the
        walker's confidence in this route."""
        try:
            pair_addr = factory.functions.getPair(
                Web3.to_checksum_address(token_addr),
                Web3.to_checksum_address(target_addr),
            ).call()
        except Exception:
            return None
        if not pair_addr or int(pair_addr, 16) == 0:
            return None
        try:
            pair = w3.eth.contract(
                address=Web3.to_checksum_address(pair_addr), abi=PAIR_RESERVES_ABI
            )
            reserves = pair.functions.getReserves().call()
        except Exception:
            return None
        tokens = _get_pair_tokens(w3, pair_addr)
        if tokens is None:
            return None
        t0, _t1 = tokens
        _, dec_token = _get_token_meta(w3, token_addr)
        _, dec_target = _get_token_meta(w3, target_addr)
        if t0.lower() == addr:
            r_token, r_target = reserves[0], reserves[1]
        else:
            r_token, r_target = reserves[1], reserves[0]
        if r_token <= 0 or r_target <= 0:
            return None
        depth_usd = (r_target / 10**dec_target) * target_price_usd
        if depth_usd < PRICE_MIN_POOL_USD:
            return None
        price = (r_target / 10**dec_target) / (r_token / 10**dec_token) * target_price_usd
        return price, depth_usd

    routes: list[tuple[float, float]] = []

    for anchor in USD_ANCHORS:
        r = price_via(anchor, 1.0)
        if r is not None and r[0] > 0:
            routes.append(r)

    for relay in PRICE_RELAY_TOKENS:
        if relay == addr:
            continue
        relay_price = _get_token_usd_price(w3, relay, _depth=_depth + 1)
        if relay_price is None or relay_price <= 0:
            continue
        r = price_via(relay, relay_price)
        if r is not None and r[0] > 0:
            routes.append(r)

    price = max(routes, key=lambda r: r[1])[0] if routes else None
    # A None computed mid-recursion may be an artifact of the depth guard, not
    # a real "no route" — caching it would poison the token for the TTL.
    if price is not None or _depth == 0:
        _token_usd_price_cache[addr] = (price, now)
    return price
def _swap_usd_volume(
    w3: Web3,
    in_addr: str, in_amt: int, in_dec: int,
    out_addr: str, out_amt: int, out_dec: int,
) -> float | None:
    """USD value of a swap. Prefers pricing the input side (closer to user
    intent), falls back to the output side. Returns None if neither can be
    priced — caller decides whether to allow through."""
    in_price = _get_token_usd_price(w3, in_addr)
    if in_price is not None:
        return (in_amt / 10**in_dec) * in_price
    out_price = _get_token_usd_price(w3, out_addr)
    if out_price is not None:
        return (out_amt / 10**out_dec) * out_price
    return None
def _liquidity_usd_volume(
    w3: Web3,
    t0_addr: str, t1_addr: str,
    dec0: int, dec1: int,
    amount0: int, amount1: int,
) -> float | None:
    """USD value of a Mint/Burn. Both sides equal in a constant-product pool,
    so if only one side can be priced we double it."""
    p0 = _get_token_usd_price(w3, t0_addr)
    p1 = _get_token_usd_price(w3, t1_addr)
    val0 = (amount0 / 10**dec0) * p0 if p0 is not None else None
    val1 = (amount1 / 10**dec1) * p1 if p1 is not None else None
    if val0 is None and val1 is None:
        return None
    if val0 is None:
        return val1 * 2  # type: ignore[operator]
    if val1 is None:
        return val0 * 2
    return val0 + val1
def _router_topic_hex() -> str:
    return _address_topic_hex(RITUAL_V2_ROUTER)


def _address_topic_hex(address: str) -> str:
    """An address as an indexed-topic filter: left-padded to 32 bytes."""
    return "0x" + address.lower().replace("0x", "").rjust(64, "0")


def _decode_v3_swap_data(data) -> tuple[int, int]:
    """V3 Swap data: the first two words are int256 amount0 / amount1, signed
    from the pool's side — positive went in, negative came out."""
    h = _hex_no_prefix(data)

    def signed(word: str) -> int:
        value = int(word, 16)
        return value - (1 << 256) if value >= (1 << 255) else value

    return signed(h[0:64]), signed(h[64:128])


def _decode_abi_string(data, head_word: int) -> str | None:
    """A dynamic `string` out of an event's data, found through the offset in
    head word `head_word`. None rather than raising on anything malformed."""
    h = _hex_no_prefix(data)
    try:
        offset = int(h[head_word * 64:(head_word + 1) * 64], 16) * 2
        length = int(h[offset:offset + 64], 16)
        raw = bytes.fromhex(h[offset + 64:offset + 64 + length * 2])
    except (ValueError, IndexError):
        return None
    if len(raw) != length:
        return None
    text = raw.decode("utf-8", errors="replace")
    return "".join(ch for ch in text if ch.isprintable()).strip() or None
def _decode_data_words(data, n: int) -> list[int]:
    """Decode the first `n` 32-byte words of an event's data blob to ints."""
    h = _hex_no_prefix(data)
    return [int(h[i * 64:(i + 1) * 64], 16) for i in range(n)]
def _event_topic(signature: str) -> str:
    """0x-prefixed keccak topic for an event signature. Normalizes the prefix
    since hexbytes' `.hex()` adds `0x` in 1.x but not in older releases."""
    return "0x" + Web3.keccak(text=signature).hex().removeprefix("0x").removeprefix("0X")
# Cache tx hash → initiating EOA so re-scanned/multi-event txs cost one lookup.
_tx_sender_cache: dict[str, str] = {}


def _get_tx_sender(w3: Web3, tx_hash: str) -> str | None:
    cached = _tx_sender_cache.get(tx_hash)
    if cached is not None:
        return cached
    try:
        tx = w3.eth.get_transaction(tx_hash)
        sender = Web3.to_checksum_address(tx["from"])
    except Exception as e:
        logger.warning(f"liquidity_announcer: get_transaction {tx_hash} failed: {e}")
        return None
    _tx_sender_cache[tx_hash] = sender
    return sender
GET_ALL_MARKETS_ABI = [{
    "inputs": [], "name": "getAllMarkets",
    "outputs": [{"name": "", "type": "address[]"}],
    "stateMutability": "view", "type": "function",
}]
UNDERLYING_ABI = [{
    "inputs": [], "name": "underlying",
    "outputs": [{"name": "", "type": "address"}],
    "stateMutability": "view", "type": "function",
}]
_market_underlying_cache: dict[str, str] = {}


def _get_lending_markets(w3: Web3) -> list[str]:
    c = w3.eth.contract(
        address=Web3.to_checksum_address(LENDING_COMPTROLLER), abi=GET_ALL_MARKETS_ABI
    )
    return [Web3.to_checksum_address(m) for m in c.functions.getAllMarkets().call()]


def _get_market_underlying(w3: Web3, market_addr: str) -> str | None:
    addr = Web3.to_checksum_address(market_addr)
    cached = _market_underlying_cache.get(addr)
    if cached is not None:
        return cached
    try:
        c = w3.eth.contract(address=addr, abi=UNDERLYING_ABI)
        underlying = Web3.to_checksum_address(c.functions.underlying().call())
    except Exception as e:
        logger.warning(f"lending_announcer: underlying() failed for {addr}: {e}")
        return None
    _market_underlying_cache[addr] = underlying
    return underlying
