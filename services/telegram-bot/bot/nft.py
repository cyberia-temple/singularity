"""Mint channel posts into the shared CyberiaNFT collection.

When the bot is an admin of a public channel it receives that channel's posts as
`channel_post` updates. Each new post is turned into an NFT: the image (if any)
and an ERC-721 metadata JSON are pinned to IPFS, then `CyberiaNFT.mint(uri)` is
signed with DEPLOYER_PK. The metadata shape matches the Laravel NFTController so
the token renders on the marketplace (resources/js/pages/Market.vue), which
lists the whole collection by nextId.
"""
import json
import uuid
import asyncio
import logging
import urllib.request
from datetime import timezone

from web3 import Web3

from telegram import Update
from telegram.ext import ContextTypes

from bot.chain import next_nonce
from telegram.error import TelegramError

from bot.config import (
    CYBERIA_NFT_ADDRESS, CYBERIA_NFT_ABI, MINTED_TOPIC,
    NFT_FROM_POSTS, NFT_FROM_POSTS_DRYRUN,
    IPFS_API_URL, NFT_MAX_DESC_CHARS, TELEGRAM_POST_BASE,
    RPC_URL, CHAIN_ID, DEPLOYER_PK, EXPLORER_URL,
)
from bot.utils import is_valid_eth_address
from bot.language import T, lang_of, tr

DM_ONLY = T("Отправьте мне эту команду в личку.", "DM me this command in private.")
INTERNAL_ERROR = T("Внутренняя ошибка. Попробуйте ещё раз.", "Internal error. Try again.")
from bot.db import (
    _post_nft_seen, _record_post_nft,
    _set_channel_wallet, _get_channel_wallet,
)

logger = logging.getLogger(__name__)

# (chat_id, message_id) and (chat_id, media_group_id) claimed by an in-flight
# mint. Belt-and-suspenders against album items racing past the DB dedup before
# the first item's row is written.
_inflight: set = set()


# --------------------------------------------------------------------------- #
# IPFS pinning (mirrors NFTController::pinToIpfs)                              #
# --------------------------------------------------------------------------- #
def _pin_bytes_to_ipfs(content: bytes, filename: str, mime: str) -> str:
    """Pin raw bytes to the local Kubo node and return `ipfs://CID`. Blocking —
    call through asyncio.to_thread from the event loop."""
    endpoint = f"{IPFS_API_URL}/api/v0/add?pin=true&cid-version=1"
    boundary = uuid.uuid4().hex
    pre = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f"Content-Type: {mime}\r\n\r\n"
    ).encode()
    post = f"\r\n--{boundary}--\r\n".encode()
    body = pre + content + post
    req = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode()
    return _parse_ipfs_add(raw)


def _parse_ipfs_add(raw: str) -> str:
    """Kubo streams one JSON object per pinned file; the last line is the root.
    Returns `ipfs://<Hash>`."""
    lines = [ln for ln in raw.strip().splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError("Kubo add returned an empty body")
    decoded = json.loads(lines[-1])
    cid = decoded.get("Hash")
    if not cid:
        raise RuntimeError("Kubo add returned no Hash")
    return f"ipfs://{cid}"


def _pin_json_to_ipfs(obj: dict) -> str:
    body = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode()
    return _pin_bytes_to_ipfs(body, "metadata.json", "application/json")


# --------------------------------------------------------------------------- #
# Metadata + mint                                                             #
# --------------------------------------------------------------------------- #
def _build_post_metadata(chat, message, image_uri: str | None, text_body: str) -> dict:
    """ERC-721 metadata for one channel post, in the shape Market.vue renders."""
    username = chat.username
    title = chat.title or (f"@{username}" if username else "channel")
    description = text_body[:NFT_MAX_DESC_CHARS]

    metadata: dict = {
        "name": f"{title} #{message.message_id}",
        "description": description,
    }
    if image_uri:
        metadata["image"] = image_uri
    if username:
        metadata["external_url"] = f"{TELEGRAM_POST_BASE}/{username}/{message.message_id}"

    attributes = []
    if username:
        attributes.append({"trait_type": "Channel", "value": f"@{username}"})
    if message.date is not None:
        posted = message.date.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
        attributes.append({"trait_type": "Posted", "value": posted})
    if attributes:
        metadata["attributes"] = attributes
    return metadata


def _send_tx(w3, acct, fn, fallback_gas: int) -> str:
    """Build/sign/send `fn` from `acct`, wait for the receipt, return tx hash.
    Raises on revert. Uses a fresh pending nonce so sequential calls don't clash."""
    nonce = next_nonce(w3, acct.address)
    try:
        estimated = fn.estimate_gas({"from": acct.address})
    except Exception as est_err:
        logger.warning(f"nft: estimate_gas failed, using {fallback_gas}: {est_err}")
        estimated = fallback_gas
    gas_limit = int(estimated * 1.25) + 50_000
    tx = fn.build_transaction({
        "from": acct.address,
        "nonce": nonce,
        "gas": gas_limit,
        "gasPrice": w3.eth.gas_price,
        "chainId": CHAIN_ID,
    })
    signed = acct.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    tx_hex = tx_hash.hex()
    if not tx_hex.startswith("0x"):
        tx_hex = "0x" + tx_hex
    if receipt.status != 1:
        raise RuntimeError(f"tx reverted: {tx_hex}")
    return tx_hex, receipt


def _mint_nft(token_uri: str, recipient: str | None = None) -> tuple[int | None, str, str | None]:
    """Mint one CyberiaNFT with `token_uri` (to the deployer) and, if `recipient`
    is set and not the deployer, transfer it there. Returns
    (token_id, mint_tx, transfer_tx). Blocking — call through asyncio.to_thread."""
    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    acct = w3.eth.account.from_key(DEPLOYER_PK)
    nft = w3.eth.contract(
        address=Web3.to_checksum_address(CYBERIA_NFT_ADDRESS), abi=CYBERIA_NFT_ABI
    )

    mint_tx, receipt = _send_tx(
        w3, acct, nft.functions.mint(token_uri), fallback_gas=500_000
    )

    token_id = None
    for log in receipt.logs:
        if log.get("address", "").lower() != nft.address.lower():
            continue
        topics = log.get("topics") or []
        if not topics or topics[0].hex().lower() != MINTED_TOPIC.lower():
            continue
        try:
            event = nft.events.Minted().process_log(log)
            token_id = int(event["args"]["tokenId"])
        except Exception as e:
            logger.debug(f"nft: Minted decode failed: {e}")
        break
    if token_id is None:
        try:
            token_id = int(nft.functions.nextId().call())
        except Exception:
            token_id = None

    transfer_tx = None
    if recipient and token_id is not None:
        to = Web3.to_checksum_address(recipient)
        if to.lower() != acct.address.lower():
            transfer_tx, _ = _send_tx(
                w3, acct,
                nft.functions.safeTransferFrom(acct.address, to, token_id),
                fallback_gas=150_000,
            )
    return token_id, mint_tx, transfer_tx


# --------------------------------------------------------------------------- #
# Handler                                                                     #
# --------------------------------------------------------------------------- #
async def channel_post_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Turn one new public-channel post into an NFT. Never raises into the loop."""
    if not NFT_FROM_POSTS:
        return
    msg = update.channel_post or update.effective_message
    chat = update.effective_chat
    if msg is None or chat is None or chat.type != "channel":
        return
    username = chat.username
    if not username:  # public channels only
        return
    if not DEPLOYER_PK and not NFT_FROM_POSTS_DRYRUN:
        return

    mgid = msg.media_group_id
    key = (chat.id, msg.message_id)
    gkey = (chat.id, mgid) if mgid else None

    try:
        if _post_nft_seen(chat.id, msg.message_id, mgid):
            return
    except Exception as e:
        logger.error(f"nft: dedup check failed: {e}")
        return
    if key in _inflight or (gkey is not None and gkey in _inflight):
        return

    # The NFT is minted then transferred to the wallet a channel admin
    # registered via /set_channel_wallet. Without one we still mint so the post
    # shows up on the marketplace — the token stays custodial on the deployer
    # until an admin registers a wallet.
    recipient = _get_channel_wallet(chat.id)
    if not recipient:
        logger.info(
            f"nft: no recipient wallet for @{username}; minting custodial "
            f"(admin can DM /set_channel_wallet @{username} 0x... to receive future posts)"
        )

    _inflight.add(key)
    if gkey is not None:
        _inflight.add(gkey)
    try:
        text_body = (msg.text or msg.caption or "").strip()

        image_uri = None
        if msg.photo:
            try:
                photo = msg.photo[-1]  # largest size
                tg_file = await context.bot.get_file(photo.file_id)
                buf = await tg_file.download_as_bytearray()
                image_uri = await asyncio.to_thread(
                    _pin_bytes_to_ipfs, bytes(buf),
                    f"post_{msg.message_id}.jpg", "image/jpeg",
                )
            except Exception as e:
                logger.warning(
                    f"nft: image pin failed for @{username}/{msg.message_id}: {e}"
                )

        if not text_body and image_uri is None:
            logger.info(f"nft: skipping content-less post @{username}/{msg.message_id}")
            return

        metadata = _build_post_metadata(chat, msg, image_uri, text_body)
        post_link = f"{TELEGRAM_POST_BASE}/{username}/{msg.message_id}"
        try:
            token_uri = await asyncio.to_thread(_pin_json_to_ipfs, metadata)
        except Exception as e:
            # IPFS unreachable: fall back to the bare post link so an NFT still
            # gets created (CyberiaNFT accepts any non-empty string).
            token_uri = post_link
            logger.warning(
                f"nft: metadata pin failed, using link uri for @{username}/{msg.message_id}: {e}"
            )

        if NFT_FROM_POSTS_DRYRUN:
            logger.info(
                f"nft[dryrun]: @{username}/{msg.message_id} -> {token_uri} "
                f"recipient={recipient or '(none set)'}"
            )
            _record_post_nft(
                chat.id, msg.message_id, f"@{username}", mgid, None, token_uri, None
            )
            return

        token_id, mint_tx, transfer_tx = await asyncio.to_thread(
            _mint_nft, token_uri, recipient
        )
        _record_post_nft(
            chat.id, msg.message_id, f"@{username}", mgid, token_id, token_uri, mint_tx
        )
        logger.info(
            f"nft: minted token_id={token_id} mint_tx={mint_tx} "
            f"transfer_tx={transfer_tx} -> {recipient} "
            f"for @{username}/{msg.message_id} uri={token_uri}"
        )
    except Exception as e:
        logger.error(f"nft: failed to mint post @{username}/{msg.message_id}: {e}")
    finally:
        _inflight.discard(key)
        if gkey is not None:
            _inflight.discard(gkey)


# --------------------------------------------------------------------------- #
# Channel-wallet registration commands (DM)                                   #
# --------------------------------------------------------------------------- #
async def _resolve_channel(context, ref: str):
    """Resolve '@name' / 'name' / numeric id to a Chat, or None."""
    ref = ref.strip()
    if not ref.startswith("@") and not ref.lstrip("-").isdigit():
        ref = "@" + ref
    target = int(ref) if ref.lstrip("-").isdigit() else ref
    try:
        return await context.bot.get_chat(target)
    except TelegramError as e:
        logger.info(f"nft: get_chat({ref}) failed: {e}")
        return None


async def _is_channel_admin(context, chat_id: int, user_id: int) -> bool:
    try:
        member = await context.bot.get_chat_member(chat_id, user_id)
        return member.status in ("creator", "administrator")
    except TelegramError as e:
        logger.info(f"nft: get_chat_member({chat_id},{user_id}) failed: {e}")
        return False


async def set_channel_wallet_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/set_channel_wallet <@channel> <0xaddress> — a channel admin registers the
    wallet that post NFTs from that channel are sent to. DM only; the caller must
    be an admin/owner of the channel."""
    chat = update.effective_chat
    user = update.effective_user
    if chat is None or user is None:
        return
    lang = lang_of(update)
    if chat.type != "private":
        await update.message.reply_text(DM_ONLY(lang))
        return

    args = context.args or []
    if len(args) < 2:
        await update.message.reply_text(tr(
            lang,
            "Как: /set_channel_wallet <@канал> <0xадрес>\n"
            "Пример: /set_channel_wallet @anarcho_autism 0x1234...abcd\n"
            "Вы должны быть админом этого канала, и бот тоже должен быть там админом.",
            "Usage: /set_channel_wallet <@channel> <0xaddress>\n"
            "Example: /set_channel_wallet @anarcho_autism 0x1234...abcd\n"
            "You must be an admin of that channel, and the bot must be an admin there too.",
        ))
        return

    address = args[1].strip()
    if not is_valid_eth_address(address):
        await update.message.reply_text(tr(lang, "Неверный адрес. Нужен 0x и 40 шестнадцатеричных символов.",
                                           "Invalid address. Expected 0x followed by 40 hex characters."))
        return
    try:
        address = Web3.to_checksum_address(address)
    except Exception:
        await update.message.reply_text(tr(lang, "Неверный адрес.", "Invalid address."))
        return

    channel = await _resolve_channel(context, args[0])
    if channel is None or channel.type != "channel":
        await update.message.reply_text(tr(
            lang,
            "Не нашёл такой канал. Проверьте, что бот в нём админ и что вы "
            "указали его @username (или числовой id).",
            "Couldn't find that channel. Make sure the bot is an admin of it and "
            "you passed its @username (or numeric id).",
        ))
        return

    if not await _is_channel_admin(context, channel.id, user.id):
        await update.message.reply_text(tr(lang, "Кошелёк канала может задать только его админ.",
                                           "Only an admin of that channel can set its wallet."))
        logger.warning(
            "nft: unauthorized set_channel_wallet by user_id=%s for channel=%s",
            user.id, channel.id,
        )
        return

    label = f"@{channel.username}" if channel.username else (channel.title or str(channel.id))
    try:
        _set_channel_wallet(channel.id, label, address, user.id)
    except Exception as e:
        logger.error(f"nft: set_channel_wallet db error: {e}")
        await update.message.reply_text(INTERNAL_ERROR(lang))
        return

    await update.message.reply_text(tr(
        lang,
        f"Кошелёк для {label} задан.\nНовые посты там станут NFT и уйдут на:\n{address}\n",
        f"Wallet set for {label}.\nNew posts there will be minted as NFTs and sent to:\n{address}\n",
    ) + f"{EXPLORER_URL}/address/{address}")


async def channel_wallet_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """/channel_wallet <@channel> — show the wallet registered for a channel
    (admins only). DM only."""
    chat = update.effective_chat
    user = update.effective_user
    lang = lang_of(update)
    if chat is None or user is None or chat.type != "private":
        if chat is not None and chat.type != "private":
            await update.message.reply_text(DM_ONLY(lang))
        return

    args = context.args or []
    if not args:
        await update.message.reply_text(tr(lang, "Как: /channel_wallet <@канал>", "Usage: /channel_wallet <@channel>"))
        return

    channel = await _resolve_channel(context, args[0])
    if channel is None or channel.type != "channel":
        await update.message.reply_text(tr(lang, "Не нашёл такой канал.", "Couldn't find that channel."))
        return
    if not await _is_channel_admin(context, channel.id, user.id):
        await update.message.reply_text(tr(lang, "Кошелёк канала может смотреть только его админ.",
                                           "Only an admin of that channel can view its wallet."))
        return

    label = f"@{channel.username}" if channel.username else (channel.title or str(channel.id))
    address = _get_channel_wallet(channel.id)
    if not address:
        await update.message.reply_text(tr(
            lang, f"Для {label} кошелёк не задан. Задать: /set_channel_wallet {label} 0x...",
            f"No wallet set for {label}. Set one with /set_channel_wallet {label} 0x...",
        ))
        return
    await update.message.reply_text(f"{label} -> {address}\n{EXPLORER_URL}/address/{address}")
