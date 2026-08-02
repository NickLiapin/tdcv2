"""The formatting layer, against the reference's own answers.

Masks and filters are small and full of decisions that are easy to get subtly wrong: which end an
index counts from, whether a range may run backwards, whether an out-of-range index is an error or
a gap. Each has a right answer, and the right answer is the reference's.

This fixture found a real one, in Java rather than here: ``slice:-3`` meant "the last three
characters" in the reference and in Python, and "all of them" there. Nothing else caught it — the
shared case fixtures happen not to use a negative slice, and a filter that returns too much text
still looks like text.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tdcv2.format.transforms import apply_filter

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "cross-language"


def _vectors() -> list[tuple[str, str, str, str]]:
    document = json.loads((FIXTURES / "filter-vectors.json").read_text(encoding="utf-8"))
    assert document["schemaVersion"] == 1
    return [(v["kind"], v["arg"], v["input"], v["expected"]) for v in document["vectors"]]


@pytest.mark.parametrize(("kind", "arg", "value", "expected"), _vectors())
def test_matches_the_reference(kind: str, arg: str, value: str, expected: str) -> None:
    assert apply_filter(kind, arg or None, value) == expected
