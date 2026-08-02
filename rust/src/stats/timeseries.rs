//! `<gen type="timeseries" .../>` — a value that depends on when it happened.
//!
//! The layered model every real series is built from:
//!
//! `value(i) = base + trend·i + amplitude·sin(2π·i/period) + noise·z`
//!
//! A trend, one seasonal wave, and gaussian noise, with the row index as the
//! clock. Sales, sensor readings and traffic look like this. A uniform draw over
//! the same range does not, and anything that plots the column will show the
//! difference immediately.
//!
//! Like the counters, the value comes from the absolute row index rather than
//! from the row before it, so any row can be computed on its own.

use std::collections::BTreeMap;

use crate::engine::{invalid, EngineResult};
use crate::numbers;
use crate::prng::{seekable, Sfc32};

#[derive(Clone, Copy, Debug)]
pub struct Spec {
    pub base: f64,
    pub trend: f64,
    /// Seasonal period in rows; zero means no seasonality.
    pub period: f64,
    pub amplitude: f64,
    /// Standard deviation of the noise; zero means no noise, and no draws.
    pub noise_sd: f64,
    pub decimals: usize,
}

impl Spec {
    pub fn has_noise(&self) -> bool {
        self.noise_sd != 0.0
    }
}

pub fn generate(
    attrs: &BTreeMap<String, String>,
    count: usize,
    prng: &mut Sfc32,
) -> EngineResult<Vec<String>> {
    let spec = parse(attrs)?;
    let noisy = spec.has_noise();
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        // Two uniforms per row when there is noise, none at all when there is
        // not — the draw budget has to be exactly this, or a column declared
        // after this one shifts.
        let z = if noisy {
            standard_normal(
                seekable::open_unit(prng.next()),
                seekable::open_unit(prng.next()),
            )
        } else {
            0.0
        };
        result.push(numbers::to_fixed(
            value_at(&spec, i as i64, z),
            spec.decimals,
        ));
    }
    Ok(result)
}

pub fn parse(attrs: &BTreeMap<String, String>) -> EngineResult<Spec> {
    let period = number(attrs, "period", 0.0)?;
    let noise_sd = number(attrs, "noise", 0.0)?;
    if period < 0.0 {
        return invalid("timeseries: \"period\" must be >= 0");
    }
    if noise_sd < 0.0 {
        return invalid("timeseries: \"noise\" must be >= 0");
    }

    let decimals = match attrs.get("decimals").map(String::as_str) {
        None => 0,
        Some(raw) if raw.trim().is_empty() => 0,
        Some(raw) => match raw.trim().parse::<i32>() {
            Ok(d) if d >= 0 => d as usize,
            _ => return invalid("timeseries: \"decimals\" must be a non-negative integer"),
        },
    };

    Ok(Spec {
        base: number(attrs, "base", 0.0)?,
        trend: number(attrs, "trend", 0.0)?,
        period,
        amplitude: number(attrs, "amplitude", 0.0)?,
        noise_sd,
        decimals,
    })
}

/// A standard normal deviate by Box–Muller, from two uniforms in (0,1).
pub fn standard_normal(u1: f64, u2: f64) -> f64 {
    (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
}

pub fn value_at(spec: &Spec, i: i64, z: f64) -> f64 {
    let mut v = spec.base + spec.trend * i as f64;
    if spec.period > 0.0 && spec.amplitude != 0.0 {
        v += spec.amplitude * (2.0 * std::f64::consts::PI * i as f64 / spec.period).sin();
    }
    if spec.noise_sd != 0.0 {
        v += spec.noise_sd * z;
    }
    v
}

fn number(attrs: &BTreeMap<String, String>, key: &str, fallback: f64) -> EngineResult<f64> {
    let Some(raw) = attrs.get(key) else {
        return Ok(fallback);
    };
    if raw.trim().is_empty() {
        return Ok(fallback);
    }
    match raw.trim().parse::<f64>() {
        Ok(n) if n.is_finite() => Ok(n),
        _ => invalid(&format!(
            "timeseries: \"{key}\" must be a number (got \"{raw}\")"
        )),
    }
}
