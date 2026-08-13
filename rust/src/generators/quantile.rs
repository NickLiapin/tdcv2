//! A file read as a QUANTILE FUNCTION rather than as a bag of values.
//!
//! `<gen type="file" src="amounts.txt" read="quantile"/>` — the file is one measurement
//! per line, the engine sorts it once, and a row lands anywhere on that sorted ruler,
//! interpolating between two neighbours when it falls between them.
//!
//! ## Why this exists beside `weight=`
//!
//! A weighted read honours declared shares exactly and is the right answer for a
//! countable value. It can also only ever emit values that were written in the file:
//! stretch a thousand-line sample to a million rows and a thousand distinct values come
//! back with nothing between them — a comb, and for a MEASURED quantity that comb is
//! structure the real data never had.
//!
//! ## Why it fits the engine
//!
//! One uniform per row, and the answer depends on that row alone. So it streams, it
//! parallelises, and it needs no totals up front — unlike `weight=`, which is in-memory
//! precisely because an exact quota has to see the whole file first.

use std::collections::BTreeMap;

use crate::engine::{EngineError, EngineResult};
use crate::numbers;
use crate::prng::permute;

/// A source read as a quantile function: sorted values, and how they were written.
#[derive(Clone, Debug)]
pub struct Source {
    /// The sample, ascending. Duplicates are kept — they are what makes an atom.
    pub sorted: Vec<f64>,
    /// The most decimal places any line used, so the answer is written like the source.
    pub decimals: usize,
}

/// Parse and sort the file's values.
///
/// A line that is not a number is refused rather than skipped: dropping it would change
/// the very shape the file was chosen for, and silently. The message names the line,
/// because in a file of ten thousand numbers "one of them is not a number" is not an
/// answer anyone can act on.
pub fn source(values: &[String], src: &str) -> EngineResult<Source> {
    if values.is_empty() {
        return Err(EngineError::Invalid(format!(
            "file generator: read=\"quantile\" needs values, and \"{src}\" has none"
        )));
    }
    let mut sorted = Vec::with_capacity(values.len());
    let mut decimals = 0usize;
    for (index, raw) in values.iter().enumerate() {
        let text = raw.trim();
        let parsed: Option<f64> = if text.is_empty() {
            None
        } else {
            text.parse::<f64>().ok().filter(|v| v.is_finite())
        };
        let Some(value) = parsed else {
            return Err(EngineError::Invalid(format!(
                "file generator: read=\"quantile\" reads the file as measurements, and line \
                 {} of \"{src}\" is \"{raw}\", which is not a number. Every value has to be \
                 one, because the sorted sample IS the distribution.",
                index + 1
            )));
        };
        sorted.push(value);
        decimals = decimals.max(decimals_of(text));
    }
    sorted.sort_by(|a, b| a.partial_cmp(b).expect("finite"));
    Ok(Source { sorted, decimals })
}

/// How many digits this text wrote after the point — `12.50` is two, `12` is none.
fn decimals_of(text: &str) -> usize {
    let Some(dot) = text.find('.') else {
        return 0;
    };
    // An exponent would make the count meaningless, so such a value asks for nothing.
    if text.contains('e') || text.contains('E') {
        return 0;
    }
    text.len() - dot - 1
}

/// The value at probability `u`, interpolating between neighbours.
///
/// Each observation sits at `(i + 0.5) / n` — the MIDDLE of the slice of probability it
/// owns — rather than at `i / (n - 1)`, which is where the ENDS of the sample would be.
/// That is not a detail of taste: the end convention gives the smallest and largest
/// observations exactly half the weight they should have, because there is nothing on
/// the far side of them to ramp from. Measured on the reference before it was fixed,
/// over a hundred distinct values that each owe 1.000%: first 0.505%, middle 1.010%,
/// last 0.505%.
///
/// It is also the convention the ROW axis already uses, where row `i` reads
/// `(slot + 0.5) / count`. One rule on both axes.
pub fn at(sorted: &[f64], u: f64) -> f64 {
    let n = sorted.len();
    if n == 1 {
        return sorted[0];
    }
    let p = (u * n as f64 - 0.5).clamp(0.0, (n - 1) as f64);
    let lo = p.floor() as usize;
    let low = sorted[lo];
    if lo + 1 >= n {
        return sorted[n - 1];
    }
    let high = sorted[lo + 1];
    // A repeated value makes low == high, and the interpolation returns it unchanged —
    // that is how an atom keeps its plateau while everything around it stays continuous.
    low + (p - lo as f64) * (high - low)
}

/// The finished cell: written like the source unless the config said otherwise.
pub fn render(value: f64, decimals: usize) -> String {
    numbers::to_fixed(value, decimals)
}

/// The EXACT sweep: every row takes its own point on the ruler, no dice at all.
///
/// Row `i` is sent to slot `permute(i, count, key)` and reads probability
/// `(slot + 0.5) / count`. Over the whole run the slots are the numbers `0 … count-1`
/// exactly once each, so the generated column reproduces the sample's distribution with
/// no sampling noise whatever.
///
/// The permutation is what keeps it usable: without it the column would come out sorted.
/// It is the same seekable, seeded permutation `uniq` and the exact `percent=` quota
/// already use, so a row still costs nothing to compute on its own.
pub fn exact_at(source: &Source, decimals: usize, count: i32, key: i32, position: i32) -> String {
    let slot = permute::apply(position, count, key);
    render(
        at(&source.sorted, (f64::from(slot) + 0.5) / f64::from(count)),
        decimals,
    )
}

/// `read="quantile"`: the file is a distribution, not a bag of values.
pub fn is_quantile(attrs: &BTreeMap<String, String>) -> bool {
    attrs.get("read").map(|v| v.trim()) == Some("quantile")
}

/// `sample="exact"`: cover the distribution evenly rather than draw from it.
pub fn is_exact_sample(attrs: &BTreeMap<String, String>) -> bool {
    attrs.get("sample").map(|v| v.trim()) == Some("exact")
}

/// `decimals=` when the config declared one, otherwise the source's own precision.
///
/// Interpolating between 31 and 40 gives 35.4, which is right for money and wrong for a
/// count of orders. Rather than guess, the answer is printed with the same number of
/// decimal places as the SOURCE.
pub fn decimals_for(attrs: &BTreeMap<String, String>, source: &Source) -> usize {
    match attrs.get("decimals").map(|v| v.trim()) {
        Some(raw) if !raw.is_empty() => raw.parse::<usize>().unwrap_or(source.decimals),
        _ => source.decimals,
    }
}
