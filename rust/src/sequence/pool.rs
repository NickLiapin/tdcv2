//! `<pool>` — a small table computed once, before the rows.
//!
//! Twenty doctors for two thousand patients. The problem an ordinary sequence
//! cannot solve: a doctor is not a VALUE, he is a RECORD, and his gender, first
//! name and last name have to agree with each other.
//!
//! A pool is not read directly — `${{Doctors.lastName}}` would give the dot a
//! second meaning next to `${{Sequence.Field}}`. A sequence draws from it
//! instead, and that hands us the hardest rule for free: one sequence holds one
//! value per row, so every field read from the same reference in the same row
//! comes from the same member.

use std::collections::BTreeMap;

use crate::expr::match_key::match_key;
use crate::prng::seekable;

/// Measured on the reference: ~320 bytes a member with four fields.
pub const POOL_WARN_MEMBERS: i64 = 100_000;
pub const POOL_MAX_MEMBERS: i64 = 1_000_000;

/// A computed pool: `count` members, each a set of named fields.
///
/// Column-first because that is how a member is read — a row asks for one field
/// of one member, never for a whole member at once.
#[derive(Debug, Clone, Default)]
pub struct PoolTable {
    pub name: String,
    pub count: usize,
    /// Field names in declaration order.
    pub fields: Vec<String>,
    /// field → one value per member.
    pub columns: BTreeMap<String, Vec<String>>,
}

/// The seed a pool's own values are drawn from. Part of the cross-language
/// contract.
///
/// Derived rather than taken off the main stream, so adding a pool to a config
/// leaves every other column exactly where it was and an old snapshot still
/// matches.
pub fn pool_seed(seed: &str, pool_name: &str) -> String {
    format!("{seed}#pool:{pool_name}")
}

/// The PRNG stream a reference draws its member from. Seekable by row.
pub fn ref_stream(ref_name: &str) -> String {
    format!("pool-ref:{ref_name}")
}

pub fn pick_member(seed: &str, ref_name: &str, table: &PoolTable, row: usize) -> usize {
    seekable::next_int(seed, &ref_stream(ref_name), row as i32, table.count as i32) as usize
}

/// `field == Column`, recognised only when BOTH sides are what they look like.
///
/// Without the `is_column` test, `filter="clinic == North"` — where North is a
/// bare word, which the expression language has always allowed and which is the
/// obvious way to write "northern doctors only" — reads as a comparison against
/// a column named North, finds nothing, and refuses the run.
pub fn parse_equality_filter(
    expression: &str,
    table: &PoolTable,
    is_column: &dyn Fn(&str) -> bool,
) -> Option<(String, String)> {
    let parts: Vec<&str> = expression.split("==").collect();
    if parts.len() != 2 {
        return None;
    }
    let left = parts[0].trim();
    let right = parts[1].trim();
    if !plain(left) || !plain(right) {
        return None;
    }
    let has = |name: &str| table.fields.iter().any(|f| f == name);
    if has(left) && is_column(right) {
        return Some((left.to_string(), right.to_string()));
    }
    if has(right) && is_column(left) {
        return Some((right.to_string(), left.to_string()));
    }
    None
}

fn plain(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// member value → the members holding it. Built once per reference.
///
/// Keyed by `match_key` rather than by the raw text, so the bucket answers the
/// same question `==` would: a member holding `"01"` is found by a row
/// producing `"1"`, exactly as the general expression path finds it.
pub fn bucket_by_field(table: &PoolTable, field: &str) -> BTreeMap<String, Vec<usize>> {
    let mut buckets: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    let empty = Vec::new();
    let column = table.columns.get(field).unwrap_or(&empty);
    for m in 0..table.count {
        let key = match_key(column.get(m).map(String::as_str).unwrap_or_default());
        buckets.entry(key).or_default().push(m);
    }
    buckets
}

/// The refusal a row gets when the filter leaves it with no member at all.
/// ` (Clinic="North", Budget="40")` — what the row held, for the refusal below.
///
/// The bucketed `field == Column` path always named the value a row was looking
/// for; the general one named nothing, so the reader could not tell a pool
/// missing a member from a filter that is wrong. What the evaluator ASKED for is
/// what the filter reads, so the names are recorded during the scan rather than
/// parsed back out of the expression.
pub fn row_values_detail(values: &std::collections::BTreeMap<String, String>) -> String {
    if values.is_empty() {
        return String::new();
    }
    let parts: Vec<String> = values
        .iter()
        .map(|(name, value)| format!("{name}=\"{value}\""))
        .collect();
    format!(" ({})", parts.join(", "))
}

pub fn no_candidate_message(pool_name: &str, expression: &str, row: usize, detail: &str) -> String {
    format!(
        "pool \"{pool_name}\": no member satisfies filter=\"{expression}\" for row {}{detail}. \
         A filter narrows the members a row may draw from; when it narrows them to none there is \
         nothing to substitute. Add a member that matches, or widen the filter.",
        row + 1
    )
}
