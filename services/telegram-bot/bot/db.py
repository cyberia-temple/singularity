"""SQLite engine, schema bootstrap, key/value store, activity log, cursors."""
import logging

from sqlalchemy import create_engine, text

from bot.config import DB_PATH

logger = logging.getLogger(__name__)


try:
    engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    logger.info(f"Database connected: {DB_PATH}")
except Exception as e:
    logger.error(f"Database connection failed: {e}")
    raise
def ensure_chat_token_schema():
    with engine.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS chat_tokens (
                chat_id           INTEGER PRIMARY KEY,
                name              TEXT NOT NULL,
                symbol            TEXT NOT NULL,
                token_address     TEXT,
                rewards_interval  INTEGER NOT NULL,
                reward_amount     TEXT NOT NULL DEFAULT '1000000000000000000',
                created_by        INTEGER NOT NULL,
                created_at        TEXT DEFAULT (datetime('now')),
                last_payout_at    TEXT
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS chat_members (
                chat_id    INTEGER NOT NULL,
                user_id    INTEGER NOT NULL,
                first_seen TEXT DEFAULT (datetime('now')),
                last_seen  TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (chat_id, user_id)
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS tg_wallets (
                user_id    INTEGER PRIMARY KEY,
                address    TEXT NOT NULL,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """))
        # Owed rewards for users without a wallet yet. distribute_chat_tokens.py
        # adds to `amount` (uint256 as text) on every payout tick where the
        # user is a chat member but has no entry in tg_wallets. /set_wallet
        # flushes these on-chain in one mint per chat token.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS pending_rewards (
                chat_id    INTEGER NOT NULL,
                user_id    INTEGER NOT NULL,
                amount     TEXT NOT NULL DEFAULT '0',
                updated_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (chat_id, user_id)
            )
        """))
        # Small key/value store for the bot's own state, separate from the
        # Laravel-owned tables. Used to track the last bridge_requests.id we
        # already announced in BRIDGE_ANNOUNCE_CHAT.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS bot_kv (
                key   TEXT PRIMARY KEY,
                value TEXT
            )
        """))
        # One-time links minted by /whale and consumed by the Laravel verify
        # endpoint (shared SQLite file): maps an opaque token -> telegram user.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS tg_link_tokens (
                token      TEXT PRIMARY KEY,
                tg_user_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                used       INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """))
        # Verified Solana wallets + CYBER.sol balance. Laravel writes on verify;
        # this bot reads to invite/kick and re-reads balances on a schedule.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS tg_sol_wallets (
                tg_user_id      INTEGER PRIMARY KEY,
                solana_address  TEXT NOT NULL,
                balance_raw     TEXT NOT NULL DEFAULT '0',
                is_whale        INTEGER NOT NULL DEFAULT 0,
                invited         INTEGER NOT NULL DEFAULT 0,
                verified_at     TEXT,
                last_checked_at TEXT
            )
        """))
        # Every on-chain event the announcers observe (swaps, liquidity,
        # bridges, lending), whether or not it was posted individually. The
        # periodic digest and /stats aggregate from here. usd is NULL when the
        # price walker found no route. meta holds kind-specific extras
        # (bridge direction).
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS activity_events (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                kind       TEXT NOT NULL,
                usd        REAL,
                sym_in     TEXT,
                amt_in     REAL,
                sym_out    TEXT,
                amt_out    REAL,
                user_addr  TEXT,
                tx_hash    TEXT,
                block      INTEGER,
                meta       TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_activity_events_kind_time
            ON activity_events (kind, created_at)
        """))
        # Market snapshot rewritten by market_snapshot_loop every few minutes:
        # token USD prices and DEX pool reserves/TVL. Read by the Laravel
        # /analytics page through the shared SQLite file.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS token_prices (
                address    TEXT PRIMARY KEY,
                symbol     TEXT,
                price_usd  REAL,
                updated_at TEXT
            )
        """))
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS dex_pools (
                pair_address TEXT PRIMARY KEY,
                token0       TEXT,
                token1       TEXT,
                symbol0      TEXT,
                symbol1      TEXT,
                reserve0     REAL,
                reserve1     REAL,
                tvl_usd      REAL,
                updated_at   TEXT
            )
        """))
        # One row per channel post turned into a CyberiaNFT. Dedup is by
        # (chat_id, message_id); media_group_id lets albums mint a single NFT.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS channel_post_nfts (
                chat_id        INTEGER NOT NULL,
                message_id     INTEGER NOT NULL,
                channel        TEXT,
                media_group_id TEXT,
                token_id       INTEGER,
                token_uri      TEXT,
                tx_hash        TEXT,
                created_at     TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (chat_id, message_id)
            )
        """))
        conn.execute(text("""
            CREATE INDEX IF NOT EXISTS idx_channel_post_nfts_group
            ON channel_post_nfts (chat_id, media_group_id)
        """))
        # Recipient wallet a channel admin registered (DM /set_channel_wallet).
        # Post NFTs are minted then transferred to this address; posts in
        # channels without a wallet are not minted.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS channel_wallets (
                chat_id    INTEGER PRIMARY KEY,
                channel    TEXT,
                address    TEXT NOT NULL,
                set_by     INTEGER,
                updated_at TEXT DEFAULT (datetime('now'))
            )
        """))
        # The language a chat's admins chose with /language (bot.language).
        # No row: everyone is answered in their own Telegram app's language.
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS chat_languages (
                chat_id    INTEGER PRIMARY KEY,
                lang       TEXT NOT NULL,
                set_by     INTEGER,
                updated_at TEXT DEFAULT (datetime('now'))
            )
        """))


def _kv_get(key: str, default: str | None = None) -> str | None:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT value FROM bot_kv WHERE key = :k"),
            {"k": key},
        ).fetchone()
    return row[0] if row else default


def _kv_set(key: str, value: str) -> None:
    with engine.begin() as conn:
        conn.execute(
            text("""
                INSERT INTO bot_kv (key, value) VALUES (:k, :v)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """),
            {"k": key, "v": value},
        )
def _record_activity(
    kind: str,
    usd: float | None = None,
    sym_in: str | None = None,
    amt_in: float | None = None,
    sym_out: str | None = None,
    amt_out: float | None = None,
    user_addr: str | None = None,
    tx_hash: str | None = None,
    block: int | None = None,
    meta: str | None = None,
) -> None:
    """Persist one observed on-chain event for the digest. Never raises —
    losing a stats row must not break the announcer that called us."""
    try:
        with engine.begin() as conn:
            conn.execute(
                text("""
                    INSERT INTO activity_events
                        (kind, usd, sym_in, amt_in, sym_out, amt_out,
                         user_addr, tx_hash, block, meta)
                    VALUES
                        (:kind, :usd, :sym_in, :amt_in, :sym_out, :amt_out,
                         :user_addr, :tx_hash, :block, :meta)
                """),
                {
                    "kind": kind, "usd": usd,
                    "sym_in": sym_in, "amt_in": amt_in,
                    "sym_out": sym_out, "amt_out": amt_out,
                    "user_addr": user_addr, "tx_hash": tx_hash,
                    "block": block, "meta": meta,
                },
            )
    except Exception as e:
        logger.error(f"record_activity: insert failed kind={kind} tx={tx_hash}: {e}")
def _get_block_cursor(key: str) -> tuple[int, int] | None:
    """Read a `block:log_index` cursor stored in bot_kv under `key`."""
    raw = _kv_get(key)
    if raw is None:
        return None
    try:
        block_str, idx_str = raw.split(":", 1)
        return int(block_str), int(idx_str)
    except Exception:
        return None


def _set_block_cursor(key: str, block: int, log_index: int) -> None:
    _kv_set(key, f"{block}:{log_index}")


def _get_swap_cursor() -> tuple[int, int] | None:
    return _get_block_cursor("last_announced_swap_cursor")


def _set_swap_cursor(block: int, log_index: int) -> None:
    _set_block_cursor("last_announced_swap_cursor", block, log_index)


def _post_nft_seen(chat_id: int, message_id: int, media_group_id: str | None = None) -> bool:
    """True if this post (or its album) already produced an NFT. Albums fire one
    update per item; the media_group_id check collapses them to a single mint."""
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT 1 FROM channel_post_nfts WHERE chat_id = :c AND message_id = :m"),
            {"c": chat_id, "m": message_id},
        ).fetchone()
        if row is not None:
            return True
        if media_group_id:
            row = conn.execute(
                text("""
                    SELECT 1 FROM channel_post_nfts
                    WHERE chat_id = :c AND media_group_id = :g LIMIT 1
                """),
                {"c": chat_id, "g": media_group_id},
            ).fetchone()
            return row is not None
    return False


def _record_post_nft(
    chat_id: int,
    message_id: int,
    channel: str | None,
    media_group_id: str | None,
    token_id: int | None,
    token_uri: str | None,
    tx_hash: str | None,
) -> None:
    with engine.begin() as conn:
        conn.execute(
            text("""
                INSERT INTO channel_post_nfts
                    (chat_id, message_id, channel, media_group_id,
                     token_id, token_uri, tx_hash)
                VALUES (:c, :m, :ch, :g, :tid, :uri, :tx)
                ON CONFLICT(chat_id, message_id) DO UPDATE SET
                    token_id = excluded.token_id,
                    token_uri = excluded.token_uri,
                    tx_hash = excluded.tx_hash
            """),
            {
                "c": chat_id, "m": message_id, "ch": channel, "g": media_group_id,
                "tid": token_id, "uri": token_uri, "tx": tx_hash,
            },
        )


def _set_channel_wallet(chat_id: int, channel: str | None, address: str, set_by: int | None) -> None:
    with engine.begin() as conn:
        conn.execute(
            text("""
                INSERT INTO channel_wallets (chat_id, channel, address, set_by, updated_at)
                VALUES (:c, :ch, :a, :by, datetime('now'))
                ON CONFLICT(chat_id) DO UPDATE SET
                    channel = excluded.channel,
                    address = excluded.address,
                    set_by = excluded.set_by,
                    updated_at = datetime('now')
            """),
            {"c": chat_id, "ch": channel, "a": address, "by": set_by},
        )


def _get_channel_wallet(chat_id: int) -> str | None:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT address FROM channel_wallets WHERE chat_id = :c"),
            {"c": chat_id},
        ).fetchone()
    return row[0] if row else None


ensure_schema = ensure_chat_token_schema
