"""Tracks on request: a Yandex Music or VK link, or "Artist — Title", in; the song out.

Three ways in:

* a Yandex Music or VK track link anywhere in a message, in any chat;
* `/track <artist — title>` (or `/track` in reply to such a message);
* a bare one-line "Artist — Title" message. It is answered only when a search
  returns that very song, its artist and its title both matching, so an
  ordinary sentence with a dash in it gets no reply at all. Admins switch this
  off per chat with `/music off`.

Where the audio comes from:

* **Yandex Music** (`api.music.yandex.net`). Search and track pages need no
  account. A whole file needs `YANDEX_MUSIC_TOKEN` from an account with Plus;
  without one, Yandex hands out a 30-second preview. Yandex answers 451 to
  hosts outside Russia, and prod is in Germany, so `YANDEX_MUSIC_PROXY_URL`
  sends every Yandex request through an http(s) proxy in Russia.
* **VK** (`api.vk.com`, `audio.*`), with `VK_AUDIO_TOKEN`: a user token of the
  Kate Mobile client, the only kind `audio.*` still accepts. VK gives either
  an mp3 or an HLS playlist of AES-128 segments. The playlist is decrypted and
  demuxed here into one mp3, without ffmpeg.

When Yandex will not give a track in full, the song is looked up on VK by its
artist, title and length, so a Yandex link still brings back the whole song.
A preview goes out only on an explicit request, and its caption says so.

Telegram's file_id of every full track sent is kept in `bot_kv`, so the same
song asked for again is one sendAudio call and no download.
"""
from __future__ import annotations

import asyncio
import hashlib
import html
import logging
import re
import time
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher
from urllib.parse import urljoin

import httpx
from Crypto.Cipher import AES
from telegram import InputFile, Message, MessageEntity, Update
from telegram.constants import ChatAction, ParseMode
from telegram.error import BadRequest, TelegramError
from telegram.ext import ContextTypes

from bot.config import (
    MUSIC_AUTO_DETECT,
    VK_AUDIO_TOKEN,
    YANDEX_MUSIC_PROXY_URL,
    YANDEX_MUSIC_TOKEN,
)
from bot.db import _kv_get, _kv_set
from bot.handlers import is_chat_admin

logger = logging.getLogger(__name__)

# Both the artist and the title must reach this for a bare line to be answered.
MATCH_THRESHOLD = 0.8
# Telegram bots upload at most 50 MB.
MAX_AUDIO_BYTES = 49 * 1024 * 1024
SEARCH_LIMIT = 8
# Downloads in flight at once, across every chat.
_DELIVERY_SLOTS = asyncio.Semaphore(3)
# Interactive prompts that own the user's next message.
_AWAITING_KEYS = ("awaiting_wallet", "awaiting_token_name", "awaiting_token_interval")

_YANDEX_TRACK_RE = re.compile(
    r"https?://music\.yandex\.(?:ru|com|by|kz|uz)/(?:album/\d+/)?track/(\d+)",
    re.IGNORECASE,
)
_VK_AUDIO_RE = re.compile(
    r"https?://(?:www\.|m\.)?vk\.(?:com|ru)/audio(-?\d+)_(\d+)(?:_([0-9a-z]+))?",
    re.IGNORECASE,
)
# " - ", " – ", " — " with spaces, or an en/em dash without them. A bare
# hyphen inside a word ("кто-то") is never a separator.
_SEPARATOR_RE = re.compile(r"\s+[-–—]\s+|\s*[–—]\s*")
_LETTER_RE = re.compile(r"[^\W\d_]")
_BRACKETS_RE = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]")
_FEAT_RE = re.compile(r"\s(?:feat|ft)\.?\s.*$")


class Unavailable(Exception):
    """A source cannot be used right now: no token, a refused token, a geo-block, the network."""


class TooLarge(Exception):
    """The file is bigger than Telegram lets a bot upload."""


@dataclass
class Track:
    source: str                      # "yandex" or "vk"
    id: str                          # Yandex track id, or VK "owner_audio"
    artists: list[str]
    title: str
    version: str | None = None
    duration: int | None = None      # seconds
    cover_url: str | None = None
    page_url: str | None = None
    audio_url: str | None = None     # VK only: the file or playlist
    available: bool = True

    @property
    def performer(self) -> str:
        return ", ".join(self.artists)

    @property
    def full_title(self) -> str:
        return f"{self.title} ({self.version})" if self.version else self.title


@dataclass(frozen=True)
class MusicRequest:
    kind: str                        # "yandex", "vk" or "query"
    ref: str = ""                    # Yandex track id, or VK "owner_audio[_key]"
    query: str = ""
    parts: tuple[str, str] | None = None


@dataclass
class Found:
    track: Track
    data: bytes | None = None
    file_id: str | None = None
    duration: int | None = None
    preview: bool = False


@dataclass
class Segment:
    url: str
    key_url: str | None = None
    iv: bytes | None = None


# --- Reading a message ---------------------------------------------------------

def link_request(text: str) -> MusicRequest | None:
    """A Yandex Music or VK track link anywhere in the text."""
    if not text:
        return None
    match = _YANDEX_TRACK_RE.search(text)
    if match:
        return MusicRequest("yandex", ref=match.group(1))
    match = _VK_AUDIO_RE.search(text)
    if match:
        owner, audio, key = match.groups()
        return MusicRequest("vk", ref=f"{owner}_{audio}" + (f"_{key}" if key else ""))
    return None


def split_artist_title(text: str) -> tuple[str, str] | None:
    """("Artist", "Title") from one short "Artist — Title" line, or None.

    Strict on purpose: this decides whether an ordinary chat line is a search
    at all. A question, a URL, a mention, a second line or a long sentence is
    not one.
    """
    line = (text or "").strip()
    if not line or "\n" in line or len(line) > 100:
        return None
    if line.startswith("/") or line.endswith("?") or "://" in line or "@" in line or "www." in line:
        return None
    match = _SEPARATOR_RE.search(line)
    if not match:
        return None
    left = line[:match.start()].strip(" \"'«»“”„")
    right = line[match.end():].strip(" \"'«»“”„")
    if not (_LETTER_RE.search(left) and _LETTER_RE.search(right)):
        return None
    if len(left.split()) > 7 or len(right.split()) > 12:
        return None
    return left, right


def query_request(text: str) -> MusicRequest | None:
    """The request behind `/track <text>`: a link, "Artist — Title" or free words."""
    text = " ".join((text or "").split())
    if not text:
        return None
    link = link_request(text)
    if link:
        return link
    parts = split_artist_title(text)
    query = f"{parts[0]} {parts[1]}" if parts else text
    return MusicRequest("query", query=query[:200], parts=parts)


def _message_texts(message: Message) -> list[str]:
    texts = [message.text or message.caption or ""]
    for entity in (*(message.entities or ()), *(message.caption_entities or ())):
        if entity.type == MessageEntity.TEXT_LINK and entity.url:
            texts.append(entity.url)
    return texts


def request_from_message(message: Message) -> tuple[MusicRequest, bool] | None:
    """The request a chat message makes, and whether it was made explicitly.

    A link is explicit. A bare "Artist — Title" line is not: it is answered
    only when the song is found for certain, and silently dropped otherwise.
    """
    for text in _message_texts(message):
        link = link_request(text)
        if link:
            return link, True
    parts = split_artist_title(message.text or "")
    if parts:
        return MusicRequest("query", query=f"{parts[0]} {parts[1]}", parts=parts), False
    return None


def claims_message(message: Message) -> bool:
    """Whether this message is the music feature's to answer (the AI then stays out)."""
    got = request_from_message(message)
    return bool(got and got[1])


# --- Matching -----------------------------------------------------------------

def _normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value or "").lower().replace("ё", "е")
    value = _FEAT_RE.sub(" ", value)
    value = re.sub(r"[^\w\s]|_", " ", value)
    return " ".join(value.split())


def _similarity(a: str, b: str, name: bool = False) -> float:
    """0..1. Whole words of one inside the other count as a match: for a title
    only when they are most of it ("Группа крови" in "Группа крови remastered"),
    for a name whenever they are a word of three letters or more ("Цой" is
    "Виктор Цой"), since people name an artist by the surname alone."""
    a, b = _normalize(a), _normalize(b)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    ratio = SequenceMatcher(None, a, b).ratio()
    shorter, longer = sorted((a, b), key=len)
    if f" {shorter} " in f" {longer} ":
        if len(shorter) >= 0.5 * len(longer):
            ratio = max(ratio, 0.9)
        elif name and len(shorter) >= 3:
            ratio = max(ratio, 0.85)
    return ratio


def match_score(parts: tuple[str, str], track: Track) -> float:
    """How surely `track` is the song "left — right" names, in either order (0..1)."""
    artists = [*track.artists, track.performer]
    titles = {track.title, track.full_title, _BRACKETS_RE.sub("", track.title)}

    def best(query: str, options, name: bool = False) -> float:
        return max(
            (_similarity(query, option, name) for option in options if option), default=0.0
        )

    left, right = parts
    as_written = min(best(left, artists, name=True), best(right, titles))
    swapped = min(best(right, artists, name=True), best(left, titles))
    return max(as_written, swapped)


def pick_track(results: list[Track], parts: tuple[str, str] | None, explicit: bool) -> Track | None:
    """The result to send. A bare line takes only a sure match; a command takes the best there is."""
    if not results:
        return None
    if parts:
        scored = [(match_score(parts, track), -index, track) for index, track in enumerate(results)]
        score, _, track = max(scored, key=lambda item: item[:2])
        if score >= MATCH_THRESHOLD:
            return track
        if explicit:
            return track if score >= 0.5 else results[0]
        return None
    return results[0] if explicit else None


# --- Audio formats ------------------------------------------------------------

def looks_like_mp3(data: bytes | None) -> bool:
    """An ID3 tag or an MPEG audio frame header near the start (ADTS AAC is not one)."""
    if not data:
        return False
    if data[:3] == b"ID3":
        return True
    head = data[:4096]
    for index in range(len(head) - 1):
        if head[index] == 0xFF and head[index + 1] & 0xE0 == 0xE0 and (head[index + 1] >> 1) & 0x3:
            return True
    return False


def yandex_mp3_url(xml: str) -> str:
    """The signed file URL from a Yandex `download-info` XML answer."""
    fields = {}
    for name in ("host", "path", "ts", "s"):
        match = re.search(rf"<{name}>([^<]*)</{name}>", xml or "")
        if not match:
            raise ValueError(f"download-info has no <{name}>")
        fields[name] = match.group(1)
    sign = hashlib.md5(
        ("XGRlBW9FXlekgbPrRHuSiA" + fields["path"][1:] + fields["s"]).encode()
    ).hexdigest()
    return f"https://{fields['host']}/get-mp3/{sign}/{fields['ts']}{fields['path']}"


_M3U8_TO_MP3_RE = re.compile(r"/[0-9a-f]+(/audios)?/([0-9a-f]+)/index\.m3u8")


def vk_mp3_url(playlist_url: str) -> str | None:
    """VK serves the same file as a plain mp3 next to many of its playlists."""
    if not _M3U8_TO_MP3_RE.search(playlist_url):
        return None
    return _M3U8_TO_MP3_RE.sub(r"\1/\2.mp3", playlist_url)


def _attributes(value: str) -> dict[str, str]:
    return {
        key: raw.strip('"')
        for key, raw in re.findall(r'([A-Z0-9-]+)=("[^"]*"|[^,]*)', value)
    }


def parse_m3u8(text: str, base_url: str) -> list[Segment]:
    """Segments of a media playlist with the AES-128 key each one is under.

    Without an IV attribute the IV is the segment's media sequence number
    (RFC 8216 §5.2), which is what VK relies on.
    """
    segments: list[Segment] = []
    sequence = 0
    key_url: str | None = None
    key_iv: bytes | None = None
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-MEDIA-SEQUENCE:"):
            sequence = int(line.split(":", 1)[1])
        elif line.startswith("#EXT-X-KEY:"):
            attributes = _attributes(line.split(":", 1)[1])
            method = attributes.get("METHOD", "NONE").upper()
            if method == "NONE":
                key_url, key_iv = None, None
            elif method == "AES-128" and attributes.get("URI"):
                key_url = urljoin(base_url, attributes["URI"])
                iv = attributes.get("IV", "")
                key_iv = bytes.fromhex(iv[2:].rjust(32, "0")) if iv.lower().startswith("0x") else None
            else:
                raise ValueError(f"unsupported HLS key method {method}")
        elif not line.startswith("#"):
            iv = (key_iv or sequence.to_bytes(16, "big")) if key_url else None
            segments.append(Segment(urljoin(base_url, line), key_url, iv))
            sequence += 1
    return segments


def decrypt_segment(data: bytes, key: bytes, iv: bytes) -> bytes:
    """AES-128-CBC with PKCS#7 padding, as HLS defines it."""
    data = data[: len(data) - len(data) % 16]
    if not data:
        return b""
    plain = AES.new(key, AES.MODE_CBC, iv).decrypt(data)
    pad = plain[-1]
    if 1 <= pad <= 16 and plain[-pad:] == bytes([pad]) * pad:
        plain = plain[:-pad]
    return plain


def ts_audio(data: bytes) -> bytes:
    """The MPEG audio elementary stream carried in an MPEG-TS segment.

    A segment that is not a transport stream (no 0x47 sync) is already the
    audio and is returned as it is.
    """
    if len(data) < 188 or data[0] != 0x47 or (len(data) > 188 and data[188] != 0x47):
        return data
    out = bytearray()
    audio_pid: int | None = None
    for offset in range(0, len(data) - 187, 188):
        packet = data[offset:offset + 188]
        if packet[0] != 0x47:
            continue
        starts_unit = bool(packet[1] & 0x40)
        pid = ((packet[1] & 0x1F) << 8) | packet[2]
        adaptation = (packet[3] >> 4) & 0x3
        if adaptation in (0, 2):
            continue
        start = 5 + packet[4] if adaptation == 3 else 4
        if start >= 188:
            continue
        payload = packet[start:]
        if starts_unit:
            # A PES header for an MPEG audio stream (ids 0xC0-0xDF); anything
            # else starting here is a PSI table or another stream.
            if payload[:3] == b"\x00\x00\x01" and 0xC0 <= payload[3] <= 0xDF and len(payload) > 9:
                if audio_pid is None:
                    audio_pid = pid
                if pid == audio_pid:
                    out += payload[9 + payload[8]:]
            continue
        if pid == audio_pid:
            out += payload
    return bytes(out)


# --- Sources ------------------------------------------------------------------

class _Source:
    def __init__(self, proxy: str = "", headers: dict[str, str] | None = None):
        self._proxy = proxy
        self._headers = headers or {}
        self._client: httpx.AsyncClient | None = None

    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            try:
                self._client = httpx.AsyncClient(
                    proxy=self._proxy or None,
                    headers=self._headers,
                    timeout=httpx.Timeout(20.0, connect=10.0),
                    follow_redirects=True,
                )
            except ImportError as error:  # socks5:// without the socksio package
                logger.warning("music: proxy not usable: %s", error)
                raise Unavailable("proxy not usable") from error
        return self._client

    async def fetch(self, url: str, limit: int = MAX_AUDIO_BYTES) -> bytes:
        try:
            async with self.client().stream("GET", url) as response:
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body += chunk
                    if len(body) > limit:
                        raise TooLarge(url)
                return bytes(body)
        except httpx.HTTPError as error:
            raise Unavailable(type(error).__name__) from error


class YandexMusic(_Source):
    API = "https://api.music.yandex.net"
    # A 451 is about the host, not the song: stop asking for a while.
    BLOCK_SECONDS = 1800

    def __init__(self, token: str = "", proxy: str = ""):
        headers = {"Accept-Language": "ru"}
        if token:
            headers["Authorization"] = f"OAuth {token}"
        super().__init__(proxy, headers)
        self.token = token
        self._blocked_until = 0.0

    async def _result(self, path: str, params: dict | None = None):
        if time.monotonic() < self._blocked_until:
            raise Unavailable("Yandex Music is blocked from this host")
        try:
            response = await self.client().get(self.API + path, params=params)
        except httpx.HTTPError as error:
            raise Unavailable(type(error).__name__) from error
        if response.status_code == 451:
            self._blocked_until = time.monotonic() + self.BLOCK_SECONDS
            logger.warning(
                "music: Yandex Music answers 451 from this host; "
                "set YANDEX_MUSIC_PROXY_URL to an http(s) proxy in Russia"
            )
            raise Unavailable("HTTP 451")
        if response.status_code in (401, 403):
            logger.warning(
                "music: Yandex Music refused the request (HTTP %s); check YANDEX_MUSIC_TOKEN",
                response.status_code,
            )
            raise Unavailable(f"HTTP {response.status_code}")
        if response.status_code == 404:
            return None
        if response.status_code >= 400:
            raise Unavailable(f"HTTP {response.status_code}")
        try:
            return response.json().get("result")
        except ValueError as error:
            raise Unavailable("not JSON") from error

    @staticmethod
    def track_from(item: dict) -> Track | None:
        if not item or not item.get("id") or not item.get("title"):
            return None
        albums = item.get("albums") or []
        album_id = albums[0].get("id") if albums else None
        cover = item.get("coverUri") or (albums[0].get("coverUri") if albums else None)
        track_id = str(item["id"])
        return Track(
            source="yandex",
            id=track_id,
            artists=[a["name"] for a in item.get("artists") or [] if a.get("name")] or ["—"],
            title=item["title"],
            version=item.get("version") or None,
            duration=round(item["durationMs"] / 1000) if item.get("durationMs") else None,
            cover_url=f"https://{cover.replace('%%', '200x200')}" if cover else None,
            page_url=(
                f"https://music.yandex.ru/album/{album_id}/track/{track_id}"
                if album_id else f"https://music.yandex.ru/track/{track_id}"
            ),
            available=item.get("available", True) is not False,
        )

    async def search(self, query: str) -> list[Track]:
        result = await self._result(
            "/search", {"text": query, "type": "track", "page": 0, "nocorrect": "false"}
        )
        items = ((result or {}).get("tracks") or {}).get("results") or []
        return [track for track in map(self.track_from, items[:SEARCH_LIMIT]) if track]

    async def track(self, track_id: str) -> Track | None:
        result = await self._result(f"/tracks/{track_id}")
        return self.track_from(result[0]) if result else None

    async def download_options(self, track: Track) -> list[dict]:
        options = await self._result(f"/tracks/{track.id}/download-info") or []
        return [o for o in options if o.get("codec") == "mp3" and o.get("downloadInfoUrl")]

    async def fetch_option(self, option: dict) -> bytes:
        xml = (await self.fetch(option["downloadInfoUrl"], limit=64 * 1024)).decode("utf-8", "replace")
        try:
            url = yandex_mp3_url(xml)
        except ValueError as error:
            raise Unavailable(str(error)) from error
        return await self.fetch(url)


def best_option(options: list[dict] | None, preview: bool) -> dict | None:
    pool = [o for o in options or [] if bool(o.get("preview")) == preview]
    return max(pool, key=lambda o: o.get("bitrateInKbps") or 0, default=None)


class VkAudio(_Source):
    API = "https://api.vk.com/method/"
    VERSION = "5.131"
    # audio.* answers only the Kate Mobile client, and checks its user agent.
    USER_AGENT = (
        "KateMobileAndroid/56 lite-460 (Android 4.4.2; SDK 19; x86; "
        "unknown Android SDK built for x86; en)"
    )

    def __init__(self, token: str = "", proxy: str = ""):
        super().__init__(proxy, {"User-Agent": self.USER_AGENT})
        self.token = token

    async def _call(self, method: str, **params):
        if not self.token:
            raise Unavailable("VK_AUDIO_TOKEN is not set")
        # POST keeps the token out of every URL, and so out of any log line.
        data = {**params, "access_token": self.token, "v": self.VERSION}
        payload = None
        for attempt in range(2):
            try:
                response = await self.client().post(self.API + method, data=data)
                payload = response.json()
                break
            except httpx.TransportError as error:
                if attempt:
                    raise Unavailable(type(error).__name__) from error
            except (httpx.HTTPError, ValueError) as error:
                raise Unavailable(type(error).__name__) from error
        error = (payload or {}).get("error")
        if error:
            logger.warning(
                "music: VK %s failed: %s %s", method, error.get("error_code"), error.get("error_msg")
            )
            raise Unavailable(f"VK error {error.get('error_code')}")
        return (payload or {}).get("response")

    @staticmethod
    def track_from(item: dict) -> Track | None:
        if not item or item.get("id") is None or not item.get("title"):
            return None
        main = [a["name"] for a in item.get("main_artists") or [] if a.get("name")]
        thumb = ((item.get("album") or {}).get("thumb") or {})
        return Track(
            source="vk",
            id=f"{item.get('owner_id')}_{item['id']}",
            artists=main or [item.get("artist") or "—"],
            title=item["title"],
            version=item.get("subtitle") or None,
            duration=int(item["duration"]) if item.get("duration") else None,
            cover_url=thumb.get("photo_300") or thumb.get("photo_270") or thumb.get("photo_600"),
            audio_url=item.get("url") or None,
        )

    async def search(self, query: str) -> list[Track]:
        response = await self._call("audio.search", q=query, count=SEARCH_LIMIT, auto_complete=1)
        items = (response or {}).get("items") or []
        return [track for track in map(self.track_from, items) if track and track.audio_url]

    async def by_id(self, ref: str) -> Track | None:
        response = await self._call("audio.getById", audios=ref)
        items = response.get("items") if isinstance(response, dict) else response
        tracks = [track for track in map(self.track_from, items or []) if track]
        return tracks[0] if tracks else None

    async def download(self, track: Track) -> bytes | None:
        url = track.audio_url
        if not url:
            return None
        if ".m3u8" not in url:
            data = await self.fetch(url)
            return data if looks_like_mp3(data) else None
        mp3 = vk_mp3_url(url)
        if mp3:
            try:
                data = await self.fetch(mp3)
                if looks_like_mp3(data):
                    return data
            except Unavailable:
                pass
        return await self._from_playlist(url)

    async def _from_playlist(self, url: str) -> bytes | None:
        playlist = (await self.fetch(url, limit=1024 * 1024)).decode("utf-8", "replace")
        try:
            segments = parse_m3u8(playlist, url)
        except ValueError as error:
            logger.warning("music: VK playlist not readable: %s", error)
            return None
        keys = {}
        for key_url in {s.key_url for s in segments if s.key_url}:
            keys[key_url] = await self.fetch(key_url, limit=64)
        bodies: list[bytes] = []
        for start in range(0, len(segments), 6):
            batch = segments[start:start + 6]
            bodies += await asyncio.gather(*(self.fetch(s.url) for s in batch))
        audio = b"".join(
            ts_audio(decrypt_segment(body, keys[s.key_url], s.iv) if s.key_url else body)
            for s, body in zip(segments, bodies)
        )
        if len(audio) > MAX_AUDIO_BYTES:
            raise TooLarge(url)
        return audio if looks_like_mp3(audio) else None


# --- Finding a song and its file ---------------------------------------------

def _cache_key(track: Track) -> str:
    return f"music:tg:{track.source}:{track.id}"


async def _quietly(awaitable):
    """None instead of a source failure: the next source gets its turn."""
    try:
        return await awaitable
    except (Unavailable, TooLarge) as error:
        logger.info("music: %s", type(error).__name__ + (f": {error}" if str(error) else ""))
        return None


class MusicFinder:
    def __init__(self, yandex: YandexMusic, vk: VkAudio):
        self.yandex = yandex
        self.vk = vk

    async def find(self, request: MusicRequest, explicit: bool) -> Track | None:
        """The song a request names. Raises Unavailable when no source could be asked."""
        if request.kind == "yandex":
            return await self.yandex.track(request.ref)
        if request.kind == "vk":
            return await self.vk.by_id(request.ref)
        asked = 0
        for source in (self.yandex, self.vk):
            try:
                results = await source.search(request.query)
            except Unavailable:
                continue
            asked += 1
            track = pick_track(results, request.parts, explicit)
            if track:
                return track
        if not asked:
            raise Unavailable("no music source answers")
        return None

    async def vk_twin(self, track: Track) -> Track | None:
        """The same recording on VK: artist and title match, length within a few seconds."""
        if not self.vk.token:
            return None
        results = await self.vk.search(f"{track.performer} {track.title}")
        best: tuple[tuple[float, int], Track] | None = None
        for candidate in results:
            score = match_score((track.performer, track.title), candidate)
            if score < MATCH_THRESHOLD:
                continue
            gap = 0
            if track.duration and candidate.duration:
                gap = abs(track.duration - candidate.duration)
                if gap > max(10, track.duration * 0.06):
                    continue
            rank = (score, -gap)
            if best is None or rank > best[0]:
                best = (rank, candidate)
        return best[1] if best else None

    async def audio_for(self, track: Track, explicit: bool) -> Found | None:
        """The file to send: a cached upload, Yandex in full, the VK twin, then (asked for) a preview."""
        cached = _kv_get(_cache_key(track))
        if cached:
            return Found(track, file_id=cached)
        if track.source == "vk":
            data = await _quietly(self.vk.download(track))
            return Found(track, data=data, duration=track.duration) if data else None

        options = await _quietly(self.yandex.download_options(track)) if track.available else None
        full = best_option(options, preview=False)
        if full:
            data = await _quietly(self.yandex.fetch_option(full))
            if data:
                return Found(track, data=data, duration=track.duration)
        twin = await _quietly(self.vk_twin(track))
        if twin:
            data = await _quietly(self.vk.download(twin))
            if data:
                return Found(track, data=data, duration=twin.duration)
        preview = best_option(options, preview=True) if explicit else None
        if preview:
            data = await _quietly(self.yandex.fetch_option(preview))
            if data:
                return Found(track, data=data, preview=True)
        return None

    async def cover(self, track: Track) -> bytes | None:
        if not track.cover_url:
            return None
        source = self.yandex if track.source == "yandex" else self.vk
        try:
            # Telegram takes a thumbnail of at most 200 kB.
            return await source.fetch(track.cover_url, limit=200 * 1024)
        except (Unavailable, TooLarge):
            return None


_finder: MusicFinder | None = None


def get_finder() -> MusicFinder:
    global _finder
    if _finder is None:
        _finder = MusicFinder(
            YandexMusic(YANDEX_MUSIC_TOKEN, YANDEX_MUSIC_PROXY_URL),
            VkAudio(VK_AUDIO_TOKEN),
        )
    return _finder


# --- Telegram -----------------------------------------------------------------

def _auto_key(chat_id: int) -> str:
    return f"music:auto:{chat_id}"


def auto_detect_enabled(chat_id: int) -> bool:
    value = _kv_get(_auto_key(chat_id))
    return MUSIC_AUTO_DETECT if value is None else value == "1"


def _filename(track: Track) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", f"{track.performer} - {track.full_title}")
    return " ".join(name.split())[:120] + ".mp3"


def _caption(found: Found) -> str | None:
    track = found.track
    link = (
        f'<a href="{html.escape(track.page_url, quote=True)}">Яндекс Музыка</a>'
        if track.source == "yandex" and track.page_url else ""
    )
    if found.preview:
        return "Фрагмент 30 секунд: целиком трек не нашёлся." + (f" {link}" if link else "")
    return link or None


async def _keep_uploading(context: ContextTypes.DEFAULT_TYPE, chat_id: int) -> None:
    """The "sending audio…" line under the chat title, for as long as the download runs."""
    while True:
        try:
            await context.bot.send_chat_action(chat_id=chat_id, action=ChatAction.UPLOAD_VOICE)
        except TelegramError:
            return
        await asyncio.sleep(4.5)


async def _send(message: Message, found: Found, finder: MusicFinder) -> None:
    track = found.track
    caption = _caption(found)
    if found.file_id:
        await message.reply_audio(audio=found.file_id, caption=caption, parse_mode=ParseMode.HTML)
        return
    thumbnail = await finder.cover(track)
    kwargs = dict(
        title=track.full_title[:128],
        performer=track.performer[:128],
        duration=found.duration,
        caption=caption,
        parse_mode=ParseMode.HTML,
        write_timeout=180,
        read_timeout=60,
    )
    try:
        sent = await message.reply_audio(
            audio=InputFile(found.data, filename=_filename(track)),
            # Bytes, not an InputFile: Telegram takes a thumbnail only as attach://.
            thumbnail=thumbnail,
            **kwargs,
        )
    except BadRequest as error:
        if not thumbnail:
            raise
        logger.info("music: thumbnail refused (%s), sending without it", error)
        sent = await message.reply_audio(
            audio=InputFile(found.data, filename=_filename(track)), **kwargs
        )
    if not found.preview and sent and sent.audio:
        _kv_set(_cache_key(track), sent.audio.file_id)


async def deliver(
    message: Message,
    context: ContextTypes.DEFAULT_TYPE,
    request: MusicRequest,
    explicit: bool,
    finder: MusicFinder | None = None,
) -> bool:
    """Find the song and post it as a reply. A bare line that finds nothing stays silent."""
    finder = finder or get_finder()
    async with _DELIVERY_SLOTS:
        try:
            track = await finder.find(request, explicit)
        except Unavailable:
            if explicit:
                await message.reply_text("Музыка сейчас недоступна, попробуй чуть позже.")
            return False
        if track is None:
            if explicit:
                await message.reply_text(
                    "Трек по ссылке не открылся."
                    if request.kind != "query"
                    else f"Не нашёл «{request.query}»."
                )
            return False

        uploading = asyncio.create_task(_keep_uploading(context, message.chat_id))
        try:
            found = await finder.audio_for(track, explicit)
            if found is None:
                if explicit:
                    name = html.escape(f"{track.performer} — {track.full_title}")
                    where = (
                        f' Послушать: <a href="{html.escape(track.page_url, quote=True)}">Яндекс Музыка</a>'
                        if track.page_url else ""
                    )
                    await message.reply_text(
                        f"Нашёл «{name}», но файл достать не вышло.{where}",
                        parse_mode=ParseMode.HTML,
                        disable_web_page_preview=True,
                    )
                return False
            try:
                await _send(message, found, finder)
            except TelegramError as error:
                logger.warning("music: sending %s failed: %s", _cache_key(track), error)
                if explicit:
                    await message.reply_text("Нашёл трек, но Telegram не принял файл.")
                return False
            return True
        finally:
            uploading.cancel()


async def music_message_handler(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """A track link in any chat, or a bare "Artist — Title" line where auto-detect is on."""
    message = update.effective_message
    chat = update.effective_chat
    if message is None or chat is None:
        return
    sender = message.from_user
    if (sender and sender.is_bot) or message.via_bot or message.is_automatic_forward:
        return
    got = request_from_message(message)
    if got is None:
        return
    request, explicit = got
    if any((context.user_data or {}).get(key) for key in _AWAITING_KEYS):
        return
    if not explicit and not auto_detect_enabled(chat.id):
        return
    await deliver(message, context, request, explicit)


TRACK_USAGE = (
    "Пришли «Исполнитель — Название» или ссылку на трек в Яндекс Музыке или VK, "
    "например: /track Кино — Группа крови"
)


async def track_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """/track <artist — title | link>, or /track in reply to such a message."""
    message = update.effective_message
    if message is None:
        return
    text = " ".join(context.args or [])
    if not text and message.reply_to_message:
        text = message.reply_to_message.text or message.reply_to_message.caption or ""
        if not link_request(text):
            for entity_url in _message_texts(message.reply_to_message)[1:]:
                if link_request(entity_url):
                    text = entity_url
                    break
    request = query_request(text)
    if request is None:
        await message.reply_text(TRACK_USAGE)
        return
    await deliver(message, context, request, explicit=True)


async def music_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """/music — what the music feature does here; /music on|off — (admins) bare-line search."""
    message = update.effective_message
    chat = update.effective_chat
    if message is None or chat is None:
        return
    choice = (context.args[0].lower() if context.args else "")
    if choice in ("on", "off"):
        if not await is_chat_admin(update, context):
            await message.reply_text("Включать и выключать автопоиск могут только админы чата.")
            return
        _kv_set(_auto_key(chat.id), "1" if choice == "on" else "0")
        await message.reply_text(
            "Автопоиск включён: на строку «Исполнитель — Название» пришлю трек, если найду именно его."
            if choice == "on"
            else "Автопоиск выключен. Ссылки на треки и /track работают как раньше."
        )
        return

    yandex = (
        "целиком" if YANDEX_MUSIC_TOKEN else "без токена, только 30-секундные фрагменты"
    ) + (", через прокси" if YANDEX_MUSIC_PROXY_URL else "")
    vk = "подключён" if VK_AUDIO_TOKEN else "не подключён"
    auto = "включён" if auto_detect_enabled(chat.id) else "выключен"
    await message.reply_text(
        "🎵 Музыка\n"
        "• Ссылка на трек в Яндекс Музыке или VK — пришлю сам трек.\n"
        "• /track Исполнитель — Название — найду и пришлю.\n"
        f"• Просто строка «Исполнитель — Название» в чате (автопоиск {auto}; "
        "админы: /music on, /music off).\n\n"
        f"Источники: Яндекс Музыка — {yandex}; VK — {vk}."
    )
