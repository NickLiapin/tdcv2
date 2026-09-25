"""How many different strings a regex pattern makes, against the shared fixture.

``uniq="true"`` over a ``type="regex"`` pattern refuses a count the pattern cannot meet before it
draws, and knows the pattern's size by counting its parse tree. That count decides which configs
are refused, so all five implementations are held to one set of numbers — including the
deliberate overcounts, which are the contract rather than a mistake.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tdcv2.generators import advanced_regex
from tdcv2.generators.regex import DEFAULT_MAX_LENGTH, SPACE_CAP, space_size

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "cross-language" / "regex-space.json"
DATA = json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_saturates_at_the_same_ceiling():
    assert DATA["cap"] == SPACE_CAP


@pytest.mark.parametrize("case", DATA["patterns"], ids=lambda c: c["pattern"])
def test_counts_the_space_the_reference_counts(case):
    assert space_size(case["pattern"], DEFAULT_MAX_LENGTH) == case["size"], case["why"]


@pytest.mark.parametrize("case", DATA["advanced"], ids=lambda c: c["pattern"])
def test_counts_an_advanced_pattern_the_way_the_reference_does(case):
    assert advanced_regex.space_size(case["pattern"], DEFAULT_MAX_LENGTH) == case["size"], case[
        "why"
    ]
