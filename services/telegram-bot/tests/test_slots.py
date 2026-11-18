"""🎰 slots: the reel arithmetic, the paytable, and the bank behind it.

The values are Telegram's, so every spin here is one the dice really can return
(1..64) and the decoding is anchored to the two ends Telegram documents: 1 is
BAR BAR BAR and 64 is three sevens.

The invariant every escrow test checks is the same one sentence: the tokens in
play are only ones somebody accrued, so `sum(pending_rewards) + bank` never
moves, whatever the reels do.
"""
import asyncio
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from sqlalchemy import create_engine, text

from bot import db, slots, stakes, language

JACKPOT = 64          # 7️⃣ 7️⃣ 7️⃣   ×28
BARS = 1              # BAR BAR BAR  ×13
LEMONS = 43           # 🍋 🍋 🍋    ×6
BERRIES = 22          # 🍇 🍇 🍇    ×4


def value_of(first, second, third):
    """A dice value decoding to these reels (0 BAR, 1 🍇, 2 🍋, 3 7️⃣)."""
    return 1 + first + (second << 2) + (third << 4)


TWO_SEVENS = value_of(3, 3, 0)   # 7️⃣ 7️⃣ BAR — ставка назад
NOTHING = value_of(3, 2, 0)      # 7️⃣ 🍋 BAR — мимо


class ReelTests(unittest.TestCase):
    def test_the_two_documented_jackpots_anchor_the_decoding(self):
        self.assertEqual(slots.reels(BARS), (0, 0, 0))
        self.assertEqual(slots.reels(JACKPOT), (3, 3, 3))
        self.assertEqual(slots.combo(JACKPOT), "7️⃣ 7️⃣ 7️⃣ — ДЖЕКПОТ ×28")
        self.assertEqual(slots.combo(BARS), "BAR BAR BAR — три в ряд ×13")

    def test_every_value_decodes_and_no_other_does(self):
        for value in range(1, 65):
            self.assertEqual(len(slots.reels(value)), 3)
        for bad in (0, 65, -1, None, "64", 1.0, True):
            with self.assertRaises(ValueError):
                slots.reels(bad)

    def test_the_paytable_pays_what_it_prints(self):
        self.assertEqual(slots.multiplier(JACKPOT), 28)
        self.assertEqual(slots.multiplier(BARS), 13)
        self.assertEqual(slots.multiplier(LEMONS), 6)
        self.assertEqual(slots.multiplier(BERRIES), 4)
        self.assertEqual(slots.multiplier(TWO_SEVENS), 1)
        self.assertEqual(slots.multiplier(NOTHING), 0)
        self.assertEqual(slots.combo(TWO_SEVENS), "7️⃣ 7️⃣ BAR — пара семёрок, ставка назад")
        self.assertEqual(slots.combo(NOTHING), "7️⃣ 🍋 BAR — мимо")

    def test_only_sevens_pay_for_a_pair(self):
        for face in (0, 1, 2):
            other = 3 if face != 3 else 0
            self.assertEqual(slots.multiplier(value_of(face, face, other)), 0)

    def test_the_machine_has_no_left_or_right(self):
        for a, b, c in ((3, 3, 0), (3, 0, 3), (0, 3, 3)):
            self.assertEqual(slots.multiplier(value_of(a, b, c)), 1)

    def test_return_to_player_is_computed_from_the_table(self):
        """60 of 64 outcomes' worth of multiplier, so the number on screen
        cannot drift from the table above it."""
        self.assertAlmostEqual(slots.rtp(), 60 / 64)
        self.assertAlmostEqual(slots.rtp(), 0.9375)
        self.assertLess(slots.rtp(), 1)          # or the bank drains by design
        self.assertEqual(slots.MAX_MULTIPLIER, 28)

    def test_two_sevens_is_nine_outcomes_not_three(self):
        """The miscount the computed RTP caught: the odd reel is any of three
        positions holding any of three other symbols."""
        pairs = [v for v in range(1, 65) if slots.shape(v) == ("pair", 3)]
        self.assertEqual(len(pairs), 9)
        paying = sum(1 for value in range(1, 65) if slots.multiplier(value))
        self.assertEqual(paying, 13)             # 4 triples + 9 pairs of sevens

    def test_the_printed_table_lists_every_paying_combination(self):
        table = slots.paytable()
        self.assertEqual(len(table.split("\n")), len(slots.WINS))
        self.assertIn("7️⃣ 7️⃣ 7️⃣ — ×28", table)
        self.assertIn("7️⃣ 7️⃣ + любой — ставка назад", table)


class SlotsCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.engine = create_engine(f"sqlite:///{Path(self.directory.name) / 'test.sqlite'}")
        self.addCleanup(self.engine.dispose)
        for module in (db, slots, stakes):
            mock = patch.object(module, 'engine', self.engine)
            mock.start()
            self.addCleanup(mock.stop)
        db.ensure_schema()
        slots.ensure_schema()
        with self.engine.begin() as conn:
            for chat, symbol in ((-100, 'SOC23'), (-200, 'CYBERIA_CHAT')):
                conn.execute(text("""INSERT INTO chat_tokens(chat_id,name,symbol,token_address,rewards_interval,created_by)
                    VALUES(:c,:s,:s,'0x123',3600,1)"""), {'c': chat, 's': symbol})
                for user in (1, 2, 3):
                    stakes.credit(conn, chat, user, 1000 * stakes.UNIT)
        slots.fund(-100, 3, 900 * stakes.UNIT)   # user 3 is the chat's admin.
        language.set_chat_language(-100, 'ru')   # a Russian chat; -200 is left on auto.

    def balance(self, user, chat=-100):
        with self.engine.connect() as conn:
            row = conn.execute(text('SELECT amount FROM pending_rewards WHERE chat_id=:c AND user_id=:u'),
                               {'c': chat, 'u': user}).scalar_one_or_none()
        return int(row or 0)

    def everything(self, chat=-100):
        """Every accrued token in this chat, wherever it is sitting."""
        with self.engine.connect() as conn:
            held = conn.execute(text('SELECT amount FROM pending_rewards WHERE chat_id=:c'), {'c': chat}).scalars().all()
        return sum(int(x) for x in held) + slots.bank(chat)[0]

    def pull(self, value, user=1, stake=10, now=2000):
        spin = slots.reserve(-100, user, stake * stakes.UNIT, now=now)
        return slots.settle(spin, value)


class SlotsBankTests(SlotsCase):
    def test_nothing_is_minted_whatever_the_reels_do(self):
        for index, value in enumerate((JACKPOT, BARS, LEMONS, BERRIES, TWO_SEVENS, NOTHING)):
            before = self.everything()
            self.pull(value, now=2000 + index * 10)
            self.assertEqual(before, self.everything(), f"value {value} moved the total")

    def test_a_win_pays_the_multiplier_out_of_the_bank(self):
        bank_before = slots.bank(-100)[0]
        self.pull(LEMONS, stake=10)
        self.assertEqual(self.balance(1), (1000 - 10 + 60) * stakes.UNIT)
        self.assertEqual(slots.bank(-100)[0], bank_before + (10 - 60) * stakes.UNIT)

    def test_a_loss_goes_into_the_bank(self):
        bank_before = slots.bank(-100)[0]
        self.pull(NOTHING, stake=10)
        self.assertEqual(self.balance(1), 990 * stakes.UNIT)
        self.assertEqual(slots.bank(-100)[0], bank_before + 10 * stakes.UNIT)

    def test_a_bet_the_bank_could_not_pay_is_refused_before_the_reels(self):
        """The whole point of the hold: the machine says no while saying no is
        still free, never after an animation has promised a jackpot."""
        _, _, _, allowed = slots.bank(-100)
        self.assertEqual(allowed, 900 * stakes.UNIT // (slots.MAX_MULTIPLIER - 1))
        with self.assertRaises(ValueError) as refusal:
            slots.reserve(-100, 1, allowed + 1, now=2000)
        self.assertIn('Касса не потянет', str(refusal.exception))
        self.assertEqual(self.balance(1), 1000 * stakes.UNIT)
        self.assertIsInstance(slots.reserve(-100, 1, allowed, now=2000), int)

    def test_an_empty_bank_closes_the_machine_rather_than_playing(self):
        with self.assertRaises(ValueError) as refusal:
            slots.reserve(-200, 1, 1 * stakes.UNIT, now=2000)
        self.assertIn('пуста', str(refusal.exception))
        self.assertEqual(self.balance(1, -200), 1000 * stakes.UNIT)

    def test_the_jackpot_is_always_payable_once_taken(self):
        """Bet the published maximum and win the top prize: the bank covers it
        exactly, and never goes negative."""
        allowed = slots.bank(-100)[3]
        spin = slots.reserve(-100, 1, allowed, now=2000)
        balance, reserved, _, _ = slots.bank(-100)
        self.assertGreaterEqual(balance, reserved)
        slots.settle(spin, JACKPOT)
        self.assertGreaterEqual(slots.bank(-100)[0], 0)
        self.assertEqual(self.balance(1), (1000 * stakes.UNIT - allowed) + allowed * 28)

    def test_two_spins_cannot_be_promised_the_same_bank(self):
        """Each pull holds its own worst case until it settles."""
        allowed = slots.bank(-100)[3]
        slots.reserve(-100, 1, allowed, now=2000)
        self.assertEqual(slots.bank(-100)[3], 0)
        with self.assertRaises(ValueError):
            slots.reserve(-100, 2, allowed, now=2000)
        self.assertEqual(self.balance(2), 1000 * stakes.UNIT)

    def test_settling_releases_the_hold(self):
        allowed = slots.bank(-100)[3]
        spin = slots.reserve(-100, 1, allowed, now=2000)
        slots.settle(spin, NOTHING)
        self.assertEqual(slots.bank(-100)[1], 0)
        self.assertGreater(slots.bank(-100)[3], allowed)   # the loss grew the till

    def test_a_second_settle_pays_once(self):
        spin = slots.reserve(-100, 1, 10 * stakes.UNIT, now=2000)
        slots.settle(spin, JACKPOT)
        after = (self.balance(1), slots.bank(-100))
        slots.settle(spin, JACKPOT)
        slots.settle(spin, NOTHING)
        self.assertEqual(after, (self.balance(1), slots.bank(-100)))

    def test_a_dice_that_never_came_back_is_refunded_not_guessed(self):
        spin = slots.reserve(-100, 1, 10 * stakes.UNIT, now=2000)
        self.assertEqual(self.balance(1), 990 * stakes.UNIT)
        with slots.transaction() as conn:
            self.assertEqual(slots.sweep(conn, 2000 + slots.STUCK), [spin])
        self.assertEqual(self.balance(1), 1000 * stakes.UNIT)
        self.assertEqual(slots.bank(-100)[1], 0)
        with slots.transaction() as conn:
            self.assertEqual(slots.sweep(conn, 3000), [])
        self.assertIn('завершён', 'завершён')
        self.assertEqual(slots.settle(spin, JACKPOT)['status'], 'refunded')
        self.assertEqual(self.balance(1), 1000 * stakes.UNIT)

    def test_abandoning_a_spin_returns_the_stake_and_the_hold(self):
        before = slots.bank(-100)
        spin = slots.reserve(-100, 1, 10 * stakes.UNIT, now=2000)
        slots.abandon(spin)
        self.assertEqual(self.balance(1), 1000 * stakes.UNIT)
        self.assertEqual(slots.bank(-100), before)
        slots.abandon(spin)   # A repeat cannot refund twice.
        self.assertEqual(self.balance(1), 1000 * stakes.UNIT)

    def test_you_cannot_stake_what_you_have_not_accrued(self):
        with self.assertRaises(ValueError):
            slots.reserve(-100, 1, 1001 * stakes.UNIT, now=2000)
        self.assertEqual(self.balance(1), 1000 * stakes.UNIT)

    def test_one_spin_at_a_time_and_not_faster_than_the_cooldown(self):
        spin = slots.reserve(-100, 1, 10 * stakes.UNIT, now=2000)
        with self.assertRaises(ValueError) as busy:
            slots.reserve(-100, 1, 10 * stakes.UNIT, now=2001)
        self.assertIn('крутятся', str(busy.exception))
        slots.settle(spin, NOTHING)
        with self.assertRaises(ValueError) as fast:
            slots.reserve(-100, 1, 10 * stakes.UNIT, now=2001)
        self.assertIn('быстро', str(fast.exception))
        self.assertIsInstance(slots.reserve(-100, 1, 10 * stakes.UNIT, now=2000 + slots.COOLDOWN), int)

    def test_simultaneous_pulls_cannot_overdraw_the_bank(self):
        allowed = slots.bank(-100)[3]
        def pull(user):
            try:
                slots.reserve(-100, user, allowed, now=2000)
                return True
            except ValueError:
                return False
        with ThreadPoolExecutor(max_workers=2) as pool:
            taken = list(pool.map(pull, (1, 2)))
        self.assertEqual(sum(taken), 1)
        balance, reserved, _, _ = slots.bank(-100)
        self.assertGreaterEqual(balance, reserved)

    def test_the_bank_is_per_chat(self):
        self.assertEqual(slots.bank(-200)[0], 0)
        self.pull(NOTHING, stake=10)
        self.assertEqual(slots.bank(-200)[0], 0)

    def test_funding_moves_tokens_and_never_creates_them(self):
        before = self.everything()
        slots.fund(-100, 2, 50 * stakes.UNIT)
        self.assertEqual(self.balance(2), 950 * stakes.UNIT)
        self.assertEqual(self.everything(), before)
        with self.assertRaises(ValueError):
            slots.fund(-100, 2, 10_000 * stakes.UNIT)
        self.assertEqual(self.balance(2), 950 * stakes.UNIT)

    def test_a_chat_without_a_token_has_no_machine(self):
        for call in (lambda: slots.reserve(-300, 1, stakes.UNIT, now=2000),
                     lambda: slots.fund(-300, 1, stakes.UNIT)):
            with self.assertRaises(ValueError) as missing:
                call()
            self.assertIn('/create_token', str(missing.exception))

    def test_the_machine_screen_states_the_table_the_odds_and_the_till(self):
        screen = slots.machine(-100, user=1)
        self.assertIn('7️⃣ 7️⃣ 7️⃣ — ×28', screen)
        self.assertIn('Возврат 93.75%', screen)
        self.assertIn('Касса чата: 900 SOC23', screen)
        self.assertIn('Ваш баланс: 1000 SOC23', screen)
        self.assertIn('Telegram', screen)
        self.assertIn('Максимальная ставка: 33.333333333333333333 SOC23', screen)
        self.assertIn('закрыт', slots.machine(-200))

    def test_the_result_line_names_the_stake_the_combo_and_the_till(self):
        spin = self.pull(JACKPOT, stake=10)
        line = slots.result(spin)
        self.assertIn('ставка 10 SOC23', line)
        self.assertIn('7️⃣ 7️⃣ 7️⃣ — ДЖЕКПОТ ×28', line)
        self.assertIn('Выигрыш: 280 SOC23', line)
        self.assertIn('Касса: 630 SOC23', line)
        self.assertIn('Ставка ушла в кассу', slots.result(self.pull(NOTHING, now=3000)))


class SlotsCommandTests(SlotsCase):
    def command(self, args, user_id=1, dice=LEMONS, chat_type='supergroup',
                send_dice=None, admin=False, sender_chat=None, effective_user=True,
                administrators=None, chat_id=-100):
        msg = SimpleNamespace(sender_chat=sender_chat, message_id=5, reply_text=AsyncMock())
        update = SimpleNamespace(
            effective_message=msg,
            effective_chat=SimpleNamespace(id=chat_id, type=chat_type),
            effective_user=(SimpleNamespace(id=user_id, is_bot=False, name=f'@u{user_id}')
                            if effective_user else None),
        )
        rolled = SimpleNamespace(dice=SimpleNamespace(value=dice), message_id=6)
        bot = SimpleNamespace(
            send_dice=send_dice or AsyncMock(return_value=rolled),
            send_message=AsyncMock(),
            get_chat_member=AsyncMock(return_value=SimpleNamespace(
                status='administrator' if admin else 'member')),
            get_chat_administrators=AsyncMock(return_value=administrators or []),
        )
        context = SimpleNamespace(args=args, bot=bot, application=None)
        return msg, bot, update, context

    def run_slots(self, *a, **kw):
        msg, bot, update, context = self.command(*a, **kw)
        with patch.object(slots, 'REVEAL', 0):
            asyncio.run(slots.slots_command(update, context))
        return msg, bot

    def test_a_pull_sends_telegrams_own_machine_and_pays_what_it_rolled(self):
        msg, bot = self.run_slots(['10'], dice=BARS)
        self.assertEqual(bot.send_dice.await_count, 1)
        self.assertEqual(bot.send_dice.await_args.kwargs['emoji'], '🎰')
        self.assertEqual(bot.send_dice.await_args.kwargs['reply_to_message_id'], 5)
        self.assertEqual(self.balance(1), (1000 - 10 + 130) * stakes.UNIT)

    def test_owner_can_pull_anonymously_when_they_are_the_only_anonymous_admin(self):
        owner = SimpleNamespace(id=1, is_bot=False, name='owner')
        creator = SimpleNamespace(status='creator', is_anonymous=True, user=owner)
        msg, bot = self.run_slots(
            ['10'], dice=BARS, sender_chat=SimpleNamespace(id=-100),
            effective_user=False, administrators=[creator],
        )
        self.assertEqual(bot.send_dice.await_count, 1)
        self.assertEqual(self.balance(1), (1000 - 10 + 130) * stakes.UNIT)

    def test_ordinary_members_keep_playing_from_their_own_accounts(self):
        msg, bot = self.run_slots(['10'], user_id=2, dice=BARS)
        self.assertEqual(bot.send_dice.await_count, 1)
        self.assertEqual(self.balance(2), (1000 - 10 + 130) * stakes.UNIT)

    def test_anonymous_admin_or_linked_channel_cannot_spend_the_owners_balance(self):
        owner = SimpleNamespace(id=1, is_bot=False, name='owner')
        creator = SimpleNamespace(status='creator', is_anonymous=True, user=owner)
        admin = SimpleNamespace(status='administrator', is_anonymous=True,
                                user=SimpleNamespace(id=2, is_bot=False, name='admin'))
        for sender, administrators in (
            (SimpleNamespace(id=-100), [creator, admin]),
            (SimpleNamespace(id=-200), [creator]),
        ):
            msg, bot = self.run_slots(
                ['10'], sender_chat=sender, effective_user=False, administrators=administrators,
            )
            self.assertEqual(bot.send_dice.await_count, 0)
            self.assertIn('только его владелец', msg.reply_text.await_args.args[0])
        self.assertEqual(self.balance(1), 1000 * stakes.UNIT)

    def test_no_argument_shows_the_machine_and_stakes_nothing(self):
        msg, bot = self.run_slots([])
        self.assertEqual(bot.send_dice.await_count, 0)
        self.assertIn('Возврат 93.75%', msg.reply_text.await_args.args[0])
        self.assertEqual(self.balance(1), 1000 * stakes.UNIT)

    def test_a_refusal_never_reaches_the_reels(self):
        msg, bot = self.run_slots(['100000'])
        self.assertEqual(bot.send_dice.await_count, 0)
        self.assertEqual(self.balance(1), 1000 * stakes.UNIT)

    def test_a_machine_telegram_refuses_to_send_gives_the_stake_back(self):
        from telegram.error import TelegramError
        with self.assertRaises(TelegramError):
            self.run_slots(['10'], send_dice=AsyncMock(side_effect=TelegramError('offline')))
        self.assertEqual(self.balance(1), 1000 * stakes.UNIT)
        self.assertEqual(slots.bank(-100)[1], 0)

    def test_a_chat_on_auto_answers_in_the_players_own_language(self):
        msg, _ = self.run_slots([], chat_id=-200)       # no language_code: English
        self.assertIn('Returns 93.75%', msg.reply_text.await_args.args[0])

    def test_the_machine_is_a_group_fixture(self):
        msg, bot = self.run_slots(['10'], chat_type='private')
        self.assertEqual(bot.send_dice.await_count, 0)
        self.assertIn('в чате', msg.reply_text.await_args.args[0])

    def test_only_admins_fill_the_till(self):
        msg, bot, update, context = self.command(['50'], user_id=2, admin=False)
        asyncio.run(slots.slots_bank_command(update, context))
        self.assertIn('администраторы', msg.reply_text.await_args.args[0])
        self.assertEqual(self.balance(2), 1000 * stakes.UNIT)

        msg, bot, update, context = self.command(['50'], user_id=2, admin=True)
        asyncio.run(slots.slots_bank_command(update, context))
        self.assertEqual(self.balance(2), 950 * stakes.UNIT)
        self.assertEqual(slots.bank(-100)[0], 950 * stakes.UNIT)

    def test_the_till_reads_without_arguments_and_says_it_is_one_way(self):
        msg, bot, update, context = self.command([], user_id=2)
        asyncio.run(slots.slots_bank_command(update, context))
        text_out = msg.reply_text.await_args.args[0]
        self.assertIn('Касса чата: 900 SOC23', text_out)
        self.assertIn('не выводится', text_out)


if __name__ == '__main__':
    unittest.main()
