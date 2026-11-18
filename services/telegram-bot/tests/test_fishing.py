"""🎣 fishing: places, bait and a bucket as durable state, and the queue that
turns a catch into an NFT.

A cast is `waiting → biting → caught | escaped`, and whatever order the strike
and the escape timer arrive in, exactly one outcome is written. What comes up
goes into the bucket until its angler mints it or sells it. The NFT queue is
driven against a fake chain that only does what a node can — hand back a
receipt, no receipt yet, or an error — and asks one question of every path:
did each catch reach its angler's wallet exactly once?
"""
import asyncio
import struct
import tempfile
import time
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from sqlalchemy import create_engine, text
from telegram import InputMediaPhoto
from telegram.error import TelegramError
from web3.exceptions import Web3RPCError

from bot import db, fish_art, fishing, language, stakes
from bot import fishing_world as world

WALLET = "0x00000000000000000000000000000000000000A1"
DAY = 1000                                   # 1000 s into the game day: daylight
NIGHT = int(world.CYCLE * 0.8)


class Fixed:
    """For a cast: the bite comes at the earliest moment."""

    def uniform(self, low, high):
        return low


class Pick:
    """An RNG that lands on one item of the table it is rolled against."""

    def __init__(self, key, spot, when, bait, bare, size=0.5):
        table = world.weights(spot, when, bait, bare)
        before = 0.0
        for item, weight in table.items():
            if item == key:
                break
            before += weight
        else:
            raise AssertionError(f"{key} does not bite at {spot}")
        self.values = [(before + table[key] / 2) / sum(table.values()), size]

    def random(self):
        return self.values.pop(0) if len(self.values) > 1 else self.values[0]

    def getrandbits(self, bits):
        return 7


def png_size(image):
    return struct.unpack(">II", image[16:24])


def pixels(image):
    idat = image.index(b"IDAT")
    length = struct.unpack(">I", image[idat - 4:idat])[0]
    raw = zlib.decompress(image[idat + 4:idat + 4 + length])
    side = fish_art.SIZE * fish_art.SCALE
    stride = 1 + 3 * side
    return [raw[row * stride + 1 + col * 3:row * stride + 4 + col * 3]
            for row in range(0, side, fish_art.SCALE) for col in range(0, side, fish_art.SCALE)]


class CatalogueTests(unittest.TestCase):
    def test_every_spot_names_things_that_exist_and_can_be_drawn(self):
        for key, spot in world.SPOTS.items():
            self.assertIn(spot["rod"], world.GEAR, key)
            self.assertTrue(not spot["key"] or world.ITEMS[spot["key"]]["opens"] == key, key)
            self.assertTrue(not spot["bait"] or spot["bait"] in world.BAITS, key)
            self.assertTrue(set(spot["baits"]) <= set(world.BAITS), key)
            for item in spot["loot"]:
                thing = world.ITEMS[item]
                self.assertIn(thing["rarity"], world.RARITIES)
                self.assertTrue(thing.get("look") or item in fish_art.ITEM_ART, item)

    def test_the_keys_lead_from_one_place_to_the_next(self):
        self.assertIn("chart", world.SPOTS["lake"]["loot"])
        self.assertEqual(world.ITEMS["chart"]["opens"], "sea")
        self.assertIn("keycard", world.SPOTS["sea"]["loot"])
        self.assertEqual(world.ITEMS["keycard"]["opens"], "wired")

    def test_the_day_turns(self):
        self.assertEqual(world.phase(0), "dawn")
        self.assertEqual(world.phase(DAY), "day")
        self.assertEqual(world.phase(world.CYCLE * 0.6), "dusk")
        self.assertEqual(world.phase(NIGHT), "night")
        self.assertEqual(world.phase(world.CYCLE + DAY), "day")
        self.assertEqual(world.phase_left(world.CYCLE * 0.65 - 30), 30)

    def test_bait_brings_what_it_likes_and_an_empty_hook_drags_junk(self):
        plain = world.chances("river", "day", None, bare=True)
        worm = world.chances("river", "day", "worm")
        empty = world.chances("river", "day", None)
        magnet = world.chances("river", "day", "magnet")
        self.assertGreater(worm["roach"], plain["roach"])
        self.assertGreater(empty["boot"], plain["boot"])
        self.assertGreater(magnet["ring"], plain["ring"])
        self.assertAlmostEqual(sum(worm.values()), 1.0)

    def test_the_catfish_comes_out_at_night_and_trout_by_day(self):
        day, night = world.chances("lake", "day", "live"), world.chances("lake", "night", "live")
        self.assertGreater(night["catfish"], 2 * day["catfish"])
        self.assertGreater(day["trout"], night["trout"])

    def test_a_roll_lands_where_its_draw_falls_and_trophies_are_the_top(self):
        for size in (0.0, 0.5, 0.89, 0.9):
            caught = world.roll("pond", "day", None, True, Pick("bream", "pond", "day", None, True, size))
            low, high = world.ITEMS["bream"]["kg"]
            self.assertEqual(caught["species"], "bream")
            self.assertTrue(low * 1000 <= caught["grams"] <= high * 1000)
            self.assertEqual(caught["trophy"], int(size >= 0.9))
        boot = world.roll("pond", "day", None, True, Pick("boot", "pond", "day", None, True))
        self.assertEqual((boot["kind"], boot["grams"]), ("junk", 0))

    def test_the_buyer_pays_by_rarity_double_for_a_trophy(self):
        self.assertEqual(world.price({"species": "boot", "rarity": "common", "trophy": 0}), 2)
        self.assertEqual(world.price({"species": "pike", "rarity": "uncommon", "trophy": 1}), 10)
        self.assertEqual(world.price({"species": "ring", "rarity": "rare", "trophy": 0}), 18)

    def test_the_hook_takes_the_required_bait_then_your_choice_then_what_the_spot_likes(self):
        self.assertEqual(world.pick_bait("wired", {"glitch": 1, "worm": 3}, "worm"), "glitch")
        self.assertIsNone(world.pick_bait("wired", {"worm": 3}))
        self.assertEqual(world.pick_bait("river", {"worm": 1, "magnet": 1}, "magnet"), "magnet")
        self.assertEqual(world.pick_bait("river", {"live": 1, "worm": 1}), "worm")
        self.assertIsNone(world.pick_bait("river", {}))


class PictureTests(unittest.TestCase):
    def test_a_place_is_a_512px_png_and_its_night_is_darker_than_its_day(self):
        day, night = fish_art.render_place("pond", "day"), fish_art.render_place("pond", "night")
        self.assertTrue(day.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(png_size(day), (fish_art.SIZE * fish_art.SCALE,) * 2)
        brightness = [sum(sum(pixel) for pixel in pixels(image)) for image in (day, night)]
        self.assertLess(brightness[1], brightness[0] * 0.7)

    def test_every_thing_draws_at_every_hour_and_the_same_catch_draws_the_same(self):
        for key, thing in world.ITEMS.items():
            for when in world.PHASE_INFO:
                image = fish_art.render_loot("sea", when, key, "#3d8bff", 3, 5, look=thing.get("look"))
                self.assertEqual(png_size(image), (fish_art.SIZE * fish_art.SCALE,) * 2, key)
        first = fish_art.render_loot("lake", "night", "chart", "#b45cff", 4, 9)
        self.assertEqual(first, fish_art.render_loot("lake", "night", "chart", "#b45cff", 4, 9))

    def test_a_catch_from_before_places_keeps_its_old_picture(self):
        old = {"species": "pike", "rarity": "uncommon", "grams": 6000, "seed": 5}
        fill = 0.86 + 0.14 * ((6 - 2) / 8) ** 0.5
        self.assertEqual(fishing.picture(old), fish_art.render(world.ITEMS["pike"]["look"], "#5cc46a", 2, 5, fill))


class FishingCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.engine = create_engine(f"sqlite:///{Path(self.directory.name) / 'test.sqlite'}")
        self.addCleanup(self.engine.dispose)
        for module in (db, fishing, stakes):
            mock = patch.object(module, "engine", self.engine)
            mock.start()
            self.addCleanup(mock.stop)
        db.ensure_schema()
        fishing.ensure_schema()
        fishing._key_memory.clear()

    def hooked(self, key="roach", user=1, chat=-100, now=DAY, size=0.5, keys=None):
        """Cast, let it bite, strike a second later on `key`: (cast, catch)."""
        cast_id, delay = fishing.cast(chat, user, "Angler", now=now, rng=Fixed(), keys=keys)
        row = fishing.get_cast(cast_id)
        at = now + delay + 1
        rng = Pick(key, row["spot"], world.phase(at), row["bait"], row["gear"] == "hands", size)
        fishing.bite(cast_id, now + delay)
        return fishing.strike(cast_id, user, at, rng=rng)

    def catch(self, key="roach", **kwargs):
        return self.hooked(key, **kwargs)[1]

    def equip(self, user=1, **fields):
        with self.engine.begin() as conn:
            fishing._save(conn, user, **fields)

    def stock(self, user=1, **baits):
        with self.engine.begin() as conn:
            for bait, count in baits.items():
                conn.execute(text("INSERT OR REPLACE INTO fishing_baits(user_id,bait,count) VALUES(:u,:b,:n)"),
                             {"u": user, "b": bait, "n": count})

    def link(self, user=1, address=WALLET):
        with self.engine.begin() as conn:
            conn.execute(text("INSERT INTO tg_wallets(user_id,address) VALUES(:u,:a)"), {"u": user, "a": address})

    def status(self, catch_id):
        return fishing.get_catch(catch_id)["nft_status"]


class CastTests(FishingCase):
    def test_a_strike_in_time_puts_the_catch_in_the_bucket_with_its_place_and_hour(self):
        catch = self.catch("roach")
        self.assertEqual((catch["nft_status"], catch["kind"], catch["spot"], catch["phase"], catch["gear"]),
                         ("bucket", "fish", "pond", "day", "hands"))
        self.assertEqual(fishing.get_cast(catch["cast_id"])["status"], "caught")
        self.assertEqual([row["id"] for row in fishing.bucket(1)], [catch["id"]])

    def test_junk_and_treasure_are_loot_too(self):
        self.assertEqual(self.catch("boot")["nft_status"], "bucket")
        self.assertEqual(self.catch("can", user=2)["kind"], "junk")

    def test_bare_hands_hold_only_common_loot_and_say_what_got_away(self):
        row, catch = self.hooked("bream")
        self.assertIsNone(catch)
        self.assertEqual(row["got_away"]["species"], "bream")
        self.assertIn("Голыми руками", fishing.too_big_text("Angler", "hands", row["got_away"], "ru"))
        self.assertEqual(fishing.bucket(1), [])
        ready = fishing.get_cast(row["id"])["ready_at"]
        fishing.cast(-100, 1, "Angler", now=ready, rng=Fixed())     # a miss: the short rest only

    def test_a_rod_spends_one_bait_per_cast_and_hands_spend_none(self):
        self.stock(worm=2)
        cast_id, _ = fishing.cast(-100, 1, "Angler", now=DAY, rng=Fixed())
        self.assertIsNone(fishing.get_cast(cast_id)["bait"])               # bare hands
        fishing.sweep(DAY + fishing.STUCK)
        self.equip(gear="hazel", spot="river")
        cast_id, _ = fishing.cast(-100, 1, "Angler", now=DAY + fishing.STUCK + 1, rng=Fixed())
        self.assertEqual(fishing.get_cast(cast_id)["bait"], "worm")
        self.assertEqual(fishing.bait_stock(1), {"worm": 1})

    def test_only_the_angler_can_strike(self):
        cast_id, delay = fishing.cast(-100, 1, "Angler", now=DAY, rng=Fixed())
        fishing.bite(cast_id, DAY + delay)
        with self.assertRaises(ValueError) as other:
            fishing.strike(cast_id, 2, DAY + delay + 1, rng=Pick("roach", "pond", "day", None, True))
        self.assertIn("Это заброс Angler", str(other.exception))

    def test_a_late_strike_lets_it_go_with_only_a_short_rest(self):
        cast_id, delay = fishing.cast(-100, 1, "Angler", now=DAY, rng=Fixed())
        fishing.bite(cast_id, DAY + delay)
        late = DAY + delay + fishing.GEAR["hands"]["window"] + 0.1
        row, catch = fishing.strike(cast_id, 1, late, rng=Pick("roach", "pond", "day", None, True))
        self.assertIsNone(catch)
        self.assertEqual(fishing.get_cast(cast_id)["ready_at"], int(late) + fishing.MISS_COOLDOWN)

    def test_the_escape_timer_and_a_strike_settle_one_outcome(self):
        cast_id, delay = fishing.cast(-100, 1, "Angler", now=DAY, rng=Fixed())
        fishing.bite(cast_id, DAY + delay)
        self.assertFalse(fishing.escape(cast_id, DAY + delay + 1))
        fishing.strike(cast_id, 1, DAY + delay + 2, rng=Pick("roach", "pond", "day", None, True))
        self.assertFalse(fishing.escape(cast_id, DAY + delay + 60))
        with self.assertRaises(ValueError):
            fishing.strike(cast_id, 1, DAY + delay + 3, rng=Pick("roach", "pond", "day", None, True))
        self.assertEqual(len(fishing.bucket(1)), 1)

    def test_one_line_in_the_water_per_account_across_chats(self):
        fishing.cast(-100, 1, "Angler", now=DAY, rng=Fixed())
        with self.assertRaises(ValueError) as busy:
            fishing.cast(-200, 1, "Angler", now=DAY + 1, rng=Fixed())
        self.assertIn("уже рыбачите", str(busy.exception))
        fishing.cast(-100, 2, "Other", now=DAY + 1, rng=Fixed())

    def test_a_landing_rests_the_angler_everywhere(self):
        self.catch("roach")
        with self.assertRaises(fishing.Resting) as resting:
            fishing.cast(-200, 1, "Angler", now=DAY + 100, rng=Fixed())
        self.assertIn("Рыба отдыхает", str(resting.exception))
        fishing.cast(-200, 1, "Angler", now=DAY + fishing.COOLDOWN + 10, rng=Fixed())

    def test_a_full_bucket_stops_the_line(self):
        size = fishing.BUCKETS["pail"]["size"]
        for index in range(size):
            self.catch("roach", now=DAY + index * world.CYCLE)
        with self.assertRaises(fishing.BucketFull):
            fishing.cast(-100, 1, "Angler", now=DAY + size * world.CYCLE, rng=Fixed())

    def test_a_forgotten_cast_is_lost_and_owes_no_rest(self):
        cast_id, _ = fishing.cast(-100, 1, "Angler", now=DAY, rng=Fixed())
        swept = fishing.sweep(DAY + fishing.STUCK)
        self.assertEqual([row["id"] for row in swept], [cast_id])
        fishing.cast(-100, 1, "Angler", now=DAY + fishing.STUCK + 1, rng=Fixed())


class EnergyTests(FishingCase):
    def test_one_drink_poured_into_a_chat_ends_everyones_rest_there(self):
        self.catch("roach", user=1, chat=-100)
        self.catch("crucian", user=2, chat=-200)            # rests after fishing in another chat
        self.equip(user=3, energy=1)
        fishing.pour(-100, 3, "Barista", now=DAY + 100)
        self.assertEqual(fishing.angler(3)["energy"], 0)
        fishing.cast(-100, 1, "Angler", now=DAY + 120, rng=Fixed())
        fishing.cast(-100, 2, "Other", now=DAY + 120, rng=Fixed())

    def test_it_wakes_only_the_chat_it_was_poured_into(self):
        self.catch("roach", user=1, chat=-100)
        self.equip(user=3, energy=1)
        fishing.pour(-200, 3, "Barista", now=DAY + 100)
        with self.assertRaises(fishing.Resting):
            fishing.cast(-100, 1, "Angler", now=DAY + 120, rng=Fixed())

    def test_a_rest_that_begins_after_the_drink_is_a_rest(self):
        self.equip(user=3, energy=1)
        fishing.pour(-100, 3, "Barista", now=DAY - 50)
        self.catch("roach", user=1, chat=-100)
        with self.assertRaises(fishing.Resting):
            fishing.cast(-100, 1, "Angler", now=DAY + 120, rng=Fixed())

    def test_no_can_in_the_pocket_buys_one_and_no_shells_buys_nothing(self):
        with self.assertRaises(ValueError) as broke:
            fishing.pour(-100, 3, "Barista", now=DAY)
        self.assertIn("Нет энергетика", str(broke.exception))
        self.equip(user=3, shells=fishing.ENERGY["price"] + 1)
        fishing.pour(-100, 3, "Barista", now=DAY)
        self.assertEqual(fishing.angler(3)["shells"], 1)

    def test_a_can_fished_up_goes_into_the_pocket_not_the_bucket(self):
        self.equip(gear="hazel", spot="river")
        catch = self.catch("energy")
        self.assertEqual(catch["nft_status"], "pocket")
        self.assertEqual(fishing.angler(1)["energy"], 1)
        self.assertEqual(fishing.bucket(1), [])


class ShopTests(FishingCase):
    def test_shells_buy_rods_buckets_bait_and_drinks_and_never_more_than_they_cover(self):
        self.equip(shells=fishing.GEAR["hazel"]["price"] - 1)
        with self.assertRaises(ValueError) as short:
            fishing.buy(1, "rod", "hazel")
        self.assertIn("Не хватает ракушек", str(short.exception))
        self.equip(shells=100)
        self.assertEqual(fishing.buy(1, "rod", "hazel")["gear"], "hazel")
        self.assertEqual(fishing.buy(1, "bucket", "keepnet")["bucket"], "keepnet")
        fishing.buy(1, "bait", "worm")
        fishing.buy(1, "bait", "worm")
        self.assertEqual(fishing.bait_stock(1), {"worm": 20})
        self.assertEqual(fishing.buy(1, "energy")["energy"], 1)
        self.assertEqual(fishing.angler(1)["shells"], 100 - 10 - 25 - 5 - 5 - fishing.ENERGY["price"])
        for what, key in (("rod", "hazel"), ("rod", "hands"), ("bucket", "pail"), ("bait", "caviar")):
            with self.assertRaises(ValueError):
                fishing.buy(1, what, key)

    def test_the_shop_offers_only_what_is_above_your_own(self):
        self.equip(gear="hazel", bucket="keepnet", shells=5)
        body, markup = fishing.shop(1, "Angler", "en")
        self.assertIn("Angler: 🐚 5", body)
        offered = [button.callback_data for row in markup.inline_keyboard for button in row]
        self.assertIn("fishshop:rod:bamboo", offered)
        self.assertNotIn("fishshop:rod:hazel", offered)
        self.assertNotIn("fishshop:bucket:keepnet", offered)
        self.assertIn("fishshop:bucket:coolbox", offered)
        self.assertIn("fishshop:bait:glitch", offered)
        self.assertIn("fishshop:energy:1", offered)


class PlaceTests(FishingCase):
    def chart_in_hand(self, user=1):
        self.equip(user=user, gear="carbon", spot="lake")
        self.stock(user=user, live=3)
        return self.catch("chart", user=user)

    def test_a_better_spot_needs_a_better_rod(self):
        with self.assertRaises(ValueError) as closed:
            fishing.travel(1, "river", {})
        self.assertIn("удочка из орешника", str(closed.exception))
        self.equip(gear="hazel")
        self.assertEqual(fishing.travel(1, "river", {})["spot"], "river")

    def test_the_chart_in_the_bucket_opens_the_sea_and_selling_it_closes_it(self):
        chart = self.chart_in_hand()
        keys = fishing.keys_held(1)
        self.assertTrue(keys["chart"])
        fishing.travel(1, "sea", keys)
        fishing.sell(1, [chart["id"]])
        fishing._key_memory.clear()
        with self.assertRaises(ValueError) as gone:
            fishing.cast(-100, 1, "Angler", now=DAY + fishing.COOLDOWN + 10, rng=Fixed(), keys=fishing.keys_held(1))
        self.assertIn("Карта побережья", str(gone.exception))

    def test_a_chart_minted_into_a_wallet_opens_the_sea_for_whoever_holds_that_wallet(self):
        chart = self.chart_in_hand(user=1)
        self.link(user=1)
        with self.engine.begin() as conn:
            conn.execute(text("UPDATE fishing_catches SET nft_status='delivered', token_id=900 WHERE id=:id"),
                         {"id": chart["id"]})
        buyer = "0x00000000000000000000000000000000000000B2"
        self.link(user=2, address=buyer)
        on_chain = {900: WALLET}
        self.assertTrue(fishing.holds_key(1, "chart", owner_of=on_chain.get))
        self.assertFalse(fishing.holds_key(2, "chart", owner_of=on_chain.get))
        on_chain[900] = buyer                               # sold on the market
        fishing._key_memory.clear()
        self.assertTrue(fishing.holds_key(2, "chart", owner_of=on_chain.get))
        self.assertFalse(fishing.holds_key(1, "chart", owner_of=on_chain.get))

    def test_a_node_that_cannot_answer_is_no_key(self):
        chart = self.chart_in_hand()
        self.link()
        with self.engine.begin() as conn:
            conn.execute(text("UPDATE fishing_catches SET nft_status='delivered', token_id=900 WHERE id=:id"),
                         {"id": chart["id"]})

        def down(token):
            raise ConnectionError("rpc down")

        self.assertFalse(fishing.holds_key(1, "chart", owner_of=down))

    def test_the_wired_wants_its_rod_its_keycard_and_glitch_bait(self):
        self.equip(gear="wired")
        missing = fishing.blockers("wired", fishing.angler(1), {}, {"keycard": True})
        self.assertEqual([m.en for m in missing], ["💾 glitch bait"])
        self.assertEqual(fishing.blockers("wired", fishing.angler(1), {"glitch": 1}, {"keycard": True}), [])

    def test_the_map_shows_locks_and_offers_only_open_places(self):
        self.equip(gear="hazel")
        body, markup = fishing.spots_view(1, {}, "en")
        self.assertIn("🔒", body)
        self.assertEqual([row[0].callback_data for row in markup.inline_keyboard], ["fishspot:river"])


class BucketTests(FishingCase):
    def test_the_buyer_pays_for_what_you_sell_once(self):
        boot = self.catch("boot")
        self.equip(gear="hazel", spot="river")
        pike = self.catch("pike", now=DAY + world.CYCLE, size=0.95)
        paid, sold = fishing.sell(1)
        self.assertEqual(paid, 2 + 10)
        self.assertEqual(fishing.angler(1)["shells"], 12)
        self.assertEqual({self.status(boot["id"]), self.status(pike["id"])}, {"sold"})
        with self.assertRaises(ValueError):
            fishing.sell(1, [boot["id"]])

    def test_minting_needs_a_wallet_and_leaves_the_bucket(self):
        catch = self.catch("roach")
        with self.assertRaises(ValueError) as no_wallet:
            fishing.mint(1, [catch["id"]])
        self.assertIn("/set_wallet", str(no_wallet.exception))
        self.link()
        fishing.mint(1, [catch["id"]])
        self.assertEqual(self.status(catch["id"]), "pending")
        self.assertEqual(fishing.bucket(1), [])

    def test_nobody_empties_someone_elses_bucket(self):
        catch = self.catch("roach", user=1)
        with self.assertRaises(ValueError):
            fishing.sell(2, [catch["id"]])
        self.assertEqual(self.status(catch["id"]), "bucket")


class FakeChain:
    """What a node does: sign locally, accept or refuse, and later a receipt."""

    def __init__(self):
        self.signed, self.pool, self.receipts = [], [], {}
        self.refuse = None
        self.token = 400

    def sign_mint(self, uri):
        tx = f"0x{len(self.signed):064x}"
        self.signed.append(("mint", uri))
        return tx, ("mint", tx, uri)

    def sign_transfer(self, token_id, to):
        tx = f"0x{len(self.signed):064x}"
        self.signed.append(("transfer", token_id, to))
        return tx, ("transfer", tx, token_id, to)

    def broadcast(self, raw):
        if self.refuse:
            raise self.refuse
        self.pool.append(raw)

    def mine(self, succeed=True):
        for raw in self.pool:
            if raw[0] == "mint" and succeed:
                self.token += 1
                self.receipts[raw[1]] = (True, self.token)
            else:
                self.receipts[raw[1]] = (succeed, None)
        mined, self.pool = self.pool, []
        return mined

    def outcome(self, tx):
        return self.receipts.get(tx)


class QueueTests(FishingCase):
    def setUp(self):
        super().setUp()
        self.chain = FakeChain()
        self.pinned = []
        self.link()

    def pin(self, catch):
        self.pinned.append(catch["id"])
        return f"ipfs://fish-{catch['id']}"

    def step(self, now=5000):
        return fishing.advance(self.chain, pin=self.pin, now=now)

    def minted_catch(self, key="roach"):
        catch = self.catch(key)
        fishing.mint(1, [catch["id"]])
        return catch

    def test_nothing_reaches_the_chain_until_the_angler_mints_it_then_it_arrives_once(self):
        catch = self.catch("boot")
        self.assertEqual(self.step(), ([], False))
        fishing.mint(1, [catch["id"]])
        self.assertEqual(self.step(), ([], True))
        self.chain.mine()
        self.step()
        self.chain.mine()
        delivered, busy = self.step()
        self.assertEqual((delivered, busy), ([catch["id"]], False))
        row = fishing.get_catch(catch["id"])
        self.assertEqual((row["token_id"], row["recipient"]), (401, WALLET))
        self.assertEqual(self.chain.signed, [("mint", f"ipfs://fish-{catch['id']}"), ("transfer", 401, WALLET)])
        self.step()
        self.assertEqual(len(self.chain.signed), 2)

    def test_a_refused_broadcast_is_retried_with_the_same_pin_then_given_up(self):
        catch = self.minted_catch()
        self.chain.refuse = Web3RPCError("nonce too low")
        for attempt in range(1, fishing.MAX_ATTEMPTS):
            self.step()
            row = fishing.get_catch(catch["id"])
            self.assertEqual((row["nft_status"], row["attempts"]), ("pending", attempt))
        self.step()
        self.assertEqual(self.status(catch["id"]), "failed")
        self.assertEqual(self.pinned, [catch["id"]])

    def test_an_unclear_broadcast_waits_for_its_receipt_instead_of_minting_again(self):
        catch = self.minted_catch()
        self.chain.refuse = TimeoutError("read timed out")
        self.step()
        self.chain.refuse = None
        self.step(now=5100)
        self.assertEqual(sum(1 for item in self.chain.signed if item[0] == "mint"), 1)
        self.chain.receipts[fishing.get_catch(catch["id"])["mint_tx"]] = (True, 777)
        self.step(now=5200)
        self.assertEqual(fishing.get_catch(catch["id"])["token_id"], 777)

    def test_a_transaction_with_no_receipt_for_too_long_is_sent_again(self):
        catch = self.minted_catch()
        self.step(now=5000)
        self.chain.pool.clear()
        first = fishing.get_catch(catch["id"])["mint_tx"]
        self.step(now=5000 + fishing.DROPPED_AFTER + 1)
        row = fishing.get_catch(catch["id"])
        self.assertEqual((row["nft_status"], row["attempts"]), ("minting", 1))
        self.assertNotEqual(row["mint_tx"], first)

    def test_a_reverted_transfer_keeps_the_token_and_tries_again(self):
        catch = self.minted_catch()
        self.step()
        self.chain.mine()
        self.step()
        self.chain.mine(succeed=False)
        self.step()
        row = fishing.get_catch(catch["id"])
        self.assertEqual((row["nft_status"], row["token_id"], row["attempts"]), ("sending", 401, 1))


class MessageTests(FishingCase):
    def test_a_fresh_card_offers_mint_or_sell_and_a_delivered_one_the_market(self):
        catch = self.catch("roach")
        card = fishing.caption(catch, room=(1, 6))
        self.assertIn("📍 🏡 Деревенский пруд · ☀️ день", card)
        self.assertIn("🪣 Ведро: 1/6", card)
        buttons = [b.callback_data for b in fishing.catch_markup(catch).inline_keyboard[0]]
        self.assertEqual(buttons, [f"fishb:m:{catch['id']}", f"fishb:s:{catch['id']}"])
        delivered = dict(catch, nft_status="delivered", token_id=401, recipient=WALLET)
        self.assertIn("NFT #401", fishing.caption(delivered, minting=True))
        sell, explorer = fishing.catch_markup(delivered).inline_keyboard[0]
        self.assertTrue(sell.url.endswith("/market?token=401"))
        self.assertTrue(explorer.url.endswith("/instance/401"))

    def test_a_key_says_what_it_opens(self):
        self.equip(gear="carbon", spot="lake")
        chart = self.catch("chart")
        self.assertIn("⚓ Морской пирс", fishing.caption(chart))
        meta = fishing.metadata(chart, "ipfs://image")
        traits = {item["trait_type"]: item["value"] for item in meta["attributes"]}
        self.assertEqual((traits["Kind"], traits["Opens"], traits["Spot"]), ("Key", "Sea pier", "Forest lake"))

    def test_metadata_names_the_catch_its_place_and_hour_and_not_the_angler(self):
        catch = self.catch("roach")
        meta = fishing.metadata(catch, "ipfs://image")
        self.assertNotIn("Angler", str(meta))
        traits = {item["trait_type"]: item["value"] for item in meta["attributes"]}
        self.assertEqual((traits["Kind"], traits["Species"], traits["Time of day"]), ("Fish", "Roach", "day"))
        self.assertEqual(traits["Weight (g)"], catch["grams"])

    def test_the_odds_mark_what_your_rod_cannot_hold(self):
        table = fishing.odds("pond", "day", None, True, "hands", "en")
        self.assertIn("Goldfish", table)
        self.assertIn("🔒📡", table)

    def test_bag_and_top_rank_by_rarity_then_weight(self):
        self.equip(gear="wired")
        self.catch("roach", now=DAY)
        self.catch("goldfish", now=DAY + world.CYCLE)
        self.catch("coin", now=DAY + 2 * world.CYCLE)
        bag = fishing.bag(1, "Angler")
        self.assertIn("1. ★★★★★ Золотая рыбка", bag)
        self.assertIn("1. ★★☆☆☆ 🪙 Старая монета", bag)
        top = fishing.top(-100)
        self.assertIn("1. ★★★★★ Золотая рыбка", top)
        self.assertNotIn("монета", top)


class HandlerTests(FishingCase):
    def update(self, language_code="ru", user_id=1):
        sent = SimpleNamespace(message_id=55, photo=[SimpleNamespace(file_id="SCENE")])
        message = SimpleNamespace(message_id=50, sender_chat=None,
                                  reply_text=AsyncMock(return_value=SimpleNamespace(message_id=56)),
                                  reply_photo=AsyncMock(return_value=sent))
        return SimpleNamespace(
            effective_chat=SimpleNamespace(id=-100, type="supergroup"),
            effective_user=SimpleNamespace(id=user_id, is_bot=False, full_name="Angler", language_code=language_code),
            effective_message=message,
        )

    def context(self, args=()):
        bot = SimpleNamespace(edit_message_media=AsyncMock(), edit_message_caption=AsyncMock(),
                              edit_message_text=AsyncMock(), send_message=AsyncMock(), username="cyberia_network_bot")
        return SimpleNamespace(args=list(args), bot=bot, application=None)

    def cast_via_command(self, update, context=None):
        context = context or self.context()
        with patch.object(fishing, "_detach") as detach:
            asyncio.run(fishing.fish_command(update, context))
        if detach.call_args:
            detach.call_args.args[1].close()
        return context

    def only_cast(self):
        with self.engine.connect() as conn:
            return conn.execute(text("SELECT * FROM fishing_casts ORDER BY id DESC")).mappings().first()

    def test_a_cast_posts_the_place_and_remembers_its_picture(self):
        update = self.update("ru")
        self.cast_via_command(update)
        caption = update.effective_message.reply_photo.call_args.kwargs["caption"]
        self.assertIn("заходит в воду", caption)
        self.assertIn("📍 🏡 Деревенский пруд", caption)
        cast = self.only_cast()
        self.assertEqual((cast["message_id"], cast["media"], cast["spot"], cast["lang"]), (55, 1, "pond", "ru"))
        self.assertEqual(db._kv_get(f"{fishing.SCENE_CACHE}pond:{world.phase(time.time())}"), "SCENE")

    def test_a_chat_that_refuses_pictures_still_gets_the_cast_as_text(self):
        update = self.update("en")
        update.effective_message.reply_photo.side_effect = TelegramError("no media here")
        self.cast_via_command(update)
        self.assertIn("wades in knee-deep", update.effective_message.reply_text.call_args.args[0])
        self.assertEqual(self.only_cast()["media"], 0)

    def test_the_catch_replaces_the_place_picture_with_its_own(self):
        context = self.cast_via_command(self.update("ru"))
        row = dict(self.only_cast())
        at = row["bite_at"] + 1
        query = SimpleNamespace(data=f"fish:{row['id']}", from_user=SimpleNamespace(id=1), answer=AsyncMock())
        real = fishing.strike
        with patch.object(fishing, "strike", lambda cast_id, user: real(
                cast_id, user, at, rng=Pick("boot", "pond", world.phase(at), None, True))):
            asyncio.run(fishing.fish_callback(SimpleNamespace(callback_query=query), context))
        call = context.bot.edit_message_media.await_args
        self.assertIsInstance(call.kwargs["media"], InputMediaPhoto)
        self.assertIn("Старый ботинок", call.kwargs["media"].caption)
        self.assertEqual(call.kwargs["reply_markup"].inline_keyboard[0][0].callback_data.split(":")[:2], ["fishb", "m"])

    def test_someone_elses_strike_is_refused(self):
        context = self.cast_via_command(self.update("ru"))
        query = SimpleNamespace(data=f"fish:{self.only_cast()['id']}", from_user=SimpleNamespace(id=2), answer=AsyncMock())
        asyncio.run(fishing.fish_callback(SimpleNamespace(callback_query=query), context))
        self.assertIn("That's Angler's cast", query.answer.call_args.args[0])

    def test_a_resting_angler_is_offered_the_drink_and_pouring_it_tells_the_chat(self):
        self.catch("roach", now=int(time.time()) - 60)      # landed a minute ago
        self.equip(energy=1)
        update = self.update("ru")
        self.cast_via_command(update)
        reply = update.effective_message.reply_text.call_args
        self.assertIn("Рыба отдыхает", reply.args[0])
        self.assertEqual(reply.kwargs["reply_markup"].inline_keyboard[0][0].callback_data, "fishpour")
        context = self.context()
        query = SimpleNamespace(data="fishpour", from_user=SimpleNamespace(id=1, full_name="Angler"), answer=AsyncMock())
        asyncio.run(fishing.fish_pour_callback(SimpleNamespace(
            callback_query=query, effective_chat=SimpleNamespace(id=-100, type="supergroup"),
            effective_user=SimpleNamespace(id=1, language_code="ru")), context))
        self.assertIn("выливает энергетик", context.bot.send_message.await_args.kwargs["text"])
        self.cast_via_command(self.update("ru"))
        self.assertEqual(self.only_cast()["status"], "waiting")

    def test_the_bucket_buttons_answer_only_their_owner(self):
        catch = self.catch("roach")
        context = self.context()
        for data in (f"fishb:s:{catch['id']}", "fishb:S:1"):
            query = SimpleNamespace(data=data, from_user=SimpleNamespace(id=2, full_name="Other"),
                                    answer=AsyncMock(), message=None)
            asyncio.run(fishing.fish_bucket_callback(SimpleNamespace(callback_query=query), context))
            self.assertTrue(query.answer.call_args.kwargs.get("show_alert"))
        self.assertEqual(self.status(catch["id"]), "bucket")
        query = SimpleNamespace(data=f"fishb:s:{catch['id']}", from_user=SimpleNamespace(id=1, full_name="Angler"),
                                answer=AsyncMock(), message=None)
        asyncio.run(fishing.fish_bucket_callback(SimpleNamespace(callback_query=query), context))
        self.assertEqual(self.status(catch["id"]), "sold")
        self.assertEqual(fishing.angler(1)["shells"], fishing.shells_for(catch))

    def test_the_chat_language_outranks_the_anglers_app(self):
        language.set_chat_language(-100, "en", 7)
        update = self.update("ru")
        self.cast_via_command(update)
        self.assertIn("wades in knee-deep", update.effective_message.reply_photo.call_args.kwargs["caption"])


if __name__ == "__main__":
    unittest.main()
