"""The free-model pool: what is offered, and what a button carries.

`openrouter/free` is a router over a pool that changes week to week, so the
list of models is read from the provider's catalogue rather than written down.
These tests pin the reading: free is a price and not a name, a provider that
publishes no prices is offered whole rather than as an empty menu, and a button
carries a digest that survives the pool moving under it.

Env is pinned before bot.* imports because bot.config reads it at import time.
"""
import os
import tempfile
import unittest

_TMP = tempfile.mkdtemp(prefix="ai_models_test_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "ai_models_test.sqlite"))

from bot.ai_models import (  # noqa: E402
    Catalogue,
    ModelChoice,
    catalogue_url,
    format_context,
    model_token,
    page_slice,
    parse_catalogue,
    served_note,
)

# One OpenRouter page, trimmed to the fields the menu reads.
OPENROUTER_BODY = {
    "data": [
        {
            "id": "deepseek/deepseek-r1:free",
            "name": "DeepSeek: R1 (free)",
            "context_length": 163840,
            "pricing": {"prompt": "0", "completion": "0"},
        },
        {
            "id": "anthropic/claude-opus-4.8",
            "name": "Anthropic: Claude Opus 4.8",
            "context_length": 200000,
            "pricing": {"prompt": "0.000015", "completion": "0.000075"},
        },
        {
            "id": "nvidia/nemotron-3.5-lightning:free",
            "name": "NVIDIA: Nemotron 3.5 Lightning (free)",
            "context_length": 1000000,
            "pricing": {"prompt": "0.0", "completion": "0.0"},
        },
    ]
}


class CatalogueUrlTests(unittest.TestCase):
    def test_derives_models_endpoint_from_completions(self):
        self.assertEqual(
            catalogue_url("https://openrouter.ai/api/v1/chat/completions"),
            "https://openrouter.ai/api/v1/models",
        )

    def test_derives_from_a_bare_base_url(self):
        self.assertEqual(
            catalogue_url("https://cyberia.church/api/ai/v1/"),
            "https://cyberia.church/api/ai/v1/models",
        )

    def test_override_wins(self):
        self.assertEqual(
            catalogue_url("https://openrouter.ai/api/v1/chat/completions", "https://x/y"),
            "https://x/y",
        )

    def test_no_endpoint_configured_is_empty(self):
        self.assertEqual(catalogue_url(""), "")


class ParseCatalogueTests(unittest.TestCase):
    def test_free_is_a_price_not_a_name(self):
        catalogue = parse_catalogue(OPENROUTER_BODY)
        self.assertTrue(catalogue.priced)
        self.assertEqual(
            sorted(m.id for m in catalogue.selectable()),
            ["deepseek/deepseek-r1:free", "nvidia/nemotron-3.5-lightning:free"],
        )

    def test_unpriced_catalogue_is_offered_whole(self):
        """A gateway that bills nobody per token prices nothing; "no prices"
        must not read as "nothing is free"."""
        catalogue = parse_catalogue(
            {"data": [{"id": "lain-fast"}, {"id": "lain-free"}]}
        )
        self.assertFalse(catalogue.priced)
        self.assertEqual([m.id for m in catalogue.selectable()], ["lain-fast", "lain-free"])

    def test_label_drops_the_redundant_free_suffix(self):
        catalogue = parse_catalogue(OPENROUTER_BODY)
        labels = {m.id: m.label for m in catalogue.models}
        self.assertEqual(labels["deepseek/deepseek-r1:free"], "DeepSeek: R1")

    def test_context_comes_from_top_provider_when_absent(self):
        catalogue = parse_catalogue(
            {"data": [{"id": "x", "top_provider": {"context_length": 8192}}]}
        )
        self.assertEqual(catalogue.models[0].context, 8192)

    def test_junk_rows_and_duplicates_are_dropped(self):
        catalogue = parse_catalogue(
            {"data": [{"id": "a"}, {"id": "a"}, {"no_id": 1}, "nonsense", None]}
        )
        self.assertEqual([m.id for m in catalogue.models], ["a"])

    def test_an_unreadable_body_is_an_empty_catalogue(self):
        self.assertEqual(parse_catalogue(None).models, ())
        self.assertEqual(parse_catalogue({"error": "nope"}).models, ())


class ModalityTests(unittest.TestCase):
    def test_a_music_model_is_not_a_chat_model(self):
        """Free is a price, and the free pool prices music and image models at
        zero too. Neither can answer a question, so neither belongs in a menu
        headed "which model answers you"."""
        catalogue = parse_catalogue(
            {
                "data": [
                    {
                        "id": "google/lyria-3-pro-preview",
                        "pricing": {"prompt": "0", "completion": "0"},
                        "architecture": {"output_modalities": ["text", "audio"]},
                    },
                    {
                        "id": "vision/reader:free",
                        "pricing": {"prompt": "0", "completion": "0"},
                        "architecture": {
                            "input_modalities": ["text", "image"],
                            "output_modalities": ["text"],
                        },
                    },
                ]
            }
        )
        self.assertEqual([m.id for m in catalogue.selectable()], ["vision/reader:free"])

    def test_a_catalogue_without_modalities_is_taken_at_face_value(self):
        catalogue = parse_catalogue({"data": [{"id": "plain", "pricing": {"prompt": "0", "completion": "0"}}]})
        self.assertEqual([m.id for m in catalogue.selectable()], ["plain"])


class PagingTests(unittest.TestCase):
    def items(self, count):
        return [ModelChoice(id=f"m{i}", label=f"M{i}", context=None, free=True) for i in range(count)]

    def test_page_is_clamped_into_range(self):
        items, page, pages = page_slice(self.items(10), page=99, size=4)
        self.assertEqual((page, pages), (2, 3))
        self.assertEqual([m.id for m in items], ["m8", "m9"])

    def test_negative_page_lands_on_the_first(self):
        items, page, pages = page_slice(self.items(10), page=-3, size=4)
        self.assertEqual((page, pages), (0, 3))
        self.assertEqual(len(items), 4)

    def test_empty_pool_still_has_one_page(self):
        items, page, pages = page_slice([], page=0, size=4)
        self.assertEqual((items, page, pages), ([], 0, 1))


class TokenTests(unittest.TestCase):
    def test_token_is_short_enough_for_callback_data(self):
        token = model_token("inclusionai/ling-3.0-flash-sante:free")
        self.assertEqual(len(token), 12)
        self.assertLess(len(f"aim|s|{token}".encode("utf-8")), 64)

    def test_token_is_stable_and_distinct(self):
        self.assertEqual(model_token("a/b:free"), model_token("a/b:free"))
        self.assertNotEqual(model_token("a/b:free"), model_token("a/c:free"))


class ServedNoteTests(unittest.TestCase):
    def test_router_names_who_answered(self):
        self.assertIn("deepseek/deepseek-r1:free", served_note("openrouter/free", "deepseek/deepseek-r1:free"))

    def test_silent_when_the_answer_is_the_model_asked_for(self):
        self.assertEqual(served_note("deepseek/deepseek-r1:free", "deepseek/deepseek-r1:free"), "")
        self.assertEqual(served_note("openrouter/free", ""), "")


class ContextFormatTests(unittest.TestCase):
    def test_thousands_and_millions(self):
        self.assertEqual(format_context(163840), "163k")
        self.assertEqual(format_context(1_000_000), "1M")
        self.assertEqual(format_context(1_500_000), "1.5M")
        self.assertEqual(format_context(None), "")
        self.assertEqual(format_context(512), "512")


class SelectableTests(unittest.TestCase):
    def test_priced_catalogue_with_nothing_free_offers_nothing(self):
        catalogue = Catalogue(
            models=(ModelChoice(id="paid", label="Paid", context=None, free=False),),
            priced=True,
        )
        self.assertEqual(catalogue.selectable(), [])


if __name__ == "__main__":
    unittest.main()
