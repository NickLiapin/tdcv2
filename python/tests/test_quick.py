"""The quick API: one value, one call, no config.

The values are pinned to the TypeScript implementation's, not merely to
themselves. That is the point of the feature existing here at all — a name in a
Python unit test and a name in a TypeScript fixture should come from the same
list, in the same order, under the same seed. The constants below were taken by
running `tdc.seed('demo').locale('en')` against the published npm package.
"""

from __future__ import annotations

import json
from functools import reduce
from pathlib import Path

import pytest

from tdcv2 import TdcQuickError, tdc
from tdcv2.packs import DataPacks
from tdcv2.quick import RESERVED_PATH_NAMES, RESERVED_ROOT_NAMES
from tdcv2.quick.draw import BATCH_ROWS, QuickDraw


@pytest.fixture
def demo():
    return tdc.seed("demo").locale("en")


class TestValues:
    def test_agrees_with_the_typescript_implementation(self, demo) -> None:
        assert demo.person.lastName() == "Jones"
        assert demo.person.male.firstName() == "Robert"
        assert demo.company.industry() == "Pharmaceuticals"
        assert demo.common.id.uuid() == "3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9"
        assert demo.common.finance.iban() == "DE62299399441396459682"
        assert demo.country.usa.docs.ssn() == "699209702"

    def test_a_call_takes_the_next_value_rather_than_rerendering_row_one(self, demo) -> None:
        # The bug this prevents: a call that means "render one row" returns the
        # same value forever, so a loop of calls produces one name repeated.
        first = [demo.person.lastName() for _ in range(5)]
        assert first == ["Jones", "Bush", "Armstrong", "Andrews", "Jimenez"]

    def test_many_is_the_same_stream_as_repeated_calls(self) -> None:
        assert tdc.seed("demo").locale("en").person.lastName.many(5) == [
            "Jones",
            "Bush",
            "Armstrong",
            "Andrews",
            "Jimenez",
        ]

    def test_addresses_draw_independently_of_each_other(self, demo) -> None:
        # Two addresses are two streams: reading one must not advance the other.
        demo.company.industry()
        demo.company.industry()
        assert demo.person.lastName() == "Jones"

    def test_the_stream_continues_past_one_batch(self) -> None:
        # BATCH_ROWS values come from one underlying run; the next batch reopens
        # under a derived seed. That boundary is where two implementations drift,
        # so these four straddle it and are pinned to the TypeScript output.
        many = tdc.seed("batch").locale("en").person.lastName.many(BATCH_ROWS + 88)
        assert len(many) == BATCH_ROWS + 88
        assert many[510:514] == ["Nguyen", "Miller", "Gilbert", "Reyes"]

    def test_a_different_seed_gives_different_values(self) -> None:
        assert tdc.seed("other").locale("en").person.lastName() != "Jones"

    def test_seed_and_locale_return_a_new_object(self) -> None:
        # Two tests must be able to hold two seeds at once without either leaking
        # into the other, and neither may disturb the shared `tdc`.
        one, two = tdc.seed("a").locale("en"), tdc.seed("b").locale("en")
        first_of_one = one.person.lastName()
        assert first_of_one != two.person.lastName()
        # The stream belongs to the OBJECT, not to the seed: `one` has advanced,
        # but a fresh object under the same seed starts from the beginning again.
        assert one.person.lastName() != first_of_one
        assert tdc.seed("a").locale("en").person.lastName() == first_of_one

    def test_the_locale_decides_what_a_bare_address_means(self) -> None:
        # The same address, read against two locales, reaches two lists.
        assert tdc.seed("l").locale("en").person.lastName().isascii()
        assert not tdc.seed("l").locale("ru").person.lastName().isascii()


class TestGen:
    def test_a_bare_string_is_the_value_attribute(self) -> None:
        assert tdc.seed("demo").gen.number("18..80") == "66"

    def test_attributes_can_be_named(self) -> None:
        assert tdc.seed("demo").gen.number(value="18..80") == "66"

    def test_many_works_on_a_generator_too(self) -> None:
        assert tdc.seed("x").gen.number.many(4, "1..1000") == ["332", "591", "349", "665"]


class TestParameters:
    @pytest.mark.xfail(
        reason="pack parameters are a TypeScript-only feature; this port refuses them (TDC015)",
        strict=True,
    )
    def test_a_pack_parameter_reaches_the_generator(self) -> None:
        # `common.internet.email` declares a `domain` sequence in its body, and a
        # caller may override it. TypeScript reads the pack's declared parameter
        # names and lets the attribute through; none of the four ports do, so the
        # SAME CONFIG runs there and is refused here — not only through the quick
        # API but from a .tdc file as well. Written as a failing test rather than
        # left out, so closing the gap flips it green and cannot be forgotten.
        email = tdc.seed("p").locale("en").common.internet.email(domain="example.test")
        assert email.endswith("@example.test")

    def test_the_real_diagnostic_is_not_hidden_behind_an_address_message(self) -> None:
        # The failure above must arrive as what it is. Rewriting every template
        # error into "unknown address" produced `unknown address
        # "common.internet.email". Did you mean "common.internet.email"?`.
        with pytest.raises(Exception) as caught:
            tdc.seed("p").locale("en").common.internet.email(domain="example.test")
        assert "unknown address" not in str(caught.value)
        assert 'does not read "domain"' in str(caught.value)


class TestRefusals:
    def test_a_count_that_is_not_a_positive_whole_number(self) -> None:
        for bad in (0, -1, 1.5, True):
            with pytest.raises(TdcQuickError):
                tdc.seed("c").locale("en").person.lastName.many(bad)

    def test_a_misspelled_address_names_the_nearest_one(self) -> None:
        draw = QuickDraw("e", "en")
        with pytest.raises(TdcQuickError) as caught:
            draw.draw("template", {"value": "usa.docs.sn"}, 1)
        assert 'Did you mean "usa.docs.ssn"' in str(caught.value)

    def test_a_missing_pack_says_so_instead_of_proposing_another_language(self) -> None:
        # A wheel carries common/en/usa; the rest are downloaded. Answering
        # `af.person.lastName` with "did you mean en.person.lastName?" offers
        # English to someone who asked for Afrikaans.
        draw = QuickDraw("m", "en")
        with pytest.raises(TdcQuickError) as caught:
            draw.draw("template", {"value": "af.person.lastName"}, 1)
        message = str(caught.value)
        assert '"af" pack is not installed' in message
        assert "tdcv2 pack add af" in message
        assert "Did you mean" not in message

    def test_a_double_quote_in_a_value(self) -> None:
        with pytest.raises(TdcQuickError):
            tdc.seed("q").gen.text('a"b')


class TestTheObjectItself:
    def test_the_runtime_probing_for_attributes_is_refused(self) -> None:
        # Answering these with a live address makes the object lie about what it
        # is: `copy.deepcopy` and pytest's assertion rewriting both ask.
        for probe in ("__wrapped__", "__deepcopy__", "_ipython_canary_method_should_not_exist_"):
            with pytest.raises(AttributeError):
                getattr(tdc, probe)
            with pytest.raises(AttributeError):
                getattr(tdc.person, probe)

    def test_repr_says_what_it_is(self) -> None:
        assert "quick" in repr(tdc.seed("r"))
        assert "person.lastName" in repr(tdc.person.lastName)

    def test_no_bundled_address_collides_with_a_reserved_name(self) -> None:
        # The API answers to these words, so a pack category called one of them
        # would be unreachable. This is the guard that says so at the moment the
        # pack is added rather than when a user cannot reach it.
        addresses = DataPacks.bundled().addresses()
        roots = {a.split(".", 1)[0] for a in addresses}
        assert roots.isdisjoint(RESERVED_ROOT_NAMES - {"lang", "country"})
        segments = {segment for a in addresses for segment in a.split(".")}
        assert segments.isdisjoint(RESERVED_PATH_NAMES)


class TestSharedVectors:
    """The one file all five implementations answer to.

    The hand-written constants above say what the values are; this says that the
    OTHER FOUR agree, because every implementation reads this same file. It is
    generated from the reference, so a change to the batch size, the derived
    seed, or the synthesised config shows up here in whichever implementation
    made it — rather than in a user's diff six months later.
    """

    VECTORS = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "fixtures"
            / "cross-language"
            / "quick-vectors.json"
        ).read_text(encoding="utf-8")
    )

    def test_the_batch_size_is_the_declared_one(self) -> None:
        assert self.VECTORS["batchRows"] == BATCH_ROWS

    def test_every_address_vector(self) -> None:
        for case in self.VECTORS["addresses"]:
            # Walked with getattr rather than reaching past the public surface:
            # this exercises the same path a caller writes by hand.
            node = reduce(
                getattr,
                case["address"].split("."),
                tdc.seed(case["seed"]).locale(case["locale"]),
            )
            assert node.many(case["count"]) == case["expected"], case["address"]

    def test_every_generator_vector(self) -> None:
        for case in self.VECTORS["generators"]:
            node = getattr(tdc.seed(case["seed"]).gen, case["type"])
            assert node.many(case["count"], **case["attrs"]) == case["expected"], case["type"]
