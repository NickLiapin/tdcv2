//! The Moment-style formatting subset TDC uses.
//!
//! `YYYY-MM-DD`, `MMMM D, YYYY`, `dddd` for a weekday name. The tokens are
//! Moment's because that is what the reference chose and what every config
//! already written expects; the point here is that they mean the same thing in
//! every implementation, so `MM` is always a two-digit month and `mm` is always
//! minutes.
//!
//! An unknown token is passed through as text by design — that is how a format
//! can hold ordinary words — so `[...]` brackets exist to protect text that
//! WOULD be read as a token. They are the only thing in a format string that can
//! actually be malformed.

use super::locales::{self, DateLocale};
use super::{weekday, PlainDateTime};
use crate::engine::{invalid, EngineResult};

/// Longest first: `MMMM` must be recognised before `MMM` and `MM`.
const TOKENS: [&str; 19] = [
    "YYYY", "MMMM", "dddd", "MMM", "ddd", "SSS", "YY", "MM", "DD", "HH", "mm", "ss", "ZZ", "M",
    "D", "H", "m", "s", "Z",
];

pub fn locale(name: Option<&str>) -> &'static DateLocale {
    locales::resolve(name)
}

/// Whether a format string is well formed, without a date to apply it to.
pub fn check_format(format: &str) -> EngineResult<()> {
    let chars: Vec<char> = format.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            match chars[i + 1..].iter().position(|c| *c == ']') {
                Some(end) => i += end + 2,
                None => return invalid(&format!("date format: unterminated literal \"{format}\"")),
            }
        } else {
            i += 1;
        }
    }
    Ok(())
}

pub fn format(value: PlainDateTime, pattern: Option<&str>, locale_name: Option<&str>) -> String {
    let locale = locales::resolve(locale_name);
    let expanded = expand(pattern.unwrap_or("L"), locale);
    let chars: Vec<char> = expanded.chars().collect();

    let mut result = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            // An unterminated bracket cannot reach here — `check_format` runs
            // first — so the rest of the string is taken literally rather than
            // failing at the point where nothing can be reported.
            match chars[i + 1..].iter().position(|c| *c == ']') {
                Some(end) => {
                    result.extend(&chars[i + 1..i + 1 + end]);
                    i += end + 2;
                }
                None => {
                    result.extend(&chars[i + 1..]);
                    i = chars.len();
                }
            }
            continue;
        }

        match TOKENS.iter().find(|t| starts_at(&chars, i, t)) {
            Some(token) => {
                result.push_str(&render(token, value, locale));
                i += token.chars().count();
            }
            None => {
                result.push(chars[i]);
                i += 1;
            }
        }
    }
    result
}

fn starts_at(chars: &[char], at: usize, token: &str) -> bool {
    token
        .chars()
        .enumerate()
        .all(|(i, c)| chars.get(at + i) == Some(&c))
}

fn expand(pattern: &str, locale: &DateLocale) -> String {
    match pattern {
        "ISO" => "YYYY-MM-DD".to_string(),
        "ISO_TIME" => "YYYY-MM-DDTHH:mm:ss".to_string(),
        "L" => locale.formats[0].to_string(),
        "LL" => locale.formats[1].to_string(),
        "LLL" => locale.formats[2].to_string(),
        "LLLL" => locale.formats[3].to_string(),
        other => other.to_string(),
    }
}

fn render(token: &str, v: PlainDateTime, locale: &DateLocale) -> String {
    let month = (v.month - 1).clamp(0, 11) as usize;
    match token {
        "YYYY" => pad(v.year, 4),
        "YY" => pad(v.year % 100, 2),
        "MMMM" => locale.months[month].to_string(),
        "MMM" => locale.months_short[month].to_string(),
        "MM" => pad(v.month, 2),
        "M" => v.month.to_string(),
        "DD" => pad(v.day, 2),
        "D" => v.day.to_string(),
        "dddd" => locale.weekdays[weekday(v)].to_string(),
        "ddd" => locale.weekdays_short[weekday(v)].to_string(),
        "HH" => pad(v.hour, 2),
        "H" => v.hour.to_string(),
        "mm" => pad(v.minute, 2),
        "m" => v.minute.to_string(),
        "ss" => pad(v.second, 2),
        "s" => v.second.to_string(),
        "SSS" => pad(v.millisecond, 3),
        // Every value is UTC, so the offset is not read from anywhere.
        "Z" => "+00:00".to_string(),
        "ZZ" => "+0000".to_string(),
        other => other.to_string(),
    }
}

/// Left-padded with zeros to `width`, and never truncated — a five-digit year
/// stays five digits.
fn pad(value: i32, width: usize) -> String {
    let text = value.to_string();
    "0".repeat(width.saturating_sub(text.chars().count())) + &text
}
