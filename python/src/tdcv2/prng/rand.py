"""Drawing from a generator: an integer, an element, a shuffle.

Small on purpose, and shared rather than reimplemented per generator: the ORDER in which draws
are taken is part of the output. A second copy of "pick an element" that consumed a different
number of draws would silently shift every value after it.
"""

from __future__ import annotations

import math
from typing import TypeVar

from .prng import Sfc32

T = TypeVar("T")


def next_int(prng: Sfc32, minimum: int, maximum: int) -> int:
    """An integer in ``[minimum, maximum)``. The caller guarantees the range is non-empty."""
    return math.floor(prng.next() * (maximum - minimum) + minimum)


def pick(prng: Sfc32, items: list[T]) -> T:
    """A uniformly chosen element of a non-empty list."""
    return items[math.floor(prng.next() * len(items))]


def shuffle(prng: Sfc32, items: list[T]) -> list[T]:
    """Fisher-Yates, returning a new list and leaving the input untouched."""
    out = list(items)
    for i in range(len(out) - 1, 0, -1):
        j = math.floor(prng.next() * (i + 1))
        out[i], out[j] = out[j], out[i]
    return out
