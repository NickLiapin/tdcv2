//! `repeat="N"` or `repeat="A..B"` — several values in one cell instead of one.
//!
//! A customer with three orders, a post with a handful of tags. The values are
//! joined by `separator` in text output, and `each=` on a line walks them.
//!
//! The whole difficulty is that a row has to be computable without computing the
//! rows before it. A variable number of values would mean a variable number of
//! draws, which breaks that. The way out is to decide the **lengths first**, as
//! an exact quota over the whole run: once the lengths are known the total
//! number of value slots is a fixed number, so nothing is generated and
//! discarded, and a row finds its slice from its own position rather than from a
//! running total over its predecessors.
//!
//! Deciding lengths first also keeps `percent=` exact. The obvious alternative —
//! give every row `max` slots and throw away the extras — spends quota on the
//! discarded slots, and a declared 50/50 split quietly stops coming out 50/50.

use std::collections::BTreeMap;

use crate::engine::{invalid, EngineError, EngineResult};
use crate::numbers;
use crate::prng::Sfc32;
use crate::stats::hamilton;

/// A ceiling, so one careless attribute cannot make a run a thousand times slower.
pub const MAX_REPEAT: i32 = 64;

pub const DEFAULT_SEPARATOR: &str = ",";

/// Bounded retries before a `distinct` draw admits it cannot find a fresh value.
pub const DISTINCT_MAX_TRIES: usize = 64;

#[derive(Clone, Debug)]
pub struct Spec {
    pub min: i32,
    pub max: i32,
    pub separator: String,
    /// `lengths=`: the share of rows that get each possible length, `min` first.
    ///
    /// Without it every length is equally likely, and exactly so — the lengths are laid
    /// out as a Hamilton quota, which is the wrong shape for every real one-to-many
    /// relationship. The shares live HERE, in the spec, rather than in a per-row draw:
    /// a per-row count would make a row's draws depend on the rows before it.
    pub lengths: Option<Vec<f64>>,
    /// `accumulate=`: the list is replaced by its running total before joining.
    pub accumulate: Option<String>,
    /// `distinct=`: the row's values are drawn WITHOUT replacement.
    ///
    /// This changes the regime the column is built in, which is why `percent` is refused
    /// beside it. Ordinarily a listed column lays its values out over the whole run as an
    /// exact quota; under `distinct` it draws per row instead, because holding an exact
    /// whole-run quota AND a per-row guarantee at once costs either streaming or the
    /// randomness of the sample. Frequencies stay approximate, rows stay independent.
    pub distinct: bool,
}

/// `None` when the generator has no `repeat`, which is the ordinary case.
pub fn parse(attrs: &BTreeMap<String, String>) -> EngineResult<Option<Spec>> {
    let Some(raw) = attrs.get("repeat") else {
        return Ok(None);
    };
    if raw.trim().is_empty() {
        return Ok(None);
    }

    let text = raw.trim();
    let (min_text, max_text) = match text.find("..") {
        Some(dots) => (text[..dots].trim(), text[dots + 2..].trim()),
        None => (text, text),
    };

    let min = whole(min_text, raw, "minimum")?;
    let max = whole(max_text, raw, "maximum")?;
    if min < 0 {
        return invalid(&format!(
            "repeat: minimum of \"{raw}\" must not be negative"
        ));
    }
    if max < min {
        return invalid(&format!(
            "repeat: \"{raw}\" has its maximum below its minimum"
        ));
    }
    if max > MAX_REPEAT {
        return invalid(&format!(
            "repeat: maximum of \"{raw}\" must not exceed {MAX_REPEAT}"
        ));
    }

    Ok(Some(Spec {
        min,
        max,
        separator: attrs
            .get("separator")
            .cloned()
            .unwrap_or_else(|| DEFAULT_SEPARATOR.to_string()),
        lengths: parse_lengths(attrs.get("lengths").map(String::as_str), min, max)?,
        accumulate: super::accumulate::read(attrs),
        distinct: read_distinct(attrs),
    }))
}

/// `lengths="40,25,15,10,7,3"` — one share per possible length, `min` first.
///
/// Refused rather than repaired when the count is wrong or the shares do not sum to 100:
/// a fan-out written with five shares for six lengths is a config whose author had a
/// shape in mind, and guessing which of the six they forgot is the silent repair this
/// project spends its time removing. The sum rule is `percent=`'s, deliberately.
pub fn parse_lengths(raw: Option<&str>, min: i32, max: i32) -> EngineResult<Option<Vec<f64>>> {
    let Some(text) = raw.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let parts: Vec<&str> = text
        .split(',')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    let groups = (max - min + 1).max(1) as usize;
    if parts.len() != groups {
        return Err(EngineError::Invalid(format!(
            "lengths: {} share(s) for {groups} possible length(s) — repeat=\"{min}..{max}\" \
             can produce {min} to {max} values, so it needs one share for each",
            parts.len()
        )));
    }
    let mut values = Vec::with_capacity(parts.len());
    for (index, part) in parts.iter().enumerate() {
        let value: f64 = part.parse().unwrap_or(f64::NAN);
        if !value.is_finite() || value < 0.0 {
            return Err(EngineError::Invalid(format!(
                "lengths: share for length {} is not a number >= 0",
                min + index as i32
            )));
        }
        values.push(value);
    }
    let total: f64 = values.iter().sum();
    if (total - 100.0).abs() > 1e-9 {
        return Err(EngineError::Invalid(format!(
            "lengths: shares sum to {}, expected 100",
            numbers::to_text(total)
        )));
    }
    Ok(Some(values))
}

/// The same attributes without `repeat`, for building one element at a time.
pub fn without(attrs: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    let mut result = attrs.clone();
    result.remove("repeat");
    result
}

/// Produce `count` rows of joined values.
///
/// `build_flat` is the caller's ordinary "give me N values" builder, already
/// applying anomaly, missing and formatting per value — which is exactly why
/// those come out per element here with no extra work. The draw order is fixed:
/// all the length draws first, then the values. Both engines depend on it
/// staying that way.
/// Where each row's values sit in one flat run of slots.
///
/// The lengths are decided before any value exists, so a row's slice follows from its own
/// position rather than from a running total over the rows before it. That is what lets the
/// streaming engine answer row nine million without having built the first eight.
#[derive(Clone, Debug)]
pub struct Plan {
    pub min: i32,
    pub total_slots: usize,
    row_cum_lo: Vec<usize>,
    slot_offset: Vec<usize>,
}

impl Plan {
    /// How many values the row at permuted position `p` keeps.
    pub fn length_at(&self, p: usize) -> usize {
        self.min as usize + self.group_of(p)
    }

    /// The first slot the row at permuted position `p` owns.
    pub fn slot_start_at(&self, p: usize) -> usize {
        let j = self.group_of(p);
        self.slot_offset[j] + (p - self.row_cum_lo[j]) * (self.min as usize + j)
    }

    fn group_of(&self, p: usize) -> usize {
        let (mut lo, mut hi) = (0usize, self.row_cum_lo.len() - 1);
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if p >= self.row_cum_lo[mid] {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        lo
    }
}

/// Lay out `row_count` rows whose lengths were apportioned as `counts`.
pub fn plan(spec: &Spec, counts: &[i32]) -> Plan {
    let groups = (spec.max - spec.min + 1).max(1) as usize;
    let mut row_cum_lo = vec![0usize; groups];
    let mut slot_offset = vec![0usize; groups];
    let mut row_acc = 0usize;
    let mut slot_acc = 0usize;
    for j in 0..groups {
        row_cum_lo[j] = row_acc;
        slot_offset[j] = slot_acc;
        let c = counts.get(j).copied().unwrap_or(0).max(0) as usize;
        row_acc += c;
        slot_acc += c * (spec.min as usize + j);
    }
    Plan {
        min: spec.min,
        total_slots: slot_acc,
        row_cum_lo,
        slot_offset,
    }
}

/// An even split across the possible lengths — the shares `plan` quotas by.
pub fn length_percents(spec: &Spec) -> Vec<f64> {
    if let Some(declared) = &spec.lengths {
        return declared.clone();
    }
    let groups = (spec.max - spec.min + 1).max(1) as usize;
    vec![100.0 / groups as f64; groups]
}

pub fn build(
    spec: &Spec,
    count: usize,
    prng: &mut Sfc32,
    build_flat: impl FnOnce(usize, &mut Sfc32) -> EngineResult<Vec<String>>,
) -> EngineResult<Vec<String>> {
    let groups = (spec.max - spec.min + 1).max(1) as usize;

    // The lengths, as an exact quota rather than a per-row coin flip — and by the
    // DECLARED shares when `lengths=` gave any, which is the one place that decides how
    // many rows get one value and how many get five.
    let group_ids: Vec<usize> = (0..groups).collect();
    let percents = length_percents(spec);
    let per_row_group = hamilton::distribute(count as i32, &group_ids, &percents, prng);

    let mut counts = vec![0usize; groups];
    for j in &per_row_group {
        counts[*j] += 1;
    }

    // Each length group owns one contiguous block of slots, so a row's slice
    // follows from its rank inside its own group and from nothing else.
    let mut offsets = vec![0usize; groups];
    let mut acc = 0usize;
    for (j, offset) in offsets.iter_mut().enumerate() {
        *offset = acc;
        acc += counts[j] * (spec.min as usize + j);
    }
    let total_slots = acc;

    let mut next_rank = vec![0usize; groups];
    let mut starts = vec![0usize; count];
    let mut keeps = vec![0usize; count];
    for i in 0..count {
        let j = per_row_group[i];
        let length = spec.min as usize + j;
        starts[i] = offsets[j] + next_rank[j] * length;
        next_rank[j] += 1;
        keeps[i] = length;
    }

    let flat = build_flat(total_slots, prng)?;

    (0..count)
        .map(|i| {
            let parts: Vec<String> = (0..keeps[i])
                .map(|k| flat.get(starts[i] + k).cloned().unwrap_or_default())
                .collect();
            join(&parts, spec)
        })
        .collect()
}

/// The last step every repeat list goes through: accumulate, then join.
///
/// One function rather than three copies because there are three places a list becomes a
/// cell — one in the in-memory engine and two in the streaming one — and a running total
/// that appeared on one engine and not the other is the failure this shape prevents.
pub fn join(parts: &[String], spec: &Spec) -> EngineResult<String> {
    let running = match &spec.accumulate {
        Some(op) => match super::accumulate::apply(parts, op) {
            Ok(values) => values,
            Err(message) => return invalid(&message),
        },
        None => parts.to_vec(),
    };
    Ok(running.join(&spec.separator))
}

/// Split a cell back into the elements `each=` walks.
///
/// An empty cell is an EMPTY list, not a list holding one blank. Splitting `""`
/// would invent a phantom element and emit an order row for a customer who
/// placed none.
pub fn split(cell: Option<&str>, separator: &str) -> Vec<String> {
    match cell {
        None | Some("") => Vec::new(),
        Some(cell) if separator.is_empty() => vec![cell.to_string()],
        Some(cell) => cell.split(separator).map(str::to_string).collect(),
    }
}

/// The key for one element: card `card` (1-based), position `position` (1-based).
///
/// Each card owns a block of `stride` keys and each list owns a lane inside it.
/// Both parts are needed — a config with two repeating sequences writes both
/// into the same child table, and one shared counter would make their keys
/// collide.
///
/// Derived from the card index alone, so a row still resolves without knowing
/// anything about the rows before it. That leaves gaps when a card holds fewer
/// elements than its list allows, which is the deliberate trade: keys that
/// increase down the file read better in a dump than gapless keys that jump
/// around.
pub fn item_key(card: i64, position: i64, lane: i64, stride: i64) -> i64 {
    (card - 1) * stride + lane + position
}

fn whole(text: &str, raw: &str, label: &str) -> EngineResult<i32> {
    match text.parse::<i32>() {
        Ok(v) => Ok(v),
        Err(_) => invalid(&format!(
            "repeat: {label} of \"{raw}\" must be a whole number"
        )),
    }
}

/// `distinct="true"`. Anything but the two words is refused by the validator.
pub fn read_distinct(attrs: &BTreeMap<String, String>) -> bool {
    attrs.get("distinct").map(|v| v.trim()) == Some("true")
}

/// Draw `keep` DIFFERENT values from a weighted list, one uniform per pick.
///
/// Weights survive — a frequent name is still likelier to be picked first — but the exact
/// whole-run quota does not, which is the documented price of `distinct` and the reason
/// `percent` may not appear beside it.
///
/// Running out is an error rather than a short list: a cell quietly shorter than `repeat`
/// asked for is the silent-and-wrong outcome the feature exists to prevent.
pub fn draw_distinct(
    values: &[String],
    weights: &[f64],
    keep: usize,
    mut next_uniform: impl FnMut() -> f64,
    describe_pool: &str,
) -> EngineResult<Vec<String>> {
    if keep > values.len() {
        return invalid(&format!(
            "repeat with distinct=\"true\" asks for {keep} different values, but {describe_pool} holds only {}",
            values.len()
        ));
    }

    // Weighted draw without replacement: pick against the remaining weight, then swap the
    // winner out with the last live candidate. What remains is a pure function of the picks
    // already made, so the draw stays deterministic.
    let mut pool: Vec<String> = values.to_vec();
    let mut w: Vec<f64> = if weights.len() == values.len() {
        weights.to_vec()
    } else {
        vec![1.0; values.len()]
    };
    let mut total: f64 = w.iter().filter(|x| **x > 0.0).sum();

    let mut out: Vec<String> = Vec::with_capacity(keep);
    for picked in 0..keep {
        let size = pool.len() - picked;
        let mut index = size - 1;
        if total > 0.0 {
            let mut target = next_uniform() * total;
            for (i, weight) in w.iter().take(size).enumerate() {
                target -= weight.max(0.0);
                if target < 0.0 {
                    index = i;
                    break;
                }
            }
        } else {
            index = ((next_uniform() * size as f64) as usize).min(size - 1);
        }
        let chosen = pool[index].clone();
        total -= w[index].max(0.0);
        let last = size - 1;
        pool[index] = pool[last].clone();
        w[index] = w[last];
        pool[last] = chosen.clone();
        out.push(chosen);
    }
    Ok(out)
}

/// Ask `draw` for a value that is not already in `seen`.
///
/// A drawn generator has no pool to draw down, so `distinct` is rejection sampling. `draw`
/// receives the sub-stream suffix: empty for the first attempt (so a config WITHOUT
/// `distinct` reads the very same stream), then `r1`, `r2` and so on.
///
/// Exhausting the tries is an error rather than a duplicate or a short list.
/// `regex="[01]"` under `repeat="5"` cannot be satisfied by anything, and saying so is the
/// entire point of the attribute.
pub fn redraw_until_fresh(
    seen: &[String],
    gen_type: &str,
    draw: impl FnMut(&str) -> EngineResult<String>,
) -> EngineResult<String> {
    Ok(redraw_until_fresh_at(seen, gen_type, draw)?.0)
}

/// The same loop, reporting WHICH sub-stream won.
///
/// The anomaly flag needs this. A flag is resolved by re-running the element's draw and
/// asking whether it spiked — and under `distinct` the value that survived may have come
/// from `r3` rather than the first attempt. Resolving the flag on the first attempt would
/// describe a value that was thrown away: the list would say `false` beside a number that
/// plainly spiked, which is worse than no flag at all.
pub fn redraw_until_fresh_at(
    seen: &[String],
    gen_type: &str,
    mut draw: impl FnMut(&str) -> EngineResult<String>,
) -> EngineResult<(String, String)> {
    let mut suffix = String::new();
    let mut value = draw(&suffix)?;
    let mut attempt = 1usize;
    while seen.contains(&value) && attempt <= DISTINCT_MAX_TRIES {
        suffix = format!("r{attempt}");
        value = draw(&suffix)?;
        attempt += 1;
    }
    if seen.contains(&value) {
        return invalid(&format!(
            "repeat with distinct=\"true\" could not find {} different values for <gen type=\"{gen_type}\"> after {DISTINCT_MAX_TRIES} tries — the generator does not produce that many",
            seen.len() + 1
        ));
    }
    Ok((value, suffix))
}
