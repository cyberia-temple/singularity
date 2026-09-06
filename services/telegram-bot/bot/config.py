"""Configuration: environment variables, contract ABIs/topics, logging.

All runtime tunables are read from the environment here so the rest of the
package can `from bot.config import NAME`. The .env file is discovered from a
few candidate locations so both the clean `python -m bot` launch and the legacy
scripts/python shim find the right one.
"""
import os
import sys
import logging
from pathlib import Path

from dotenv import dotenv_values, load_dotenv
from web3 import Web3

_PKG_DIR = Path(__file__).resolve().parent           # services/telegram-bot/bot
_SVC_DIR = _PKG_DIR.parent                            # services/telegram-bot

# .env discovery: first existing wins. BOT_ENV_FILE overrides everything; the
# legacy scripts/python/.env keeps the prod shim working unchanged.
for _candidate in (
    os.environ.get("BOT_ENV_FILE"),
    _SVC_DIR / ".env",
    _PKG_DIR / ".env",
    _SVC_DIR.parents[1] / "scripts" / "python" / ".env",
):
    if _candidate and Path(_candidate).is_file():
        load_dotenv(_candidate)
        break


# Required to run the Telegram bot itself, but NOT to refresh the analytics
# market snapshot (see `--snapshot-once`), so the check is deferred to
# run_dispatcher() instead of failing at import time.
TELEGRAM_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")

CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID")
HTTP_PROXY = os.environ.get("HTTP_PROXY")

DB_PATH = os.environ.get("DB_PATH", "/home/lain/random/singularity/backend/laravel/database/database.sqlite")

TOKEN_ADDRESS = os.environ.get(
    "TG_TOKEN_ADDRESS", "0x4A3B5919e60fd290172955753DdA9216E396170A"
).strip() or None
TOKEN_ABI = [
    {
        "inputs": [
            {"name": "to", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "name": "mint",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "symbol",
        "outputs": [{"name": "", "type": "string"}],
        "stateMutability": "view",
        "type": "function",
    },
]

RPC_URL = os.environ.get("RPC_URL", "https://rpc.cyberia.church")
CHAIN_ID = int(os.environ.get("CHAIN_ID", "49406"))
EXPLORER_URL = os.environ.get("EXPLORER_URL", "https://explorer.cyberia.church").rstrip("/")

TELEGRAM_TOKEN_FACTORY = os.environ.get("TELEGRAM_TOKEN_FACTORY")
DEPLOYER_PK = os.environ.get("DEPLOYER_PK")

FACTORY_ABI = [
    {
        "inputs": [
            {"name": "name_", "type": "string"},
            {"name": "symbol_", "type": "string"},
            {"name": "tokenOwner", "type": "address"},
        ],
        "name": "createToken",
        "outputs": [{"name": "token", "type": "address"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True, "name": "token", "type": "address"},
            {"indexed": True, "name": "owner", "type": "address"},
            {"indexed": False, "name": "name", "type": "string"},
            {"indexed": False, "name": "symbol", "type": "string"},
        ],
        "name": "TokenCreated",
        "type": "event",
    },
]

TOKEN_CREATED_TOPIC = Web3.keccak(text="TokenCreated(address,address,string,string)").hex()

MIN_REWARDS_INTERVAL_SECONDS = int(os.environ.get("MIN_REWARDS_INTERVAL_SECONDS", "60"))
MAX_REWARDS_INTERVAL_SECONDS = int(os.environ.get("MAX_REWARDS_INTERVAL_SECONDS", str(30 * 24 * 3600)))

# Public chat where successful bridge txs are announced.
BRIDGE_ANNOUNCE_CHAT = os.environ.get("BRIDGE_ANNOUNCE_CHAT", "@cyberia_network_chat")
BRIDGE_POLL_SECONDS = int(os.environ.get("BRIDGE_POLL_SECONDS", "30"))
SOLSCAN_URL = os.environ.get("SOLSCAN_URL", "https://solscan.io").rstrip("/")

# Ritual DEX (Quickswap V2 fork on Cyberia) swap announcer.
SWAP_ANNOUNCE_CHAT = os.environ.get("SWAP_ANNOUNCE_CHAT", BRIDGE_ANNOUNCE_CHAT)
SWAP_POLL_SECONDS = int(os.environ.get("SWAP_POLL_SECONDS", "30"))
RITUAL_V2_ROUTER = os.environ.get(
    "RITUAL_V2_ROUTER", "0x8bECfB12Ab113586D8deD3D343aEfFd8eD54FD62"
)
RITUAL_V2_FACTORY = os.environ.get(
    "RITUAL_V2_FACTORY", "0xB0aC30907c04b61F1482e62eA66eF4562a690917"
)

# Don't announce swap/liquidity events whose USD volume is below this. Set to 0
# to disable the filter. Default: $1 — drops dust noise from cheap launchpad
# memecoins paired against CYBER.sol.
MIN_ANNOUNCE_USD = float(os.environ.get("MIN_ANNOUNCE_USD", "1.0"))

# Per-event posts are reserved for events at/above this USD value. Everything
# below it (but above MIN_ANNOUNCE_USD's dust floor) is recorded in
# activity_events and only surfaces in the periodic digest. Set to 0 to post
# every event individually (the old behaviour).
BIG_ANNOUNCE_USD = float(os.environ.get("BIG_ANNOUNCE_USD", "10.0"))

# Periodic on-chain activity digest: swap volume, top tokens, liquidity flows,
# bridges, lending and the CYBER price — one summary message instead of a
# stream of per-event posts. Set DIGEST_INTERVAL_SECONDS=0 to disable.
DIGEST_ANNOUNCE_CHAT = os.environ.get("DIGEST_ANNOUNCE_CHAT", BRIDGE_ANNOUNCE_CHAT)
DIGEST_INTERVAL_SECONDS = int(os.environ.get("DIGEST_INTERVAL_SECONDS", str(6 * 3600)))
# Recorded events older than this are pruned (the digest never looks that far back).
DIGEST_RETENTION_DAYS = int(os.environ.get("DIGEST_RETENTION_DAYS", "30"))
# Hide tiny price wiggles in the regular digest. Default: 100 bps = 1%.
DIGEST_PRICE_CHANGE_MIN_BPS = int(os.environ.get("DIGEST_PRICE_CHANGE_MIN_BPS", "100"))
# Number of priced tokens to include in the digest's market line.
DIGEST_PRICE_TOKEN_LIMIT = max(0, int(os.environ.get("DIGEST_PRICE_TOKEN_LIMIT", "8")))

# Tokens pegged to $1 — anchor points for the price walker. Comma-separated
# addresses. Default: USDC + USDT on Cyberia.
USD_ANCHORS = {
    a.strip().lower()
    for a in os.environ.get(
        "USD_ANCHORS",
        "0xdc25597B19799010047F17e9591EFE08EFd40077,"
        "0x94845aF24a3E431593A2b941b2b31836dE45185D",
    ).split(",")
    if a.strip()
}

# A pool is only trusted as a price source when its anchor/relay-side reserve
# is worth at least this many USD. Dust pools (e.g. a pair seeded with 1e-6
# USDC) have meaningless reserve ratios and would otherwise poison the price
# walker. When several pools qualify, the deepest one wins.
#
# Kept well below $1: Cyberia's WCYBER/stablecoin relay pools currently hold
# under a dollar of stables (~$0.8-0.95), and at a $1 floor they get rejected,
# which unprices WCYBER/CYBER.sol and collapses the whole relay cascade down to
# just the two anchors. $0.1 still rejects genuine dust (depth ~$0) while
# admitting the real pools (depth $0.4-$3).
PRICE_MIN_POOL_USD = float(os.environ.get("PRICE_MIN_POOL_USD", "0.1"))

# Relay tokens used to price assets that have no direct stablecoin pair.
# Default: WCYBER and CYBER.sol — together they reach the long tail of pairs.
PRICE_RELAY_TOKENS = [
    a.strip().lower()
    for a in os.environ.get(
        "PRICE_RELAY_TOKENS",
        "0x78272aAd03E4b9d7A9134e874BA6d419B534F6c9,"
        "0x7DcDa19Cf984ca708E5fA228AC148e7d82D508BA",
    ).split(",")
    if a.strip()
]
# Bound the per-tick block range so eth_getLogs stays under provider limits even
# if the bot was stopped for a while. The Cyberia RPC rejects ranges over ~1023
# blocks with "block range too high", so keep the default at 1000: a larger value
# makes every catch-up query fail once the cursor falls that far behind head,
# wedging the announcer permanently. Inherited by the liquidity/lending/cybersol
# announcers below.
SWAP_MAX_BLOCK_RANGE = int(os.environ.get("SWAP_MAX_BLOCK_RANGE", "1000"))

# Ritual DEX liquidity (V2 Mint/Burn) announcer. Same router filter as swaps:
# addLiquidity/removeLiquidity go through the router, so the pair's Mint/Burn
# `sender` topic equals the router address.
LIQUIDITY_ANNOUNCE_CHAT = os.environ.get("LIQUIDITY_ANNOUNCE_CHAT", BRIDGE_ANNOUNCE_CHAT)
LIQUIDITY_POLL_SECONDS = int(os.environ.get("LIQUIDITY_POLL_SECONDS", str(SWAP_POLL_SECONDS)))
LIQUIDITY_MAX_BLOCK_RANGE = int(os.environ.get("LIQUIDITY_MAX_BLOCK_RANGE", str(SWAP_MAX_BLOCK_RANGE)))

# Lending (Compound-style markets) announcer. Markets are enumerated from the
# comptroller's getAllMarkets(); supply/withdraw/borrow/repay are announced.
LENDING_ANNOUNCE_CHAT = os.environ.get("LENDING_ANNOUNCE_CHAT", BRIDGE_ANNOUNCE_CHAT)
LENDING_POLL_SECONDS = int(os.environ.get("LENDING_POLL_SECONDS", str(SWAP_POLL_SECONDS)))
LENDING_MAX_BLOCK_RANGE = int(os.environ.get("LENDING_MAX_BLOCK_RANGE", str(SWAP_MAX_BLOCK_RANGE)))
# Same value the DEX frontend reads as VITE_LENDING_COMPTROLLER. Without it the
# lending announcer stays dormant.
LENDING_COMPTROLLER = (os.environ.get("LENDING_COMPTROLLER", "") or "").strip()

# CYBER.sol -> native CYBER converter (CyberSolSwap) announcer. The fixed-rate
# redeemer emits Swapped(user, amountIn, amountOut) on every conversion at the
# hard 1000 CYBER.sol : 1 CYBER ratio. Default is the deployed redeemer; blank
# disables the loop. The CYBER.sol input token is CYBER_CA_EVM (both 18 decimals).
CYBERSOL_SWAP_ADDRESS = (os.environ.get(
    "CYBERSOL_SWAP_ADDRESS", "0x69b1614B088F5670E49bcC6fE33F28F2544F7415"
) or "").strip()
CYBERSOL_SWAP_ANNOUNCE_CHAT = os.environ.get("CYBERSOL_SWAP_ANNOUNCE_CHAT", BRIDGE_ANNOUNCE_CHAT)
CYBERSOL_SWAP_POLL_SECONDS = int(os.environ.get("CYBERSOL_SWAP_POLL_SECONDS", str(SWAP_POLL_SECONDS)))
CYBERSOL_SWAP_MAX_BLOCK_RANGE = int(os.environ.get("CYBERSOL_SWAP_MAX_BLOCK_RANGE", str(SWAP_MAX_BLOCK_RANGE)))

# MasterChef solo-staking (/staking page) announcer. Deposit/Withdraw events on
# LP-farm pids are skipped — the liquidity announcer covers those flows — so only
# single-asset stake/unstake gets posted. Default is the live ASH MasterChef;
# blank disables the loop.
STAKING_MASTERCHEF = (os.environ.get(
    "STAKING_MASTERCHEF", "0xd540DEa828567160FFDe5e792ca359aDD1f6B03D"
) or "").strip()
STAKING_ANNOUNCE_CHAT = os.environ.get("STAKING_ANNOUNCE_CHAT", BRIDGE_ANNOUNCE_CHAT)
STAKING_POLL_SECONDS = int(os.environ.get("STAKING_POLL_SECONDS", str(SWAP_POLL_SECONDS)))
STAKING_MAX_BLOCK_RANGE = int(os.environ.get("STAKING_MAX_BLOCK_RANGE", str(SWAP_MAX_BLOCK_RANGE)))

# --- Whales chat gate (CYBER.sol holders) -------------------------------------
# Users prove ownership of a Solana wallet with a Phantom signature on the
# Laravel-served page (/tg/cyber-sol); the backend writes the verified balance
# to tg_sol_wallets and this bot invites/kicks based on the threshold. Balance
# re-checks here need no signature — ownership was already proven once.
SOLANA_RPC_URL = os.environ.get("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com")
# Every Solana read in this bot — the whales gate and the pump.fun buy bot —
# goes through this list, tried in order until one answers. One URL is one
# point of failure, and it failed: the keyed provider began answering 401 on
# 2026-08-14 and both surfaces went quiet at once. SOLANA_RPC_FALLBACK_URL is
# comma-separated and named after the variable Laravel's relay already reads
# (config/solana.php), so one .env line configures both; the keyless public
# cluster is always last, because it answers a server perfectly well and is
# what makes a dead key latency instead of an outage.
SOLANA_RPC_FALLBACK_URL = os.environ.get("SOLANA_RPC_FALLBACK_URL", "")
_PUBLIC_SOLANA_RPC = "https://api.mainnet-beta.solana.com"


def _ordered_urls(*values: str) -> list[str]:
    """Trimmed, in order, no duplicates — pointing two variables at the same
    host must not cost two timeouts."""
    out: list[str] = []
    for value in values:
        url = (value or "").strip()
        if url and url not in out:
            out.append(url)
    return out


SOLANA_RPC_URLS = _ordered_urls(
    SOLANA_RPC_URL, *SOLANA_RPC_FALLBACK_URL.split(","), _PUBLIC_SOLANA_RPC
)
SOLANA_RPC_TIMEOUT = float(os.environ.get("SOLANA_RPC_TIMEOUT", "15"))
# How long an endpoint that refused is left alone. A dead key should cost one
# call, not one call per request.
SOLANA_RPC_COOLDOWN_SECONDS = float(os.environ.get("SOLANA_RPC_COOLDOWN_SECONDS", "300"))
CYBER_SOL_MINT = os.environ.get("CYBER_SOL_MINT", "E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump")
CYBER_SOL_DECIMALS = int(os.environ.get("CYBER_SOL_DECIMALS", "6"))
WHALE_MIN_CYBER_SOL = int(os.environ.get("WHALE_MIN_CYBER_SOL", "10000000"))
WHALE_MIN_RAW = WHALE_MIN_CYBER_SOL * (10 ** CYBER_SOL_DECIMALS)
WHALE_VERIFY_URL = os.environ.get("WHALE_VERIFY_URL", "https://cyberia.church/tg/cyber-sol").rstrip("/")
WHALE_LINK_TTL_MINUTES = int(os.environ.get("WHALE_LINK_TTL_MINUTES", "15"))
# How often the loop ticks (issuing pending invites) and how stale a row must be
# before its on-chain balance is re-read to enforce the threshold.
WHALE_POLL_SECONDS = int(os.environ.get("WHALE_POLL_SECONDS", "20"))
WHALE_RECHECK_SECONDS = int(os.environ.get("WHALE_RECHECK_SECONDS", "3600"))

_whale_chat_raw = (os.environ.get("WHALE_CHAT_ID", "") or "").strip()
try:
    WHALE_CHAT_ID = int(_whale_chat_raw) if _whale_chat_raw else None
except ValueError:
    WHALE_CHAT_ID = None

# --- Quick replies ("x", "ca", …) ---------------------------------------------
# Plain one-word messages people drop in chat ("ca?", "x") asking for the
# project's social link or token contract address. Answered both as /x, /ca
# commands and as bare-text triggers. All values are env-overridable.
PROJECT_X_URL = os.environ.get("PROJECT_X_URL", "https://x.com/cyberia_temple")
PROJECT_WEBSITE_URL = os.environ.get("PROJECT_WEBSITE_URL", "https://cyberia.church")
TELEGRAM_CHANNEL_URL = os.environ.get("TELEGRAM_CHANNEL_URL", "https://t.me/cyberia_network")
TELEGRAM_CHAT_URL = os.environ.get("TELEGRAM_CHAT_URL", "https://t.me/cyberia_network_chat")

# --- pump.fun buy bot ---------------------------------------------------------
# Every CYBER.sol buy worth at least PUMPFUN_MIN_BUY_USD gets its own post. The
# coin has graduated off the bonding curve, so buys settle on the PumpSwap AMM
# pool its pump.fun page trades against; bot/pumpfun.py reads them off that
# pool's balance deltas. Blank PUMPFUN_ANNOUNCE_CHAT disables the loop.
PUMPFUN_ANNOUNCE_CHAT = os.environ.get("PUMPFUN_ANNOUNCE_CHAT", BRIDGE_ANNOUNCE_CHAT)
PUMPFUN_MIN_BUY_USD = float(os.environ.get("PUMPFUN_MIN_BUY_USD", "5"))
PUMPFUN_POLL_SECONDS = int(os.environ.get("PUMPFUN_POLL_SECONDS", "30"))
# Pool override. Left blank, the pool is whichever SOL-quoted pair for
# CYBER_SOL_MINT is deepest in the market feed, so a migration to another pool
# is picked up without a redeploy.
PUMPFUN_POOL_ADDRESS = (os.environ.get("PUMPFUN_POOL_ADDRESS", "") or "").strip()
# Signatures per page and how many pages one tick may walk back. The product is
# the burst a single tick can catch up on; anything older is left behind rather
# than replayed into the chat minutes late.
PUMPFUN_SIG_LIMIT = int(os.environ.get("PUMPFUN_SIG_LIMIT", "25"))
PUMPFUN_MAX_PAGES = int(os.environ.get("PUMPFUN_MAX_PAGES", "4"))
PUMPFUN_RPC_TIMEOUT = float(os.environ.get("PUMPFUN_RPC_TIMEOUT", "20"))
# A buy older than this is recorded for the digest but never posted. The chat
# gets news, not a backlog: when the watcher comes back from an outage its
# cursor is hours behind, and the catch-up scan would otherwise announce
# yesterday's trades one after another as if they had just happened.
PUMPFUN_MAX_AGE_SECONDS = float(os.environ.get("PUMPFUN_MAX_AGE_SECONDS", "1800"))
# How long one market quote (SOL/USD + market cap) is reused across ticks.
PUMPFUN_MARKET_TTL_SECONDS = float(os.environ.get("PUMPFUN_MARKET_TTL_SECONDS", "60"))
DEXSCREENER_API_URL = os.environ.get(
    "DEXSCREENER_API_URL", "https://api.dexscreener.com"
).rstrip("/")

# Post cosmetics: the headline links the coin's name to the community chat, and
# the emoji row's length is how the post shows size at a glance.
PUMPFUN_TOKEN_LABEL = os.environ.get("PUMPFUN_TOKEN_LABEL", "cyber.sol")
PUMPFUN_TOKEN_SYMBOL = os.environ.get("PUMPFUN_TOKEN_SYMBOL", "CYBER.sol")
PUMPFUN_TOKEN_URL = os.environ.get("PUMPFUN_TOKEN_URL", TELEGRAM_CHAT_URL)
PUMPFUN_BUY_EMOJI = os.environ.get("PUMPFUN_BUY_EMOJI", "⛓️‍💥🎲")
PUMPFUN_EMOJI_USD = float(
    os.environ.get("PUMPFUN_EMOJI_USD", str(PUMPFUN_MIN_BUY_USD or 5))
)
PUMPFUN_EMOJI_MAX = int(os.environ.get("PUMPFUN_EMOJI_MAX", "40"))
# A returning buyer gets a "Position: N% Up!" line — how much the bag they
# already held grew. Rounding makes anything under a percent read as "0% Up!",
# so below this floor the line is left out rather than printed empty.
PUMPFUN_MIN_POSITION_PCT = float(os.environ.get("PUMPFUN_MIN_POSITION_PCT", "1"))
# Footer links, one blank line under the post. Blank turns a link off.
PUMPFUN_CHART_URL = os.environ.get(
    "PUMPFUN_CHART_URL", f"https://dexscreener.com/solana/{CYBER_SOL_MINT}"
)
PUMPFUN_TRADE_URL = os.environ.get(
    "PUMPFUN_TRADE_URL", f"https://pump.fun/coin/{CYBER_SOL_MINT}"
)

# Ecosystem links surfaced as inline URL buttons under /start and /help.
# Defaults derive the marketplace/pixel-battle pages from the project website.
SWAP_URL = os.environ.get("SWAP_URL", "https://swap.cyberia.church")
NFT_MARKET_URL = os.environ.get("NFT_MARKET_URL", PROJECT_WEBSITE_URL.rstrip("/") + "/market")
PIXEL_BATTLE_URL = os.environ.get("PIXEL_BATTLE_URL", PROJECT_WEBSITE_URL.rstrip("/") + "/pixels")
# The wallet app download page. /app answers with this instead of an APK file
# passed around by hand, which is how the app used to reach people.
APP_DOWNLOAD_URL = os.environ.get("APP_DOWNLOAD_URL", PROJECT_WEBSITE_URL.rstrip("/") + "/download")

# The Mini App: the wallet on the site, opened inside Telegram's web view.
# Nothing is bundled here — the page is the same /wallet everyone else uses, so
# a deploy updates the Mini App with it. Telegram requires HTTPS, and only that.
WALLET_MINI_APP_URL = os.environ.get(
    "WALLET_MINI_APP_URL", PROJECT_WEBSITE_URL.rstrip("/") + "/wallet"
)
ARENA_MINI_APP_URL = os.environ.get(
    "ARENA_MINI_APP_URL", PROJECT_WEBSITE_URL.rstrip("/") + "/wallet?screen=arena"
)

# Whether to put the Mini App behind the chat menu button (the ☰ beside the
# input box) at startup. Off switches the bot back to the plain command menu.
WALLET_MINI_APP_MENU = os.environ.get("WALLET_MINI_APP_MENU", "1") not in ("0", "false", "False")

# --- AI assistant ------------------------------------------------------------
# Master switch. The assistant stays fully off (no /ask, no DM/mention answers,
# no "not configured" replies) unless AI_ENABLED is set to a truthy value.
AI_ENABLED = (
    os.environ.get("AI_ENABLED", "0").strip().lower() in {"1", "true", "yes", "on"}
)

# Any provider exposing the OpenAI-compatible /chat/completions API can be
# used. The feature stays disabled until a key is supplied, so existing bot
# deployments continue to work without an additional dependency or secret.
# In the monorepo, the bot may reuse LainOS's OpenRouter configuration without
# duplicating its secret. Explicit bot/process variables always take priority.
_lainos_env_path = _SVC_DIR.parent / "lainos" / ".env"
_lainos_ai_env = dotenv_values(_lainos_env_path) if _lainos_env_path.is_file() else {}
_direct_ai_key = (
    os.environ.get("AI_API_KEY") or os.environ.get("OPENAI_API_KEY", "")
).strip()
_openrouter_key = (
    os.environ.get("OPENROUTER_API_KEY")
    or _lainos_ai_env.get("OPENROUTER_API_KEY")
    or ""
).strip()
_using_openrouter = not _direct_ai_key and bool(_openrouter_key)
AI_API_KEY = _direct_ai_key or _openrouter_key

_openrouter_base = (
    os.environ.get("OPENROUTER_BASE_URL")
    or _lainos_ai_env.get("OPENROUTER_BASE_URL")
    or "https://openrouter.ai/api/v1"
).rstrip("/")
_default_ai_url = (
    f"{_openrouter_base}/chat/completions"
    if _using_openrouter
    else "https://api.openai.com/v1/chat/completions"
)
AI_API_URL = (os.environ.get("AI_API_URL", _default_ai_url) or "").strip()

_default_ai_model = "gpt-4.1-mini"
if _using_openrouter:
    _default_ai_model = (
        os.environ.get("OPENROUTER_MODEL_SMALL")
        or _lainos_ai_env.get("OPENROUTER_MODEL_SMALL")
        or "openrouter/free"
    )
AI_MODEL = (os.environ.get("AI_MODEL", _default_ai_model) or "").strip()
del _lainos_ai_env
AI_TIMEOUT_SECONDS = float(os.environ.get("AI_TIMEOUT_SECONDS", "45"))
AI_MAX_OUTPUT_TOKENS = int(os.environ.get("AI_MAX_OUTPUT_TOKENS", "700"))
AI_HISTORY_MESSAGES = max(0, int(os.environ.get("AI_HISTORY_MESSAGES", "8")))
AI_USER_COOLDOWN_SECONDS = max(
    0.0, float(os.environ.get("AI_USER_COOLDOWN_SECONDS", "3"))
)
AI_MAX_CONCURRENT_REQUESTS = max(
    1, int(os.environ.get("AI_MAX_CONCURRENT_REQUESTS", "3"))
)
AI_MAX_QUESTION_CHARS = max(
    100, int(os.environ.get("AI_MAX_QUESTION_CHARS", "4000"))
)

# Contract addresses surfaced by "ca". CYBER.sol is the community pump.fun token
# (also gates the whales chat); its EVM counterpart is the bridged CYBER.sol on
# Cyberia (matches PRICE_RELAY_TOKENS). Blank values are simply omitted.
CYBER_CA_SOLANA = (os.environ.get("CYBER_CA_SOLANA", CYBER_SOL_MINT) or "").strip()
CYBER_CA_EVM = (os.environ.get(
    "CYBER_CA_EVM", "0x7DcDa19Cf984ca708E5fA228AC148e7d82D508BA"
) or "").strip()

# --- NFT from channel posts ---------------------------------------------------
# When the bot is an admin of a PUBLIC channel it receives that channel's posts;
# each new post is minted into the shared CyberiaNFT collection with ERC-721 +
# IPFS metadata so it shows up on the Cyberia NFT marketplace. The NFT is owned
# by the deployer/treasury wallet (mint -> msg.sender) but the marketplace lists
# the whole collection by nextId, so it is visible regardless.
CYBERIA_NFT_ADDRESS = (os.environ.get(
    "CYBERIA_NFT_ADDRESS", "0x546462FAbf30734E63b64f32B30EC8ADD9B6EBa7"
) or "").strip()

# Master switch. Defaults on once both the NFT address and a deployer key exist;
# set NFT_FROM_POSTS=0 to disable.
NFT_FROM_POSTS = (os.environ.get("NFT_FROM_POSTS", "1").strip().lower()
                  not in ("0", "false", "no", "off")) and bool(CYBERIA_NFT_ADDRESS)

# Pin metadata to IPFS but skip the on-chain mint (no gas) — for testing.
NFT_FROM_POSTS_DRYRUN = os.environ.get(
    "NFT_FROM_POSTS_DRYRUN", "0"
).strip().lower() in ("1", "true", "yes", "on")

# Local Kubo HTTP API used to pin images + metadata JSON. Same env name and
# default as the Laravel NFTController so prod config carries over.
IPFS_API_URL = (os.environ.get("IPFS_API_URL", "http://127.0.0.1:5001") or "").rstrip("/")

# Cap the NFT description (post text) length kept in metadata.
NFT_MAX_DESC_CHARS = int(os.environ.get("NFT_MAX_DESC_CHARS", "1500"))

# Public base for the post link surfaced as the NFT's external_url.
TELEGRAM_POST_BASE = os.environ.get("TELEGRAM_POST_BASE", "https://t.me").rstrip("/")

CYBERIA_NFT_ABI = [
    {
        "inputs": [{"name": "uri", "type": "string"}],
        "name": "mint",
        "outputs": [{"name": "tokenId", "type": "uint256"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "nextId",
        "outputs": [{"name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"name": "from", "type": "address"},
            {"name": "to", "type": "address"},
            {"name": "tokenId", "type": "uint256"},
        ],
        "name": "safeTransferFrom",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True, "name": "tokenId", "type": "uint256"},
            {"indexed": True, "name": "creator", "type": "address"},
            {"indexed": False, "name": "uri", "type": "string"},
        ],
        "name": "Minted",
        "type": "event",
    },
]

MINTED_TOPIC = Web3.keccak(text="Minted(uint256,address,string)").hex()


MARKET_SNAPSHOT_SECONDS = int(os.environ.get("MARKET_SNAPSHOT_SECONDS", "300"))

# --- Logging ---------------------------------------------------------------
LOG_FILE = Path(os.environ.get("BOT_LOG_FILE", str(_SVC_DIR / "bot.log")))


class SecurityFilter(logging.Filter):
    """Redact API credentials from string log messages."""

    def filter(self, record):
        if isinstance(record.msg, str):
            for secret_value in (TELEGRAM_BOT_TOKEN, AI_API_KEY):
                if secret_value:
                    record.msg = record.msg.replace(secret_value, "***")
        return True


_log_handlers = [logging.FileHandler(LOG_FILE), logging.StreamHandler(sys.stdout)]
for _h in _log_handlers:
    _h.addFilter(SecurityFilter())

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
    handlers=_log_handlers,
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("telegram").setLevel(logging.WARNING)
