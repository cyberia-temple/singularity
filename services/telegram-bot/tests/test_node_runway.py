"""Validator runway: P-Chain balances to days, the daily post, once a day.

The validator fixture is the Fuji L1's real getCurrentValidators answer of
2026-11-24. No network or Telegram runs in tests.
"""
import asyncio
import os
import tempfile
import unittest
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import AsyncMock, patch

# Its own database, never CI's shared DB_PATH: the whole bot schema there would change what
# later test files (which expect some tables to be absent) see.
os.environ["DB_PATH"] = tempfile.mktemp(prefix="node-runway-test-", suffix=".sqlite")

from sqlalchemy import text  # noqa: E402

from bot import db, node_runway  # noqa: E402

FUJI = {"network": "fuji", "subnet": "UVRXcqMkQM9X8Wv6BmXXEbFbAcbKoW1t8vde5Lds35SLQSVn3", "name": "Cyberia 2.0 testnet (Fuji)"}
FUJI_VALIDATORS = {"validators": [{
    "nodeID": "NodeID-6VfUgV34HC4b6S7wu375cDmsUG3gzcHZ7",
    "weight": "100",
    "validationID": "2KZnTnX6QqZ1WNAFd7BCp9cKgXWYd3MXoj1zpccdSfVG14ULLJ",
    "balance": "84497984",
}]}
FEE_STATE = {"excess": 0, "price": 512}


def answers(validators):
    def p_chain(network, method, params):
        return {"platform.getCurrentValidators": validators, "platform.getValidatorFeeState": FEE_STATE}[method]
    return p_chain


class RunwayTests(unittest.TestCase):
    def test_balance_and_fee_become_days(self):
        with patch.object(node_runway, "_p_chain", side_effect=answers(FUJI_VALIDATORS)):
            runway = node_runway.read_runway(FUJI)
        self.assertEqual(runway["balances"], [84497984])
        self.assertEqual(runway["price"], 512)
        days = node_runway.days_left(runway["balances"][0], runway["price"])
        self.assertAlmostEqual(float(days), 84497984 / 512 / 86400, places=9)

    def test_a_subnet_not_converted_yet_has_no_runway(self):
        with patch.object(node_runway, "_p_chain", side_effect=answers({"validators": []})):
            self.assertIsNone(node_runway.read_runway(FUJI))

    def test_malformed_entries_are_skipped(self):
        l1s = node_runway.parse_l1s("mainnet:2LbF:Cyberia 2.0, fuji::empty, devnet:x:y, nonsense")
        self.assertEqual(l1s, [{"network": "mainnet", "subnet": "2LbF", "name": "Cyberia 2.0"}])


class PostTests(unittest.TestCase):
    def runway(self, *balances, name="Cyberia 2.0"):
        return {"name": name, "price": 512, "balances": sorted(balances)}

    def test_post_names_days_balance_and_daily_spend(self):
        post = node_runway.format_post([self.runway(850_000_000)], topup_url="https://top.up/")
        self.assertIn("Cyberia 2.0: <b>19 days</b>", post)
        self.assertIn("0.850 AVAX on the P-Chain, 0.044 AVAX a day", post)
        self.assertIn('href="https://top.up/"', post)
        self.assertNotIn("⚠️", post)

    def test_under_a_week_is_flagged_and_an_empty_balance_reads_stopped(self):
        post = node_runway.format_post([
            self.runway(84_497_984, name="Fuji"),
            self.runway(0, name="Dead"),
        ])
        self.assertIn("⚠️ Fuji: <b>1.9 days</b>", post)
        self.assertIn("🛑 Dead: <b>stopped</b>", post)

    def test_several_validators_report_the_first_to_stop(self):
        post = node_runway.format_post([self.runway(850_000_000, 84_497_984)])
        self.assertIn("<b>1.9 days</b> (the first of 2 validators)", post)


class OncePerDayTests(unittest.TestCase):
    def setUp(self):
        with db.engine.begin() as conn:
            conn.execute(text("CREATE TABLE IF NOT EXISTS bot_kv (key TEXT PRIMARY KEY, value TEXT)"))
            conn.execute(text("DELETE FROM bot_kv WHERE key = :k"), {"k": node_runway.POSTED_KEY})
        self.bot = AsyncMock()

    def run_tick(self, hour, validators=FUJI_VALIDATORS, day=24):
        now = datetime(2026, 11, day, hour, 5, tzinfo=timezone.utc)
        with patch.object(node_runway, "NODE_RUNWAY_HOUR_UTC", 9), \
             patch.object(node_runway, "NODE_RUNWAY_L1S", "fuji:UVRX:Fuji"), \
             patch.object(node_runway, "_p_chain", side_effect=answers(validators)):
            return asyncio.run(node_runway.tick(self.bot, now))

    def test_posts_once_after_the_hour_then_waits_for_tomorrow(self):
        self.assertFalse(self.run_tick(8))
        self.assertTrue(self.run_tick(9))
        self.assertFalse(self.run_tick(15))
        self.assertTrue(self.run_tick(9, day=25))
        self.assertEqual(self.bot.send_message.await_count, 2)

    def test_nothing_to_report_posts_nothing(self):
        self.assertFalse(self.run_tick(10, validators={"validators": []}))
        self.bot.send_message.assert_not_awaited()

    def test_an_unreadable_p_chain_retries_on_the_next_tick(self):
        now = datetime(2026, 11, 24, 10, 0, tzinfo=timezone.utc)
        with patch.object(node_runway, "NODE_RUNWAY_L1S", "fuji:UVRX:Fuji"), \
             patch.object(node_runway, "_p_chain", side_effect=OSError("timed out")):
            with self.assertRaises(OSError):
                asyncio.run(node_runway.tick(self.bot, now))
        self.assertTrue(self.run_tick(10))


if __name__ == "__main__":
    unittest.main()
