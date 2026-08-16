"""The calendar, the formatter and the date generator, against the shared date cases."""

from __future__ import annotations

import pytest

from tdcv2.date import gen, locales, parse, plain
from tdcv2.date.formatter import check_format, format_date_time
from tdcv2.prng.prng import create

# The clock every shared date case is frozen at: 2026-04-23T12:00:00Z.
NOW = 1776945600000


# ── the calendar ────────────────────────────────────────────────────────────────────────────


def test_the_frozen_clock_is_the_instant_the_fixtures_name() -> None:
    assert plain.to_epoch_millis(plain.PlainDateTime(2026, 4, 23, 12, 0, 0, 0)) == NOW


@pytest.mark.parametrize(
    ("year", "month", "day"),
    [(1970, 1, 1), (1, 1, 1), (9999, 12, 31), (2000, 2, 29), (1969, 12, 31), (1900, 3, 1)],
)
def test_a_date_survives_the_round_trip_through_milliseconds(
    year: int, month: int, day: int
) -> None:
    value = plain.PlainDateTime(year, month, day)
    back = plain.from_epoch_millis(plain.to_epoch_millis(value))
    assert (back.year, back.month, back.day) == (year, month, day)


def test_the_epoch_was_a_thursday() -> None:
    assert plain.weekday(plain.PlainDateTime(1970, 1, 1)) == 4


@pytest.mark.parametrize(
    ("year", "leap"), [(2000, True), (1900, False), (2024, True), (2026, False)]
)
def test_the_century_rule_is_the_gregorian_one(year: int, leap: bool) -> None:
    assert plain.is_leap_year(year) is leap
    assert plain.days_in_month(year, 2) == (29 if leap else 28)


def test_stepping_back_a_year_clamps_a_leap_day_rather_than_overflowing() -> None:
    leap_day = plain.to_epoch_millis(plain.PlainDateTime(2024, 2, 29))
    landed = plain.from_epoch_millis(plain.subtract_years(leap_day, 1))
    assert (landed.month, landed.day) == (2, 28)


# ── parsing ─────────────────────────────────────────────────────────────────────────────────


def test_a_date_that_does_not_exist_is_refused() -> None:
    with pytest.raises(plain.DateError, match="invalid day"):
        parse.date_time("2026-02-30")


def test_the_two_separators_have_to_match_each_other() -> None:
    with pytest.raises(plain.DateError, match="invalid date"):
        parse.date_time("2026-01/01")


def test_a_fraction_pads_on_the_right() -> None:
    assert parse.date_time("2026-01-01T00:00:00.5").value.millisecond == 500


def test_a_time_in_the_text_is_remembered_because_it_decides_the_precision() -> None:
    assert parse.date_time("2026-01-01").has_time is False
    assert parse.date_time("2026-01-01T10:00").has_time is True


# ── formatting ──────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("locale", "fmt", "expected"),
    [
        ("en", "L", "10/18/2026"),
        ("ru", "LLLL", "воскресенье, 18 октября 2026 г. 00:00"),
        ("es", "LL", "18 de octubre de 2026"),
        ("de", "LL", "18. Oktober 2026"),
        ("fr", "LL", "18 octobre 2026"),
        ("pt", "LL", "18 de outubro de 2026"),
        ("it", "LL", "18 ottobre 2026"),
        ("pl", "LL", "18 października 2026"),
        ("el", "LL", "18 Οκτωβρίου 2026"),
        ("zh-cn", "LL", "2026年10月18日"),
        ("ar", "LL", "18 أكتوبر 2026"),
        ("cs", "LL", "18. října 2026"),
        ("hu", "LL", "2026. október 18."),
        ("fi", "LL", "18. lokakuuta 2026"),
        # A language with no table of its own falls back rather than failing the run. The code
        # here is deliberately not a real language: this row used to read ("cs", "L", "10/18/2026")
        # back when Czech HAD a table and it simply worked, so the row was asserting the fallback
        # against a language that never took it. Any real code can gain a table; "qq" cannot.
        ("qq", "L", "10/18/2026"),
    ],
)
def test_a_locale_prints_its_own_names(locale: str, fmt: str, expected: str) -> None:
    assert format_date_time(plain.PlainDateTime(2026, 10, 18), fmt, locale) == expected


def test_every_advertised_locale_resolves_to_itself() -> None:
    for name in locales.NAMES:
        assert locales.resolve(name).name == name
        assert locales.is_known(name)


def test_a_bracketed_run_is_a_literal() -> None:
    assert format_date_time(plain.PlainDateTime(2026, 1, 2), "[Day] D", "en") == "Day 2"


def test_an_unterminated_literal_is_named_before_a_run_starts() -> None:
    with pytest.raises(plain.DateError, match="unterminated literal"):
        check_format("[Day D")


# ── the generator ───────────────────────────────────────────────────────────────────────────


def test_a_day_range_matches_the_reference() -> None:
    produced = gen.generate(
        {"range": "2026-01-01..2026-01-31", "format": "YYYY-MM-DD"},
        6,
        "en",
        NOW,
        create("unit-test"),
    )
    assert produced == [
        "2026-01-22",
        "2026-01-25",
        "2026-01-18",
        "2026-01-27",
        "2026-01-05",
        "2026-01-30",
    ]


def test_second_precision_lands_every_row_on_its_own_instant() -> None:
    produced = gen.generate(
        {
            "range": "2026-01-01T00:00:00..2026-01-01T23:59:59",
            "format": "ISO_TIME",
            "precision": "second",
        },
        6,
        "en",
        NOW,
        create("unit-test"),
    )
    assert produced == [
        "2026-01-01T16:37:05",
        "2026-01-01T19:12:27",
        "2026-01-01T13:33:00",
        "2026-01-01T20:20:18",
        "2026-01-01T03:25:40",
        "2026-01-01T22:47:45",
    ]


def test_today_is_the_same_day_on_every_row() -> None:
    produced = gen.generate({"value": "today", "format": "ISO"}, 3, "en", NOW, create("unit-test"))
    assert produced == ["2026-04-23"] * 3


def test_a_birthday_is_an_age_range_read_from_the_clock() -> None:
    prng = create("unit-test")
    attrs = {"oldest": "70", "youngest": "14", "format": "LL", "local": "en"}
    produced = [gen.render_birthday(attrs, "en", NOW, prng) for _ in range(6)]
    assert produced == [
        "February 1, 1995",
        "February 16, 2001",
        "December 5, 1987",
        "October 7, 2003",
        "April 22, 1964",
        "July 2, 2009",
    ]


def test_an_age_range_that_runs_backwards_is_refused() -> None:
    with pytest.raises(plain.DateError, match="youngest must be less than or equal to oldest"):
        gen.build_plan({"value": "birth", "oldest": "10", "youngest": "70"}, "en", NOW)


def test_to_without_from_is_refused() -> None:
    # An end with no beginning says nothing under either reading: a drawn range needs both, and a
    # walked one starts at `from`.
    with pytest.raises(plain.DateError, match="must be provided together"):
        gen.build_plan({"to": "2026-01-01"}, "en", NOW)


def test_from_alone_is_an_open_axis_rather_than_an_error() -> None:
    # It used to be refused. The end of a WALKED range is start + count x step — a consequence,
    # not an input — so requiring it meant working out what date the millionth day falls on in
    # order to write it down. A drawn date with one end is still refused, now by the validator
    # (TDC150) rather than here.
    plan = gen.build_plan({"from": "2026-01-01"}, "en", NOW)
    assert plan.start == plain.PlainDateTime(2026, 1, 1)
    assert plan.end is None


def test_an_unsupported_precision_lists_the_ones_that_are() -> None:
    with pytest.raises(plain.DateError, match="day, second, millisecond"):
        gen.parse_precision("hour")


def test_the_older_dotted_range_spelling_still_works() -> None:
    produced = gen.render_date_range(
        {"range": "1990.01.01 - 2000.12.31", "format": "ISO"}, "en", NOW, create("unit-test")
    )
    assert produced.startswith("199") or produced.startswith("200")
