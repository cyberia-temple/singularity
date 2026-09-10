"""The [Swap] button, and the Telegram rule that decides its shape.

The bot has no private key and must never have one, so it cannot trade for
anybody. What it can do is hand the person to the wallet with the token already
chosen — the mini app is the wallet, and it reads `?swap=<contract>` on the way
in. A `web_app` button is legal only in a private chat; Telegram rejects the
whole message otherwise, which would turn a helpful button into a /balance that
answers nothing in a group.
"""
import asyncio
import unittest
from types import SimpleNamespace
from urllib.parse import urlparse, parse_qs
from unittest.mock import AsyncMock
from unittest.mock import patch

from sqlalchemy import create_engine, text

from bot import handlers

TOKEN = "0x000000000000000000000000000000000000dEaD"


class SwapMarkupTests(unittest.TestCase):
    def test_a_private_chat_gets_a_web_app_button(self):
        markup = handlers.swap_markup(True, [("ROOM", TOKEN)])
        button = markup.inline_keyboard[0][0]

        self.assertIsNotNone(button.web_app)
        self.assertIsNone(button.url)
        self.assertIn(f"swap={TOKEN}", button.web_app.url)

    def test_a_group_links_to_the_bot_instead_of_the_site(self):
        # Telegram rejects a message carrying a web_app button outside a
        # private chat, so the whole /balance answer would fail to send.
        markup = handlers.swap_markup(False, [("ROOM", TOKEN)], "example_bot")
        button = markup.inline_keyboard[0][0]

        self.assertIsNone(button.web_app)
        self.assertEqual(button.url, f"https://t.me/example_bot?start=swap_{TOKEN}")

    def test_nothing_to_swap_is_no_keyboard_at_all(self):
        self.assertIsNone(handlers.swap_markup(True, []))

    def test_the_row_is_capped(self):
        many = [(f"T{i}", TOKEN) for i in range(20)]

        self.assertEqual(len(handlers.swap_markup(True, many).inline_keyboard), 6)

    def test_each_token_gets_its_own_button(self):
        markup = handlers.swap_markup(True, [("A", TOKEN), ("B", TOKEN)])

        self.assertEqual(len(markup.inline_keyboard), 2)
        self.assertIn("Swap A", markup.inline_keyboard[0][0].text)
        self.assertIn("Swap B", markup.inline_keyboard[1][0].text)


class SwapHandoffTests(unittest.TestCase):
    def test_group_link_opens_private_mini_app_with_the_same_token(self):
        button = handlers.swap_markup(False, [("SOC23", TOKEN)]).inline_keyboard[0][0]
        payload = parse_qs(urlparse(button.url).query)['start'][0]
        self.assertLessEqual(len(payload), 64)
        update = SimpleNamespace(effective_chat=SimpleNamespace(type="private"),
                                 message=SimpleNamespace(reply_text=AsyncMock()))
        context = SimpleNamespace(args=[payload])
        asyncio.run(handlers.start_command(update, context))
        reply = update.message.reply_text.call_args.kwargs['reply_markup'].inline_keyboard[0][0]
        self.assertIsNone(reply.url)
        self.assertEqual(parse_qs(urlparse(reply.web_app.url).query)['swap'], [TOKEN])

    def test_bad_payload_never_opens_a_wallet(self):
        update = SimpleNamespace(effective_chat=SimpleNamespace(type="private"),
                                 message=SimpleNamespace(reply_text=AsyncMock()))
        for payload in ('swap_https://example.org', 'swap_0x123', 'swap_' + TOKEN + '?evil=1'):
            asyncio.run(handlers.start_command(update, SimpleNamespace(args=[payload])))
            self.assertNotIn('reply_markup', update.message.reply_text.call_args.kwargs)

    def test_payload_in_group_never_emits_a_web_app_button(self):
        update = SimpleNamespace(effective_chat=SimpleNamespace(type="supergroup"),
                                 message=SimpleNamespace(reply_text=AsyncMock()))
        asyncio.run(handlers.start_command(update, SimpleNamespace(args=['swap_' + TOKEN])))
        self.assertNotIn('reply_markup', update.message.reply_text.call_args.kwargs)


class TokenAddressLookupTests(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE TABLE chat_tokens (chat_id INTEGER PRIMARY KEY, name TEXT, "
                "symbol TEXT NOT NULL, token_address TEXT)"
            ))
            conn.execute(text(
                "INSERT INTO chat_tokens (chat_id, name, symbol, token_address) "
                f"VALUES (-1, 'Room', 'ROOM', '{TOKEN}'), (-2, 'Pend', 'PEND', NULL)"
            ))
        self._patch = patch.object(handlers, "engine", engine)
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def test_resolves_symbols_to_addresses(self):
        self.assertEqual(handlers._token_addresses(["ROOM"]), [("ROOM", TOKEN)])

    def test_skips_a_token_still_being_deployed(self):
        # No address means nothing to open the swap screen on.
        self.assertEqual(handlers._token_addresses(["PEND"]), [])

    def test_no_symbols_is_no_query(self):
        self.assertEqual(handlers._token_addresses([]), [])


if __name__ == "__main__":
    unittest.main()
