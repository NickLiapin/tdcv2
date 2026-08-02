"""The generator every value in the product comes out of, checked digit for digit.

These numbers are not an implementation detail — they are the product's promise. A config and a
seed produce one dataset, in whichever language happens to be running. Everything else here can
be refactored freely; this file decides whether that sentence is true.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tdcv2.prng import permute, seekable
from tdcv2.prng.prng import create, cyrb128

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "cross-language"


def _vectors() -> list[dict]:
    return json.loads((FIXTURES / "prng-vectors.json").read_text())["vectors"]


@pytest.mark.parametrize("vector", _vectors(), ids=lambda v: repr(v["seed"]))
def test_matches_the_shared_vectors(vector: dict) -> None:
    generator = create(vector["seed"])
    produced = [generator.next() for _ in range(len(vector["values"]))]
    assert produced == vector["values"]


def test_seed_is_hashed_as_utf16_code_units() -> None:
    """A character outside the Basic Multilingual Plane is two units, not one.

    Python iterates code points and the other two languages iterate UTF-16 units. Hashing the
    code point would give a different generator for such a seed — rare, and permanently wrong
    once someone's seed contains an emoji.
    """
    # U+1F600 is one code point and the surrogate pair D83D DE00.
    assert cyrb128("\U0001f600") == cyrb128("😀")


def test_seekable_draws_depend_on_the_row_and_nothing_else() -> None:
    assert f"{seekable.next_value('s', 'col', 0):.12f}" == "0.395373520209"
    assert f"{seekable.next_value('s', 'col', 1):.12f}" == "0.622989792144"
    assert f"{seekable.next_value('s', 'col', 7):.12f}" == "0.171570741571"

    assert [seekable.next_int("s", "col", i, 10) for i in (0, 1, 2, 7, 99)] == [3, 6, 0, 1, 1]

    drawn = seekable.uniforms("s", "col", 3, 3)
    assert [f"{u:.12f}" for u in drawn] == [
        "0.216913319775",
        "0.496834229794",
        "0.946410457720",
    ]


def test_permutation_matches_the_other_implementations() -> None:
    key = permute.key("s", "col")
    assert key == 968748470
    assert [permute.permute(i, 7, key) for i in range(5)] == [0, 2, 1, 6, 5]
    assert [permute.permute(i, 100, key) for i in range(5)] == [27, 29, 80, 78, 0]
    assert [permute.permute(i, 1000, key) for i in range(5)] == [887, 349, 633, 904, 5]


@pytest.mark.parametrize("n", [1, 2, 7, 64, 100, 999, 1024])
def test_permutation_is_a_bijection(n: int) -> None:
    """The property the whole design rests on.

    If two rows shared a slot, an exact quota would be over-filled in one place and short in
    another — and no single row would look wrong.
    """
    key = permute.key("run", "column")
    slots = [permute.permute(i, n, key) for i in range(n)]
    assert sorted(slots) == list(range(n))
    assert all(permute.unpermute(slot, n, key) == i for i, slot in enumerate(slots))
