"""``<gen type="date" of="Admitted" plus="3..10d">`` — a date measured from another date.

The interval is in almost every real record — admitted and discharged, ordered and shipped,
issued and expires, the start and end of a shift — and it could not be said at all. Two
independent date columns put the discharge BEFORE the admission on a third of the rows, and the
workaround people reach for, non-overlapping windows ("admitted in January, discharged April to
June"), throws away exactly what the interval is for: its length, and how that length is
distributed. "Most stay a week, a few stay months" had no way to be written.

A generator sees no other column, by design — that is what makes a column's values a function of
the seed and the row index alone. This reads a sibling, so it is resolved in the engine beside
``running`` and ``stat``, in declaration order, which is also why ``of=`` must name a column
declared ABOVE it.
"""

from __future__ import annotations

import re

from ..date import parse as date_parse
from ..date.calendar import (
    ColumnOffset,
    OffsetSpec,
    add_step,
    apply_offset,
    parse_column_offset,
    parse_offset,
)
from ..date.formatter import format_date_time
from ..date.plain import PlainDateTime, from_epoch_millis, to_epoch_millis
from ..prng.prng import Sfc32


class DateOffsetError(ValueError):
    """A source column an offset cannot read."""


def source_of(attrs: dict[str, str]) -> str:
    """The column this date is measured from, or ``""`` when the generator did not say."""
    return (attrs.get("of") or "").strip()


def is_offset(gen) -> bool:
    """True when this ``<gen type="date">`` is an offset rather than a draw."""
    return gen is not None and gen.type == "date" and source_of(gen.attrs) != ""


def build(
    name: str,
    attrs: dict[str, str],
    source: list[str | None],
    instants: list[int | None] | None,
    count: int,
    prng: Sfc32,
    locale: str,
    keep_instants: bool,
    columns: dict | None = None,
) -> tuple[list[str | None], list[int | None] | None]:
    """The offset column, and its own instants when a third column measures from it.

    One draw per row, and only when the offset is a RANGE: ``plus="7d"`` is a fixed distance and
    consumes no randomness at all, so a config that pins the interval leaves every other column
    exactly where it was.

    A row whose source is empty — outside a parent filter, or a source that was itself filtered —
    stays empty. There is no date to measure from, and inventing one would put a value in a cell
    the config said should have none.
    """
    parsed = parse_offset(attrs.get("plus"))
    by_column = None if parsed.ok else parse_column_offset(attrs.get("plus"))
    distance = None if by_column is None else (columns or {}).get(by_column.column)
    # A bad plus=, or a column nobody declared, is a diagnostic, not a crash.
    unreadable = by_column is not None and distance is None
    if (parsed.offset is None and by_column is None) or unreadable:
        return ([None] * count, None)

    fmt = (attrs.get("format") or "").strip() or "L"
    values: list[str | None] = [None] * count
    # An offset is itself a date this engine produced, so it keeps its own value when a THIRD
    # column measures from it — signed, expires a year later, remind a month before that.
    own: list[int | None] | None = [None] * count if keep_instants else None

    for i in range(count):
        text = source[i] if i < len(source) else None
        if text is None or text.strip() == "":
            continue
        start = start_of_row(name, attrs, instants, i, text)
        if start is None:
            continue
        if by_column is not None and distance is not None:
            cell = distance[i] if i < len(distance) else None
            steps = steps_from_column(name, by_column, cell, i)
            if steps is None:
                continue
            landed = add_step(start, by_column.unit, steps)
        elif parsed.offset is not None:
            landed = apply_offset(start, parsed.offset, draw_steps(parsed.offset, prng))
        else:
            continue
        if own is not None:
            own[i] = to_epoch_millis(landed)
        values[i] = format_date_time(landed, fmt, locale)
    return (values, own)


def start_of_row(
    name: str,
    attrs: dict[str, str],
    instants: list[int | None] | None,
    i: int,
    text: str,
) -> PlainDateTime | None:
    """The date row ``i`` is measured FROM, or ``None`` when the row has none.

    Three readings, in this order:

    1. **The instant the source column kept.** A ``<gen type="date">`` this engine built
       remembers what it generated, so the offset works from the value and ``format=`` is free to
       be anything at all — the cell may read ``March 2`` or ``02.03.2026`` and the arithmetic is
       the same either way.
    2. **No instant on a column that carries them.** ``missing="0.1"`` blanked that cell: the
       column HAS a date for other rows and none for this one. The offset has nothing to measure
       and the cell stays empty.
    3. **The text, read as ISO.** A date that came from a file or a pack has only its spelling
       left. The ISO form has one reading in every locale, so it is accepted; anything else is
       refused rather than guessed at, because ``02/03/2026`` is the 2nd of March in one locale
       and the 3rd of February in another.
    """
    if instants is not None:
        millis = instants[i] if i < len(instants) else None
        return None if millis is None else from_epoch_millis(millis)
    try:
        return date_parse.date_time(text.strip()).value
    except Exception as error:
        raise DateOffsetError(
            f'date offset ("{name}"): "{text}" in column "{source_of(attrs)}" is not a date '
            "this can measure from. A date TDC generated carries its own value and any format= "
            "works; one read from a file or a pack has only its text, and only the ISO form "
            "(YYYY-MM-DD) means the same thing in every locale."
        ) from error


#: The largest whole number every implementation reads exactly — JavaScript's safe integer.
_MAX_SAFE = 9007199254740991
_WHOLE = re.compile(r"-?[0-9]+")


def steps_from_column(name: str, offset: ColumnOffset, cell: str | None, i: int) -> int | None:
    """How many steps row ``i`` moves when ``plus=`` names a column, or None when its cell is
    empty — ``missing=`` blanked it, or a parent filter left the row without one — and the date
    stays empty with it, as it does when the date it is measured from is missing.

    Only a whole number is a distance. A decimal is refused rather than rounded: ``1.5`` hours is
    ninety minutes, and silently landing on one or two hours would put a wrong time in a column
    that looks right. No draw is taken, so adding such a column moves no other value.
    """
    text = (cell or "").strip()
    if text == "":
        return None
    n = int(text) if _WHOLE.fullmatch(text) else None
    if n is None or abs(n) > _MAX_SAFE:
        raise DateOffsetError(
            f'date offset ("{name}"): "{text}" in column "{offset.column}" on row {i + 1} is not '
            "a whole number. plus= reads the distance from that column, so it has to hold one — "
            "15, -3, 120; for a fraction of an hour, count in minutes."
        )
    return offset.sign * n


def draw_steps(offset: OffsetSpec, prng: Sfc32) -> int:
    """How many steps this row moves.

    A fixed offset takes no draw, which is what lets ``plus="7d"`` be added to a config without
    shifting any other column. A range takes exactly one.
    """
    if offset.lo == offset.hi:
        return offset.lo
    span = offset.hi - offset.lo + 1
    return offset.lo + min(span - 1, int(prng.next() * span))
