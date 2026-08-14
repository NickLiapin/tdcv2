//! `<gen type="increment"/>` and `<gen type="decrement"/>`.
//!
//! Position, not chance: the tenth cell is the start plus ten steps whatever the
//! seed is, and no draw is taken. That is what makes a counter safe to add to an
//! existing config — every column declared after it keeps the values it had.

use std::collections::BTreeMap;

use crate::engine::{invalid, EngineResult};
use crate::numbers;

pub fn generate(
    attrs: &BTreeMap<String, String>,
    count: usize,
    ascending: bool,
) -> EngineResult<Vec<String>> {
    (0..count).map(|i| value_at(attrs, i as i64, ascending)).collect()
}

/// One row's value, for the engines that build a counter a row at a time.
///
/// Shared with `generate` so the streaming and the in-memory answer cannot drift — a
/// counter is position, not chance, and the two paths disagreeing about it would show
/// in every row.
///
/// A whole counter stays on integer arithmetic, where it is exact however far it runs.
/// A fractional one — `value="9.99" step="0.50"`, the shape the counters page teaches —
/// moves to the same floating point the reference uses and is written the same way, so
/// the two agree digit for digit. Note the value is the start plus `step * i`, not `i`
/// additions: repeated addition accumulates its own error and would drift away from the
/// reference by the thousandth row.
pub fn value_at(
    attrs: &BTreeMap<String, String>,
    index: i64,
    ascending: bool,
) -> EngineResult<String> {
    let raw_start = attrs.get("value").map(String::as_str);
    let raw_step = attrs.get("step").map(String::as_str);
    if is_whole(raw_start) && is_whole(raw_step) {
        let start = whole(raw_start, 0)?;
        let step = whole(raw_step, 1)?;
        let offset = step * index;
        let value = if ascending { start + offset } else { start - offset };
        return Ok(value.to_string());
    }
    let start = fraction(raw_start, 0.0)?;
    let step = fraction(raw_step, 1.0)?;
    let offset = step * index as f64;
    let value = if ascending { start + offset } else { start - offset };
    Ok(numbers::to_text(value))
}

fn is_whole(raw: Option<&str>) -> bool {
    match raw {
        None => true,
        Some(text) if text.trim().is_empty() => true,
        Some(text) => text.trim().parse::<i64>().is_ok(),
    }
}

fn whole(raw: Option<&str>, fallback: i64) -> EngineResult<i64> {
    let Some(raw) = raw else { return Ok(fallback) };
    if raw.trim().is_empty() {
        return Ok(fallback);
    }
    match raw.trim().parse::<i64>() {
        Ok(n) => Ok(n),
        Err(_) => invalid(&format!("counter: \"{raw}\" is not a whole number")),
    }
}

fn fraction(raw: Option<&str>, fallback: f64) -> EngineResult<f64> {
    let Some(raw) = raw else { return Ok(fallback) };
    if raw.trim().is_empty() {
        return Ok(fallback);
    }
    match raw.trim().parse::<f64>() {
        Ok(n) if n.is_finite() => Ok(n),
        _ => invalid(&format!("counter: \"{raw}\" is not a number")),
    }
}
