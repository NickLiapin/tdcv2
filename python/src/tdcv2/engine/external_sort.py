"""Sorting more records than fit in memory.

The oldest trick there is, and still the right one: fill a buffer, sort it, write it out, repeat;
then merge the sorted runs by always taking the smallest head. Memory is bounded by one chunk plus
one line per run, whatever the input's size.

The exact engine needs it for one question — are any two records identical — which cannot be
answered by a set once the answer stops fitting in RAM. Sorting puts equal records next to each
other, and the scan that follows holds nothing but the group it is in.

An input that fits in a single chunk never touches the disk. Most runs are that, and paying for
temp files to sort ten thousand rows would make the exact engine slower than the one it exists to
replace.
"""

from __future__ import annotations

import heapq
import shutil
import tempfile
from collections.abc import Iterable, Iterator
from pathlib import Path

# Records held in memory per run. Roughly a hundred megabytes of short keys.
DEFAULT_CHUNK = 1_000_000


def sort(records: Iterable[str], chunk_size: int = 0, tmp_dir: Path | None = None) -> Iterator[str]:
    """The records in ascending order.

    A generator rather than a list on purpose: the caller scans it once, and materializing the
    result would give back exactly the memory this exists to save. Byte order, not locale order —
    the keys are opaque and only equality of neighbours matters.
    """
    limit = max(1, DEFAULT_CHUNK if chunk_size <= 0 else chunk_size)
    runs: list[Path] = []
    chunk: list[str] = []
    directory: Path | None = None

    for record in records:
        chunk.append(record)
        if len(chunk) >= limit:
            if directory is None:
                directory = Path(tempfile.mkdtemp(prefix="tdc-esort-", dir=tmp_dir))
            runs.append(_write_run(chunk, directory, len(runs)))
            chunk = []

    # It all fit. Sorted in memory, and no file was ever created — the common case by far.
    if not runs:
        chunk.sort()
        return iter(chunk)

    if chunk:
        assert directory is not None
        runs.append(_write_run(chunk, directory, len(runs)))
    assert directory is not None
    return _merge(runs, directory)


def _write_run(chunk: list[str], directory: Path, index: int) -> Path:
    chunk.sort()
    path = directory / f"run-{index}.txt"
    with path.open("w", encoding="utf-8") as out:
        for record in chunk:
            out.write(record)
            out.write("\n")
    return path


def _merge(runs: list[Path], directory: Path) -> Iterator[str]:
    """The k-way merge: one line per run in memory, and the temp files gone when it ends."""
    handles = [path.open(encoding="utf-8") for path in runs]
    try:
        heap: list[tuple[str, int]] = []
        for run, handle in enumerate(handles):
            line = handle.readline()
            if line:
                heapq.heappush(heap, (line.rstrip("\n"), run))
        while heap:
            value, run = heapq.heappop(heap)
            line = handles[run].readline()
            if line:
                heapq.heappush(heap, (line.rstrip("\n"), run))
            yield value
    finally:
        for handle in handles:
            handle.close()
        # Temp files in the system's own temp directory; a leftover is not worth failing over.
        shutil.rmtree(directory, ignore_errors=True)
