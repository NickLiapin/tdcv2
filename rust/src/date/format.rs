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

/// The named formats, longest first — the order they have to be tried in. `LLLL` before
/// `LLL` before `LL` before `L`, and `ISO_TIME` before `ISO`, or a longer name is read as
/// a shorter one followed by letters nobody asked for.
const NAMED_FORMATS: [&str; 6] = ["LLLL", "LLL", "LL", "L", "ISO_TIME", "ISO"];

/// The letters a TOKEN is spelled with, plus the two a reader arrives with from elsewhere.
///
/// `A`/`a` is Moment's AM/PM and `h` its 12-hour clock; TDC has neither, and a format
/// carrying them was written by somebody expecting them to work. Letters outside this set
/// — the `o` and `f` of `of`, the `t` and `e` of `date:` — are ordinary words, and a word
/// beside a date is a reasonable thing to write unbracketed.
const TOKEN_LETTERS: [char; 13] = [
    'Y', 'M', 'D', 'd', 'H', 'h', 'm', 's', 'S', 'Z', 'A', 'a', 'L',
];

pub fn locale(name: Option<&str>) -> &'static DateLocale {
    locales::resolve(name)
}

/// Whether a format string is well formed, without a date to apply it to.
pub fn check_format(format: &str) -> EngineResult<()> {
    // The same walk the formatter does, so what is refused here is exactly what would have
    // been printed as literal text there. A near-miss token used to pass validation and then
    // print itself: `hh:mm A` gave `hh:00 A`, `YYY` gave `24Y`, and the run said nothing.
    let chars: Vec<char> = format.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            match chars[i + 1..].iter().position(|c| *c == ']') {
                Some(end) => i += end + 2,
                None => return invalid(&format!("date format: unterminated literal \"{format}\"")),
            }
            continue;
        }
        let rest: String = chars[i..].iter().collect();
        if let Some(name) = NAMED_FORMATS.iter().find(|n| rest.starts_with(**n)) {
            i += name.chars().count();
            continue;
        }
        if let Some(token) = TOKENS.iter().find(|tk| rest.starts_with(**tk)) {
            i += token.chars().count();
            continue;
        }
        if TOKEN_LETTERS.contains(&chars[i]) {
            // The whole run, so the message names what the writer typed rather than one letter.
            let mut end = i;
            while end < chars.len() && TOKEN_LETTERS.contains(&chars[end]) {
                end += 1;
            }
            let run: String = chars[i..end].iter().collect();
            return invalid(&format!(
                "date format: \"{run}\" is not a token — write it as [{run}] if it is meant to be literal text"
            ));
        }
        i += 1;
    }
    Ok(())
}

pub fn format(value: PlainDateTime, pattern: Option<&str>, locale_name: Option<&str>) -> String {
    let locale = locales::resolve(locale_name);
    let expanded = expand(pattern.unwrap_or("L"), locale);
    let chars: Vec<char> = expanded.chars().collect();

    let mut result = String::new();
    // Whether a day-of-month token has already been rendered; `MMMM` reads it to
    // pick between the month's two forms. See `render`.
    let mut after_day = false;
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
                result.push_str(&render(token, value, locale, after_day));
                if *token == "D" || *token == "DD" {
                    after_day = true;
                }
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

/// What one named format stands for.
fn named(name: &str, locale: &DateLocale) -> String {
    match name {
        "ISO" => "YYYY-MM-DD".to_string(),
        "ISO_TIME" => "YYYY-MM-DDTHH:mm:ss".to_string(),
        "L" => locale.formats[0].to_string(),
        "LL" => locale.formats[1].to_string(),
        "LLL" => locale.formats[2].to_string(),
        _ => locale.formats[3].to_string(),
    }
}

/// Replace every named format with the tokens it stands for, once.
///
/// These are TOKENS, not whole formats: the reference table documents them beside `YYYY`
/// and `MM`, and a reader who writes `LL [at] HH:mm` is owed the date the table promises.
/// They used to be matched against the WHOLE format string, so `LL` alone worked and
/// `LL HH:mm` printed the literal text `LL 00:00` — the config was accepted, the run
/// succeeded, and the file was wrong.
///
/// Bracketed text is skipped, so `[LL]` stays the letters. The result is not expanded
/// again: a locale's own `LL` is written in plain tokens, and a second pass could only
/// find a name a locale had put there, which would be a loop rather than a feature.
fn expand(pattern: &str, locale: &DateLocale) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '[' {
            match chars[i + 1..].iter().position(|c| *c == ']') {
                Some(end) => {
                    out.extend(&chars[i..=i + end + 1]);
                    i += end + 2;
                }
                None => {
                    // Left for the caller to report, so the message is the one it always was.
                    out.extend(&chars[i..]);
                    break;
                }
            }
            continue;
        }
        let rest: String = chars[i..].iter().collect();
        match NAMED_FORMATS.iter().find(|name| rest.starts_with(**name)) {
            Some(name) => {
                out.push_str(&named(name, locale));
                i += name.chars().count();
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// `after_day` — whether a day-of-month token has already been rendered.
///
/// Half the world writes the month differently depending on whether a day number
/// stands beside it. Russian says `январь` alone and `15 января 2026` in a date;
/// Polish, Ukrainian, Greek, Czech and Finnish all shift too. English and
/// Hungarian do not, and put the month first anyway.
///
/// `MMMM` renders the in-date form when a day token came BEFORE it, and the
/// standalone form otherwise — the rule the reference applies, read off the
/// format string alone so all five implementations agree:
///
///   D. MMMM YYYY      -> in-date     Czech, Finnish, Russian
///   MMMM D, YYYY      -> standalone  English
///   YYYY. MMMM D.     -> standalone  Hungarian, which wants the nominative
///   dddd, D MMMM YYYY -> in-date     `dddd` is a weekday, not a day number
fn render(token: &str, v: PlainDateTime, locale: &DateLocale, after_day: bool) -> String {
    let month = (v.month - 1).clamp(0, 11) as usize;
    match token {
        "YYYY" => pad(v.year, 4),
        "YY" => pad(v.year % 100, 2),
        "MMMM" => match locale.months_in_date {
            Some(in_date) if after_day => in_date[month].to_string(),
            _ => locale.months[month].to_string(),
        },
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
