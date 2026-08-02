"""The mask, the filters and the interpolation marker, against the shared formatting cases."""

from __future__ import annotations

import pytest

from tdcv2.format import interpolate
from tdcv2.format.mask import apply_mask
from tdcv2.format.transforms import apply_filter, gen_formatter


@pytest.mark.parametrize(
    ("pattern", "value", "expected"),
    [
        ("xxx-xxx-xxxx", "5551234567", "555-123-4567"),
        ("w[1] w[0]", "John Smith", "Smith John"),
        # The same notation copies rather than moves, because `*` claims the position too.
        ("x[0]. *", "John Smith", "J. ohn Smith"),
        ("x[2..0]", "abcdef", "cba"),
        ("x[9]", "abc", ""),
        ("[tel.] xxx", "5551234", "[tel.] 555"),
        (r"x\[0]", "abc", "a[0]"),
        ("w w", "John Smith", "John Smith"),
    ],
)
def test_the_mask_matches_the_reference(pattern: str, value: str, expected: str) -> None:
    assert apply_mask(pattern, value) == expected


def test_an_index_that_is_not_one_names_the_syntax_it_wanted() -> None:
    with pytest.raises(ValueError, match=r"use x\[0\], x\[0\.\.4\] or x\[-1\]"):
        apply_mask("x[1-2]", "abc")


@pytest.mark.parametrize(
    ("kind", "arg", "value", "expected"),
    [
        ("upper", None, "jOHN mcDONALD", "JOHN MCDONALD"),
        ("lower", None, "jOHN mcDONALD", "john mcdonald"),
        # Only the first letter, so McDonald does not become Mcdonald.
        ("capitalize", None, "jOHN mcDONALD", "JOHN mcDONALD"),
        ("title", None, "jOHN mcDONALD", "JOHN McDONALD"),
        ("slice", "0,3", "1234567890", "123"),
        ("slice", "2", "1234567890", "34567890"),
        ("group", "3", "1234567890", "1 234 567 890"),
        ("group", "4,-", "1234567890", "12-3456-7890"),
        ("compact", None, "1000000", "lfls"),
        ("compact", "16", "1000000", "f4240"),
        ("compact", None, "not a number", "not a number"),
        ("csv", None, "Jr", '"Jr"'),
        ("csv", None, 'say "hi"', '"say ""hi"""'),
        ("sql", None, "O'Brien", "O''Brien"),
        ("trim", None, "  padded  ", "padded"),
        ("replace", "a,b", "banana", "bbnbnb"),
        ("nosuchfilter", None, "untouched", "untouched"),
    ],
)
def test_a_filter_matches_the_reference(
    kind: str, arg: str | None, value: str, expected: str
) -> None:
    assert apply_filter(kind, arg, value) == expected


def test_filters_chain_left_to_right() -> None:
    value = apply_filter("upper", None, "o'brien")
    assert apply_filter("sql", None, value) == "O''BRIEN"


def test_a_gen_applies_its_mask_before_its_case() -> None:
    formatter = gen_formatter("xxx", "upper")
    assert formatter is not None
    assert formatter("abcdef") == "ABC"
    assert gen_formatter(None, None) is None


def test_the_inject_marker_is_configurable() -> None:
    lookup = {"V": "Ann"}.get
    assert interpolate.apply("hi <<V>> and ${{V}}", "<<%>>", lookup) == "hi Ann and ${{V}}"


def test_an_unknown_name_stays_visible_so_a_typo_is_obvious() -> None:
    assert interpolate.apply("${{Gendre}}", "${{%}}", {}.get) == "${{Gendre}}"


def test_an_inject_with_no_slot_substitutes_nothing() -> None:
    assert interpolate.apply("${{V}}", "nopercent", {"V": "Ann"}.get) == "${{V}}"


def test_a_reference_carries_its_filter_chain() -> None:
    name, filters = interpolate.parse_reference("V | upper | mask:xxx ")
    assert name == "V"
    assert [(f.kind, f.arg) for f in filters] == [("upper", None), ("mask", "xxx")]
