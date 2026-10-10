"""Every on-chain action reaches activity_events: v3 swaps decode like v2 ones,
and the record-only watchers (NFTs, domains, predictions) write one row per
event, start at the head and never write the same event twice.

The chain is a stand-in object answering exactly the calls a tick makes. Env is
pinned before bot.* imports because bot.config reads it at import time.
"""
import os
import tempfile
import unittest
from unittest.mock import patch

_TMP = tempfile.mkdtemp(prefix="watchers_test_")
os.environ["DB_PATH"] = os.path.join(_TMP, "watchers_test.sqlite")
os.environ.pop("DEPLOYER_PK", None)

from sqlalchemy import text  # noqa: E402

from bot import config, watchers  # noqa: E402
from bot import announcers  # noqa: E402
from bot.chain import _decode_abi_string, _decode_v3_swap_data  # noqa: E402
from bot.db import engine, ensure_chat_token_schema  # noqa: E402

if config.DB_PATH != os.environ["DB_PATH"]:
    raise unittest.SkipTest(
        "bot.config was imported before the test DB could be pinned; "
        "run standalone: python -m unittest tests.test_chain_watchers"
    )

USER = "0x" + "ab" * 20
POOL = "0x" + "11" * 20
TOKEN0 = "0x" + "22" * 20
TOKEN1 = "0x" + "33" * 20


def word(value: int) -> str:
    return format(value % (1 << 256), "064x")


def address_topic(address: str) -> str:
    return "0x" + address[2:].rjust(64, "0")


def abi_strings(*values: str, extra_words: list[int] = ()) -> str:
    """Head (offsets, then any static words) + tails, the way solc lays out an
    event's non-indexed (string, string, uint) data."""
    head_words = len(values) + len(extra_words)
    offsets, tails, at = [], "", head_words * 32
    for value in values:
        raw = value.encode()
        padded = raw.hex().ljust(((len(raw) + 31) // 32) * 64, "0")
        offsets.append(word(at))
        tails += word(len(raw)) + padded
        at += 32 + len(padded) // 2
    return "0x" + "".join(offsets) + "".join(word(w) for w in extra_words) + tails


class FakeEth:
    def __init__(self, head: int, logs: list[dict]):
        self.block_number = head
        self._logs = logs
        self.queries: list[dict] = []

    def get_logs(self, query):
        self.queries.append(query)
        return [
            log for log in self._logs
            if query["fromBlock"] <= log["blockNumber"] <= query["toBlock"]
            and log["topics"][0] == query["topics"][0]
        ]


class FakeW3:
    def __init__(self, head: int, logs: list[dict]):
        self.eth = FakeEth(head, logs)


def log(topic: str, block: int, index: int, topics: list[str], data: str, tx: str = "0x" + "aa" * 32) -> dict:
    return {
        "address": config.CYBERIA_DOMAINS_ADDRESS,
        "blockNumber": block, "logIndex": index,
        "transactionHash": tx,
        "topics": [topic, *topics], "data": data,
    }


def rows() -> list[dict]:
    with engine.connect() as conn:
        return [dict(r._mapping) for r in conn.execute(text(
            "SELECT kind, user_addr, sym_in, amt_in, meta, block FROM activity_events ORDER BY id"
        ))]


class DecodingTests(unittest.TestCase):
    def test_v3_amounts_are_signed_from_the_pools_side(self):
        data = "0x" + word(5 * 10**18) + word(-12_500_000) + word(0) * 5
        self.assertEqual(_decode_v3_swap_data(data), (5 * 10**18, -12_500_000))

    def test_a_v3_hop_reads_in_and_out_from_the_signs(self):
        data = "0x" + word(-7) + word(3) + word(0) * 5
        meta = {TOKEN0.lower(): ("USDC", 6), TOKEN1.lower(): ("CYBER", 18)}
        with patch.object(announcers, "_get_pair_tokens", return_value=(TOKEN0, TOKEN1)), \
             patch.object(announcers, "_get_token_meta", side_effect=lambda _w3, a: meta[a.lower()]):
            hop = announcers._decode_v3_swap_hop(None, {
                "address": POOL,
                "topics": ["0x0", address_topic(config.CYBERIA_V3_ROUTER), address_topic(USER)],
                "data": data,
            })
        self.assertEqual((hop["in_sym"], hop["in_amt"]), ("CYBER", 3))
        self.assertEqual((hop["out_sym"], hop["out_amt"]), ("USDC", 7))
        self.assertEqual(hop["to"].lower(), USER)

    def test_both_venues_are_watched_and_v2_keeps_its_cursor(self):
        self.assertEqual(announcers.SWAP_VENUES["v2"]["cursor"], "last_announced_swap_cursor")
        self.assertNotEqual(announcers.SWAP_VENUES["v2"]["topic"], announcers.SWAP_VENUES["v3"]["topic"])

    def test_strings_come_out_of_event_data_by_offset(self):
        data = abi_strings("lain", "cyber", extra_words=[10**18])
        self.assertEqual(_decode_abi_string(data, 0), "lain")
        self.assertEqual(_decode_abi_string(data, 1), "cyber")
        self.assertIsNone(_decode_abi_string("0x1234", 0))


class WatcherTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        ensure_chat_token_schema()

    def setUp(self):
        with engine.begin() as conn:
            conn.execute(text("DELETE FROM activity_events"))
            conn.execute(text("DELETE FROM bot_kv"))

    def domain_watcher(self):
        return next(w for w in watchers.WATCHERS if w.kind == "domain")

    def test_first_run_starts_at_the_head_and_records_nothing(self):
        w3 = FakeW3(500, [])
        self.assertEqual(watchers.watch_tick(w3, self.domain_watcher()), 0)
        self.assertEqual(rows(), [])
        self.assertEqual(w3.eth.queries, [])

    def test_a_domain_is_recorded_once_with_its_full_name(self):
        watcher = self.domain_watcher()
        watchers.watch_tick(FakeW3(500, []), watcher)
        registered = log(
            watcher.topic, 510, 3,
            [address_topic("0x" + "00" * 19 + "07"), address_topic(USER)],
            abi_strings("lain", "cyber", extra_words=[10**18]),
        )

        w3 = FakeW3(520, [registered])
        self.assertEqual(watchers.watch_tick(w3, watcher), 1)
        self.assertEqual(watchers.watch_tick(w3, watcher), 0)

        [row] = rows()
        self.assertEqual(row["kind"], "domain")
        self.assertEqual(row["user_addr"].lower(), USER)
        self.assertEqual(row["meta"], "lain.cyber")
        self.assertEqual(row["block"], 510)

    def test_a_bet_carries_its_side_and_its_cyber(self):
        watcher = next(w for w in watchers.WATCHERS if w.kind == "predict_bet")
        watchers.watch_tick(FakeW3(100, []), watcher)
        bet = log(watcher.topic, 101, 0, [address_topic("0x" + "00" * 19 + "02"), address_topic(USER)],
                  "0x" + word(1) + word(25 * 10**17))

        with patch.object(watchers, "_get_token_usd_price", return_value=None):
            watchers.watch_tick(FakeW3(101, [bet]), watcher)

        [row] = rows()
        self.assertEqual((row["kind"], row["sym_in"], row["amt_in"]), ("predict_bet", "CYBER", 2.5))
        self.assertEqual(row["meta"], "YES · market #2")

    def test_the_bots_own_channel_mints_are_not_somebodys_action(self):
        watcher = next(w for w in watchers.WATCHERS if w.kind == "nft_mint")
        mint = {
            "topics": [watcher.topic, address_topic("0x" + "00" * 19 + "05"), address_topic(USER)],
            "transactionHash": "0x" + "bb" * 32, "blockNumber": 9, "data": "0x",
        }
        self.assertEqual(watchers._decode_nft_mint(None, mint)["meta"], "#5")
        with patch.object(watchers, "_OWN_MINTER", USER):
            self.assertIsNone(watchers._decode_nft_mint(None, mint))


if __name__ == "__main__":
    unittest.main()
