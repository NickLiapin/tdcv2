"""Walking a date range instead of drawing from it: ``step=`` and ``weekdays=``.

A step is EITHER a fixed span or a calendar span, and never both. The distinction is not
pedantry: ``15m`` is always 900 000 milliseconds, while ``1mo`` is 28, 29, 30 or 31 days
depending on where you start. They compose within their own group — ``1h30m``, ``1y6mo`` — and
refuse to compose across it, because "one month and fifteen days" depends on which is applied
first, and a config whose meaning turns on an invisible ordering is worse than one that will not
parse. Allowing the mix later is easy; changing what it already means is not.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .plain import (
    MS_PER_DAY,
    MS_PER_SECOND,
    PlainDateTime,
    days_in_month,
    from_epoch_millis,
    to_epoch_millis,
)
from .plain import weekday as _weekday_of


@dataclass(frozen=True, slots=True)
class StepSpec:
    """How far one row advances: milliseconds, or months. Exactly one is non-zero."""

    ms: int
    months: int


# Fixed units. ``m`` is MINUTE, as it is everywhere this notation is used.
_FIXED_UNIT_MS = {
    "s": MS_PER_SECOND,
    "m": 60 * MS_PER_SECOND,
    "h": 3600 * MS_PER_SECOND,
    "d": MS_PER_DAY,
    "w": 7 * MS_PER_DAY,
}

# Calendar units, in months. ``mo`` rather than ``m`` because ``m`` is already the minute, and
# rather than ``M`` because the difference between three minutes and three months would then rest
# on the case of one letter — a distinction no reader checks and no tool that normalizes case
# preserves.
_CALENDAR_UNIT_MONTHS = {"mo": 1, "y": 12}

#: What a ``step=`` may say, for a diagnostic to quote.
STEP_SYNTAX = "15m, 1h30m, 2d, 3mo, 1y — units s, m, h, d, w, mo, y"

#: The default step of a walked axis: one day.
DEFAULT_STEP = StepSpec(MS_PER_DAY, 0)

_WHOLE_STEP = re.compile(r"^(?:\d+(?:mo|[smhdwy]))+$")
_STEP_PART = re.compile(r"(\d+)(mo|[smhdwy])")


@dataclass(frozen=True, slots=True)
class StepResult:
    """Either the step, or why it was refused: ``"syntax"`` or ``"mixed"``."""

    step: StepSpec | None
    reason: str | None

    @property
    def ok(self) -> bool:
        return self.step is not None


def parse_step(raw: str | None) -> StepResult:
    """``step="15m"``, ``step="1h30m"``, ``step="3mo"``, ``step="2"``.

    A bare number means DAYS, the default unit, so ``step="2"`` is every other day. A unit may
    appear once: ``1h30m1h`` is a typo, and summing it would hide the typo rather than report it.
    """
    value = (raw or "").strip().lower()
    if value == "":
        return StepResult(DEFAULT_STEP, None)
    if value.isdigit():
        days = int(value)
        return (
            StepResult(StepSpec(days * MS_PER_DAY, 0), None)
            if days >= 1
            else StepResult(None, "syntax")
        )
    if not _WHOLE_STEP.match(value):
        return StepResult(None, "syntax")

    ms = 0
    months = 0
    seen: set[str] = set()
    for digits, unit in _STEP_PART.findall(value):
        if unit in seen:
            return StepResult(None, "syntax")
        seen.add(unit)
        n = int(digits)
        if unit in _FIXED_UNIT_MS:
            ms += n * _FIXED_UNIT_MS[unit]
        else:
            months += n * _CALENDAR_UNIT_MONTHS[unit]
    if ms > 0 and months > 0:
        return StepResult(None, "mixed")
    if ms == 0 and months == 0:
        return StepResult(None, "syntax")
    return StepResult(StepSpec(ms, months), None)


def add_step(start: PlainDateTime, step: StepSpec, n: int) -> PlainDateTime:
    """``start`` advanced by ``n`` steps.

    A calendar month has no fixed length, so stepping by month or year keeps the DAY OF MONTH and
    clamps it to the last day of a shorter one: 31 January plus one month is 28 February, not 3
    March. That is the same rule ``subtract_years`` already applies to ``person.b_day``, so the
    engine answers one way about calendars rather than two.
    """
    if step.months == 0:
        return from_epoch_millis(to_epoch_millis(start) + n * step.ms)
    months = start.year * 12 + (start.month - 1) + n * step.months
    year, month_index = divmod(months, 12)
    month = month_index + 1
    return PlainDateTime(
        year,
        month,
        min(start.day, days_in_month(year, month)),
        start.hour,
        start.minute,
        start.second,
        start.millisecond,
    )


def steps_between(start: PlainDateTime, end: PlainDateTime, step: StepSpec) -> int:
    """How many steps fit in ``start..end``, counting both ends.

    Computed rather than counted, because a second-by-second span of a century is a number no loop
    should walk. A fixed step divides; a calendar one is estimated from the month difference and
    corrected by at most one, which is what the clamping in ``add_step`` can cost.
    """
    if step.months == 0:
        span = to_epoch_millis(end) - to_epoch_millis(start)
        return 1 if span < 0 else span // step.ms + 1
    months = (end.year - start.year) * 12 + (end.month - start.month)
    n = months // step.months
    if n < 0:
        return 1
    if to_epoch_millis(add_step(start, step, n)) > to_epoch_millis(end):
        n -= 1
    return n + 1


def fixes_weekday(step: StepSpec) -> bool:
    """True when every row of this step lands on the same weekday.

    A calendar step does, and so does any whole number of weeks — ``14d`` as much as ``2w``, which
    a test on the unit's NAME would have missed. A weekday filter over such a step matches every
    row or none, so it is refused rather than silently producing a full column or an empty one.
    """
    return step.months > 0 or step.ms % (7 * MS_PER_DAY) == 0


_WEEKDAYS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")

#: What a ``weekdays=`` may say, for a diagnostic to quote.
WEEKDAY_NAMES: tuple[str, ...] = _WEEKDAYS


def parse_weekdays(raw: str | None) -> frozenset[int] | None:
    """``weekdays="mon..fri"`` or ``weekdays="sun,wed"`` — which weekdays an axis keeps.

    ``..`` is the range operator everywhere else in the language, so it is the range operator
    here. A SPAN wraps: ``fri..mon`` is Friday, Saturday, Sunday, Monday, because a week is a
    circle and refusing to go round it would make half the spans unwritable. Returns ``None`` on a
    name it does not know, so the caller can say which.
    """
    value = (raw or "").strip().lower()
    if value == "":
        return None
    keep: set[int] = set()
    for part in value.split(","):
        span = part.strip()
        if span == "":
            return None
        at = span.find("..")
        if at < 0:
            if span not in _WEEKDAYS:
                return None
            keep.add(_WEEKDAYS.index(span))
            continue
        first, last = span[:at].strip(), span[at + 2 :].strip()
        if first not in _WEEKDAYS or last not in _WEEKDAYS:
            return None
        start, end = _WEEKDAYS.index(first), _WEEKDAYS.index(last)
        day = start
        while True:
            keep.add(day)
            if day == end:
                break
            day = (day + 1) % 7
    return frozenset(keep)


def weekday_of(value: PlainDateTime) -> int:
    """The weekday of a date, 0 = Sunday, matching :func:`parse_weekdays`."""
    return _weekday_of(value)


@dataclass(frozen=True, slots=True)
class OffsetSpec:
    """A drawn offset: ``lo..hi`` steps of one unit. ``lo == hi`` is a fixed offset."""

    lo: int
    hi: int
    #: One step, as ``add_step`` takes it — so the calendar clamping is shared.
    unit: StepSpec


#: What a ``plus=`` may say, for a diagnostic to quote.
OFFSET_SYNTAX = "7d, 3..10d, 1..3mo, -5..-1d — units s, m, h, d, w, mo, y"

_OFFSET = re.compile(r"^(-?\d+)(?:\.\.(-?\d+))?(mo|[smhdwy])?$")


@dataclass(frozen=True, slots=True)
class OffsetResult:
    """Either the offset, or why it was refused: ``"syntax"`` or ``"order"``."""

    offset: OffsetSpec | None
    reason: str | None

    @property
    def ok(self) -> bool:
        return self.offset is not None


def parse_offset(raw: str | None) -> OffsetResult:
    """``plus="3..10d"``, ``plus="7d"``, ``plus="-5..-1d"``, ``plus="1..3mo"``.

    A bare number means DAYS, matching ``step=``. The low bound may not exceed the high one:
    ``10..3d`` is a typo, and silently swapping it would hide the typo rather than report it.

    The unit sits at the end rather than on both sides because ``3d..10d`` invites two DIFFERENT
    units, and "three days to two months" has no whole number of steps to draw.
    """
    value = (raw or "").strip().lower()
    if value == "":
        return OffsetResult(None, "syntax")
    shape = _OFFSET.match(value)
    if shape is None:
        return OffsetResult(None, "syntax")
    lo_text, hi_text, unit_name = shape.group(1), shape.group(2), shape.group(3)
    lo = int(lo_text)
    hi = lo if hi_text is None else int(hi_text)
    if lo > hi:
        return OffsetResult(None, "order")

    name = unit_name or "d"
    fixed = _FIXED_UNIT_MS.get(name)
    months = _CALENDAR_UNIT_MONTHS.get(name)
    unit = StepSpec(0, months or 0) if fixed is None else StepSpec(fixed, 0)
    if unit.ms == 0 and unit.months == 0:
        return OffsetResult(None, "syntax")
    return OffsetResult(OffsetSpec(lo, hi, unit), None)


def apply_offset(start: PlainDateTime, offset: OffsetSpec, n: int) -> PlainDateTime:
    """The source date moved by ``n`` steps of the offset's unit."""
    return add_step(start, offset.unit, n)
