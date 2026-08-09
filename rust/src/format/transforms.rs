//! Text transforms applied to a finished value.
//!
//! Shared by three places that all mean the same thing: the `case=` attribute on
//! a `<gen>`, the compute tags, and the `${{Name|upper}}` interpolation filters.
//! One implementation, so the three cannot drift apart.
//!
//! **On uppercasing.** The C# port carries a hundred-entry table of code points
//! whose uppercase is longer than one character, because .NET's
//! `ToUpperInvariant` is a 1:1 mapping and leaves `ß` as `ß` where JavaScript,
//! Java and Python all write `SS`. Rust needs none of it: `str::to_uppercase`
//! does the full Unicode mapping, and was checked against `node` on the awkward
//! ones — `straße`, `ﬄ`, `ʼn`, `ǰ` — before this comment was written rather than
//! after.

use crate::engine::EngineResult;

/// Every name accepted after a `|` inside an interpolation.
pub const FILTER_NAMES: [&str; 12] = [
    "upper",
    "lower",
    "capitalize",
    "title",
    "mask",
    "slice",
    "replace",
    "trim",
    "group",
    "compact",
    "csv",
    "sql",
];

pub const CASE_TRANSFORMS: [&str; 4] = ["upper", "lower", "capitalize", "title"];

pub fn is_case_transform(name: &str) -> bool {
    CASE_TRANSFORMS.contains(&name)
}

pub fn is_filter_name(name: &str) -> bool {
    FILTER_NAMES.contains(&name)
}

/// Apply one interpolation filter.
///
/// An unknown filter passes the value through untouched. Filters are lenient by
/// design and the validator is where a typo gets named; failing here would turn
/// a misspelling into a dead run rather than a visible oddity in the output.
pub fn apply_filter(kind: &str, arg: Option<&str>, value: &str) -> EngineResult<String> {
    let a = arg.unwrap_or("");
    Ok(match kind {
        "mask" => super::mask::apply(a, value)?,
        "slice" => {
            let mut parts = a.split(',');
            let from = parts.next().and_then(int_or).unwrap_or(0);
            let to = parts.next().filter(|p| !p.is_empty()).and_then(int_or);
            slice(value, from, to)
        }
        "replace" => {
            // Split on the FIRST comma, so the replacement may contain one.
            let (from, to) = match a.find(',') {
                Some(comma) => (&a[..comma], &a[comma + 1..]),
                None => (a, ""),
            };
            if from.is_empty() {
                value.to_string()
            } else {
                value.replace(from, to)
            }
        }
        "trim" => value.trim().to_string(),
        "group" => {
            let (size, sep) = match a.find(',') {
                Some(comma) => (&a[..comma], &a[comma + 1..]),
                None => (a, " "),
            };
            let size = if size.is_empty() {
                3
            } else {
                int_or(size).unwrap_or(3)
            };
            group(value, size, sep)
        }
        "compact" => compact(
            value,
            if a.is_empty() {
                36
            } else {
                int_or(a).unwrap_or(36)
            },
        ),
        "csv" => csv(value),
        "sql" => sql(value),
        "upper" | "lower" | "capitalize" | "title" => apply_case(kind, value),
        _ => value.to_string(),
    })
}

/// A substring by code-point index, `[from, to)`; a missing `to` means the end.
///
/// A negative index counts from the END, which is what the reference's
/// `Array.slice` does and what Python's own slicing does. It matters:
/// `slice:-3` has to mean "the last three characters" everywhere, not "all of
/// them" in whichever implementation clamped it to zero.
pub fn slice(s: &str, from: i32, to: Option<i32>) -> String {
    let cp: Vec<char> = s.chars().collect();
    let n = cp.len() as i32;
    let f = if from < 0 {
        (n + from).max(0)
    } else {
        from.min(n)
    };
    let t = match to {
        None => n,
        Some(t) if t < 0 => (n + t).max(0),
        Some(t) => t.min(n),
    };
    if t <= f {
        String::new()
    } else {
        cp[f as usize..t as usize].iter().collect()
    }
}

/// Group characters from the *right*, so a number's last group stays whole.
pub fn group(s: &str, size: i32, sep: &str) -> String {
    if size <= 0 || s.is_empty() {
        return s.to_string();
    }
    // A decimal number is grouped where a person groups one: the digits BEFORE
    // the separator, and nowhere else. Chunking the whole string from the right
    // put the space in the fraction — `1234.56` came out `1 234 .56`, which is a
    // number in no locale, and nothing said so. Only this exact shape is treated
    // as a number: `group:4` on a card number stays the blocks it was written
    // for, and so does every other string.
    if let Some((sign, whole, fraction)) = split_decimal(s) {
        return format!(
            "{sign}{}{fraction}",
            chunk_from_right(whole, size as usize, sep)
        );
    }
    chunk_from_right(s, size as usize, sep)
}

/// `-1234.56` → `("-", "1234", ".56")`. `None` for anything that is not exactly
/// an optionally-signed integer, one dot, and at least one more digit.
fn split_decimal(s: &str) -> Option<(&str, &str, &str)> {
    let (sign, rest) = match s.as_bytes().first() {
        Some(b'+') | Some(b'-') => s.split_at(1),
        _ => ("", s),
    };
    let dot = rest.find('.')?;
    let (whole, fraction) = rest.split_at(dot);
    if whole.is_empty() || fraction.len() < 2 {
        return None;
    }
    if !whole.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if !fraction[1..].bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((sign, whole, fraction))
}

fn chunk_from_right(s: &str, size: usize, sep: &str) -> String {
    let cp: Vec<char> = s.chars().collect();
    if cp.is_empty() {
        return s.to_string();
    }
    let mut parts: Vec<String> = Vec::new();
    let mut end = cp.len();
    while end > 0 {
        let start = end.saturating_sub(size);
        parts.insert(0, cp[start..end].iter().collect());
        end = start;
    }
    parts.join(sep)
}

/// Write a whole number in a shorter alphabet: `1000000` becomes `lfls`.
///
/// The point is a unique suffix that stays readable at scale. A row id appended
/// to a generated address keeps it unique, but `john.smith2000000000@` is
/// nobody's email; in base 36 the same id is six characters and covers two
/// billion rows.
///
/// Lowercase only, and deliberately. Base 62 would be shorter, but many systems
/// fold the local part of an address to lower case, so `aB` and `Ab` would merge
/// and quietly reintroduce the duplicates the suffix exists to prevent.
pub fn compact(value: &str, radix: i32) -> String {
    let text = value.trim();
    if !is_whole_number(text) || !(2..=36).contains(&radix) {
        return value.to_string();
    }
    let Ok(n) = text.parse::<i64>() else {
        return value.to_string();
    };
    let sign = if n < 0 { "-" } else { "" };
    format!("{sign}{}", to_radix(n.unsigned_abs(), radix as u64))
}

/// Quote a value for CSV, per RFC 4180.
///
/// `<data>` assembles text and knows nothing about the file being written, so a
/// value containing the delimiter silently splits the row — a product named
/// `Knife set, 3 pcs` turns one seven-field row into eight fields, with category
/// landing in price and price in quantity, and nothing anywhere reporting an
/// error.
///
/// Quoted unconditionally rather than only when needed: a rule with no
/// exceptions is one nobody has to remember, every reader accepts redundant
/// quotes, and "only when it contains a comma" is exactly the reasoning that
/// loses to a newline later.
pub fn csv(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Escape a value for a single-quoted SQL literal by doubling apostrophes.
///
/// `O'Brien` closes the string early and the statement fails to parse — or
/// worse, in generated data, parses into something else. The body only, with no
/// surrounding quotes, so the config keeps writing `'${{Name|sql}}'` and the
/// shape of the statement stays visible where it is written.
pub fn sql(value: &str) -> String {
    value.replace('\'', "''")
}

pub fn apply_case(name: &str, s: &str) -> String {
    match name {
        "upper" => s.to_uppercase(),
        "lower" => s.to_lowercase(),
        "capitalize" => upper_first(s),
        // Only the first letter of each word moves; the rest is left as written,
        // so an already-correct "McDonald" is not flattened to "Mcdonald".
        "title" => title_case(s),
        _ => s.to_string(),
    }
}

/// `\S+` runs uppercased at the front, with the whitespace between them intact.
fn title_case(s: &str) -> String {
    let mut result = String::with_capacity(s.len());
    let mut word = String::new();
    for c in s.chars() {
        if c.is_whitespace() {
            if !word.is_empty() {
                result.push_str(&upper_first(&word));
                word.clear();
            }
            result.push(c);
        } else {
            word.push(c);
        }
    }
    result.push_str(&upper_first(&word));
    result
}

/// Uppercase the first character, by code point rather than by byte.
fn upper_first(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        None => String::new(),
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
    }
}

fn int_or(raw: &str) -> Option<i32> {
    raw.trim().parse::<i32>().ok()
}

/// `^-?\d+$`
fn is_whole_number(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// Java's `Long.toString(n, radix)`: lowercase digits, no padding.
fn to_radix(mut value: u64, radix: u64) -> String {
    if value == 0 {
        return "0".to_string();
    }
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut buffer = Vec::new();
    while value > 0 {
        buffer.push(DIGITS[(value % radix) as usize]);
        value /= radix;
    }
    buffer.reverse();
    String::from_utf8(buffer).expect("ASCII digits")
}
