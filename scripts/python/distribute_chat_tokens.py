"""
Accrue per-chat Telegram reward tokens.

For each row in `chat_tokens`:
  * skip if `token_address` is NULL (deployment in-flight)
  * skip if `last_payout_at + rewards_interval` is still in the future
  * otherwise consume the tick and credit `reward_amount` to every member of
    that chat in `pending_rewards`.

**This script writes nothing to the chain.** It used to mint on every tick to
every member who had linked a wallet, which across eight tokens on an hourly
interval was hundreds of unrequested transactions a day -- and the people
receiving them were not interested enough to sell what arrived. Minting now
happens once, when a person asks for it (`/claim` in the bot, or the flush on
`/set_wallet`), so a reward is something you collect rather than something
that silently happens to you, and the chain records a transfer somebody wanted.

Intended to be run by cron / systemd timer as frequently as the shortest
desired rewards interval (e.g. every minute).
"""

import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, text

load_dotenv(Path(__file__).parent / ".env")

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

DB_PATH = os.environ.get(
    "DB_PATH", "/home/lain/random/singularity/backend/laravel/database/database.sqlite"
)
# No key, no RPC, no ABI. This job runs from cron every minute and now only
# adds rows to a table, so it has no business holding a private key that can
# mint tokens -- the minting half moved to /claim, which is the only place it
# is wanted. Removing DEPLOYER_PK from here shrinks the number of processes on
# this host that can sign anything.
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})


def _parse_ts(value):
    if value is None:
        return None
    # SQLite DATETIME default returns 'YYYY-MM-DD HH:MM:SS' in UTC.
    try:
        return datetime.fromisoformat(value).replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _amount_to_int(value) -> int:
    """Parse a uint256-as-text amount into a Python int. Tolerates values an
    earlier int64-overflowing version may have left in REAL/scientific form
    (e.g. '1.02e+19') so we can keep accruing instead of choking on them."""
    if value in (None, ""):
        return 0
    s = str(value)
    try:
        return int(s)
    except ValueError:
        try:
            return int(float(s))
        except (ValueError, OverflowError):
            return 0


def distribute():
    with engine.connect() as conn:
        tokens = conn.execute(
            text("""
                SELECT chat_id, name, symbol, token_address, rewards_interval,
                       reward_amount, last_payout_at
                FROM chat_tokens
                WHERE token_address IS NOT NULL
            """)
        ).fetchall()

    if not tokens:
        return

    now = datetime.now(timezone.utc)
    started = False

    for chat_id, name, symbol, token_address, interval, reward_amount, last_payout_at in tokens:
        last = _parse_ts(last_payout_at)
        if last is not None and (now - last).total_seconds() < interval:
            next_due = last.timestamp() + interval - now.timestamp()
            logger.debug(
                "Skipping chat %s (%s): next payout in %ds", chat_id, symbol, int(next_due)
            )
            continue

        # The tick is due: consume it NOW, before any crediting or minting.
        # Bumping only after a successful mint let a minter outage (e.g. the
        # EOA out of gas) leave last_payout_at stale, so every cron run
        # (each minute) re-credited pending_rewards -- wallet-less members
        # accrued 1440x/day instead of 24x/day. A failed mint loses its tick,
        # exactly as the partial-failure path always did.
        with engine.begin() as conn:
            conn.execute(
                text("UPDATE chat_tokens SET last_payout_at = :t WHERE chat_id = :c"),
                {"t": now.strftime("%Y-%m-%d %H:%M:%S"), "c": chat_id},
            )

        # One cohort: everybody who has been seen in this chat. Rewards accrue
        # off-chain and are minted only when somebody asks for them (/claim).
        #
        # This used to be two cohorts, and members with a linked wallet were
        # minted to on every tick. Eight tokens times an hourly interval times
        # every wallet-holding member is hundreds of transactions a day that
        # nobody requested, in a chain everybody can read -- and the people
        # receiving them were not interested enough to sell what they got. The
        # off-chain half of that design was already the right one; it was just
        # reserved for the people who were not yet users.
        #
        # Accruing for everyone also makes the reward something you act to
        # collect rather than something that silently happens to you, which is
        # the entire point of a claim.
        with engine.connect() as conn:
            members = conn.execute(
                text("""
                    SELECT cm.user_id
                    FROM chat_members cm
                    WHERE cm.chat_id = :c
                """),
                {"c": chat_id},
            ).fetchall()

        amount = int(reward_amount)

        # Credit pending balances first; this is cheap and unconditional, so it
        # happens even if the on-chain mint half later fails.
        #
        # `amount` is a uint256 wei value (1e18 per 18-decimal token). It MUST be
        # accumulated in Python: SQLite integers are signed 64-bit, so adding via
        # CAST(amount AS INTEGER) overflows past ~9.2e18 (a handful of tokens),
        # silently promotes the sum to a lossy REAL, and caps the running total.
        if members:
            with engine.begin() as conn:
                conn.exec_driver_sql("BEGIN IMMEDIATE")
                for (uid,) in members:
                    row = conn.execute(
                        text("SELECT amount FROM pending_rewards WHERE chat_id = :c AND user_id = :u"),
                        {"c": chat_id, "u": uid},
                    ).fetchone()
                    new_amount = str(_amount_to_int(row[0] if row else 0) + amount)
                    conn.execute(
                        text("""
                            INSERT INTO pending_rewards (chat_id, user_id, amount, updated_at)
                            VALUES (:c, :u, :amt, datetime('now'))
                            ON CONFLICT(chat_id, user_id) DO UPDATE SET
                                amount = :amt,
                                updated_at = datetime('now')
                        """),
                        {"c": chat_id, "u": uid, "amt": new_amount},
                    )
            logger.info(
                "chat %s (%s): credited %s to %d members (claimable)",
                chat_id, symbol, reward_amount, len(members),
            )

        if not started:
            logger.info("Starting chat-token accrual")
            started = True

    if started:
        logger.info("Accrual complete -- nothing was minted; /claim does that")


if __name__ == "__main__":
    distribute()
