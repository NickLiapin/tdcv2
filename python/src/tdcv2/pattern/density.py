"""The SECOND way to read the same drawing (``mode="density"``).

A signal reads the curve as a TRAJECTORY: the horizontal axis is the row index and the height is
that row's value, so the rows walk along the line in order. A density asks the opposite question —
the horizontal axis is the VALUE and the height is HOW OFTEN that value comes up. Draw a hump over
the middle and the numbers pile up in the middle, in random order.

That is "draw your own probability" instead of picking ``normal`` or ``poisson`` from a list, and
it is reachable from every input the pattern generator takes: inline points, an SVG, a photographed
sketch.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..lib import numbers
from .curve import Curve, height_at

# How many grid points the drawing is integrated on. Every drawn vertex is kept regardless; this
# only decides how finely the space between them is subdivided.
GRID = 512


@dataclass(frozen=True, slots=True)
class Density:
    xs: tuple[float, ...]
    dens: tuple[float, ...]
    """The height above the baseline at each grid point, never negative."""

    cdf: tuple[float, ...]
    """The normalised running area — inverting it turns a uniform draw into a value."""

    area: float
    y_range: tuple[float, float] | None
    decimals: int


def build(curve: Curve) -> Density:
    """A curve read as a distribution.

    Zero probability is the curve's BASELINE — the picture's floor for a raster, the lowest drawn
    point otherwise — so the deepest part of the drawing is the value that never appears. A drawing
    with no height at all is not an error: it has nothing to weight by, so it degrades to a
    uniform distribution.
    """
    vertices = curve.xs
    x_max = vertices[-1]

    grid: list[float] = []
    per = max(1, math.ceil(GRID / max(1, len(vertices) - 1)))
    for i in range(len(vertices) - 1):
        a, b = vertices[i], vertices[i + 1]
        for k in range(per):
            grid.append(a + (b - a) * k / per)
    grid.append(x_max)

    dens = [max(0.0, height_at(curve, x) - curve.y_min) for x in grid]
    cumulative = [0.0]
    total = 0.0
    for i in range(len(grid) - 1):
        h = grid[i + 1] - grid[i]
        total += h * (dens[i] + dens[i + 1]) / 2
        cumulative.append(total)

    if total <= 0:
        flat = [1.0] * len(grid)
        uniform = [(i / (len(grid) - 1) if len(grid) > 1 else 0.0) for i in range(len(grid))]
        return Density(
            tuple(grid), tuple(flat), tuple(uniform), x_max - grid[0], curve.y_range, curve.decimals
        )

    return Density(
        tuple(grid),
        tuple(dens),
        tuple(c / total for c in cumulative),
        total,
        curve.y_range,
        curve.decimals,
    )


def value_at(d: Density, u: float) -> float:
    """A uniform turned into a value.

    Inside a grid cell the density is a straight line, so the area up to ``s`` is a quadratic in
    ``s`` and the exact crossing is solved rather than searched. Bucketing would introduce a bias
    that is invisible in a histogram and obvious in a quantile.
    """
    target = min(max(u, 0.0), 1.0)

    lo, hi = 0, len(d.cdf) - 1
    while lo < hi:
        mid = (lo + hi + 1) >> 1
        if d.cdf[mid] <= target:
            lo = mid
        else:
            hi = mid - 1
    k = min(lo, len(d.xs) - 2)

    xa, xb = d.xs[k], d.xs[k + 1]
    h = xb - xa
    d0, d1 = d.dens[k], d.dens[k + 1]
    # What is left to cover inside this cell, in the same units as `dens * x`.
    cell_area = (target - d.cdf[k]) * d.area
    slope = d1 - d0

    if h <= 0:
        s = 0.0
    elif abs(slope) < 1e-12:
        s = 0.0 if d0 == 0 else min(1.0, cell_area / (h * d0))
    else:
        # (slope/2)·s² + d0·s − cell_area/h = 0
        c = -cell_area / h
        disc = max(0.0, d0 * d0 - 2 * slope * c)
        s = (-d0 + math.sqrt(disc)) / slope
        if s != s or s in (float("inf"), float("-inf")) or s < 0:
            s = 0.0
        if s > 1:
            s = 1.0
    x = xa + s * h

    if d.y_range is None:
        return x
    span = d.xs[-1] - d.xs[0]
    normalized = 0.0 if span == 0 else (x - d.xs[0]) / span
    a, b = d.y_range
    return a + normalized * (b - a)


def format_value(value: float, decimals: int) -> str:
    return numbers.to_fixed(value, decimals)
