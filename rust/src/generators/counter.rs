//! `<gen type="increment"/>` and `<gen type="decrement"/>`.
//!
//! Position, not chance: the tenth cell is the start plus ten steps whatever the
//! seed is, and no draw is taken. That is what makes a counter safe to add to an
//! existing config — every column declared after it keeps the values it had.

use std::collections::BTreeMap;

use crate::engine::{invalid, EngineResult};

pub fn generate(
    attrs: &BTreeMap<String, String>,
    count: usize,
    ascending: bool,
) -> EngineResult<Vec<String>> {
    let start = number(attrs.get("value").map(String::as_str), 0)?;
    let step = number(attrs.get("step").map(String::as_str), 1)?;
    Ok((0..count)
        .map(|i| {
            let offset = step * i as i64;
            let value = if ascending {
                start + offset
            } else {
                start - offset
            };
            value.to_string()
        })
        .collect())
}

fn number(raw: Option<&str>, fallback: i64) -> EngineResult<i64> {
    let Some(raw) = raw else { return Ok(fallback) };
    if raw.trim().is_empty() {
        return Ok(fallback);
    }
    match raw.trim().parse::<i64>() {
        Ok(n) => Ok(n),
        Err(_) => invalid(&format!("counter: \"{raw}\" is not a whole number")),
    }
}
