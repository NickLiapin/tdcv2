//! The two things real data has that generated data usually does not: gaps and
//! outliers.
//!
//! Both are attributes on any `<gen>` rather than generator types of their own,
//! because both apply to whatever the generator produced. They run as a pass
//! over the finished column, **anomaly first and missing second** — so a value
//! can be spiked and then blanked, and a blanked value is never spiked
//! afterwards.
//!
//! Each takes exactly one draw per row when it is active and none at all when it
//! is not. That is what lets a config add `missing="0.1"` to one column without
//! changing any other.

use std::collections::BTreeMap;

use crate::engine::{invalid, EngineResult};
use crate::numbers;
use crate::prng::Sfc32;

const DEFAULT_FACTOR: f64 = 10.0;

/// `missing="p"` with an optional `missing_as="NULL"`.
#[derive(Clone, Debug)]
pub struct Missing {
    pub probability: f64,
    pub token: String,
}

/// `anomaly="p"` with an optional `anomaly_factor="10"`.
#[derive(Clone, Copy, Debug)]
pub struct Anomaly {
    pub probability: f64,
    pub factor: f64,
}

pub fn parse_missing(attrs: &BTreeMap<String, String>) -> EngineResult<Option<Missing>> {
    let Some(raw) = attrs.get("missing") else {
        return Ok(None);
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(Missing {
        probability: probability(raw, "missing")?,
        token: attrs.get("missing_as").cloned().unwrap_or_default(),
    }))
}

pub fn parse_anomaly(attrs: &BTreeMap<String, String>) -> EngineResult<Option<Anomaly>> {
    let Some(raw) = attrs.get("anomaly") else {
        return Ok(None);
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    let p = probability(raw, "anomaly")?;

    let factor = match attrs.get("anomaly_factor") {
        None => DEFAULT_FACTOR,
        Some(raw) if raw.trim().is_empty() => DEFAULT_FACTOR,
        Some(raw) => match raw.trim().parse::<f64>() {
            Ok(n) if n.is_finite() => n,
            _ => {
                return invalid(&format!(
                    "anomaly: anomaly_factor \"{raw}\" must be a number"
                ))
            }
        },
    };

    Ok(Some(Anomaly {
        probability: p,
        factor,
    }))
}

/// Blank each value with the given probability — missing completely at random.
///
/// Real datasets have holes, and code that has only ever seen complete data
/// tends to fall over on the first one.
pub fn apply_missing(values: &mut [String], spec: &Missing, prng: &mut Sfc32) {
    if spec.probability <= 0.0 {
        // No draws at all when nothing can go missing, so `missing="0"` costs
        // nothing — and adding it does not move any later column.
        return;
    }
    for value in values.iter_mut() {
        if prng.next() < spec.probability {
            value.clone_from(&spec.token);
        }
    }
}

/// Multiply selected values out of their normal range, for testing detectors and
/// pipelines against spikes.
///
/// A non-numeric value is selected but left alone: an outlier is a numeric idea,
/// and there is nothing sensible to do to the word "Tuesday". `flags`, when
/// supplied, records the **selection** rather than the change — so a ground-truth
/// column marks the rows the run chose, including the ones where the spike was a
/// no-op.
///
/// Note that the draw happens on every row even when the probability is zero,
/// unlike [`apply_missing`]. That asymmetry is the reference's and is kept: the
/// two attributes are not symmetric in the stream, and matching one to the other
/// would shift every column after an `anomaly="0"`.
pub fn apply_anomaly(
    values: &mut [String],
    spec: Anomaly,
    prng: &mut Sfc32,
    mut flags: Option<&mut [bool]>,
) {
    for (i, value) in values.iter_mut().enumerate() {
        let selected = spec.probability > 0.0 && prng.next() < spec.probability;
        if let Some(flags) = flags.as_deref_mut() {
            if let Some(flag) = flags.get_mut(i) {
                *flag = selected;
            }
        }
        if selected {
            *value = spike(value, spec.factor);
        }
    }
}

/// One value made an outlier, or returned untouched when it is not a number.
///
/// Shared with the streaming engine, which decides row by row rather than over a
/// column but has to spike a selected value in exactly the same way.
/// Whether `spike` would actually change this value: it is a finite number.
///
/// Split out so the flag can be computed WITHOUT comparing before and after.
/// That comparison looks equivalent and is not — `0` times any factor is still
/// `0`, and a row that really was spiked would come back unflagged.
pub fn is_spikeable(value: &str) -> bool {
    matches!(value.trim().parse::<f64>(), Ok(n) if n.is_finite())
}

pub fn spike(value: &str, factor: f64) -> String {
    match value.trim().parse::<f64>() {
        Ok(n) if n.is_finite() => keep_shape(value, n * factor),
        // Not a number, so there is no outlier to make. Left exactly as it was.
        _ => value.to_string(),
    }
}

/// The spike keeps the SHAPE of the value it replaced.
///
/// Multiplying and re-stringifying threw away everything the column had already been
/// rendered with — the zero padding length= asked for, and the decimal places decimals=
/// asked for — so the outlier rows were the only ones in the file with a different shape:
///
/// ```text
/// length="5"    00014 00046 00053 ...  and then  117
/// decimals="2"  85.66 40.97 11.52 ...  and then  6.445
/// ```
///
/// A column of fixed-width identifiers stopped being fixed width on exactly the rows a test
/// is about to exercise, and a column declared with decimals is typed a float in Parquet — a
/// third place is a value the declared type never promised. An outlier is meant to be far
/// from the others in VALUE, not in format.
///
/// So: the same number of decimal places, and at least the same digit width where the
/// column was zero-padded. The padding only ever adds, so a spike that genuinely
/// outgrew the width keeps its extra digits — which is the whole point of one.
fn keep_shape(original: &str, spiked: f64) -> String {
    let dot = original.find('.');
    let places = match dot {
        None => 0usize,
        Some(i) => original.len() - i - 1,
    };

    // Rounded on the SCALED integer, half away from zero, rather than by handing an
    // arbitrary product to a host formatter: `round` already means that everywhere else
    // in TDC, and it is the one rule all five spell the same.
    let scale = 10f64.powi(places as i32);
    let scaled = spiked * scale;
    let rounded = if scaled < 0.0 {
        -(-scaled + 0.5).floor()
    } else {
        (scaled + 0.5).floor()
    };
    let text = format!("{:.*}", places, rounded / scale);

    // Only a value that was ZERO-PADDED has a width to preserve. `12.89` is five
    // characters wide because the number is, not because the column asked for five.
    let bare = original.strip_prefix('-').unwrap_or(original);
    let whole_part = match bare.find('.') {
        None => bare,
        Some(i) => &bare[..i],
    };
    if !whole_part.starts_with('0') || whole_part.len() < 2 {
        return text;
    }

    let negative = text.starts_with('-');
    let body = text.strip_prefix('-').unwrap_or(&text);
    let (whole, rest) = match body.find('.') {
        None => (body, ""),
        Some(i) => (&body[..i], &body[i..]),
    };
    let pad = whole_part.len().saturating_sub(whole.len());
    format!(
        "{}{}{}{}",
        if negative { "-" } else { "" },
        "0".repeat(pad),
        whole,
        rest
    )
}

fn probability(raw: &str, label: &str) -> EngineResult<f64> {
    match raw.trim().parse::<f64>() {
        Ok(p) if p.is_finite() && (0.0..=1.0).contains(&p) => Ok(p),
        _ => invalid(&format!(
            "{label}: probability \"{raw}\" must be a number in [0, 1]"
        )),
    }
}
