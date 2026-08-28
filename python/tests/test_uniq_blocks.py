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


def test_leftover_units_are_handed_out_globally_strongest_claim_first():
    # Both values are owed half a row in each block; `a`'s claim on block 0 is walked first
    # (equal remainders, value order), takes the block's one free slot, and `b`'s unit goes to
    # block 1. Assigning per VALUE was tried twice and starved a block both times.
    assert deal(["a", "a", "b", "b"], [1, 3]) == [["a"], ["a", "b", "b"]]


def test_unequal_blocks_do_not_starve_the_last_value():
    # Five values × 5 over blocks [13, 12] — the shape an ODD count cuts. A per-value deal
    # dumped the fifth value [1, 4] and "count 25" was refused saying "at most 24"; the global
    # walk lands every value [3, 2] or [2, 3].
    dealt = deal([f"v{i % 5}" for i in range(25)], [13, 12])
    for v in range(5):
        a = dealt[0].count(f"v{v}")
        b = dealt[1].count(f"v{v}")
        assert a + b == 5
        assert abs(a - b) == 1
