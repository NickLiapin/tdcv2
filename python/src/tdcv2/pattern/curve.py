"""A drawn curve stretched over the rows.

The curve's HORIZONTAL axis is the row index: row ``i`` of ``count`` reads the curve at
``t = i/(count−1)``, so a small drawing — a hundred pixels, a handful of points — is interpolated
onto however many rows are asked for, one or a million. The VERTICAL axis is the value; a drawing
has no inherent scale, so ``y_range="min..max"`` declares what its height means and only the SHAPE
carries over.

This is the thing no distribution name gives you: a shape someone has in mind. "Quiet until March,
then a ramp, then a plateau with a dip at the end" is one drawing and no combination of ``normal``
and ``poisson``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..lib import numbers

INTERPOLATIONS = ("linear", "smooth", "step")


@dataclass(frozen=True, slots=True)
class Curve:
    xs: tuple[float, ...]
    """The point x-coordinates, sorted — the horizontal shape."""

    ys: tuple[float, ...]
    """The drawn height at each x."""

    y_min: float
    y_max: float
    """The height extent ``y_range`` normalises against; a corridor shares one across both edges."""

    y_range: tuple[float, float] | None
    decimals: int
    interp: str
    slopes: tuple[float, ...] | None = None
    """Monotone-cubic tangents, precomputed when the reading is ``smooth``."""


@dataclass(frozen=True, slots=True)
class Corridor:
    """Two curves in one value space; the value is drawn at random between them."""

    lower: Curve
    upper: Curve
    decimals: int


def parse_interp(raw: str | None) -> str:
    """``interp="linear|smooth|step"``.

    ``linear`` follows the straight segment — faithful to a polyline, but when one segment is
    stretched over thousands of rows the values climb by an identical step every time, which reads
    as obviously artificial. ``smooth`` runs a monotone cubic through the points instead: it eases
    in and out of every point and, unlike an ordinary spline, never overshoots beyond the drawn
    values — which matters when the drawing IS the specification. ``step`` holds each value until
    the next point.
    """
    if raw is None or not raw.strip():
        return "linear"
    value = raw.strip().lower()
    if value not in INTERPOLATIONS:
        raise ValueError('pattern: "interp" must be "linear", "smooth" or "step"')
    return value


def parse_mode(raw: str | None) -> str:
    """``mode="signal|density"`` — which question the drawing answers."""
    if raw is None or not raw.strip():
        return "signal"
    value = raw.strip().lower()
    if value not in ("signal", "density"):
        raise ValueError(
            'pattern: "mode" must be "signal" (a trajectory) or "density" (a distribution)'
        )
    return value


def parse_points(raw: str) -> list[tuple[float, float]]:
    """A points list into pairs.

    Both ``"x,y x,y"`` and SVG's space-separated ``"x y x y"`` work: every number is extracted and
    the numbers are paired. A points list gets copied out of an editor as often as it gets typed,
    and the two spellings are indistinguishable in intent.
    """
    found = re.findall(r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", raw)
    if not found or len(found) % 2 != 0:
        raise ValueError(
            f'pattern: points must be an even list of "x,y" coordinates (got {len(found)} numbers)'
        )
    values = [float(n) for n in found]
    return [(values[i], values[i + 1]) for i in range(0, len(values), 2)]


def parse_y_range(raw: str | None) -> tuple[float, float] | None:
    if raw is None or not raw.strip():
        return None
    parts = raw.split("..")
    if len(parts) != 2:
        raise ValueError(f'pattern: y_range "{raw}" must be "min..max" with two numbers')
    a, b = numbers.parse(parts[0]), numbers.parse(parts[1])
    if a != a or b != b or a in (float("inf"), float("-inf")) or b in (float("inf"), float("-inf")):
        raise ValueError(f'pattern: y_range "{raw}" must be "min..max" with two numbers')
    return a, b


def parse_decimals(attrs: dict[str, str]) -> int:
    raw = attrs.get("decimals")
    value = 0.0 if raw is None or not raw.strip() else numbers.parse(raw)
    if value != value or value != int(value) or value < 0:
        raise ValueError('pattern: "decimals" must be a non-negative integer')
    return int(value)


def parse_spread(attrs: dict[str, str]) -> float:
    """``spread="N"`` — the half-width of the random band around the drawing, in value units.

    A single drawn line becomes the CENTRE of a tunnel without drawing both edges by hand. It
    follows whatever scale ``y_range`` sets, so on a 0..1 axis a spread of 0.001 is the natural way
    to ask for a barely-there wobble. Left at zero the line stays exactly predictable.
    """
    raw = attrs.get("spread")
    if raw is None or not raw.strip():
        return 0.0
    value = numbers.parse(raw)
    if value != value or value in (float("inf"), float("-inf")) or value < 0:
        raise ValueError('pattern: "spread" must be a non-negative number')
    return value


def build(
    points: list[tuple[float, float]],
    y_range: tuple[float, float] | None,
    decimals: int,
    norm_extent: tuple[float, float] | None = None,
    interp: str = "linear",
) -> Curve:
    if len(points) < 2:
        raise ValueError("pattern: need at least two points to define a curve")
    ordered = sorted(points, key=lambda p: p[0])
    xs = tuple(p[0] for p in ordered)
    ys = tuple(p[1] for p in ordered)
    extent = norm_extent if norm_extent is not None else (min(ys), max(ys))
    return Curve(
        xs,
        ys,
        extent[0],
        extent[1],
        y_range,
        decimals,
        interp,
        _pchip_slopes(xs, ys) if interp == "smooth" else None,
    )


def build_corridor(
    upper_points: list[tuple[float, float]],
    lower_points: list[tuple[float, float]] | None,
    y_range: tuple[float, float] | None,
    decimals: int,
    interp: str = "linear",
) -> Corridor:
    """A corridor from an upper edge and an optional lower one; omitted means a flat floor at 0.

    Both edges are normalised against their SHARED height extent, so the band between them means
    something. Normalising each against its own would make a narrow band and a wide one look
    identical.
    """
    heights = [p[1] for p in upper_points] + [p[1] for p in (lower_points or [])]
    if lower_points is None:
        heights.append(0.0)
    extent = (min(heights), max(heights))

    upper = build(upper_points, y_range, decimals, extent, interp)
    if lower_points is not None:
        lower = build(lower_points, y_range, decimals, extent, interp)
    else:
        x0 = upper_points[0][0]
        xn = upper_points[-1][0]
        lower = build([(x0, extent[0]), (xn, extent[0])], y_range, decimals, extent, interp)
    return Corridor(lower, upper, decimals)


def value_at(curve: Curve, t: float, dt: float = 0) -> float:
    """The value of the row at position ``t`` in [0,1].

    ``dt`` is how much of the drawing ONE row covers. When the rows outnumber the points that
    window is shorter than a segment and the reading is simply the point on the curve. When the
    drawing has MORE points than there are rows — a thousand-point trace squeezed into ten — each
    row averages the curve across its whole window instead, so the detail in between is summarised
    rather than silently dropped by landing on one arbitrary sample.
    """
    x0 = curve.xs[0]
    xn = curve.xs[-1]
    span = xn - x0

    half = dt / 2
    xa = x0 + min(max(t - half, 0.0), 1.0) * span
    xb = x0 + min(max(t + half, 0.0), 1.0) * span
    inside = _segment_at(curve.xs, xb) - _segment_at(curve.xs, xa) if dt > 0 else 0

    if inside <= 0:
        y = _height_at(curve, x0 + min(max(t, 0.0), 1.0) * span)
    else:
        steps = min(64, max(2, inside * 2))
        total = 0.0
        for i in range(steps + 1):
            weight = 0.5 if i in (0, steps) else 1.0  # trapezoid ends count half
            total += weight * _height_at(curve, xa + (xb - xa) * i / steps)
        y = total / steps

    if curve.y_range is None:
        return y
    vspan = curve.y_max - curve.y_min
    normalized = 0.0 if vspan == 0 else (y - curve.y_min) / vspan
    a, b = curve.y_range
    return a + normalized * (b - a)


def corridor_value_at(corridor: Corridor, t: float, u: float, dt: float = 0) -> float:
    a = value_at(corridor.lower, t, dt)
    b = value_at(corridor.upper, t, dt)
    lo, hi = min(a, b), max(a, b)
    return lo + u * (hi - lo)


def format_value(value: float, decimals: int) -> str:
    return numbers.to_fixed(value, decimals)


def height_at(curve: Curve, x: float) -> float:
    """The drawn height at a horizontal coordinate — what a density integrates."""
    return _height_at(curve, x)


def segment_at(xs: tuple[float, ...], x: float) -> int:
    return _segment_at(xs, x)


def _pchip_slopes(xs: tuple[float, ...], ys: tuple[float, ...]) -> tuple[float, ...]:
    """Fritsch–Carlson tangents.

    The slope at a point is a weighted harmonic mean of its neighbouring secants, forced to zero
    wherever the data turns. That is exactly what keeps the smoothed curve inside the drawn
    values: an ordinary spline would overshoot, and a drawing that says "never above 100" would
    quietly produce 104.
    """
    n = len(xs)
    h = [xs[i + 1] - xs[i] for i in range(n - 1)]
    d = [0.0 if h[i] == 0 else (ys[i + 1] - ys[i]) / h[i] for i in range(n - 1)]

    m = [0.0] * n
    m[0] = d[0]
    m[n - 1] = d[n - 2]
    for i in range(1, n - 1):
        if d[i - 1] * d[i] <= 0:
            m[i] = 0.0
            continue
        w1 = 2 * h[i] + h[i - 1]
        w2 = h[i] + 2 * h[i - 1]
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i])
    return tuple(m)


def _segment_at(xs: tuple[float, ...], x: float) -> int:
    """The index of the segment ``[xs[k], xs[k+1]]`` that holds ``x``."""
    lo, hi = 0, len(xs) - 1
    while lo < hi:
        mid = (lo + hi + 1) >> 1
        if xs[mid] <= x:
            lo = mid
        else:
            hi = mid - 1
    return min(lo, len(xs) - 2)


def _height_at(curve: Curve, x: float) -> float:
    k = _segment_at(curve.xs, x)
    xa, xb = curve.xs[k], curve.xs[k + 1]
    ya, yb = curve.ys[k], curve.ys[k + 1]
    dx = xb - xa
    if dx <= 0:
        return ya
    s = (x - xa) / dx
    if curve.interp == "step":
        return ya
    if curve.interp == "smooth" and curve.slopes is not None:
        # Cubic Hermite on the segment, with the monotone tangents.
        ma, mb = curve.slopes[k], curve.slopes[k + 1]
        s2 = s * s
        s3 = s2 * s
        return (
            (2 * s3 - 3 * s2 + 1) * ya
            + (s3 - 2 * s2 + s) * dx * ma
            + (-2 * s3 + 3 * s2) * yb
            + (s3 - s2) * dx * mb
        )
    return ya + s * (yb - ya)
