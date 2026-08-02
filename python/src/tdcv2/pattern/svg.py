"""Reading a drawing out of an SVG file.

A file exported by any vector editor is mostly Bezier curves inside transformed groups, not the
straight ``M``/``L`` segments a naive reader assumes. So the document is walked with a transform
stack, every curve-ish element is read, curves and arcs are flattened into points, and the points
are mapped through the accumulated matrix.

Flattening is deterministic — a fixed subdivision count derived from the control polygon — because
the same file has to produce the same points in every implementation.

SVG's y axis points DOWN. It is flipped here, because for a graph "higher on the screen" has to
mean "a larger value".
"""

from __future__ import annotations

import math
import re

Point = tuple[float, float]
Matrix = tuple[float, float, float, float, float, float]

IDENTITY: Matrix = (1, 0, 0, 1, 0, 0)

_TRANSFORM = re.compile(r"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)")
_PATH_TOKEN = re.compile(r"[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][+-]?\d+)?")
_NUMBER = re.compile(r"-?\d*\.?\d+(?:[eE][+-]?\d+)?")
_TAG = re.compile(r"""<\/?([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>""")
_LETTER = re.compile(r"[A-Za-z]")


def graph_points(svg: str) -> list[Point]:
    """The curve to read a graph from: the one spanning the most horizontal space.

    A chart export usually carries axes, a frame and a legend as well. The data line is the widest
    path, so this picks the signal without anyone having to say which shape it is.
    """
    curves = collect(svg)
    if not curves:
        raise ValueError(
            "pattern: the SVG has no <path>/<polyline>/<polygon>/<line> to read a curve from"
        )
    best_points, best_width = max(curves, key=lambda c: c[1])
    if len(best_points) < 2 or best_width <= 0:
        raise ValueError(
            "pattern: the SVG curve has no horizontal extent to stretch over the cards"
        )
    return [(x, 0.0 if y == 0 else -y) for x, y in best_points]


def envelope(svg: str, samples: int = 600) -> tuple[list[Point], list[Point]]:
    """The drawing measured the way the raster reader measures it.

    At each position along the horizontal axis, the HIGHEST and the LOWEST point of every shape in
    the file. One stroke gives the same point twice — an exact value. Two strokes, or any closed
    outline (draw a car and it still has a top and a bottom), give two different points — a band.
    A single file may do both: run as one line and split into a corridor further along.
    """
    curves = collect(svg)
    if not curves:
        raise ValueError(
            "pattern: the SVG has no <path>/<polyline>/<polygon>/<line> to read a curve from"
        )
    # Flipped once: SVG grows downward, a graph grows upward.
    shapes = [[(x, 0.0 if y == 0 else -y) for x, y in points] for points, _ in curves]

    xs = [x for shape in shapes for x, _ in shape]
    x_min, x_max = min(xs), max(xs)
    if not x_max > x_min:
        raise ValueError(
            "pattern: the SVG curve has no horizontal extent to stretch over the cards"
        )

    # Measured AT THE DRAWN VERTICES, not on a uniform grid. A grid would replace the drawing with
    # a dense straight-line resampling, and there would be nothing left for interp="smooth" to
    # round off. Between two consecutive vertices every shape is a straight segment anyway, so the
    # vertices carry the whole shape.
    axis = sorted(set(xs))
    if len(axis) > samples:
        # Absurdly dense input — a huge flattened path. An even subset keeps the shape.
        step = len(axis) / samples
        thinned = [axis[math.floor(i * step)] for i in range(samples)]
        thinned.append(x_max)
        axis = sorted(set(thinned))

    top: list[Point] = []
    bottom: list[Point] = []
    for x in axis:
        lo = math.inf
        hi = -math.inf
        for shape in shapes:
            for k in range(1, len(shape)):
                ax, ay = shape[k - 1]
                bx, by = shape[k]
                if x < min(ax, bx) or x > max(ax, bx):
                    continue
                dx = bx - ax
                # A vertical segment covers a whole span of values at this x.
                ys = [ay, by] if dx == 0 else [ay + (x - ax) / dx * (by - ay)]
                lo = min(lo, *ys)
                hi = max(hi, *ys)
        if lo == math.inf:
            continue  # nothing drawn at this x
        top.append((x, hi))
        bottom.append((x, lo))

    if len(top) < 2:
        raise ValueError("pattern: the SVG has too little geometry to read a curve from")
    return top, bottom


def collect(svg: str) -> list[tuple[list[Point], float]]:
    """Every curve in the document, in user space, each with its horizontal extent.

    A hand-rolled tag scan rather than an XML parser: only element names, their attributes and the
    nesting of ``<g>`` matter here, and an editor's export is full of namespaces and metadata a
    strict parser would have opinions about.
    """
    found: list[tuple[list[Point], float]] = []
    stack: list[Matrix] = [IDENTITY]

    for hit in _TAG.finditer(svg):
        whole = hit.group()
        name = hit.group(1).lower()
        top = stack[-1]

        if whole.startswith("</"):
            if name in ("g", "svg") and len(stack) > 1:
                stack.pop()
            continue

        transform = _attr(whole, "transform")
        local = multiply(top, parse_transform(transform)) if transform else top

        if name in ("g", "svg"):
            if not whole.endswith("/>"):
                stack.append(local)
            continue

        raw = _shape_points(whole, name)
        if raw is None or len(raw) < 2:
            continue
        points = [apply(local, p) for p in raw]
        column = [p[0] for p in points]
        found.append((points, max(column) - min(column)))
    return found


def flatten_path(d: str) -> list[Point]:
    """A path ``d`` flattened into points — every command, absolute and relative.

    Sub-paths are concatenated. A graph is normally one, and a file that draws its line in two
    strokes is better read as one sequence than silently truncated to the first.
    """
    tokens = _PATH_TOKEN.findall(d)
    points: list[Point] = []
    i = 0
    cur: Point = (0.0, 0.0)
    start: Point = (0.0, 0.0)
    prev_cubic: Point | None = None
    prev_quad: Point | None = None
    command = ""

    def number() -> float:
        nonlocal i
        value = float(tokens[i]) if i < len(tokens) else 0.0
        i += 1
        return value

    while i < len(tokens):
        token = tokens[i]
        if not _LETTER.search(token):
            # An implicit repeat of the previous command; M becomes L, per the spec.
            if command == "M":
                command = "L"
            elif command == "m":
                command = "l"
        else:
            command = tokens[i]
            i += 1

        relative = command == command.lower()
        bx = cur[0] if relative else 0.0
        by = cur[1] if relative else 0.0
        head = command.upper()

        if head == "M":
            cur = (bx + number(), by + number())
            start = cur
            points.append(cur)
            prev_cubic = prev_quad = None
        elif head == "L":
            cur = (bx + number(), by + number())
            points.append(cur)
            prev_cubic = prev_quad = None
        elif head == "H":
            cur = (bx + number(), cur[1])
            points.append(cur)
            prev_cubic = prev_quad = None
        elif head == "V":
            cur = (cur[0], by + number())
            points.append(cur)
            prev_cubic = prev_quad = None
        elif head == "C":
            c1 = (bx + number(), by + number())
            c2 = (bx + number(), by + number())
            end = (bx + number(), by + number())
            points.extend(_cubic(cur, c1, c2, end))
            cur, prev_cubic, prev_quad = end, c2, None
        elif head == "S":
            c1 = _reflect(cur, prev_cubic)
            c2 = (bx + number(), by + number())
            end = (bx + number(), by + number())
            points.extend(_cubic(cur, c1, c2, end))
            cur, prev_cubic, prev_quad = end, c2, None
        elif head == "Q":
            c = (bx + number(), by + number())
            end = (bx + number(), by + number())
            points.extend(_quadratic(cur, c, end))
            cur, prev_quad, prev_cubic = end, c, None
        elif head == "T":
            c = _reflect(cur, prev_quad)
            end = (bx + number(), by + number())
            points.extend(_quadratic(cur, c, end))
            cur, prev_quad, prev_cubic = end, c, None
        elif head == "A":
            rx = number()
            ry = number()
            rotation = number()
            large = number() != 0
            sweep = number() != 0
            end = (bx + number(), by + number())
            points.extend(_arc(cur, rx, ry, rotation, large, sweep, end))
            cur = end
            prev_cubic = prev_quad = None
        elif head == "Z":
            cur = start
            points.append(cur)
            prev_cubic = prev_quad = None
        else:
            i += 1  # an unknown token, skipped so the loop never spins

    return points


def parse_transform(raw: str) -> Matrix:
    """An SVG ``transform`` attribute — a chain of primitives — as one matrix."""
    m = IDENTITY
    for hit in _TRANSFORM.finditer(raw):
        args = [float(s) for s in re.split(r"[\s,]+", hit.group(2).strip()) if s]
        m = multiply(m, _primitive(hit.group(1), args))
    return m


def multiply(m: Matrix, n: Matrix) -> Matrix:
    return (
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    )


def apply(m: Matrix, p: Point) -> Point:
    return (m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5])


def _primitive(name: str, a: list[float]) -> Matrix:
    def at(index: int, fallback: float) -> float:
        return a[index] if index < len(a) else fallback

    if name == "matrix":
        return (at(0, 1), at(1, 0), at(2, 0), at(3, 1), at(4, 0), at(5, 0))
    if name == "translate":
        return (1, 0, 0, 1, at(0, 0), at(1, 0))
    if name == "scale":
        sx = at(0, 1)
        return (sx, 0, 0, at(1, sx), 0, 0)
    if name == "rotate":
        radians = math.radians(at(0, 0))
        c, s = math.cos(radians), math.sin(radians)
        rotation: Matrix = (c, s, -s, c, 0, 0)
        if len(a) < 3:
            return rotation
        cx, cy = at(1, 0), at(2, 0)
        return multiply(multiply((1, 0, 0, 1, cx, cy), rotation), (1, 0, 0, 1, -cx, -cy))
    if name == "skewX":
        return (1, 0, math.tan(math.radians(at(0, 0))), 1, 0, 0)
    if name == "skewY":
        return (1, math.tan(math.radians(at(0, 0))), 0, 1, 0, 0)
    return IDENTITY


def _shape_points(tag: str, name: str) -> list[Point] | None:
    if name == "path":
        d = _attr(tag, "d")
        return flatten_path(d) if d else None
    if name in ("polyline", "polygon"):
        raw = _attr(tag, "points")
        return _points_attr(raw) if raw else None
    if name == "line":
        try:
            coords = [float(_attr(tag, key) or "") for key in ("x1", "y1", "x2", "y2")]
        except ValueError:
            return None
        if any(math.isnan(c) or math.isinf(c) for c in coords):
            return None
        return [(coords[0], coords[1]), (coords[2], coords[3])]
    return None


def _points_attr(raw: str) -> list[Point]:
    values = [float(n) for n in _NUMBER.findall(raw)]
    return [(values[k], values[k + 1]) for k in range(0, len(values) - 1, 2)]


def _attr(tag: str, name: str) -> str | None:
    double = re.search(rf'\b{name}\s*=\s*"([^"]*)"', tag, re.IGNORECASE)
    if double:
        return double.group(1)
    single = re.search(rf"\b{name}\s*=\s*'([^']*)'", tag, re.IGNORECASE)
    return single.group(1) if single else None


def _segments_for(*points: Point) -> int:
    """How finely a curve segment is split — deterministic, so all three ports agree."""
    length = sum(
        math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
        for i in range(1, len(points))
    )
    return min(64, max(4, math.ceil(length / 3)))


def _cubic(p0: Point, p1: Point, p2: Point, p3: Point) -> list[Point]:
    n = _segments_for(p0, p1, p2, p3)
    out = []
    for i in range(1, n + 1):
        t = i / n
        s = 1 - t
        s2, s3 = s * s, s * s * s
        t2, t3 = t * t, t * t * t
        out.append(
            (
                s3 * p0[0] + 3 * s2 * t * p1[0] + 3 * s * t2 * p2[0] + t3 * p3[0],
                s3 * p0[1] + 3 * s2 * t * p1[1] + 3 * s * t2 * p2[1] + t3 * p3[1],
            )
        )
    return out


def _quadratic(p0: Point, p1: Point, p2: Point) -> list[Point]:
    # A quadratic is a cubic with lifted control points.
    c1 = (p0[0] + 2 / 3 * (p1[0] - p0[0]), p0[1] + 2 / 3 * (p1[1] - p0[1]))
    c2 = (p2[0] + 2 / 3 * (p1[0] - p2[0]), p2[1] + 2 / 3 * (p1[1] - p2[1]))
    return _cubic(p0, c1, c2, p2)


def _reflect(current: Point, previous: Point | None) -> Point:
    """The smooth-continuation control point: the previous one mirrored through the current."""
    if previous is None:
        return current
    return (2 * current[0] - previous[0], 2 * current[1] - previous[1])


def _arc(
    p0: Point,
    rx0: float,
    ry0: float,
    rotation_deg: float,
    large_arc: bool,
    sweep: bool,
    p1: Point,
) -> list[Point]:
    """An endpoint-parametrized elliptical arc into points, per SVG F.6.5."""
    rx, ry = abs(rx0), abs(ry0)
    if rx == 0 or ry == 0:
        return [p1]  # degenerate, so a straight line

    phi = math.radians(rotation_deg)
    cos_p, sin_p = math.cos(phi), math.sin(phi)
    dx = (p0[0] - p1[0]) / 2
    dy = (p0[1] - p1[1]) / 2
    x1 = cos_p * dx + sin_p * dy
    y1 = -sin_p * dx + cos_p * dy

    lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry)
    if lam > 1:
        k = math.sqrt(lam)
        rx *= k
        ry *= k

    denominator = rx * rx * y1 * y1 + ry * ry * x1 * x1
    numerator = max(0.0, rx * rx * ry * ry - denominator)
    coefficient = (-1 if large_arc == sweep else 1) * math.sqrt(
        0.0 if denominator == 0 else numerator / denominator
    )
    cx1 = coefficient * rx * y1 / ry
    cy1 = -coefficient * ry * x1 / rx
    cx = cos_p * cx1 - sin_p * cy1 + (p0[0] + p1[0]) / 2
    cy = sin_p * cx1 + cos_p * cy1 + (p0[1] + p1[1]) / 2

    def angle(ux: float, uy: float, vx: float, vy: float) -> float:
        dot = ux * vx + uy * vy
        length = math.hypot(ux, uy) * math.hypot(vx, vy)
        a = math.acos(min(1.0, max(-1.0, 1.0 if length == 0 else dot / length)))
        return -a if ux * vy - uy * vx < 0 else a

    theta = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
    delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
    if not sweep and delta > 0:
        delta -= 2 * math.pi
    if sweep and delta < 0:
        delta += 2 * math.pi

    n = min(64, max(6, math.ceil(abs(delta) / math.pi * 24)))
    out = []
    for i in range(1, n + 1):
        t = theta + delta * i / n
        ex = rx * math.cos(t)
        ey = ry * math.sin(t)
        out.append((cos_p * ex - sin_p * ey + cx, sin_p * ex + cos_p * ey + cy))
    return out
