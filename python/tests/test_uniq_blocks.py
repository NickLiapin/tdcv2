"""The block dealer, on its own.

A `<switch>` inside a `<uniq>` cuts the rows into blocks by its subject, and each block is
arranged separately. The free columns are dealt across those blocks first, or one block ends up
holding four `a`s while the next holds none and the group runs out of distinct rows far below its
real ceiling.

What the deal must promise, and what these check: the multiset is preserved exactly (so `percent=`
stays exact), every block gets precisely the number of rows it has, and WHICH block each copy
lands in is decided by largest remainder — the same rule the percentages use, so five
implementations cannot disagree about who gets the odd one.
"""

from __future__ import annotations

import pytest

from tdcv2.engine.memory import _deal_across_blocks as deal

# Measured against the reference implementation, not derived by hand.
SHAPES = [
    (["a", "a", "b", "b"], [2, 2], [["a", "b"], ["a", "b"]]),
    (["a", "a", "a", "b"], [2, 2], [["a", "a"], ["a", "b"]]),
    (["x", "x", "x", "y"], [1, 3], [["x"], ["x", "x", "y"]]),
    (["a", "b", "a", "b"], [4], [["a", "a", "b", "b"]]),
    (
        ["p", "q", "r", "p", "q", "r", "p", "q", "r", "p", "q", "r"],
        [5, 4, 3],
        [["p", "p", "q", "q", "r"], ["p", "q", "r", "r"], ["p", "q", "r"]],
    ),
    ([], [0], [[]]),
    (["z", "z", "z"], [0, 3], [[], ["z", "z", "z"]]),
]


@pytest.mark.parametrize(("column", "sizes", "want"), SHAPES)
def test_the_deal_is_the_arrangement_the_reference_makes(column, sizes, want):
    assert deal(column, sizes) == want


@pytest.mark.parametrize(("column", "sizes", "_want"), SHAPES)
def test_every_block_gets_exactly_the_rows_it_has(column, sizes, _want):
    assert [len(b) for b in deal(column, sizes)] == sizes


@pytest.mark.parametrize(("column", "sizes", "_want"), SHAPES)
def test_nothing_is_lost_and_nothing_is_invented(column, sizes, _want):
    dealt = [v for block in deal(column, sizes) for v in block]
    assert sorted(dealt) == sorted(column)


def test_a_value_short_of_a_whole_share_still_lands_somewhere():
    # One `y` against three `x`s over two blocks: `y` is owed 0.25 and 0.75 of a row and gets a
    # whole one, because a value that rounds to nothing everywhere would be dropped.
    assert deal(["x", "x", "x", "y"], [2, 2]) == [["x", "x"], ["x", "y"]]


def test_a_full_block_passes_its_share_on():
    # Block 0 has room for one row and `a` fills it, so both `b`s go to block 1 even though the
    # proportional split would have given block 0 one of them.
    assert deal(["a", "a", "b", "b"], [1, 3]) == [["a"], ["a", "b", "b"]]
