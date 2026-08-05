//! Dates: a calendar, a strict parser, a formatter and the generator over them.
//!
//! Written out rather than taken from a crate, and the reason is the same one
//! that keeps the whole crate dependency-free: a date library carries its own
//! idea of what a leap second, a locale and a rounding rule are, and any of the
//! three differing from the reference by a day shows up as data that looks
//! perfectly ordinary and is wrong. The arithmetic below is small enough to
//! state exactly.
//!
//! Everything here is UTC. A generator that quietly used the machine's zone
//! would produce different data in Moscow and in Denver from the same seed,
//! which is the one thing the product promises never happens.

pub mod calendar;
pub mod format;
pub mod gen;
pub mod locales;
pub mod parse;

pub const MS_PER_DAY: i64 = 86_400_000;

/// A calendar instant with no zone attached.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PlainDateTime {
    pub year: i32,
    pub month: i32,
    pub day: i32,
    pub hour: i32,
    pub minute: i32,
    pub second: i32,
    pub millisecond: i32,
}

impl PlainDateTime {
    pub fn date(year: i32, month: i32, day: i32) -> Self {
        Self {
            year,
            month,
            day,
            ..Self::default()
        }
    }

    pub fn start_of_day(self) -> Self {
        Self {
            hour: 0,
            minute: 0,
            second: 0,
            millisecond: 0,
            ..self
        }
    }
}

pub fn is_leap_year(year: i32) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

pub fn days_in_month(year: i32, month: i32) -> i32 {
    match month {
        2 => {
            if is_leap_year(year) {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01, by Howard Hinnant's civil-calendar algorithm.
///
/// The shift to a March-based year is what makes it work: with February last,
/// the leap day is the final day of the year and every other month's length
/// follows one formula. Written out because the alternative is a table of
/// cumulative day counts that has to be right twice.
pub fn days_from_civil(year: i32, month: i32, day: i32) -> i64 {
    let y = i64::from(year) - i64::from(month <= 2);
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let m = i64::from(month);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// The inverse of [`days_from_civil`].
pub fn civil_from_days(days: i64) -> (i32, i32, i32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], March = 0
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = mp + if mp < 10 { 3 } else { -9 }; // [1, 12]
    ((y + i64::from(m <= 2)) as i32, m as i32, d as i32)
}

pub fn to_epoch_millis(v: PlainDateTime) -> i64 {
    days_from_civil(v.year, v.month, v.day) * MS_PER_DAY
        + i64::from(v.hour) * 3_600_000
        + i64::from(v.minute) * 60_000
        + i64::from(v.second) * 1_000
        + i64::from(v.millisecond)
}

pub fn from_epoch_millis(ms: i64) -> PlainDateTime {
    let day = floor_div(ms, MS_PER_DAY);
    let mut rest = ms - day * MS_PER_DAY;
    let (year, month, d) = civil_from_days(day);
    let hour = rest / 3_600_000;
    rest -= hour * 3_600_000;
    let minute = rest / 60_000;
    rest -= minute * 60_000;
    let second = rest / 1_000;
    PlainDateTime {
        year,
        month,
        day: d,
        hour: hour as i32,
        minute: minute as i32,
        second: second as i32,
        millisecond: (rest - second * 1_000) as i32,
    }
}

pub fn to_epoch_day(v: PlainDateTime) -> i64 {
    floor_div(to_epoch_millis(v.start_of_day()), MS_PER_DAY)
}

pub fn from_epoch_day(day: i64) -> PlainDateTime {
    from_epoch_millis(day * MS_PER_DAY)
}

/// Step back whole years, clamping the day.
///
/// The clamp is what keeps 29 February from silently becoming 1 March: a
/// birthday on a leap day, taken back to a non-leap year, lands on the 28th.
pub fn subtract_utc_years(ms: i64, years: i32) -> i64 {
    let source = from_epoch_millis(ms);
    let year = source.year - years;
    let day = source.day.min(days_in_month(year, source.month));
    to_epoch_millis(PlainDateTime {
        year,
        day,
        ..source
    })
}

/// Day of week, Sunday = 0, to match the weekday tables.
///
/// 1970-01-01 was a Thursday, which is where the `+ 4` comes from.
pub fn weekday(v: PlainDateTime) -> usize {
    (days_from_civil(v.year, v.month, v.day) + 4).rem_euclid(7) as usize
}

/// Division that rounds toward negative infinity, as the reference's does.
///
/// Rust's `/` truncates toward zero, so a millisecond before the epoch would
/// otherwise land on the wrong day — the only place in the whole crate where a
/// date before 1970 differs from one after it.
pub fn floor_div(a: i64, b: i64) -> i64 {
    let q = a / b;
    if a % b != 0 && (a < 0) != (b < 0) {
        q - 1
    } else {
        q
    }
}
