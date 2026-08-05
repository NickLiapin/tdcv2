"""``<gen type="timeseries">`` — a column that moves the way measured things move.

    value(i) = base + trend·i + amplitude·cos(2π·(i − peak)/period) + noise·z

A drift, one seasonal wave, and gaussian noise over the row index as the time axis. Sales,
sensors, traffic and queue depths all look like this; none of them look like flat uniform noise,
and a dashboard tested against flat noise has never had its trend line or its seasonality checked.

Like a counter it depends on the ABSOLUTE row index, so both engines hand it the real index rather
than a position within a chunk. The noise is one standard-normal draw per row, which keeps the
series seekable: row nine million is computable without the rows before it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..lib import numbers


@dataclass(frozen=True, slots=True)
class Spec:
    base: float
    trend: float
    period: float
    """The seasonal period in rows; zero switches seasonality off."""

    amplitude: float

    noise_sd: float
    """The standard deviation of the gaussian noise; zero switches it off."""

    decimals: int

    peak_at: float | None = None
    """Which row the wave peaks on, or None for the classic sine.

    A plain ``sin(2π·i/period)`` crosses zero at row 0 and peaks a QUARTER PERIOD later, so a
    year of daily rows peaks in early April — the one season nobody means by "warmer in
    summer". ``peak_at`` names the ROW instead of a shift, because the row is what the author
    knows: 182 of 365 is the first of July. Last in the record because it is the only field
    with a default, and a dataclass wants those at the end.
    """

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

    period = num("period", 0)
    noise_sd = num("noise", 0)
    if period < 0:
        raise ValueError('timeseries: "period" must be ≥ 0')
    if noise_sd < 0:
        raise ValueError('timeseries: "noise" must be ≥ 0')

    raw_decimals = attrs.get("decimals")
    blank = raw_decimals is None or not raw_decimals.strip()
    decimals = 0.0 if blank else numbers.parse(raw_decimals)
    if decimals != decimals or decimals != int(decimals) or decimals < 0:
        raise ValueError('timeseries: "decimals" must be a non-negative integer')

    return Spec(
        base=num("base", 0),
        trend=num("trend", 0),
        period=period,
        amplitude=num("amplitude", 0),
        peak_at=(
            None
            if attrs.get("peak_at") is None or not str(attrs["peak_at"]).strip()
            else num("peak_at", 0)
        ),
        noise_sd=noise_sd,
        decimals=int(decimals),
    )


def standard_normal(u1: float, u2: float) -> float:
    """A standard normal deviate from two uniforms in (0,1), by Box–Muller."""
    return math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


def value_at(spec: Spec, i: int, z: float) -> float:
    """The layered value at row ``i``, with ``z`` as its standard-normal noise sample."""
    v = spec.base + spec.trend * i
    if spec.period > 0 and spec.amplitude != 0:
        # One formula for both. ``cos`` peaks where its argument is zero, so the wave peaks
        # exactly on ``peak``. The DEFAULT peak is a quarter period in, which is where a plain
        # ``sin(2π·i/period)`` already peaked — so a config without ``peak_at`` produces the
        # same bytes it always did, without a second branch saying so.
        peak = spec.period / 4 if spec.peak_at is None else spec.peak_at
        v += spec.amplitude * math.cos(2 * math.pi * (i - peak) / spec.period)
    if spec.noise_sd != 0:
        v += spec.noise_sd * z
    return v


def format_value(value: float, decimals: int) -> str:
    return numbers.to_fixed(value, decimals)
