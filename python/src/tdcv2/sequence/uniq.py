"""``uniq="true"`` — every row's tuple different from every other row's.

The one invariant everything here is built around: values are only ever REARRANGED, never
replaced. Each column keeps exactly the multiset it was drawn with, so a declared ``percent=``
share survives untouched. Uniqueness and an exact distribution are not in tension — they coexist
because the arrangement is a permutation.

Three pieces. :func:`upper_bound` is a proven ceiling, so asking for more than it is impossible and
can be refused before any work. :func:`capacity` simulates over the quota numbers alone, giving a
safe floor that certifies a billion-row config in milliseconds without assembling a row.
:func:`arrange` is the constructive builder: proportional fill, then swap repair.

Pure: no config, no randomness, no input beyond the columns. The rearrangement is a function of the
values drawn, which is what lets it be checked against a brute-force answer.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# NUL, because it is the one character a generated value cannot contain. With a space or a comma,
# ["a b", "c"] and ["a", "b c"] would key alike, and two genuinely different rows would count as
# one duplicate — the exact mistake this file exists to avoid.
SEP = "\0"

# Sweeps of swap repair before the arrangement is accepted as it stands.
MAX_SWEEPS = 8


@dataclass(frozen=True, slots=True)
class Arrangement:
    columns: list[list[str]]
    distinct: int


def value_counts(column: list[str]) -> list[int]:
    """How often each distinct value appears, in first-seen order."""
    counts: dict[str, int] = {}
    for v in column:
        counts[v] = counts.get(v, 0) + 1
    return list(counts.values())


def upper_bound(column_counts: list[list[int]]) -> int:
    """A proven ceiling on the distinct tuples these value-counts can produce.

    It never undercounts, which is the property that matters: a config asking for more than this
    is definitely impossible and can be refused immediately, with no risk of refusing one that
    would have worked.
    """
    need = 1
    for counts in _by_deviation(column_counts):
        need = sum(min(c, need) for c in counts)
    return need


def capacity(column_counts: list[list[int]], need: int) -> int:
    """A safe floor, simulated over the counts alone.

    The builder always does at least this well, so reaching ``need`` here certifies the config
    without touching any data — which is what makes a billion-row config answerable in
    milliseconds.
    """
    ordered = _by_deviation(column_counts)
    if not ordered:
        return 0
    profile = list(ordered[0])
    for k in range(1, len(ordered)):
        pool = list(ordered[k])
        following: list[int] = []
        for group_size in sorted(profile, reverse=True):
            live = [(i, n) for i, n in enumerate(pool) if n > 0]
            split = _proportional_split(group_size, [n for _, n in live])
            for x, (index, _) in enumerate(live):
                if split[x] > 0:
                    following.append(split[x])
                    pool[index] -= split[x]
        profile = following
        # The count only grows with each further column, so reaching the target certifies it.
        if len(profile) >= need:
            return len(profile)
    return len(profile)


def arrange(columns: list[list[str]]) -> Arrangement:
    """The columns rearranged so as many rows as possible carry a distinct tuple."""
    k = len(columns)
    if k == 0:
        return Arrangement([], 0)
    if not columns[0]:
        return Arrangement([[] for _ in range(k)], 0)

    # Balanced columns first. A column whose values are evenly spread offers the most freedom, so
    # spending it early leaves the lopsided ones an easier job.
    deviations = [_stddev(value_counts(column)) for column in columns]
    order = sorted(range(k), key=lambda i: (deviations[i], i))

    rows = _build_rows([columns[i] for i in order])
    _repair(rows)

    out: list[list[str]] = [[] for _ in range(k)]
    for sorted_k, original in enumerate(order):
        out[original] = [row[sorted_k] for row in rows]

    distinct = len({SEP.join(row) for row in rows})
    return Arrangement(out, distinct)


def _deal_distinct(pool: dict[str, int], indexes: list[int], rows: list[list[str]]) -> bool:
    """Give a group of ``g`` rows ``g`` DISTINCT values, when the column still has that many left.

    Two rows in the same group agree on every column before this one, so they are distinct only
    if they differ HERE. The proportional split does not know that: it hands out values in
    proportion to remaining stock, which repeats a value inside a group as soon as one value
    dominates. Every such repeat is a duplicate row, and duplicates are what the repair then
    spends quadratic time undoing.

    Taking the ``g`` largest stocks costs nothing in exactness — the column's multiset is fixed
    either way, and this only chooses WHICH row gets which value. Returns False when the column
    has fewer values left than the group has rows, and the proportional path handles it.
    """
    g = len(indexes)
    # ``at`` is the position in the pool's own order, counted over every entry and not only the
    # live ones, so a tie is broken by first appearance the same way in every implementation.
    live = [(stock, at, value) for at, (value, stock) in enumerate(pool.items()) if stock > 0]
    if len(live) < g:
        return False

    live.sort(key=lambda entry: (-entry[0], entry[1]))
    for m in range(g):
        stock, _at, value = live[m]
        pool[value] = stock - 1
        rows[indexes[m]].append(value)
    return True


def _build_rows(columns: list[list[str]]) -> list[list[str]]:
    """Rows assembled column by column, spreading each column's values across the groups so far."""
    rows = [[v] for v in columns[0]]
    n = len(rows)

    for k in range(1, len(columns)):
        pool: dict[str, int] = {}
        for v in columns[k]:
            pool[v] = pool.get(v, 0) + 1

        groups: dict[str, list[int]] = {}
        for j in range(n):
            groups.setdefault(SEP.join(rows[j]), []).append(j)

        # Largest groups first: they are the ones most in need of diversity, and the pool is
        # finite, so serving them last would leave them whatever nobody else wanted.
        for indexes in sorted(groups.values(), key=len, reverse=True):
            if _deal_distinct(pool, indexes, rows):
                continue
            live_keys = [key for key, n_left in pool.items() if n_left > 0]
            split = _proportional_split(len(indexes), [pool[key] for key in live_keys])

            deck: list[str] = []
            for x, key in enumerate(live_keys):
                deck.extend([key] * split[x])
            deck.sort()

            for di, j in enumerate(indexes):
                if di < len(deck):
                    v = deck[di]
                elif deck:
                    v = deck[-1]
                else:
                    v = ""
                pool[v] = pool.get(v, 0) - 1
                rows[j].append(v)
    return rows


def _repair(rows: list[list[str]]) -> None:
    """Swap repair, in place.

    While a row duplicates another, trade one of its cells with another row's cell in the SAME
    column whenever that strictly reduces the number of duplicates. Swapping within a column is
    what preserves the multiset — the values move between rows, and the column still holds
    exactly what it held.
    """
    n = len(rows)
    k = len(rows[0]) if n else 0

    for _ in range(MAX_SWEEPS):
        improved = False
        counts: dict[str, int] = {}
        for row in rows:
            key = SEP.join(row)
            counts[key] = counts.get(key, 0) + 1

        for i in range(n):
            ri = rows[i]
            old_i = SEP.join(ri)
            if counts.get(old_i, 0) <= 1:
                continue
            done = False
            for col in range(k):
                if done:
                    break
                for j in range(n):
                    rj = rows[j]
                    if j == i or ri[col] == rj[col]:
                        continue
                    old_j = SEP.join(rj)
                    ni = list(ri)
                    nj = list(rj)
                    ni[col] = rj[col]
                    nj[col] = ri[col]
                    new_i = SEP.join(ni)
                    new_j = SEP.join(nj)

                    before = 1 + (1 if counts.get(old_j, 0) > 1 else 0)
                    # Only four tallies can change, so they are adjusted rather than recounted.
                    # The obvious version copies the whole map inside the innermost loop, which
                    # makes a sweep cubic in the row count and never finishes on real data.
                    after = (1 if _trial(counts, new_i, new_i, new_j, old_i, old_j) > 1 else 0) + (
                        1 if _trial(counts, new_j, new_i, new_j, old_i, old_j) > 1 else 0
                    )

                    if after < before:
                        rows[i] = ni
                        rows[j] = nj
                        counts[old_i] = counts.get(old_i, 0) - 1
                        counts[old_j] = counts.get(old_j, 0) - 1
                        counts[new_i] = counts.get(new_i, 0) + 1
                        counts[new_j] = counts.get(new_j, 0) + 1
                        improved = True
                        done = True
                        break
        if not improved:
            break


def _trial(counts: dict[str, int], key: str, new_i: str, new_j: str, old_i: str, old_j: str) -> int:
    return (
        counts.get(key, 0)
        + (1 if key == new_i else 0)
        + (1 if key == new_j else 0)
        - (1 if key == old_i else 0)
        - (1 if key == old_j else 0)
    )


def _proportional_split(total: int, caps: list[int]) -> list[int]:
    """A largest-remainder split of ``total`` over parts with the given capacities."""
    out = [0] * len(caps)
    if not caps:
        return out
    weight = sum(caps)

    remainders = [0.0] * len(caps)
    assigned = 0
    for i, cap in enumerate(caps):
        exact = 0.0 if weight == 0 else total * cap / weight
        out[i] = min(cap, math.floor(exact))
        remainders[i] = exact - math.floor(exact)
        assigned += out[i]

    for i in sorted(range(len(caps)), key=lambda i: (-remainders[i], i)):
        if assigned >= total:
            break
        if out[i] < caps[i]:
            out[i] += 1
            assigned += 1

    # Whatever the clamping left over, round-robin into the parts that still have room.
    i = 0
    while assigned < total:
        if out[i] < caps[i]:
            out[i] += 1
            assigned += 1
        elif not any(out[x] < caps[x] for x in range(len(caps))):
            break
        i = (i + 1) % len(out)
    return out


def _by_deviation(items: list[list[int]]) -> list[list[int]]:
    """The count vectors ordered by how evenly spread they are, most balanced first."""
    deviations = [_stddev(counts) for counts in items]
    return [items[i] for i in sorted(range(len(items)), key=lambda i: (deviations[i], i))]


def _stddev(numbers: list[int]) -> float:
    n = len(numbers)
    if n < 2:
        return 0.0
    mean = sum(numbers) / n
    variance = sum((v - mean) ** 2 for v in numbers)
    return math.sqrt(variance / (n - 1))
