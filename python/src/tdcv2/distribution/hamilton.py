"""Turning percentages into whole rows, exactly.

``percent="50,30,20"`` over seven records cannot be met by rounding: the shares come to 3.5, 2.1
and 1.4. Largest-remainder apportionment — the same method used to allocate seats to parties —
hands out the whole parts first and then the leftovers, so the columns always sum to the count
and each share is as close to what was asked for as whole rows allow.

Ties are the interesting part. When several values have the same remainder and there are fewer
leftovers than claimants, the choice is made from the run's own generator rather than by index
order. Breaking ties by index would make the first-declared value quietly win every close call,
and a config that lists its values in a different order would produce different data.
"""

from __future__ import annotations

import math
from typing import TypeVar

from ..prng import rand
from ..prng.prng import Sfc32

T = TypeVar("T")


def counts_per_value(count: int, percents: list[float], prng: Sfc32) -> list[int]:
    """How many rows each value receives."""
    card_percent = 100.0 / count
    counts = [0] * len(percents)
    remainders = [0.0] * len(percents)
    filled = 0

    for i, percent in enumerate(percents):
        raw_cells = percent / card_percent
        whole = int(raw_cells)  # truncation toward zero, as Math.trunc does
        counts[i] = whole
        remainders[i] = raw_cells % 1
        filled += whole

    unallocated = count - filled
    if unallocated <= 0:
        return counts

    # Largest remainder first; index order only to make the grouping below deterministic.
    order = sorted(range(len(remainders)), key=lambda i: (-remainders[i], i))

    at = 0
    while unallocated > 0 and at < len(order):
        remainder = remainders[order[at]]
        end = at
        while end < len(order) and remainders[order[end]] == remainder:
            end += 1

        group_size = end - at
        if group_size <= unallocated:
            for k in range(at, end):
                counts[order[k]] += 1
                unallocated -= 1
            at = end
            continue

        # More claimants than leftovers: draw, rather than let declaration order decide.
        pool = list(order[at:end])
        while unallocated > 0:
            picked = math.floor(prng.next() * len(pool))
            counts[pool[picked]] += 1
            pool.pop(picked)
            unallocated -= 1

    return counts


def distribute(count: int, values: list[T], percents: list[float], prng: Sfc32) -> list[T]:
    """The materialized, shuffled sequence of ``count`` values."""
    counts = counts_per_value(count, percents, prng)
    sequence: list[T] = []
    for i, value in enumerate(values):
        sequence.extend([value] * counts[i])
    return rand.shuffle(prng, sequence)
