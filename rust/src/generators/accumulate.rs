//! `accumulate=` — a running total inside one record's `repeat` list.
//!
//! A cell holding `100,150,150` becomes `100,250,400`. That is the shape most "I need a
//! running total" questions actually have: a receipt's subtotal, the elapsed time of a
//! session, the odometer over the legs of a trip. The accumulation lives inside ONE
//! record, which is why it costs nothing — a record is computed whole anyway, so rows
//! stay independent and streaming, `--jobs` and `get_at` are untouched.
//!
//! The one decision worth defending is the arithmetic. Five implementations have to
//! produce the same bytes, and floating point does not: `0.1 + 0.2` prints differently in
//! JavaScript, Python, Java, C# and Rust. So the sum is done on SCALED INTEGERS. Every
//! element is read as a fixed-point number, the widest fraction in the list sets the
//! scale, and the total is formatted back at that scale by hand.
//!
//! `i128` rather than `i64`: `repeat` caps a list at 64 elements, so the widest sum is 64
//! values of at most 18 digits scaled by up to 10^18 — comfortably inside `i128` and
//! nowhere near `i64`. The reference uses arbitrary precision, and this is the width that
//! matches it over every input the ceiling allows.
//!
//! `min` and `max` are different in a useful way: their result IS one of the inputs, so
//! the winning element's own text is returned unchanged. A value that arrived as `007`
//! stays `007`.

use std::collections::BTreeMap;

/// What a running accumulation can do. Each keeps a value that only ever moves one way.
pub const OPS: [&str; 3] = ["sum", "min", "max"];

/// Read `accumulate=` where an unknown op simply means "none".
///
/// The engine path uses this one. By the time a value is drawn the validator has already
/// refused a misspelled op (TDC238), so failing here would only turn a reported problem
/// into a crash.
pub fn read(attrs: &BTreeMap<String, String>) -> Option<String> {
    let raw = attrs.get("accumulate").map(|s| s.trim()).unwrap_or("");
    OPS.contains(&raw).then(|| raw.to_string())
}

/// The same, but strict — the validator's copy, which turns a bad op into a diagnostic.
pub fn parse(attrs: &BTreeMap<String, String>) -> Result<Option<String>, String> {
    let raw = attrs.get("accumulate").map(|s| s.trim()).unwrap_or("");
    if raw.is_empty() {
        return Ok(None);
    }
    if !OPS.contains(&raw) {
        return Err(format!(
            "accumulate=\"{raw}\" is not one of {}",
            OPS.join(", ")
        ));
    }
    Ok(Some(raw.to_string()))
}

/// One element as `(value, scale)` — the value scaled by `10^scale`.
///
/// Deliberately strict. A generator that produces words has no running total, and quietly
/// treating `abc` as zero would hand back a column that adds up to something and means
/// nothing.
fn parse_fixed(text: &str) -> Result<(i128, u32), String> {
    let trimmed = text.trim();
    let body = trimmed.strip_prefix(['+', '-']).unwrap_or(trimmed);
    let (whole, fraction) = match body.split_once('.') {
        Some((w, f)) => (w, f),
        None => (body, ""),
    };
    let shaped = !whole.is_empty()
        && whole.bytes().all(|b| b.is_ascii_digit())
        && (body.find('.').is_none() || !fraction.is_empty())
        && fraction.bytes().all(|b| b.is_ascii_digit());
    if !shaped {
        return Err(format!(
            "accumulate=: \"{text}\" is not a number, so there is nothing to accumulate. \
             A running total needs numeric elements — accumulate= belongs on a numeric \
             generator."
        ));
    }
    let digits = format!("{whole}{fraction}");
    let magnitude: i128 = digits
        .parse()
        .map_err(|_| format!("accumulate=: \"{text}\" does not fit a number"))?;
    let value = if trimmed.starts_with('-') {
        -magnitude
    } else {
        magnitude
    };
    Ok((
        value,
        u32::try_from(fraction.len()).expect("a fraction cannot be that long"),
    ))
}

/// Back to text at `scale` decimal places, with no float in the path.
fn format_fixed(value: i128, scale: u32) -> String {
    if scale == 0 {
        return value.to_string();
    }
    let negative = value < 0;
    let digits = format!(
        "{:0>width$}",
        value.unsigned_abs(),
        width = scale as usize + 1
    );
    let split = digits.len() - scale as usize;
    format!(
        "{}{}.{}",
        if negative { "-" } else { "" },
        &digits[..split],
        &digits[split..]
    )
}

/// Turn a list into its running accumulation.
///
/// An EMPTY element stays empty and leaves the accumulator alone. That is what `missing=`
/// produces, and "no reading that day" should not reset a meter or count as a zero-value
/// transaction.
pub fn apply(parts: &[String], op: &str) -> Result<Vec<String>, String> {
    // One pass to learn the widest fraction, so every element is compared and summed at
    // the same scale. Done first because the scale of the total must not depend on which
    // elements happened to come earlier.
    let mut scale = 0u32;
    let mut numbers: Vec<Option<(i128, u32)>> = Vec::with_capacity(parts.len());
    for part in parts {
        if part.trim().is_empty() {
            numbers.push(None);
            continue;
        }
        let number = parse_fixed(part)?;
        scale = scale.max(number.1);
        numbers.push(Some(number));
    }

    let mut out: Vec<String> = Vec::with_capacity(parts.len());
    let mut acc: Option<i128> = None;
    let mut acc_text = String::new();
    for (part, number) in parts.iter().zip(numbers.iter()) {
        let Some((value, own_scale)) = number else {
            out.push(part.clone());
            continue;
        };
        let scaled = value * 10i128.pow(scale - own_scale);
        match acc {
            None => {
                acc = Some(scaled);
                acc_text = part.clone();
            }
            Some(current) if op == "sum" => acc = Some(current + scaled),
            Some(current) => {
                if (scaled < current) == (op == "min") {
                    acc = Some(scaled);
                    acc_text = part.clone();
                }
            }
        }
        // min/max return an element that already exists, so its own spelling is kept;
        // sum produces a new number and is formatted at the shared scale.
        out.push(if op == "sum" {
            format_fixed(acc.unwrap_or(0), scale)
        } else {
            acc_text.clone()
        });
    }
    Ok(out)
}

/// The same fold, but down a COLUMN instead of across a list.
///
/// `<gen type="running">` is this: row i's value is the accumulation of every row up to
/// it. Reusing [`apply`] rather than writing a second fold is deliberate — the
/// arithmetic, the scale rule and the treatment of an empty cell then cannot drift apart
/// between the two features.
///
/// `base` is prepended and its result dropped, which is exactly "start from an opening
/// balance": it joins the scale pool, so an opening `1000.00` widens the whole column to
/// two decimals the way a reader would expect.
///
/// `reset_at` splits the column into segments, each accumulated on its own — one running
/// balance per account rather than one for the file.
pub fn apply_column(
    values: &[Option<String>],
    op: &str,
    base: Option<&str>,
    reset_at: Option<&[Option<String>]>,
) -> Result<Vec<Option<String>>, String> {
    let mut out: Vec<Option<String>> = vec![None; values.len()];
    let mut start = 0usize;
    while start < values.len() {
        let end = match reset_at {
            None => values.len(),
            Some(keys) => {
                let mut end = start + 1;
                while end < values.len() && keys[end] == keys[start] {
                    end += 1;
                }
                end
            }
        };
        let segment: Vec<String> = values[start..end]
            .iter()
            .map(|v| v.clone().unwrap_or_default())
            .collect();
        let parts: Vec<String> = match base {
            None => segment,
            Some(b) => std::iter::once(b.to_string()).chain(segment).collect(),
        };
        let running = apply(&parts, op)?;
        let offset = usize::from(base.is_some());
        for i in start..end {
            // A row outside a parent filter has no value, and gains none: the accumulator
            // passed over it without counting it.
            out[i] = values[i]
                .as_ref()
                .map(|_| running[i - start + offset].clone());
        }
        start = end;
    }
    Ok(out)
}
