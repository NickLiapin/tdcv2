"""The Dremel core: rows of lists turned into the three flat streams Parquet actually stores.

Parquet keeps no brackets. A list column is the leaf values laid end to end, plus two integer
streams that let a reader rebuild the shape. A repetition level of 0 starts a new record and 1
continues the current list; a definition level says how deep the value actually exists, which is
how an empty list and a missing element are expressed without any value at all.

The schema here has exactly one level of repetition, so the maximum repetition level is 1 and the
maximum definition level is 1 for a required element or 2 for an optional one. The outer group is
REQUIRED because "no list at all" is not a state this can produce — an empty cell is an empty list
— and declaring it optional would spend a level on something never emitted.

Kept apart from the writer so it can be checked against levels worked out by hand. Getting these
two streams wrong produces a file that readers accept and then reassemble incorrectly, which is the
worst failure available.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class Built:
    """The elements that are present, and the two level streams describing their shape."""

    present: list[str]
    rep_levels: list[int]
    def_levels: list[int]
    max_def: int
    max_rep: int


def max_def(element_nullable: bool) -> int:
    """The maximum definition level for a list whose element is, or is not, nullable."""
    return 2 if element_nullable else 1


def bit_width(max_level: int) -> int:
    """Bits needed to hold levels up to ``max_level``; zero when there is nothing to say."""
    bits = 0
    while (1 << bits) <= max_level:
        bits += 1
    return bits


def build(rows: list[list[str]], element_nullable: bool) -> Built:
    """The value, repetition and definition streams for one list column.

    An element is NULL when its text is empty AND the element type is nullable — the same rule the
    scalar path uses, so ``missing=`` behaves identically whether or not the column repeats. When
    the element is not nullable an empty string is a legitimate empty value and is passed on to
    conversion, which refuses it if the type cannot hold it.
    """
    deepest = max_def(element_nullable)
    present: list[str] = []
    rep_levels: list[int] = []
    def_levels: list[int] = []

    for row in rows:
        if not row:
            # An empty list still occupies one level slot; definition 0 IS the statement "this row
            # has no elements". Without it the row would vanish entirely.
            rep_levels.append(0)
            def_levels.append(0)
            continue
        for k, text in enumerate(row):
            rep_levels.append(0 if k == 0 else 1)
            if element_nullable and text == "":
                def_levels.append(deepest - 1)  # the slot exists, the value does not
                continue
            def_levels.append(deepest)
            present.append(text)

    return Built(present, rep_levels, def_levels, deepest, 1)
