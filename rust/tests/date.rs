//! The date layer, checked against the calendar rather than against itself.
//!
//! A hand-written calendar is exactly the kind of code that is wrong in a
//! self-consistent way: round-tripping a value through its own two halves proves
//! nothing if both halves share a mistake. The day numbers and weekdays below
//! are facts about the world, taken from outside this crate.

use std::collections::BTreeMap;

use tdcv2::date::{self, gen, parse, PlainDateTime};
use tdcv2::prng;

fn attrs(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

fn generate(pairs: &[(&str, &str)], count: usize, seed: &str, now: i64) -> Vec<String> {
    let mut prng = prng::create(seed);
    gen::generate(&attrs(pairs), Some("en"), now, count, &mut prng)
        .unwrap_or_else(|e| panic!("{pairs:?}: {e}"))
}

/// 2026-04-23T12:00:00Z, the instant the shared fixtures pin.
const NOON: i64 = 1_776_945_600_000;

#[test]
fn the_day_count_matches_the_calendar_including_before_the_epoch() {
    // Day zero is 1970-01-01 by definition; the rest are counted days from a
    // source that is not this crate.
    for (year, month, day, expected) in [
        (1970, 1, 1, 0),
        (2026, 4, 23, 20_566),
        (2000, 1, 1, 10_957),
        (2024, 2, 29, 19_782),
        (1969, 7, 20, -165),
        // 1900 was NOT a leap year — the century rule that a naive `% 4` gets
        // wrong, and the reason this row is here.
        (1900, 3, 1, -25_508),
    ] {
        assert_eq!(
            date::days_from_civil(year, month, day),
            expected,
            "{year}-{month}-{day}"
        );
        assert_eq!(
            date::civil_from_days(expected),
            (year, month, day),
            "day {expected}"
        );
    }
}

#[test]
fn the_weekday_is_the_real_one() {
    // Sunday = 0, matching the tables. A calendar off by one day would still
    // round-trip perfectly and print the wrong weekday name every time.
    let weekday = |y, m, d| date::weekday(PlainDateTime::date(y, m, d));
    assert_eq!(weekday(2026, 4, 23), 4, "a Thursday");
    assert_eq!(weekday(2000, 1, 1), 6, "a Saturday");
    assert_eq!(weekday(1969, 7, 20), 0, "a Sunday");
}

#[test]
fn an_instant_before_the_epoch_lands_on_the_right_day() {
    // The whole reason `floor_div` exists: Rust's `/` truncates toward zero, so
    // one millisecond before the epoch would divide to day 0 and be reported as
    // 1 January 1970.
    let before = date::from_epoch_millis(-1);
    assert_eq!((before.year, before.month, before.day), (1969, 12, 31));
    assert_eq!((before.hour, before.minute, before.second), (23, 59, 59));
    assert_eq!(before.millisecond, 999);
    assert_eq!(date::to_epoch_millis(before), -1);
}

#[test]
fn a_leap_day_birthday_is_clamped_rather_than_rolled_forward() {
    // 29 February taken back to a non-leap year lands on the 28th. Rolling
    // forward instead would put it in March, which is a different month for
    // anyone reading the data.
    let leap = date::to_epoch_millis(PlainDateTime::date(2024, 2, 29));
    let back = date::from_epoch_millis(date::subtract_utc_years(leap, 1));
    assert_eq!((back.year, back.month, back.day), (2023, 2, 28));

    let four = date::from_epoch_millis(date::subtract_utc_years(leap, 4));
    assert_eq!((four.year, four.month, four.day), (2020, 2, 29));
}

#[test]
fn the_parser_refuses_a_date_that_does_not_exist() {
    // A lenient parser would read 2026-02-30 as 2 March and generate data that
    // looks fine until someone tries to explain where March came from.
    assert!(parse::date_time("2026-02-30").is_err());
    assert!(parse::date_time("2026-13-01").is_err());
    assert!(parse::date_time("2026-01-01T24:00").is_err());
    // The separator has to match itself.
    assert!(parse::date_time("2026-01/01").is_err());
    // Every accepted separator, and both time spellings.
    for text in [
        "2026-01-31",
        "2026.01.31",
        "2026/01/31",
        "2026-01-31T12:30",
        "2026-01-31 12:30:45",
    ] {
        assert!(parse::date_time(text).is_ok(), "{text}");
    }
    assert!(
        parse::date_time("2024-02-29").is_ok(),
        "2024 is a leap year"
    );
    assert!(parse::date_time("2023-02-29").is_err(), "2023 is not");
}

#[test]
fn a_fraction_pads_on_the_right() {
    // ".5" is 500 milliseconds, not 5. Padding the other way is a factor of a
    // hundred, and every value still looks like a plausible timestamp.
    let half = parse::date_time("2026-01-01T00:00:00.5").expect("parses");
    assert_eq!(half.value.millisecond, 500);
    assert_eq!(
        parse::date_time("2026-01-01T00:00:00.05")
            .expect("parses")
            .value
            .millisecond,
        50
    );
    assert_eq!(
        parse::date_time("2026-01-01T00:00:00.005")
            .expect("parses")
            .value
            .millisecond,
        5
    );
    assert!(parse::date_time("2026-01-01T00:00:00.0005").is_err());
}

#[test]
fn a_range_with_no_times_is_drawn_by_whole_days() {
    // Otherwise `range="2026-01-01..2026-01-31"` would yield timestamps at 03:47
    // when the config plainly asked for dates.
    for value in generate(
        &[("range", "2026-01-01..2026-01-31"), ("format", "ISO_TIME")],
        20,
        "days",
        NOON,
    ) {
        assert!(value.ends_with("T00:00:00"), "{value}");
        assert!(value.starts_with("2026-01-"), "{value}");
    }
}

#[test]
fn precision_decides_what_the_single_draw_is_over() {
    // One draw either way, so the two disagree on every row rather than
    // occasionally — which is why precision is not cosmetic.
    let by_day = generate(
        &[
            ("range", "2026-01-01T00:00:00..2026-01-01T23:59:59"),
            ("format", "ISO_TIME"),
            ("precision", "day"),
        ],
        5,
        "grain",
        NOON,
    );
    let by_second = generate(
        &[
            ("range", "2026-01-01T00:00:00..2026-01-01T23:59:59"),
            ("format", "ISO_TIME"),
            ("precision", "second"),
        ],
        5,
        "grain",
        NOON,
    );
    assert!(
        by_day.iter().all(|v| v.ends_with("T00:00:00")),
        "{by_day:?}"
    );
    assert!(
        by_second.iter().any(|v| !v.ends_with("T00:00:00")),
        "{by_second:?}"
    );
}

#[test]
fn today_reads_the_run_clock_and_takes_no_draw() {
    // No draw at all: a fixed value must not shift the columns that follow it.
    let mut prng = prng::create("clock");
    let before = prng.next();
    let mut same = prng::create("clock");
    let values = gen::generate(
        &attrs(&[("value", "today"), ("format", "ISO")]),
        Some("en"),
        NOON,
        3,
        &mut same,
    )
    .expect("generates");
    assert_eq!(values, ["2026-04-23", "2026-04-23", "2026-04-23"]);
    assert_eq!(same.next(), before, "a fixed date must consume no draw");
}

#[test]
fn a_birth_range_is_bounded_by_the_ages_asked_for() {
    let values = generate(
        &[
            ("value", "birth"),
            ("oldest", "70"),
            ("youngest", "14"),
            ("format", "ISO"),
        ],
        50,
        "birth",
        NOON,
    );
    for value in &values {
        let year: i32 = value[..4].parse().expect("a year");
        assert!((1956..=2012).contains(&year), "{value}");
    }
    assert!(gen::check_birth_ages(&attrs(&[("oldest", "10"), ("youngest", "40")])).is_err());
    assert!(gen::check_birth_ages(&attrs(&[("oldest", "200")])).is_err());
}

#[test]
fn the_format_tokens_mean_what_moment_means_by_them() {
    // `MM` is a month and `mm` is minutes; `DD` is a day and `dddd` is a weekday
    // name. Getting either pair the wrong way round produces a date that is
    // wrong and perfectly readable.
    let v = PlainDateTime {
        year: 2026,
        month: 4,
        day: 23,
        hour: 9,
        minute: 5,
        second: 7,
        millisecond: 42,
    };
    let f = |pattern: &str| date::format::format(v, Some(pattern), Some("en"));
    assert_eq!(f("YYYY-MM-DD"), "2026-04-23");
    assert_eq!(f("YY/M/D"), "26/4/23");
    assert_eq!(f("HH:mm:ss.SSS"), "09:05:07.042");
    assert_eq!(f("dddd, MMMM D, YYYY"), "Thursday, April 23, 2026");
    assert_eq!(f("ddd MMM"), "Thu Apr");
    assert_eq!(f("ISO_TIME"), "2026-04-23T09:05:07");
    assert_eq!(f("Z ZZ"), "+00:00 +0000");
    // Brackets protect text that would otherwise be read as tokens.
    assert_eq!(f("[Day] D [of] MMMM"), "Day 23 of April");
    assert!(date::format::check_format("[unterminated").is_err());
}

#[test]
fn a_month_inside_a_date_takes_the_form_that_language_needs() {
    // Russian's dictionary form is «апрель»; a date needs «апреля». The tables
    // carry the form a date needs, which is why they are not the month list a
    // config draws a month NAME from.
    let v = PlainDateTime::date(2026, 4, 23);
    assert_eq!(
        date::format::format(v, Some("LL"), Some("ru")),
        "23 апреля 2026 г."
    );
    assert_eq!(date::format::format(v, Some("L"), Some("de")), "23.04.2026");
    assert_eq!(date::format::format(v, Some("L"), Some("en")), "04/23/2026");
    // An unknown language falls back to English rather than refusing: a country
    // pack may have no date table of its own yet.
    assert_eq!(
        date::format::format(v, Some("MMMM"), Some("kl")),
        date::format::format(v, Some("MMMM"), Some("en"))
    );
}

#[test]
fn the_older_range_spelling_still_works() {
    // `date.range` takes `1990.01.01 - 2000.12.31` — dots and a dash, not the
    // `..` the date generator uses. Two spellings for one idea is not a design
    // anyone would choose, but the old one is in configs already.
    let mut prng = prng::create("legacy");
    let values = gen::legacy_range(
        &attrs(&[("range", "1990.01.01 - 2000.12.31"), ("format", "ISO")]),
        Some("en"),
        NOON,
        20,
        &mut prng,
    )
    .expect("generates");
    for value in &values {
        let year: i32 = value[..4].parse().expect("a year");
        assert!((1990..=2000).contains(&year), "{value}");
    }
    assert!(
        parse::legacy_range("1990-01-01 - 2000-12-31").is_err(),
        "dots only"
    );
    assert!(parse::legacy_range("1990.01.01..2000.12.31").is_err());
}
