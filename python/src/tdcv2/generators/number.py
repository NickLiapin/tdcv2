"""``<gen type="number">`` — the workhorse.

Five separate ideas share one generator because they share one question, "what number goes here":
a plain range, a list of ranges, a digit count, decimals, and a set of holes punched out with
``include``/``exclude``. Splitting them into five generators would make the common case — a range
— require choosing between them.

Zero-padding is decided by how the bounds were WRITTEN, not by how large they are: ``0001..9999``
pads to four and ``1..9999`` does not. A postcode and a quantity are both numbers, and only the
config knows which one is meant.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from ..distribution import hamilton, percent_mask
from ..prng import rand
from ..prng.prng import Sfc32

_RANGE = re.compile(r"^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$")
_INT = re.compile(r"^-?\d+$")
_LENGTH_RANGE = re.compile(r"^(\d+)\s*-\s*(\d+)$")
_DIGITS_ONLY = re.compile(r"^\d+$")


@dataclass(frozen=True, slots=True)
class Range:
    """An inclusive integer range; ``width`` is the zero-padding the source text implied."""

    min: int
    max: int
    width: int


@dataclass(frozen=True, slots=True)
class Interval:
    min: int
    max: int


@dataclass(frozen=True, slots=True)
class LengthChoice:
    """One entry of ``length="2,10-12"``: a fixed width, or a range of them."""

    min: int
    max: int


def generate(attrs: dict[str, str], count: int, prng: Sfc32) -> list[str]:
    """``count`` numbers, as the attributes describe them."""
    range_spec = attrs.get("value", "").strip()
    ranges = [] if not range_spec else parse_ranges(range_spec)

    has_explicit_length = attrs.get("length") is not None
    if has_explicit_length:
        length_choices = parse_length_choices(attrs["length"])
    elif not ranges:
        length_choices = [LengthChoice(1, 1)]
    else:
        length_choices = []

    first_zero = attrs.get("first_zero")
    allow_leading_zero = (
        first_zero.strip().lower() == "true"
        if first_zero is not None
        else bool(ranges) or not has_explicit_length
    )

    percent = attrs.get("percent")
    if percent is not None and len(length_choices) <= 1:
        # It cannot select anything with one choice, but a mask that is wrong should still say so.
        percent_mask.expand(percent, len(length_choices))

    include = attrs.get("include")
    exclude = attrs.get("exclude")
    has_modifiers = bool(include and include.strip()) or bool(exclude and exclude.strip())

    allowed: list[Interval] | None = None
    allowed_width = 0
    if has_modifiers:
        if not ranges:
            raise ValueError(
                'number generator: include/exclude require a numeric range in "value", '
                'e.g. value="0..9"'
            )
        allowed = compute_allowed(ranges, include, exclude)
        allowed_width = next((r.width for r in ranges if r.width > 0), 0)

    decimals = _parse_decimals(attrs.get("decimals"))
    if decimals > 0 and ranges and allowed is None:
        return [_random_decimal(ranges, decimals, prng) for _ in range(count)]

    widths = _materialize_widths(count, length_choices, percent, prng)
    out: list[str] = []
    for i in range(count):
        width = widths[i]
        if allowed is not None:
            out.append(_draw_guarded(allowed, width or allowed_width, allow_leading_zero, prng))
        elif not ranges:
            out.append(_digit_string(width, allow_leading_zero, prng))
        else:
            out.append(_draw_guarded_range(ranges, width, allow_leading_zero, prng))
    return out


def weighted_length_choices(attrs: dict[str, str]) -> list[LengthChoice] | None:
    """The length groups ``percent=`` apportions between, or ``None`` when there is no split.

    Which group a row lands in is an exact quota over the whole column, so the streaming engine
    has to plan it rather than draw it — with one row to apportion, the largest share takes
    everything and an 85/15 split silently becomes 100/0.
    """
    length = attrs.get("length")
    percent = attrs.get("percent")
    if length is None or percent is None or not percent.strip():
        return None
    try:
        choices = parse_length_choices(length)
    except ValueError:
        return None
    return choices if len(choices) > 1 else None


def pin_length(attrs: dict[str, str], group: LengthChoice) -> dict[str, str]:
    """The same attributes pinned to one length group, with ``percent`` dropped."""
    out = {k: v for k, v in attrs.items() if k not in ("percent", "length")}
    out["length"] = str(group.min) if group.min == group.max else f"{group.min}-{group.max}"
    return out


def parse_ranges(source: str) -> list[Range]:
    """``0..9``, ``bit``, or a bracketed list of ranges."""
    spec = source.strip()
    if not spec:
        raise ValueError("number generator: range is empty")
    if spec == "bit":
        return [Range(0, 1, 0)]
    if "[" not in spec and "]" not in spec:
        return [_parse_range(spec)]

    ranges: list[Range] = []
    rest = spec
    while rest:
        # Found by index, not by a regex. ``^\[\s*([^\]]+?)\s*\]`` said the same
        # thing, but ``\s*`` and ``[^\]]+?`` can both match a space, so an
        # unclosed bracket made the engine try every way to split the run
        # between them: ``value="["`` followed by four thousand spaces took a
        # minute. A generator hanging on its own config is not a slow path, it
        # is a stopped program.
        close = rest.find("]") if rest.startswith("[") else -1
        if close < 0:
            raise ValueError(f'number generator: invalid range list "{source}"')
        ranges.append(_parse_range(rest[1:close].strip()))
        rest = rest[close + 1 :].strip()
        if not rest:
            break
        if not rest.startswith(","):
            raise ValueError(f'number generator: invalid range list "{source}"')
        rest = rest[1:].strip()
        if not rest:
            raise ValueError(f'number generator: invalid range list "{source}"')
    return ranges


def _parse_range(text: str) -> Range:
    m = _RANGE.match(text)
    if not m:
        raise ValueError(f'number generator: invalid range "{text}" (expected MIN..MAX)')
    min_text, max_text = m.group(1), m.group(2)
    minimum, maximum = int(min_text), int(max_text)
    if minimum > maximum:
        raise ValueError(f'number generator: invalid numeric range "{text}"')
    return Range(minimum, maximum, _infer_width(min_text, max_text))


def _infer_width(min_text: str, max_text: str) -> int:
    """Zero-padding is implied by the way the bounds were written, never by their magnitude."""
    if min_text.startswith("-") or max_text.startswith("-"):
        return 0
    has_leading_zeros = (len(min_text) > 1 and min_text.startswith("0")) or (
        len(max_text) > 1 and max_text.startswith("0")
    )
    return max(len(min_text), len(max_text)) if has_leading_zeros else 0


def parse_length_choices(source: str) -> list[LengthChoice]:
    spec = source.strip()
    if not spec:
        raise ValueError("number generator: length is empty")
    out: list[LengthChoice] = []
    for raw in spec.split(","):
        part = raw.strip()
        if _DIGITS_ONLY.match(part):
            n = int(part)
            out.append(_to_length_choice(n, n, source))
            continue
        m = _LENGTH_RANGE.match(part)
        if m:
            out.append(_to_length_choice(int(m.group(1)), int(m.group(2)), source))
            continue
        raise ValueError(f'number generator: invalid length "{source}"')
    return out


def _to_length_choice(minimum: int, maximum: int, source: str) -> LengthChoice:
    if minimum <= 0 or maximum <= 0 or minimum > maximum:
        raise ValueError(f'number generator: invalid length "{source}"')
    return LengthChoice(minimum, maximum)


def _parse_decimals(raw: str | None) -> int:
    if raw is None:
        return 0
    try:
        value = int(raw.strip())
    except ValueError:
        raise ValueError(f'number decimals must be an integer 0..10, got "{raw}"') from None
    if value < 0 or value > 10:
        raise ValueError(f'number decimals must be an integer 0..10, got "{raw}"')
    return value


def _parse_interval_list(source: str, label: str) -> list[Interval]:
    spec = source.strip()
    if not spec:
        raise ValueError(f"number generator: {label} is empty")
    out: list[Interval] = []
    for raw in spec.split(","):
        part = raw.strip()
        if _INT.match(part):
            n = int(part)
            out.append(Interval(n, n))
            continue
        m = _RANGE.match(part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if a > b:
                raise ValueError(f'number generator: {label} range "{part}" is reversed')
            out.append(Interval(a, b))
            continue
        raise ValueError(f'number generator: invalid {label} "{source}"')
    return out


def compute_allowed(base: list[Range], include: str | None, exclude: str | None) -> list[Interval]:
    """The range with holes punched out and extras added, as a set of disjoint intervals."""
    combined = [Interval(r.min, r.max) for r in base]
    if include and include.strip():
        combined.extend(_parse_interval_list(include, "include"))
    combined = _merge(combined)
    if exclude and exclude.strip():
        combined = _subtract(combined, _parse_interval_list(exclude, "exclude"))
    if not combined:
        raise ValueError("number generator: the range is empty after include/exclude")
    return combined


def _merge(intervals: list[Interval]) -> list[Interval]:
    merged: list[Interval] = []
    for iv in sorted(intervals, key=lambda x: (x.min, x.max)):
        # Adjacent counts as overlapping: 1..3 and 4..6 are one run of integers.
        if merged and iv.min <= merged[-1].max + 1:
            last = merged.pop()
            merged.append(Interval(last.min, max(last.max, iv.max)))
        else:
            merged.append(iv)
    return merged


def _subtract(ranges: list[Interval], excludes: list[Interval]) -> list[Interval]:
    result = list(ranges)
    for ex in excludes:
        following: list[Interval] = []
        for r in result:
            if ex.max < r.min or ex.min > r.max:
                following.append(r)
                continue
            if ex.min > r.min:
                following.append(Interval(r.min, ex.min - 1))
            if ex.max < r.max:
                following.append(Interval(ex.max + 1, r.max))
        result = following
    return result


def _materialize_widths(
    count: int, choices: list[LengthChoice], percent: str | None, prng: Sfc32
) -> list[int]:
    widths = [0] * count
    if not choices:
        return widths

    if percent is None:
        selected = _random_length_choices(count, choices, prng)
    else:
        selected = hamilton.distribute(
            count, choices, percent_mask.expand(percent, len(choices)), prng
        )

    for i in range(count):
        c = selected[i]
        widths[i] = c.min if c.min == c.max else rand.next_int(prng, c.min, c.max + 1)
    return widths


def _random_length_choices(
    count: int, choices: list[LengthChoice], prng: Sfc32
) -> list[LengthChoice]:
    if len(choices) == 1:
        return [choices[0]] * count
    return [choices[rand.next_int(prng, 0, len(choices))] for _ in range(count)]


def _draw_guarded_range(
    ranges: list[Range], width: int, allow_leading_zero: bool, prng: Sfc32
) -> str:
    """Redraw a leading zero away, but only so many times — a range of zeroes has none else."""
    s = _draw_range(ranges, width, prng)
    guard = 0
    while not allow_leading_zero and s.startswith("0") and guard < 100:
        s = _draw_range(ranges, width, prng)
        guard += 1
    return s


def _draw_range(ranges: list[Range], width: int, prng: Sfc32) -> str:
    r = ranges[0] if len(ranges) == 1 else ranges[rand.next_int(prng, 0, len(ranges))]
    n = _next_long(prng, r.min, r.max + 1)
    s = str(n)
    actual_width = width if width > 0 else r.width
    return _pad(s, actual_width) if actual_width > 0 else s


def _draw_guarded(
    intervals: list[Interval], width: int, allow_leading_zero: bool, prng: Sfc32
) -> str:
    s = _draw_weighted(intervals, width, prng)
    guard = 0
    while not allow_leading_zero and s.startswith("0") and guard < 100:
        s = _draw_weighted(intervals, width, prng)
        guard += 1
    return s


def _draw_weighted(intervals: list[Interval], width: int, prng: Sfc32) -> str:
    """One draw over the total size, then map it into whichever interval holds that index.

    Drawing an interval first and a value second would make a one-element hole as likely as a
    thousand-element run.
    """
    total = sum(iv.max - iv.min + 1 for iv in intervals)
    k = _next_long(prng, 0, total)
    n = intervals[0].min
    for iv in intervals:
        size = iv.max - iv.min + 1
        if k < size:
            n = iv.min + k
            break
        k -= size
    s = str(n)
    return _pad(s, width) if width > 0 else s


def _digit_string(width: int, allow_leading_zero: bool, prng: Sfc32) -> str:
    out = []
    for i in range(width):
        minimum = 1 if i == 0 and not allow_leading_zero else 0
        out.append(str(rand.next_int(prng, minimum, 10)))
    return "".join(out)


def _random_decimal(ranges: list[Range], decimals: int, prng: Sfc32) -> str:
    """Drawn over the SCALED integers, so every representable value is equally likely."""
    scale = 10.0**decimals
    lo: list[int] = []
    size: list[int] = []
    total = 0
    for r in ranges:
        low = round(r.min * scale)
        lo.append(low)
        span = round(r.max * scale) - low + 1
        size.append(span)
        total += span

    pick = math.floor(prng.next() * total)
    for i in range(len(ranges)):
        if pick < size[i]:
            return _fixed(lo[i] + pick, scale, decimals)
        pick -= size[i]
    last = len(ranges) - 1
    return _fixed(lo[last] + size[last] - 1, scale, decimals)


def _fixed(scaled: int, scale: float, decimals: int) -> str:
    quantum = Decimal(1).scaleb(-decimals)
    return str(Decimal(repr(scaled / scale)).quantize(quantum, rounding=ROUND_HALF_UP))


def _next_long(prng: Sfc32, minimum: int, maximum: int) -> int:
    """``[min, max)`` over integers wider than 32 bits — the range form can exceed them."""
    return math.floor(prng.next() * float(maximum - minimum) + float(minimum))


def _pad(s: str, width: int) -> str:
    return s.rjust(width, "0") if len(s) < width else s
