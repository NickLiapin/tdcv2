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

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use super::{external_sort, fingerprint};
use crate::engine::{invalid, EngineError, EngineResult};
use crate::prng::{self, permute};
use crate::sequence::uniq;
use crate::stats::hamilton;

/// Separates a tuple's columns. Control characters cannot appear in a generated
/// value.
pub const JOIN: char = '\u{1}';

/// Separates a key from its row index in a sortable record. NUL sorts below
/// everything.
const SEP: char = '\u{0}';

/// Enough digits for any run: the index is padded so byte order is also numeric
/// order.
const INDEX_WIDTH: usize = 16;

/// The pool repair is quadratic; past this many collisions, the config is
/// pathological.
/// Anything that can answer "is this tuple taken?" — an exact set, or the disk ledger.
pub trait Membership {
    fn has(&mut self, key: &str) -> bool;
}

impl Membership for BTreeSet<String> {
    fn has(&mut self, key: &str) -> bool {
        self.contains(key)
    }
}

impl Membership for fingerprint::Ledger {
    fn has(&mut self, key: &str) -> bool {
        fingerprint::Ledger::has(self, key)
    }
}

/// How many colliding rows the bounded repair takes on, for a run of `count`.
///
/// A flat cap was written when the repair was quadratic in its pool. It is not
/// any more, and collisions grow as the SQUARE of the run — so a flat cap
/// doomed every sufficiently large run. A thousandth of the rows keeps the
/// repair pool in tens of megabytes at any size, and the floor keeps small runs
/// as permissive as they were.
fn max_repair_rows_for(count: i32) -> usize {
    (count as usize / 1000).max(20_000)
}

/// Rows past which the in-memory engine is NOT a fallback: past this it cannot
/// hold the table at all, so falling back fails after a long materialisation
/// rather than fast.
pub const IN_MEMORY_FALLBACK_MAX_ROWS: i32 = 20_000_000;

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
        "uniq {label} is too tight to repair without holding the whole table ({collisions} row(s) \
         couldn't be placed) — run without mode=\"stream\" so the in-memory engine can arrange it."
    ))
}

/// The part of that sentence that identifies it, wherever it is quoted from.
const REPAIR_NEEDED_MARK: &str = "is too tight to repair without holding the whole table";

/// Whether an error is the repair giving up, and so the signal to fall back.
pub fn is_repair_needed(error: &EngineError) -> bool {
    matches!(error, EngineError::Unsupported(m) if m.contains(REPAIR_NEEDED_MARK))
}

/// A column as the repair sees it: the value it gives a row.
///
/// The quota walk below is one such column, and a stream engine's finished
/// column is another — an env-level `<uniq>` repairs sequences that were built
/// by every other path in the engine, so the repair cannot name their type.
pub type Source<'a> = Box<dyn Fn(i32) -> String + 'a>;

/// The rows the repair moved, and the values they hold now — one per column.
pub type Overrides = BTreeMap<i32, Vec<String>>;

/// Build the uniq columns with exact shares, and make sure the tuples really are
/// distinct.
pub fn arrange(
    fields: &[Field],
    count: i32,
    seed: &str,
    label: &str,
    tmp_dir: &Path,
    on_progress: crate::engine::Watch<'_>,
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

    let overrides = {
        let sources: Vec<Source<'_>> = resolvers
            .iter()
            .map(|r| Box::new(move |row: i32| r.value_at(row)) as Source<'_>)
            .collect();
        repair(&sources, count, label, tmp_dir, None, on_progress)?
    };
    for (row, values) in &overrides {
        for (j, resolver) in resolvers.iter_mut().enumerate() {
            resolver.overrides.insert(*row, values[j].clone());
        }
    }
    Ok(named(fields, resolvers))
}

fn named(fields: &[Field], resolvers: Vec<Resolver>) -> Vec<(String, Resolver)> {
    fields.iter().map(|f| f.id.clone()).zip(resolvers).collect()
}

/// Verify, and repair what the construction left colliding.
///
/// The repair moves a small pool of rows and nothing else. That is what keeps
/// the percentages exact: a value only ever changes hands between two rows of
/// the pool, so every column ends the pass with the multiset it started with.
///
/// `block_of` names which rows may trade values with each other. A `<switch>`
/// member draws from a different list depending on another column, so a male
/// row's first name is not a value a female row is allowed to hold; without
/// this the repair would keep the tuple unique and stop the record making
/// sense. `None` means one block holding everything, which is the ordinary
/// case.
pub fn repair(
    sources: &[Source<'_>],
    count: i32,
    label: &str,
    tmp_dir: &Path,
    block_of: Option<&dyn Fn(i32) -> String>,
    on_progress: crate::engine::Watch<'_>,
) -> EngineResult<Overrides> {
    // How the duplicates are hunted: by fingerprint on a large run, by tuple
    // text on a small one. The carrier is all that differs — the rows found are
    // the same either way, because a matching fingerprint is verified against
    // the true tuples before it is believed.
    let mut report = RepairReport::new(on_progress);
    let scan = fingerprint_scan(sources, count, tmp_dir, on_progress, &mut report)?;

    let mut excess: Vec<i32> = Vec::new();
    match &scan {
        Some(found) => excess.extend(found.excess.iter().copied()),
        None => {
            // Keep the first row of every colliding group; the rest have to move.
            for group in duplicate_groups(sources, count, tmp_dir)? {
                excess.extend(group.into_iter().skip(1));
            }
        }
    }

    if excess.is_empty() {
        if let Some(found) = &scan {
            found.drop_files();
        }
        return Ok(Overrides::new());
    }
    if excess.len() > max_repair_rows_for(count) {
        if let Some(found) = &scan {
            found.drop_files();
        }
        return Err(repair_needed(excess.len(), label));
    }
    excess.sort_unstable();

    // The colliding rows on their own often lack the variety to move — a lone
    // duplicate can only re-form the tuple it already has. So the pool takes in
    // donor rows sampled across the run, which gives the arrangement room
    // without letting any value leave the pool.
    let donor_target = ((count as usize).saturating_sub(excess.len())).min(8 * excess.len() + 24);
    let mut in_pool: BTreeSet<i32> = excess.iter().copied().collect();
    let mut pool: Vec<i32> = excess.clone();
    match block_of {
        _ if donor_target == 0 => {}
        None => {
            let stride = (count as usize / donor_target).max(1) as i32;
            let mut i = 0i32;
            while i < count && pool.len() - excess.len() < donor_target {
                if in_pool.insert(i) {
                    pool.push(i);
                }
                i += stride;
            }
        }
        Some(block) => {
            // Donors have to come from the row's OWN block, or they arrive
            // holding values it is not allowed to take. Wanted per block, in
            // proportion to how many of its rows have to move.
            let mut wanted: BTreeMap<String, usize> = BTreeMap::new();
            for row in &excess {
                *wanted.entry(block(*row)).or_insert(0) += 8;
            }
            for left in wanted.values_mut() {
                *left += 24;
            }
            let stride = (count as usize / donor_target.max(1)).max(1) as i32;
            let mut i = 0i32;
            while i < count {
                if !in_pool.contains(&i) {
                    if let Some(left) = wanted.get_mut(&block(i)) {
                        if *left > 0 {
                            *left -= 1;
                            in_pool.insert(i);
                            pool.push(i);
                        }
                    }
                }
                i += stride;
            }
        }
    }
    pool.sort_unstable();

    let k = sources.len();
    report.step(pool.len());
    let mut pool_columns: Vec<Vec<String>> = Vec::with_capacity(k);
    let mut pool_space: Vec<BTreeSet<String>> = Vec::with_capacity(k);
    for source in sources {
        let column: Vec<String> = pool.iter().map(|row| source(*row)).collect();
        pool_space.push(column.iter().cloned().collect());
        pool_columns.push(column);
    }

    // "Is this tuple taken?" — answered one of two ways.
    //
    // Large run: no structure at all. The sorted fingerprint piles on disk ARE
    // the ledger, and a query is a binary search. Small run: derive every row's
    // tuple once more and hold the ones inside the pool's value space in an
    // exact set, exactly as before.
    let mut forbidden: Box<dyn Membership> = match &scan {
        Some(found) => {
            let moving: HashSet<usize> = in_pool.iter().map(|row| *row as usize).collect();
            Box::new(
                fingerprint::Ledger::open(&found.sorted_paths, moving).map_err(|e| {
                    EngineError::Unsupported(format!("uniq fingerprint ledger: {e}"))
                })?,
            )
        }
        None => {
            let mut exact: BTreeSet<String> = BTreeSet::new();
            for i in 0..count {
                if in_pool.contains(&i) {
                    continue;
                }
                let mut key = String::new();
                let mut in_space = true;
                for (j, source) in sources.iter().enumerate() {
                    let value = source(i);
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
                    exact.insert(key);
                }
            }
            Box::new(exact)
        }
    };

    // The pool is arranged one block at a time: a value only ever lands on a row
    // that was allowed to hold it. One block, keyed by the empty string, is the
    // ordinary case.
    let mut order: Vec<String> = Vec::new();
    let mut blocks: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (m, row) in pool.iter().enumerate() {
        let key = block_of.map_or_else(String::new, |block| block(*row));
        let positions = blocks.entry(key.clone()).or_insert_with(|| {
            order.push(key);
            Vec::new()
        });
        positions.push(m);
    }

    let mut overrides = Overrides::new();
    let mut failed = false;
    for key in &order {
        let positions = &blocks[key];
        let columns: Vec<Vec<String>> = pool_columns
            .iter()
            .map(|column| positions.iter().map(|m| column[*m].clone()).collect())
            .collect();
        match arrange_avoiding(&columns, forbidden.as_mut(), positions.len(), &mut report) {
            Some(arranged) => {
                for (at, m) in positions.iter().enumerate() {
                    overrides.insert(
                        pool[*m],
                        arranged.iter().map(|column| column[at].clone()).collect(),
                    );
                }
            }
            None => {
                failed = true;
                break;
            }
        }
    }
    drop(forbidden);
    if let Some(found) = &scan {
        found.drop_files();
    }
    if failed {
        return Err(repair_needed(excess.len(), label));
    }
    report.finish();
    Ok(overrides)
}

/// The groups of rows whose tuples are identical, in bounded memory.
///
/// Sorting is what makes this affordable: equal keys end up adjacent, so the
/// scan holds one group rather than a set of every tuple seen. The row index is
/// padded to a fixed width and appended after a NUL, which makes plain byte
/// order the same as ordering by key and then by row — no record has to be
/// parsed to be compared.
/// What the fingerprint hunt produced: the sorted piles, their home, the rows.
struct FingerprintScan {
    sorted_paths: Vec<PathBuf>,
    directory: PathBuf,
    excess: Vec<i32>,
}

impl FingerprintScan {
    fn drop_files(&self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

/// Hunt duplicates by fingerprint, or return None to leave the text path in charge.
///
/// Every row's tuple is hashed into a 13-byte record routed straight to its
/// pile; each pile is sorted as raw bytes; groups sharing a hash are
/// CANDIDATES. Verification then recomputes the true tuples for those few rows,
/// so a 64-bit collision costs one recomputation and never a false duplicate —
/// the rows returned are exactly the ones the text sort would name.
fn fingerprint_scan(
    sources: &[Source<'_>],
    count: i32,
    tmp_dir: &Path,
    on_progress: crate::engine::Watch<'_>,
    report: &mut RepairReport<'_>,
) -> EngineResult<Option<FingerprintScan>> {
    let cores = std::thread::available_parallelism()
        .map(std::num::NonZeroUsize::get)
        .unwrap_or(1);
    let buckets = fingerprint::bucket_count_for(count as u64, cores);
    if buckets < 2 {
        return Ok(None);
    }

    let directory = tmp_dir.join(format!("tdc-fp-{}", std::process::id()));
    std::fs::create_dir_all(&directory)
        .map_err(|e| EngineError::Unsupported(format!("uniq fingerprint dir: {e}")))?;

    let join = JOIN.to_string();
    let functions: Vec<Box<dyn Fn(usize) -> String + '_>> = sources
        .iter()
        .map(|source| {
            Box::new(move |row: usize| source(row as i32)) as Box<dyn Fn(usize) -> String>
        })
        .collect();

    let raw_paths = fingerprint::write_piles(
        &functions,
        0,
        count as usize,
        &directory,
        "raw",
        buckets,
        &join,
        on_progress,
    )
    .map_err(|e| EngineError::Unsupported(format!("uniq fingerprint scan: {e}")))?;

    let mut sorted_paths = Vec::with_capacity(buckets);
    let mut candidates: Vec<Vec<usize>> = Vec::new();
    for (b, raw) in raw_paths.iter().enumerate() {
        if let Some(report) = on_progress {
            report("uniq-sort", b, buckets);
        }
        let out = directory.join(format!("sorted-{b}"));
        fingerprint::sort_files(std::slice::from_ref(raw), &out, &directory)
            .map_err(|e| EngineError::Unsupported(format!("uniq fingerprint sort: {e}")))?;
        let _ = std::fs::remove_file(raw);
        candidates.extend(
            fingerprint::candidate_groups(&out)
                .map_err(|e| EngineError::Unsupported(format!("uniq candidates: {e}")))?,
        );
        sorted_paths.push(out);
    }

    let excess = verify_candidates(sources, &candidates, report);
    Ok(Some(FingerprintScan {
        sorted_paths,
        directory,
        excess,
    }))
}

/// One rising scale for the whole `uniq-repair` phase.
///
/// The repair is several steps with different units: candidate groups to check
/// here, pool rows to prepare there, then a deal repeated per sweep. Reported
/// straight, each step would restart the counter at zero, and a bar drawn from
/// the phase would jump backwards every time one ended — which reads as a bug,
/// not as progress.
///
/// So the steps are added up. Each declares its size, the phase's total grows to
/// hold it, and `done` only ever rises. The total is not known in advance and is
/// not meant to be: it is what has been taken on so far.
pub(crate) struct RepairReport<'a> {
    on_progress: crate::engine::Watch<'a>,
    base: usize,
    size: usize,
}

impl<'a> RepairReport<'a> {
    pub(crate) fn new(on_progress: crate::engine::Watch<'a>) -> Self {
        Self {
            on_progress,
            base: 0,
            size: 0,
        }
    }

    fn emit(&self, done: usize) {
        if let Some(report) = self.on_progress {
            report("uniq-repair", done, self.base + self.size);
        }
    }

    /// Take on a step of `next` units. Ends the previous one.
    pub(crate) fn step(&mut self, next: usize) {
        self.base += self.size;
        self.size = next;
        self.emit(self.base);
    }

    /// `done` units into the current step.
    pub(crate) fn at(&self, done: usize) {
        self.emit(self.base + done);
    }

    /// Close the phase full, so a watcher sees it end rather than stall.
    pub(crate) fn finish(&self) {
        self.emit(self.base + self.size);
    }
}

/// Keep only the rows whose tuples GENUINELY repeat, lowest row of each group spared.
fn verify_candidates(
    sources: &[Source<'_>],
    candidates: &[Vec<usize>],
    report: &mut RepairReport<'_>,
) -> Vec<i32> {
    let mut excess: Vec<i32> = Vec::new();
    report.step(candidates.len());
    // Reported, because this is where a large run goes quiet: every candidate group costs a
    // tuple recomputed per row to tell a real duplicate from a hash collision, and there can be
    // a hundred thousand of them — tens of seconds saying nothing.
    let report_every = (candidates.len() / 200).max(1);
    for (done, group) in candidates.iter().enumerate() {
        if done % report_every == 0 {
            report.at(done);
        }
        let mut by_key: BTreeMap<String, Vec<i32>> = BTreeMap::new();
        for row in group {
            let mut key = String::new();
            for (j, source) in sources.iter().enumerate() {
                if j > 0 {
                    key.push(JOIN);
                }
                key.push_str(&source(*row as i32));
            }
            by_key.entry(key).or_default().push(*row as i32);
        }
        for (_, mut rows) in by_key {
            if rows.len() < 2 {
                continue; // a hash collision, not a duplicate
            }
            rows.sort_unstable();
            excess.extend(rows.into_iter().skip(1));
        }
    }
    excess.sort_unstable();
    excess
}

fn duplicate_groups(
    sources: &[Source<'_>],
    count: i32,
    tmp_dir: &Path,
) -> EngineResult<Vec<Vec<i32>>> {
    let records = (0..count).map(|i| {
        let mut key = String::new();
        for (j, source) in sources.iter().enumerate() {
            if j > 0 {
                key.push(JOIN);
            }
            key.push_str(&source(i));
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
    forbidden: &mut dyn Membership,
    size: usize,
    report: &mut RepairReport<'_>,
) -> Option<Vec<Vec<String>>> {
    let k = columns.len();
    if size == 0 || k == 0 {
        return Some(columns.to_vec());
    }

    // Said BEFORE the first deal: `uniq::arrange` below is itself seconds of work
    // on a large pool, and a watcher that only heard from the sweep loop would sit
    // on a stale `uniq-sort` throughout it. The phase NAME answers "what is it
    // doing".
    report.step(size);
    let arranged = uniq::arrange(columns).columns;
    let mut rows: Vec<Vec<String>> = (0..size)
        .map(|i| arranged.iter().map(|column| column[i].clone()).collect())
        .collect();

    let report_every = (size / 200).max(1);
    for sweep in 0..32 {
        // Each sweep is another `size` units taken on, so the scale grows with the
        // work instead of the counter restarting inside the phase.
        if sweep > 0 {
            report.step(size);
        }
        let mut tally: BTreeMap<String, i32> = BTreeMap::new();
        for row in &rows {
            *tally.entry(key_of(row)).or_insert(0) += 1;
        }

        let mut improved = false;
        for i in 0..size {
            if i % report_every == 0 {
                report.at(i);
            }
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

fn is_bad(tally: &BTreeMap<String, i32>, forbidden: &mut dyn Membership, key: &str) -> bool {
    tally.get(key).copied().unwrap_or(0) > 1 || forbidden.has(key)
}

/// The verdict on `key` as it would stand after the two rows swapped.
fn is_bad_after(
    tally: &BTreeMap<String, i32>,
    forbidden: &mut dyn Membership,
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
    after > 1 || forbidden.has(key)
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

#[cfg(test)]
mod tests {
    use super::RepairReport;
    use std::cell::RefCell;

    /// The scale itself, tested where it is written: a new step lifts the floor
    /// instead of resetting it, and the phase closes full.
    #[test]
    fn a_new_step_lifts_the_floor_instead_of_resetting_it() {
        let seen: RefCell<Vec<(String, usize, usize)>> = RefCell::new(Vec::new());
        let hook = |phase: &str, done: usize, total: usize| {
            seen.borrow_mut().push((phase.to_string(), done, total));
        };
        let mut report = RepairReport::new(Some(&hook));

        report.step(3);
        report.at(1);
        report.at(2);
        report.step(5);
        report.at(1);
        report.finish();

        let got: Vec<(usize, usize)> = seen.borrow().iter().map(|t| (t.1, t.2)).collect();
        assert_eq!(
            got,
            vec![
                (0, 3), // three units taken on
                (1, 3),
                (2, 3),
                (3, 8), // the first step is behind us, five more taken on
                (4, 8),
                (8, 8), // closed full
            ]
        );
        assert!(seen.borrow().iter().all(|t| t.0 == "uniq-repair"));
    }

    #[test]
    fn no_listener_no_work() {
        let mut report = RepairReport::new(None);
        report.step(2);
        report.at(1);
        report.finish();
    }
}
