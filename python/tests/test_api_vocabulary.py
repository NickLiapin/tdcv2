"""The object a finished run hands back answers to the SAME names in all five implementations.

There was no guard on this surface and it drifted: Python had no ``to_string``, Java no
``toArray``, C# neither ``GetAt`` nor ``Iterate``, Rust neither ``to_array`` nor ``get_at``.
Each was reasonable in its own language and wrong for a reader crossing between them — which
is the only way this library is ever read, because it exists to be used beside the generator.

The fixture is the vocabulary; this test asks Python to answer to it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tdcv2 import TDC

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "cross-language" / "api.json"
DOC = json.loads(FIXTURE.read_text(encoding="utf-8"))
MEMBERS = DOC["members"]


@pytest.mark.parametrize("member", MEMBERS, ids=[m["python"] for m in MEMBERS])
def test_the_shared_name_exists(member: dict) -> None:
    tdc = TDC(config_string=DOC["config"])
    name = member["python"]
    assert hasattr(tdc, name), f'{name} — {member["concept"]}'
    # A property is as good as a method here: the vocabulary is about the NAME a reader
    # reaches for, and `count` is Pythonic as a property while `to_array` is not.
    on_class = getattr(type(tdc), name, None)
    assert callable(getattr(tdc, name)) or isinstance(on_class, property)


def test_the_vocabulary_is_not_empty() -> None:
    """A fixture that says nothing would let every name above pass by saying nothing."""
    assert len(MEMBERS) > 5
