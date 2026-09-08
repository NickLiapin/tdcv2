"""Sorting more records than fit in memory.

The exact engine asks one question of this — are any two records identical — and answers it by
putting equal records next to each other. Get the merge wrong and the answer is wrong: duplicates
that never meet are duplicates that ship.

The disk half had never run. An input that fits in one chunk is sorted in memory and never touches
a file, and every test in this suite was that size, so the run files, the k-way merge and the
cleanup were dead to the suite while being exactly what a large run uses. TypeScript and Java each
had a test for it; Python, Rust and C# had none.

``chunk_size`` is the seam: production leaves it at a million records, and these pass a handful.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from tdcv2.engine.external_sort import sort


def test_spans_many_runs_and_loses_nothing():
    # 500 records, chunk of 7 → about 72 runs merged. Forces the disk path.
    records = [str((i * 137 + 11) % 500) for i in range(500)]
    out = list(sort(iter(records), chunk_size=7))
    assert out == sorted(records)
    assert len(out) == len(records)


def test_keeps_duplicates_so_the_scan_can_find_them():
    # The whole point: equal records end up adjacent, and none is dropped on the way.
    records = ["b", "a", "b", "c", "a", "a"]
    assert list(sort(iter(records), chunk_size=2)) == ["a", "a", "a", "b", "b", "c"]


def test_the_in_memory_path_when_it_all_fits():
    assert list(sort(iter(["3", "1", "2"]), chunk_size=1000)) == ["1", "2", "3"]


def test_empty_input():
    assert list(sort(iter([]), chunk_size=4)) == []


def test_chunk_size_cannot_change_the_answer():
    records = [str((i * 977) % 251) for i in range(200)]
    once = list(sort(iter(records), chunk_size=5))
    assert once == list(sort(iter(records), chunk_size=5))
    assert once == list(sort(iter(records), chunk_size=50))
    assert once == list(sort(iter(records), chunk_size=100000))


def test_byte_order_not_number_order():
    # The keys are opaque and only equality of neighbours matters, so this sorts as text.
    # "100" before "2" is correct here, and a locale-aware comparison would be both slower and
    # machine-dependent.
    records = ["10", "9", "100", "2", "30"]
    assert list(sort(iter(records), chunk_size=2)) == ["10", "100", "2", "30", "9"]


def test_a_record_holding_a_newline_would_break_the_merge():
    # Records are written one per line, so a newline INSIDE a record would come back as two.
    # Nothing in the engine produces one — the keys are joined with NUL — and this says so out
    # loud, because the format is the assumption.
    records = ["a", "b"]
    assert all("\n" not in r for r in records)
    assert list(sort(iter(records), chunk_size=1)) == ["a", "b"]


def test_the_temp_files_are_gone_when_the_scan_ends():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        records = [str(i) for i in range(60)]
        out = list(sort(iter(records), chunk_size=4, tmp_dir=root))
        assert out == sorted(records)
        # A long run sorts many times; a leaked run directory each time fills the disk.
        assert list(root.iterdir()) == []
