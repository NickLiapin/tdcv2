//! `<gen type="timeseries" .../>` — a value that depends on when it happened.
//!
//! The layered model every real series is built from:
//!
//! `value(i) = base + trend·i + Σ amplitude·cos(2π·(i − peak)/period) + noise·e(i)`
//!
//! A trend, one or more seasonal waves, and noise, with the row index as the
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

/// How many past rows the correlated noise remembers.
///
/// The textbook AR(1) is written `e(t) = φ·e(t−1) + z(t)` — a recurrence, which a
/// seekable engine cannot evaluate: row 900,000 would have to replay 900,000
/// rows. Written out, that recurrence is a weighted sum of the past innovations,
/// `Σ φ^k·z(t−k)`, and the weights fall off geometrically — so this generator
/// defines the noise as that sum over a FIXED window and evaluates it directly.
/// Both engines then run the same arithmetic in the same order and cannot drift
/// apart, and any row is computable on its own.
pub const NOISE_WINDOW: usize = 63;

/// One seasonal wave: how long it is, how far it swings, and where it peaks.
#[derive(Clone, Copy, Debug)]
pub struct Wave {
    pub period: f64,
    pub amplitude: f64,
    /// Which row the wave peaks on, or `None` for the classic sine.
    ///
    /// A plain `sin(2π·i/period)` crosses zero at row 0 and peaks a QUARTER
    /// PERIOD later, so a year of daily rows peaks in early April — the one
    /// season nobody means by "warmer in summer". `peak_at` names the ROW rather
    /// than a shift, because the row is what the author knows: 182 of 365 is the
    /// first of July.
    pub peak_at: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct Spec {
    pub base: f64,
    pub trend: f64,
    /// The seasonal waves, in the order written. Empty means no seasonality.
    ///
    /// A list rather than one wave because real series carry more than one
    /// season at a time: shop takings rise on Saturdays AND in December, and a
    /// model given only the weekly wave has nothing to find in the yearly one.
    /// The waves simply sum.
    pub waves: Vec<Wave>,
    /// Standard deviation of the noise; zero means no noise, and no draws.
    pub noise_sd: f64,
    /// How strongly one row's noise carries into the next, in (−1, 1).
    ///
    /// Zero is the independent (white) noise this generator has always produced.
    /// Real measurement error is rarely independent: a sensor reading high today
    /// tends to read high tomorrow, and a model tested only against white noise
    /// has never met the case it will actually fail on.
    pub noise_correlation: f64,
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
    // The window's draws, kept in a ring: walking forward, 63 of the 64 terms
    // were drawn for the row before. It is a cache and nothing else — the sum is
    // the same terms in the same order either way.
    let mut ring = Ring::new();
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        // Two uniforms per row when there is noise, none at all when there is
        // not — the draw budget has to be exactly this, or a column declared
        // after this one shifts.
        let z = if noisy {
            let mut draw = |_row: usize| {
                standard_normal(
                    seekable::open_unit(prng.next()),
                    seekable::open_unit(prng.next()),
                )
            };
            correlated_noise(&spec, i, |k| ring.read(i, k, &mut draw))
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
    let periods = number_list(attrs, "period")?;
    let amplitudes = number_list(attrs, "amplitude")?;
    let peaks = number_list(attrs, "peak_at")?;
    for period in &periods {
        if *period < 0.0 {
            return invalid("timeseries: \"period\" must be >= 0");
        }
    }
    // The three lists describe the same waves position by position, so a length
    // that disagrees is not a wave anybody can draw. The validator says this
    // first and better; this is the backstop for callers who build a gen through
    // the library without validating.
    if amplitudes.len() > 1 && amplitudes.len() != periods.len() {
        return invalid("timeseries: \"amplitude\" must have as many entries as \"period\"");
    }
    if !peaks.is_empty() && peaks.len() != periods.len() {
        return invalid("timeseries: \"peak_at\" must have as many entries as \"period\"");
    }

    let waves = periods
        .iter()
        .enumerate()
        .map(|(k, period)| Wave {
            period: *period,
            // One amplitude for many periods is the shorthand for waves of equal
            // height; the far more common case is one of each, which reads the same.
            amplitude: if amplitudes.len() == 1 {
                amplitudes[0]
            } else {
                amplitudes.get(k).copied().unwrap_or(0.0)
            },
            peak_at: peaks.get(k).copied(),
        })
        .collect();

    let noise_sd = number(attrs, "noise", 0.0)?;
    if noise_sd < 0.0 {
        return invalid("timeseries: \"noise\" must be >= 0");
    }
    let noise_correlation = number(attrs, "noise_correlation", 0.0)?;
    if !(noise_correlation.abs() < 1.0) {
        return invalid("timeseries: \"noise_correlation\" must be between -1 and 1");
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
        waves,
        noise_sd,
        noise_correlation,
        decimals,
    })
}

/// A standard normal deviate by Box–Muller, from two uniforms in (0,1).
pub fn standard_normal(u1: f64, u2: f64) -> f64 {
    (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
}

/// The correlated noise at row `i`, from the innovations of rows `i − k`.
///
/// `past(k)` hands back the innovation of row `i − k`; the caller decides where
/// it comes from, which is what lets a sequential walk keep a ring of 64 and a
/// random access pay for 64 lookups. The ARITHMETIC is the same either way — the
/// same terms, added in the same order — so the two engines cannot disagree.
///
/// The sum is divided by the length of its own weight vector, so **every row has
/// the same spread**. Without that the first rows of a column would be visibly
/// quieter than the rest — the window has fewer terms to add there — and a series
/// that settles down after sixty rows is an artefact of the method, not of
/// anything the config asked for.
pub fn correlated_noise<F: FnMut(usize) -> f64>(spec: &Spec, i: usize, mut past: F) -> f64 {
    if spec.noise_correlation == 0.0 {
        return past(0);
    }
    let reach = i.min(NOISE_WINDOW);
    let mut sum = 0.0;
    let mut squares = 0.0;
    let mut weight = 1.0;
    for k in 0..=reach {
        sum += weight * past(k);
        squares += weight * weight;
        weight *= spec.noise_correlation;
    }
    sum / squares.sqrt()
}

/// The window's innovations, kept so a forward walk draws each row once.
///
/// A cache and nothing else: the arithmetic never changes, so an engine that
/// seeks and an engine that walks produce one series. `draw` is asked only for
/// rows the walk has reached, in order, which is what lets the in-memory engine
/// hand it a SEQUENTIAL generator — on that path there is no row to seek to, and
/// the ring is the only reason the window can be read at all.
pub struct Ring {
    slots: [f64; NOISE_WINDOW + 1],
    /// The highest row in the ring; rows `have - NOISE_WINDOW ..= have` are live.
    have: i64,
}

impl Default for Ring {
    fn default() -> Self {
        Self::new()
    }
}

impl Ring {
    pub fn new() -> Self {
        Self {
            slots: [0.0; NOISE_WINDOW + 1],
            have: -1,
        }
    }

    pub fn read<F: FnMut(usize) -> f64>(&mut self, row: usize, k: usize, draw: &mut F) -> f64 {
        let size = NOISE_WINDOW + 1;
        let row_i = row as i64;
        if row_i > self.have {
            // Forward by one on a sequential walk; a first touch deep into the
            // column fills the whole window at once.
            let from = (row_i - NOISE_WINDOW as i64).max(self.have + 1).max(0);
            for r in from..=row_i {
                self.slots[r as usize % size] = draw(r as usize);
            }
            self.have = row_i;
        }
        let want = row_i - k as i64;
        if want < 0 {
            return 0.0; // before row zero there is nothing to remember
        }
        // A jump backwards past the window re-draws, which costs one hash and
        // cannot give a different number.
        if want > self.have - size as i64 {
            self.slots[want as usize % size]
        } else {
            draw(want as usize)
        }
    }
}

pub fn value_at(spec: &Spec, i: i64, e: f64) -> f64 {
    let mut v = spec.base + spec.trend * i as f64;
    for wave in &spec.waves {
        if wave.period <= 0.0 || wave.amplitude == 0.0 {
            continue;
        }
        // One formula for both. `cos` peaks where its argument is zero, so the
        // wave peaks exactly on `peak`. The DEFAULT peak is a quarter period in,
        // which is where a plain `sin(2π·i/period)` already peaked — so a config
        // without `peak_at` produces the same bytes it always did, without a
        // second branch saying so.
        let peak = wave.peak_at.unwrap_or(wave.period / 4.0);
        v += wave.amplitude * (2.0 * std::f64::consts::PI * (i as f64 - peak) / wave.period).cos();
    }
    if spec.noise_sd != 0.0 {
        v += spec.noise_sd * e;
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

/// A comma-separated list of numbers, or an empty vector when absent or blank.
fn number_list(attrs: &BTreeMap<String, String>, key: &str) -> EngineResult<Vec<f64>> {
    let Some(raw) = attrs.get(key) else {
        return Ok(Vec::new());
    };
    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for piece in raw.split(',') {
        match piece.trim().parse::<f64>() {
            Ok(n) if n.is_finite() => out.push(n),
            _ => {
                return invalid(&format!(
                    "timeseries: \"{key}\" must be a number (got \"{raw}\")"
                ))
            }
        }
    }
    Ok(out)
}
