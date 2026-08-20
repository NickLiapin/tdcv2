"""Draws addressed by row rather than taken in order.

An ordinary generator has to be walked: the millionth value costs a million calls. Keying the
generator by ``seed | stream | index`` instead makes a row's values a function of its own number,
which is what lets the streaming engine answer row nine million without having built the first
eight.
"""

from __future__ import annotations

import math
import struct
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


def _bits_hex(value: float) -> str:
    """A double as the 16 hex digits of its IEEE-754 image."""
    return struct.unpack(">Q", struct.pack(">d", value))[0].to_bytes(8, "big").hex()


def hash_unit(n: float, salt: float) -> float:
    """A deterministic value in [0, 1) from a pair of numbers — `hash(n, salt)`.

    The key is built from the IEEE-754 BIT PATTERNS of the two arguments, not from
    their decimal forms: `salt` is any double, and the shortest decimal spelling of
    a double differs between languages, while those 64 bits are pinned by the
    standard and printing an integer as hex is exact everywhere. The mixing is
    cyrb128 and the stream is sfc32 — the PRNG the rest of TDC already runs on.
    """
    return generator("hash", f"{_bits_hex(n)}|{_bits_hex(salt)}", 0).next()


def noise_unit(t: float, scale: float, salt: float) -> float:
    """Smooth one-dimensional value noise — `noise(t, scale, salt)`.

    A drifting baseline is not three sine waves: modulate those however you like and
    a spectrum still shows three pure tones. Here each lattice point is an
    independent draw and only the interpolation between them is smooth, so the
    spectrum is broad.

    `scale` is the wavelength in rows; `salt` picks the series. The easing is the
    classic smoothstep, u*u*(3-2u), zero at both ends with zero slope, so no corner
    appears where one cell meets the next. The interpolation is a*(1-u) + b*u for
    the same reason `lerp` uses it: the lattice points come out EXACTLY equal to
    `hash` there, so a cell boundary is continuous to the last bit.

    A `scale` of zero divides by zero and the answer is NaN — the same answer
    `sqrt(-1)` gives here.
    """
    # Python RAISES on float division by zero where IEEE-754 — and the other four
    # implementations — return an infinity. Downstream that infinity always ends
    # as NaN, whatever `t` is: floor(inf) is inf and inf - inf is NaN, and 0/0 is
    # NaN to begin with. So return NaN directly rather than let this one language
    # throw where the rest answer. Same rule as `_divide` in expr/evaluate.py.
    if scale == 0:
        return math.nan
    x = t / scale
    cell = math.floor(x)
    u = x - cell
    eased = u * u * (3 - 2 * u)
    a = hash_unit(cell, salt)
    b = hash_unit(cell + 1, salt)
    return a * (1 - eased) + b * eased
