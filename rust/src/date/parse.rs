//! Strict parsing for the dates a config writes by hand.
//!
//! Strict on purpose. A lenient parser would read `2026-02-30` as 2 March and
//! generate data that looks fine until someone tries to explain where March came
//! from. The separator has to match itself too, so `2026-01/01` is an error
//! rather than a guess.
//!
//! The reference states the shape as a regular expression:
//!
//! ```text
//! ^(\d{4})([./-])(\d{2})\2(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$
//! ```
//!
//! Read by hand here, since the crate has no regex dependency. The `\2` — the
//! second separator matching the first — is the part a hand-written reader is
//! most likely to drop, so it is checked explicitly below.

use super::{days_in_month, PlainDateTime};
use crate::engine::{invalid, EngineResult};

/// A parsed value plus whether the text carried a time — which decides the
/// default precision.
#[derive(Clone, Copy, Debug)]
pub struct Parsed {
    pub value: PlainDateTime,
    pub has_time: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Range {
    pub start: Parsed,
    pub end: Parsed,
}

pub fn date_time(source: &str) -> EngineResult<Parsed> {
    let text: Vec<char> = source.trim().chars().collect();
    let bad = || {
        invalid(&format!(
            "date: invalid date \"{source}\" (expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)"
        ))
    };

    // YYYY sep MM sep DD — ten characters, and the two separators must be the
    // same one.
    if text.len() < 10 {
        return bad();
    }
    let sep = text[4];
    if !matches!(sep, '.' | '/' | '-') || text[7] != sep {
        return bad();
    }
    let (Some(year), Some(month), Some(day)) = (
        digits(&text, 0, 4),
        digits(&text, 5, 2),
        digits(&text, 8, 2),
    ) else {
        return bad();
    };

    let mut value = PlainDateTime::date(year, month, day);
    let mut has_time = false;
    let mut at = 10;

    if at < text.len() {
        // `T` or a space, then HH:mm — all or nothing.
        if !matches!(text[at], 'T' | ' ') || text.len() < at + 6 || text[at + 3] != ':' {
            return bad();
        }
        let (Some(hour), Some(minute)) = (digits(&text, at + 1, 2), digits(&text, at + 4, 2))
        else {
            return bad();
        };
        has_time = true;
        value.hour = hour;
        value.minute = minute;
        at += 6;

        if at < text.len() {
            if text[at] != ':' || text.len() < at + 3 {
                return bad();
            }
            let Some(second) = digits(&text, at + 1, 2) else {
                return bad();
            };
            value.second = second;
            at += 3;

            if at < text.len() {
                // ".5" means 500 milliseconds, not 5 — pad on the right, never
                // the left.
                let fraction: String = text[at + 1..].iter().collect();
                if text[at] != '.' || fraction.is_empty() || fraction.len() > 3 {
                    return bad();
                }
                let Some(ms) = digits(&text, at + 1, fraction.len()) else {
                    return bad();
                };
                value.millisecond = ms * 10_i32.pow(3 - fraction.len() as u32);
                at = text.len();
            }
        }
    }
    if at != text.len() {
        return bad();
    }

    assert_valid(value, source)?;
    Ok(Parsed { value, has_time })
}

/// The older `range="1990.01.01 - 2000.12.31"` spelling, as `date.range` takes
/// it.
///
/// Dots and a dash rather than the `..` the `date` generator uses. Two spellings
/// for one idea is not a design anyone would choose, but the old one is in
/// configs already and silently rejecting them would be worse than carrying it.
pub fn legacy_range(source: &str) -> EngineResult<Range> {
    let text = source.trim();
    let bad = || invalid(&format!("date.range: invalid range attribute \"{source}\""));

    // `^(\d{4}\.\d{2}\.\d{2})\s*-\s*(\d{4}\.\d{2}\.\d{2})$` — both halves are a
    // fixed ten characters, so the dash is found rather than searched for.
    let chars: Vec<char> = text.chars().collect();
    if chars.len() < 21 {
        return bad();
    }
    let (left, rest) = chars.split_at(10);
    let middle: String = rest[..rest.len() - 10].iter().collect();
    let right: String = rest[rest.len() - 10..].iter().collect();

    let (before, after) = match middle.split_once('-') {
        Some(halves) => halves,
        None => return bad(),
    };
    if !before.chars().all(char::is_whitespace) || !after.chars().all(char::is_whitespace) {
        return bad();
    }
    let left: String = left.iter().collect();
    if !dotted(&left) || !dotted(&right) {
        return bad();
    }

    let (Ok(start), Ok(end)) = (date_time(&left), date_time(&right)) else {
        return bad();
    };
    Ok(Range { start, end })
}

/// `\d{4}\.\d{2}\.\d{2}` — dots only, unlike the general reader.
fn dotted(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    chars.len() == 10
        && chars[4] == '.'
        && chars[7] == '.'
        && [0, 1, 2, 3, 5, 6, 8, 9]
            .iter()
            .all(|i| chars[*i].is_ascii_digit())
}

pub fn range(source: &str) -> EngineResult<Range> {
    let parts: Vec<&str> = source.split("..").collect();
    if parts.len() != 2 {
        return invalid(&format!(
            "date: invalid range \"{source}\" (expected START..END)"
        ));
    }
    Ok(Range {
        start: date_time(parts[0])?,
        end: date_time(parts[1])?,
    })
}

/// `count` digits starting at `from`, or `None` when any of them is not one.
fn digits(text: &[char], from: usize, count: usize) -> Option<i32> {
    let slice = text.get(from..from + count)?;
    if !slice.iter().all(char::is_ascii_digit) {
        return None;
    }
    slice.iter().collect::<String>().parse().ok()
}

fn assert_valid(v: PlainDateTime, source: &str) -> EngineResult<()> {
    if v.month < 1 || v.month > 12 {
        return invalid(&format!("date: invalid month in \"{source}\""));
    }
    if v.day < 1 || v.day > days_in_month(v.year, v.month) {
        return invalid(&format!("date: invalid day in \"{source}\""));
    }
    if v.hour > 23 || v.minute > 59 || v.second > 59 {
        return invalid(&format!("date: invalid time in \"{source}\""));
    }
    Ok(())
}

/// An ISO-8601 instant as milliseconds since the epoch, or `None`.
///
/// Written for the Parquet `timestamp` column, which is the only caller that
/// needs an OFFSET: the generators all work in a single frame, and this reads
/// text a user typed. `Z` and `±HH:MM` are honoured; a bare local timestamp is
/// read as UTC, as the reference does.
pub fn iso_millis(source: &str) -> Option<i64> {
    let text = source.trim();
    if text.len() < 10 {
        return None;
    }
    let bytes = text.as_bytes();
    if bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let year: i32 = text[0..4].parse().ok()?;
    let month: i32 = text[5..7].parse().ok()?;
    let day: i32 = text[8..10].parse().ok()?;
    if !(1..=12).contains(&month) || day < 1 || day > super::days_in_month(year, month) {
        return None;
    }

    let mut millis = super::days_from_civil(year, month, day) * 86_400_000;
    let rest = &text[10..];
    if rest.is_empty() {
        return Some(millis);
    }

    // The date and the time may be joined by `T` or by a space; nothing else.
    let rest = match rest.as_bytes()[0] {
        b'T' | b't' | b' ' => &rest[1..],
        _ => return None,
    };

    // The offset, if there is one, ends the string.
    let (clock, offset_millis) = split_offset(rest)?;
    let mut parts = clock.split(':');
    let hour: i64 = parts.next()?.parse().ok()?;
    let minute: i64 = parts.next().unwrap_or("0").parse().ok()?;
    let seconds_text = parts.next().unwrap_or("0");
    if parts.next().is_some() {
        return None;
    }
    let (second_text, fraction) = match seconds_text.split_once('.') {
        None => (seconds_text, ""),
        Some((s, f)) => (s, f),
    };
    let second: i64 = second_text.parse().ok()?;
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    // Milliseconds only, as every implementation stores: a longer fraction is
    // truncated rather than rounded, which is what reading three digits does.
    let mut fraction_millis = 0i64;
    for (i, digit) in fraction.chars().take(3).enumerate() {
        let d = digit.to_digit(10)? as i64;
        fraction_millis += d * 10i64.pow(2 - i as u32);
    }
    if !fraction.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    millis += hour * 3_600_000 + minute * 60_000 + second * 1000 + fraction_millis;
    Some(millis - offset_millis)
}

/// The clock text and what its trailing offset is worth in milliseconds.
fn split_offset(rest: &str) -> Option<(&str, i64)> {
    if let Some(clock) = rest.strip_suffix(['Z', 'z']) {
        return Some((clock, 0));
    }
    // `+HH:MM` or `-HH:MM`, and only after the seconds — a leading sign is not
    // an offset.
    let at = rest.rfind(['+', '-']).filter(|at| *at > 0);
    let Some(at) = at else {
        return Some((rest, 0));
    };
    let sign = if rest.as_bytes()[at] == b'-' { -1 } else { 1 };
    let offset = &rest[at + 1..];
    let (hours, minutes) = match offset.split_once(':') {
        Some((h, m)) => (h, m),
        None if offset.len() == 4 => (&offset[..2], &offset[2..]),
        None => (offset, "0"),
    };
    let hours: i64 = hours.parse().ok()?;
    let minutes: i64 = minutes.parse().ok()?;
    Some((&rest[..at], sign * (hours * 3_600_000 + minutes * 60_000)))
}
