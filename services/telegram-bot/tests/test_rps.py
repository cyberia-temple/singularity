import asyncio
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from sqlalchemy import create_engine, text

from bot import db, rps


class RpsTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.engine = create_engine(f"sqlite:///{Path(self.directory.name) / 'test.sqlite'}")
        self.addCleanup(self.engine.dispose)
        for module in (db, rps):
            mock = patch.object(module, 'engine', self.engine)
            mock.start()
            self.addCleanup(mock.stop)
        db.ensure_schema()
        rps.ensure_schema()
        with self.engine.begin() as conn:
            for chat, symbol in ((-100, 'SOC23'), (-200, 'CYBERIA_CHAT')):
                conn.execute(text("""INSERT INTO chat_tokens(chat_id,name,symbol,token_address,rewards_interval,created_by)
                    VALUES(:c,:s,:s,'0x123',3600,1)"""), {'c': chat, 's': symbol})
                for user in (1, 2, 3):
                    rps.credit(conn, chat, user, 100 * rps.UNIT)

    def balance(self, user, chat=-100):
        with self.engine.connect() as conn:
            return int(conn.execute(text('SELECT amount FROM pending_rewards WHERE chat_id=:c AND user_id=:u'), {'c': chat, 'u': user}).scalar_one())

    def game(self, user=1, chat=-100):
        return rps.create(chat, user, 10 * rps.UNIT, now=1000)

    def test_all_nine_results_conserve_tokens(self):
        for first in rps.MOVES:
            for second in rps.MOVES:
                before = [self.balance(u) for u in (1, 2)]
                game = self.game()
                rps.play(game, -100, 1, first, now=1001)
                rps.play(game, -100, 2, second, now=1002)
                state, _, buttons = rps.view(game)
                self.assertIsNone(buttons)
                after = [self.balance(u) for u in (1, 2)]
                self.assertEqual(sum(before), sum(after))
                if first == second:
                    self.assertEqual(state['status'], 'draw')
                    self.assertEqual(before, after)
                else:
                    winner = 1 if (first, second) in {('r', 's'), ('s', 'p'), ('p', 'r')} else 2
                    self.assertEqual(state['winner'], winner)
                    self.assertEqual(after[winner - 1], before[winner - 1] + 10 * rps.UNIT)
                rps.play(game, -100, 2, second, now=1003)
                self.assertEqual(after, [self.balance(u) for u in (1, 2)])

    def test_stakes_hidden_and_immutable(self):
        game = self.game()
        self.assertEqual(self.balance(1), 90 * rps.UNIT)
        rps.play(game, -100, 1, 'r', now=1001)
        rps.play(game, -100, 1, 'p', now=1002)
        state, label, _ = rps.view(game)
        self.assertEqual(state['creator_move'], 'r')
        self.assertNotIn('🪨', label)
        self.assertEqual(self.balance(2), 100 * rps.UNIT)
        with self.assertRaises(ValueError):
            self.game()

    def test_expiry_refunds_each_once_after_restart(self):
        game = self.game()
        rps.play(game, -100, 2, 's', now=1001)
        rps.ensure_schema()  # Startup never resets active escrow.
        with rps.transaction() as conn:
            self.assertEqual(rps.expire(conn, 1600), [game])
        with rps.transaction() as conn:
            self.assertEqual(rps.expire(conn, 1601), [])
        self.assertEqual(self.balance(1), 100 * rps.UNIT)
        self.assertEqual(self.balance(2), 100 * rps.UNIT)
        rps.play(game, -100, 1, 'r', now=1602)
        self.assertEqual(rps.view(game)[0]['status'], 'expired')

    def test_late_move_returns_escrow(self):
        game = self.game()
        rps.play(game, -100, 2, 's', now=1600)
        self.assertEqual(self.balance(1), 100 * rps.UNIT)
        self.assertEqual(self.balance(2), 100 * rps.UNIT)

    def test_cancel_permissions_and_cross_chat(self):
        game = self.game()
        for chat, user in ((-200, 1), (-100, 2)):
            with self.assertRaises(ValueError):
                rps.play(game, chat, user, 'cancel', now=1001)
        rps.play(game, -100, 1, 'cancel', now=1002)
        rps.play(game, -100, 1, 'cancel', now=1003)
        self.assertEqual(self.balance(1), 100 * rps.UNIT)
        game = self.game()
        rps.play(game, -100, 2, 's', now=1001)
        for user, move in ((1, 'cancel'), (3, 'r')):
            with self.assertRaises(ValueError):
                rps.play(game, -100, user, move, now=1002)
        self.assertEqual(self.balance(3), 100 * rps.UNIT)
        self.assertEqual(self.balance(1, -200), 100 * rps.UNIT)

    def test_insufficient_funds_roll_back_and_wallet_not_required(self):
        with self.assertRaises(ValueError):
            rps.create(-100, 1, 101 * rps.UNIT, now=1000)
        game = self.game()
        with self.assertRaises(ValueError):
            rps.play(game, -100, 4, 'r', now=1001)
        self.assertIsNone(rps.view(game)[0]['opponent'])
        rps.play(game, -100, 2, 'r', now=1001)
        with self.engine.connect() as conn:
            self.assertEqual(conn.execute(text('SELECT count(*) FROM tg_wallets')).scalar_one(), 0)
            self.assertEqual(conn.execute(text('SELECT count(*) FROM chat_members')).scalar_one(), 2)

    def test_two_simultaneous_opponents_only_one_pays(self):
        game = self.game()
        def join(user):
            try:
                rps.play(game, -100, user, 'r', now=1001)
                return True
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(join, (2, 3)))
        self.assertEqual(sum(results), 1)
        self.assertEqual(self.balance(2) + self.balance(3), 190 * rps.UNIT)

    def test_decimal_parser_never_uses_float(self):
        self.assertEqual(rps.parse_stake('1,000000000000000001'), rps.UNIT + 1)
        self.assertEqual(rps.amount(rps.UNIT + 1), '1.000000000000000001')
        for value in ('0', '-1', 'nan', '1e10', '0.0000000000000000001', '9' * 60):
            with self.assertRaises(ValueError):
                rps.parse_stake(value)

    def test_callback_admits_ordinary_and_restricted_members_only(self):
        game = self.game()
        user = SimpleNamespace(id=2, is_bot=False, name="@player")
        query = SimpleNamespace(from_user=user, data=f"rps:{game}:s", answer=AsyncMock())
        update = SimpleNamespace(callback_query=query, effective_chat=SimpleNamespace(id=-100, type="supergroup"))
        bot = SimpleNamespace(get_chat_member=AsyncMock(), edit_message_text=AsyncMock())
        with patch.object(rps.time, "time", return_value=1001):
            for status in ("left", "kicked"):
                bot.get_chat_member.return_value = SimpleNamespace(status=status)
                asyncio.run(rps.rps_callback(update, SimpleNamespace(bot=bot)))
                self.assertIsNone(rps.view(game)[0]['opponent'])
            bot.get_chat_member.return_value = SimpleNamespace(status="restricted", is_member=True)
            asyncio.run(rps.rps_callback(update, SimpleNamespace(bot=bot)))
        self.assertEqual(rps.view(game)[0]['opponent'], 2)
        self.assertIn("@player", rps.view(game)[1])
        self.assertEqual(self.balance(2), 90 * rps.UNIT)

    def test_claimable_balance_excludes_escrow(self):
        game = self.game()
        # /claim reads only pending_rewards; removing the free balance cannot
        # take the already reserved stake or prevent its subsequent refund.
        with self.engine.begin() as conn:
            self.assertEqual(self.balance(1), 90 * rps.UNIT)
            conn.execute(text("DELETE FROM pending_rewards WHERE chat_id=-100 AND user_id=1"))
        rps.play(game, -100, 1, 'cancel', now=1001)
        self.assertEqual(self.balance(1), 10 * rps.UNIT)

    def test_failed_telegram_send_refunds(self):
        from telegram.error import TelegramError
        msg = SimpleNamespace(sender_chat=None, reply_text=AsyncMock(side_effect=TelegramError('offline')))
        update = SimpleNamespace(effective_message=msg, effective_chat=SimpleNamespace(id=-100, type='supergroup'), effective_user=SimpleNamespace(id=1, is_bot=False))
        with self.assertRaises(TelegramError):
            asyncio.run(rps.rps_command(update, SimpleNamespace(args=['10'])))
        self.assertEqual(self.balance(1), 100 * rps.UNIT)


if __name__ == '__main__':
    unittest.main()
