"""Exercise the real registration path without starting Telegram polling."""
import unittest
from unittest.mock import MagicMock, patch

from telegram import Update
from telegram.ext import CallbackQueryHandler

from bot import app
from bot.rps import rps_callback


class DispatcherTests(unittest.TestCase):
    def test_rps_buttons_are_received_and_routed(self):
        application = MagicMock()
        builder = MagicMock()
        builder.token.return_value = builder
        builder.post_init.return_value = builder
        builder.build.return_value = application
        with patch.object(app.Application, 'builder', return_value=builder), \
                patch.object(app, 'TELEGRAM_BOT_TOKEN', 'test-token'), \
                patch.object(app, 'HTTP_PROXY', None):
            app.run_dispatcher()
        self.assertIn('callback_query', application.run_polling.call_args.kwargs['allowed_updates'])
        handlers = [call.args[0] for call in application.add_handler.call_args_list]
        update = Update.de_json({
            'update_id': 1,
            'callback_query': {
                'id': 'test-query', 'chat_instance': 'test-chat', 'data': 'rps:1:r',
                'from': {'id': 2, 'is_bot': False, 'first_name': 'Player'},
                'message': {'message_id': 10, 'date': 0,
                            'chat': {'id': -100, 'type': 'supergroup', 'title': 'Chat'}},
            },
        }, None)
        matching = [handler for handler in handlers if isinstance(handler, CallbackQueryHandler)
                    and handler.check_update(update)]
        self.assertEqual(len(matching), 1)
        self.assertIs(matching[0].callback, rps_callback)
