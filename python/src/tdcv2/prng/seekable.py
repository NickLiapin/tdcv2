"""Draws addressed by row rather than taken in order.

An ordinary generator has to be walked: the millionth value costs a million calls. Keying the
generator by ``seed | stream | index`` instead makes a row's values a function of its own number,
which is what lets the streaming engine answer row nine million without having built the first
eight.
"""

from __future__ import annotations

import math
from functools import lru_cache

from .prng import INITIAL, Sfc32, State, absorb, finish

# Half of a 32-bit unit in the last place — see `open_unit`.
_HALF_ULP = 0.5 / 4294967296.0


@lru_cache(maxsize=1024)
def _prefix(seed: str, stream_id: str) -> State:
    """The hash state after ``seed|stream|``, which every row of a stream shares.

    A config has a handful of streams and a run has millions of rows, so this turns the constant
    part of the seed string — usually two thirds of its characters — into one lookup.
    """
    return absorb(INITIAL, f"{seed}|{stream_id}|")


def generator(seed: str, stream_id: str, index: int) -> Sfc32:
    """A generator private to one row of one stream."""
    a, b, c, d = finish(absorb(_prefix(seed, stream_id), str(index)))
    return Sfc32(a, b, c, d)


def next_value(seed: str, stream_id: str, index: int) -> float:
    return generator(seed, stream_id, index).next()


def next_int(seed: str, stream_id: str, index: int, n: int) -> int:
    """An integer in ``[0, n)`` for this row."""
    if n <= 1:
        return 0
    return math.floor(next_value(seed, stream_id, index) * n)


def open_unit(u: float) -> float:
    """Nudge a draw off both endpoints, into the open interval ``(0, 1)``.

    Several distributions take a logarithm of the draw or of its complement, and an exact 0 or 1
    would make that infinite. Half a unit in the last place is the smallest shift that cannot
    change which value a draw would otherwise have selected.
    """
    return min(1 - _HALF_ULP, max(_HALF_ULP, u + _HALF_ULP))


def uniforms(seed: str, stream_id: str, index: int, count: int) -> list[float]:
    """``count`` uniforms in ``(0, 1)`` for one row — what a fixed-draw sampler needs."""
    gen = generator(seed, stream_id, index)
    return [open_unit(gen.next()) for _ in range(count)]
