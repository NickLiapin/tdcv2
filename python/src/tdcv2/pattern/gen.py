"""``<gen type="pattern">`` — the resolved drawing, whatever it was drawn with.

Four inputs reach the same place: a points list in the config, an ``upper``/``lower`` pair, an SVG
exported from a drawing tool, and a PNG of a sketch. By the time they get here each has produced
the same thing — a per-position "highest point, lowest point" reading — so the rules below are
written once instead of four times.

Where the two readings coincide the drawing is a single line and the value is exact. Where they
stand apart it is a band and the value is drawn between them. One picture can therefore be a firm
line for the first half of a run and widen into a corridor for the second, which is exactly what a
hand-drawn line does.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..generators import file as file_gen
from ..lib import numbers
from . import curve as curves
from . import density as densities
from . import png, svg
from .png import luminance


@dataclass(frozen=True, slots=True)
class Pattern:
    """One drawing, resolved: a signal, a corridor, or a distribution."""

    kind: str
    curve: curves.Curve | None = None
    corridor: curves.Corridor | None = None
    density: densities.Density | None = None
    spread: float = 0.0


def from_points(attrs: dict[str, str], points: list[tuple[float, float]]) -> Pattern:
    return Pattern(
        "signal",
        curve=curves.build(
            points,
            curves.parse_y_range(attrs.get("y_range")),
            curves.parse_decimals(attrs),
            None,
            curves.parse_interp(attrs.get("interp")),
        ),
        spread=curves.parse_spread(attrs),
    )


def from_edges(
    attrs: dict[str, str],
    upper_points: list[tuple[float, float]],
    lower_points: list[tuple[float, float]] | None,
) -> Pattern:
    return Pattern(
        "corridor",
        corridor=curves.build_corridor(
            upper_points,
            lower_points,
            curves.parse_y_range(attrs.get("y_range")),
            curves.parse_decimals(attrs),
            curves.parse_interp(attrs.get("interp")),
        ),
        spread=curves.parse_spread(attrs),
    )


def from_envelope(
    top: list[tuple[float, float]],
    bottom: list[tuple[float, float]],
    attrs: dict[str, str],
    norm_extent: tuple[float, float] | None = None,
) -> Pattern:
    """A per-position highest/lowest measurement turned into a pattern.

    A picture that never parts is a plain signal and spends no random draw at all; as soon as it
    parts anywhere the pattern draws per row, and the positions that still touch keep returning
    their exact value, because a zero-width band ignores the draw.
    """
    y_range = curves.parse_y_range(attrs.get("y_range"))
    decimals = curves.parse_decimals(attrs)
    interp = curves.parse_interp(attrs.get("interp"))
    spread = curves.parse_spread(attrs)

    banded = any(abs(a[1] - b[1]) > 1e-9 for a, b in zip(top, bottom, strict=False))
    if not banded:
        return Pattern(
            "signal",
            curve=curves.build(top, y_range, decimals, norm_extent, interp),
            spread=spread,
        )

    heights = [p[1] for p in top] + [p[1] for p in bottom]
    # ONE canvas for both curves. Measuring them separately would let each fill the range on
    # its own, so a narrow band and a wide one would come out the same width.
    extent = (
        norm_extent
        if norm_extent is not None
        else curves.vector_canvas(min(heights), max(heights))
    )
    return Pattern(
        "corridor",
        corridor=curves.Corridor(
            lower=curves.build(bottom, y_range, decimals, extent, interp),
            upper=curves.build(top, y_range, decimals, extent, interp),
            decimals=decimals,
        ),
        spread=spread,
    )


def from_raster(image: png.Image, attrs: dict[str, str]) -> Pattern:
    """A decoded picture turned into a pattern.

    Each image column becomes a position on the horizontal axis; the ink in that column defines the
    height. The image's full height maps to ``y_range`` — the frame is the scale — so only the
    drawing's shape matters and not how many pixels it was drawn at.

    A pixel is INK BY ALPHA when the picture has no opaque background: a drawing exported on
    transparency has no background at all, so every opaque pixel is the line. Only when the picture
    is flattened onto an opaque canvas does "dark is ink" apply, with ``ink_threshold`` as the
    cutoff.
    """
    width, height, rgba = image.width, image.height, image.rgba
    cutoff = _ink_threshold(attrs) * 255
    opaque_only = not _has_opaque_background(rgba)

    def is_ink(x: int, y: int) -> bool:
        p = (y * width + x) * 4
        if rgba[p + 3] < 128:
            return False  # transparent, so background
        if opaque_only:
            return True
        return luminance(rgba[p], rgba[p + 1], rgba[p + 2]) <= cutoff

    # Each column is measured twice — from the top down to the first ink and from the bottom up.
    # Where the two readings meet on one pixel the column is an exact point on the graph; where
    # they stand apart it is a band.
    top: list[tuple[float, float]] = []
    bottom: list[tuple[float, float]] = []
    for x in range(width):
        rows = [y for y in range(height) if is_ink(x, y)]
        if not rows:
            continue  # an empty column — a gap in the stroke, interpolated across
        first, last = rows[0], rows[-1]
        if last - first <= 1:
            # Touching within one pixel: a single line, not a band.
            middle = height - 1 - (first + last) / 2
            top.append((x, middle))
            bottom.append((x, middle))
        else:
            top.append((x, height - 1 - first))
            bottom.append((x, height - 1 - last))

    if len(top) < 2:
        raise ValueError("pattern: the image has too little ink to read a curve from")
    return from_envelope(top, bottom, attrs, (0.0, float(height - 1)))


def _has_opaque_background(rgba: bytearray) -> bool:
    """True when the picture is flattened onto an opaque canvas, with no alpha cut-out."""
    return all(rgba[p] >= 128 for p in range(3, len(rgba), 4))


def _ink_threshold(attrs: dict[str, str]) -> float:
    raw = attrs.get("ink_threshold")
    if raw is None or not raw.strip():
        return 0.5
    value = numbers.parse(raw)
    if value != value or value <= 0 or value >= 1:
        raise ValueError('pattern: "ink_threshold" must be a number strictly between 0 and 1')
    return value


def as_density(pattern: Pattern) -> Pattern:
    """The same drawing re-read as a distribution.

    Every input path has by then produced a curve in one common shape, so this is a single
    conversion at the end rather than a branch in each reader. A band contributes its TOP edge: the
    outline is the distribution, whatever the drawing's lower edge does.
    """
    if pattern.kind == "density":
        return pattern
    if pattern.spread > 0:
        raise ValueError(
            'pattern: "spread" has no meaning with mode="density" '
            "— the drawing itself sets the scatter"
        )
    source = pattern.corridor.upper if pattern.kind == "corridor" else pattern.curve
    assert source is not None
    return Pattern("density", density=densities.build(source))


def value_at(pattern: Pattern, t: float, u: float) -> str:
    """The value of the row at position ``t``.

    ``u`` is that row's uniform, used when there is a band to pick from — a corridor, a spread, or
    a density.
    """
    if pattern.kind == "density":
        assert pattern.density is not None
        # Position in the run means nothing here: the drawing is a distribution, so the row's own
        # draw picks the value and the order is random.
        return densities.format_value(
            densities.value_at(pattern.density, u), pattern.density.decimals
        )

    if pattern.kind == "signal":
        assert pattern.curve is not None
        v = curves.value_at(pattern.curve, t)
        if pattern.spread > 0:
            v += (2 * u - 1) * pattern.spread
        return curves.format_value(v, pattern.curve.decimals)

    assert pattern.corridor is not None
    a = curves.value_at(pattern.corridor.lower, t)
    b = curves.value_at(pattern.corridor.upper, t)
    lo = min(a, b) - pattern.spread
    hi = max(a, b) + pattern.spread
    return curves.format_value(lo + u * (hi - lo), pattern.corridor.decimals)


def draws(pattern: Pattern) -> bool:
    """Whether the pattern consumes a uniform per row — a band, a spread, or a density."""
    return pattern.kind != "signal" or pattern.spread > 0


def of(attrs: dict[str, str], base_dir=None, roots=None) -> Pattern:
    """The drawing a ``<gen type="pattern">`` names, whichever way it names one.

    ``upper`` (with an optional ``lower``) is a corridor; otherwise ``points`` or ``src`` is a
    single curve. ``mode="density"`` asks a different question of the SAME drawing — how often a
    value occurs, instead of which row gets it — so it is applied once at the end, after whichever
    reader produced the curve, rather than as a branch inside each reader.
    """
    upper = attrs.get("upper")
    if upper is not None and upper.strip():
        lower = attrs.get("lower")
        resolved = from_edges(
            attrs,
            curves.parse_points(upper),
            curves.parse_points(lower) if lower and lower.strip() else None,
        )
    else:
        points_raw = attrs.get("points")
        if points_raw is not None and points_raw.strip():
            resolved = from_points(attrs, curves.parse_points(points_raw))
        else:
            src = attrs.get("src")
            if src is None or not src.strip():
                raise ValueError(
                    'sequence: <gen type="pattern"> needs "points"/"src", or "upper"[/"lower"]'
                )
            data = file_gen.resolve(src.strip(), base_dir, roots).read_bytes()
            if png.is_png(data):
                resolved = from_raster(png.decode(data), attrs)
            else:
                # A vector file is measured exactly like a picture: highest and lowest point at
                # each position. One stroke gives exact values; two strokes or a closed outline
                # give a band, and a file may switch from one to the other.
                top, bottom = svg.envelope(data.decode("utf-8"))
                resolved = from_envelope(top, bottom, attrs)

    if curves.parse_mode(attrs.get("mode")) == "density":
        resolved = as_density(resolved)
    return resolved
