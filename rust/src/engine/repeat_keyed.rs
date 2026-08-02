//! `repeat=` built in memory the way the streaming engine builds it.
//!
//! A repeating column has two plans, not one. How MANY values a row keeps is an exact quota
//! over the run — permuted by `#replen`, so a row's length follows from its own position and
//! never from a running total over its predecessors. What those values ARE then depends on the
//! generator: a list is laid out over the whole slot space and read at the row's slots, while
//! anything drawn takes one seekable sub-stream per element, `#e0`, `#e1`, and so on.
//!
//! Both halves are keyed by `(seed, stream_id)` and mirror the reference's `repeat-keyed.ts`.
//! The older sequential builder in `generators/repeat.rs` stays for the cases with nothing to
//! key by — an inline generator inside a pack body.

use super::EngineResult;
use crate::generators::repeat;
use crate::prng::{permute, seekable, Sfc32};
use crate::stats::hamilton;

use super::per_row::Stream;

/// How many values each position keeps, and where in the slot space they start.
fn length_plan(spec: &repeat::Spec, count: usize, stream: &Stream) -> (repeat::Plan, i32) {
    let mut pct = crate::prng::create(&format!("{}|{}|replen", stream.seed, stream.id));
    let counts = hamilton::counts_per_value(count as i32, &repeat::length_percents(spec), &mut pct);
    let key = permute::key(&stream.seed, &format!("{}#replen", stream.id));
    (repeat::plan(spec, &counts), key)
}

/// A repeating column of DRAWN values.
///
/// Element k of a row comes off the row's own `#e{k}` stream, so the row still resolves alone —
/// which is also what lets a worker render a range of rows without seeing the rest.
pub fn build_draws(
    spec: &repeat::Spec,
    count: usize,
    stream: &Stream,
    mut one_element: impl FnMut(usize, &mut Sfc32, &mut [bool]) -> EngineResult<String>,
    mut flag_text_out: Option<&mut Vec<String>>,
) -> EngineResult<Vec<String>> {
    let (plan, key) = length_plan(spec, count, stream);
    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let row = stream.row_at(i);
        let keep = plan.length_at(permute::apply(i as i32, count as i32, key) as usize);
        let mut parts = Vec::with_capacity(keep);
        let mut marks = Vec::with_capacity(keep);
        for k in 0..keep {
            let mut element_prng =
                seekable::generator(&stream.seed, &format!("{}#e{k}", stream.id), row as i32);
            let mut flag = [false];
            parts.push(one_element(k, &mut element_prng, &mut flag)?);
            marks.push(if flag[0] { "true" } else { "false" }.to_string());
        }
        out.push(repeat::join(&parts, spec)?);
        // A parallel list of true/false, never a running total — accumulating it would mean
        // nothing — so it joins with the separator alone.
        if let Some(flags) = flag_text_out.as_deref_mut() {
            flags.push(marks.join(&spec.separator));
        }
    }
    Ok(out)
}

/// A repeating column of LISTED values.
///
/// The slot space covers every element of every row at once, laid out exactly and permuted; a
/// row reads the slots its length plan gave it.
pub fn build_layout(
    spec: &repeat::Spec,
    values: &[String],
    percents: &[f64],
    count: usize,
    stream: &Stream,
    mut modify: impl FnMut(usize, String, usize) -> String,
) -> EngineResult<Vec<String>> {
    let (plan, len_key) = length_plan(spec, count, stream);
    let slots = plan.total_slots;
    let mut pct = crate::prng::create(&format!("{}|{}|pct", stream.seed, stream.id));
    let counts = hamilton::counts_per_value(slots as i32, percents, &mut pct);
    let key = permute::key(&stream.seed, &stream.id);

    let mut cum_hi = Vec::with_capacity(counts.len());
    let mut acc = 0;
    for c in &counts {
        acc += c;
        cum_hi.push(acc);
    }
    let value_for_slot = |slot: i32| -> String {
        let (mut lo, mut hi) = (0usize, cum_hi.len().saturating_sub(1));
        while lo < hi {
            let mid = (lo + hi) / 2;
            if slot < cum_hi[mid] {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        values.get(lo).cloned().unwrap_or_default()
    };

    let mut out = Vec::with_capacity(count);
    for i in 0..count {
        let p = permute::apply(i as i32, count as i32, len_key) as usize;
        let row = stream.row_at(i);
        let start = plan.slot_start_at(p);
        let keep = plan.length_at(p);
        let mut parts = Vec::with_capacity(keep);
        for k in 0..keep {
            let raw = value_for_slot(permute::apply((start + k) as i32, slots as i32, key));
            parts.push(modify(row, raw, k));
        }
        out.push(repeat::join(&parts, spec)?);
    }
    Ok(out)
}

/// The `anomaly=`/`missing=` draw for one element of a repeating LISTED column.
///
/// One draw per element, pulled a whole row at a time — the budget is the row's maximum
/// length, so which uniform element k gets does not depend on how long its row turned out.
pub fn element_uniforms<'a>(
    stream: &'a Stream,
    purpose: &str,
    budget: usize,
) -> impl FnMut(usize, usize) -> f64 + 'a {
    let id = format!("{}{purpose}", stream.id);
    let mut cached: Option<(usize, Vec<f64>)> = None;
    move |row: usize, k: usize| -> f64 {
        if cached.as_ref().map(|(r, _)| *r) != Some(row) {
            cached = Some((
                row,
                seekable::uniforms(&stream.seed, &id, row as i32, budget),
            ));
        }
        cached
            .as_ref()
            .and_then(|(_, drawn)| drawn.get(k).copied())
            .unwrap_or(1.0)
    }
}
