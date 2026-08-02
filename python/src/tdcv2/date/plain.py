"""A calendar instant with no zone attached, and the arithmetic that goes with it.

Everything in TDC's date handling is UTC. A generator that quietly used the machine's zone would
produce different data in Moscow and in Denver from the same seed, which is the one thing the
product promises never happens.

The arithmetic is written out rather than taken from ``datetime`` for the same reason: the
reference implementation does it this way, and a library that disagrees about, say, what happens
to 29 February would show up as wrong data rather than as an error.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum

MS_PER_SECOND = 1000
MS_PER_DAY = 86_400_000

_EPOCH_YEAR = 1970
_DAYS_IN_MONTH = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


class Precision(Enum):
    DAY = "day"
    SECOND = "second"
    MILLISECOND = "millisecond"


class DateError(ValueError):
    """A date a config wrote that cannot be one."""


@dataclass(frozen=True, slots=True)
class PlainDateTime:
    year: int
    month: int
    day: int
    hour: int = 0
    minute: int = 0
    second: int = 0
    millisecond: int = 0

    def start_of_day(self) -> PlainDateTime:
        # Constructed rather than `replace`d: the time fields all default to zero, so this is the
        # same value, and `replace` re-inspects the dataclass's fields on every call.
        return PlainDateTime(self.year, self.month, self.day)


def is_leap_year(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)


def days_in_month(year: int, month: int) -> int:
    if month == 2:
        return 29 if is_leap_year(year) else 28
    return _DAYS_IN_MONTH[month - 1] if 1 <= month <= 12 else 31


def assert_valid(value: PlainDateTime, source: str) -> None:
    if value.year < 1 or value.year > 9999:
        raise DateError(f'date: invalid year in "{source}"')
    if value.month < 1 or value.month > 12:
        raise DateError(f'date: invalid month in "{source}"')
    if value.day < 1 or value.day > days_in_month(value.year, value.month):
        raise DateError(f'date: invalid day in "{source}"')
    if value.hour < 0 or value.hour > 23:
        raise DateError(f'date: invalid hour in "{source}"')
    if value.minute < 0 or value.minute > 59:
        raise DateError(f'date: invalid minute in "{source}"')
    if value.second < 0 or value.second > 59:
        raise DateError(f'date: invalid second in "{source}"')
    if value.millisecond < 0 or value.millisecond > 999:
        raise DateError(f'date: invalid millisecond in "{source}"')


def to_epoch_millis(value: PlainDateTime) -> int:
    days = _days_from_civil(value.year, value.month, value.day)
    seconds = value.hour * 3600 + value.minute * 60 + value.second
    return days * MS_PER_DAY + seconds * MS_PER_SECOND + value.millisecond


def from_epoch_millis(ms: int) -> PlainDateTime:
    days, rest = divmod(ms, MS_PER_DAY)
    year, month, day = _civil_from_days(days)
    seconds, millisecond = divmod(rest, MS_PER_SECOND)
    hour, remainder = divmod(seconds, 3600)
    minute, second = divmod(remainder, 60)
    return PlainDateTime(year, month, day, hour, minute, second, millisecond)


def to_epoch_day(value: PlainDateTime) -> int:
    return to_epoch_millis(value.start_of_day()) // MS_PER_DAY


def from_epoch_day(day: int) -> PlainDateTime:
    return from_epoch_millis(day * MS_PER_DAY)


def subtract_years(ms: int, years: int) -> int:
    """Whole years back, with the day clamped.

    The clamp is what keeps 29 February from silently becoming 1 March: a birthday on a leap day,
    taken back to a year that has none, lands on the 28th.
    """
    source = from_epoch_millis(ms)
    year = source.year - years
    day = min(source.day, days_in_month(year, source.month))
    return to_epoch_millis(replace(source, year=year, day=day))


def weekday(value: PlainDateTime) -> int:
    """Day of the week, Sunday = 0, matching the weekday tables the locales carry."""
    return (_days_from_civil(value.year, value.month, value.day) + 4) % 7


def _days_from_civil(year: int, month: int, day: int) -> int:
    """Days since 1970-01-01 — Howard Hinnant's civil-from-days, run backwards.

    Written out rather than delegated: it has to give the same answer for year 1 and year 9999 in
    all three implementations, and the shifted-era trick makes the negative side fall out of the
    same arithmetic instead of needing a separate branch.
    """
    y = year - (1 if month <= 2 else 0)
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _civil_from_days(days: int) -> tuple[int, int, int]:
    z = days + 719468
    era = (z if z >= 0 else z - 146096) // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    day = doy - (153 * mp + 2) // 5 + 1
    month = mp + (3 if mp < 10 else -9)
    return y + (1 if month <= 2 else 0), month, day
