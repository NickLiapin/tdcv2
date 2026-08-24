"""Exact percentages and uniqueness at the same time, past the size of memory.

The streaming engine can give unique combinations, but only uniform ones: its mixed-radix index
spreads rows evenly over the combination space by construction. It can give exact percentages too.
It cannot give both, because the arrangement that satisfies one is not free to satisfy the other.
The in-memory engine does both by holding the whole table and repairing collisions, which is
precisely what stops working at scale.

So: build each column with its exact quota the seekable way, then ask whether the tuples happen to
be distinct — a question a sort on disk can answer with bounded memory. Usually they are, because a
run of a million rows over a space of billions collides by birthday odds, which is to say rarely.
Then nothing more is needed and the whole run stays flat in memory.

When there ARE collisions there are few of them, so they can be repaired in RAM: gather the
colliding rows plus enough neighbours to give them somewhere to move, learn which tuples already
exist inside that small value space, and rearrange the pool to avoid them. Only the pool's rows
move, and only among the pool's own values, so every column's totals come out exactly as declared.
A pool too tight to solve hands the config back to the in-memory engine rather than shipping data
that is nearly unique.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Callable, Iterator
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from ..distribution import hamilton
from ..prng import permute
from ..prng.prng import create
from ..sequence import uniq as uniq_lib
from . import external_sort, fingerprint

# Separates a tuple's columns. Control characters cannot appear in a generated value.
JOIN = "\x01"

# Separates a key from its row index in a sortable record. NUL sorts below everything.
SEP = "\x00"

# Enough digits for any run: the index is padded so byte order is also numeric order.
INDEX_WIDTH = 16

# The pool repair is quadratic; past this many collisions, the config is pathological.
def max_repair_rows_for(count: int) -> int:
    """How many colliding rows the bounded repair takes on, for a run of ``count``.

    A flat cap was written when the repair was quadratic in its pool. It is not any more, and
    collisions grow as the SQUARE of the run — so a flat cap doomed every sufficiently large run:
    97 million rows slid under 20,000 at 18,225, and 194 million tripped it at about 73,000. A
    thousandth of the rows keeps the repair pool in tens of megabytes at any size, and the floor
    keeps small runs as permissive as they were.
    """
    return max(20_000, count // 1000)


#: Rows past which the in-memory engine is NOT a fallback. Past this it cannot hold the table at
#: all, so falling back is not failing fast — it is failing after a long materialisation with
#: nothing written. Refusing with a sentence is the honest outcome.
IN_MEMORY_FALLBACK_MAX_ROWS = 20_000_000

# Sweeps of swap repair before the pool is judged unsolvable.
MAX_SWEEPS = 32


class RepairNeededError(RuntimeError):
    """The exact construction collided and the bounded repair could not place every row.

    Two audiences, one sentence. A caller that CHOSE a bounded-memory engine for the user catches
    this and falls back to the in-memory engine, which has the whole table to work with. A caller
    the user forced into stream mode lets it through instead: holding the whole table is the one
    thing that user asked not to happen, so the text says what to change rather than claiming a
    fallback that did not occur.
    """

    def __init__(self, collisions: int, label: str) -> None:
        super().__init__(
            f"uniq {label} is too tight to repair without holding the whole table "
            f"({collisions} row(s) couldn't be placed) — run without mode=\"stream\" "
            "so the in-memory engine can arrange it."
        )


@dataclass(frozen=True, slots=True)
class Plan:
    """How an arrangement travels between the process that works it out and the ones that do not.

    Deciding which rows a uniq group moves where is a pass over every row to find the collisions
    and a second to learn which tuples are taken — the expensive half of a uniq run, and the same
    answer every time for a given config and seed. ``on_computed`` hands the result out;
    ``preset`` hands it back in, and a worker holding one skips the analysis entirely. That is what
    lets several processes render different row ranges of one uniq config instead of each
    repeating the whole hunt.

    The result is small — only the rows that actually moved — so it crosses a process boundary as
    JSON for nothing.
    """

    preset: dict[int, list[str]] | None = None
    on_computed: Callable[[dict[int, list[str]]], None] | None = None


@dataclass(frozen=True, slots=True)
class Field:
    """One uniq column: where it lands in the registry, its values, and their shares."""

    id: str
    values: list[str]
    percents: list[float]


Resolver = Callable[[int], str]


def arrange(
    fields: list[Field],
    count: int,
    seed: str,
    label: str,
    tmp_dir: Path | None = None,
    on_progress=None,
    plan: Plan | None = None,
) -> dict[str, Resolver]:
    """The uniq columns built with exact shares, and their tuples verified really distinct."""
    counts = [
        hamilton.counts_per_value(count, f.percents, create(f"{seed}|{f.id}|pct")) for f in fields
    ]

    upper = uniq_lib.upper_bound(counts)
    if count > upper:
        raise RuntimeError(
            f"uniq {label} is infeasible — its data supports at most {upper} distinct rows, but "
            f"{count} were requested. Widen a column's values or lower count."
        )

    resolvers: list[Resolver] = []
    for j, f in enumerate(fields):
        cum_hi = _cumulative(counts[j])
        key = permute.key(seed, f.id)
        values = f.values
        resolvers.append(
            lambda row, cum_hi=cum_hi, key=key, values=values: values[
                _run_for(cum_hi, permute.permute(row, count, key))
            ]
        )

    # If any column uses each of its values at most once, the tuple is unique by that column
    # alone. Worth checking: it turns the whole verification pass into an inspection of a handful
    # of integers, and a serial-number column makes it true.
    for column_counts in counts:
        if all(c <= 1 for c in column_counts):
            # Nothing moves, and a worker waiting to be told must hear that rather than wait.
            if plan is not None and plan.on_computed is not None:
                plan.on_computed({})
            return _registry([f.id for f in fields], resolvers)

    return repair(
        [f.id for f in fields], resolvers, count, label, tmp_dir, None, on_progress, plan
    )


def _registry(ids: list[str], resolvers: list[Resolver]) -> dict[str, Resolver]:
    return {name: resolvers[j] for j, name in enumerate(ids)}


def repair(
    ids: list[str],
    resolvers: list[Resolver],
    count: int,
    label: str,
    tmp_dir: Path | None = None,
    block_of: Callable[[int], str] | None = None,
    on_progress=None,
    plan: Plan | None = None,
) -> dict[str, Resolver]:
    """Verified, and whatever the construction left colliding repaired.

    The repair moves a small pool of rows and nothing else. That is what keeps the percentages
    exact: a value only ever changes hands between two rows of the pool, so every column ends the
    pass with the multiset it started with.

    ``block_of`` names which rows may trade values with each other. A ``<switch>`` member draws
    from a different list depending on another column, so a male row's first name is not a value a
    female row is allowed to hold; without this the repair would keep the tuple unique and stop the
    record making sense. Absent means one block holding everything, which is the ordinary case.
    """
    # Told rather than worked out: the whole point of a plan. Nothing below this line runs.
    if plan is not None and plan.preset is not None:
        return _apply_override(ids, resolvers, plan.preset)

    # How the duplicates are hunted: by fingerprint on a large run, by tuple text on a small one.
    # The carrier is all that differs — the rows found are the same rows either way, because a
    # matching fingerprint is verified against the true tuples before it is believed.
    scan = _fingerprint_scan(resolvers, count, tmp_dir, on_progress)

    excess: list[int] = []
    if scan is not None:
        excess = list(scan.excess)
    else:
        # The first row of every colliding group stays; the rest have to move.
        for group in _duplicate_groups(resolvers, count, tmp_dir):
            excess.extend(group[1:])
    if not excess:
        if scan is not None:
            scan.drop()
        if plan is not None and plan.on_computed is not None:
            plan.on_computed({})
        return _registry(ids, resolvers)
    if len(excess) > max_repair_rows_for(count):
        if scan is not None:
            scan.drop()
        raise RepairNeededError(len(excess), label)
    excess.sort()

    # The colliding rows on their own often lack the variety to move — a lone duplicate can only
    # re-form the tuple it already has. So the pool takes in donor rows sampled across the run,
    # which gives the arrangement room without letting any value leave the pool.
    donor_target = min(count - len(excess), 8 * len(excess) + 24)
    in_pool = set(excess)
    pool = list(excess)
    if donor_target > 0 and block_of is None:
        stride = max(1, count // donor_target)
        for i in range(0, count, stride):
            if len(pool) - len(excess) >= donor_target:
                break
            if i not in in_pool:
                in_pool.add(i)
                pool.append(i)
    elif donor_target > 0:
        # Donors have to come from the row's OWN block, or they arrive holding values it is not
        # allowed to take. Wanted per block, in proportion to how many of its rows have to move.
        wanted: dict[str, int] = {}
        for row in excess:
            block = block_of(row)
            wanted[block] = wanted.get(block, 0) + 8
        for block in wanted:
            wanted[block] += 24
        stride = max(1, count // max(1, donor_target))
        for i in range(0, count, stride):
            if i in in_pool:
                continue
            block = block_of(i)
            left = wanted.get(block, 0)
            if left <= 0:
                continue
            wanted[block] = left - 1
            in_pool.add(i)
            pool.append(i)
    pool.sort()

    k = len(resolvers)
    pool_columns = [[resolvers[j](row) for row in pool] for j in range(k)]
    pool_space = [set(column) for column in pool_columns]

    # "Is this tuple taken?" — answered one of two ways.
    #
    # Large run: no structure at all. The sorted fingerprint piles on disk ARE the ledger, and a
    # query is a binary search. Small run: derive every row's tuple once more and hold the ones
    # inside the pool's value space in an exact set, exactly as before.
    ledger: fingerprint.Ledger | None = None
    forbidden: Membership
    if scan is not None:
        ledger = fingerprint.Ledger(scan.sorted_paths, in_pool)
        forbidden = ledger
    else:
        exact: set[str] = set()
        for i in range(count):
            if i in in_pool:
                continue
            tuple_values = []
            in_space = True
            for j in range(k):
                value = resolvers[j](i)
                if value not in pool_space[j]:
                    in_space = False
                    break
                tuple_values.append(value)
            if in_space:
                exact.add(JOIN.join(tuple_values))
        forbidden = _ExactMembership(exact)

    # The pool is arranged one block at a time: a value only ever lands on a row that was allowed
    # to hold it. One block, keyed by the empty string, is the ordinary case.
    blocks: dict[str, list[int]] = {}
    for m, row in enumerate(pool):
        blocks.setdefault("" if block_of is None else block_of(row), []).append(m)

    override: dict[int, list[str]] = {}
    try:
        for positions in blocks.values():
            columns = [[column[m] for m in positions] for column in pool_columns]
            arranged = _arrange_avoiding(columns, forbidden, len(positions))
            if arranged is None:
                raise RepairNeededError(len(excess), label)
            for at, m in enumerate(positions):
                override[pool[m]] = [column[at] for column in arranged]
    finally:
        if ledger is not None:
            ledger.close()
        if scan is not None:
            scan.drop()

    if plan is not None and plan.on_computed is not None:
        plan.on_computed(override)
    return _apply_override(ids, resolvers, override)


def _apply_override(
    ids: list[str], resolvers: list[Resolver], override: dict[int, list[str]]
) -> dict[str, Resolver]:
    """Columns that answer from the override where there is one, and from the resolver elsewhere.

    Which is all a repaired uniq column IS.
    """
    out: dict[str, Resolver] = {}
    for j, name in enumerate(ids):
        base = resolvers[j]
        out[name] = lambda row, column=j, base=base: (
            override[row][column] if row in override else base(row)
        )
    return out


class Membership(Protocol):
    """Anything that can answer "is this tuple taken?" — an exact set, or the disk ledger."""

    def has(self, key: str) -> bool: ...


class _ExactMembership:
    """The small-run answer: every in-space tuple, held exactly."""

    def __init__(self, keys: set[str]) -> None:
        self._keys = keys

    def has(self, key: str) -> bool:
        return key in self._keys


@dataclass
class _FingerprintScan:
    """What the fingerprint hunt produced: the sorted piles, their home, and the verified rows."""

    sorted_paths: list[Path]
    directory: Path
    excess: list[int]

    def drop(self) -> None:
        for path in self.sorted_paths:
            path.unlink(missing_ok=True)
        with suppress(OSError):
            self.directory.rmdir()


def _fingerprint_scan(
    resolvers: list[Resolver], count: int, tmp_dir: Path | None, on_progress=None
) -> _FingerprintScan | None:
    """Hunt duplicates by fingerprint, or return None to leave the text path in charge.

    Every row's tuple is hashed into a 13-byte record routed straight to its pile; each pile is
    sorted as raw bytes; groups sharing a hash are CANDIDATES. Verification then recomputes the
    true tuples for those few rows, so a 64-bit collision costs one recomputation and never a
    false duplicate — the rows returned are exactly the ones the text sort would name.
    """
    buckets = fingerprint.bucket_count_for(count, os.cpu_count() or 1)
    if buckets < 2:
        return None

    directory = Path(tempfile.mkdtemp(prefix="tdc-fp-", dir=tmp_dir))
    raw_paths = fingerprint.write_piles(
        resolvers, 0, count, directory, "raw", buckets, on_progress
    )

    sorted_paths: list[Path] = []
    candidates: list[list[int]] = []
    for b in range(buckets):
        if on_progress is not None:
            on_progress("uniq-sort", b, buckets)
        out = directory / f"sorted-{b}"
        fingerprint.sort_files([raw_paths[b]], out, directory)
        raw_paths[b].unlink(missing_ok=True)
        sorted_paths.append(out)
        candidates.extend(fingerprint.candidate_groups(out))

    return _FingerprintScan(sorted_paths, directory, _verify(resolvers, candidates))


def _verify(resolvers: list[Resolver], candidates: list[list[int]]) -> list[int]:
    """Keep only the rows whose tuples GENUINELY repeat, lowest row of each group spared."""
    excess: list[int] = []
    for group in candidates:
        by_key: dict[str, list[int]] = {}
        for row in group:
            key = JOIN.join(resolver(row) for resolver in resolvers)
            by_key.setdefault(key, []).append(row)
        for rows in by_key.values():
            if len(rows) < 2:
                continue  # a hash collision, not a duplicate
            rows.sort()
            excess.extend(rows[1:])
    excess.sort()
    return excess


def _duplicate_groups(
    resolvers: list[Resolver], count: int, tmp_dir: Path | None
) -> Iterator[list[int]]:
    """The groups of rows whose tuples are identical, in bounded memory.

    Sorting is what makes this affordable: equal keys end up adjacent, so the scan holds one group
    rather than a set of every tuple seen. The row index is padded to a fixed width and appended
    after a NUL, which makes plain byte order the same as ordering by key and then by row — no
    record has to be parsed to be compared.
    """

    def records() -> Iterator[str]:
        for row in range(count):
            key = JOIN.join(resolver(row) for resolver in resolvers)
            yield f"{key}{SEP}{row:0{INDEX_WIDTH}d}"

    current_key: str | None = None
    group: list[int] = []
    for record in external_sort.sort(records(), 0, tmp_dir):
        split = record.rfind(SEP)
        key = record[:split]
        index = int(record[split + 1 :])
        if key != current_key:
            if len(group) >= 2:
                yield group
            group = []
            current_key = key
        group.append(index)
    if len(group) >= 2:
        yield group


def _arrange_avoiding(
    columns: list[list[str]], forbidden: Membership, size: int
) -> list[list[str]] | None:
    """The pool's columns rearranged so its tuples are distinct and none is already taken.

    Each column is permuted WITHIN itself, never added to or taken from, so the pool's totals
    survive the pass. What changes is which values meet each other.
    """
    k = len(columns)
    if size == 0 or k == 0:
        return list(columns)

    arranged = uniq_lib.arrange(columns).columns
    rows = [[column[i] for column in arranged] for i in range(size)]

    for _ in range(MAX_SWEEPS):
        tally: dict[str, int] = {}
        for row in rows:
            key = JOIN.join(row)
            tally[key] = tally.get(key, 0) + 1
        improved = False

        for i in range(size):
            ri = rows[i]
            key_i = JOIN.join(ri)
            if tally.get(key_i, 0) <= 1 and not forbidden.has(key_i):
                continue
            done = False
            for col in range(k):
                if done:
                    break
                for j in range(size):
                    rj = rows[j]
                    if j == i or ri[col] == rj[col]:
                        continue
                    ni = list(ri)
                    nj = list(rj)
                    ni[col] = rj[col]
                    nj[col] = ri[col]
                    key_j = JOIN.join(rj)
                    new_i = JOIN.join(ni)
                    new_j = JOIN.join(nj)

                    # Row i is known bad — that is why a partner is being looked for at all.
                    before = 1 + (1 if _is_bad(tally, forbidden, key_j) else 0)
                    # A swap moves two rows, so only four tallies can change. Computing the delta
                    # beats copying the whole table inside the innermost loop, which is what makes
                    # a large pool finish rather than hang.
                    bad_i = _is_bad_after(tally, forbidden, new_i, key_i, key_j, new_i, new_j)
                    bad_j = _is_bad_after(tally, forbidden, new_j, key_i, key_j, new_i, new_j)
                    after = (1 if bad_i else 0) + (1 if bad_j else 0)
                    if after < before:
                        rows[i] = ni
                        rows[j] = nj
                        tally[key_i] = tally.get(key_i, 0) - 1
                        tally[key_j] = tally.get(key_j, 0) - 1
                        tally[new_i] = tally.get(new_i, 0) + 1
                        tally[new_j] = tally.get(new_j, 0) + 1
                        improved = True
                        done = True
                        break
        if not improved:
            break

    final: dict[str, int] = {}
    for row in rows:
        key = JOIN.join(row)
        final[key] = final.get(key, 0) + 1
    for row in rows:
        if _is_bad(final, forbidden, JOIN.join(row)):
            return None

    return [[row[j] for row in rows] for j in range(k)]


def _is_bad(tally: dict[str, int], forbidden: Membership, key: str) -> bool:
    return tally.get(key, 0) > 1 or forbidden.has(key)


def _is_bad_after(tally, forbidden, key, old_i, old_j, new_i, new_j) -> bool:
    """The verdict on ``key`` as it would stand after the two rows swapped."""
    after = (
        tally.get(key, 0)
        + (1 if key == new_i else 0)
        + (1 if key == new_j else 0)
        - (1 if key == old_i else 0)
        - (1 if key == old_j else 0)
    )
    return after > 1 or forbidden.has(key)


def _cumulative(counts: list[int]) -> list[int]:
    out = []
    acc = 0
    for c in counts:
        acc += c
        out.append(acc)
    return out


def _run_for(cum_hi: list[int], slot: int) -> int:
    lo, hi = 0, len(cum_hi) - 1
    while lo < hi:
        mid = (lo + hi) >> 1
        if slot < cum_hi[mid]:
            hi = mid
        else:
            lo = mid + 1
    return lo
