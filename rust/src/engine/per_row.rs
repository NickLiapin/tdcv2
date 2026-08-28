//! How the in-memory engine derives a column the way the streaming engine does.
//!
//! The two engines were built on different ideas of randomness. Engine 1 threaded one PRNG
//! through every sequence in declaration order, so a column's values depended on how many
//! draws the columns before it had made; engines 2 and 3 derive each cell from
//! `(seed, stream_id, row)` and are independent of one another. Two architectures, and no seed
//! could ever make them agree.
//!
//! This module is engine 1 adopting the second scheme — the port of the reference's
//! `sequence/per-row.ts`, with the same names so the two can be read side by side.
//!
//! Rust cannot copy the shared `Env` per column the way the other ports copy their context,
//! so the column's identity travels beside it as a [`Stream`]. Absent, everything falls back
//! to the sequential PRNG, which is what an inline generator or a nested pack body wants.

use std::collections::BTreeMap;

use crate::distribution::percent_mask;
use crate::model::Gen;
use crate::prng::{permute, seekable, Sfc32};
use crate::stats::hamilton;

/// What a column's exact layout gave each row.
///
/// Kept so a child that filters on this column can be ordered the way the streaming engine
/// orders it: a child's position inside its parent's subset is its RANK in the parent's
/// layout, not its ordinal among the matching rows, and the two are different orders.
#[derive(Clone, Debug)]
pub struct ExactLayout {
    pub values: Vec<String>,
    pub counts: Vec<i32>,
    /// Cumulative upper bound per value: value v owns slots `[cum_hi[v-1], cum_hi[v])`.
    pub cum_hi: Vec<i32>,
    pub slot_by_row: BTreeMap<usize, i32>,
}

/// The column a build belongs to: the seed it derives from, its name on the wire, and — when
/// it does not cover every row — the ABSOLUTE row each drawn position belongs to.
#[derive(Clone, Debug)]
pub struct Stream {
    pub seed: String,
    pub id: String,
    /// `None` means the column covers every row, so position and row are the same number.
    pub rows: Option<Vec<usize>>,
    /// This stream belongs to a ONE-ROW build — a pack generator's body, built for a single row
    /// of the column that names it. Anything only correct across a whole column has to refuse
    /// here rather than plan a quota over one row.
    pub one_row: bool,
    /// This stream builds a sequence INSIDE a pack body. The reference gives a
    /// body's inner sequences no stream identity, so its plain-list layout never
    /// fires there — a plain pack or file drawn inside a body stays a per-row
    /// pick, and this flag is how the same rule is stated here.
    pub in_body: bool,
}

impl Stream {
    pub fn new(seed: &str, id: &str) -> Self {
        Self {
            in_body: false,
            seed: seed.to_string(),
            id: id.to_string(),
            rows: None,
            one_row: false,
        }
    }

    /// The same stream, marked as one row of a bigger build.
    #[must_use]
    pub fn for_one_row(mut self) -> Self {
        self.one_row = true;
        self
    }

    /// The same stream, marked as building inside a pack body.
    pub fn for_body(mut self) -> Self {
        self.in_body = true;
        self
    }

    /// The same stream under a different name, keeping the row list.
    pub fn named(&self, id: &str) -> Self {
        Self {
            in_body: self.in_body,
            seed: self.seed.clone(),
            id: id.to_string(),
            rows: self.rows.clone(),
            one_row: self.one_row,
        }
    }

    /// A column whose drawn positions are known rows outright — a `<mix>` case, whose rows are
    /// neither a contiguous run nor a mask over the whole set but whichever rows the
    /// percentage layout gave it.
    pub fn with_rows(seed: &str, id: &str, rows: Vec<usize>) -> Self {
        Self {
            in_body: false,
            seed: seed.to_string(),
            id: id.to_string(),
            rows: Some(rows),
            one_row: false,
        }
    }

    /// The absolute row a drawn position belongs to.
    ///
    /// Index-dependent generators — counters, timeseries, a pattern stretched over the run —
    /// read the POSITION for their value, and the streaming engine does the same. Their random
    /// draws are keyed by the row instead, which is why the two numbers have to be told apart.
    pub fn row_at(&self, position: usize) -> usize {
        match &self.rows {
            Some(rows) => rows.get(position).copied().unwrap_or(position),
            None => position,
        }
    }
}

/// The absolute rows a mask lets through, in row order.
pub fn rows_of(mask: &[bool]) -> Vec<usize> {
    mask.iter()
        .enumerate()
        .filter(|(_, on)| **on)
        .map(|(i, _)| i)
        .collect()
}

/// Generators whose value for a row depends on nothing but that row.
///
/// A generator is off this list when its column is a PLAN rather than a series of draws.
/// `text` is the clearest case: even an UNWEIGHTED list is spread evenly over the column and
/// permuted, never picked independently per row, so [`exact_text_layout`] handles it instead.
/// The rest are conditional and checked in [`per_row_buildable`].
const PER_ROW_TYPES: [&str; 7] = [
    "number",
    "regex",
    "symbol",
    "date",
    "template",
    "file",
    "advanced_regex",
];

/// Types the streaming engine builds INLINE — it reads the row's position rather than deriving
/// a value from the row — and whose `anomaly=`/`missing=` draws it therefore takes from
/// dedicated `#anom` and `#miss` streams instead of from the generator's own.
pub const INLINE_ANOMALY_TYPES: [&str; 5] =
    ["text", "increment", "decrement", "timeseries", "pattern"];

pub fn is_inline_anomaly(gen_type: &str) -> bool {
    INLINE_ANOMALY_TYPES.contains(&gen_type)
}

/// Can this generator be built row by row?
///
/// A one-row build is refused, and only that: `one_row` says we are ALREADY inside one, not
/// that this column happens to hold a single row. The test used to be `count <= 1`, which
/// refused a genuine one-row column too — a run of `count="1"`, or a `<mix>` case whose quota
/// came to a single row. Those fell back to the threaded PRNG while the streaming engines drew
/// from the seekable stream, so one config produced two different datasets depending on which
/// engine ran it.
///
/// `weighted` and `whole_column` are decided by the caller, which is the only place that can
/// reach the pack registry without this module depending on it.
pub fn per_row_buildable(
    gen: &Gen,
    count: usize,
    weighted: bool,
    whole_column: bool,
    one_row: bool,
) -> bool {
    // `sample="exact"` on a quantile read is a PLAN too: every row takes its own point on
    // the sorted sample, and which point follows from a scatter over the whole column.
    // Built a row at a time it would see a count of one and hand every row the median.
    if gen.attrs.get("sample").map(|v| v.trim()) == Some("exact") {
        return false;
    }

    if count == 0 || one_row || !PER_ROW_TYPES.contains(&gen.gen_type.as_str()) {
        return false;
    }
    let attrs = &gen.attrs;
    // order="sequential" reads the position, never the randomness.
    if attrs.get("order").map(String::as_str) == Some("sequential") {
        return false;
    }
    // A weighted file column and a pack that declares shares are both exact quotas over the
    // whole column: the streaming engine lays them out the way it lays out weighted text.
    if attrs.contains_key("weight") || weighted || whole_column {
        return false;
    }
    // `row=` links several columns to ONE row of a file. That choice belongs to the row as a
    // whole, not to any single column reading from it.
    if !attrs.get("row").map(|r| r.trim()).unwrap_or("").is_empty() {
        return false;
    }
    // `percent=` on ANY type, not just text: a number can apportion its LENGTH groups the same
    // exact way (`length="2,10-12" percent="85,15"`).
    if attrs.contains_key("percent") {
        return false;
    }
    // `repeat=` apportions the LENGTHS exactly across the column. That plan is separate, and
    // taking this path would skip it.
    if attrs.contains_key("repeat") {
        return false;
    }
    true
}

/// A list of values laid out exactly, the way the streaming engine lays it out.
///
/// [`hamilton::counts_per_value`] turns the shares into a whole number of slots per value;
/// [`permute::apply`] scatters those slots over the rows with a key derived from the column's
/// name. Row i gets the value whose slot range contains `permute(i)`. Both halves are keyed by
/// `(seed, stream_id)`, so the in-memory and the streaming engine land on the same arrangement.
///
/// The layout is recorded in `layouts` for any child that filters on this column.
pub fn exact_text_layout(
    values: &[String],
    percents: &[f64],
    count: usize,
    stream: &Stream,
    layouts: Option<&mut BTreeMap<String, ExactLayout>>,
) -> Vec<String> {
    let mut pct_prng = crate::prng::create(&format!("{}|{}|pct", stream.seed, stream.id));
    let counts = hamilton::counts_per_value(count as i32, percents, &mut pct_prng);
    let key = permute::key(&stream.seed, &stream.id);

    let mut cum_hi: Vec<i32> = Vec::with_capacity(counts.len());
    let mut acc = 0;
    for c in &counts {
        acc += c;
        cum_hi.push(acc);
    }

    let mut out = Vec::with_capacity(count);
    let mut slot_by_row = BTreeMap::new();
    for i in 0..count {
        let slot = permute::apply(i as i32, count as i32, key);
        slot_by_row.insert(stream.row_at(i), slot);
        // Binary search rather than a linear scan: a wide column (many values) would otherwise
        // make the render O(count x values).
        let (mut lo, mut hi) = (0usize, cum_hi.len().saturating_sub(1));
        while lo < hi {
            let mid = (lo + hi) / 2;
            if slot < cum_hi[mid] {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        out.push(values.get(lo).cloned().unwrap_or_default());
    }

    if let Some(store) = layouts {
        store.insert(
            stream.id.clone(),
            ExactLayout {
                values: values.to_vec(),
                counts,
                cum_hi,
                slot_by_row,
            },
        );
    }
    out
}

/// The rows a sequence builds, in the order it builds them.
///
/// For an unparented column that is simply every row. For a child it is the rows the parent
/// selected, ordered by their RANK inside the parent's exact layout — which is not their row
/// order. The streaming engine hands a child that rank as its position, so a parented column
/// would otherwise arrange its own quota over a differently ordered subset and land every
/// value on the wrong row.
///
/// Falls back to row order when the parent kept no layout — a bare `parent="Name"` with no
/// value, or a parent the streaming engine would refuse as a parent anyway.
pub fn ordered_rows(
    parent: Option<&str>,
    mask: &[bool],
    layouts: &BTreeMap<String, ExactLayout>,
) -> Vec<usize> {
    let applicable = rows_of(mask);
    let Some(reference) = parent else {
        return applicable;
    };
    let Some((name, value)) = reference.split_once('.') else {
        return applicable;
    };
    let Some(plan) = layouts.get(name) else {
        return applicable;
    };
    let Some(vi) = plan.values.iter().position(|v| v == value) else {
        return applicable;
    };
    let lo = plan.cum_hi[vi] - plan.counts[vi];

    let mut ordered = vec![usize::MAX; applicable.len()];
    for &row in &applicable {
        let Some(&slot) = plan.slot_by_row.get(&row) else {
            return applicable;
        };
        let rank = slot - lo;
        if rank < 0 || rank as usize >= ordered.len() {
            return applicable;
        }
        ordered[rank as usize] = row;
    }
    if ordered.contains(&usize::MAX) {
        return applicable;
    }
    ordered
}

/// The uniform of row `i` on one of the column's own purpose streams (`#anom`, `#miss`).
pub fn purpose_draw(stream: &Stream, purpose: &str, row: usize) -> f64 {
    seekable::uniforms(
        &stream.seed,
        &format!("{}{}", stream.id, purpose),
        row as i32,
        1,
    )[0]
}

/// The generator a single row draws from.
pub fn row_generator(stream: &Stream, row: usize) -> Sfc32 {
    seekable::generator(&stream.seed, &stream.id, row as i32)
}

/// The shares a `percent=` mask expands to, or equal shares when there is no mask.
pub fn shares_of(percent: Option<&str>, value_count: usize) -> Vec<f64> {
    match percent {
        Some(mask) if !mask.is_empty() => percent_mask::expand(mask, value_count)
            .unwrap_or_else(|_| vec![100.0 / value_count as f64; value_count]),
        _ => vec![100.0 / value_count as f64; value_count],
    }
}
