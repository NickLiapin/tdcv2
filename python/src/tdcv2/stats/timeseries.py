"""``<gen type="timeseries">`` — a column that moves the way measured things move.

    value(i) = base + trend·i + Σ amplitude·cos(2π·(i − peak)/period) + noise·e(i)

A drift, one or more seasonal waves, and noise over the row index as the time axis. Sales,
sensors, traffic and queue depths all look like this; none of them look like flat uniform noise,
and a dashboard tested against flat noise has never had its trend line or its seasonality checked.

Like a counter it depends on the ABSOLUTE row index, so both engines hand it the real index rather
than a position within a chunk. The noise is built from per-row standard-normal draws, which keeps
the series seekable: row nine million is computable without the rows before it.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

from ..lib import numbers

NOISE_WINDOW = 63
"""How many past rows the correlated noise remembers.

The textbook AR(1) is written ``e(t) = φ·e(t−1) + z(t)`` — a recurrence, which a seekable engine
cannot evaluate: row 900,000 would have to replay 900,000 rows. Written out, that recurrence is a
weighted sum of the past innovations, ``Σ φ^k·z(t−k)``, and the weights fall off geometrically —
so this generator defines the noise as that sum over a FIXED window and evaluates it directly.
Both engines then run the same arithmetic in the same order and cannot drift apart, and any row is
computable on its own.

64 terms, because that is where the cost stops mattering: with the window's draws kept in a ring
the whole sum costs about 20 ns a row over plain noise.
"""


@dataclass(frozen=True, slots=True)
class Wave:
    """One seasonal wave: how long it is, how far it swings, and where it peaks."""

    period: float
    amplitude: float
    peak_at: float | None = None
    """Which row the wave peaks on, or None for the classic sine.

    A plain ``sin(2π·i/period)`` crosses zero at row 0 and peaks a QUARTER PERIOD later, so a
    year of daily rows peaks in early April — the one season nobody means by "warmer in
    summer". ``peak_at`` names the ROW instead of a shift, because the row is what the author
    knows: 182 of 365 is the first of July.
    """


@dataclass(frozen=True, slots=True)
class Spec:
    base: float
    trend: float

    waves: tuple[Wave, ...]
    """The seasonal waves, in the order written. Empty means no seasonality.

    A list rather than one wave because real series carry more than one season at a time: shop
    takings rise on Saturdays AND in December, and a model given only the weekly wave has
    nothing to find in the yearly one. The waves simply sum.
    """

    noise_sd: float
    """The standard deviation of the noise; zero switches it off."""

    noise_correlation: float
    """How strongly one row's noise carries into the next, in (−1, 1).

    Zero is the independent (white) noise this generator has always produced. Real measurement
    error is rarely independent: a sensor reading high today tends to read high tomorrow, and a
    model tested only against white noise has never met the case it will actually fail on.
    """

    decimals: int

    def has_noise(self) -> bool:
        """Whether this spec draws at all — which decides if it consumes uniforms."""
        return self.noise_sd != 0


def parse(attrs: dict[str, str]) -> Spec:
    def num(key: str, fallback: float) -> float:
        raw = attrs.get(key)
        if raw is None or not raw.strip():
            return fallback
        n = numbers.parse(raw)
        if n != n or n in (float("inf"), float("-inf")):
            raise ValueError(f'timeseries: "{key}" must be a number (got "{raw}")')
        return n

    def num_list(key: str) -> list[float]:
        """A comma-separated list of numbers, or [] when the attribute is absent."""
        raw = attrs.get(key)
        if raw is None or not raw.strip():
            return []
        out = []
        for piece in raw.split(","):
            text = piece.strip()
            n = numbers.parse(text) if text else float("nan")
            if not text or n != n or n in (float("inf"), float("-inf")):
                raise ValueError(f'timeseries: "{key}" must be a number (got "{raw}")')
            out.append(n)
        return out

    periods = num_list("period")
    amplitudes = num_list("amplitude")
    peaks = num_list("peak_at")
    for period in periods:
        if period < 0:
            raise ValueError('timeseries: "period" must be ≥ 0')
    # The three lists describe the same waves position by position, so a length that disagrees is
    # not a wave anybody can draw. The validator says this first and better; the generator keeps
    # its own copy for callers who build a gen through the library without validating.
    if len(amplitudes) > 1 and len(amplitudes) != len(periods):
        raise ValueError('timeseries: "amplitude" must have as many entries as "period"')
    if peaks and len(peaks) != len(periods):
        raise ValueError('timeseries: "peak_at" must have as many entries as "period"')

    waves = tuple(
        Wave(
            period=periods[k],
            # One amplitude for many periods is the shorthand for waves of equal height; the far
            # more common case is one of each, which reads the same.
            amplitude=(amplitudes[0] if len(amplitudes) == 1 else amplitudes[k])
            if amplitudes
            else 0.0,
            peak_at=peaks[k] if peaks else None,
        )
        for k in range(len(periods))
    )

    noise_sd = num("noise", 0)
    if noise_sd < 0:
        raise ValueError('timeseries: "noise" must be ≥ 0')
    noise_correlation = num("noise_correlation", 0)
    if not abs(noise_correlation) < 1:
        raise ValueError('timeseries: "noise_correlation" must be between -1 and 1')

    raw_decimals = attrs.get("decimals")
    blank = raw_decimals is None or not raw_decimals.strip()
    decimals = 0.0 if blank else numbers.parse(raw_decimals)
    if decimals != decimals or decimals != int(decimals) or decimals < 0:
        raise ValueError('timeseries: "decimals" must be a non-negative integer')

    return Spec(
        base=num("base", 0),
        trend=num("trend", 0),
        waves=waves,
        noise_sd=noise_sd,
        noise_correlation=noise_correlation,
        decimals=int(decimals),
    )


def standard_normal(u1: float, u2: float) -> float:
    """A standard normal deviate from two uniforms in (0,1), by Box–Muller."""
    return math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


def correlated_noise(spec: Spec, i: int, past: Callable[[int], float]) -> float:
    """The correlated noise at row ``i``, from the innovations of rows ``i − k``.

    ``past(k)`` hands back the innovation of row ``i − k``; the caller decides where it comes
    from, which is what lets a sequential walk keep a ring of 64 and a random access pay for 64
    lookups. The ARITHMETIC is the same either way — the same terms, added in the same order — so
    the two engines cannot disagree.

    The sum is divided by the length of its own weight vector, so **every row has the same
    spread**. Without that the first rows of a column would be visibly quieter than the rest —
    the window has fewer terms to add there — and a series that settles down after sixty rows is
    an artefact of the method, not of anything the config asked for.
    """
    if spec.noise_correlation == 0:
        return past(0)
    reach = min(i, NOISE_WINDOW)
    total = 0.0
    squares = 0.0
    weight = 1.0
    for k in range(reach + 1):
        total += weight * past(k)
        squares += weight * weight
        weight *= spec.noise_correlation
    return total / math.sqrt(squares)


def innovation_ring(draw: Callable[[int], float]) -> Callable[[int, int], float]:
    """A reader for the window's innovations that keeps them in a ring.

    The sum in :func:`correlated_noise` wants the innovations of the last 64 rows, and drawing
    each one costs a hash — 64 hashes a row would make correlated noise forty times the price of
    plain noise. Walking forward, though, 63 of those 64 were drawn for the row before, so the
    ring turns it back into ONE draw a row.

    It is a cache and nothing else. The arithmetic never changes — the same terms are added in the
    same order whether they came from the ring or from a fresh draw — so an engine that seeks and
    an engine that walks produce one series.

    ``draw`` is asked only for rows the walk has reached, in order, which is what lets the
    in-memory engine hand it a SEQUENTIAL generator: on that path there is no row to seek to, and
    the ring is the only reason the window can be read at all.
    """
    size = NOISE_WINDOW + 1
    ring = [0.0] * size
    have = -1  # the highest row in the ring; rows ``have - NOISE_WINDOW .. have`` are live

    def read(row: int, k: int) -> float:
        nonlocal have
        if row > have:
            # Forward by one on a sequential walk; a first touch deep into the column fills the
            # whole window at once, which is what a seeking engine wants.
            for r in range(max(0, max(row - NOISE_WINDOW, have + 1)), row + 1):
                ring[r % size] = draw(r)
            have = row
        want = row - k
        if want < 0:
            return 0.0  # before row zero there is nothing to remember
        # A jump backwards past the window re-draws, which costs one hash and cannot give a
        # different number.
        return ring[want % size] if want > have - size else draw(want)

    return read


def value_at(spec: Spec, i: int, e: float) -> float:
    """The layered value at row ``i``, with ``e`` as its (already correlated) noise sample."""
    v = spec.base + spec.trend * i
    for wave in spec.waves:
        if wave.period <= 0 or wave.amplitude == 0:
            continue
        # One formula for both. ``cos`` peaks where its argument is zero, so the wave peaks
        # exactly on ``peak``. The DEFAULT peak is a quarter period in, which is where a plain
        # ``sin(2π·i/period)`` already peaked — so a config without ``peak_at`` produces the
        # same bytes it always did, without a second branch saying so.
        peak = wave.period / 4 if wave.peak_at is None else wave.peak_at
        v += wave.amplitude * math.cos(2 * math.pi * (i - peak) / wave.period)
    if spec.noise_sd != 0:
        v += spec.noise_sd * e
    return v


def format_value(value: float, decimals: int) -> str:
    return numbers.to_fixed(value, decimals)
