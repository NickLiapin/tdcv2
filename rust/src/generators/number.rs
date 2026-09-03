//! `<gen type="number"/>` — digits, ranges and decimals.
//!
//! The paths here are the ones the shared cases exercise: a plain width
//! (`length="6"`), one or more inclusive ranges (`value="1..9"`,
//! `value="[1..9],[20..30]"`), and decimals. Zero-padding is implied by how the
//! bounds were written, never by their magnitude — `00..99` pads and `0..99`
//! does not.
//!
//! `include=` and `exclude=` are interval arithmetic rather than enumeration, so
//! `value="1..1000000000" exclude="7"` stays instant instead of listing a
//! billion numbers to drop one. `percent=` apportions rows between length groups
//! exactly, over the whole column.

use std::collections::BTreeMap;

use super::rand;
use super::scan;
use crate::distribution::percent_mask;
use crate::engine::{invalid, EngineError, EngineResult};
use crate::prng::Sfc32;
use crate::stats::hamilton;

/// An inclusive integer range; `width` is the zero-padding the source implied.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub min: i64,
    pub max: i64,
    pub width: usize,
}

/// One entry of `length="2,10-12"`: a fixed width, or a range of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LengthChoice {
    pub min: i32,
    pub max: i32,
}

pub fn generate(
    attrs: &BTreeMap<String, String>,
    count: usize,
    prng: &mut Sfc32,
) -> EngineResult<Vec<String>> {
    let attr = |name: &str| attrs.get(name).map(String::as_str);

    let range_spec = attr("value").unwrap_or("").trim().to_string();
    let ranges: Vec<Range> = if range_spec.is_empty() {
        Vec::new()
    } else {
        parse_ranges(&range_spec)?
    };

    let has_explicit_length = attrs.contains_key("length");
    let length_choices: Vec<LengthChoice> = if has_explicit_length {
        parse_length_choices(attr("length").unwrap_or(""))?
    } else if ranges.is_empty() {
        vec![LengthChoice { min: 1, max: 1 }]
    } else {
        Vec::new()
    };

    let allow_leading_zero = match attr("first_zero") {
        Some(raw) => match raw.trim() {
            "true" => true,
            "false" => false,
            other => return invalid(&format!("number generator: invalid first_zero \"{other}\"")),
        },
        None => !ranges.is_empty() || !has_explicit_length,
    };

    let percent = attr("percent");
    if let Some(percent) = percent {
        if length_choices.len() <= 1 {
            // Validated even though it cannot select anything with one choice:
            // a mask that is wrong should still say so, and it is the same
            // complaint the reference makes.
            percent_mask::expand(percent, length_choices.len())
                .map_err(|e| EngineError::Invalid(e.message))?;
        }
    }

    let include = attr("include").unwrap_or("");
    let exclude = attr("exclude").unwrap_or("");
    let has_modifiers = !include.trim().is_empty() || !exclude.trim().is_empty();

    let mut allowed: Option<Vec<Interval>> = None;
    let mut allowed_width = 0usize;
    if has_modifiers {
        if ranges.is_empty() {
            return invalid(
                "number generator: include/exclude require a numeric range in \"value\", \
                 e.g. value=\"0..9\"",
            );
        }
        allowed = Some(compute_allowed(&ranges, include, exclude)?);
        allowed_width = ranges.iter().map(|r| r.width).find(|w| *w > 0).unwrap_or(0);
    }

    let decimals = parse_decimals(attr("decimals"))?;
    if decimals > 0 && !ranges.is_empty() && allowed.is_none() {
        return Ok((0..count)
            .map(|_| random_decimal(&ranges, decimals, prng))
            .collect());
    }

    let widths = materialize_widths(count, &length_choices, percent, prng)?;
    let mut result = Vec::with_capacity(count);
    for width in widths {
        let value = match &allowed {
            Some(intervals) => draw_guarded(
                intervals,
                if width > 0 { width } else { allowed_width },
                allow_leading_zero,
                prng,
            ),
            None if ranges.is_empty() => digit_string(width, allow_leading_zero, prng),
            None => draw_guarded_range(&ranges, width, allow_leading_zero, prng),
        };
        result.push(value);
    }

    Ok(result)
}

pub fn parse_ranges(source: &str) -> EngineResult<Vec<Range>> {
    let spec = source.trim();
    if spec.is_empty() {
        return invalid("number generator: range is empty");
    }

    if spec == "bit" {
        return Ok(vec![Range {
            min: 0,
            max: 1,
            width: 0,
        }]);
    }

    // Split, then parse each piece — never one pattern over the whole string.
    // Splitting on a comma is linear; the bracket scan it replaces had to be
    // written by index for the same reason.
    let mut ranges = Vec::new();
    for piece in spec.split(',') {
        ranges.push(parse_range_item(piece, source)?);
    }
    Ok(ranges)
}

/// One comma-separated piece: `45`, `34..89`, or either wrapped in brackets.
fn parse_range_item(piece: &str, source: &str) -> EngineResult<Range> {
    let mut item = piece.trim();
    if item.starts_with('[') {
        let Some(stripped) = item.strip_suffix(']') else {
            return invalid(&format!(
                "number generator: invalid range list \"{source}\""
            ));
        };
        item = stripped[1..].trim();
    }
    // A bracket left INSIDE a piece means the list itself is malformed — a
    // missing comma, as in `[1..9] [2..3]`. Saying "invalid range list" there is
    // the useful answer.
    if item.contains('[') || item.contains(']') || item.is_empty() {
        return invalid(&format!(
            "number generator: invalid range list \"{source}\""
        ));
    }
    // A bare number is the range of one point, so the drawing code, the uniq
    // capacity check and include/exclude all keep working on it unchanged.
    if scan::is_single_int(item) {
        return make_range(item, item, item);
    }
    parse_range(item)
}

fn parse_range(range: &str) -> EngineResult<Range> {
    let Some((min_text, max_text)) = scan::split_range(range) else {
        return invalid(&format!(
            "number generator: invalid range \"{range}\" (expected MIN..MAX)"
        ));
    };
    make_range(min_text, max_text, range)
}

fn make_range(min_text: &str, max_text: &str, source: &str) -> EngineResult<Range> {
    let (Ok(min), Ok(max)) = (min_text.parse::<i64>(), max_text.parse::<i64>()) else {
        return invalid(&format!(
            "number generator: invalid range \"{source}\" (expected MIN..MAX)"
        ));
    };
    if min > max {
        return invalid(&format!(
            "number generator: invalid numeric range \"{source}\""
        ));
    }
    Ok(Range {
        min,
        max,
        width: infer_width(min_text, max_text),
    })
}

/// Zero-padding is implied by the way the bounds were written, never by magnitude.
fn infer_width(min_text: &str, max_text: &str) -> usize {
    if min_text.starts_with('-') || max_text.starts_with('-') {
        return 0;
    }
    let leading_zero = |s: &str| s.len() > 1 && s.starts_with('0');
    if leading_zero(min_text) || leading_zero(max_text) {
        min_text.len().max(max_text.len())
    } else {
        0
    }
}

pub fn parse_length_choices(source: &str) -> EngineResult<Vec<LengthChoice>> {
    let mut choices = Vec::new();
    for raw in source.split(',') {
        let part = raw.trim();
        if part.is_empty() {
            continue;
        }
        if let Some((min, max)) = scan::split_length_range(part) {
            match (min.parse::<i32>(), max.parse::<i32>()) {
                (Ok(min), Ok(max)) => {
                    choices.push(LengthChoice { min, max });
                    continue;
                }
                _ => return invalid(&format!("number generator: invalid length \"{part}\"")),
            }
        }
        match part.parse::<i32>() {
            Ok(one) => choices.push(LengthChoice { min: one, max: one }),
            Err(_) => return invalid(&format!("number generator: invalid length \"{part}\"")),
        }
    }

    if choices.is_empty() {
        return invalid(&format!("number generator: invalid length \"{source}\""));
    }
    Ok(choices)
}

fn materialize_widths(
    count: usize,
    choices: &[LengthChoice],
    percent: Option<&str>,
    prng: &mut Sfc32,
) -> EngineResult<Vec<usize>> {
    if choices.is_empty() {
        return Ok(vec![0; count]);
    }

    let selected: Vec<LengthChoice> = match percent {
        None => random_length_choices(count, choices, prng),
        Some(mask) => {
            let shares = percent_mask::expand(mask, choices.len())
                .map_err(|e| EngineError::Invalid(e.message))?;
            hamilton::distribute(count as i32, choices, &shares, prng)
        }
    };

    Ok(selected
        .into_iter()
        .map(|choice| {
            let width = if choice.min == choice.max {
                choice.min
            } else {
                rand::next_int(prng, choice.min, choice.max + 1)
            };
            width.max(0) as usize
        })
        .collect())
}

fn random_length_choices(
    count: usize,
    choices: &[LengthChoice],
    prng: &mut Sfc32,
) -> Vec<LengthChoice> {
    if choices.len() == 1 {
        // No draw at all with a single choice — which is why `length="4"` leaves
        // the stream untouched and a config can add it without shifting every
        // later column.
        return vec![choices[0]; count];
    }
    (0..count)
        .map(|_| choices[rand::next_int(prng, 0, choices.len() as i32).max(0) as usize])
        .collect()
}

// ── include / exclude ────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Interval {
    min: i64,
    max: i64,
}

/// `(base ∪ include) − exclude`, as disjoint intervals.
///
/// Interval arithmetic rather than enumeration: `value="1..1000000000"
/// exclude="7"` has to stay instant, and listing a billion values to remove one
/// of them would not be.
fn compute_allowed(
    base_ranges: &[Range],
    include: &str,
    exclude: &str,
) -> EngineResult<Vec<Interval>> {
    let mut combined: Vec<Interval> = base_ranges
        .iter()
        .map(|r| Interval {
            min: r.min,
            max: r.max,
        })
        .collect();
    if !include.trim().is_empty() {
        combined.extend(parse_interval_list(include, "include")?);
    }

    let mut merged = merge(combined);
    if !exclude.trim().is_empty() {
        merged = subtract(&merged, &parse_interval_list(exclude, "exclude")?);
    }

    if merged.is_empty() {
        return invalid("number generator: the range is empty after include/exclude");
    }
    Ok(merged)
}

fn parse_interval_list(source: &str, label: &str) -> EngineResult<Vec<Interval>> {
    let spec = source.trim();
    if spec.is_empty() {
        return invalid(&format!("number generator: {label} is empty"));
    }

    let mut result = Vec::new();
    for raw in spec.split(',') {
        let part = raw.trim();
        if scan::is_single_int(part) {
            if let Ok(n) = part.parse::<i64>() {
                result.push(Interval { min: n, max: n });
                continue;
            }
        }
        if let Some((a_text, b_text)) = scan::split_range(part) {
            let (Ok(a), Ok(b)) = (a_text.parse::<i64>(), b_text.parse::<i64>()) else {
                return invalid(&format!("number generator: invalid {label} \"{source}\""));
            };
            if a > b {
                return invalid(&format!(
                    "number generator: {label} range \"{part}\" is reversed"
                ));
            }
            result.push(Interval { min: a, max: b });
            continue;
        }
        return invalid(&format!("number generator: invalid {label} \"{source}\""));
    }

    Ok(result)
}

/// Touching intervals join, so 1..3 and 4..6 become one; the draw must not
/// double-count.
fn merge(mut intervals: Vec<Interval>) -> Vec<Interval> {
    intervals.sort_by(|a, b| a.min.cmp(&b.min).then(a.max.cmp(&b.max)));
    let mut merged: Vec<Interval> = Vec::new();
    for iv in intervals {
        match merged.last_mut() {
            Some(last) if iv.min <= last.max + 1 => last.max = last.max.max(iv.max),
            _ => merged.push(iv),
        }
    }
    merged
}

fn subtract(ranges: &[Interval], excludes: &[Interval]) -> Vec<Interval> {
    let mut result = ranges.to_vec();
    for ex in excludes {
        let mut next = Vec::new();
        for r in &result {
            if ex.max < r.min || ex.min > r.max {
                next.push(*r);
                continue;
            }
            if ex.min > r.min {
                next.push(Interval {
                    min: r.min,
                    max: ex.min - 1,
                });
            }
            if ex.max < r.max {
                next.push(Interval {
                    min: ex.max + 1,
                    max: r.max,
                });
            }
        }
        result = next;
    }
    result
}

/// A draw, redrawn while it starts with a zero it is not allowed to start with.
///
/// The guard is bounded at 100 attempts, exactly as the reference bounds it: a
/// range that can only produce leading zeros would otherwise spin forever, and
/// giving up after a fixed number keeps the draw count predictable.
fn draw_guarded(
    intervals: &[Interval],
    width: usize,
    allow_leading_zero: bool,
    prng: &mut Sfc32,
) -> String {
    let mut s = draw_weighted(intervals, width, prng);
    let mut guard = 0;
    while !allow_leading_zero && s.starts_with('0') && guard < 100 {
        s = draw_weighted(intervals, width, prng);
        guard += 1;
    }
    s
}

/// One draw over the total size, then map it into whichever interval holds that
/// index.
fn draw_weighted(intervals: &[Interval], width: usize, prng: &mut Sfc32) -> String {
    let total: i64 = intervals.iter().map(|iv| iv.max - iv.min + 1).sum();
    let mut k = rand::next_long(prng, 0, total);
    let mut n = intervals[0].min;
    for iv in intervals {
        let size = iv.max - iv.min + 1;
        if k < size {
            n = iv.min + k;
            break;
        }
        k -= size;
    }
    pad(&n.to_string(), width)
}

fn parse_decimals(raw: Option<&str>) -> EngineResult<usize> {
    let Some(raw) = raw else { return Ok(0) };
    if raw.trim().is_empty() {
        return Ok(0);
    }
    match raw.trim().parse::<i32>() {
        Ok(n) if n >= 0 => Ok(n as usize),
        _ => invalid(&format!("number generator: invalid decimals \"{raw}\"")),
    }
}

fn draw_guarded_range(
    ranges: &[Range],
    width: usize,
    allow_leading_zero: bool,
    prng: &mut Sfc32,
) -> String {
    let mut s = draw_range(ranges, width, prng);
    let mut guard = 0;
    while !allow_leading_zero && s.starts_with('0') && guard < 100 {
        s = draw_range(ranges, width, prng);
        guard += 1;
    }
    s
}

fn draw_range(ranges: &[Range], width: usize, prng: &mut Sfc32) -> String {
    // One range costs no draw of its own. Spending one to "choose" among a
    // single option would shift every column after this one.
    let range = if ranges.len() == 1 {
        ranges[0]
    } else {
        ranges[rand::next_int(prng, 0, ranges.len() as i32).max(0) as usize]
    };
    let n = rand::next_long(prng, range.min, range.max + 1);
    let actual = if width > 0 { width } else { range.width };
    pad(&n.to_string(), actual)
}

fn digit_string(width: usize, allow_leading_zero: bool, prng: &mut Sfc32) -> String {
    let mut result = String::with_capacity(width);
    for i in 0..width {
        let min = if i == 0 && !allow_leading_zero { 1 } else { 0 };
        result.push_str(&rand::next_int(prng, min, 10).to_string());
    }
    result
}

/// A uniform draw over the decimal grid of the range.
///
/// Scaling by a power of ten and drawing one integer costs the same single draw
/// an integer range costs. Drawing the whole part and the fraction separately
/// would cost two and would over-represent the endpoints.
fn random_decimal(ranges: &[Range], decimals: usize, prng: &mut Sfc32) -> String {
    let scale = 10f64.powi(decimals as i32);
    let mut lo = Vec::with_capacity(ranges.len());
    let mut size = Vec::with_capacity(ranges.len());
    let mut total = 0i64;
    for r in ranges {
        // `round` is half-away-from-zero in Rust and in .NET's
        // MidpointRounding.AwayFromZero; the reference's Math.round is
        // half-up, which differs only for negative halves — and a bound is an
        // integer here, so the product lands on one exactly.
        let l = (r.min as f64 * scale).round() as i64;
        let s = (r.max as f64 * scale).round() as i64 - l + 1;
        lo.push(l);
        size.push(s);
        total += s;
    }

    let mut pick = (prng.next() * total as f64).floor() as i64;
    for i in 0..ranges.len() {
        if pick < size[i] {
            return fixed(lo[i] + pick, decimals);
        }
        pick -= size[i];
    }

    let last = ranges.len() - 1;
    fixed(lo[last] + size[last] - 1, decimals)
}

/// A scaled integer written back out with its decimal point.
///
/// Done on the integer rather than by dividing and formatting the double. The
/// value has exactly `decimals` places by construction, so there is nothing to
/// round — and rounding is where .NET, JavaScript and Rust each pick a different
/// rule for a tie. Formatting the integer cannot land on one.
fn fixed(scaled: i64, decimals: usize) -> String {
    if decimals == 0 {
        return scaled.to_string();
    }
    let negative = scaled < 0;
    let digits = scaled.unsigned_abs().to_string();
    let padded = if digits.len() <= decimals {
        format!("{}{}", "0".repeat(decimals + 1 - digits.len()), digits)
    } else {
        digits
    };
    let split = padded.len() - decimals;
    format!(
        "{}{}.{}",
        if negative { "-" } else { "" },
        &padded[..split],
        &padded[split..]
    )
}

fn pad(s: &str, width: usize) -> String {
    if s.len() >= width {
        s.to_string()
    } else {
        format!("{}{s}", "0".repeat(width - s.len()))
    }
}

/// The length groups of a `length=` that also carries a `percent=`, or `None`.
///
/// Which group a row lands in is an exact quota over the column, so the
/// streaming engine has to plan it rather than draw it — an apportionment over a
/// single cell always awards it to the largest share, turning 85/15 into 100/0.
/// A `length=` this cannot read is not this question's business; the ordinary
/// path reports it.
pub fn weighted_length_choices(attrs: &BTreeMap<String, String>) -> Option<Vec<LengthChoice>> {
    let length = attrs.get("length")?;
    if attrs
        .get("percent")
        .map(String::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return None;
    }
    let choices = parse_length_choices(length).ok()?;
    (choices.len() > 1).then_some(choices)
}

/// The same attributes with one length group pinned, for a row already assigned
/// to it.
pub fn pin_length(
    attrs: &BTreeMap<String, String>,
    group: LengthChoice,
) -> BTreeMap<String, String> {
    let mut result: BTreeMap<String, String> = attrs
        .iter()
        .filter(|(k, _)| k.as_str() != "percent" && k.as_str() != "length")
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    result.insert(
        "length".to_string(),
        if group.min == group.max {
            group.min.to_string()
        } else {
            format!("{}-{}", group.min, group.max)
        },
    );
    result
}
