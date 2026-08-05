//! Walking a date range instead of drawing from it: `step=` and `weekdays=`.
//!
//! A step is EITHER a fixed span or a calendar span, and never both. The
//! distinction is not pedantry: `15m` is always 900 000 milliseconds, while
//! `1mo` is 28, 29, 30 or 31 days depending on where you start. They compose
//! within their own group — `1h30m`, `1y6mo` — and refuse to compose across it,
//! because "one month and fifteen days" depends on which is applied first, and a
//! config whose meaning turns on an invisible ordering is worse than one that
//! will not parse. Allowing the mix later is easy; changing what it already
//! means is not.

use super::{
    days_in_month, from_epoch_millis, to_epoch_millis, weekday, PlainDateTime, MS_PER_DAY,
};

const MS_PER_SECOND: i64 = 1000;

/// How far one row advances: milliseconds, or months. Exactly one is non-zero.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StepSpec {
    pub ms: i64,
    pub months: i64,
}

/// Why a `step=` was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StepError {
    /// A spelling this notation does not have.
    Syntax,
    /// A calendar unit and a fixed one in the same step.
    Mixed,
}

/// What a `step=` may say, for a diagnostic to quote.
pub const STEP_SYNTAX: &str = "15m, 1h30m, 2d, 3mo, 1y — units s, m, h, d, w, mo, y";

/// The default step of a walked axis: one day.
pub const DEFAULT_STEP: StepSpec = StepSpec {
    ms: MS_PER_DAY,
    months: 0,
};

/// Milliseconds in a fixed unit. `m` is MINUTE, as it is everywhere this
/// notation is used.
fn fixed_unit_ms(unit: &str) -> Option<i64> {
    match unit {
        "s" => Some(MS_PER_SECOND),
        "m" => Some(60 * MS_PER_SECOND),
        "h" => Some(3600 * MS_PER_SECOND),
        "d" => Some(MS_PER_DAY),
        "w" => Some(7 * MS_PER_DAY),
        _ => None,
    }
}

/// Months in a calendar unit.
///
/// `mo` rather than `m` because `m` is already the minute, and rather than `M`
/// because the difference between three minutes and three months would then rest
/// on the case of one letter — a distinction no reader checks and no tool that
/// normalizes case preserves.
fn calendar_unit_months(unit: &str) -> Option<i64> {
    match unit {
        "mo" => Some(1),
        "y" => Some(12),
        _ => None,
    }
}

/// `step="15m"`, `step="1h30m"`, `step="3mo"`, `step="2"` — how far a row moves.
///
/// A bare number means DAYS, the default unit, so `step="2"` is every other day.
/// A unit may appear once: `1h30m1h` is a typo, and summing it would hide the
/// typo rather than report it.
pub fn parse_step(raw: Option<&str>) -> Result<StepSpec, StepError> {
    let value = raw.unwrap_or("").trim().to_ascii_lowercase();
    if value.is_empty() {
        return Ok(DEFAULT_STEP);
    }
    if value.chars().all(|c| c.is_ascii_digit()) {
        let days: i64 = value.parse().map_err(|_| StepError::Syntax)?;
        return if days >= 1 {
            Ok(StepSpec {
                ms: days * MS_PER_DAY,
                months: 0,
            })
        } else {
            Err(StepError::Syntax)
        };
    }

    let mut ms = 0i64;
    let mut months = 0i64;
    let mut seen: Vec<String> = Vec::new();
    let bytes = value.as_bytes();
    let mut at = 0usize;
    while at < bytes.len() {
        let digits_from = at;
        while at < bytes.len() && bytes[at].is_ascii_digit() {
            at += 1;
        }
        if at == digits_from {
            return Err(StepError::Syntax);
        }
        let count: i64 = value[digits_from..at]
            .parse()
            .map_err(|_| StepError::Syntax)?;

        let unit_from = at;
        while at < bytes.len() && bytes[at].is_ascii_alphabetic() {
            at += 1;
        }
        let unit = &value[unit_from..at];
        if unit.is_empty() {
            return Err(StepError::Syntax);
        }
        if seen.iter().any(|u| u == unit) {
            return Err(StepError::Syntax);
        }
        seen.push(unit.to_string());

        if let Some(per) = fixed_unit_ms(unit) {
            ms += count * per;
        } else if let Some(per) = calendar_unit_months(unit) {
            months += count * per;
        } else {
            return Err(StepError::Syntax);
        }
    }

    if ms > 0 && months > 0 {
        return Err(StepError::Mixed);
    }
    if ms == 0 && months == 0 {
        return Err(StepError::Syntax);
    }
    Ok(StepSpec { ms, months })
}

/// `start` advanced by `n` steps.
///
/// A calendar month has no fixed length, so stepping by month or year keeps the
/// DAY OF MONTH and clamps it to the last day of a shorter one: 31 January plus
/// one month is 28 February, not 3 March. That is the same rule
/// `subtract_utc_years` already applies to `person.b_day`, so the engine answers
/// one way about calendars rather than two.
pub fn add_step(start: PlainDateTime, step: StepSpec, n: i64) -> PlainDateTime {
    if step.months == 0 {
        return from_epoch_millis(to_epoch_millis(start) + n * step.ms);
    }
    let months = i64::from(start.year) * 12 + i64::from(start.month - 1) + n * step.months;
    let year = months.div_euclid(12) as i32;
    let month = months.rem_euclid(12) as i32 + 1;
    PlainDateTime {
        year,
        month,
        day: start.day.min(days_in_month(year, month)),
        ..start
    }
}

/// How many steps fit in `start..end`, counting both ends.
///
/// Computed rather than counted, because a second-by-second span of a century is
/// a number no loop should walk. A fixed step divides; a calendar one is
/// estimated from the month difference and corrected by at most one, which is
/// what the clamping in `add_step` can cost.
pub fn steps_between(start: PlainDateTime, end: PlainDateTime, step: StepSpec) -> i64 {
    if step.months == 0 {
        let span = to_epoch_millis(end) - to_epoch_millis(start);
        return if span < 0 { 1 } else { span / step.ms + 1 };
    }
    let months =
        i64::from(end.year - start.year) * 12 + i64::from(end.month) - i64::from(start.month);
    let mut n = months.div_euclid(step.months);
    if n < 0 {
        return 1;
    }
    if to_epoch_millis(add_step(start, step, n)) > to_epoch_millis(end) {
        n -= 1;
    }
    n + 1
}

/// True when every row of this step lands on the same weekday.
///
/// A calendar step does, and so does any whole number of weeks — `14d` as much
/// as `2w`, which a test on the unit's NAME would have missed. A weekday filter
/// over such a step matches every row or none, so it is refused rather than
/// silently producing a full column or an empty one.
pub fn fixes_weekday(step: StepSpec) -> bool {
    step.months > 0 || step.ms % (7 * MS_PER_DAY) == 0
}

const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/// What a `weekdays=` may say, for a diagnostic to quote.
pub fn weekday_names() -> String {
    WEEKDAYS.join(", ")
}

/// `weekdays="mon..fri"` or `weekdays="sun,wed"` — which weekdays an axis keeps.
///
/// `..` is the range operator everywhere else in the language, so it is the range
/// operator here. A SPAN wraps: `fri..mon` is Friday, Saturday, Sunday, Monday,
/// because a week is a circle and refusing to go round it would make half the
/// spans unwritable. Returns `None` on a name it does not know, so the caller can
/// say which.
pub fn parse_weekdays(raw: Option<&str>) -> Option<[bool; 7]> {
    let value = raw.unwrap_or("").trim().to_ascii_lowercase();
    if value.is_empty() {
        return None;
    }
    let mut keep = [false; 7];
    for part in value.split(',') {
        let span = part.trim();
        if span.is_empty() {
            return None;
        }
        match span.find("..") {
            None => keep[WEEKDAYS.iter().position(|d| *d == span)?] = true,
            Some(at) => {
                let first = WEEKDAYS.iter().position(|d| *d == span[..at].trim())?;
                let last = WEEKDAYS.iter().position(|d| *d == span[at + 2..].trim())?;
                let mut day = first;
                loop {
                    keep[day] = true;
                    if day == last {
                        break;
                    }
                    day = (day + 1) % 7;
                }
            }
        }
    }
    Some(keep)
}

/// The weekday of a date, 0 = Sunday, matching [`parse_weekdays`].
pub fn weekday_of(value: PlainDateTime) -> usize {
    weekday(value)
}
