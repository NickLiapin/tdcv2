//! Named statistical distributions for `<gen type="number" distribution="..."/>`.
//!
//! A column drawn from a distribution looks like real data. Heights are normal,
//! incomes are lognormal, waiting times are exponential, word frequencies are
//! Zipf — and a uniform range over the same interval looks like none of them,
//! which is exactly what makes uniform test data feel wrong to anyone who knows
//! the domain.
//!
//! Two rules hold across every distribution here, and both keep a row computable
//! from its index:
//!
//! * **A fixed number of draws.** Inverse-CDF or Box–Muller only, never
//!   rejection sampling. Rejection sampling consumes a variable number of
//!   uniforms, which would make each row depend on all the rows before it.
//! * **No dependency.** The arithmetic is written out here, so the numbers are
//!   the same in every language rather than the same as whatever library each
//!   language happened to pick.

use std::collections::BTreeMap;

use super::special;
use crate::engine::{invalid, EngineResult};
use crate::numbers;

/// `e^-lambda` underflows to zero past about 745, which would break the recurrence.
const POISSON_MAX_LAMBDA: f64 = 700.0;

const ZIPF_MAX_N: f64 = 10_000_000.0;

#[derive(Clone, Debug)]
pub struct Spec {
    pub name: String,
    /// How many uniforms [`sample`] needs.
    pub draws: usize,
    pub decimals: usize,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub params: BTreeMap<String, f64>,
    /// The cumulative table a discrete distribution is inverted through.
    pub table: Option<Vec<f64>>,
}

pub fn parse(attrs: &BTreeMap<String, String>) -> EngineResult<Spec> {
    let get = |key: &str| attrs.get(key).map(String::as_str);

    let decimals = read_decimals(get("decimals"))?;
    let min = optional(get("min"), "min")?;
    let max = optional(get("max"), "max")?;
    if let (Some(min), Some(max)) = (min, max) {
        if min > max {
            return invalid(&format!(
                "distribution: min ({}) must be <= max ({})",
                numbers::to_text(min),
                numbers::to_text(max)
            ));
        }
    }

    let dist = get("distribution").unwrap_or("null").to_string();
    let mut params = BTreeMap::new();
    let mut table = None;
    let draws;

    match dist.as_str() {
        "normal" => {
            draws = 2;
            params.insert("mean".into(), required(attrs, "mean", &dist)?);
            params.insert("sd".into(), positive(attrs, "sd", &dist)?);
        }
        "lognormal" => {
            draws = 2;
            params.insert("meanlog".into(), required(attrs, "meanlog", &dist)?);
            params.insert("sdlog".into(), positive(attrs, "sdlog", &dist)?);
        }
        "exponential" => {
            draws = 1;
            params.insert("rate".into(), positive(attrs, "rate", &dist)?);
        }
        "pareto" => {
            draws = 1;
            params.insert("alpha".into(), positive(attrs, "alpha", &dist)?);
            params.insert("xmin".into(), positive(attrs, "xmin", &dist)?);
        }
        "weibull" => {
            draws = 1;
            params.insert("shape".into(), positive(attrs, "shape", &dist)?);
            params.insert("scale".into(), positive(attrs, "scale", &dist)?);
        }
        "gamma" => {
            draws = 1;
            params.insert("shape".into(), positive(attrs, "shape", &dist)?);
            params.insert("scale".into(), positive(attrs, "scale", &dist)?);
        }
        "beta" => {
            draws = 1;
            params.insert("alpha".into(), positive(attrs, "alpha", &dist)?);
            params.insert("beta".into(), positive(attrs, "beta", &dist)?);
        }
        "poisson" => {
            draws = 1;
            let lambda = positive(attrs, "lambda", &dist)?;
            params.insert("lambda".into(), lambda);
            table = Some(poisson_cdf(lambda)?);
        }
        "zipf" => {
            draws = 1;
            let n = positive_integer(attrs, "n", &dist)?;
            let s = positive(attrs, "s", &dist)?;
            params.insert("n".into(), n);
            params.insert("s".into(), s);
            table = Some(zipf_cumulative(n, s)?);
        }
        other => {
            return invalid(&format!(
                "distribution: unknown distribution \"{other}\" — expected normal, lognormal, \
                 exponential, pareto, weibull, poisson, zipf, gamma, or beta"
            ))
        }
    }

    Ok(Spec {
        name: dist,
        draws,
        decimals,
        min,
        max,
        params,
        table,
    })
}

/// The raw value, from uniforms already in the open interval (0,1).
///
/// Clipping and rounding happen in [`format`].
pub fn sample(spec: &Spec, uniforms: &[f64]) -> f64 {
    let u1 = uniforms.first().copied().unwrap_or(0.0);
    let u2 = uniforms.get(1).copied().unwrap_or(0.0);
    let p = |key: &str| spec.params.get(key).copied().unwrap_or(0.0);

    match spec.name.as_str() {
        "normal" => p("mean") + p("sd") * box_muller(u1, u2),
        "lognormal" => (p("meanlog") + p("sdlog") * box_muller(u1, u2)).exp(),
        "exponential" => -u1.ln() / p("rate"),
        "pareto" => p("xmin") * (1.0 - u1).powf(-1.0 / p("alpha")),
        "weibull" => p("scale") * (-u1.ln()).powf(1.0 / p("shape")),
        // The smallest count k where P(X <= k) >= u.
        "poisson" => lower_bound(spec.table.as_deref().unwrap_or(&[]), u1),
        // Ranks are 1-based.
        "zipf" => lower_bound(spec.table.as_deref().unwrap_or(&[]), u1) + 1.0,
        "gamma" => p("scale") * special::gamma_p_inv(p("shape"), u1),
        "beta" => special::beta_i_inv(p("alpha"), p("beta"), u1),
        // `parse` refuses anything else, so this is unreachable by construction.
        _ => f64::NAN,
    }
}

pub fn format(x: f64, spec: &Spec) -> String {
    let mut v = x;
    if let Some(min) = spec.min {
        v = v.max(min);
    }
    if let Some(max) = spec.max {
        v = v.min(max);
    }
    numbers::to_fixed(v, spec.decimals)
}

/// A standard normal deviate by Box–Muller, from two uniforms in (0,1).
fn box_muller(u1: f64, u2: f64) -> f64 {
    (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
}

/// The smallest index where `cum[k] >= u`, by binary search; clamped to the last.
fn lower_bound(cum: &[f64], u: f64) -> f64 {
    if cum.is_empty() {
        return 0.0;
    }
    let mut lo = 0usize;
    let mut hi = cum.len() - 1;
    while lo < hi {
        let mid = (lo + hi) / 2;
        if cum[mid] >= u {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo as f64
}

/// `cdf[k] = P(X <= k)`, extended until it reaches one.
fn poisson_cdf(lambda: f64) -> EngineResult<Vec<f64>> {
    if lambda > POISSON_MAX_LAMBDA {
        return invalid(&format!(
            "distribution \"poisson\": lambda {} is too large (max {}); for large means use \
             distribution=\"normal\" mean=\"{}\" sd=\"sqrt(lambda)\".",
            numbers::to_text(lambda),
            POISSON_MAX_LAMBDA as i64,
            numbers::to_text(lambda)
        ));
    }

    let mut cdf = Vec::new();
    let mut p = (-lambda).exp();
    let mut cum = p;
    cdf.push(cum);
    let cap = lambda + 40.0 * lambda.sqrt() + 100.0;
    let mut k = 1.0;
    while cum < 1.0 - 1e-12 && k < cap {
        p = p * lambda / k;
        cum += p;
        cdf.push(cum.min(1.0));
        k += 1.0;
    }
    Ok(cdf)
}

/// `cum[k] = P(rank <= k+1)` over ranks 1..n.
fn zipf_cumulative(n: f64, s: f64) -> EngineResult<Vec<f64>> {
    if n > ZIPF_MAX_N {
        return invalid(&format!(
            "distribution \"zipf\": n {} is too large (max {}).",
            numbers::to_text(n),
            ZIPF_MAX_N as i64
        ));
    }

    let n = n as usize;
    let mut sum = 0.0;
    let mut weights = Vec::with_capacity(n);
    for k in 1..=n {
        let w = 1.0 / (k as f64).powf(s);
        weights.push(w);
        sum += w;
    }

    let mut cum = Vec::with_capacity(n);
    let mut c = 0.0;
    for w in &weights {
        c += w / sum;
        cum.push(c);
    }
    // Pin the last against floating-point drift, so a u near 1 lands on rank n
    // rather than falling off the end of the table.
    if let Some(last) = cum.last_mut() {
        *last = 1.0;
    }
    Ok(cum)
}

fn read_decimals(raw: Option<&str>) -> EngineResult<usize> {
    let Some(raw) = raw else { return Ok(0) };
    if raw.trim().is_empty() {
        return Ok(0);
    }
    match raw.trim().parse::<i32>() {
        Ok(n) if n >= 0 => Ok(n as usize),
        _ => invalid(&format!(
            "distribution: \"decimals\" must be a non-negative integer (got \"{raw}\")"
        )),
    }
}

fn optional(raw: Option<&str>, label: &str) -> EngineResult<Option<f64>> {
    let Some(raw) = raw else { return Ok(None) };
    if raw.trim().is_empty() {
        return Ok(None);
    }
    match raw.trim().parse::<f64>() {
        Ok(n) => Ok(Some(n)),
        Err(_) => invalid(&format!(
            "distribution: \"{label}\" must be a number (got \"{raw}\")"
        )),
    }
}

fn required(attrs: &BTreeMap<String, String>, key: &str, dist: &str) -> EngineResult<f64> {
    let raw = attrs.get(key).map(String::as_str).unwrap_or("");
    match raw.trim().parse::<f64>() {
        Ok(n) if n.is_finite() => Ok(n),
        _ => invalid(&format!(
            "distribution \"{dist}\": \"{key}\" is required and must be a number"
        )),
    }
}

fn positive(attrs: &BTreeMap<String, String>, key: &str, dist: &str) -> EngineResult<f64> {
    let n = required(attrs, key, dist)?;
    if n > 0.0 {
        Ok(n)
    } else {
        invalid(&format!(
            "distribution \"{dist}\": \"{key}\" must be a positive number (got {})",
            numbers::to_text(n)
        ))
    }
}

fn positive_integer(attrs: &BTreeMap<String, String>, key: &str, dist: &str) -> EngineResult<f64> {
    let n = required(attrs, key, dist)?;
    if n != n.round() || n < 1.0 {
        return invalid(&format!(
            "distribution \"{dist}\": \"{key}\" must be a positive integer (got {})",
            numbers::to_text(n)
        ));
    }
    Ok(n)
}
