"""Tuple fingerprints — how a large uniq run finds its duplicates.

Sorting the tuples THEMSELVES means sorting text: records of eighty-odd characters, millions of
strings, each one an object the garbage collector has to track. That text is what makes the middle
of a big run heavy — in scratch disk, in sort time, and in memory.

None of it is needed to DETECT a duplicate. Detection only asks "are these two the same?", and a
hash answers that in thirteen bytes::

    [hi 4B][lo 4B][row index 5B]   big-endian, fixed width

Fixed width and big-endian together buy the whole design. Comparing the raw thirteen bytes IS
comparing ``(hi, lo, index)``, so sorting needs no comparator and every implementation agrees by
construction. And a record's place in a file is ``13 * ordinal``, so a sorted pile can be
binary-searched on disk: "is this tuple taken?" costs about twenty-five tiny reads and no resident
memory at all.

A 64-bit hash is not proof — two different tuples can collide — so a group of records sharing a
hash is a CANDIDATE, not a verdict. Candidates are few, and each is verified by recomputing the
actual tuples by row number, which the engine can do for any row at any time. That is what makes
the duplicates found exactly the ones the text sort would name.

Every number here is part of the cross-language contract and is pinned by
``fixtures/cross-language/fingerprint-vectors.json``.
"""

from __future__ import annotations

import heapq
import struct
import tempfile
from collections.abc import Iterator
from pathlib import Path

from ..prng.prng import cyrb128

#: Bytes per record: 4 (hash hi) + 4 (hash lo) + 5 (row index).
RECORD_BYTES = 13

#: Rows a 5-byte index can name. Checked at the door rather than wrapped silently.
MAX_INDEX = 2**40

#: Records held in memory per sort batch. 2M records is 26 MB of packed bytes.
SORT_BATCH = 2_000_000

_HEAD = struct.Struct(">II")


def hash64(key: str) -> tuple[int, int]:
    """The 64-bit fingerprint of a tuple key, as two 32-bit halves."""
    state = cyrb128(key)
    return state[0], state[1]


def bucket_of(hi: int, buckets: int) -> int:
    """Which pile a fingerprint belongs to."""
    return hi % buckets


def bucket_count_for(count: int, cores: int) -> int:
    """How many piles for a run of ``count`` rows.

    A short run gets one pile — the signal to stay on the exact text path, where hashing has
    nothing to pay for itself with. Above that, four piles per core: measured sizes come out even
    enough that no core waits on a straggler.
    """
    if count < 1_000_000:
        return 1
    return min(256, max(2, max(1, cores) * 4))


def encode(hi: int, lo: int, index: int) -> bytes:
    """One record. Refuses an index the five bytes cannot carry rather than wrapping it."""
    if index >= MAX_INDEX:
        raise ValueError(
            f"fingerprint index {index} exceeds the 5-byte record limit ({MAX_INDEX} rows)"
        )
    return _HEAD.pack(hi & 0xFFFFFFFF, lo & 0xFFFFFFFF) + index.to_bytes(5, "big")


def decode(record: bytes) -> tuple[int, int, int]:
    """``(hi, lo, index)`` from one record."""
    hi, lo = _HEAD.unpack_from(record, 0)
    return hi, lo, int.from_bytes(record[8:13], "big")


class Writer:
    """Writes fingerprint records to a file, buffered."""

    def __init__(self, path: Path) -> None:
        self._file = path.open("wb")
        self.count = 0

    def write(self, hi: int, lo: int, index: int) -> None:
        self._file.write(encode(hi, lo, index))
        self.count += 1

    def close(self) -> None:
        self._file.close()

    def __enter__(self) -> Writer:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def read_records(path: Path) -> Iterator[bytes]:
    """Every record in a file, one at a time, in bounded memory."""
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(RECORD_BYTES * 4096)
            if not chunk:
                return
            for at in range(0, len(chunk) - RECORD_BYTES + 1, RECORD_BYTES):
                yield chunk[at : at + RECORD_BYTES]


def write_piles(
    resolvers: list,
    from_row: int,
    to_row: int,
    directory: Path,
    prefix: str,
    buckets: int,
    on_progress=None,
) -> list[Path]:
    """Hash rows ``[from_row, to_row)`` and route each fingerprint into its pile file.

    Returns one path per pile, in pile order. Nothing is sorted here — a pile is sorted by whoever
    picks it up, which is what lets several threads share the work.
    """
    from .exact_uniq import JOIN  # local: avoids a circular import at module load

    paths = [directory / f"{prefix}-{b}" for b in range(buckets)]
    writers = [Writer(path) for path in paths]
    total = to_row - from_row
    # About one report per half-percent of the range: cheap enough to leave on always.
    report_every = max(1, total // 200)
    try:
        for row in range(from_row, to_row):
            if on_progress is not None and (row - from_row) % report_every == 0:
                on_progress("uniq-scan", row - from_row, total)
            key = JOIN.join(resolver(row) for resolver in resolvers)
            hi, lo = hash64(key)
            writers[bucket_of(hi, buckets)].write(hi, lo, row)
    finally:
        for writer in writers:
            writer.close()
    return paths


def sort_files(
    inputs: list[Path], out_path: Path, tmp_root: Path | None = None, batch_size: int = SORT_BATCH
) -> int:
    """Sort any number of fingerprint files into ONE sorted file. Returns the record count.

    External merge sort over fixed-width records: batches sorted in memory, then a k-way merge
    holding one record per run. Bounded memory at any input size.

    The records are sorted AS BYTES. Because the encoding is big-endian and fixed width, that is
    exactly ``(hi, lo, index)`` ascending — no comparator to reproduce, and no way for two
    implementations to disagree about the order.
    """
    directory = Path(tempfile.mkdtemp(prefix="tdc-fp-sort-", dir=tmp_root))
    runs: list[Path] = []
    total = 0
    try:
        batch: list[bytes] = []

        def flush() -> None:
            if not batch:
                return
            batch.sort()
            run = directory / f"run-{len(runs)}"
            with run.open("wb") as handle:
                handle.write(b"".join(batch))
            runs.append(run)
            batch.clear()

        for source in inputs:
            for record in read_records(source):
                batch.append(record)
                total += 1
                if len(batch) >= batch_size:
                    flush()
        flush()

        with out_path.open("wb") as out:
            buffer: list[bytes] = []
            for record in heapq.merge(*(read_records(run) for run in runs)):
                buffer.append(record)
                if len(buffer) >= 65536:
                    out.write(b"".join(buffer))
                    buffer.clear()
            if buffer:
                out.write(b"".join(buffer))
        return total
    finally:
        for run in runs:
            run.unlink(missing_ok=True)
        directory.rmdir()


def candidate_groups(sorted_path: Path) -> Iterator[list[int]]:
    """Row groups that share a fingerprint, from a SORTED file.

    Candidates, not verdicts: a 64-bit collision between different tuples lands here too, so the
    caller recomputes the true tuples and keeps only the rows that genuinely repeat.
    """
    current: tuple[int, int] | None = None
    group: list[int] = []
    for record in read_records(sorted_path):
        hi, lo, index = decode(record)
        if current != (hi, lo):
            if len(group) >= 2:
                yield group
            group = []
            current = (hi, lo)
        group.append(index)
    if len(group) >= 2:
        yield group


class Ledger:
    """ "Is this tuple already taken?" — answered by binary search on the sorted piles.

    The sorted fingerprints ARE the ledger; a lookup is about twenty-five record-sized reads and no
    resident memory. Rows being reassigned have their old tuples freed, so a match counts only if
    some matching record's row is not among them. A 64-bit collision can only make the answer
    "taken" for a free tuple — the repair then picks another combination; it can never hide a taken
    one.
    """

    def __init__(self, sorted_paths: list[Path], moving: set[int]) -> None:
        self._paths = sorted_paths
        self._moving = moving
        self._handles = [path.open("rb") for path in sorted_paths]
        self._counts = [path.stat().st_size // RECORD_BYTES for path in sorted_paths]

    def has(self, key: str) -> bool:
        hi, lo = hash64(key)
        pile = bucket_of(hi, len(self._paths))
        handle = self._handles[pile]
        count = self._counts[pile]
        if count == 0:
            return False

        wanted = _HEAD.pack(hi, lo)
        low, high = 0, count
        while low < high:
            mid = (low + high) // 2
            handle.seek(mid * RECORD_BYTES)
            head = handle.read(8)
            if head < wanted:
                low = mid + 1
            else:
                high = mid

        at = low
        while at < count:
            handle.seek(at * RECORD_BYTES)
            record = handle.read(RECORD_BYTES)
            if record[:8] != wanted:
                break
            if int.from_bytes(record[8:13], "big") not in self._moving:
                return True
            at += 1
        return False

    def close(self) -> None:
        for handle in self._handles:
            handle.close()
