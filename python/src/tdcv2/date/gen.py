"""``<gen type="date">`` — a moment, a range of them, or a birthday.

One generator covers four shapes because they are four ways of asking the same question: a fixed
date, a range written as ``from``/``to``, ``today``/``now`` read from the clock, and ``birth``,
which is a range expressed in ages rather than dates. Splitting them apart would make the common
case — "some date in the nineties" — a choice between generators.

Precision decides what is drawn, not just how it prints. At day precision a whole day is one
outcome, so a range of ten years has 3653 of them; at millisecond precision the same range has
315 billion, and every row lands on a different instant. That is the difference between an order
date and an event timestamp, and only the config knows which one is wanted.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..prng.prng import Sfc32
from . import parse
from .formatter import format_date_time
from .plain import (
    MS_PER_SECOND,
    DateError,
    PlainDateTime,
    Precision,
    from_epoch_day,
    from_epoch_millis,
    subtract_years,
    to_epoch_day,
    to_epoch_millis,
)

DEFAULT_START = "1970-01-01"
DEFAULT_FORMAT = "L"

_DEFAULT_OLDEST = 80
_DEFAULT_YOUNGEST = 10


@dataclass(frozen=True, slots=True)
class Plan:
    """What a run of this generator will draw from, decided once."""

    fixed: PlainDateTime | None
    start: PlainDateTime | None
    end: PlainDateTime | None
    precision: Precision
    format: str
    locale: str


def generate(attrs: dict[str, str], count: int, locale: str, now: int, prng: Sfc32) -> list[str]:
    plan = build_plan(attrs, locale, now)
    return [
        format_date_time(
            plan.fixed if plan.fixed is not None else _pick(plan, prng), plan.format, plan.locale
        )
        for _ in range(count)
    ]


def build_plan(attrs: dict[str, str], locale: str, now: int) -> Plan:
    fmt = attrs.get("format", DEFAULT_FORMAT)
    loc = attrs.get("local", locale)
    value = attrs["value"].strip() if attrs.get("value") is not None else None

    if value == "today":
        return Plan(
            from_epoch_millis(now).start_of_day(),
            None,
            None,
            parse_precision(attrs.get("precision"), Precision.DAY),
            fmt,
            loc,
        )

    if value == "now":
        return Plan(
            from_epoch_millis(now),
            None,
            None,
            parse_precision(attrs.get("precision"), Precision.MILLISECOND),
            fmt,
            loc,
        )

    if value == "birth":
        # Ages, not dates: "between 10 and 80 years old" stays true as the clock moves, where a
        # pair of fixed dates would quietly age the whole population by a year every January.
        oldest = _age(attrs.get("oldest"), _DEFAULT_OLDEST, "oldest")
        youngest = _age(attrs.get("youngest"), _DEFAULT_YOUNGEST, "youngest")
        if youngest > oldest:
            raise DateError("date generator: youngest must be less than or equal to oldest")
        start = from_epoch_millis(subtract_years(now, oldest))
        end = from_epoch_millis(subtract_years(now, youngest))
        return _range_plan(
            parse.Range(parse.Parsed(start, False), parse.Parsed(end, False)),
            attrs,
            fmt,
            loc,
            Precision.DAY,
        )

    if attrs.get("from") is not None or attrs.get("to") is not None:
        if attrs.get("from") is None or attrs.get("to") is None:
            raise DateError('date generator: "from" and "to" must be provided together')
        bounds = parse.Range(parse.date_time(attrs["from"]), parse.date_time(attrs["to"]))
        return _range_plan(bounds, attrs, fmt, loc)

    if attrs.get("range") is not None:
        return _range_plan(parse.value_range(attrs["range"]), attrs, fmt, loc)

    if value:
        if ".." in value:
            return _range_plan(parse.value_range(value), attrs, fmt, loc)
        parsed = parse.date_time(value)
        return Plan(
            parsed.value,
            None,
            None,
            parse_precision(
                attrs.get("precision"),
                Precision.MILLISECOND if parsed.has_time else Precision.DAY,
            ),
            fmt,
            loc,
        )

    # Nothing said at all: the whole span from the epoch to right now, by day.
    bounds = parse.Range(parse.date_time(DEFAULT_START), parse.Parsed(from_epoch_millis(now), True))
    return _range_plan(bounds, attrs, fmt, loc, Precision.DAY)


def parse_precision(raw: str | None, fallback: Precision = Precision.DAY) -> Precision:
    if raw is None:
        return fallback
    for precision in Precision:
        if raw == precision.value:
            return precision
    raise DateError(
        f'date generator: unsupported precision "{raw}" (supported: day, second, millisecond)'
    )


def render_birthday(attrs: dict[str, str], locale: str, now: int, prng: Sfc32) -> str:
    """The ``person.b_day`` template, which is this generator under another name."""
    forwarded = {
        "value": "birth",
        "precision": attrs.get("precision", "millisecond"),
        **{k: attrs[k] for k in ("oldest", "youngest", "format", "local") if k in attrs},
    }
    return generate(forwarded, 1, locale, now, prng)[0]


def render_date_range(attrs: dict[str, str], locale: str, now: int, prng: Sfc32) -> str:
    """The ``date.range`` template, which takes the older dotted spelling of a range."""
    raw = attrs.get("range", "")
    bounds = parse.legacy_range(raw)
    forwarded = {
        "from": _serialize(bounds.start.value),
        "to": _serialize(bounds.end.value),
        "precision": attrs.get("precision", "day"),
        **{k: attrs[k] for k in ("format", "local") if k in attrs},
    }
    return generate(forwarded, 1, locale, now, prng)[0]


def _range_plan(
    bounds: parse.Range,
    attrs: dict[str, str],
    fmt: str,
    locale: str,
    fallback: Precision | None = None,
) -> Plan:
    # A range written with a time in it means the config cares about the time, so the default
    # precision follows what was written rather than a fixed choice.
    has_time = bounds.start.has_time or bounds.end.has_time
    default = fallback or (Precision.MILLISECOND if has_time else Precision.DAY)
    return Plan(
        None,
        bounds.start.value,
        bounds.end.value,
        parse_precision(attrs.get("precision"), default),
        fmt,
        locale,
    )


def _pick(plan: Plan, prng: Sfc32) -> PlainDateTime:
    if plan.start is None or plan.end is None:
        raise DateError("date generator: range plan is incomplete")

    if plan.precision is Precision.DAY:
        a = to_epoch_day(plan.start)
        b = to_epoch_day(plan.end)
        return from_epoch_day(_inclusive(prng, min(a, b), max(a, b)))

    divisor = MS_PER_SECOND if plan.precision is Precision.SECOND else 1
    a = to_epoch_millis(plan.start) // divisor
    b = to_epoch_millis(plan.end) // divisor
    return from_epoch_millis(_inclusive(prng, min(a, b), max(a, b)) * divisor)


def _inclusive(prng: Sfc32, minimum: int, maximum: int) -> int:
    return math.floor(prng.next() * (maximum - minimum + 1) + minimum)


def _age(raw: str | None, fallback: int, name: str) -> int:
    if raw is None:
        return fallback
    try:
        value = int(raw.strip())
    except ValueError:
        raise DateError(f"date generator: {name} must be an integer from 0 to 150") from None
    if value < 0 or value > 150:
        raise DateError(f"date generator: {name} must be an integer from 0 to 150")
    return value


def _serialize(value: PlainDateTime) -> str:
    return (
        f"{value.year:04d}-{value.month:02d}-{value.day:02d}"
        f"T{value.hour:02d}:{value.minute:02d}:{value.second:02d}.{value.millisecond:03d}"
    )
