"""The periodic digest: numbers a reader can read, and a post that survives a
token symbol someone chose to look like markup.

The fixture is the digest as it actually went out on 2026-08-15 — four swaps
worth pennies, one five-million-CYBER.sol bridge, eight prices — which is the
message that prompted this: `5.14993e+06 CYBER.sol`, `1 traders`, and eight
`SYM $price` pairs on one wrapping line.

Env is pinned before bot.* imports because bot.config reads it at import time.
"""
import os
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix="digest_test_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "digest_test.sqlite"))

from bot import announcers  # noqa: E402
from bot.utils import _fmt_amount, _fmt_price_usd, _fmt_usd, _plural  # noqa: E402


class FormatNumbersTest(unittest.TestCase):
    def test_amount_never_goes_scientific(self):
        # The bridge line that started this: 5149930.0 rendered as 5.14993e+06.
        self.assertEqual(_fmt_amount(5149930.0), "5.15M")
        self.assertEqual(_fmt_amount(1_234_567_890), "1.23B")
        self.assertEqual(_fmt_amount(12345.6), "12,346")
        self.assertEqual(_fmt_amount(67.2673), "67.27")
        self.assertEqual(_fmt_amount(0.317596), "0.3176")
        self.assertEqual(_fmt_amount(0.00000055), "0.00000055")
        self.assertEqual(_fmt_amount(0), "0")
        self.assertEqual(_fmt_amount(None), "0")

    def test_usd_keeps_small_money_visible(self):
        self.assertEqual(_fmt_usd(0.0852), "$0.0852")
        # Four decimals used to round this to $0.0000.
        self.assertEqual(_fmt_usd(0.0000234), "$0.0000234")
        self.assertEqual(_fmt_usd(181.6145), "$181.61")
        self.assertEqual(_fmt_usd(83847.7993), "$83,848")
        self.assertEqual(_fmt_usd(2_500_000), "$2.5M")
        self.assertEqual(_fmt_usd(0), "$0")

    def test_price_keeps_four_significant_figures(self):
        self.assertEqual(_fmt_price_usd(83847.7993), "$83,848")
        self.assertEqual(_fmt_price_usd(181.6145), "$181.61")
        self.assertEqual(_fmt_price_usd(0.07648949), "$0.07649")
        self.assertEqual(_fmt_price_usd(0.00158935), "$0.001589")
        self.assertEqual(_fmt_price_usd(0.00000055), "$0.00000055")
        self.assertEqual(_fmt_price_usd(1), "$1.00")

    def test_plural(self):
        self.assertEqual(_plural(1, "trader"), "1 trader")
        self.assertEqual(_plural(4, "trader"), "4 traders")


class DigestTextTest(unittest.TestCase):
    """_build_digest_text reads six queries; each test stubs the connection it
    opens, so the assertions are about the text and nothing else."""

    def setUp(self):
        self.addCleanup(setattr, announcers, "engine", announcers.engine)
        self.addCleanup(
            setattr, announcers, "_market_price_block", announcers._market_price_block
        )

    def _build(self, prices=(), **rows):
        results = [
            rows.get("swaps", (0, 0.0, 0, 0)),      # count, volume, traders, unpriced
            rows.get("top_tokens", []),
            rows.get("largest"),
            rows.get("liq", []),
            rows.get("bridges", []),
            rows.get("lending", []),
            rows.get("staking", []),
            rows.get("conversions", (0, 0.0, 0.0, 0.0)),
            rows.get("sol_buys", (0, 0.0, 0, 0)),
            rows.get("ecosystem", []),
            rows.get("newcomers", (0,)),
        ]

        class _Result:
            def __init__(self, value):
                self._value = value

            def fetchone(self):
                return self._value

            def fetchall(self):
                return self._value

        class _Conn:
            def __init__(self, queue):
                self._queue = list(queue)

            def execute(self, *_args, **_kwargs):
                return _Result(self._queue.pop(0))

            def __enter__(self):
                return self

            def __exit__(self, *_exc):
                return False

        class _Engine:
            def __init__(self, queue):
                self._queue = queue

            def connect(self):
                return _Conn(self._queue)

        announcers.engine = _Engine(results)
        announcers._market_price_block = lambda: announcers._price_block(list(prices))
        return announcers._build_digest_text("2026-08-15 10:00:00", "6h")

    def test_quiet_window_stays_silent(self):
        self.assertIsNone(self._build())

    def test_the_message_that_prompted_this(self):
        text = self._build(
            swaps=(4, 0.0852, 1, 0),
            top_tokens=[("WCYBER", 0.0852), ("HATCHER", 0.0243), ("SOL", 0.0217)],
            largest=("HATCHER", 67.2673, "WCYBER", 0.317596, 0.0243,
                     "0x8bEC000000000000000000000000000000000FD62"),
            bridges=[("sol_to_evm", "CYBER.sol", 1, 5149930.0)],
        )
        # No scientific notation anywhere, and no "1 traders".
        self.assertNotIn("e+0", text)
        self.assertIn("1 trader", text)
        self.assertNotIn("1 traders", text)
        self.assertIn("5.15M CYBER.sol", text)
        self.assertIn("Solana → Cyberia", text)
        self.assertIn("67.27 HATCHER → 0.3176 WCYBER", text)
        # Blocks are separated, so the post is not one grey paragraph.
        self.assertIn("\n\n", text)
        self.assertTrue(text.startswith("📊 <b>Cyberia · last 6h</b>"))

    def test_the_rest_of_the_ecosystem_and_new_wallets(self):
        text = self._build(
            ecosystem=[("nft_mint", 3, "#12"), ("domain", 1, "lain.cyber"), ("predict_bet", 2, None)],
            newcomers=(4,),
        )
        self.assertIn("🧩 <b>Ecosystem</b>", text)
        self.assertIn("3 NFTs minted", text)
        self.assertIn("1 domain registered (lain.cyber)", text)
        self.assertIn("2 bets placed", text)
        self.assertIn("4 new wallets", text)

    def test_new_wallets_alone_are_not_a_digest(self):
        self.assertIsNone(self._build(newcomers=(2,)))

    def test_one_sided_liquidity_and_staking_omit_the_empty_half(self):
        text = self._build(
            swaps=(1, 12.0, 1, 0),
            liq=[("liq_add", 3, 1234.0)],
            staking=[("stake", 2, 500.0)],
        )
        self.assertIn("+$1,234 in (3)", text)
        self.assertNotIn("out (0)", text)
        self.assertIn("+$500.00 staked (2)", text)
        self.assertNotIn("unstaked (0)", text)

    def test_a_symbol_that_looks_like_markup_is_escaped(self):
        text = self._build(
            swaps=(1, 5.0, 1, 0),
            top_tokens=[("<b>PWN</b>", 5.0)],
        )
        self.assertNotIn("<b>PWN", text)
        self.assertIn("&lt;b&gt;PWN", text)


class PlainFallbackTest(unittest.TestCase):
    def test_markup_comes_out_and_the_text_stays(self):
        post = "📊 <b>Cyberia · last 6h</b>\n\n<pre>BTC  $83,848</pre>\n&lt;b&gt;PWN"
        self.assertEqual(
            announcers._plain(post),
            "📊 Cyberia · last 6h\n\nBTC  $83,848\n<b>PWN",
        )


class PriceBlockTest(unittest.TestCase):
    def test_prices_are_an_aligned_table(self):
        block = announcers._price_block([
            ("CYBER.sol", 0.00158935), ("WCYBER", 0.07648949), ("BTC", 83847.7993),
        ])
        body = "\n".join(block)
        self.assertIn("<pre>", body)
        # Symbols padded to one width, so the column lines up.
        self.assertIn("CYBER.sol  $0.001589", body)
        self.assertIn("WCYBER     $0.07649", body)
        self.assertIn("BTC        $83,848", body)


if __name__ == "__main__":
    unittest.main()
