"""The fingerprint repair against the text repair — same table, or no deal.

Engine 3 changes the CARRIER when a run is large: 13-byte hashes routed into piles, each pile
sorted as raw bytes, groups sharing a hash treated as candidates. Which rows collide and where
they move must not change with the carrier. These cases run the same columns through both paths
and compare every row.

None of this had a test in this port, and it could not have had one: the carrier switches at a
MILLION rows, and no suite renders a million rows. So ``repair`` takes the pile count instead of
working it out — the same knob the reference has always had — and these run at a few thousand.

The one place the two may legitimately differ is a real 64-bit hash collision, whose odds at these
sizes are nil; equality is asserted outright.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest

from tdcv2.engine.exact_uniq import JOIN, _verify, repair

Resolver = Callable[[int], str]


def column(values: list[str], stride: int) -> Resolver:
    """A column that cycles through ``values``, holding each for ``stride`` rows."""
    return lambda row: values[(row // stride) % len(values)]


def many(n: int, prefix: str) -> list[str]:
    return [f"{prefix}{i}" for i in range(n)]


def rows_of(built: dict[str, Resolver], ids: list[str], count: int) -> list[str]:
    return ["|".join(built[name](row) for name in ids) for row in range(count)]


def duplicate_count(resolvers: list[Resolver], count: int) -> int:
    seen: set[str] = set()
    duplicates = 0
    for row in range(count):
        key = JOIN.join(resolver(row) for resolver in resolvers)
        if key in seen:
            duplicates += 1
        seen.add(key)
    return duplicates


CASES = [
    (
        "a wide column and a narrow one, hundreds of collisions",
        3000,
        ["A", "B"],
        [column(many(200, "a"), 1), column(many(25, "b"), 11)],
    ),
    (
        "three columns, collisions in quantity",
        2000,
        ["A", "B", "C"],
        [column(many(50, "a"), 1), column(many(20, "b"), 13), column(many(6, "c"), 29)],
    ),
    (
        "two columns drawing from one list",
        1500,
        ["A", "B"],
        [column(many(60, "v"), 1), column(many(60, "v"), 11)],
    ),
]


@pytest.mark.parametrize(("name", "count", "ids", "columns"), CASES)
def test_the_carrier_does_not_change_the_answer(name, count, ids, columns):
    label = '"' + " × ".join(ids) + '"'
    assert duplicate_count(columns, count) > 0, (
        f"{name}: nothing to repair, so the case proves nothing"
    )

    text = rows_of(repair(ids, columns, count, label), ids, count)
    assert len(set(text)) == count, f"{name}: the text repair left a duplicate"

    for buckets in (2, 8, 32):
        printed = rows_of(
            repair(ids, columns, count, label, fingerprint_buckets=buckets), ids, count
        )
        assert printed == text, f"{name}: {buckets} piles produced a different table"


def test_a_hash_collision_between_different_tuples_never_becomes_a_duplicate():
    # Pinned directly, because at these sizes a real 64-bit collision does not happen — turn
    # verification off entirely and every comparison above still passes. Only a FORGED candidate
    # group can fail this: rows whose tuples differ, handed over as if their hashes had matched.
    resolvers: list[Resolver] = [
        lambda row: f"a{row}",  # all distinct
        lambda row: "same" if row in (1, 2) else f"b{row}",
    ]
    assert _verify(resolvers, [[5, 6]]) == []
    # Rows 1 and 2 share ONLY the second column; the tuples still differ through the first.
    assert _verify(resolvers, [[1, 2, 9]]) == []

    # And a genuine repeat inside a mixed group survives, lowest row spared.
    twin: list[Resolver] = [
        lambda row: "x" if row in (3, 7) else f"a{row}",
        lambda row: "y" if row in (3, 7) else f"b{row}",
    ]
    assert _verify(twin, [[3, 7, 12]]) == [7]


def test_a_run_with_nothing_to_repair_passes_through_untouched():
    columns = [column(many(400, "a"), 1), column(many(400, "b"), 1)]
    ids = ["A", "B"]
    built = repair(ids, columns, 400, '"A × B"', fingerprint_buckets=8)
    rows = rows_of(built, ids, 400)
    assert len(set(rows)) == 400
    # Untouched means untouched: every row still holds what it drew.
    for row in range(400):
        assert rows[row] == f"{columns[0](row)}|{columns[1](row)}", (
            f"row {row} moved although nothing needed repairing"
        )
