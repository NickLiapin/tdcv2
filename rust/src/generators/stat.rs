//! `<gen type="stat">` — one number for the WHOLE run, on every row.
//!
//! `accumulate=` totals a list inside one record. `<gen type="running">` totals a
//! column as it goes, so row i knows about rows 1..i. This is the third and last
//! axis: a row that knows something about EVERY row, including the ones after it.
//!
//! `sum`, `min` and `max` are the last value of the corresponding RUNNING column,
//! computed by [`accumulate::apply_column`]. That is not a shortcut — it is how
//! the two features are kept from drifting: the fixed-point scale rule, the
//! treatment of an empty cell and the "min returns the winning element's own
//! spelling" rule are written once and used twice.
//!
//! `mean`, `median` and `stddev` are ratios and cannot be exact, so they are
//! computed in floating point over the numeric values — the same three formulas
//! the expression language's list functions use, including the POPULATION
//! standard deviation. `decimals=` rounds the answer; without it the full value
//! is printed, because a mean that quietly lost digits is worse than an ugly one.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use super::accumulate;
use crate::numbers;

/// What a statistic can be.
pub const OPS: [&str; 7] = ["sum", "mean", "median", "min", "max", "count", "stddev"];

/// Read `op=` where an unknown op simply means "none".
///
/// The engine path uses this one: by the time a value is drawn the validator has
/// already refused a misspelled op, so failing here would turn a reported
/// problem into a crash.
pub fn read_op(attrs: &BTreeMap<String, String>) -> Option<String> {
    let raw = attrs.get("op").map(|s| s.trim()).unwrap_or("");
    OPS.contains(&raw).then(|| raw.to_string())
}

/// The same, but strict — the validator's copy, which turns a bad op into a diagnostic.
pub fn parse_op(attrs: &BTreeMap<String, String>) -> Result<Option<String>, String> {
    let raw = attrs.get("op").map(|s| s.trim()).unwrap_or("");
    if raw.is_empty() {
        return Ok(None);
    }
    if !OPS.contains(&raw) {
        return Err(format!("op=\"{raw}\" is not one of {}", OPS.join(", ")));
    }
    Ok(Some(raw.to_string()))
}

/// `decimals=`, or `None` when the answer is printed at full precision.
pub fn parse_decimals(attrs: &BTreeMap<String, String>) -> Result<Option<usize>, String> {
    let raw = attrs.get("decimals").map(|s| s.trim()).unwrap_or("");
    if raw.is_empty() {
        return Ok(None);
    }
    let bad = || format!("decimals=\"{raw}\" is not a whole number from 0 to 10");
    let n: i64 = raw.parse().map_err(|_| bad())?;
    if !(0..=10).contains(&n) {
        return Err(bad());
    }
    Ok(Some(n as usize))
}

/// The statistic itself, as the text that goes in every cell.
///
/// A cell the parent filter emptied does not take part — the same rule
/// `apply_column` follows, so a filtered column has one meaning across the three
/// features rather than three.
pub fn statistic(
    values: &[Option<String>],
    op: &str,
    decimals: Option<usize>,
) -> Result<String, String> {
    let present: Vec<&String> = values
        .iter()
        .filter_map(|v| v.as_ref())
        .filter(|v| !v.trim().is_empty())
        .collect();
    if op == "count" {
        return Ok(present.len().to_string());
    }
    if present.is_empty() {
        return Ok(String::new());
    }

    if op == "sum" || op == "min" || op == "max" {
        // The last value of the running column IS the total over every row, and
        // reusing it is what keeps the exact-decimal arithmetic from drifting.
        let running = accumulate::apply_column(values, op, None, None)?;
        let last = running
            .iter()
            .rev()
            .find_map(|v| v.clone())
            .unwrap_or_default();
        return Ok(match decimals {
            None => last,
            Some(places) => fixed(as_number(&last), places),
        });
    }

    let figures: Vec<f64> = present.iter().map(|v| as_number(v)).collect();
    let answer = match op {
        "mean" => mean(&figures),
        "median" => median(&figures),
        _ => stddev(&figures),
    };
    Ok(match decimals {
        None => numbers::to_text(answer),
        Some(places) => fixed(answer, places),
    })
}

/// A cell as a number. The column it reads is numeric by construction, so this is
/// the plain parse the other four implementations make.
fn as_number(raw: &str) -> f64 {
    raw.trim().parse::<f64>().unwrap_or(f64::NAN)
}

fn mean(values: &[f64]) -> f64 {
    values.iter().sum::<f64>() / values.len() as f64
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let half = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[half]
    } else {
        (sorted[half - 1] + sorted[half]) / 2.0
    }
}

/// The POPULATION standard deviation — divided by n, matching `stddev()` in an expression.
fn stddev(values: &[f64]) -> f64 {
    let average = mean(values);
    let variance =
        values.iter().map(|v| (v - average) * (v - average)).sum::<f64>() / values.len() as f64;
    crate::math::sqrt(variance)
}

/// `decimals=` applied.
///
/// `numbers::to_fixed` and nothing hand-rolled, deliberately. Multiplying by
/// 10^decimals and flooring introduces a rounding error of its own before the
/// rounding rule ever runs, so two implementations could land on either side of
/// a tie for the same input. `to_fixed` works on the decimal expansion of the
/// double itself, is what `decimals=` on `<gen type="number">` already uses, and
/// so the attribute means one thing across the whole engine rather than two.
fn fixed(value: f64, decimals: usize) -> String {
    numbers::to_fixed(value, decimals)
}
