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

use crate::engine::{invalid, EngineResult};
use crate::prng::Sfc32;
use crate::stats::hamilton;

/// A ceiling, so one careless attribute cannot make a run a thousand times slower.
pub const MAX_REPEAT: i32 = 64;

pub const DEFAULT_SEPARATOR: &str = ",";

#[derive(Clone, Debug)]
pub struct Spec {
    pub min: i32,
    pub max: i32,
    pub separator: String,
    /// `accumulate=`: the list is replaced by its running total before joining.
    pub accumulate: Option<String>,
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
        accumulate: super::accumulate::read(attrs),
    }))
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

    // The lengths, as an exact quota rather than a per-row coin flip.
    let group_ids: Vec<usize> = (0..groups).collect();
    let percents = vec![100.0 / groups as f64; groups];
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
