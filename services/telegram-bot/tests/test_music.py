"""Tracks on request: what counts as a request, which song is taken, where its file comes from.

No Yandex, VK or Telegram is contacted: sources are fakes, and the VK playlist
is a synthetic AES-128 HLS stream of MPEG-TS segments built here.
"""
import asyncio
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DB_PATH", tempfile.mktemp(prefix="music-test-", suffix=".sqlite"))

from Crypto.Cipher import AES
from sqlalchemy import create_engine, text
from telegram.ext import CommandHandler, MessageHandler

from bot import app, music
from bot.music import (
    Found,
    MusicFinder,
    MusicRequest,
    Track,
    Unavailable,
    VkAudio,
    link_request,
    match_score,
    parse_m3u8,
    pick_track,
    query_request,
    split_artist_title,
    vk_mp3_url,
    yandex_mp3_url,
)

MP3 = b"\xff\xfb\x90\x64" + bytes(range(256)) * 3


def yandex_track(**overrides) -> Track:
    values = dict(
        source="yandex", id="38633712", artists=["КИНО"], title="Группа крови",
        duration=235, page_url="https://music.yandex.ru/album/5307396/track/38633712",
    )
    values.update(overrides)
    return Track(**values)


def vk_track(**overrides) -> Track:
    values = dict(
        source="vk", id="-2001_77", artists=["Кино"], title="Группа крови",
        duration=236, audio_url="https://cs1.vkuseraudio.net/s/v1/a2/x.mp3",
    )
    values.update(overrides)
    return Track(**values)


class LinkTests(unittest.TestCase):
    def test_yandex_share_links_name_the_track(self):
        for url in (
            "https://music.yandex.ru/album/5307396/track/38633712?utm_source=desktop&utm_medium=copy_link",
            "https://music.yandex.com/track/38633712",
            "Сейчас слушаю: КИНО — Группа крови https://music.yandex.ru/album/5307396/track/38633712",
        ):
            self.assertEqual(link_request(url), MusicRequest("yandex", ref="38633712"), url)

    def test_vk_links_keep_the_access_key(self):
        self.assertEqual(
            link_request("https://vk.com/audio-2001234_5678_ab12cd"),
            MusicRequest("vk", ref="-2001234_5678_ab12cd"),
        )
        self.assertEqual(link_request("https://m.vk.ru/audio42_7"), MusicRequest("vk", ref="42_7"))

    def test_albums_playlists_and_other_sites_are_not_tracks(self):
        for text_value in (
            "https://music.yandex.ru/album/5307396",
            "https://music.yandex.ru/users/someone/playlists/3",
            "https://vk.com/music/album/-2000_1",
            "https://example.com/track/1",
        ):
            self.assertIsNone(link_request(text_value), text_value)


class BareLineTests(unittest.TestCase):
    def test_artist_and_title_around_a_dash(self):
        self.assertEqual(split_artist_title("Кино — Группа крови"), ("Кино", "Группа крови"))
        self.assertEqual(split_artist_title("AC/DC - Back In Black"), ("AC/DC", "Back In Black"))
        self.assertEqual(split_artist_title("Земфира–Хочешь"), ("Земфира", "Хочешь"))
        self.assertEqual(split_artist_title("«Кино» - «Кукушка»"), ("Кино", "Кукушка"))

    def test_ordinary_chat_is_not_a_search(self):
        for line in (
            "кто-то пришёл",                        # hyphen inside a word
            "а ты кто - бот?",                      # a question
            "Кино — Группа крови\nи ещё одна",      # two lines
            "@cyberia_bot Кино — Группа крови",     # addressed to someone
            "смотри https://x.com - вот",           # a link
            "10 - 5",                               # no words
            "это была очень длинная история про то как мы все вместе - и потом ушли",
        ):
            self.assertIsNone(split_artist_title(line), line)

    def test_track_command_takes_links_dashes_and_free_words(self):
        self.assertEqual(query_request("https://music.yandex.ru/track/1").kind, "yandex")
        dashed = query_request("Кино — Группа крови")
        self.assertEqual((dashed.query, dashed.parts), ("Кино Группа крови", ("Кино", "Группа крови")))
        free = query_request("группа крови")
        self.assertEqual((free.query, free.parts), ("группа крови", None))
        self.assertIsNone(query_request("   "))


class MatchTests(unittest.TestCase):
    def test_artist_and_title_must_both_match_in_either_order(self):
        track = yandex_track()
        self.assertGreaterEqual(match_score(("кино", "группа крови"), track), music.MATCH_THRESHOLD)
        self.assertGreaterEqual(match_score(("Группа крови", "Кино"), track), music.MATCH_THRESHOLD)
        self.assertLess(match_score(("Кино", "Кукушка"), track), music.MATCH_THRESHOLD)
        tsoi = yandex_track(artists=["Виктор Цой"])
        self.assertGreaterEqual(match_score(("Цой", "Группа крови"), tsoi), music.MATCH_THRESHOLD)
        # A surname is enough for the artist, a single word is not enough for a title.
        longer = yandex_track(artists=["Скриптонит"], title="Где твоя любовь?")
        self.assertLess(match_score(("Скриптонит", "Любовь"), longer), music.MATCH_THRESHOLD)
        self.assertLess(match_score(("Привет", "как дела"), track), music.MATCH_THRESHOLD)

    def test_versions_and_featured_artists_do_not_break_a_match(self):
        remaster = yandex_track(title="Группа крови (Remastered 2019)")
        self.assertGreaterEqual(match_score(("Кино", "Группа крови"), remaster), music.MATCH_THRESHOLD)
        duet = yandex_track(artists=["Miyagi", "Andy Panda"], title="Kosandra")
        self.assertGreaterEqual(match_score(("Miyagi", "Kosandra"), duet), music.MATCH_THRESHOLD)

    def test_a_bare_line_takes_only_a_sure_match_and_a_command_the_best_there_is(self):
        cover = yandex_track(artists=["Кавер-бэнд"], title="Группа крови (кавер)")
        original = yandex_track()
        self.assertIs(pick_track([cover, original], ("Кино", "Группа крови"), explicit=False), original)
        stranger = yandex_track(artists=["Другой"], title="Песня")
        self.assertIsNone(pick_track([stranger], ("Кино", "Группа крови"), explicit=False))
        self.assertIs(pick_track([stranger], ("Кино", "Группа крови"), explicit=True), stranger)
        self.assertIsNone(pick_track([stranger], None, explicit=False))


def _ts_packet(pid: int, payload: bytes, start: bool) -> bytes:
    header = bytes([0x47, (0x40 if start else 0) | (pid >> 8), pid & 0xFF])
    if len(payload) == 184:
        return header + b"\x10" + payload
    stuffing = 183 - len(payload)
    adaptation = bytes([stuffing]) + (b"\x00" + b"\xff" * (stuffing - 1) if stuffing else b"")
    return header + b"\x30" + adaptation + payload


def transport_stream(audio: bytes, pid: int = 0x101) -> bytes:
    """A PAT packet, then one MPEG audio PES (with a PTS) split over TS packets."""
    out = _ts_packet(0, b"\x00\x00\xb0\x0d" + b"\x00" * 9, start=True)
    pes = b"\x00\x00\x01\xc0\x00\x00\x80\x80\x05\x21\x00\x01\x00\x01" + audio
    for offset in range(0, len(pes), 184):
        out += _ts_packet(pid, pes[offset:offset + 184], start=offset == 0)
    return out


def encrypt(data: bytes, key: bytes, iv: bytes) -> bytes:
    pad = 16 - len(data) % 16
    return AES.new(key, AES.MODE_CBC, iv).encrypt(data + bytes([pad]) * pad)


class FakeVk(VkAudio):
    def __init__(self, files: dict[str, bytes]):
        super().__init__(token="vk-token")
        self.files = files
        self.fetched: list[str] = []

    async def fetch(self, url, limit=music.MAX_AUDIO_BYTES):
        self.fetched.append(url)
        if url not in self.files:
            raise Unavailable("HTTP 404")
        return self.files[url]


class AudioFormatTests(unittest.TestCase):
    BASE = "https://cs9.vkuseraudio.net/s/v1/ac/abc/def/index.m3u8"

    def test_encrypted_hls_segments_become_one_mp3(self):
        key = bytes(range(16))
        first, second = MP3[:500], MP3[500:]
        playlist = (
            "#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:1\n"
            '#EXT-X-KEY:METHOD=AES-128,URI="key.pub"\n#EXTINF:2.0,\nseg-1.ts\n'
            "#EXT-X-KEY:METHOD=NONE\n#EXTINF:4.0,\nseg-2.ts\n#EXT-X-ENDLIST\n"
        )
        segments = parse_m3u8(playlist, self.BASE)
        self.assertEqual([s.url.rsplit("/", 1)[1] for s in segments], ["seg-1.ts", "seg-2.ts"])
        self.assertEqual(segments[0].iv, (1).to_bytes(16, "big"))
        self.assertIsNone(segments[1].key_url)

        base = self.BASE.rsplit("/", 1)[0] + "/"
        vk = FakeVk({
            self.BASE: playlist.encode(),
            base + "key.pub": key,
            base + "seg-1.ts": encrypt(transport_stream(first), key, (1).to_bytes(16, "big")),
            base + "seg-2.ts": transport_stream(second),
        })
        audio = asyncio.run(vk.download(vk_track(audio_url=self.BASE)))
        self.assertEqual(audio, MP3)
        # The plain-mp3 twin of the playlist was tried first and was not there.
        self.assertEqual(vk.fetched[0], vk_mp3_url(self.BASE))

    def test_a_playlist_with_a_plain_mp3_twin_is_not_assembled(self):
        vk = FakeVk({"https://cs9.vkuseraudio.net/s/v1/ac/def.mp3": MP3})
        self.assertEqual(vk_mp3_url(self.BASE), "https://cs9.vkuseraudio.net/s/v1/ac/def.mp3")
        self.assertEqual(asyncio.run(vk.download(vk_track(audio_url=self.BASE))), MP3)
        self.assertEqual(len(vk.fetched), 1)

    def test_yandex_download_info_becomes_a_signed_file_url(self):
        xml = (
            '<?xml version="1.0" encoding="utf-8"?><download-info>'
            "<host>s1.storage.yandex.net</host><path>/rmusic/U2FsdGVk/5355</path>"
            "<ts>00066084b1</ts><region>-1</region><s>abc123</s></download-info>"
        )
        self.assertEqual(
            yandex_mp3_url(xml),
            "https://s1.storage.yandex.net/get-mp3/"
            "bdbfca4a5e189be00fa2bb05911c498d/00066084b1/rmusic/U2FsdGVk/5355",
        )
        with self.assertRaises(ValueError):
            yandex_mp3_url("<download-info></download-info>")


class FakeYandex:
    def __init__(self, results=(), options=(), unavailable=False):
        self.results = list(results)
        self.options = list(options)
        self.unavailable = unavailable
        self.fetched: list[dict] = []

    async def search(self, query):
        if self.unavailable:
            raise Unavailable("HTTP 451")
        return self.results

    async def track(self, track_id):
        return next((t for t in self.results if t.id == track_id), None)

    async def download_options(self, track):
        return self.options

    async def fetch_option(self, option):
        self.fetched.append(option)
        return b"preview" if option.get("preview") else MP3

    async def fetch(self, url, limit=0):
        raise Unavailable("no covers in tests")


class FakeVkSource:
    def __init__(self, results=(), token="vk-token"):
        self.results = list(results)
        self.token = token

    async def search(self, query):
        if not self.token:
            raise Unavailable("VK_AUDIO_TOKEN is not set")
        return self.results

    async def download(self, track):
        return b"vk:" + track.id.encode()

    async def fetch(self, url, limit=0):
        raise Unavailable("no covers in tests")


PREVIEW = {"codec": "mp3", "preview": True, "bitrateInKbps": 128, "downloadInfoUrl": "p"}
FULL = {"codec": "mp3", "preview": False, "bitrateInKbps": 320, "downloadInfoUrl": "f"}


class KvTestCase(unittest.TestCase):
    def setUp(self):
        engine = create_engine("sqlite:///:memory:")
        with engine.begin() as conn:
            conn.execute(text("CREATE TABLE bot_kv (key TEXT PRIMARY KEY, value TEXT)"))
        from bot import db
        patcher = patch.object(db, "engine", engine)
        patcher.start()
        self.addCleanup(patcher.stop)


class SourceOrderTests(KvTestCase):
    def test_yandex_in_full_comes_first(self):
        finder = MusicFinder(FakeYandex(options=[PREVIEW, FULL]), FakeVkSource([vk_track()]))
        found = asyncio.run(finder.audio_for(yandex_track(), explicit=False))
        self.assertEqual((found.data, found.preview), (MP3, False))

    def test_without_plus_the_same_recording_comes_from_vk_under_yandex_names(self):
        live = vk_track(id="-1_1", title="Группа крови (live)", duration=420)
        finder = MusicFinder(FakeYandex(options=[PREVIEW]), FakeVkSource([live, vk_track()]))
        found = asyncio.run(finder.audio_for(yandex_track(), explicit=False))
        self.assertEqual(found.data, b"vk:-2001_77")
        self.assertEqual((found.track.source, found.track.performer, found.duration), ("yandex", "КИНО", 236))
        self.assertFalse(found.preview)

    def test_a_preview_only_when_asked_for_and_marked_as_one(self):
        yandex = FakeYandex(options=[PREVIEW])
        finder = MusicFinder(yandex, FakeVkSource(token=""))
        self.assertIsNone(asyncio.run(finder.audio_for(yandex_track(), explicit=False)))
        found = asyncio.run(finder.audio_for(yandex_track(), explicit=True))
        self.assertEqual((found.data, found.preview), (b"preview", True))
        self.assertIn("Фрагмент 30 секунд", music._caption(found))

    def test_a_song_sent_before_is_sent_again_by_its_file_id(self):
        music._kv_set("music:tg:yandex:38633712", "FILE-1")
        yandex = FakeYandex(options=[FULL])
        found = asyncio.run(MusicFinder(yandex, FakeVkSource()).audio_for(yandex_track(), explicit=False))
        self.assertEqual(found.file_id, "FILE-1")
        self.assertEqual(yandex.fetched, [])

    def test_vk_is_searched_when_yandex_is_blocked(self):
        finder = MusicFinder(FakeYandex(unavailable=True), FakeVkSource([vk_track()]))
        request = query_request("Кино — Группа крови")
        self.assertEqual(asyncio.run(finder.find(request, explicit=False)).source, "vk")

    def test_no_source_at_all_is_said_as_such(self):
        finder = MusicFinder(FakeYandex(unavailable=True), FakeVkSource(token=""))
        with self.assertRaises(Unavailable):
            asyncio.run(finder.find(query_request("Кино — Группа крови"), explicit=True))


def chat_message(sent_file_id="FILE-9"):
    return SimpleNamespace(
        chat_id=-100,
        reply_text=AsyncMock(),
        reply_audio=AsyncMock(return_value=SimpleNamespace(audio=SimpleNamespace(file_id=sent_file_id))),
    )


def bot_context():
    return SimpleNamespace(bot=SimpleNamespace(send_chat_action=AsyncMock()), user_data={})


class DeliveryTests(KvTestCase):
    def test_a_bare_line_that_names_no_song_gets_no_reply(self):
        finder = MusicFinder(FakeYandex([yandex_track(artists=["Другой"], title="Песня")]), FakeVkSource([]))
        message = chat_message()
        request = MusicRequest("query", query="Привет как дела", parts=("Привет", "как дела"))
        self.assertFalse(asyncio.run(music.deliver(message, bot_context(), request, False, finder)))
        message.reply_text.assert_not_awaited()
        message.reply_audio.assert_not_awaited()

    def test_a_found_song_is_posted_with_its_names_and_remembered(self):
        finder = MusicFinder(FakeYandex([yandex_track()], options=[FULL]), FakeVkSource())
        message = chat_message()
        request = query_request("Кино — Группа крови")
        self.assertTrue(asyncio.run(music.deliver(message, bot_context(), request, False, finder)))
        kwargs = message.reply_audio.await_args.kwargs
        self.assertEqual((kwargs["performer"], kwargs["title"], kwargs["duration"]), ("КИНО", "Группа крови", 235))
        self.assertEqual(kwargs["audio"].filename, "КИНО - Группа крови.mp3")
        self.assertIn("music.yandex.ru/album/5307396/track/38633712", kwargs["caption"])
        self.assertEqual(music._kv_get("music:tg:yandex:38633712"), "FILE-9")

    def test_an_explicit_request_that_finds_nothing_says_so(self):
        finder = MusicFinder(FakeYandex([]), FakeVkSource([]))
        message = chat_message()
        asyncio.run(music.deliver(message, bot_context(), query_request("абвгд"), True, finder))
        self.assertIn("Не нашёл «абвгд»", message.reply_text.await_args.args[0])
        message.reply_audio.assert_not_awaited()

    def test_a_preview_is_not_remembered_as_the_song(self):
        finder = MusicFinder(FakeYandex([yandex_track()], options=[PREVIEW]), FakeVkSource(token=""))
        asyncio.run(music.deliver(chat_message(), bot_context(), MusicRequest("yandex", ref="38633712"), True, finder))
        self.assertIsNone(music._kv_get("music:tg:yandex:38633712"))


class ChatWiringTests(KvTestCase):
    def message(self, text_value, chat_type="supergroup"):
        return SimpleNamespace(
            text=text_value, caption=None, entities=(), caption_entities=(),
            from_user=SimpleNamespace(is_bot=False), via_bot=None, is_automatic_forward=False,
            chat_id=-100,
        )

    def handle(self, text_value, auto=None, chat_id=-100):
        if auto is not None:
            music._kv_set(f"music:auto:{chat_id}", auto)
        update = SimpleNamespace(
            effective_message=self.message(text_value),
            effective_chat=SimpleNamespace(id=chat_id, type="supergroup"),
        )
        with patch.object(music, "deliver", AsyncMock()) as deliver:
            asyncio.run(music.music_message_handler(update, bot_context()))
        return deliver

    def test_links_are_always_answered_and_bare_lines_follow_the_chat_switch(self):
        self.assertTrue(self.handle("https://music.yandex.ru/track/1", auto="0").await_args.args[3])
        self.assertFalse(self.handle("Кино — Группа крови", chat_id=-200).await_args.args[3])
        self.handle("Кино — Группа крови", auto="0").assert_not_awaited()
        self.handle("просто болтаю").assert_not_awaited()

    def test_the_ai_leaves_links_to_music_but_not_ordinary_lines(self):
        self.assertTrue(music.claims_message(self.message("https://vk.com/audio1_2")))
        self.assertFalse(music.claims_message(self.message("Кино — Группа крови")))

    def test_handlers_are_registered_non_blocking_and_ahead_of_the_ai(self):
        application = MagicMock()
        builder = MagicMock()
        builder.token.return_value = builder
        builder.post_init.return_value = builder
        builder.build.return_value = application
        with patch.object(app.Application, "builder", return_value=builder), \
                patch.object(app, "TELEGRAM_BOT_TOKEN", "test-token"), \
                patch.object(app, "HTTP_PROXY", None), \
                patch.object(app, "AI_ENABLED", True), \
                patch.object(app, "MUSIC_ENABLED", True):
            app.run_dispatcher()
        registered = [(c.args[0], c.kwargs.get("group", 0)) for c in application.add_handler.call_args_list]
        groups = {h.callback: g for h, g in registered if isinstance(h, MessageHandler)}
        self.assertLess(groups[music.music_message_handler], groups[app.ai_message_handler])
        handlers = {h.callback: h for h, _ in registered}
        self.assertFalse(handlers[music.music_message_handler].block)
        track = [h for h, _ in registered if isinstance(h, CommandHandler) and "track" in h.commands]
        self.assertEqual([h.callback for h in track], [music.track_command])
        self.assertFalse(track[0].block)


if __name__ == "__main__":
    unittest.main()
