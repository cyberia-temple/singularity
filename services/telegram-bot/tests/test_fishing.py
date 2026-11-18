"""🎣 fishing: the cast as durable state, and the queue that turns a fish into an NFT.

A cast is `waiting → biting → caught | escaped`, and whatever order the strike
and the escape timer arrive in, exactly one outcome is written. The NFT queue
is driven against a fake chain that only does what a node can: hand back a
receipt, no receipt yet, or an error — and every test asks the same question
of it: did each fish reach its angler's wallet exactly once?
"""
import asyncio
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from sqlalchemy import create_engine, text
from web3.exceptions import Web3RPCError

from bot import db, fish_art, fishing, stakes

WALLET = "0x00000000000000000000000000000000000000A1"


class Fixed:
    """An RNG that lands on one rarity: `pick` is the draw out of TOTAL_ODDS."""

    def __init__(self, pick, size=0.5):
        self.pick, self.size = pick, size

    def randrange(self, n):
        return self.pick

    def choice(self, options):
        return options[0]

    def random(self):
        return self.size

    def getrandbits(self, bits):
        return 7

    def uniform(self, low, high):
        return low


TRASH = Fixed(0)
COMMON = Fixed(270)                 # first draw past the 270 of trash
LEGENDARY = Fixed(fishing.TOTAL_ODDS - 1)


class CatalogueTests(unittest.TestCase):
    def test_every_rarity_but_trash_has_fish_and_the_odds_add_up(self):
        self.assertEqual(fishing.TOTAL_ODDS, 1000)
        for rarity in fishing.RARITIES:
            fish = [key for key, item in fishing.SPECIES.items() if item["rarity"] == rarity]
            self.assertEqual(bool(fish), rarity != "trash", rarity)

    def test_a_roll_lands_on_the_rarity_its_draw_falls_in(self):
        self.assertEqual(fishing.roll(TRASH)["rarity"], "trash")
        self.assertEqual(fishing.roll(Fixed(269))["rarity"], "trash")
        self.assertEqual(fishing.roll(COMMON)["rarity"], "common")
        self.assertEqual(fishing.roll(LEGENDARY)["rarity"], "legendary")

    def test_weights_stay_inside_the_species_range_and_trophies_are_the_top(self):
        for size in (0.0, 0.5, 0.89, 0.9, 0.999):
            catch = fishing.roll(Fixed(270, size))
            low, high = fishing.SPECIES[catch["species"]]["kg"]
            self.assertTrue(low * 1000 <= catch["grams"] <= high * 1000)
            self.assertEqual(catch["trophy"], int(size >= 0.9))

    def test_weight_reads_in_grams_then_kilograms(self):
        self.assertEqual(fishing.weight(350), "350 г")
        self.assertEqual(fishing.weight(4210), "4,21 кг")
        self.assertEqual(fishing.weight(2000), "2 кг")


class PictureTests(unittest.TestCase):
    def catch(self, seed):
        return {"species": "pike", "rarity": "uncommon", "grams": 6000, "seed": seed}

    def test_the_picture_is_a_512px_png_and_the_same_fish_draws_the_same(self):
        image = fishing.picture(self.catch(5))
        self.assertTrue(image.startswith(b"\x89PNG\r\n\x1a\n"))
        width, height = struct.unpack(">II", image[16:24])
        self.assertEqual((width, height), (fish_art.SIZE * fish_art.SCALE,) * 2)
        self.assertEqual(image, fishing.picture(self.catch(5)))
        self.assertNotEqual(image, fishing.picture(self.catch(6)))

    def test_every_species_draws(self):
        for key, fish in fishing.SPECIES.items():
            image = fishing.picture({"species": key, "rarity": fish["rarity"],
                                     "grams": int(fish["kg"][1] * 1000), "seed": 1})
            idat = image.index(b"IDAT")
            length = struct.unpack(">I", image[idat - 4:idat])[0]
            raw = zlib.decompress(image[idat + 4:idat + 4 + length])
            self.assertEqual(len(raw), fish_art.SIZE * fish_art.SCALE * (1 + 3 * fish_art.SIZE * fish_art.SCALE))


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

    def hooked(self, rng=COMMON, user=1, chat=-100, now=1000):
        """Cast, let it bite, strike a second later: the catch."""
        cast_id, delay = fishing.cast(chat, user, "Angler", now=now, rng=rng)
        fishing.bite(cast_id, now + delay)
        return fishing.strike(cast_id, user, now + delay + 1, rng=rng)[1]

    def link(self, user=1, address=WALLET):
        with self.engine.begin() as conn:
            conn.execute(text("INSERT INTO tg_wallets(user_id,address) VALUES(:u,:a)"), {"u": user, "a": address})

    def status(self, catch_id):
        return fishing.get_catch(catch_id)["nft_status"]

    def equip(self, gear, user=1, shells=0):
        with self.engine.begin() as conn:
            conn.execute(text("INSERT OR REPLACE INTO fishing_anglers(user_id,shells,gear) VALUES(:u,:s,:g)"),
                         {"u": user, "s": shells, "g": gear})


class CastTests(FishingCase):
    def test_a_strike_in_time_lands_a_fish_queued_for_its_nft(self):
        catch = self.hooked(COMMON)
        self.assertEqual(catch["rarity"], "common")
        self.assertEqual(catch["nft_status"], "pending")
        self.assertEqual(fishing.get_cast(catch["cast_id"])["status"], "caught")

    def test_trash_is_landed_but_never_minted(self):
        catch = self.hooked(TRASH)
        self.assertEqual(catch["nft_status"], "none")

    def test_the_float_must_bite_before_a_strike_counts(self):
        cast_id, delay = fishing.cast(-100, 1, "Angler", now=1000)
        with self.assertRaises(ValueError) as early:
            fishing.strike(cast_id, 1, 1000 + delay - 0.5, rng=COMMON)
        self.assertIn("Ещё не клюёт", str(early.exception))

    def test_only_the_angler_can_strike(self):
        cast_id, delay = fishing.cast(-100, 1, "Angler", now=1000)
        fishing.bite(cast_id, 1000 + delay)
        with self.assertRaises(ValueError) as other:
            fishing.strike(cast_id, 2, 1000 + delay + 1, rng=COMMON)
        self.assertIn("Это заброс Angler", str(other.exception))
        self.assertIsNotNone(fishing.strike(cast_id, 1, 1000 + delay + 1, rng=COMMON)[1])

    def test_a_late_strike_lets_it_go_with_only_a_short_rest(self):
        cast_id, delay = fishing.cast(-100, 1, "Angler", now=1000)
        fishing.bite(cast_id, 1000 + delay)
        late = 1000 + delay + fishing.GEAR["hands"]["window"] + 0.1
        row, catch = fishing.strike(cast_id, 1, late, rng=COMMON)
        self.assertIsNone(catch)
        self.assertEqual(row["status"], "escaped")
        self.assertEqual(fishing.get_cast(cast_id)["ready_at"], int(late) + fishing.MISS_COOLDOWN)

    def test_the_escape_timer_and_a_strike_settle_one_outcome(self):
        cast_id, delay = fishing.cast(-100, 1, "Angler", now=1000)
        fishing.bite(cast_id, 1000 + delay)
        self.assertFalse(fishing.escape(cast_id, 1000 + delay + 1))   # still inside the window
        fishing.strike(cast_id, 1, 1000 + delay + 2, rng=COMMON)
        self.assertFalse(fishing.escape(cast_id, 1000 + delay + 60))  # caught stays caught
        with self.assertRaises(ValueError):
            fishing.strike(cast_id, 1, 1000 + delay + 3, rng=COMMON)  # and is not caught twice
        with self.engine.connect() as conn:
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM fishing_catches")).scalar_one(), 1)

    def test_one_line_in_the_water_per_account_across_chats(self):
        fishing.cast(-100, 1, "Angler", now=1000)
        with self.assertRaises(ValueError) as busy:
            fishing.cast(-200, 1, "Angler", now=1001)
        self.assertIn("уже рыбачите", str(busy.exception))
        fishing.cast(-100, 2, "Other", now=1001)  # someone else is free to fish

    def test_a_fish_earns_the_long_rest_and_trash_the_short_one(self):
        self.hooked(COMMON, now=1000)
        with self.assertRaises(ValueError) as resting:
            fishing.cast(-200, 1, "Angler", now=1100)
        self.assertIn("Рыба отдыхает", str(resting.exception))
        fishing.cast(-200, 1, "Angler", now=1000 + fishing.COOLDOWN + 20)

        self.hooked(TRASH, user=2, now=1000)            # bites at +3, struck at +4
        fishing.cast(-100, 2, "Other", now=1000 + 4 + fishing.MISS_COOLDOWN)

    def test_a_forgotten_cast_is_lost_and_owes_no_rest(self):
        cast_id, _ = fishing.cast(-100, 1, "Angler", now=1000)
        swept = fishing.sweep(1000 + fishing.STUCK)
        self.assertEqual([row["id"] for row in swept], [cast_id])
        self.assertEqual(fishing.get_cast(cast_id)["status"], "lost")
        fishing.cast(-100, 1, "Angler", now=1000 + fishing.STUCK + 1)


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

    def pin(self, catch):
        self.pinned.append(catch["id"])
        return f"ipfs://fish-{catch['id']}"

    def step(self, now=5000):
        return fishing.advance(self.chain, pin=self.pin, now=now)

    def test_a_fish_waits_for_a_wallet_then_mints_and_reaches_it_once(self):
        catch = self.hooked(COMMON)
        self.assertEqual(self.step(), ([], False))       # no wallet: nothing signed
        self.assertEqual(self.chain.signed, [])

        self.link()
        self.assertEqual(self.step(), ([], True))
        self.assertEqual(self.status(catch["id"]), "minting")
        self.chain.mine()
        self.step()                                      # minted → transfer sent
        self.assertEqual(self.status(catch["id"]), "sending")
        self.chain.mine()
        delivered, busy = self.step()
        self.assertEqual((delivered, busy), ([catch["id"]], False))

        row = fishing.get_catch(catch["id"])
        self.assertEqual((row["token_id"], row["recipient"], row["token_uri"]), (401, WALLET, f"ipfs://fish-{catch['id']}"))
        self.assertEqual(self.chain.signed, [("mint", f"ipfs://fish-{catch['id']}"), ("transfer", 401, WALLET)])
        self.step()
        self.assertEqual(len(self.chain.signed), 2)      # nothing more once delivered

    def test_trash_never_reaches_the_chain(self):
        self.link()
        self.hooked(TRASH)
        self.step()
        self.assertEqual(self.chain.signed, [])

    def test_a_refused_broadcast_is_retried_with_the_same_pin_then_given_up(self):
        self.link()
        catch = self.hooked(COMMON)
        self.chain.refuse = Web3RPCError("nonce too low")
        for attempt in range(1, fishing.MAX_ATTEMPTS):
            self.step()
            row = fishing.get_catch(catch["id"])
            self.assertEqual((row["nft_status"], row["attempts"]), ("pending", attempt))
        self.step()
        self.assertEqual(self.status(catch["id"]), "failed")
        self.assertEqual(self.pinned, [catch["id"]])     # pinned once, reused on every retry

    def test_an_unclear_broadcast_waits_for_its_receipt_instead_of_minting_again(self):
        self.link()
        catch = self.hooked(COMMON)
        self.chain.refuse = TimeoutError("read timed out")
        self.step()
        self.assertEqual(self.status(catch["id"]), "minting")
        self.chain.refuse = None
        self.step(now=5100)
        self.assertEqual(sum(1 for item in self.chain.signed if item[0] == "mint"), 1)

        # It did reach the node after all: the receipt settles it.
        tx = fishing.get_catch(catch["id"])["mint_tx"]
        self.chain.receipts[tx] = (True, 777)
        self.step(now=5200)
        self.assertEqual(fishing.get_catch(catch["id"])["token_id"], 777)

    def test_a_transaction_with_no_receipt_for_too_long_is_sent_again(self):
        self.link()
        catch = self.hooked(COMMON)
        self.step(now=5000)
        self.chain.pool.clear()                          # the node dropped it
        self.step(now=5000 + fishing.DROPPED_AFTER - 1)
        self.assertEqual(self.status(catch["id"]), "minting")
        first = fishing.get_catch(catch["id"])["mint_tx"]
        self.step(now=5000 + fishing.DROPPED_AFTER + 1)  # given up on, and signed afresh
        row = fishing.get_catch(catch["id"])
        self.assertEqual((row["nft_status"], row["attempts"]), ("minting", 1))
        self.assertNotEqual(row["mint_tx"], first)
        self.assertEqual(self.pinned, [catch["id"]])

    def test_a_reverted_transfer_keeps_the_token_and_tries_again(self):
        self.link()
        catch = self.hooked(COMMON)
        self.step()
        self.chain.mine()
        self.step()
        self.chain.mine(succeed=False)
        self.step()
        row = fishing.get_catch(catch["id"])
        self.assertEqual((row["nft_status"], row["token_id"], row["attempts"]), ("sending", 401, 1))
        self.assertEqual([item[0] for item in self.chain.signed], ["mint", "transfer", "transfer"])


class MessageTests(FishingCase):
    def test_the_card_tells_a_walletless_angler_how_to_get_the_nft(self):
        catch = self.hooked(COMMON)
        card = fishing.caption(catch, wallet=None, bot_username="cyberia_network_bot", minting=True)
        self.assertIn("/set_wallet", card)
        self.assertIn("@cyberia_network_bot", card)
        linked = fishing.caption(catch, wallet=WALLET, minting=True)
        self.assertIn("Чеканим NFT в кошелёк 0x0000…00A1", linked)

    def test_a_delivered_card_names_its_token_and_links_it(self):
        catch = dict(self.hooked(COMMON), nft_status="delivered", token_id=401, recipient=WALLET)
        self.assertIn("NFT #401", fishing.caption(catch, minting=True))
        button = fishing.nft_markup(catch).inline_keyboard[0][0]
        self.assertTrue(button.url.endswith("/instance/401"))

    def test_metadata_names_the_fish_and_not_the_angler(self):
        catch = self.hooked(COMMON)
        meta = fishing.metadata(catch, "ipfs://image")
        self.assertEqual(meta["image"], "ipfs://image")
        self.assertNotIn("Angler", str(meta))
        traits = {item["trait_type"]: item["value"] for item in meta["attributes"]}
        self.assertEqual(traits["Rarity"], "common")
        self.assertEqual(traits["Weight (g)"], catch["grams"])

    def test_bag_and_top_rank_by_rarity_then_weight(self):
        self.equip("wired")
        self.hooked(COMMON, now=1000)
        self.hooked(LEGENDARY, now=1000 + fishing.COOLDOWN + 10)
        self.assertIn("1. ★★★★★", fishing.bag(1, "Angler"))
        self.assertIn("Ждут кошелька: 2", fishing.bag(1, "Angler"))
        self.assertIn("1. ★★★★★", fishing.top(-100))
        self.assertIn("пусто", fishing.bag(99))


class TackleTests(FishingCase):
    def test_bare_hands_hold_only_common_fish_and_say_what_got_away(self):
        cast_id, delay = fishing.cast(-100, 1, "Angler", now=1000, rng=LEGENDARY)
        fishing.bite(cast_id, 1000 + delay)
        row, catch = fishing.strike(cast_id, 1, 1000 + delay + 1, rng=LEGENDARY)
        self.assertIsNone(catch)
        self.assertEqual(row["got_away"]["rarity"], "legendary")
        self.assertEqual(fishing.get_cast(cast_id)["status"], "escaped")
        self.assertEqual(fishing.angler(1), {"shells": 0, "gear": "hands"})
        text_ru = fishing.too_big_text("Angler", "hands", row["got_away"], "ru")
        self.assertIn("Голыми руками", text_ru)
        self.assertIn("/fish_shop", text_ru)
        with self.engine.connect() as conn:
            self.assertEqual(conn.execute(text("SELECT COUNT(*) FROM fishing_catches")).scalar_one(), 0)
        # A miss, not a fish: only the short rest.
        fishing.cast(-100, 1, "Angler", now=int(1000 + delay + 1) + fishing.MISS_COOLDOWN)

    def test_each_rod_up_the_ladder_holds_one_rarity_more_and_the_wired_rod_holds_all(self):
        self.assertEqual([fishing.GEAR[key]["holds"] for key in fishing.LADDER],
                         ["common", "uncommon", "rare", "epic", "legendary"])
        self.assertEqual(fishing.first_gear_for("trash"), "hands")
        self.assertEqual(fishing.first_gear_for("legendary"), "wired")
        self.equip("wired")
        self.assertEqual(self.hooked(LEGENDARY)["rarity"], "legendary")

    def test_a_landing_pays_shells_trash_too_and_a_trophy_double(self):
        self.hooked(TRASH, now=1000)
        self.assertEqual(fishing.angler(1)["shells"], fishing.SHELLS["trash"])
        self.hooked(Fixed(270, size=0.95), now=2000)       # a trophy common fish
        self.assertEqual(fishing.angler(1)["shells"], fishing.SHELLS["trash"] + 2 * fishing.SHELLS["common"])

    def test_shells_buy_the_next_rod_and_never_more_than_they_cover(self):
        self.equip("hands", shells=fishing.GEAR["hazel"]["price"] - 1)
        with self.assertRaises(ValueError) as short:
            fishing.buy(1, "hazel")
        self.assertIn("Не хватает ракушек", str(short.exception))
        self.equip("hands", shells=fishing.GEAR["hazel"]["price"] + 2)
        self.assertEqual(fishing.buy(1, "hazel"), {"shells": 2, "gear": "hazel"})
        with self.assertRaises(ValueError):
            fishing.buy(1, "hazel")                       # already has it
        with self.assertRaises(ValueError):
            fishing.buy(1, "hands")

    def test_the_cast_keeps_the_tackle_it_was_made_with(self):
        cast_id, delay = fishing.cast(-100, 1, "Angler", now=1000, rng=COMMON)
        self.equip("hazel")                                # bought while the line is in
        fishing.bite(cast_id, 1000 + delay)
        late_for_hands = 1000 + delay + fishing.GEAR["hands"]["window"] + 1
        self.assertLess(late_for_hands - 1000 - delay, fishing.GEAR["hazel"]["window"])
        self.assertIsNone(fishing.strike(cast_id, 1, late_for_hands, rng=COMMON)[1])

    def test_anglers_from_before_shells_are_paid_for_their_catches_once(self):
        self.hooked(COMMON, now=1000)
        with self.engine.begin() as conn:
            conn.execute(text("DELETE FROM fishing_anglers"))
        fishing.ensure_schema()
        fishing.ensure_schema()
        self.assertEqual(fishing.angler(1), {"shells": fishing.SHELLS["common"], "gear": "hands"})

    def test_the_shop_offers_only_rods_above_your_own(self):
        self.equip("hazel", shells=5)
        body, markup = fishing.shop(1, "Angler", "en")
        self.assertIn("Angler: 🌿 hazel rod · 🐚 5", body)
        offered = [row[0].callback_data for row in markup.inline_keyboard]
        self.assertEqual(offered, ["fishshop:bamboo", "fishshop:carbon", "fishshop:wired"])


class LanguageTests(FishingCase):
    def test_a_cast_in_english_lands_an_english_card(self):
        cast_id, delay = fishing.cast(-100, 1, "Angler", now=1000, rng=COMMON, lang="en")
        fishing.bite(cast_id, 1000 + delay)
        catch = fishing.strike(cast_id, 1, 1000 + delay + 1, rng=COMMON)[1]
        card = fishing.caption(catch, wallet=WALLET, minting=True)
        self.assertIn("✋ Catch — Angler", card)
        self.assertIn("Minting the NFT to 0x0000…00A1", card)
        self.assertIn("Next cast in", card)
        self.assertEqual(fishing.weight(4210, "en"), "4.21 kg")

    def test_rows_from_before_the_choice_stay_russian(self):
        self.assertEqual(fishing._lang({"lang": None}), "ru")
        self.assertIn("Леска оборвалась", fishing.lost_text({"lang": None, "gear": None}))


class HandlerTests(FishingCase):
    def update(self, language_code=None, chat_type="supergroup"):
        sent = SimpleNamespace(message_id=55)
        message = SimpleNamespace(message_id=50, sender_chat=None, reply_text=AsyncMock(return_value=sent))
        return SimpleNamespace(
            effective_chat=SimpleNamespace(id=-100, type=chat_type),
            effective_user=SimpleNamespace(id=1, is_bot=False, full_name="Angler", language_code=language_code),
            effective_message=message,
        )

    def cast_via_command(self, update):
        context = SimpleNamespace(args=[], bot=SimpleNamespace(), application=None)
        with patch.object(fishing, "_detach") as detach:
            asyncio.run(fishing.fish_command(update, context))
        detach.call_args.args[1].close()                 # the float task is not under test here
        return context

    def test_a_cast_posts_the_line_and_someone_elses_strike_is_refused(self):
        update = self.update("ru")
        context = self.cast_via_command(update)
        self.assertIn("заходит в воду", update.effective_message.reply_text.call_args.args[0])

        with self.engine.connect() as conn:
            cast = conn.execute(text("SELECT * FROM fishing_casts")).mappings().one()
        self.assertEqual((cast["message_id"], cast["command_message_id"], cast["gear"], cast["lang"]),
                         (55, 50, "hands", "ru"))

        query = SimpleNamespace(data=f"fish:{cast['id']}", from_user=SimpleNamespace(id=2), answer=AsyncMock())
        asyncio.run(fishing.fish_callback(SimpleNamespace(callback_query=query), context))
        self.assertIn("That's Angler's cast", query.answer.call_args.args[0])
        self.assertTrue(query.answer.call_args.kwargs["show_alert"])

    def test_the_chat_language_outranks_the_anglers_app(self):
        from bot import language

        language.set_chat_language(-100, "en", 7)
        update = self.update("ru")
        self.cast_via_command(update)
        self.assertIn("wades in knee-deep", update.effective_message.reply_text.call_args.args[0])

    def test_with_a_rod_the_cast_says_so(self):
        self.equip("bamboo")
        update = self.update("ru")
        self.cast_via_command(update)
        self.assertIn("закидывает бамбуковую удочку", update.effective_message.reply_text.call_args.args[0])


if __name__ == "__main__":
    unittest.main()
