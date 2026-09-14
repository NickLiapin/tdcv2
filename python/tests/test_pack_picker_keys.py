"""The pack picker's key decoder, against the shared vectors.

A terminal cannot say "the user pressed Page Up". It sends bytes — ``ESC``, ``[``, ``5``, ``~`` —
and somebody has to read them back into a name. Three of the five implementations do that by
hand: this one, Java and Rust. TypeScript hands the job to Node's readline and C# to
``Console.ReadKey``, so neither ever sees a raw byte, which is why these vectors are read by
three tests rather than five.

The half worth pinning is not the name but what is LEFT in the stream afterwards. Java and Rust
read on to the closing ``~`` only for the four numbers they recognised, so Delete and Insert
returned ``unknown`` and left their ``~`` unread — and the next turn of the picker's loop took
that ``~`` for a keystroke and typed it into the search box. This decoder got it right by
accident, matching on any digit; it got F5 wrong instead, reading ``ESC[15~`` as Home because it
only ever looked at the first digit.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

from tdcv2.cli.pack_picker import _read_key

FIXTURE = (
    Path(__file__).resolve().parents[2] / "fixtures" / "cross-language" / "pack-picker-keys.json"
)
VECTORS = json.loads(FIXTURE.read_text(encoding="utf-8"))["keys"]


@pytest.mark.parametrize("case", VECTORS, ids=lambda c: c["name"])
def test_names_the_key_a_terminal_sent(case, monkeypatch):
    stream = io.StringIO(case["input"])
    monkeypatch.setattr(sys, "stdin", stream)
    assert _read_key() == case["key"]
    assert stream.read() == case["left"]
