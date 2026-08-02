"""Stated shares into whole rows, against the vectors every implementation is held to."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tdcv2.distribution.hamilton import counts_per_value, distribute
from tdcv2.distribution.percent_mask import Kind, MaskError, expand
from tdcv2.prng.prng import create

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "cross-language"


def _vectors() -> list[dict]:
    return json.loads((FIXTURES / "hamilton-vectors.json").read_text())["vectors"]


@pytest.mark.parametrize("vector", _vectors(), ids=lambda v: v["name"])
def test_matches_the_shared_vectors(vector: dict) -> None:
    percents = [float(p) for p in vector["percents"]]
    produced = distribute(vector["count"], vector["values"], percents, create(vector["seed"]))
    expected = vector.get("expected") or vector["expectedPrefix"]
    assert produced[: len(expected)] == expected

    if "expectedCounts" in vector:
        counts = counts_per_value(vector["count"], percents, create(vector["seed"]))
        by_value = dict(zip(vector["values"], counts, strict=True))
        assert by_value == vector["expectedCounts"]


def test_shares_always_sum_to_the_count() -> None:
    """The property the whole method exists for: no row is lost to rounding."""
    for count in (7, 13, 100, 999):
        counts = counts_per_value(count, [50.0, 30.0, 20.0], create("sum"))
        assert sum(counts) == count


def test_blank_positions_split_what_is_left() -> None:
    assert expand("50,,", 3) == [50.0, 25.0, 25.0]
    assert expand("60,40", 2) == [60.0, 40.0]
    # A short mask pads on the right; a leading comma anchors the first entry instead.
    assert expand("50", 3) == [50.0, 25.0, 25.0]
    assert expand(",50", 3) == [25.0, 25.0, 50.0]


def test_the_three_ways_a_mask_is_wrong_are_told_apart() -> None:
    """Each calls for a different fix, so each carries its own kind."""
    with pytest.raises(MaskError) as too_many:
        expand("50,30,20", 2)
    assert too_many.value.kind is Kind.LENGTH

    with pytest.raises(MaskError) as not_a_number:
        expand("lots,20", 2)
    assert not_a_number.value.kind is Kind.NUMBER

    with pytest.raises(MaskError) as bad_sum:
        expand("70,50", 2)
    assert bad_sum.value.kind is Kind.SUM
