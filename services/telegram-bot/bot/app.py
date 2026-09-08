"""Application wiring: build the bot, register handlers, schedule loops, run."""
import sys
import logging

from telegram import BotCommand, MenuButtonWebApp, WebAppInfo
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    ChatMemberHandler,
    CommandHandler,
    MessageHandler,
    filters,
)
from telegram.request import HTTPXRequest

from bot.config import (
    TELEGRAM_BOT_TOKEN, HTTP_PROXY,
    BRIDGE_ANNOUNCE_CHAT, BRIDGE_POLL_SECONDS,
    SWAP_ANNOUNCE_CHAT, SWAP_POLL_SECONDS, RITUAL_V2_ROUTER,
    LIQUIDITY_ANNOUNCE_CHAT, LIQUIDITY_POLL_SECONDS,
    LENDING_ANNOUNCE_CHAT, LENDING_POLL_SECONDS, LENDING_COMPTROLLER,
    CYBERSOL_SWAP_ADDRESS, CYBERSOL_SWAP_ANNOUNCE_CHAT, CYBERSOL_SWAP_POLL_SECONDS,
    STAKING_MASTERCHEF, STAKING_ANNOUNCE_CHAT, STAKING_POLL_SECONDS,
    PUMPFUN_ANNOUNCE_CHAT, PUMPFUN_MIN_BUY_USD, PUMPFUN_POLL_SECONDS,
    PUMPFUN_POOL_ADDRESS,
    DIGEST_ANNOUNCE_CHAT, DIGEST_INTERVAL_SECONDS, BIG_ANNOUNCE_USD,
    MARKET_SNAPSHOT_SECONDS,
    WHALE_CHAT_ID, WHALE_MIN_CYBER_SOL, WHALE_POLL_SECONDS, WHALE_RECHECK_SECONDS,
    NFT_FROM_POSTS, NFT_FROM_POSTS_DRYRUN, CYBERIA_NFT_ADDRESS, IPFS_API_URL,
    AI_ENABLED, AI_API_KEY, AI_MODEL, AI_MODEL_CHOICE,
    WALLET_MINI_APP_URL, WALLET_MINI_APP_MENU,
)
from bot.db import ensure_schema
from bot.nft import (
    channel_post_handler, set_channel_wallet_command, channel_wallet_command,
)
from bot.handlers import (
    start_command, help_command, set_wallet_command, unset_wallet_command,
    wallet_command, cancel_command, balance_command, claim_command, token_command,
    github_command, website_command, app_command, open_command, create_token_command,
    set_rewards_interval_command, reward_now_command, whois_command,
    whale_command, x_command, ca_command, stats_command,
    pending_input_handler, pending_create_token_handler, track_chat_member,
    quick_reply_handler, thank_you_reward_handler,
    on_chat_member_update, error_handler,
    _QUICK_REPLY_RE,
)
from bot.ai import ask_command, ai_message_handler
from bot.ai_models import CALLBACK_PREFIX as AI_MODEL_CALLBACK, model_callback, model_command
from bot.announcers import (
    bridge_announcer_loop, swap_announcer_loop, liquidity_announcer_loop,
    lending_announcer_loop, cybersol_swap_announcer_loop, staking_announcer_loop,
    pumpfun_announcer_loop, digest_loop, market_snapshot_loop, whale_loop,
    run_snapshot_once,
)

logger = logging.getLogger(__name__)


async def post_init(application: Application):
    await application.bot.set_my_commands(
        [
            BotCommand("start", "Start receiving TG"),
            BotCommand("help", "Show available commands"),
            BotCommand("set_wallet", "Link wallet (asks for address if omitted)"),
            BotCommand("unset_wallet", "Unlink your wallet (keep pending)"),
            BotCommand("wallet", "Show your linked wallet"),
            BotCommand("balance", "Show TG, chat tokens, and pending rewards"),
            BotCommand("claim", "Collect your accrued chat-token rewards"),
            BotCommand("token", "Show this chat's reward token"),
            BotCommand("cancel", "Cancel an interactive prompt"),
            BotCommand("github", "Link GitHub for GITHUB airdrop"),
            BotCommand("website", "Open the project website"),
            BotCommand("app", "Download the Cyberia wallet app"),
            BotCommand("open", "Open the wallet inside Telegram"),
            BotCommand("x", "Show X (Twitter) and Telegram links"),
            BotCommand("ca", "Show the CYBER contract address"),
            BotCommand("stats", "On-chain activity digest (default 24h)"),
            BotCommand("ask", "Ask the Cyberia AI assistant"),
            *(
                [BotCommand("model", "Choose which free AI model answers you")]
                if AI_ENABLED and AI_MODEL_CHOICE
                else []
            ),
            BotCommand("whale", "Verify CYBER.sol to join the whales chat"),
            BotCommand("create_token", "(admins) Create a chat reward token"),
            BotCommand("set_rewards_interval", "(admins) Change rewards interval"),
            BotCommand("reward_now", "(admins) Pay rewards immediately"),
            BotCommand("set_channel_wallet", "(channel admins) Wallet to receive post NFTs"),
        ]
    )
    logger.info("Bot commands published to Telegram")

    # The ☰ beside the input box becomes the wallet. This is the entry point
    # people actually find — a command has to be remembered, a button does not
    # — and it needs no BotFather setup, only the URL.
    if WALLET_MINI_APP_MENU:
        try:
            await application.bot.set_chat_menu_button(
                menu_button=MenuButtonWebApp(
                    text="Wallet", web_app=WebAppInfo(url=WALLET_MINI_APP_URL)
                )
            )
            logger.info(f"Mini App menu button set: {WALLET_MINI_APP_URL}")
        except Exception as e:
            # A menu button that could not be set is not a reason to keep the
            # bot from starting: every other way in still works.
            logger.warning(f"Mini App menu button not set: {e}")

    # Background loop that announces successful bridge txs in the public chat.
    application.create_task(bridge_announcer_loop(application))
    logger.info(
        f"Bridge announcer started: chat={BRIDGE_ANNOUNCE_CHAT} interval={BRIDGE_POLL_SECONDS}s"
    )

    # Background loop that announces Ritual DEX swaps in the public chat.
    application.create_task(swap_announcer_loop(application))
    logger.info(
        f"Swap announcer started: chat={SWAP_ANNOUNCE_CHAT} "
        f"router={RITUAL_V2_ROUTER} interval={SWAP_POLL_SECONDS}s"
    )

    # Background loop that announces Ritual DEX liquidity add/remove.
    application.create_task(liquidity_announcer_loop(application))
    logger.info(
        f"Liquidity announcer started: chat={LIQUIDITY_ANNOUNCE_CHAT} "
        f"router={RITUAL_V2_ROUTER} interval={LIQUIDITY_POLL_SECONDS}s"
    )

    # Background loop that announces lending supply/withdraw/borrow/repay.
    if LENDING_COMPTROLLER:
        application.create_task(lending_announcer_loop(application))
        logger.info(
            f"Lending announcer started: chat={LENDING_ANNOUNCE_CHAT} "
            f"comptroller={LENDING_COMPTROLLER} interval={LENDING_POLL_SECONDS}s"
        )
    else:
        logger.info("Lending announcer disabled: LENDING_COMPTROLLER not set")

    # Background loop that announces CYBER.sol -> native CYBER conversions.
    if CYBERSOL_SWAP_ADDRESS:
        application.create_task(cybersol_swap_announcer_loop(application))
        logger.info(
            f"CYBER.sol conversion announcer started: chat={CYBERSOL_SWAP_ANNOUNCE_CHAT} "
            f"swap={CYBERSOL_SWAP_ADDRESS} interval={CYBERSOL_SWAP_POLL_SECONDS}s"
        )
    else:
        logger.info("CYBER.sol conversion announcer disabled: CYBERSOL_SWAP_ADDRESS not set")

    # Background loop that announces solo-pool staking enters/exits.
    if STAKING_MASTERCHEF:
        application.create_task(staking_announcer_loop(application))
        logger.info(
            f"Staking announcer started: chat={STAKING_ANNOUNCE_CHAT} "
            f"masterchef={STAKING_MASTERCHEF} interval={STAKING_POLL_SECONDS}s"
        )
    else:
        logger.info("Staking announcer disabled: STAKING_MASTERCHEF not set")

    # Background loop that announces CYBER.sol buys on the pump.fun pool.
    if PUMPFUN_ANNOUNCE_CHAT:
        application.create_task(pumpfun_announcer_loop(application))
        logger.info(
            f"pump.fun buy bot started: chat={PUMPFUN_ANNOUNCE_CHAT} "
            f"pool={PUMPFUN_POOL_ADDRESS or 'auto'} min=${PUMPFUN_MIN_BUY_USD:g} "
            f"interval={PUMPFUN_POLL_SECONDS}s"
        )
    else:
        logger.info("pump.fun buy bot disabled: PUMPFUN_ANNOUNCE_CHAT not set")

    # Periodic on-chain activity digest.
    if DIGEST_INTERVAL_SECONDS > 0:
        application.create_task(digest_loop(application))
        logger.info(
            f"Digest started: chat={DIGEST_ANNOUNCE_CHAT} "
            f"interval={DIGEST_INTERVAL_SECONDS}s big-event=${BIG_ANNOUNCE_USD:g}"
        )
    else:
        logger.info("Digest disabled: DIGEST_INTERVAL_SECONDS=0")

    # Token prices + DEX pools snapshot for the Laravel /analytics page.
    if MARKET_SNAPSHOT_SECONDS > 0:
        application.create_task(market_snapshot_loop(application))
        logger.info(f"Market snapshot started: every {MARKET_SNAPSHOT_SECONDS}s")
    else:
        logger.info("Market snapshot disabled: MARKET_SNAPSHOT_SECONDS=0")

    # Whales chat gate: invite verified whales and re-check balances/kick.
    if WHALE_CHAT_ID:
        application.create_task(whale_loop(application))
        logger.info(
            f"Whale loop started: chat={WHALE_CHAT_ID} min={WHALE_MIN_CYBER_SOL} "
            f"poll={WHALE_POLL_SECONDS}s recheck={WHALE_RECHECK_SECONDS}s"
        )
    else:
        logger.info("Whale gate disabled: WHALE_CHAT_ID not set")

    # NFT-from-posts: mint each new post in public channels the bot administers.
    if NFT_FROM_POSTS:
        mode = "DRY-RUN (no mint)" if NFT_FROM_POSTS_DRYRUN else "live"
        logger.info(
            f"NFT-from-posts enabled [{mode}]: collection={CYBERIA_NFT_ADDRESS} "
            f"ipfs={IPFS_API_URL}"
        )
    else:
        logger.info("NFT-from-posts disabled: NFT_FROM_POSTS off or no collection")

    if not AI_ENABLED:
        logger.info("AI assistant disabled: AI_ENABLED off")
    elif AI_API_KEY:
        logger.info(
            "AI assistant enabled: model=%s, per-user choice %s",
            AI_MODEL,
            "on (/model)" if AI_MODEL_CHOICE else "off",
        )
    else:
        logger.info("AI assistant disabled: AI_API_KEY not set")


def run_dispatcher():
    logger.info("Building application...")

    if not TELEGRAM_BOT_TOKEN:
        raise ValueError("TELEGRAM_BOT_TOKEN not set")

    builder = Application.builder().token(TELEGRAM_BOT_TOKEN).post_init(post_init)

    if HTTP_PROXY:
        proxy_url = HTTP_PROXY
        if proxy_url.startswith("http://") or proxy_url.startswith("socks5://"):
            logger.info(f"Using proxy: {proxy_url}")
            builder = builder.request(
                HTTPXRequest(
                    connection_pool_size=10,
                    proxy=proxy_url,
                )
            )
        else:
            logger.warning(f"Unsupported proxy format: {proxy_url}, ignoring")

    application = builder.build()

    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("set_wallet", set_wallet_command))
    application.add_handler(CommandHandler("unset_wallet", unset_wallet_command))
    application.add_handler(CommandHandler("wallet", wallet_command))
    application.add_handler(CommandHandler("cancel", cancel_command))
    application.add_handler(CommandHandler("balance", balance_command))
    application.add_handler(CommandHandler("claim", claim_command))
    application.add_handler(CommandHandler("token", token_command))
    application.add_handler(CommandHandler("github", github_command))
    application.add_handler(CommandHandler("website", website_command))
    application.add_handler(CommandHandler("app", app_command))
    application.add_handler(CommandHandler("open", open_command))
    application.add_handler(CommandHandler("create_token", create_token_command))
    application.add_handler(CommandHandler("set_rewards_interval", set_rewards_interval_command))
    application.add_handler(CommandHandler("reward_now", reward_now_command))
    application.add_handler(CommandHandler("whois", whois_command))
    application.add_handler(CommandHandler("whale", whale_command))
    application.add_handler(CommandHandler("x", x_command))
    application.add_handler(CommandHandler("ca", ca_command))
    application.add_handler(CommandHandler("stats", stats_command))
    if AI_ENABLED:
        application.add_handler(CommandHandler("ask", ask_command))
    # Which model answers is a per-user preference, so the picker is a command
    # and a keyboard rather than an env var only the operator can reach.
    if AI_ENABLED and AI_MODEL_CHOICE:
        application.add_handler(CommandHandler("model", model_command))
        application.add_handler(
            CallbackQueryHandler(model_callback, pattern=rf"^{AI_MODEL_CALLBACK}\|")
        )
    application.add_handler(CommandHandler("set_channel_wallet", set_channel_wallet_command))
    application.add_handler(CommandHandler("channel_wallet", channel_wallet_command))

    # Capture the "next message is the address" reply after a bare /set_wallet
    # in DMs. Restricted to private chats so the bot never hijacks ordinary
    # group messages.
    application.add_handler(
        MessageHandler(
            filters.ChatType.PRIVATE & filters.TEXT & ~filters.COMMAND,
            pending_input_handler,
        )
    )

    # Capture name/interval replies after a bare /create_token in groups.
    application.add_handler(
        MessageHandler(
            (filters.ChatType.GROUPS | filters.ChatType.SUPERGROUP)
            & filters.TEXT & ~filters.COMMAND,
            pending_create_token_handler,
        )
    )

    # Track chat membership on any group message, including commands.
    application.add_handler(
        MessageHandler(
            filters.ChatType.GROUPS | filters.ChatType.SUPERGROUP,
            track_chat_member,
        ),
        group=1,
    )

    # Bare-text quick replies ("x", "ca", …) in any chat type. Lives in its own
    # handler group so it never collides with the wallet/token follow-up
    # handlers above; the Regex filter keeps it from running on ordinary chat.
    application.add_handler(
        MessageHandler(
            filters.TEXT & ~filters.COMMAND & ~filters.ChatType.CHANNEL
            & filters.Regex(_QUICK_REPLY_RE),
            quick_reply_handler,
        ),
        group=2,
    )

    # Replying "спасибо" to another user's message mints this chat's token to
    # that user, or queues the reward until they link a wallet.
    application.add_handler(
        MessageHandler(
            (filters.ChatType.GROUPS | filters.ChatType.SUPERGROUP)
            & filters.TEXT & ~filters.COMMAND,
            thank_you_reward_handler,
        ),
        group=3,
    )

    # AI answers all ordinary text in DMs, but only explicit mentions/replies
    # in groups. A separate handler group lets interactive wallet/token flows
    # inspect the same update first; the AI handler checks those states itself.
    # With AI_ENABLED off the handler is not registered at all, so the bot
    # stays silent instead of replying that the assistant is not configured.
    if AI_ENABLED:
        application.add_handler(
            MessageHandler(
                filters.TEXT & ~filters.COMMAND & ~filters.ChatType.CHANNEL
                & ~filters.Regex(_QUICK_REPLY_RE),
                ai_message_handler,
            ),
            group=4,
        )

    # Mint each new post in public channels the bot administers into CyberiaNFT.
    # A bot only receives channel_post updates for channels it is an admin of.
    if NFT_FROM_POSTS:
        application.add_handler(
            MessageHandler(
                filters.ChatType.CHANNEL & filters.UpdateType.CHANNEL_POST,
                channel_post_handler,
            ),
            group=3,
        )

    # Catch silent leaves/kicks and joins. Requires the bot to be admin in the
    # chat to receive these updates from Telegram. Without admin rights only
    # service messages (handled above) will fire.
    application.add_handler(
        ChatMemberHandler(on_chat_member_update, ChatMemberHandler.CHAT_MEMBER)
    )

    application.add_error_handler(error_handler)

    logger.info("Bot started, polling...")

    try:
        application.run_polling(
            allowed_updates=["message", "chat_member", "channel_post"]
        )
    except Exception as e:
        logger.error(f"Polling error: {e}")
        raise


def main() -> None:
    """Entry point shared by `python -m bot` and the legacy shim."""
    logger.info("Starting bot...")
    ensure_schema()
    if "--snapshot-once" in sys.argv:
        run_snapshot_once()
    else:
        logger.info("Main entry point")
        run_dispatcher()
