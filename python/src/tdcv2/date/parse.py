"""Strict parsing for the dates a config writes by hand.

Strict on purpose. A lenient parser would read ``2026-02-30`` as 2 March and generate data that
looks fine until someone tries to explain where March came from. The separator has to match itself
too, so ``2026-01/01`` is an error rather than a guess.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache

from .plain import DateError, PlainDateTime, assert_valid

# The backreference makes the second separator match the first: dashes, dots or slashes, not a mix.
_DATE_TIME = re.compile(
    r"^(\d{4})([./-])(\d{2})\2(\d{2})"
    r"(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$"
)

_LEGACY_RANGE = re.compile(r"^(\d{4}\.\d{2}\.\d{2})\s*-\s*(\d{4}\.\d{2}\.\d{2})$")


@dataclass(frozen=True, slots=True)
class Parsed:
    value: PlainDateTime
    has_time: bool
    """Whether the text carried a time, which is what decides the default precision."""


@dataclass(frozen=True, slots=True)
class Range:
    start: Parsed
    end: Parsed


@lru_cache(maxsize=512)
def date_time(source: str) -> Parsed:
    """One date, from the text a config wrote.

    Cached: the bounds of a ``from``/``to`` range are two constants that every row re-reads, so an
    uncached parse charges each row for a regex match it has already paid for. ``Parsed`` is frozen,
    so handing the same instance to every caller is safe.
    """
    m = _DATE_TIME.match(source.strip())
    if not m:
        raise DateError(
            f'date: invalid date "{source}" (expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)'
        )
    has_time = m.group(5) is not None
    value = PlainDateTime(
        year=int(m.group(1)),
        month=int(m.group(3)),
        day=int(m.group(4)),
        hour=int(m.group(5)) if has_time else 0,
        minute=int(m.group(6)) if has_time else 0,
        second=0 if m.group(7) is None else int(m.group(7)),
        # ".5" means 500 milliseconds, not 5 — padded on the right, never the left.
        millisecond=0 if m.group(8) is None else int(m.group(8).ljust(3, "0")),
    )
    assert_valid(value, source)
    return Parsed(value, has_time)


def value_range(source: str) -> Range:
    parts = source.split("..")
    if len(parts) != 2:
        raise DateError(f'date: invalid range "{source}" (expected START..END)')
    return Range(date_time(parts[0]), date_time(parts[1]))


def legacy_range(source: str) -> Range:
    """The older ``range="1990.01.01 - 2000.12.31"`` spelling, as ``date.range`` takes it.

    Dots and a dash rather than the ``..`` the ``date`` generator uses. Two spellings for one idea
    is not a design anyone would choose, but the old one is in configs already and silently
    rejecting them would be worse than carrying it.
    """
    m = _LEGACY_RANGE.match(source.strip())
    if not m:
        raise DateError(f'date.range: invalid range attribute "{source}"')
    return Range(date_time(m.group(1)), date_time(m.group(2)))
