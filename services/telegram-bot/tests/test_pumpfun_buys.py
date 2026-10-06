"""pump.fun buy bot: parsing and post formatting, pinned to a real trade.

The fixture is the balance section of a real CYBER.sol buy on the PumpSwap pool
(signature rrVsUwS6…UnuN4, slot 438515078), reduced to the fields the parser
reads. It arrived through a Jupiter route, which is the point: the parser never
looks at instructions, so an aggregated buy reads like a direct one.

Env is pinned before bot.* imports because bot.config reads it at import time.
"""
import os
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix="pumpfun_test_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "pumpfun_test.sqlite"))

from bot import pumpfun  # noqa: E402

POOL = "Dk19ZrUAJLW2e6Ra1qkaZk1pwb48y5cwQu6xfcFXYtEg"
MINT = "E67WWiQY4s9SZbCyFVTh2CEjorEYbhuVJQUZb3Mbpump"
WSOL = "So11111111111111111111111111111111111111112"
BUYER = "Dox7A7DgiPQJaNLTyPPQUyptYy3iyB7AgvzbwRBHhSUJ"
SIGNATURE = (
    "rrVsUwS6Ab4y1DLpcDrVQAUfZwkAc7cB8tXdZpu1paRxVzWq1wDQdPmnh2raQj6je8ZTymd4fdL5Dh1HYuUnuN4"
)


def _balance(index, mint, owner, amount, decimals):
    return {
        "accountIndex": index,
        "mint": mint,
        "owner": owner,
        "uiTokenAmount": {"amount": str(amount), "decimals": decimals},
    }


def _tx(pre, post, err=None, signature=SIGNATURE, fee_payer=BUYER):
    return {
        "slot": 438515078,
        "blockTime": 1786412817,
        "meta": {"err": err, "preTokenBalances": pre, "postTokenBalances": post},
        "transaction": {
            "signatures": [signature],
            "message": {"accountKeys": [{"pubkey": fee_payer}]},
        },
    }


# The real trade: 3 133 447.177223 CYBER.sol out of the pool for 0.981430814 SOL.
POOL_COIN_PRE = 261811967311653
POOL_COIN_POST = 258678520134430
POOL_SOL_PRE = 81004813894
POOL_SOL_POST = 81986244708

REAL_BUY = _tx(
    pre=[
        _balance(19, MINT, POOL, POOL_COIN_PRE, 6),
        _balance(20, WSOL, POOL, POOL_SOL_PRE, 9),
        # Unrelated wrapped-SOL accounts moving in the same transaction.
        _balance(5, WSOL, "JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU", 1076423471766, 9),
        _balance(21, WSOL, "S9eH5natbUZjE2qPxswFK3Y6947vs98r37NpMwj7P9j", 111061363, 9),
    ],
    post=[
        _balance(4, MINT, BUYER, 3133447177223, 6),
        _balance(19, MINT, POOL, POOL_COIN_POST, 6),
        _balance(20, WSOL, POOL, POOL_SOL_POST, 9),
        _balance(5, WSOL, "JCRGumoE9Qi5BBgULTgdgTLjSgkCMSbF62ZZfGs84JeU", 1076428034507, 9),
        _balance(21, WSOL, "S9eH5natbUZjE2qPxswFK3Y6947vs98r37NpMwj7P9j", 114005067, 9),
    ],
)


def _top_up(held_before, gained, extra_pre=(), extra_post=()):
    """A buyer who already holds `held_before` units buying `gained` more."""
    return _tx(
        pre=[
            _balance(19, MINT, POOL, POOL_COIN_PRE, 6),
            _balance(20, WSOL, POOL, POOL_SOL_PRE, 9),
            _balance(4, MINT, BUYER, held_before, 6),
            *extra_pre,
        ],
        post=[
            _balance(19, MINT, POOL, POOL_COIN_PRE - gained, 6),
            _balance(20, WSOL, POOL, POOL_SOL_POST, 9),
            _balance(4, MINT, BUYER, held_before + gained, 6),
            *extra_post,
        ],
    )


class ParseBuyTest(unittest.TestCase):
    def test_reads_the_real_trade(self):
        buy = pumpfun.parse_buy(REAL_BUY, POOL, MINT)
        self.assertIsNotNone(buy)
        self.assertEqual(buy["buyer"], BUYER)
        self.assertEqual(buy["signature"], SIGNATURE)
        self.assertAlmostEqual(buy["token_amount"], 3133447.177223, places=6)
        self.assertAlmostEqual(buy["sol_amount"], 0.981430814, places=9)
        self.assertEqual(buy["token_decimals"], 6)
        self.assertEqual(buy["slot"], 438515078)

    def test_first_ever_balance_is_a_new_holder(self):
        self.assertTrue(pumpfun.parse_buy(REAL_BUY, POOL, MINT)["new_holder"])

    def test_topping_up_an_existing_bag_is_not(self):
        tx = _tx(
            pre=REAL_BUY["meta"]["preTokenBalances"] + [_balance(4, MINT, BUYER, 1_000_000, 6)],
            post=REAL_BUY["meta"]["postTokenBalances"],
        )
        self.assertFalse(pumpfun.parse_buy(tx, POOL, MINT)["new_holder"])

    def test_position_growth_is_the_bag_it_added_to(self):
        buy = pumpfun.parse_buy(_top_up(1_000_000_000_000, 340_000_000_000), POOL, MINT)
        self.assertFalse(buy["new_holder"])
        self.assertAlmostEqual(buy["position_pct"], 34.0, places=6)

    def test_position_growth_counts_every_account_of_the_buyer(self):
        """A second token account of the same buyer is the same position."""
        buy = pumpfun.parse_buy(
            _top_up(
                500_000_000_000, 340_000_000_000,
                extra_pre=[_balance(7, MINT, BUYER, 500_000_000_000, 6)],
                extra_post=[_balance(7, MINT, BUYER, 500_000_000_000, 6)],
            ),
            POOL, MINT,
        )
        self.assertAlmostEqual(buy["position_pct"], 34.0, places=6)

    def test_a_new_holder_has_no_position_growth(self):
        self.assertIsNone(pumpfun.parse_buy(REAL_BUY, POOL, MINT)["position_pct"])

    def test_sell_is_not_a_buy(self):
        """Same pool, both deltas reversed."""
        tx = _tx(
            pre=[
                _balance(19, MINT, POOL, POOL_COIN_POST, 6),
                _balance(20, WSOL, POOL, POOL_SOL_POST, 9),
                _balance(4, MINT, BUYER, 3133447177223, 6),
            ],
            post=[
                _balance(19, MINT, POOL, POOL_COIN_PRE, 6),
                _balance(20, WSOL, POOL, POOL_SOL_PRE, 9),
                _balance(4, MINT, BUYER, 0, 6),
            ],
        )
        self.assertIsNone(pumpfun.parse_buy(tx, POOL, MINT))

    def test_liquidity_deposit_is_not_a_buy(self):
        """Both sides into the pool — the case a naive 'coin left the pool'
        check would still get right, and its withdrawal twin would not."""
        tx = _tx(
            pre=[
                _balance(19, MINT, POOL, POOL_COIN_PRE, 6),
                _balance(20, WSOL, POOL, POOL_SOL_PRE, 9),
            ],
            post=[
                _balance(19, MINT, POOL, POOL_COIN_PRE + 10_000_000, 6),
                _balance(20, WSOL, POOL, POOL_SOL_PRE + 3_000_000, 9),
            ],
        )
        self.assertIsNone(pumpfun.parse_buy(tx, POOL, MINT))

    def test_liquidity_withdrawal_is_not_a_buy(self):
        tx = _tx(
            pre=[
                _balance(19, MINT, POOL, POOL_COIN_PRE, 6),
                _balance(20, WSOL, POOL, POOL_SOL_PRE, 9),
            ],
            post=[
                _balance(19, MINT, POOL, POOL_COIN_PRE - 10_000_000, 6),
                _balance(20, WSOL, POOL, POOL_SOL_PRE - 3_000_000, 9),
            ],
        )
        self.assertIsNone(pumpfun.parse_buy(tx, POOL, MINT))

    def test_another_pool_is_ignored(self):
        self.assertIsNone(pumpfun.parse_buy(REAL_BUY, "SomeOtherPool1111111111111111", MINT))

    def test_failed_transaction_is_ignored(self):
        tx = _tx(
            pre=REAL_BUY["meta"]["preTokenBalances"],
            post=REAL_BUY["meta"]["postTokenBalances"],
            err={"InstructionError": [3, {"Custom": 6002}]},
        )
        self.assertIsNone(pumpfun.parse_buy(tx, POOL, MINT))

    def test_buyer_is_the_recipient_not_the_signer(self):
        """An aggregator or a relayer may pay the fee for someone else."""
        tx = _tx(
            pre=REAL_BUY["meta"]["preTokenBalances"],
            post=REAL_BUY["meta"]["postTokenBalances"],
            fee_payer="Rel4yer11111111111111111111111111111111111",
        )
        self.assertEqual(pumpfun.parse_buy(tx, POOL, MINT)["buyer"], BUYER)

    def test_flat_arbitrage_falls_back_to_the_fee_payer(self):
        """Bought here and sold on elsewhere in the same transaction: nobody
        ends up holding, so the signer is the closest thing to a trader."""
        arb = "Arb1111111111111111111111111111111111111111"
        tx = _tx(
            pre=[
                _balance(19, MINT, POOL, POOL_COIN_PRE, 6),
                _balance(20, WSOL, POOL, POOL_SOL_PRE, 9),
            ],
            post=[
                _balance(19, MINT, POOL, POOL_COIN_POST, 6),
                _balance(20, WSOL, POOL, POOL_SOL_POST, 9),
            ],
            fee_payer=arb,
        )
        buy = pumpfun.parse_buy(tx, POOL, MINT)
        self.assertEqual(buy["buyer"], arb)
        self.assertFalse(buy["new_holder"])
        self.assertIsNone(buy["position_pct"])


class MarketCapTest(unittest.TestCase):
    """The gap this exists to close, pinned to the trade that exposed it.

    On 2026-09-13 a 6.936224 SOL buy landed in the pool below. The post said
    $39 917 — DexScreener's marketCap, which prices the coin at that buy's own
    average fill — while pump.fun's page said $43.1k, pricing it at the
    reserves the buy left behind. Both are arithmetic on the same trade; only
    the second is what a reader sees on opening the chart the post links to.
    """

    # Pool before and after, raw, from signature k7Hmz458…znKj (slot 446770009).
    BIG_COIN_PRE = 240704572933941
    BIG_COIN_POST = 223175005135650
    BIG_SOL_PRE = 88289813669
    BIG_SOL_POST = 95226037599

    # SOL/USD as the pair quoted it that minute, and the mint's supply on chain.
    SOL_USD = 101.11
    SUPPLY = 997917108.037699

    def _big_buy(self):
        tx = _tx(
            pre=[
                _balance(5, MINT, POOL, self.BIG_COIN_PRE, 6),
                _balance(6, WSOL, POOL, self.BIG_SOL_PRE, 9),
            ],
            post=[
                _balance(4, MINT, BUYER, 17529567798291, 6),
                _balance(5, MINT, POOL, self.BIG_COIN_POST, 6),
                _balance(6, WSOL, POOL, self.BIG_SOL_POST, 9),
            ],
        )
        return pumpfun.parse_buy(tx, POOL, MINT)

    def test_reserves_left_by_the_trade_are_carried_on_the_buy(self):
        buy = self._big_buy()
        self.assertAlmostEqual(buy["pool_coin"], 223175005.13565, places=5)
        self.assertAlmostEqual(buy["pool_sol"], 95.226037599, places=9)

    def test_cap_is_the_price_the_buy_ended_at(self):
        """$43.1k — what pump.fun showed — not the $39.9k the feed showed."""
        cap = pumpfun.market_cap_after(self._big_buy(), self.SOL_USD, self.SUPPLY)
        self.assertAlmostEqual(cap, 43053.0, delta=1.0)

    def test_the_feeds_figure_is_the_average_fill_and_undershoots(self):
        """Why the old post was low: a buy's fill price is below where it ends,
        and the larger the buy the wider the gap."""
        buy = self._big_buy()
        fill = buy["sol_amount"] / buy["token_amount"] * self.SUPPLY * self.SOL_USD
        cap = pumpfun.market_cap_after(buy, self.SOL_USD, self.SUPPLY)
        self.assertAlmostEqual(fill, 39924.6, delta=1.0)
        self.assertGreater(cap / fill, 1.07)

    def test_a_small_buy_barely_moves_it(self):
        """The same arithmetic on the fixture trade: 0.98 SOL into 81 SOL."""
        buy = pumpfun.parse_buy(REAL_BUY, POOL, MINT)
        fill = buy["sol_amount"] / buy["token_amount"] * self.SUPPLY * self.SOL_USD
        cap = pumpfun.market_cap_after(buy, self.SOL_USD, self.SUPPLY)
        self.assertLess(cap / fill, 1.02)

    def test_a_missing_number_is_none_never_zero(self):
        buy = self._big_buy()
        self.assertIsNone(pumpfun.market_cap_after(buy, None, self.SUPPLY))
        self.assertIsNone(pumpfun.market_cap_after(buy, self.SOL_USD, None))
        self.assertIsNone(pumpfun.market_cap_after({}, self.SOL_USD, self.SUPPLY))
        self.assertIsNone(
            pumpfun.market_cap_after(
                dict(buy, pool_coin=0.0), self.SOL_USD, self.SUPPLY
            )
        )


class FormatBuyTest(unittest.TestCase):
    def test_post_layout(self):
        buy = pumpfun.parse_buy(REAL_BUY, POOL, MINT)
        # 0.981430814 SOL at the pair's own SOL/USD quote.
        text = pumpfun.format_buy(buy, usd=52.51, market_cap=22662.0)
        lines = text.split("\n")

        self.assertEqual(lines[0], '<a href="https://t.me/cyberia_network_chat">cyber.sol</a> Buy!')
        self.assertEqual(lines[1], "⛓️‍💥🎲" * 11)
        # The blank lines are the layout: header, then the trade, then links.
        self.assertEqual(lines[2], "")
        self.assertEqual(lines[3], "🔀 0.9814 SOL ($52.51)")
        self.assertEqual(lines[4], "🔀 3 133 447.2 CYBER.sol")
        self.assertEqual(
            lines[5],
            f'👤 <a href="https://solscan.io/address/{BUYER}">Dox7A7...hSUJ</a> | '
            f'<a href="https://solscan.io/tx/{SIGNATURE}">Txn</a>',
        )
        self.assertEqual(lines[6], "⬆️ New Holder!")
        self.assertEqual(lines[7], "💸 Market Cap $22 662")
        self.assertEqual(lines[8], "")
        self.assertEqual(
            lines[9],
            f'📈 <a href="https://dexscreener.com/solana/{MINT}">Chart</a>   '
            f'🛒 <a href="https://pump.fun/coin/{MINT}">Buy</a>',
        )
        self.assertEqual(len(lines), 10)

    def test_growing_a_position_says_so_instead_of_new_holder(self):
        buy = pumpfun.parse_buy(_top_up(1_000_000_000_000, 340_000_000_000), POOL, MINT)
        text = pumpfun.format_buy(buy, usd=52.51, market_cap=22662.0)
        self.assertIn("⬆️ Position: 34% Up!", text.split("\n"))
        self.assertNotIn("New Holder", text)

    def test_a_position_that_barely_moved_says_nothing(self):
        """Rounded, a 0.1% top-up would print as '0% Up!'."""
        buy = pumpfun.parse_buy(_top_up(1_000_000_000_000, 1_000_000_000), POOL, MINT)
        self.assertNotIn("Position", pumpfun.format_buy(buy, usd=52.51, market_cap=22662.0))

    def test_a_big_position_jump_is_grouped_like_the_other_numbers(self):
        buy = pumpfun.parse_buy(_top_up(1_000_000, 12_500_000_000), POOL, MINT)
        self.assertIn(
            "⬆️ Position: 1 250 000% Up!",
            pumpfun.format_buy(buy, usd=52.51, market_cap=22662.0).split("\n"),
        )

    def test_a_buyer_who_kept_nothing_has_neither_line(self):
        buy = dict(pumpfun.parse_buy(REAL_BUY, POOL, MINT), new_holder=False, position_pct=None)
        text = pumpfun.format_buy(buy, usd=52.51, market_cap=22662.0)
        self.assertNotIn("New Holder", text)
        self.assertNotIn("Position", text)

    def test_unknown_market_cap_is_omitted_never_zero(self):
        buy = pumpfun.parse_buy(REAL_BUY, POOL, MINT)
        self.assertNotIn("Market Cap", pumpfun.format_buy(buy, usd=52.51, market_cap=None))

    def test_emoji_row_scales_with_size_and_is_capped(self):
        self.assertEqual(pumpfun._emoji_row(5.0), "⛓️‍💥🎲")
        self.assertEqual(pumpfun._emoji_row(100.0), "⛓️‍💥🎲" * 20)
        self.assertEqual(pumpfun._emoji_row(10_000_000.0), "⛓️‍💥🎲" * 40)
        # A buy just over the floor still gets a row.
        self.assertEqual(pumpfun._emoji_row(5.01), "⛓️‍💥🎲")


class CursorTest(unittest.TestCase):
    def test_slot_then_index_in_block(self):
        """Two buys in one slot must not collapse onto the same cursor."""
        first = pumpfun._cursor_of({"slot": 438515078, "transactionIndex": 12})
        second = pumpfun._cursor_of({"slot": 438515078, "transactionIndex": 1281})
        later_slot = pumpfun._cursor_of({"slot": 438515079, "transactionIndex": 0})
        self.assertLess(first, second)
        self.assertLess(second, later_slot)

    def test_missing_index_defaults_to_zero(self):
        self.assertEqual(pumpfun._cursor_of({"slot": 7}), (7, 0))


class FetchTest(unittest.TestCase):
    def test_asks_for_version_one_transactions(self):
        """A v1 buy fetched with a v0 cap is refused, and the scan holds its
        cursor on it forever — every buy after it went unannounced."""
        from unittest import mock
        with mock.patch.object(pumpfun, "_rpc", return_value=None) as rpc:
            pumpfun._get_transaction(SIGNATURE)
        opts = rpc.call_args.args[1][1]
        self.assertGreaterEqual(opts["maxSupportedTransactionVersion"], 1)


if __name__ == "__main__":
    unittest.main()
