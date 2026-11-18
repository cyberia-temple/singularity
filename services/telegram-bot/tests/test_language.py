"""🌐 /language: a chat's admins pick Russian or English; until then everyone is
answered in their own Telegram app's language.

The questions are who may choose, which choice wins, and that the command menu
follows the chat — the menu is the first thing a newcomer reads.
"""
import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from sqlalchemy import create_engine
from telegram import BotCommandScopeChat

from bot import db, language
from bot.language import T, lang_for, say


class LanguageCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.engine = create_engine(f"sqlite:///{Path(self.directory.name) / 'test.sqlite'}")
        self.addCleanup(self.engine.dispose)
        mock = patch.object(db, "engine", self.engine)
        mock.start()
        self.addCleanup(mock.stop)
        db.ensure_schema()


class ChoiceTests(LanguageCase):
    def test_a_telegram_app_in_russian_reads_russian_and_everything_else_english(self):
        for code, lang in (("ru", "ru"), ("ru-RU", "ru"), ("be", "ru"), ("kk", "ru"),
                           ("en", "en"), ("de", "en"), ("uk", "en"), (None, "en"), ("", "en")):
            self.assertEqual(language.guess(code), lang, code)

    def test_the_chat_choice_outranks_the_app_and_auto_hands_it_back(self):
        russian = SimpleNamespace(language_code="ru")
        self.assertEqual(lang_for(-100, russian), "ru")
        language.set_chat_language(-100, "en", 7)
        self.assertEqual(lang_for(-100, russian), "en")
        self.assertEqual(language.chosen_languages(), {-100: "en"})
        language.set_chat_language(-100, None)
        self.assertEqual(lang_for(-100, russian), "ru")
        with self.assertRaises(ValueError):
            language.set_chat_language(-100, "de")

    def test_a_message_nobody_asked_for_keeps_the_language_it_was_written_in(self):
        self.assertEqual(lang_for(42, fallback="ru"), "ru")
        language.set_chat_language(42, "en")
        self.assertEqual(lang_for(42, fallback="ru"), "en")

    def test_a_pair_is_still_a_string_and_say_picks_its_side(self):
        pair = T("Привет", "Hello")
        self.assertIsInstance(pair, str)
        self.assertEqual(pair, "Привет")
        self.assertEqual(say("en", pair), "Hello")
        self.assertEqual(say("ru", ValueError(pair)), "Привет")
        self.assertEqual(say("en", ValueError("plain")), "plain")

    def test_both_menus_list_the_same_commands(self):
        ru, en = language.commands("ru"), language.commands("en")
        self.assertEqual([c.command for c in ru], [c.command for c in en])
        self.assertIn("language", [c.command for c in en])
        self.assertNotEqual([c.description for c in ru], [c.description for c in en])
        for item in ru + en:
            self.assertLessEqual(len(item.description), 256)


class CommandTests(LanguageCase):
    def update(self, chat_type="supergroup", language_code=None, args=None):
        message = SimpleNamespace(sender_chat=None, reply_text=AsyncMock())
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=-100, type=chat_type),
            effective_user=SimpleNamespace(id=5, language_code=language_code),
            effective_message=message,
            callback_query=None,
        )
        bot = SimpleNamespace(set_my_commands=AsyncMock(), delete_my_commands=AsyncMock())
        return update, SimpleNamespace(args=args or [], bot=bot)

    def run_command(self, admin, **kwargs):
        update, context = self.update(**kwargs)
        with patch("bot.handlers.is_chat_admin", AsyncMock(return_value=admin)):
            asyncio.run(language.language_command(update, context))
        return update.effective_message.reply_text.await_args, context.bot

    def test_in_a_group_only_admins_choose(self):
        said, bot = self.run_command(False, args=["en"], language_code="ru")
        self.assertIn("администраторы", said.args[0])
        self.assertIsNone(language.chat_language(-100))
        bot.set_my_commands.assert_not_awaited()

    def test_an_admin_choice_switches_the_answer_and_the_chats_menu(self):
        said, bot = self.run_command(True, args=["en"], language_code="ru")
        self.assertEqual(language.chat_language(-100), "en")
        self.assertIn("Now: 🇬🇧 English", said.args[0])
        scope = bot.set_my_commands.await_args.kwargs["scope"]
        self.assertIsInstance(scope, BotCommandScopeChat)
        self.assertEqual(scope.chat_id, -100)
        self.assertIn("Start receiving TG", [c.description for c in bot.set_my_commands.await_args.args[0]])

        said, bot = self.run_command(True, args=["auto"], language_code="ru")
        self.assertIsNone(language.chat_language(-100))
        self.assertIn("авто", said.args[0])
        bot.delete_my_commands.assert_awaited_once()

    def test_a_private_chat_is_its_owners_to_set(self):
        self.run_command(False, args=["ru"], chat_type="private")
        self.assertEqual(language.chat_language(-100), "ru")

    def test_without_arguments_it_shows_the_buttons_and_changes_nothing(self):
        said, _ = self.run_command(True)
        buttons = [b.callback_data for row in said.kwargs["reply_markup"].inline_keyboard for b in row]
        self.assertEqual(buttons, ["lang:ru", "lang:en", "lang:auto"])
        self.assertIsNone(language.chat_language(-100))

    def test_startup_publishes_both_menus_and_every_chats_own(self):
        language.set_chat_language(-100, "ru")
        bot = SimpleNamespace(set_my_commands=AsyncMock(), delete_my_commands=AsyncMock())
        asyncio.run(language.publish_menus(bot))
        calls = bot.set_my_commands.await_args_list
        self.assertEqual([call.kwargs.get("language_code") for call in calls], [None, "ru", None])
        self.assertEqual(calls[2].kwargs["scope"].chat_id, -100)


if __name__ == "__main__":
    unittest.main()
