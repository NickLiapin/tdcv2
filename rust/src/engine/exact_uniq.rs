//! Exact percentages and uniqueness at the same time, past the size of memory.
//!
//! The streaming engine can give unique combinations, but only uniform ones: its
//! mixed-radix index spreads rows evenly over the combination space by
//! construction. It can give exact percentages too. It cannot give both, because
//! the arrangement that satisfies one is not free to satisfy the other. The
//! in-memory engine does both by holding the whole table and repairing
//! collisions, which is precisely what stops working at scale.
//!
//! So: build each column with its exact quota the seekable way, then ask whether
//! the tuples happen to be distinct — a question a sort on disk can answer with
//! bounded memory. Usually they are, because a run of a million rows over a
//! space of billions collides by birthday odds, which is to say rarely. Then
//! nothing more is needed and the whole run stays O(1) in memory.
//!
//! When there are collisions there are few of them, so they can be repaired in
//! RAM: gather the colliding rows plus enough neighbours to give them somewhere
//! to move, learn which tuples already exist inside that small value space, and
//! rearrange the pool to avoid them. Only the pool's rows move, and only among
//! the pool's own values, so every column's totals come out exactly as declared.
//! A pool too tight to solve hands the config back to the in-memory engine
//! rather than shipping data that is nearly unique.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use super::external_sort;
use crate::engine::{invalid, EngineError, EngineResult};
use crate::prng::{self, permute};
use crate::sequence::uniq;
use crate::stats::hamilton;

/// Separates a tuple's columns. Control characters cannot appear in a generated
/// value.
const JOIN: char = '\u{1}';

/// Separates a key from its row index in a sortable record. NUL sorts below
/// everything.
const SEP: char = '\u{0}';

/// Enough digits for any run: the index is padded so byte order is also numeric
/// order.
const INDEX_WIDTH: usize = 16;

/// The pool repair is quadratic; past this many collisions, the config is
/// pathological.
const MAX_REPAIR_ROWS: usize = 20_000;

/// One uniq column: where it lands in the registry, its values, and their
/// shares.
pub struct Field {
    pub id: String,
    pub values: Vec<String>,
    pub percents: Vec<f64>,
}

/// A column of the finished arrangement.
///
/// A quota walk for the rows the construction left alone, plus the handful the
/// repair moved. Kept as data rather than as a closure so the stream engine can
/// hold it in its `Column` enum like any other.
#[derive(Clone, Debug)]
pub struct Resolver {
    values: Vec<String>,
    /// The running totals of the value quotas — which value a permuted slot
    /// lands in.
    cum_hi: Vec<i32>,
    count: i32,
    key: i32,
    /// Rows the repair rearranged, and what they hold now.
    overrides: BTreeMap<i32, String>,
}

impl Resolver {
    pub fn value_at(&self, row: i32) -> String {
        if let Some(replaced) = self.overrides.get(&row) {
            return replaced.clone();
        }
        let slot = permute::apply(row, self.count, self.key);
        self.values[run_for(&self.cum_hi, slot)].clone()
    }
}

/// The exact construction collided and the bounded repair could not place every
/// row.
///
/// Its own error rather than a message, because the disk engine catches exactly
/// this and hands the config to the in-memory engine.
pub fn repair_needed(collisions: usize, label: &str) -> EngineError {
    EngineError::Unsupported(format!(
        "engine 3: uniq {label} is too tight for the bounded-memory repair ({collisions} row(s) \
         couldn't be placed) — using the in-memory engine instead"
    ))
}

/// Whether an error is the repair giving up, and so the signal to fall back.
pub fn is_repair_needed(error: &EngineError) -> bool {
    matches!(error, EngineError::Unsupported(m) if m.starts_with("engine 3: uniq "))
}

/// Build the uniq columns with exact shares, and make sure the tuples really are
/// distinct.
pub fn arrange(
    fields: &[Field],
    count: i32,
    seed: &str,
    label: &str,
    tmp_dir: &Path,
) -> EngineResult<Vec<(String, Resolver)>> {
    let mut counts: Vec<Vec<i32>> = Vec::with_capacity(fields.len());
    for field in fields {
        let mut prng = prng::create(&format!("{seed}|{}|pct", field.id));
        counts.push(hamilton::counts_per_value(
            count,
            &field.percents,
            &mut prng,
        ));
    }

    let as_usize: Vec<Vec<usize>> = counts
        .iter()
        .map(|c| c.iter().map(|v| (*v).max(0) as usize).collect())
        .collect();
    let upper = uniq::upper_bound(&as_usize);
    if count as usize > upper {
        return invalid(&format!(
            "uniq {label} is infeasible — its data supports at most {upper} distinct rows, but \
             {count} were requested. Widen a column's values or lower count."
        ));
    }

    let mut resolvers: Vec<Resolver> = Vec::with_capacity(fields.len());
    for (j, field) in fields.iter().enumerate() {
        resolvers.push(Resolver {
            values: field.values.clone(),
            cum_hi: cumulative(&counts[j]),
            count,
            key: permute::key(seed, &field.id),
            overrides: BTreeMap::new(),
        });
    }

    // If any column uses each of its values at most once, the tuple is unique by
    // that column alone. Worth checking: it turns the whole verification pass
    // into an inspection of a handful of integers, and a serial-number column
    // makes it true.
    if counts.iter().any(|c| c.iter().all(|v| *v <= 1)) {
        return Ok(named(fields, resolvers));
    }

    repair(fields, resolvers, count, label, tmp_dir)
}

fn named(fields: &[Field], resolvers: Vec<Resolver>) -> Vec<(String, Resolver)> {
    fields.iter().map(|f| f.id.clone()).zip(resolvers).collect()
}

/// Verify, and repair what the construction left colliding.
///
/// The repair moves a small pool of rows and nothing else. That is what keeps
/// the percentages exact: a value only ever changes hands between two rows of
/// the pool, so every column ends the pass with the multiset it started with.
fn repair(
    fields: &[Field],
    resolvers: Vec<Resolver>,
    count: i32,
    label: &str,
    tmp_dir: &Path,
) -> EngineResult<Vec<(String, Resolver)>> {
    // Keep the first row of every colliding group; the rest have to move.
    let mut excess: Vec<i32> = Vec::new();
    for group in duplicate_groups(&resolvers, count, tmp_dir)? {
        excess.extend(group.into_iter().skip(1));
    }

    if excess.is_empty() {
        return Ok(named(fields, resolvers));
    }
    if excess.len() > MAX_REPAIR_ROWS {
        return Err(repair_needed(excess.len(), label));
    }

    // The colliding rows on their own often lack the variety to move — a lone
    // duplicate can only re-form the tuple it already has. So the pool takes in
    // donor rows sampled across the run, which gives the arrangement room
    // without letting any value leave the pool.
    let donor_target = ((count as usize).saturating_sub(excess.len())).min(8 * excess.len() + 24);
    let mut in_pool: BTreeSet<i32> = excess.iter().copied().collect();
    let mut pool: Vec<i32> = excess.clone();
    if donor_target > 0 {
        let stride = (count as usize / donor_target).max(1) as i32;
        let mut i = 0i32;
        while i < count && pool.len() - excess.len() < donor_target {
            if in_pool.insert(i) {
                pool.push(i);
            }
            i += stride;
        }
    }
    pool.sort_unstable();

    let k = resolvers.len();
    let mut pool_columns: Vec<Vec<String>> = Vec::with_capacity(k);
    let mut pool_space: Vec<BTreeSet<String>> = Vec::with_capacity(k);
    for resolver in &resolvers {
        let column: Vec<String> = pool.iter().map(|row| resolver.value_at(*row)).collect();
        pool_space.push(column.iter().cloned().collect());
        pool_columns.push(column);
    }

    // The only tuples a rearranged pool row could collide with are the ones
    // already present whose every value lies inside the pool's own value space.
    // One pass finds them.
    let mut forbidden: BTreeSet<String> = BTreeSet::new();
    for i in 0..count {
        if in_pool.contains(&i) {
            continue;
        }
        let mut key = String::new();
        let mut in_space = true;
        for (j, resolver) in resolvers.iter().enumerate() {
            let value = resolver.value_at(i);
            if !pool_space[j].contains(&value) {
                in_space = false;
                break;
            }
            if j > 0 {
                key.push(JOIN);
            }
            key.push_str(&value);
        }
        if in_space {
            forbidden.insert(key);
        }
    }

    let Some(arranged) = arrange_avoiding(&pool_columns, &forbidden, pool.len()) else {
        return Err(repair_needed(excess.len(), label));
    };

    let mut resolvers = resolvers;
    for (j, resolver) in resolvers.iter_mut().enumerate() {
        for (m, row) in pool.iter().enumerate() {
            resolver.overrides.insert(*row, arranged[j][m].clone());
        }
    }
    Ok(named(fields, resolvers))
}

/// The groups of rows whose tuples are identical, in bounded memory.
///
/// Sorting is what makes this affordable: equal keys end up adjacent, so the
/// scan holds one group rather than a set of every tuple seen. The row index is
/// padded to a fixed width and appended after a NUL, which makes plain byte
/// order the same as ordering by key and then by row — no record has to be
/// parsed to be compared.
fn duplicate_groups(
    resolvers: &[Resolver],
    count: i32,
    tmp_dir: &Path,
) -> EngineResult<Vec<Vec<i32>>> {
    let records = (0..count).map(|i| {
        let mut key = String::new();
        for (j, resolver) in resolvers.iter().enumerate() {
            if j > 0 {
                key.push(JOIN);
            }
            key.push_str(&resolver.value_at(i));
        }
        key.push(SEP);
        key.push_str(&format!("{i:0>INDEX_WIDTH$}"));
        key
    });

    let mut sorted = external_sort::sort(records, 0, tmp_dir)?;
    let mut groups: Vec<Vec<i32>> = Vec::new();
    let mut current: Option<String> = None;
    let mut group: Vec<i32> = Vec::new();

    while let Some(record) = sorted.take()? {
        let Some(split) = record.rfind(SEP) else {
            return invalid("engine 3: a sorted uniq record lost its separator");
        };
        let key = record[..split].to_string();
        // The index is zero-padded so byte order is numeric order; leading zeros
        // parse without help.
        let Ok(index) = record[split + 1..].parse::<i32>() else {
            return invalid("engine 3: a sorted uniq record has no row index");
        };
        push_group(&mut groups, &mut group, &mut current, Some(key), index);
    }

    if group.len() >= 2 {
        groups.push(group);
    }
    Ok(groups)
}

fn push_group(
    groups: &mut Vec<Vec<i32>>,
    group: &mut Vec<i32>,
    current: &mut Option<String>,
    key: Option<String>,
    index: i32,
) {
    if current.as_deref() != key.as_deref() {
        if group.len() >= 2 {
            groups.push(std::mem::take(group));
        }
        group.clear();
        *current = key;
    }
    group.push(index);
}

/// Rearrange the pool's columns so its tuples are distinct and none is already
/// taken.
///
/// Each column is permuted within itself, never added to or taken from, so the
/// pool's totals survive the pass. What changes is which values meet each other.
fn arrange_avoiding(
    columns: &[Vec<String>],
    forbidden: &BTreeSet<String>,
    size: usize,
) -> Option<Vec<Vec<String>>> {
    let k = columns.len();
    if size == 0 || k == 0 {
        return Some(columns.to_vec());
    }

    let arranged = uniq::arrange(columns).columns;
    let mut rows: Vec<Vec<String>> = (0..size)
        .map(|i| arranged.iter().map(|column| column[i].clone()).collect())
        .collect();

    for _ in 0..32 {
        let mut tally: BTreeMap<String, i32> = BTreeMap::new();
        for row in &rows {
            *tally.entry(key_of(row)).or_insert(0) += 1;
        }

        let mut improved = false;
        for i in 0..size {
            let key_i = key_of(&rows[i]);
            if !is_bad(&tally, forbidden, &key_i) {
                continue;
            }

            let mut done = false;
            for col in 0..k {
                if done {
                    break;
                }
                for j in 0..size {
                    if done || j == i || rows[i][col] == rows[j][col] {
                        continue;
                    }
                    let mut ni = rows[i].clone();
                    let mut nj = rows[j].clone();
                    ni[col] = rows[j][col].clone();
                    nj[col] = rows[i][col].clone();
                    let key_j = key_of(&rows[j]);
                    let new_i = key_of(&ni);
                    let new_j = key_of(&nj);

                    // Row i is known bad — that is why a partner is being looked
                    // for at all.
                    let before = 1 + i32::from(is_bad(&tally, forbidden, &key_j));
                    // A swap moves two rows, so only four tallies can change.
                    // Computing the delta beats copying the whole table inside
                    // the innermost loop, which is what makes a large pool
                    // finish rather than hang.
                    let after = i32::from(is_bad_after(
                        &tally, forbidden, &new_i, &key_i, &key_j, &new_i, &new_j,
                    )) + i32::from(is_bad_after(
                        &tally, forbidden, &new_j, &key_i, &key_j, &new_i, &new_j,
                    ));
                    if after < before {
                        rows[i] = ni;
                        rows[j] = nj;
                        *tally.entry(key_i.clone()).or_insert(0) -= 1;
                        *tally.entry(key_j).or_insert(0) -= 1;
                        *tally.entry(new_i).or_insert(0) += 1;
                        *tally.entry(new_j).or_insert(0) += 1;
                        improved = true;
                        done = true;
                    }
                }
            }
        }

        if !improved {
            break;
        }
    }

    let mut final_tally: BTreeMap<String, i32> = BTreeMap::new();
    for row in &rows {
        *final_tally.entry(key_of(row)).or_insert(0) += 1;
    }
    if rows
        .iter()
        .any(|row| is_bad(&final_tally, forbidden, &key_of(row)))
    {
        return None;
    }

    Some(
        (0..k)
            .map(|j| rows.iter().map(|row| row[j].clone()).collect())
            .collect(),
    )
}

fn is_bad(tally: &BTreeMap<String, i32>, forbidden: &BTreeSet<String>, key: &str) -> bool {
    tally.get(key).copied().unwrap_or(0) > 1 || forbidden.contains(key)
}

/// The verdict on `key` as it would stand after the two rows swapped.
fn is_bad_after(
    tally: &BTreeMap<String, i32>,
    forbidden: &BTreeSet<String>,
    key: &str,
    old_i: &str,
    old_j: &str,
    new_i: &str,
    new_j: &str,
) -> bool {
    let after =
        tally.get(key).copied().unwrap_or(0) + i32::from(key == new_i) + i32::from(key == new_j)
            - i32::from(key == old_i)
            - i32::from(key == old_j);
    after > 1 || forbidden.contains(key)
}

fn key_of(row: &[String]) -> String {
    row.join(&JOIN.to_string())
}

fn cumulative(counts: &[i32]) -> Vec<i32> {
    let mut result = Vec::with_capacity(counts.len());
    let mut acc = 0;
    for c in counts {
        acc += c;
        result.push(acc);
    }
    result
}

fn run_for(cum_hi: &[i32], slot: i32) -> usize {
    let mut lo = 0usize;
    let mut hi = cum_hi.len() - 1;
    while lo < hi {
        let mid = (lo + hi) >> 1;
        if slot < cum_hi[mid] {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}
